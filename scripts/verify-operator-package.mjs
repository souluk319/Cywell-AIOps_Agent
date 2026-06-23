#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const files = {
  crd: "deploy/olm/bundle/manifests/ai.cywell.co.kr_cywellaisentinels.yaml",
  csv: "deploy/olm/bundle/manifests/cywell-ai-sentinel-operator.clusterserviceversion.yaml",
  annotations: "deploy/olm/bundle/metadata/annotations.yaml",
  bundleDockerfile: "deploy/olm/bundle.Dockerfile",
  catalog: "deploy/olm/catalog/catalog.yaml",
  catalogDockerfile: "deploy/olm/catalog.Dockerfile",
  catalogSource: "deploy/olm/openshift/catalogsource.yaml",
  subscription: "deploy/olm/openshift/subscription.yaml",
  sample: "deploy/olm/openshift/komsco-edition.yaml",
  operator: "apps/operator/src/index.mjs"
};

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

async function text(path) {
  try {
    const value = await readFile(path, "utf8");
    pass(`file:${path}`, "readable");
    return value;
  } catch (error) {
    fail(`file:${path}`, error.message);
    return "";
  }
}

const content = Object.fromEntries(
  await Promise.all(Object.entries(files).map(async ([key, path]) => [key, await text(path)]))
);

const olmContent = Object.entries(content)
  .filter(([key]) => key !== "operator")
  .map(([, value]) => value)
  .join("\n");
const forbidden = ["cywell-opslens", "opslens.cywell.io", "OpsLensInstallation", "CASInstallation", "casinstallations.cas.cywell.io"];
for (const value of forbidden) {
  expect(`contamination:${value}`, !olmContent.includes(value), `${value} absent`, `${value} must not appear in CAS OLM package`);
}

expect("package:name", content.catalog.includes("name: cywell-ai-sentinel"), "catalog package name present");
expect("package:channel", content.catalog.includes("defaultChannel: alpha"), "catalog default channel alpha present");
expect(
  "bundle:name",
  content.catalog.includes("cywell-ai-sentinel-operator.v0.1.3") && content.csv.includes("name: cywell-ai-sentinel-operator.v0.1.3"),
  "bundle and CSV use v0.1.3"
);
expect("crd:name", content.crd.includes("name: cywellaisentinels.ai.cywell.co.kr"), "CywellAISentinel CRD name present");
expect("crd:kind", content.crd.includes("kind: CywellAISentinel"), "CywellAISentinel kind present");
expect("crd:group", content.crd.includes("group: ai.cywell.co.kr"), "ai.cywell.co.kr group present");
expect("csv:display", content.csv.includes("displayName: Cywell AI Sentinel Operator"), "CSV displayName present");
expect("csv:owned-crd", content.csv.includes("cywellaisentinels.ai.cywell.co.kr"), "CSV owns CywellAISentinel CRD");
expect("csv:operator-image", content.csv.includes("cas-operator:v0.1.3-crc"), "CSV operator image pinned");
expect("csv:gateway-image", content.csv.includes("cas-gateway:v0.1.3-crc"), "CSV gateway image pinned");
expect("csv:plugin-image", content.csv.includes("cas-console-plugin:v0.1.3-crc"), "CSV console plugin image pinned");
expect(
  "csv:operand-rbac-core-read",
  content.csv.includes("- pods\n                - pods/log\n                - events") &&
    content.csv.includes("- get\n                - list\n                - watch"),
  "CSV grants operator read access needed to create CAS evidence Role"
);
expect(
  "csv:operand-rbac-replicasets-read",
  content.csv.includes("- replicasets") && content.csv.includes("- apps"),
  "CSV grants operator read access needed for ReplicaSet evidence Role"
);
expect("catalogsource:name", content.catalogSource.includes("name: cywell-ai-sentinel-catalog"), "CatalogSource name present");
expect("catalogsource:image", content.catalogSource.includes("cas-operator-catalog:v0.1.3-crc"), "CatalogSource image pinned");
expect("subscription:name", content.subscription.includes("name: cywell-ai-sentinel"), "Subscription package name present");
expect("subscription:source", content.subscription.includes("source: cywell-ai-sentinel-catalog"), "Subscription source present");
expect("sample:kind", content.sample.includes("kind: CywellAISentinel"), "sample CR kind present");
expect("operator:console-merge", content.operator.includes("cywell-opslens") && content.operator.includes("lightspeed-console-plugin"), "operator preserves OpsLens and removes native Lightspeed plugin");
expect("operator:lightspeed-button", content.operator.includes("LightspeedButton") && content.operator.includes("Disabled"), "operator disables LightspeedButton");

const opm = spawnSync("opm", ["validate", "deploy/olm/catalog"], {
  cwd: process.cwd(),
  encoding: "utf8",
  windowsHide: true
});
expect("opm:validate-catalog", opm.status === 0, "opm validate deploy/olm/catalog passed", opm.stderr || opm.stdout);

const failures = checks.filter((check) => check.status === "FAIL");
if (failures.length > 0) {
  console.error(`Operator package verification failed with ${failures.length} failures.`);
  process.exitCode = 1;
} else {
  console.log(`Operator package verification passed with ${checks.length} checks.`);
}
