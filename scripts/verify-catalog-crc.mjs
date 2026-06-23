#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const namespace = "cywell-ai-sentinel";
const checks = [];

function run(command, args, timeoutMs = 30000) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? result.error?.message ?? ""
  };
}

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

function json(id, args) {
  const result = run("oc", [...args, "-o", "json"], 60000);
  if (!result.ok) {
    fail(id, result.stderr || result.stdout || "oc command failed");
    return undefined;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(id, `JSON parse failed: ${error.message}`);
    return undefined;
  }
}

function deploymentReady(deployment) {
  return (
    Number(deployment?.status?.availableReplicas ?? 0) >= Number(deployment?.spec?.replicas ?? 1) &&
    deployment?.status?.conditions?.some((condition) => condition.type === "Available" && condition.status === "True")
  );
}

const catalogSource = json("catalogsource:json", [
  "get",
  "catalogsource",
  "cywell-ai-sentinel-catalog",
  "-n",
  "openshift-marketplace"
]);
expect(
  "catalogsource:ready",
  catalogSource?.status?.connectionState?.lastObservedState === "READY",
  "cywell-ai-sentinel-catalog READY",
  `expected READY, got ${catalogSource?.status?.connectionState?.lastObservedState ?? "missing"}`
);
expect(
  "catalogsource:image",
  catalogSource?.spec?.image?.includes("cas-operator-catalog:v0.1.3-crc"),
  "catalog source uses v0.1.3 catalog image"
);

const packageManifest = json("packagemanifest:json", [
  "get",
  "packagemanifest",
  "cywell-ai-sentinel",
  "-n",
  "openshift-marketplace"
]);
expect(
  "packagemanifest:source",
  packageManifest?.status?.catalogSource === "cywell-ai-sentinel-catalog",
  "PackageManifest is served by cywell-ai-sentinel-catalog",
  `unexpected source ${packageManifest?.status?.catalogSource ?? "missing"}`
);
expect(
  "packagemanifest:display",
  packageManifest?.status?.channels?.some((channel) => channel.currentCSV === "cywell-ai-sentinel-operator.v0.1.3"),
  "PackageManifest points at cywell-ai-sentinel-operator.v0.1.3"
);

const subscription = json("subscription:json", ["get", "subscription", "cywell-ai-sentinel", "-n", namespace]);
expect("subscription:exists", subscription?.spec?.name === "cywell-ai-sentinel", "Subscription exists");
expect("subscription:source", subscription?.spec?.source === "cywell-ai-sentinel-catalog", "Subscription source matches catalog");

const csv = json("csv:json", ["get", "csv", "cywell-ai-sentinel-operator.v0.1.3", "-n", namespace]);
expect("csv:succeeded", csv?.status?.phase === "Succeeded", "CSV Succeeded", `CSV phase ${csv?.status?.phase ?? "missing"}`);
expect("csv:display", csv?.spec?.displayName === "Cywell AI Sentinel Operator", "CSV displayName correct");

const crd = json("crd:json", ["get", "crd", "cywellaisentinels.ai.cywell.co.kr"]);
expect("crd:kind", crd?.spec?.names?.kind === "CywellAISentinel", "CywellAISentinel CRD installed");

const cr = json("cr:json", ["get", "cywellaisentinel", "komsco-edition", "-n", namespace]);
expect("cr:ready", cr?.status?.phase === "Ready", "KOMSCO Edition CR Ready", `CR phase ${cr?.status?.phase ?? "missing"}`);

const deployments = json("deployments:json", ["get", "deploy", "-n", namespace]);
const deploymentByName = new Map((deployments?.items ?? []).map((deployment) => [deployment.metadata.name, deployment]));
expect("operator:ready", deploymentReady(deploymentByName.get("cywell-ai-sentinel-operator")), "operator deployment available");
expect("gateway:ready", deploymentReady(deploymentByName.get("cas-gateway")), "cas-gateway deployment available");
expect("console-plugin:ready", deploymentReady(deploymentByName.get("cas-console-plugin")), "cas-console-plugin deployment available");

const consolePlugin = json("consoleplugin:json", ["get", "consoleplugin", "cywell-ai-sentinel"]);
const proxy = consolePlugin?.spec?.proxy?.find((item) => item.alias === "cas-api");
expect("consoleplugin:backend", consolePlugin?.spec?.backend?.service?.name === "cas-console-plugin", "ConsolePlugin backend points to cas-console-plugin");
expect("consoleplugin:proxy", proxy?.authorization === "UserToken", "ConsolePlugin cas-api proxy uses UserToken");

const consoleOperator = json("console:operator", ["get", "console.operator.openshift.io", "cluster"]);
const plugins = consoleOperator?.spec?.plugins ?? [];
const capabilities = consoleOperator?.spec?.customization?.capabilities ?? [];
const capabilityByName = new Map(capabilities.map((capability) => [capability.name, capability]));
expect("console:cas-enabled", plugins.includes("cywell-ai-sentinel"), "cywell-ai-sentinel plugin enabled");
expect("console:opslens-preserved", plugins.includes("cywell-opslens"), "cywell-opslens plugin preserved");
expect("console:lightspeed-plugin-removed", !plugins.includes("lightspeed-console-plugin"), "native lightspeed plugin removed");
expect(
  "console:lightspeed-button-disabled",
  capabilityByName.get("LightspeedButton")?.visibility?.state === "Disabled",
  "native LightspeedButton disabled"
);

const failures = checks.filter((check) => check.status === "FAIL");
if (failures.length > 0) {
  console.error(`Catalog CRC verification failed with ${failures.length} failures.`);
  process.exitCode = 1;
} else {
  console.log(`Catalog CRC verification passed with ${checks.length} checks.`);
}
