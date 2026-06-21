#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const project = "cywell-ai-sentinel";
const contextDir = resolve("test-results/cas-build-context");

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
    return !normalized.includes("/dist") && !normalized.includes("/node_modules");
  };

  await cp(resolve("apps/gateway"), resolve(contextDir, "apps/gateway"), { recursive: true, filter });
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

console.log("Preparing minimal CAS build context");
await copyBuildContext();

console.log("Applying CRC BuildConfigs");
run("oc", ["apply", "-f", "deploy/kustomize/overlays/crc/buildconfigs.yaml"], { stdio: "inherit" });

for (const buildName of ["cas-gateway", "cas-console-plugin"]) {
  console.log(`Starting OpenShift binary build: ${buildName}`);
  run(
    "oc",
    ["start-build", buildName, "-n", project, `--from-dir=${contextDir}`, "--follow", "--wait"],
    { stdio: "inherit", timeoutMs: 1200000 }
  );
}

console.log("Applying CAS manifests");
run("oc", ["apply", "-k", "deploy/kustomize/base"], { stdio: "inherit" });

console.log("Restarting CAS deployments to pull the latest dev tags");
run("oc", ["rollout", "restart", "deploy/cas-gateway", "-n", project], { stdio: "inherit" });
run("oc", ["rollout", "restart", "deploy/cas-console-plugin", "-n", project], { stdio: "inherit" });

console.log("Waiting for CAS deployments");
run("oc", ["rollout", "status", "deploy/cas-gateway", "-n", project, "--timeout=180s"], { stdio: "inherit" });
run("oc", ["rollout", "status", "deploy/cas-console-plugin", "-n", project, "--timeout=180s"], { stdio: "inherit" });

ensureCasReplacesLightspeed();

console.log("Verifying CRC deployment");
run("node", ["./scripts/verify-crc-deployment.mjs"], { stdio: "inherit", timeoutMs: 120000 });
