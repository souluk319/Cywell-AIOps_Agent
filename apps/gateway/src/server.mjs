import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { PRODUCT } from "../../../packages/contracts/src/index.js";
import { createMockOomKilledRun } from "./mockRca.mjs";
import { checkLightspeedReadiness, createLightspeedBackedRun, getBrainConfig } from "./lightspeedBrain.mjs";
import { collectOpenShiftOverview, collectOpenShiftTargets, enrichInputWithOpenShiftEvidence, getEvidenceConfig } from "./openshiftEvidence.mjs";
import { getMetricConfig } from "./metricAdapter.mjs";
import { getRunbookConfig } from "./runbookAdapter.mjs";
import { enrichInputWithSimulation, listSimulationScenarios } from "./simulationLab.mjs";

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";
const tlsCertFile = process.env.CAS_TLS_CERT_FILE;
const tlsKeyFile = process.env.CAS_TLS_KEY_FILE;
const brainConfig = getBrainConfig();
const evidenceConfig = getEvidenceConfig();
const metricConfig = getMetricConfig();
const runbookConfig = getRunbookConfig();

function loadTlsOptions() {
  if (!tlsCertFile || !tlsKeyFile) return undefined;
  if (!existsSync(tlsCertFile) || !existsSync(tlsKeyFile)) return undefined;
  return {
    cert: readFileSync(tlsCertFile),
    key: readFileSync(tlsKeyFile)
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  return JSON.parse(text);
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

function writeSseHeaders(response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
}

function writeSseEvent(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function answerChunks(answer = "") {
  const text = String(answer);
  if (!text) return [];
  const chunks = [];
  for (let index = 0; index < text.length; index += 28) {
    chunks.push(text.slice(index, index + 28));
  }
  return chunks;
}

function streamRun(response, run) {
  writeSseEvent(response, "tool_plan", run.tool_plan ?? null);
  writeSseEvent(response, "evidence", run.evidence_bundle ?? null);
  for (const token of answerChunks(run.rca_result?.answer ?? "")) {
    writeSseEvent(response, "token", { token });
  }
  writeSseEvent(response, "final_answer", run);
}

function routeMissing(response) {
  sendJson(response, 404, {
    code: "route-missing",
    error: "route missing"
  });
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
        metric_provider: metricConfig.provider,
        runbook_provider: runbookConfig.provider
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

    if (request.method === "GET" && url.pathname === "/api/aiops/overview") {
      const namespace = url.searchParams.get("namespace") || "default";
      const overview = await collectOpenShiftOverview(
        {
          scope: {
            cluster: "local-cluster",
            namespaces: [namespace]
          }
        },
        {
          authorization: request.headers.authorization,
          config: evidenceConfig,
          metricConfig,
          runbookConfig
        }
      );
      sendJson(response, 200, overview);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/aiops/targets") {
      const namespace = url.searchParams.get("namespace") || "default";
      const catalog = await collectOpenShiftTargets(
        {
          scope: {
            cluster: "local-cluster",
            namespaces: [namespace]
          }
        },
        {
          authorization: request.headers.authorization,
          config: evidenceConfig
        }
      );
      sendJson(response, 200, catalog);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/aiops/simulations") {
      sendJson(response, 200, {
        product: PRODUCT.officialName,
        mode: "simulation_catalog",
        ...listSimulationScenarios()
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/aiops/query") {
      const body = await readJson(request);
      const wantsStream =
        body.stream === true ||
        String(request.headers.accept ?? "").includes("text/event-stream") ||
        url.searchParams.get("stream") === "true";

      if (wantsStream) {
        writeSseHeaders(response);
        try {
          writeSseEvent(response, "status", {
            stage: "evidence",
            message: body.locale === "en-US" ? "Checking data" : "자료 확인 중"
          });
          const enrichedBody =
            body.simulation_id
              ? await enrichInputWithSimulation(body, {
                  authorization: request.headers.authorization
                })
              : evidenceConfig.provider === "none"
              ? body
              : await enrichInputWithOpenShiftEvidence(body, {
                  authorization: request.headers.authorization,
                  config: evidenceConfig,
                  metricConfig,
                  runbookConfig
                });
          if (enrichedBody.cas_evidence) {
            writeSseEvent(response, "evidence", enrichedBody.cas_evidence);
          }
          writeSseEvent(response, "status", {
            stage: "brain",
            message: body.locale === "en-US" ? "Writing answer" : "답변 작성 중"
          });
          const run =
            brainConfig.provider === "openshift-lightspeed"
              ? await createLightspeedBackedRun(enrichedBody, {
                  authorization: request.headers.authorization,
                  config: brainConfig
                })
              : createMockOomKilledRun(enrichedBody);
          streamRun(response, run);
        } catch (error) {
          writeSseEvent(response, "error", {
            error: error instanceof Error ? error.message : "unknown stream error"
          });
        } finally {
          response.end();
        }
        return;
      }

      const enrichedBody =
        body.simulation_id
          ? await enrichInputWithSimulation(body, {
              authorization: request.headers.authorization
            })
          : evidenceConfig.provider === "none"
          ? body
          : await enrichInputWithOpenShiftEvidence(body, {
              authorization: request.headers.authorization,
              config: evidenceConfig,
              metricConfig,
              runbookConfig
            });
      const run =
        brainConfig.provider === "openshift-lightspeed"
          ? await createLightspeedBackedRun(enrichedBody, {
              authorization: request.headers.authorization,
              config: brainConfig
            })
          : createMockOomKilledRun(enrichedBody);
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
