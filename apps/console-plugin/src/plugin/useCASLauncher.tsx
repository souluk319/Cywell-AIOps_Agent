import * as React from "react";

const API_BASE = "/api/proxy/plugin/cywell-ai-sentinel/cas-api";
const CSRF_COOKIE_NAME = "csrf-token";

type CauseCandidate = {
  cause: string;
  confidence: number;
  evidence_refs?: string[];
};

type EvidenceItem = {
  id: string;
  source: string;
  summary: string;
};

type MissingEvidence = {
  type: string;
  reason: string;
};

type RCAResult = {
  run_id?: string;
  mode?: string;
  conversation_id?: string | null;
  audit?: {
    answer_provider?: string;
    brain?: {
      provider?: string;
      status?: string;
      endpoint?: string;
    };
  };
  rca_result?: {
    answer?: string;
    cause_candidates?: CauseCandidate[];
  };
  evidence_bundle?: {
    evidence?: EvidenceItem[];
    missing?: MissingEvidence[];
  };
};

type BrainStatus = {
  state: "checking" | "ready" | "degraded";
  provider: string;
  detail: string;
};

type ActiveView = "chat" | "cockpit" | "evidence" | "actions";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  question?: string;
  isPending?: boolean;
  result?: RCAResult;
};

type OverviewAction = {
  label: string;
  type: "cas_query" | "console_link";
  question?: string;
  href?: string;
};

type RiskWorkload = {
  id?: string;
  namespace: string;
  kind: string;
  name: string;
  status: string;
  restarts?: number;
  risk: "high" | "medium" | "low" | string;
  reason: string;
  href?: string;
};

type TimelineItem = {
  id?: string;
  ts: string;
  type: string;
  summary: string;
  source: string;
};

type OverviewResult = {
  mode?: string;
  scope?: {
    cluster?: string;
    namespaces?: string[];
  };
  health?: {
    score?: number;
    risk?: string;
    summary?: string;
  };
  signals?: {
    warning_events?: number;
    restart_spikes?: number;
    pending_pods?: number;
    risky_workloads?: number;
  };
  event_reasons?: Array<{ reason: string; count: number }>;
  risk_workloads?: RiskWorkload[];
  rca_candidate?: {
    cause?: string;
    confidence?: number;
    evidence_refs?: string[];
  };
  evidence_timeline?: TimelineItem[];
  actions?: OverviewAction[];
  missing?: MissingEvidence[];
};

const initialQuestion = "ClusterVersion 상태를 한 문장으로 요약해줘.";
const RECOMMENDED_QUESTION_COUNT = 5;
const OCP_AIOPS_QUESTION_BANK = [
  "ClusterVersion 상태를 한 문장으로 요약해줘.",
  "현재 degraded 상태의 ClusterOperator가 있는지 확인해줘.",
  "default namespace에서 위험도가 높은 workload를 찾아 원인 후보를 정리해줘.",
  "최근 Warning 이벤트 기준으로 장애 가능성이 높은 리소스를 알려줘.",
  "Pending 상태 Pod가 있다면 스케줄링 실패 원인을 분석해줘.",
  "CrashLoopBackOff Pod가 있다면 재시작 원인 후보를 정리해줘.",
  "OOMKilled가 발생한 Pod를 찾아 메모리 limit 관점에서 설명해줘.",
  "ImagePullBackOff 또는 ErrImagePull 이벤트가 있는지 확인해줘.",
  "최근 restart spike가 있는 workload와 영향 범위를 요약해줘.",
  "Node NotReady 또는 pressure condition이 있는지 점검해줘.",
  "CPU pressure 가능성이 있는 Pod나 Node 신호를 찾아줘.",
  "Memory pressure 가능성이 있는 Pod나 Node 신호를 찾아줘.",
  "PVC Pending 또는 volume mount 실패 이벤트를 찾아줘.",
  "Service endpoint가 비어 있는 리소스가 있는지 확인해줘.",
  "Route 또는 Ingress 연결 장애 가능성을 점검해줘.",
  "Deployment rollout이 멈춘 리소스와 원인 후보를 알려줘.",
  "ReplicaSet과 Pod 수가 기대치와 다른 workload를 찾아줘.",
  "최근 FailedScheduling 이벤트를 기준으로 필요한 조치를 제안해줘.",
  "Pod readiness probe 실패가 반복되는 리소스를 찾아줘.",
  "Pod liveness probe 실패가 반복되는 리소스를 찾아줘.",
  "namespace별 Warning 이벤트 상위 원인을 요약해줘.",
  "컨트롤 플레인 operator 상태를 운영자 관점으로 요약해줘.",
  "현재 클러스터 업데이트 위험 신호가 있는지 확인해줘.",
  "현재 설치된 OpenShift 버전과 업데이트 진행 상태를 알려줘.",
  "최근 이벤트만 보고 가장 먼저 봐야 할 장애 후보 3개를 골라줘.",
  "장애 대응을 위해 지금 수집된 증적과 부족한 증적을 구분해줘.",
  "읽기 전용으로 안전하게 확인 가능한 다음 명령을 제안해줘.",
  "Prometheus 메트릭 없이 이벤트와 상태만으로 RCA 후보를 정리해줘.",
  "API 서버나 인증 관련 operator 이상 신호가 있는지 확인해줘.",
  "네트워크 operator 또는 DNS 관련 이상 신호를 찾아줘.",
  "이미지 레지스트리 operator 상태와 관련 이벤트를 점검해줘.",
  "Monitoring stack 상태 이상이 있는지 요약해줘.",
  "OpenShift Console 관련 Pod나 operator 이상 여부를 확인해줘.",
  "MachineConfigPool 업데이트가 멈췄는지 확인해줘.",
  "노드별 Ready 상태와 taint 영향 가능성을 요약해줘.",
  "특정 namespace에서 가장 위험한 Pod 하나를 골라 RCA를 시작해줘.",
  "Pod 로그 없이 상태와 이벤트만으로 가능한 원인 후보를 정리해줘.",
  "최근 배포 이후 문제가 생긴 workload 후보를 찾아줘.",
  "HPA 또는 리소스 부족 때문에 replica가 불안정한지 확인해줘.",
  "서비스 장애 관점에서 사용자 영향 가능성이 높은 리소스를 알려줘.",
  "보안이나 권한 문제로 실패한 Pod 이벤트가 있는지 찾아줘.",
  "ConfigMap 또는 Secret mount 실패 가능성을 점검해줘.",
  "CNI 또는 네트워크 정책 때문에 통신 실패 가능성이 있는지 봐줘.",
  "스토리지 attach/detach 실패 이벤트가 있는지 확인해줘.",
  "운영자가 지금 바로 봐야 할 Top 5 신호를 요약해줘.",
  "현재 상태를 장애 보고서 초안 형태로 정리해줘.",
  "현재 상태를 교대 근무 인수인계용으로 짧게 정리해줘.",
  "RCA를 시작하기 전에 확인해야 할 증적 체크리스트를 만들어줘.",
  "현재 클러스터에서 안전한 조치와 위험한 조치를 구분해줘.",
  "CAS가 수집한 증적 기준으로 다음 분석 질문을 추천해줘."
];

function getCookieValue(name: string) {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!match) return undefined;
  return decodeURIComponent(match.slice(name.length + 1));
}

function gatewayHeaders(headers: Record<string, string> = {}) {
  const csrfToken = getCookieValue(CSRF_COOKIE_NAME);
  return {
    ...headers,
    ...(csrfToken ? { "X-CSRFToken": csrfToken } : {})
  };
}

async function gatewayErrorMessage(response: Response) {
  const text = await response.text().catch(() => "");
  const detail = text.trim().replace(/\s+/g, " ").slice(0, 180);
  return `CAS Gateway HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
}

const styles = `
.cas-launcher-root {
  --cas-ink: #16212c;
  --cas-muted: #5a6877;
  --cas-line: #d7dee7;
  --cas-surface: #ffffff;
  --cas-soft: #f5f7fa;
  --cas-soft-strong: #edf4f6;
  --cas-accent: #087f8c;
  --cas-accent-strong: #05606a;
  --cas-warning: #a66200;
  --cas-danger: #b1382e;
  color: var(--cas-ink);
  font-family: var(--pf-t--global--font--family--body, "Red Hat Text", "Noto Sans KR", "Segoe UI", Arial, sans-serif);
}

.cas-launcher-root,
.cas-launcher-root * {
  box-sizing: border-box;
}

.cas-launcher-button {
  align-items: center;
  background: var(--cas-surface);
  border: 1px solid rgba(8, 127, 140, 0.24);
  border-radius: 12px;
  bottom: var(--pf-t--global--spacer--lg, 24px);
  box-shadow: var(--pf-t--global--box-shadow--lg, 0 10px 28px rgba(3, 22, 30, 0.22));
  color: var(--cas-accent);
  cursor: pointer;
  display: inline-flex;
  height: var(--pf-t--global--spacer--2xl, 48px);
  justify-content: center;
  padding: 0;
  position: fixed;
  right: var(--pf-t--global--spacer--lg, 24px);
  width: var(--pf-t--global--spacer--2xl, 48px);
  z-index: var(--pf-t--global--z-index--md, 300);
}

.cas-launcher-button:hover,
.cas-launcher-button:focus {
  border-color: var(--cas-accent);
  color: var(--cas-accent-strong);
  outline: 2px solid rgba(8, 127, 140, 0.22);
  outline-offset: 2px;
}

.cas-launcher-button svg {
  height: 30px;
  width: 30px;
}

.cas-panel-header > svg {
  flex: 0 0 34px;
  height: 34px;
  width: 34px;
}

.cas-panel {
  background: var(--cas-surface);
  border: 1px solid var(--cas-line);
  border-radius: 8px;
  bottom: calc(var(--pf-t--global--spacer--2xl, 48px) + var(--pf-t--global--spacer--lg, 24px) + 10px);
  box-shadow: var(--pf-t--global--box-shadow--lg, 0 18px 44px rgba(3, 22, 30, 0.24));
  max-height: min(760px, calc(100vh - 112px));
  overflow: hidden;
  position: fixed;
  right: var(--pf-t--global--spacer--lg, 24px);
  width: min(560px, calc(100vw - 32px));
  z-index: calc(var(--pf-t--global--z-index--md, 300) + 1);
}

.cas-panel-header {
  align-items: center;
  border-bottom: 1px solid var(--cas-line);
  display: flex;
  gap: 12px;
  padding: 14px 16px;
}

.cas-header-tools {
  align-items: center;
  display: flex;
  flex: 0 0 auto;
  gap: 6px;
}

.cas-view-switcher {
  align-items: center;
  display: inline-flex;
  gap: 4px;
}

.cas-view-button {
  align-items: center;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--cas-muted);
  cursor: pointer;
  display: inline-flex;
  height: 32px;
  justify-content: center;
  padding: 0;
  width: 32px;
}

.cas-view-button:hover,
.cas-view-button:focus,
.cas-view-button[data-active="true"] {
  background: var(--cas-soft-strong);
  border-color: rgba(8, 127, 140, 0.24);
  color: var(--cas-accent-strong);
  outline: 0;
}

.cas-view-button svg {
  height: 18px;
  width: 18px;
}

.cas-panel-title {
  flex: 1;
  min-width: 0;
}

.cas-panel-title strong,
.cas-section-title,
.cas-message strong,
.cas-evidence-item strong {
  display: block;
}

.cas-panel-title span,
.cas-meta,
.cas-evidence-item span,
.cas-conversation {
  color: var(--cas-muted);
  font-size: 12px;
}

.cas-panel-title strong,
.cas-panel-title span {
  overflow-wrap: anywhere;
}

.cas-close {
  align-items: center;
  background: transparent;
  border: 0;
  color: var(--cas-muted);
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  height: 32px;
  justify-content: center;
  padding: 0;
  width: 32px;
}

.cas-panel-body {
  display: grid;
  gap: 12px;
  max-height: calc(min(760px, calc(100vh - 112px)) - 65px);
  overflow: auto;
  padding: 14px 16px 16px;
}

.cas-status-row {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.cas-cockpit {
  display: grid;
  gap: 10px;
}

.cas-health-strip {
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.cas-signal-card {
  background: var(--cas-soft);
  border: 1px solid var(--cas-line);
  border-radius: 6px;
  min-width: 0;
  padding: 9px 10px;
}

.cas-signal-card span {
  color: var(--cas-muted);
  display: block;
  font-size: 11px;
}

.cas-signal-card strong {
  display: block;
  font-size: 20px;
  line-height: 1.2;
  margin-top: 3px;
}

.cas-cockpit-grid {
  display: grid;
  gap: 10px;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}

.cas-cockpit-panel {
  background: var(--cas-soft);
  border: 1px solid var(--cas-line);
  border-radius: 8px;
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 11px 12px;
}

.cas-cockpit-panel[data-wide="true"] {
  grid-column: 1 / -1;
}

.cas-panel-heading {
  align-items: center;
  display: flex;
  gap: 8px;
  justify-content: space-between;
  min-width: 0;
}

.cas-panel-heading strong {
  display: block;
}

.cas-risk-list,
.cas-action-list,
.cas-timeline-list,
.cas-reason-list {
  display: grid;
  gap: 7px;
}

.cas-risk-row,
.cas-action-row,
.cas-timeline-row,
.cas-reason-row {
  background: #fff;
  border: 1px solid var(--cas-line);
  border-radius: 6px;
  min-width: 0;
  padding: 8px 9px;
}

.cas-risk-row {
  cursor: pointer;
  text-align: left;
  width: 100%;
}

.cas-risk-row:hover,
.cas-risk-row:focus {
  border-color: rgba(8, 127, 140, 0.42);
  outline: 2px solid rgba(8, 127, 140, 0.16);
  outline-offset: 1px;
}

.cas-risk-row:disabled,
.cas-link-button:disabled {
  cursor: progress;
  opacity: 0.64;
}

.cas-row-main {
  align-items: center;
  display: flex;
  gap: 8px;
  justify-content: space-between;
  min-width: 0;
}

.cas-row-main strong,
.cas-timeline-row strong {
  overflow-wrap: anywhere;
}

.cas-risk-pill {
  border-radius: 999px;
  border: 1px solid var(--cas-line);
  color: var(--cas-muted);
  flex: 0 0 auto;
  font-size: 11px;
  padding: 3px 6px;
}

.cas-risk-pill[data-risk="high"] {
  color: var(--cas-danger);
}

.cas-risk-pill[data-risk="medium"] {
  color: var(--cas-warning);
}

.cas-action-row {
  align-items: center;
  display: flex;
  gap: 8px;
  justify-content: space-between;
}

.cas-action-row span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.cas-link-button {
  background: transparent;
  border: 0;
  color: var(--cas-accent-strong);
  cursor: pointer;
  font: inherit;
  font-weight: 700;
  padding: 0;
  text-decoration: none;
}

.cas-link-button:hover,
.cas-link-button:focus {
  text-decoration: underline;
}

.cas-badge {
  align-items: center;
  background: var(--cas-soft-strong);
  border: 1px solid var(--cas-line);
  border-radius: 999px;
  color: var(--cas-muted);
  display: inline-flex;
  font-size: 12px;
  gap: 6px;
  line-height: 1;
  padding: 6px 8px;
}

.cas-badge[data-state="ready"] {
  color: var(--cas-accent-strong);
}

.cas-badge[data-state="degraded"] {
  color: var(--cas-warning);
}

.cas-chat-thread {
  display: grid;
  gap: 10px;
  min-height: 220px;
}

.cas-chat-surface {
  display: grid;
  gap: 12px;
}

.cas-chat-topline {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: space-between;
}

.cas-message {
  border: 1px solid var(--cas-line);
  border-radius: 8px;
  display: grid;
  gap: 8px;
  padding: 11px 12px;
}

.cas-message[data-role="user"] {
  background: #f7fbfc;
  border-color: rgba(8, 127, 140, 0.26);
  justify-self: end;
  max-width: 86%;
}

.cas-message[data-role="assistant"] {
  background: #fff;
}

.cas-message[data-role="system"] {
  background: transparent;
  border: 0;
  color: var(--cas-muted);
  font-size: 12px;
  padding: 0 2px;
}

.cas-message-role {
  color: var(--cas-muted);
  font-size: 12px;
}

.cas-answer {
  font-size: 14px;
  line-height: 1.55;
  margin: 0;
  white-space: pre-wrap;
}

.cas-answer[data-primary="true"] {
  color: var(--cas-ink);
  font-size: 15px;
}

.cas-result-meta {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.cas-message-tools {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}

.cas-cause-list,
.cas-evidence-list,
.cas-missing-list {
  display: grid;
  gap: 8px;
}

.cas-cause,
.cas-evidence-item,
.cas-missing-item {
  background: #fff;
  border: 1px solid var(--cas-line);
  border-radius: 6px;
  padding: 9px 10px;
}

.cas-missing-item {
  border-color: rgba(166, 98, 0, 0.24);
}

.cas-result-details {
  background: var(--cas-soft);
  border: 1px solid var(--cas-line);
  border-radius: 6px;
  overflow: hidden;
}

.cas-result-details > summary {
  align-items: center;
  color: var(--cas-muted);
  cursor: pointer;
  display: flex;
  font-size: 12px;
  gap: 8px;
  justify-content: space-between;
  list-style: none;
  padding: 8px 10px;
}

.cas-result-details > summary::-webkit-details-marker {
  display: none;
}

.cas-result-details > summary::after {
  content: "열기";
  color: var(--cas-accent-strong);
  font-weight: 700;
}

.cas-result-details[open] > summary {
  border-bottom: 1px solid var(--cas-line);
}

.cas-result-details[open] > summary::after {
  content: "닫기";
}

.cas-result-details-body {
  display: grid;
  gap: 8px;
  padding: 9px 10px 10px;
}

.cas-compose {
  border-top: 1px solid var(--cas-line);
  display: grid;
  gap: 10px;
  padding-top: 12px;
}

.cas-input-wrap {
  display: grid;
  gap: 8px;
  position: relative;
}

.cas-compose textarea,
.cas-compose input {
  border: 1px solid var(--cas-line);
  border-radius: 4px;
  color: var(--cas-ink);
  font: inherit;
  padding: 9px 10px;
  width: 100%;
}

.cas-compose textarea {
  min-height: 80px;
  padding-right: 48px;
  resize: vertical;
}

.cas-send-button {
  align-items: center;
  background: var(--cas-accent);
  border: 0;
  border-radius: 6px;
  bottom: 8px;
  color: #fff;
  cursor: pointer;
  display: inline-flex;
  height: 34px;
  justify-content: center;
  padding: 0;
  position: absolute;
  right: 8px;
  width: 34px;
}

.cas-send-button svg {
  height: 18px;
  width: 18px;
}

.cas-send-button:disabled {
  cursor: progress;
  opacity: 0.68;
}

.cas-suggestion-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.cas-suggestion {
  background: #fff;
  border: 1px solid var(--cas-line);
  border-radius: 999px;
  color: var(--cas-muted);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  line-height: 1.35;
  max-width: 100%;
  padding: 6px 9px;
  text-align: left;
}

.cas-suggestion:hover,
.cas-suggestion:focus,
.cas-suggestion[data-active="true"] {
  border-color: rgba(8, 127, 140, 0.36);
  color: var(--cas-accent-strong);
  outline: 0;
}

.cas-compose-toolbar {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: space-between;
}

.cas-target-toggle {
  max-width: 100%;
}

.cas-fields {
  display: grid;
  gap: 8px;
  grid-template-columns: 1fr 1fr 1fr;
}

.cas-actions {
  align-items: center;
  display: flex;
  gap: 8px;
  justify-content: space-between;
}

.cas-submit,
.cas-secondary {
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
  font-weight: 700;
  padding: 9px 12px;
}

.cas-submit {
  background: var(--cas-accent);
  border: 0;
  color: #fff;
}

.cas-secondary {
  background: #fff;
  border: 1px solid var(--cas-line);
  color: var(--cas-muted);
}

.cas-submit:disabled,
.cas-secondary:disabled {
  cursor: progress;
  opacity: 0.68;
}

@media (max-width: 620px) {
  .cas-panel {
    bottom: calc(var(--pf-t--global--spacer--2xl, 48px) + 22px);
    left: 8px;
    right: 8px;
    width: auto;
  }

  .cas-launcher-button {
    bottom: 12px;
    right: 12px;
  }

  .cas-panel-header {
    align-items: flex-start;
  }

  .cas-header-tools {
    align-items: flex-end;
    flex-direction: column-reverse;
  }

  .cas-fields,
  .cas-actions {
    grid-template-columns: 1fr;
  }

  .cas-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .cas-health-strip,
  .cas-cockpit-grid {
    grid-template-columns: 1fr;
  }

  .cas-cockpit-panel[data-wide="true"] {
    grid-column: auto;
  }
}
`;

function SentinelIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" role="img">
      <path
        d="M24 5.5 38 10v11.4c0 9.1-5.4 16.8-14 21.1-8.6-4.3-14-12-14-21.1V10l14-4.5Z"
        fill="currentColor"
        opacity="0.16"
      />
      <path
        d="M24 6.5 37 11v10.2c0 8.2-5 15.1-13 19-8-3.9-13-10.8-13-19V11l13-4.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path d="M16 25.5h16M19.5 18.5h9M19.5 32.5h9" stroke="currentColor" strokeLinecap="round" strokeWidth="3" />
      <circle cx="33.5" cy="18.5" r="3" fill="currentColor" />
    </svg>
  );
}

function ViewIcon({ view }: { view: ActiveView }) {
  if (view === "chat") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" role="img">
        <path d="M5 6.5h14v8.8H9.2L5 18.5v-12Z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="2" />
        <path d="M8 10h8M8 13h5" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      </svg>
    );
  }
  if (view === "cockpit") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" role="img">
        <path d="M4 13a8 8 0 1 1 16 0" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
        <path d="M12 13 16 9M7 17h10" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      </svg>
    );
  }
  if (view === "evidence") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" role="img">
        <path d="M7 4h10v16H7z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="2" />
        <path d="M9.5 8h5M9.5 12h5M9.5 16h3" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" role="img">
      <path d="M5 12h12M13 8l4 4-4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      <path d="M5 5h14v14H5z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="2" opacity="0.35" />
    </svg>
  );
}

function SendIcon({ mode }: { mode: "send" | "stop" }) {
  if (mode === "stop") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" role="img">
        <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" role="img">
      <path d="M4.5 19.5 20 12 4.5 4.5 7 11.2 14 12l-7 .8-2.5 6.7Z" fill="currentColor" />
    </svg>
  );
}

function viewLabel(view: ActiveView) {
  if (view === "chat") return "Chat";
  if (view === "cockpit") return "Cockpit";
  if (view === "evidence") return "Evidence";
  return "Actions";
}

function createMessageId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function modeLabel(mode?: string) {
  if (mode === "lightspeed_read_only") return "Lightspeed real answer";
  if (mode === "lightspeed_fallback_mock") return "Fallback mock RCA";
  if (mode === "mock_read_only") return "Mock RCA";
  return mode || "ready";
}

function resultProvider(result?: RCAResult) {
  return result?.audit?.answer_provider ?? result?.audit?.brain?.provider ?? "cas-gateway";
}

function normalizeQuestion(value: string, fallback = initialQuestion) {
  return value.trim() || fallback;
}

function pickQuestionSuggestions(count = RECOMMENDED_QUESTION_COUNT) {
  const pool = [...OCP_AIOPS_QUESTION_BANK];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]];
  }
  return pool.slice(0, count);
}

function confidenceLabel(value?: number) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function scoreLabel(value?: number) {
  return Number.isFinite(Number(value)) ? String(Math.round(Number(value))) : "-";
}

function formatTimelineTime(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function OverviewCockpit({
  overview,
  status,
  activeView,
  onRefresh,
  onRunQuestion,
  onSelectWorkload,
  isRunning
}: {
  overview: OverviewResult | null;
  status: "idle" | "loading" | "ready" | "degraded";
  activeView: Exclude<ActiveView, "chat">;
  onRefresh: () => void;
  onRunQuestion: (question: string, resourceName?: string) => void;
  onSelectWorkload: (workload: RiskWorkload) => void;
  isRunning: boolean;
}) {
  const signals = overview?.signals ?? {};
  const riskWorkloads = overview?.risk_workloads ?? [];
  const timeline = overview?.evidence_timeline ?? [];
  const actions = overview?.actions ?? [];
  const eventReasons = overview?.event_reasons ?? [];
  const missing = overview?.missing ?? [];
  const candidate = overview?.rca_candidate;

  return (
    <section className="cas-cockpit" data-test="cas-overview-cockpit">
      <div className="cas-panel-heading">
        <strong>{viewLabel(activeView)}</strong>
        <button className="cas-link-button" onClick={onRefresh} type="button">
          {status === "loading" ? "Refreshing" : "Refresh"}
        </button>
      </div>

      {activeView === "cockpit" && (
        <>
          <div className="cas-health-strip" data-test="cas-health-strip">
            <div className="cas-signal-card">
              <span>Health</span>
              <strong>{scoreLabel(overview?.health?.score)}</strong>
              <div className="cas-meta">{overview?.health?.risk ?? status}</div>
            </div>
            <div className="cas-signal-card">
              <span>Warning Events</span>
              <strong>{signals.warning_events ?? 0}</strong>
              <div className="cas-meta">최근 scope</div>
            </div>
            <div className="cas-signal-card">
              <span>Restart Spikes</span>
              <strong>{signals.restart_spikes ?? 0}</strong>
              <div className="cas-meta">pod restart</div>
            </div>
            <div className="cas-signal-card">
              <span>Risk Workloads</span>
              <strong>{signals.risky_workloads ?? 0}</strong>
              <div className="cas-meta">top targets</div>
            </div>
          </div>

          <div className="cas-cockpit-grid">
            <article className="cas-cockpit-panel" data-test="cas-rca-candidate">
              <div className="cas-panel-heading">
                <strong>RCA Candidate</strong>
                <span className="cas-risk-pill" data-risk={overview?.health?.risk ?? "low"}>
                  {overview?.health?.risk ?? "unknown"}
                </span>
              </div>
              <div>{candidate?.cause ?? overview?.health?.summary ?? "Overview를 불러오는 중입니다."}</div>
              <div className="cas-meta">
                confidence {confidenceLabel(candidate?.confidence)} · evidence {(candidate?.evidence_refs ?? []).join(", ") || "pending"}
              </div>
              {overview?.health?.summary && <div className="cas-meta">{overview.health.summary}</div>}
            </article>

            <article className="cas-cockpit-panel" data-test="cas-risk-workloads">
              <div className="cas-panel-heading">
                <strong>Risk Workloads</strong>
                <span className="cas-meta">Top {riskWorkloads.length}</span>
              </div>
              <div className="cas-risk-list">
                {riskWorkloads.slice(0, 5).map((workload) => (
                  <button
                    className="cas-risk-row"
                    disabled={isRunning}
                    key={`${workload.namespace}-${workload.kind}-${workload.name}`}
                    onClick={() => onSelectWorkload(workload)}
                    type="button"
                  >
                    <div className="cas-row-main">
                      <strong>{workload.name}</strong>
                      <span className="cas-risk-pill" data-risk={workload.risk}>
                        {workload.risk}
                      </span>
                    </div>
                    <div className="cas-meta">
                      {workload.namespace} · {workload.kind} · {workload.status} · restarts {workload.restarts ?? 0}
                    </div>
                    <div className="cas-meta">{workload.reason}</div>
                  </button>
                ))}
                {riskWorkloads.length === 0 && <div className="cas-meta">현재 scope에서 위험 workload가 없습니다.</div>}
              </div>
            </article>
          </div>
        </>
      )}

      {activeView === "evidence" && (
        <div className="cas-cockpit-grid">
          <article className="cas-cockpit-panel" data-test="cas-event-reasons">
            <div className="cas-panel-heading">
              <strong>Event Reasons</strong>
              <span className="cas-meta">warning</span>
            </div>
            <div className="cas-reason-list">
              {eventReasons.map((item) => (
                <div className="cas-reason-row" key={item.reason}>
                  <div className="cas-row-main">
                    <strong>{item.reason}</strong>
                    <span className="cas-meta">{item.count}</span>
                  </div>
                </div>
              ))}
              {eventReasons.length === 0 && <div className="cas-meta">Warning event reason이 없습니다.</div>}
            </div>
          </article>

          <article className="cas-cockpit-panel" data-test="cas-overview-missing">
            <div className="cas-panel-heading">
              <strong>Missing Evidence</strong>
              <span className="cas-meta">{missing.length}</span>
            </div>
            <div className="cas-missing-list">
              {missing.slice(0, 4).map((item) => (
                <div className="cas-missing-item" key={`${item.type}-${item.reason}`}>
                  <strong>{item.type}</strong>
                  <div className="cas-meta">{item.reason}</div>
                </div>
              ))}
              {missing.length === 0 && <div className="cas-meta">부족한 증적이 없습니다.</div>}
            </div>
          </article>

          <article className="cas-cockpit-panel" data-wide="true" data-test="cas-evidence-timeline">
            <div className="cas-panel-heading">
              <strong>Evidence Timeline</strong>
              <span className="cas-meta">{timeline.length} signals</span>
            </div>
            <div className="cas-timeline-list">
              {timeline.slice(0, 8).map((item, index) => (
                <div className="cas-timeline-row" key={`${item.ts}-${item.summary}-${index}`}>
                  <strong>
                    {formatTimelineTime(item.ts)} · {item.type}
                  </strong>
                  <div>{item.summary}</div>
                  <div className="cas-meta">{item.source}</div>
                </div>
              ))}
              {timeline.length === 0 && <div className="cas-meta">아직 timeline evidence가 없습니다.</div>}
            </div>
          </article>
        </div>
      )}

      {activeView === "actions" && (
        <div className="cas-cockpit-grid">
          <article className="cas-cockpit-panel" data-test="cas-action-queue">
            <div className="cas-panel-heading">
              <strong>Action Queue</strong>
              <span className="cas-meta">{actions.length} actions</span>
            </div>
            <div className="cas-action-list">
              {actions.slice(0, 6).map((action) => (
                <div className="cas-action-row" key={`${action.type}-${action.label}`}>
                  <span>{action.label}</span>
                  {action.type === "cas_query" && action.question ? (
                    <button className="cas-link-button" disabled={isRunning} onClick={() => onRunQuestion(action.question ?? "")} type="button">
                      Run
                    </button>
                  ) : (
                    <a className="cas-link-button" href={action.href ?? "/"} rel="noreferrer">
                      Open
                    </a>
                  )}
                </div>
              ))}
              {actions.length === 0 && <div className="cas-meta">아직 추천 행동이 없습니다.</div>}
            </div>
          </article>

          <article className="cas-cockpit-panel" data-test="cas-risk-workloads">
            <div className="cas-panel-heading">
              <strong>Run RCA Targets</strong>
              <span className="cas-meta">Top {riskWorkloads.length}</span>
            </div>
            <div className="cas-risk-list">
              {riskWorkloads.slice(0, 5).map((workload) => (
                <button
                  className="cas-risk-row"
                  disabled={isRunning}
                  key={`${workload.namespace}-${workload.kind}-${workload.name}`}
                  onClick={() => onSelectWorkload(workload)}
                  type="button"
                >
                  <div className="cas-row-main">
                    <strong>{workload.name}</strong>
                    <span className="cas-risk-pill" data-risk={workload.risk}>
                      {workload.risk}
                    </span>
                  </div>
                  <div className="cas-meta">
                    {workload.namespace} · {workload.kind} · {workload.status}
                  </div>
                </button>
              ))}
              {riskWorkloads.length === 0 && <div className="cas-meta">현재 실행 가능한 RCA target이 없습니다.</div>}
            </div>
          </article>
        </div>
      )}
    </section>
  );
}

function EvidenceSummary({ result }: { result: RCAResult }) {
  const causes = result.rca_result?.cause_candidates ?? [];
  const evidence = result.evidence_bundle?.evidence ?? [];
  const missing = result.evidence_bundle?.missing ?? [];
  const total = causes.length + evidence.length + missing.length;

  if (total === 0) return null;

  return (
    <details className="cas-result-details" data-test="cas-evidence-panel">
      <summary>
        근거 {evidence.length}개 · RCA 후보 {causes.length}개 · 부족한 증적 {missing.length}개
      </summary>
      <div className="cas-result-details-body">
      {causes.length > 0 && (
        <div className="cas-cause-list" data-test="cas-cause-list">
          {causes.map((cause) => (
            <div className="cas-cause" key={`${cause.cause}-${cause.confidence}`}>
              <strong>{cause.cause}</strong>
              <div className="cas-meta">
                confidence {Math.round(Number(cause.confidence || 0) * 100)}% · evidence{" "}
                {(cause.evidence_refs ?? []).join(", ") || "none"}
              </div>
            </div>
          ))}
        </div>
      )}

      {evidence.length > 0 && (
        <div className="cas-evidence-list">
          <strong className="cas-section-title">증적</strong>
          {evidence.map((item) => (
            <div className="cas-evidence-item" key={item.id}>
              <strong>{item.id}</strong>
              <div>{item.summary}</div>
              <span>{item.source}</span>
            </div>
          ))}
        </div>
      )}

      {missing.length > 0 && (
        <div className="cas-missing-list" data-test="cas-missing-evidence">
          <strong className="cas-section-title">부족한 증적</strong>
          {missing.map((item) => (
            <div className="cas-missing-item" key={`${item.type}-${item.reason}`}>
              <strong>{item.type}</strong>
              <div className="cas-meta">{item.reason}</div>
            </div>
          ))}
        </div>
      )}
      </div>
    </details>
  );
}

export function CASLauncher() {
  const [isOpen, setIsOpen] = React.useState(false);
  const [activeView, setActiveView] = React.useState<ActiveView>("chat");
  const [question, setQuestion] = React.useState("");
  const [questionSuggestions, setQuestionSuggestions] = React.useState(() => pickQuestionSuggestions());
  const [activeSuggestionIndex, setActiveSuggestionIndex] = React.useState(0);
  const [showSuggestions, setShowSuggestions] = React.useState(true);
  const [showTargetControls, setShowTargetControls] = React.useState(false);
  const [namespace, setNamespace] = React.useState("default");
  const [resourceName, setResourceName] = React.useState("version");
  const [resourceKind, setResourceKind] = React.useState("ClusterVersion");
  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const [isRunning, setIsRunning] = React.useState(false);
  const [copiedMessageId, setCopiedMessageId] = React.useState<string | null>(null);
  const [overviewStatus, setOverviewStatus] = React.useState<"idle" | "loading" | "ready" | "degraded">("idle");
  const [overview, setOverview] = React.useState<OverviewResult | null>(null);
  const [brainStatus, setBrainStatus] = React.useState<BrainStatus>({
    state: "checking",
    provider: "openshift-lightspeed",
    detail: "연결 확인 중"
  });
  const [messages, setMessages] = React.useState<ChatMessage[]>([
    {
      id: "system-ready",
      role: "system",
      content: "CAS가 OpenShift Lightspeed 기능을 내부 뇌로 사용해 읽기 전용 분석을 수행합니다."
    }
  ]);
  const chatThreadRef = React.useRef<HTMLDivElement | null>(null);
  const abortControllerRef = React.useRef<AbortController | null>(null);
  const activeSuggestion = questionSuggestions[activeSuggestionIndex] ?? initialQuestion;
  const targetSummary = `${namespace || "default"} · ${resourceKind || "Resource"}/${resourceName || "name"}`;

  const rotateQuestionSuggestions = React.useCallback(() => {
    setQuestionSuggestions(pickQuestionSuggestions());
    setActiveSuggestionIndex(0);
    setShowSuggestions(true);
  }, []);

  const refreshBrainStatus = React.useCallback(async () => {
    setBrainStatus((current) => ({ ...current, state: "checking", detail: "연결 확인 중" }));
    try {
      const response = await fetch(`${API_BASE}/api/aiops/brainz`, {
        credentials: "same-origin",
        headers: gatewayHeaders({ accept: "application/json" })
      });
      const body = await response.json();
      const provider = body?.brain?.provider ?? "openshift-lightspeed";
      if (!response.ok || body?.status !== "ok") {
        setBrainStatus({
          state: "degraded",
          provider,
          detail: "Gateway는 응답하지만 Lightspeed readiness가 degraded입니다."
        });
        return;
      }
      setBrainStatus({
        state: "ready",
        provider,
        detail: "OpenShift Lightspeed readiness 확인됨"
      });
    } catch (error) {
      setBrainStatus({
        state: "degraded",
        provider: "openshift-lightspeed",
        detail: error instanceof Error ? error.message : "brainz 확인 실패"
      });
    }
  }, []);

  React.useEffect(() => {
    if (isOpen) void refreshBrainStatus();
  }, [isOpen, refreshBrainStatus]);

  const refreshOverview = React.useCallback(async () => {
    setOverviewStatus("loading");
    try {
      const response = await fetch(`${API_BASE}/api/aiops/overview?namespace=${encodeURIComponent(namespace || "default")}`, {
        credentials: "same-origin",
        headers: gatewayHeaders({ accept: "application/json" })
      });
      const body = (await response.json()) as OverviewResult;
      setOverview(body);
      setOverviewStatus(response.ok && body.mode === "overview_read_only" ? "ready" : "degraded");
    } catch {
      setOverview(null);
      setOverviewStatus("degraded");
    }
  }, [namespace]);

  React.useEffect(() => {
    if (isOpen) void refreshOverview();
  }, [isOpen]);

  React.useEffect(() => {
    if (isOpen && activeView === "chat") {
      chatThreadRef.current?.scrollTo({
        top: chatThreadRef.current.scrollHeight,
        behavior: "smooth"
      });
    }
  }, [activeView, isOpen, messages]);

  const openView = React.useCallback(
    (view: ActiveView) => {
      setActiveView(view);
      if (view !== "chat" && overviewStatus === "idle") {
        void refreshOverview();
      }
    },
    [overviewStatus, refreshOverview]
  );

  const copyMessage = React.useCallback(async (message: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedMessageId(message.id);
      window.setTimeout(() => setCopiedMessageId((current) => (current === message.id ? null : current)), 1200);
    } catch {
      setCopiedMessageId(null);
    }
  }, []);

  const submitQuestion = React.useCallback(
    async (questionText: string, nextResourceName?: string, nextNamespace?: string, nextResourceKind?: string) => {
      if (isRunning) return;
      const submittedQuestion = normalizeQuestion(questionText);
      const targetResourceName = nextResourceName ?? resourceName;
      const targetNamespace = nextNamespace ?? namespace;
      const targetResourceKind = nextResourceKind ?? resourceKind;
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      const userMessage: ChatMessage = {
        id: createMessageId("user"),
        role: "user",
        content: submittedQuestion
      };
      const pendingMessageId = createMessageId("assistant");
      setMessages((current) => [
        ...current,
        userMessage,
        {
          id: pendingMessageId,
          role: "assistant",
          content: "분석 중입니다. Gateway를 통해 Lightspeed brain에 질의하고 있습니다.",
          question: submittedQuestion,
          isPending: true
        }
      ]);
      setIsRunning(true);
      setActiveView("chat");
      setQuestion("");
      setShowSuggestions(false);

      try {
        const response = await fetch(`${API_BASE}/api/aiops/query`, {
          method: "POST",
          credentials: "same-origin",
          signal: abortController.signal,
          headers: gatewayHeaders({
            "content-type": "application/json",
            accept: "application/json"
          }),
          body: JSON.stringify({
            question: submittedQuestion,
            scope: {
              cluster: "local-cluster",
              namespaces: [targetNamespace || "default"]
            },
            resourceRef: {
              kind: targetResourceKind || (targetResourceName === "version" ? "ClusterVersion" : "Pod"),
              name: targetResourceName || "version"
            },
            mode: "read_only",
            stream: false,
            locale: "ko-KR",
            conversation_id: conversationId
          })
        });

        if (!response.ok) {
          throw new Error(await gatewayErrorMessage(response));
        }

        const body = (await response.json()) as RCAResult;
        setConversationId(body.conversation_id ?? conversationId);
        setMessages((current) =>
          current.map((message) =>
            message.id === pendingMessageId
              ? {
                  ...message,
                  content: body.rca_result?.answer ?? "Gateway 응답은 도착했지만 answer 필드가 비어 있습니다.",
                  isPending: false,
                  result: body
                }
              : message
          )
        );
      } catch (queryError) {
        const isAbort = queryError instanceof DOMException && queryError.name === "AbortError";
        setMessages((current) =>
          current.map((message) =>
            message.id === pendingMessageId
              ? {
                  ...message,
                  content: isAbort ? "요청을 중지했습니다." : queryError instanceof Error ? queryError.message : "분석 요청에 실패했습니다.",
                  isPending: false
                }
              : message
          )
        );
      } finally {
        if (abortControllerRef.current === abortController) {
          abortControllerRef.current = null;
          setIsRunning(false);
        }
        rotateQuestionSuggestions();
      }
    },
    [conversationId, isRunning, namespace, resourceKind, resourceName, rotateQuestionSuggestions]
  );

  const runQuery = React.useCallback(
    async (event?: React.FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      await submitQuestion(normalizeQuestion(question, activeSuggestion));
    },
    [activeSuggestion, question, submitQuestion]
  );

  const stopQuery = React.useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  const retryMessage = React.useCallback(
    (message: ChatMessage) => {
      if (message.question) {
        void submitQuestion(message.question);
      }
    },
    [submitQuestion]
  );

  const submitSuggestion = React.useCallback(
    (suggestion: string, index: number) => {
      setActiveSuggestionIndex(index);
      setShowSuggestions(false);
      void submitQuestion(suggestion);
    },
    [submitQuestion]
  );

  const handleQuestionKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        if (!isRunning) {
          void submitQuestion(normalizeQuestion(question, activeSuggestion));
        }
      }
    },
    [activeSuggestion, isRunning, question, submitQuestion]
  );

  const runOverviewQuestion = React.useCallback(
    (nextQuestion: string, nextResourceName?: string, nextNamespace?: string, nextResourceKind?: string) => {
      setQuestion(nextQuestion);
      if (nextResourceName) setResourceName(nextResourceName);
      if (nextNamespace) setNamespace(nextNamespace);
      if (nextResourceKind) setResourceKind(nextResourceKind);
      setActiveView("chat");
      void submitQuestion(nextQuestion, nextResourceName, nextNamespace, nextResourceKind);
    },
    [submitQuestion]
  );

  const selectWorkload = React.useCallback(
    (workload: RiskWorkload) => {
      const nextQuestion = `${workload.namespace} namespace ${workload.name} ${workload.kind} 원인 분석해줘`;
      runOverviewQuestion(nextQuestion, workload.name, workload.namespace, workload.kind);
    },
    [runOverviewQuestion]
  );

  const resetConversation = React.useCallback(() => {
    abortControllerRef.current?.abort();
    setConversationId(null);
    setIsRunning(false);
    setCopiedMessageId(null);
    setActiveView("chat");
    setQuestion("");
    setShowTargetControls(false);
    rotateQuestionSuggestions();
    setMessages([
      {
        id: "system-ready",
        role: "system",
        content: "새 대화를 시작했습니다. CAS는 읽기 전용 분석만 수행합니다."
      }
    ]);
  }, [rotateQuestionSuggestions]);

  return (
    <div className="cas-launcher-root" data-test="cas-launcher-root">
      <style>{styles}</style>
      {isOpen && (
        <section aria-label="Cywell AI Sentinel" className="cas-panel" data-test="cas-launcher-panel" role="dialog">
          <header className="cas-panel-header">
            <SentinelIcon />
            <div className="cas-panel-title">
              <strong>Cywell AI Sentinel</strong>
              <span>OpenShift RCA Agent · Lightspeed replacement</span>
            </div>
            <div className="cas-header-tools">
              <nav aria-label="AI Sentinel views" className="cas-view-switcher" data-test="cas-view-switcher">
                {(["chat", "cockpit", "evidence", "actions"] as ActiveView[]).map((view) => (
                  <button
                    aria-label={viewLabel(view)}
                    className="cas-view-button"
                    data-active={activeView === view}
                    data-test={`cas-view-${view}`}
                    key={view}
                    onClick={() => openView(view)}
                    title={viewLabel(view)}
                    type="button"
                  >
                    <ViewIcon view={view} />
                  </button>
                ))}
              </nav>
              <button aria-label="Close AI Sentinel" className="cas-close" onClick={() => setIsOpen(false)} type="button">
                x
              </button>
            </div>
          </header>

          <div className="cas-panel-body">
            <div className="cas-status-row">
              <span className="cas-badge" data-state={brainStatus.state} data-test="cas-brain-status">
                {brainStatus.state === "checking" ? "checking" : brainStatus.state} · {brainStatus.provider}
              </span>
              <span className="cas-badge" data-test="cas-provider-badge">
                UserToken proxy
              </span>
              {conversationId && (
                <span className="cas-conversation" data-test="cas-conversation-id">
                  conversation {conversationId}
                </span>
              )}
            </div>

            <div className="cas-meta">{brainStatus.detail}</div>

            {activeView === "chat" ? (
              <div className="cas-chat-surface" data-test="cas-chat-default-view">
                <div className="cas-chat-topline">
                  <span className="cas-badge" data-state={overviewStatus === "ready" ? "ready" : "degraded"}>
                    Health {scoreLabel(overview?.health?.score)} · {overview?.health?.risk ?? overviewStatus}
                  </span>
                  <button className="cas-link-button" onClick={() => openView("cockpit")} type="button">
                    Open Cockpit
                  </button>
                </div>

                <div className="cas-chat-thread" data-test="cas-chat-thread" ref={chatThreadRef}>
                  {messages.map((message) => {
                    const isFallback = message.result?.mode === "lightspeed_fallback_mock";
                    return (
                      <article
                        className="cas-message"
                        data-pending={message.isPending ? "true" : "false"}
                        data-role={message.role}
                        data-test={`cas-message-${message.role}`}
                        key={message.id}
                      >
                        <strong className="cas-message-role">
                          {message.role === "user" ? "운영자" : message.role === "assistant" ? "AI Sentinel" : "시스템"}
                        </strong>
                        <p className="cas-answer" data-primary={message.role === "assistant" && message.result ? "true" : "false"}>
                          {message.content}
                        </p>
                        {message.result && (
                          <>
                            <div className="cas-result-meta">
                              <span className="cas-meta">
                                {modeLabel(message.result.mode)} · {resultProvider(message.result)}
                              </span>
                              {message.result.run_id ? ` · ${message.result.run_id}` : ""}
                            </div>
                            {isFallback && (
                              <div className="cas-badge" data-state="degraded" data-test="cas-fallback-notice">
                                fallback active
                              </div>
                            )}
                            <EvidenceSummary result={message.result} />
                          </>
                        )}
                        {message.role === "assistant" && (
                          <div className="cas-message-tools">
                            <button className="cas-link-button" onClick={() => void copyMessage(message)} type="button">
                              {copiedMessageId === message.id ? "Copied" : "Copy"}
                            </button>
                            {message.question && (
                              <button
                                className="cas-link-button"
                                disabled={isRunning || message.isPending}
                                onClick={() => retryMessage(message)}
                                type="button"
                              >
                                Retry
                              </button>
                            )}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>

                <form className="cas-compose" onSubmit={runQuery}>
                  {showSuggestions && question.trim().length === 0 && (
                    <div aria-label="추천 질문" className="cas-suggestion-list" data-test="cas-suggestion-list">
                      {questionSuggestions.map((suggestion, index) => (
                        <button
                          className="cas-suggestion"
                          data-active={activeSuggestionIndex === index}
                          data-test="cas-suggestion"
                          disabled={isRunning}
                          key={suggestion}
                          onClick={() => submitSuggestion(suggestion, index)}
                          onMouseEnter={() => setActiveSuggestionIndex(index)}
                          type="button"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="cas-input-wrap">
                    <textarea
                      aria-label="AI Sentinel question"
                      onBlur={() => {
                        if (question.trim().length === 0) setShowSuggestions(true);
                      }}
                      onChange={(event) => {
                        setQuestion(event.currentTarget.value);
                        setShowSuggestions(false);
                      }}
                      onFocus={() => setShowSuggestions(false)}
                      onKeyDown={handleQuestionKeyDown}
                      placeholder={showSuggestions ? activeSuggestion : "OpenShift 운영 질문을 입력하세요. Enter 전송, Shift+Enter 줄바꿈"}
                      value={question}
                    />
                    {isRunning ? (
                      <button
                        aria-label="분석 중지"
                        className="cas-send-button"
                        data-test="cas-stop-analysis"
                        onClick={stopQuery}
                        title="중지"
                        type="button"
                      >
                        <SendIcon mode="stop" />
                      </button>
                    ) : (
                      <button
                        aria-label="질의 전송"
                        className="cas-send-button"
                        data-test="cas-send-question"
                        title="질의"
                        type="submit"
                      >
                        <SendIcon mode="send" />
                      </button>
                    )}
                  </div>
                  <div className="cas-compose-toolbar">
                    <button
                      aria-expanded={showTargetControls}
                      className="cas-link-button cas-target-toggle"
                      onClick={() => setShowTargetControls((current) => !current)}
                      type="button"
                    >
                      Target {targetSummary}
                    </button>
                    <span className="cas-meta">추천 질문 {questionSuggestions.length}개 · Enter 전송</span>
                  </div>
                  {showTargetControls && (
                    <div className="cas-fields" data-test="cas-target-fields">
                      <input
                        aria-label="Namespace"
                        onChange={(event) => setNamespace(event.currentTarget.value)}
                        placeholder="namespace"
                        value={namespace}
                      />
                      <input
                        aria-label="Resource name"
                        onChange={(event) => setResourceName(event.currentTarget.value)}
                        placeholder="resource"
                        value={resourceName}
                      />
                      <input
                        aria-label="Resource kind"
                        onChange={(event) => setResourceKind(event.currentTarget.value)}
                        placeholder="kind"
                        value={resourceKind}
                      />
                    </div>
                  )}
                  <div className="cas-actions">
                    <button className="cas-secondary" disabled={isRunning} onClick={resetConversation} type="button">
                      새 대화
                    </button>
                  </div>
                </form>
              </div>
            ) : (
              <OverviewCockpit
                activeView={activeView}
                overview={overview}
                status={overviewStatus}
                onRefresh={refreshOverview}
                onRunQuestion={runOverviewQuestion}
                onSelectWorkload={selectWorkload}
                isRunning={isRunning}
              />
            )}
          </div>
        </section>
      )}
      <button
        aria-label="Cywell AI Sentinel"
        className="cas-launcher-button"
        data-test="cas-launcher-button"
        onClick={() => setIsOpen((current) => !current)}
        title="Cywell AI Sentinel"
        type="button"
      >
        <SentinelIcon />
      </button>
    </div>
  );
}

export function useCASLauncher() {
  return React.useMemo(() => ({ surface: "cas-launcher" }), []);
}

export default useCASLauncher;
