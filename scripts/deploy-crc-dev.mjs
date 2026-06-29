#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const project = "cywell-ai-sentinel";
const contextDir = resolve("test-results/cas-build-context");
const sourceCheckedAt = new Date().toISOString();

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
    timeout: options.timeoutMs ?? 900000,
    windowsHide: true
  });

  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? result.error?.message ?? ""
  };
}

function git(args) {
  return run("git", args, { timeoutMs: 30000 });
}

function trackedTreeStatus() {
  const result = tryRun("git", ["status", "--porcelain", "--untracked-files=no"], { timeoutMs: 30000 });
  if (!result.ok) return "unknown";
  return result.stdout ? "dirty" : "clean";
}

const sourceGit = {
  branch: git(["branch", "--show-current"]),
  head: git(["rev-parse", "HEAD"]),
  shortHead: git(["rev-parse", "--short", "HEAD"]),
  treeStatus: trackedTreeStatus()
};

if (sourceGit.treeStatus !== "clean" && String(process.env.CAS_ALLOW_DIRTY_CRC_DEPLOY ?? "").toLowerCase() !== "true") {
  throw new Error("Refusing CRC deploy from a dirty tracked git tree; commit/stash tracked changes or set CAS_ALLOW_DIRTY_CRC_DEPLOY=true intentionally");
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForBuildComplete(build) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const phase = run("oc", ["get", "build", build, "-n", project, "-o", "jsonpath={.status.phase}"]);
    if (phase === "Complete") return;
    if (["Cancelled", "Error", "Failed"].includes(phase)) {
      run("oc", ["describe", "build", build, "-n", project], { stdio: "inherit" });
      throw new Error(`OpenShift build ${build} finished with phase ${phase}`);
    }
    sleep(2000);
  }
  run("oc", ["describe", "build", build, "-n", project], { stdio: "inherit" });
  throw new Error(`Timed out waiting for OpenShift build ${build} to complete`);
}

function startBinaryBuild(buildName) {
  console.log(`Starting OpenShift binary build: ${buildName}`);
  const output = run(
    "oc",
    ["start-build", buildName, "-n", project, `--from-dir=${contextDir}`, "--wait=false", "-o", "name"],
    { timeoutMs: 1200000 }
  );
  const buildRef = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("build.build.openshift.io/") || line.startsWith("build/"));
  const build = buildRef?.split("/").pop();
  if (!build) {
    throw new Error(`Could not determine OpenShift build name for ${buildName}: ${output}`);
  }
  console.log(`Following OpenShift build: ${build}`);
  run("oc", ["logs", "-n", project, `build/${build}`, "-f"], { stdio: "inherit", timeoutMs: 1800000 });
  waitForBuildComplete(build);
}

function annotateDeploymentSource(name) {
  const annotations = {
    "cywell.io/source-branch": sourceGit.branch,
    "cywell.io/source-head": sourceGit.head,
    "cywell.io/source-short-head": sourceGit.shortHead,
    "cywell.io/source-tree-status": sourceGit.treeStatus,
    "cywell.io/source-checked-at": sourceCheckedAt
  };
  run(
    "oc",
    [
      "patch",
      `deploy/${name}`,
      "-n",
      project,
      "--type=merge",
      "-p",
      JSON.stringify({
        metadata: { annotations },
        spec: { template: { metadata: { annotations } } }
      })
    ],
    { stdio: "inherit" }
  );
}

async function copyBuildContext() {
  await rm(contextDir, { recursive: true, force: true });
  await mkdir(contextDir, { recursive: true });
  await mkdir(resolve(contextDir, "apps"), { recursive: true });
  await mkdir(resolve(contextDir, "packages"), { recursive: true });

  const files = ["package.json", "package-lock.json", "tsconfig.base.json", ".dockerignore"];
  for (const file of files) {
    await cp(resolve(file), resolve(contextDir, file));
  }

  const filter = (source) => {
    const normalized = source.replace(/\\/g, "/");
    return !normalized.includes("/dist") && !normalized.includes("/node_modules") && !normalized.includes("/__pycache__") && !normalized.endsWith(".pyc");
  };

  await cp(resolve("apps/gateway"), resolve(contextDir, "apps/gateway"), { recursive: true, filter });
  await cp(resolve("apps/knowledge-engine"), resolve(contextDir, "apps/knowledge-engine"), { recursive: true, filter });
  await cp(resolve("apps/console-plugin"), resolve(contextDir, "apps/console-plugin"), { recursive: true, filter });
  await cp(resolve("packages/contracts"), resolve(contextDir, "packages/contracts"), { recursive: true, filter });
}

function ensureCasReplacesLightspeed() {
  const raw = run("oc", ["get", "console.operator.openshift.io", "cluster", "-o", "json"]);
  const parsed = JSON.parse(raw);
  const plugins = (Array.isArray(parsed?.spec?.plugins) ? parsed.spec.plugins : []).filter(
    (plugin) => plugin !== "lightspeed-console-plugin"
  );
  if (!plugins.includes("cywell-ai-sentinel")) {
    plugins.push("cywell-ai-sentinel");
  }
  const existingCapabilities = Array.isArray(parsed?.spec?.customization?.capabilities)
    ? parsed.spec.customization.capabilities
    : [];
  const capabilitiesByName = new Map(existingCapabilities.map((capability) => [capability.name, capability]));
  capabilitiesByName.set("LightspeedButton", {
    name: "LightspeedButton",
    visibility: {
      state: "Disabled"
    }
  });
  if (!capabilitiesByName.has("GettingStartedBanner")) {
    capabilitiesByName.set("GettingStartedBanner", {
      name: "GettingStartedBanner",
      visibility: {
        state: "Enabled"
      }
    });
  }
  const payload = JSON.stringify({
    spec: {
      plugins,
      customization: {
        capabilities: [...capabilitiesByName.values()]
      }
    }
  });
  run("oc", ["patch", "console.operator.openshift.io", "cluster", "--type=merge", "-p", payload], { stdio: "inherit" });
  console.log(`Console plugins: ${plugins.join(",")}`);
}

function ensureDevPostgresSecret() {
  const existing = tryRun("oc", ["get", "secret", "cas-knowledge-postgres", "-n", project, "-o", "name"], { timeoutMs: 30000 });
  if (existing.ok && existing.stdout) {
    console.log("CAS dev Postgres Secret already exists; preserving current local CRC credentials");
    return;
  }
  const database = "cas_knowledge";
  const username = "cas_knowledge";
  const password = randomBytes(24).toString("hex");
  const databaseUrl = `postgresql://${username}:${password}@cas-knowledge-postgres.cywell-ai-sentinel.svc.cluster.local:5432/${database}`;
  console.log("Creating local CRC-only CAS dev Postgres Secret");
  run(
    "oc",
    [
      "create",
      "secret",
      "generic",
      "cas-knowledge-postgres",
      "-n",
      project,
      `--from-literal=database=${database}`,
      `--from-literal=username=${username}`,
      `--from-literal=password=${password}`,
      `--from-literal=database-url=${databaseUrl}`
    ],
    { stdio: "inherit" }
  );
}

function ensureInternalAuthSecret() {
  const existing = tryRun("oc", ["get", "secret", "cas-knowledge-internal-auth", "-n", project, "-o", "name"], { timeoutMs: 30000 });
  if (existing.ok && existing.stdout) {
    console.log("CAS internal owner-auth Secret already exists; preserving current local CRC signing key");
    return;
  }
  console.log("Creating local CRC-only CAS internal owner-auth Secret");
  run(
    "oc",
    [
      "create",
      "secret",
      "generic",
      "cas-knowledge-internal-auth",
      "-n",
      project,
      `--from-literal=owner-hmac-secret=${randomBytes(32).toString("hex")}`
    ],
    { stdio: "inherit" }
  );
}

console.log("Preparing minimal CAS build context");
await copyBuildContext();

console.log("Ensuring CAS namespace exists before CRC binary builds");
run("oc", ["apply", "-f", "deploy/kustomize/base/00-namespace.yaml"], { stdio: "inherit" });
ensureDevPostgresSecret();
ensureInternalAuthSecret();

console.log("Applying CRC BuildConfigs");
run("oc", ["apply", "-f", "deploy/kustomize/overlays/crc/buildconfigs.yaml"], { stdio: "inherit" });

for (const buildName of ["cas-gateway", "cas-console-plugin", "cas-knowledge-engine"]) {
  startBinaryBuild(buildName);
}

console.log("Applying CAS manifests");
const operator = tryRun("oc", ["get", "deploy/cywell-ai-sentinel-operator", "-n", project, "-o", "name"], { timeoutMs: 30000 });
if (operator.ok && operator.stdout) {
  console.log("Pausing the v0.1.3 OLM operator so the v0.1.4 dev manifests own runtime workloads");
  run("oc", ["scale", "deploy/cywell-ai-sentinel-operator", "-n", project, "--replicas=0"], { stdio: "inherit" });
} else {
  console.log("No v0.1.3 OLM operator found; continuing clean v0.1.4 dev deploy");
}

run("oc", ["apply", "-k", "deploy/kustomize/overlays/crc"], { stdio: "inherit" });

console.log("Pinning CAS deployments to freshly built dev images");
run(
  "oc",
  [
    "set",
    "image",
    "deploy/cas-gateway",
    "gateway=image-registry.openshift-image-registry.svc:5000/cywell-ai-sentinel/cas-gateway:dev",
    "-n",
    project
  ],
  { stdio: "inherit" }
);
run(
  "oc",
  [
    "set",
    "image",
    "deploy/cas-console-plugin",
    "console-plugin=image-registry.openshift-image-registry.svc:5000/cywell-ai-sentinel/cas-console-plugin:dev",
    "-n",
    project
  ],
  { stdio: "inherit" }
);
run(
  "oc",
  [
    "set",
    "image",
    "deploy/cas-knowledge-engine",
    "knowledge-engine=image-registry.openshift-image-registry.svc:5000/cywell-ai-sentinel/cas-knowledge-engine:dev",
    "-n",
    project
  ],
  { stdio: "inherit" }
);

console.log("Restarting CAS deployments to pull the latest dev tags");
for (const deployment of ["cas-gateway", "cas-console-plugin", "cas-knowledge-engine"]) {
  annotateDeploymentSource(deployment);
}
run("oc", ["rollout", "restart", "deploy/cas-gateway", "-n", project], { stdio: "inherit" });
run("oc", ["rollout", "restart", "deploy/cas-console-plugin", "-n", project], { stdio: "inherit" });
run("oc", ["rollout", "restart", "deploy/cas-knowledge-engine", "-n", project], { stdio: "inherit" });

console.log("Waiting for CAS deployments");
run("oc", ["rollout", "status", "statefulset/cas-knowledge-postgres", "-n", project, "--timeout=240s"], { stdio: "inherit" });
run("oc", ["rollout", "status", "deploy/cas-gateway", "-n", project, "--timeout=180s"], { stdio: "inherit" });
run("oc", ["rollout", "status", "deploy/cas-console-plugin", "-n", project, "--timeout=180s"], { stdio: "inherit" });
run("oc", ["rollout", "status", "deploy/cas-knowledge-engine", "-n", project, "--timeout=180s"], { stdio: "inherit" });

ensureCasReplacesLightspeed();

console.log("Verifying CRC deployment");
run("node", ["./scripts/verify-crc-deployment.mjs"], { stdio: "inherit", timeoutMs: 120000 });
