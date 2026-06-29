# v0.1.4 Verification Summary - 2026-06-29

## Scope

This summary captures the current v0.1.4 branch verification state for the Cywell PBS/customer-data/RAG/LLM Wiki/topology integration.

## Passing Gates

| Command | Result | Notes |
| --- | --- | --- |
| `npm run verify` | PASS | Full local gate including contracts, gateway, knowledge engine, brain, OpenShift evidence, console build, browser topology DOM, console integration, CRC connection preview, and manifest verification |
| `npm run verify:knowledge-engine` | PASS, 61 checks | Includes Gateway owner verification, internal bearer/header stripping, public capabilities error sanitization, PBS shadow/live adapter contracts, topology provenance |
| `npm run verify:console:topology-dom` | PASS, 19 checks | Browser-required smoke with 1024px and 390px overflow/overlap checks and dense 28-node fixture |
| `npm run verify:console:integration` | PASS, 63 checks | Includes static app `innerHTML` rejection and built plugin route/bundle checks |
| `npm run deploy:crc` | PASS | Rebuilt and deployed `cas-gateway:dev`, `cas-console-plugin:dev`, and `cas-knowledge-engine:dev` to CRC |

Local JSON evidence was written under ignored `test-results/`:

```text
test-results/cas-crc-connection.json
test-results/cas-crc-deployment.json
test-results/cas-deploy-manifests.json
test-results/cas-pbs-live-smoke.json
test-results/cas-pbs-preflight.json
```

## Expected Failing Live Cutover Gates

| Command | Result | Blocking Reason |
| --- | --- | --- |
| `npm run verify:pbs:cutover` | FAIL expected | `CAS_PBS_BASE_URL` is not configured in the local shell |
| `npm run verify:pbs:cutover:cluster` | FAIL expected | Current CRC has no `playbookstudio` namespace/service, no `cas-pbs-auth`, no `cas-knowledge-postgres-live`, still runs base `:dev` images/provider, has legacy `cas-knowledge-postgres` dev Secret, and has not applied `cas-knowledge-engine-pbs-egress` |

## Release Boundary

CRC v0.1.4 dev deployment is verified. Production PBS live cutover is not complete until the external PBS runtime, live Secrets, release image tags, live overlay, PBS egress policy, and runtime/corpus readiness are present.

Non-CRC live clusters also need cluster-specific Kubernetes API egress for Gateway SelfSubjectReview/OpenShift evidence. Standard Kubernetes NetworkPolicy cannot allow `kubernetes.default.svc` by Service name.
