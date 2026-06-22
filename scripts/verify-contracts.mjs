#!/usr/bin/env node
import {
  PRODUCT,
  assertReadOnlyToolPlan,
  createAnalyzeRequest,
  createEvidenceBundle,
  createEvidenceStatus,
  createOverviewResult,
  createRcaResult,
  createToolPlan
} from "../packages/contracts/src/index.js";

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

function requireField(id, object, path) {
  const value = path.split(".").reduce((current, key) => current?.[key], object);
  if (value === undefined || value === null || value === "") {
    fail(id, `${path} is missing`);
    return;
  }
  pass(id, `${path}=${JSON.stringify(value)}`);
}

const request = createAnalyzeRequest();
const toolPlan = createToolPlan();
const evidence = createEvidenceBundle();
const rca = createRcaResult();
const overview = createOverviewResult();

requireField("product:name", PRODUCT, "officialName");
requireField("product:namespace", PRODUCT, "namespace");
requireField("request:question", request, "question");
requireField("request:scope", request, "scope.namespaces");
requireField("request:mode", request, "mode");
requireField("toolplan:type", toolPlan, "task_type");
requireField("evidence:run", evidence, "run_id");
requireField("evidence:status", evidence, "evidence_status");
requireField("rca:cause", rca, "cause_candidates");
requireField("overview:mode", overview, "mode");
requireField("overview:health", overview, "health.score");
requireField("overview:signals", overview, "signals.warning_events");
requireField("overview:actions", overview, "actions");
requireField("overview:evidence-status", overview, "evidence_status");

const guard = assertReadOnlyToolPlan(toolPlan);
if (guard.ok) {
  pass("guard:readonly", "default tool plan is read-only");
} else {
  fail("guard:readonly", guard.violations.join("; "));
}

const unsafeGuard = assertReadOnlyToolPlan(
  createToolPlan({
    tool_plan: [{ step: 1, tool: "delete_pod", verb: "delete" }]
  })
);
if (!unsafeGuard.ok) {
  pass("guard:unsafe-blocked", unsafeGuard.violations.join("; "));
} else {
  fail("guard:unsafe-blocked", "unsafe delete tool plan was not blocked");
}

const status = createEvidenceStatus({
  evidence: [
    { type: "pod", id: "openshift:pod:default:api", summary: "pod status", source: "api" },
    { type: "metric", id: "metric:pod_restart:default:Pod:api", summary: "no-series", source: "thanos.api.v1.query" },
    { type: "runbook", id: "runbook:komsco_ocp_rca:pod-oomkilled", summary: "runbook", source: "playbookstudio" }
  ],
  missing: []
});
for (const type of ["openshift", "metric", "runbook"]) {
  const item = status.find((entry) => entry.type === type);
  if (item?.status === "collected" && item.count >= 1) {
    pass(`evidence-status:${type}`, `${type} collected count=${item.count}`);
  } else {
    fail(`evidence-status:${type}`, `${type} status missing or not collected`);
  }
}

const failures = checks.filter((check) => check.status === "FAIL");
if (failures.length > 0) {
  console.error(`Contract verification failed with ${failures.length} failures.`);
  process.exitCode = 1;
} else {
  console.log(`Contract verification passed with ${checks.length} checks.`);
}
