from __future__ import annotations

import importlib
import json
from pathlib import Path
from typing import Any

STORE_VERSION = "0.1.4"


def empty_store() -> dict[str, Any]:
    return {
        "version": STORE_VERSION,
        "documents": [],
        "chunks": [],
        "notes": [],
        "events": [],
    }


class JsonKnowledgeStore:
    def __init__(self, data_dir: str | Path):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.store_path = self.data_dir / "knowledge-store.json"

    def load(self) -> dict[str, Any]:
        if not self.store_path.exists():
            return empty_store()
        with self.store_path.open("r", encoding="utf-8") as handle:
            store = json.load(handle)
        for key, value in empty_store().items():
            store.setdefault(key, value)
        return store

    def save(self, store: dict[str, Any]) -> None:
        tmp_path = self.store_path.with_suffix(".tmp")
        with tmp_path.open("w", encoding="utf-8") as handle:
            json.dump(store, handle, ensure_ascii=False, indent=2)
        tmp_path.replace(self.store_path)

    def health(self) -> dict[str, Any]:
        return {
            "mode": "local-json",
            "path": str(self.store_path),
            "database_configured": False,
            "database_ready": False,
            "database_error": "",
        }


class PostgresKnowledgeStore:
    def __init__(self, database_url: str):
        self.database_url = database_url
        self.db_error = ""
        self._db_ready = False

    def _psycopg(self) -> Any:
        return importlib.import_module("psycopg")

    def _connect(self) -> Any:
        return self._psycopg().connect(self.database_url, connect_timeout=5)

    def ensure_ready(self) -> bool:
        if self._db_ready:
            return True
        try:
            with self._connect() as conn:
                with conn.cursor() as cur:
                    cur.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
                    cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
                    cur.execute(
                        """
                        CREATE TABLE IF NOT EXISTS cas_knowledge_documents (
                            id text PRIMARY KEY,
                            customer_id text NOT NULL,
                            owner_id text NOT NULL DEFAULT 'cas-local',
                            payload jsonb NOT NULL,
                            updated_at timestamptz NOT NULL DEFAULT now()
                        )
                        """
                    )
                    cur.execute("ALTER TABLE cas_knowledge_documents ADD COLUMN IF NOT EXISTS owner_id text NOT NULL DEFAULT 'cas-local'")
                    cur.execute(
                        """
                        CREATE TABLE IF NOT EXISTS cas_knowledge_chunks (
                            id text PRIMARY KEY,
                            document_id text NOT NULL,
                            customer_id text NOT NULL,
                            owner_id text NOT NULL DEFAULT 'cas-local',
                            payload jsonb NOT NULL,
                            updated_at timestamptz NOT NULL DEFAULT now()
                        )
                        """
                    )
                    cur.execute("ALTER TABLE cas_knowledge_chunks ADD COLUMN IF NOT EXISTS owner_id text NOT NULL DEFAULT 'cas-local'")
                    cur.execute(
                        """
                        CREATE TABLE IF NOT EXISTS cas_knowledge_notes (
                            id text PRIMARY KEY,
                            customer_id text NOT NULL,
                            owner_id text NOT NULL DEFAULT 'cas-local',
                            payload jsonb NOT NULL,
                            updated_at timestamptz NOT NULL DEFAULT now()
                        )
                        """
                    )
                    cur.execute("ALTER TABLE cas_knowledge_notes ADD COLUMN IF NOT EXISTS owner_id text NOT NULL DEFAULT 'cas-local'")
                    cur.execute(
                        """
                        CREATE TABLE IF NOT EXISTS cas_knowledge_events (
                            id text PRIMARY KEY,
                            customer_id text NOT NULL,
                            owner_id text NOT NULL DEFAULT 'cas-local',
                            event_type text NOT NULL,
                            payload jsonb NOT NULL,
                            created_at timestamptz NOT NULL DEFAULT now()
                        )
                        """
                    )
                    cur.execute("ALTER TABLE cas_knowledge_events ADD COLUMN IF NOT EXISTS owner_id text NOT NULL DEFAULT 'cas-local'")
                    cur.execute(
                        """
                        CREATE TABLE IF NOT EXISTS cas_knowledge_vector_readiness (
                            id text PRIMARY KEY,
                            embedding vector(768)
                        )
                        """
                    )
                    cur.execute(
                        "CREATE INDEX IF NOT EXISTS idx_cas_knowledge_chunks_scope ON cas_knowledge_chunks(owner_id, customer_id)"
                    )
                    cur.execute(
                        "CREATE INDEX IF NOT EXISTS idx_cas_knowledge_notes_scope ON cas_knowledge_notes(owner_id, customer_id)"
                    )
                    cur.execute(
                        "CREATE INDEX IF NOT EXISTS idx_cas_knowledge_events_scope ON cas_knowledge_events(owner_id, customer_id, created_at DESC)"
                    )
                conn.commit()
            self.db_error = ""
            self._db_ready = True
            return True
        except Exception as error:
            self.db_error = str(error)
            self._db_ready = False
            return False

    def load(self) -> dict[str, Any]:
        if not self.ensure_ready():
            raise RuntimeError(f"database unavailable: {self.db_error}")
        store = empty_store()
        with self._connect() as conn:
            with conn.cursor() as cur:
                for table, key in [
                    ("cas_knowledge_documents", "documents"),
                    ("cas_knowledge_chunks", "chunks"),
                    ("cas_knowledge_notes", "notes"),
                    ("cas_knowledge_events", "events"),
                ]:
                    cur.execute(f"SELECT payload::text FROM {table}")
                    store[key] = [json.loads(row[0]) for row in cur.fetchall()]
        return store

    def save(self, store: dict[str, Any]) -> None:
        if not self.ensure_ready():
            raise RuntimeError(f"database unavailable: {self.db_error}")
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM cas_knowledge_events")
                cur.execute("DELETE FROM cas_knowledge_notes")
                cur.execute("DELETE FROM cas_knowledge_chunks")
                cur.execute("DELETE FROM cas_knowledge_documents")
                for document in store["documents"]:
                    cur.execute(
                        """
                        INSERT INTO cas_knowledge_documents(id, customer_id, owner_id, payload)
                        VALUES (%s, %s, %s, %s::jsonb)
                        ON CONFLICT (id) DO UPDATE SET customer_id = EXCLUDED.customer_id, owner_id = EXCLUDED.owner_id, payload = EXCLUDED.payload, updated_at = now()
                        """,
                        (
                            document["id"],
                            document.get("customer_id", "default"),
                            document.get("owner_id", "cas-local"),
                            json.dumps(document, ensure_ascii=False),
                        ),
                    )
                for chunk in store["chunks"]:
                    cur.execute(
                        """
                        INSERT INTO cas_knowledge_chunks(id, document_id, customer_id, owner_id, payload)
                        VALUES (%s, %s, %s, %s, %s::jsonb)
                        ON CONFLICT (id) DO UPDATE SET document_id = EXCLUDED.document_id, customer_id = EXCLUDED.customer_id, owner_id = EXCLUDED.owner_id, payload = EXCLUDED.payload, updated_at = now()
                        """,
                        (
                            chunk["id"],
                            chunk.get("document_id", ""),
                            chunk.get("customer_id", "default"),
                            chunk.get("owner_id", "cas-local"),
                            json.dumps(chunk, ensure_ascii=False),
                        ),
                    )
                for note in store["notes"]:
                    cur.execute(
                        """
                        INSERT INTO cas_knowledge_notes(id, customer_id, owner_id, payload)
                        VALUES (%s, %s, %s, %s::jsonb)
                        ON CONFLICT (id) DO UPDATE SET customer_id = EXCLUDED.customer_id, owner_id = EXCLUDED.owner_id, payload = EXCLUDED.payload, updated_at = now()
                        """,
                        (
                            note["id"],
                            note.get("customer_id", "default"),
                            note.get("owner_id", "cas-local"),
                            json.dumps(note, ensure_ascii=False),
                        ),
                    )
                for event in store["events"]:
                    cur.execute(
                        """
                        INSERT INTO cas_knowledge_events(id, customer_id, owner_id, event_type, payload)
                        VALUES (%s, %s, %s, %s, %s::jsonb)
                        ON CONFLICT (id) DO UPDATE SET customer_id = EXCLUDED.customer_id, owner_id = EXCLUDED.owner_id, event_type = EXCLUDED.event_type, payload = EXCLUDED.payload
                        """,
                        (
                            event["id"],
                            event.get("customer_id", "default"),
                            event.get("owner_id", "cas-local"),
                            event.get("type", "event"),
                            json.dumps(event, ensure_ascii=False),
                        ),
                    )
            conn.commit()

    def health(self) -> dict[str, Any]:
        self.ensure_ready()
        return {
            "mode": "postgres-pgvector",
            "path": None,
            "database_configured": True,
            "database_ready": self._db_ready,
            "database_error": self.db_error,
        }


def build_store(data_dir: str | Path, database_url: str):
    if database_url:
        return PostgresKnowledgeStore(database_url)
    return JsonKnowledgeStore(data_dir)
