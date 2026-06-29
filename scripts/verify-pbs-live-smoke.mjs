#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";

const checks = [];
const children = [];
const checkedAt = new Date().toISOString();
const pbsBaseUrl = (process.env.CAS_PBS_BASE_URL ?? "").trim();
const namespace = process.env.CAS_PBS_LIVE_NAMESPACE || "cywell-ai-sentinel";

function envBool(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  return ["1", "true", "yes", "y", "on"].includes(String(raw).trim().toLowerCase());
}

const cutover = process.argv.includes("--cutover") || envBool("CAS_PBS_LIVE_CUTOVER");
const clusterSmoke = process.argv.includes("--cluster") || envBool("CAS_PBS_LIVE_CLUSTER_SMOKE");
const readOnlyException = process.argv.includes("--read-only-exception") || envBool("CAS_PBS_LIVE_READ_ONLY_EXCEPTION");
const requireLive = cutover || clusterSmoke || envBool("CAS_PBS_LIVE_REQUIRED");
const writeSmoke = (cutover && !readOnlyException) || envBool("CAS_PBS_LIVE_WRITE_SMOKE");
const requireRuntimeReady = envBool("CAS_PBS_LIVE_REQUIRE_RUNTIME_READY", true);
const requireCorpusReady = envBool("CAS_PBS_LIVE_REQUIRE_CORPUS_READY", true);

function record(status, id, detail) {
  checks.push({ status, id, detail });
  console.log(`[${status}] ${id}: ${detail}`);
}

function pass(id, detail) {
  record("PASS", id, detail);
}

function skip(id, detail) {
  record("SKIP", id, detail);
}

function fail(id, detail) {
  record("FAIL", id, detail);
}

function expect(id, condition, passDetail, failDetail = passDetail) {
  if (condition) pass(id, passDetail);
  else fail(id, failDetail);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseLastJsonLine(stdout) {
  for (const line of String(stdout ?? "").split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    const parsed = parseJson(trimmed);
    if (parsed) return parsed;
  }
  return undefined;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: options.timeoutMs ?? 60000,
    windowsHide: true,
    env: options.env ?? process.env
  });
}

function getJson(id, args, { required = true, timeoutMs = 30000 } = {}) {
  const result = run("oc", [...args, "-o", "json"], { timeoutMs });
  if (result.status !== 0) {
    if (required) fail(id, result.stderr || result.stdout || "oc command failed");
    else skip(id, result.stderr || result.stdout || "oc command failed");
    return undefined;
  }
  const parsed = parseJson(result.stdout);
  if (!parsed) {
    if (required) fail(id, "could not parse oc JSON output");
    else skip(id, "could not parse oc JSON output");
  }
  return parsed;
}

function deploymentReady(deployment) {
  const desired = Number(deployment?.spec?.replicas ?? 1);
  return (
    Number(deployment?.status?.observedGeneration ?? 0) >= Number(deployment?.metadata?.generation ?? 0) &&
    Number(deployment?.status?.updatedReplicas ?? 0) >= desired &&
    Number(deployment?.status?.availableReplicas ?? 0) >= desired &&
    Number(deployment?.status?.unavailableReplicas ?? 0) === 0
  );
}

function podReady(pod) {
  return (
    pod?.status?.phase === "Running" &&
    !pod?.metadata?.deletionTimestamp &&
    pod?.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True") &&
    pod?.status?.containerStatuses?.every((container) => container.ready && container.state?.running)
  );
}

function containerByName(workload, name) {
  const containers = workload?.spec?.template?.spec?.containers ?? [];
  return containers.find((container) => container.name === name) ?? containers[0] ?? {};
}

function envValue(workload, name, containerName) {
  return (containerByName(workload, containerName).env ?? []).find((entry) => entry.name === name)?.value ?? "";
}

function envSecretRef(workload, name, secretName, key, containerName) {
  const ref = (containerByName(workload, containerName).env ?? []).find((entry) => entry.name === name)?.valueFrom?.secretKeyRef;
  return ref?.name === secretName && ref?.key === key && ref?.optional !== true;
}

function envConfigRef(workload, name, configName, key, containerName) {
  const ref = (containerByName(workload, containerName).env ?? []).find((entry) => entry.name === name)?.valueFrom?.configMapKeyRef;
  return ref?.name === configName && ref?.key === key;
}

function execNode(podName, code, timeoutMs = 60000) {
  return run("oc", ["exec", "-n", namespace, podName, "--", "node", "-e", code], { timeoutMs });
}

function findPython() {
  const python = run("python", ["--version"], { timeoutMs: 10000 });
  if (python.status === 0) return { command: "python", argsPrefix: [] };
  const py = run("py", ["-3", "--version"], { timeoutMs: 10000 });
  if (py.status === 0) return { command: "py", argsPrefix: ["-3"] };
  throw new Error("Python 3 executable not found");
}

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(options.headers ?? {})
      },
      signal: controller.signal
    });
    const body = await response.json();
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForJson(url, predicate, timeoutMs = 30000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await fetchJson(url, {}, 5000);
      if (predicate(result)) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw lastError ?? new Error(`timeout waiting for ${url}`);
}

function pbsTraceOk(body) {
  const trace = body?.pbs;
  return trace?.ok === true && Number(trace?.status ?? 0) >= 200 && Number(trace?.status ?? 0) < 300;
}

function casLiveOk(result) {
  return result.response.status >= 200 && result.response.status < 300 && result.body?.status !== "error" && pbsTraceOk(result.body);
}

function hasFailedStage(body) {
  return Array.isArray(body?.stages) && body.stages.some((stage) => String(stage?.status ?? "").toLowerCase() === "failed");
}

function spawnChild(command, args, env) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(child);
  return child;
}

async function stopChildren() {
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolveStop) => {
          if (child.exitCode !== null || child.killed) {
            resolveStop();
            return;
          }
          child.once("exit", resolveStop);
          child.kill();
          setTimeout(() => {
            if (child.exitCode === null) child.kill("SIGKILL");
            resolveStop();
          }, 1000).unref();
        })
    )
  );
}

function writeEvidence(status) {
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/cas-pbs-live-smoke.json",
    JSON.stringify(
      {
        checkedAt,
        branch: run("git", ["branch", "--show-current"]).stdout.trim(),
        head: run("git", ["rev-parse", "--short", "HEAD"]).stdout.trim(),
        status,
        pbsBaseUrl: pbsBaseUrl ? "<configured>" : "",
        namespace,
        cutover,
        clusterSmoke,
        readOnlyException,
        writeSmoke,
        requireRuntimeReady,
        requireCorpusReady,
        summary: {
          total: checks.length,
          passed: checks.filter((check) => check.status === "PASS").length,
          skipped: checks.filter((check) => check.status === "SKIP").length,
          failed: checks.filter((check) => check.status === "FAIL").length
        },
        checks
      },
      null,
      2
    )
  );
  console.log("Evidence: test-results/cas-pbs-live-smoke.json");
}

async function runClusterSmoke() {
  const engineDeployment = getJson("pbs-live:cluster-engine-deployment", [
    "get",
    "deployment",
    "-n",
    namespace,
    "cas-knowledge-engine"
  ]);
  const gatewayDeployment = getJson("pbs-live:cluster-gateway-deployment", ["get", "deployment", "-n", namespace, "cas-gateway"]);
  const consoleDeployment = getJson("pbs-live:cluster-console-deployment", [
    "get",
    "deployment",
    "-n",
    namespace,
    "cas-console-plugin"
  ]);
  if (engineDeployment) {
    const engineContainer = containerByName(engineDeployment, "knowledge-engine");
    expect(
      "pbs-live:cluster-engine-contract",
      deploymentReady(engineDeployment) &&
        String(engineContainer.image ?? "").endsWith(":v0.1.4") &&
        envValue(engineDeployment, "CAS_KNOWLEDGE_PROVIDER", "knowledge-engine") === "pbs-http-live" &&
        envValue(engineDeployment, "CAS_KNOWLEDGE_REQUIRE_OWNER_HEADER", "knowledge-engine") === "true" &&
        envConfigRef(engineDeployment, "CAS_PBS_AUTH_MODE", "cas-pbs-config", "auth-mode", "knowledge-engine") &&
        envSecretRef(engineDeployment, "CAS_PBS_BEARER_TOKEN", "cas-pbs-auth", "bearer-token", "knowledge-engine") &&
        envSecretRef(engineDeployment, "DATABASE_URL", "cas-knowledge-postgres-live", "database-url", "knowledge-engine"),
      "applied knowledge engine is pbs-live, rolled out, v0.1.4, owner-required, PBS-authenticated, and wired to live Postgres Secret",
      JSON.stringify({
        image: engineContainer.image,
        provider: envValue(engineDeployment, "CAS_KNOWLEDGE_PROVIDER", "knowledge-engine"),
        readyReplicas: engineDeployment.status?.readyReplicas,
        availableReplicas: engineDeployment.status?.availableReplicas
      })
    );
  }
  if (gatewayDeployment) {
    const gatewayContainer = containerByName(gatewayDeployment, "gateway");
    expect(
      "pbs-live:cluster-gateway-contract",
      deploymentReady(gatewayDeployment) &&
        String(gatewayContainer.image ?? "").endsWith(":v0.1.4") &&
        envValue(gatewayDeployment, "CAS_KNOWLEDGE_ENGINE_URL", "gateway").includes("cas-knowledge-engine") &&
        envValue(gatewayDeployment, "CAS_KNOWLEDGE_OWNER_IDENTITY_MODE", "gateway") === "openshift-selfsubjectreview",
      "applied gateway is rolled out as v0.1.4, verifies users with SelfSubjectReview, and routes knowledge traffic to cas-knowledge-engine",
      JSON.stringify({
        image: gatewayContainer.image,
        knowledgeUrl: envValue(gatewayDeployment, "CAS_KNOWLEDGE_ENGINE_URL", "gateway"),
        readyReplicas: gatewayDeployment.status?.readyReplicas,
        availableReplicas: gatewayDeployment.status?.availableReplicas
      })
    );
  }
  if (consoleDeployment) {
    const consoleContainer = containerByName(consoleDeployment, "console-plugin");
    expect(
      "pbs-live:cluster-console-contract",
      deploymentReady(consoleDeployment) && String(consoleContainer.image ?? "").endsWith(":v0.1.4"),
      "applied console plugin is rolled out as v0.1.4",
      JSON.stringify({
        image: consoleContainer.image,
        readyReplicas: consoleDeployment.status?.readyReplicas,
        availableReplicas: consoleDeployment.status?.availableReplicas
      })
    );
  }

  const pbsEgress = getJson("pbs-live:cluster-pbs-egress-policy", [
    "get",
    "networkpolicy",
    "-n",
    namespace,
    "cas-knowledge-engine-pbs-egress"
  ]);
  if (pbsEgress) {
    const policy = JSON.stringify(pbsEgress.spec ?? {});
    expect(
      "pbs-live:cluster-pbs-egress-scoped",
      policy.includes("playbookstudio") && policy.includes("runtime") && policy.includes("8765") && !policy.includes('"podSelector":{}'),
      "applied PBS egress policy is scoped to labeled playbookstudio runtime pods on 8765",
      policy
    );
  }

  const pods = getJson("pbs-live:cluster-pods", ["get", "pods", "-n", namespace, "-l", "app.kubernetes.io/name=cywell-ai-sentinel"]);
  const gatewayPod = pods?.items?.find((pod) => pod.metadata?.name?.startsWith("cas-gateway-") && podReady(pod));
  const consolePod = pods?.items?.find((pod) => pod.metadata?.name?.startsWith("cas-console-plugin-") && podReady(pod));
  expect("pbs-live:cluster-gateway-pod", Boolean(gatewayPod), "ready gateway pod exists for in-cluster cutover smoke");
  expect("pbs-live:cluster-console-pod", Boolean(consolePod), "ready console-plugin pod exists for direct-access isolation check");
  if (checks.some((check) => check.status === "FAIL")) {
    skip(
      "pbs-live:cluster-mutation-smoke",
      "applied pbs-live prerequisites failed; skipping gateway mutation smoke to avoid writing through the wrong runtime"
    );
    return;
  }
  if (!gatewayPod) return;

  const whoamiToken = run("oc", ["whoami", "-t"], { timeoutMs: 10000 });
  const smokeToken = whoamiToken.status === 0 ? String(whoamiToken.stdout ?? "").trim() : "";
  expect(
    "pbs-live:cluster-user-token",
    Boolean(smokeToken),
    "current oc user token is available for SelfSubjectReview-backed gateway cutover smoke",
    whoamiToken.stderr || whoamiToken.stdout || "oc whoami -t failed"
  );
  if (!smokeToken) return;
  const smokeCode = [
    "const https=require('https');",
    "const http=require('http');",
    `const smokeToken=${JSON.stringify(smokeToken)};`,
    "const customerId='pbs-live-cluster-smoke';",
    "const lineageToken=`pbs-live-cluster-lineage-${Date.now()}`;",
    "const fileName=`cas-pbs-live-cluster-${lineageToken}.txt`; ",
    "const writeSmoke=" + JSON.stringify(writeSmoke) + ";",
    "const readOnlyException=" + JSON.stringify(readOnlyException) + ";",
    "function parse(body){try{return JSON.parse(body||'{}')}catch{return {parse_error:body}}}",
    "function req(path,method='GET',body,auth=true,extraHeaders={}){return new Promise((resolve,reject)=>{const payload=body?JSON.stringify(body):undefined;const headers={'content-type':'application/json','content-length':payload?Buffer.byteLength(payload):0,...extraHeaders};if(auth)headers.authorization=`Bearer ${smokeToken}`;const r=https.request(`https://127.0.0.1:9443${path}`,{method,rejectUnauthorized:false,headers},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:parse(b)}));});r.on('error',reject);if(payload)r.write(payload);r.end();});}",
    "function engineReq(path){return new Promise((resolve,reject)=>{const r=http.request(`http://cas-knowledge-engine.cywell-ai-sentinel.svc.cluster.local:8080${path}`,{method:'GET',timeout:5000},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:parse(b)}));});r.on('timeout',()=>{r.destroy(new Error('knowledge engine direct health timed out'))});r.on('error',reject);r.end();});}",
    "function traceOk(body){return body?.pbs?.ok===true&&Number(body?.pbs?.status||0)>=200&&Number(body?.pbs?.status||0)<300}",
    "function casOk(result){return result.status>=200&&result.status<300&&result.body?.status!=='error'&&traceOk(result.body)}",
    "(async()=>{",
    "const health=await req('/api/knowledge/healthz');",
    "const healthOk=health.status===200&&health.body?.provider==='pbs-http-live'&&health.body?.status==='ok'&&Array.isArray(health.body?.capabilities)&&health.body?.storage===undefined&&health.body?.counts===undefined&&health.body?.provider_config===undefined&&health.body?.engine?.endpoint===undefined;",
    "const engineHealth=await engineReq('/api/knowledge/healthz');",
    "const readiness=engineHealth.body?.provider_config?.pbs_http?.readiness||{};",
    "const runtimeReady=readiness.database_runtime===true&&readiness.db_ready===true&&readiness.pgvector_ready===true;",
    "const embeddingReady=Number(readiness.schema_embedding_dim||0)>0&&Number(readiness.stale_embedding_index_entries||0)===0&&Number(readiness.missing_embedding_index_entries||0)===0;",
    "const readyScopes=Array.isArray(readiness.ready_scopes)?readiness.ready_scopes:[];",
    "const corpusReady=readiness.db_corpus_ready===true&&readiness.embedding_index_parity===true&&readiness.compiled_wiki_ready===true&&readyScopes.includes('official_docs')&&readyScopes.includes('study_docs');",
    "const noOwner=await req('/api/knowledge/rag/query','POST',{customer_id:customerId,question:'owner required'},false);",
    "const spoofRemote=await req('/api/knowledge/rag/query','POST',{customer_id:customerId,question:'owner required'},false,{'x-remote-user':'spoofed-pbs-live-cluster'});",
    "const spoofOpenShift=await req('/api/knowledge/rag/query','POST',{customer_id:customerId,question:'owner required'},false,{'x-openshift-user':'spoofed-pbs-live-cluster'});",
    "const ownerEnforced=noOwner.status===401&&spoofRemote.status===401&&spoofOpenShift.status===401;",
    "const wikiStatus=await req(`/api/knowledge/wiki-loop/status?customer_id=${customerId}`);",
    "const topology=await req(`/api/knowledge/topology?customer_id=${customerId}`);",
    "const initialNodes=Array.isArray(topology.body?.nodes)?topology.body.nodes:[];",
    "const initialEdges=Array.isArray(topology.body?.edges)?topology.body.edges:[];",
    "const initialIds=new Set(initialNodes.map(n=>String(n.id||'')).filter(Boolean));",
    "const initialGraphOk=initialEdges.every(e=>initialIds.has(String(e.source||''))&&initialIds.has(String(e.target||'')));",
    "const result={healthOk,runtimeReady,embeddingReady,corpusReady,ownerEnforced,wikiStatusOk:casOk(wikiStatus),topologyOk:casOk(topology),initialNodes:initialNodes.length,initialEdges:initialEdges.length,initialGraphOk,noOwnerStatus:noOwner.status,spoofRemoteStatus:spoofRemote.status,spoofOpenShiftStatus:spoofOpenShift.status};",
    "if(!writeSmoke){result.writeSkipped=true;result.readOnlyTopologyReady=readOnlyException?initialNodes.length>0&&initialGraphOk:true;console.log(JSON.stringify(result));return;}",
    "const upload=await req('/api/knowledge/uploads/ingest','POST',{customer_id:customerId,file_name:fileName,filename:fileName,content:`${lineageToken} router latency evidence from cluster cutover smoke.`,source_scope:'user_upload',visibility:'private_user',source_kind:'upload',source_metadata:{customer_id:customerId,verifier:'cas-pbs-live-cluster-smoke',lineage_token:lineageToken},index:true,force_reingest:false});",
    "const uploadedDocumentId=upload.body?.document?.id||upload.body?.document?.document_source_id||upload.body?.document_source_id;",
    "const rag=await req('/api/knowledge/rag/query','POST',{customer_id:customerId,question:`${lineageToken} router latency evidence`});",
    "const citations=Array.isArray(rag.body?.citations)?rag.body.citations:[];",
    "const ragLineageOk=Boolean(uploadedDocumentId)&&citations.some(c=>c.document_id===uploadedDocumentId||c.document_source_id===uploadedDocumentId||c.title===upload.body?.document?.title||String(c.snippet||'').includes(lineageToken)||String(rag.body?.answer||'').includes(lineageToken));",
    "const wiki=await req('/api/knowledge/wiki-loop/run','POST',{customer_id:customerId,document_id:uploadedDocumentId});",
    "const vault=await req(`/api/knowledge/wiki-vault?customer_id=${customerId}`);",
    "const notes=Array.isArray(vault.body?.notes)?vault.body.notes:[];",
    "const lineageNote=notes.find(n=>n.document_id===uploadedDocumentId||n.source_document_id===uploadedDocumentId||n.provenance?.source_document_id===uploadedDocumentId||String(n.body||'').includes(lineageToken));",
    "const postTopology=await req(`/api/knowledge/topology?customer_id=${customerId}`);",
    "const nodes=Array.isArray(postTopology.body?.nodes)?postTopology.body.nodes:[];",
    "const edges=Array.isArray(postTopology.body?.edges)?postTopology.body.edges:[];",
    "const docNode=nodes.find(n=>n.id===uploadedDocumentId||n.document_source_id===uploadedDocumentId||n.source_document_id===uploadedDocumentId);",
    "const noteNode=nodes.find(n=>String(n.type||'').includes('wiki')&&(n.id===lineageNote?.id||n.document_id===uploadedDocumentId||n.source_document_id===uploadedDocumentId||n.provenance?.source_document_id===uploadedDocumentId));",
    "const topologyLineageOk=Boolean(docNode&&noteNode)&&edges.some(e=>(e.source===noteNode.id&&e.target===docNode.id)||(e.source===docNode.id&&e.target===noteNode.id)||e.source_document_id===uploadedDocumentId||e.provenance?.source_document_id===uploadedDocumentId);",
    "Object.assign(result,{lineageToken,fileName,uploadedDocumentId,uploadOk:casOk(upload)&&upload.body?.status==='indexed',ragOk:casOk(rag)&&rag.body?.trace?.retriever==='pbs-http',ragLineageOk,wikiOk:casOk(wiki)&&!String(wiki.body?.status||'').toLowerCase().includes('error'),vaultOk:casOk(vault),wikiLineageOk:Boolean(lineageNote),postTopologyOk:casOk(postTopology),postNodes:nodes.length,postEdges:edges.length,topologyLineageOk});",
    "console.log(JSON.stringify(result));",
    "})().catch(e=>{console.error(e.stack||e.message);process.exit(1);});"
  ].join("");
  const smoke = execNode(gatewayPod.metadata.name, smokeCode, 120000);
  const smokeBody = parseLastJsonLine(smoke.stdout);
  expect(
    "pbs-live:cluster-gateway-health",
    smoke.status === 0 && smokeBody?.healthOk === true,
    "gateway pod reaches applied pbs-live knowledge health with Postgres storage",
    smoke.stderr || smoke.stdout
  );
  expect(
    "pbs-live:cluster-readiness",
    smoke.status === 0 &&
      (!requireRuntimeReady || (smokeBody?.runtimeReady === true && smokeBody?.embeddingReady === true)) &&
      (!requireCorpusReady || smokeBody?.corpusReady === true),
    "applied pbs-live reports runtime, embedding, corpus, and compiled wiki readiness",
    JSON.stringify(smokeBody ?? { stdout: smoke.stdout, stderr: smoke.stderr })
  );
  expect(
    "pbs-live:cluster-owner-enforcement",
    smoke.status === 0 && smokeBody?.ownerEnforced === true,
    "gateway rejects no-owner and spoofed owner headers in applied pbs-live path",
    JSON.stringify(smokeBody ?? { stdout: smoke.stdout, stderr: smoke.stderr })
  );
  expect(
    "pbs-live:cluster-read-routes",
    smoke.status === 0 &&
      smokeBody?.wikiStatusOk === true &&
      smokeBody?.topologyOk === true &&
      smokeBody?.initialGraphOk === true &&
      (!readOnlyException || smokeBody?.readOnlyTopologyReady === true),
    "gateway pod can read wiki status and normalized topology from applied pbs-live",
    JSON.stringify(smokeBody ?? { stdout: smoke.stdout, stderr: smoke.stderr })
  );
  if (!writeSmoke) {
    if (cutover && !readOnlyException) {
      fail("pbs-live:cluster-write-smoke-required", "cluster cutover smoke requires write smoke unless CAS_PBS_LIVE_READ_ONLY_EXCEPTION=true");
    } else {
      skip("pbs-live:cluster-write-smoke", "CAS_PBS_LIVE_WRITE_SMOKE is not true; cluster upload/RAG/wiki write smoke skipped");
    }
  } else {
    expect(
      "pbs-live:cluster-write-lineage",
      smoke.status === 0 &&
        smokeBody?.uploadOk === true &&
        smokeBody?.ragOk === true &&
        smokeBody?.ragLineageOk === true &&
        smokeBody?.wikiOk === true &&
        smokeBody?.vaultOk === true &&
        smokeBody?.wikiLineageOk === true &&
        smokeBody?.postTopologyOk === true &&
        smokeBody?.topologyLineageOk === true,
      "applied pbs-live preserves upload -> RAG -> wiki vault -> topology lineage through gateway pod",
      JSON.stringify(smokeBody ?? { stdout: smoke.stdout, stderr: smoke.stderr })
    );
  }

  if (consolePod) {
    const directCheck = execNode(
      consolePod.metadata.name,
      [
        "const http=require('http');",
        "const req=http.request('http://cas-knowledge-engine.cywell-ai-sentinel.svc.cluster.local:8080/api/knowledge/healthz',{method:'GET',timeout:2500},res=>{res.resume();res.on('end',()=>{console.log(JSON.stringify({status:res.statusCode}));});});",
        "req.on('timeout',()=>{console.log(JSON.stringify({blocked:'timeout'}));req.destroy();});",
        "req.on('error',e=>{console.log(JSON.stringify({blocked:'error',code:e.code||e.message}));});",
        "req.end();",
        "setTimeout(()=>process.exit(0),3500);"
      ].join(""),
      8000
    );
    const directBody = parseLastJsonLine(directCheck.stdout);
    expect(
      "pbs-live:cluster-direct-engine-blocked",
      directCheck.status === 0 && directBody?.status !== 200,
      "console-plugin pod cannot directly reach knowledge-engine; gateway is the in-cluster ingress path",
      directCheck.stderr || directCheck.stdout
    );
  }
}

if (clusterSmoke) {
  try {
    await runClusterSmoke();
  } catch (error) {
    fail("pbs-live:cluster-smoke", error instanceof Error ? error.message : "unknown cluster PBS live smoke failure");
  }
  const failures = checks.filter((check) => check.status === "FAIL");
  const finalStatus = failures.length > 0 ? "FAIL" : checks.every((check) => check.status === "SKIP") ? "SKIP" : "PASS";
  writeEvidence(finalStatus);
  if (failures.length > 0) process.exitCode = 1;
  process.exit();
}

if (!pbsBaseUrl) {
  if (requireLive) {
    fail("pbs-live:base-url", "CAS_PBS_BASE_URL is required when live or cutover smoke is required");
    writeEvidence("FAIL");
    process.exitCode = 1;
  } else {
    skip("pbs-live:base-url", "CAS_PBS_BASE_URL is not set; real PBS live smoke skipped");
    writeEvidence("SKIP");
  }
  process.exit();
}

const python = findPython();
const pythonPath = [resolve("apps/knowledge-engine/src"), process.env.PYTHONPATH].filter(Boolean).join(delimiter);
const dataDir = await mkdtemp(resolve(tmpdir(), "cas-pbs-live-"));
const port = Number(process.env.CAS_PBS_LIVE_SMOKE_PORT ?? 18086);
const gatewayPort = Number(process.env.CAS_PBS_LIVE_SMOKE_GATEWAY_PORT ?? port + 1);
try {
  const engineEnv = {
    ...process.env,
    PYTHONPATH: pythonPath,
    HOST: "127.0.0.1",
    PORT: String(port),
    CAS_KNOWLEDGE_DATA_DIR: dataDir,
    CAS_KNOWLEDGE_PROVIDER: "pbs-http-live",
    CAS_KNOWLEDGE_OWNER_MODE: "trusted-header",
    CAS_KNOWLEDGE_REQUIRE_OWNER_HEADER: "true",
    CAS_KNOWLEDGE_SINGLE_OWNER: "pbs-live-smoke-owner",
    CAS_PBS_REQUIRE_RUNTIME_READY: String(requireRuntimeReady),
    CAS_PBS_BASE_URL: pbsBaseUrl
  };
  spawnChild(python.command, [...python.argsPrefix, "-m", "cas_knowledge_engine.app"], engineEnv);
  const base = `http://127.0.0.1:${port}`;
  const health = await waitForJson(`${base}/api/knowledge/healthz`, ({ response, body }) => {
    return response.status >= 200 && response.status < 600 && body.provider === "pbs-http-live" && body.provider_config?.pbs_http?.ok === true;
  });
  expect("pbs-live:health", health.response.status === 200 && health.body.status === "ok", "CAS pbs-http-live health reaches real PBS backend", JSON.stringify(health.body));
  const pbsHttp = health.body.provider_config?.pbs_http ?? {};
  const readiness = pbsHttp.readiness ?? {};
  expect(
    "pbs-live:health-readiness-schema",
    readiness.pbs_health_ok === true,
    "CAS health exposes PBS /api/health readiness summary",
    JSON.stringify(health.body.provider_config?.pbs_http ?? {})
  );
  if (requireRuntimeReady) {
    expect(
      "pbs-live:runtime-db-ready",
      readiness.database_runtime === true && readiness.db_ready === true && readiness.pgvector_ready === true,
      "PBS runtime database and pgvector are ready",
      JSON.stringify(readiness)
    );
    expect(
      "pbs-live:embedding-schema-ready",
      Number(readiness.schema_embedding_dim || 0) > 0 &&
        Number(readiness.stale_embedding_index_entries || 0) === 0 &&
        Number(readiness.missing_embedding_index_entries || 0) === 0,
      "PBS embedding schema exists and has no missing/stale entries",
      JSON.stringify(readiness)
    );
  } else {
    skip("pbs-live:runtime-db-ready", "CAS_PBS_LIVE_REQUIRE_RUNTIME_READY is false; DB/vector readiness check skipped");
  }
  if (requireCorpusReady) {
    const readyScopes = Array.isArray(readiness.ready_scopes) ? readiness.ready_scopes : [];
    expect(
      "pbs-live:corpus-ready",
      readiness.db_corpus_ready === true &&
        readiness.embedding_index_parity === true &&
        readiness.compiled_wiki_ready === true &&
        readyScopes.includes("official_docs") &&
        readyScopes.includes("study_docs"),
      "PBS corpus and compiled wiki are ready with embedding parity for official_docs and study_docs",
      JSON.stringify(readiness)
    );
  } else {
    skip("pbs-live:corpus-ready", "CAS_PBS_LIVE_REQUIRE_CORPUS_READY is false; corpus readiness check skipped");
  }

  const gatewayEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(gatewayPort),
    CAS_BRAIN_PROVIDER: "mock",
    CAS_EVIDENCE_PROVIDER: "none",
    CAS_KNOWLEDGE_OWNER_IDENTITY_MODE: "token-hash",
    CAS_KNOWLEDGE_ENGINE_URL: base,
    CAS_KNOWLEDGE_ENGINE_TIMEOUT_MS: "10000"
  };
  spawnChild("node", ["apps/gateway/src/server.mjs"], gatewayEnv);
  const gatewayBase = `http://127.0.0.1:${gatewayPort}`;
  const gatewayHealth = await waitForJson(`${gatewayBase}/api/knowledge/healthz`, ({ response, body }) => {
    return response.status === 200 && body.service === "cas-knowledge-engine" && body.provider === "pbs-http-live";
  });
  expect(
    "pbs-live:gateway-health",
    gatewayHealth.body.status === "ok" &&
      Array.isArray(gatewayHealth.body.capabilities) &&
      gatewayHealth.body.storage === undefined &&
      gatewayHealth.body.counts === undefined &&
      gatewayHealth.body.provider_config === undefined &&
      gatewayHealth.body.engine?.endpoint === undefined,
    "gateway exposes sanitized pbs-http-live public health in local live smoke",
    JSON.stringify(gatewayHealth.body)
  );
  const gatewayNoOwner = await fetchJson(`${gatewayBase}/api/knowledge/rag/query`, {
    method: "POST",
    body: JSON.stringify({ customer_id: "pbs-live-smoke", question: "owner required" })
  });
  const gatewaySpoofRemote = await fetchJson(`${gatewayBase}/api/knowledge/rag/query`, {
    method: "POST",
    headers: { "x-remote-user": "spoofed-pbs-live-owner" },
    body: JSON.stringify({ customer_id: "pbs-live-smoke", question: "owner required" })
  });
  const gatewaySpoofOpenShift = await fetchJson(`${gatewayBase}/api/knowledge/rag/query`, {
    method: "POST",
    headers: { "x-openshift-user": "spoofed-pbs-live-owner" },
    body: JSON.stringify({ customer_id: "pbs-live-smoke", question: "owner required" })
  });
  expect(
    "pbs-live:gateway-owner-enforcement",
    gatewayNoOwner.response.status === 401 &&
      gatewayNoOwner.body.code === "knowledge-owner-unverified" &&
      gatewaySpoofRemote.response.status === 401 &&
      gatewaySpoofRemote.body.code === "knowledge-owner-unverified" &&
      gatewaySpoofOpenShift.response.status === 401 &&
      gatewaySpoofOpenShift.body.code === "knowledge-owner-unverified",
    "gateway rejects no-owner and spoofed owner headers before local pbs-live smoke",
    JSON.stringify({ noOwner: gatewayNoOwner.body, remote: gatewaySpoofRemote.body, openshift: gatewaySpoofOpenShift.body })
  );

  const headers = { authorization: "Bearer pbs-live-smoke-owner" };
  const wikiStatus = await fetchJson(`${gatewayBase}/api/knowledge/wiki-loop/status?customer_id=pbs-live-smoke`, { headers });
  expect(
    "pbs-live:wiki-status",
    casLiveOk(wikiStatus) && wikiStatus.body.provider === "pbs-http-live",
    "CAS pbs-http-live exposes PBS wiki-loop status",
    JSON.stringify(wikiStatus.body)
  );
  const topology = await fetchJson(`${gatewayBase}/api/knowledge/topology?customer_id=pbs-live-smoke`, { headers });
  const topologyNodes = Array.isArray(topology.body?.nodes) ? topology.body.nodes : [];
  const topologyEdges = Array.isArray(topology.body?.edges) ? topology.body.edges : [];
  const topologyNodeIds = new Set(topologyNodes.map((node) => String(node?.id ?? "")));
  const topologyGraphOk = topologyEdges.every((edge) => topologyNodeIds.has(String(edge?.source ?? "")) && topologyNodeIds.has(String(edge?.target ?? "")));
  expect(
    "pbs-live:topology",
    casLiveOk(topology) && topology.body.provider === "pbs-http-live" && Array.isArray(topology.body.nodes),
    "CAS pbs-http-live normalizes PBS Wiki Vault graph",
    JSON.stringify(topology.body)
  );
  if (cutover) {
    expect(
      "pbs-live:cutover-topology-ready",
      topologyNodes.length > 0 && topologyGraphOk,
      "PBS cutover topology returns non-empty graph data with valid edge endpoints",
      JSON.stringify(topology.body)
    );
  }

  if (!writeSmoke) {
    if (cutover && !readOnlyException) {
      fail("pbs-live:write-smoke-required", "cutover smoke requires write smoke unless CAS_PBS_LIVE_READ_ONLY_EXCEPTION=true");
    } else {
      skip("pbs-live:write-smoke", "CAS_PBS_LIVE_WRITE_SMOKE is not true; upload/RAG/wiki write smoke skipped");
    }
  } else {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
    const lineageToken = `cas-pbs-live-lineage-${stamp}`;
    const upload = await fetchJson(`${gatewayBase}/api/knowledge/uploads/ingest`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        customer_id: "pbs-live-smoke",
        file_name: `cas-pbs-live-smoke-${stamp}.txt`,
        content: `CAS PBS live smoke ${stamp}: ${lineageToken} router latency evidence for RAG and wiki-loop verification.`,
        source_scope: "user_upload",
        visibility: "private_user",
        source_kind: "upload",
        source_metadata: { customer_id: "pbs-live-smoke", verifier: "cas-pbs-live-smoke", lineage_token: lineageToken },
        index: true,
        force_reingest: false
      })
    });
    expect(
      "pbs-live:upload",
      casLiveOk(upload) && upload.body.provider === "pbs-http-live" && upload.body.status === "indexed" && upload.body.document?.id,
      "CAS pbs-http-live upload write smoke succeeds",
      JSON.stringify(upload.body)
    );
    const uploadedDocumentId = upload.body.document?.id || upload.body.document?.document_source_id || upload.body.document_source_id;
    const rag = await fetchJson(`${gatewayBase}/api/knowledge/rag/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        customer_id: "pbs-live-smoke",
        question: `${lineageToken} router latency evidence`
      })
    });
    const ragCitations = Array.isArray(rag.body.citations) ? rag.body.citations : [];
    expect(
      "pbs-live:rag",
      casLiveOk(rag) &&
        rag.body.provider === "pbs-http-live" &&
        typeof rag.body.answer === "string" &&
        rag.body.answer.trim().length > 0 &&
        rag.body.trace?.retriever === "pbs-http",
      "CAS pbs-http-live RAG smoke succeeds",
      JSON.stringify(rag.body)
    );
    expect(
      "pbs-live:rag-lineage",
      Boolean(uploadedDocumentId) &&
        ragCitations.some(
          (citation) =>
            citation.document_id === uploadedDocumentId ||
            citation.document_source_id === uploadedDocumentId ||
            citation.title === upload.body.document?.title ||
            String(citation.snippet ?? "").includes(lineageToken) ||
            String(rag.body.answer ?? "").includes(lineageToken)
        ),
      "CAS pbs-http-live RAG cites the document uploaded by this smoke run",
      JSON.stringify({ uploadedDocumentId, lineageToken, citations: ragCitations, answer: rag.body.answer })
    );
    const wiki = await fetchJson(`${gatewayBase}/api/knowledge/wiki-loop/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({ customer_id: "pbs-live-smoke", document_id: uploadedDocumentId })
    });
    expect(
      "pbs-live:wiki-loop",
      casLiveOk(wiki) &&
        wiki.body.provider === "pbs-http-live" &&
        !String(wiki.body.status ?? "").toLowerCase().includes("error") &&
        !hasFailedStage(wiki.body),
      "CAS pbs-http-live wiki-loop write smoke succeeds",
      JSON.stringify(wiki.body)
    );
    const vault = await fetchJson(`${gatewayBase}/api/knowledge/wiki-vault?customer_id=pbs-live-smoke`, { headers });
    const vaultNotes = Array.isArray(vault.body.notes) ? vault.body.notes : [];
    const lineageNote = vaultNotes.find(
      (note) =>
        note.document_id === uploadedDocumentId ||
        note.source_document_id === uploadedDocumentId ||
        note.provenance?.source_document_id === uploadedDocumentId ||
        String(note.body ?? "").includes(lineageToken)
    );
    expect(
      "pbs-live:wiki-lineage",
      casLiveOk(vault) && Boolean(lineageNote),
      "CAS pbs-http-live wiki vault exposes a note tied to the uploaded smoke document",
      JSON.stringify({ uploadedDocumentId, lineageToken, lineageNote, notes: vaultNotes.slice(0, 5) })
    );
    const postWriteTopology = await fetchJson(`${gatewayBase}/api/knowledge/topology?customer_id=pbs-live-smoke`, { headers });
    const postWriteNodes = Array.isArray(postWriteTopology.body.nodes) ? postWriteTopology.body.nodes : [];
    const postWriteEdges = Array.isArray(postWriteTopology.body.edges) ? postWriteTopology.body.edges : [];
    const postWriteDocNode = postWriteNodes.find(
      (node) => node.id === uploadedDocumentId || node.document_source_id === uploadedDocumentId || node.source_document_id === uploadedDocumentId
    );
    const postWriteNoteNode = postWriteNodes.find(
      (node) =>
        String(node.type ?? "").includes("wiki") &&
        (node.document_id === uploadedDocumentId ||
          node.source_document_id === uploadedDocumentId ||
          node.provenance?.source_document_id === uploadedDocumentId ||
          node.id === lineageNote?.id)
    );
    const postWriteLineageEdge = postWriteEdges.some(
      (edge) =>
        postWriteNoteNode &&
        postWriteDocNode &&
        ((edge.source === postWriteNoteNode.id && edge.target === postWriteDocNode.id) ||
          (edge.source === postWriteDocNode.id && edge.target === postWriteNoteNode.id) ||
          edge.source_document_id === uploadedDocumentId ||
          edge.provenance?.source_document_id === uploadedDocumentId)
    );
    expect(
      "pbs-live:topology-lineage",
      casLiveOk(postWriteTopology) && Boolean(postWriteDocNode) && Boolean(postWriteNoteNode) && postWriteLineageEdge,
      "CAS pbs-http-live topology links the uploaded document and its LLM Wiki note",
      JSON.stringify({ uploadedDocumentId, lineageToken, postWriteDocNode, postWriteNoteNode, postWriteEdges })
    );
  }
} catch (error) {
  fail("pbs-live:smoke", error instanceof Error ? error.message : "unknown PBS live smoke failure");
} finally {
  await stopChildren();
  await rm(dataDir, { recursive: true, force: true });
}

const failures = checks.filter((check) => check.status === "FAIL");
const finalStatus = failures.length > 0 ? "FAIL" : checks.every((check) => check.status === "SKIP") ? "SKIP" : "PASS";
writeEvidence(finalStatus);
if (failures.length > 0) process.exitCode = 1;
