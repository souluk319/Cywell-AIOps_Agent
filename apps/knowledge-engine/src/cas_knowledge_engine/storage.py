from __future__ import annotations

import importlib
import hashlib
import json
import re
import uuid
from pathlib import Path
from typing import Any

STORE_VERSION = "0.1.4"
LOCAL_EMBEDDING_MODEL = "cas-local-hash-v1"
LOCAL_EMBEDDING_DIMENSIONS = 768
PBS_COMPAT_TABLES = [
    "tenants",
    "workspaces",
    "document_sources",
    "parsed_documents",
    "document_chunks",
    "chunk_embeddings",
    "graph_entities",
    "graph_entity_mentions",
    "graph_entity_relations",
]
TOKEN_RE = re.compile(r"[0-9A-Za-z가-힣_./:-]{2,}")
WIKI_LINK_RE = re.compile(r"\[\[([^\]]+)\]\]")
HASHTAG_RE = re.compile(r"(?<![\w/])#([0-9A-Za-z가-힣][0-9A-Za-z가-힣_-]{1,63})")
URL_SIGNAL_RE = re.compile(r"https?://[^\s)\]}>'\"]+")
STOPWORDS = {
    "the",
    "and",
    "for",
    "with",
    "from",
    "this",
    "that",
    "are",
    "was",
    "were",
    "have",
    "has",
    "into",
    "api",
    "http",
    "https",
    "그리고",
    "또는",
    "에서",
    "으로",
    "하는",
    "있는",
    "없는",
    "고객",
    "데이터",
}


def empty_store() -> dict[str, Any]:
    return {
        "version": STORE_VERSION,
        "documents": [],
        "chunks": [],
        "notes": [],
        "events": [],
    }


def stable_uuid(prefix: str, value: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"cywell-ai-sentinel:{prefix}:{value}"))


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def tokenize(text: str) -> list[str]:
    tokens = [token.lower().strip("._:-/") for token in TOKEN_RE.findall(text)]
    return [token for token in tokens if token and token not in STOPWORDS and len(token) > 1]


def compact_list(values: list[str], limit: int = 12) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        clean = re.sub(r"\s+", " ", str(value or "")).strip().strip("#")
        if not clean:
            continue
        key = clean.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(clean)
        if len(result) >= limit:
            break
    return result


def top_terms(text: str, limit: int = 8) -> list[str]:
    counts: dict[str, int] = {}
    for token in tokenize(text):
        counts[token] = counts.get(token, 0) + 1
    return [term for term, _count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:limit]]


def graph_signals(text: str, fallback_terms: list[str] | None = None) -> list[dict[str, str]]:
    body = str(text or "")
    signals: list[dict[str, str]] = []
    for kind, values in [
        ("wikilink", WIKI_LINK_RE.findall(body)),
        ("tag", HASHTAG_RE.findall(body)),
        ("url", URL_SIGNAL_RE.findall(body)),
        ("concept", [*(fallback_terms or []), *top_terms(body, 8)]),
    ]:
        for value in compact_list(values, limit=12 if kind != "url" else 4):
            signals.append({"kind": kind, "name": value})
    deduped: list[dict[str, str]] = []
    seen: set[str] = set()
    for signal in signals:
        key = f"{signal['kind']}:{signal['name'].lower()}"
        if key in seen:
            continue
        seen.add(key)
        deduped.append(signal)
    return deduped[:16]


def graph_entity_key(kind: str, name: str) -> str:
    normalized = re.sub(r"\s+", " ", name).strip().lower()
    return f"{kind}:{normalized}"


def local_embedding_literal(text: str, dimensions: int = LOCAL_EMBEDDING_DIMENSIONS) -> str:
    seed = sha256_text(text or "")
    values: list[str] = []
    counter = 0
    while len(values) < dimensions:
        digest = hashlib.sha256(f"{seed}:{counter}".encode("utf-8")).digest()
        for byte in digest:
            values.append(f"{((byte - 127.5) / 127.5):.6f}")
            if len(values) >= dimensions:
                break
        counter += 1
    return f"[{','.join(values)}]"


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
                    self._ensure_pbs_compat_schema(cur)
                conn.commit()
            self.db_error = ""
            self._db_ready = True
            return True
        except Exception as error:
            self.db_error = str(error)
            self._db_ready = False
            return False

    def _ensure_pbs_compat_schema(self, cur: Any) -> None:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS tenants (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                slug text NOT NULL UNIQUE,
                name text NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS workspaces (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                slug text NOT NULL,
                name text NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now(),
                UNIQUE (tenant_id, slug)
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS document_sources (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
                workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
                source_kind text NOT NULL DEFAULT 'upload',
                filename text NOT NULL,
                mime_type text NOT NULL DEFAULT '',
                sha256 text NOT NULL,
                storage_key text NOT NULL,
                byte_size bigint NOT NULL DEFAULT 0,
                access_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
                metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
                created_by text NOT NULL DEFAULT '',
                created_at timestamptz NOT NULL DEFAULT now(),
                UNIQUE (workspace_id, sha256)
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS parsed_documents (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                document_source_id uuid NOT NULL REFERENCES document_sources(id) ON DELETE CASCADE,
                parser_name text NOT NULL,
                parser_version text NOT NULL DEFAULT '',
                title text NOT NULL DEFAULT '',
                markdown text NOT NULL DEFAULT '',
                metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
                outline jsonb NOT NULL DEFAULT '[]'::jsonb,
                warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
                created_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS document_chunks (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                parsed_document_id uuid NOT NULL REFERENCES parsed_documents(id) ON DELETE CASCADE,
                chunk_key text NOT NULL,
                ordinal integer NOT NULL,
                chunk_type text NOT NULL DEFAULT 'document',
                markdown text NOT NULL,
                embedding_text text NOT NULL,
                token_count integer NOT NULL DEFAULT 0,
                page_start integer,
                page_end integer,
                section_path jsonb NOT NULL DEFAULT '[]'::jsonb,
                asset_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
                metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
                created_at timestamptz NOT NULL DEFAULT now(),
                UNIQUE (parsed_document_id, chunk_key)
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS chunk_embeddings (
                chunk_id uuid NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
                model text NOT NULL,
                embedding vector(768) NOT NULL,
                embedding_text_hash text NOT NULL,
                payload_hash text NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (chunk_id, model)
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS graph_entities (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                customer_id text NOT NULL DEFAULT '',
                entity_kind text NOT NULL,
                name text NOT NULL,
                display_name text NOT NULL DEFAULT '',
                entity_key text NOT NULL,
                aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
                source_scope text NOT NULL DEFAULT 'user_upload',
                owner_user_id text NOT NULL DEFAULT '',
                metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
                mention_count integer NOT NULL DEFAULT 0,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        cur.execute("ALTER TABLE graph_entities ADD COLUMN IF NOT EXISTS customer_id text NOT NULL DEFAULT ''")
        cur.execute("DROP INDEX IF EXISTS idx_graph_entities_key_scope")
        cur.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_entities_key_customer_scope
            ON graph_entities(customer_id, entity_key, source_scope, owner_user_id)
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS graph_entity_mentions (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                entity_id uuid NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
                source_kind text NOT NULL DEFAULT 'chunk',
                chunk_id uuid NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
                source_ref text NOT NULL DEFAULT '',
                document_source_id uuid NULL REFERENCES document_sources(id) ON DELETE CASCADE,
                quote text NOT NULL DEFAULT '',
                quote_sha256 text NOT NULL DEFAULT '',
                locator jsonb NOT NULL DEFAULT '{}'::jsonb,
                extraction_method text NOT NULL DEFAULT 'rule',
                extractor_version text NOT NULL DEFAULT 'cas-local-v1',
                confidence real NOT NULL DEFAULT 1.0,
                customer_id text NOT NULL DEFAULT '',
                source_scope text NOT NULL DEFAULT 'user_upload',
                owner_user_id text NOT NULL DEFAULT '',
                visibility text NOT NULL DEFAULT 'workspace_shared',
                created_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS graph_entity_relations (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                subject_entity_id uuid NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
                object_entity_id uuid NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
                relation_type text NOT NULL,
                source_kind text NOT NULL DEFAULT 'chunk',
                chunk_id uuid NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
                source_ref text NOT NULL DEFAULT '',
                document_source_id uuid NULL REFERENCES document_sources(id) ON DELETE CASCADE,
                quote text NOT NULL DEFAULT '',
                quote_sha256 text NOT NULL DEFAULT '',
                locator jsonb NOT NULL DEFAULT '{}'::jsonb,
                extraction_method text NOT NULL DEFAULT 'rule',
                extractor_version text NOT NULL DEFAULT 'cas-local-v1',
                confidence real NOT NULL DEFAULT 1.0,
                customer_id text NOT NULL DEFAULT '',
                source_scope text NOT NULL DEFAULT 'user_upload',
                owner_user_id text NOT NULL DEFAULT '',
                visibility text NOT NULL DEFAULT 'workspace_shared',
                created_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        cur.execute("ALTER TABLE graph_entity_mentions ADD COLUMN IF NOT EXISTS customer_id text NOT NULL DEFAULT ''")
        cur.execute("ALTER TABLE graph_entity_relations ADD COLUMN IF NOT EXISTS customer_id text NOT NULL DEFAULT ''")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_document_chunks_parsed_ordinal ON document_chunks(parsed_document_id, ordinal)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_model ON chunk_embeddings(model)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_text_hash ON chunk_embeddings(model, embedding_text_hash)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_graph_entities_kind ON graph_entities(entity_kind)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_graph_entities_customer ON graph_entities(customer_id)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_graph_entity_mentions_chunk ON graph_entity_mentions(chunk_id)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_graph_entity_mentions_customer ON graph_entity_mentions(customer_id)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_graph_entity_relations_subject ON graph_entity_relations(subject_entity_id)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_graph_entity_relations_object ON graph_entity_relations(object_entity_id)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_graph_entity_relations_customer ON graph_entity_relations(customer_id)")

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
                self._save_pbs_compat_rows(cur, store)
            conn.commit()

    def health(self) -> dict[str, Any]:
        self.ensure_ready()
        pbs_compat = {
            "schema_ready": False,
            "tables": [],
            "embedding_dimension": 0,
            "embedding_model": LOCAL_EMBEDDING_MODEL,
            "document_sources": 0,
            "document_chunks": 0,
            "chunk_embeddings": 0,
            "graph_entities": 0,
            "graph_entity_mentions": 0,
            "graph_entity_relations": 0,
            "missing_embedding_entries": 0,
            "embedding_index_parity": False,
        }
        if self._db_ready:
            try:
                with self._connect() as conn:
                    with conn.cursor() as cur:
                        pbs_compat = self._pbs_compat_health(cur)
            except Exception as error:
                self.db_error = str(error)
        return {
            "mode": "postgres-pgvector",
            "path": None,
            "database_configured": True,
            "database_ready": self._db_ready,
            "database_error": self.db_error,
            "pbs_compat": pbs_compat,
        }

    def _save_pbs_compat_rows(self, cur: Any, store: dict[str, Any]) -> None:
        chunks_by_document: dict[str, list[dict[str, Any]]] = {}
        for chunk in store["chunks"]:
            chunks_by_document.setdefault(str(chunk.get("document_id") or ""), []).append(chunk)

        def upsert_graph_entity(kind: str, name: str, *, source_scope: str, owner_id: str, customer_id: str, document_id: str) -> str:
            entity_key = graph_entity_key(kind, name)
            entity_uuid = stable_uuid("graph-entity", f"{owner_id}:{customer_id}:{source_scope}:{entity_key}")
            metadata = {
                "customer_id": customer_id,
                "cas_document_id": document_id,
                "extractor": "cas-local-rule",
                "extractor_version": STORE_VERSION,
            }
            cur.execute(
                """
                INSERT INTO graph_entities(id, customer_id, entity_kind, name, display_name, entity_key, aliases, source_scope, owner_user_id, metadata)
                VALUES (%s::uuid, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s::jsonb)
                ON CONFLICT (customer_id, entity_key, source_scope, owner_user_id) DO UPDATE SET
                    entity_kind = EXCLUDED.entity_kind,
                    name = EXCLUDED.name,
                    display_name = EXCLUDED.display_name,
                    metadata = graph_entities.metadata || EXCLUDED.metadata,
                    updated_at = now()
                RETURNING id
                """,
                (
                    entity_uuid,
                    customer_id,
                    kind,
                    name,
                    name,
                    entity_key,
                    json.dumps([], ensure_ascii=False),
                    source_scope,
                    owner_id,
                    json.dumps(metadata, ensure_ascii=False),
                ),
            )
            return str((cur.fetchone() or [entity_uuid])[0])

        for document in store["documents"]:
            document_id = str(document.get("id") or "")
            if not document_id:
                continue
            document_chunks = sorted(chunks_by_document.get(document_id, []), key=lambda item: int(item.get("index") or 0))
            markdown = "\n\n".join(str(chunk.get("text") or "") for chunk in document_chunks).strip() or str(document.get("summary") or "")
            metadata = document.get("metadata") if isinstance(document.get("metadata"), dict) else {}
            pbs_payload = metadata.get("pbs_payload") if isinstance(metadata.get("pbs_payload"), dict) else {}
            source_scope = str(metadata.get("source_scope") or pbs_payload.get("source_scope") or "user_upload")
            visibility = str(metadata.get("visibility") or pbs_payload.get("visibility") or "private_user")
            owner_id = str(document.get("owner_id") or "cas-local")
            customer_id = str(document.get("customer_id") or "default")
            source_uuid = stable_uuid("document-source", document_id)
            parsed_uuid = stable_uuid("parsed-document", document_id)
            content_sha = sha256_text(markdown or document_id)
            source_metadata = {
                **metadata,
                "cas_document_id": document_id,
                "customer_id": customer_id,
                "owner_id": owner_id,
                "visibility": visibility,
            }
            cur.execute(
                """
                INSERT INTO document_sources(id, source_kind, filename, mime_type, sha256, storage_key, byte_size, access_policy, metadata, created_by)
                VALUES (%s::uuid, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s)
                ON CONFLICT (id) DO UPDATE SET
                    source_kind = EXCLUDED.source_kind,
                    filename = EXCLUDED.filename,
                    mime_type = EXCLUDED.mime_type,
                    sha256 = EXCLUDED.sha256,
                    storage_key = EXCLUDED.storage_key,
                    byte_size = EXCLUDED.byte_size,
                    access_policy = EXCLUDED.access_policy,
                    metadata = EXCLUDED.metadata,
                    created_by = EXCLUDED.created_by
                """,
                (
                    source_uuid,
                    str(document.get("source_type") or "upload"),
                    str(document.get("title") or document_id),
                    str(metadata.get("mime_type") or ""),
                    content_sha,
                    f"cas://knowledge/{document_id}",
                    int(document.get("bytes") or len(markdown.encode("utf-8"))),
                    json.dumps({"customer_id": customer_id, "owner_id": owner_id, "visibility": visibility}, ensure_ascii=False),
                    json.dumps(source_metadata, ensure_ascii=False),
                    owner_id,
                ),
            )
            cur.execute(
                """
                INSERT INTO parsed_documents(id, document_source_id, parser_name, parser_version, title, markdown, metadata)
                VALUES (%s::uuid, %s::uuid, %s, %s, %s, %s, %s::jsonb)
                ON CONFLICT (id) DO UPDATE SET
                    document_source_id = EXCLUDED.document_source_id,
                    parser_name = EXCLUDED.parser_name,
                    parser_version = EXCLUDED.parser_version,
                    title = EXCLUDED.title,
                    markdown = EXCLUDED.markdown,
                    metadata = EXCLUDED.metadata
                """,
                (
                    parsed_uuid,
                    source_uuid,
                    str(metadata.get("parser") or "cas-local-text"),
                    STORE_VERSION,
                    str(document.get("title") or document_id),
                    markdown,
                    json.dumps(source_metadata, ensure_ascii=False),
                ),
            )
            cur.execute("DELETE FROM graph_entity_relations WHERE document_source_id = %s::uuid", (source_uuid,))
            cur.execute("DELETE FROM graph_entity_mentions WHERE document_source_id = %s::uuid", (source_uuid,))
            for chunk in document_chunks:
                chunk_id = str(chunk.get("id") or "")
                if not chunk_id:
                    continue
                text = str(chunk.get("text") or "")
                chunk_uuid = stable_uuid("document-chunk", chunk_id)
                chunk_metadata = {
                    "cas_chunk_id": chunk_id,
                    "cas_document_id": document_id,
                    "customer_id": customer_id,
                    "owner_id": owner_id,
                    "terms": chunk.get("terms") or [],
                }
                cur.execute(
                    """
                    INSERT INTO document_chunks(id, parsed_document_id, chunk_key, ordinal, chunk_type, markdown, embedding_text, token_count, metadata)
                    VALUES (%s::uuid, %s::uuid, %s, %s, %s, %s, %s, %s, %s::jsonb)
                    ON CONFLICT (id) DO UPDATE SET
                        parsed_document_id = EXCLUDED.parsed_document_id,
                        chunk_key = EXCLUDED.chunk_key,
                        ordinal = EXCLUDED.ordinal,
                        chunk_type = EXCLUDED.chunk_type,
                        markdown = EXCLUDED.markdown,
                        embedding_text = EXCLUDED.embedding_text,
                        token_count = EXCLUDED.token_count,
                        metadata = EXCLUDED.metadata
                    """,
                    (
                        chunk_uuid,
                        parsed_uuid,
                        chunk_id,
                        int(chunk.get("index") or 0),
                        "document",
                        text,
                        text,
                        len(text.split()),
                        json.dumps(chunk_metadata, ensure_ascii=False),
                    ),
                )
                embedding_text_hash = sha256_text(text)
                embedding_payload_hash = sha256_text(json.dumps(chunk_metadata, ensure_ascii=False, sort_keys=True))
                cur.execute(
                    """
                    INSERT INTO chunk_embeddings(chunk_id, model, embedding, embedding_text_hash, payload_hash)
                    VALUES (%s::uuid, %s, %s::vector, %s, %s)
                    ON CONFLICT (chunk_id, model) DO UPDATE SET
                        embedding = EXCLUDED.embedding,
                        embedding_text_hash = EXCLUDED.embedding_text_hash,
                        payload_hash = EXCLUDED.payload_hash,
                        updated_at = now()
                    """,
                    (
                        chunk_uuid,
                        LOCAL_EMBEDDING_MODEL,
                        local_embedding_literal(text),
                        embedding_text_hash,
                        embedding_payload_hash,
                    ),
                )
                chunk_signals = graph_signals(f"{document.get('title', '')} {text}", [str(term) for term in chunk.get("terms") or document.get("terms") or []])
                entity_rows: list[tuple[str, str, str]] = []
                for signal in chunk_signals:
                    kind = signal["kind"]
                    name = signal["name"]
                    entity_key = graph_entity_key(kind, name)
                    entity_id = upsert_graph_entity(kind, name, source_scope=source_scope, owner_id=owner_id, customer_id=customer_id, document_id=document_id)
                    entity_rows.append((entity_id, entity_key, name))
                    mention_uuid = stable_uuid("graph-mention", f"{chunk_uuid}:{entity_key}")
                    cur.execute(
                        """
                        INSERT INTO graph_entity_mentions(
                            id, entity_id, source_kind, chunk_id, source_ref, document_source_id, quote, quote_sha256,
                            locator, extraction_method, extractor_version, confidence, customer_id, source_scope, owner_user_id, visibility
                        )
                        VALUES (%s::uuid, %s::uuid, %s, %s::uuid, %s, %s::uuid, %s, %s, %s::jsonb, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (id) DO UPDATE SET
                            entity_id = EXCLUDED.entity_id,
                            source_kind = EXCLUDED.source_kind,
                            chunk_id = EXCLUDED.chunk_id,
                            source_ref = EXCLUDED.source_ref,
                            document_source_id = EXCLUDED.document_source_id,
                            quote = EXCLUDED.quote,
                            quote_sha256 = EXCLUDED.quote_sha256,
                            locator = EXCLUDED.locator,
                            customer_id = EXCLUDED.customer_id,
                            source_scope = EXCLUDED.source_scope,
                            owner_user_id = EXCLUDED.owner_user_id,
                            visibility = EXCLUDED.visibility
                        """,
                        (
                            mention_uuid,
                            entity_id,
                            "chunk",
                            chunk_uuid,
                            chunk_id,
                            source_uuid,
                            text[:260],
                            sha256_text(text[:260]),
                            json.dumps({"chunk_index": int(chunk.get("index") or 0), "cas_chunk_id": chunk_id, "cas_document_id": document_id}, ensure_ascii=False),
                            "rule",
                            "cas-local-v1",
                            1.0,
                            customer_id,
                            source_scope,
                            owner_id,
                            visibility,
                        ),
                    )
                relation_rows = entity_rows[:8]
                for index, subject in enumerate(relation_rows):
                    for target in relation_rows[index + 1 :]:
                        relation_uuid = stable_uuid("graph-relation", f"{chunk_uuid}:{subject[1]}:co_occurs:{target[1]}")
                        cur.execute(
                            """
                            INSERT INTO graph_entity_relations(
                                id, subject_entity_id, object_entity_id, relation_type, source_kind, chunk_id, source_ref,
                                document_source_id, quote, quote_sha256, locator, extraction_method, extractor_version,
                                confidence, customer_id, source_scope, owner_user_id, visibility
                            )
                            VALUES (%s::uuid, %s::uuid, %s::uuid, %s, %s, %s::uuid, %s, %s::uuid, %s, %s, %s::jsonb, %s, %s, %s, %s, %s, %s, %s)
                            ON CONFLICT (id) DO UPDATE SET
                                subject_entity_id = EXCLUDED.subject_entity_id,
                                object_entity_id = EXCLUDED.object_entity_id,
                                relation_type = EXCLUDED.relation_type,
                                source_kind = EXCLUDED.source_kind,
                                chunk_id = EXCLUDED.chunk_id,
                                source_ref = EXCLUDED.source_ref,
                                document_source_id = EXCLUDED.document_source_id,
                                quote = EXCLUDED.quote,
                                quote_sha256 = EXCLUDED.quote_sha256,
                                locator = EXCLUDED.locator,
                                customer_id = EXCLUDED.customer_id,
                                source_scope = EXCLUDED.source_scope,
                                owner_user_id = EXCLUDED.owner_user_id,
                                visibility = EXCLUDED.visibility
                            """,
                            (
                                relation_uuid,
                                subject[0],
                                target[0],
                                "co_occurs",
                                "chunk",
                                chunk_uuid,
                                chunk_id,
                                source_uuid,
                                text[:260],
                                sha256_text(text[:260]),
                                json.dumps({"chunk_index": int(chunk.get("index") or 0), "cas_chunk_id": chunk_id, "cas_document_id": document_id}, ensure_ascii=False),
                                "rule",
                                "cas-local-v1",
                                0.85,
                                customer_id,
                                source_scope,
                                owner_id,
                                visibility,
                            ),
                        )
        cur.execute(
            """
            UPDATE graph_entities ge
            SET mention_count = COALESCE(mentions.count, 0),
                updated_at = now()
            FROM (
                SELECT entity_id, COUNT(*)::integer AS count
                FROM graph_entity_mentions
                GROUP BY entity_id
            ) mentions
            WHERE ge.id = mentions.entity_id
            """
        )
        cur.execute(
            """
            UPDATE graph_entities ge
            SET mention_count = 0,
                updated_at = now()
            WHERE NOT EXISTS (
                SELECT 1 FROM graph_entity_mentions gm WHERE gm.entity_id = ge.id
            )
            """
        )

    def _pbs_compat_health(self, cur: Any) -> dict[str, Any]:
        cur.execute(
            """
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema='public' AND table_name = ANY(%s)
            ORDER BY table_name
            """,
            (PBS_COMPAT_TABLES,),
        )
        tables = [str(row[0]) for row in cur.fetchall()]
        cur.execute(
            """
            SELECT COALESCE(format_type(atttypid, atttypmod), '')
            FROM pg_attribute
            WHERE attrelid='chunk_embeddings'::regclass AND attname='embedding'
            """
        )
        embedding_type = str((cur.fetchone() or [""])[0] or "")
        cur.execute("SELECT COUNT(*) FROM document_sources")
        document_sources = int((cur.fetchone() or [0])[0] or 0)
        cur.execute("SELECT COUNT(*) FROM document_chunks")
        document_chunks = int((cur.fetchone() or [0])[0] or 0)
        cur.execute("SELECT COUNT(*) FROM chunk_embeddings WHERE model = %s", (LOCAL_EMBEDDING_MODEL,))
        chunk_embeddings = int((cur.fetchone() or [0])[0] or 0)
        cur.execute("SELECT COUNT(*) FROM graph_entities WHERE mention_count > 0")
        graph_entities = int((cur.fetchone() or [0])[0] or 0)
        cur.execute("SELECT COUNT(*) FROM graph_entity_mentions")
        graph_entity_mentions = int((cur.fetchone() or [0])[0] or 0)
        cur.execute("SELECT COUNT(*) FROM graph_entity_relations")
        graph_entity_relations = int((cur.fetchone() or [0])[0] or 0)
        cur.execute(
            """
            SELECT COUNT(*)
            FROM document_chunks c
            LEFT JOIN chunk_embeddings ce ON ce.chunk_id = c.id AND ce.model = %s
            WHERE length(btrim(COALESCE(c.embedding_text, ''))) > 0 AND ce.chunk_id IS NULL
            """,
            (LOCAL_EMBEDDING_MODEL,),
        )
        missing_embeddings = int((cur.fetchone() or [0])[0] or 0)
        return {
            "schema_ready": sorted(tables) == sorted(PBS_COMPAT_TABLES) and embedding_type == "vector(768)",
            "tables": tables,
            "embedding_dimension": 768 if embedding_type == "vector(768)" else 0,
            "embedding_model": LOCAL_EMBEDDING_MODEL,
            "document_sources": document_sources,
            "document_chunks": document_chunks,
            "chunk_embeddings": chunk_embeddings,
            "graph_entities": graph_entities,
            "graph_entity_mentions": graph_entity_mentions,
            "graph_entity_relations": graph_entity_relations,
            "missing_embedding_entries": missing_embeddings,
            "embedding_index_parity": document_chunks > 0 and chunk_embeddings == document_chunks and missing_embeddings == 0,
        }


def build_store(data_dir: str | Path, database_url: str):
    if database_url:
        return PostgresKnowledgeStore(database_url)
    return JsonKnowledgeStore(data_dir)
