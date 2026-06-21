#!/usr/bin/env node
import { assertReadOnlyToolPlan } from "../packages/contracts/src/index.js";
import { createMockOomKilledRun } from "../apps/gateway/src/mockRca.mjs";

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

const failures = checks.filter((check) => check.status === "FAIL");
if (failures.length > 0) {
  console.error(`Gateway mock verification failed with ${failures.length} failures.`);
  process.exitCode = 1;
} else {
  console.log(`Gateway mock verification passed with ${checks.length} checks.`);
}

