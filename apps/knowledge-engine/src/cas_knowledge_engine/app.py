from __future__ import annotations

import hashlib
import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from .engine import KnowledgeEngine


def data_dir() -> str:
    return os.environ.get("CAS_KNOWLEDGE_DATA_DIR", os.path.join(os.getcwd(), "data", "knowledge-engine"))


def json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def max_request_bytes() -> int:
    raw = os.environ.get("CAS_KNOWLEDGE_MAX_REQUEST_BYTES", str(25 * 1024 * 1024)).strip()
    try:
        return max(1024, int(raw))
    except ValueError:
        return 25 * 1024 * 1024


def resolve_owner_id(headers: Any) -> str | None:
    owner_mode = os.environ.get("CAS_KNOWLEDGE_OWNER_MODE", "single").strip().lower()
    if owner_mode != "trusted-header":
        return None
    value = headers.get("x-forwarded-user")
    if not value:
        return None
    owner_id = str(value).strip()
    secret = os.environ.get("CAS_KNOWLEDGE_OWNER_HMAC_SECRET", "").strip()
    if secret:
        signature = str(headers.get("x-cas-owner-signature") or "").strip()
        expected = hmac.new(secret.encode("utf-8"), owner_id.encode("utf-8"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return None
    if owner_id:
        return owner_id
    return None


def require_trusted_owner_header() -> bool:
    value = os.environ.get("CAS_KNOWLEDGE_REQUIRE_OWNER_HEADER", "false").strip().lower()
    return value in {"1", "true", "yes", "y", "on"}


def owner_mode() -> str:
    return os.environ.get("CAS_KNOWLEDGE_OWNER_MODE", "single").strip().lower()


class KnowledgeRequestHandler(BaseHTTPRequestHandler):
    server_version = "CywellKnowledgeEngine/0.1.4"

    @property
    def engine(self) -> KnowledgeEngine:
        return self.server.engine  # type: ignore[attr-defined]

    def log_message(self, format: str, *args: Any) -> None:
        if os.environ.get("CAS_KNOWLEDGE_ACCESS_LOG", "false").lower() == "true":
            super().log_message(format, *args)

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "authorization,content-type,x-forwarded-user,x-cas-owner-signature")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length") or "0")
        if length <= 0:
            return {}
        limit = max_request_bytes()
        if length > limit:
            raise ValueError(f"request body exceeds CAS_KNOWLEDGE_MAX_REQUEST_BYTES ({limit})")
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw)

    def scoped_owner_id(self) -> str | None:
        owner_id = resolve_owner_id(self.headers)
        if owner_mode() == "trusted-header" and require_trusted_owner_header() and not owner_id:
            raise PermissionError("trusted-header owner is required")
        return owner_id

    def engine_status(self, payload: dict[str, Any], default: int = 200) -> int:
        if payload.get("status") != "error":
            return default
        pbs = payload.get("pbs") if isinstance(payload.get("pbs"), dict) else {}
        status = int(pbs.get("status") or 0)
        if 400 <= status <= 599:
            return status
        return 502

    def send_engine_json(self, payload: dict[str, Any], default: int = 200) -> None:
        self.send_json(self.engine_status(payload, default=default), payload)

    def do_OPTIONS(self) -> None:
        self.send_json(204, {})

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        customer_id = query.get("customer_id", query.get("customerId", ["default"]))[0]
        try:
            if parsed.path in {"/healthz", "/api/knowledge/healthz"}:
                health = self.engine.health()
                self.send_json(200 if health.get("status") == "ok" else 503, health)
                return
            if parsed.path == "/api/knowledge/capabilities":
                self.send_json(200, {"status": "ok", "capabilities": self.engine.capabilities()})
                return
            owner_id = self.scoped_owner_id()
            if parsed.path == "/api/knowledge/uploads/reports":
                self.send_engine_json(self.engine.upload_reports(customer_id, owner_id=owner_id))
                return
            if parsed.path == "/api/knowledge/wiki-loop/status":
                self.send_engine_json(self.engine.wiki_loop_status(customer_id=customer_id, owner_id=owner_id))
                return
            if parsed.path == "/api/knowledge/wiki-vault":
                self.send_engine_json(self.engine.wiki_vault(customer_id, owner_id=owner_id))
                return
            if parsed.path == "/api/knowledge/topology":
                self.send_engine_json(self.engine.topology(customer_id, owner_id=owner_id))
                return
            self.send_json(404, {"code": "route-missing", "error": "route missing"})
        except PermissionError as error:
            self.send_json(403, {"code": "owner-required", "status": "error", "error": str(error)})
        except Exception as error:
            self.send_json(400, {"code": "bad-request", "error": str(error)})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            payload = self.read_json()
            owner_id = self.scoped_owner_id()
            if parsed.path == "/api/knowledge/uploads/ingest":
                self.send_engine_json(self.engine.ingest_upload(payload, owner_id=owner_id))
                return
            if parsed.path == "/api/knowledge/uploads/url-ingest":
                self.send_engine_json(self.engine.ingest_url(payload, owner_id=owner_id))
                return
            if parsed.path == "/api/knowledge/rag/query":
                self.send_engine_json(self.engine.search(payload, owner_id=owner_id))
                return
            if parsed.path == "/api/knowledge/wiki-loop/run":
                customer_id = str(payload.get("customer_id") or payload.get("customerId") or "default")
                document_id = payload.get("document_id") or payload.get("documentId")
                self.send_engine_json(self.engine.run_wiki_loop(customer_id=customer_id, document_id=document_id, owner_id=owner_id))
                return
            if parsed.path == "/api/knowledge/wiki-vault/notes":
                self.send_engine_json(self.engine.save_note(payload, owner_id=owner_id))
                return
            self.send_json(404, {"code": "route-missing", "error": "route missing"})
        except PermissionError as error:
            self.send_json(403, {"code": "owner-required", "status": "error", "error": str(error)})
        except Exception as error:
            self.send_json(400, {"code": "bad-request", "error": str(error)})


def create_server(host: str, port: int, engine: KnowledgeEngine) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), KnowledgeRequestHandler)
    server.engine = engine  # type: ignore[attr-defined]
    return server


def main() -> None:
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8080"))
    engine = KnowledgeEngine(data_dir())
    server = create_server(host, port, engine)
    print(f"CAS Knowledge Engine listening on http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
