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
- PBS runtime transport must be HTTPS or equivalent service-mesh mTLS when bearer/service-token auth is used.
- PBS runtime pods labeled:
  - `app.kubernetes.io/name=playbookstudio`
  - `app.kubernetes.io/component=runtime`
- PBS runtime Service/label contract sample:
  - `deliverables/active/v0.1.4/pbs-runtime-service-contract.sample.yaml`
- Live PBS API base URL for smoke tests:
  - `CAS_PBS_BASE_URL=https://playbookstudio-runtime.playbookstudio.svc.cluster.local:8765`
- Local cutover smoke PBS auth material:
  - `CAS_PBS_BEARER_TOKEN`, `CAS_PBS_API_KEY`, or `CAS_PBS_BEARER_TOKEN_FILE`
- PBS bearer token material for:
  - `cas-pbs-auth/bearer-token`
- Gateway customer workspace ACL JSON for `cas-knowledge-live-config/customer-access-json`.
  - Production cutover must use a concrete mapping of OpenShift users/groups to customer IDs.
  - Wildcard, default, prefix, or suffix customer grants are rejected.
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

## Live Prerequisite Manifest Renderer

Render these with real values supplied from a secret manager or operator-approved handoff, review the diff, then apply after approval. Do not use one-shot `oc create secret` or `oc create configmap` for live cutover because those paths are easy to mistype and do not run the same input validation.

```powershell
$env:CAS_PBS_LIVE_NAMESPACE="cywell-ai-sentinel"
$env:CAS_PBS_BEARER_TOKEN_FILE="C:\secure-handoff\pbs-live-token.txt"
$env:CAS_KNOWLEDGE_SERVICE_OWNER="cas-pbs-live"
$env:CAS_KNOWLEDGE_CUSTOMER_ACCESS_FILE="C:\secure-handoff\customer-access.json"
$env:CAS_KNOWLEDGE_POSTGRES_DB="cas_knowledge_live"
$env:CAS_KNOWLEDGE_POSTGRES_USER="cas_knowledge_live"
$env:CAS_KNOWLEDGE_POSTGRES_PASSWORD="<from-secret-manager>"
$env:CAS_KNOWLEDGE_POSTGRES_DATABASE_URL="postgresql://cas_knowledge_live:<url-encoded-password>@cas-knowledge-postgres.cywell-ai-sentinel.svc.cluster.local:5432/cas_knowledge_live"

npm run render:pbs:live-prereqs

oc diff -f .\test-results\pbs-live-prereqs\cas-pbs-auth.secret.yaml
oc diff -f .\test-results\pbs-live-prereqs\cas-knowledge-postgres-live.secret.yaml
oc diff -f .\test-results\pbs-live-prereqs\cas-knowledge-live-config.configmap.yaml
oc diff -k .\test-results\pbs-live-prereqs\pbs-live-site

oc apply -f .\test-results\pbs-live-prereqs\cas-pbs-auth.secret.yaml
oc apply -f .\test-results\pbs-live-prereqs\cas-knowledge-postgres-live.secret.yaml
oc apply -f .\test-results\pbs-live-prereqs\cas-knowledge-live-config.configmap.yaml
```

If those Secrets or the ConfigMap already exist, compare keys and rotation plan before applying the reviewed manifests. The renderer also writes a site overlay to `test-results/pbs-live-prereqs/pbs-live-site`; use that overlay for preflight and live apply so the rendered `pbs-live` ConfigMap replacement is the same one you reviewed. The renderer writes a redacted summary to `test-results/pbs-live-prereqs/pbs-live-prereqs.summary.json`; verify hashes and metadata there, not raw Secret values.

Customer ACL example:

```json
{
  "groups": {
    "customer-a-ops": ["customer-a"],
    "customer-b-ops": ["customer-b"]
  },
  "users": {
    "alice@example.com": ["customer-a"]
  }
}
```

Do not proceed if the reviewed policy contains `default`, `*`, prefix/suffix wildcard entries, or placeholder customer IDs. The renderer and strict live preflight both require concrete customer IDs in every ACL entry.

## Pre-Apply Gates

Run these before applying live manifests:

```powershell
npm run verify
npm run verify:pbs:live-prereqs
npm run verify:deploy:manifests
npm run release:crc:v0.1.4
npm run verify:pbs:preflight:live:site:preapply
```

Required result:

- `verify` passes.
- `verify:pbs:live-prereqs` passes and writes `test-results/cas-pbs-live-prereqs-render.json`.
- `verify:deploy:manifests` passes.
- `release:crc:v0.1.4` passes if the target cluster expects local OpenShift ImageStreamTags. If `v0.1.4` tags already exist and must intentionally move, rerun as `CAS_RELEASE_FORCE=true npm run release:crc:v0.1.4` and capture the old/new image evidence.
- `verify:pbs:preflight:live:site:preapply` passes with no missing namespace, service, Secret, release image, Postgres image pinning, Kubernetes API egress, Postgres credential, or runtime readiness failures.
- `verify:pbs:preflight:live:site:preapply` confirms Gateway live customer ACL is enabled and sourced from `cas-knowledge-live-config/customer-access-json`.
- `verify:pbs:preflight:live:site:preapply` confirms release-image evidence is current-head and sourced from non-stale CRC deployment evidence.
- `verify:pbs:preflight:live:site:preapply` confirms the Gateway Kubernetes API NetworkPolicy allows the API IP and port in the same egress rule.
- `verify:pbs:preflight:live:site:preapply` confirms `playbookstudio-runtime` has ready Endpoints on port `8765` once the PBS namespace/service exists.
- `verify:pbs:preflight:live:site:preapply` confirms `cas-pbs-auth` and `cas-knowledge-postgres-live` contain usable non-placeholder values; the Postgres `database-url` credentials/database must match the individual Secret keys.

Stop immediately if any gate fails.

## Shadow Apply

Use shadow mode first if the target cluster has not previously run this PBS integration.

```powershell
oc apply -k deploy/kustomize/overlays/pbs-shadow
$env:CAS_PBS_BASE_URL="https://playbookstudio-runtime.playbookstudio.svc.cluster.local:8765"
npm run verify:pbs:preflight:shadow:cluster
npm run verify:pbs:live
```

Required result:

- `verify:pbs:preflight:shadow:cluster` renders `pbs-shadow` and checks the applied cluster prerequisites; do not substitute the default live preflight or the non-cluster shadow diagnostic for shadow acceptance.
- Knowledge Engine remains reachable through Gateway.
- Shadow health reports PBS runtime readiness.
- No broad NetworkPolicy peers are introduced.
- No write side effects are enabled unless explicitly approved with `CAS_PBS_SHADOW_WRITES=true`.

## Live Apply

Only proceed after shadow read smoke is accepted.

```powershell
oc apply -k .\test-results\pbs-live-prereqs\pbs-live-site
npm run verify:release:pbs-live
```

Required result:

- Applied workloads use `v0.1.4` release image tags.
- Postgres/pgvector uses the approved internal `cas-knowledge-postgres:v0.1.4` release image or an equivalent digest-pinned production image.
- Knowledge Engine provider is `pbs-http-live`.
- `CAS_PBS_BEARER_TOKEN` comes from required `cas-pbs-auth/bearer-token`.
- `DATABASE_URL` and Postgres credentials come from required `cas-knowledge-postgres-live`.
- `DATABASE_URL` targets the `cas-knowledge-postgres` Service DNS on port `5432`, not localhost or a pod-local endpoint.
- Decoded live Secret values are non-placeholder; `cas-knowledge-postgres-live/database-url` username, password, and database match `username`, `password`, and `database`.
- Legacy CRC dev Secret `cas-knowledge-postgres` is absent before live cutover.
- PBS egress policy is present and scoped exactly to DNS, Postgres, and labeled PBS runtime pods on port `8765`.
- Applied Gateway, Console Plugin, Knowledge Engine, and Postgres NetworkPolicy unions stay inside their allowlists; no extra applied policy can broaden access for those pods.
- PBS service-token auth uses HTTPS/mTLS transport; plain HTTP with bearer token is not accepted.
- Knowledge Engine applied env includes PBS config refs, required runtime/corpus readiness gates, HMAC Secret refs, and live Secret refs.
- Gateway applied env enables customer workspace ACL and reads `CAS_KNOWLEDGE_CUSTOMER_ACCESS_JSON` from `cas-knowledge-live-config/customer-access-json`.
- Applied ingress NetworkPolicy union for knowledge-engine pods allows only Gateway pods on TCP `8080`.
- Gateway rejects a valid owner requesting an unmapped customer with `403` before PBS, and rejects conflicting nested `source_metadata.customer_id` with `400` before PBS.
- Upload -> RAG -> wiki vault -> topology lineage passes through the Gateway with exact document/customer/source IDs and a direct topology document-note edge.
- Direct console-plugin pod access to `cas-knowledge-engine` remains blocked.

## Rollback Criteria

Rollback or stop the cutover if any of these occur:

- `verify:pbs:preflight:live:site` fails.
- `verify:pbs:cutover:cluster` fails.
- PBS health reports DB/vector/corpus readiness false.
- RAG answers lose uploaded document citations.
- RAG citations, wiki notes, or topology edges only match a smoke token/title but do not carry the exact uploaded document/customer/source IDs.
- Wiki vault or topology returns empty graph data for the cutover smoke customer.
- Gateway owner verification fails open or forwards user bearer tokens to Knowledge Engine.
- Gateway customer ACL fails open for an unmapped customer or lets conflicting nested customer metadata reach PBS.
- NetworkPolicy permits broad namespace, pod, or internet peers for Gateway, Console Plugin, Knowledge Engine, or Postgres.

## Evidence To Capture

Save command output or JSON artifacts for the release record:

- `git rev-parse HEAD`
- `npm run verify`
- `npm run verify:pbs:preflight:shadow:cluster` if shadow mode is applied
- `npm run verify:pbs:preflight:live:site`
- `npm run verify:release:pbs-live`
- `oc get deploy,statefulset,svc,networkpolicy,secret -n cywell-ai-sentinel`
- `oc get svc,pods -n playbookstudio --show-labels`
- `test-results/cas-pbs-preflight-pbs-shadow-applied-cluster-optional-secrets.json` if shadow mode is applied
- `test-results/cas-pbs-preflight-pbs-live-applied-cluster-required-secrets.json`
- `test-results/cas-pbs-live-smoke-cluster-cutover.json`
- `test-results/cas-release-images.json`
- `test-results/cas-pbs-live-prereqs-render.json`

## Completion Definition

Production live cutover is complete only when the live overlay is applied in the target cluster and both strict gates pass:

```powershell
npm run verify:pbs:preflight:live:site
npm run verify:release:pbs-live
```

Until then, v0.1.4 remains a verified CRC/dev integration with production live cutover gated by external PBS runtime and secret readiness.
