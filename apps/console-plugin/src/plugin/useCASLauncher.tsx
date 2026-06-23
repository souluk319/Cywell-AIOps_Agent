import * as React from "react";

const API_BASE = "/api/proxy/plugin/cywell-ai-sentinel/cas-api";
const CSRF_COOKIE_NAME = "csrf-token";
const TUTORIAL_STORAGE_KEY = "cas:onboarding:v0.1.1";

type CauseCandidate = {
  cause: string;
  confidence: number;
  evidence_refs?: string[];
};

type EvidenceItem = {
  id: string;
  type?: string;
  source: string;
  summary: string;
  observed_at?: string;
  score?: number;
  query?: string;
};

type MissingEvidence = {
  type: string;
  reason: string;
};

type RCAResult = {
  run_id?: string;
  mode?: string;
  conversation_id?: string | null;
  tool_plan?: {
    task_type?: string;
    tool_plan?: Array<{ step?: number; tool?: string; verb?: string; optional?: boolean }>;
  };
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
    evidence_status?: EvidenceStatus[];
  };
};

type EvidenceStatus = {
  type: "openshift" | "metric" | "runbook" | string;
  status: "collected" | "missing" | string;
  count: number;
  reason?: string;
};

type BrainStatus = {
  state: "checking" | "ready" | "degraded";
  provider: string;
  detail: string;
};

type ActiveView = "chat" | "cockpit" | "evidence" | "actions" | "simulation";
type Language = "ko" | "en";
type ChatMode = "ask" | "troubleshooting";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  question?: string;
  isPending?: boolean;
  result?: RCAResult;
  simulation?: {
    scenarioId: string;
    actionId?: string;
  };
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
  evidence_groups?: {
    openshift?: EvidenceItem[];
    metric?: EvidenceItem[];
    runbook?: EvidenceItem[];
    missing?: MissingEvidence[];
  };
  evidence_status?: EvidenceStatus[];
  actions?: OverviewAction[];
  missing?: MissingEvidence[];
};

type SimulationRemediation = {
  id: string;
  label: string;
  description?: string;
  question?: string;
  expectedOutcome?: string;
  followUps?: string[];
};

type SimulationScenario = {
  id: string;
  title: string;
  summary?: string;
  category?: string;
  risk?: string;
  question: string;
  learning?: {
    objective?: string;
    checkpoints?: string[];
    cycle?: string[];
    followUps?: string[];
  };
  target: {
    namespace: string;
    kind: string;
    name: string;
    container?: string;
  };
  signals?: {
    warnings?: number;
    restarts?: number;
    metric_series?: number;
  };
  remediations?: SimulationRemediation[];
};

type QueryTarget = {
  namespace: string;
  kind: string;
  name: string;
};

type TargetCatalog = {
  mode?: string;
  targets?: QueryTarget[];
  missing?: MissingEvidence[];
};

type StreamEvent = {
  event: string;
  data: unknown;
};

type TutorialStep = {
  id: string;
  title: string;
  body: string;
  hint: string;
  view?: ActiveView;
  targetOpen?: boolean;
};

type MarkdownBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "code"; text: string };

const initialQuestionByLanguage: Record<Language, string> = {
  ko: "ClusterVersion 상태를 한 문장으로 요약해줘.",
  en: "Summarize the ClusterVersion status in one sentence."
};
const localeByLanguage: Record<Language, string> = {
  ko: "ko-KR",
  en: "en-US"
};
const RECOMMENDED_QUESTION_COUNT = 5;
const OCP_AIOPS_QUESTION_BANK_KO = [
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
const OCP_AIOPS_QUESTION_BANK_EN = [
  "Summarize the ClusterVersion status in one sentence.",
  "Check whether any ClusterOperator is currently degraded.",
  "Find high-risk workloads in the default namespace and summarize likely causes.",
  "Show the resources most likely to be impacted based on recent Warning events.",
  "Analyze the scheduling failure cause if any Pods are Pending.",
  "Identify CrashLoopBackOff Pods and summarize restart cause candidates.",
  "Find Pods that were OOMKilled and explain them from the memory limit perspective.",
  "Check whether ImagePullBackOff or ErrImagePull events exist.",
  "Summarize workloads with recent restart spikes and their possible impact.",
  "Check whether any Node is NotReady or has pressure conditions.",
  "Find Pod or Node signals that suggest CPU pressure.",
  "Find Pod or Node signals that suggest memory pressure.",
  "Look for PVC Pending or volume mount failure events.",
  "Check whether any Service has empty endpoints.",
  "Assess Route or Ingress connectivity failure signals.",
  "Find deployments with stalled rollouts and likely causes.",
  "Find workloads where ReplicaSet and Pod counts do not match the expected state.",
  "Recommend safe next checks based on recent FailedScheduling events.",
  "Find resources with repeated readiness probe failures.",
  "Find resources with repeated liveness probe failures.",
  "Summarize top Warning event reasons by namespace.",
  "Summarize control plane operator status from an operator perspective.",
  "Check whether there are risk signals for the current cluster update.",
  "Tell me the current OpenShift version and update progress.",
  "Pick the top three incident candidates from recent events.",
  "Separate collected evidence from missing evidence for incident response.",
  "Suggest safe read-only commands for the next investigation step.",
  "Build RCA candidates from events and status only, without Prometheus metrics.",
  "Check for API server or authentication operator warning signals.",
  "Look for network operator or DNS-related warning signals.",
  "Check image registry operator status and related events.",
  "Summarize any Monitoring stack health issues.",
  "Check OpenShift Console Pods or operator health.",
  "Check whether any MachineConfigPool update is stuck.",
  "Summarize Node readiness and possible taint impact.",
  "Choose the riskiest Pod in a namespace and start RCA.",
  "List possible causes from Pod status and events without logs.",
  "Find workloads that may have broken after a recent deployment.",
  "Check whether HPA or resource shortage is causing replica instability.",
  "Identify resources with the highest possible user impact.",
  "Find Pod events that suggest security or permission failures.",
  "Check for ConfigMap or Secret mount failure signals.",
  "Check whether CNI or NetworkPolicy may be causing connectivity failures.",
  "Check for storage attach or detach failure events.",
  "Summarize the top five signals an operator should inspect now.",
  "Draft a short incident report from the current cluster state.",
  "Summarize the current state for shift handoff.",
  "Create an evidence checklist before starting RCA.",
  "Separate safe checks from risky actions for the current cluster.",
  "Recommend the next analysis questions based on evidence collected by CAS."
];
const OCP_AIOPS_QUESTION_BANK: Record<Language, string[]> = {
  ko: OCP_AIOPS_QUESTION_BANK_KO,
  en: OCP_AIOPS_QUESTION_BANK_EN
};
const languageCopy: Record<
  Language,
  {
    suggestionLabel: string;
    inputPlaceholder: string;
    sendLabel: string;
    stopLabel: string;
    newChat: string;
    recommendationMeta: string;
    openCockpit: string;
    scrollBottom: string;
    statusConnected: string;
    statusChecking: string;
    statusDegraded: string;
    pending: string;
    abort: string;
    failure: string;
    emptyAnswer: string;
    systemReady: string;
    systemReset: string;
    subtitle: string;
    targetPrefix: string;
    targetTitle: string;
    targetCurrent: string;
    targetNamespace: string;
    targetKind: string;
    targetName: string;
    targetApply: string;
    targetClose: string;
    modeSelectorLabel: string;
    modeLabels: Record<ChatMode, string>;
    modeDescriptions: Record<ChatMode, string>;
    modeTitles: Record<ChatMode, string>;
    languageTitle: string;
    tutorialLabel: string;
    tutorialTitle: string;
    tutorialSkip: string;
    tutorialBack: string;
    tutorialNext: string;
    tutorialDone: string;
    tutorialProgress: (current: number, total: number) => string;
    tutorialSteps: TutorialStep[];
    viewLabels: Record<ActiveView, string>;
    viewsNavLabel: string;
    closeLabel: string;
    refresh: string;
    refreshing: string;
    health: string;
    warningEvents: string;
    recentScope: string;
    restartSpikes: string;
    podRestart: string;
    riskWorkloads: string;
    topTargets: string;
    top: string;
    restarts: string;
    rcaCandidate: string;
    overviewLoading: string;
    confidence: string;
    evidence: string;
    none: string;
    pendingEvidence: string;
    noRiskWorkloads: string;
    eventReasons: string;
    warning: string;
    noWarningEventReasons: string;
    missingEvidence: string;
    noMissingEvidence: string;
    evidenceStatus: string;
    openshiftEvidence: string;
    metricEvidence: string;
    runbookEvidence: string;
    toolPlan: string;
    rcaTrace: string;
    brain: string;
    whyThisMatters: string;
    whyOpenShift: string;
    whyMetric: string;
    whyRunbook: string;
    metricProvider: string;
    evidenceTimeline: string;
    signals: string;
    noTimelineEvidence: string;
    actionQueue: string;
    actionCount: string;
    run: string;
    open: string;
    noActions: string;
    runRcaTargets: string;
    noRcaTargets: string;
    evidenceSummary: (evidence: number, causes: number, missing: number) => string;
    evidenceSection: string;
    missingSection: string;
    simulationLab: string;
    simulationLoading: string;
    simulationIntro: string;
    simulationRun: string;
    simulationFix: string;
    simulationSignals: string;
    simulationNoScenarios: string;
    simulationLearning: string;
    simulationCycle: string;
    simulationOutcome: string;
    simulationNext: string;
    simulationBackToLab: string;
  }
> = {
  ko: {
    suggestionLabel: "자주 확인",
    inputPlaceholder: "무엇을 확인할까요?",
    sendLabel: "질의 전송",
    stopLabel: "분석 중지",
    newChat: "새 대화",
    recommendationMeta: "자주 확인 5개 · Enter 전송",
    openCockpit: "상황 열기",
    scrollBottom: "아래로",
    statusConnected: "연결됨",
    statusChecking: "확인 중",
    statusDegraded: "점검 필요",
    pending: "자료 확인 중",
    abort: "요청을 중지했습니다.",
    failure: "분석 요청에 실패했습니다.",
    emptyAnswer: "Gateway 응답은 도착했지만 answer 필드가 비어 있습니다.",
    systemReady: "",
    systemReset: "",
    subtitle: "KOMSCO AI AGENT",
    targetPrefix: "대상 설정",
    targetTitle: "분석 대상",
    targetCurrent: "현재 대상",
    targetNamespace: "Namespace",
    targetKind: "Kind",
    targetName: "Name",
    targetApply: "적용",
    targetClose: "닫기",
    modeSelectorLabel: "질문 모드",
    modeLabels: {
      ask: "Ask",
      troubleshooting: "Troubleshooting"
    },
    modeDescriptions: {
      ask: "명확한 설명과 운영 가이드",
      troubleshooting: "장애 진단과 해결 방향 탐색"
    },
    modeTitles: {
      ask: "개념, 문서, 설정, 사용법 질문",
      troubleshooting: "Troubleshooting: 현재 클러스터 증적 기반 장애 분석"
    },
    languageTitle: "언어: 한국어. 영어로 전환",
    tutorialLabel: "튜토리얼 보기",
    tutorialTitle: "CAS 빠른 안내",
    tutorialSkip: "건너뛰기",
    tutorialBack: "이전",
    tutorialNext: "다음",
    tutorialDone: "시작하기",
    tutorialProgress: (current, total) => `${current} / ${total}`,
    tutorialSteps: [
      {
        id: "chat",
        title: "1. 먼저 채팅에서 시작합니다",
        body: "CAS는 Lightspeed 위치를 대체하는 AI 관제 챗봇입니다. 질문하면 Gateway가 OpenShift 증적, Metric, Runbook을 모아 답변합니다.",
        hint: "왼쪽 첫 아이콘은 채팅, 바로 옆 아이콘은 새 대화입니다.",
        view: "chat"
      },
      {
        id: "target",
        title: "2. 분석 대상을 정합니다",
        body: "Namespace, Kind, Name을 바꾸면 다음 질문부터 그 리소스를 기준으로 분석합니다. 이전 답변은 바뀌지 않습니다.",
        hint: "헤더의 조준점 아이콘이 대상 설정입니다.",
        view: "chat",
        targetOpen: true
      },
      {
        id: "situation",
        title: "3. 상황은 신호등처럼 봅니다",
        body: "상태 점수, 경고 이벤트, 재시작, 위험 워크로드를 먼저 봅니다. 여기서 문제 후보를 고르고 채팅 분석으로 넘길 수 있습니다.",
        hint: "상황 탭은 RCA를 시작하기 위한 조종석입니다.",
        view: "cockpit"
      },
      {
        id: "grounds",
        title: "4. 근거는 답변의 재료입니다",
        body: "OpenShift 이벤트, Pod 상태, 로그, Metric, Runbook hit, 부족한 증적을 분리해서 보여줍니다.",
        hint: "답변이 믿을 만한지 보려면 근거 탭과 답변 아래 근거 패널을 확인합니다.",
        view: "evidence"
      },
      {
        id: "actions",
        title: "5. 다음 확인은 안전한 질문부터 갑니다",
        body: "CAS v0.1.1은 읽기 전용입니다. 화면을 바로 이동시키지 않고 CAS가 확인 절차와 콘솔 위치를 먼저 설명합니다.",
        hint: "실제 변경, 재시작, scale, patch는 승인 이후의 별도 절차입니다.",
        view: "actions"
      },
      {
        id: "simulation",
        title: "6. 시뮬레이션은 학습 레일입니다",
        body: "시나리오에서 1. 문제 분석을 누르고, 답변 아래 2. 해결 시뮬레이션을 눌러 회복 여부까지 확인합니다.",
        hint: "OOMKilled, Pending, Probe 실패, ImagePullBackOff, PVC, NetworkPolicy 같은 케이스를 반복해서 익힙니다.",
        view: "simulation"
      },
      {
        id: "composer",
        title: "7. 입력창은 작게, 기능은 안쪽에 있습니다",
        body: "+ 버튼은 자주 확인하는 질문, Ask/Troubleshooting은 질문 모드, 오른쪽 버튼은 전송 또는 중지입니다.",
        hint: "답변을 읽는 중 스크롤을 올리면 자동 스크롤이 풀리고 아래로 버튼이 나타납니다.",
        view: "chat"
      }
    ],
    viewLabels: {
      chat: "채팅",
      cockpit: "상황",
      evidence: "근거",
      actions: "다음 확인",
      simulation: "시뮬레이션"
    },
    viewsNavLabel: "AI Sentinel 화면",
    closeLabel: "AI Sentinel 닫기",
    refresh: "새로고침",
    refreshing: "새로고침 중",
    health: "상태 점수",
    warningEvents: "경고 이벤트",
    recentScope: "최근 범위",
    restartSpikes: "재시작 급증",
    podRestart: "Pod 재시작",
    riskWorkloads: "위험 워크로드",
    topTargets: "상위 대상",
    top: "상위",
    restarts: "재시작",
    rcaCandidate: "원인 후보",
    overviewLoading: "Overview를 불러오는 중입니다.",
    confidence: "신뢰도",
    evidence: "근거",
    none: "없음",
    pendingEvidence: "대기 중",
    noRiskWorkloads: "현재 범위에서 위험 워크로드가 없습니다.",
    eventReasons: "이벤트 원인",
    warning: "경고",
    noWarningEventReasons: "경고 이벤트 원인이 없습니다.",
    missingEvidence: "부족한 증적",
    noMissingEvidence: "부족한 증적이 없습니다.",
    evidenceStatus: "근거 수집 상태",
    openshiftEvidence: "OpenShift 상태/이벤트",
    metricEvidence: "Metric 관측값",
    runbookEvidence: "Runbook 참고",
    toolPlan: "읽기 전용 Tool Plan",
    rcaTrace: "수집 흐름",
    brain: "Brain",
    whyThisMatters: "왜 보는가",
    whyOpenShift: "OpenShift 상태, 이벤트, 로그는 RCA의 1차 사실 근거입니다.",
    whyMetric: "재시작, 메모리, 포화 신호는 문제가 현재 진행 중인지 과거 상태인지 구분합니다.",
    whyRunbook: "Runbook은 원시 근거를 안전한 다음 확인 절차로 바꿉니다.",
    metricProvider: "Metric provider",
    evidenceTimeline: "OpenShift 이벤트 흐름",
    signals: "신호",
    noTimelineEvidence: "아직 타임라인 증적이 없습니다.",
    actionQueue: "다음 확인",
    actionCount: "개 항목",
    run: "실행",
    open: "열기",
    noActions: "아직 추천 확인 항목이 없습니다.",
    runRcaTargets: "원인 분석 대상",
    noRcaTargets: "현재 실행 가능한 원인 분석 대상이 없습니다.",
    evidenceSummary: (evidence, causes, missing) => `근거 ${evidence}개 · 원인 후보 ${causes}개 · 부족한 증적 ${missing}개`,
    evidenceSection: "근거",
    missingSection: "부족한 증적",
    simulationLab: "운영 시뮬레이션",
    simulationLoading: "시뮬레이션을 불러오는 중입니다.",
    simulationIntro: "목업 운영 세계를 선택하면 CAS가 실제처럼 증적, metric, Runbook을 수집해 분석합니다.",
    simulationRun: "문제 분석",
    simulationFix: "해결 시뮬레이션",
    simulationSignals: "신호",
    simulationNoScenarios: "시뮬레이션 시나리오가 없습니다.",
    simulationLearning: "학습 목표",
    simulationCycle: "사이클",
    simulationOutcome: "예상 회복",
    simulationNext: "다음으로 해볼 것",
    simulationBackToLab: "다른 시나리오"
  },
  en: {
    suggestionLabel: "Frequent checks",
    inputPlaceholder: "Ask about OpenShift operations",
    sendLabel: "Send question",
    stopLabel: "Stop analysis",
    newChat: "New chat",
    recommendationMeta: "5 frequent checks · Enter to send",
    openCockpit: "Open Situation",
    scrollBottom: "Bottom",
    statusConnected: "Connected",
    statusChecking: "Checking",
    statusDegraded: "Needs attention",
    pending: "Checking data",
    abort: "Request stopped.",
    failure: "Analysis request failed.",
    emptyAnswer: "The Gateway responded, but the answer field is empty.",
    systemReady: "",
    systemReset: "",
    subtitle: "KOMSCO AI AGENT",
    targetPrefix: "Target settings",
    targetTitle: "Analysis Target",
    targetCurrent: "Current target",
    targetNamespace: "Namespace",
    targetKind: "Kind",
    targetName: "Name",
    targetApply: "Apply",
    targetClose: "Close",
    modeSelectorLabel: "Question mode",
    modeLabels: {
      ask: "Ask",
      troubleshooting: "Troubleshooting"
    },
    modeDescriptions: {
      ask: "Explanations and operations guidance",
      troubleshooting: "Incident diagnosis and next steps"
    },
    modeTitles: {
      ask: "Concepts, docs, configuration, and how-to questions",
      troubleshooting: "Troubleshooting: live evidence-based incident analysis"
    },
    languageTitle: "Language: English. Switch to Korean",
    tutorialLabel: "Show tutorial",
    tutorialTitle: "CAS quick tour",
    tutorialSkip: "Skip",
    tutorialBack: "Back",
    tutorialNext: "Next",
    tutorialDone: "Start",
    tutorialProgress: (current, total) => `${current} / ${total}`,
    tutorialSteps: [
      {
        id: "chat",
        title: "1. Start in Chat",
        body: "CAS replaces the Lightspeed position as an AI operations chatbot. It gathers OpenShift evidence, metrics, and runbooks through the Gateway.",
        hint: "The first icon is Chat. The icon next to it starts a new conversation.",
        view: "chat"
      },
      {
        id: "target",
        title: "2. Set the analysis target",
        body: "Namespace, Kind, and Name affect the next question only. Previous answers are not rewritten.",
        hint: "Use the target icon in the header.",
        view: "chat",
        targetOpen: true
      },
      {
        id: "situation",
        title: "3. Read Situation like signals",
        body: "Health, warnings, restarts, and risky workloads show where RCA should start.",
        hint: "Situation is the cockpit for starting RCA.",
        view: "cockpit"
      },
      {
        id: "grounds",
        title: "4. Grounds are answer ingredients",
        body: "OpenShift events, pod status, logs, metrics, runbook hits, and missing evidence are separated.",
        hint: "Use Grounds and the folded answer evidence panel to judge trust.",
        view: "evidence"
      },
      {
        id: "actions",
        title: "5. Next Checks stay safe",
        body: "CAS v0.1.1 is read-only. It asks CAS for safe checks and Console locations instead of moving the browser directly.",
        hint: "Mutating actions require a separate approved change workflow.",
        view: "actions"
      },
      {
        id: "simulation",
        title: "6. Simulation is the learning rail",
        body: "Run 1. Analyze Issue, then use 2. recovery simulation under the answer to confirm recovery.",
        hint: "Practice OOMKilled, Pending, probes, ImagePullBackOff, PVC, and NetworkPolicy cases.",
        view: "simulation"
      },
      {
        id: "composer",
        title: "7. The composer keeps tools inside",
        body: "+ opens frequent checks, Ask/Troubleshooting selects mode, and the right button sends or stops.",
        hint: "When you scroll up during streaming, auto-scroll unlocks and the bottom button appears.",
        view: "chat"
      }
    ],
    viewLabels: {
      chat: "Chat",
      cockpit: "Situation",
      evidence: "Grounds",
      actions: "Next Checks",
      simulation: "Simulation"
    },
    viewsNavLabel: "AI Sentinel views",
    closeLabel: "Close AI Sentinel",
    refresh: "Refresh",
    refreshing: "Refreshing",
    health: "Health",
    warningEvents: "Warning Events",
    recentScope: "Recent scope",
    restartSpikes: "Restart Spikes",
    podRestart: "Pod restart",
    riskWorkloads: "Risk Workloads",
    topTargets: "Top targets",
    top: "Top",
    restarts: "restarts",
    rcaCandidate: "Cause Candidate",
    overviewLoading: "Loading overview.",
    confidence: "confidence",
    evidence: "evidence",
    none: "none",
    pendingEvidence: "pending",
    noRiskWorkloads: "No risky workloads in the current scope.",
    eventReasons: "Event Reasons",
    warning: "warning",
    noWarningEventReasons: "No Warning event reasons.",
    missingEvidence: "Missing Evidence",
    noMissingEvidence: "No missing evidence.",
    evidenceStatus: "Evidence Status",
    openshiftEvidence: "OpenShift status/events",
    metricEvidence: "Metric observations",
    runbookEvidence: "Runbook references",
    toolPlan: "Read-only Tool Plan",
    rcaTrace: "RCA Trace",
    brain: "Brain",
    whyThisMatters: "Why this matters",
    whyOpenShift: "OpenShift status, events, and logs are the primary RCA facts.",
    whyMetric: "Restart, memory, and saturation signals show whether the issue is current or historical.",
    whyRunbook: "Runbooks turn raw evidence into safe next checks.",
    metricProvider: "Metric provider",
    evidenceTimeline: "OpenShift Event Flow",
    signals: "signals",
    noTimelineEvidence: "No timeline evidence yet.",
    actionQueue: "Next Checks",
    actionCount: "checks",
    run: "Run",
    open: "Open",
    noActions: "No recommended checks yet.",
    runRcaTargets: "Cause Analysis Targets",
    noRcaTargets: "No cause analysis targets are available.",
    evidenceSummary: (evidence, causes, missing) => `${evidence} evidence · ${causes} cause candidates · ${missing} missing evidence`,
    evidenceSection: "Evidence",
    missingSection: "Missing Evidence",
    simulationLab: "Operations Simulation",
    simulationLoading: "Loading simulations.",
    simulationIntro: "Choose a mock operations world. CAS will collect synthetic evidence, metrics, and runbooks as if it were live.",
    simulationRun: "Analyze Issue",
    simulationFix: "Simulate Fix",
    simulationSignals: "Signals",
    simulationNoScenarios: "No simulation scenarios are available.",
    simulationLearning: "Learning goal",
    simulationCycle: "Cycle",
    simulationOutcome: "Expected recovery",
    simulationNext: "Try next",
    simulationBackToLab: "Other scenarios"
  }
};

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
  flex: 0 0 26px;
  height: 26px;
  width: 26px;
}

.cas-panel {
  background: var(--cas-surface);
  border: 1px solid var(--cas-line);
  border-radius: 8px;
  bottom: calc(var(--pf-t--global--spacer--2xl, 48px) + var(--pf-t--global--spacer--lg, 24px) + 10px);
  box-shadow: var(--pf-t--global--box-shadow--lg, 0 18px 44px rgba(3, 22, 30, 0.24));
  display: flex;
  flex-direction: column;
  height: min(760px, calc(100vh - 112px));
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
  flex: 0 0 auto;
  gap: 6px;
  min-height: 63px;
  padding: 12px;
}

.cas-header-tools {
  align-items: center;
  display: flex;
  flex: 0 0 auto;
  gap: 2px;
}

.cas-view-switcher {
  align-items: center;
  display: inline-flex;
  gap: 1px;
}

.cas-view-button {
  align-items: center;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--cas-muted);
  cursor: pointer;
  display: inline-flex;
  height: 28px;
  justify-content: center;
  padding: 0;
  width: 24px;
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
  height: 17px;
  width: 16px;
}

.cas-language-toggle {
  gap: 4px;
  width: 34px;
}

.cas-language-toggle span {
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
}

.cas-language-toggle svg {
  height: 16px;
  width: 16px;
}

.cas-panel-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
}

.cas-panel-title strong,
.cas-section-title,
.cas-message-role,
.cas-evidence-item strong {
  display: block;
}

.cas-panel-title span,
.cas-meta,
.cas-evidence-item span {
  color: var(--cas-muted);
  font-size: 12px;
}

.cas-panel-title strong,
.cas-panel-title span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cas-panel-title strong {
  font-size: 12.5px;
  line-height: 1.25;
}

.cas-panel-title span {
  display: block;
  font-size: 11px;
  line-height: 1.35;
}

.cas-close {
  align-items: center;
  background: transparent;
  border: 0;
  color: var(--cas-muted);
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  height: 28px;
  justify-content: center;
  padding: 0;
  width: 22px;
}

.cas-tutorial-overlay {
  align-items: end;
  background: linear-gradient(180deg, rgba(15, 23, 42, 0.18), rgba(15, 23, 42, 0.34));
  border-radius: 8px;
  display: grid;
  inset: 0;
  padding: 14px;
  pointer-events: auto;
  position: absolute;
  z-index: 6;
}

.cas-tutorial-card {
  background: rgba(255, 255, 255, 0.98);
  border: 1px solid rgba(8, 127, 140, 0.28);
  border-radius: 8px;
  box-shadow: 0 18px 44px rgba(15, 23, 42, 0.22);
  color: var(--cas-text);
  display: grid;
  gap: 10px;
  justify-self: stretch;
  max-width: 100%;
  padding: 14px;
}

.cas-tutorial-kicker {
  align-items: center;
  color: var(--cas-accent-strong);
  display: flex;
  font-size: 11px;
  font-weight: 700;
  justify-content: space-between;
  line-height: 1.2;
}

.cas-tutorial-card h3 {
  font-size: 16px;
  line-height: 1.35;
  margin: 0;
}

.cas-tutorial-card p {
  font-size: 13px;
  line-height: 1.55;
  margin: 0;
}

.cas-tutorial-hint {
  background: var(--cas-soft);
  border: 1px solid var(--cas-line);
  border-radius: 6px;
  color: var(--cas-muted);
  font-size: 12px;
  line-height: 1.45;
  padding: 8px 10px;
}

.cas-tutorial-actions {
  align-items: center;
  display: grid;
  gap: 8px;
  grid-template-columns: auto 1fr auto auto;
}

.cas-tutorial-dots {
  display: flex;
  gap: 5px;
  justify-content: center;
}

.cas-tutorial-dot {
  background: var(--cas-line);
  border-radius: 999px;
  height: 6px;
  width: 6px;
}

.cas-tutorial-dot[data-active="true"] {
  background: var(--cas-accent);
}

.cas-panel-body {
  display: grid;
  gap: 12px;
  flex: 1 1 auto;
  grid-template-rows: auto minmax(0, 1fr);
  min-height: 0;
  overflow: hidden;
  padding: 14px 16px 16px;
}

.cas-panel-body[data-target-open="true"] {
  grid-template-rows: auto auto minmax(0, 1fr);
}

.cas-status-row {
  align-items: center;
  display: inline-flex;
  gap: 6px;
  justify-self: end;
  min-height: 18px;
}

.cas-status-light {
  background: var(--cas-muted);
  border-radius: 999px;
  display: inline-block;
  height: 8px;
  margin-top: 1px;
  width: 8px;
}

.cas-status-light[data-state="ready"] {
  background: var(--cas-accent);
}

.cas-status-light[data-state="checking"] {
  background: var(--cas-warning);
}

.cas-status-light[data-state="degraded"] {
  background: var(--cas-danger);
}

.cas-status-label {
  color: var(--cas-muted);
  font-size: 11px;
  line-height: 1;
}

.cas-cockpit {
  display: grid;
  gap: 10px;
  min-height: 0;
  overflow: auto;
  padding-right: 4px;
}

.cas-health-strip {
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(5, minmax(0, 1fr));
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

.cas-signal-card strong[data-kind="status"] {
  color: var(--cas-accent-strong);
  font-size: 13px;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.cas-simulation-list {
  display: grid;
  gap: 10px;
}

.cas-simulation-card {
  background: var(--cas-soft);
  border: 1px solid var(--cas-line);
  border-radius: 8px;
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 11px 12px;
}

.cas-simulation-card[data-selected="true"] {
  border-color: rgba(8, 127, 140, 0.45);
  box-shadow: inset 3px 0 0 var(--cas-accent);
}

.cas-learning-flow,
.cas-learning-checks,
.cas-simulation-next {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.cas-learning-chip {
  background: #fff;
  border: 1px solid var(--cas-line);
  border-radius: 999px;
  color: var(--cas-muted);
  font-size: 11px;
  line-height: 1.35;
  max-width: 100%;
  overflow: hidden;
  padding: 3px 8px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cas-learning-note {
  color: var(--cas-muted);
  font-size: 12px;
  line-height: 1.45;
}

.cas-simulation-actions {
  display: grid;
  gap: 8px;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}

.cas-simulation-actions button {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cas-simulation-actions .cas-secondary {
  justify-content: center;
}

.cas-simulation-next {
  border-top: 1px solid var(--cas-line);
  margin-top: 8px;
  padding-top: 8px;
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
.cas-reason-list,
.cas-status-list {
  display: grid;
  gap: 7px;
}

.cas-risk-row,
.cas-action-row,
.cas-timeline-row,
.cas-reason-row,
.cas-status-row-item {
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
  display: grid;
  gap: 8px;
  grid-template-columns: minmax(0, 1fr) auto;
}

.cas-action-row span {
  display: -webkit-box;
  min-width: 0;
  overflow: hidden;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.cas-action-row .cas-link-button {
  justify-self: end;
  min-width: max-content;
  white-space: nowrap;
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
  align-content: start;
  display: grid;
  gap: 10px;
  min-height: 0;
  overflow: auto;
  padding-right: 4px;
  scrollbar-gutter: stable;
}

.cas-chat-surface {
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 12px;
  min-height: 0;
  position: relative;
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
  min-width: 0;
  overflow-wrap: anywhere;
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

.cas-message[data-pending="true"] {
  min-height: 78px;
}

.cas-message-role {
  color: var(--cas-muted);
  font-size: 12px;
}

.cas-answer {
  font-size: 14px;
  line-height: 1.55;
  margin: 0;
}

.cas-answer[data-primary="true"] {
  color: var(--cas-ink);
  font-size: 15px;
}

.cas-pending-answer {
  align-items: center;
  color: var(--cas-muted);
  display: inline-flex;
  font-size: 14px;
  gap: 8px;
  min-height: 24px;
}

.cas-pending-dots {
  display: inline-flex;
  gap: 3px;
}

.cas-pending-dots span {
  animation: cas-pending-pulse 1.1s infinite ease-in-out;
  background: var(--cas-accent);
  border-radius: 999px;
  display: inline-block;
  height: 5px;
  opacity: 0.34;
  width: 5px;
}

.cas-pending-dots span:nth-child(2) {
  animation-delay: 0.16s;
}

.cas-pending-dots span:nth-child(3) {
  animation-delay: 0.32s;
}

@keyframes cas-pending-pulse {
  0%,
  80%,
  100% {
    opacity: 0.34;
    transform: translateY(0);
  }
  40% {
    opacity: 1;
    transform: translateY(-2px);
  }
}

.cas-markdown {
  display: grid;
  gap: 9px;
}

.cas-md-paragraph,
.cas-md-list,
.cas-md-heading {
  margin: 0;
}

.cas-md-heading {
  color: var(--cas-ink);
  font-size: 14px;
  line-height: 1.35;
  margin-top: 5px;
}

.cas-answer[data-primary="true"] .cas-md-heading {
  font-size: 15px;
}

.cas-md-list {
  display: grid;
  gap: 5px;
  padding-left: 20px;
}

.cas-md-list .cas-md-list {
  margin-top: 5px;
}

.cas-md-inline-code,
.cas-md-code {
  background: #f3f6f8;
  border: 1px solid var(--cas-line);
  border-radius: 4px;
  color: #243242;
  font-family: Consolas, "Liberation Mono", Menlo, monospace;
}

.cas-md-inline-code {
  font-size: 0.92em;
  padding: 1px 4px;
}

.cas-md-code {
  display: block;
  margin: 0;
  max-width: 100%;
  overflow: auto;
  padding: 9px 10px;
  white-space: pre-wrap;
}

.cas-rca-trace {
  align-items: center;
  background: var(--cas-soft);
  border: 1px solid var(--cas-line);
  border-radius: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 7px 8px;
}

.cas-rca-trace-label {
  color: var(--cas-muted);
  font-size: 12px;
  font-weight: 700;
  margin-right: 2px;
}

.cas-trace-chip {
  align-items: center;
  background: #fff;
  border: 1px solid var(--cas-line);
  border-radius: 999px;
  color: var(--cas-muted);
  display: inline-flex;
  font-size: 12px;
  gap: 4px;
  line-height: 1;
  max-width: 100%;
  min-height: 24px;
  overflow-wrap: anywhere;
  padding: 5px 7px;
}

.cas-trace-chip[data-status="collected"],
.cas-trace-chip[data-status="ok"] {
  border-color: rgba(8, 127, 140, 0.28);
  color: var(--cas-accent-strong);
}

.cas-trace-chip[data-status="missing"],
.cas-trace-chip[data-status="fallback"] {
  border-color: rgba(166, 98, 0, 0.28);
  color: var(--cas-warning);
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

.cas-evidence-group {
  display: grid;
  gap: 7px;
}

.cas-evidence-group + .cas-evidence-group {
  border-top: 1px solid var(--cas-line);
  padding-top: 9px;
}

.cas-status-row-item {
  align-items: center;
  display: flex;
  gap: 8px;
  justify-content: space-between;
}

.cas-status-row-item[data-status="missing"] {
  border-color: rgba(166, 98, 0, 0.24);
}

.cas-cause,
.cas-evidence-item,
.cas-missing-item {
  background: #fff;
  border: 1px solid var(--cas-line);
  border-radius: 6px;
  min-width: 0;
  padding: 9px 10px;
}

.cas-result-details-body,
.cas-evidence-item,
.cas-evidence-item strong,
.cas-evidence-item div,
.cas-evidence-item span,
.cas-missing-item,
.cas-missing-item strong,
.cas-missing-item div {
  overflow-wrap: anywhere;
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
  flex: 0 0 auto;
  gap: 0;
  min-width: 0;
  padding-top: 10px;
  position: relative;
}

.cas-mode-selector {
  display: inline-flex;
  position: relative;
}

.cas-mode-button {
  align-items: center;
  background: #fff;
  border: 1px solid var(--cas-line);
  border-radius: 4px;
  color: var(--cas-ink);
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  gap: 5px;
  height: 28px;
  line-height: 1.1;
  max-width: 160px;
  min-width: 0;
  overflow: hidden;
  padding: 0 8px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cas-mode-button:hover,
.cas-mode-button:focus,
.cas-mode-button[data-open="true"] {
  background: var(--cas-soft);
  border-color: rgba(8, 127, 140, 0.28);
  color: var(--cas-accent-strong);
  outline: 0;
}

.cas-mode-button svg {
  flex: 0 0 auto;
  height: 14px;
  width: 14px;
}

.cas-mode-button span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cas-mode-chevron {
  height: 12px;
  width: 12px;
}

.cas-mode-menu {
  background: #fff;
  border: 1px solid var(--cas-line);
  border-radius: 4px;
  bottom: calc(100% + 6px);
  box-shadow: 0 12px 28px rgba(3, 22, 30, 0.16);
  display: grid;
  gap: 2px;
  left: 0;
  max-width: calc(100vw - 48px);
  min-width: 260px;
  padding: 6px;
  position: absolute;
  z-index: 5;
}

.cas-mode-menu[data-open="false"] {
  display: none;
}

.cas-mode-option {
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: 4px;
  color: var(--cas-ink);
  cursor: pointer;
  display: grid;
  gap: 2px 10px;
  grid-template-columns: 18px 1fr 16px;
  padding: 8px;
  text-align: left;
}

.cas-mode-option:hover,
.cas-mode-option:focus,
.cas-mode-option[data-active="true"] {
  background: var(--cas-soft);
  outline: 0;
}

.cas-mode-option > svg {
  color: var(--cas-ink);
  grid-row: 1 / span 2;
  height: 16px;
  width: 16px;
}

.cas-mode-option strong {
  font-size: 13px;
  line-height: 1.2;
}

.cas-mode-option span {
  color: var(--cas-muted);
  font-size: 12px;
  line-height: 1.25;
}

.cas-mode-check {
  align-self: center;
  color: var(--cas-accent-strong);
  grid-column: 3;
  grid-row: 1 / span 2;
  visibility: hidden;
}

.cas-mode-option[data-active="true"] .cas-mode-check {
  visibility: visible;
}

.cas-mode-check svg {
  color: var(--cas-accent-strong);
  height: 16px;
  width: 16px;
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
  height: 92px;
  max-height: 112px;
  min-height: 92px;
  overflow: auto;
  padding-bottom: 40px;
  padding-right: 48px;
  resize: none;
}

.cas-input-tools {
  align-items: center;
  bottom: 8px;
  display: inline-flex;
  gap: 4px;
  left: 8px;
  max-width: calc(100% - 58px);
  min-width: 0;
  position: absolute;
  z-index: 1;
}

.cas-compose-icon-button {
  align-items: center;
  background: #fff;
  border: 1px solid var(--cas-line);
  border-radius: 4px;
  color: var(--cas-muted);
  cursor: pointer;
  display: inline-flex;
  flex: 0 0 auto;
  height: 28px;
  justify-content: center;
  padding: 0;
  width: 28px;
}

.cas-compose-icon-button:hover,
.cas-compose-icon-button:focus,
.cas-compose-icon-button[data-active="true"] {
  background: var(--cas-soft-strong);
  color: var(--cas-accent-strong);
  outline: 0;
}

.cas-compose-icon-button svg {
  height: 14px;
  width: 14px;
}

.cas-suggestion-button {
  position: static;
}

.cas-scroll-bottom {
  align-items: center;
  background: var(--cas-accent);
  border: 0;
  border-radius: 999px;
  bottom: 76px;
  box-shadow: 0 8px 20px rgba(3, 22, 30, 0.18);
  color: #fff;
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  gap: 5px;
  justify-self: center;
  left: 50%;
  padding: 7px 10px;
  position: absolute;
  transform: translateX(-50%);
  z-index: 2;
}

.cas-scroll-bottom svg {
  height: 15px;
  width: 15px;
}

.cas-send-button {
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: 999px;
  bottom: 8px;
  color: var(--cas-muted);
  cursor: pointer;
  display: inline-flex;
  height: 28px;
  justify-content: center;
  padding: 0;
  position: absolute;
  right: 8px;
  width: 28px;
}

.cas-send-button:hover,
.cas-send-button:focus {
  background: var(--cas-soft-strong);
  color: var(--cas-accent-strong);
  outline: 0;
}

.cas-send-button svg {
  height: 20px;
  width: 20px;
}

.cas-send-button:disabled {
  cursor: progress;
  opacity: 0.68;
}

.cas-suggestion-list {
  display: grid;
  grid-template-columns: 1fr;
  gap: 6px;
  max-width: 100%;
}

.cas-suggestion-shell {
  background: #fff;
  border: 1px solid var(--cas-line);
  border-radius: 8px;
  bottom: calc(100% - 2px);
  box-shadow: 0 10px 24px rgba(3, 22, 30, 0.16);
  display: grid;
  left: 0;
  max-height: 196px;
  min-height: 0;
  overflow: auto;
  padding: 8px;
  position: absolute;
  right: 0;
  z-index: 3;
}

.cas-suggestion-shell[data-visible="false"] {
  display: none;
}

.cas-suggestion {
  background: #fff;
  border: 1px solid var(--cas-line);
  border-radius: 999px;
  color: var(--cas-muted);
  cursor: pointer;
  display: -webkit-box;
  font: inherit;
  font-size: 12px;
  line-height: 1.35;
  max-height: 38px;
  max-width: 100%;
  min-height: 32px;
  min-width: 0;
  overflow: hidden;
  padding: 6px 9px;
  text-align: left;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
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
  display: grid;
  gap: 7px;
  justify-content: space-between;
  margin-top: 8px;
}

.cas-target-toggle {
  color: var(--cas-muted);
  font-size: 12px;
  justify-self: start;
  max-width: 100%;
}

.cas-fields {
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  min-width: 0;
}

.cas-target-popover {
  background: #fff;
  border: 1px solid var(--cas-line);
  border-radius: 8px;
  box-shadow: 0 10px 24px rgba(3, 22, 30, 0.12);
  display: grid;
  gap: 10px;
  padding: 12px;
}

.cas-target-heading {
  align-items: start;
  display: flex;
  gap: 10px;
  justify-content: space-between;
  min-width: 0;
}

.cas-target-heading strong {
  display: block;
  font-size: 13px;
}

.cas-target-current {
  color: var(--cas-muted);
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.cas-target-field {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.cas-target-field input,
.cas-target-field select {
  background: #fff;
  border: 1px solid #8a96a3;
  border-radius: 2px;
  color: var(--cas-text);
  font: inherit;
  height: 31px;
  min-width: 0;
  padding: 3px 6px;
  width: 100%;
}

.cas-target-field span {
  color: var(--cas-muted);
  font-size: 11px;
  font-weight: 700;
}

.cas-target-actions {
  align-items: center;
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.cas-small-button {
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  padding: 7px 10px;
}

.cas-small-button[data-variant="primary"] {
  background: var(--cas-accent);
  border: 1px solid var(--cas-accent);
  color: #fff;
}

.cas-small-button[data-variant="secondary"] {
  background: #fff;
  border: 1px solid var(--cas-line);
  color: var(--cas-muted);
}

.cas-actions {
  align-items: center;
  display: none;
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
    height: min(720px, calc(100vh - 86px));
    left: 8px;
    right: 8px;
    width: auto;
  }

  .cas-launcher-button {
    bottom: 12px;
    right: 12px;
  }

  .cas-panel-header {
    align-items: center;
    gap: 8px;
    padding: 12px;
  }

  .cas-panel-body {
    gap: 10px;
    padding: 12px;
  }

  .cas-header-tools {
    align-items: center;
    flex-direction: row;
    gap: 3px;
    margin-left: auto;
  }

  .cas-view-switcher {
    gap: 2px;
  }

  .cas-view-button {
    height: 28px;
    width: 24px;
  }

  .cas-language-toggle {
    width: 34px;
  }

  .cas-close {
    height: 28px;
    width: 22px;
  }

  .cas-tutorial-overlay {
    padding: 10px;
  }

  .cas-tutorial-card {
    padding: 12px;
  }

  .cas-tutorial-actions {
    display: flex;
    flex-wrap: wrap;
  }

  .cas-tutorial-dots {
    flex: 1 0 100%;
    order: -1;
  }

  .cas-tutorial-actions button {
    flex: 1 1 0;
  }

  .cas-suggestion-shell {
    max-height: 172px;
  }

  .cas-suggestion {
    font-size: 11px;
    max-height: 32px;
    min-height: 28px;
    padding: 4px 8px;
  }

  .cas-compose textarea {
    height: 92px;
    min-height: 92px;
  }

  .cas-secondary {
    padding: 7px 10px;
  }

  .cas-fields,
  .cas-actions {
    grid-template-columns: 1fr;
  }

  .cas-target-popover .cas-fields {
    grid-template-columns: repeat(3, minmax(0, 1fr));
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
  if (view === "simulation") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" role="img">
        <path d="M5 6.5h14v11H5z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="2" />
        <path d="M8.3 10 11.5 12l-3.2 2z" fill="currentColor" />
        <path d="M14 10h3M14 14h3" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
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

function GlobeIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" role="img">
      <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M4 12h16M12 4c2.2 2.3 3.3 5 3.3 8S14.2 17.7 12 20M12 4c-2.2 2.3-3.3 5-3.3 8s1.1 5.7 3.3 8" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

function NewChatIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" role="img">
      <path d="M5 6.5h11.5v8H9l-4 3v-11Z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="2" />
      <path d="M17 5v5M14.5 7.5h5" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

function TargetIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" role="img">
      <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" role="img">
      <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M9.7 9.4a2.4 2.4 0 0 1 4.6.9c0 1.7-2.3 2-2.3 3.7" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      <path d="M12 17h.01" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2.6" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" role="img">
      <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2.2" />
    </svg>
  );
}

function ModeIcon({ mode }: { mode: ChatMode }) {
  if (mode === "troubleshooting") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" role="img">
        <path d="m14.7 5.3 4 4-2.6 2.6-1.5-1.5-5.8 5.8-2-2 5.8-5.8-1.5-1.5 3.6-1.6Z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
        <path d="m5.5 18.5 3-3" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" role="img">
      <path d="M5 6.5h14v8.8H9.2L5 18.5v-12Z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg aria-hidden="true" className="cas-mode-chevron" viewBox="0 0 24 24" role="img">
      <path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" role="img">
      <path d="m6 12 4 4 8-8" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" />
    </svg>
  );
}

function ArrowDownIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" role="img">
      <path d="M12 5v13M7 13l5 5 5-5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  );
}

function createMessageId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeQuestion(value: string, fallback = initialQuestionByLanguage.ko) {
  return value.trim() || fallback;
}

function hasSeenTutorial() {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(TUTORIAL_STORAGE_KEY) === "seen";
  } catch {
    return true;
  }
}

function markTutorialSeen() {
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(TUTORIAL_STORAGE_KEY, "seen");
  } catch {
    // Ignore storage failures; the tutorial can simply show again.
  }
}

function isOpenShiftConsoleHref(value?: string) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return false;
  return value.startsWith("/k8s/") || value.startsWith("/search") || value.startsWith("/monitoring");
}

function pickQuestionSuggestions(language: Language, count = RECOMMENDED_QUESTION_COUNT) {
  const pool = [...OCP_AIOPS_QUESTION_BANK[language]];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]];
  }
  return pool.slice(0, count);
}

function inferTargetFromQuestion(question: string, scenarios: SimulationScenario[]): QueryTarget | undefined {
  const normalized = question.toLowerCase();
  const matchedScenario = scenarios.find((scenario) => {
    const terms = [
      scenario.id,
      scenario.title,
      scenario.target.namespace,
      scenario.target.kind,
      scenario.target.name,
      scenario.target.container
    ].filter(Boolean) as string[];
    return terms.some((term) => term.length >= 4 && normalized.includes(term.toLowerCase()));
  });
  if (!matchedScenario) return undefined;
  return {
    namespace: matchedScenario.target.namespace,
    kind: matchedScenario.target.kind,
    name: matchedScenario.target.name
  };
}

function isNearBottom(element: HTMLElement, threshold = 56) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

function statusMessageFromStream(data: unknown, fallback: string) {
  if (!data || typeof data !== "object") return fallback;
  const message = (data as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message : fallback;
}

function tokenFromStream(data: unknown) {
  if (typeof data === "string") return data;
  if (!data || typeof data !== "object") return "";
  const token = (data as { token?: unknown }).token;
  return typeof token === "string" ? token : "";
}

async function readSseStream(response: Response, onEvent: (event: StreamEvent) => void) {
  if (!response.body) throw new Error("stream response body is empty");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flushEvent = (rawEvent: string) => {
    const lines = rawEvent.split(/\r?\n/);
    let event = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim() || "message";
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    const dataText = dataLines.join("\n");
    try {
      onEvent({ event, data: JSON.parse(dataText) });
    } catch {
      onEvent({ event, data: dataText });
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\n\n|\r\n\r\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) flushEvent(part);
  }
  buffer += decoder.decode();
  if (buffer.trim()) flushEvent(buffer);
}

function confidenceLabel(value?: number) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function scoreLabel(value?: number) {
  return Number.isFinite(Number(value)) ? String(Math.round(Number(value))) : "-";
}

function displayActionLabel(action: OverviewAction, language: Language) {
  const label = action.label ?? "";
  if (language !== "ko") return label;
  if (label === "Review namespace events") return "Namespace 이벤트 확인";
  if (label.startsWith("Review runbook:")) return label.replace("Review runbook:", "Runbook 확인:");
  if (label.startsWith("Run RCA for ")) return label.replace("Run RCA for ", "RCA 실행: ");
  const openMatch = label.match(/^Open (.+) in Console$/);
  if (openMatch) return `콘솔에서 ${openMatch[1]} 열기`;
  return label;
}

function targetKey(target: QueryTarget) {
  return `${target.namespace}::${target.kind}::${target.name}`;
}

function collectTargetOptions(
  overview: OverviewResult | null,
  simulations: SimulationScenario[],
  current: QueryTarget,
  catalogTargets: QueryTarget[] = []
) {
  const options = new Map<string, QueryTarget>();
  const add = (target: Partial<QueryTarget> | undefined) => {
    const namespace = String(target?.namespace ?? "").trim();
    const kind = String(target?.kind ?? "").trim();
    const name = String(target?.name ?? "").trim();
    if (!namespace || !kind || !name) return;
    const normalized = { namespace, kind, name };
    options.set(targetKey(normalized), normalized);
  };

  add(current);
  add({ namespace: "default", kind: "ClusterVersion", name: "version" });
  for (const target of catalogTargets) add(target);
  for (const workload of overview?.risk_workloads ?? []) add(workload);
  for (const scenario of simulations) add(scenario.target);

  return [...options.values()].sort((left, right) => {
    const namespaceOrder = left.namespace.localeCompare(right.namespace);
    if (namespaceOrder !== 0) return namespaceOrder;
    const kindOrder = left.kind.localeCompare(right.kind);
    if (kindOrder !== 0) return kindOrder;
    return left.name.localeCompare(right.name);
  });
}

function uniqueTargetValues(options: QueryTarget[], key: keyof QueryTarget) {
  return [...new Set(options.map((option) => option[key]).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function matchingNames(options: QueryTarget[], namespace: string, kind: string) {
  const exact = uniqueTargetValues(
    options.filter((option) => option.namespace === namespace && option.kind === kind),
    "name"
  );
  if (exact.length > 0) return exact;
  const namespaceMatches = uniqueTargetValues(options.filter((option) => option.namespace === namespace), "name");
  return namespaceMatches.length > 0 ? namespaceMatches : uniqueTargetValues(options, "name");
}

function formatTimelineTime(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function evidenceGroupLabel(type: string | undefined, copy: (typeof languageCopy)[Language]) {
  if (type === "metric") return copy.metricEvidence;
  if (type === "runbook" || type === "rag_reference") return copy.runbookEvidence;
  return copy.openshiftEvidence;
}

function evidenceGroupWhy(type: string | undefined, copy: (typeof languageCopy)[Language]) {
  if (type === "metric") return `${copy.whyThisMatters}: ${copy.whyMetric}`;
  if (type === "runbook" || type === "rag_reference") return `${copy.whyThisMatters}: ${copy.whyRunbook}`;
  return `${copy.whyThisMatters}: ${copy.whyOpenShift}`;
}

function groupEvidenceBySource(evidence: EvidenceItem[]) {
  return {
    openshift: evidence.filter((item) => !["metric", "runbook", "rag_reference"].includes(item.type ?? "")),
    metric: evidence.filter((item) => item.type === "metric"),
    runbook: evidence.filter((item) => item.type === "runbook" || item.type === "rag_reference")
  };
}

function statusFor(evidenceStatus: EvidenceStatus[] | undefined, type: string) {
  return evidenceStatus?.find((item) => item.type === type);
}

function traceCount(status: EvidenceStatus | undefined, fallbackCount: number) {
  if (status) return status.count;
  return fallbackCount;
}

function traceStatus(status: EvidenceStatus | undefined, fallbackCount: number) {
  if (status?.status) return status.status;
  return fallbackCount > 0 ? "collected" : "missing";
}

function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = String(content || "").split(/\r?\n/);
  let paragraph: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let listItems: string[] = [];
  let codeLines: string[] = [];
  let inCodeBlock = false;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", text: paragraph.join(" ").trim() });
    paragraph = [];
  };
  const flushList = () => {
    if (!listType || listItems.length === 0) return;
    blocks.push({ type: listType, items: listItems });
    listType = null;
    listItems = [];
  };
  const flushCode = () => {
    blocks.push({ type: "code", text: codeLines.join("\n") });
    codeLines = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flushParagraph();
      flushList();
      if (inCodeBlock) {
        flushCode();
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        codeLines = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const nextType = unordered ? "ul" : "ol";
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push((unordered?.[1] ?? ordered?.[1] ?? "").trim());
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  if (inCodeBlock || codeLines.length > 0) flushCode();
  return blocks.length > 0 ? blocks : [{ type: "paragraph", text: content }];
}

function renderInlineMarkdown(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*.+?\*\*)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;
    if (token.startsWith("`")) {
      nodes.push(
        <code className="cas-md-inline-code" key={key}>
          {token.slice(1, -1)}
        </code>
      );
    } else {
      nodes.push(
        <strong key={key}>
          {renderInlineMarkdown(token.slice(2, -2), `${key}-strong`)}
        </strong>
      );
    }
    cursor = match.index + token.length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function MarkdownAnswer({ content, primary }: { content: string; primary: boolean }) {
  const blocks = React.useMemo(() => parseMarkdownBlocks(content), [content]);
  return (
    <div className="cas-answer cas-markdown" data-primary={primary ? "true" : "false"} data-test="cas-markdown-answer">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          return (
            <h3 className="cas-md-heading" data-level={block.level} key={`heading-${index}`}>
              {renderInlineMarkdown(block.text, `heading-${index}`)}
            </h3>
          );
        }
        if (block.type === "ul" || block.type === "ol") {
          const ListTag = block.type;
          return (
            <ListTag className="cas-md-list" key={`${block.type}-${index}`}>
              {block.items.map((item, itemIndex) => (
                <li key={`${block.type}-${index}-${itemIndex}`}>{renderInlineMarkdown(item, `${block.type}-${index}-${itemIndex}`)}</li>
              ))}
            </ListTag>
          );
        }
        if (block.type === "code") {
          return (
            <pre className="cas-md-code" key={`code-${index}`}>
              <code>{block.text}</code>
            </pre>
          );
        }
        return (
          <p className="cas-md-paragraph" key={`paragraph-${index}`}>
            {renderInlineMarkdown(block.text, `paragraph-${index}`)}
          </p>
        );
      })}
    </div>
  );
}

function PendingAnswer({ content }: { content: string }) {
  return (
    <div className="cas-pending-answer" data-test="cas-pending-answer">
      <span>{content}</span>
      <span aria-hidden="true" className="cas-pending-dots">
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}

function EvidenceGroup({
  title,
  type,
  items,
  copy,
  emptyText
}: {
  title: string;
  type: string;
  items: EvidenceItem[];
  copy: (typeof languageCopy)[Language];
  emptyText: string;
}) {
  return (
    <div className="cas-evidence-group" data-test={`cas-evidence-group-${type}`}>
      <div className="cas-panel-heading">
        <strong>{title}</strong>
        <span className="cas-meta">{items.length}</span>
      </div>
      <div className="cas-meta">{evidenceGroupWhy(type, copy)}</div>
      <div className="cas-evidence-list">
        {items.slice(0, 6).map((item) => (
          <div className="cas-evidence-item" key={item.id}>
            <strong>{item.id}</strong>
            <div>{item.summary}</div>
            <span>{item.source}</span>
            {item.query && <span>{item.query}</span>}
          </div>
        ))}
        {items.length === 0 && <div className="cas-meta">{emptyText}</div>}
      </div>
    </div>
  );
}

function RcaTrace({ result, copy }: { result: RCAResult; copy: (typeof languageCopy)[Language] }) {
  const evidence = result.evidence_bundle?.evidence ?? [];
  const groups = groupEvidenceBySource(evidence);
  const evidenceStatus = result.evidence_bundle?.evidence_status ?? [];
  const openShift = statusFor(evidenceStatus, "openshift");
  const metric = statusFor(evidenceStatus, "metric");
  const runbook = statusFor(evidenceStatus, "runbook");
  const toolSteps = result.tool_plan?.tool_plan ?? [];
  const brainStatus = result.audit?.brain?.status ?? (result.mode === "lightspeed_fallback_mock" ? "fallback" : "ok");
  const chips = [
    {
      label: "OpenShift",
      status: traceStatus(openShift, groups.openshift.length),
      count: traceCount(openShift, groups.openshift.length)
    },
    {
      label: "Metric",
      status: traceStatus(metric, groups.metric.length),
      count: traceCount(metric, groups.metric.length)
    },
    {
      label: "Runbook",
      status: traceStatus(runbook, groups.runbook.length),
      count: traceCount(runbook, groups.runbook.length)
    },
    {
      label: "Tool Plan",
      status: toolSteps.length > 0 ? "collected" : "missing",
      count: toolSteps.length
    },
    {
      label: copy.brain,
      status: brainStatus,
      count: brainStatus === "ok" ? 1 : 0
    }
  ];

  return (
    <div className="cas-rca-trace" data-test="cas-rca-trace">
      <span className="cas-rca-trace-label">{copy.rcaTrace}</span>
      {chips.map((chip) => (
        <span className="cas-trace-chip" data-status={chip.status} key={chip.label}>
          <strong>{chip.label}</strong>
          <span>{chip.status}</span>
          {chip.label !== copy.brain && <span>{chip.count}</span>}
        </span>
      ))}
    </div>
  );
}

function OverviewCockpit({
  overview,
  status,
  activeView,
  copy,
  onRefresh,
  onRunQuestion,
  onSelectWorkload,
  isRunning
}: {
  overview: OverviewResult | null;
  status: "idle" | "loading" | "ready" | "degraded";
  activeView: Exclude<ActiveView, "chat" | "simulation">;
  copy: (typeof languageCopy)[Language];
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
  const evidenceStatus = overview?.evidence_status ?? [];
  const evidenceGroups = overview?.evidence_groups ?? {};
  const metricStatus = statusFor(evidenceStatus, "metric");
  const candidate = overview?.rca_candidate;

  return (
    <section className="cas-cockpit" data-test="cas-overview-cockpit">
      <div className="cas-panel-heading">
        <strong>{copy.viewLabels[activeView]}</strong>
        <button className="cas-link-button" onClick={onRefresh} type="button">
          {status === "loading" ? copy.refreshing : copy.refresh}
        </button>
      </div>

      {activeView === "cockpit" && (
        <>
          <div className="cas-health-strip" data-test="cas-health-strip">
            <div className="cas-signal-card">
              <span>{copy.health}</span>
              <strong>{scoreLabel(overview?.health?.score)}</strong>
              <div className="cas-meta">{overview?.health?.risk ?? status}</div>
            </div>
            <div className="cas-signal-card">
              <span>{copy.warningEvents}</span>
              <strong>{signals.warning_events ?? 0}</strong>
              <div className="cas-meta">{copy.recentScope}</div>
            </div>
            <div className="cas-signal-card">
              <span>{copy.restartSpikes}</span>
              <strong>{signals.restart_spikes ?? 0}</strong>
              <div className="cas-meta">{copy.podRestart}</div>
            </div>
            <div className="cas-signal-card">
              <span>{copy.riskWorkloads}</span>
              <strong>{signals.risky_workloads ?? 0}</strong>
              <div className="cas-meta">{copy.topTargets}</div>
            </div>
            <div className="cas-signal-card" data-test="cas-metric-provider">
              <span>{copy.metricProvider}</span>
              <strong data-kind="status">{metricStatus?.status ?? "missing"}</strong>
              <div className="cas-meta">
                {metricStatus?.count ?? 0} {copy.signals}
              </div>
            </div>
          </div>

          <div className="cas-cockpit-grid">
            <article className="cas-cockpit-panel" data-test="cas-rca-candidate">
              <div className="cas-panel-heading">
                <strong>{copy.rcaCandidate}</strong>
                <span className="cas-risk-pill" data-risk={overview?.health?.risk ?? "low"}>
                  {overview?.health?.risk ?? "unknown"}
                </span>
              </div>
              <div>{candidate?.cause ?? overview?.health?.summary ?? copy.overviewLoading}</div>
              <div className="cas-meta">
                {copy.confidence} {confidenceLabel(candidate?.confidence)} · {copy.evidence}{" "}
                {(candidate?.evidence_refs ?? []).join(", ") || copy.pendingEvidence}
              </div>
              {overview?.health?.summary && <div className="cas-meta">{overview.health.summary}</div>}
            </article>

            <article className="cas-cockpit-panel" data-test="cas-risk-workloads">
              <div className="cas-panel-heading">
                <strong>{copy.riskWorkloads}</strong>
                <span className="cas-meta">
                  {copy.top} {riskWorkloads.length}
                </span>
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
                      {workload.namespace} · {workload.kind} · {workload.status} · {copy.restarts}{" "}
                      {workload.restarts ?? 0}
                    </div>
                    <div className="cas-meta">{workload.reason}</div>
                  </button>
                ))}
                {riskWorkloads.length === 0 && <div className="cas-meta">{copy.noRiskWorkloads}</div>}
              </div>
            </article>
          </div>
        </>
      )}

      {activeView === "evidence" && (
        <div className="cas-cockpit-grid">
          <article className="cas-cockpit-panel" data-wide="true" data-test="cas-evidence-status">
            <div className="cas-panel-heading">
              <strong>{copy.evidenceStatus}</strong>
              <span className="cas-meta">{evidenceStatus.length}</span>
            </div>
            <div className="cas-status-list">
              {evidenceStatus.map((item) => (
                <div className="cas-status-row-item" data-status={item.status} key={item.type}>
                  <div className="cas-row-main">
                    <strong>{item.type}</strong>
                    <span className="cas-risk-pill" data-risk={item.status === "collected" ? "low" : "medium"}>
                      {item.status}
                    </span>
                  </div>
                  <div className="cas-meta">
                    {item.count} {copy.signals}
                    {item.reason ? ` · ${item.reason}` : ""}
                  </div>
                </div>
              ))}
              {evidenceStatus.length === 0 && <div className="cas-meta">{copy.pendingEvidence}</div>}
            </div>
          </article>

          <article className="cas-cockpit-panel" data-test="cas-event-reasons">
            <div className="cas-panel-heading">
              <strong>{copy.eventReasons}</strong>
              <span className="cas-meta">{copy.warning}</span>
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
              {eventReasons.length === 0 && <div className="cas-meta">{copy.noWarningEventReasons}</div>}
            </div>
          </article>

          <article className="cas-cockpit-panel" data-test="cas-overview-missing">
            <div className="cas-panel-heading">
              <strong>{copy.missingEvidence}</strong>
              <span className="cas-meta">{missing.length}</span>
            </div>
            <div className="cas-missing-list">
              {missing.slice(0, 6).map((item) => (
                <div className="cas-missing-item" key={`${item.type}-${item.reason}`}>
                  <strong>{item.type}</strong>
                  <div className="cas-meta">{item.reason}</div>
                </div>
              ))}
              {missing.length === 0 && <div className="cas-meta">{copy.noMissingEvidence}</div>}
            </div>
          </article>

          <article className="cas-cockpit-panel" data-wide="true" data-test="cas-evidence-groups">
            <EvidenceGroup
              copy={copy}
              emptyText={copy.noTimelineEvidence}
              items={evidenceGroups.openshift ?? timeline.map((item) => ({
                id: item.id ?? `${item.ts}-${item.summary}`,
                type: item.type,
                summary: item.summary,
                source: item.source,
                observed_at: item.ts
              }))}
              title={copy.openshiftEvidence}
              type="openshift"
            />
            <EvidenceGroup
              copy={copy}
              emptyText={copy.pendingEvidence}
              items={evidenceGroups.metric ?? []}
              title={copy.metricEvidence}
              type="metric"
            />
            <EvidenceGroup
              copy={copy}
              emptyText={copy.pendingEvidence}
              items={evidenceGroups.runbook ?? []}
              title={copy.runbookEvidence}
              type="runbook"
            />
          </article>

          <article className="cas-cockpit-panel" data-wide="true" data-test="cas-evidence-timeline">
            <div className="cas-panel-heading">
              <strong>{copy.evidenceTimeline}</strong>
              <span className="cas-meta">
                {timeline.length} {copy.signals}
              </span>
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
              {timeline.length === 0 && <div className="cas-meta">{copy.noTimelineEvidence}</div>}
            </div>
          </article>
        </div>
      )}

      {activeView === "actions" && (
        <div className="cas-cockpit-grid">
          <article className="cas-cockpit-panel" data-test="cas-action-queue">
            <div className="cas-panel-heading">
              <strong>{copy.actionQueue}</strong>
              <span className="cas-meta">
                {actions.length} {copy.actionCount}
              </span>
            </div>
            <div className="cas-action-list">
              {actions.slice(0, 6).map((action) => {
                const canOpenConsole = action.type === "console_link" && isOpenShiftConsoleHref(action.href);
                const actionLabel = displayActionLabel(action, language);
                const fallbackQuestion =
                  action.question ??
                  (canOpenConsole
                    ? `다음 확인 "${action.label}"을 위한 안전한 확인 절차와 콘솔 위치(${action.href})를 알려줘. 브라우저 이동은 하지 말고 단계별로 설명해줘.`
                    : `다음 확인 "${action.label}"을 위한 안전한 확인 절차와 콘솔 위치를 알려줘.`);
                return (
                  <div className="cas-action-row" key={`${action.type}-${action.label}`}>
                    <span title={actionLabel}>{actionLabel}</span>
                    <button className="cas-link-button" disabled={isRunning} onClick={() => onRunQuestion(fallbackQuestion)} type="button">
                      {copy.run}
                    </button>
                  </div>
                );
              })}
              {actions.length === 0 && <div className="cas-meta">{copy.noActions}</div>}
            </div>
          </article>

          <article className="cas-cockpit-panel" data-test="cas-risk-workloads">
            <div className="cas-panel-heading">
              <strong>{copy.runRcaTargets}</strong>
              <span className="cas-meta">
                {copy.top} {riskWorkloads.length}
              </span>
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
              {riskWorkloads.length === 0 && <div className="cas-meta">{copy.noRcaTargets}</div>}
            </div>
          </article>
        </div>
      )}
    </section>
  );
}

function SimulationLab({
  scenarios,
  status,
  selectedScenarioId,
  copy,
  isRunning,
  onRefresh,
  onRunScenario,
  onRunRemediation
}: {
  scenarios: SimulationScenario[];
  status: "idle" | "loading" | "ready" | "degraded";
  selectedScenarioId: string | null;
  copy: (typeof languageCopy)[Language];
  isRunning: boolean;
  onRefresh: () => void;
  onRunScenario: (scenario: SimulationScenario) => void;
  onRunRemediation: (scenario: SimulationScenario, remediation: SimulationRemediation) => void;
}) {
  return (
    <section className="cas-cockpit" data-test="cas-simulation-lab">
      <div className="cas-panel-heading">
        <strong>{copy.simulationLab}</strong>
        <button className="cas-link-button" onClick={onRefresh} type="button">
          {status === "loading" ? copy.refreshing : copy.refresh}
        </button>
      </div>
      <div className="cas-meta">{status === "loading" ? copy.simulationLoading : copy.simulationIntro}</div>
      <div className="cas-simulation-list" data-test="cas-simulation-list">
        {scenarios.map((scenario) => (
          <article
            className="cas-simulation-card"
            data-selected={selectedScenarioId === scenario.id ? "true" : "false"}
            data-test="cas-simulation-card"
            key={scenario.id}
          >
            <div className="cas-panel-heading">
              <strong>{scenario.title}</strong>
              <span className="cas-risk-pill" data-risk={scenario.risk ?? "medium"}>
                {scenario.risk ?? "medium"}
              </span>
            </div>
            <div>{scenario.summary ?? scenario.question}</div>
            <div className="cas-meta">
              {scenario.target.namespace} · {scenario.target.kind}/{scenario.target.name}
            </div>
            {scenario.learning?.objective && (
              <div className="cas-learning-note" data-test="cas-simulation-learning">
                {copy.simulationLearning}: {scenario.learning.objective}
              </div>
            )}
            {(scenario.learning?.cycle?.length ?? 0) > 0 && (
              <div className="cas-learning-flow" data-test="cas-simulation-cycle">
                {scenario.learning?.cycle?.map((step, index) => (
                  <span className="cas-learning-chip" key={`${scenario.id}-cycle-${step}`}>
                    {index + 1}. {step}
                  </span>
                ))}
              </div>
            )}
            <div className="cas-meta">
              {copy.simulationSignals}: warnings {scenario.signals?.warnings ?? 0} · restarts {scenario.signals?.restarts ?? 0} · metrics{" "}
              {scenario.signals?.metric_series ?? 0}
            </div>
            <div className="cas-simulation-actions">
              <button className="cas-secondary" disabled={isRunning} onClick={() => onRunScenario(scenario)} type="button">
                1. {copy.simulationRun}
              </button>
              {(scenario.remediations ?? []).map((remediation) => (
                <button
                  className="cas-link-button"
                  disabled={isRunning}
                  key={remediation.id}
                  onClick={() => onRunRemediation(scenario, remediation)}
                  title={remediation.description}
                  type="button"
                >
                  2. {remediation.label || copy.simulationFix}
                </button>
              ))}
            </div>
          </article>
        ))}
        {status !== "loading" && scenarios.length === 0 && <div className="cas-meta">{copy.simulationNoScenarios}</div>}
      </div>
    </section>
  );
}

function TutorialOverlay({
  copy,
  stepIndex,
  onBack,
  onClose,
  onNext
}: {
  copy: (typeof languageCopy)[Language];
  stepIndex: number;
  onBack: () => void;
  onClose: () => void;
  onNext: () => void;
}) {
  const steps = copy.tutorialSteps;
  const step = steps[Math.min(stepIndex, steps.length - 1)] ?? steps[0];
  const isFirst = stepIndex <= 0;
  const isLast = stepIndex >= steps.length - 1;

  return (
    <div className="cas-tutorial-overlay" data-test="cas-tutorial-overlay" role="dialog" aria-label={copy.tutorialTitle}>
      <article className="cas-tutorial-card" data-test="cas-tutorial-card">
        <div className="cas-tutorial-kicker">
          <span>{copy.tutorialTitle}</span>
          <span>{copy.tutorialProgress(stepIndex + 1, steps.length)}</span>
        </div>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        <div className="cas-tutorial-hint">{step.hint}</div>
        <div className="cas-tutorial-actions">
          <button className="cas-link-button" onClick={onClose} type="button">
            {copy.tutorialSkip}
          </button>
          <div className="cas-tutorial-dots" aria-hidden="true">
            {steps.map((item, index) => (
              <span className="cas-tutorial-dot" data-active={index === stepIndex ? "true" : "false"} key={item.id} />
            ))}
          </div>
          <button className="cas-small-button" data-variant="secondary" disabled={isFirst} onClick={onBack} type="button">
            {copy.tutorialBack}
          </button>
          <button className="cas-small-button" data-variant="primary" onClick={onNext} type="button">
            {isLast ? copy.tutorialDone : copy.tutorialNext}
          </button>
        </div>
      </article>
    </div>
  );
}

function SimulationNextActions({
  copy,
  isRunning,
  message,
  onOpenLab,
  onRunRemediation,
  onRunQuestion,
  scenarios
}: {
  copy: (typeof languageCopy)[Language];
  isRunning: boolean;
  message: ChatMessage;
  onOpenLab: () => void;
  onRunRemediation: (scenario: SimulationScenario, remediation: SimulationRemediation) => void;
  onRunQuestion: (scenario: SimulationScenario, question: string, remediation?: SimulationRemediation) => void;
  scenarios: SimulationScenario[];
}) {
  const scenario = message.simulation?.scenarioId
    ? scenarios.find((candidate) => candidate.id === message.simulation?.scenarioId)
    : undefined;
  if (!scenario) return null;

  const remediation = message.simulation?.actionId
    ? (scenario.remediations ?? []).find((candidate) => candidate.id === message.simulation?.actionId)
    : undefined;
  const followUps = remediation?.followUps ?? scenario.learning?.followUps ?? [];

  return (
    <div className="cas-simulation-next" data-test="cas-simulation-next-actions">
      {!remediation &&
        (scenario.remediations ?? []).map((action) => (
          <button
            className="cas-link-button"
            disabled={isRunning}
            key={action.id}
            onClick={() => onRunRemediation(scenario, action)}
            title={action.description}
            type="button"
          >
            2. {action.label || copy.simulationFix}
          </button>
        ))}
      {remediation?.expectedOutcome && (
        <span className="cas-learning-chip" title={remediation.expectedOutcome}>
          {copy.simulationOutcome}: {remediation.expectedOutcome}
        </span>
      )}
      {followUps.slice(0, 3).map((question) => (
        <button
          className="cas-link-button"
          disabled={isRunning}
          key={`${scenario.id}-${question}`}
          onClick={() => onRunQuestion(scenario, question, remediation)}
          title={question}
          type="button"
        >
          3. {question}
        </button>
      ))}
      <button className="cas-link-button" disabled={isRunning} onClick={onOpenLab} type="button">
        {copy.simulationBackToLab}
      </button>
    </div>
  );
}

function EvidenceSummary({ result, copy }: { result: RCAResult; copy: (typeof languageCopy)[Language] }) {
  const causes = result.rca_result?.cause_candidates ?? [];
  const evidence = result.evidence_bundle?.evidence ?? [];
  const missing = result.evidence_bundle?.missing ?? [];
  const toolSteps = result.tool_plan?.tool_plan ?? [];
  const groups = groupEvidenceBySource(evidence);
  const total = causes.length + evidence.length + missing.length + toolSteps.length;

  if (total === 0) return null;

  return (
    <details className="cas-result-details" data-test="cas-evidence-panel">
      <summary>{copy.evidenceSummary(evidence.length, causes.length, missing.length)}</summary>
      <div className="cas-result-details-body">
        {causes.length > 0 && (
          <div className="cas-cause-list" data-test="cas-cause-list">
            {causes.map((cause) => (
              <div className="cas-cause" key={`${cause.cause}-${cause.confidence}`}>
                <strong>{cause.cause}</strong>
                <div className="cas-meta">
                  {copy.confidence} {Math.round(Number(cause.confidence || 0) * 100)}% · {copy.evidence}{" "}
                  {(cause.evidence_refs ?? []).join(", ") || copy.none}
                </div>
              </div>
            ))}
          </div>
        )}

        {evidence.length > 0 && (
          <div className="cas-evidence-list" data-test="cas-result-evidence-groups">
            <strong className="cas-section-title">{copy.evidenceSection}</strong>
            {[
              { type: "openshift", items: groups.openshift },
              { type: "metric", items: groups.metric },
              { type: "runbook", items: groups.runbook }
            ].map((group) =>
              group.items.length > 0 ? (
                <div className="cas-evidence-group" key={group.type}>
                  <div className="cas-panel-heading">
                    <strong>{evidenceGroupLabel(group.type, copy)}</strong>
                    <span className="cas-meta">{group.items.length}</span>
                  </div>
                  <div className="cas-meta">{evidenceGroupWhy(group.type, copy)}</div>
                  {group.items.map((item) => (
                    <div className="cas-evidence-item" key={item.id}>
                      <strong>{item.id}</strong>
                      <div>{item.summary}</div>
                      <span>{item.source}</span>
                      {item.query && <span>{item.query}</span>}
                    </div>
                  ))}
                </div>
              ) : null
            )}
          </div>
        )}

        {toolSteps.length > 0 && (
          <div className="cas-evidence-list" data-test="cas-tool-plan-panel">
            <strong className="cas-section-title">{copy.toolPlan}</strong>
            {toolSteps.map((step) => (
              <div className="cas-evidence-item" key={`${step.step}-${step.tool}`}>
                <strong>
                  {step.step}. {step.tool}
                </strong>
                <div className="cas-meta">
                  {step.verb ?? "get"}
                  {step.optional ? " · optional" : ""}
                </div>
              </div>
            ))}
          </div>
        )}

        {missing.length > 0 && (
          <div className="cas-missing-list" data-test="cas-missing-evidence">
            <strong className="cas-section-title">{copy.missingSection}</strong>
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
  const [language, setLanguage] = React.useState<Language>("ko");
  const [chatMode, setChatMode] = React.useState<ChatMode>("ask");
  const [question, setQuestion] = React.useState("");
  const [questionSuggestions, setQuestionSuggestions] = React.useState(() => pickQuestionSuggestions("ko"));
  const [activeSuggestionIndex, setActiveSuggestionIndex] = React.useState(0);
  const [showSuggestions, setShowSuggestions] = React.useState(false);
  const [showModeMenu, setShowModeMenu] = React.useState(false);
  const [showTargetControls, setShowTargetControls] = React.useState(false);
  const [showTutorial, setShowTutorial] = React.useState(false);
  const [tutorialStepIndex, setTutorialStepIndex] = React.useState(0);
  const [namespace, setNamespace] = React.useState("default");
  const [resourceName, setResourceName] = React.useState("version");
  const [resourceKind, setResourceKind] = React.useState("ClusterVersion");
  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const [isRunning, setIsRunning] = React.useState(false);
  const [copiedMessageId, setCopiedMessageId] = React.useState<string | null>(null);
  const [overviewStatus, setOverviewStatus] = React.useState<"idle" | "loading" | "ready" | "degraded">("idle");
  const [overview, setOverview] = React.useState<OverviewResult | null>(null);
  const [targetCatalog, setTargetCatalog] = React.useState<TargetCatalog | null>(null);
  const [targetCatalogStatus, setTargetCatalogStatus] = React.useState<"idle" | "loading" | "ready" | "degraded">("idle");
  const [simulationStatus, setSimulationStatus] = React.useState<"idle" | "loading" | "ready" | "degraded">("idle");
  const [simulations, setSimulations] = React.useState<SimulationScenario[]>([]);
  const [selectedSimulationId, setSelectedSimulationId] = React.useState<string | null>(null);
  const [brainStatus, setBrainStatus] = React.useState<BrainStatus>({
    state: "checking",
    provider: "openshift-lightspeed",
    detail: "연결 확인 중"
  });
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [showScrollBottom, setShowScrollBottom] = React.useState(false);
  const chatThreadRef = React.useRef<HTMLDivElement | null>(null);
  const abortControllerRef = React.useRef<AbortController | null>(null);
  const autoScrollRef = React.useRef(true);
  const copy = languageCopy[language];
  const activeSuggestion = questionSuggestions[activeSuggestionIndex] ?? initialQuestionByLanguage[language];
  const targetSummary = `${namespace || "default"} · ${resourceKind || "Resource"}/${resourceName || "name"}`;
  const statusLabel =
    brainStatus.state === "ready"
      ? copy.statusConnected
      : brainStatus.state === "checking"
      ? copy.statusChecking
      : copy.statusDegraded;
  const targetOptions = React.useMemo(
    () =>
      collectTargetOptions(overview, simulations, {
        namespace: namespace || "default",
        kind: resourceKind || "Pod",
        name: resourceName || "version"
      }, targetCatalog?.targets ?? []),
    [namespace, overview, resourceKind, resourceName, simulations, targetCatalog]
  );
  const namespaceOptions = React.useMemo(() => uniqueTargetValues(targetOptions, "namespace"), [targetOptions]);
  const kindOptions = React.useMemo(() => uniqueTargetValues(targetOptions, "kind"), [targetOptions]);
  const nameOptions = React.useMemo(() => matchingNames(targetOptions, namespace, resourceKind), [namespace, resourceKind, targetOptions]);

  const selectTarget = React.useCallback((target: QueryTarget) => {
    setNamespace(target.namespace);
    setResourceKind(target.kind);
    setResourceName(target.name);
  }, []);

  const selectNamespace = React.useCallback(
    (nextNamespace: string) => {
      const nextTarget =
        targetOptions.find((option) => option.namespace === nextNamespace && option.kind === resourceKind) ??
        targetOptions.find((option) => option.namespace === nextNamespace);
      if (nextTarget) {
        selectTarget(nextTarget);
        return;
      }
      setNamespace(nextNamespace);
    },
    [resourceKind, selectTarget, targetOptions]
  );

  const selectKind = React.useCallback(
    (nextKind: string) => {
      const nextTarget =
        targetOptions.find((option) => option.namespace === namespace && option.kind === nextKind) ??
        targetOptions.find((option) => option.kind === nextKind);
      if (nextTarget) {
        selectTarget(nextTarget);
        return;
      }
      setResourceKind(nextKind);
    },
    [namespace, selectTarget, targetOptions]
  );

  const selectName = React.useCallback(
    (nextName: string) => {
      const nextTarget =
        targetOptions.find((option) => option.namespace === namespace && option.kind === resourceKind && option.name === nextName) ??
        targetOptions.find((option) => option.name === nextName);
      if (nextTarget) {
        selectTarget(nextTarget);
        return;
      }
      setResourceName(nextName);
    },
    [namespace, resourceKind, selectTarget, targetOptions]
  );

  const applyTutorialStep = React.useCallback(
    (stepIndex: number) => {
      const nextIndex = Math.max(0, Math.min(stepIndex, copy.tutorialSteps.length - 1));
      const step = copy.tutorialSteps[nextIndex];
      setTutorialStepIndex(nextIndex);
      if (step?.view) setActiveView(step.view);
      setShowTargetControls(Boolean(step?.targetOpen));
      setShowSuggestions(false);
      setShowModeMenu(false);
    },
    [copy]
  );

  const rotateQuestionSuggestions = React.useCallback((nextLanguage = language) => {
    setQuestionSuggestions(pickQuestionSuggestions(nextLanguage));
    setActiveSuggestionIndex(0);
    setShowSuggestions(false);
    setShowModeMenu(false);
  }, [language]);

  const toggleLanguage = React.useCallback(() => {
    const nextLanguage: Language = language === "ko" ? "en" : "ko";
    setLanguage(nextLanguage);
    setQuestion("");
    setShowSuggestions(false);
    setShowModeMenu(false);
    setQuestionSuggestions(pickQuestionSuggestions(nextLanguage));
    setActiveSuggestionIndex(0);
  }, [language]);

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

  React.useEffect(() => {
    if (!isOpen || hasSeenTutorial()) return;
    setShowTutorial(true);
    applyTutorialStep(0);
  }, [applyTutorialStep, isOpen]);

  const openTutorial = React.useCallback(() => {
    setShowTutorial(true);
    applyTutorialStep(0);
  }, [applyTutorialStep]);

  const closeTutorial = React.useCallback(() => {
    markTutorialSeen();
    setShowTutorial(false);
    setActiveView("chat");
    setShowTargetControls(false);
    setShowSuggestions(false);
    setShowModeMenu(false);
    autoScrollRef.current = true;
    void refreshBrainStatus();
  }, [refreshBrainStatus]);

  const nextTutorialStep = React.useCallback(() => {
    if (tutorialStepIndex >= copy.tutorialSteps.length - 1) {
      closeTutorial();
      return;
    }
    applyTutorialStep(tutorialStepIndex + 1);
  }, [applyTutorialStep, closeTutorial, copy.tutorialSteps.length, tutorialStepIndex]);

  const previousTutorialStep = React.useCallback(() => {
    applyTutorialStep(tutorialStepIndex - 1);
  }, [applyTutorialStep, tutorialStepIndex]);

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

  const refreshTargetCatalog = React.useCallback(async () => {
    setTargetCatalogStatus("loading");
    try {
      const response = await fetch(`${API_BASE}/api/aiops/targets?namespace=${encodeURIComponent(namespace || "default")}`, {
        credentials: "same-origin",
        headers: gatewayHeaders({ accept: "application/json" })
      });
      const body = (await response.json()) as TargetCatalog;
      setTargetCatalog(body);
      setTargetCatalogStatus(response.ok && body.mode === "target_catalog" ? "ready" : "degraded");
    } catch {
      setTargetCatalog(null);
      setTargetCatalogStatus("degraded");
    }
  }, [namespace]);

  const refreshSimulations = React.useCallback(async () => {
    setSimulationStatus("loading");
    try {
      const response = await fetch(`${API_BASE}/api/aiops/simulations`, {
        credentials: "same-origin",
        headers: gatewayHeaders({ accept: "application/json" })
      });
      const body = await response.json();
      setSimulations(Array.isArray(body?.scenarios) ? body.scenarios : []);
      setSimulationStatus(response.ok && body?.mode === "simulation_catalog" ? "ready" : "degraded");
    } catch {
      setSimulations([]);
      setSimulationStatus("degraded");
    }
  }, []);

  React.useEffect(() => {
    if (isOpen) void refreshOverview();
  }, [isOpen]);

  React.useEffect(() => {
    if (isOpen && simulationStatus === "idle") void refreshSimulations();
  }, [isOpen, refreshSimulations, simulationStatus]);

  React.useEffect(() => {
    if (isOpen && showTargetControls) void refreshTargetCatalog();
  }, [isOpen, refreshTargetCatalog, showTargetControls]);

  React.useEffect(() => {
    if (isOpen && activeView === "chat" && autoScrollRef.current) {
      chatThreadRef.current?.scrollTo({
        top: chatThreadRef.current.scrollHeight,
        behavior: "auto"
      });
    }
  }, [activeView, isOpen, messages]);

  const handleChatScroll = React.useCallback(() => {
    const thread = chatThreadRef.current;
    if (!thread) return;
    const nearBottom = isNearBottom(thread);
    autoScrollRef.current = nearBottom;
    setShowScrollBottom(!nearBottom);
  }, []);

  const scrollToBottom = React.useCallback(() => {
    const thread = chatThreadRef.current;
    if (!thread) return;
    autoScrollRef.current = true;
    setShowScrollBottom(false);
    thread.scrollTo({
      top: thread.scrollHeight,
      behavior: "auto"
    });
  }, []);

  const openView = React.useCallback(
    (view: ActiveView) => {
      setActiveView(view);
      setShowTargetControls(false);
      setShowSuggestions(false);
      setShowModeMenu(false);
      if (view === "simulation" && simulationStatus !== "loading") {
        void refreshSimulations();
      }
      if (view !== "chat" && view !== "simulation" && overviewStatus !== "loading") {
        void refreshOverview();
      }
    },
    [overviewStatus, refreshOverview, refreshSimulations, simulationStatus]
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
    async (
      questionText: string,
      nextResourceName?: string,
      nextNamespace?: string,
      nextResourceKind?: string,
      simulationId?: string,
      simulationActionId?: string,
      modeOverride?: ChatMode
    ) => {
      if (isRunning) return;
      const submittedQuestion = normalizeQuestion(questionText, initialQuestionByLanguage[language]);
      const effectiveChatMode = modeOverride ?? chatMode;
      if (modeOverride && modeOverride !== chatMode) {
        setChatMode(modeOverride);
      }
      const inferredTarget = nextResourceName || nextNamespace || nextResourceKind ? undefined : inferTargetFromQuestion(submittedQuestion, simulations);
      const targetResourceName = nextResourceName ?? inferredTarget?.name ?? resourceName;
      const targetNamespace = nextNamespace ?? inferredTarget?.namespace ?? namespace;
      const targetResourceKind = nextResourceKind ?? inferredTarget?.kind ?? resourceKind;
      const simulation = simulationId
        ? {
            scenarioId: simulationId,
            actionId: simulationActionId
          }
        : undefined;
      if (inferredTarget) {
        setNamespace(inferredTarget.namespace);
        setResourceKind(inferredTarget.kind);
        setResourceName(inferredTarget.name);
      }
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      const userMessage: ChatMessage = {
        id: createMessageId("user"),
        role: "user",
        content: submittedQuestion,
        simulation
      };
      const pendingMessageId = createMessageId("assistant");
      setMessages((current) => [
        ...current,
        userMessage,
        {
          id: pendingMessageId,
          role: "assistant",
          content: copy.pending,
          question: submittedQuestion,
          isPending: true,
          simulation
        }
      ]);
      setIsRunning(true);
      setActiveView("chat");
      setQuestion("");
      setShowSuggestions(false);
      setShowModeMenu(false);
      autoScrollRef.current = true;
      setShowScrollBottom(false);

      try {
        const response = await fetch(`${API_BASE}/api/aiops/query`, {
          method: "POST",
          credentials: "same-origin",
          signal: abortController.signal,
          headers: gatewayHeaders({
            "content-type": "application/json",
            accept: "text/event-stream"
          }),
          body: JSON.stringify({
            question: submittedQuestion,
            scope: {
              cluster: simulationId ? "cas-simulation" : "local-cluster",
              namespaces: [targetNamespace || "default"]
            },
            resourceRef: {
              kind: targetResourceKind || (targetResourceName === "version" ? "ClusterVersion" : "Pod"),
              name: targetResourceName || "version"
            },
            mode: "read_only",
            brain_mode: effectiveChatMode,
            stream: true,
            locale: localeByLanguage[language],
            conversation_id: conversationId,
            context: {
              namespace: targetNamespace || "default",
              resourceKind: targetResourceKind || (targetResourceName === "version" ? "ClusterVersion" : "Pod"),
              resourceName: targetResourceName || "version",
              timeRange: effectiveChatMode === "troubleshooting" ? "1h" : null,
              safety: "read_only"
            },
            ui: {
              source: "console-plugin",
              selectedMode: effectiveChatMode,
              conversationId
            },
            simulation_id: simulationId,
            simulation_action_id: simulationActionId
          })
        });

        if (!response.ok) {
          throw new Error(await gatewayErrorMessage(response));
        }

        let streamedAnswer = "";
        let finalRun: RCAResult | null = null;
        const applyAssistantMessage = (patch: Partial<ChatMessage>) => {
          setMessages((current) =>
            current.map((message) =>
              message.id === pendingMessageId
                ? {
                    ...message,
                    ...patch
                  }
                : message
            )
          );
        };

        if (response.body && String(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
          await readSseStream(response, ({ event, data }) => {
            if (event === "status") {
              if (!streamedAnswer) {
                applyAssistantMessage({
                  content: statusMessageFromStream(data, copy.pending),
                  isPending: true
                });
              }
              return;
            }
            if (event === "token") {
              streamedAnswer += tokenFromStream(data);
              applyAssistantMessage({
                content: streamedAnswer || copy.pending,
                isPending: false
              });
              return;
            }
            if (event === "final_answer") {
              finalRun = data as RCAResult;
              const finalAnswer = finalRun.rca_result?.answer ?? streamedAnswer ?? copy.emptyAnswer;
              setConversationId(finalRun.conversation_id ?? conversationId);
              applyAssistantMessage({
                content: finalAnswer,
                isPending: false,
                result: finalRun
              });
              return;
            }
            if (event === "error") {
              const errorMessage =
                data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
                  ? String((data as { error?: unknown }).error)
                  : copy.failure;
              throw new Error(errorMessage);
            }
          });
        } else {
          const body = (await response.json()) as RCAResult;
          finalRun = body;
          setConversationId(body.conversation_id ?? conversationId);
          applyAssistantMessage({
            content: body.rca_result?.answer ?? copy.emptyAnswer,
            isPending: false,
            result: body
          });
        }

        if (!finalRun) {
          throw new Error(copy.emptyAnswer);
        }
      } catch (queryError) {
        const isAbort = queryError instanceof DOMException && queryError.name === "AbortError";
        setMessages((current) =>
          current.map((message) =>
            message.id === pendingMessageId
              ? {
                  ...message,
                  content: isAbort ? copy.abort : queryError instanceof Error ? queryError.message : copy.failure,
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
    [chatMode, conversationId, copy, isRunning, language, namespace, resourceKind, resourceName, rotateQuestionSuggestions, simulations]
  );

  const runQuery = React.useCallback(
    async (event?: React.FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      const trimmedQuestion = question.trim();
      if (!trimmedQuestion) {
        if (showSuggestions) {
          await submitQuestion(activeSuggestion);
          return;
        }
        setShowModeMenu(false);
        setShowSuggestions(true);
        return;
      }
      await submitQuestion(trimmedQuestion);
    },
    [activeSuggestion, question, showSuggestions, submitQuestion]
  );

  const stopQuery = React.useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  const retryMessage = React.useCallback(
    (message: ChatMessage) => {
      if (message.question) {
        const scenario = message.simulation?.scenarioId
          ? simulations.find((candidate) => candidate.id === message.simulation?.scenarioId)
          : undefined;
        void submitQuestion(
          message.question,
          scenario?.target.name,
          scenario?.target.namespace,
          scenario?.target.kind,
          message.simulation?.scenarioId,
          message.simulation?.actionId,
          message.simulation ? "troubleshooting" : undefined
        );
      }
    },
    [simulations, submitQuestion]
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
          const trimmedQuestion = question.trim();
          if (!trimmedQuestion) {
            if (showSuggestions) {
              void submitQuestion(activeSuggestion);
              return;
            }
            setShowModeMenu(false);
            setShowSuggestions(true);
            return;
          }
          void submitQuestion(trimmedQuestion);
        }
      }
    },
    [activeSuggestion, isRunning, question, showSuggestions, submitQuestion]
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

  const runSimulationQuestion = React.useCallback(
    (scenario: SimulationScenario, nextQuestion: string, remediation?: SimulationRemediation) => {
      setSelectedSimulationId(scenario.id);
      setNamespace(scenario.target.namespace);
      setResourceKind(scenario.target.kind);
      setResourceName(scenario.target.name);
      setActiveView("chat");
      void submitQuestion(
        nextQuestion,
        scenario.target.name,
        scenario.target.namespace,
        scenario.target.kind,
        scenario.id,
        remediation?.id,
        "troubleshooting"
      );
    },
    [submitQuestion]
  );

  const runSimulationScenario = React.useCallback(
    (scenario: SimulationScenario) => {
      runSimulationQuestion(scenario, scenario.question);
    },
    [runSimulationQuestion]
  );

  const runSimulationRemediation = React.useCallback(
    (scenario: SimulationScenario, remediation: SimulationRemediation) => {
      runSimulationQuestion(scenario, remediation.question ?? scenario.question, remediation);
    },
    [runSimulationQuestion]
  );

  const selectWorkload = React.useCallback(
    (workload: RiskWorkload) => {
      const nextQuestion =
        language === "en"
          ? `Analyze the root cause for ${workload.kind} ${workload.name} in namespace ${workload.namespace}.`
          : `${workload.namespace} namespace ${workload.name} ${workload.kind} 원인 분석해줘`;
      runOverviewQuestion(nextQuestion, workload.name, workload.namespace, workload.kind);
    },
    [language, runOverviewQuestion]
  );

  const resetConversation = React.useCallback(() => {
    abortControllerRef.current?.abort();
    setConversationId(null);
    setIsRunning(false);
    setCopiedMessageId(null);
    setActiveView("chat");
    setQuestion("");
    setShowTargetControls(false);
    setSelectedSimulationId(null);
    rotateQuestionSuggestions(language);
    autoScrollRef.current = true;
    setShowScrollBottom(false);
    setMessages([]);
  }, [language, rotateQuestionSuggestions]);

  return (
    <div className="cas-launcher-root" data-test="cas-launcher-root">
      <style>{styles}</style>
      {isOpen && (
        <section aria-label="Cywell AI Sentinel" className="cas-panel" data-test="cas-launcher-panel" role="dialog">
          <header className="cas-panel-header">
            <SentinelIcon />
            <div className="cas-panel-title">
              <strong>Cywell AI Sentinel</strong>
              <span>{copy.subtitle}</span>
            </div>
            <div className="cas-header-tools">
              <nav aria-label={copy.viewsNavLabel} className="cas-view-switcher" data-test="cas-view-switcher">
                {(["chat", "cockpit", "evidence", "actions", "simulation"] as ActiveView[]).map((view) => (
                  <React.Fragment key={view}>
                    <button
                      aria-label={copy.viewLabels[view]}
                      className="cas-view-button"
                      data-active={activeView === view}
                      data-test={`cas-view-${view}`}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        openView(view);
                      }}
                      title={copy.viewLabels[view]}
                      type="button"
                    >
                      <ViewIcon view={view} />
                    </button>
                    {view === "chat" && (
                      <button
                        aria-label={copy.newChat}
                        className="cas-view-button"
                        data-test="cas-new-chat"
                        disabled={isRunning}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          resetConversation();
                        }}
                        title={copy.newChat}
                        type="button"
                      >
                        <NewChatIcon />
                      </button>
                    )}
                  </React.Fragment>
                ))}
              </nav>
              <button
                aria-label={`${copy.targetPrefix}: ${targetSummary}`}
                className="cas-view-button"
                data-active={showTargetControls}
                data-test="cas-target-toggle"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setShowTargetControls((current) => !current);
                }}
                title={`${copy.targetPrefix}: ${targetSummary}`}
                type="button"
              >
                <TargetIcon />
              </button>
              <button
                aria-label={copy.tutorialLabel}
                className="cas-view-button"
                data-active={showTutorial}
                data-test="cas-tutorial-toggle"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openTutorial();
                }}
                title={copy.tutorialLabel}
                type="button"
              >
                <HelpIcon />
              </button>
              <button
                aria-label={copy.languageTitle}
                className="cas-view-button cas-language-toggle"
                data-language={language}
                data-test="cas-language-toggle"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  toggleLanguage();
                }}
                title={copy.languageTitle}
                type="button"
              >
                <GlobeIcon />
                <span>{language === "ko" ? "한" : "EN"}</span>
              </button>
              <button
                aria-label={copy.closeLabel}
                className="cas-close"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setIsOpen(false);
                }}
                type="button"
              >
                x
              </button>
            </div>
          </header>

          <div className="cas-panel-body" data-target-open={showTargetControls ? "true" : "false"}>
            <div
              className="cas-status-row"
              data-test="cas-brain-status"
              title={`${brainStatus.provider} · ${brainStatus.detail}${conversationId ? ` · ${conversationId}` : ""}`}
            >
              <span className="cas-status-light" data-state={brainStatus.state} />
              <span className="cas-status-label">{statusLabel}</span>
            </div>

            {showTargetControls && (
              <div className="cas-target-popover" data-test="cas-target-fields">
                <div className="cas-target-heading">
                  <div>
                    <strong>{copy.targetTitle}</strong>
                    <div className="cas-target-current">
                      {copy.targetCurrent}: {targetSummary}
                    </div>
                    <div className="cas-target-current">
                      {targetCatalogStatus === "loading"
                        ? language === "ko"
                          ? "대상 목록 확인 중"
                          : "Loading target list"
                        : language === "ko"
                          ? `${targetOptions.length}개 대상 선택 가능`
                          : `${targetOptions.length} targets available`}
                    </div>
                  </div>
                  <button
                    className="cas-link-button"
                    onClick={() => setShowTargetControls(false)}
                    type="button"
                  >
                    {copy.targetClose}
                  </button>
                </div>
                <div className="cas-fields">
                  <label className="cas-target-field">
                    <span>{copy.targetNamespace}</span>
                    <select
                      aria-label={copy.targetNamespace}
                      data-test="cas-target-namespace-select"
                      onChange={(event) => selectNamespace(event.currentTarget.value)}
                      value={namespace}
                    >
                      {namespaceOptions.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="cas-target-field">
                    <span>{copy.targetKind}</span>
                    <select
                      aria-label={copy.targetKind}
                      data-test="cas-target-kind-select"
                      onChange={(event) => selectKind(event.currentTarget.value)}
                      value={resourceKind}
                    >
                      {kindOptions.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="cas-target-field">
                    <span>{copy.targetName}</span>
                    <select
                      aria-label={copy.targetName}
                      data-test="cas-target-name-select"
                      onChange={(event) => selectName(event.currentTarget.value)}
                      value={resourceName}
                    >
                      {nameOptions.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="cas-target-actions">
                  <button
                    className="cas-small-button"
                    data-variant="secondary"
                    onClick={() => setShowTargetControls(false)}
                    type="button"
                  >
                    {copy.targetClose}
                  </button>
                  <button
                    className="cas-small-button"
                    data-variant="primary"
                    onClick={() => setShowTargetControls(false)}
                    type="button"
                  >
                    {copy.targetApply}
                  </button>
                </div>
              </div>
            )}

            {activeView === "chat" ? (
              <div className="cas-chat-surface" data-test="cas-chat-default-view">
                <div className="cas-chat-thread" data-test="cas-chat-thread" onScroll={handleChatScroll} ref={chatThreadRef}>
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
                        {message.isPending ? (
                          <PendingAnswer content={message.content} />
                        ) : (
                          <MarkdownAnswer content={message.content} primary={message.role === "assistant" && Boolean(message.result)} />
                        )}
                        {message.result && (
                          <>
                            {isFallback && (
                              <div className="cas-badge" data-state="degraded" data-test="cas-fallback-notice">
                                fallback active
                              </div>
                            )}
                            <RcaTrace copy={copy} result={message.result} />
                            <EvidenceSummary copy={copy} result={message.result} />
                            <SimulationNextActions
                              copy={copy}
                              isRunning={isRunning}
                              message={message}
                              onOpenLab={() => setActiveView("simulation")}
                              onRunQuestion={runSimulationQuestion}
                              onRunRemediation={runSimulationRemediation}
                              scenarios={simulations}
                            />
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
                {showScrollBottom && (
                  <button className="cas-scroll-bottom" data-test="cas-scroll-bottom" onClick={scrollToBottom} type="button">
                    <ArrowDownIcon />
                    {copy.scrollBottom}
                  </button>
                )}

                <form className="cas-compose" onSubmit={runQuery}>
                  <div className="cas-suggestion-shell" data-visible={showSuggestions && question.trim().length === 0 ? "true" : "false"}>
                    <div aria-label={copy.suggestionLabel} className="cas-suggestion-list" data-test="cas-suggestion-list">
                      {questionSuggestions.map((suggestion, index) => (
                        <button
                          className="cas-suggestion"
                          data-active={activeSuggestionIndex === index}
                          data-test="cas-suggestion"
                          disabled={isRunning}
                          key={suggestion}
                          onClick={() => submitSuggestion(suggestion, index)}
                          onMouseEnter={() => setActiveSuggestionIndex(index)}
                          title={suggestion}
                          type="button"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="cas-input-wrap">
                    <textarea
                      aria-label="AI Sentinel question"
                      onChange={(event) => {
                        setQuestion(event.currentTarget.value);
                        setShowSuggestions(false);
                      }}
                      onFocus={() => setShowSuggestions(false)}
                      onKeyDown={handleQuestionKeyDown}
                      placeholder={copy.inputPlaceholder}
                      value={question}
                    />
                    <div className="cas-input-tools">
                      <button
                        aria-expanded={showSuggestions}
                        aria-label={copy.suggestionLabel}
                        className="cas-compose-icon-button cas-suggestion-button"
                        data-active={showSuggestions}
                        data-test="cas-suggestion-toggle"
                        disabled={isRunning}
                        onClick={() => {
                          setShowModeMenu(false);
                          setShowSuggestions((current) => !current);
                        }}
                        title={copy.suggestionLabel}
                        type="button"
                      >
                        <PlusIcon />
                      </button>
                      <div
                        aria-label={copy.modeSelectorLabel}
                        className="cas-mode-selector"
                        data-test="cas-mode-selector"
                        onBlur={(event) => {
                          const nextTarget = event.relatedTarget;
                          if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
                            setShowModeMenu(false);
                          }
                        }}
                      >
                        <button
                          aria-expanded={showModeMenu}
                          aria-haspopup="menu"
                          className="cas-mode-button"
                          data-open={showModeMenu}
                          data-test="cas-mode-current"
                          onClick={() => setShowModeMenu((current) => !current)}
                          title={copy.modeTitles[chatMode]}
                          type="button"
                        >
                          <ModeIcon mode={chatMode} />
                          <span>{copy.modeLabels[chatMode]}</span>
                          <ChevronDownIcon />
                        </button>
                        <div className="cas-mode-menu" data-open={showModeMenu ? "true" : "false"} role="menu">
                          {(["ask", "troubleshooting"] as ChatMode[]).map((mode) => (
                          <button
                            aria-checked={chatMode === mode}
                            className="cas-mode-option"
                            data-active={chatMode === mode}
                            data-test={`cas-mode-${mode}`}
                            key={mode}
                            onClick={() => {
                              setChatMode(mode);
                              setShowModeMenu(false);
                            }}
                            role="menuitemradio"
                            title={copy.modeTitles[mode]}
                            type="button"
                          >
                            <ModeIcon mode={mode} />
                            <strong>{copy.modeLabels[mode]}</strong>
                            <span>{copy.modeDescriptions[mode]}</span>
                            <span className="cas-mode-check">
                              <CheckIcon />
                            </span>
                          </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    {isRunning ? (
                      <button
                        aria-label={copy.stopLabel}
                        className="cas-send-button"
                        data-test="cas-stop-analysis"
                        onClick={stopQuery}
                        title={copy.stopLabel}
                        type="button"
                      >
                        <SendIcon mode="stop" />
                      </button>
                    ) : (
                      <button
                        aria-label={copy.sendLabel}
                        className="cas-send-button"
                        data-test="cas-send-question"
                        title={copy.sendLabel}
                        type="submit"
                      >
                        <SendIcon mode="send" />
                      </button>
                    )}
                  </div>
                </form>
              </div>
            ) : activeView === "simulation" ? (
              <SimulationLab
                copy={copy}
                isRunning={isRunning}
                scenarios={simulations}
                selectedScenarioId={selectedSimulationId}
                status={simulationStatus}
                onRefresh={refreshSimulations}
                onRunRemediation={runSimulationRemediation}
                onRunScenario={runSimulationScenario}
              />
            ) : (
              <OverviewCockpit
                activeView={activeView}
                copy={copy}
                overview={overview}
                status={overviewStatus}
                onRefresh={refreshOverview}
                onRunQuestion={runOverviewQuestion}
                onSelectWorkload={selectWorkload}
                isRunning={isRunning}
              />
            )}
          </div>
          {showTutorial && (
            <TutorialOverlay
              copy={copy}
              stepIndex={tutorialStepIndex}
              onBack={previousTutorialStep}
              onClose={closeTutorial}
              onNext={nextTutorialStep}
            />
          )}
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
