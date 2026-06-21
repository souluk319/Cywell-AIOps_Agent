#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const files = [
  "deploy/kustomize/base/00-namespace.yaml",
  "deploy/kustomize/base/10-rbac.yaml",
  "deploy/kustomize/base/20-networkpolicy.yaml",
  "deploy/kustomize/base/kustomization.yaml"
];

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

for (const file of files) {
  try {
    const text = await readFile(file, "utf8");
    pass(`file:${file}`, "readable");
    if (file.includes("rbac")) {
      for (const forbidden of ["delete", "patch", "update", "pods/exec", "pods/portforward"]) {
        if (text.includes(forbidden)) fail(`rbac:forbidden:${forbidden}`, `${forbidden} must not appear in MVP RBAC`);
      }
      for (const required of ["get", "list", "watch", "selfsubjectaccessreviews"]) {
        if (text.includes(required)) pass(`rbac:required:${required}`, `${required} present`);
        else fail(`rbac:required:${required}`, `${required} missing`);
      }
    }
    if (file.includes("networkpolicy")) {
      if (text.includes("policyTypes") && text.includes("Egress")) pass("networkpolicy:egress", "egress policy present");
      else fail("networkpolicy:egress", "egress policy missing");
    }
  } catch (error) {
    fail(`file:${file}`, error.message);
  }
}

const failures = checks.filter((check) => check.status === "FAIL");
if (failures.length > 0) {
  console.error(`Deploy manifest verification failed with ${failures.length} failures.`);
  process.exitCode = 1;
} else {
  console.log(`Deploy manifest verification passed with ${checks.length} checks.`);
}

