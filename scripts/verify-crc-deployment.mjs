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

function record(status, id, detail, extra = {}) {
  checks.push({ status, id, detail, ...extra });
  console.log(`[${status}] ${id}: ${detail}`);
}

function pass(id, detail, extra) {
  record("PASS", id, detail, extra);
}

function fail(id, detail, extra) {
  record("FAIL", id, detail, extra);
}

function expect(id, condition, passDetail, failDetail = passDetail, extra = {}) {
  if (condition) pass(id, passDetail, extra);
  else fail(id, failDetail, extra);
}

function getJson(id, args) {
  const result = run("oc", [...args, "-o", "json"]);
  if (!result.ok) {
    fail(id, result.stderr || result.stdout || "oc command failed");
    return undefined;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(id, `could not parse JSON: ${error.message}`);
    return undefined;
  }
}

function deploymentReady(deployment) {
  return (
    Number(deployment?.status?.availableReplicas ?? 0) >= Number(deployment?.spec?.replicas ?? 1) &&
    deployment?.status?.conditions?.some((condition) => condition.type === "Available" && condition.status === "True")
  );
}

function execNode(pod, code, timeoutMs = 30000) {
  return run("oc", ["exec", "-n", namespace, pod, "--", "node", "-e", code], timeoutMs);
}

const images = getJson("images:istags", ["get", "istag", "-n", namespace]);
const imageNames = (images?.items ?? []).map((item) => item.metadata?.name);
expect("images:gateway", imageNames.includes("cas-gateway:dev"), "cas-gateway:dev exists", "cas-gateway:dev missing");
expect(
  "images:console-plugin",
  imageNames.includes("cas-console-plugin:dev"),
  "cas-console-plugin:dev exists",
  "cas-console-plugin:dev missing"
);

const deployments = getJson("runtime:deployments", ["get", "deploy", "-n", namespace]);
const deploymentByName = new Map((deployments?.items ?? []).map((deployment) => [deployment.metadata.name, deployment]));
expect("runtime:gateway-ready", deploymentReady(deploymentByName.get("cas-gateway")), "cas-gateway available", "cas-gateway not available");
expect(
  "runtime:console-plugin-ready",
  deploymentReady(deploymentByName.get("cas-console-plugin")),
  "cas-console-plugin available",
  "cas-console-plugin not available"
);

const consolePlugin = getJson("console:plugin-cr", ["get", "consoleplugin", "cywell-ai-sentinel"]);
const proxy = consolePlugin?.spec?.proxy?.find((item) => item.alias === "cas-api");
expect(
  "console:plugin-contract",
  consolePlugin?.spec?.backend?.service?.name === "cas-console-plugin" && proxy?.endpoint?.service?.name === "cas-gateway",
  "ConsolePlugin backend and cas-api proxy are configured",
  "ConsolePlugin backend/proxy contract is incomplete"
);
expect(
  "console:proxy-usertoken",
  proxy?.authorization === "UserToken",
  "cas-api proxy forwards UserToken",
  `expected UserToken, got ${proxy?.authorization ?? "missing"}`
);

const consoleOperator = getJson("console:operator", ["get", "console.operator.openshift.io", "cluster"]);
const enabledPlugins = consoleOperator?.spec?.plugins ?? [];
expect("console:opslens-still-enabled", enabledPlugins.includes("cywell-opslens"), "cywell-opslens remains enabled");
expect("console:cas-enabled", enabledPlugins.includes("cywell-ai-sentinel"), "cywell-ai-sentinel is enabled");

const pods = getJson("runtime:pods", ["get", "pods", "-n", namespace]);
const gatewayPod = pods?.items?.find((pod) => pod.metadata?.name?.startsWith("cas-gateway-") && pod.status?.phase === "Running");
const consolePod = pods?.items?.find((pod) => pod.metadata?.name?.startsWith("cas-console-plugin-") && pod.status?.phase === "Running");

if (gatewayPod) {
  const health = execNode(
    gatewayPod.metadata.name,
    "const https=require('https');https.get('https://127.0.0.1:9443/api/aiops/healthz',{rejectUnauthorized:false},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{console.log(JSON.stringify({status:r.statusCode,body:b}));});}).on('error',e=>{console.error(e.message);process.exit(1);});"
  );
  let healthOk = false;
  try {
    const parsed = JSON.parse(health.stdout);
    const body = JSON.parse(parsed.body);
    healthOk = parsed.status === 200 && body.status === "ok";
  } catch {
    healthOk = false;
  }
  expect("runtime:gateway-health", health.ok && healthOk, "gateway healthz ok", health.stderr || health.stdout);
} else {
  fail("runtime:gateway-health", "no running gateway pod");
}

if (consolePod) {
  const queryCode = [
    "const https=require('https');",
    "const payload=JSON.stringify({question:'default namespace의 api pod가 왜 재시작됐어?',scope:{cluster:'local-cluster',namespaces:['default']},resourceRef:{kind:'Pod',name:'api-7c8d9'},mode:'read_only',stream:false});",
    "const req=https.request('https://127.0.0.1:9443/api/aiops/query',{method:'POST',rejectUnauthorized:false,headers:{'content-type':'application/json','content-length':Buffer.byteLength(payload)}},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{const j=JSON.parse(b);console.log(JSON.stringify({status:r.statusCode,mode:j.mode,topCause:j.rca_result?.cause_candidates?.[0]?.cause,evidence:j.evidence_bundle?.evidence?.length}));});});",
    "req.on('error',e=>{console.error(e.message);process.exit(1);});req.write(payload);req.end();"
  ].join("");
  const query = execNode(consolePod.metadata.name, queryCode);
  expect(
    "runtime:mock-query-through-plugin",
    query.ok && query.stdout.includes("memory limit exceeded") && query.stdout.includes("mock_read_only"),
    "console plugin proxies mock RCA query to gateway",
    query.stderr || query.stdout
  );
} else {
  fail("runtime:mock-query-through-plugin", "no running console plugin pod");
}

const failures = checks.filter((check) => check.status === "FAIL");
const finalStatus = failures.length > 0 ? "FAIL" : "PASS";
console.log(`CAS CRC deployment final status: ${finalStatus}`);
if (failures.length > 0) process.exitCode = 1;
