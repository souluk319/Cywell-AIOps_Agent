#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const project = "cywell-ai-sentinel";
const contextDir = resolve("test-results/cas-olm-build-context");
const forceBuild = process.argv.includes("--force");
const buildPlan = [
  { buildName: "cas-gateway-v013", imageTag: "cas-gateway:v0.1.3-crc" },
  { buildName: "cas-console-plugin-v013", imageTag: "cas-console-plugin:v0.1.3-crc" },
  { buildName: "cas-operator-v013", imageTag: "cas-operator:v0.1.3-crc" },
  { buildName: "cas-operator-bundle-v013", imageTag: "cas-operator-bundle:v0.1.3-crc" },
  { buildName: "cas-operator-catalog-v013", imageTag: "cas-operator-catalog:v0.1.3-crc" }
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    timeout: options.timeoutMs ?? 900000,
    windowsHide: true
  });
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    throw new Error(`${command} ${args.join(" ")} failed\n${detail}`);
  }
  return result.stdout?.trim() ?? "";
}

function tryRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    timeout: options.timeoutMs ?? 120000,
    windowsHide: true
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? result.error?.message ?? ""
  };
}

async function copyBuildContext() {
  await rm(contextDir, { recursive: true, force: true });
  await mkdir(contextDir, { recursive: true });
  await mkdir(resolve(contextDir, "apps"), { recursive: true });
  await mkdir(resolve(contextDir, "packages"), { recursive: true });
  await mkdir(resolve(contextDir, "deploy"), { recursive: true });

  for (const file of ["package.json", "package-lock.json", "tsconfig.base.json", ".dockerignore"]) {
    await cp(resolve(file), resolve(contextDir, file));
  }

  const filter = (source) => {
    const normalized = source.replace(/\\/g, "/");
    return !normalized.includes("/dist") && !normalized.includes("/node_modules");
  };

  await cp(resolve("apps/gateway"), resolve(contextDir, "apps/gateway"), { recursive: true, filter });
  await cp(resolve("apps/console-plugin"), resolve(contextDir, "apps/console-plugin"), { recursive: true, filter });
  await cp(resolve("apps/operator"), resolve(contextDir, "apps/operator"), { recursive: true, filter });
  await cp(resolve("packages/contracts"), resolve(contextDir, "packages/contracts"), { recursive: true, filter });
  await cp(resolve("deploy/olm"), resolve(contextDir, "deploy/olm"), { recursive: true, filter });
}

function waitForJsonpath(id, args, expected, timeoutMs = 180000) {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeoutMs) {
    const result = tryRun("oc", args);
    last = result.ok ? result.stdout : result.stderr;
    if (result.ok && (!expected || result.stdout.includes(expected))) {
      console.log(`[PASS] ${id}: ${result.stdout || expected}`);
      return result.stdout;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
  }
  throw new Error(`${id} timed out. Last output: ${last}`);
}

function deleteIfExists(kind, name, namespace) {
  const args = namespace
    ? ["delete", kind, name, "-n", namespace, "--ignore-not-found=true"]
    : ["delete", kind, name, "--ignore-not-found=true"];
  run("oc", args, { stdio: "inherit", timeoutMs: 120000 });
}

console.log("Checking OLM toolchain");
run("opm", ["version"], { stdio: "inherit" });
run("docker", ["--version"], { stdio: "inherit" });
run("oc", ["version"], { stdio: "inherit" });

console.log("Verifying local OLM package");
run("node", ["./scripts/verify-operator-package.mjs"], { stdio: "inherit" });

console.log("Preparing OLM build context");
await copyBuildContext();

console.log("Ensuring CAS namespace and CRC BuildConfigs");
run("oc", ["apply", "-f", "deploy/olm/openshift/00-namespace.yaml"], { stdio: "inherit" });
run("oc", ["apply", "-f", "deploy/olm/crc/buildconfigs.yaml"], { stdio: "inherit" });

for (const { buildName, imageTag } of buildPlan) {
  const existingImage = tryRun("oc", ["get", "istag", imageTag, "-n", project, "-o", "name"]);
  if (!forceBuild && existingImage.ok && existingImage.stdout) {
    console.log(`Skipping ${buildName}; ${imageTag} already exists`);
    continue;
  }
  console.log(`Starting OpenShift binary build: ${buildName}`);
  run("oc", ["start-build", buildName, "-n", project, `--from-dir=${contextDir}`, "--follow", "--wait"], {
    stdio: "inherit",
    timeoutMs: 1800000
  });
}

console.log("Tagging v0.1.3 operand images as dev for existing runtime verifier compatibility");
run("oc", ["tag", "-n", project, "cas-gateway:v0.1.3-crc", "cas-gateway:dev"], { stdio: "inherit" });
run("oc", ["tag", "-n", project, "cas-console-plugin:v0.1.3-crc", "cas-console-plugin:dev"], { stdio: "inherit" });

console.log("Granting openshift-marketplace image pull access to CAS internal images");
run("oc", ["policy", "add-role-to-group", "system:image-puller", "system:serviceaccounts:openshift-marketplace", "-n", project], {
  stdio: "inherit"
});

console.log("Resetting previous CAS OLM install objects if present");
deleteIfExists("subscription", "cywell-ai-sentinel", project);
deleteIfExists("csv", "cywell-ai-sentinel-operator.v0.1.3", project);
deleteIfExists("catalogsource", "cywell-ai-sentinel-catalog", "openshift-marketplace");

console.log("Applying CAS CatalogSource");
run("oc", ["apply", "-f", "deploy/olm/openshift/catalogsource.yaml"], { stdio: "inherit" });
waitForJsonpath(
  "catalogsource:ready",
  [
    "get",
    "catalogsource",
    "cywell-ai-sentinel-catalog",
    "-n",
    "openshift-marketplace",
    "-o",
    "jsonpath={.status.connectionState.lastObservedState}"
  ],
  "READY",
  240000
);

waitForJsonpath(
  "packagemanifest:available",
  [
    "get",
    "packagemanifest",
    "cywell-ai-sentinel",
    "-n",
    "openshift-marketplace",
    "-o",
    "jsonpath={.status.catalogSource}"
  ],
  "cywell-ai-sentinel-catalog",
  240000
);

console.log("Applying CAS Subscription");
run("oc", ["apply", "-f", "deploy/olm/openshift/operatorgroup.yaml"], { stdio: "inherit" });
run("oc", ["apply", "-f", "deploy/olm/openshift/subscription.yaml"], { stdio: "inherit" });
waitForJsonpath(
  "csv:succeeded",
  ["get", "csv", "cywell-ai-sentinel-operator.v0.1.3", "-n", project, "-o", "jsonpath={.status.phase}"],
  "Succeeded",
  300000
);

console.log("Applying CAS KOMSCO Edition CR");
run("oc", ["apply", "-f", "deploy/olm/openshift/komsco-edition.yaml"], { stdio: "inherit" });
waitForJsonpath(
  "cywellaisentinel:ready",
  ["get", "cywellaisentinel", "komsco-edition", "-n", project, "-o", "jsonpath={.status.phase}"],
  "Ready",
  240000
);

console.log("Waiting for CAS operand deployments");
run("oc", ["rollout", "status", "deploy/cas-gateway", "-n", project, "--timeout=180s"], { stdio: "inherit" });
run("oc", ["rollout", "status", "deploy/cas-console-plugin", "-n", project, "--timeout=180s"], { stdio: "inherit" });

console.log("Verifying CAS OLM catalog registration");
run("node", ["./scripts/verify-catalog-crc.mjs"], { stdio: "inherit", timeoutMs: 180000 });

console.log("Verifying CAS runtime deployment");
run("node", ["./scripts/verify-crc-deployment.mjs"], { stdio: "inherit", timeoutMs: 180000 });
