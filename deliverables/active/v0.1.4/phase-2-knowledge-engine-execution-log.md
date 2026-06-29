# Cywell v0.1.4 Phase 2 Knowledge Engine Execution Log

## Implemented

- Added `apps/knowledge-engine` Python service.
- Added local persistent knowledge store under `CAS_KNOWLEDGE_DATA_DIR`.
- Added PBS-compatible JSON API surface:
  - `GET /api/knowledge/healthz`
  - `GET /api/knowledge/capabilities`
  - `POST /api/knowledge/uploads/ingest`
  - `GET /api/knowledge/uploads/reports`
  - `POST /api/knowledge/uploads/url-ingest`
  - `POST /api/knowledge/rag/query`
  - `POST /api/knowledge/wiki-loop/run`
  - `GET /api/knowledge/wiki-vault`
  - `POST /api/knowledge/wiki-vault/notes`
  - `GET /api/knowledge/topology`
- Added PBS-compatible ingest metadata capture for upload and URL ingest:
  - `file_name`
  - `created_by`
  - `source_scope`
  - `visibility`
  - `source_kind`
  - `source_metadata`
  - `force_reingest`
  - `index`
  - `auto_compile_wiki` for URL ingest
- Added base64 upload support and lightweight extraction for text, DOCX, PPTX, XLSX, and PDF payloads.
- Added PBS HTTP provider adapter:
  - `pbs-compatible-local` remains the default
  - `pbs-http-shadow` records PBS traces while returning the local CAS result
  - `pbs-http-live` uses PBS HTTP responses and normalizes them into CAS API shapes
  - owner scope is sent to PBS through `X-User` and the matching PBS owner hash is used for `created_by`, `owner_user_id`, and `user_id`
  - shadow write calls are disabled unless `CAS_PBS_SHADOW_WRITES=true`
  - live PBS failures propagate as non-2xx CAS HTTP responses with PBS trace details
  - PBS health readiness summary exposes DB, pgvector, embedding parity, missing/stale embedding counters, ready scopes, and compiled wiki readiness
  - live readiness can be gated on DB/pgvector runtime readiness plus corpus/index parity, zero missing/stale embedding entries, compiled wiki readiness, and required scopes
- Confirmed the PBS backend API target from `F:\AI_Projects\PBS-Dev3`:
  - app/backend service listens on port `8765`
  - health endpoint is `GET /api/health`
  - public web/nginx service normally listens on port `8080` and proxies `/api/*`
- Added `/api/knowledge/wiki-loop/status`.
- Added request body limits in both Gateway and Knowledge Engine.
- Added Gateway proxy from `/api/knowledge/*` to `CAS_KNOWLEDGE_ENGINE_URL`.
- Gateway derives knowledge owner scope from Authorization/UserToken by default and no longer trusts forwarded owner headers unless explicitly enabled.
- Knowledge Engine scoped data APIs require trusted owner headers in the base deployment.
- Extended Cywell console routes with working controls:
  - customer file/text upload
  - URL ingest
  - upload reports
  - RAG query
  - wiki loop run
  - manual wiki note save
  - vault/topology load
- Added OpenShift resources:
  - `cas-knowledge-engine` Deployment
  - `cas-knowledge-engine` Service
  - `cas-knowledge-engine-data` PVC
  - gateway egress to knowledge engine port 8080
  - knowledge-engine ingress NetworkPolicy that allows only gateway pods on TCP 8080
  - CRC BuildConfig and ImageStream
- Added PBS deployment overlays:
  - `pbs-shadow` overlay with `CAS_KNOWLEDGE_PROVIDER=pbs-http-shadow`
  - `pbs-live` overlay that composes shadow and flips `CAS_KNOWLEDGE_PROVIDER=pbs-http-live`
  - `cas-pbs-config` ConfigMap for PBS base URL/auth mode/timeouts/response limits/TLS flag
  - optional `cas-pbs-auth/bearer-token` Secret reference in shadow mode
  - required `cas-pbs-auth/bearer-token` Secret reference in live mode
  - required `cas-knowledge-postgres-live` Secret references in live mode
  - live mode removes inherited CRC owner/dev DB defaults and uses `v0.1.4` release image tags
  - knowledge-engine PBS egress policy limited to DNS, Postgres, and labeled PBS runtime pods on port `8765`
  - `CAS_PBS_REQUIRE_RUNTIME_READY=true` in live mode so pod health fails when PBS DB/vector readiness fails
  - `CAS_PBS_REQUIRE_CORPUS_READY=true` and `CAS_PBS_REQUIRED_READY_SCOPES=official_docs,study_docs` in live mode so pod health fails when PBS corpus/index readiness is incomplete
- Added `npm run verify:pbs:live` for optional real PBS smoke verification.
- Added `npm run verify:pbs:preflight` for PBS shadow/live overlay and cluster readiness preflight.
- Added `npm run verify:pbs:preflight:live` and `npm run verify:pbs:cutover` as strict live cutover gates.
- Updated `deploy:crc` to build and deploy `cas-knowledge-engine`, follow OpenShift build logs separately, and poll final build phase after slow binary uploads.
- Paused the existing v0.1.3 OLM operator during dev deployment so v0.1.4 kustomize manifests own gateway/console workloads.

## Verification

Executed:

```powershell
npm run verify
npm run verify:pbs:preflight
npm run verify:pbs:preflight:live
npm run verify:pbs:live
npm run verify:pbs:cutover
npm run verify:crc:deployment
```

Results:

- Local full verification: pass
- CRC deployment verification: pass
- Runtime gateway smoke: pass
  - image tags present
  - gateway ready
  - console plugin ready
  - knowledge engine ready
  - gateway proxies knowledge health
  - upload/base64/URL ingest -> RAG -> wiki-loop -> topology passes through gateway
  - PBS-compatible upload and URL ingest metadata is present
  - console plugin exposes Cywell navigation/routes
  - AI Sentinel Lightspeed flow still passes
- PBS provider verifier: pass
  - fake PBS health
  - PBS runtime readiness summary
  - PBS live degraded health when DB/vector readiness is required but absent
  - PBS live degraded health when corpus/index readiness is required but embeddings are missing or stale
  - shadow upload trace and owner hash contract
  - live upload normalization
  - live URL ingest preservation
  - live upload reports normalization
  - live chat/RAG normalization
  - live outbound owner/hash contract for upload, URL ingest, reports, chat, wiki run/status, wiki vault, and note save
  - live outbound customer_id contract for reports, wiki status, and wiki vault
  - live failed PBS operation returns non-2xx CAS HTTP status
  - live wiki loop and status
  - live wiki vault graph to CAS topology
  - live note save preservation
- PBS live smoke verifier: skip without failure when `CAS_PBS_BASE_URL` is not set
- PBS preflight verifier: local rendered live overlay passes; current CRC warns until the real `playbookstudio` namespace/service, `cas-pbs-auth` Secret, `cas-knowledge-postgres-live` Secret, and cleanup of legacy `cas-knowledge-postgres` Secret are handled
- Strict PBS live preflight and cutover verifier: expected fail locally until the real PBS target and Secrets exist
- Deploy manifest verifier: pass with rendered `base`, `pbs-shadow`, and `pbs-live` kustomize checks
- CRC deployment verifier: pass with live Knowledge Engine ingress policy shape and direct non-gateway access blocked from the console-plugin pod

## Updated Runtime Status

This started as a PBS-compatible local-json MVP and was then upgraded to a PostgreSQL/pgvector-backed CRC runtime.

Current deployed storage mode:

- `postgres-pgvector`
- `pgcrypto` extension present
- `vector` extension present
- `cas_knowledge_vector_readiness.embedding vector(768)` present
- smoke upload persisted in Postgres under owner scope
- scoped Knowledge Engine APIs are reachable through Gateway and blocked from direct console-plugin pod access by NetworkPolicy

Still required for full PBS parity:

- PBS migration runner and exact PBS table lineage
- real PBS runtime deployment wiring
- real `cas-pbs-auth` Secret value creation outside git
- real `cas-knowledge-postgres-live` Secret value creation outside git
- live PBS target route/service confirmation and overlay application
- `CAS_PBS_BASE_URL` live smoke against the target PBS runtime
- PBS document parser/indexer execution against the target database
- PBS `/api/chat/stream` adapter if CAS needs streaming RAG
- LLM/embedding endpoint configuration
- production identity now uses Gateway-verified OpenShift/Kubernetes SelfSubjectReview owner scope; still review cluster-ID scoping before sharing one knowledge DB across multiple clusters
- real PBS owner/header mapping review before exposing knowledge-engine outside the Gateway path

## Docker Desktop Note

Docker Desktop was not used for the CAS v0.1.4 CRC build. OpenShift BuildConfig built the images inside CRC.

Observed local Docker state during this run:

- `com.docker.service`: stopped
- `docker-desktop` WSL distro: running

The Windows-side recovery command is:

```powershell
wsl.exe --shutdown
```

Inside WSL, use:

```bash
/mnt/c/Windows/System32/wsl.exe --shutdown
```

## Historical Knowledge Engine Verification Update

Added after parallel review:

- Local upload now proves the initial LLM Wiki note is created with document provenance.
- RAG verification now requires a citation tied to the exact uploaded document ID/title/snippet.
- Wiki-loop verification now proves revision evolution for the same uploaded document:
  - upload auto wiki note: `revision=1`, `previous_revision=0`
  - first explicit wiki-loop: `revision=2`, `previous_revision=1`
  - second document-scoped wiki-loop: `revision=3`, `previous_revision=2`
- Topology verification now requires:
  - uploaded document node
  - wiki-note node with `source_document_id`
  - `summarizes` edge from wiki note to uploaded document
- PBS live topology normalization now preserves provenance and revision metadata from PBS-style graph payloads.
- CRC runtime verifier now parses smoke JSON and verifies exact document lineage through:
  - RAG citation
  - wiki revision
  - topology edge
- Postgres document/chunk/note/event rows under the Gateway-verified owner scope

Historical results at this step:

- `npm run verify:knowledge-engine`: `PASS`, 49 checks
- `npm run verify:crc:deployment`: `PASS`
- `npm run verify`: `PASS`

## Historical Gateway Boundary Verification Update

Added after the second parallel review pass:

- Gateway no longer wraps SelfSubjectReview transport failures as Knowledge Engine outages.
  - verifier unavailable: `503 knowledge-owner-verifier-unavailable`
  - invalid/missing owner: `401 knowledge-owner-unverified`
- Private owner failures are rejected before the Knowledge Engine receives the request.
- Public Gateway knowledge health is sanitized and no longer exposes storage paths, tenant counts, provider internals, PBS diagnostics, or upstream endpoints.
- Recording fake Knowledge Engine smoke verifies:
  - raw user bearer token is not forwarded internally
  - spoofed owner headers are not forwarded internally
  - Gateway injects only the derived owner as `x-forwarded-user`
- SelfSubjectReview local integration smoke verifies refreshed tokens for the same Kubernetes user map to the same owner while other users remain isolated.

Historical results at this step:

- `npm run verify:knowledge-engine`: `PASS`, 57 checks
- `npm run verify:crc:deployment`: `PASS`, 59 checks
- `npm run verify`: `PASS`

## Historical Knowledge Engine Hardening Update

Added after the security-focused parallel review pass:

- Client-supplied LLM Wiki note IDs are now namespaced by owner/customer before persistence.
- The original client ID is preserved as `client_note_id` metadata, but the stored note primary key is server-derived.
- Verification now proves two owners saving the same `shared-note-id` under the same customer cannot overwrite or read each other's wiki note.
- Local/live PBS smoke now sends write/read operations through the Gateway knowledge API, preserving the same owner derivation path used by the console.
- Strict live preflight now probes the actual Postgres readiness schema column `cas_knowledge_vector_readiness.embedding vector(768)`.
- The base Knowledge Engine now has an explicit DNS/Postgres-only egress NetworkPolicy; PBS shadow/live overlays add the separate scoped PBS runtime egress policy.

Historical hardening results at this step:

- `npm run verify:knowledge-engine`: `PASS`, 50 checks
- `npm run verify:deploy:manifests`: `PASS`, 174 checks
- `npm run verify:crc:deployment`: `PASS`
- `npm run verify`: `PASS`

## Historical Identity and PBS Auth Hardening Update

Added after the follow-up parallel review pass:

- Gateway knowledge owner scope now uses OpenShift/Kubernetes `SelfSubjectReview` in deployed mode.
- The Knowledge Engine internal hop receives only the Gateway-minted `x-forwarded-user`; raw bearer tokens and client-supplied owner headers are not forwarded.
- Local smoke tests keep explicit `token-hash` mode only where no OpenShift API is available.
- PBS shadow/live fake backend now enforces bearer auth and verifier asserts bearer auth on every PBS API request.
- CRC runtime verifier proves current `oc whoami -t` resolves through SelfSubjectReview, then checks upload/RAG/wiki/topology responses and persisted lineage rows under the resulting verified owner.
- Required browser mode is now part of the topology DOM release gate.
- Runtime NetworkPolicy verification now fails if any NetworkPolicy selecting gateway or knowledge-engine pods has broad peers.

Historical identity/auth results at this step:

- `npm run verify:gateway`: `PASS`, 15 checks
- `npm run verify:knowledge-engine`: `PASS`, 50 checks
- `npm run verify:crc:deployment`: `PASS`
- `npm run verify`: `PASS`
