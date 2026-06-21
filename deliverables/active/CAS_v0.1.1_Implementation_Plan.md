# Cywell AI Sentinel v0.1.1 Implementation Plan

## 0. 문서 목적

이 문서는 **Cywell AI Sentinel(CAS) v0.1.1**의 실행 계획 산출물이다.

v0.1.1의 핵심은 대시보드를 단순 관제 화면으로 만들지 않고, **챗봇형 RCA 조종석**으로 만드는 것이다. 사용자는 OpenShift Web Console 안에서 CAS 버튼을 열고, 현재 콘솔의 메뉴와 기능을 그대로 활용하면서 자연어로 RCA를 시작한다. CAS는 OpenShift의 Pod, Event, Log, Metric, Workload, Namespace, Monitoring, Administrator/Developer 관점의 정보를 읽기 전용으로 수집하고, 가독성이 떨어지는 기본 시각화는 RCA에 더 적합한 카드, 타임라인, 리스크 테이블, 액션 큐로 재구성한다.

## 1. 현재 기준 상태

### 완료된 기반

| 구분 | 현재 상태 | 증거 |
| --- | --- | --- |
| 제품명 | Cywell AI Sentinel(CAS) 확정 | `packages/contracts/src/index.js` |
| Console 진입점 | CAS가 Lightspeed 위치를 대체 | `console.context-provider`, `useCASLauncher` |
| Native Lightspeed 버튼 | 비활성화 조건 추가 | `scripts/deploy-crc-dev.mjs`, `scripts/verify-crc-deployment.mjs` |
| Lightspeed brain | CAS Gateway에서 UserToken으로 `/v1/streaming_query` 호출 | `apps/gateway/src/lightspeedBrain.mjs` |
| OpenShift evidence | UserToken으로 ClusterVersion/Pod/Event/Log 증적 수집 | `apps/gateway/src/openshiftEvidence.mjs` |
| Runtime 검증 | CRC에서 Lightspeed answer + OpenShift evidence 수신 검증 | `npm run verify:crc:deployment` |

### v0.1.1 시작점

현재 CAS는 **뇌와 증적 수집**이 붙어 있다. 그러나 사용자가 보는 화면은 아직 “챗봇 + 결과 표시”에 가깝다.

v0.1.1에서는 화면을 다음 구조로 바꾼다.

```text
Ask -> See -> Explain -> Prove -> Act
```

즉, 사용자는 CAS 패널에서 질문하고, CAS는 OpenShift Web Console의 기능과 데이터를 바탕으로 현재 위험도, RCA 후보, 증적 타임라인, 다음 행동을 한 화면에 제시한다.

## 2. v0.1.1 제품 정의

### 한 문장 정의

**CAS v0.1.1은 OpenShift Web Console 안에서 동작하는 챗봇형 RCA 대시보드이며, 콘솔의 기존 운영 기능을 AI 질의, 증적 수집, 원인 후보, 후속 행동으로 재구성하는 버전이다.**

### 화면 철학

```text
See -> Explain -> Prove -> Act
```

| 단계 | 의미 | 화면 요소 |
| --- | --- | --- |
| See | 현재 어디가 위험한지 즉시 본다 | Health Score, Warning Events, Restart Spikes, Risk Workloads |
| Explain | AI가 좁힌 원인 후보를 본다 | RCA Candidate, Confidence, Affected Resource |
| Prove | 판단 근거를 확인한다 | Evidence Timeline, Event/Log/Metric cards |
| Act | 다음 확인 또는 이동을 수행한다 | Open Console Link, Recommended Checks, Runbook 후보 |

### 중요한 제품 판단

CAS는 OpenShift Web Console 전체를 대체하지 않는다.

CAS는 다음 역할을 한다.

- 콘솔에 흩어진 기능을 RCA 흐름으로 묶는다.
- 기존 메뉴와 리소스 화면으로 이동할 수 있는 맥락 링크를 제공한다.
- 가독성이 떨어지는 원본 대시보드는 CAS RCA에 맞게 재시각화한다.
- 자동 조치를 실행하지 않고, 읽기 전용 증적과 안전한 다음 확인을 제공한다.

## 3. v0.1.1 목표

### 목표

1. CAS Launcher 패널 첫 화면을 **Chat Dashboard Cockpit**으로 전환한다.
2. 챗봇 입력은 유지하되, 입력 전에도 현재 클러스터/namespace 위험도를 볼 수 있게 한다.
3. OpenShift Web Console 기능과 연결되는 RCA 중심 shortcut을 제공한다.
4. RCA 결과를 단순 텍스트가 아니라 **Candidate, Evidence, Timeline, Action Queue**로 표시한다.
5. 가독성이 낮은 차트는 작은 KPI, risk table, event reason bar, evidence timeline으로 대체한다.
6. 모든 데이터는 read-only UserToken 기반으로 수집하고, 실패는 missing evidence로 표시한다.

### 하지 않을 것

v0.1.1에서는 다음을 하지 않는다.

- OpenShift Console 전체 모딩
- 독립 full-screen dashboard route 추가
- 자동 remediation 실행
- `delete`, `patch`, `restart`, `scale`, `rollout undo` 실행
- `pods/exec`, `pods/portforward` 실행
- Secret value 조회
- Operator/CRD 정식 제품화
- KOMSCO 전용 branding asset 완성
- SaaS형 별도 대시보드

## 4. v0.1.1 UX 구조

### 4.1 Chat Dashboard Cockpit

CAS 패널은 세 영역으로 구성한다.

```text
[Header]
AI Sentinel / Brain status / Evidence status / Scope

[Cockpit]
Health Score | Active Risk | Warning Events | Restart Spikes
RCA Candidate | Risk Workloads | Evidence Timeline | Action Queue

[Chat Composer]
Question input / namespace / resource / send
```

### 4.2 화면 구성

| 영역 | v0.1.1 구성 | 설명 |
| --- | --- | --- |
| Header | Brain readiness, UserToken proxy, active scope | CAS가 실제 brain/evidence에 연결됐는지 표시 |
| Health Strip | Health Score, Warning Events, Restart Spikes | 첫 3초 안에 위험도 판단 |
| RCA Candidate | likely cause, confidence, provider | AI가 좁힌 1순위 원인 후보 |
| Evidence Timeline | event/log/metric sequence | RCA 판단의 시간 순서 |
| Workload Risk | namespace, workload, status, restart, reason | RCA를 시작할 대상 |
| Action Queue | next checks, open console links, runbook candidates | 운영자가 바로 할 다음 행동 |
| Chat Thread | user question, assistant answer, evidence cards | 기존 챗봇 흐름 유지 |

### 4.3 OpenShift Web Console 기능 활용

CAS는 기존 콘솔 메뉴를 복제하지 않고, RCA 맥락에서 호출하거나 이동한다.

| Console 기능 | CAS에서의 사용 방식 | v0.1.1 구현 |
| --- | --- | --- |
| Search | 리소스 이름/namespace 탐색 | quick resource scope 입력 |
| Administrator > Workloads > Pods | Pod 상태/재시작 원인 확인 | Pod evidence + Open Pod link |
| Administrator > Workloads > Deployments | 최근 rollout 영향 확인 | Deployment evidence + Open Deployment link |
| Observe > Events | Warning event reason 확인 | Event reason bar + filtered event link |
| Observe > Metrics | CPU/Memory pressure 확인 | metric adapter placeholder + missing evidence |
| Observe > Logs | previous/current log 확인 | previous log card + Open Logs link |
| Observe > Dashboards | 장기 추세 확인 | 필요 시 console dashboard deep link |
| Networking | service/route 연결 이슈 RCA | v0.1.1에서는 link only |
| Storage | PVC/PV Pending 원인 분석 | v0.1.1에서는 link only |
| User Preferences | theme/locale 존중 | console-native light mode 우선 |

## 5. 데이터 계약

### 5.1 GET `/api/aiops/overview`

v0.1.1에서 추가할 API다.

목적:

```text
CAS 패널이 열릴 때 현재 scope의 RCA cockpit 데이터를 빠르게 가져온다.
```

예시 응답:

```json
{
  "product": "Cywell AI Sentinel",
  "mode": "overview_read_only",
  "scope": {
    "cluster": "local-cluster",
    "namespaces": ["default"]
  },
  "health": {
    "score": 82,
    "risk": "medium",
    "summary": "Warning events and restart spikes detected in default namespace"
  },
  "signals": {
    "warning_events": 14,
    "restart_spikes": 3,
    "pending_pods": 2,
    "risky_workloads": 5
  },
  "risk_workloads": [
    {
      "namespace": "default",
      "kind": "Pod",
      "name": "api-7c8d9",
      "status": "Restarting",
      "risk": "high",
      "reason": "restartCount increased and OOMKilled event observed"
    }
  ],
  "rca_candidate": {
    "cause": "memory pressure or limit breach",
    "confidence": 0.72,
    "evidence_refs": ["openshift:events:default:api-7c8d9"]
  },
  "evidence_timeline": [
    {
      "ts": "2026-06-22T09:12:00+09:00",
      "type": "event",
      "summary": "Container terminated with OOMKilled",
      "source": "kubernetes.events"
    }
  ],
  "actions": [
    {
      "label": "Run RCA",
      "type": "cas_query",
      "question": "default namespace api-7c8d9 pod 재시작 원인 분석해줘"
    },
    {
      "label": "Open Pod in Console",
      "type": "console_link",
      "href": "/k8s/ns/default/pods/api-7c8d9"
    }
  ],
  "missing": [
    {
      "type": "metric",
      "reason": "Prometheus metric adapter is not configured in v0.1.1"
    }
  ]
}
```

### 5.2 기존 POST `/api/aiops/query`

v0.1.1에서는 기존 query 응답을 유지하되, UI 표시를 강화한다.

필수 표시 필드:

- `mode`
- `conversation_id`
- `audit.answer_provider`
- `audit.evidence.collected_count`
- `evidence_bundle.evidence`
- `evidence_bundle.missing`
- `rca_result.cause_candidates`
- `rca_result.answer`

## 6. 구현 계획표

| Step | 작업 | 구현 파일 | 완료 기준 | 검증 |
| ---: | --- | --- | --- | --- |
| 1 | Overview 계약 추가 | `packages/contracts/src/index.js` | `createOverviewResult()` 또는 동등 fixture 생성 | `verify:contracts` |
| 2 | Overview evidence collector 구현 | `apps/gateway/src/openshiftEvidence.mjs` | namespace/pod/event 기반 overview signals 생성 | `verify:openshift:evidence` |
| 3 | Gateway API 추가 | `apps/gateway/src/server.mjs` | `GET /api/aiops/overview` 200 응답 | 신규 verifier |
| 4 | Chat Dashboard state 추가 | `apps/console-plugin/src/plugin/useCASLauncher.tsx` | 패널 open 시 overview fetch | console integration verifier |
| 5 | Health Strip UI | `useCASLauncher.tsx` | score/risk/warning/restart 표시 | build + screenshot/manual smoke |
| 6 | RCA Candidate Card | `useCASLauncher.tsx` | cause/confidence/evidence_refs 표시 | verifier text check |
| 7 | Evidence Timeline | `useCASLauncher.tsx` | event/log/metric 순서 표시 | verifier text check |
| 8 | Risk Workload Table | `useCASLauncher.tsx` | top risky workloads 표시, 클릭 시 query scope 반영 | console integration verifier |
| 9 | Action Queue | `useCASLauncher.tsx` | Run RCA, Open Console link 표시 | console integration verifier |
| 10 | CRC runtime 검증 확장 | `scripts/verify-crc-deployment.mjs` | overview endpoint + launcher contract 확인 | `npm run verify:crc:deployment` |

## 7. Acceptance Criteria

| 항목 | Pass / Fail | 측정 방법 | Evidence | 현재 Gap |
| --- | --- | --- | --- | --- |
| CAS launcher 위치 | CAS만 AI launcher로 표시 | console operator spec 확인 | `lightspeed-console-plugin` 없음, `LightspeedButton=Disabled` | 완료 |
| Overview API | `/api/aiops/overview`가 read-only overview 반환 | Gateway pod 내부 HTTPS 호출 | `mode=overview_read_only` | 완료 |
| UserToken 보존 | overview/query 모두 UserToken 경유 | ConsolePlugin proxy 확인 | `authorization: UserToken` runtime PASS | 완료 |
| Health Strip | score/risk/signals 표시 | DOM/data-test 및 bundle verifier | `cas-health-strip` | 완료 |
| Risk Workloads | 위험 workload Top 5 표시 | fixture 및 runtime response | `risk_workloads[]` | 완료 |
| RCA Candidate | 원인 후보와 confidence 표시 | UI verifier | `cas-rca-candidate` | 완료 |
| Evidence Timeline | event/log/metric 순서 표시 | UI verifier | `cas-evidence-timeline` | 완료 |
| Action Queue | Run RCA + console deep link 제공 | UI verifier | `actions[]`, `cas-action-queue` | 완료 |
| Missing Evidence | metric/RAG 미구현 상태를 숨기지 않음 | API/UI 확인 | `missing[]` | 완료 |
| 가독성 | 작은 패널에서 텍스트 겹침 없음 | desktop/mobile visual smoke | screenshot 또는 manual note | 잔여: 실제 브라우저 스크린샷 QA 필요 |

### 7.1 Implementation Status

2026-06-22 기준 v0.1.1 핵심 구현은 `feat/CAS-v0.1.1` 브랜치에 반영되었다.

| 영역 | 상태 | Evidence |
| --- | --- | --- |
| 계약 | 완료 | `createOverviewResult()` 추가, `verify:contracts` PASS |
| Gateway overview | 완료 | `GET /api/aiops/overview` 추가, critical missing evidence degrade 처리 |
| OpenShift evidence | 완료 | pods/events/clusterversion read-only 수집, refs resolve 검증 PASS |
| Console cockpit | 완료 | Health, RCA Candidate, Risk Workloads, Event Reasons, Evidence Timeline, Action Queue 렌더링 |
| Runtime 배포 | 완료 | `npm run deploy:crc` PASS, overview/query 모두 UserToken proxy로 통과 |
| 시각 QA | 잔여 | 브라우저 screenshot/manual smoke로 overflow와 mobile width 확인 필요 |

검수에서 발견된 주요 이슈와 처리 결과:

| 이슈 | 처리 |
| --- | --- |
| evidence 조회 실패 시 건강 상태가 정상으로 보일 수 있음 | critical missing evidence면 `risk=unknown`, `score=0`으로 degrade |
| `rca_candidate.evidence_refs`가 실제 반환 item과 연결되지 않음 | `risk_workloads[].id`, `evidence_timeline[].id` 추가 및 resolver 검증 |
| risk workload 클릭 시 항상 Pod로 질의될 수 있음 | `kind`를 workload/action context에서 넘기도록 수정 |
| namespace 입력 중 overview 요청이 과도하게 발생할 수 있음 | panel open 기준 fetch로 줄이고 실패 시 stale overview 제거 |
| bundle verifier가 cockpit 일부만 확인함 | candidate/action/risk/timeline bundle marker 검증 추가 |

## 8. v0.1.1 화면 세부안

### 8.1 Header

```text
Cywell AI Sentinel
OpenShift RCA Cockpit

Brain: ready / openshift-lightspeed
Evidence: openshift-api / UserToken proxy
Scope: default
```

### 8.2 Health Strip

```text
Health 82/100
Risk Medium
Warning Events 14
Restart Spikes 3
Pending Pods 2
```

시각화 원칙:

- 좁은 패널이므로 큰 차트보다 compact KPI 카드 우선
- donut/ring은 작은 score에만 제한
- event reason은 막대보다 label + count list가 더 읽기 좋으면 대체

### 8.3 RCA Candidate

```text
Likely Cause
memory pressure or limit breach

Confidence
72%

Evidence
events x3 / logs x1 / metrics missing
```

### 8.4 Evidence Timeline

```text
09:12 Warning OOMKilled
09:13 Pod restarted
09:14 Previous log collected
09:15 Lightspeed answer generated
```

### 8.5 Risk Workloads

```text
Namespace | Kind | Name | Risk | Reason
default   | Pod  | api  | High | restart spike + OOMKilled
```

### 8.6 Action Queue

```text
1. Run RCA for api pod
2. Open Pod in Console
3. Open Events view
4. Open related Runbook
```

## 9. Web Console 연동 원칙

### Console deep link

v0.1.1은 먼저 link 기반으로 OpenShift console 기능을 활용한다.

| 대상 | 링크 예시 |
| --- | --- |
| Pod | `/k8s/ns/{namespace}/pods/{name}` |
| Deployment | `/k8s/ns/{namespace}/deployments/{name}` |
| Events | `/k8s/ns/{namespace}/events` |
| Logs | Pod detail의 logs tab deep link는 후속 확인 |
| Monitoring | Observe menu deep link는 후속 확인 |

### 기능 사용 방식

CAS가 모든 console 메뉴를 화면에 복제하면 가독성이 떨어진다. 따라서 v0.1.1은 다음 우선순위를 따른다.

1. RCA 판단에 필요한 정보는 CAS 카드로 요약한다.
2. 상세 확인은 OpenShift native page로 이동한다.
3. native page가 너무 복잡하면 CAS가 더 읽기 쉬운 요약 시각화로 대체한다.
4. 조치 실행은 하지 않고, 안전한 확인 절차와 링크만 제공한다.

## 10. 기술 구현 세부

### Backend

| 항목 | 구현 |
| --- | --- |
| API | `GET /api/aiops/overview` |
| Auth | ConsolePlugin proxy UserToken |
| Evidence | OpenShift API read-only |
| Scope | default namespace 우선, query param으로 확장 |
| Timeout | overview p95 5초 목표 |
| Fallback | evidence 실패 시 partial overview + missing evidence |

### Frontend

| 항목 | 구현 |
| --- | --- |
| Surface | 기존 CAS launcher panel |
| Pattern | Chat dashboard cockpit |
| CSS | PatternFly neutral 기반, 기존 CAS token 재사용 |
| Data fetch | panel open 시 overview fetch |
| Refresh | 수동 refresh 버튼 우선 |
| Query | Risk workload 또는 Action Queue에서 질문 자동 채움 |
| State | loading / ready / degraded / error |

### Verification

| 스크립트 | 추가 검증 |
| --- | --- |
| `verify-contracts.mjs` | overview result schema |
| `verify-openshift-evidence.mjs` | overview signals 생성 |
| `verify-console-integration.mjs` | health strip/timeline/action queue bundle 포함 |
| `verify-crc-deployment.mjs` | `/api/aiops/overview` runtime 응답 |
| `verify-deploy-manifests.mjs` | native Lightspeed disabled condition 유지 |

## 11. v0.1.1 산출물 Definition of Done

v0.1.1은 아래 조건을 만족해야 완료다.

1. CAS 버튼이 native Lightspeed 대신 보인다.
2. 패널을 열면 Overview Cockpit이 먼저 보인다.
3. Overview Cockpit은 Health, Risk, RCA Candidate, Evidence Timeline, Action Queue를 표시한다.
4. 사용자는 Risk Workload 또는 Action Queue에서 바로 RCA 질문을 시작할 수 있다.
5. Query 결과는 기존 Lightspeed-backed answer와 OpenShift evidence를 유지한다.
6. Evidence가 부족하면 "없음"이 아니라 missing reason으로 표시한다.
7. OpenShift native page로 이동할 수 있는 console link가 제공된다.
8. `npm run verify`가 통과한다.
9. `npm run verify:crc:deployment`가 overview runtime까지 통과한다.
10. `.env`와 materials 문서는 변경하지 않는다.

## 12. 일정안

| 일차 | 목표 | 산출 |
| --- | --- | --- |
| Day 1 | Overview API와 계약 구현 | API JSON, unit verifier |
| Day 2 | Launcher cockpit UI 구현 | Health strip, candidate, timeline, action queue |
| Day 3 | CRC runtime 검증과 UX 다듬기 | deploy PASS, overflow/manual smoke |

## 13. 다음 작업 명령

v0.1.1 브랜치에서 수행 완료된 작업:

```text
1. createOverviewResult 계약 추가: 완료
2. GET /api/aiops/overview 구현: 완료
3. useCASLauncher에 cockpit state/UI 추가: 완료
4. verify-console-integration/verify-crc-deployment 확장: 완료
5. npm run verify: PASS
6. npm run deploy:crc: PASS
```

잔여 작업:

```text
1. 브라우저 screenshot/manual smoke로 desktop/mobile overflow 확인
2. OpenShift native page deep link를 실제 콘솔 URL에서 클릭 검증
3. 필요하면 v0.1.1-ux-fix 커밋으로 visual polish 반영
```

## 14. Ref Stamp

작성 기준:

```text
branch: feat/CAS-v0.1.1
base: main
target version: v0.1.1
implementation commit: fdae8397246cdb1efd42c0d117edfb14916f6167
current product state: v0.1.1 RCA cockpit implemented and CRC runtime verified
```
