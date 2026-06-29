# Cywell v0.1.4 Phase 3-6 Runtime and Topology Execution Log

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

Current proof:

- Clean clone from `v0.1.4` commit `c335977`: `npm ci` PASS and `npm run verify` PASS.
- Current working tree verification after hardening: `npm run verify` PASS.
- `npm run verify:knowledge-engine`: PASS, 62 checks.
- `npm run verify:deploy:manifests`: PASS, 204 checks.
- `npm run deploy:crc`: PASS, rebuilt and redeployed `cas-gateway:dev`, `cas-console-plugin:dev`, and `cas-knowledge-engine:dev`; CRC deployment verification passed, including HMAC Secret refs and topology dashboard bundle.
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

Latest CRC verifier evidence:

- `test-results/cas-crc-deployment.json`
- status: `PASS`
- total checks: `43`
- live bundle check: `console:topology-dashboard-bundle`
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
  - `runtime:knowledge-postgres-vector-dimension`
  - `runtime:knowledge-smoke-persisted`

Latest manifest verifier evidence:

- `test-results/cas-deploy-manifests.json`
- status: `PASS`
- total checks: `163`
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

- `test-results/cas-pbs-preflight.json`
- status: `WARN` in the local CRC environment because the real `playbookstudio` namespace/service and `cas-pbs-auth` Secret are absent
- total checks: `29`
- rendered live overlay checks pass for provider, ConfigMap env refs, required token Secret ref, live Postgres Secret refs, no literal Secret material, no dev defaults, PBS base URL shape, timeout/response bounds, labeled PBS egress, knowledge ingress, runtime readiness gate, corpus readiness gate, and disabled shadow writes
- WARNs are expected in local CRC until the real `playbookstudio` namespace/service, required `cas-pbs-auth` Secret, required `cas-knowledge-postgres-live` Secret, and cleanup of legacy `cas-knowledge-postgres` Secret are handled

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
