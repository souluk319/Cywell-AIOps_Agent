# Cywell v0.1.4 Phase 1 Execution Log

## Branch

- Created and switched to `v0.1.4`.

## Implemented Scope

- Added Cywell navigation section and route entries to the OpenShift Console plugin.
- Added `CywellKnowledgeRoute` as the v0.1.4 route shell for:
  - `/cywell/customer-data`
  - `/cywell/rag`
  - `/cywell/llm-wiki`
  - `/cywell/topology`
- Kept `/cywell/ai-sentinel` connected to the existing AI Sentinel static surface.
- Added CAS Gateway Knowledge facade module:
  - `/api/knowledge/healthz`
  - `/api/knowledge/capabilities`
  - pending responses for future PBS engine routes.
- Updated verification scripts to require Cywell nav/route registration instead of rejecting route UI.

## Verification

Executed:

```powershell
npm run verify
```

Result:

- `verify:contracts`: pass
- `verify:gateway`: pass
- `verify:gateway:brain`: pass
- `verify:openshift:evidence`: pass
- `verify:console-plugin`: pass
- `verify:console:integration`: pass
- `verify:crc:connection:preview`: pass
- `verify:deploy:manifests`: pass

## Deferred

- PBS Python service image and deployment.
- PostgreSQL/pgvector migration.
- Real upload and URL ingest.
- RAG query execution.
- LLM Wiki loop execution.
- Topology graph payload backed by PBS data.
