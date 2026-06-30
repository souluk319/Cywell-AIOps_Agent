#!/usr/bin/env node
import { assertReadOnlyToolPlan } from "../packages/contracts/src/index.js";
import {
  buildKnowledgeCapabilities,
  buildKnowledgeHealth,
  buildKnowledgeUnavailable,
  getKnowledgeConfig
} from "../apps/gateway/src/knowledgeFacade.mjs";
import { createMockOomKilledRun } from "../apps/gateway/src/mockRca.mjs";
import {
  resolveKnowledgeOwner,
  stableOwnerFromAuthorization,
  stableOwnerFromVerifiedUser
} from "../apps/gateway/src/ownerIdentity.mjs";

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

const run = createMockOomKilledRun({
  question: "default namespace의 api pod가 왜 재시작됐어?",
  scope: { cluster: "local-cluster", namespaces: ["default"] },
  resourceRef: { kind: "Pod", name: "api-7c8d9" },
  mode: "read_only",
  stream: false
});

expect("mock:mode", run.mode === "mock_read_only", "mock_read_only mode is set");
expect("mock:run-id", typeof run.run_id === "string" && run.run_id.length > 0, "run_id generated");
expect("mock:tool-plan", run.tool_plan?.task_type === "pod_restart_rca", "pod_restart_rca tool plan generated");

const guard = assertReadOnlyToolPlan(run.tool_plan);
expect("mock:read-only", guard.ok, "tool plan is read-only", guard.violations.join("; "));
expect(
  "mock:evidence",
  run.evidence_bundle?.evidence?.some((item) => item.id === "event:oomkilled"),
  "OOMKilled event evidence exists"
);
expect(
  "mock:rca",
  run.rca_result?.cause_candidates?.[0]?.cause === "memory limit exceeded",
  "memory limit exceeded is the top cause"
);
expect(
  "mock:audit",
  run.audit?.response_schema_valid === true && run.audit?.redaction_applied === true,
  "audit marks schema validation and redaction"
);

const knowledgeConfig = getKnowledgeConfig({ CAS_KNOWLEDGE_ENGINE_URL: "https://cas-knowledge-engine.example" });
const knowledgeHealth = buildKnowledgeHealth({ config: knowledgeConfig, product: "Cywell AI Sentinel" });
const knowledgeCapabilities = buildKnowledgeCapabilities();
const knowledgeUnavailable = buildKnowledgeUnavailable("/api/knowledge/uploads/ingest", { config: getKnowledgeConfig({}) });

expect("knowledge:config", knowledgeConfig.engineUrl === "https://cas-knowledge-engine.example", "knowledge engine URL is parsed");
expect("knowledge:health", knowledgeHealth.status === "ok", "knowledge health is ok when engine URL is configured");
expect(
  "knowledge:capabilities",
  knowledgeCapabilities.some((capability) => capability.id === "rag-query") &&
    knowledgeCapabilities.some((capability) => capability.id === "llm-wiki-loop"),
  "knowledge facade exposes RAG and LLM Wiki capabilities"
);
expect(
  "knowledge:unavailable",
  knowledgeUnavailable.code === "knowledge-engine-not-configured" && knowledgeUnavailable.status === "pending",
  "knowledge facade has explicit pending response before PBS engine is connected"
);

const tokenHashOwner = await resolveKnowledgeOwner("Bearer local-token", {
  config: {
    mode: "token-hash",
    apiUrl: "https://openshift.example",
    timeoutMs: 1000,
    tlsInsecure: true,
    cacheTtlMs: 0
  }
});
expect(
  "owner-identity:token-hash-local",
  tokenHashOwner.ok && tokenHashOwner.owner === stableOwnerFromAuthorization("Bearer local-token"),
  "local owner identity can still use explicit token-hash mode"
);

const identityRequests = [];
const identityTransport = async (url, options = {}) => {
  identityRequests.push({ url, options });
  const auth = options.headers?.authorization ?? "";
  if (auth === "Bearer refreshed-token-a" || auth === "Bearer refreshed-token-b") {
    return {
      statusCode: 201,
      body: JSON.stringify({
        status: {
          userInfo: {
            username: "kube:admin",
            uid: "uid-kube-admin",
            groups: ["system:authenticated"]
          }
        }
      })
    };
  }
  return { statusCode: 401, body: JSON.stringify({ message: "Unauthorized" }) };
};
const openshiftIdentityConfig = {
  mode: "openshift-selfsubjectreview",
  apiUrl: "https://openshift.example",
  timeoutMs: 1000,
  tlsInsecure: true,
  cacheTtlMs: 0
};
const refreshedTokenAOwner = await resolveKnowledgeOwner("Bearer refreshed-token-a", {
  config: openshiftIdentityConfig,
  transport: identityTransport
});
const refreshedTokenBOwner = await resolveKnowledgeOwner("Bearer refreshed-token-b", {
  config: openshiftIdentityConfig,
  transport: identityTransport
});
const invalidTokenOwner = await resolveKnowledgeOwner("Bearer invalid-token", {
  config: openshiftIdentityConfig,
  transport: identityTransport
});
expect(
  "owner-identity:selfsubjectreview-stable",
  refreshedTokenAOwner.ok &&
    refreshedTokenBOwner.ok &&
    refreshedTokenAOwner.owner === stableOwnerFromVerifiedUser({ username: "kube:admin", uid: "uid-kube-admin" }) &&
    refreshedTokenAOwner.owner === refreshedTokenBOwner.owner &&
    !refreshedTokenAOwner.owner.includes("refreshed-token"),
  "SelfSubjectReview identity maps refreshed tokens for the same user to one stable owner"
);
expect(
  "owner-identity:selfsubjectreview-contract",
  identityRequests.every(
    (request) =>
      request.url.endsWith("/apis/authentication.k8s.io/v1/selfsubjectreviews") &&
      request.options.method === "POST" &&
      request.options.headers?.["content-type"] === "application/json" &&
      JSON.parse(request.options.body).kind === "SelfSubjectReview"
  ),
  "owner identity verifier posts SelfSubjectReview with the incoming bearer token"
);
expect(
  "owner-identity:invalid-token-rejected",
  invalidTokenOwner.ok === false && !invalidTokenOwner.owner,
  "OpenShift user identity rejects invalid bearer tokens instead of deriving an owner from them"
);

const failures = checks.filter((check) => check.status === "FAIL");
if (failures.length > 0) {
  console.error(`Gateway mock verification failed with ${failures.length} failures.`);
  process.exitCode = 1;
} else {
  console.log(`Gateway mock verification passed with ${checks.length} checks.`);
}

