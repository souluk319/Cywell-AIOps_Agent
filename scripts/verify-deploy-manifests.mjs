#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const files = [
  "deploy/kustomize/base/00-namespace.yaml",
  "deploy/kustomize/base/10-rbac.yaml",
  "deploy/kustomize/base/20-networkpolicy.yaml",
  "deploy/kustomize/base/30-gateway.yaml",
  "deploy/kustomize/base/40-console-plugin-workload.yaml",
  "deploy/kustomize/base/50-consoleplugin.yaml",
  "deploy/kustomize/base/kustomization.yaml",
  "deploy/kustomize/overlays/crc/buildconfigs.yaml",
  "deploy/kustomize/overlays/crc/kustomization.yaml",
  "apps/console-plugin/console-extensions.json"
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
    if (file.includes("50-consoleplugin")) {
      if (text.includes("name: cywell-ai-sentinel")) pass("consoleplugin:name", "cywell-ai-sentinel name present");
      else fail("consoleplugin:name", "ConsolePlugin name must be cywell-ai-sentinel");
      if (text.includes("alias: cas-api")) pass("consoleplugin:proxy", "cas-api proxy alias present");
      else fail("consoleplugin:proxy", "ConsolePlugin proxy alias must be cas-api");
      if (text.includes("cywell-opslens") || text.includes("opslens-api")) {
        fail("consoleplugin:opslens-isolation", "CAS ConsolePlugin must not reference OpsLens names");
      } else {
        pass("consoleplugin:opslens-isolation", "no OpsLens names referenced");
      }
    }
    if (file.includes("console-extensions")) {
      if (text.includes("/ai-sentinel")) pass("console-extension:path", "/ai-sentinel route present");
      else fail("console-extension:path", "/ai-sentinel route missing");
      if (text.includes("/opslens") || text.includes("cywell-opslens")) {
        fail("console-extension:opslens-isolation", "CAS extension must not reference OpsLens route or plugin id");
      } else {
        pass("console-extension:opslens-isolation", "no OpsLens route or plugin id referenced");
      }
    }
    if (file.includes("buildconfigs")) {
      for (const expected of ["kind: BuildConfig", "name: cas-gateway", "name: cas-console-plugin", "dockerfilePath: apps/gateway/Dockerfile", "dockerfilePath: apps/console-plugin/Dockerfile"]) {
        if (text.includes(expected)) pass(`buildconfig:${expected}`, `${expected} present`);
        else fail(`buildconfig:${expected}`, `${expected} missing`);
      }
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
