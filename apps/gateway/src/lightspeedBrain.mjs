import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  PRODUCT,
  assertReadOnlyToolPlan,
  createEvidenceBundle,
  createRcaResult,
  createToolPlan
} from "../../../packages/contracts/src/index.js";
import { createMockOomKilledRun } from "./mockRca.mjs";

const defaultLightspeedUrl = "https://lightspeed-app-server.openshift-lightspeed.svc.cluster.local:8443";

export function getBrainConfig(env = process.env) {
  return {
    provider: env.CAS_BRAIN_PROVIDER ?? "mock",
    lightspeedUrl: (env.CAS_LIGHTSPEED_URL ?? defaultLightspeedUrl).replace(/\/+$/, ""),
    timeoutMs: Number(env.CAS_LIGHTSPEED_TIMEOUT_MS ?? 90000),
    tlsInsecure: env.CAS_LIGHTSPEED_TLS_INSECURE === "true"
  };
}

function getTarget(input = {}) {
  return {
    namespace: input.scope?.namespaces?.[0] ?? input.namespace ?? input.resourceRef?.namespace ?? "default",
    kind: input.resourceRef?.kind ?? "Pod",
    name: input.resourceRef?.name ?? "api-7c8d9"
  };
}

function buildQuery(input = {}) {
  const question = String(input.question ?? "OpenShift cluster 상태를 요약해줘.");
  const target = getTarget(input);
  const context = [
    "You are Cywell AI Sentinel, a read-only OpenShift operations assistant.",
    "Do not propose destructive actions. Prefer evidence, RCA hypotheses, and safe next checks.",
    `Target resource: ${target.namespace}/${target.kind}/${target.name}.`,
    `Locale: ${input.locale ?? "ko-KR"}.`
  ].join("\n");
  const evidenceContext = input.cas_evidence_context ? `\n\nCAS evidence context:\n${input.cas_evidence_context}` : "";
  return `Context:\n${context}${evidenceContext}\n\nQuestion:\n${question}`;
}

export function buildLightspeedPayload(input = {}) {
  return {
    attachments: [],
    conversation_id: input.conversation_id,
    media_type: "application/json",
    mode: input.mode === "troubleshooting" ? "troubleshooting" : "ask",
    query: buildQuery(input)
  };
}

export function parseLightspeedStream(text = "") {
  const events = [];
  let answer = "";
  let conversationId;
  let references = [];
  let truncated = false;
  const tools = [];

  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    const raw = line.slice(6).trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      events.push(parsed);
      if (parsed.event === "start") {
        conversationId = parsed.data?.conversation_id ?? conversationId;
      }
      if (parsed.event === "token") {
        answer += parsed.data?.token ?? "";
      }
      if (parsed.event === "end") {
        references = parsed.data?.referenced_documents ?? references;
        truncated = parsed.data?.truncated === true;
      }
      if (parsed.event === "tool_call") {
        tools.push(parsed.data);
      }
    } catch {
      events.push({ event: "parse_error", raw });
    }
  }

  if (!answer.trim()) {
    try {
      const parsed = JSON.parse(text);
      answer = parsed.answer ?? parsed.response ?? parsed.message ?? "";
      conversationId = parsed.conversation_id ?? conversationId;
      references = parsed.referenced_documents ?? references;
    } catch {
      // Keep the empty answer. The caller will classify it as an invalid brain response.
    }
  }

  return {
    answer: answer.trim(),
    conversationId,
    references: Array.isArray(references) ? references : [],
    tools,
    truncated,
    eventCount: events.length
  };
}

function requestText(url, options) {
  const target = new URL(url);
  const isHttps = target.protocol === "https:";
  const body = options.body ?? "";
  const transport = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const request = transport(
      target,
      {
        method: options.method ?? "GET",
        headers: {
          ...options.headers,
          "content-length": Buffer.byteLength(body)
        },
        rejectUnauthorized: isHttps ? !options.tlsInsecure : undefined,
        timeout: options.timeoutMs
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error(`request timed out after ${options.timeoutMs}ms`));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

export async function queryLightspeed(input = {}, options = {}) {
  const config = options.config ?? getBrainConfig();
  const authorization = options.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    throw new Error("missing user bearer token for Lightspeed UserToken forwarding");
  }

  const payload = buildLightspeedPayload(input);
  const body = JSON.stringify(payload);
  const transport = options.transport ?? requestText;
  const response = await transport(`${config.lightspeedUrl}/v1/streaming_query`, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      accept: "text/event-stream"
    },
    body,
    timeoutMs: config.timeoutMs,
    tlsInsecure: config.tlsInsecure
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Lightspeed streaming_query returned HTTP ${response.statusCode}`);
  }

  const parsed = parseLightspeedStream(response.body);
  if (!parsed.answer) {
    throw new Error("Lightspeed returned an empty answer");
  }

  return {
    ...parsed,
    payloadMode: payload.mode
  };
}

function referenceEvidence(references = []) {
  return references.slice(0, 5).map((reference, index) => ({
    id: `lightspeed:reference:${index + 1}`,
    type: "rag_reference",
    summary: reference.doc_title ?? reference.title ?? reference.url ?? "Lightspeed reference",
    source: reference.doc_url ?? reference.url ?? "openshift-lightspeed.reference",
    observed_at: new Date().toISOString()
  }));
}

function collectedEvidence(input = {}) {
  return Array.isArray(input.cas_evidence?.evidence) ? input.cas_evidence.evidence : [];
}

function collectedMissing(input = {}) {
  return Array.isArray(input.cas_evidence?.missing) ? input.cas_evidence.missing : [];
}

function mergeCollectedEvidence(run, input = {}) {
  const evidence = collectedEvidence(input);
  const missing = collectedMissing(input);
  if (!run.evidence_bundle) return run;
  run.evidence_bundle.evidence = [...evidence, ...(run.evidence_bundle.evidence ?? [])];
  run.evidence_bundle.missing = [...missing, ...(run.evidence_bundle.missing ?? [])];
  run.audit = {
    ...(run.audit ?? {}),
    evidence: {
      provider: input.cas_evidence?.provider ?? "none",
      collected_count: evidence.length,
      missing_count: missing.length
    }
  };
  return run;
}

export function createLightspeedRun(input = {}, lightspeedResult = {}) {
  const target = getTarget(input);
  const runId = `cas-lightspeed-${Date.now()}`;
  const toolPlan = createToolPlan({
    task_type: "lightspeed_assisted_rca",
    target: {
      platform: "openshift",
      ...target
    }
  });
  const guard = assertReadOnlyToolPlan(toolPlan);

  const openShiftEvidence = collectedEvidence(input);
  const openShiftMissing = collectedMissing(input);
  const evidence = [
    ...openShiftEvidence,
    {
      id: "lightspeed:answer",
      type: "llm_answer",
      summary: "OpenShift Lightspeed returned a streamed answer through /v1/streaming_query",
      source: "openshift-lightspeed.v1.streaming_query",
      observed_at: new Date().toISOString()
    },
    ...referenceEvidence(lightspeedResult.references)
  ];

  const evidenceBundle = createEvidenceBundle({
    run_id: runId,
    target,
    evidence,
    missing: openShiftMissing
  });
  const causeEvidenceRefs = ["lightspeed:answer", ...openShiftEvidence.slice(0, 4).map((item) => item.id)];

  const rcaResult = createRcaResult({
    cause_candidates: [
      {
        cause: "openshift lightspeed generated operational analysis",
        confidence: 0.72,
        evidence_refs: causeEvidenceRefs
      }
    ],
    answer: lightspeedResult.answer
  });

  return {
    product: PRODUCT.officialName,
    mode: "lightspeed_read_only",
    run_id: runId,
    question: String(input.question ?? ""),
    conversation_id: lightspeedResult.conversationId ?? input.conversation_id ?? null,
    guardrail: {
      read_only: guard.ok,
      violations: guard.violations
    },
    tool_plan: toolPlan,
    evidence_bundle: evidenceBundle,
    rca_result: rcaResult,
    audit: {
      audit_id: `audit-${runId}`,
      auth_mode: "user-token-forwarded",
      answer_provider: "openshift-lightspeed",
      brain: {
        provider: "openshift-lightspeed",
        endpoint: "/v1/streaming_query",
        status: "ok",
        event_count: lightspeedResult.eventCount,
        tool_call_count: lightspeedResult.tools?.length ?? 0,
        truncated: lightspeedResult.truncated === true
      },
      evidence: {
        provider: input.cas_evidence?.provider ?? "none",
        collected_count: openShiftEvidence.length,
        missing_count: openShiftMissing.length
      },
      response_schema_valid: true,
      redaction_applied: true
    }
  };
}

export function createLightspeedFallbackRun(input = {}, error) {
  const run = createMockOomKilledRun(input);
  run.mode = "lightspeed_fallback_mock";
  run.rca_result.answer =
    `Lightspeed brain 연결에 실패해 mock RCA로 폴백했습니다. 원인: ${error?.message ?? "unknown"}. ` +
    run.rca_result.answer;
  run.evidence_bundle.missing = [
    ...(run.evidence_bundle.missing ?? []),
    {
      type: "lightspeed_brain",
      reason: error?.message ?? "Lightspeed brain unavailable"
    }
  ];
  run.audit.auth_mode = "user-token-forwarded-or-missing";
  run.audit.answer_provider = "mock-fallback";
  run.audit.brain = {
    provider: "openshift-lightspeed",
    endpoint: "/v1/streaming_query",
    status: "fallback",
    error: error?.message ?? "unknown"
  };
  return mergeCollectedEvidence(run, input);
}

export async function createLightspeedBackedRun(input = {}, options = {}) {
  try {
    const lightspeedResult = await queryLightspeed(input, options);
    return createLightspeedRun(input, lightspeedResult);
  } catch (error) {
    return createLightspeedFallbackRun(input, error);
  }
}

export async function checkLightspeedReadiness(options = {}) {
  const config = options.config ?? getBrainConfig();
  const transport = options.transport ?? requestText;
  try {
    const response = await transport(`${config.lightspeedUrl}/readiness`, {
      method: "GET",
      headers: {
        accept: "application/json"
      },
      timeoutMs: Math.min(config.timeoutMs, 15000),
      tlsInsecure: config.tlsInsecure
    });
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      statusCode: response.statusCode,
      provider: config.provider,
      endpoint: "/readiness"
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 0,
      provider: config.provider,
      endpoint: "/readiness",
      error: error?.message ?? "unknown readiness error"
    };
  }
}
