import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { PRODUCT } from "../../../packages/contracts/src/index.js";
import { createMockOomKilledRun, streamMockRun } from "./mockRca.mjs";
import { checkLightspeedReadiness, createLightspeedBackedRun, getBrainConfig } from "./lightspeedBrain.mjs";
import {
  buildKnowledgeCapabilities,
  buildKnowledgeHealth,
  buildKnowledgeUnavailable,
  getKnowledgeConfig
} from "./knowledgeFacade.mjs";
import { getOwnerIdentityConfig, resolveKnowledgeOwner } from "./ownerIdentity.mjs";
import { enrichInputWithOpenShiftEvidence, getEvidenceConfig } from "./openshiftEvidence.mjs";

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";
const tlsCertFile = process.env.CAS_TLS_CERT_FILE;
const tlsKeyFile = process.env.CAS_TLS_KEY_FILE;
const brainConfig = getBrainConfig();
const evidenceConfig = getEvidenceConfig();
const knowledgeConfig = getKnowledgeConfig();
const ownerIdentityConfig = getOwnerIdentityConfig();
const ownerIdentityCache = new Map();
const maxRequestBytes = Number(process.env.CAS_MAX_REQUEST_BYTES ?? 25 * 1024 * 1024);

function loadTlsOptions() {
  if (!tlsCertFile || !tlsKeyFile) return undefined;
  if (!existsSync(tlsCertFile) || !existsSync(tlsKeyFile)) return undefined;
  return {
    cert: readFileSync(tlsCertFile),
    key: readFileSync(tlsKeyFile)
  };
}

async function readJson(request) {
  const text = (await readBody(request)).toString("utf8");
  if (!text) return {};
  return JSON.parse(text);
}

async function readBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxRequestBytes) {
      throw new Error(`request body exceeds CAS_MAX_REQUEST_BYTES (${maxRequestBytes})`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "authorization,content-type",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function sendProxy(response, statusCode, headers, body) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "authorization,content-type",
    "Content-Type": headers.get("content-type") ?? "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function routeMissing(response) {
  sendJson(response, 404, {
    code: "route-missing",
    error: "route missing"
  });
}

function publicKnowledgeRoute(pathname) {
  return pathname === "/api/knowledge/healthz" || pathname === "/api/knowledge/capabilities";
}

async function resolveOwnerForKnowledge(request) {
  try {
    return await resolveKnowledgeOwner(request.headers.authorization, {
      config: ownerIdentityConfig,
      cache: ownerIdentityCache
    });
  } catch (error) {
    return {
      ok: false,
      provider: ownerIdentityConfig.mode,
      statusCode: 503,
      reason: error instanceof Error ? error.message : "knowledge owner identity verifier unavailable"
    };
  }
}

function sendOwnerFailure(response, ownerResult) {
  const statusCode = Number(ownerResult?.statusCode ?? 0);
  const unavailable = statusCode >= 500 || ownerResult?.reason?.toLowerCase?.().includes("timed out");
  sendJson(response, unavailable ? 503 : 401, {
    code: unavailable ? "knowledge-owner-verifier-unavailable" : "knowledge-owner-unverified",
    status: "error",
    service: "cas-knowledge-facade",
    owner_identity_provider: ownerResult?.provider ?? ownerIdentityConfig.mode,
    reason: ownerResult?.reason ?? "knowledge owner identity could not be verified"
  });
}

function parseJsonBuffer(buffer) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return {};
  }
}

function sanitizedKnowledgeHealth(body = {}, statusCode = 200) {
  const upstreamOk = statusCode >= 200 && statusCode < 300;
  const status = String(body.status ?? (upstreamOk ? "ok" : "degraded"));
  const proxiedEngine = body.service === "cas-knowledge-engine";
  return {
    status,
    service: proxiedEngine ? "cas-knowledge-engine" : "cas-knowledge-facade",
    version: body.version ?? "0.1.4",
    provider: proxiedEngine ? (body.provider ?? knowledgeConfig.provider) : knowledgeConfig.provider,
    engine: {
      provider: knowledgeConfig.provider,
      status: status === "ok" ? "ready" : "degraded"
    },
    capabilities: Array.isArray(body.capabilities) ? body.capabilities : buildKnowledgeCapabilities()
  };
}

async function sendKnowledgeHealth(response) {
  if (!knowledgeConfig.engineUrl) {
    sendJson(
      response,
      503,
      sanitizedKnowledgeHealth(
        buildKnowledgeHealth({
          config: knowledgeConfig,
          product: PRODUCT.officialName
        }),
        503
      )
    );
    return;
  }

  const targetUrl = `${knowledgeConfig.engineUrl}/api/knowledge/healthz`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), knowledgeConfig.timeoutMs);
  try {
    const upstream = await fetch(targetUrl, {
      method: "GET",
      headers: {
        accept: "application/json"
      },
      signal: controller.signal
    });
    const upstreamBody = Buffer.from(await upstream.arrayBuffer());
    sendJson(response, upstream.status, sanitizedKnowledgeHealth(parseJsonBuffer(upstreamBody), upstream.status));
  } catch (error) {
    sendJson(response, 502, {
      code: "knowledge-engine-unavailable",
      status: "degraded",
      service: "cas-knowledge-facade",
      route: "/api/knowledge/healthz",
      engine: {
        provider: knowledgeConfig.provider,
        status: "unavailable"
      },
      error: error instanceof Error ? error.message : "unknown knowledge engine health error"
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function proxyKnowledgeRequest(request, response, url) {
  if (!knowledgeConfig.engineUrl) {
    sendJson(response, 501, buildKnowledgeUnavailable(url.pathname, { config: knowledgeConfig }));
    return;
  }

  const targetUrl = `${knowledgeConfig.engineUrl}${url.pathname}${url.search}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), knowledgeConfig.timeoutMs);
  try {
    const ownerResult = publicKnowledgeRoute(url.pathname) ? { ok: true, owner: "" } : await resolveOwnerForKnowledge(request);
    if (!ownerResult.ok) {
      sendOwnerFailure(response, ownerResult);
      return;
    }
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request);
    const scopedOwner = ownerResult.owner ?? "";
    const ownerHeaders = scopedOwner ? { "x-forwarded-user": scopedOwner } : {};
    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers: {
        accept: request.headers.accept ?? "application/json",
        "content-type": request.headers["content-type"] ?? "application/json",
        ...ownerHeaders
      },
      body,
      signal: controller.signal
    });
    const upstreamBody = Buffer.from(await upstream.arrayBuffer());
    sendProxy(response, upstream.status, upstream.headers, upstreamBody);
  } catch (error) {
    const publicRoute = publicKnowledgeRoute(url.pathname);
    sendJson(response, 502, {
      code: "knowledge-engine-unavailable",
      status: "degraded",
      service: "cas-knowledge-facade",
      route: url.pathname,
      engine: {
        provider: knowledgeConfig.provider,
        status: "unavailable",
        ...(publicRoute ? {} : { endpoint: knowledgeConfig.engineUrl, timeout_ms: knowledgeConfig.timeoutMs })
      },
      error: error instanceof Error ? error.message : "unknown knowledge engine proxy error"
    });
  } finally {
    clearTimeout(timeout);
  }
}

const requestHandler = async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

    if (request.method === "OPTIONS") {
      sendJson(response, 204, {});
      return;
    }

    if (request.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/api/aiops/healthz")) {
      sendJson(response, 200, {
        status: "ok",
        service: "cas-gateway",
        product: PRODUCT.officialName,
        mode: brainConfig.provider === "openshift-lightspeed" ? "lightspeed_read_only" : "mock_read_only",
        brain_provider: brainConfig.provider,
        evidence_provider: evidenceConfig.provider,
        knowledge_owner_identity_mode: ownerIdentityConfig.mode
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/aiops/brainz") {
      const readiness =
        brainConfig.provider === "openshift-lightspeed"
          ? await checkLightspeedReadiness({ config: brainConfig })
          : { ok: true, provider: "mock", endpoint: "local" };
      sendJson(response, readiness.ok ? 200 : 503, {
        status: readiness.ok ? "ok" : "degraded",
        service: "cas-gateway",
        product: PRODUCT.officialName,
        brain: readiness
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/knowledge/healthz") {
      await sendKnowledgeHealth(response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/knowledge/capabilities") {
      if (knowledgeConfig.engineUrl) {
        await proxyKnowledgeRequest(request, response, url);
      } else {
        sendJson(response, 200, {
          status: "ok",
          service: "cas-knowledge-facade",
          capabilities: buildKnowledgeCapabilities()
        });
      }
      return;
    }

    if (url.pathname.startsWith("/api/knowledge/")) {
      await proxyKnowledgeRequest(request, response, url);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/aiops/query") {
      const body = await readJson(request);
      const enrichedBody =
        evidenceConfig.provider === "none"
          ? body
          : await enrichInputWithOpenShiftEvidence(body, {
              authorization: request.headers.authorization,
              config: evidenceConfig
            });
      const run =
        brainConfig.provider === "openshift-lightspeed"
          ? await createLightspeedBackedRun(enrichedBody, {
              authorization: request.headers.authorization,
              config: brainConfig
            })
          : createMockOomKilledRun(enrichedBody);
      const wantsStream =
        body.stream === true ||
        String(request.headers.accept ?? "").includes("text/event-stream") ||
        url.searchParams.get("stream") === "true";
      if (wantsStream) {
        streamMockRun(response, run);
        return;
      }
      sendJson(response, 200, run);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/aiops/feedback") {
      const body = await readJson(request);
      sendJson(response, 202, {
        status: "accepted",
        feedback_id: `feedback-${Date.now()}`,
        run_id: body.run_id ?? null,
        note: "feedback is accepted in mock mode and will be persisted when audit storage is added"
      });
      return;
    }

    routeMissing(response);
  } catch (error) {
    sendJson(response, 400, {
      code: "bad-request",
      error: error instanceof Error ? error.message : "unknown request error"
    });
  }
};

const tlsOptions = loadTlsOptions();
const server = tlsOptions ? createHttpsServer(tlsOptions, requestHandler) : createHttpServer(requestHandler);

server.listen(port, host, () => {
  const scheme = tlsOptions ? "https" : "http";
  console.log(`CAS Gateway listening on ${scheme}://${host}:${port}`);
});
