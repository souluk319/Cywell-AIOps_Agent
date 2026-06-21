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
  locale: "ko-KR"
});
expect("brain:payload-mode", payload.mode === "ask", "Lightspeed payload uses ask mode by default");
expect("brain:payload-context", payload.query.includes("read-only OpenShift operations assistant"), "payload carries CAS read-only context");

const run = await createLightspeedBackedRun(
  {
    question: "ClusterVersion 상태를 한 문장으로 요약해줘.",
    resourceRef: { kind: "ClusterVersion", name: "version" },
    scope: { namespaces: ["default"] }
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
expect("brain:run-evidence", run.evidence_bundle?.evidence?.some((item) => item.id === "lightspeed:answer"), "Lightspeed answer evidence exists");

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
