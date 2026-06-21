export const PRODUCT = {
  officialName: "Cywell AI Sentinel",
  shortName: "CAS",
  consoleDisplayName: "AI Sentinel",
  namespace: "cywell-ai-sentinel",
  apiGroup: "ai.cywell.co.kr",
  crdKind: "CywellAISentinel"
};

export const READ_ONLY_VERBS = ["get", "list", "watch"];

export const FORBIDDEN_ACTIONS = [
  "create",
  "update",
  "patch",
  "delete",
  "exec",
  "portforward",
  "restart",
  "scale",
  "rollout"
];

export function createAnalyzeRequest(overrides = {}) {
  return {
    question: "default namespace의 api pod가 왜 재시작됐어?",
    scope: {
      cluster: "local-cluster",
      namespaces: ["default"],
      time_range: {
        from: "2026-06-21T00:00:00+09:00",
        to: "2026-06-21T06:00:00+09:00"
      }
    },
    resourceRef: {
      kind: "Pod",
      name: "api-7c8d9"
    },
    mode: "read_only",
    stream: true,
    locale: "ko-KR",
    conversation_id: "conv-20260621-001",
    ...overrides
  };
}

export function createToolPlan(overrides = {}) {
  return {
    task_type: "pod_restart_rca",
    target: {
      platform: "openshift",
      namespace: "default",
      kind: "Pod",
      name: "api-7c8d9"
    },
    execution_policy: {
      mode: "read_only"
    },
    tool_plan: [
      { step: 1, tool: "get_pod", verb: "get" },
      { step: 2, tool: "get_events", verb: "list" },
      { step: 3, tool: "get_previous_logs", verb: "get" },
      { step: 4, tool: "query_metrics", verb: "get", optional: true },
      { step: 5, tool: "search_runbook", verb: "get", optional: true }
    ],
    ...overrides
  };
}

export function createEvidenceBundle(overrides = {}) {
  return {
    run_id: "20260621-001",
    target: {
      namespace: "default",
      kind: "Pod",
      name: "api-7c8d9"
    },
    evidence: [
      {
        id: "event:oomkilled",
        type: "event",
        summary: "Container terminated with OOMKilled",
        source: "kubernetes.events",
        observed_at: "2026-06-21T02:14:00+09:00"
      }
    ],
    missing: [
      {
        type: "metric",
        reason: "Prometheus endpoint not configured"
      }
    ],
    ...overrides
  };
}

export function createRcaResult(overrides = {}) {
  return {
    cause_candidates: [
      {
        cause: "memory limit exceeded",
        confidence: 0.86,
        evidence_refs: ["event:oomkilled", "log:previous"]
      }
    ],
    immediate_actions: [
      "previous container log에서 OOM 직전 요청 패턴 확인",
      "memory limit과 request 설정 검토"
    ],
    prevention: ["memory limit baseline 재산정", "OOMKilled alert rule 추가"],
    answer: "Pod는 지정된 memory limit을 초과해 OOMKilled로 종료된 가능성이 높습니다.",
    ...overrides
  };
}

export function createOverviewResult(overrides = {}) {
  return {
    product: PRODUCT.officialName,
    mode: "overview_read_only",
    scope: {
      cluster: "local-cluster",
      namespaces: ["default"]
    },
    health: {
      score: 82,
      risk: "medium",
      summary: "Warning events and restart spikes detected in the selected scope"
    },
    signals: {
      warning_events: 0,
      restart_spikes: 0,
      pending_pods: 0,
      risky_workloads: 0
    },
    risk_workloads: [],
    rca_candidate: {
      cause: "No high-confidence RCA candidate yet",
      confidence: 0,
      evidence_refs: []
    },
    evidence_timeline: [],
    actions: [],
    missing: [],
    ...overrides
  };
}

export function assertReadOnlyToolPlan(toolPlan) {
  const violations = [];
  if (toolPlan?.execution_policy?.mode !== "read_only") {
    violations.push("execution_policy.mode must be read_only");
  }

  for (const step of toolPlan?.tool_plan ?? []) {
    const verb = String(step.verb ?? "").toLowerCase();
    const tool = String(step.tool ?? "").toLowerCase();
    if (verb && !READ_ONLY_VERBS.includes(verb)) {
      violations.push(`step ${step.step ?? "unknown"} uses non-read-only verb ${verb}`);
    }
    if (FORBIDDEN_ACTIONS.some((action) => tool.includes(action))) {
      violations.push(`step ${step.step ?? "unknown"} uses forbidden tool ${step.tool}`);
    }
  }

  return {
    ok: violations.length === 0,
    violations
  };
}
