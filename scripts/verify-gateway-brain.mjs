#!/usr/bin/env node
import {
  buildLightspeedPayload,
  createLightspeedBackedRun,
  parseLightspeedStream
} from "../apps/gateway/src/lightspeedBrain.mjs";

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

const sampleStream = [
  'data: {"event":"start","data":{"conversation_id":"conv-live-1"}}',
  "",
  'data: {"event":"token","data":{"token":"ClusterVersion는 "}}',
  "",
  'data: {"event":"token","data":{"token":"정상적으로 응답했습니다."}}',
  "",
  'data: {"event":"end","data":{"referenced_documents":[{"doc_title":"OpenShift documentation","doc_url":"https://docs.openshift.com/"}],"truncated":false}}',
  ""
].join("\n");

const parsed = parseLightspeedStream(sampleStream);
expect("brain:parse-answer", parsed.answer.includes("ClusterVersion"), "Lightspeed SSE tokens are combined");
expect("brain:parse-conversation", parsed.conversationId === "conv-live-1", "conversation id is captured");
expect("brain:parse-references", parsed.references.length === 1, "referenced documents are captured");

const payload = buildLightspeedPayload({
  question: "ClusterVersion 상태를 한 문장으로 요약해줘.",
  scope: { namespaces: ["default"] },
  resourceRef: { kind: "ClusterVersion", name: "version" },
  locale: "ko-KR",
  cas_evidence_context: "Collected read-only OpenShift evidence:\n- openshift:clusterversion:version [clusterversion]: ClusterVersion desired=4.20.5"
});
expect("brain:payload-mode", payload.mode === "ask", "Lightspeed payload uses ask mode by default");
expect("brain:payload-context", payload.query.includes("read-only OpenShift operations assistant"), "payload carries CAS read-only context");
expect("brain:payload-evidence", payload.query.includes("openshift:clusterversion:version"), "payload carries CAS OpenShift evidence context");
expect("brain:payload-cas-context", payload.query.includes("CAS evidence context"), "payload separates CAS evidence context from the user question");
expect("brain:payload-direct-answer", payload.query.includes("Answer directly first"), "payload asks Lightspeed to answer directly first");
expect("brain:payload-ask-context", payload.query.includes("Lightspeed mode: ask"), "payload records Ask mode in the prompt context");

const troubleshootingPayload = buildLightspeedPayload({
  question: "default namespace pod가 왜 재시작됐어?",
  mode: "read_only",
  brain_mode: "troubleshooting",
  scope: { namespaces: ["default"] },
  resourceRef: { kind: "Pod", name: "api-7c8d9" },
  locale: "ko-KR"
});
expect(
  "brain:payload-troubleshooting-mode",
  troubleshootingPayload.mode === "troubleshooting",
  "brain_mode=troubleshooting maps to Lightspeed troubleshooting mode"
);
expect(
  "brain:payload-troubleshooting-keeps-readonly",
  troubleshootingPayload.query.includes("read-only OpenShift operations assistant"),
  "troubleshooting payload keeps CAS read-only safety context"
);

const run = await createLightspeedBackedRun(
  {
    question: "ClusterVersion 상태를 한 문장으로 요약해줘.",
    resourceRef: { kind: "ClusterVersion", name: "version" },
    scope: { namespaces: ["default"] },
    cas_evidence: {
      provider: "openshift-api",
      evidence: [
        {
          id: "openshift:clusterversion:version",
          type: "clusterversion",
          summary: "ClusterVersion desired=4.20.5 conditions=[Available=True, Progressing=False, Degraded=False]",
          source: "apis/config.openshift.io/v1/clusterversions/version"
        },
        {
          id: "metric:namespace_restart_increase_by_pod:default:Namespace:default",
          type: "metric",
          summary: "namespace_restart_increase_by_pod for default:Namespace:default returned no-series",
          source: "thanos.api.v1.query"
        },
        {
          id: "runbook:komsco_ocp_cluster:clusterversion-operator-conditions",
          type: "runbook",
          summary: "KOMSCO OpenShift Cluster Runbook > Cluster > Version > Operator conditions",
          source: "/docs/cas/runbooks/komsco-ocp-mini#clusterversion-operator-conditions"
        }
      ],
      missing: []
    },
    cas_evidence_context:
      "Collected read-only OpenShift evidence:\n- openshift:clusterversion:version [clusterversion]: ClusterVersion desired=4.20.5\n- metric:namespace_restart_increase_by_pod:default:Namespace:default [metric]: no-series\n- runbook:komsco_ocp_cluster:clusterversion-operator-conditions [runbook]: ClusterVersion conditions"
  },
  {
    authorization: "Bearer test-token",
    transport: async () => ({
      statusCode: 200,
      body: sampleStream,
      headers: {}
    }),
    config: {
      provider: "openshift-lightspeed",
      lightspeedUrl: "https://lightspeed.example",
      timeoutMs: 1000,
      tlsInsecure: true
    }
  }
);

expect("brain:run-mode", run.mode === "lightspeed_read_only", "successful brain run is lightspeed_read_only");
expect("brain:run-provider", run.audit?.answer_provider === "openshift-lightspeed", "audit marks openshift-lightspeed provider");
expect("brain:run-payload-mode", run.audit?.brain?.mode === "ask", "audit preserves the Lightspeed payload mode");
expect("brain:run-evidence", run.evidence_bundle?.evidence?.some((item) => item.id === "lightspeed:answer"), "Lightspeed answer evidence exists");
expect(
  "brain:run-cause-from-answer",
  run.rca_result?.cause_candidates?.[0]?.cause?.includes("ClusterVersion"),
  "CAS RCA cause is derived from the Lightspeed answer"
);
expect(
  "brain:run-openshift-evidence",
  run.evidence_bundle?.evidence?.some((item) => item.id === "openshift:clusterversion:version"),
  "OpenShift evidence is preserved in the CAS result"
);
expect(
  "brain:run-metric-runbook-evidence",
  run.evidence_bundle?.evidence?.some((item) => item.type === "metric") &&
    run.evidence_bundle?.evidence?.some((item) => item.type === "runbook"),
  "metric and runbook evidence are preserved in the CAS result"
);
expect(
  "brain:run-evidence-status",
  run.evidence_bundle?.evidence_status?.some((item) => item.type === "metric" && item.status === "collected"),
  "evidence_status is attached to the Lightspeed-backed run"
);

const fallback = await createLightspeedBackedRun(
  {
    question: "default namespace의 api pod가 왜 재시작됐어?",
    scope: { namespaces: ["default"] },
    resourceRef: { kind: "Pod", name: "api-7c8d9" }
  },
  {
    config: {
      provider: "openshift-lightspeed",
      lightspeedUrl: "https://lightspeed.example",
      timeoutMs: 1000,
      tlsInsecure: true
    }
  }
);

expect("brain:fallback-mode", fallback.mode === "lightspeed_fallback_mock", "missing token degrades to explicit fallback");
expect("brain:fallback-audit", fallback.audit?.brain?.status === "fallback", "fallback is visible in audit");
expect("brain:fallback-missing", fallback.evidence_bundle?.missing?.some((item) => item.type === "lightspeed_brain"), "fallback records missing brain evidence");

const failures = checks.filter((check) => check.status === "FAIL");
if (failures.length > 0) {
  console.error(`Gateway brain verification failed with ${failures.length} failures.`);
  process.exitCode = 1;
} else {
  console.log(`Gateway brain verification passed with ${checks.length} checks.`);
}
