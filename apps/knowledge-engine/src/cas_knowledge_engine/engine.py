from __future__ import annotations

import hashlib
import html
import ipaddress
import base64
import io
import os
import re
import socket
import time
import zipfile
from collections import Counter
from pathlib import PurePath
from typing import Any
from urllib.parse import urlparse
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .pbs_client import PBSHttpClient
from .storage import build_store, empty_store

TOKEN_RE = re.compile(r"[0-9A-Za-z가-힣_./:-]{2,}")
TAG_RE = re.compile(r"<[^>]+>")
WIKI_LINK_RE = re.compile(r"\[\[([^\]]+)\]\]")
HASHTAG_RE = re.compile(r"(?<![\w/])#([0-9A-Za-z가-힣][0-9A-Za-z가-힣_-]{1,63})")
URL_SIGNAL_RE = re.compile(r"https?://[^\s)\]}>'\"]+")
PDF_TEXT_RE = re.compile(rb"\(([^()]{2,500})\)")
UPLOAD_ALLOWED_EXTENSIONS = {
    "",
    ".csv",
    ".docx",
    ".htm",
    ".html",
    ".json",
    ".log",
    ".md",
    ".markdown",
    ".pdf",
    ".pptx",
    ".txt",
    ".xlsx",
    ".yaml",
    ".yml",
}
UPLOAD_BLOCKED_EXTENSIONS = {
    ".7z",
    ".apk",
    ".bat",
    ".bin",
    ".cmd",
    ".com",
    ".dll",
    ".dmg",
    ".exe",
    ".iso",
    ".jar",
    ".msi",
    ".ps1",
    ".rar",
    ".scr",
    ".sh",
    ".tar",
    ".tgz",
    ".war",
    ".zip",
}
UPLOAD_ALLOWED_MIME_TYPES = {
    "",
    "application/json",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/csv",
    "text/html",
    "text/markdown",
    "text/plain",
    "text/x-log",
    "text/yaml",
}
UPLOAD_MAX_DECODED_BYTES = 18 * 1024 * 1024
OFFICE_ZIP_MAX_ENTRIES = 400
OFFICE_ZIP_MAX_ENTRY_BYTES = 3 * 1024 * 1024
OFFICE_ZIP_MAX_TOTAL_XML_BYTES = 12 * 1024 * 1024
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


class NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None


def now_ms() -> int:
    return int(time.time() * 1000)


def stable_id(prefix: str, text: str) -> str:
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
    return f"{prefix}-{digest}"


def tokenize(text: str) -> list[str]:
    tokens = [token.lower().strip("._:-/") for token in TOKEN_RE.findall(text)]
    return [token for token in tokens if token and token not in STOPWORDS and len(token) > 1]


def chunk_text(text: str, size: int = 900, overlap: int = 140) -> list[str]:
    compact = re.sub(r"\s+", " ", text).strip()
    if not compact:
        return []
    chunks: list[str] = []
    step = max(1, size - overlap)
    for start in range(0, len(compact), step):
        chunk = compact[start : start + size].strip()
        if chunk:
            chunks.append(chunk)
        if start + size >= len(compact):
            break
    return chunks


def strip_html(text: str) -> str:
    no_script = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", text, flags=re.IGNORECASE | re.DOTALL)
    stripped = TAG_RE.sub(" ", no_script)
    return html.unescape(re.sub(r"\s+", " ", stripped)).strip()


def strip_xml_text(text: str) -> str:
    stripped = re.sub(r"<[^>]+>", " ", text)
    return html.unescape(re.sub(r"\s+", " ", stripped)).strip()


def decode_binary_text(raw: bytes) -> str:
    for encoding in ("utf-8", "utf-16", "cp949", "latin-1"):
        try:
            text = raw.decode(encoding)
            cleaned = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]+", " ", text)
            if len(tokenize(cleaned)) >= 3:
                return cleaned
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def extract_office_zip_text(raw: bytes, prefixes: tuple[str, ...]) -> str:
    parts: list[str] = []
    total_xml_bytes = 0
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        infos = archive.infolist()
        if len(infos) > OFFICE_ZIP_MAX_ENTRIES:
            raise ValueError("office upload has too many archive entries")
        for info in sorted(infos, key=lambda item: item.filename):
            name = info.filename
            if not name.endswith(".xml") or not name.startswith(prefixes):
                continue
            if info.file_size > OFFICE_ZIP_MAX_ENTRY_BYTES:
                raise ValueError("office upload XML entry is too large")
            total_xml_bytes += info.file_size
            if total_xml_bytes > OFFICE_ZIP_MAX_TOTAL_XML_BYTES:
                raise ValueError("office upload XML payload is too large")
            parts.append(strip_xml_text(archive.read(info).decode("utf-8", errors="replace")))
    return "\n".join(part for part in parts if part).strip()


def extract_pdf_text(raw: bytes) -> str:
    snippets = []
    for match in PDF_TEXT_RE.finditer(raw[:8_000_000]):
        value = match.group(1).replace(rb"\\(", b"(").replace(rb"\\)", b")")
        text = value.decode("utf-8", errors="replace").strip()
        if len(text) >= 2:
            snippets.append(text)
    if snippets:
        return re.sub(r"\s+", " ", " ".join(snippets)).strip()
    return decode_binary_text(raw)


def extract_uploaded_text(title: str, payload: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    validate_upload_policy(title, payload)
    text = str(payload.get("content") or payload.get("text") or "")
    if text:
        return text, {"parser": "text"}

    encoded = payload.get("content_base64") or payload.get("file_base64") or payload.get("data_base64")
    raw: bytes | None = None
    if isinstance(encoded, str) and encoded.strip():
        raw = base64.b64decode(encoded, validate=True)
    elif isinstance(payload.get("file_bytes"), list):
        raw = bytes(int(value) & 0xFF for value in payload["file_bytes"])

    if raw is None:
        return "", {"parser": "empty"}
    if len(raw) > UPLOAD_MAX_DECODED_BYTES:
        raise ValueError(f"decoded upload exceeds {UPLOAD_MAX_DECODED_BYTES} bytes")

    lowered = title.lower()
    mime_type = str(payload.get("mime_type") or payload.get("mimeType") or "").lower()
    parser = "binary-text"
    try:
        if lowered.endswith(".docx") or "wordprocessingml" in mime_type:
            parser = "docx-xml"
            text = extract_office_zip_text(raw, ("word/document.xml", "word/header", "word/footer"))
        elif lowered.endswith(".pptx") or "presentationml" in mime_type:
            parser = "pptx-xml"
            text = extract_office_zip_text(raw, ("ppt/slides/", "ppt/notesSlides/"))
        elif lowered.endswith(".xlsx") or "spreadsheetml" in mime_type:
            parser = "xlsx-xml"
            text = extract_office_zip_text(raw, ("xl/sharedStrings.xml", "xl/worksheets/"))
        elif lowered.endswith(".pdf") or mime_type == "application/pdf":
            parser = "pdf-lite"
            text = extract_pdf_text(raw)
        else:
            text = decode_binary_text(raw)
    except Exception as error:
        if isinstance(error, ValueError) and (
            "too large" in str(error) or "too many archive entries" in str(error)
        ):
            raise
        parser = f"{parser}-fallback"
        text = decode_binary_text(raw)
        return text, {"parser": parser, "byte_size": len(raw), "parser_warning": str(error)}
    return text, {"parser": parser, "byte_size": len(raw)}


def upload_extension(title: str) -> str:
    name = PurePath(str(title or "")).name.lower()
    return PurePath(name).suffix


def upload_mime_type(payload: dict[str, Any]) -> str:
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    return str(payload.get("mime_type") or payload.get("mimeType") or metadata.get("mime_type") or "").split(";")[0].strip().lower()


def validate_upload_policy(title: str, payload: dict[str, Any]) -> None:
    extension = upload_extension(title)
    mime_type = upload_mime_type(payload)
    if extension in UPLOAD_BLOCKED_EXTENSIONS:
        raise ValueError(f"upload extension {extension} is not allowed")
    if extension not in UPLOAD_ALLOWED_EXTENSIONS:
        raise ValueError(f"upload extension {extension or '(none)'} is not in the allowed document set")
    if mime_type and mime_type not in UPLOAD_ALLOWED_MIME_TYPES and not mime_type.startswith("text/"):
        raise ValueError(f"upload MIME type {mime_type} is not allowed")


def validate_encoded_upload_size(payload: dict[str, Any]) -> None:
    encoded = payload.get("content_base64") or payload.get("file_base64") or payload.get("data_base64")
    if isinstance(encoded, str) and encoded.strip():
        raw = base64.b64decode(encoded, validate=True)
        if len(raw) > UPLOAD_MAX_DECODED_BYTES:
            raise ValueError(f"decoded upload exceeds {UPLOAD_MAX_DECODED_BYTES} bytes")
    elif isinstance(payload.get("file_bytes"), list) and len(payload["file_bytes"]) > UPLOAD_MAX_DECODED_BYTES:
        raise ValueError(f"decoded upload exceeds {UPLOAD_MAX_DECODED_BYTES} bytes")


def payload_bool(payload: dict[str, Any], *keys: str, default: bool) -> bool:
    for key in keys:
        if key not in payload:
            continue
        value = payload[key]
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            lowered = value.strip().lower()
            if lowered in {"true", "1", "yes", "y", "on"}:
                return True
            if lowered in {"false", "0", "no", "n", "off"}:
                return False
        return bool(value)
    return default


def source_metadata(payload: dict[str, Any], customer_id: str) -> dict[str, Any]:
    candidate = payload.get("source_metadata")
    if not isinstance(candidate, dict):
        candidate = payload.get("sourceMetadata")
    metadata = dict(candidate) if isinstance(candidate, dict) else {}
    metadata.setdefault("customer_id", customer_id)
    return metadata


def pbs_created_by(payload: dict[str, Any], owner_id: str) -> str:
    return str(
        payload.get("created_by")
        or payload.get("createdBy")
        or payload.get("owner_user_id")
        or payload.get("ownerUserId")
        or owner_id
    )


def pbs_common_payload(payload: dict[str, Any], *, customer_id: str, owner_id: str, source_kind: str) -> dict[str, Any]:
    return {
        "created_by": pbs_created_by(payload, owner_id),
        "source_scope": str(payload.get("source_scope") or payload.get("sourceScope") or "user_upload"),
        "visibility": str(payload.get("visibility") or "private_user"),
        "source_kind": str(payload.get("source_kind") or payload.get("sourceKind") or source_kind),
        "source_metadata": source_metadata(payload, customer_id),
        "force_reingest": payload_bool(payload, "force_reingest", "forceReingest", default=False),
        "index": payload_bool(payload, "index", default=True),
    }


def top_terms(text: str, limit: int = 8) -> list[str]:
    counts = Counter(tokenize(text))
    return [term for term, _count in counts.most_common(limit)]


def is_private_hostname(hostname: str) -> bool:
    lowered = hostname.lower().strip(".")
    if lowered in {"localhost", "0.0.0.0"} or lowered.endswith(".local"):
        return True
    try:
        ip = ipaddress.ip_address(lowered)
        return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
    except ValueError:
        pass
    try:
        for _family, _type, _proto, _canonname, sockaddr in socket.getaddrinfo(lowered, None):
            ip = ipaddress.ip_address(sockaddr[0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                return True
    except OSError:
        return True
    return False


def validated_public_http_url(url: str) -> Any:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("only http and https URLs are supported")
    if parsed.username or parsed.password:
        raise ValueError("URL credentials are not allowed")
    if is_private_hostname(parsed.hostname):
        raise ValueError("private, loopback, or unresolved URL targets are blocked")
    return parsed


def fetch_public_url_text(url: str) -> str:
    request = Request(url, headers={"User-Agent": "Cywell-KnowledgeEngine/0.1.4"})
    opener = build_opener(NoRedirectHandler)
    try:
        with opener.open(request, timeout=8) as response:
            final_url = response.geturl()
            if final_url and final_url != url:
                validated_public_http_url(final_url)
            return response.read(1_500_000).decode("utf-8", errors="replace")
    except HTTPError as error:
        if 300 <= int(error.code or 0) <= 399:
            location = error.headers.get("Location", "")
            raise ValueError(f"URL redirects are blocked for guarded ingest: {location}") from error
        raise


class KnowledgeEngine:
    def __init__(self, data_dir: str | os.PathLike[str]):
        self.provider_id = os.environ.get("CAS_KNOWLEDGE_PROVIDER", "pbs-compatible-local").strip() or "pbs-compatible-local"
        self.owner_mode = os.environ.get("CAS_KNOWLEDGE_OWNER_MODE", "single").strip() or "single"
        self.single_owner = os.environ.get("CAS_KNOWLEDGE_SINGLE_OWNER", "cas-local").strip() or "cas-local"
        self.database_url = os.environ.get("DATABASE_URL", "").strip()
        self.store = build_store(data_dir, self.database_url)
        self.pbs = PBSHttpClient()

    def _empty_store(self) -> dict[str, Any]:
        return empty_store()

    def load_store(self) -> dict[str, Any]:
        return self.store.load()

    def save_store(self, store: dict[str, Any]) -> None:
        self.store.save(store)

    def owner_id(self, owner_id: str | None = None) -> str:
        return str(owner_id or self.single_owner or "cas-local")

    def _in_scope(self, item: dict[str, Any], *, customer_id: str, owner_id: str) -> bool:
        return item.get("customer_id") == customer_id and str(item.get("owner_id") or self.single_owner) == owner_id

    def _pbs_shadow_enabled(self) -> bool:
        return self.provider_id == "pbs-http-shadow"

    def _pbs_live_enabled(self) -> bool:
        return self.provider_id in {"pbs-http-live", "pbs-http"}

    def _pbs_enabled(self) -> bool:
        return self._pbs_shadow_enabled() or self._pbs_live_enabled()

    def _with_shadow(self, payload: dict[str, Any], operation: str, pbs_result: Any) -> dict[str, Any]:
        payload["pbs_shadow"] = {
            "operation": operation,
            **pbs_result.trace(),
        }
        return payload

    def _with_shadow_write(self, payload: dict[str, Any], operation: str, call: Any) -> dict[str, Any]:
        if not self.pbs.shadow_writes:
            payload["pbs_shadow"] = {
                "operation": operation,
                "ok": True,
                "status": 0,
                "elapsed_ms": 0,
                "path": "",
                "skipped": True,
                "reason": "CAS_PBS_SHADOW_WRITES is not true",
            }
            return payload
        return self._with_shadow(payload, operation, call())

    def _pbs_error_payload(self, operation: str, pbs_result: Any) -> dict[str, Any]:
        return {
            "status": "error",
            "provider": "pbs-http-live",
            "error": pbs_result.error or "PBS request failed",
            "pbs": {
                "operation": operation,
                **pbs_result.trace(),
                "body": pbs_result.body,
            },
        }

    def _pbs_body(self, operation: str, pbs_result: Any, defaults: dict[str, Any] | None = None) -> dict[str, Any]:
        if not pbs_result.ok:
            return self._pbs_error_payload(operation, pbs_result)
        body = dict(pbs_result.body)
        for key, value in (defaults or {}).items():
            body.setdefault(key, value)
        body.setdefault("status", "ok")
        body["provider"] = "pbs-http-live" if self._pbs_live_enabled() else self.provider_id
        body["pbs"] = {
            "operation": operation,
            **pbs_result.trace(),
        }
        return body

    def _pbs_scope_value(self, value: Any) -> str:
        return str(value or "").strip()

    def _pbs_scope_mismatches(
        self, value: Any, *, customer_id: str, owner_id: str, path: str = "$"
    ) -> list[dict[str, str]]:
        if not isinstance(value, (dict, list)):
            return []
        expected_customer_id = self._pbs_scope_value(customer_id)
        expected_owner_values = {
            self._pbs_scope_value(owner_id),
            self._pbs_scope_value(self.pbs.owner_id(owner_id)),
        }
        owner_keys = {"owner_id", "ownerId", "owner_user_id", "ownerUserId", "user_id", "userId", "created_by", "createdBy"}
        customer_keys = {"customer_id", "customerId"}
        mismatches: list[dict[str, str]] = []

        def walk(candidate: Any, current_path: str) -> None:
            if isinstance(candidate, dict):
                for key, item in candidate.items():
                    item_path = f"{current_path}.{key}"
                    observed = self._pbs_scope_value(item)
                    if key in customer_keys and observed and expected_customer_id and observed != expected_customer_id:
                        mismatches.append(
                            {"path": item_path, "expected": expected_customer_id, "observed": observed, "scope": "customer_id"}
                        )
                    if key in owner_keys and observed and observed not in expected_owner_values:
                        mismatches.append(
                            {
                                "path": item_path,
                                "expected": self._pbs_scope_value(self.pbs.owner_id(owner_id)),
                                "observed": observed,
                                "scope": "owner",
                            }
                        )
                    if isinstance(item, (dict, list)):
                        walk(item, item_path)
            elif isinstance(candidate, list):
                for index, item in enumerate(candidate):
                    walk(item, f"{current_path}[{index}]")

        walk(value, path)
        return mismatches

    def _pbs_scope_error_payload(self, operation: str, pbs_result: Any, mismatches: list[dict[str, str]]) -> dict[str, Any]:
        payload = self._pbs_error_payload(operation, pbs_result)
        payload["code"] = "pbs-scope-mismatch"
        payload["error"] = "PBS response scope mismatch"
        payload["pbs"]["scope_mismatches"] = mismatches[:25]
        return payload

    def _pbs_scoped_body(
        self,
        operation: str,
        pbs_result: Any,
        *,
        customer_id: str,
        owner_id: str,
        defaults: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if pbs_result.ok:
            mismatches = self._pbs_scope_mismatches(pbs_result.body, customer_id=customer_id, owner_id=owner_id)
            if mismatches:
                return self._pbs_scope_error_payload(operation, pbs_result, mismatches)
        return self._pbs_body(operation, pbs_result, defaults)

    def _pbs_upload_payload(self, pbs_result: Any, *, customer_id: str, owner_id: str) -> dict[str, Any]:
        body = self._pbs_scoped_body("upload_ingest", pbs_result, customer_id=customer_id, owner_id=owner_id, defaults={"status": "indexed"})
        if body.get("status") == "error":
            return body
        if body.get("status") == "ok":
            body["status"] = "indexed"
        body.setdefault("chunks_indexed", int(body.get("indexed_count") or body.get("chunk_count") or 0))
        document = body.get("document") if isinstance(body.get("document"), dict) else {}
        if not document:
            document_source_id = str(body.get("document_source_id") or body.get("id") or "")
            document = {
                "id": document_source_id,
                "title": str(body.get("title") or body.get("filename") or body.get("file_name") or document_source_id or "pbs-upload"),
                "status": body.get("status"),
                "metadata": {
                    "pbs_document_source_id": document_source_id,
                    "pbs_response_schema": body.get("schema_version", ""),
                },
            }
            body["document"] = document
        return body

    def _pbs_search_payload(self, question: str, pbs_result: Any, *, customer_id: str, owner_id: str) -> dict[str, Any]:
        body = self._pbs_scoped_body("chat", pbs_result, customer_id=customer_id, owner_id=owner_id, defaults={"status": "ok"})
        if body.get("status") == "error":
            return body
        body.setdefault("question", question)
        body.setdefault("answer", body.get("response") or body.get("message") or "")
        body.setdefault("citations", body.get("sources") if isinstance(body.get("sources"), list) else [])
        trace = body.get("trace") if isinstance(body.get("trace"), dict) else {}
        trace["retriever"] = "pbs-http"
        trace["pbs"] = body["pbs"]
        body["trace"] = trace
        return body

    def _pbs_wiki_loop_payload(self, pbs_result: Any, *, customer_id: str, owner_id: str) -> dict[str, Any]:
        body = self._pbs_scoped_body("wiki_loop_run", pbs_result, customer_id=customer_id, owner_id=owner_id, defaults={"status": "ok"})
        if body.get("status") == "error":
            return body
        summary = body.get("summary") if isinstance(body.get("summary"), dict) else {}
        body.setdefault("notes_upserted", int(summary.get("compiled_note_count") or body.get("compiled_note_count") or 0))
        return body

    def _pbs_reports_payload(self, pbs_result: Any, *, customer_id: str, owner_id: str) -> dict[str, Any]:
        body = self._pbs_scoped_body("upload_reports", pbs_result, customer_id=customer_id, owner_id=owner_id, defaults={"status": "ok"})
        if body.get("status") == "error":
            return body
        items = body.get("items") if isinstance(body.get("items"), list) else body.get("documents") if isinstance(body.get("documents"), list) else []
        body.setdefault("documents", items)
        body.setdefault("counts", {"documents": len(items), "events": 0})
        return body

    def _pbs_health_int(self, value: Any) -> int:
        try:
            return int(value or 0)
        except (TypeError, ValueError):
            return 0

    def _pbs_health_readiness(self, body: dict[str, Any]) -> dict[str, Any]:
        runtime = body.get("runtime") if isinstance(body.get("runtime"), dict) else {}
        db_corpus = runtime.get("db_corpus") if isinstance(runtime.get("db_corpus"), dict) else {}
        compiled_wiki_status = (
            runtime.get("compiled_wiki_status") if isinstance(runtime.get("compiled_wiki_status"), dict) else {}
        )
        schema_embedding_dim = self._pbs_health_int(
            runtime.get("schema_embedding_dim") or db_corpus.get("schema_embedding_dimensions")
        )
        embedding_dim = self._pbs_health_int(runtime.get("embedding_dim"))
        missing_embeddings = self._pbs_health_int(db_corpus.get("missing_embedding_index_entries"))
        stale_embeddings = self._pbs_health_int(db_corpus.get("stale_embedding_index_entries"))
        return {
            "pbs_health_ok": body.get("ok") is True or body.get("status") == "ok",
            "database_runtime": bool(runtime.get("database_runtime")),
            "db_ready": bool(runtime.get("db_ready") or db_corpus.get("db_ready")),
            "pgvector_ready": bool(runtime.get("pgvector_ready") or db_corpus.get("pgvector_ready")),
            "embedding_model": str(runtime.get("embedding_model") or db_corpus.get("embedding_model") or ""),
            "embedding_dim": embedding_dim,
            "schema_embedding_dim": schema_embedding_dim,
            "embedding_index_parity": bool(db_corpus.get("embedding_index_parity")),
            "missing_embedding_index_entries": missing_embeddings,
            "stale_embedding_index_entries": stale_embeddings,
            "db_corpus_ready": bool(db_corpus.get("ready")),
            "ready_scopes": list(db_corpus.get("ready_scopes") or []),
            "compiled_wiki_ready": bool(compiled_wiki_status.get("ready") or compiled_wiki_status.get("exists")),
        }

    def _pbs_runtime_ready_required(self) -> bool:
        value = os.environ.get("CAS_PBS_REQUIRE_RUNTIME_READY")
        if value is None:
            return False
        return value.strip().lower() in {"1", "true", "yes", "y", "on"}

    def _pbs_corpus_ready_required(self) -> bool:
        value = os.environ.get("CAS_PBS_REQUIRE_CORPUS_READY")
        if value is None:
            return self._pbs_runtime_ready_required()
        return value.strip().lower() in {"1", "true", "yes", "y", "on"}

    def _pbs_required_ready_scopes(self) -> list[str]:
        raw = os.environ.get("CAS_PBS_REQUIRED_READY_SCOPES", "official_docs,study_docs")
        return [scope.strip() for scope in raw.split(",") if scope.strip()]

    def _pbs_readiness_ok(self, readiness: dict[str, Any]) -> bool:
        runtime_ok = bool(readiness.get("pbs_health_ok")) and bool(readiness.get("database_runtime")) and bool(readiness.get("db_ready")) and bool(
            readiness.get("pgvector_ready")
        )
        if not runtime_ok:
            return False
        if not self._pbs_corpus_ready_required():
            return True
        ready_scopes = set(str(scope) for scope in readiness.get("ready_scopes") or [])
        required_scopes = self._pbs_required_ready_scopes()
        return (
            int(readiness.get("schema_embedding_dim") or 0) > 0
            and bool(readiness.get("embedding_index_parity"))
            and int(readiness.get("missing_embedding_index_entries") or 0) == 0
            and int(readiness.get("stale_embedding_index_entries") or 0) == 0
            and bool(readiness.get("db_corpus_ready"))
            and bool(readiness.get("compiled_wiki_ready"))
            and all(scope in ready_scopes for scope in required_scopes)
        )

    def _pbs_graph_candidates(self, body: dict[str, Any]) -> list[dict[str, Any]]:
        candidates: list[dict[str, Any]] = []
        for candidate in [
            body.get("graph"),
            body.get("topology", {}).get("graph") if isinstance(body.get("topology"), dict) else None,
            body.get("topology"),
            body,
        ]:
            if isinstance(candidate, dict) and candidate not in candidates:
                candidates.append(candidate)
        return candidates

    def _pbs_graph_candidate(self, body: dict[str, Any]) -> dict[str, Any]:
        for candidate in self._pbs_graph_candidates(body):
            for key in ["nodes", "entities", "vertices", "edges", "links", "relations", "relationships"]:
                if isinstance(candidate.get(key), list):
                    return candidate
        return {}

    def _pbs_first_list(self, candidate: dict[str, Any], keys: list[str]) -> list[Any]:
        if not isinstance(candidate, dict):
            return []
        for key in keys:
            value = candidate.get(key)
            if isinstance(value, list):
                return value
        return []

    def _pbs_count(self, candidate: dict[str, Any], body: dict[str, Any], key: str, fallback: int) -> int:
        return self._pbs_count_any(candidate, body, [key, f"{key}_count", f"graph_{key}_count"], fallback)

    def _pbs_count_any(self, candidate: dict[str, Any], body: dict[str, Any], keys: list[str], fallback: int) -> int:
        for source in [candidate.get("counts") if isinstance(candidate.get("counts"), dict) else None, body.get("counts") if isinstance(body.get("counts"), dict) else None, body.get("summary") if isinstance(body.get("summary"), dict) else None]:
            if not isinstance(source, dict):
                continue
            for count_key in keys:
                try:
                    if count_key in source:
                        return max(fallback, int(source[count_key] or 0))
                except (TypeError, ValueError):
                    continue
        return fallback

    def _pbs_node_ref(self, value: Any) -> str:
        if isinstance(value, dict):
            return str(
                value.get("id")
                or value.get("node_id")
                or value.get("key")
                or value.get("slug")
                or value.get("entity_id")
                or value.get("document_source_id")
                or ""
            ).strip()
        return str(value or "").strip()

    def _pbs_node_payload(self, value: Any, *, fallback_id: str, fallback_type: str = "pbs-node") -> dict[str, Any]:
        if isinstance(value, dict):
            node_id = self._pbs_node_ref(value) or fallback_id
            metadata = value.get("metadata") if isinstance(value.get("metadata"), dict) else {}
            provenance = value.get("provenance") if isinstance(value.get("provenance"), dict) else {}
            source_document_id = (
                value.get("source_document_id")
                or value.get("document_id")
                or value.get("document_source_id")
                or metadata.get("source_document_id")
                or metadata.get("document_id")
                or provenance.get("source_document_id")
            )
            payload = {
                "id": node_id,
                "type": str(value.get("type") or value.get("kind") or value.get("entity_type") or value.get("category") or fallback_type),
                "label": str(value.get("label") or value.get("title") or value.get("name") or value.get("summary") or node_id),
                "summary": str(value.get("summary") or value.get("body") or value.get("image_summary") or ""),
                "status": str(value.get("status") or value.get("source") or value.get("vision_status") or "pbs"),
            }
            if metadata:
                payload["metadata"] = metadata
            if provenance:
                payload["provenance"] = provenance
            if source_document_id:
                payload["source_document_id"] = str(source_document_id)
            for key in [
                "revision",
                "previous_revision",
                "document_id",
                "document_source_id",
                "updated_at",
                "degree",
                "weight",
                "viewer_path",
                "note_type",
                "compiled_wiki",
                "entity_kind",
                "source_kind",
                "source_url",
                "ready_for_chat",
                "basic_index_ready",
            ]:
                if key in value:
                    payload[key] = value[key]
            return payload
        node_id = self._pbs_node_ref(value) or fallback_id
        return {"id": node_id, "type": fallback_type, "label": node_id, "summary": "", "status": "pbs"}

    def _topology_from_pbs_vault(self, body: dict[str, Any], *, customer_id: str, owner_id: str) -> dict[str, Any]:
        candidate = self._pbs_graph_candidate(body)
        raw_nodes = self._pbs_first_list(candidate, ["nodes", "entities", "vertices"])
        raw_edges = self._pbs_first_list(candidate, ["edges", "links", "relations", "relationships"])
        nodes: list[dict[str, Any]] = []
        node_ids: set[str] = set()
        def add_node(value: Any, *, fallback_id: str, fallback_type: str = "pbs-node") -> str:
            node = self._pbs_node_payload(value, fallback_id=fallback_id, fallback_type=fallback_type)
            node_id = str(node.get("id") or fallback_id)
            if node_id not in node_ids:
                nodes.append(node)
                node_ids.add(node_id)
            return node_id

        for index, node in enumerate(item for item in raw_nodes if isinstance(item, dict)):
            add_node(node, fallback_id=f"pbs-node-{index}")
        edges: list[dict[str, Any]] = []
        for index, edge in enumerate(item for item in raw_edges if isinstance(item, dict)):
            source_value = edge.get("source") or edge.get("from") or edge.get("subject") or edge.get("source_id") or edge.get("subject_id")
            target_value = edge.get("target") or edge.get("to") or edge.get("object") or edge.get("target_id") or edge.get("object_id")
            source = self._pbs_node_ref(source_value)
            target = self._pbs_node_ref(target_value)
            if source and target:
                if source not in node_ids:
                    source = add_node(source_value, fallback_id=source, fallback_type="pbs-endpoint")
                if target not in node_ids:
                    target = add_node(target_value, fallback_id=target, fallback_type="pbs-endpoint")
                edge_payload: dict[str, Any] = {
                    "source": source,
                    "target": target,
                    "type": str(edge.get("type") or edge.get("kind") or "relates"),
                }
                metadata = edge.get("metadata") if isinstance(edge.get("metadata"), dict) else {}
                provenance = edge.get("provenance") if isinstance(edge.get("provenance"), dict) else {}
                if metadata:
                    edge_payload["metadata"] = metadata
                if provenance:
                    edge_payload["provenance"] = provenance
                for key in ["revision", "previous_revision", "source_document_id", "document_id", "updated_at"]:
                    if key in edge:
                        edge_payload[key] = edge[key]
                edges.append(edge_payload)
            elif len(nodes) > 1:
                edges.append({"source": nodes[0]["id"], "target": nodes[(index % (len(nodes) - 1)) + 1]["id"], "type": "relates"})
        document_count = self._pbs_count_any(
            candidate,
            body,
            ["documents", "documents_count", "document_count", "document_node_count", "upload_node_count", "source_count"],
            len([node for node in nodes if str(node["type"]) in {"document", "upload", "source", "upload_document", "web_url_source"}]),
        )
        upload_count = self._pbs_count_any(candidate, body, ["uploads", "uploads_count", "upload_count", "upload_node_count"], 0)
        note_count = self._pbs_count_any(
            candidate,
            body,
            ["notes", "notes_count", "note_count", "wiki_note_count"],
            len([node for node in nodes if str(node["type"]).replace("_", "-") in {"note", "wiki-note"}]),
        )
        compiled_count = self._pbs_count_any(candidate, body, ["compiled", "compiled_count", "compiled_note_count"], 0)
        wikilink_count = self._pbs_count_any(candidate, body, ["wikilinks", "wikilinks_count", "wikilink_count"], len([node for node in nodes if str(node["type"]) in {"wikilink", "link"}]))
        tag_count = self._pbs_count_any(candidate, body, ["tags", "tags_count", "tag_count"], len([node for node in nodes if str(node["type"]) == "tag"]))
        entity_count = self._pbs_count_any(candidate, body, ["entities", "entities_count", "entity_count", "entity_node_count"], len([node for node in nodes if str(node["type"]) == "entity"]))
        concept_count = self._pbs_count_any(candidate, body, ["concepts", "concepts_count", "concept_count", "concept_node_count"], len([node for node in nodes if str(node["type"]) == "concept"]))
        relation_count = self._pbs_count_any(candidate, body, ["relations", "relations_count", "relation_count", "graph_relation_count", "edge_count"], len(edges))
        return {
            "status": "ok",
            "customer_id": customer_id,
            "owner_mode": self.owner_mode,
            "provider": "pbs-http-live",
            "nodes": nodes,
            "edges": edges,
            "counts": {
                "documents": document_count,
                "uploads": upload_count,
                "notes": note_count,
                "compiled": compiled_count,
                "wikilinks": wikilink_count,
                "tags": tag_count,
                "entities": entity_count + concept_count,
                "concepts": concept_count,
                "relations": relation_count,
                "nodes": len(nodes),
                "edges": len(edges),
            },
            "pbs": {
                "schema_version": body.get("schema_version", ""),
                "summary": body.get("summary", {}),
                "top_wikilinks": body.get("top_wikilinks", []),
                "top_tags": body.get("top_tags", []),
                "relations": body.get("relations", []),
                "selected_context": body.get("selected_context", []),
                "selected_uploads": body.get("selected_uploads", []),
            },
        }

    def capabilities(self) -> list[dict[str, Any]]:
        return [
            {
                "id": "customer-data-upload",
                "label": "고객 데이터 업로드",
                "endpoint": "/api/knowledge/uploads/ingest",
                "state": "ready",
                "source": "CAS PBS-compatible ingest adapter",
            },
            {
                "id": "url-ingest",
                "label": "URL ingest",
                "endpoint": "/api/knowledge/uploads/url-ingest",
                "state": "ready",
                "source": "CAS guarded URL ingest adapter",
            },
            {
                "id": "upload-reports",
                "label": "업로드 리포트",
                "endpoint": "/api/knowledge/uploads/reports",
                "state": "ready",
                "source": "CAS ingest report adapter",
            },
            {
                "id": "rag-query",
                "label": "RAG 질의",
                "endpoint": "/api/knowledge/rag/query",
                "state": "ready",
                "source": "CAS local retrieval adapter",
            },
            {
                "id": "llm-wiki-loop",
                "label": "LLM Wiki loop",
                "endpoint": "/api/knowledge/wiki-loop/run",
                "state": "ready",
                "source": "CAS wiki compiler adapter",
            },
            {
                "id": "wiki-vault",
                "label": "Wiki Vault",
                "endpoint": "/api/knowledge/wiki-vault",
                "state": "ready",
                "source": "CAS wiki vault adapter",
            },
            {
                "id": "topology-dashboard",
                "label": "Topology dashboard",
                "endpoint": "/api/knowledge/topology",
                "state": "ready",
                "source": "CAS knowledge topology adapter",
            },
        ]

    def health(self) -> dict[str, Any]:
        status = "ok"
        try:
            store = self.load_store()
        except Exception:
            status = "degraded"
            store = self._empty_store()
        storage = self.store.health()
        pbs_health: dict[str, Any] = {
            "configured": self.pbs.configured,
            "mode": self.provider_id,
        }
        if self._pbs_enabled():
            pbs_result = self.pbs.health(owner_id=self.single_owner)
            pbs_health.update(pbs_result.trace())
            if pbs_result.ok:
                readiness = self._pbs_health_readiness(pbs_result.body)
                pbs_health["readiness"] = readiness
                if self._pbs_live_enabled() and self._pbs_runtime_ready_required() and not self._pbs_readiness_ok(readiness):
                    status = "degraded"
            if self._pbs_live_enabled() and not pbs_result.ok:
                status = "degraded"
        return {
            "status": status,
            "service": "cas-knowledge-engine",
            "version": "0.1.4",
            "provider": self.provider_id,
            "provider_config": {
                "mode": "pbs-http-adapter" if self._pbs_enabled() else "cas-pbs-compatible-adapter",
                "owner_mode": self.owner_mode,
                "pbs_reference": "PlaybookStudio upload/RAG/wiki/topology contract",
                "pbs_http": pbs_health,
            },
            "storage": storage,
            "counts": {
                "documents": len(store["documents"]),
                "chunks": len(store["chunks"]),
                "notes": len(store["notes"]),
            },
            "capabilities": self.capabilities(),
        }

    def ingest_text(
        self,
        *,
        title: str,
        content: str,
        source_type: str = "upload",
        source_uri: str | None = None,
        customer_id: str = "default",
        owner_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        clean_content = strip_html(content) if source_type == "url" else re.sub(r"\s+", " ", content).strip()
        if not clean_content:
            raise ValueError("content is empty")

        resolved_owner_id = self.owner_id(owner_id)
        document_id = stable_id("doc", f"{resolved_owner_id}:{customer_id}:{source_type}:{source_uri or title}:{clean_content[:2048]}")
        created_at = now_ms()
        chunks = chunk_text(clean_content)
        terms = top_terms(clean_content)
        store = self.load_store()
        store["documents"] = [doc for doc in store["documents"] if doc["id"] != document_id]
        store["chunks"] = [chunk for chunk in store["chunks"] if chunk["document_id"] != document_id]

        document = {
            "id": document_id,
            "customer_id": customer_id,
            "owner_id": resolved_owner_id,
            "title": title or document_id,
            "source_type": source_type,
            "source_uri": source_uri,
            "created_at": created_at,
            "updated_at": created_at,
            "status": "indexed",
            "terms": terms,
            "metadata": metadata or {},
            "summary": clean_content[:360],
            "chunk_count": len(chunks),
            "bytes": len(clean_content.encode("utf-8")),
        }
        chunk_rows = [
            {
                "id": stable_id("chunk", f"{document_id}:{index}:{chunk}"),
                "document_id": document_id,
                "customer_id": customer_id,
                "owner_id": resolved_owner_id,
                "index": index,
                "text": chunk,
                "terms": top_terms(chunk, 12),
            }
            for index, chunk in enumerate(chunks)
        ]
        store["documents"].append(document)
        store["chunks"].extend(chunk_rows)
        store["events"].append(
            {
                "id": stable_id("event", f"{document_id}:{created_at}"),
                "type": "document_ingested",
                "document_id": document_id,
                "customer_id": customer_id,
                "owner_id": resolved_owner_id,
                "created_at": created_at,
            }
        )
        self.save_store(store)
        wiki_result = self.run_wiki_loop(customer_id=customer_id, document_id=document_id, owner_id=resolved_owner_id)
        return {
            "status": "indexed",
            "document": document,
            "chunks_indexed": len(chunk_rows),
            "wiki": wiki_result,
        }

    def ingest_upload(self, payload: dict[str, Any], owner_id: str | None = None) -> dict[str, Any]:
        resolved_owner_id = self.owner_id(owner_id)
        title = str(
            payload.get("file_name") or payload.get("fileName") or payload.get("filename") or payload.get("title") or "uploaded-document"
        )
        validate_upload_policy(title, payload)
        validate_encoded_upload_size(payload)
        customer_id = str(payload.get("customer_id") or payload.get("customerId") or "default")
        if self._pbs_live_enabled():
            return self._pbs_upload_payload(self.pbs.upload_ingest(payload, resolved_owner_id), customer_id=customer_id, owner_id=resolved_owner_id)
        content, parser_metadata = extract_uploaded_text(title, payload)
        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
        pbs_payload = {
            **pbs_common_payload(payload, customer_id=customer_id, owner_id=resolved_owner_id, source_kind="upload"),
            "file_name": title,
            "mime_type": str(payload.get("mime_type") or payload.get("mimeType") or metadata.get("mime_type") or ""),
            "content_fields": sorted(
                field
                for field in ["content", "text", "content_base64", "file_base64", "data_base64", "file_bytes"]
                if payload.get(field) is not None
            ),
        }
        metadata = {
            **metadata,
            **parser_metadata,
            "mime_type": str(payload.get("mime_type") or payload.get("mimeType") or metadata.get("mime_type") or ""),
            "source_scope": pbs_payload["source_scope"],
            "visibility": pbs_payload["visibility"],
            "pbs_payload": pbs_payload,
            "pbs_payload_fields": sorted(
                field
                for field in ["content", "text", "content_base64", "file_base64", "data_base64", "file_bytes"]
                if payload.get(field) is not None
            ),
        }
        result = self.ingest_text(
            title=title,
            content=content,
            source_type="upload",
            source_uri=payload.get("source_uri"),
            customer_id=customer_id,
            owner_id=resolved_owner_id,
            metadata=metadata,
        )
        if self._pbs_shadow_enabled():
            return self._with_shadow_write(result, "upload_ingest", lambda: self.pbs.upload_ingest(payload, resolved_owner_id))
        return result

    def ingest_url(self, payload: dict[str, Any], owner_id: str | None = None) -> dict[str, Any]:
        resolved_owner_id = self.owner_id(owner_id)
        url = str(payload.get("url") or "").strip()
        if not url:
            raise ValueError("url is required")
        parsed = validated_public_http_url(url)
        customer_id = str(payload.get("customer_id") or payload.get("customerId") or "default")
        if self._pbs_live_enabled():
            return self._pbs_scoped_body(
                "url_ingest",
                self.pbs.url_ingest(payload, resolved_owner_id),
                customer_id=customer_id,
                owner_id=resolved_owner_id,
                defaults={"status": "indexed"},
            )
        content = str(payload.get("content") or "")
        if not content:
            content = fetch_public_url_text(url)
        title = str(payload.get("title") or parsed.netloc + parsed.path or url)
        pbs_payload = {
            **pbs_common_payload(payload, customer_id=customer_id, owner_id=resolved_owner_id, source_kind="url"),
            "url": url,
            "title": title,
            "auto_compile_wiki": payload_bool(payload, "auto_compile_wiki", "autoCompileWiki", default=True),
        }
        result = self.ingest_text(
            title=title,
            content=content,
            source_type="url",
            source_uri=url,
            customer_id=customer_id,
            owner_id=resolved_owner_id,
            metadata={
                "url": url,
                "source_scope": pbs_payload["source_scope"],
                "visibility": pbs_payload["visibility"],
                "pbs_payload": pbs_payload,
            },
        )
        if self._pbs_shadow_enabled():
            return self._with_shadow_write(result, "url_ingest", lambda: self.pbs.url_ingest(payload, resolved_owner_id))
        return result

    def _signal_list(self, values: list[str], limit: int = 12) -> list[str]:
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

    def _text_signals(self, text: str, fallback_terms: list[str] | None = None) -> dict[str, list[str]]:
        body = str(text or "")
        links = self._signal_list(WIKI_LINK_RE.findall(body))
        tags = self._signal_list(HASHTAG_RE.findall(body))
        urls = self._signal_list(URL_SIGNAL_RE.findall(body), limit=6)
        concepts = self._signal_list([*(fallback_terms or []), *top_terms(body, 8)], limit=8)
        return {"links": links, "tags": tags, "urls": urls, "concepts": concepts}

    def _local_vault_graph(self, *, customer_id: str, owner_id: str, store: dict[str, Any] | None = None) -> dict[str, Any]:
        store = store or self.load_store()
        documents = [doc for doc in store["documents"] if self._in_scope(doc, customer_id=customer_id, owner_id=owner_id)]
        notes = [note for note in store["notes"] if self._in_scope(note, customer_id=customer_id, owner_id=owner_id)]
        chunks_by_document: dict[str, list[dict[str, Any]]] = {}
        for chunk in store["chunks"]:
            if self._in_scope(chunk, customer_id=customer_id, owner_id=owner_id):
                chunks_by_document.setdefault(str(chunk.get("document_id") or ""), []).append(chunk)

        nodes: dict[str, dict[str, Any]] = {}
        edges: list[dict[str, Any]] = []
        relations: list[dict[str, Any]] = []
        backlinks: list[dict[str, Any]] = []
        wikilink_counts: Counter[str] = Counter()
        tag_counts: Counter[str] = Counter()

        def add_node(node_id: str, node_type: str, label: str, **extra: Any) -> None:
            current = nodes.get(node_id, {})
            nodes[node_id] = {
                **current,
                "id": node_id,
                "type": node_type,
                "label": label,
                **{key: value for key, value in extra.items() if value is not None},
            }

        def add_relation(source: str, target: str, relation_type: str, label: str = "", **extra: Any) -> None:
            edge_id = stable_id("edge", f"{source}:{relation_type}:{target}")
            if not any(edge.get("id") == edge_id for edge in edges):
                edge = {"id": edge_id, "source": source, "target": target, "type": relation_type, "label": label or relation_type}
                edge.update({key: value for key, value in extra.items() if value is not None})
                edges.append(edge)
            relations.append({"source": source, "target": target, "type": relation_type, "label": label or relation_type, **extra})

        for document in documents:
            doc_id = str(document["id"])
            metadata = document.get("metadata") if isinstance(document.get("metadata"), dict) else {}
            pbs_payload = metadata.get("pbs_payload") if isinstance(metadata.get("pbs_payload"), dict) else {}
            source_kind = str(pbs_payload.get("source_kind") or document.get("source_type") or "upload")
            source_url = str(document.get("source_uri") or metadata.get("url") or pbs_payload.get("url") or "")
            chunk_texts = " ".join(str(chunk.get("text") or "") for chunk in chunks_by_document.get(doc_id, []))
            signals = self._text_signals(f"{document.get('title', '')} {document.get('summary', '')} {chunk_texts}", document.get("terms", [])[:8])
            add_node(
                doc_id,
                "upload_document" if source_kind == "upload" else "web_url_source",
                str(document.get("title") or doc_id),
                summary=document.get("summary", ""),
                status=document.get("status", ""),
                document_source_id=doc_id,
                source_kind=source_kind,
                source_url=source_url or None,
                basic_index_ready=True,
            )
            for label in signals["links"]:
                wikilink_counts[label] += 1
                link_id = stable_id("wikilink", label.lower())
                add_node(link_id, "wikilink", label)
                add_relation(doc_id, link_id, "wikilink", label, source_document_id=doc_id)
            for label in signals["tags"]:
                tag_counts[label] += 1
                tag_id = stable_id("tag", label.lower())
                add_node(tag_id, "tag", label)
                add_relation(doc_id, tag_id, "tag", label, source_document_id=doc_id)
            for label in signals["concepts"][:6]:
                concept_id = stable_id("concept", label.lower())
                add_node(concept_id, "concept", label, entity_kind="concept")
                add_relation(doc_id, concept_id, "mentions", label, source_document_id=doc_id)

        for note in notes:
            note_id = str(note["id"])
            body = str(note.get("body") or "")
            signals = self._text_signals(body, [str(tag) for tag in note.get("tags", [])])
            document_id = str(note.get("document_id") or "")
            add_node(
                note_id,
                "wiki-note",
                str(note.get("title") or note_id),
                summary=body[:240],
                status=note.get("source", ""),
                revision=note.get("revision"),
                previous_revision=note.get("previous_revision"),
                document_id=document_id or None,
                source_document_id=note.get("provenance", {}).get("source_document_id") if isinstance(note.get("provenance"), dict) else document_id or None,
                provenance=note.get("provenance", {}),
                updated_at=note.get("updated_at"),
                note_type=note.get("source", ""),
                compiled_wiki=note.get("source") == "wiki-loop",
                ready_for_chat=True,
            )
            if document_id:
                add_relation(note_id, document_id, "summarizes", "summarizes", source_document_id=document_id)
            for label in signals["links"]:
                wikilink_counts[label] += 1
                link_id = stable_id("wikilink", label.lower())
                add_node(link_id, "wikilink", label)
                add_relation(note_id, link_id, "wikilink", label, source_note_id=note_id)
                backlinks.append({"source_note_id": note_id, "source_title": note.get("title", ""), "target": label, "type": "wikilink"})
            for label in signals["tags"]:
                tag_counts[label] += 1
                tag_id = stable_id("tag", label.lower())
                add_node(tag_id, "tag", label)
                add_relation(note_id, tag_id, "tag", label, source_note_id=note_id)

        degree_by_id: Counter[str] = Counter()
        for edge in edges:
            degree_by_id[str(edge["source"])] += 1
            degree_by_id[str(edge["target"])] += 1
        for node_id, node in nodes.items():
            degree = degree_by_id[node_id]
            node["degree"] = degree
            node["weight"] = round(min(1.0, 0.2 + degree / 10), 3)

        top_wikilinks = [{"label": label, "count": count} for label, count in wikilink_counts.most_common(12)]
        top_tags = [{"label": label, "count": count} for label, count in tag_counts.most_common(12)]
        selected_uploads = [
            {
                "id": document["id"],
                "title": document.get("title", ""),
                "summary": document.get("summary", ""),
                "source_kind": (document.get("metadata") or {}).get("pbs_payload", {}).get("source_kind", document.get("source_type", "")) if isinstance(document.get("metadata"), dict) else document.get("source_type", ""),
            }
            for document in documents[:8]
        ]
        selected_context = [
            {
                "id": note["id"],
                "title": note.get("title", ""),
                "body": str(note.get("body", ""))[:700],
                "source": note.get("source", ""),
                "document_id": note.get("document_id"),
            }
            for note in notes[:8]
        ]
        summary = {
            "document_node_count": len(documents),
            "upload_node_count": len([doc for doc in documents if doc.get("source_type") == "upload"]),
            "note_count": len(notes),
            "compiled_note_count": len([note for note in notes if note.get("source") == "wiki-loop"]),
            "wikilink_count": len(top_wikilinks),
            "tag_count": len(top_tags),
            "concept_node_count": len([node for node in nodes.values() if node.get("type") == "concept"]),
            "entity_node_count": len([node for node in nodes.values() if node.get("type") in {"concept", "wikilink", "tag"}]),
            "graph_relation_count": len(edges),
        }
        topology = {
            "status": "ok",
            "customer_id": customer_id,
            "owner_mode": self.owner_mode,
            "nodes": list(nodes.values()),
            "edges": edges,
            "counts": {
                "documents": len(documents),
                "uploads": summary["upload_node_count"],
                "notes": len(notes),
                "compiled": summary["compiled_note_count"],
                "wikilinks": summary["wikilink_count"],
                "tags": summary["tag_count"],
                "entities": summary["entity_node_count"],
                "concepts": summary["concept_node_count"],
                "relations": len(edges),
                "nodes": len(nodes),
                "edges": len(edges),
            },
            "pbs": {
                "schema_version": "cas-local-v1",
                "summary": summary,
                "top_wikilinks": top_wikilinks,
                "top_tags": top_tags,
                "relations": relations,
                "selected_context": selected_context,
                "selected_uploads": selected_uploads,
            },
        }
        return {
            "documents": documents,
            "notes": notes,
            "topology": topology,
            "summary": summary,
            "top_wikilinks": top_wikilinks,
            "top_tags": top_tags,
            "relations": relations,
            "backlinks": backlinks,
            "selected_context": selected_context,
            "selected_uploads": selected_uploads,
        }

    def search(self, payload: dict[str, Any], owner_id: str | None = None) -> dict[str, Any]:
        question = str(payload.get("question") or payload.get("query") or "").strip()
        customer_id = str(payload.get("customer_id") or payload.get("customerId") or "default")
        resolved_owner_id = self.owner_id(owner_id)
        if not question:
            raise ValueError("question is required")
        if self._pbs_live_enabled():
            return self._pbs_search_payload(question, self.pbs.chat(payload, resolved_owner_id), customer_id=customer_id, owner_id=resolved_owner_id)
        query_terms = tokenize(question)
        store = self.load_store()
        scored: list[tuple[int, dict[str, Any]]] = []
        for chunk in store["chunks"]:
            if not self._in_scope(chunk, customer_id=customer_id, owner_id=resolved_owner_id):
                continue
            chunk_terms = set(chunk.get("terms") or tokenize(chunk.get("text", "")))
            score = sum(3 if term in chunk_terms else 0 for term in query_terms)
            score += sum(chunk.get("text", "").lower().count(term) for term in query_terms)
            if score > 0:
                scored.append((score, chunk))
        scored.sort(key=lambda item: item[0], reverse=True)
        top_chunks = [chunk for _score, chunk in scored[:5]]
        documents = {doc["id"]: doc for doc in store["documents"]}
        citations: list[dict[str, Any]] = [
            {
                "chunk_id": chunk["id"],
                "document_id": chunk["document_id"],
                "title": documents.get(chunk["document_id"], {}).get("title", chunk["document_id"]),
                "snippet": chunk["text"][:260],
                "source": "chunk",
            }
            for chunk in top_chunks
        ]
        vault = self._local_vault_graph(customer_id=customer_id, owner_id=resolved_owner_id, store=store)
        vault_scored: list[tuple[int, dict[str, Any]]] = []
        for context in vault["selected_context"]:
            haystack = f"{context.get('title', '')} {context.get('body', '')}".lower()
            score = sum(4 if term in haystack else 0 for term in query_terms)
            score += sum(haystack.count(term) for term in query_terms)
            if score > 0:
                vault_scored.append((score, context))
        vault_scored.sort(key=lambda item: item[0], reverse=True)
        for _score, context in vault_scored[:3]:
            citations.append(
                {
                    "note_id": context["id"],
                    "document_id": context.get("document_id"),
                    "title": context.get("title", context["id"]),
                    "snippet": str(context.get("body") or "")[:260],
                    "source": "wiki-vault",
                }
            )
        answer = "관련 고객 데이터가 아직 적재되지 않았습니다."
        if citations:
            answer = " / ".join(citation["snippet"] for citation in citations[:2])
        event = {
            "id": stable_id("event", f"rag:{customer_id}:{question}:{now_ms()}"),
            "type": "rag_query",
            "customer_id": customer_id,
            "owner_id": resolved_owner_id,
            "question": question,
            "citations": [citation.get("chunk_id") or citation.get("note_id") for citation in citations],
            "created_at": now_ms(),
        }
        store["events"].append(event)
        self.save_store(store)
        result = {
            "status": "ok",
            "question": question,
            "answer": answer,
            "citations": citations,
            "trace": {
                "retriever": "local-keyword",
                "owner_scope": self.owner_mode,
                "query_terms": query_terms,
                "matches": len(scored),
                "vault_matches": len(vault_scored),
                "wiki_vault_context_attached": bool(vault["selected_context"]),
            },
        }
        if self._pbs_shadow_enabled():
            return self._with_shadow(result, "chat", self.pbs.chat(payload, resolved_owner_id))
        return result

    def upload_reports(self, customer_id: str = "default", owner_id: str | None = None) -> dict[str, Any]:
        resolved_owner_id = self.owner_id(owner_id)
        if self._pbs_live_enabled():
            return self._pbs_reports_payload(self.pbs.upload_reports(resolved_owner_id, customer_id=customer_id), customer_id=customer_id, owner_id=resolved_owner_id)
        store = self.load_store()
        documents = [doc for doc in store["documents"] if self._in_scope(doc, customer_id=customer_id, owner_id=resolved_owner_id)]
        events = [
            event
            for event in store["events"]
            if self._in_scope(event, customer_id=customer_id, owner_id=resolved_owner_id)
            and event.get("type") in {"document_ingested", "wiki_loop_run"}
        ]
        result = {
            "status": "ok",
            "customer_id": customer_id,
            "owner_mode": self.owner_mode,
            "documents": documents,
            "events": events[-50:],
            "counts": {
                "documents": len(documents),
                "events": len(events),
            },
        }
        if self._pbs_shadow_enabled():
            return self._with_shadow(result, "upload_reports", self.pbs.upload_reports(resolved_owner_id, customer_id=customer_id))
        return result

    def run_wiki_loop(
        self, *, customer_id: str = "default", document_id: str | None = None, owner_id: str | None = None
    ) -> dict[str, Any]:
        resolved_owner_id = self.owner_id(owner_id)
        loop_payload = {"customer_id": customer_id, "document_id": document_id}
        if self._pbs_live_enabled():
            return self._pbs_wiki_loop_payload(self.pbs.wiki_loop_run(loop_payload, resolved_owner_id), customer_id=customer_id, owner_id=resolved_owner_id)
        store = self.load_store()
        documents = [
            doc
            for doc in store["documents"]
            if self._in_scope(doc, customer_id=customer_id, owner_id=resolved_owner_id)
            and (document_id is None or doc.get("id") == document_id)
        ]
        upserted: list[dict[str, Any]] = []
        retained_notes = [
            note for note in store["notes"] if not self._in_scope(note, customer_id=customer_id, owner_id=resolved_owner_id)
        ]
        existing = {
            note["id"]: note for note in store["notes"] if self._in_scope(note, customer_id=customer_id, owner_id=resolved_owner_id)
        }
        for document in documents:
            note_id = stable_id("note", f"{resolved_owner_id}:{customer_id}:{document['id']}")
            previous_note = existing.get(note_id) if isinstance(existing.get(note_id), dict) else {}
            previous_revision = int(previous_note.get("revision") or 0) if previous_note else 0
            links = [f"[[{term}]]" for term in document.get("terms", [])[:5]]
            note = {
                "id": note_id,
                "customer_id": customer_id,
                "owner_id": resolved_owner_id,
                "document_id": document["id"],
                "revision": previous_revision + 1,
                "previous_revision": previous_revision,
                "provenance": {
                    "source": "wiki-loop",
                    "source_document_id": document["id"],
                    "source_document_title": document["title"],
                    "source_terms": document.get("terms", [])[:8],
                    "previous_body_hash": hashlib.sha256(str(previous_note.get("body") or "").encode("utf-8")).hexdigest()[:16]
                    if previous_note
                    else "",
                },
                "title": f"{document['title']} Wiki",
                "body": "\n".join(
                    [
                        f"# {document['title']} Wiki",
                        "",
                        document.get("summary", ""),
                        "",
                        "핵심 연결: " + ", ".join(links),
                    ]
                ),
                "tags": document.get("terms", [])[:6],
                "links": [term.strip("[]") for term in links],
                "updated_at": now_ms(),
                "source": "wiki-loop",
            }
            existing[note_id] = note
            upserted.append(note)
        store["notes"] = retained_notes + list(existing.values())
        store["events"].append(
            {
                "id": stable_id("event", f"wiki:{resolved_owner_id}:{customer_id}:{document_id or 'all'}:{now_ms()}"),
                "type": "wiki_loop_run",
                "customer_id": customer_id,
                "owner_id": resolved_owner_id,
                "document_id": document_id,
                "notes_upserted": len(upserted),
                "created_at": now_ms(),
            }
        )
        self.save_store(store)
        result = {
            "status": "ok",
            "customer_id": customer_id,
            "owner_mode": self.owner_mode,
            "notes_upserted": len(upserted),
            "notes": upserted,
        }
        if self._pbs_shadow_enabled():
            return self._with_shadow_write(result, "wiki_loop_run", lambda: self.pbs.wiki_loop_run(loop_payload, resolved_owner_id))
        return result

    def wiki_loop_status(self, *, customer_id: str = "default", owner_id: str | None = None) -> dict[str, Any]:
        resolved_owner_id = self.owner_id(owner_id)
        if self._pbs_live_enabled():
            return self._pbs_scoped_body(
                "wiki_loop_status",
                self.pbs.wiki_loop_status(resolved_owner_id, customer_id=customer_id),
                customer_id=customer_id,
                owner_id=resolved_owner_id,
                defaults={"status": "ok"},
            )
        store = self.load_store()
        documents = [doc for doc in store["documents"] if self._in_scope(doc, customer_id=customer_id, owner_id=resolved_owner_id)]
        notes = [note for note in store["notes"] if self._in_scope(note, customer_id=customer_id, owner_id=resolved_owner_id)]
        result = {
            "status": "ok",
            "customer_id": customer_id,
            "owner_mode": self.owner_mode,
            "db_ready": self.store.health().get("database_ready", False),
            "vector_ready": self.store.health().get("mode") == "postgres-pgvector",
            "compiled_wiki_ready": bool(notes),
            "summary": {
                "document_count": len(documents),
                "note_count": len(notes),
            },
        }
        if self._pbs_shadow_enabled():
            return self._with_shadow(result, "wiki_loop_status", self.pbs.wiki_loop_status(resolved_owner_id, customer_id=customer_id))
        return result

    def save_note(self, payload: dict[str, Any], owner_id: str | None = None) -> dict[str, Any]:
        customer_id = str(payload.get("customer_id") or payload.get("customerId") or "default")
        resolved_owner_id = self.owner_id(owner_id)
        if self._pbs_live_enabled():
            return self._pbs_scoped_body(
                "wiki_vault_note_save",
                self.pbs.save_note(payload, resolved_owner_id),
                customer_id=customer_id,
                owner_id=resolved_owner_id,
                defaults={"status": "ok"},
            )
        title = str(payload.get("title") or "Untitled note").strip()
        body = str(payload.get("body") or "").strip()
        if not body:
            raise ValueError("body is required")
        tags = payload.get("tags") if isinstance(payload.get("tags"), list) else top_terms(body, 6)
        links = WIKI_LINK_RE.findall(body)
        client_note_id = str(payload.get("id") or "").strip()
        note_id = (
            stable_id("note", f"{resolved_owner_id}:{customer_id}:client:{client_note_id}")
            if client_note_id
            else stable_id("note", f"{resolved_owner_id}:{customer_id}:{title}:{body[:512]}")
        )
        note = {
            "id": note_id,
            "client_note_id": client_note_id,
            "customer_id": customer_id,
            "owner_id": resolved_owner_id,
            "document_id": payload.get("document_id"),
            "title": title,
            "body": body,
            "tags": tags,
            "links": links,
            "updated_at": now_ms(),
            "source": "user",
        }
        store = self.load_store()
        store["notes"] = [
            existing
            for existing in store["notes"]
            if existing["id"] != note["id"] or not self._in_scope(existing, customer_id=customer_id, owner_id=resolved_owner_id)
        ]
        store["notes"].append(note)
        self.save_store(store)
        result = {"status": "ok", "note": note}
        if self._pbs_shadow_enabled():
            return self._with_shadow_write(result, "wiki_vault_note_save", lambda: self.pbs.save_note(payload, resolved_owner_id))
        return result

    def wiki_vault(self, customer_id: str = "default", owner_id: str | None = None) -> dict[str, Any]:
        resolved_owner_id = self.owner_id(owner_id)
        if self._pbs_live_enabled():
            pbs_result = self.pbs.wiki_vault({"customer_id": customer_id}, resolved_owner_id)
            body = self._pbs_scoped_body("wiki_vault", pbs_result, customer_id=customer_id, owner_id=resolved_owner_id, defaults={"status": "ok"})
            if body.get("status") == "error":
                return body
            body.setdefault("customer_id", customer_id)
            if "topology" in body:
                body.setdefault("pbs_topology", body.get("topology"))
            body["topology"] = self._topology_from_pbs_vault(pbs_result.body if pbs_result.ok else {}, customer_id=customer_id, owner_id=resolved_owner_id)
            return body
        store = self.load_store()
        vault = self._local_vault_graph(customer_id=customer_id, owner_id=resolved_owner_id, store=store)
        result = {
            "status": "ok",
            "customer_id": customer_id,
            "owner_mode": self.owner_mode,
            "documents": vault["documents"],
            "notes": vault["notes"],
            "summary": vault["summary"],
            "top_wikilinks": vault["top_wikilinks"],
            "top_tags": vault["top_tags"],
            "relations": vault["relations"],
            "backlinks": vault["backlinks"],
            "selected_context": vault["selected_context"],
            "selected_uploads": vault["selected_uploads"],
            "topology": vault["topology"],
        }
        if self._pbs_shadow_enabled():
            return self._with_shadow(result, "wiki_vault", self.pbs.wiki_vault({"customer_id": customer_id}, resolved_owner_id))
        return result

    def topology(self, customer_id: str = "default", owner_id: str | None = None) -> dict[str, Any]:
        resolved_owner_id = self.owner_id(owner_id)
        if self._pbs_live_enabled():
            pbs_result = self.pbs.wiki_vault({"customer_id": customer_id}, resolved_owner_id)
            if pbs_result.ok:
                mismatches = self._pbs_scope_mismatches(pbs_result.body, customer_id=customer_id, owner_id=resolved_owner_id)
                if mismatches:
                    return self._pbs_scope_error_payload("wiki_vault_topology", pbs_result, mismatches)
            result = self._topology_from_pbs_vault(pbs_result.body if pbs_result.ok else {}, customer_id=customer_id, owner_id=resolved_owner_id)
            result["pbs"] = {
                **result.get("pbs", {}),
                **pbs_result.trace(),
            }
            if not pbs_result.ok:
                result["status"] = "error"
                result["error"] = pbs_result.error
            return result
        store = self.load_store()
        result = self._local_vault_graph(customer_id=customer_id, owner_id=resolved_owner_id, store=store)["topology"]
        if self._pbs_shadow_enabled():
            return self._with_shadow(result, "wiki_vault_topology", self.pbs.wiki_vault({"customer_id": customer_id}, resolved_owner_id))
        return result
