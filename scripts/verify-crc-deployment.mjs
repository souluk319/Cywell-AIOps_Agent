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

function podReady(pod) {
  return (
    pod?.status?.phase === "Running" &&
    !pod?.metadata?.deletionTimestamp &&
    pod?.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True") &&
    pod?.status?.containerStatuses?.every((container) => container.ready && container.state?.running)
  );
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
const gatewayEnv = deploymentByName.get("cas-gateway")?.spec?.template?.spec?.containers?.[0]?.env ?? [];
const gatewayEnvByName = new Map(gatewayEnv.map((item) => [item.name, item.value]));
expect(
  "runtime:gateway-brain-env",
  gatewayEnvByName.get("CAS_BRAIN_PROVIDER") === "openshift-lightspeed" &&
    gatewayEnvByName.get("CAS_LIGHTSPEED_URL")?.includes("lightspeed-app-server.openshift-lightspeed"),
  "cas-gateway is configured to use OpenShift Lightspeed as brain",
  "cas-gateway Lightspeed brain env is missing"
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
expect(
  "console:lightspeed-replaced",
  !enabledPlugins.includes("lightspeed-console-plugin"),
  "lightspeed-console-plugin is disabled so CAS owns the AI launcher position",
  "lightspeed-console-plugin is still enabled"
);

const pods = getJson("runtime:pods", ["get", "pods", "-n", namespace]);
const gatewayPod = pods?.items?.find((pod) => pod.metadata?.name?.startsWith("cas-gateway-") && podReady(pod));
const consolePod = pods?.items?.find((pod) => pod.metadata?.name?.startsWith("cas-console-plugin-") && podReady(pod));

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

  const brainz = execNode(
    gatewayPod.metadata.name,
    "const https=require('https');https.get('https://127.0.0.1:9443/api/aiops/brainz',{rejectUnauthorized:false},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{console.log(JSON.stringify({status:r.statusCode,body:b}));});}).on('error',e=>{console.error(e.message);process.exit(1);});",
    30000
  );
  let brainzOk = false;
  try {
    const parsed = JSON.parse(brainz.stdout);
    const body = JSON.parse(parsed.body);
    brainzOk = parsed.status === 200 && body.brain?.provider === "openshift-lightspeed";
  } catch {
    brainzOk = false;
  }
  expect("runtime:gateway-brainz", brainz.ok && brainzOk, "gateway brainz confirms OpenShift Lightspeed readiness", brainz.stderr || brainz.stdout);
} else {
  fail("runtime:gateway-health", "no running gateway pod");
}

if (consolePod) {
  const manifest = execNode(
    consolePod.metadata.name,
    "const https=require('https');https.get('https://127.0.0.1:9443/plugin-manifest.json',{rejectUnauthorized:false},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{const j=JSON.parse(b);console.log(JSON.stringify({status:r.statusCode,types:j.extensions.map(e=>e.type),refs:JSON.stringify(j.extensions)}));});}).on('error',e=>{console.error(e.message);process.exit(1);});"
  );
  expect(
    "console:launcher-extension",
    manifest.ok &&
      manifest.stdout.includes("console.context-provider") &&
      manifest.stdout.includes("useCASLauncher") &&
      !manifest.stdout.includes("console.navigation/href") &&
      !manifest.stdout.includes("console.page/route"),
    "CAS plugin registers a launcher context-provider without nav/full-screen route",
    manifest.stderr || manifest.stdout
  );

  const queryCode = [
    "const https=require('https');",
    "const payload=JSON.stringify({question:'default namespace의 api pod가 왜 재시작됐어?',scope:{cluster:'local-cluster',namespaces:['default']},resourceRef:{kind:'Pod',name:'api-7c8d9'},mode:'read_only',stream:false});",
    "const req=https.request('https://127.0.0.1:9443/api/aiops/query',{method:'POST',rejectUnauthorized:false,headers:{'content-type':'application/json','content-length':Buffer.byteLength(payload)}},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{const j=JSON.parse(b);console.log(JSON.stringify({status:r.statusCode,mode:j.mode,topCause:j.rca_result?.cause_candidates?.[0]?.cause,evidence:j.evidence_bundle?.evidence?.length}));});});",
    "req.on('error',e=>{console.error(e.message);process.exit(1);});req.write(payload);req.end();"
  ].join("");
  const query = execNode(consolePod.metadata.name, queryCode);
  expect(
    "runtime:fallback-query-through-plugin",
    query.ok && query.stdout.includes("memory limit exceeded") && query.stdout.includes("lightspeed_fallback_mock"),
    "console plugin without token degrades visibly to fallback mock RCA",
    query.stderr || query.stdout
  );

  const token = run("oc", ["whoami", "-t"], 30000);
  if (!token.ok || !token.stdout) {
    fail("runtime:lightspeed-query-through-plugin", "could not obtain local oc user token");
  } else {
    const tokenB64 = Buffer.from(token.stdout, "utf8").toString("base64");
    const liveQueryCode = [
      "const https=require('https');",
      `const token=Buffer.from('${tokenB64}','base64').toString('utf8');`,
      "const payload=JSON.stringify({question:'ClusterVersion 상태를 한 문장으로 요약해줘.',scope:{cluster:'local-cluster',namespaces:['default']},resourceRef:{kind:'ClusterVersion',name:'version'},mode:'read_only',stream:false,locale:'ko-KR'});",
      "const req=https.request('https://127.0.0.1:9443/api/aiops/query',{method:'POST',rejectUnauthorized:false,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','content-length':Buffer.byteLength(payload)}},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{const j=JSON.parse(b);console.log(JSON.stringify({status:r.statusCode,mode:j.mode,provider:j.audit?.answer_provider,brain:j.audit?.brain?.status,answerLength:j.rca_result?.answer?.length||0,conversation:!!j.conversation_id}));});});",
      "req.on('error',e=>{console.error(e.message);process.exit(1);});req.write(payload);req.end();"
    ].join("");
    const liveQuery = execNode(consolePod.metadata.name, liveQueryCode, 150000);
    expect(
      "runtime:lightspeed-query-through-plugin",
      liveQuery.ok &&
        liveQuery.stdout.includes("lightspeed_read_only") &&
        liveQuery.stdout.includes("openshift-lightspeed") &&
        liveQuery.stdout.includes("\"brain\":\"ok\""),
      "console plugin forwards user token and CAS receives a real Lightspeed answer",
      liveQuery.stderr || liveQuery.stdout
    );
  }
} else {
  fail("runtime:fallback-query-through-plugin", "no running console plugin pod");
}

const failures = checks.filter((check) => check.status === "FAIL");
const finalStatus = failures.length > 0 ? "FAIL" : "PASS";
console.log(`CAS CRC deployment final status: ${finalStatus}`);
if (failures.length > 0) process.exitCode = 1;
