#!/usr/bin/env node
import {
  PRODUCT,
  assertReadOnlyToolPlan,
  createAnalyzeRequest,
  createEvidenceBundle,
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

requireField("product:name", PRODUCT, "officialName");
requireField("product:namespace", PRODUCT, "namespace");
requireField("request:question", request, "question");
requireField("request:scope", request, "scope.namespaces");
requireField("request:mode", request, "mode");
requireField("toolplan:type", toolPlan, "task_type");
requireField("evidence:run", evidence, "run_id");
requireField("rca:cause", rca, "cause_candidates");

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

const failures = checks.filter((check) => check.status === "FAIL");
if (failures.length > 0) {
  console.error(`Contract verification failed with ${failures.length} failures.`);
  process.exitCode = 1;
} else {
  console.log(`Contract verification passed with ${checks.length} checks.`);
}

