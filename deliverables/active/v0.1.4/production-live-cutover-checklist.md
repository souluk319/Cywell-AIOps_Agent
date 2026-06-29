# v0.1.4 Production PBS Live Cutover Checklist

This checklist is the release gate for moving from verified CRC/dev mode to a production PBS live deployment. Do not mark live cutover complete until every required item below is proven against the target cluster.

## Current Proven State

- `v0.1.4` branch is pushed to `origin/v0.1.4`.
- Draft PR: `https://github.com/souluk319/Cywell-AIOps_Agent/pull/1`.
- CRC/dev deployment passed with `cas-gateway:dev`, `cas-console-plugin:dev`, and `cas-knowledge-engine:dev`.
- Local verification passed:
  - `npm run verify`
  - `npm run verify:knowledge-engine`
  - `npm run verify:console:topology-dom`
  - `npm run verify:console:integration`
  - `npm run verify:deploy:manifests`
- Production PBS live cutover is not proven yet.

## Required External Inputs

These values must come from the target environment. Do not commit any secret values.

- Target cluster kube context and namespace access.
- PBS runtime namespace: `playbookstudio`.
- PBS runtime service: `playbookstudio-runtime.playbookstudio.svc.cluster.local:8765`.
- PBS runtime pods labeled:
  - `app.kubernetes.io/name=playbookstudio`
  - `app.kubernetes.io/component=runtime`
- Live PBS API base URL for smoke tests:
  - `CAS_PBS_BASE_URL=http://playbookstudio-runtime.playbookstudio.svc.cluster.local:8765`
- Local cutover smoke PBS auth material:
  - `CAS_PBS_BEARER_TOKEN`, `CAS_PBS_API_KEY`, or `CAS_PBS_BEARER_TOKEN_FILE`
- PBS bearer token material for:
  - `cas-pbs-auth/bearer-token`
- Live Postgres credentials for:
  - `cas-knowledge-postgres-live/database`
  - `cas-knowledge-postgres-live/username`
  - `cas-knowledge-postgres-live/password`
  - `cas-knowledge-postgres-live/database-url`
- Published release images tagged `v0.1.4` for:
  - `cas-gateway`
  - `cas-console-plugin`
  - `cas-knowledge-engine`
  - `cas-knowledge-postgres`
- Approved production Postgres/pgvector image pinned by digest or internal `v0.1.4` release tag. Do not use the mutable CRC/dev `pgvector/pgvector:pg16` image directly for live cutover.
- Decision on live DB handling:
  - rotate credentials on the existing PVC only if the initialized Postgres password and Secret match
  - otherwise use a fresh PVC or perform a planned DB migration
- Cluster-specific Gateway egress to Kubernetes API for SelfSubjectReview/OpenShift evidence. Standard NetworkPolicy cannot allow `kubernetes.default.svc` by Service name.

## Secret Creation Template

Run these in the target cluster with real values supplied from a secret manager or operator-approved handoff.

```powershell
oc create secret generic cas-pbs-auth `
  -n cywell-ai-sentinel `
  --from-literal=bearer-token="$env:CAS_PBS_BEARER_TOKEN"

oc create secret generic cas-knowledge-postgres-live `
  -n cywell-ai-sentinel `
  --from-literal=database="$env:CAS_KNOWLEDGE_POSTGRES_DB" `
  --from-literal=username="$env:CAS_KNOWLEDGE_POSTGRES_USER" `
  --from-literal=password="$env:CAS_KNOWLEDGE_POSTGRES_PASSWORD" `
  --from-literal=database-url="$env:CAS_KNOWLEDGE_POSTGRES_DATABASE_URL"
```

If those Secrets already exist, compare keys and rotation plan before replacing them.

## Pre-Apply Gates

Run these before applying live manifests:

```powershell
npm run verify
npm run verify:deploy:manifests
npm run release:crc:v0.1.4
npm run verify:pbs:preflight:live:preapply
```

Required result:

- `verify` passes.
- `verify:deploy:manifests` passes.
- `release:crc:v0.1.4` passes if the target cluster expects local OpenShift ImageStreamTags.
- `verify:pbs:preflight:live:preapply` passes with no missing namespace, service, Secret, release image, Postgres image pinning, Kubernetes API egress, Postgres credential, or runtime readiness failures.

Stop immediately if any gate fails.

## Shadow Apply

Use shadow mode first if the target cluster has not previously run this PBS integration.

```powershell
oc apply -k deploy/kustomize/overlays/pbs-shadow
$env:CAS_PBS_BASE_URL="http://playbookstudio-runtime.playbookstudio.svc.cluster.local:8765"
npm run verify:pbs:preflight:shadow
npm run verify:pbs:live
```

Required result:

- `verify:pbs:preflight:shadow` renders `pbs-shadow`; do not substitute the default live preflight for shadow acceptance.
- Knowledge Engine remains reachable through Gateway.
- Shadow health reports PBS runtime readiness.
- No broad NetworkPolicy peers are introduced.
- No write side effects are enabled unless explicitly approved with `CAS_PBS_SHADOW_WRITES=true`.

## Live Apply

Only proceed after shadow read smoke is accepted.

```powershell
oc apply -k deploy/kustomize/overlays/pbs-live
npm run verify:pbs:preflight:live
npm run verify:pbs:cutover:cluster
```

Required result:

- Applied workloads use `v0.1.4` release image tags.
- Postgres/pgvector uses the approved internal `cas-knowledge-postgres:v0.1.4` release image or an equivalent digest-pinned production image.
- Knowledge Engine provider is `pbs-http-live`.
- `CAS_PBS_BEARER_TOKEN` comes from required `cas-pbs-auth/bearer-token`.
- `DATABASE_URL` and Postgres credentials come from required `cas-knowledge-postgres-live`.
- `DATABASE_URL` targets the `cas-knowledge-postgres` Service DNS on port `5432`, not localhost or a pod-local endpoint.
- Legacy CRC dev Secret `cas-knowledge-postgres` is absent before live cutover.
- PBS egress policy is present and scoped exactly to DNS, Postgres, and labeled PBS runtime pods on port `8765`.
- Knowledge Engine applied env includes PBS config refs, required runtime/corpus readiness gates, HMAC Secret refs, and live Secret refs.
- Upload -> RAG -> wiki vault -> topology lineage passes through the Gateway.
- Direct console-plugin pod access to `cas-knowledge-engine` remains blocked.

## Rollback Criteria

Rollback or stop the cutover if any of these occur:

- `verify:pbs:preflight:live` fails.
- `verify:pbs:cutover:cluster` fails.
- PBS health reports DB/vector/corpus readiness false.
- RAG answers lose uploaded document citations.
- Wiki vault or topology returns empty graph data for the cutover smoke customer.
- Gateway owner verification fails open or forwards user bearer tokens to Knowledge Engine.
- NetworkPolicy permits broad namespace, pod, or internet peers for Gateway, Console Plugin, Knowledge Engine, or Postgres.

## Evidence To Capture

Save command output or JSON artifacts for the release record:

- `git rev-parse HEAD`
- `npm run verify`
- `npm run verify:pbs:preflight:shadow` if shadow mode is applied
- `npm run verify:pbs:preflight:live`
- `npm run verify:pbs:cutover:cluster`
- `oc get deploy,statefulset,svc,networkpolicy,secret -n cywell-ai-sentinel`
- `oc get svc,pods -n playbookstudio --show-labels`
- `test-results/cas-pbs-preflight.json`
- `test-results/cas-pbs-live-smoke.json`
- `test-results/cas-release-images.json`

## Completion Definition

Production live cutover is complete only when the live overlay is applied in the target cluster and both strict gates pass:

```powershell
npm run verify:pbs:preflight:live
npm run verify:pbs:cutover:cluster
```

Until then, v0.1.4 remains a verified CRC/dev integration with production live cutover gated by external PBS runtime and secret readiness.
