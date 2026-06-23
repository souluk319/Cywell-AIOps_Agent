#!/usr/bin/env node
import {
  buildOpenShiftEvidenceContext,
  collectOpenShiftOverview,
  collectOpenShiftEvidence,
  collectOpenShiftTargets,
  enrichInputWithOpenShiftEvidence
} from "../apps/gateway/src/openshiftEvidence.mjs";
import { collectMetricEvidence } from "../apps/gateway/src/metricAdapter.mjs";
import { collectRunbookEvidence } from "../apps/gateway/src/runbookAdapter.mjs";

const checks = [];

function record(status, id, detail) {
  checks.push({ status, id, detail });
  console.log(`[${status}] ${id}: ${detail}`);
}

function pass(id, detail) {
  record("PASS", id, detail);
}

function fail(id, detail) {
  record("FAIL", id, detail);
}

function expect(id, condition, passDetail, failDetail = passDetail) {
  if (condition) pass(id, passDetail);
  else fail(id, failDetail);
}

const config = {
  provider: "openshift-api",
  apiUrl: "https://openshift.example",
  timeoutMs: 1000,
  tlsInsecure: true,
  logTailLines: 12
};
const metricConfig = {
  provider: "thanos",
  thanosUrl: "https://thanos.example",
  timeoutMs: 1000,
  tlsInsecure: true
};
const runbookConfig = {
  provider: "jsonl",
  corpusPath: "apps/gateway/runbooks/komsco-ops-sim.jsonl",
  topK: 5
};

const transport = async (url) => {
  const target = new URL(url);
  const path = `${target.pathname}${target.search}`;
  if (path === "/apis/config.openshift.io/v1/clusterversions/version") {
    return {
      statusCode: 200,
      body: JSON.stringify({
        status: {
          desired: { version: "4.20.5" },
          conditions: [
            { type: "Available", status: "True" },
            { type: "Progressing", status: "False" },
            { type: "Degraded", status: "False" }
          ]
        }
      })
    };
  }
  if (path === "/api/v1/namespaces/default") {
    return {
      statusCode: 200,
      body: JSON.stringify({
        metadata: { name: "default" },
        status: { phase: "Active" }
      })
    };
  }
  if (path === "/api/v1/namespaces/default/pods/api-7c8d9") {
    return {
      statusCode: 200,
      body: JSON.stringify({
        metadata: { name: "api-7c8d9" },
        spec: { nodeName: "crc-node", containers: [{ name: "api" }] },
        status: {
          phase: "Running",
          containerStatuses: [
            {
              name: "api",
              restartCount: 2,
              state: { running: {} },
              lastState: { terminated: { reason: "OOMKilled" } }
            }
          ]
        }
      })
    };
  }
  if (path === "/api/v1/namespaces/default/pods?limit=50") {
    return {
      statusCode: 200,
      body: JSON.stringify({
        items: [
          {
            metadata: { name: "api-7c8d9" },
            spec: { nodeName: "crc-node", containers: [{ name: "api" }] },
            status: {
              phase: "Running",
              containerStatuses: [
                {
                  name: "api",
                  restartCount: 2,
                  state: { running: {} },
                  lastState: { terminated: { reason: "OOMKilled" } }
                }
              ]
            }
          },
          {
            metadata: { name: "worker-pending" },
            status: {
              phase: "Pending",
              containerStatuses: []
            }
          }
        ]
      })
    };
  }
  if (path === "/api/v1/namespaces?limit=80") {
    return {
      statusCode: 200,
      body: JSON.stringify({
        items: [{ metadata: { name: "default" } }, { metadata: { name: "komsco-batch" } }]
      })
    };
  }
  if (path === "/api/v1/pods?limit=100") {
    return {
      statusCode: 200,
      body: JSON.stringify({
        items: [
          {
            metadata: { namespace: "default", name: "api-7c8d9" },
            status: {
              phase: "Running",
              containerStatuses: [{ name: "api", restartCount: 2, state: { running: {} } }]
            }
          },
          {
            metadata: { namespace: "komsco-batch", name: "settlement-worker-28477112-qx4kp" },
            status: {
              phase: "Pending",
              containerStatuses: []
            }
          }
        ]
      })
    };
  }
  if (path === "/api/v1/events?limit=120") {
    return {
      statusCode: 200,
      body: JSON.stringify({
        items: [
          {
            type: "Warning",
            reason: "OOMKilled",
            message: "Container api was terminated because it used too much memory",
            involvedObject: { namespace: "default", kind: "Pod", name: "api-7c8d9" },
            lastTimestamp: "2026-06-21T09:12:00Z"
          },
          {
            type: "Warning",
            reason: "FailedScheduling",
            message: "0/1 nodes are available: insufficient memory",
            involvedObject: { namespace: "komsco-batch", kind: "Pod", name: "settlement-worker-28477112-qx4kp" },
            lastTimestamp: "2026-06-21T09:13:00Z"
          }
        ]
      })
    };
  }
  if (path === "/api/v1/namespaces/default/pods?limit=100") {
    return {
      statusCode: 200,
      body: JSON.stringify({
        items: [{ metadata: { name: "api-7c8d9" } }, { metadata: { name: "worker-pending" } }]
      })
    };
  }
  if (path === "/apis/apps/v1/namespaces/default/deployments?limit=80") {
    return {
      statusCode: 200,
      body: JSON.stringify({
        items: [{ metadata: { name: "api" } }]
      })
    };
  }
  if (path === "/api/v1/namespaces/komsco-batch/pods?limit=100") {
    return {
      statusCode: 200,
      body: JSON.stringify({
        items: [{ metadata: { name: "settlement-worker-28477112-qx4kp" } }]
      })
    };
  }
  if (path === "/apis/apps/v1/namespaces/komsco-batch/deployments?limit=80") {
    return {
      statusCode: 200,
      body: JSON.stringify({
        items: [{ metadata: { name: "settlement-worker" } }]
      })
    };
  }
  if (path === "/api/v1/namespaces/default/events?limit=80") {
    return {
      statusCode: 200,
      body: JSON.stringify({
        items: [
          {
            type: "Warning",
            reason: "OOMKilled",
            message: "Container api was terminated because it used too much memory",
            involvedObject: { kind: "Pod", name: "api-7c8d9" },
            lastTimestamp: "2026-06-21T09:12:00Z"
          },
          {
            type: "Warning",
            reason: "FailedScheduling",
            message: "0/1 nodes are available: insufficient memory",
            involvedObject: { kind: "Pod", name: "worker-pending" },
            lastTimestamp: "2026-06-21T09:13:00Z"
          }
        ]
      })
    };
  }
  if (path.startsWith("/api/v1/namespaces/default/events?")) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        items: [
          {
            reason: "Killing",
            message: "Container api failed liveness probe",
            lastTimestamp: "2026-06-21T09:00:00Z"
          }
        ]
      })
    };
  }
  if (path.startsWith("/api/v1/namespaces/default/pods/api-7c8d9/log?")) {
    return {
      statusCode: 200,
      body: "FATAL heap allocation failed\nprocess exited"
    };
  }
  return {
    statusCode: 404,
    body: JSON.stringify({ message: `not found: ${path}` })
  };
};

const metricTransport = async (url) => {
  const target = new URL(url);
  const query = target.searchParams.get("query") ?? "";
  if (query.includes("kube_pod_container_status_restarts_total")) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        status: "success",
        data: {
          resultType: "vector",
          result: [{ metric: { pod: "api-7c8d9" }, value: [Date.now() / 1000, "2"] }]
        }
      })
    };
  }
  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: {
        resultType: "vector",
        result: []
      }
    })
  };
};

const clusterVersion = await collectOpenShiftEvidence(
  {
    question: "ClusterVersion 상태 요약",
    resourceRef: { kind: "ClusterVersion", name: "version" },
    scope: { namespaces: ["default"] }
  },
  {
    authorization: "Bearer test-token",
    config,
    transport
  }
);

expect(
  "evidence:clusterversion",
  clusterVersion.evidence.some((item) => item.id === "openshift:clusterversion:version"),
  "ClusterVersion evidence is collected through OpenShift API"
);
expect(
  "evidence:clusterversion-summary",
  clusterVersion.evidence.some((item) => item.summary.includes("Available=True")),
  "ClusterVersion condition summary is captured"
);

const pod = await collectOpenShiftEvidence(
  {
    question: "default namespace의 api pod가 왜 재시작됐어?",
    resourceRef: { kind: "Pod", name: "api-7c8d9" },
    scope: { namespaces: ["default"] }
  },
  {
    authorization: "Bearer test-token",
    config,
    transport,
    metricConfig,
    runbookConfig,
    metricTransport
  }
);

expect("evidence:namespace", pod.evidence.some((item) => item.id === "openshift:namespace:default"), "namespace evidence is collected");
expect("evidence:pod", pod.evidence.some((item) => item.id === "openshift:pod:default:api-7c8d9"), "pod evidence is collected");
expect("evidence:events", pod.evidence.some((item) => item.id === "openshift:events:default:api-7c8d9"), "pod event evidence is collected");
expect(
  "evidence:previous-log",
  pod.evidence.some((item) => item.id === "openshift:previous-log:default:api-7c8d9:api"),
  "previous pod log evidence is collected"
);
expect("evidence:metric", pod.evidence.some((item) => item.type === "metric"), "metric evidence is collected through Thanos adapter");
expect("evidence:runbook", pod.evidence.some((item) => item.type === "runbook"), "runbook evidence is collected through JSONL adapter");
expect(
  "evidence:status",
  pod.evidence_status?.some((item) => item.type === "metric" && item.status === "collected") &&
    pod.evidence_status?.some((item) => item.type === "runbook" && item.status === "collected"),
  "evidence_status marks metric and runbook as collected"
);

const context = buildOpenShiftEvidenceContext(pod);
expect("evidence:context", context.includes("Collected read-only OpenShift evidence"), "evidence context is generated for the brain prompt");
expect("evidence:context-runbook", context.includes("runbook:"), "brain prompt includes runbook evidence context");
expect("evidence:context-runbook-excerpt", context.includes("KOMSCO Synthetic"), "brain prompt includes synthetic customer runbook context");

const allNamespacesEvidence = await collectOpenShiftEvidence(
  {
    question: "모든 namespace에서 위험 신호를 찾아줘",
    resourceRef: { kind: "Namespace", name: "__all_namespaces__" },
    scope: { namespaces: ["__all_namespaces__"] }
  },
  {
    authorization: "Bearer test-token",
    config,
    transport,
    metricConfig,
    runbookConfig,
    metricTransport
  }
);
expect(
  "evidence:all-namespaces:namespaces",
  allNamespacesEvidence.evidence.some((item) => item.id === "openshift:namespaces:all"),
  "all-namespaces evidence collects the namespace list instead of calling a fake namespace"
);
expect(
  "evidence:all-namespaces:pods",
  allNamespacesEvidence.evidence.some((item) => item.id === "openshift:pods:all-namespaces"),
  "all-namespaces evidence collects pods across namespaces"
);
expect(
  "evidence:all-namespaces:events",
  allNamespacesEvidence.evidence.some((item) => item.id === "openshift:events:all-namespaces"),
  "all-namespaces evidence collects events across namespaces"
);
expect(
  "evidence:all-namespaces:no-fake-namespace-missing",
  !allNamespacesEvidence.missing.some((item) => item.reason.includes("/api/v1/namespaces/__all_namespaces__")),
  "all-namespaces evidence does not call __all_namespaces__ as a Kubernetes namespace"
);

const missing = await collectOpenShiftEvidence(
  {
    resourceRef: { kind: "Pod", name: "api-7c8d9" },
    scope: { namespaces: ["default"] }
  },
  {
    config,
    transport
  }
);
expect(
  "evidence:missing-token",
  missing.missing.some((item) => item.type === "openshift_api" && item.reason.includes("missing user bearer token")),
  "missing UserToken is recorded as missing evidence"
);

const enriched = await enrichInputWithOpenShiftEvidence(
  {
    question: "ClusterVersion 상태 요약",
    resourceRef: { kind: "ClusterVersion", name: "version" }
  },
  {
    authorization: "Bearer test-token",
    config,
    transport,
    runbookConfig,
    metricConfig,
    metricTransport
  }
);
expect("evidence:enriched-input", enriched.cas_evidence_context.includes("openshift:clusterversion:version"), "input is enriched with evidence context");

const runbook = await collectRunbookEvidence(
  {
    question: "OOMKilled Pod memory limit RCA",
    resourceRef: { kind: "Pod", name: "api-7c8d9" },
    scope: { namespaces: ["default"] }
  },
  { config: runbookConfig }
);
expect("runbook:hit", runbook.evidence.length >= 1, "runbook adapter returns at least one curated JSONL hit");
expect("runbook:customer-corpus", runbook.evidence.some((item) => item.source.includes("komsco-ops-sim")), "runbook adapter reads the synthetic customer corpus");
expect("runbook:excerpt", runbook.evidence.some((item) => item.summary.includes("memory limit")), "runbook evidence includes excerpt text");
expect(
  "runbook:shape",
  runbook.evidence.every((item) => item.id.startsWith("runbook:") && item.type === "runbook" && item.source),
  "runbook evidence uses the v0.1.1 shape"
);

const metric = await collectMetricEvidence(
  {
    resourceRef: { kind: "Pod", name: "api-7c8d9" },
    scope: { namespaces: ["default"] }
  },
  {
    authorization: "Bearer test-token",
    config: metricConfig,
    transport: metricTransport
  }
);
expect("metric:evidence", metric.evidence.length >= 3, "metric adapter emits Pod restart, working set, and limit evidence");
expect("metric:no-series", metric.evidence.some((item) => item.summary.includes("no-series")), "metric no-series is recorded as evidence");
const metricFailure = await collectMetricEvidence(
  {
    resourceRef: { kind: "Pod", name: "api-7c8d9" },
    scope: { namespaces: ["default"] }
  },
  {
    authorization: "Bearer test-token",
    config: metricConfig,
    transport: async () => {
      throw new Error("network denied");
    }
  }
);
expect("metric:failure-missing", metricFailure.missing.some((item) => item.type === "metric" && item.reason.includes("network denied")), "metric adapter failures are recorded in missing evidence");

const overview = await collectOpenShiftOverview(
  {
    scope: { cluster: "local-cluster", namespaces: ["default"] }
  },
  {
    authorization: "Bearer test-token",
    config,
    transport,
    metricConfig,
    runbookConfig,
    metricTransport
  }
);
expect("overview:mode", overview.mode === "overview_read_only", "overview contract mode is read-only");
expect("overview:health", Number(overview.health?.score) < 100, "overview health score reflects risk signals");
expect("overview:signals", overview.signals?.warning_events === 2 && overview.signals?.pending_pods === 1, "overview signals summarize events and pods");
expect("overview:risk-workloads", overview.risk_workloads?.length >= 2, "overview includes risky workloads");
expect("overview:timeline", overview.evidence_timeline?.some((item) => item.summary.includes("FailedScheduling")), "overview includes evidence timeline");
expect("overview:actions", overview.actions?.some((item) => item.type === "cas_query"), "overview includes a Run RCA action");
expect(
  "overview:events-query-action",
  overview.actions?.some((item) => item.type === "cas_query" && item.label === "Namespace event check"),
  "overview namespace events action becomes CAS guidance instead of a fragile console route"
);
expect(
  "overview:actions-targeted",
  overview.actions?.every((item) => item.type !== "cas_query" || (item.question && item.target?.namespace && item.target?.kind && item.target?.name)),
  "overview CAS query actions carry executable questions and analysis targets"
);

const allOverview = await collectOpenShiftOverview(
  {
    scope: { cluster: "local-cluster", namespaces: ["__all_namespaces__"] }
  },
  {
    authorization: "Bearer test-token",
    config,
    metricConfig,
    runbookConfig,
    transport,
    metricTransport
  }
);
expect(
  "overview:all-namespaces:scope",
  allOverview.scope?.namespaces?.[0] === "__all_namespaces__",
  "all-namespaces overview preserves the broad analysis scope"
);
expect(
  "overview:all-namespaces:risk-workload",
  allOverview.risk_workloads?.some((item) => item.namespace === "komsco-batch"),
  "all-namespaces overview can surface risky workloads from any namespace"
);
expect(
  "overview:all-namespaces:actions",
  allOverview.actions?.some((item) => item.label === "All namespaces check"),
  "all-namespaces overview exposes a broad next-check action"
);
expect(
  "overview:metric-check-action",
  overview.actions?.some((item) => item.type === "cas_query" && String(item.id ?? "").startsWith("check:metrics:")),
  "overview exposes a metric-focused next check for the top risky workload"
);
expect(
  "overview:no-events-404-link",
  !overview.actions?.some((item) => item.type === "console_link" && String(item.href ?? "").startsWith("/events/")),
  "overview does not emit OpenShift Events routes that 404 in CRC 4.20"
);
expect("overview:no-runbook-404-link", !overview.actions?.some((item) => String(item.href ?? "").startsWith("/docs/")), "overview does not emit runbook links to missing in-console docs routes");
expect("overview:runbook-query-action", overview.actions?.some((item) => item.type === "cas_query" && String(item.label ?? "").startsWith("Runbook check:")), "overview runbook actions are CAS guidance queries instead of broken links");
expect("overview:metric-group", overview.evidence_groups?.metric?.length >= 1, "overview includes metric evidence group");
expect("overview:runbook-group", overview.evidence_groups?.runbook?.length >= 1, "overview includes runbook evidence group");
expect("overview:evidence-status", overview.evidence_status?.some((item) => item.type === "runbook" && item.status === "collected"), "overview exposes evidence_status");
expect(
  "overview:refs-resolve",
  overview.rca_candidate?.evidence_refs?.every((ref) => {
    return (
      overview.risk_workloads?.some((item) => item.id === ref) ||
      overview.evidence_timeline?.some((item) => item.id === ref)
    );
  }),
  "overview RCA candidate evidence refs resolve to returned cockpit items"
);

const forbiddenTransport = async () => ({
  statusCode: 403,
  body: JSON.stringify({ message: "forbidden" })
});
const degradedOverview = await collectOpenShiftOverview(
  {
    scope: { cluster: "local-cluster", namespaces: ["default"] }
  },
  {
    authorization: "Bearer test-token",
    config,
    transport: forbiddenTransport
  }
);
expect(
  "overview:critical-missing-degrades",
  degradedOverview.health?.risk === "unknown" && degradedOverview.health?.score === 0,
  "overview degrades instead of reporting healthy when pod/event evidence is unavailable"
);

const targets = await collectOpenShiftTargets(
  {
    scope: { cluster: "local-cluster", namespaces: ["default"] }
  },
  {
    authorization: "Bearer test-token",
    config,
    transport
  }
);
expect("targets:mode", targets.mode === "target_catalog", "target catalog endpoint contract mode is target_catalog");
expect(
  "targets:namespace",
  targets.targets?.some((item) => item.kind === "Namespace" && item.name === "komsco-batch"),
  "target catalog includes Namespace options for namespace-level checks"
);
expect(
  "targets:all-namespaces",
  targets.targets?.some(
    (item) =>
      item.namespace === "__all_namespaces__" &&
      item.kind === "Namespace" &&
      item.name === "__all_namespaces__"
  ),
  "target catalog includes an All namespaces option for broad discovery"
);
expect(
  "targets:pod",
  targets.targets?.some((item) => item.namespace === "komsco-batch" && item.kind === "Pod"),
  "target catalog includes Pod options from OpenShift API"
);
expect(
  "targets:deployment",
  targets.targets?.some((item) => item.kind === "Deployment" && item.name === "settlement-worker"),
  "target catalog includes Deployment options from OpenShift API"
);
expect(
  "targets:clusterversion",
  targets.targets?.some((item) => item.kind === "ClusterVersion" && item.name === "version"),
  "target catalog includes ClusterVersion/version fallback"
);

const failures = checks.filter((check) => check.status === "FAIL");
if (failures.length > 0) {
  console.error(`OpenShift evidence verification failed with ${failures.length} failures.`);
  process.exitCode = 1;
} else {
  console.log(`OpenShift evidence verification passed with ${checks.length} checks.`);
}
