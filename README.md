# Cywell AI Sentinel

Cywell AI Sentinel(CAS)는 OpenShift 운영 신호를 근거 기반 RCA와 안전한 조치 가이드로 전환하는 OpenShift-native AIOps Agent 제품입니다.

첫 작업 범위는 다음에 한정합니다.

- read-only Tool Plan 계약
- Evidence Bundle / RCA Result 계약
- CRC OpenShift Console 연결 검증
- 최소 namespace/RBAC/NetworkPolicy 배포 골격

문서 산출물과 민감 설정은 git에 포함하지 않습니다.

```text
.env
deliverables/
docs/
```

## Verification

```bash
npm run verify:contracts
npm run verify:crc:connection:preview
npm run verify:deploy:manifests
```

CRC 연결을 반드시 실패 처리해야 하는 gate에서는 다음을 사용합니다.

```bash
npm run verify:crc:connection
```

