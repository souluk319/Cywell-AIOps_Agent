# Cywell v0.1.4 PBS Engine Integration Plan

## Objective

PlayBookStudio(PBS-Dev3)의 사용자 업로드, URL ingest, RAG, LLM Wiki, Wiki Vault, Topology 기능을 Cywell AI Sentinel(CAS)의 하위 메뉴와 서비스 구조로 편입한다.

최종 목표는 CAS에서 고객 데이터를 추가하면 PBS 엔진이 문서/URL을 적재하고, pgvector 기반 RAG와 LLM Wiki loop가 계속 지식을 갱신하며, Wiki Vault와 Topology Dashboard가 고객별 운영 지식 그래프를 보여주는 구조다.

## Source Inventory

PBS-Dev3에서 가져올 핵심 모듈은 다음으로 본다.

| 기능 | PBS-Dev3 위치 | CAS 편입 대상 |
| --- | --- | --- |
| 파일 업로드/문서 적재 | `src/play_book_studio/http/upload_api.py` | `cas-knowledge-engine` ingest API |
| URL ingest | `src/play_book_studio/http/url_ingest_api.py` | `cas-knowledge-engine` URL ingest API |
| RAG retrieval | `src/play_book_studio/retrieval/*` | `cas-knowledge-engine` retrieval pipeline |
| embedding/indexing | `src/play_book_studio/db/embedding_indexer.py` | pgvector indexing worker |
| document repository | `src/play_book_studio/db/document_repository.py` | customer document store |
| graph/topology | `src/play_book_studio/db/graph_repository.py`, `src/play_book_studio/http/wiki_vault.py` | topology payload API |
| LLM Wiki loop | `src/play_book_studio/wiki_loop.py` | scheduled/on-demand wiki compiler |
| RAG chat | `src/play_book_studio/http/server_chat.py` | CAS RAG chat endpoint |
| UI surfaces | `apps/web/src/pages/WorkspacePage.tsx`, `LlmWikiBookPage.tsx`, `PlaybookLibraryPage.tsx` | CAS console routes under Cywell |

현재 `F:\AI_Projects\PBS-Dev3` 워킹트리는 수정/삭제/신규 파일이 많이 섞여 있다. 따라서 그대로 복사하지 않고, 먼저 스냅샷을 고정한 뒤 모듈 단위로 편입한다.

## Target Architecture

### Console Plugin

`cas-console-plugin`은 OpenShift Console dynamic plugin으로 Cywell 메뉴를 제공한다.

- `Cywell`
- `Cywell > AI Sentinel`
- `Cywell > 고객 데이터`
- `Cywell > RAG`
- `Cywell > LLM Wiki`
- `Cywell > Topology`

각 메뉴는 `console.navigation/section`, `console.navigation/href`, `console.page/route` extension으로 등록한다.

### Gateway

`cas-gateway`는 기존 `/api/aiops/*`를 유지하고, PBS 엔진을 향한 facade를 추가한다.

- `/api/knowledge/healthz`
- `/api/knowledge/capabilities`
- `/api/knowledge/uploads/ingest`
- `/api/knowledge/uploads/url-ingest`
- `/api/knowledge/rag/query`
- `/api/knowledge/wiki-loop/run`
- `/api/knowledge/wiki-vault`
- `/api/knowledge/topology`

초기에는 엔진 미연결 상태를 명시적으로 반환하고, 이후 `cas-knowledge-engine`으로 프록시한다.

### Knowledge Engine

PBS Python 코드는 Node gateway 안에 섞지 않고 별도 서비스로 둔다.

- Deployment: `cas-knowledge-engine`
- Runtime: Python 3.11+
- Storage: PostgreSQL + pgvector
- File storage: PVC 또는 object storage
- API: PBS upload/url ingest/RAG/wiki/topology endpoint를 CAS customer/workspace scope에 맞춰 노출

### Data Flow

1. 운영자가 CAS Console에서 고객 데이터 업로드 또는 URL ingest를 실행한다.
2. Console Plugin이 CAS Gateway의 `/api/knowledge/*`로 요청한다.
3. Gateway가 UserToken, customer scope, request metadata를 정규화한다.
4. Knowledge Engine이 PBS ingest pipeline을 실행한다.
5. 문서 chunk와 embedding이 pgvector에 적재된다.
6. RAG query가 고객 데이터 scope 안에서 검색된다.
7. Wiki loop가 답변/문서/그래프 정보를 Wiki note로 계속 컴파일한다.
8. Wiki Vault와 Topology Dashboard가 갱신된 관계/노트를 표시한다.

## Phases

### Phase 1 - v0.1.4 first scope

이번 턴의 실행 범위다.

- `v0.1.4` 브랜치 생성
- `deliverables/active/v0.1.4` 산출물 폴더 생성
- PBS 기능 편입 플랜 저장
- Cywell 메뉴와 route shell 추가
- CAS Gateway에 Knowledge facade 상태 API 추가
- 검증 스크립트를 새 route/nav 목표에 맞게 수정

완료 기준:

- console plugin build 성공
- console manifest에 Cywell nav/route extension 포함
- Gateway mock/brain/evidence 검증 영향 없음
- `/api/knowledge/healthz` facade 검증 가능

### Phase 2 - Knowledge Engine skeleton

- `apps/knowledge-engine` 또는 `services/knowledge-engine` Python 서비스 생성
- PBS runtime 의존성 정리
- `/healthz`, `/capabilities` 구현
- OpenShift Deployment/Service/NetworkPolicy 추가
- Gateway에서 engine URL 프록시 연결

Status: implemented and deployed to CRC.

Current implementation:

- `apps/knowledge-engine` Python service
- Gateway `/api/knowledge/*` proxy
- OpenShift Deployment/Service/PVC
- CRC BuildConfig/ImageStream
- owner-scope aware API contract

### Phase 2.5 - Storage and Provider Boundary

Status: implemented for the v0.1.4 smoke path.

- `JsonKnowledgeStore` and `PostgresKnowledgeStore` storage boundary added.
- `CAS_KNOWLEDGE_PROVIDER` is explicit.
- Provider modes are implemented:
  - `pbs-compatible-local`: current CRC default and stable local smoke path
  - `pbs-http-shadow`: local response stays source of truth while PBS calls are traced
  - `pbs-http-live`: PBS HTTP response is source of truth and normalized into CAS API shapes
- PBS HTTP adapter maps CAS routes to PBS:
  - `/api/uploads/ingest`
  - `/api/uploads/url-ingest`
  - `/api/uploads/reports`
  - `/api/chat`
  - `/api/wiki-loop/run`
  - `/api/wiki-loop/status`
  - `/api/wiki-vault`
  - `/api/wiki-vault/notes`
- Shadow writes are disabled by default unless `CAS_PBS_SHADOW_WRITES=true`, to avoid duplicate PBS-side write effects.
- PBS runtime inspection confirmed the backend API surface runs on port `8765` with `GET /api/health`; the public web/nginx surface normally runs on port `8080` and proxies `/api/*`.
- `CAS_KNOWLEDGE_OWNER_MODE=trusted-header` and `CAS_KNOWLEDGE_SINGLE_OWNER` are explicit.
- Gateway derives a stable owner hint from UserToken/Authorization and does not trust forwarded owner headers by default.
- Knowledge Engine scoped APIs require a trusted owner header in the base deployment.
- Gateway and knowledge engine request body limits are explicit.
- CRC runtime uses PostgreSQL with `pgcrypto` and `pgvector`.
- CRC verifier directly checks:
  - `pgcrypto` extension
  - `vector` extension
  - CAS knowledge tables
  - `vector(768)` readiness column
  - smoke upload persisted in owner scope

Important: this is still not full PBS corpus/index parity. The CRC/local Postgres path now creates PBS-compatible `document_sources`, `parsed_documents`, `document_chunks`, `chunk_embeddings`, and graph tables, and CAS ingest writes document source, parsed document, and chunk shadow rows. It still does not fabricate embeddings or prove PBS indexer/model parity against a production PBS database.

### Phase 3 - Customer Data Ingest

- PBS `upload_api.py`, `url_ingest_api.py` 편입
- upload storage/PVC 설계
- ingest report API 연결
- 고객별 workspace/source scope 적용
- upload limit, MIME policy, SSRF guard 적용

Status: partially implemented.

Delivered:

- text upload
- local file upload through base64 payloads
- PBS-compatible ingest metadata contract:
  - `file_name`
  - `created_by`
  - `source_scope`
  - `visibility`
  - `source_kind`
  - `source_metadata.customer_id`
  - `force_reingest`
  - `index`
- MIME metadata capture
- lightweight text extraction for text, DOCX, PPTX, XLSX, and PDF payloads
- guarded URL ingest
- unsafe upload extension/MIME rejection, strict base64 validation, decoded-size cap, and OOXML zip entry/size caps
- URL ingest rejects private/loopback/unresolved targets, URL credentials, and redirects in the local guarded ingest path
- URL ingest PBS-compatible metadata including `auto_compile_wiki`
- upload report list
- customer_id scope
- owner_id scope in the engine contract
- Gateway-verified OpenShift/Kubernetes SelfSubjectReview owner scope

Not yet PBS parity:

- exact PBS parser/indexer parity
- OCR/vision asset pipeline
- duplicate/delete workflow
- streamed ingest progress
- PBS upload report schema

### Phase 4 - RAG

- pgvector migration 적용
- embedding/indexer 실행 경로 정리
- RAG query endpoint 연결
- CAS UI의 고객 데이터 scope selector 추가
- 답변 trace와 source citation 표시

Status: smoke path implemented, full PBS RAG not implemented.

Delivered:

- `/api/knowledge/rag/query`
- owner/customer scoped query
- citation-bearing keyword retrieval
- topology node to RAG action in the console UI
- PBS live chat adapter normalization into CAS `answer`, `citations`, and `trace` shape

Not yet PBS parity:

- embedding generation
- pgvector search
- BM25/vector fusion
- reranker
- PBS chat/session context
- LLM answerer
- PBS citation/audit schema

### Phase 5 - LLM Wiki and Topology

- `wiki_loop.py` 편입
- Wiki Vault overlay CRUD 연결
- topology graph payload API 연결
- LLMWikiBook/PlaybookLibrary UI를 CAS console view로 재구성
- answer-to-wiki save flow 연결

Status: v0.1.4 smoke path and visual topology dashboard implemented.

Delivered:

- wiki loop run endpoint
- manual wiki note save endpoint
- wiki vault endpoint
- topology endpoint
- Cywell Topology dashboard with:
  - KPI stats strip
  - node type segmented filter
  - PBS Wiki Vault `graph.nodes/graph.edges`, nested `topology.graph`, `links`/`relations`/`relationships`, and `node_id`/`source_id`/`target_id` payload support
  - degree-ranked graph canvas
  - SVG relation lines
  - selectable nodes
  - node inspector
  - relation grid
  - direct RAG action from selected node
  - graph integrity checks so returned edges must point at returned nodes

Not yet PBS parity:

- PBS compiled wiki note taxonomy
- markdown vault export/prune loop
- graph extraction/backfill
- entity/relation repository
- PBS wiki overlay semantics
- PBS vault payload fidelity

### Phase 6 - OpenShift hardening

- tenant/customer isolation 검증
- RBAC와 UserToken propagation 정리
- NetworkPolicy와 secret/env 분리
- backup/restore, migration rollback 계획
- smoke/e2e 시나리오 작성

Status: CRC/dev hardening implemented; production hardening remains.

Delivered:

- gateway egress to knowledge engine
- knowledge-engine ingress limited to gateway pods on TCP `8080`
- Postgres ingress limited to knowledge engine
- anyuid SCC binding for CRC pgvector image
- PBS shadow/live kustomize overlays:
  - `deploy/kustomize/overlays/pbs-shadow`
  - `deploy/kustomize/overlays/pbs-live`
  - stable `cas-pbs-config` ConfigMap for base URL/auth mode/timeouts/response limits/TLS flag
  - optional `cas-pbs-auth` Secret reference for `CAS_PBS_BEARER_TOKEN` in shadow mode
  - required `cas-pbs-auth/bearer-token` Secret reference for `CAS_PBS_BEARER_TOKEN` in live mode
  - live required `cas-knowledge-postgres-live` Secret references for Knowledge Engine and Postgres credentials
  - live `cas-knowledge-live-config/service-owner` instead of inherited CRC owner defaults
  - live `cas-knowledge-live-config/customer-access-json` drives Gateway customer workspace ACL
  - live render removes inherited dev Postgres Secret material and uses `v0.1.4` release image tags instead of `:dev`
  - knowledge-engine egress limited to DNS, Postgres, and labeled PBS runtime pods on namespace `playbookstudio`, port `8765`
  - PBS service-token transport defaults to HTTPS, and the PBS client fails closed for missing token material or non-local HTTP token transport unless explicitly overridden for a lab
  - live mode requires PBS runtime readiness through `CAS_PBS_REQUIRE_RUNTIME_READY=true`
  - live mode requires PBS corpus/index readiness through `CAS_PBS_REQUIRE_CORPUS_READY=true` and `CAS_PBS_REQUIRED_READY_SCOPES=official_docs,study_docs`
- v0.1.3 operator paused during dev deployment
- UserToken verified through Gateway SelfSubjectReview for trusted-header owner mode
- verifier checks operator pause, runtime pods, pgvector readiness, live console bundle, upload/RAG/wiki/topology smoke, Lightspeed flow, and rendered PBS shadow/live overlay shape
- verifier checks local PBS-compatible Postgres schema creation and verifies smoke uploads write PBS-compatible document source, parsed document, and chunk shadow rows
- verifier records app `:dev` ImageStreamTag digests and running Postgres imageID digest as release-source evidence
- CRC verifier checks the live `cas-knowledge-engine-ingress` policy and confirms non-gateway direct access is blocked from the console-plugin pod
- optional `npm run verify:pbs:live` smoke script for a real PBS target; it skips cleanly when `CAS_PBS_BASE_URL` is not set
- `npm run verify:pbs:preflight` renders the PBS live/shadow overlay and checks config, Secret refs, egress, ingress, runtime service shape, and live readiness gates before a cluster cutover
- `npm run verify:pbs:preflight:live` is the strict cutover preflight and fails unless the real PBS namespace/service and required Secrets exist
- `npm run verify:release:pbs-live` is the non-skipping release gate and runs strict live preflight plus in-cluster cutover smoke
- `npm run verify:pbs:cutover` is a local write smoke gate and fails unless `CAS_PBS_BASE_URL` and PBS auth material are configured
- live PBS route failures propagate as non-2xx CAS HTTP status with PBS trace evidence
- Gateway can require a ConfigMap-backed customer workspace ACL before proxying private knowledge requests; live mode enables this and verifies mismatched nested `source_metadata.customer_id` is rejected before reaching Knowledge Engine
- strict PBS preflight checks that all applied ingress NetworkPolicies selecting knowledge-engine pods only allow Gateway pods on TCP `8080`
- `deploy:crc` starts OpenShift binary builds without `--follow --wait`, follows build logs separately, and polls final build phase to avoid cancellation after slow uploads
- `release:crc:v0.1.4` is bound to current PASS CRC deployment evidence, refuses stale or wrong-HEAD evidence, records `promotedImages`, requires app release sources to match verified runtime digests, and records both the verified external Postgres digest and the promoted internal ImageStream digest

Still required:

- production secret management
- production customer authorization policy content that maps verified OpenShift users/groups/namespaces to allowed customer workspaces; the live overlay enforces the ConfigMap-backed ACL, but the real customer/group mapping must come from the target environment
- migration rollback plan
- backup/restore plan
- exact PBS migration lineage
- real PBS runtime route/service name confirmation in the target cluster
- real PBS runtime HTTPS or service-mesh mTLS confirmation in the target cluster
- real `cas-pbs-auth` Secret material creation outside git
- real `cas-knowledge-postgres-live` Secret material creation outside git
- cleanup of legacy CRC `cas-knowledge-postgres` Secret before live apply
- PBS runtime pod labels matching the CAS egress policy
- production registry/ImageStream publication for any non-CRC target; local CRC `v0.1.4` ImageStreamTags are published and bound to verified deployment evidence
- applying `pbs-shadow` or `pbs-live` overlay in an environment where PBS is deployed
- live PBS smoke with HTTPS `CAS_PBS_BASE_URL` set and strict `npm run verify:release:pbs-live`
- egress controls for URL ingest and LLM/embedding endpoints

Latest closed review items:

- CRC dev deploy is now clean-cluster reproducible for namespace, ImageStreams, BuildConfigs, and optional legacy operator pause.
- Gateway public knowledge health is sanitized; detailed readiness remains on the internal Knowledge Engine health path and live preflight/smoke checks.
- Gateway owner verification failures are fail-closed before proxying private knowledge requests.
- Base NetworkPolicy now covers gateway, console-plugin, knowledge-engine, and Postgres ingress/egress boundaries.
- Active v0.1.4 deliverables are no longer hidden by `.gitignore`.

## Risks

- PBS-Dev3 워킹트리가 더럽기 때문에 소스 기준점을 먼저 고정해야 한다.
- PBS Python dependency가 크다. CAS Node gateway에 합치지 말고 별도 image로 분리해야 한다.
- pgvector embedding dimension, model 선택, migration 순서가 맞지 않으면 재색인이 필요하다.
- PBS-live URL ingest는 실제 fetch가 PBS에서 수행되므로 PBS 런타임의 SSRF/redirect/DNS-rebind 방어 계약을 별도로 확인해야 한다.
- 고객 데이터는 tenant isolation, audit trail, retention policy가 먼저 정해져야 한다.
- 기존 CAS 검증은 nav/route 미등록을 기대하므로 v0.1.4부터 검증 기준을 바꿔야 한다.

## Current Completion Boundary

v0.1.4 currently proves:

- Cywell menu and route integration
- working customer data/RAG/wiki/topology API path
- owner-scoped customer workspace isolation plus live ConfigMap-backed customer ACL enforcement before private knowledge requests are proxied
- rejection of conflicting top-level and nested customer IDs before indexing or outbound PBS calls
- CRC deployment of gateway, console plugin, knowledge engine, and Postgres
- topology dashboard visual design in the live console plugin bundle
- topology KPI strip, PBS-rich node tones, type filters, Signal leaders, relation grid, selected-node inspector, source/viewer metadata, and node-to-RAG action in the live console plugin bundle
- PBS-compatible upload and URL ingest payload metadata
- PBS-compatible local Postgres schema and ingest shadow rows for document sources, parsed documents, and chunks
- local Wiki Vault graph extraction for `[[wikilinks]]`, `#tags`, URLs, concepts, relations, backlinks, selected context/uploads, and RAG citations from vault-only context
- base64 file upload with lightweight MIME-aware extraction
- unsafe upload extension/MIME/base64/oversized OOXML rejection before local indexing or PBS-live outbound upload
- PBS HTTP shadow/live adapter with fake PBS verification for upload, URL ingest, reports, RAG, wiki-loop, wiki status, wiki vault topology, and note save
- PBS live outbound owner/hash contract verification across upload, URL ingest, reports, chat, wiki run/status, wiki vault, and note save
- PBS live outbound customer scope verification for reports, wiki status, and wiki vault
- PBS live response scope verification so mismatched customer IDs or PBS owner/user hashes are blocked before report rows, wiki vault payloads, or topology graphs reach CAS callers
- rendered PBS shadow/live deployment overlays with HTTPS service-token transport, shadow optional token Secret reference, live required token Secret reference, live required Postgres Secret references, no dev owner/DB Secret material, release image tags, and restricted knowledge-engine egress to labeled PBS runtime pods on `8765`
- rendered PBS live overlay with Gateway customer ACL required from `cas-knowledge-live-config/customer-access-json`; the default is an admin-all placeholder and target customer/group mapping is still an external cutover input
- topology normalization across PBS `graph`, `topology.graph`, `links`, `relations`, `relationships`, `node_id`, `source_id`, and `target_id` variants without mixing wrapper and nested graph candidates
- topology normalization preserves PBS summary counts, wikilinks, tags, entity/concept nodes, relation signals, degree/weight, selected context, and selected upload metadata
- Knowledge Engine ingress isolation so only the CAS gateway can call scoped data APIs in-cluster
- optional real PBS live smoke verifier with skip/required modes and strict DB/pgvector/corpus readiness checks
- owner-required scoped knowledge APIs with Gateway SelfSubjectReview owner mapping and deployed gateway rejection of spoofed owner headers
- non-2xx propagation for failed PBS live operations
- request body limits in Gateway and Knowledge Engine
- CRC/local pgvector readiness plus rendered and strict-preflight checks for live Postgres service readiness; production live pgvector readiness still requires target-cluster apply and Secrets
- smoke data persistence and owner-scoped query behavior
- CRC `v0.1.4` release tags are promoted only from current verified runtime evidence, and strict live preflight compares applied release ImageStreamTag digests to `test-results/cas-release-images.json`

v0.1.4 does not yet prove a production PBS live deployment. Full parity still requires applying the PBS overlay against a real PBS runtime, supplying the Secret material outside git, running PBS migrations/indexers against the target database, and verifying live corpus answers against real customer data.

## Phase 1 Implementation Notes

Phase 1은 기능 완성이 아니라 연결면을 고정하는 작업이다. PBS 엔진 API 표면, 메뉴 구조, route shell, 검증 기준을 먼저 만든다. 실제 ingest/RAG/wiki 실행은 Phase 2 이후 별도 서비스가 붙은 뒤 활성화한다.
