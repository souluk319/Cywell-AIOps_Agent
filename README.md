# Cywell AI Sentinel

Cywell AI Sentinel(CAS)는 OpenShift 운영 신호를 근거 기반 RCA와 안전한 조치 가이드로 전환하는 OpenShift-native AIOps Agent 제품입니다.

첫 작업 범위는 다음에 한정합니다.

- read-only Tool Plan 계약
- Evidence Bundle / RCA Result 계약
- CRC OpenShift Console 연결 검증
- 최소 namespace/RBAC/NetworkPolicy 배포 골격
- OOMKilled mock RCA Gateway
- `/ai-sentinel` Console Plugin shell

문서 산출물과 민감 설정은 git에 포함하지 않습니다.

```text
.env
deliverables/
docs/
```

## Verification

```bash
npm run verify:contracts
npm run verify:gateway
npm run verify:console-plugin
npm run verify:crc:connection:preview
npm run verify:deploy:manifests
```

CRC 연결을 반드시 실패 처리해야 하는 gate에서는 다음을 사용합니다.

```bash
npm run verify:crc:connection
```

## Current Boundary

현재 Gateway는 mock read-only mode입니다. 실제 OpenShift Pod/Event/Previous Log 조회는 다음 단계에서 `openshift-adapter`로 교체합니다.

현재 OpenShift manifest는 server-side dry-run까지 검증했습니다. 실제 workload 배포는 `cas-gateway`와 `cas-console-plugin` 이미지를 registry에 push한 뒤 진행합니다.

Console Plugin 병렬 설치 기준:

- OpsLens path: `/opslens`
- AI Sentinel path: `/ai-sentinel`
- OpsLens proxy alias: `opslens-api`
- AI Sentinel proxy alias: `cas-api`

## CRC Dev Deployment

Docker push가 CRC route CA 신뢰 문제로 막히는 경우, CRC overlay의 OpenShift binary `BuildConfig`를 사용합니다.

```bash
npm run deploy:crc
npm run verify:crc:deployment
```

`deploy:crc`는 `.env`, `deliverables`, `node_modules`를 제외한 최소 build context를 `test-results/cas-build-context`에 만든 뒤 OpenShift binary build로 `cas-gateway:dev`와 `cas-console-plugin:dev` 이미지를 생성합니다. 이후 manifest 적용, rollout 대기, ConsolePlugin 활성화, deployment 검증을 수행합니다.
