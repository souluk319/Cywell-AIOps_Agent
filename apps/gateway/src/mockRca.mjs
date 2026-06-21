import {
  PRODUCT,
  assertReadOnlyToolPlan,
  createEvidenceBundle,
  createRcaResult,
  createToolPlan
} from "../../../packages/contracts/src/index.js";

export function createMockOomKilledRun(input = {}) {
  const question = String(input.question ?? "default namespace의 api pod가 왜 재시작됐어?");
  const namespace =
    input.scope?.namespaces?.[0] ??
    input.namespace ??
    input.resourceRef?.namespace ??
    "default";
  const podName = input.resourceRef?.name ?? "api-7c8d9";
  const runId = `cas-mock-${Date.now()}`;

  const toolPlan = createToolPlan({
    task_type: "pod_restart_rca",
    target: {
      platform: "openshift",
      namespace,
      kind: "Pod",
      name: podName
    }
  });
  const guard = assertReadOnlyToolPlan(toolPlan);

  const evidenceBundle = createEvidenceBundle({
    run_id: runId,
    target: {
      namespace,
      kind: "Pod",
      name: podName
    },
    evidence: [
      {
        id: "pod:last-state",
        type: "pod_status",
        summary: "container app lastState.terminated.reason is OOMKilled",
        source: "mock.openshift.pod",
        observed_at: "2026-06-21T02:14:00+09:00"
      },
      {
        id: "event:oomkilled",
        type: "event",
        summary: "Container was killed because it exceeded the configured memory limit",
        source: "mock.kubernetes.events",
        observed_at: "2026-06-21T02:14:01+09:00"
      },
      {
        id: "log:previous",
        type: "log",
        summary: "previous log shows memory allocation spike before termination",
        source: "mock.kubernetes.logs.previous",
        observed_at: "2026-06-21T02:13:58+09:00"
      }
    ],
    missing: [
      {
        type: "metric",
        reason: "Prometheus adapter is not configured in mock mode"
      }
    ]
  });

  const rcaResult = createRcaResult({
    cause_candidates: [
      {
        cause: "memory limit exceeded",
        confidence: 0.86,
        evidence_refs: ["pod:last-state", "event:oomkilled", "log:previous"]
      },
      {
        cause: "traffic burst increased memory allocation",
        confidence: 0.42,
        evidence_refs: ["log:previous"]
      }
    ],
    answer:
      `${namespace}/${podName} Pod는 memory limit 초과로 OOMKilled 재시작된 가능성이 높습니다. ` +
      "현재 단계는 mock evidence 기반이며, 다음 단계에서 실제 OpenShift Pod/Event/Previous Log 조회로 교체합니다."
  });

  return {
    product: PRODUCT.officialName,
    mode: "mock_read_only",
    run_id: runId,
    question,
    guardrail: {
      read_only: guard.ok,
      violations: guard.violations
    },
    tool_plan: toolPlan,
    evidence_bundle: evidenceBundle,
    rca_result: rcaResult,
    audit: {
      audit_id: `audit-${runId}`,
      auth_mode: "mock",
      answer_provider: "rule-based-mock",
      response_schema_valid: true,
      redaction_applied: true
    }
  };
}

export function streamMockRun(response, run) {
  const events = [
    ["tool_plan", run.tool_plan],
    ["evidence", run.evidence_bundle],
    ["final_answer", run]
  ];

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  for (const [event, data] of events) {
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  }
  response.end();
}

