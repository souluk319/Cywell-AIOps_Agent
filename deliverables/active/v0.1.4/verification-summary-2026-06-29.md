# v0.1.4 Verification Summary - 2026-06-29

## Scope

This summary captures the current v0.1.4 branch verification state for the Cywell PBS/customer-data/RAG/LLM Wiki/topology integration.

## Passing Verification Gates

| Command | Result | Notes |
| --- | --- | --- |
| `npm run verify` | PASS | Full local gate including contracts, gateway, knowledge engine, brain, OpenShift evidence, console build, browser topology DOM, console integration, CRC connection preview, PBS source contract, PBS live prerequisite renderer self-test, and manifest verification |
| `npm run verify:knowledge-engine` | PASS, 100 checks | Includes Gateway owner verification, signed internal owner headers, recursive customer/workspace/tenant scope mismatch rejection, nested scope alias scrubbing before PBS proxying, strict ConfigMap-driven customer workspace ACL behavior, explicit customer ID requirement, invalid ACL fail-closed behavior even when enforcement is unset, customer mismatch not-proxied fail-closed coverage, internal bearer/header stripping, public health/capabilities sanitization, unsafe upload/URL ingest rejection, private ingest lane enforcement before local indexing or PBS outbound calls, PBS-style upload report `items` with `viewer_path`, `graph_summary`, and `chunk_previews`, local Wiki Vault graph alias/context viewer lineage, selected-upload source scoping for RAG, RAG scope allowlisting to `user_upload` and `wiki_vault`, PBS-style LLM Wiki staged run/status and note overlay metadata, RAG citations from vault-only context, PBS shadow/live adapter contracts, PBS live response scope mismatch, missing scope proof, primitive citation/source leak rejection, rich PBS topology signal preservation, topology provenance, orphan endpoint topology normalization, and single-candidate PBS graph normalization |
| `npm run verify:console:topology-dom:built` | PASS, 34 checks | Browser-required smoke with topology auto-load, empty/error reload stale-data protection, PBS-rich KPI/tone/signal-leader/link-filter rendering, PBS-rich signal-node RAG scope from selected context/upload lineage, Wiki Vault side-channel token/context/relation panels, filter-scoped node index, corpus/viewer deep links from PBS-rich topology nodes and context rows, orphan edge fallback nodes, mixed-scope graph selection, late-response stale-data protection, dense 28-node searchable index, and 1024px/390px overflow/overlap checks |
| `npm run verify:console:integration:built` | PASS, 100 checks | Includes static app `innerHTML` rejection, structural `/cywell/topology` manifest routing/navigation, topology auto-load, topology-selected source-scoped RAG request checks, Customer Corpus Workbench/viewer route checks, explicit all-corpus vs selected-document scope controls, URL ingest corpus joining for PBS `pages`/`upload_results`, selected-corpus RAG and selected-document wiki-loop/note request checks, PBS topology signal fields/counts, Signal leaders, Wiki Vault side-channel panels, and built plugin route/bundle checks |
| `npm run verify:pbs:source-contract:required` | PASS, 29 checks, dirty-source WARN recorded | Verifies the real `F:\AI_Projects\PBS-Dev3` Docker/compose runtime contract, port `8765`, `/api/health`, upload, URL ingest, chat/RAG, Wiki Vault, Wiki Loop, owner-scoped reports, selected uploads, graph, and chunk-preview API surface against the Cywell PBS runtime contract. Evidence records PBS source branch, HEAD, tree status, optional expected HEAD, optional clean-tree enforcement flag, and contract file hashes |
| `npm run verify:pbs:live-prereqs` | PASS, 8 checks | Self-tests live prerequisite rendering, generated `pbs-live-site` overlay rendering, redacted summary output, owner-HMAC Secret validation, wildcard/default/string wildcard/broad group customer ACL rejection, and Postgres database URL/Secret mismatch rejection |
| `npm run verify:deploy:manifests` | PASS, 283 checks | Includes base/shadow/live/CRC render checks, HMAC Secret refs, no tracked dev DB Secret, generated pbs-live site preflight scripts, strict Gateway customer ACL checks, pbs-live Gateway customer ACL config, pbs-live Postgres release image pinning, PBS source-contract static coverage with git/hash evidence, private source-lane policy coverage, PBS-compatible local schema checks, PBS-style local upload report/RAG source-scope checks, LLM Wiki staged contract checks, release image promotion force/evidence binding coverage, explicit strict shadow preflight script coverage, HTTPS PBS service-token transport, PBS live response scope guard coverage, structural Kubernetes API egress matching, PBS runtime endpoint readiness/Secret content/applied NetworkPolicy union self-checks, CRC/release source and cluster identity binding, exact live lineage smoke self-checks, owner-HMAC live prereq/preflight checks, cutover bundle strict source/real-render evidence checks, and direct console script build prerequisites |

Current hardening additions after the initial summary:

- Tracked base manifests no longer contain a literal dev Postgres password or database URL.
- `deploy:crc` creates local-only random dev Postgres and internal owner-HMAC Secrets when missing.
- Gateway signs derived owner headers; Knowledge Engine rejects unsigned owner headers when HMAC is configured.
- Gateway and Knowledge Engine fail closed if the internal owner-HMAC Secret is missing.
- Public Gateway `/healthz`, `/api/aiops/healthz`, `/api/knowledge/healthz`, and `/api/knowledge/capabilities` omit provider and owner identity internals.
- PBS live preflight checks the live `DATABASE_URL` over TCP through the Postgres service.
- Base manifests verify OpenShift API TLS with the mounted namespace CA and verify Lightspeed TLS with the mounted OpenShift service CA instead of disabling TLS verification.
- CRC-specific Kubernetes API egress, lab Lightspeed ingress, and lab-only Lightspeed TLS insecure override are owned by the CRC overlay, not the base render.
- `release:crc:v0.1.4` promotes CRC `:dev` app images plus the running Postgres digest into `v0.1.4` ImageStreamTags; moving an existing release tag now requires `CAS_RELEASE_FORCE=true`.
- pbs-live Postgres now renders as `image-registry.openshift-image-registry.svc:5000/cywell-ai-sentinel/cas-knowledge-postgres:v0.1.4`.
- Topology UI now ignores late customer topology responses, selects one graph payload scope instead of mixing wrapper/nested graph lists, reconciles visible KPI counts after fallback endpoint creation, and announces empty/error states to assistive tech.
- PBS preflight now fails unsupported overlay names, exposes `verify:pbs:preflight:shadow`, validates applied NetworkPolicies structurally, requires live `DATABASE_URL` to target the Postgres Service on port 5432, and checks release ImageStreamTag resolution.
- Local `verify:pbs:cutover` now requires `CAS_PBS_BASE_URL` plus PBS bearer token material; cluster cutover readiness remains gated by `verify:pbs:cutover:cluster`.
- Knowledge Engine now rejects unsafe upload extensions/MIME, invalid base64, oversized decoded uploads, oversized OOXML zip payloads, and loopback/private URL ingest before indexing.
- PBS-live upload policy now runs before outbound PBS calls, and verifier asserts rejected live uploads create no PBS request.
- PBS-live responses are checked against the requested customer ID and owner/PBS user hash before CAS exposes report rows, wiki vault payloads, or topology graphs.
- PBS service-token auth now fails closed without token material and rejects non-local plain HTTP transport; rendered pbs-shadow/live default to HTTPS.
- Gateway can require customer workspace ACL before private knowledge proxying; live mode reads `CAS_KNOWLEDGE_CUSTOMER_ACCESS_JSON` from `cas-knowledge-live-config/customer-access-json`, rejects unmapped customers with `403`, rejects missing customer IDs with `400`, rejects invalid configured ACLs with `503`, and rejects conflicting nested `source_metadata.customer_id` with `400`.
- Gateway now recursively scans query/body customer, workspace, tenant, and customer-workspace aliases, rejects nested scope smuggling before PBS, strips nested scope aliases from forwarded payloads, and preserves only the verified canonical `customer_id`.
- Knowledge Engine PBS response scope checks now include customer, workspace, tenant, and customer-workspace aliases; fake-live verification blocks a cross-scope RAG citation leak with `pbs-scope-mismatch`.
- Strict live preflight checks the live customer ACL env wiring through the generated site overlay, rejects default/wildcard/string/broad-principal ACLs, confirms applied live ConfigMap values, requires release evidence sourced from current non-stale CRC deployment evidence, compares ready pod digests to promoted release evidence, and confirms all applied ingress/egress NetworkPolicies selecting knowledge-engine pods stay scoped.
- PBS live release smoke no longer permits read-only exception bypass for cutover/release checks, and direct-engine block verification requires an actual in-cluster blocked result instead of accepting any non-200 response.
- Preflight and live-smoke evidence artifacts are mode-specific, so shadow, live preapply, live applied, local cutover, and cluster cutover runs do not overwrite each other.
- Local Postgres now creates PBS-compatible `tenants`, `workspaces`, `document_sources`, `parsed_documents`, `document_chunks`, `chunk_embeddings`, and graph tables; CAS ingest writes PBS-compatible document/chunk shadow rows, deterministic local hash embeddings, and customer-scoped graph entity/mention/relation rows. These rows prove CRC schema/lineage compatibility, not PBS production embedding model parity.
- Local upload reports and Wiki Vault selected uploads now expose PBS-style `items`, `document_source_id`, readiness flags, `graph_summary`, top-level `graph`, context `viewer_path`, source scopes, and `chunk_previews`, so topology/RAG consumers can use the same report shape without a live PBS backend.
- Topology inspector RAG actions now send selected topology document scope into `/api/knowledge/rag/query`; local RAG honors `active_document_id`, `enabled_upload_document_ids`, `enabled_source_scopes`, and `restrict_uploaded_sources`, and citations include `document_source_id`, `viewer_path`, `source_scope`, and `source_collection`.
- Customer Corpus Workbench now renders uploaded document/report cards, chunk previews, graph summaries, selected document state, viewer deep links, selected-corpus RAG, and selected-document wiki-loop actions under the Cywell customer data route.
- Knowledge route scope is explicit: operators can switch between full private corpus and selected-document mode, deep-linked documents auto-load reports, URL ingest can join the corpus from PBS `pages` and `upload_results`, saved wiki notes refresh against the current selected document, and result/error text remains visible outside the debug JSON panel.
- User upload and URL ingest payloads are forced into the private lane (`source_scope=user_upload`, `visibility=private_user`) before local storage or PBS outbound requests; RAG source selection is allowlisted to private `user_upload` and `wiki_vault` scopes.
- Private ingest strips both `source_metadata` and camelCase `sourceMetadata` reserved lane, owner, customer, tenant, workspace, and source-collection aliases before PBS outbound calls; PBS-live RAG fails closed for object citations without customer/owner proof and primitive string/source citation leaks.
- Local LLM Wiki loop now returns PBS-style `run_id`, `stages`, `duration_ms`, `warnings`, `summary`, `last_run`, and `compiled_wiki_status`; manual Wiki Vault notes preserve `overlay_id`, `book_slug`, `note_type`, target refs, wikilinks, and tags.
- PBS Wiki Vault topology normalization now preserves PBS summary aliases, wikilinks, tags, entity/concept nodes, degree/weight, source/viewer fields, selected context/uploads, and relation signals.
- The Cywell topology dashboard renders PBS-rich graph semantics as KPIs, node tones, type filters, Signal leaders, Wiki Vault token/context/relation side-channel panels, inspector metadata, relation lines, and node-to-RAG actions in the browser-backed release gate.
- The Cywell console plugin owns the topology visualization design for v0.1.4; no external dashboard design file is required. The current design includes graph canvas, KPI strip, type filters, signal leaders, relation grid, inspector, viewer links, and corpus-to-RAG/wiki actions.
- CRC release promotion is now bound to current-HEAD `test-results/cas-crc-deployment.json`; app release sources must match verified runtime digest evidence before `v0.1.4` tags move, release evidence records `sourceEvidenceHead` and rejects stale-source promotion in strict preflight, Postgres records both the verified external runtime digest and promoted internal ImageStream digest, and strict live preflight compares applied release tags to `test-results/cas-release-images.json`.
- Strict live preflight now checks Gateway Kubernetes API egress structurally, requiring the API target IP and port to be allowed by the same NetworkPolicy egress rule.
- Local Wiki Vault now extracts `[[wikilinks]]`, `#tags`, URLs, concepts, relations, backlinks, selected context/uploads, and can feed RAG citations from wiki-only context.
- Strict live preflight now checks `playbookstudio-runtime` Endpoints on port `8765`, rejects placeholder/short `cas-pbs-auth` bearer tokens, validates decoded `cas-knowledge-postgres-live` values, requires `database-url` credentials/database to match the individual Secret keys, and evaluates applied NetworkPolicy unions for Gateway, Console Plugin, Knowledge Engine, and Postgres.
- Customer ACL concrete validation now evaluates `owners`, `users`, and `groups`; pbs-live rejects `default`, wildcard or prefix/suffix wildcard entries, string ACL values, placeholder principals/customers, and broad Kubernetes system groups before cutover.
- PBS live local/cluster smoke now checks valid-owner unmapped-customer `403` fail-closed behavior with no PBS trace, rejects conflicting nested customer metadata before PBS, and requires exact upload document/customer/source lineage through RAG citations, LLM Wiki notes, and direct topology doc-note edges.
- `render:pbs:live-prereqs` now creates reviewed live Secret/ConfigMap manifests plus a generated `pbs-live-site` overlay under ignored `test-results/pbs-live-prereqs/`, renders `cas-knowledge-internal-auth/owner-hmac-secret`, rejects weak token/HMAC material, wildcard/default/string wildcard/broad-principal customer ACL policy, and mismatched Postgres `database-url`, and records redacted evidence under `test-results/cas-pbs-live-prereqs-render.json`.
- `verify:pbs:live-prereqs` now writes self-test evidence separately under `test-results/cas-pbs-live-prereqs-self-test.json`; the release cutover bundle only accepts real-render evidence with output file hashes, rendered site overlay hash, and redacted summary hash.
- `verify:pbs:source-contract:required` now verifies the checked-out `F:\AI_Projects\PBS-Dev3` runtime/API shape and writes `test-results/cas-pbs-source-contract.json` with PBS branch/HEAD/tree status plus contract file hashes. This proves the source/API contract shape, not a live PBS production deployment. The current checkout passes with a dirty-source WARN; strict release use can set `CAS_PBS_SOURCE_HEAD` and `CAS_PBS_REQUIRE_CLEAN_SOURCE=true`.
- `verify:release:pbs-live` now runs strict source pinning, generated-site live preapply, a `--require-live-ready` cutover bundle, applied live-site preflight, and in-cluster cutover smoke. The bundle rejects dirty or unpinned PBS source evidence, stale/missing HEAD evidence, and self-test prerequisite evidence used as cutover proof.
- CRC deployment and release evidence now records full git HEAD, clean/dirty source status, and cluster identity; deploy refuses dirty tracked source by default, release promotion rejects wrong-HEAD, dirty-source, or wrong-cluster evidence, and strict live preflight compares release evidence cluster identity when present.

Clean checkout reproduction:

```text
C:\Users\soulu\AppData\Local\Temp\cywell-v014-clean-20260629100550
npm ci: PASS
npm run verify: PASS
```

## CRC Evidence Policy

| Command | Result | Notes |
| --- | --- | --- |
| `npm run deploy:crc` | PASS, latest 68 runtime checks | Mutating deploy action; rebuilds and deploys `cas-gateway:dev`, `cas-console-plugin:dev`, and `cas-knowledge-engine:dev` to CRC, creates/preserves local Secrets, applies CRC-only API/Lightspeed policies, verifies app pod imageID digests against dev ImageStreamTags, verifies PBS-compatible Postgres schema/shadow rows, and writes current `head` plus `verifiedImages` to `test-results/cas-crc-deployment.json` |
| `CAS_RELEASE_FORCE=true npm run release:crc:v0.1.4` | PASS after current deployment evidence is regenerated | Mutating release action; refuses stale/wrong-HEAD, dirty-source, or wrong-cluster deployment evidence, verifies app release sources against runtime evidence, records `promotedImages`, and force-promotes `cas-gateway`, `cas-console-plugin`, `cas-knowledge-engine`, and digest-pinned `cas-knowledge-postgres` to local `v0.1.4` ImageStreamTags |
| `npm run verify:pbs:preflight:shadow` | PASS/WARN | Render/config checks pass for `pbs-shadow`; current CRC warns because external `playbookstudio` namespace/service and optional `cas-pbs-auth` are absent |

Current CRC `v0.1.4` release image references are intentionally not duplicated in this tracked document. The source of truth is ignored evidence under `test-results/cas-release-images.json`, specifically `branch`, `head`, `status`, and `promotedImages`.

Local JSON evidence was written under ignored `test-results/`:

```text
test-results/cas-crc-connection.json
test-results/cas-crc-deployment.json
test-results/cas-deploy-manifests.json
test-results/cas-release-images.json
test-results/cas-pbs-live-smoke-local-cutover.json
test-results/cas-pbs-preflight-pbs-shadow-diagnostic-local-optional-secrets.json
test-results/cas-pbs-preflight-pbs-live-preapply-cluster-required-secrets.json
test-results/cas-pbs-live-prereqs-render.json
test-results/cas-pbs-live-prereqs-self-test.json
test-results/cas-pbs-source-contract.json
```

## Expected Failing Live Cutover Gates

| Command | Result | Blocking Reason |
| --- | --- | --- |
| `npm run verify:pbs:cutover` | FAIL expected | `CAS_PBS_BASE_URL` is not configured in the local shell |
| `npm run verify:pbs:preflight:live:site:preapply` | FAIL expected, 46 PASS / 7 FAIL | Generated site overlay render/config/egress/API/release-image checks pass; service-token transport is HTTPS, pbs-live Gateway customer ACL is wired to the generated live ConfigMap replacement, owner-HMAC Secret validation passes from rendered prereq evidence, release evidence cluster identity matches the current cluster, `v0.1.4` release ImageStreamTags resolve to promoted digests, and pbs-live Postgres image pinning passes. Current CRC still has no `playbookstudio` namespace/service, no `cas-pbs-auth`, no `cas-knowledge-postgres-live`, and still has the legacy `cas-knowledge-postgres` dev Secret |
| `npm run verify:release:pbs-live` | FAIL expected | Requires strict `CAS_PBS_SOURCE_HEAD` source pinning plus the same live prerequisites as pre-apply, a live-ready cutover bundle, actual pbs-live workload cutover, and in-cluster Gateway/console-plugin smoke |

Diagnostic non-ready states:

| Command | Result | Meaning |
| --- | --- | --- |
| `npm run verify:pbs:preflight` | exit 0 with WARNs possible | Defaults to pbs-live render/config diagnostics unless strict flags and live prerequisites are present |
| `npm run verify:pbs:preflight:shadow` | exit 0 with WARNs possible | Explicit pbs-shadow render/config diagnostics for the shadow apply phase |
| `npm run verify:pbs:preflight:shadow:cluster` | nonzero until cluster prerequisites exist | Strict pbs-shadow applied-cluster acceptance gate |
| `npm run verify:pbs:live` | exit 0 SKIP possible | Skips when `CAS_PBS_BASE_URL` is unset; not release readiness |

## Release Boundary

CRC v0.1.4 dev deployment is verified, PBS-compatible local shadow storage is exercised, `F:\AI_Projects\PBS-Dev3` source/API contract shape is verified, and local `v0.1.4` release ImageStreamTags are bound to verified CRC runtime digest evidence. Production PBS live cutover is not complete until the external HTTPS/mTLS PBS runtime, live Secrets, live overlay, PBS egress policy, live DB credential rotation/fresh PVC decision, runtime/corpus readiness, and `npm run verify:release:pbs-live` success are present.

The current CRC cluster already passes the Gateway Kubernetes API egress check for SelfSubjectReview/OpenShift evidence through the CRC overlay. Non-CRC live clusters still need their own cluster-specific Kubernetes API egress, because standard Kubernetes NetworkPolicy cannot allow `kubernetes.default.svc` by Service name.

The pbs-live overlay enforces Gateway customer workspace ACL through `cas-knowledge-live-config/customer-access-json`. For production, use `render:pbs:live-prereqs` and the generated `test-results/pbs-live-prereqs/pbs-live-site` overlay so strict preflight renders the reviewed concrete customer/group mapping.

Operational checklist:

```text
deliverables/active/v0.1.4/production-live-cutover-checklist.md
```
