#!/usr/bin/env node
import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";

const checks = [];
const children = [];
const verifyPbsBearerToken = "verify-pbs-token";

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

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: options.timeoutMs ?? 60000,
    windowsHide: true,
    env: options.env ?? process.env
  });
}

function findPython() {
  const python = run("python", ["--version"], { timeoutMs: 10000 });
  if (python.status === 0) return { command: "python", argsPrefix: [] };
  const py = run("py", ["-3", "--version"], { timeoutMs: 10000 });
  if (py.status === 0) return { command: "py", argsPrefix: ["-3"] };
  throw new Error("Python 3 executable not found");
}

async function fetchJson(url, options = {}, timeoutMs = 10000) {
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

async function waitForJson(url, predicate, timeoutMs = 15000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await fetchJson(url, {}, 3000);
      if (predicate(result)) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw lastError ?? new Error(`timeout waiting for ${url}`);
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

function pbsOwnerHash(owner) {
  return createHash("sha256").update(`header:X-User:${owner}`).digest("hex").slice(0, 32);
}

function ownerSignature(secret, owner) {
  return createHmac("sha256", secret).update(owner).digest("hex");
}

function signedOwnerHeaders(owner) {
  return {
    "x-forwarded-user": owner,
    "x-cas-owner-signature": ownerSignature(ownerHmacSecret, owner)
  };
}

function tokenOwner(token) {
  return `token-${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
}

function graphIntegrity(body) {
  const nodes = Array.isArray(body?.nodes) ? body.nodes : body?.topology && Array.isArray(body.topology.nodes) ? body.topology.nodes : [];
  const edges = Array.isArray(body?.edges) ? body.edges : body?.topology && Array.isArray(body.topology.edges) ? body.topology.edges : [];
  const ids = new Set(nodes.map((node) => String(node?.id ?? "")).filter(Boolean));
  return nodes.length >= 2 && edges.length >= 1 && edges.every((edge) => ids.has(String(edge?.source ?? "")) && ids.has(String(edge?.target ?? "")));
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendFakePbsJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function startFakePbsServer(port) {
  const records = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    const body = request.method === "GET" ? {} : await readRequestJson(request);
    records.push({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: request.headers,
      body
    });
    if (url.pathname.startsWith("/api/") && request.headers.authorization !== `Bearer ${verifyPbsBearerToken}`) {
      sendFakePbsJson(response, 401, { error: "missing or invalid PBS bearer token", code: "pbs-auth-required" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      const ready = request.headers["x-user"] !== "not-ready-owner";
      const staleIndex = request.headers["x-user"] === "stale-index-owner";
      const runtimeReady = ready;
      const corpusReady = ready && !staleIndex;
      sendFakePbsJson(response, 200, {
        ok: true,
        service: "fake-pbs",
        runtime: {
          database_runtime: runtimeReady,
          db_ready: runtimeReady,
          pgvector_ready: runtimeReady,
          embedding_model: "fake-embedding",
          embedding_dim: runtimeReady ? 768 : 0,
          schema_embedding_dim: runtimeReady ? 768 : 0,
          compiled_wiki_status: { ready: corpusReady, note_count: corpusReady ? 2 : 0 },
          db_corpus: {
            db_ready: runtimeReady,
            pgvector_ready: runtimeReady,
            ready: corpusReady,
            embedding_index_parity: corpusReady,
            missing_embedding_index_entries: corpusReady ? 0 : 1,
            stale_embedding_index_entries: corpusReady ? 0 : 1,
            schema_embedding_dimensions: runtimeReady ? 768 : 0,
            ready_scopes: corpusReady ? ["official_docs", "study_docs"] : []
          }
        }
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/uploads/ingest") {
      sendFakePbsJson(response, 200, {
        filename: body.file_name,
        document_source_id: "pbs-doc-1",
        chunk_count: 2,
        indexed_count: 2,
        owner_user_id: body.owner_user_id,
        ready_for_chat: true,
        stage_events: [{ stage: "fake", status: "done" }]
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/uploads/url-ingest") {
      sendFakePbsJson(response, 200, {
        schema_version: "url_ingestion_report_v1",
        import_id: "pbs-url-1",
        root_url: body.url,
        summary: { imported_url_count: 1, indexed_url_count: 1 },
        pages: [{ url: body.url, status: "imported", chunk_count: 1, indexed_count: 1 }],
        upload_results: [],
        wiki_loop: { status: "done" },
        stage_events: []
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/uploads/reports") {
      if (url.searchParams.get("customer_id") === "scope-leak") {
        sendFakePbsJson(response, 200, {
          items: [
            {
              document_source_id: "pbs-leaked-doc",
              filename: "leaked.txt",
              customer_id: "other-customer",
              owner_user_id: pbsOwnerHash("other-owner")
            }
          ]
        });
        return;
      }
      sendFakePbsJson(response, 200, {
        items: [{ document_source_id: "pbs-doc-1", filename: "fake-pbs.txt", owner_user_id: url.searchParams.get("user_id") }]
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/chat") {
      if (String(body.query ?? "").includes("force-pbs-error")) {
        sendFakePbsJson(response, 500, { error: "forced PBS chat failure", code: "forced-chat-failure" });
        return;
      }
      sendFakePbsJson(response, 200, {
        answer: `PBS answer for ${body.query}`,
        citations: [{ id: "pbs-citation-1", title: "PBS Citation", snippet: "PBS evidence" }],
        pipeline_trace: { retrieval_summary: { hit_count: 1 } },
        wiki_vault_context_attached: true
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/wiki-loop/run") {
      sendFakePbsJson(response, 201, {
        run_id: "wiki-loop-fake",
        status: "done",
        user_id: body.user_id,
        stages: [{ name: "wiki_compile", status: "done" }],
        summary: { compiled_note_count: 2 }
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/wiki-loop/status") {
      sendFakePbsJson(response, 200, {
        db_ready: true,
        vector_ready: true,
        compiled_wiki_ready: true,
        user_id: url.searchParams.get("user_id")
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/wiki-vault") {
      if (url.searchParams.get("customer_id") === "scope-leak") {
        sendFakePbsJson(response, 200, {
          user_id: pbsOwnerHash("other-owner"),
          customer_id: "other-customer",
          topology: {
            graph: {
              nodes: [
                {
                  node_id: "pbs-leaked-note",
                  kind: "wiki-note",
                  title: "PBS Leaked Note",
                  metadata: { customer_id: "other-customer" }
                }
              ],
              links: []
            }
          }
        });
        return;
      }
      if (url.searchParams.get("customer_id") === "orphan-live") {
        sendFakePbsJson(response, 200, {
          user_id: url.searchParams.get("user_id"),
          notes: [{ id: "pbs-orphan-note", title: "PBS Orphan Note", body: "PBS body", tags: ["orphan"], wikilinks: [] }],
          topology: {
            graph: {
              nodes: [{ node_id: "pbs-orphan-note", kind: "wiki-note", title: "PBS Orphan Note" }],
              links: [{ source_id: "pbs-orphan-note", target_id: "pbs-missing-endpoint", kind: "references" }]
            }
          },
          summary: { graph_relation_count: 1 }
        });
        return;
      }
      if (url.searchParams.get("customer_id") === "mixed-live") {
        sendFakePbsJson(response, 200, {
          user_id: url.searchParams.get("user_id"),
          relations: [{ source_id: "wrapper-noise-a", target_id: "wrapper-noise-b", kind: "should-not-render" }],
          topology: {
            graph: {
              nodes: [
                { node_id: "pbs-mixed-note", kind: "wiki-note", title: "PBS Mixed Note" },
                { node_id: "pbs-mixed-term", kind: "term", title: "mixed" }
              ],
              links: [{ source_id: "pbs-mixed-note", target_id: "pbs-mixed-term", kind: "tag" }]
            }
          },
          summary: { graph_relation_count: 1 }
        });
        return;
      }
      sendFakePbsJson(response, 200, {
        user_id: url.searchParams.get("user_id"),
        notes: [{ id: "pbs-note-1", title: "PBS Note", body: "PBS body", tags: ["router"], wikilinks: ["HAProxy"] }],
        topology: {
          graph: {
            nodes: [
              {
                node_id: "pbs-note-1",
                kind: "wiki-note",
                title: "PBS Note",
                degree: 9,
                weight: 0.92,
                viewer_path: "/wiki/pbs-note-1",
                note_type: "source",
                compiled_wiki: true,
                ready_for_chat: true,
                revision: 7,
                previous_revision: 6,
                provenance: { source_document_id: "pbs-doc-1", source: "pbs-wiki-loop" },
                metadata: { customer_id: url.searchParams.get("customer_id") }
              },
              {
                node_id: "pbs-doc-1",
                kind: "upload_document",
                title: "PBS Upload Document",
                degree: 3,
                source_kind: "upload",
                source_url: "cas://pbs/upload/pbs-doc-1",
                basic_index_ready: true,
                metadata: { source_document_id: "pbs-doc-1" }
              },
              {
                node_id: "pbs-link-haproxy",
                kind: "wikilink",
                title: "HAProxy",
                degree: 4,
                metadata: { source_document_id: "pbs-doc-1" }
              },
              {
                node_id: "pbs-tag-router",
                kind: "tag",
                title: "router",
                degree: 2,
                metadata: { source_document_id: "pbs-doc-1" }
              },
              {
                node_id: "pbs-entity-route-shard",
                kind: "entity",
                entity_kind: "openshift_resource",
                title: "route shard",
                degree: 5,
                metadata: { source_document_id: "pbs-doc-1" }
              },
              {
                node_id: "pbs-concept-latency",
                kind: "concept",
                title: "latency",
                degree: 4,
                metadata: { source_document_id: "pbs-doc-1" }
              }
            ],
            links: [
              {
                source_id: "pbs-note-1",
                target_id: "pbs-link-haproxy",
                kind: "links_to",
                provenance: { source_document_id: "pbs-doc-1" }
              },
              {
                source_id: "pbs-note-1",
                target_id: "pbs-tag-router",
                kind: "tagged",
                provenance: { source_document_id: "pbs-doc-1" }
              },
              {
                source_id: "pbs-entity-route-shard",
                target_id: "pbs-concept-latency",
                kind: "explains",
                provenance: { source_document_id: "pbs-doc-1" }
              }
            ]
          }
        },
        summary: {
          document_node_count: 1,
          upload_node_count: 1,
          note_count: 1,
          compiled_note_count: 1,
          wikilink_count: 1,
          tag_count: 1,
          entity_node_count: 1,
          concept_node_count: 1,
          graph_relation_count: 3
        },
        top_wikilinks: [{ label: "HAProxy", count: 1 }],
        top_tags: [{ label: "router", count: 1 }],
        selected_context: [{ title: "PBS Note", body: "PBS body" }],
        selected_uploads: [{ id: "pbs-doc-1", title: "PBS Upload Document" }]
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/wiki-vault/notes") {
      sendFakePbsJson(response, 201, {
        saved: true,
        overlay_id: "pbs-overlay-1",
        title: body.title,
        body: body.body,
        payload: { tags: ["router"], wikilinks: ["HAProxy"] }
      });
      return;
    }
    sendFakePbsJson(response, 404, { error: `missing fake route ${request.method} ${url.pathname}` });
  });
  return new Promise((resolveStart) => {
    server.listen(port, "127.0.0.1", () => {
      resolveStart({ server, records, url: `http://127.0.0.1:${port}` });
    });
  });
}

function startFakeOpenShiftIdentityServer(port) {
  const records = [];
  const users = new Map([
    ["Bearer verified-token-a", { username: "verified-user", uid: "uid-verified-user" }],
    ["Bearer verified-token-b", { username: "verified-user", uid: "uid-verified-user" }],
    ["Bearer verified-token-other", { username: "other-user", uid: "uid-other-user" }]
  ]);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    const body = request.method === "GET" ? {} : await readRequestJson(request);
    records.push({ method: request.method, path: url.pathname, headers: request.headers, body });
    if (request.method !== "POST" || url.pathname !== "/apis/authentication.k8s.io/v1/selfsubjectreviews") {
      sendFakePbsJson(response, 404, { message: `missing fake OpenShift route ${request.method} ${url.pathname}` });
      return;
    }
    if (body?.kind !== "SelfSubjectReview") {
      sendFakePbsJson(response, 400, { message: "expected SelfSubjectReview" });
      return;
    }
    const user = users.get(String(request.headers.authorization ?? ""));
    if (!user) {
      sendFakePbsJson(response, 401, { message: "Unauthorized" });
      return;
    }
    sendFakePbsJson(response, 201, {
      apiVersion: "authentication.k8s.io/v1",
      kind: "SelfSubjectReview",
      status: {
        userInfo: {
          username: user.username,
          uid: user.uid,
          groups: ["system:authenticated"]
        }
      }
    });
  });
  return new Promise((resolveStart) => {
    server.listen(port, "127.0.0.1", () => {
      resolveStart({ server, records, url: `http://127.0.0.1:${port}` });
    });
  });
}

function startFakeKnowledgeBoundaryServer(port) {
  const records = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    const body = request.method === "GET" ? {} : await readRequestJson(request);
    records.push({ method: request.method, path: url.pathname, headers: request.headers, body });
    if (request.method === "GET" && url.pathname === "/api/knowledge/healthz") {
      sendFakePbsJson(response, 200, {
        status: "ok",
        service: "cas-knowledge-engine",
        version: "0.1.4",
        provider: "fake-boundary",
        provider_config: {
          pbs_http: {
            error: "private PBS diagnostic detail"
          }
        },
        storage: {
          mode: "private-store",
          path: "F:\\private\\cas-knowledge"
        },
        counts: {
          documents: 99,
          chunks: 199,
          notes: 299
        },
        capabilities: [{ id: "fake-boundary-capability", label: "Fake boundary capability" }]
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/knowledge/capabilities") {
      sendFakePbsJson(response, 200, {
        status: "ok",
        capabilities: [{ id: "fake-boundary-capability", label: "Fake boundary capability" }]
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/knowledge/rag/query") {
      sendFakePbsJson(response, 200, {
        status: "ok",
        answer: "boundary answer",
        citations: []
      });
      return;
    }
    sendFakePbsJson(response, 404, { error: `missing fake knowledge route ${request.method} ${url.pathname}` });
  });
  return new Promise((resolveStart) => {
    server.listen(port, "127.0.0.1", () => {
      resolveStart({ server, records, url: `http://127.0.0.1:${port}` });
    });
  });
}

function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.unref();
    server.on("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
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

const python = findPython();
const pythonPath = [resolve("apps/knowledge-engine/src"), process.env.PYTHONPATH].filter(Boolean).join(delimiter);
const selftest = run(python.command, [...python.argsPrefix, "-m", "cas_knowledge_engine.selftest"], {
  env: {
    ...process.env,
    PYTHONPATH: pythonPath
  }
});
expect("knowledge:selftest", selftest.status === 0, "knowledge engine self-test passed", selftest.stderr || selftest.stdout);

const enginePort = await getFreePort();
const unsignedEnginePort = await getFreePort();
const gatewayPort = await getFreePort();
const verifiedGatewayPort = await getFreePort();
const fakeIdentityPort = await getFreePort();
const boundaryEnginePort = await getFreePort();
const boundaryGatewayPort = await getFreePort();
const unsignedBoundaryGatewayPort = await getFreePort();
const publicFailureGatewayPort = await getFreePort();
const deadKnowledgeEnginePort = await getFreePort();
const verifierFailureGatewayPort = await getFreePort();
const deadIdentityPort = await getFreePort();
const fakePbsPort = await getFreePort();
const shadowPort = await getFreePort();
const livePort = await getFreePort();
const degradedLivePort = await getFreePort();
const staleIndexLivePort = await getFreePort();
const engineBase = `http://127.0.0.1:${enginePort}`;
const unsignedEngineBase = `http://127.0.0.1:${unsignedEnginePort}`;
const gatewayBase = `http://127.0.0.1:${gatewayPort}`;
const verifiedGatewayBase = `http://127.0.0.1:${verifiedGatewayPort}`;
const boundaryGatewayBase = `http://127.0.0.1:${boundaryGatewayPort}`;
const unsignedBoundaryGatewayBase = `http://127.0.0.1:${unsignedBoundaryGatewayPort}`;
const publicFailureGatewayBase = `http://127.0.0.1:${publicFailureGatewayPort}`;
const verifierFailureGatewayBase = `http://127.0.0.1:${verifierFailureGatewayPort}`;
const shadowBase = `http://127.0.0.1:${shadowPort}`;
const liveBase = `http://127.0.0.1:${livePort}`;
const degradedLiveBase = `http://127.0.0.1:${degradedLivePort}`;
const staleIndexLiveBase = `http://127.0.0.1:${staleIndexLivePort}`;

const dataDir = await mkdtemp(resolve(tmpdir(), "cas-knowledge-"));
const ownerHmacSecret = "verify-owner-hmac-secret";
let fakeIdentity;
let boundaryEngine;
try {
  const engineEnv = {
    ...process.env,
    PYTHONPATH: pythonPath,
    HOST: "127.0.0.1",
    PORT: String(enginePort),
    CAS_KNOWLEDGE_DATA_DIR: dataDir,
    CAS_KNOWLEDGE_PROVIDER: "pbs-compatible-local",
    CAS_KNOWLEDGE_OWNER_MODE: "trusted-header",
    CAS_KNOWLEDGE_SINGLE_OWNER: "verify-single-owner",
    CAS_KNOWLEDGE_REQUIRE_OWNER_HEADER: "true",
    CAS_KNOWLEDGE_OWNER_HMAC_SECRET: ownerHmacSecret
  };
  spawnChild(python.command, [...python.argsPrefix, "-m", "cas_knowledge_engine.app"], engineEnv);
  const engineHealth = await waitForJson(`${engineBase}/api/knowledge/healthz`, ({ response, body }) => {
    return (
      response.status === 200 &&
      body.status === "ok" &&
      body.service === "cas-knowledge-engine" &&
      body.provider === "pbs-compatible-local" &&
      body.provider_config?.owner_mode === "trusted-header"
    );
  });
  expect("knowledge:http-health", engineHealth.body.service === "cas-knowledge-engine", "knowledge engine HTTP health works");
  expect(
    "knowledge:engine-cors-owner-header-contract",
    engineHealth.response.headers.get("access-control-allow-headers") === "authorization,content-type,x-forwarded-user,x-cas-owner-signature",
    "knowledge engine CORS only advertises the gateway-derived owner header"
  );
  const directUnsignedOwner = await fetchJson(`${engineBase}/api/knowledge/rag/query`, {
    method: "POST",
    headers: { "x-forwarded-user": "unsigned-owner" },
    body: JSON.stringify({ customer_id: "verify", question: "unsigned owner" })
  });
  const directRemoteOwner = await fetchJson(`${engineBase}/api/knowledge/rag/query`, {
    method: "POST",
    headers: { "x-remote-user": "legacy-remote-owner" },
    body: JSON.stringify({ customer_id: "verify", question: "legacy remote owner" })
  });
  const directOpenShiftOwner = await fetchJson(`${engineBase}/api/knowledge/rag/query`, {
    method: "POST",
    headers: { "x-openshift-user": "legacy-openshift-owner" },
    body: JSON.stringify({ customer_id: "verify", question: "legacy openshift owner" })
  });
  expect(
    "knowledge:engine-legacy-owner-headers-rejected",
    directUnsignedOwner.response.status === 403 &&
      directUnsignedOwner.body.code === "owner-required" &&
      directRemoteOwner.response.status === 403 &&
      directRemoteOwner.body.code === "owner-required" &&
      directOpenShiftOwner.response.status === 403 &&
      directOpenShiftOwner.body.code === "owner-required",
    "knowledge engine only trusts signed x-forwarded-user in trusted-header mode",
    JSON.stringify({ unsigned: directUnsignedOwner.body, remote: directRemoteOwner.body, openshift: directOpenShiftOwner.body })
  );

  const unsignedEngineEnv = {
    ...process.env,
    PYTHONPATH: pythonPath,
    HOST: "127.0.0.1",
    PORT: String(unsignedEnginePort),
    CAS_KNOWLEDGE_DATA_DIR: dataDir,
    CAS_KNOWLEDGE_PROVIDER: "pbs-compatible-local",
    CAS_KNOWLEDGE_OWNER_MODE: "trusted-header",
    CAS_KNOWLEDGE_REQUIRE_OWNER_HEADER: "true",
    CAS_KNOWLEDGE_OWNER_HMAC_SECRET: ""
  };
  spawnChild(python.command, [...python.argsPrefix, "-m", "cas_knowledge_engine.app"], unsignedEngineEnv);
  await waitForJson(`${unsignedEngineBase}/api/knowledge/healthz`, ({ response, body }) => response.status === 200 && body.service === "cas-knowledge-engine");
  const missingSecretDirectOwner = await fetchJson(`${unsignedEngineBase}/api/knowledge/rag/query`, {
    method: "POST",
    headers: { "x-forwarded-user": "unsigned-owner" },
    body: JSON.stringify({ customer_id: "verify", question: "missing hmac secret" })
  });
  expect(
    "knowledge:engine-missing-hmac-secret-rejected",
    missingSecretDirectOwner.response.status === 403 && missingSecretDirectOwner.body.code === "owner-required",
    "knowledge engine rejects trusted-header private requests when owner HMAC secret is missing",
    JSON.stringify(missingSecretDirectOwner.body)
  );

  const gatewayEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(gatewayPort),
    CAS_BRAIN_PROVIDER: "mock",
    CAS_EVIDENCE_PROVIDER: "none",
    CAS_KNOWLEDGE_OWNER_IDENTITY_MODE: "token-hash",
    CAS_KNOWLEDGE_ENGINE_URL: engineBase,
    CAS_KNOWLEDGE_ENGINE_TIMEOUT_MS: "10000",
    CAS_KNOWLEDGE_OWNER_HMAC_SECRET: ownerHmacSecret,
    CAS_KNOWLEDGE_REQUIRE_CUSTOMER_ACCESS: "true",
    CAS_KNOWLEDGE_CUSTOMER_ACCESS_JSON: JSON.stringify({
      owners: {
        [tokenOwner("verify-owner-a")]: ["verify"],
        [tokenOwner("verify-owner-b")]: ["verify"],
        [tokenOwner("verify-token-a")]: ["auth-scope", "shared-note-scope"],
        [tokenOwner("verify-token-b")]: ["auth-scope", "shared-note-scope"]
      }
    })
  };
  spawnChild("node", ["apps/gateway/src/server.mjs"], gatewayEnv);
  const ownerHeaders = { authorization: "Bearer verify-owner-a" };
  const gatewayHealth = await waitForJson(`${gatewayBase}/api/knowledge/healthz`, ({ response, body }) => {
    return response.status === 200 && body.service === "cas-knowledge-engine";
  });
  expect("knowledge:gateway-proxy-health", gatewayHealth.body.service === "cas-knowledge-engine", "gateway proxies knowledge health");
  expect(
    "knowledge:gateway-cors-client-header-contract",
    gatewayHealth.response.headers.get("access-control-allow-headers") === "authorization,content-type",
    "gateway CORS does not advertise internal owner identity headers to browser clients"
  );

  const upload = await fetchJson(`${gatewayBase}/api/knowledge/uploads/ingest`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      customer_id: "verify",
      file_name: "verify-runbook.txt",
      filename: "verify-runbook.txt",
      content: "OpenShift router latency is connected to [[Router Latency]], route shards, HAProxy logs, ingress certificates, namespace events, #ingress, and https://example.com/verify-runbook.",
      source_scope: "user_upload",
      visibility: "private_user",
      source_kind: "upload",
      source_metadata: {
        customer_id: "verify",
        verifier: "knowledge-engine"
      },
      force_reingest: false,
      index: true
    })
  });
  expect("knowledge:upload", upload.response.status === 200 && upload.body.status === "indexed", "gateway upload ingest indexes document");
  const uploadedDocumentId = upload.body.document?.id;
  expect(
    "knowledge:pbs-upload-contract",
    upload.body.document?.metadata?.pbs_payload?.file_name === "verify-runbook.txt" &&
      upload.body.document?.metadata?.pbs_payload?.source_scope === "user_upload" &&
      upload.body.document?.metadata?.pbs_payload?.visibility === "private_user" &&
      upload.body.document?.metadata?.pbs_payload?.index === true &&
      upload.body.document?.metadata?.pbs_payload?.force_reingest === false,
    "gateway upload records PBS ingest contract"
  );
  const uploadWikiNote = Array.isArray(upload.body.wiki?.notes)
    ? upload.body.wiki.notes.find((note) => note.document_id === uploadedDocumentId)
    : null;
  expect(
    "knowledge:upload-wiki-provenance",
    Boolean(uploadedDocumentId) &&
      uploadWikiNote?.revision === 1 &&
      uploadWikiNote?.previous_revision === 0 &&
      uploadWikiNote?.provenance?.source === "wiki-loop" &&
      uploadWikiNote?.provenance?.source_document_id === uploadedDocumentId,
    "upload creates initial LLM Wiki note with document provenance",
    JSON.stringify({ uploadedDocumentId, uploadWikiNote })
  );
  const encodedContent = Buffer.from("Base64 upload payloads are accepted by the CAS PBS-compatible ingest adapter.", "utf8").toString("base64");
  const base64Upload = await fetchJson(`${gatewayBase}/api/knowledge/uploads/ingest`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      customer_id: "verify",
      filename: "verify-base64-runbook.txt",
      content_base64: encodedContent,
      mime_type: "text/plain"
    })
  });
  expect(
    "knowledge:upload-base64",
      base64Upload.response.status === 200 &&
      base64Upload.body.status === "indexed" &&
      base64Upload.body.document?.metadata?.parser === "binary-text",
    "gateway base64 upload ingest indexes document"
  );
  expect(
    "knowledge:pbs-base64-contract",
    base64Upload.body.document?.metadata?.pbs_payload?.content_fields?.includes("content_base64"),
    "gateway base64 upload records PBS content field contract"
  );
  const executableUpload = await fetchJson(`${gatewayBase}/api/knowledge/uploads/ingest`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      customer_id: "verify",
      filename: "unsafe-runbook.exe",
      content: "Executable-looking customer uploads should not enter the local ingest path.",
      mime_type: "application/x-msdownload"
    })
  });
  expect(
    "knowledge:upload-blocks-executable-extension",
    executableUpload.response.status === 400 && String(executableUpload.body.error ?? "").includes("not allowed"),
    "gateway upload rejects executable extensions before indexing",
    JSON.stringify(executableUpload.body)
  );
  const invalidBase64Upload = await fetchJson(`${gatewayBase}/api/knowledge/uploads/ingest`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      customer_id: "verify",
      filename: "invalid-base64.txt",
      content_base64: "not valid base64!!",
      mime_type: "text/plain"
    })
  });
  expect(
    "knowledge:upload-blocks-invalid-base64",
    invalidBase64Upload.response.status === 400 && String(invalidBase64Upload.body.error ?? "").toLowerCase().includes("base64"),
    "gateway upload rejects invalid base64 payloads before indexing",
    JSON.stringify(invalidBase64Upload.body)
  );

  const urlIngest = await fetchJson(`${gatewayBase}/api/knowledge/uploads/url-ingest`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      customer_id: "verify",
      url: "https://93.184.216.34/verify-runbook",
      content: "URL ingest keeps PBS wiki compilation metadata for customer topology knowledge.",
      source_scope: "user_upload",
      visibility: "private_user",
      source_kind: "url",
      source_metadata: {
        customer_id: "verify",
        verifier: "knowledge-engine"
      },
      force_reingest: false,
      index: true,
      auto_compile_wiki: true
    })
  });
  expect(
    "knowledge:pbs-url-contract",
    urlIngest.response.status === 200 &&
      urlIngest.body.document?.metadata?.pbs_payload?.url === "https://93.184.216.34/verify-runbook" &&
      urlIngest.body.document?.metadata?.pbs_payload?.auto_compile_wiki === true,
    "gateway URL ingest records PBS wiki compile contract"
  );
  const mismatchedCustomerUpload = await fetchJson(`${gatewayBase}/api/knowledge/uploads/ingest`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      customer_id: "verify",
      filename: "mismatched-customer.txt",
      content: "Nested customer metadata must not smuggle a different workspace.",
      source_metadata: {
        customer_id: "forbidden-customer"
      }
    })
  });
  expect(
    "knowledge:customer-acl-blocks-mismatched-metadata",
    mismatchedCustomerUpload.response.status === 400 && mismatchedCustomerUpload.body.code === "knowledge-customer-mismatch",
    "gateway rejects conflicting top-level and nested customer workspace identifiers",
    JSON.stringify(mismatchedCustomerUpload.body)
  );
  const loopbackUrlIngest = await fetchJson(`${gatewayBase}/api/knowledge/uploads/url-ingest`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      customer_id: "verify",
      url: "http://127.0.0.1/internal-runbook",
      content: "Loopback URLs must be rejected even when inline content is supplied.",
      auto_compile_wiki: true
    })
  });
  expect(
    "knowledge:url-ingest-blocks-loopback-target",
    loopbackUrlIngest.response.status === 400 && String(loopbackUrlIngest.body.error ?? "").includes("blocked"),
    "gateway URL ingest rejects loopback/private targets before indexing",
    JSON.stringify(loopbackUrlIngest.body)
  );

  const reports = await fetchJson(`${gatewayBase}/api/knowledge/uploads/reports?customer_id=verify`, {
    headers: ownerHeaders
  });
  expect(
    "knowledge:upload-reports",
    reports.response.status === 200 && reports.body.counts?.documents === 3,
    "gateway upload reports list indexed document"
  );
  const reportItems = Array.isArray(reports.body.items) ? reports.body.items : [];
  const uploadReport = reportItems.find((item) => item.document_source_id === uploadedDocumentId);
  expect(
    "knowledge:upload-reports-pbs-shape",
    reports.response.status === 200 &&
      reports.body.counts?.items === 3 &&
      uploadReport?.filename === "verify-runbook.txt" &&
      uploadReport?.ready_for_chat === true &&
      uploadReport?.basic_index_ready === true &&
      uploadReport?.chunk_count >= 1 &&
      uploadReport?.graph_summary?.wikilinks?.includes("Router Latency") &&
      uploadReport?.graph_summary?.tags?.includes("ingress") &&
      uploadReport?.graph_summary?.urls?.includes("https://example.com/verify-runbook.") &&
      Array.isArray(uploadReport?.chunk_previews) &&
      uploadReport.chunk_previews.some((preview) => String(preview.markdown || "").includes("OpenShift router latency")),
    "gateway upload reports expose PBS-style items with graph_summary and chunk previews",
    JSON.stringify(uploadReport)
  );

  const localVault = await fetchJson(`${gatewayBase}/api/knowledge/wiki-vault?customer_id=verify`, {
    headers: ownerHeaders
  });
  const selectedUpload = Array.isArray(localVault.body.selected_uploads)
    ? localVault.body.selected_uploads.find((item) => item.document_source_id === uploadedDocumentId)
    : null;
  const selectedContext = Array.isArray(localVault.body.selected_context) ? localVault.body.selected_context[0] : null;
  expect(
    "knowledge:wiki-vault-local-signals",
    localVault.response.status === 200 &&
      Array.isArray(localVault.body.graph?.nodes) &&
      Array.isArray(localVault.body.graph?.edges) &&
      localVault.body.summary?.graph_relation_count >= 1 &&
      Array.isArray(localVault.body.top_wikilinks) &&
      localVault.body.top_wikilinks.some((item) => item.label === "Router Latency") &&
      Array.isArray(localVault.body.top_tags) &&
      localVault.body.top_tags.some((item) => item.label === "ingress") &&
      Array.isArray(localVault.body.relations) &&
      localVault.body.relations.length >= 1 &&
      Array.isArray(localVault.body.selected_context) &&
      localVault.body.selected_context.length >= 1 &&
      selectedContext?.document_source_id &&
      typeof selectedContext?.viewer_path === "string" &&
      selectedContext?.source_scope === "wiki_vault" &&
      selectedUpload?.graph_summary?.wikilinks?.includes("Router Latency") &&
      selectedUpload?.chunk_previews?.length >= 1,
    "gateway local wiki vault exposes PBS-style graph alias, wikilinks, tags, upload summaries, context viewer paths, relations, and selected context",
    JSON.stringify(localVault.body)
  );

  const rag = await fetchJson(`${gatewayBase}/api/knowledge/rag/query`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      customer_id: "verify",
      question: "router latency evidence"
    })
  });
  expect("knowledge:rag", rag.response.status === 200 && Array.isArray(rag.body.citations) && rag.body.citations.length > 0, "gateway RAG returns citations");
  const ragCitations = Array.isArray(rag.body.citations) ? rag.body.citations : [];
  expect(
    "knowledge:rag-upload-lineage",
    Boolean(uploadedDocumentId) &&
      ragCitations.some(
        (citation) =>
          citation.document_id === uploadedDocumentId ||
          citation.title === upload.body.document?.title ||
          String(citation.snippet ?? "").includes("OpenShift router latency")
      ),
    "gateway RAG cites the uploaded customer document",
    JSON.stringify({ uploadedDocumentId, citations: ragCitations })
  );
  const scopedRag = await fetchJson(`${gatewayBase}/api/knowledge/rag/query`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      customer_id: "verify",
      question: "router latency evidence",
      active_document_id: uploadedDocumentId,
      enabled_upload_document_ids: [uploadedDocumentId],
      enabled_source_scopes: ["user_upload"],
      restrict_uploaded_sources: true
    })
  });
  const scopedCitations = Array.isArray(scopedRag.body.citations) ? scopedRag.body.citations : [];
  expect(
    "knowledge:rag-active-document-scope",
    scopedRag.response.status === 200 &&
      scopedCitations.length >= 1 &&
      scopedCitations.every((citation) => citation.document_source_id === uploadedDocumentId) &&
      scopedCitations.every((citation) => typeof citation.viewer_path === "string") &&
      scopedCitations.some((citation) => citation.source === "chunk" && String(citation.viewer_path ?? "").includes(uploadedDocumentId)) &&
      scopedCitations.every((citation) => typeof citation.source_scope === "string") &&
      scopedRag.body.trace?.active_document_id === uploadedDocumentId &&
      scopedRag.body.trace?.restrict_uploaded_sources === true,
    "gateway RAG honors active uploaded document scope and emits source lineage citations",
    JSON.stringify(scopedRag.body)
  );
  const vaultOnlyNote = await fetchJson(`${gatewayBase}/api/knowledge/wiki-vault/notes`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      customer_id: "verify",
      title: "Vault-only Router Signal",
      body: "This wiki-only context contains vault-only-signal-7421 and links [[Router Latency]] with #ingress."
    })
  });
  const vaultOnlyRag = await fetchJson(`${gatewayBase}/api/knowledge/rag/query`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      customer_id: "verify",
      question: "vault-only-signal-7421"
    })
  });
  const vaultOnlyCitations = Array.isArray(vaultOnlyRag.body.citations) ? vaultOnlyRag.body.citations : [];
  expect(
    "knowledge:rag-wiki-vault-context",
    vaultOnlyNote.response.status === 200 &&
      vaultOnlyRag.response.status === 200 &&
      vaultOnlyRag.body.trace?.wiki_vault_context_attached === true &&
      vaultOnlyCitations.some((citation) => citation.source === "wiki-vault" && String(citation.snippet ?? "").includes("vault-only-signal-7421")),
    "gateway RAG can cite local wiki vault context that is not present in uploaded chunks",
    JSON.stringify({ note: vaultOnlyNote.body, rag: vaultOnlyRag.body })
  );
  const isolatedRag = await fetchJson(`${gatewayBase}/api/knowledge/rag/query`, {
    method: "POST",
    headers: { authorization: "Bearer verify-owner-b" },
    body: JSON.stringify({
      customer_id: "verify",
      question: "router latency evidence"
    })
  });
  expect(
    "knowledge:owner-isolation",
    isolatedRag.response.status === 200 && Array.isArray(isolatedRag.body.citations) && isolatedRag.body.citations.length === 0,
    "gateway knowledge API isolates same customer_id by owner scope"
  );
  const forbiddenCustomerRag = await fetchJson(`${gatewayBase}/api/knowledge/rag/query`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      customer_id: "forbidden-customer",
      question: "router latency evidence"
    })
  });
  expect(
    "knowledge:customer-acl-denies-unmapped-customer",
    forbiddenCustomerRag.response.status === 403 && forbiddenCustomerRag.body.code === "knowledge-customer-forbidden",
    "gateway rejects verified owners when the requested customer workspace is not in their ACL",
    JSON.stringify(forbiddenCustomerRag.body)
  );
  const noOwnerRag = await fetchJson(`${gatewayBase}/api/knowledge/rag/query`, {
    method: "POST",
    body: JSON.stringify({
      customer_id: "verify",
      question: "router latency evidence"
    })
  });
  expect(
    "knowledge:no-owner-rejected",
    noOwnerRag.response.status === 401 && noOwnerRag.body.code === "knowledge-owner-unverified",
    "gateway rejects no-owner private knowledge access before proxying to the engine",
    JSON.stringify(noOwnerRag.body)
  );
  const spoofedRemoteUser = await fetchJson(`${gatewayBase}/api/knowledge/rag/query`, {
    method: "POST",
    headers: { "x-remote-user": "spoofed-remote-user" },
    body: JSON.stringify({
      customer_id: "verify",
      question: "router latency evidence"
    })
  });
  const spoofedOpenShiftUser = await fetchJson(`${gatewayBase}/api/knowledge/rag/query`, {
    method: "POST",
    headers: { "x-openshift-user": "spoofed-openshift-user" },
    body: JSON.stringify({
      customer_id: "verify",
      question: "router latency evidence"
    })
  });
  expect(
    "knowledge:spoofed-owner-headers-rejected",
    spoofedRemoteUser.response.status === 401 &&
      spoofedRemoteUser.body.code === "knowledge-owner-unverified" &&
      spoofedOpenShiftUser.response.status === 401 &&
      spoofedOpenShiftUser.body.code === "knowledge-owner-unverified",
    "gateway never trusts client-supplied x-remote-user or x-openshift-user for knowledge owner scope",
    JSON.stringify({ remote: spoofedRemoteUser.body, openshift: spoofedOpenShiftUser.body })
  );
  const authHeadersA = { authorization: "Bearer verify-token-a" };
  const authHeadersB = { authorization: "Bearer verify-token-b" };
  await fetchJson(`${gatewayBase}/api/knowledge/uploads/ingest`, {
    method: "POST",
    headers: authHeadersA,
    body: JSON.stringify({
      customer_id: "auth-scope",
      filename: "auth-scope-runbook.txt",
      content: "Token-derived owner scope keeps customer documents isolated across console users."
    })
  });
  const authScopedRag = await fetchJson(`${gatewayBase}/api/knowledge/rag/query`, {
    method: "POST",
    headers: authHeadersB,
    body: JSON.stringify({
      customer_id: "auth-scope",
      question: "owner scope documents"
    })
  });
  expect(
    "knowledge:token-owner-isolation",
    authScopedRag.response.status === 200 && Array.isArray(authScopedRag.body.citations) && authScopedRag.body.citations.length === 0,
    "gateway derives owner scope from authorization token when trusted owner header is absent"
  );
  const sharedNoteA = await fetchJson(`${gatewayBase}/api/knowledge/wiki-vault/notes`, {
    method: "POST",
    headers: authHeadersA,
    body: JSON.stringify({
      customer_id: "shared-note-scope",
      id: "shared-note-id",
      title: "Owner A shared note",
      body: "Owner A [[router]] wiki note must not be overwritten by owner B."
    })
  });
  const sharedNoteB = await fetchJson(`${gatewayBase}/api/knowledge/wiki-vault/notes`, {
    method: "POST",
    headers: authHeadersB,
    body: JSON.stringify({
      customer_id: "shared-note-scope",
      id: "shared-note-id",
      title: "Owner B shared note",
      body: "Owner B [[router]] wiki note must not overwrite owner A."
    })
  });
  const sharedVaultA = await fetchJson(`${gatewayBase}/api/knowledge/wiki-vault?customer_id=shared-note-scope`, {
    headers: authHeadersA
  });
  const sharedVaultB = await fetchJson(`${gatewayBase}/api/knowledge/wiki-vault?customer_id=shared-note-scope`, {
    headers: authHeadersB
  });
  const sharedVaultANotes = Array.isArray(sharedVaultA.body.notes) ? sharedVaultA.body.notes : [];
  const sharedVaultBNotes = Array.isArray(sharedVaultB.body.notes) ? sharedVaultB.body.notes : [];
  expect(
    "knowledge:shared-note-owner-isolation",
    sharedNoteA.response.status === 200 &&
      sharedNoteB.response.status === 200 &&
      sharedNoteA.body.note?.client_note_id === "shared-note-id" &&
      sharedNoteB.body.note?.client_note_id === "shared-note-id" &&
      sharedNoteA.body.note?.id !== sharedNoteB.body.note?.id &&
      sharedVaultANotes.some((note) => note.id === sharedNoteA.body.note?.id && String(note.body ?? "").includes("Owner A")) &&
      !sharedVaultANotes.some((note) => String(note.body ?? "").includes("Owner B")) &&
      sharedVaultBNotes.some((note) => note.id === sharedNoteB.body.note?.id && String(note.body ?? "").includes("Owner B")) &&
      !sharedVaultBNotes.some((note) => String(note.body ?? "").includes("Owner A")),
    "gateway wiki notes namespace client note ids by owner and prevent cross-owner overwrite",
    JSON.stringify({ noteA: sharedNoteA.body.note, noteB: sharedNoteB.body.note, vaultA: sharedVaultANotes, vaultB: sharedVaultBNotes })
  );

  fakeIdentity = await startFakeOpenShiftIdentityServer(fakeIdentityPort);
  const verifiedGatewayEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(verifiedGatewayPort),
    CAS_BRAIN_PROVIDER: "mock",
    CAS_EVIDENCE_PROVIDER: "openshift-api",
    CAS_OPENSHIFT_API_URL: fakeIdentity.url,
    CAS_OPENSHIFT_API_TLS_INSECURE: "true",
    CAS_KNOWLEDGE_OWNER_IDENTITY_MODE: "openshift-selfsubjectreview",
    CAS_KNOWLEDGE_OWNER_IDENTITY_CACHE_TTL_MS: "0",
    CAS_KNOWLEDGE_ENGINE_URL: engineBase,
    CAS_KNOWLEDGE_ENGINE_TIMEOUT_MS: "10000",
    CAS_KNOWLEDGE_OWNER_HMAC_SECRET: ownerHmacSecret,
    CAS_KNOWLEDGE_REQUIRE_CUSTOMER_ACCESS: "true",
    CAS_KNOWLEDGE_CUSTOMER_ACCESS_JSON: JSON.stringify({
      users: {
        "verified-user": ["verified-scope"]
      }
    })
  };
  spawnChild("node", ["apps/gateway/src/server.mjs"], verifiedGatewayEnv);
  const verifiedGatewayHealth = await waitForJson(`${verifiedGatewayBase}/api/knowledge/healthz`, ({ response, body }) => {
    return response.status === 200 && body.service === "cas-knowledge-engine";
  });
  expect(
    "knowledge:selfsubjectreview-public-health",
    verifiedGatewayHealth.response.status === 200,
    "SelfSubjectReview gateway keeps knowledge health public"
  );
  const verifiedUpload = await fetchJson(`${verifiedGatewayBase}/api/knowledge/uploads/ingest`, {
    method: "POST",
    headers: { authorization: "Bearer verified-token-a" },
    body: JSON.stringify({
      customer_id: "verified-scope",
      filename: "verified-identity-runbook.txt",
      content: "SelfSubjectReview verified identity keeps refreshed tokens on the same customer knowledge scope."
    })
  });
  const refreshedTokenRag = await fetchJson(`${verifiedGatewayBase}/api/knowledge/rag/query`, {
    method: "POST",
    headers: { authorization: "Bearer verified-token-b" },
    body: JSON.stringify({
      customer_id: "verified-scope",
      question: "refreshed tokens customer knowledge scope"
    })
  });
  const differentUserRag = await fetchJson(`${verifiedGatewayBase}/api/knowledge/rag/query`, {
    method: "POST",
    headers: { authorization: "Bearer verified-token-other" },
    body: JSON.stringify({
      customer_id: "verified-scope",
      question: "refreshed tokens customer knowledge scope"
    })
  });
  const invalidVerifiedRag = await fetchJson(`${verifiedGatewayBase}/api/knowledge/rag/query`, {
    method: "POST",
    headers: { authorization: "Bearer invalid-token", "x-forwarded-user": "spoofed-owner" },
    body: JSON.stringify({
      customer_id: "verified-scope",
      question: "refreshed tokens customer knowledge scope"
    })
  });
  const spoofedValidOtherRag = await fetchJson(`${verifiedGatewayBase}/api/knowledge/rag/query`, {
    method: "POST",
    headers: { authorization: "Bearer verified-token-other", "x-forwarded-user": "uid-verified-user", "x-remote-user": "verified-user" },
    body: JSON.stringify({
      customer_id: "verified-scope",
      question: "refreshed tokens customer knowledge scope"
    })
  });
  const refreshedCitations = Array.isArray(refreshedTokenRag.body.citations) ? refreshedTokenRag.body.citations : [];
  const differentUserCitations = Array.isArray(differentUserRag.body.citations) ? differentUserRag.body.citations : [];
  const spoofedOtherCitations = Array.isArray(spoofedValidOtherRag.body.citations) ? spoofedValidOtherRag.body.citations : [];
  expect(
    "knowledge:selfsubjectreview-owner-contract",
    verifiedUpload.response.status === 200 &&
      refreshedTokenRag.response.status === 200 &&
      refreshedCitations.length > 0 &&
      differentUserRag.response.status === 403 &&
      differentUserRag.body.code === "knowledge-customer-forbidden" &&
      spoofedValidOtherRag.response.status === 403 &&
      spoofedValidOtherRag.body.code === "knowledge-customer-forbidden" &&
      invalidVerifiedRag.response.status === 401 &&
      invalidVerifiedRag.body.code === "knowledge-owner-unverified",
    "SelfSubjectReview gateway maps refreshed tokens to the same verified user, denies other users by customer ACL, and rejects invalid/spoofed owners",
    JSON.stringify({ refreshedCitations, differentUserCitations, spoofedOtherCitations, invalid: invalidVerifiedRag.body })
  );
  expect(
    "knowledge:selfsubjectreview-request-contract",
    fakeIdentity.records.length >= 4 &&
      fakeIdentity.records.every(
        (record) =>
          record.method === "POST" &&
          record.path === "/apis/authentication.k8s.io/v1/selfsubjectreviews" &&
          record.body?.kind === "SelfSubjectReview"
      ),
    "SelfSubjectReview gateway verifies private knowledge requests with POST selfsubjectreviews",
    JSON.stringify(fakeIdentity.records)
  );

  boundaryEngine = await startFakeKnowledgeBoundaryServer(boundaryEnginePort);
  const boundaryUserToken = "boundary-user-token";
  const expectedBoundaryOwner = tokenOwner(boundaryUserToken);
  const boundaryGatewayEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(boundaryGatewayPort),
    CAS_BRAIN_PROVIDER: "mock",
    CAS_EVIDENCE_PROVIDER: "none",
    CAS_KNOWLEDGE_OWNER_IDENTITY_MODE: "token-hash",
    CAS_KNOWLEDGE_ENGINE_URL: boundaryEngine.url,
    CAS_KNOWLEDGE_ENGINE_TIMEOUT_MS: "10000",
    CAS_KNOWLEDGE_OWNER_HMAC_SECRET: ownerHmacSecret,
    CAS_KNOWLEDGE_REQUIRE_CUSTOMER_ACCESS: "true",
    CAS_KNOWLEDGE_CUSTOMER_ACCESS_JSON: JSON.stringify({
      owners: {
        [expectedBoundaryOwner]: ["boundary"]
      }
    })
  };
  spawnChild("node", ["apps/gateway/src/server.mjs"], boundaryGatewayEnv);
  const boundaryHealth = await waitForJson(`${boundaryGatewayBase}/api/knowledge/healthz`, ({ response, body }) => {
    return response.status === 200 && body.service === "cas-knowledge-engine" && body.engine?.status === "ready";
  });
  const boundaryCapabilities = await fetchJson(`${boundaryGatewayBase}/api/knowledge/capabilities`);
  expect(
    "knowledge:gateway-public-health-sanitized",
    boundaryHealth.body.status === "ok" &&
      boundaryHealth.body.provider === undefined &&
      boundaryHealth.body.engine?.provider === undefined &&
      boundaryHealth.body.storage === undefined &&
      boundaryHealth.body.counts === undefined &&
      boundaryHealth.body.provider_config === undefined &&
      boundaryHealth.body.engine?.endpoint === undefined &&
      Array.isArray(boundaryHealth.body.capabilities) &&
      boundaryCapabilities.response.status === 200 &&
      boundaryCapabilities.body.provider === undefined &&
      boundaryCapabilities.body.engine === undefined &&
      Array.isArray(boundaryCapabilities.body.capabilities),
    "gateway public knowledge health/capabilities expose readiness without storage, tenant counts, provider mode, or provider internals",
    JSON.stringify({ health: boundaryHealth.body, capabilities: boundaryCapabilities.body })
  );
  const publicFailureGatewayEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(publicFailureGatewayPort),
    CAS_BRAIN_PROVIDER: "mock",
    CAS_EVIDENCE_PROVIDER: "none",
    CAS_KNOWLEDGE_OWNER_IDENTITY_MODE: "token-hash",
    CAS_KNOWLEDGE_ENGINE_URL: `http://127.0.0.1:${deadKnowledgeEnginePort}`,
    CAS_KNOWLEDGE_ENGINE_TIMEOUT_MS: "500"
  };
  spawnChild("node", ["apps/gateway/src/server.mjs"], publicFailureGatewayEnv);
  const publicGatewayHealth = await waitForJson(
    `${publicFailureGatewayBase}/healthz`,
    ({ response, body }) => response.status === 200 && body.service === "cas-gateway"
  );
  expect(
    "knowledge:gateway-public-healthz-sanitized",
    publicGatewayHealth.body.brain_provider === undefined &&
      publicGatewayHealth.body.evidence_provider === undefined &&
      publicGatewayHealth.body.knowledge_owner_identity_mode === undefined &&
      publicGatewayHealth.body.mode === undefined,
    "gateway public healthz omits provider and owner identity internals",
    JSON.stringify(publicGatewayHealth.body)
  );
  const publicCapabilitiesFailure = await fetchJson(`${publicFailureGatewayBase}/api/knowledge/capabilities`);
  expect(
    "knowledge:gateway-public-capabilities-error-sanitized",
    publicCapabilitiesFailure.response.status === 502 &&
      publicCapabilitiesFailure.body.code === "knowledge-engine-unavailable" &&
      publicCapabilitiesFailure.body.engine?.endpoint === undefined &&
      publicCapabilitiesFailure.body.engine?.timeout_ms === undefined,
    "gateway public capabilities failure omits internal engine endpoint details",
    JSON.stringify(publicCapabilitiesFailure.body)
  );

  const boundaryRag = await fetchJson(`${boundaryGatewayBase}/api/knowledge/rag/query`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${boundaryUserToken}`,
      "x-forwarded-user": "spoofed-forwarded-user",
      "x-remote-user": "spoofed-remote-user",
      "x-openshift-user": "spoofed-openshift-user"
    },
    body: JSON.stringify({ customer_id: "boundary", question: "boundary auth headers" })
  });
  const boundaryPrivateRecords = boundaryEngine.records.filter((record) => record.path === "/api/knowledge/rag/query");
  const boundaryPrivateRecord = boundaryPrivateRecords[boundaryPrivateRecords.length - 1];
  expect(
    "knowledge:gateway-internal-token-stripping",
    boundaryRag.response.status === 200 &&
      boundaryPrivateRecord?.headers?.authorization === undefined &&
      boundaryPrivateRecord?.headers?.["x-remote-user"] === undefined &&
      boundaryPrivateRecord?.headers?.["x-openshift-user"] === undefined &&
      boundaryPrivateRecord?.headers?.["x-forwarded-user"] === expectedBoundaryOwner &&
      boundaryPrivateRecord?.headers?.["x-cas-owner-signature"] === ownerSignature(ownerHmacSecret, expectedBoundaryOwner),
    "gateway strips user bearer/spoofed owner headers before the internal Knowledge Engine hop and injects only its signed derived owner",
    JSON.stringify(boundaryPrivateRecord?.headers ?? {})
  );

  const forbiddenBoundaryPrivateCountBefore = boundaryEngine.records.filter((record) => record.path === "/api/knowledge/rag/query").length;
  const boundaryForbiddenCustomer = await fetchJson(`${boundaryGatewayBase}/api/knowledge/rag/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${boundaryUserToken}` },
    body: JSON.stringify({ customer_id: "outside-boundary", question: "customer ACL should stop before proxy" })
  });
  const forbiddenBoundaryPrivateCountAfter = boundaryEngine.records.filter((record) => record.path === "/api/knowledge/rag/query").length;
  expect(
    "knowledge:gateway-customer-acl-not-proxied",
    boundaryForbiddenCustomer.response.status === 403 &&
      boundaryForbiddenCustomer.body.code === "knowledge-customer-forbidden" &&
      forbiddenBoundaryPrivateCountAfter === forbiddenBoundaryPrivateCountBefore,
    "gateway rejects customer ACL failures before the internal Knowledge Engine hop",
    JSON.stringify({ body: boundaryForbiddenCustomer.body, before: forbiddenBoundaryPrivateCountBefore, after: forbiddenBoundaryPrivateCountAfter })
  );

  const rejectedBoundaryPrivateCountBefore = boundaryEngine.records.filter((record) => record.path === "/api/knowledge/rag/query").length;
  const boundaryNoOwner = await fetchJson(`${boundaryGatewayBase}/api/knowledge/rag/query`, {
    method: "POST",
    body: JSON.stringify({ customer_id: "boundary", question: "owner required" })
  });
  const boundarySpoofedOnly = await fetchJson(`${boundaryGatewayBase}/api/knowledge/rag/query`, {
    method: "POST",
    headers: { "x-forwarded-user": "spoofed-forwarded-user" },
    body: JSON.stringify({ customer_id: "boundary", question: "owner required" })
  });
  const rejectedBoundaryPrivateCountAfter = boundaryEngine.records.filter((record) => record.path === "/api/knowledge/rag/query").length;
  expect(
    "knowledge:gateway-owner-failure-not-proxied",
    boundaryNoOwner.response.status === 401 &&
      boundaryNoOwner.body.code === "knowledge-owner-unverified" &&
      boundarySpoofedOnly.response.status === 401 &&
      boundarySpoofedOnly.body.code === "knowledge-owner-unverified" &&
      rejectedBoundaryPrivateCountAfter === rejectedBoundaryPrivateCountBefore,
    "gateway rejects missing/spoofed private knowledge owners before the engine receives the request",
    JSON.stringify({ noOwner: boundaryNoOwner.body, spoofedOnly: boundarySpoofedOnly.body })
  );

  const unsignedBoundaryGatewayEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(unsignedBoundaryGatewayPort),
    CAS_BRAIN_PROVIDER: "mock",
    CAS_EVIDENCE_PROVIDER: "none",
    CAS_KNOWLEDGE_OWNER_IDENTITY_MODE: "token-hash",
    CAS_KNOWLEDGE_ENGINE_URL: boundaryEngine.url,
    CAS_KNOWLEDGE_ENGINE_TIMEOUT_MS: "10000",
    CAS_KNOWLEDGE_OWNER_HMAC_SECRET: ""
  };
  spawnChild("node", ["apps/gateway/src/server.mjs"], unsignedBoundaryGatewayEnv);
  await waitForJson(`${unsignedBoundaryGatewayBase}/api/knowledge/healthz`, ({ response, body }) => response.status === 200 && body.service === "cas-knowledge-engine");
  const unsignedGatewayPrivateCountBefore = boundaryEngine.records.filter((record) => record.path === "/api/knowledge/rag/query").length;
  const unsignedGatewayRag = await fetchJson(`${unsignedBoundaryGatewayBase}/api/knowledge/rag/query`, {
    method: "POST",
    headers: { authorization: "Bearer unsigned-boundary-user-token" },
    body: JSON.stringify({ customer_id: "boundary", question: "missing signing secret" })
  });
  const unsignedGatewayPrivateCountAfter = boundaryEngine.records.filter((record) => record.path === "/api/knowledge/rag/query").length;
  expect(
    "knowledge:gateway-missing-hmac-secret-not-proxied",
    unsignedGatewayRag.response.status === 503 &&
      unsignedGatewayRag.body.code === "knowledge-owner-signing-unavailable" &&
      unsignedGatewayPrivateCountAfter === unsignedGatewayPrivateCountBefore,
    "gateway rejects private knowledge proxying when internal owner signing secret is missing",
    JSON.stringify(unsignedGatewayRag.body)
  );

  const verifierFailureGatewayEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(verifierFailureGatewayPort),
    CAS_BRAIN_PROVIDER: "mock",
    CAS_EVIDENCE_PROVIDER: "openshift-api",
    CAS_OPENSHIFT_API_URL: `http://127.0.0.1:${deadIdentityPort}`,
    CAS_OPENSHIFT_API_TLS_INSECURE: "true",
    CAS_KNOWLEDGE_OWNER_IDENTITY_MODE: "openshift-selfsubjectreview",
    CAS_KNOWLEDGE_OWNER_IDENTITY_TIMEOUT_MS: "500",
    CAS_KNOWLEDGE_OWNER_IDENTITY_CACHE_TTL_MS: "0",
    CAS_KNOWLEDGE_ENGINE_URL: boundaryEngine.url,
    CAS_KNOWLEDGE_ENGINE_TIMEOUT_MS: "10000",
    CAS_KNOWLEDGE_OWNER_HMAC_SECRET: ownerHmacSecret
  };
  spawnChild("node", ["apps/gateway/src/server.mjs"], verifierFailureGatewayEnv);
  await waitForJson(`${verifierFailureGatewayBase}/api/knowledge/healthz`, ({ response, body }) => {
    return response.status === 200 && body.service === "cas-knowledge-engine";
  });
  const verifierFailurePrivateCountBefore = boundaryEngine.records.filter((record) => record.path === "/api/knowledge/rag/query").length;
  const verifierUnavailable = await fetchJson(
    `${verifierFailureGatewayBase}/api/knowledge/rag/query`,
    {
      method: "POST",
      headers: { authorization: "Bearer verifier-api-down" },
      body: JSON.stringify({ customer_id: "boundary", question: "verifier unavailable" })
    },
    5000
  );
  const verifierFailurePrivateCountAfter = boundaryEngine.records.filter((record) => record.path === "/api/knowledge/rag/query").length;
  expect(
    "knowledge:selfsubjectreview-verifier-unavailable",
    verifierUnavailable.response.status === 503 &&
      verifierUnavailable.body.code === "knowledge-owner-verifier-unavailable" &&
      verifierFailurePrivateCountAfter === verifierFailurePrivateCountBefore,
    "SelfSubjectReview verifier transport failures return 503 and do not fall through to Knowledge Engine proxying",
    JSON.stringify(verifierUnavailable.body)
  );

  const wiki = await fetchJson(`${gatewayBase}/api/knowledge/wiki-loop/run`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({ customer_id: "verify" })
  });
  expect("knowledge:wiki-loop", wiki.response.status === 200 && wiki.body.notes_upserted >= 1, "gateway wiki loop upserts notes");
  const wikiNote = Array.isArray(wiki.body.notes) ? wiki.body.notes.find((note) => note.document_id === uploadedDocumentId) : null;
  expect(
    "knowledge:wiki-loop-lineage",
    wikiNote?.revision === 2 &&
      wikiNote?.previous_revision === 1 &&
      wikiNote?.provenance?.source_document_id === uploadedDocumentId &&
      String(wikiNote?.provenance?.previous_body_hash ?? "").length > 0,
    "gateway wiki loop advances uploaded document note with previous revision lineage",
    JSON.stringify({ uploadedDocumentId, wikiNote })
  );
  const evolvedWiki = await fetchJson(`${gatewayBase}/api/knowledge/wiki-loop/run`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({ customer_id: "verify", document_id: uploadedDocumentId })
  });
  const evolvedWikiNote = Array.isArray(evolvedWiki.body.notes)
    ? evolvedWiki.body.notes.find((note) => note.document_id === uploadedDocumentId)
    : null;
  expect(
    "knowledge:wiki-loop-evolution",
    evolvedWikiNote?.revision === 3 &&
      evolvedWikiNote?.previous_revision === 2 &&
      evolvedWikiNote?.provenance?.source_document_id === uploadedDocumentId &&
      String(evolvedWikiNote?.provenance?.previous_body_hash ?? "").length > 0,
    "gateway wiki loop evolves the same uploaded document note across repeated runs",
    JSON.stringify({ uploadedDocumentId, evolvedWikiNote })
  );

  const topology = await fetchJson(`${gatewayBase}/api/knowledge/topology?customer_id=verify`, {
    headers: ownerHeaders
  });
  expect("knowledge:topology", topology.response.status === 200 && topology.body.counts?.nodes >= 2, "gateway topology returns graph nodes");
  const topologyNodes = Array.isArray(topology.body.nodes) ? topology.body.nodes : [];
  const topologyEdges = Array.isArray(topology.body.edges) ? topology.body.edges : [];
  const wikiNoteId = evolvedWikiNote?.id ?? wikiNote?.id ?? uploadWikiNote?.id;
  expect(
    "knowledge:topology-upload-wiki-lineage",
    Boolean(uploadedDocumentId) &&
      Boolean(wikiNoteId) &&
      topologyNodes.some((node) => node.id === uploadedDocumentId && ["document", "upload_document"].includes(node.type)) &&
      topologyNodes.some(
        (node) =>
          node.id === wikiNoteId &&
          node.type === "wiki-note" &&
          node.source_document_id === uploadedDocumentId &&
          node.revision === 3
      ) &&
      topologyEdges.some((edge) => edge.source === wikiNoteId && edge.target === uploadedDocumentId && edge.type === "summarizes"),
    "gateway topology links uploaded document node to evolving LLM Wiki note",
    JSON.stringify({ uploadedDocumentId, wikiNoteId, topologyNodes, topologyEdges })
  );
} catch (error) {
  fail("knowledge:http-smoke", error instanceof Error ? error.message : "unknown knowledge smoke failure");
} finally {
  fakeIdentity?.server?.close();
  boundaryEngine?.server?.close();
  await stopChildren();
  await rm(dataDir, { recursive: true, force: true });
}

const fakePbs = await startFakePbsServer(fakePbsPort);
const shadowDataDir = await mkdtemp(resolve(tmpdir(), "cas-knowledge-shadow-"));
const liveDataDir = await mkdtemp(resolve(tmpdir(), "cas-knowledge-live-"));
const degradedLiveDataDir = await mkdtemp(resolve(tmpdir(), "cas-knowledge-live-degraded-"));
const staleIndexLiveDataDir = await mkdtemp(resolve(tmpdir(), "cas-knowledge-live-stale-index-"));
try {
  const shadowEnv = {
    ...process.env,
    PYTHONPATH: pythonPath,
    HOST: "127.0.0.1",
    PORT: String(shadowPort),
    CAS_KNOWLEDGE_DATA_DIR: shadowDataDir,
    CAS_KNOWLEDGE_PROVIDER: "pbs-http-shadow",
    CAS_PBS_BASE_URL: fakePbs.url,
    CAS_PBS_AUTH_MODE: "service-token",
    CAS_PBS_BEARER_TOKEN: verifyPbsBearerToken,
    CAS_PBS_SHADOW_WRITES: "true",
    CAS_KNOWLEDGE_OWNER_MODE: "trusted-header",
    CAS_KNOWLEDGE_SINGLE_OWNER: "verify-single-owner",
    CAS_KNOWLEDGE_REQUIRE_OWNER_HEADER: "true",
    CAS_KNOWLEDGE_OWNER_HMAC_SECRET: ownerHmacSecret
  };
  spawnChild(python.command, [...python.argsPrefix, "-m", "cas_knowledge_engine.app"], shadowEnv);
  const shadowHealth = await waitForJson(`${shadowBase}/api/knowledge/healthz`, ({ response, body }) => {
    return response.status === 200 && body.provider === "pbs-http-shadow" && body.provider_config?.pbs_http?.ok === true;
  });
  expect("knowledge:pbs-shadow-health", shadowHealth.body.provider_config?.pbs_http?.configured === true, "PBS shadow health reports configured backend");
  expect(
    "knowledge:pbs-shadow-readiness-summary",
    shadowHealth.body.provider_config?.pbs_http?.readiness?.db_ready === true &&
      shadowHealth.body.provider_config?.pbs_http?.readiness?.pgvector_ready === true &&
      shadowHealth.body.provider_config?.pbs_http?.readiness?.embedding_index_parity === true,
    "PBS shadow health exposes PBS runtime readiness summary"
  );
  const shadowOwner = "shadow-owner-a";
  const shadowUpload = await fetchJson(`${shadowBase}/api/knowledge/uploads/ingest`, {
    method: "POST",
    headers: signedOwnerHeaders(shadowOwner),
    body: JSON.stringify({
      customer_id: "shadow",
      filename: "shadow-runbook.txt",
      content: "Shadow mode keeps CAS local response while recording PBS write trace.",
      index: true,
      force_reingest: false
    })
  });
  const shadowUploadRecord = fakePbs.records.find((record) => record.path === "/api/uploads/ingest");
  expect(
    "knowledge:pbs-shadow-upload",
    shadowUpload.response.status === 200 &&
      shadowUpload.body.status === "indexed" &&
      shadowUpload.body.pbs_shadow?.operation === "upload_ingest" &&
      shadowUpload.body.pbs_shadow?.ok === true,
    "PBS shadow upload preserves local response and records PBS trace"
  );
  expect(
    "knowledge:pbs-shadow-owner-contract",
    shadowUploadRecord?.headers?.["x-user"] === shadowOwner &&
      shadowUploadRecord?.headers?.authorization === `Bearer ${verifyPbsBearerToken}` &&
      shadowUploadRecord?.body?.file_name === "shadow-runbook.txt" &&
      shadowUploadRecord?.body?.created_by === pbsOwnerHash(shadowOwner),
    "PBS shadow upload sends bearer auth, owner header, and PBS owner hash payload"
  );

  const liveEnv = {
    ...process.env,
    PYTHONPATH: pythonPath,
    HOST: "127.0.0.1",
    PORT: String(livePort),
    CAS_KNOWLEDGE_DATA_DIR: liveDataDir,
    CAS_KNOWLEDGE_PROVIDER: "pbs-http-live",
    CAS_PBS_BASE_URL: fakePbs.url,
    CAS_PBS_AUTH_MODE: "service-token",
    CAS_PBS_BEARER_TOKEN: verifyPbsBearerToken,
    CAS_KNOWLEDGE_OWNER_MODE: "trusted-header",
    CAS_KNOWLEDGE_SINGLE_OWNER: "verify-single-owner",
    CAS_KNOWLEDGE_REQUIRE_OWNER_HEADER: "true",
    CAS_KNOWLEDGE_OWNER_HMAC_SECRET: ownerHmacSecret
  };
  spawnChild(python.command, [...python.argsPrefix, "-m", "cas_knowledge_engine.app"], liveEnv);
  const liveHealth = await waitForJson(`${liveBase}/api/knowledge/healthz`, ({ response, body }) => {
    return response.status === 200 && body.provider === "pbs-http-live" && body.provider_config?.pbs_http?.ok === true;
  });
  expect("knowledge:pbs-live-health", liveHealth.body.status === "ok", "PBS live health reports ok when backend is healthy");
  expect(
    "knowledge:pbs-live-health-readiness",
    liveHealth.body.provider_config?.pbs_http?.readiness?.database_runtime === true &&
      liveHealth.body.provider_config?.pbs_http?.readiness?.schema_embedding_dim === 768 &&
      liveHealth.body.provider_config?.pbs_http?.readiness?.stale_embedding_index_entries === 0 &&
      liveHealth.body.provider_config?.pbs_http?.readiness?.db_corpus_ready === true,
    "PBS live health exposes DB/vector/corpus readiness"
  );
  const degradedLiveEnv = {
    ...process.env,
    PYTHONPATH: pythonPath,
    HOST: "127.0.0.1",
    PORT: String(degradedLivePort),
    CAS_KNOWLEDGE_DATA_DIR: degradedLiveDataDir,
    CAS_KNOWLEDGE_PROVIDER: "pbs-http-live",
    CAS_PBS_BASE_URL: fakePbs.url,
    CAS_PBS_AUTH_MODE: "service-token",
    CAS_PBS_BEARER_TOKEN: verifyPbsBearerToken,
    CAS_PBS_REQUIRE_RUNTIME_READY: "true",
    CAS_KNOWLEDGE_OWNER_MODE: "trusted-header",
    CAS_KNOWLEDGE_SINGLE_OWNER: "not-ready-owner",
    CAS_KNOWLEDGE_REQUIRE_OWNER_HEADER: "true",
    CAS_KNOWLEDGE_OWNER_HMAC_SECRET: ownerHmacSecret
  };
  spawnChild(python.command, [...python.argsPrefix, "-m", "cas_knowledge_engine.app"], degradedLiveEnv);
  const degradedLiveHealth = await waitForJson(`${degradedLiveBase}/api/knowledge/healthz`, ({ response, body }) => {
    return response.status >= 200 && response.status < 600 && body.provider === "pbs-http-live" && body.provider_config?.pbs_http?.ok === true;
  });
  expect(
    "knowledge:pbs-live-require-runtime-ready",
    degradedLiveHealth.response.status === 503 &&
      degradedLiveHealth.body.status === "degraded" &&
      degradedLiveHealth.body.provider_config?.pbs_http?.readiness?.db_ready === false &&
      degradedLiveHealth.body.provider_config?.pbs_http?.readiness?.pgvector_ready === false,
    "PBS live health degrades when runtime readiness is required but DB/vector are not ready",
    JSON.stringify(degradedLiveHealth.body.provider_config?.pbs_http ?? {})
  );
  const staleIndexLiveEnv = {
    ...process.env,
    PYTHONPATH: pythonPath,
    HOST: "127.0.0.1",
    PORT: String(staleIndexLivePort),
    CAS_KNOWLEDGE_DATA_DIR: staleIndexLiveDataDir,
    CAS_KNOWLEDGE_PROVIDER: "pbs-http-live",
    CAS_PBS_BASE_URL: fakePbs.url,
    CAS_PBS_AUTH_MODE: "service-token",
    CAS_PBS_BEARER_TOKEN: verifyPbsBearerToken,
    CAS_PBS_REQUIRE_RUNTIME_READY: "true",
    CAS_PBS_REQUIRE_CORPUS_READY: "true",
    CAS_PBS_REQUIRED_READY_SCOPES: "official_docs,study_docs",
    CAS_KNOWLEDGE_OWNER_MODE: "trusted-header",
    CAS_KNOWLEDGE_SINGLE_OWNER: "stale-index-owner",
    CAS_KNOWLEDGE_REQUIRE_OWNER_HEADER: "true",
    CAS_KNOWLEDGE_OWNER_HMAC_SECRET: ownerHmacSecret
  };
  spawnChild(python.command, [...python.argsPrefix, "-m", "cas_knowledge_engine.app"], staleIndexLiveEnv);
  const staleIndexLiveHealth = await waitForJson(`${staleIndexLiveBase}/api/knowledge/healthz`, ({ response, body }) => {
    return response.status >= 200 && response.status < 600 && body.provider === "pbs-http-live" && body.provider_config?.pbs_http?.ok === true;
  });
  expect(
    "knowledge:pbs-live-require-corpus-ready",
    staleIndexLiveHealth.response.status === 503 &&
      staleIndexLiveHealth.body.status === "degraded" &&
      staleIndexLiveHealth.body.provider_config?.pbs_http?.readiness?.db_ready === true &&
      staleIndexLiveHealth.body.provider_config?.pbs_http?.readiness?.pgvector_ready === true &&
      staleIndexLiveHealth.body.provider_config?.pbs_http?.readiness?.embedding_index_parity === false &&
      staleIndexLiveHealth.body.provider_config?.pbs_http?.readiness?.stale_embedding_index_entries === 1,
    "PBS live health degrades when corpus/index readiness is required but embeddings are stale or missing",
    JSON.stringify(staleIndexLiveHealth.body.provider_config?.pbs_http ?? {})
  );

  const liveHeaders = signedOwnerHeaders("live-owner-a");
  const liveOwner = liveHeaders["x-forwarded-user"];
  const liveOwnerHash = pbsOwnerHash(liveOwner);
  const liveRecord = (method, path, predicate = () => true) =>
    fakePbs.records.find(
      (record) => record.method === method && record.path === path && record.headers?.["x-user"] === liveOwner && predicate(record)
    );
  const liveUpload = await fetchJson(`${liveBase}/api/knowledge/uploads/ingest`, {
    method: "POST",
    headers: liveHeaders,
    body: JSON.stringify({
      customer_id: "live",
      filename: "live-runbook.txt",
      content_base64: Buffer.from("PBS live upload response should be normalized.", "utf8").toString("base64"),
      index: true,
      force_reingest: false
    })
  });
  expect(
    "knowledge:pbs-live-upload-normalized",
    liveUpload.response.status === 200 &&
      liveUpload.body.status === "indexed" &&
      liveUpload.body.provider === "pbs-http-live" &&
      liveUpload.body.document?.id === "pbs-doc-1" &&
      liveUpload.body.chunks_indexed === 2,
    "PBS live upload response is normalized into CAS upload shape",
    JSON.stringify(liveUpload.body)
  );
  const liveUploadRecordCountBeforeReject = fakePbs.records.filter((record) => record.path === "/api/uploads/ingest").length;
  const liveRejectedUpload = await fetchJson(`${liveBase}/api/knowledge/uploads/ingest`, {
    method: "POST",
    headers: liveHeaders,
    body: JSON.stringify({
      customer_id: "live",
      filename: "live-unsafe.exe",
      content_base64: Buffer.from("PBS live unsafe upload must be rejected before outbound call.", "utf8").toString("base64"),
      mime_type: "application/x-msdownload"
    })
  });
  const liveUploadRecordCountAfterReject = fakePbs.records.filter((record) => record.path === "/api/uploads/ingest").length;
  expect(
    "knowledge:pbs-live-upload-policy-before-outbound",
    liveRejectedUpload.response.status === 400 &&
      String(liveRejectedUpload.body.error ?? "").includes("not allowed") &&
      liveUploadRecordCountAfterReject === liveUploadRecordCountBeforeReject,
    "PBS live upload rejects unsafe files before any outbound PBS request",
    JSON.stringify({ body: liveRejectedUpload.body, before: liveUploadRecordCountBeforeReject, after: liveUploadRecordCountAfterReject })
  );
  const liveUrlIngest = await fetchJson(`${liveBase}/api/knowledge/uploads/url-ingest`, {
    method: "POST",
    headers: liveHeaders,
    body: JSON.stringify({
      customer_id: "live",
      url: "https://93.184.216.34/pbs-live-runbook",
      index: true,
      force_reingest: false,
      auto_compile_wiki: true
    })
  });
  expect(
    "knowledge:pbs-live-url-normalized",
    liveUrlIngest.response.status === 200 &&
      liveUrlIngest.body.provider === "pbs-http-live" &&
      liveUrlIngest.body.schema_version === "url_ingestion_report_v1" &&
      liveUrlIngest.body.summary?.imported_url_count === 1,
    "PBS live URL ingest response is preserved and marked as PBS live",
    JSON.stringify(liveUrlIngest.body)
  );
  const liveReports = await fetchJson(`${liveBase}/api/knowledge/uploads/reports?customer_id=live`, {
    headers: liveHeaders
  });
  expect(
    "knowledge:pbs-live-reports-normalized",
    liveReports.response.status === 200 &&
      liveReports.body.provider === "pbs-http-live" &&
      liveReports.body.counts?.documents === 1 &&
      liveReports.body.documents?.[0]?.document_source_id === "pbs-doc-1",
    "PBS live upload reports response is normalized into CAS report shape",
    JSON.stringify(liveReports.body)
  );
  const liveLeakedReports = await fetchJson(`${liveBase}/api/knowledge/uploads/reports?customer_id=scope-leak`, {
    headers: liveHeaders
  });
  expect(
    "knowledge:pbs-live-reports-scope-mismatch-blocked",
    liveLeakedReports.response.status === 502 &&
      liveLeakedReports.body.status === "error" &&
      liveLeakedReports.body.code === "pbs-scope-mismatch" &&
      liveLeakedReports.body.pbs?.scope_mismatches?.length >= 1,
    "PBS live upload reports reject response rows outside the requested customer/owner scope",
    JSON.stringify(liveLeakedReports.body)
  );
  const liveRag = await fetchJson(`${liveBase}/api/knowledge/rag/query`, {
    method: "POST",
    headers: liveHeaders,
    body: JSON.stringify({ customer_id: "live", question: "router latency evidence" })
  });
  expect(
    "knowledge:pbs-live-rag-normalized",
    liveRag.response.status === 200 &&
      liveRag.body.provider === "pbs-http-live" &&
      liveRag.body.answer.includes("PBS answer") &&
      liveRag.body.trace?.retriever === "pbs-http",
    "PBS live chat response is normalized into CAS RAG shape",
    JSON.stringify(liveRag.body)
  );
  const liveRagFailure = await fetchJson(`${liveBase}/api/knowledge/rag/query`, {
    method: "POST",
    headers: liveHeaders,
    body: JSON.stringify({ customer_id: "live", question: "force-pbs-error" })
  });
  expect(
    "knowledge:pbs-live-error-http-status",
    liveRagFailure.response.status === 500 &&
      liveRagFailure.body.status === "error" &&
      liveRagFailure.body.pbs?.ok === false &&
      liveRagFailure.body.pbs?.status === 500,
    "PBS live failed operations propagate non-2xx HTTP status and PBS trace",
    JSON.stringify(liveRagFailure.body)
  );
  const liveWiki = await fetchJson(`${liveBase}/api/knowledge/wiki-loop/run`, {
    method: "POST",
    headers: liveHeaders,
    body: JSON.stringify({ customer_id: "live" })
  });
  expect(
    "knowledge:pbs-live-wiki-normalized",
    liveWiki.response.status === 200 && liveWiki.body.provider === "pbs-http-live" && liveWiki.body.notes_upserted === 2,
    "PBS live wiki loop response is normalized into CAS wiki shape",
    JSON.stringify(liveWiki.body)
  );
  const liveTopology = await fetchJson(`${liveBase}/api/knowledge/topology?customer_id=live`, {
    headers: liveHeaders
  });
  expect(
    "knowledge:pbs-live-topology-normalized",
    liveTopology.response.status === 200 &&
      liveTopology.body.provider === "pbs-http-live" &&
      liveTopology.body.counts?.nodes === 6 &&
      liveTopology.body.counts?.edges === 3 &&
      graphIntegrity(liveTopology.body),
    "PBS live nested wiki vault graph is normalized into renderable CAS topology shape"
  );
  const liveTopologyNote = Array.isArray(liveTopology.body.nodes)
    ? liveTopology.body.nodes.find((node) => node.id === "pbs-note-1")
    : null;
  const liveTopologyEdge = Array.isArray(liveTopology.body.edges)
    ? liveTopology.body.edges.find((edge) => edge.source === "pbs-note-1" && edge.target === "pbs-link-haproxy")
    : null;
  expect(
    "knowledge:pbs-live-topology-provenance",
    liveTopologyNote?.revision === 7 &&
      liveTopologyNote?.previous_revision === 6 &&
      liveTopologyNote?.degree === 9 &&
      liveTopologyNote?.viewer_path === "/wiki/pbs-note-1" &&
      liveTopologyNote?.compiled_wiki === true &&
      liveTopologyNote?.provenance?.source_document_id === "pbs-doc-1" &&
      liveTopologyEdge?.provenance?.source_document_id === "pbs-doc-1",
    "PBS live topology normalization preserves revision, provenance, and PBS node signal metadata",
    JSON.stringify({ liveTopologyNote, liveTopologyEdge })
  );
  expect(
    "knowledge:pbs-live-topology-pbs-summary-counts",
    liveTopology.body.counts?.documents === 1 &&
      liveTopology.body.counts?.uploads === 1 &&
      liveTopology.body.counts?.notes === 1 &&
      liveTopology.body.counts?.compiled === 1 &&
      liveTopology.body.counts?.wikilinks === 1 &&
      liveTopology.body.counts?.tags === 1 &&
      liveTopology.body.counts?.entities === 2 &&
      liveTopology.body.counts?.relations === 3 &&
      liveTopology.body.pbs?.top_wikilinks?.[0]?.label === "HAProxy" &&
      liveTopology.body.pbs?.selected_uploads?.[0]?.id === "pbs-doc-1",
    "PBS live topology normalization preserves PBS summary counts and vault context signals",
    JSON.stringify(liveTopology.body.counts)
  );
  const liveOrphanTopology = await fetchJson(`${liveBase}/api/knowledge/topology?customer_id=orphan-live`, {
    headers: liveHeaders
  });
  const liveOrphanNodes = Array.isArray(liveOrphanTopology.body.nodes) ? liveOrphanTopology.body.nodes : [];
  const liveOrphanEndpoint = liveOrphanNodes.find((node) => node.id === "pbs-missing-endpoint");
  expect(
    "knowledge:pbs-live-topology-orphan-endpoint",
    liveOrphanTopology.response.status === 200 &&
      liveOrphanTopology.body.provider === "pbs-http-live" &&
      liveOrphanTopology.body.counts?.nodes === 2 &&
      liveOrphanTopology.body.counts?.edges === 1 &&
      liveOrphanEndpoint?.type === "pbs-endpoint" &&
      graphIntegrity(liveOrphanTopology.body),
    "PBS live topology normalization adds fallback endpoint nodes for orphan edge references",
    JSON.stringify(liveOrphanTopology.body)
  );
  const liveMixedTopology = await fetchJson(`${liveBase}/api/knowledge/topology?customer_id=mixed-live`, {
    headers: liveHeaders
  });
  const liveMixedNodeIds = new Set((Array.isArray(liveMixedTopology.body.nodes) ? liveMixedTopology.body.nodes : []).map((node) => node.id));
  expect(
    "knowledge:pbs-live-topology-single-graph-candidate",
    liveMixedTopology.response.status === 200 &&
      liveMixedTopology.body.provider === "pbs-http-live" &&
      liveMixedTopology.body.counts?.nodes === 2 &&
      liveMixedTopology.body.counts?.edges === 1 &&
      liveMixedNodeIds.has("pbs-mixed-note") &&
      liveMixedNodeIds.has("pbs-mixed-term") &&
      !liveMixedNodeIds.has("wrapper-noise-a") &&
      graphIntegrity(liveMixedTopology.body),
    "PBS live topology normalization derives nodes and edges from the same nested graph candidate",
    JSON.stringify(liveMixedTopology.body)
  );
  const liveLeakedTopology = await fetchJson(`${liveBase}/api/knowledge/topology?customer_id=scope-leak`, {
    headers: liveHeaders
  });
  expect(
    "knowledge:pbs-live-topology-scope-mismatch-blocked",
    liveLeakedTopology.response.status === 502 &&
      liveLeakedTopology.body.status === "error" &&
      liveLeakedTopology.body.code === "pbs-scope-mismatch" &&
      liveLeakedTopology.body.pbs?.scope_mismatches?.length >= 1,
    "PBS live topology rejects graph payloads outside the requested customer/owner scope",
    JSON.stringify(liveLeakedTopology.body)
  );
  const liveVault = await fetchJson(`${liveBase}/api/knowledge/wiki-vault?customer_id=live`, {
    headers: liveHeaders
  });
  expect(
    "knowledge:pbs-live-vault-topology-normalized",
      liveVault.response.status === 200 &&
      liveVault.body.provider === "pbs-http-live" &&
      liveVault.body.topology?.counts?.nodes === 6 &&
      liveVault.body.topology?.counts?.edges === 3 &&
      graphIntegrity(liveVault.body.topology),
    "PBS live wiki vault route exposes CAS-normalized topology even when PBS returns nested topology graph"
  );
  const liveStatus = await fetchJson(`${liveBase}/api/knowledge/wiki-loop/status?customer_id=live`, {
    headers: liveHeaders
  });
  expect(
    "knowledge:pbs-live-wiki-status",
    liveStatus.response.status === 200 && liveStatus.body.provider === "pbs-http-live" && liveStatus.body.compiled_wiki_ready === true,
    "PBS live wiki status is available through CAS route",
    JSON.stringify(liveStatus.body)
  );
  const liveNote = await fetchJson(`${liveBase}/api/knowledge/wiki-vault/notes`, {
    method: "POST",
    headers: liveHeaders,
    body: JSON.stringify({ customer_id: "live", title: "Live note", body: "Live [[router]] note" })
  });
  expect(
    "knowledge:pbs-live-note-preserved",
    liveNote.response.status === 200 &&
      liveNote.body.provider === "pbs-http-live" &&
      liveNote.body.overlay_id === "pbs-overlay-1" &&
      liveNote.body.payload?.wikilinks?.includes("HAProxy"),
    "PBS live note save response preserves PBS overlay fields",
    JSON.stringify(liveNote.body)
  );
  const liveUploadRecord = liveRecord("POST", "/api/uploads/ingest", (record) => record.body?.file_name === "live-runbook.txt");
  expect(
    "knowledge:pbs-live-upload-owner-contract",
    liveUploadRecord?.body?.created_by === liveOwnerHash &&
      liveUploadRecord?.body?.owner_user_id === liveOwnerHash &&
      liveUploadRecord?.body?.user_id === liveOwnerHash,
    "PBS live upload sends raw owner header and hashed owner payload"
  );
  const liveUrlRecord = liveRecord("POST", "/api/uploads/url-ingest", (record) => record.body?.url === "https://93.184.216.34/pbs-live-runbook");
  expect(
    "knowledge:pbs-live-url-owner-contract",
    liveUrlRecord?.body?.created_by === liveOwnerHash &&
      liveUrlRecord?.body?.owner_user_id === liveOwnerHash &&
      liveUrlRecord?.body?.user_id === liveOwnerHash,
    "PBS live URL ingest sends raw owner header and hashed owner payload"
  );
  const liveReportsRecord = liveRecord("GET", "/api/uploads/reports");
  expect(
    "knowledge:pbs-live-reports-owner-contract",
    liveReportsRecord?.query?.user_id === liveOwnerHash && liveReportsRecord?.query?.customer_id === "live",
    "PBS live upload reports sends raw owner header, hashed user_id query, and customer_id"
  );
  const liveChatRecord = liveRecord("POST", "/api/chat", (record) => record.body?.query === "router latency evidence");
  expect(
    "knowledge:pbs-live-chat-owner-contract",
    liveChatRecord?.body?.owner_user_id === liveOwnerHash && liveChatRecord?.body?.user_id === liveOwnerHash,
    "PBS live chat sends raw owner header and hashed chat owner payload"
  );
  const liveWikiRunRecord = liveRecord("POST", "/api/wiki-loop/run");
  expect(
    "knowledge:pbs-live-wiki-run-owner-contract",
    liveWikiRunRecord?.body?.user_id === liveOwnerHash && liveWikiRunRecord?.body?.once === true,
    "PBS live wiki-loop run sends raw owner header and hashed user_id payload"
  );
  const liveWikiVaultRecord = liveRecord("GET", "/api/wiki-vault");
  expect(
    "knowledge:pbs-live-wiki-vault-owner-contract",
    liveWikiVaultRecord?.query?.user_id === liveOwnerHash && liveWikiVaultRecord?.query?.customer_id === "live",
    "PBS live wiki-vault sends raw owner header, hashed user_id query, and customer_id"
  );
  const liveWikiStatusRecord = liveRecord("GET", "/api/wiki-loop/status");
  expect(
    "knowledge:pbs-live-wiki-status-owner-contract",
    liveWikiStatusRecord?.query?.user_id === liveOwnerHash && liveWikiStatusRecord?.query?.customer_id === "live",
    "PBS live wiki-loop status sends raw owner header, hashed user_id query, and customer_id"
  );
  const liveNoteRecord = liveRecord("POST", "/api/wiki-vault/notes", (record) => record.body?.title === "Live note");
  expect(
    "knowledge:pbs-live-note-owner-contract",
    liveNoteRecord?.body?.user_id === liveOwnerHash,
    "PBS live note save sends raw owner header and hashed user_id payload"
  );
  const unauthenticatedPbsRecords = fakePbs.records.filter(
    (record) => record.path.startsWith("/api/") && record.headers?.authorization !== `Bearer ${verifyPbsBearerToken}`
  );
  expect(
    "knowledge:pbs-http-bearer-auth-contract",
    fakePbs.records.length > 0 && unauthenticatedPbsRecords.length === 0,
    "PBS shadow/live providers send bearer auth on every PBS API request",
    JSON.stringify(unauthenticatedPbsRecords)
  );
} catch (error) {
  fail("knowledge:pbs-provider-smoke", error instanceof Error ? error.message : "unknown PBS provider smoke failure");
} finally {
  fakePbs.server.close();
  await stopChildren();
  await rm(shadowDataDir, { recursive: true, force: true });
  await rm(liveDataDir, { recursive: true, force: true });
  await rm(degradedLiveDataDir, { recursive: true, force: true });
  await rm(staleIndexLiveDataDir, { recursive: true, force: true });
}

const failures = checks.filter((check) => check.status === "FAIL");
if (failures.length > 0) {
  console.error(`Knowledge engine verification failed with ${failures.length} failures.`);
  process.exitCode = 1;
} else {
  console.log(`Knowledge engine verification passed with ${checks.length} checks.`);
}
