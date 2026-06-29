# Cywell v0.1.4 Phase 3-6 Runtime and Topology Execution Log

## Latest Update - Launcher DOM Proof, Source Pinning, and Live Cutover Gate Hardening

Implemented after the parallel console/cutover/evidence review pass:

- The CAS launcher now has a browser-backed DOM harness that mounts the real console context-provider hook, suppresses a pre-existing OpenShift Lightspeed launcher, proves exactly one bottom-right `cas-launcher-button` is rendered in the real corner, opens the CAS panel, calls Gateway brain readiness, posts read-only query bodies through `/api/aiops/query`, preserves `conversation_id`, and reports browser/page errors.
- Native OpenShift Lightspeed suppression now resolves child/title/class matches to the nearest launcher control/root and covers late-inserted `lightspeed`/`ols` variants, so Cywell's launcher does not coexist with a changed native launcher selector.
- Invalid bare `document_id` query params under `/cywell/rag` now get repaired to the loaded upload-report document instead of preserving a missing URL-created viewer target; if reports are empty, the URL-created selected-document scope is cleared before RAG runs. Topology/wiki viewer lineage is still preserved when it originates from an actual selected viewer target.
- Switching to Full corpus now clears `document_id`, `documentId`, `note_id`, and `noteId` from the URL through the same selected-document cleanup path; browser reload no longer restores a stale selected-document RAG scope after operators unpin scope.
- PBS source-contract evidence is split into optional, required, and strict pinned files: `cas-pbs-source-contract.json`, `cas-pbs-source-contract-required.json`, and `cas-pbs-source-contract-pinned.json`. Strict pinning records and validates the approved PBS git remote and proves a successful fresh fetch where a fetched `origin/*` ref contains the pinned SHA; the cutover bundle accepts only the strict pinned evidence produced by `verify:release:source-pinning`.
- PBS live preflight now requires the live PBS base URL to target `playbookstudio-runtime.playbookstudio.svc.cluster.local:8765` or the equivalent short service DNS on port `8765`, and requires the Service `port` itself to be `8765`, not only `targetPort`.
- PBS live preflight records ready runtime pod source revisions and, in live cluster-required mode, requires every ready PBS runtime pod to be stamped with the approved pinned PBS source SHA. When the runtime Service exists, it also probes `/api/health` through Service DNS from a runtime pod and requires DB, pgvector, corpus/index, compiled wiki, and `official_docs,study_docs` ready scopes.
- The cutover bundle now rejects stale generated-site preapply evidence, dirty required local evidence, runtime pods whose source revision does not match the pinned PBS source SHA, unapproved PBS source remotes, failed or stale remote-fetch source proof, pinned PBS SHAs not proven reachable from fetched approved remote refs, and weak PBS source-contract hash sets that do not contain the exact expected contract files with 64-character SHA-256 hashes.
- Live prerequisite rendering now rejects malformed ACL grant tables such as string grants under named owners/users/groups; only concrete arrays of customer IDs are accepted.
- Console Knowledge customer changes now clear selected corpus document, viewer state, previous action result, topology state, and document/note query params before the next RAG/Wiki/topology action, while scope revision guards ignore late upload/RAG/wiki/topology responses from the previous customer.
- Knowledge route navigation preserves the active customer/document query context across customer data, RAG, LLM Wiki, and topology pages. Wiki-note deep links now include source `document_id` when present, deep-linked notes use that selected-document scope before upload reports load, and browser back/forward reconciles URL state back into React state.
- The topology browser DOM gate now proves that switching from `workflow-customer` to `workflow-switched` clears stale `workflow-doc-1` selected-document RAG scope before sending `/api/knowledge/rag/query`, that late upload/RAG/topology responses cannot restore stale scope/results, that Wiki-note deep links carry `pbs-rich-upload` into LLM Wiki requests, that invalid query-document deep links are repaired, and that a viewer deep-link back navigation restores route state.
- PBS preflight evidence for generated-site live checks now writes `test-results/cas-pbs-preflight-pbs-live-site-preapply-cluster-required-secrets.json`, preventing generated `pbs-live-site` evidence from overwriting default pbs-live evidence.
- `render:pbs:live-prereqs:template` now writes non-secret handoff templates under `test-results/pbs-live-prereqs-input-template/`; operators copy them outside the repo before filling approved token, owner-HMAC, ACL, and Postgres values.
- The cutover bundle now requires current clean `fullHead/treeStatus` evidence, generated-site preapply flags/path, matching CRC/release/preapply cluster identity, exact live prereq output hash keys, recomputed generated-file/site-overlay/redacted-summary hashes, clean real-render prereq evidence bound to `test-results/pbs-live-prereqs`, and strict full-SHA PBS source pinning with successful fresh approved remote ref containment proof.
- Release promotion and cutover bundling now require the Cywell release HEAD itself to be contained in an approved fetched `origin/*` ref; local-only Cywell commits cannot produce live-ready release evidence.
- Strict preflight parses rendered Kubernetes objects for the live generated-site overlay and checks the exact NetworkPolicy shape for PBS egress and Knowledge Engine ingress instead of relying on string presence.
- Strict preflight now treats only real Kubernetes NotFound responses as proof that the legacy `cas-knowledge-postgres` Secret is absent; RBAC/API errors no longer pass the absence check.
- The tracked pbs-live overlay now fails closed with `customer-access-json={}`; production mappings must come from `render:pbs:live-prereqs` generated site overlay.
- The v0.1.4 PBS source baseline is now pinned through a clean clone at `F:\AI_Projects\PBS-Dev3-cywell-v014-source-pin-clone`, branch `kugnus/cywell-v0.1.4-source-contract`, commit `47c03c47cabf2fb1181fe44d9810c0feef086d6f`, pushed to approved remote `https://github.com/souluk319/PBS_DEV_Part3.git`.
- The PBS companion branch now adds `deploy/openshift-cywell-v014`, a real OpenShift overlay that renders namespace `playbookstudio`, Service `playbookstudio-runtime` on port `8765`, and runtime labels `app.kubernetes.io/name=playbookstudio` plus `app.kubernetes.io/component=runtime` without faking `/api/health`.

Proof captured in this pass:

- `node --check` passed for changed verifier/release/cutover scripts.
- `npm run verify:console-plugin`: PASS.
- `npm run verify:console:launcher-dom:built`: PASS, 10 browser-backed checks.
- `npm run verify:console:topology-dom:built`: PASS, 53 browser-backed checks.
- `npm run verify:console:integration:built`: PASS, 113 checks.
- `npm run verify:pbs:cutover-bundle`: PASS, 21 self-test checks.
- `$env:CAS_PBS_SOURCE_HEAD="47c03c47cabf2fb1181fe44d9810c0feef086d6f"; $env:CAS_PBS_SOURCE_DIR="F:\AI_Projects\PBS-Dev3-cywell-v014-source-pin-clone"; npm run verify:release:source-pinning`: PASS, 57 checks; strict source pin evidence is now clean, full-SHA, approved-remote, and remote-ref-contained.
- `npm run render:pbs:cutover-bundle`: expected FAIL in the current handoff evidence, `local-evidence-invalid`. Source pinning is no longer the blocker for the current evidence set. Remaining local blockers are stale/dirty `cas-pbs-live-prereqs-render.json` from old head `7e12aad`, missing current real-render/hash-bound generated-site preapply evidence, and missing ready PBS runtime pod source stamps for `47c03c47cabf2fb1181fe44d9810c0feef086d6f`. External live preapply blockers are retained in the active blocker list even when local evidence is invalid.
- `npm run verify:deploy:manifests`: PASS, 286 checks.
- `npm run verify:pbs:source-contract:required`: PASS, 55 total checks: 55 PASS / 0 WARN against clean clone `F:\AI_Projects\PBS-Dev3-cywell-v014-source-pin-clone`; the checked PBS remote is `https://github.com/souluk319/PBS_DEV_Part3.git`.
- `npm run verify:pbs:preflight:live:site:preapply`: expected FAIL, 48 PASS / 7 FAIL. Current release image evidence and strict pinned PBS source evidence pass; remaining failures are the missing external `playbookstudio` namespace/service, missing `cas-pbs-auth`, missing `cas-knowledge-postgres-live`, legacy dev Secret cleanup, and ready PBS runtime source revision evidence once the Service exists.
- `npm run render:pbs:live-prereqs`: blocked in the current shell until approved non-placeholder PBS bearer token, owner HMAC, service owner, concrete customer ACL JSON, and live Postgres DB credentials/URL are supplied.
- `npm run verify:pbs:live-prereqs`: PASS, 12 self-test checks.
- `npm run verify`: PASS.

## Historical Update - Customer Corpus Workbench and Source-Lane Hardening

Implemented after the latest product/runtime/backend review pass:

- Added a Cywell Customer Corpus Workbench under customer data, with uploaded document/report cards, active document selection, viewer deep links, source scope labels, chunk previews, graph summary, and one-click RAG / LLM Wiki actions.
- Added a document viewer panel for customer uploads, report rows, citations, selected topology context, and topology nodes. Viewer links use `/cywell/customer-data?customer_id=...&document_id=...` so uploaded corpus evidence stays addressable from topology, RAG, and reports.
- Customer data upload responses and upload reports now include `viewer_path` for the selected customer/document.
- RAG requests from the console now carry selected-corpus scope through `active_document_id`, `document_source_id`, `enabled_upload_document_ids`, `enabled_source_scopes`, and `restrict_uploaded_sources`.
- LLM Wiki loop requests can now target the selected document when the operator is working from the corpus view.
- Topology inspector and selected-context rows now expose viewer links for PBS-rich upload/report/citation targets while keeping the existing graph visual design owned by the Cywell console plugin.
- Knowledge Engine now enforces the private ingest lane before local indexing or PBS outbound calls: upload and URL ingest must stay `source_scope=user_upload`, `visibility=private_user`, and expected `source_kind`.
- RAG request scope selection is restricted to private CAS lanes (`user_upload`, `wiki_vault`) so clients cannot smuggle privileged corpus scopes into PBS/live or local retrieval.
- PBS source-contract evidence now records the PBS checkout branch, short/full HEAD, tree status, optional expected HEAD, optional clean-tree requirement, and SHA-256 hashes of the contract source files. The verifier defaults to the clean v0.1.4 companion clone when present, so required source-contract evidence is not based on the dirty original `F:\AI_Projects\PBS-Dev3` working tree.

Proof captured in this pass:

- `python -m py_compile apps/knowledge-engine/src/cas_knowledge_engine/engine.py`: PASS.
- `node --check` passed for changed verifier scripts.
- `npm run verify:knowledge-engine`: PASS, 94 checks.
- `npm run verify:console-plugin`: PASS.
- `npm run verify:console:integration:built`: PASS, 87 checks.
- `npm run verify:console:topology-dom:built`: PASS, 33 browser-backed checks.
- `npm run verify:pbs:source-contract:required`: PASS against clean clone `F:\AI_Projects\PBS-Dev3-cywell-v014-source-pin-clone`, 40 checks with no WARN.
- `npm run verify:deploy:manifests`: PASS, 275 checks.

## Previous Update - PBS Source Contract, Owner-HMAC, and Scope Guard Closure

Implemented after the latest parallel review pass:

- Added `verify:pbs:source-contract` and `verify:pbs:source-contract:required` to check the pinned PBS runtime/API contract before claiming PBS feature import coverage; current default evidence uses the clean companion clone.
- The source contract verifier checks the PBS app Docker/compose shape, port `8765`, `/api/health`, upload, URL ingest, chat/RAG, Wiki Vault, Wiki Loop, owner-scoped upload reports, selected uploads, graph, and chunk-preview API surface.
- Live prerequisite rendering now creates the required `cas-knowledge-internal-auth/owner-hmac-secret` manifest, validates non-placeholder signing material, and records only redacted HMAC metadata.
- Strict live preflight now validates the applied `cas-knowledge-internal-auth` Secret alongside `cas-pbs-auth` and `cas-knowledge-postgres-live`.
- Gateway customer scope parsing now recursively detects customer/workspace/tenant aliases in query/body payloads, rejects mismatches, strips nested scope aliases before proxying, and keeps only the verified canonical top-level `customer_id`.
- Knowledge Engine PBS response scope validation now covers customer, tenant, workspace, and customer-workspace aliases; the verifier blocks cross-scope RAG citation leakage before answers are exposed.
- Added `render:pbs:live-prereqs` and `verify:pbs:live-prereqs`.
- The renderer outputs reviewed live Secret/ConfigMap manifests plus `test-results/pbs-live-prereqs/pbs-live-site`, a generated overlay that replaces `cas-knowledge-live-config` while composing the tracked `pbs-live` overlay.
- Strict live preflight accepts `--overlay-path` / `CAS_PBS_PREFLIGHT_OVERLAY_PATH`, so release gates can validate the generated site overlay instead of the tracked wildcard placeholder.
- Gateway ACL parsing is now strict: arrays only, no `default`, no wildcard/string ACL values, no placeholder customer IDs, and no broad system groups such as `system:authenticated`.
- Private Gateway knowledge requests now fail closed when an invalid ACL is configured, even if `CAS_KNOWLEDGE_REQUIRE_CUSTOMER_ACCESS=false`; live ACL mode also returns `400` when `customer_id` is missing.
- Added a non-applied PBS runtime Service/label contract sample at `deliverables/active/v0.1.4/pbs-runtime-service-contract.sample.yaml`.
- Topology dashboard visual design remains owned by the Cywell console implementation; no external design package is required for v0.1.4.
- CRC deployment/release evidence now carries full git HEAD, clean/dirty source status, and cluster identity, so release tags cannot be promoted from stale, dirty, or wrong-cluster runtime evidence.

Proof captured in this pass:

- `node --check` passed for changed Gateway, preflight, renderer, and verifier scripts.
- `npm run verify:pbs:source-contract:required`: PASS, 29 checks.
- `npm run verify:pbs:live-prereqs`: PASS, 11 checks in the current renderer self-test.
- `npm run verify:knowledge-engine`: PASS, 87 checks.
- `npm run verify:deploy:manifests`: PASS, 274 checks.
- `npm run verify:pbs:preflight:live:site:preapply`: expected FAIL, `48 PASS / 7 FAIL`; failures remain external PBS namespace/service, required live Secrets, and legacy CRC dev Secret cleanup. The rendered wildcard ACL blocker is closed, owner-HMAC Secret checks pass in generated prereq evidence, release evidence cluster identity matches the current cluster, and strict PBS source pin evidence passes.

## Previous Update - Live Cutover Gate Hardening

Implemented after the third parallel review pass:

- Strict live preflight now validates `playbookstudio-runtime` Endpoints on port `8765`, not only the Service selector and ready pods.
- `cas-pbs-auth/bearer-token` is decoded and rejected if it is empty, short, whitespace-bearing, or obvious placeholder material.
- `cas-knowledge-postgres-live` is decoded as a contract: `database`, `username`, `password`, and `database-url` must be non-placeholder, the password must be production-length, `database-url` must target the Postgres Service on port `5432`, and the URL credentials/database must match the individual Secret keys.
- Applied live NetworkPolicy union checks now cover Gateway, Console Plugin, Knowledge Engine, and Postgres. Gateway egress is allowlisted to DNS, Lightspeed, Knowledge Engine, and the discovered Kubernetes API target only; Postgres egress remains default-deny.
- Live customer ACL concrete validation now evaluates `default`, `owners`, `users`, and `groups`; wildcard entries anywhere are rejected and `default` must be empty before cutover.
- PBS live smoke now exercises valid-owner/unmapped-customer fail-closed behavior and conflicting nested customer metadata rejection before any PBS trace is attached.
- PBS live write lineage now requires exact document/customer/source IDs across upload, RAG citation, LLM Wiki note, and a direct topology document-note edge. Title/snippet/answer/body token fallback no longer proves cutover lineage.
- Gateway boundary verification now proves conflicting nested customer metadata is rejected before the Knowledge Engine receives the upload request.

Proof captured in this pass:

- `node --check` passed for changed verification and preflight scripts.
- `npm run verify:knowledge-engine`: PASS, 83 checks.
- `npm run verify:deploy:manifests`: PASS, 260 checks.
- `npm run verify:pbs:preflight:live:preapply`: expected FAIL in older evidence; current generated-site preapply evidence is `48 PASS / 7 FAIL` with only external namespace/service/Secret cleanup blockers.
- `npm run verify`: PASS.

## Previous Update - Wiki Vault Side-Channels, Staged Wiki Loop, and Structural API Egress

Implemented after the second parallel review pass:

- The Cywell topology dashboard now preserves and renders PBS Wiki Vault side-channel data: ranked wikilinks/tags, selected uploads, selected context, and recent vault relations.
- Topology normalization keeps side-channel data scoped to the same selected graph candidate, preserving the existing mixed wrapper/nested graph safety invariant.
- Local LLM Wiki loop now returns PBS-style `run_id`, `stages`, `duration_ms`, `warnings`, and `summary`; status exposes `last_run`, `compiled_wiki_status`, and `pgvector_ready`.
- Manual Wiki Vault note save now preserves PBS-style overlay metadata including `overlay_id`, `book_slug`, `note_type`, target refs, wikilinks, and tags.
- Strict live preflight now checks Gateway Kubernetes API egress structurally: the API IP peer and API port must appear in the same NetworkPolicy egress rule.

Proof captured in that pass:

- `python -m py_compile apps/knowledge-engine/src/cas_knowledge_engine/engine.py`: PASS.
- `node --check` passed for changed verification and preflight scripts.
- `npm run verify:knowledge-engine`: PASS, 82 checks.
- `npm run verify:console:topology-dom`: PASS, 32 browser-backed checks.
- `npm run verify:console:integration`: PASS, 77 checks.
- `npm run verify:deploy:manifests`: PASS, 260 checks.
- `npm run verify:pbs:preflight:live:preapply`: expected FAIL in older evidence; current generated-site preapply evidence is `48 PASS / 7 FAIL` with only external namespace/service/Secret cleanup blockers.

## Previous Update - PBS Upload/RAG Scope Contract and Non-Stale Release Evidence

Implemented after the topology/RAG parity and live-gate parallel review pass:

- Local upload reports now expose PBS-style `items` with `document_source_id`, readiness flags, `graph_summary`, source scope, and chunk previews.
- Local Wiki Vault selected uploads and context rows now preserve PBS-style graph aliases, selected-upload summaries, context viewer paths, document lineage, and source scopes.
- Local RAG now honors `active_document_id`, `enabled_upload_document_ids`, `enabled_source_scopes`, and `restrict_uploaded_sources`; citations include `document_source_id`, `viewer_path`, `source_scope`, `source_collection`, and section paths.
- The topology inspector RAG action now passes the selected topology node's document/source scope into `/api/knowledge/rag/query`.
- CRC release promotion evidence now records the source deployment evidence head/check time and whether stale evidence was allowed; strict live preflight rejects stale-source release evidence.
- Strict live preflight now rejects any wildcard character in customer ACL entries, including prefix/suffix wildcards, unless the policy is replaced before cutover.

Proof captured in that pass:

- `python -m py_compile apps/knowledge-engine/src/cas_knowledge_engine/engine.py`: PASS.
- `node --check` passed for changed verification and release scripts.
- `npm run verify:knowledge-engine`: PASS, 80 checks.
- `npm run verify:console:topology-dom`: PASS, 31 browser-backed checks.
- `npm run verify:console:integration`: PASS, 73 checks.
- `npm run verify:deploy:manifests`: PASS, 259 checks.

## Previous Update - PBS-Compatible Shadow Schema, Rich Topology Signals, and Release Evidence Binding

Implemented after the backend/frontend/release parallel review pass:

- Local Postgres now creates a PBS-compatible schema subset for tenants, workspaces, document sources, parsed documents, chunks, chunk embeddings, graph entities, mentions, and relations.
- Local CAS ingest writes PBS-compatible `document_sources`, `parsed_documents`, `document_chunks`, deterministic local `chunk_embeddings`, and customer-scoped graph entity/mention/relation shadow rows in the same transaction as CAS document/chunk persistence.
- The Knowledge Engine health path reports PBS-compatible schema readiness, shadow row counts, graph row counts, embedding table dimension, and missing embedding parity. These local hash embeddings are a CRC compatibility guard, not PBS production model parity.
- PBS Wiki Vault topology normalization now preserves PBS summary aliases, relation counts, wikilinks, tags, entity/concept nodes, degree/weight, source/viewer metadata, selected context/uploads, and vault relation signals.
- The Cywell topology dashboard now renders PBS-rich topology semantics as KPI signals, distinct node tones, type filters, Signal leaders, inspector metadata, relation lines, and node-to-RAG actions.
- CRC deployment verification now records verified runtime image digest evidence for app `:dev` ImageStreamTags and the running Postgres imageID.
- CRC release promotion now refuses to move `v0.1.4` tags unless each release source digest matches the PASS CRC deployment evidence in `test-results/cas-crc-deployment.json`.
- Strict live preflight now rejects wildcard customer ACL placeholders, verifies applied ConfigMap values, checks applied workload pod digests against promoted release evidence, and evaluates the union of applied knowledge-engine egress NetworkPolicies.

Proof captured in that pass:

- `python -m py_compile apps/knowledge-engine/src/cas_knowledge_engine/engine.py apps/knowledge-engine/src/cas_knowledge_engine/storage.py`: PASS.
- `node --check` passed for changed verification and release scripts.
- `npm run verify:knowledge-engine`: PASS, 78 checks.
- `npm run verify:console:topology-dom`: PASS, 31 browser-backed checks.
- `npm run verify:console:integration`: PASS, 71 checks.
- `npm run verify:deploy:manifests`: PASS, 257 checks.
- `npm run verify`: PASS.
- `npm run deploy:crc`: PASS, 68 runtime checks.
- `CAS_RELEASE_FORCE=true npm run release:crc:v0.1.4`: PASS, 21 release checks.
- `npm run verify:pbs:preflight:live:preapply`: expected FAIL in older evidence; current generated-site preapply evidence is `48 PASS / 7 FAIL` with only external namespace/service/Secret cleanup blockers.

Latest CRC `v0.1.4` release image references are intentionally not duplicated in this tracked document. The source of truth is ignored evidence under `test-results/cas-release-images.json`, specifically `branch`, `head`, `status`, and `promotedImages`.

## Previous Update - Customer ACL and Live Gate Tightening

Implemented after the live-readiness parallel audit pass:

- Gateway private knowledge proxy now supports `CAS_KNOWLEDGE_REQUIRE_CUSTOMER_ACCESS=true`.
- Customer workspace ACL can be supplied through `CAS_KNOWLEDGE_CUSTOMER_ACCESS_JSON` or `CAS_KNOWLEDGE_CUSTOMER_ACCESS_FILE`.
- Private knowledge requests are rejected before reaching Knowledge Engine when the verified owner/user/group is not allowed for the requested `customer_id`.
- Conflicting customer scope across top-level request fields and nested `source_metadata`/`sourceMetadata`/`metadata` is rejected before indexing or outbound PBS calls.
- pbs-live enables Gateway customer ACL and reads `CAS_KNOWLEDGE_CUSTOMER_ACCESS_JSON` from `cas-knowledge-live-config/customer-access-json`.
- The tracked default live ConfigMap value is fail-closed (`{}`); production clusters must use the rendered `pbs-live-site` overlay from `render:pbs:live-prereqs` for reviewed user/group/customer mapping.
- Live smoke cutover/release mode now forbids read-only exception bypass and requires write lineage.
- Cluster direct-engine block verification now requires an actual blocked result from the in-cluster probe, not merely any non-200 response.
- Strict live preflight now checks `CAS_PBS_TLS_INSECURE=false`, live Gateway customer ACL wiring, and the union of applied ingress NetworkPolicies selecting knowledge-engine pods.

Proof captured in that pass:

- `node --check` passed for Gateway and changed verifier scripts.
- `npm run verify:knowledge-engine`: PASS, 76 checks.
- `npm run verify:deploy:manifests`: PASS, 257 checks.
- `npm run verify`: PASS.
- `npm run deploy:crc`: PASS, 68 runtime checks.
- `CAS_RELEASE_FORCE=true npm run release:crc:v0.1.4`: PASS, 21 release checks.
- `npm run verify:pbs:preflight:live:preapply`: expected FAIL in older evidence; current generated-site preapply evidence is `48 PASS / 7 FAIL` with only external namespace/service/Secret cleanup blockers.

Latest CRC `v0.1.4` release image references are intentionally not duplicated in this tracked document. The source of truth is ignored evidence under `test-results/cas-release-images.json`, specifically `branch`, `head`, `status`, and `promotedImages`.

## Latest Update - Internal Owner Signing, Secret Hygiene, and CRC Redeploy

Implemented after the post-commit parallel audit pass:

- Removed the literal dev Postgres Secret from tracked base manifests.
- `deploy:crc` now creates local CRC-only `cas-knowledge-postgres` credentials when the Secret is absent and preserves existing local credentials when present.
- Added `cas-knowledge-internal-auth/owner-hmac-secret` as the shared internal owner-signing Secret for Gateway and Knowledge Engine.
- Gateway signs its derived owner header with `x-cas-owner-signature`.
- Knowledge Engine trusted-header mode now rejects unsigned or incorrectly signed `x-forwarded-user` values when `CAS_KNOWLEDGE_OWNER_HMAC_SECRET` is configured.
- Public Gateway `/healthz` and `/api/aiops/healthz` now omit brain provider, evidence provider, owner identity mode, and runtime mode internals.
- PBS live preflight now checks the live `DATABASE_URL` Secret over TCP through the Postgres service, not only local pod credentials.
- Console direct verification scripts now build ignored `dist/` assets automatically when invoked directly; the aggregate verify path uses the built variants after the single console build.
- CRC build context filtering now excludes Python bytecode and `__pycache__`.

Proof captured in that pass:

- Clean clone from `v0.1.4` commit `c335977`: `npm ci` PASS and `npm run verify` PASS.
- Current working tree verification after hardening: `npm run verify` PASS.
- `npm run verify:knowledge-engine`: PASS, latest 76 checks.
- `npm run verify:deploy:manifests`: PASS, latest 257 checks.
- `npm run deploy:crc`: PASS, latest 68 runtime checks; rebuilt and redeployed `cas-gateway:dev`, `cas-console-plugin:dev`, and `cas-knowledge-engine:dev`; CRC deployment verification passed, including HMAC Secret refs, topology dashboard bundle, PBS-compatible schema/shadow rows, and verified image digests.
- `npm run verify:pbs:cutover`: expected FAIL because local `CAS_PBS_BASE_URL` is not configured.
- `npm run verify:pbs:cutover:cluster`: expected FAIL because the CRC cluster has no `playbookstudio` namespace/service, no `cas-pbs-auth`, no `cas-knowledge-postgres-live`, and still runs the base dev overlay.

## Implemented

- Added storage boundary for the knowledge engine:
  - `JsonKnowledgeStore`
  - `PostgresKnowledgeStore`
  - explicit provider and owner-scope runtime metadata
- Added owner scope handling:
  - engine methods accept owner scope
  - HTTP handler supports trusted owner headers
  - Gateway derives a stable owner hint from UserToken/Authorization and does not trust forwarded owner headers by default
  - Knowledge Engine can require trusted owner headers for scoped data APIs
  - local smoke verifies same `customer_id` isolation across owners
- Added PostgreSQL/pgvector runtime:
  - `cas-knowledge-postgres` StatefulSet
  - `pgvector/pgvector:pg16`
  - `DATABASE_URL` external Secret wiring
  - knowledge engine `psycopg[binary]`
  - `vector(768)` readiness table
- Added PBS-compatible ingest contract metadata:
  - upload accepts and records `file_name`, `source_scope`, `visibility`, `source_kind`, `source_metadata`, `force_reingest`, and `index`
  - URL ingest records `url` and `auto_compile_wiki`
  - `created_by` is resolved from payload or the owner scope supplied by the gateway
- Added base64/MIME-aware ingest smoke support:
  - text payloads
  - base64 payloads
  - lightweight DOCX/PPTX/XLSX XML extraction
  - lightweight PDF text extraction fallback
- Added PBS HTTP shadow/live provider boundary:
  - `pbs-http-shadow` keeps CAS local behavior authoritative and records PBS traces
  - `pbs-http-live` normalizes PBS upload, URL ingest, reports, chat/RAG, wiki-loop, wiki status, wiki vault graph, and note-save responses into CAS API shapes
  - PBS owner contract sends `X-User` and the matching PBS owner hash
  - shadow writes are gated behind `CAS_PBS_SHADOW_WRITES=true`
  - live mode propagates failed PBS operations as non-2xx CAS HTTP responses instead of 200/error bodies
  - live health can require PBS DB/pgvector runtime readiness, corpus/index parity, zero missing/stale embedding entries, compiled wiki readiness, and required scopes before the pod is considered healthy
- Added PBS shadow/live deployment overlays:
  - `deploy/kustomize/overlays/pbs-shadow`
  - `deploy/kustomize/overlays/pbs-live`
  - stable `cas-pbs-config` ConfigMap
  - shadow mode uses an optional `cas-pbs-auth/bearer-token` Secret reference
  - live mode uses a required `cas-pbs-auth/bearer-token` Secret reference
  - live mode deletes inherited dev knowledge env before re-adding `cas-knowledge-live-config/service-owner` and `cas-knowledge-postgres-live/database-url`
  - base/live manifests do not render literal dev Postgres Secret material
  - live mode uses `v0.1.4` release image tags instead of mutable `:dev` image tags
  - knowledge-engine egress restricted to DNS, Postgres, and labeled PBS runtime pods on namespace `playbookstudio`, port `8765`
  - live mode requires `CAS_PBS_REQUIRE_RUNTIME_READY=true`, `CAS_PBS_REQUIRE_CORPUS_READY=true`, and `CAS_PBS_REQUIRED_READY_SCOPES=official_docs,study_docs`
- Added Knowledge Engine ingress isolation:
  - `cas-knowledge-engine-ingress` NetworkPolicy allows only CAS gateway pods on TCP `8080`
  - CRC verifier checks the live policy shape
  - CRC verifier confirms `cas-console-plugin` cannot directly reach `cas-knowledge-engine`
- Added `npm run verify:pbs:live` for optional real PBS live smoke.
- Added `npm run verify:pbs:preflight` for rendered overlay and cluster-readiness preflight before PBS shadow/live cutover.
- Added `npm run verify:pbs:preflight:live` for strict cutover preflight requiring the real PBS namespace/service and required Secrets.
- Added `npm run verify:pbs:cutover` for required live write smoke; it fails without `CAS_PBS_BASE_URL`.
- Added request body limits:
  - Gateway `CAS_MAX_REQUEST_BYTES`
  - Knowledge Engine `CAS_KNOWLEDGE_MAX_REQUEST_BYTES`
- Added Cywell Topology dashboard visualization:
  - KPI stats strip
  - node type segmented filter
  - PBS Wiki Vault `graph.nodes/graph.edges` and CAS normalized topology payload support
  - nested PBS `topology.graph`, `links`, `relations`, `relationships`, `node_id`, `source_id`, and `target_id` topology variants
  - degree-ranked graph canvas
  - relation lines
  - selectable graph nodes
  - selected node inspector
  - relation grid
  - selected node to RAG action
- Updated `deploy:crc` build flow to avoid OpenShift binary build cancellation after long uploads by starting builds first, following build logs, and polling final build phase.
- Removed generated Python `__pycache__` from the source tree.

## Verification

Executed:

```powershell
npm run verify
npm run verify:pbs:preflight
npm run verify:pbs:preflight:live
npm run verify:pbs:live
npm run verify:pbs:cutover
npm run deploy:crc
npm run verify:crc:deployment
```

Results:

- `npm run verify`: PASS
- `npm run verify:pbs:preflight`: PASS/WARN locally; rendered live overlay passes, current CRC warns because the real `playbookstudio` namespace/service, `cas-pbs-auth` Secret, and `cas-knowledge-postgres-live` Secret are not present, and because the legacy CRC `cas-knowledge-postgres` Secret still exists
- `npm run verify:pbs:preflight:live`: expected FAIL locally because strict live prerequisites are absent
- `npm run verify:pbs:live`: SKIP/PASS behavior confirmed when `CAS_PBS_BASE_URL` is unset
- `npm run verify:pbs:cutover`: expected FAIL locally because `CAS_PBS_BASE_URL` is unset
- `npm run deploy:crc`: PASS
- `npm run verify:crc:deployment`: PASS
- `verify:knowledge-engine`: PASS with PBS upload/base64/URL contract checks, owner-required checks, spoofed owner-header rejection, PBS runtime/corpus readiness checks, and live error propagation checks
- `verify:knowledge-engine`: PASS with PBS HTTP shadow/live fake-backend checks and live outbound owner/hash/customer_id contract checks across upload, URL ingest, reports, chat, wiki run/status, wiki vault, and note save
- `verify:console:integration`: PASS with source and bundle checks for PBS payload fields, topology variant normalization, and topology KPI/relation-grid UI

Latest persisted CRC verifier evidence before the current hardening changes:

- `test-results/cas-crc-deployment.json`
- status: `PASS`
- total checks: `71`
- live bundle check: `console:topology-dashboard-bundle`
- verified release-source image checks:
  - `runtime:verified-image:cas-gateway`
  - `runtime:verified-image:cas-console-plugin`
  - `runtime:verified-image:cas-knowledge-engine`
  - `runtime:verified-image:cas-knowledge-postgres`
- ingress isolation checks:
  - `runtime:knowledge-ingress-policy`
  - `runtime:knowledge-ingress-gateway-only`
  - `runtime:knowledge-direct-access-blocked`
- live knowledge smoke includes upload, base64 upload, URL ingest, RAG, wiki, topology, and PBS contract metadata
- live knowledge smoke rejects missing owner and spoofed `x-remote-user`/`x-openshift-user` headers through the deployed gateway
- runtime request limit checks:
  - `runtime:gateway-request-limit-env`
  - `runtime:knowledge-request-limit-env`
- database checks:
  - `runtime:knowledge-postgres-extensions`
  - `runtime:knowledge-postgres-tables`
  - `runtime:knowledge-postgres-pbs-compatible-schema`
  - `runtime:knowledge-postgres-vector-dimension`
  - `runtime:knowledge-pbs-compat-shadow-persisted`
  - `runtime:knowledge-smoke-persisted`

Current working-tree manifest verifier evidence:

- `test-results/cas-deploy-manifests.json`
- status: `PASS`
- total checks: `283`
- rendered kustomize checks:
  - `base` remains `pbs-compatible-local`
  - `pbs-shadow` renders `pbs-http-shadow` with no provider env duplication
  - `pbs-live` renders `pbs-http-live` and does not retain the shadow provider
  - `base`, `pbs-shadow`, and `pbs-live` all inherit `cas-knowledge-engine-ingress`
  - PBS bearer token remains a Secret reference, not a literal
  - shadow renders an optional token Secret reference
  - live renders a required token Secret reference
  - live renders runtime and corpus/index readiness gates
  - live renders no CRC owner, no dev DB password, no generated dev Postgres Secret, and no `:dev` app image tags
  - live renders required `cas-knowledge-postgres-live` Secret references for engine and Postgres
  - PBS egress policy has no broad 80/443/API egress and scopes PBS runtime egress by pod labels

Latest PBS preflight evidence:

- `test-results/cas-pbs-preflight-pbs-shadow-diagnostic-local-optional-secrets.json`
- `test-results/cas-pbs-preflight-pbs-live-site-preapply-cluster-required-secrets.json`
- shadow diagnostic status: `PASS/WARN` in the local CRC environment because the real `playbookstudio` namespace/service and optional `cas-pbs-auth` Secret are absent
- live preapply status: expected `FAIL`, `48 PASS / 7 FAIL`
- rendered live overlay checks pass for provider, ConfigMap env refs, required token Secret ref, live Postgres Secret refs, no literal Secret material, no dev defaults, HTTPS PBS service-token transport, PBS base URL shape, timeout/response bounds, labeled PBS egress, knowledge ingress, runtime readiness gate, corpus readiness gate, and disabled shadow writes
- WARNs/failures are expected in local CRC until the real `playbookstudio` namespace/service, required `cas-pbs-auth` Secret, required `cas-knowledge-postgres-live` Secret, and cleanup of legacy `cas-knowledge-postgres` Secret are handled

## Parallel Review Findings

Four read-only parallel reviews were run across the runtime/UI work and the PBS overlay work.

Accepted findings:

- Do not claim full PBS engine parity yet.
- Current upload path now supports base64 and lightweight MIME-aware extraction, but it is still not exact PBS parser/indexer parity.
- PBS HTTP live provider is implemented against a fake PBS backend; real PBS runtime wiring is still separate.
- Current RAG is keyword retrieval, not PBS embedding/vector/LLM answerer parity.
- In `pbs-http-live`, RAG delegates to PBS `/api/chat`; CRC default remains `pbs-compatible-local`.
- Current LLM Wiki loop is a note generator, not PBS compiler parity.
- In `pbs-http-live`, wiki-loop delegates to PBS `/api/wiki-loop/run`; CRC default remains local.
- Current topology graph is doc/note/term relation smoke, not PBS entity graph parity.
- In `pbs-http-live`, topology normalizes PBS Wiki Vault graph.
- Multi-user production identity now has an explicit Gateway SelfSubjectReview contract; cluster-ID scoping should still be reviewed before sharing one knowledge DB across multiple clusters.
- Remove generated `__pycache__`.
- Render PBS overlays during manifest verification, not just substring-check files.
- Keep CRC deployment on the base/local path; do not apply PBS shadow/live overlays by default.
- PBS backend API health is `GET /api/health` on port `8765`; public web/nginx is normally port `8080` and proxies `/api/*`.
- Do not trust PBS top-level `ok` alone; gate live readiness on nested `runtime.db_ready`, `runtime.pgvector_ready`, `runtime.db_corpus.embedding_index_parity`, missing/stale embedding counters, compiled wiki readiness, and required ready scopes.
- Do not let live smoke pass on `status:error` response bodies; require non-error body plus PBS trace `ok=true`.
- Do not preserve raw PBS `topology` over the CAS-normalized topology in live Wiki Vault responses; keep the raw PBS shape under `pbs_topology` and always expose renderable CAS topology under `topology`.
- Do not allow Gateway to forward spoofed owner headers; only the Gateway-minted SelfSubjectReview owner scope is forwarded to Knowledge Engine.
- Do not let PBS read endpoints drop `customer_id`; reports, wiki status, and wiki vault requests now carry both owner hash and customer scope.
- Do not claim a live cutover from the default preflight; strict `verify:pbs:preflight:live` and `verify:pbs:cutover` must pass against the real PBS runtime.

Rejected ponytail simplifications for this scope:

- Removing Postgres/pgvector was rejected because v0.1.4 must establish the PBS-compatible storage/runtime path.
- Removing the Topology dashboard was rejected because the requested feature needs a usable visual dashboard, not raw JSON output.
- Collapsing all Cywell knowledge routes into one route was rejected because the user explicitly asked for Cywell menu sub-features.

## Historical Update - Topology/Lineage Hardening

Implemented after the second parallel review pass:

- User does not need to provide a separate topology dashboard design package for v0.1.4.
- Cywell owns the topology dashboard visual structure for this slice:
  - KPI strip
  - graph canvas
  - node type filter
  - selected-node inspector
  - relation grid
  - selected node to RAG action
  - lineage fields such as revision and source document in the inspector
- Added browser-level topology DOM smoke:
  - `npm run verify:console:topology-dom`
  - mounts the built dynamic plugin entry in a real local Chrome/Edge browser
  - asserts route mount, empty state, customer_id query propagation, 4 nodes, 3 edges, node tones, numeric SVG edge coordinates, inspector lineage, type filter behavior, node-to-RAG action, and absence of browser/page errors
  - latest result: `PASS`, 12 checks
- Strengthened local knowledge lineage verification:
  - upload creates initial LLM Wiki note with `revision=1`
  - RAG cites the exact uploaded document
  - repeated wiki-loop advances the same note through revisions 2 and 3
  - topology contains the uploaded document node, evolving wiki-note node, and `summarizes` edge
  - latest `npm run verify:knowledge-engine`: `PASS`, 48 checks
- Preserved PBS topology provenance in CAS normalization:
  - node/edge `metadata`
  - node/edge `provenance`
  - `revision`
  - `previous_revision`
  - `source_document_id`
  - `document_id`
  - `updated_at`
- Strengthened CRC runtime smoke:
  - parses the smoke JSON instead of substring matching
  - generates a unique lineage token
  - verifies exact uploaded document ID through RAG citation, LLM Wiki revision, topology edge, and Postgres rows
  - latest `npm run verify:crc:deployment`: `PASS`
- Strengthened live/cutover gates:
  - local live smoke now starts a gateway proxy and verifies no-owner plus spoofed owner headers are rejected
  - write/cutover live smoke now requires upload -> RAG -> wiki vault -> topology lineage when `CAS_PBS_BASE_URL` is configured
  - strict live preflight now compares applied cluster state in `--require-cluster` mode, including live images/env/Secret refs, NetworkPolicies, and Postgres runtime schema
- Latest full verification:
  - `npm run verify`: `PASS`
  - `npm run deploy:crc`: `PASS`
  - `npm run verify:crc:deployment`: `PASS`
  - `npm run verify:pbs:preflight`: `WARN` in current CRC because real PBS prerequisites are absent
  - `npm run verify:pbs:preflight:live`: expected `FAIL` in current CRC because `playbookstudio`, `cas-pbs-auth`, `cas-knowledge-postgres-live`, live image/env state, and PBS egress policy are not applied
  - `npm run verify:pbs:cutover`: expected `FAIL` until `CAS_PBS_BASE_URL` is configured

## Historical Update - Topology UX, Owner Header, and Public Error Hardening

Implemented after the parallel release/security/frontend review pass:

- Hardened the standalone static console preview against HTML injection.
  - Replaced analysis result `innerHTML` rendering with explicit DOM nodes and `textContent`.
  - Added `console-static:no-inner-html` to `verify:console:integration`.
- Reduced owner identity trust boundaries.
  - Knowledge Engine trusted-header mode now accepts only Gateway-derived `x-forwarded-user`.
  - Legacy `x-remote-user` and `x-openshift-user` are rejected by the engine when an owner header is required.
  - Gateway CORS now advertises only `authorization,content-type` to browser clients.
  - Knowledge Engine CORS advertises only `authorization,content-type,x-forwarded-user`.
- Sanitized public knowledge capabilities failures.
  - Public `/api/knowledge/capabilities` no longer discloses the internal Knowledge Engine endpoint or timeout when the engine is unavailable.
- Reworked topology visualization for operational viewport stability.
  - The dashboard grid is single-column by default and only switches to graph/inspector columns on wide desktop.
  - Canvas rendering caps to the top seven high-degree nodes and reports `Showing N of total nodes`.
  - Mobile view switches the topology canvas to a non-overlapping node list.
  - Added `aria-current` for Cywell route nav, `aria-pressed` for filters and selected nodes, full node button labels, and long-label wrapping.
- Expanded browser-backed topology verification.
  - Adds a 28-node long-label fixture.
  - Checks 1024px and 390px viewports for horizontal overflow and node overlap.
  - Checks route/filter/node accessibility state.

Historical verified results at this step:

- `npm run verify`: `PASS`
- `npm run verify:knowledge-engine`: `PASS`, 61 checks
- `npm run verify:console:integration`: `PASS`, 63 checks
- `npm run verify:console:topology-dom`: `PASS`, 19 checks
- `npm run deploy:crc`: `PASS`
- `npm run verify:pbs:cutover`: expected `FAIL`; `CAS_PBS_BASE_URL` is not configured
- `npm run verify:pbs:cutover:cluster`: expected `FAIL`; current CRC has no `playbookstudio` namespace/service, no `cas-pbs-auth`, no `cas-knowledge-postgres-live`, still runs `:dev` base images/provider, has legacy `cas-knowledge-postgres` dev Secret, and has not applied `cas-knowledge-engine-pbs-egress`

## Earlier Update - Local Vault Graph and Head-Bound Release Evidence

Implemented in this pass:

- Local Wiki Vault now extracts `[[wikilinks]]`, `#tags`, URLs, concepts, graph relations, backlinks, selected context, and selected upload metadata from CAS uploads and wiki notes.
- Local RAG now attaches and cites Wiki Vault context, including wiki-only facts that are not present in uploaded document chunks.
- Local topology now exposes upload document nodes, wiki-note nodes, wikilink/tag/concept nodes, relation edges, degree/weight signals, and PBS-style summary counts.
- CRC release promotion now rejects stale or wrong-HEAD deployment evidence, enforces verified app source digests, records `promotedImages`, and separates Postgres external verified digest from the internal promoted ImageStream digest.
- Strict PBS live preflight now requires current release image evidence and compares applied release ImageStreamTag digests to the promoted evidence digest.

Verification in this pass:

- `npm run verify`: `PASS`
- `npm run verify:knowledge-engine`: `PASS`, 78 checks
- `npm run verify:console:topology-dom`: `PASS`, 31 checks
- `npm run verify:deploy:manifests`: `PASS`, 257 checks

Operational note:

- Because CRC deployment and release evidence is now tied to the current git `head`, `npm run deploy:crc` and `CAS_RELEASE_FORCE=true npm run release:crc:v0.1.4` must be rerun after the final tracked commit for this pass.

## Current Update - PBS Live Response Scope Hardening

Implemented after the latest parallel review pass:

- PBS live response bodies are now checked against the requested customer ID and owner/PBS user hash.
- CAS blocks mismatched PBS report rows, wiki vault payloads, and topology graphs with `pbs-scope-mismatch` before exposing them to callers.
- Topology visual design remains owned by the Cywell console plugin implementation; no separate user-provided design package is required for v0.1.4.

Verified results at this step:

- `npm run verify:knowledge-engine`: `PASS`, 75 checks
- `npm run verify:deploy:manifests`: `PASS`, 252 checks

Live cutover note:

- Standard Kubernetes NetworkPolicy cannot allow `kubernetes.default.svc` by Service name. Any non-CRC PBS live cluster must provide/verify cluster-specific Kubernetes API egress for Gateway SelfSubjectReview/OpenShift evidence before applying strict live cutover.

## Historical Update - Cutover and Isolation Hardening

Implemented after the security-focused parallel review pass:

- Namespaced client-supplied LLM Wiki note IDs by owner/customer so two owners cannot overwrite each other's notes by sending the same note `id`.
- Added verification that two different bearer tokens saving `shared-note-id` under the same customer produce distinct note IDs and isolated vault results.
- Changed local/live PBS cutover smoke to exercise the Gateway knowledge API for upload, RAG, wiki vault, and topology instead of calling the Knowledge Engine directly with a forged owner header.
- Added `npm run verify:pbs:cutover:cluster` for in-cluster applied-state cutover smoke:
  - chains strict `verify:pbs:preflight:live` before mutation
  - checks applied `v0.1.4` image tags, live provider env, required Secret refs, owner-required mode, PBS egress policy, ready Gateway/Console pods, and direct engine access blocking
  - executes data-plane smoke from a ready Gateway pod through `https://127.0.0.1:9443/api/knowledge/*`
  - requires upload -> RAG -> wiki vault -> topology lineage for cutover writes
- Fixed strict preflight's live Postgres probe to verify the actual CAS schema column `cas_knowledge_vector_readiness.embedding vector(768)`.
- Removed broad Gateway egress peers from the base NetworkPolicy and added a base Knowledge Engine egress policy limited to DNS and CAS Postgres.
- Extended manifest/runtime verifiers to reject broad namespace, pod, and internet egress in Gateway and Knowledge Engine policies.

Historical hardening verification at this step:

- `npm run verify:knowledge-engine`: `PASS`, 49 checks
- `npm run verify:deploy:manifests`: `PASS`, 170 checks
- `npm run deploy:crc`: `PASS`
- `npm run verify:crc:deployment`: `PASS`
- `npm run verify`: `PASS`
- `npm run verify:pbs:cutover`: expected `FAIL` when `CAS_PBS_BASE_URL` is unset
- `npm run verify:pbs:cutover:cluster`: expected `FAIL` in the current CRC before mutation because strict live preflight correctly detects that the real `playbookstudio`, `cas-pbs-auth`, `cas-knowledge-postgres-live`, live release image state, and PBS egress policy are not present

## Historical Update - Verified Identity and Gate Hardening

Implemented after the follow-up parallel review pass:

- Replaced production Gateway knowledge owner derivation with OpenShift/Kubernetes `SelfSubjectReview`.
  - Gateway now verifies the incoming Console `UserToken` with `POST /apis/authentication.k8s.io/v1/selfsubjectreviews`.
  - Owner scope is derived from the verified Kubernetes user identity, not from the raw bearer token string.
  - Missing/invalid arbitrary bearer tokens no longer mint a CAS knowledge owner.
  - Gateway no longer forwards bearer tokens to the Knowledge Engine internal hop.
  - Gateway no longer forwards client-supplied `x-forwarded-user`, `x-remote-user`, or `x-openshift-user` for knowledge owner scope.
- Kept `automountServiceAccountToken: false` on `cas-gateway`; SelfSubjectReview uses the incoming user token and does not require a mounted Gateway service-account token.
- Added `apps/gateway/src/ownerIdentity.mjs` with explicit local `token-hash` mode for local smoke tests and `openshift-selfsubjectreview` mode for CRC/OpenShift deployment.
- Strengthened PBS HTTP auth verification:
  - fake PBS now rejects every `/api/*` call without `Authorization: Bearer verify-pbs-token`
  - shadow/live provider verification asserts PBS bearer auth is present on every PBS API request
  - cluster cutover smoke now requires live `CAS_PBS_AUTH_MODE` and `CAS_PBS_BEARER_TOKEN -> cas-pbs-auth/bearer-token`
- Strengthened topology release gate:
  - `npm run verify:console:topology-dom` now runs with `--require-browser`
  - browser absence is a release-gate failure, not a successful skip
- Strengthened runtime NetworkPolicy verification:
  - `verify:crc:deployment` now checks all NetworkPolicies selecting gateway/knowledge-engine pods, not only the named expected policies
  - any stale broad policy selecting those pods fails the runtime gate

Historical verified results at this step:

- `npm run deploy:crc`: `PASS`
- `npm run verify:crc:deployment`: `PASS`
- `npm run verify`: `PASS`
- `npm run verify:gateway`: `PASS`, 15 checks
- `npm run verify:knowledge-engine`: `PASS`, 50 checks
- `npm run verify:console:topology-dom`: `PASS`, 12 checks with required browser mode
- `npm run verify:deploy:manifests`: `PASS`, 174 checks
- `npm run verify:pbs:cutover`: expected `FAIL` because `CAS_PBS_BASE_URL` is unset
- `npm run verify:pbs:cutover:cluster`: expected `FAIL` in current CRC because strict live preflight correctly detects missing real PBS live prerequisites

## Current Boundary

This is now a verified v0.1.4 Cywell knowledge integration surface with live CRC deployment, topology visualization, and a tested PBS HTTP shadow/live provider boundary.

## Current Update - Live Prerequisite Renderer

Implemented in this pass:

- Added `render:pbs:live-prereqs` to render reviewed `cas-pbs-auth`, `cas-knowledge-postgres-live`, and `cas-knowledge-live-config` manifests under ignored `test-results/pbs-live-prereqs/`.
- Added `verify:pbs:live-prereqs` and wired it into `npm run verify`.
- The renderer rejects placeholder/short PBS token material, wildcard/default customer ACLs, placeholder customer/principal values, non-service Postgres URLs, and Postgres URL values that do not match the individual Secret fields.
- The renderer writes only a redacted summary and evidence file with hashes and git head metadata.

Topology design note:

- No separate user-provided topology dashboard design file is required for v0.1.4. The Cywell console plugin owns the visual system and continues to render PBS-rich topology semantics with KPI strip, graph canvas, node index, inspector, relation grid, signal leaders, and node-to-RAG actions under browser-backed DOM verification.

It is not yet a production PBS live deployment. The PBS shadow/live deployment overlays are present and render-verified, but the next implementation slice still needs a real PBS runtime around:

- actual `CAS_PBS_BASE_URL` for the target PBS app/web service
- real `cas-pbs-auth/bearer-token` Secret material created outside git for live mode
- real `cas-knowledge-postgres-live` Secret with `database`, `username`, `password`, and `database-url`
- pruning/deleting the legacy CRC `cas-knowledge-postgres` Secret before applying `pbs-live`
- ensuring `playbookstudio-runtime` selects ready pods labeled `app.kubernetes.io/name=playbookstudio` and `app.kubernetes.io/component=runtime`
- publishing or retagging the built app images as `v0.1.4` before applying the live overlay
- applying `pbs-shadow` first, then `pbs-live` after read/write smoke is accepted
- PBS migration/indexer readiness
- real PBS `/api/uploads/ingest`, `/api/uploads/url-ingest`, `/api/chat`, `/api/wiki-loop/run`, and `/api/wiki-vault` smoke data
- streaming endpoints if required by the Cywell UI

## Historical Update - Review Closure, Clean CRC Deploy, and Public Health Boundary

Implemented after the second parallel review pass:

- Gateway private knowledge routes now fail closed at the Gateway when owner verification fails.
  - Missing/invalid owner identity returns `401 knowledge-owner-unverified`.
  - SelfSubjectReview transport failure returns `503 knowledge-owner-verifier-unavailable`.
  - These failures do not proxy to the Knowledge Engine.
- Gateway public knowledge health is now sanitized.
  - Keeps `status`, `service`, `version`, `provider`, `engine.status`, and `capabilities`.
  - Removes storage paths, tenant counts, provider internals, PBS diagnostics, and upstream endpoints from public Console proxy health.
- Added local Gateway boundary smoke with a recording fake Knowledge Engine.
  - Verifies user `Authorization` is not forwarded to the internal Knowledge Engine hop.
  - Verifies spoofed `x-forwarded-user`, `x-remote-user`, and `x-openshift-user` are stripped.
  - Verifies only the Gateway-derived `x-forwarded-user` reaches the Knowledge Engine.
- Made `deploy:crc` clean-cluster reproducible.
  - Applies `00-namespace.yaml` before namespaced BuildConfigs.
  - Declares ImageStreams for gateway, console-plugin, and knowledge-engine.
  - Treats the legacy v0.1.3 operator pause as optional when it is not installed.
- Expanded NetworkPolicy coverage.
  - Gateway ingress is limited to OpenShift Console and console-plugin pods on TCP `9443`.
  - Console-plugin ingress is limited to OpenShift Console on TCP `9443`.
  - Console-plugin egress is limited to DNS and CAS gateway.
  - Knowledge Engine ingress remains gateway-only on TCP `8080`.
  - Knowledge Engine egress remains DNS/Postgres-only in base.
  - Postgres ingress is knowledge-engine-only on TCP `5432`.
  - Postgres egress is explicit default deny.
- Updated package metadata to `0.1.4` and made active v0.1.4 deliverables branch-contained.

Historical verified results at this step:

- `npm run verify:knowledge-engine`: `PASS`, 57 checks
- `npm run verify:deploy:manifests`: `PASS`, 201 checks
- `npm run deploy:crc`: `PASS`
- `npm run verify:crc:deployment`: `PASS`, 59 checks
- `npm run verify`: `PASS`
- `node --check apps/gateway/src/server.mjs`: `PASS`
- `node --check scripts/verify-knowledge-engine.mjs`: `PASS`
- `node --check scripts/verify-crc-deployment.mjs`: `PASS`
- `node --check scripts/verify-pbs-live-smoke.mjs`: `PASS`
- `npm run verify:pbs:cutover`: expected `FAIL`; `CAS_PBS_BASE_URL` is not configured
- `npm run verify:pbs:cutover:cluster`: expected `FAIL`; current CRC has no `playbookstudio` namespace/service, no `cas-pbs-auth`, no `cas-knowledge-postgres-live`, still runs `:dev` base images/provider, has legacy `cas-knowledge-postgres` dev Secret, and has not applied `cas-knowledge-engine-pbs-egress`
