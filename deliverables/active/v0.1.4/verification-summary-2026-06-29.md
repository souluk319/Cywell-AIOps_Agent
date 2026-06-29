# v0.1.4 Verification Summary - 2026-06-29

## Scope

This summary captures the current v0.1.4 branch verification state for the Cywell PBS/customer-data/RAG/LLM Wiki/topology integration.

## Passing Verification Gates

| Command | Result | Notes |
| --- | --- | --- |
| `npm run verify` | PASS | Full local gate including contracts, gateway, knowledge engine, brain, OpenShift evidence, console build, browser topology DOM, console integration, CRC connection preview, and manifest verification |
| `npm run verify:knowledge-engine` | PASS, 78 checks | Includes Gateway owner verification, signed internal owner headers, ConfigMap-driven customer workspace ACL behavior, internal bearer/header stripping, public health/capabilities sanitization, unsafe upload/URL ingest rejection, local Wiki Vault signal extraction, RAG citations from vault-only context, PBS shadow/live adapter contracts, PBS live response scope mismatch rejection, rich PBS topology signal preservation, topology provenance, orphan endpoint topology normalization, and single-candidate PBS graph normalization |
| `npm run verify:console:topology-dom` | PASS, 31 checks | Browser-required smoke with topology auto-load, empty/error reload stale-data protection, PBS-rich KPI/tone/signal-leader/link-filter rendering, filter-scoped node index, orphan edge fallback nodes, mixed-scope graph selection, late-response stale-data protection, dense 28-node searchable index, and 1024px/390px overflow/overlap checks |
| `npm run verify:console:integration` | PASS, 71 checks | Includes static app `innerHTML` rejection, structural `/cywell/topology` manifest routing/navigation, topology auto-load, PBS topology signal fields/counts, Signal leaders, and built plugin route/bundle checks |
| `npm run verify:deploy:manifests` | PASS, 257 checks | Includes base/shadow/live/CRC render checks, HMAC Secret refs, no tracked dev DB Secret, pbs-live Gateway customer ACL config, pbs-live Postgres release image pinning, PBS-compatible local schema checks, release image promotion force/evidence binding coverage, explicit strict shadow preflight script coverage, HTTPS PBS service-token transport, PBS live response scope guard coverage, and direct console script build prerequisites |

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
- Gateway can require customer workspace ACL before private knowledge proxying; live mode reads `CAS_KNOWLEDGE_CUSTOMER_ACCESS_JSON` from `cas-knowledge-live-config/customer-access-json`, rejects unmapped customers with `403`, and rejects conflicting nested `source_metadata.customer_id` with `400`.
- Strict live preflight checks the live customer ACL env wiring, rejects wildcard customer ACL placeholders, confirms applied live ConfigMap values, compares ready pod digests to promoted release evidence, and confirms all applied ingress/egress NetworkPolicies selecting knowledge-engine pods stay scoped.
- PBS live release smoke no longer permits read-only exception bypass for cutover/release checks, and direct-engine block verification requires an actual in-cluster blocked result instead of accepting any non-200 response.
- Preflight and live-smoke evidence artifacts are mode-specific, so shadow, live preapply, live applied, local cutover, and cluster cutover runs do not overwrite each other.
- Local Postgres now creates PBS-compatible `tenants`, `workspaces`, `document_sources`, `parsed_documents`, `document_chunks`, `chunk_embeddings`, and graph tables; CAS ingest writes PBS-compatible document/chunk shadow rows, deterministic local hash embeddings, and customer-scoped graph entity/mention/relation rows. These rows prove CRC schema/lineage compatibility, not PBS production embedding model parity.
- PBS Wiki Vault topology normalization now preserves PBS summary aliases, wikilinks, tags, entity/concept nodes, degree/weight, source/viewer fields, selected context/uploads, and relation signals.
- The Cywell topology dashboard renders PBS-rich graph semantics as KPIs, node tones, type filters, Signal leaders, inspector metadata, relation lines, and node-to-RAG actions in the browser-backed release gate.
- CRC release promotion is now bound to current-HEAD `test-results/cas-crc-deployment.json`; app release sources must match verified runtime digest evidence before `v0.1.4` tags move, Postgres records both the verified external runtime digest and promoted internal ImageStream digest, and strict live preflight compares applied release tags to `test-results/cas-release-images.json`.
- Local Wiki Vault now extracts `[[wikilinks]]`, `#tags`, URLs, concepts, relations, backlinks, selected context/uploads, and can feed RAG citations from wiki-only context.

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
| `CAS_RELEASE_FORCE=true npm run release:crc:v0.1.4` | PASS after current deployment evidence is regenerated | Mutating release action; refuses stale/wrong-HEAD deployment evidence, verifies app release sources against runtime evidence, records `promotedImages`, and force-promotes `cas-gateway`, `cas-console-plugin`, `cas-knowledge-engine`, and digest-pinned `cas-knowledge-postgres` to local `v0.1.4` ImageStreamTags |
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
```

## Expected Failing Live Cutover Gates

| Command | Result | Blocking Reason |
| --- | --- | --- |
| `npm run verify:pbs:cutover` | FAIL expected | `CAS_PBS_BASE_URL` is not configured in the local shell |
| `npm run verify:pbs:preflight:live:preapply` | FAIL expected, 42 PASS / 8 FAIL | Render/config/egress/API/release-image checks pass; service-token transport is HTTPS, pbs-live Gateway customer ACL is wired to the live ConfigMap, `v0.1.4` release ImageStreamTags resolve to promoted digests, and pbs-live Postgres image pinning passes. Current CRC still has no `playbookstudio` namespace/service, no `cas-pbs-auth`, no `cas-knowledge-postgres-live`, still has the legacy `cas-knowledge-postgres` dev Secret, and must replace the rendered wildcard customer ACL placeholder before cutover |
| `npm run verify:release:pbs-live` | FAIL expected | Same live prerequisites as pre-apply plus actual pbs-live workload cutover and in-cluster Gateway/console-plugin smoke are not present yet |

Diagnostic non-ready states:

| Command | Result | Meaning |
| --- | --- | --- |
| `npm run verify:pbs:preflight` | exit 0 with WARNs possible | Defaults to pbs-live render/config diagnostics unless strict flags and live prerequisites are present |
| `npm run verify:pbs:preflight:shadow` | exit 0 with WARNs possible | Explicit pbs-shadow render/config diagnostics for the shadow apply phase |
| `npm run verify:pbs:preflight:shadow:cluster` | nonzero until cluster prerequisites exist | Strict pbs-shadow applied-cluster acceptance gate |
| `npm run verify:pbs:live` | exit 0 SKIP possible | Skips when `CAS_PBS_BASE_URL` is unset; not release readiness |

## Release Boundary

CRC v0.1.4 dev deployment is verified, PBS-compatible local shadow storage is exercised, and local `v0.1.4` release ImageStreamTags are bound to verified CRC runtime digest evidence. Production PBS live cutover is not complete until the external HTTPS/mTLS PBS runtime, live Secrets, live overlay, PBS egress policy, live DB credential rotation/fresh PVC decision, runtime/corpus readiness, and `npm run verify:release:pbs-live` success are present.

The current CRC cluster already passes the Gateway Kubernetes API egress check for SelfSubjectReview/OpenShift evidence through the CRC overlay. Non-CRC live clusters still need their own cluster-specific Kubernetes API egress, because standard Kubernetes NetworkPolicy cannot allow `kubernetes.default.svc` by Service name.

The pbs-live overlay enforces Gateway customer workspace ACL through `cas-knowledge-live-config/customer-access-json`. The default rendered value is an admin-all placeholder for `cywell-knowledge-admins`; production cutover must replace or review it with the real customer/group mapping before live apply.

Operational checklist:

```text
deliverables/active/v0.1.4/production-live-cutover-checklist.md
```
