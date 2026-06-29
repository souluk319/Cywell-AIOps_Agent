# v0.1.4 Verification Summary - 2026-06-29

## Scope

This summary captures the current v0.1.4 branch verification state for the Cywell PBS/customer-data/RAG/LLM Wiki/topology integration.

## Passing Verification Gates

| Command | Result | Notes |
| --- | --- | --- |
| `npm run verify` | PASS | Full local gate including contracts, gateway, knowledge engine, brain, OpenShift evidence, console build, browser topology DOM, console integration, CRC connection preview, and manifest verification |
| `npm run verify:knowledge-engine` | PASS, 64 checks | Includes Gateway owner verification, signed internal owner headers, internal bearer/header stripping, public health/capabilities sanitization, PBS shadow/live adapter contracts, topology provenance |
| `npm run verify:console:topology-dom` | PASS, 23 checks | Browser-required smoke with topology auto-load, empty/error reload stale-data protection, filter-scoped node index, dense 28-node searchable index, and 1024px/390px overflow/overlap checks |
| `npm run verify:console:integration` | PASS, 68 checks | Includes static app `innerHTML` rejection, structural `/cywell/topology` manifest routing/navigation, topology auto-load, and built plugin route/bundle checks |
| `npm run verify:deploy:manifests` | PASS, 221 checks | Includes base/shadow/live/CRC render checks, HMAC Secret refs, no tracked dev DB Secret, pbs-live Postgres release image pinning, release image promotion script coverage, and direct console script build prerequisites |

Current hardening additions after the initial summary:

- Tracked base manifests no longer contain a literal dev Postgres password or database URL.
- `deploy:crc` creates local-only random dev Postgres and internal owner-HMAC Secrets when missing.
- Gateway signs derived owner headers; Knowledge Engine rejects unsigned owner headers when HMAC is configured.
- Gateway and Knowledge Engine fail closed if the internal owner-HMAC Secret is missing.
- Public Gateway `/healthz`, `/api/aiops/healthz`, `/api/knowledge/healthz`, and `/api/knowledge/capabilities` omit provider and owner identity internals.
- PBS live preflight checks the live `DATABASE_URL` over TCP through the Postgres service.
- Base manifests verify OpenShift API TLS with the mounted namespace CA instead of disabling TLS verification.
- CRC-specific Kubernetes API egress and lab Lightspeed ingress are owned by the CRC overlay, not the base render.
- `release:crc:v0.1.4` promotes CRC `:dev` app images plus the running Postgres digest into `v0.1.4` ImageStreamTags.
- pbs-live Postgres now renders as `image-registry.openshift-image-registry.svc:5000/cywell-ai-sentinel/cas-knowledge-postgres:v0.1.4`.

Clean checkout reproduction:

```text
C:\Users\soulu\AppData\Local\Temp\cywell-v014-clean-20260629100550
npm ci: PASS
npm run verify: PASS
```

## Last-Known CRC Deployment Evidence

| Command | Result | Notes |
| --- | --- | --- |
| `npm run deploy:crc` | PASS, 62 runtime checks | Mutating deploy action; rebuilt and deployed `cas-gateway:dev`, `cas-console-plugin:dev`, and `cas-knowledge-engine:dev` to CRC, created/preserved local Secrets, applied CRC-only API/Lightspeed policies, and reran CRC deployment verification |
| `npm run release:crc:v0.1.4` | PASS, 12 release checks | Mutating release action; promoted `cas-gateway`, `cas-console-plugin`, `cas-knowledge-engine`, and digest-pinned `cas-knowledge-postgres` to local `v0.1.4` ImageStreamTags |

Local JSON evidence was written under ignored `test-results/`:

```text
test-results/cas-crc-connection.json
test-results/cas-crc-deployment.json
test-results/cas-deploy-manifests.json
test-results/cas-release-images.json
test-results/cas-pbs-live-smoke.json
test-results/cas-pbs-preflight.json
```

## Expected Failing Live Cutover Gates

| Command | Result | Blocking Reason |
| --- | --- | --- |
| `npm run verify:pbs:cutover` | FAIL expected | `CAS_PBS_BASE_URL` is not configured in the local shell |
| `npm run verify:pbs:preflight:live:preapply` | FAIL expected, 29 PASS / 7 FAIL | Render/config/egress/API checks pass; `v0.1.4` release ImageStreamTags and pbs-live Postgres image pinning now pass. Current CRC still has no `playbookstudio` namespace/service, no `cas-pbs-auth`, no `cas-knowledge-postgres-live`, and still has the legacy `cas-knowledge-postgres` dev Secret |
| `npm run verify:pbs:cutover:cluster` | FAIL expected | Same live prerequisites as pre-apply plus actual pbs-live workload cutover and in-cluster Gateway/console-plugin smoke are not present yet |

Diagnostic non-ready states:

| Command | Result | Meaning |
| --- | --- | --- |
| `npm run verify:pbs:preflight` | exit 0 with WARNs possible | Render/config diagnostics only unless strict flags and live prerequisites are present |
| `npm run verify:pbs:live` | exit 0 SKIP possible | Skips when `CAS_PBS_BASE_URL` is unset; not release readiness |

## Release Boundary

CRC v0.1.4 dev deployment is verified and local `v0.1.4` release ImageStreamTags exist. Production PBS live cutover is not complete until the external PBS runtime, live Secrets, live overlay, PBS egress policy, live DB credential rotation/fresh PVC decision, and runtime/corpus readiness are present.

The current CRC cluster already passes the Gateway Kubernetes API egress check for SelfSubjectReview/OpenShift evidence through the CRC overlay. Non-CRC live clusters still need their own cluster-specific Kubernetes API egress, because standard Kubernetes NetworkPolicy cannot allow `kubernetes.default.svc` by Service name.

Operational checklist:

```text
deliverables/active/v0.1.4/production-live-cutover-checklist.md
```
