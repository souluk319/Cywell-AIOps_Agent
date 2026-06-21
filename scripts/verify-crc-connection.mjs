#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdir, writeFile } from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import { dirname, resolve } from "node:path";

const expectedMinor =
  process.argv.find((arg) => arg.startsWith("--expected-minor="))?.split("=")[1] ??
  process.env.CYWELL_EXPECTED_OCP_MINOR ??
  "4.20";
const requireCluster = process.argv.includes("--require-cluster");
const sshHost =
  process.argv.find((arg) => arg.startsWith("--ssh-host="))?.split("=")[1] ??
  process.env.CYWELL_KH_SSH_HOST ??
  "Kugnus-Home";
const evidenceOut = resolve("test-results/cas-crc-connection.json");
const checkedAt = new Date().toISOString();

const checks = [];
const warnings = [];
const failures = [];
let ocMode = "none";

function redact(value) {
  return String(value ?? "")
    .replace(/https?:\/\/(?!api\.crc\.testing|console-openshift-console\.apps-crc\.testing|oauth-openshift\.apps-crc\.testing|downloads-openshift-console\.apps-crc\.testing)[^\s"'<>]+/gi, "<redacted-url>")
    .replace(/\b(?!127\.0\.0\.1\b)(?:\d{1,3}\.){3}\d{1,3}\b/g, "<redacted-ip>")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/([?&](?:access_)?token=)[^&\s]+/gi, "$1<redacted>")
    .replace(/(token|password|passwd|secret|api[_-]?key)(=|:)\S+/gi, "$1$2<redacted>");
}

function record(status, id, detail, extra = {}) {
  const item = { status, id, detail: redact(detail), ...extra };
  checks.push(item);
  if (status === "WARN") warnings.push(`${id}: ${item.detail}`);
  if (status === "FAIL") failures.push(`${id}: ${item.detail}`);
  console.log(`[${status}] ${id}: ${item.detail}`);
}

function pass(id, detail, extra) {
  record("PASS", id, detail, extra);
}

function warn(id, detail, extra) {
  record("WARN", id, detail, extra);
}

function fail(id, detail, extra) {
  if (requireCluster) record("FAIL", id, detail, extra);
  else record("WARN", id, detail, extra);
}

function run(command, args, timeoutMs = 10000) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: redact(result.stdout?.trim() ?? ""),
    stderr: redact(result.stderr?.trim() ?? result.error?.message ?? "")
  };
}

function runRemoteOc(args, timeoutMs = 12000) {
  return run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", sshHost, "oc", ...args], timeoutMs);
}

function runSelectedOc(args, timeoutMs = 12000) {
  if (ocMode === "local") return run("oc", args, timeoutMs);
  if (ocMode === "ssh") return runRemoteOc(args, timeoutMs);
  return { ok: false, status: 1, stdout: "", stderr: "no working oc context found" };
}

function tcpConnect(host, port, timeoutMs = 4000) {
  return new Promise((resolveTcp) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveTcp({ ok, detail });
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => finish(true, `${host}:${port} accepted TCP connection`));
    socket.on("timeout", () => finish(false, `${host}:${port} timed out`));
    socket.on("error", (error) => finish(false, error.message));
  });
}

function httpsRequest(url, { method = "GET", timeoutMs = 6000 } = {}) {
  return new Promise((resolveHttps) => {
    const request = https.request(
      url,
      { method, rejectUnauthorized: false, timeout: timeoutMs },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 12000) request.destroy();
        });
        response.on("end", () => {
          resolveHttps({ ok: true, statusCode: response.statusCode ?? 0, body: redact(body) });
        });
      }
    );
    request.on("timeout", () => request.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    request.on("error", (error) => resolveHttps({ ok: false, statusCode: 0, body: "", error: redact(error.message) }));
    request.end();
  });
}

async function dnsToLoopback(host) {
  try {
    const addresses = await lookup(host, { all: true });
    const loopback = addresses.some((entry) => entry.address === "127.0.0.1" || entry.address === "::1");
    if (loopback) pass(`dns:${host}`, "resolves to loopback for the active CRC tunnel");
    else fail(`dns:${host}`, `does not resolve to loopback: ${addresses.map((entry) => entry.address).join(", ")}`);
  } catch (error) {
    fail(`dns:${host}`, error.message);
  }
}

function parseMinor(version) {
  const match = String(version ?? "").match(/^(\d+\.\d+)/);
  return match?.[1] ?? "unknown";
}

function condition(resource, type) {
  return resource?.status?.conditions?.find((item) => item.type === type)?.status ?? "Unknown";
}

function clusterOperatorSummary(resource) {
  return {
    name: resource?.metadata?.name ?? "unknown",
    available: condition(resource, "Available"),
    progressing: condition(resource, "Progressing"),
    degraded: condition(resource, "Degraded")
  };
}

const branch = run("git", ["branch", "--show-current"]).stdout || "unknown";
const head = run("git", ["rev-parse", "--short", "HEAD"]).stdout || "unknown";

console.log("Cywell AI Sentinel CRC connection gate");
console.log(`branch=${branch} head=${head} expectedMinor=${expectedMinor}`);

for (const host of [
  "api.crc.testing",
  "console-openshift-console.apps-crc.testing",
  "oauth-openshift.apps-crc.testing",
  "downloads-openshift-console.apps-crc.testing"
]) {
  await dnsToLoopback(host);
}

for (const [host, port] of [
  ["127.0.0.1", 443],
  ["127.0.0.1", 6443]
]) {
  const result = await tcpConnect(host, port);
  if (result.ok) pass(`tcp:${port}`, result.detail);
  else fail(`tcp:${port}`, result.detail);
}

const consoleResponse = await httpsRequest("https://console-openshift-console.apps-crc.testing", { method: "HEAD" });
if (consoleResponse.ok && consoleResponse.statusCode >= 200 && consoleResponse.statusCode < 400) {
  pass("route:console", `console route returned HTTP ${consoleResponse.statusCode}`);
} else {
  fail("route:console", consoleResponse.error ?? `HTTP ${consoleResponse.statusCode}`);
}

const oauthResponse = await httpsRequest("https://oauth-openshift.apps-crc.testing", { method: "HEAD" });
if (oauthResponse.ok && oauthResponse.statusCode > 0 && oauthResponse.statusCode < 500) {
  pass("route:oauth", `oauth route returned HTTP ${oauthResponse.statusCode}`);
} else {
  fail("route:oauth", oauthResponse.error ?? `HTTP ${oauthResponse.statusCode}`);
}

const apiVersionResponse = await httpsRequest("https://api.crc.testing:6443/version");
let apiVersion = "unknown";
if (apiVersionResponse.ok && apiVersionResponse.statusCode === 200) {
  try {
    const versionBody = JSON.parse(apiVersionResponse.body);
    apiVersion = versionBody.gitVersion ?? "unknown";
    pass("route:api-version", `Kubernetes API /version returned ${apiVersion}`);
  } catch (error) {
    fail("route:api-version", `API /version returned invalid JSON: ${error.message}`);
  }
} else {
  fail("route:api-version", apiVersionResponse.error ?? `HTTP ${apiVersionResponse.statusCode}`);
}

const ocVersion = run("oc", ["version", "--client=true", "-o", "json"], 10000);
if (ocVersion.ok) pass("oc:local-client", "local oc client is available");
else warn("oc:local-client", ocVersion.stderr || "local oc client unavailable");

let ocServer = run("oc", ["whoami", "--show-server"], 10000);
if (ocServer.ok) {
  ocMode = "local";
  pass("oc:mode", "using local Windows oc context");
} else {
  warn("oc:local-context", `${ocServer.stderr || "local oc context unavailable"}; trying ssh ${sshHost} oc context`);
  const remoteServer = runRemoteOc(["whoami", "--show-server"], 12000);
  if (remoteServer.ok) {
    ocMode = "ssh";
    ocServer = remoteServer;
    pass("oc:mode", `using ${sshHost} remote oc context`);
  } else {
    ocServer = remoteServer;
    fail("oc:mode", remoteServer.stderr || `${sshHost} remote oc context unavailable`);
  }
}

if (ocServer.ok) {
  const serverProfile = ocServer.stdout.includes("api.crc.testing")
    ? "api.crc.testing"
    : ocServer.stdout.includes("127.0.0.1")
      ? "loopback"
      : "other";
  if (serverProfile === "other") warn("oc:server", "oc is connected, but server is not the expected local CRC route");
  else pass("oc:server", `oc server profile=${serverProfile}`);
}

let clusterVersion = "unknown";
const cv = runSelectedOc(["get", "clusterversion", "version", "-o", "json"], 12000);
if (cv.ok) {
  try {
    const parsed = JSON.parse(cv.stdout);
    clusterVersion = parsed?.status?.desired?.version ?? parsed?.status?.history?.[0]?.version ?? "unknown";
    const minor = parseMinor(clusterVersion);
    if (minor === expectedMinor) pass("ocp:minor", `OpenShift ${clusterVersion} matches target ${expectedMinor}`);
    else fail("ocp:minor", `OpenShift ${clusterVersion} does not match target ${expectedMinor}`);
  } catch (error) {
    fail("ocp:minor", `could not parse clusterversion JSON: ${error.message}`);
  }
} else {
  fail("ocp:minor", cv.stderr || "could not read clusterversion");
}

const clusterOperators = [];
for (const operatorName of ["console", "monitoring", "image-registry"]) {
  const co = runSelectedOc(["get", "co", operatorName, "-o", "json"], 12000);
  if (!co.ok) {
    warn(`co:${operatorName}`, co.stderr || "could not read ClusterOperator");
    continue;
  }
  try {
    const parsed = JSON.parse(co.stdout);
    const summary = clusterOperatorSummary(parsed);
    clusterOperators.push(summary);
    if (summary.available === "True" && summary.progressing === "False" && summary.degraded === "False") {
      pass(`co:${summary.name}`, "Available=True Progressing=False Degraded=False", summary);
    } else {
      warn(`co:${summary.name}`, `Available=${summary.available} Progressing=${summary.progressing} Degraded=${summary.degraded}`, summary);
    }
  } catch (error) {
    warn(`co:${operatorName}`, `could not parse ClusterOperator JSON: ${error.message}`);
  }
}

const consolePluginCrd = runSelectedOc(["get", "crd", "consoleplugins.console.openshift.io", "-o", "name"], 10000);
if (consolePluginCrd.ok) pass("console:plugin-crd", "ConsolePlugin CRD is present");
else fail("console:plugin-crd", consolePluginCrd.stderr || "ConsolePlugin CRD missing");

const finalStatus = failures.length > 0 ? "FAIL" : warnings.length > 0 ? "PASS_WITH_WARNINGS" : "PASS";
const evidence = {
  checkedAt,
  product: "Cywell AI Sentinel",
  target: "local CRC OpenShift",
  branch,
  head,
  finalStatus,
  expectedMinor,
  requireCluster,
  ocMode,
  sshHost,
  apiVersion,
  clusterVersion,
  clusterOperators,
  checks,
  warnings,
  failures
};

await mkdir(dirname(evidenceOut), { recursive: true });
await writeFile(evidenceOut, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

console.log(`CAS CRC connection final status: ${finalStatus}`);
console.log(`Evidence: ${evidenceOut}`);

if (failures.length > 0) process.exitCode = 1;

