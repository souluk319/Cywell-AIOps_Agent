import * as React from "react";
import { createRoot } from "react-dom/client";
import { CASLauncher } from "./plugin/useCASLauncher";

const API_BASE = "/api/proxy/plugin/cywell-ai-sentinel/cas-api";
const CONVERSATION_STORAGE_KEY = "cas:conversations:v0.1.2-wing";
const TUTORIAL_STORAGE_KEY = "cas:onboarding:v0.1.1";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function sseResponse(events: Array<{ event: string; data: unknown }>) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const item of events) {
        controller.enqueue(encoder.encode(`event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`));
      }
      controller.close();
    }
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8"
    }
  });
}

function sampleRcaResult(question: string) {
  return {
    run_id: "local-preview-run",
    mode: "read_only",
    conversation_id: "local-preview-conversation",
    tool_plan: {
      task_type: "read_only_rca",
      tool_plan: [
        { step: 1, tool: "openshift", verb: "read" },
        { step: 2, tool: "metric", verb: "query" },
        { step: 3, tool: "runbook", verb: "search" }
      ]
    },
    audit: {
      answer_provider: "local-preview",
      brain: {
        provider: "openshift-lightspeed",
        status: "ok"
      }
    },
    rca_result: {
      answer:
        `질문: ${question}\n\n` +
        "현재 로컬 프리뷰 기준으로는 **ClusterVersion/version이 정상 수렴 상태**입니다.\n\n" +
        "### 근거\n" +
        "- `Available=True`\n" +
        "- `Progressing=False`\n" +
        "- 최근 Warning 이벤트와 재시작 급증은 mock 데이터에서 발견되지 않았습니다.\n\n" +
        "### 다음 확인\n" +
        "1. `oc get clusterversion version -o yaml`\n" +
        "2. `oc get events -A --field-selector type=Warning`\n" +
        "3. 대상 namespace의 Pod 재시작 증가 여부 확인",
      cause_candidates: [
        {
          cause: "No active workload risk detected in selected scope",
          confidence: 0.35,
          evidence_refs: ["openshift:clusterversion:version", "metric:namespace_restart_increase_by_pod:default"]
        }
      ]
    },
    evidence_bundle: {
      evidence_status: [
        { type: "openshift", status: "collected", count: 1 },
        { type: "metric", status: "collected", count: 1 },
        { type: "runbook", status: "collected", count: 1 }
      ],
      evidence: [
        {
          id: "openshift:clusterversion:version",
          type: "openshift",
          source: "apis/config.openshift.io/v1/clusterversions/version",
          summary: "ClusterVersion desired=4.20.5 conditions=[Available=True, Progressing=False]"
        },
        {
          id: "metric:namespace_restart_increase_by_pod:default",
          type: "metric",
          source: "thanos.api.v1.query",
          summary: "namespace_restart_increase_by_pod returned no-series"
        },
        {
          id: "runbook:komsco_ops_evidence:evidence-audit-pack-minimum",
          type: "runbook",
          source: "synthetic://komsco/evidence/audit-pack",
          summary: "KOMSCO Synthetic Evidence Handling Guide > Minimum RCA pack"
        }
      ],
      missing: []
    }
  };
}

function overviewResult() {
  return {
    mode: "overview_read_only",
    scope: {
      cluster: "local-preview",
      namespaces: ["default"]
    },
    health: {
      score: 100,
      risk: "low",
      summary: "No active workload risk detected in selected scope"
    },
    signals: {
      warning_events: 0,
      restart_spikes: 0,
      pending_pods: 0,
      risky_workloads: 0
    },
    event_reasons: [],
    risk_workloads: [],
    rca_candidate: {
      cause: "No active workload risk detected in selected scope",
      confidence: 0.35,
      evidence_refs: ["openshift:clusterversion:version"]
    },
    evidence_timeline: [
      {
        id: "timeline-clusterversion",
        ts: new Date().toISOString(),
        type: "openshift",
        summary: "ClusterVersion desired=4.20.5 conditions=[Available=True, Progressing=False]",
        source: "apis/config.openshift.io/v1/clusterversions/version"
      }
    ],
    evidence_status: [
      { type: "openshift", status: "collected", count: 1 },
      { type: "metric", status: "collected", count: 1 },
      { type: "runbook", status: "collected", count: 1 }
    ],
    evidence_groups: {
      openshift: [
        {
          id: "openshift:clusterversion:version",
          type: "openshift",
          source: "apis/config.openshift.io/v1/clusterversions/version",
          summary: "ClusterVersion desired=4.20.5 conditions=[Available=True, Progressing=False]"
        }
      ],
      metric: [
        {
          id: "metric:namespace_restart_increase_by_pod:default",
          type: "metric",
          source: "thanos.api.v1.query",
          summary: "namespace_restart_increase_by_pod returned no-series"
        }
      ],
      runbook: [
        {
          id: "runbook:komsco_ops_evidence:evidence-audit-pack-minimum",
          type: "runbook",
          source: "synthetic://komsco/evidence/audit-pack",
          summary: "KOMSCO Synthetic Evidence Handling Guide > Minimum RCA pack"
        }
      ],
      missing: []
    },
    actions: [
      {
        id: "open-events",
        label: "Open namespace events",
        type: "cas_query",
        question: "현재 namespace의 Warning 이벤트를 읽기 전용으로 요약해줘."
      },
      {
        id: "check-restarts",
        label: "Check Pod restarts",
        type: "cas_query",
        question: "최근 재시작이 증가한 Pod가 있는지 확인해줘."
      }
    ],
    missing: []
  };
}

function seedPreviewStorage() {
  try {
    window.localStorage.setItem(TUTORIAL_STORAGE_KEY, "seen");
    if (window.localStorage.getItem(CONVERSATION_STORAGE_KEY)) return;
    window.localStorage.setItem(
      CONVERSATION_STORAGE_KEY,
      JSON.stringify([
        {
          id: "local-preview-clusterversion",
          title: "ClusterVersion 상태",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          conversation_id: "local-preview-conversation",
          target: { namespace: "default", kind: "ClusterVersion", name: "version" },
          chat_mode: "ask",
          messages: [
            { id: "user-preview-1", role: "user", content: "ClusterVersion 상태를 한 문장으로 요약해줘." },
            {
              id: "assistant-preview-1",
              role: "assistant",
              content: "ClusterVersion version은 현재 4.20.5로 수렴 완료된 정상 상태로 보입니다."
            }
          ]
        },
        {
          id: "local-preview-events",
          title: "Warning 이벤트 점검",
          created_at: new Date().toISOString(),
          updated_at: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
          conversation_id: "local-preview-conversation-2",
          target: { namespace: "komsco-batch", kind: "Pod", name: "settlement-worker" },
          chat_mode: "troubleshooting",
          messages: [
            { id: "user-preview-2", role: "user", content: "Warning 이벤트 기준으로 장애 후보를 찾아줘." }
          ]
        }
      ])
    );
  } catch {
    // Local preview still works when storage is unavailable.
  }
}

function installMockApi() {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, window.location.origin);
    if (!url.pathname.startsWith(API_BASE)) {
      return nativeFetch(input, init);
    }

    if (url.pathname.endsWith("/api/aiops/brainz")) {
      return jsonResponse({ status: "ok", brain: { provider: "openshift-lightspeed", status: "ok" } });
    }

    if (url.pathname.endsWith("/api/aiops/overview")) {
      return jsonResponse(overviewResult());
    }

    if (url.pathname.endsWith("/api/aiops/targets")) {
      return jsonResponse({
        mode: "target_catalog",
        targets: [
          { namespace: "__all_namespaces__", kind: "Namespace", name: "__all_namespaces__" },
          { namespace: "default", kind: "ClusterVersion", name: "version" },
          { namespace: "komsco-batch", kind: "Pod", name: "settlement-worker-28477112-qx4kp" },
          { namespace: "komsco-secure", kind: "Pod", name: "audit-log-writer-59dff8b949-hc2k8" }
        ],
        missing: []
      });
    }

    if (url.pathname.endsWith("/api/aiops/simulations")) {
      return jsonResponse({
        mode: "simulation_catalog",
        scenarios: [
          {
            id: "local-preview-normal",
            title: "정상 ClusterVersion 확인",
            summary: "로컬 프리뷰에서 안전한 RCA 흐름을 확인합니다.",
            category: "preview",
            risk: "low",
            question: "ClusterVersion 상태를 요약해줘.",
            signals: { warnings: 0, restarts: 0, metric_series: 1 },
            remediations: []
          }
        ]
      });
    }

    if (url.pathname.endsWith("/api/aiops/query")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      const question = typeof body.question === "string" ? body.question : "현재 상태를 요약해줘.";
      const result = sampleRcaResult(question);
      return sseResponse([
        { event: "status", data: { message: "자료 확인 중" } },
        { event: "token", data: { token: result.rca_result.answer.slice(0, 48) } },
        { event: "token", data: { token: result.rca_result.answer.slice(48) } },
        { event: "final_answer", data: result }
      ]);
    }

    return jsonResponse({ error: "local preview mock route not found" }, 404);
  }) as typeof window.fetch;
}

seedPreviewStorage();
installMockApi();

const rootElement = document.getElementById("cas-local-preview-root");
if (!rootElement) throw new Error("Missing #cas-local-preview-root");

createRoot(rootElement).render(
  <React.StrictMode>
    <CASLauncher />
  </React.StrictMode>
);

window.setTimeout(() => {
  document.querySelector<HTMLButtonElement>('[data-test="cas-launcher-button"]')?.click();
}, 100);
