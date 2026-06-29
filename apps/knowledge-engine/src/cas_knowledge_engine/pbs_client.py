from __future__ import annotations

import hashlib
import json
import os
import ssl
import time
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def _timeout_seconds() -> float:
    raw = os.environ.get("CAS_PBS_TIMEOUT_MS", "10000").strip()
    try:
        return max(0.1, int(raw) / 1000)
    except ValueError:
        return 10.0


def _max_response_bytes() -> int:
    raw = os.environ.get("CAS_PBS_MAX_RESPONSE_BYTES", "5242880").strip()
    try:
        return max(4096, int(raw))
    except ValueError:
        return 5 * 1024 * 1024


def _owner_header_name() -> str:
    return os.environ.get("CAS_PBS_OWNER_HEADER", "X-User").strip() or "X-User"


def pbs_owner_id(owner_id: str) -> str:
    default_owner = os.environ.get("CAS_PBS_DEFAULT_USER_ID", "cas-local").strip() or "cas-local"
    raw_owner = str(owner_id or default_owner).strip() or default_owner
    header_name = _owner_header_name()
    return hashlib.sha256(f"header:{header_name}:{raw_owner}".encode("utf-8")).hexdigest()[:32]


def _local_http_url(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}


@dataclass(frozen=True)
class PBSHttpResult:
    ok: bool
    status: int
    elapsed_ms: int
    path: str
    body: dict[str, Any]
    error: str = ""

    def trace(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "status": self.status,
            "elapsed_ms": self.elapsed_ms,
            "path": self.path,
            "error": self.error,
        }


class PBSHttpClient:
    def __init__(self) -> None:
        self.base_url = os.environ.get("CAS_PBS_BASE_URL", "").strip().rstrip("/")
        self.timeout = _timeout_seconds()
        self.max_response_bytes = _max_response_bytes()
        self.auth_mode = os.environ.get("CAS_PBS_AUTH_MODE", "service-token").strip() or "service-token"
        self.api_key = os.environ.get("CAS_PBS_API_KEY", "").strip() or os.environ.get("CAS_PBS_BEARER_TOKEN", "").strip()
        token_file = os.environ.get("CAS_PBS_BEARER_TOKEN_FILE", "").strip()
        if not self.api_key and token_file:
            try:
                with open(token_file, "r", encoding="utf-8") as handle:
                    self.api_key = handle.read().strip()
            except OSError:
                self.api_key = ""
        self.tls_insecure = _env_bool("CAS_PBS_TLS_INSECURE")
        self.shadow_writes = _env_bool("CAS_PBS_SHADOW_WRITES", default=False)
        self.owner_header = _owner_header_name()

    @property
    def configured(self) -> bool:
        return bool(self.base_url)

    def owner_id(self, owner_id: str) -> str:
        return pbs_owner_id(owner_id)

    def _headers(self, owner_id: str = "") -> dict[str, str]:
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        if self.auth_mode == "service-token" and self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        if owner_id:
            headers[self.owner_header] = owner_id
        return headers

    def _context(self) -> ssl.SSLContext | None:
        if not self.tls_insecure:
            return None
        return ssl._create_unverified_context()

    def request_json(
        self,
        method: str,
        path: str,
        *,
        owner_id: str = "",
        payload: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
    ) -> PBSHttpResult:
        if not self.configured:
            return PBSHttpResult(False, 0, 0, path, {}, "CAS_PBS_BASE_URL is not configured")
        if self.auth_mode == "service-token" and not self.api_key:
            return PBSHttpResult(False, 0, 0, path, {}, "CAS_PBS_BEARER_TOKEN is required for service-token auth")
        if (
            self.auth_mode == "service-token"
            and self.api_key
            and self.base_url.startswith("http://")
            and not _local_http_url(self.base_url)
            and not _env_bool("CAS_PBS_ALLOW_INSECURE_TOKEN_HTTP")
        ):
            return PBSHttpResult(False, 0, 0, path, {}, "service-token auth requires HTTPS or mTLS for non-local PBS URLs")
        suffix = path if path.startswith("/") else f"/{path}"
        query_items = {key: value for key, value in (query or {}).items() if value not in {None, ""}}
        if query_items:
            suffix = f"{suffix}?{urlencode(query_items)}"
        url = f"{self.base_url}{suffix}"
        encoded_payload = json.dumps(payload or {}, ensure_ascii=False).encode("utf-8") if method.upper() != "GET" else None
        started = time.perf_counter()
        request = Request(url, data=encoded_payload, method=method.upper(), headers=self._headers(owner_id))
        try:
            with urlopen(request, timeout=self.timeout, context=self._context()) as response:
                raw = response.read(self.max_response_bytes + 1)
                if len(raw) > self.max_response_bytes:
                    return PBSHttpResult(
                        False,
                        int(response.status),
                        int((time.perf_counter() - started) * 1000),
                        suffix,
                        {},
                        "PBS response exceeded CAS_PBS_MAX_RESPONSE_BYTES",
                    )
                text = raw.decode("utf-8", errors="replace")
                try:
                    body = json.loads(text) if text else {}
                except json.JSONDecodeError:
                    elapsed_ms = int((time.perf_counter() - started) * 1000)
                    return PBSHttpResult(False, int(response.status), elapsed_ms, suffix, {"raw": text[:2048]}, "PBS response was not JSON")
                elapsed_ms = int((time.perf_counter() - started) * 1000)
                return PBSHttpResult(200 <= int(response.status) < 300, int(response.status), elapsed_ms, suffix, body)
        except HTTPError as error:
            raw = error.read(self.max_response_bytes + 1)
            text = raw[: self.max_response_bytes].decode("utf-8", errors="replace")
            try:
                body = json.loads(text) if text else {}
            except json.JSONDecodeError:
                body = {"raw": text}
            elapsed_ms = int((time.perf_counter() - started) * 1000)
            message = str(body.get("error") or body.get("message") or error)
            return PBSHttpResult(False, int(error.code), elapsed_ms, suffix, body, message)
        except (OSError, URLError, TimeoutError) as error:
            elapsed_ms = int((time.perf_counter() - started) * 1000)
            return PBSHttpResult(False, 0, elapsed_ms, suffix, {}, str(error))

    def health(self, owner_id: str = "") -> PBSHttpResult:
        return self.request_json("GET", "/api/health", owner_id=owner_id)

    def upload_ingest(self, payload: dict[str, Any], owner_id: str) -> PBSHttpResult:
        return self.request_json("POST", "/api/uploads/ingest", owner_id=owner_id, payload=self._owner_payload(payload, owner_id))

    def url_ingest(self, payload: dict[str, Any], owner_id: str) -> PBSHttpResult:
        return self.request_json("POST", "/api/uploads/url-ingest", owner_id=owner_id, payload=self._owner_payload(payload, owner_id))

    def upload_reports(self, owner_id: str, customer_id: str = "default", limit: int = 50) -> PBSHttpResult:
        return self.request_json(
            "GET",
            "/api/uploads/reports",
            owner_id=owner_id,
            query={"user_id": self.owner_id(owner_id), "customer_id": customer_id, "limit": limit},
        )

    def chat(self, payload: dict[str, Any], owner_id: str) -> PBSHttpResult:
        question = str(payload.get("question") or payload.get("query") or "").strip()
        chat_payload = {
            **payload,
            "query": question,
            "user_id": self.owner_id(owner_id),
            "owner_user_id": self.owner_id(owner_id),
        }
        chat_payload.pop("question", None)
        return self.request_json("POST", "/api/chat", owner_id=owner_id, payload=chat_payload)

    def wiki_loop_run(self, payload: dict[str, Any], owner_id: str) -> PBSHttpResult:
        return self.request_json("POST", "/api/wiki-loop/run", owner_id=owner_id, payload={**payload, "user_id": self.owner_id(owner_id), "once": True})

    def wiki_loop_status(self, owner_id: str, customer_id: str = "default") -> PBSHttpResult:
        return self.request_json(
            "GET",
            "/api/wiki-loop/status",
            owner_id=owner_id,
            query={"user_id": self.owner_id(owner_id), "customer_id": customer_id},
        )

    def wiki_vault(self, payload: dict[str, Any], owner_id: str) -> PBSHttpResult:
        return self.request_json(
            "GET",
            "/api/wiki-vault",
            owner_id=owner_id,
            query={
                "user_id": self.owner_id(owner_id),
                "customer_id": payload.get("customer_id") or payload.get("customerId") or "default",
                "q": payload.get("q") or payload.get("query") or "",
            },
        )

    def save_note(self, payload: dict[str, Any], owner_id: str) -> PBSHttpResult:
        return self.request_json("POST", "/api/wiki-vault/notes", owner_id=owner_id, payload={**payload, "user_id": self.owner_id(owner_id)})

    def _owner_payload(self, payload: dict[str, Any], owner_id: str) -> dict[str, Any]:
        resolved_owner = self.owner_id(owner_id)
        outbound = {
            **payload,
            "created_by": resolved_owner,
            "owner_user_id": resolved_owner,
            "user_id": resolved_owner,
        }
        if not outbound.get("file_name") and outbound.get("filename"):
            outbound["file_name"] = outbound["filename"]
        return outbound
