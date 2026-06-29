#!/usr/bin/env node
import { randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const namespace = "playbookstudio";
const deploymentName = "app";
const approvedPbsSourceHead = "6604777abb9e6bd44a83c6a12f36e31ac396489e";
const repoPinnedSourceDir = resolve(process.cwd(), "..", "PBS-Dev3-cywell-v014-source-pin-clone");
const repoDefaultSourceDir = existsSync(repoPinnedSourceDir) ? repoPinnedSourceDir : resolve(process.cwd(), "..", "PBS-Dev3");
const pbsSourceDir = resolve(process.env.CAS_PBS_SOURCE_DIR || repoDefaultSourceDir);
const overlayPath = join(pbsSourceDir, "deploy", "openshift-cywell-v014");
const evidencePath = join("test-results", "cas-pbs-runtime-crc-deployment.json");
const checks = [];
const startedAt = new Date().toISOString();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    input: options.input,
    stdio: options.stdio ?? "pipe",
    timeout: options.timeoutMs ?? 900000,
    windowsHide: true
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout?.trim() ?? "",
    stderr: (result.stderr ?? result.error?.message ?? "").trim()
  };
}

function git(args, cwd = pbsSourceDir) {
  return run("git", args, { cwd, timeoutMs: 30000 });
}

function record(status, id, detail, extra = {}) {
  checks.push({ status, id, detail, ...extra });
  console.log(`[${status}] ${id}: ${detail}`);
}

function pass(id, detail, extra = {}) {
  record("PASS", id, detail, extra);
}

function fail(id, detail, extra = {}) {
  record("FAIL", id, detail, extra);
}

function expect(id, condition, passDetail, failDetail = passDetail, extra = {}) {
  if (condition) pass(id, passDetail, extra);
  else fail(id, failDetail, extra);
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function b64(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

function yamlSecret(name, data) {
  const encoded = Object.entries(data)
    .filter(([, value]) => String(value ?? "").trim())
    .map(([key, value]) => `  ${key}: ${b64(value)}`)
    .join("\n");
  return [
    "apiVersion: v1",
    "kind: Secret",
    "metadata:",
    `  name: ${name}`,
    `  namespace: ${namespace}`,
    "type: Opaque",
    "data:",
    encoded
  ].join("\n") + "\n";
}

function applyYaml(yaml, detail) {
  const result = run("oc", ["apply", "-f", "-"], { input: yaml, timeoutMs: 120000 });
  expect(detail.id, result.ok, detail.pass, result.stderr || result.stdout || detail.fail, {
    stdout: result.ok ? result.stdout : undefined
  });
  return result.ok;
}

function getJson(id, args) {
  const result = run("oc", [...args, "-o", "json"], { timeoutMs: 120000 });
  if (!result.ok) {
    fail(id, result.stderr || result.stdout || `oc ${args.join(" ")} failed`);
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(id, `could not parse JSON: ${error.message}`);
    return null;
  }
}

function writeEvidence() {
  mkdirSync("test-results", { recursive: true });
  const failures = checks.filter((check) => check.status === "FAIL");
  const warnings = checks.filter((check) => check.status === "WARN");
  const status = failures.length > 0 ? "FAIL" : warnings.length > 0 ? "WARN" : "PASS";
  const evidence = {
    status,
    startedAt,
    checkedAt: new Date().toISOString(),
    summary: {
      total: checks.length,
      passed: checks.filter((check) => check.status === "PASS").length,
      warned: warnings.length,
      failed: failures.length
    },
    pbsSource: sourceMetadata,
    overlayPath,
    namespace,
    checks
  };
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log(`Evidence: ${evidencePath}`);
  return status;
}

function tokenFromOc() {
  const result = run("oc", ["whoami", "-t"], { timeoutMs: 30000 });
  return result.ok ? result.stdout.trim() : "";
}

const sourceMetadata = {
  path: pbsSourceDir,
  branch: git(["branch", "--show-current"]).stdout,
  fullHead: git(["rev-parse", "HEAD"]).stdout,
  shortHead: git(["rev-parse", "--short", "HEAD"]).stdout,
  treeStatus: git(["status", "--short"]).stdout ? "dirty" : "clean",
  remoteOriginUrl: git(["config", "--get", "remote.origin.url"]).stdout
};

expect("pbs-runtime-crc:source-dir", existsSync(pbsSourceDir), `using PBS source directory ${pbsSourceDir}`);
expect("pbs-runtime-crc:overlay-path", existsSync(overlayPath), `using PBS runtime overlay ${overlayPath}`);
expect(
  "pbs-runtime-crc:approved-source-head",
  sourceMetadata.fullHead === approvedPbsSourceHead,
  `PBS source HEAD matches approved v0.1.4 SHA ${approvedPbsSourceHead}`,
  `PBS source HEAD ${sourceMetadata.fullHead || "unknown"} must match approved v0.1.4 SHA ${approvedPbsSourceHead}`
);
expect("pbs-runtime-crc:source-clean", sourceMetadata.treeStatus === "clean", "PBS source tree is clean", `PBS source tree is ${sourceMetadata.treeStatus}`);

if (checks.some((check) => check.status === "FAIL")) {
  const status = writeEvidence();
  process.exitCode = status === "PASS" ? 0 : 1;
  process.exit();
}

const postgresPassword = process.env.PLAYBOOKSTUDIO_POSTGRES_PASSWORD || `pbs-${randomBytes(24).toString("hex")}`;
const ocpToken = process.env.PLAYBOOKSTUDIO_OCP_API_TOKEN || process.env.OCP_API_TOKEN || tokenFromOc();
const lightspeedToken = process.env.PLAYBOOKSTUDIO_OPENSHIFT_LIGHTSPEED_API_TOKEN || process.env.OPENSHIFT_LIGHTSPEED_API_TOKEN || "";

expect(
  "pbs-runtime-crc:secret-inputs",
  postgresPassword.length >= 32 && ocpToken.length >= 20,
  "local CRC PBS Secret inputs are present and non-placeholder",
  "PLAYBOOKSTUDIO_POSTGRES_PASSWORD and PLAYBOOKSTUDIO_OCP_API_TOKEN/OCP_API_TOKEN must be non-placeholder values"
);

if (checks.some((check) => check.status === "FAIL")) {
  const status = writeEvidence();
  process.exitCode = status === "PASS" ? 0 : 1;
  process.exit();
}

applyYaml(
  [
    "apiVersion: v1",
    "kind: Namespace",
    "metadata:",
    `  name: ${namespace}`,
    "  labels:",
    "    app.kubernetes.io/part-of: playbookstudio",
    "    cywell.ai/runtime-contract: pbs-v0.1.4"
  ].join("\n") + "\n",
  {
    id: "pbs-runtime-crc:namespace-apply",
    pass: "playbookstudio namespace applied",
    fail: "failed to apply playbookstudio namespace"
  }
);

applyYaml(
  yamlSecret("playbookstudio-secret", {
    POSTGRES_PASSWORD: postgresPassword,
    OCP_API_TOKEN: ocpToken,
    OPENSHIFT_LIGHTSPEED_API_TOKEN: lightspeedToken,
    OLS_AUTH_TOKEN: lightspeedToken
  }),
  {
    id: "pbs-runtime-crc:runtime-secret-apply",
    pass: "playbookstudio runtime Secret applied with redacted local CRC values",
    fail: "failed to apply playbookstudio runtime Secret"
  }
);

const applyOverlay = run("oc", ["apply", "-k", overlayPath], { timeoutMs: 600000 });
expect(
  "pbs-runtime-crc:overlay-apply",
  applyOverlay.ok,
  "PBS runtime overlay applied",
  applyOverlay.stderr || applyOverlay.stdout || "failed to apply PBS runtime overlay",
  { stdout: applyOverlay.ok ? applyOverlay.stdout : undefined }
);

const setEnv = run("oc", ["set", "env", `deployment/${deploymentName}`, "-n", namespace, `PLAYBOOKSTUDIO_SOURCE_HEAD=${approvedPbsSourceHead}`], {
  timeoutMs: 120000
});
expect(
  "pbs-runtime-crc:source-env-stamp",
  setEnv.ok,
  "PBS runtime deployment env stamps approved source SHA",
  setEnv.stderr || setEnv.stdout || "failed to set PLAYBOOKSTUDIO_SOURCE_HEAD"
);

const sourcePatch = JSON.stringify({
  spec: {
    template: {
      metadata: {
        annotations: {
          "cywell.ai/pbs-source-head": approvedPbsSourceHead,
          "org.opencontainers.image.revision": approvedPbsSourceHead
        }
      }
    }
  }
});
const patch = run("oc", ["patch", `deployment/${deploymentName}`, "-n", namespace, "--type=merge", "-p", sourcePatch], {
  timeoutMs: 120000
});
expect(
  "pbs-runtime-crc:source-annotation-stamp",
  patch.ok,
  "PBS runtime deployment pod template annotations stamp approved source SHA",
  patch.stderr || patch.stdout || "failed to patch PBS runtime source annotations"
);

for (const name of ["postgres", "app", "web"]) {
  const rollout = run("oc", ["rollout", "status", `deployment/${name}`, "-n", namespace, "--timeout=900s"], {
    timeoutMs: 930000
  });
  expect(
    `pbs-runtime-crc:rollout:${name}`,
    rollout.ok,
    `${name} deployment rolled out`,
    rollout.stderr || rollout.stdout || `${name} rollout failed`
  );
}

const service = getJson("pbs-runtime-crc:runtime-service", ["get", "service", "-n", namespace, "playbookstudio-runtime"]);
if (service) {
  const ports = service.spec?.ports ?? [];
  const selector = service.spec?.selector ?? {};
  expect(
    "pbs-runtime-crc:runtime-service-contract",
    ports.some((port) => Number(port.port) === 8765) &&
      selector["app.kubernetes.io/name"] === "playbookstudio" &&
      selector["app.kubernetes.io/component"] === "runtime",
    "playbookstudio-runtime exposes port 8765 with Cywell runtime labels",
    `playbookstudio-runtime contract mismatch: ${JSON.stringify({ ports, selector })}`
  );
}

const deployment = getJson("pbs-runtime-crc:runtime-deployment", ["get", "deployment", "-n", namespace, deploymentName]);
if (deployment) {
  const annotations = deployment.spec?.template?.metadata?.annotations ?? {};
  const env = deployment.spec?.template?.spec?.containers?.find((container) => container.name === "app")?.env ?? [];
  const envHead = env.find((item) => item.name === "PLAYBOOKSTUDIO_SOURCE_HEAD")?.value;
  expect(
    "pbs-runtime-crc:runtime-source-stamped",
    annotations["cywell.ai/pbs-source-head"] === approvedPbsSourceHead &&
      annotations["org.opencontainers.image.revision"] === approvedPbsSourceHead &&
      envHead === approvedPbsSourceHead,
    "PBS runtime pod template is stamped with the approved source SHA",
    `PBS runtime source stamp mismatch: ${JSON.stringify({ annotations, envHead })}`
  );
}

const endpoints = getJson("pbs-runtime-crc:runtime-endpoints", ["get", "endpoints", "-n", namespace, "playbookstudio-runtime"]);
if (endpoints) {
  const ready = (endpoints.subsets ?? []).some((subset) => (subset.addresses ?? []).length > 0 && (subset.ports ?? []).some((port) => Number(port.port) === 8765));
  expect(
    "pbs-runtime-crc:runtime-endpoints-ready",
    ready,
    "playbookstudio-runtime has a ready endpoint on port 8765",
    `playbookstudio-runtime endpoints are not ready on port 8765: ${JSON.stringify(endpoints.subsets ?? [])}`
  );
}

checks.push({
  status: "PASS",
  id: "pbs-runtime-crc:redacted-secret-evidence",
  detail: "evidence stores only secret hashes",
  postgresPasswordSha256: sha256(postgresPassword),
  ocpTokenSha256: sha256(ocpToken),
  lightspeedTokenSha256: lightspeedToken ? sha256(lightspeedToken) : null
});

const finalStatus = writeEvidence();
process.exitCode = finalStatus === "PASS" ? 0 : 1;
