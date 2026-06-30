import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const defaultApiUrl = "https://kubernetes.default.svc";
const defaultTimeoutMs = 3000;
const defaultCacheTtlMs = 5 * 60 * 1000;

export function getOwnerIdentityConfig(env = process.env) {
  const evidenceProvider = env.CAS_EVIDENCE_PROVIDER ?? "openshift-api";
  const mode = String(
    env.CAS_KNOWLEDGE_OWNER_IDENTITY_MODE ??
      (evidenceProvider === "openshift-api" ? "openshift-selfsubjectreview" : "token-hash")
  )
    .trim()
    .toLowerCase();
  const timeoutMs = Number(env.CAS_KNOWLEDGE_OWNER_IDENTITY_TIMEOUT_MS ?? env.CAS_EVIDENCE_TIMEOUT_MS ?? defaultTimeoutMs);
  const cacheTtlMs = Number(env.CAS_KNOWLEDGE_OWNER_IDENTITY_CACHE_TTL_MS ?? defaultCacheTtlMs);
  return {
    mode,
    apiUrl: String(env.CAS_OPENSHIFT_API_URL ?? defaultApiUrl).replace(/\/+$/, ""),
    caFile: String(env.CAS_OPENSHIFT_API_CA_FILE ?? "").trim(),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTimeoutMs,
    tlsInsecure: env.CAS_OPENSHIFT_API_TLS_INSECURE === "true",
    cacheTtlMs: Number.isFinite(cacheTtlMs) && cacheTtlMs >= 0 ? cacheTtlMs : defaultCacheTtlMs
  };
}

export function bearerTokenFromAuthorization(authorization) {
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  const match = String(value ?? "").match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

export function stableOwnerFromAuthorization(authorization) {
  const token = bearerTokenFromAuthorization(authorization);
  if (!token) return "";
  return `token-${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
}

export function stableOwnerFromVerifiedUser(identity = {}) {
  const uid = String(identity.uid ?? "").trim();
  const username = String(identity.username ?? identity.userName ?? "").trim();
  const subject = uid ? `uid:${uid}` : username ? `username:${username}` : "";
  if (!subject) return "";
  return `k8s-user-${createHash("sha256").update(subject).digest("hex").slice(0, 32)}`;
}

export function stableOwnerFromOpenShiftUser(userName) {
  return stableOwnerFromVerifiedUser({ username: userName });
}

function tokenCacheKey(token, config) {
  return `${config.apiUrl}|${createHash("sha256").update(token).digest("hex")}`;
}

function requestText(url, options = {}) {
  const target = new URL(url);
  const isHttps = target.protocol === "https:";
  const transport = isHttps ? httpsRequest : httpRequest;
  const body = options.body ? Buffer.from(String(options.body), "utf8") : undefined;
  const ca = isHttps && !options.tlsInsecure && options.caFile ? readFileSync(options.caFile) : undefined;

  return new Promise((resolve, reject) => {
    const request = transport(
      target,
      {
        method: options.method ?? "GET",
        headers: options.headers ?? {},
        ca,
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
      request.destroy(new Error(`OpenShift user identity request timed out after ${options.timeoutMs}ms`));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

export async function resolveOpenShiftUserIdentity(authorization, options = {}) {
  const config = options.config ?? getOwnerIdentityConfig();
  const token = bearerTokenFromAuthorization(authorization);
  if (!token) {
    return { ok: false, provider: "openshift-selfsubjectreview", reason: "missing bearer token" };
  }

  const cache = options.cache;
  const cacheKey = cache ? tokenCacheKey(token, config) : "";
  const cached = cacheKey ? cache.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.value, cached: true };
  }

  const transport = options.transport ?? requestText;
  const url = new URL("/apis/authentication.k8s.io/v1/selfsubjectreviews", `${config.apiUrl}/`).toString();
  const response = await transport(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      apiVersion: "authentication.k8s.io/v1",
      kind: "SelfSubjectReview"
    }),
    timeoutMs: config.timeoutMs,
    caFile: config.caFile,
    tlsInsecure: config.tlsInsecure
  });

  let body;
  try {
    body = response.body ? JSON.parse(response.body) : undefined;
  } catch {
    body = undefined;
  }

  const userInfo = body?.status?.userInfo ?? {};
  const username = String(userInfo.username ?? "").trim();
  const uid = String(userInfo.uid ?? "").trim();
  if (response.statusCode >= 200 && response.statusCode < 300 && username) {
    const value = {
      ok: true,
      provider: "openshift-selfsubjectreview",
      username,
      uid,
      groups: Array.isArray(userInfo.groups) ? userInfo.groups : [],
      owner: stableOwnerFromVerifiedUser({ username, uid })
    };
    if (cacheKey && config.cacheTtlMs > 0) cache.set(cacheKey, { value, expiresAt: Date.now() + config.cacheTtlMs });
    return value;
  }

  return {
    ok: false,
    provider: "openshift-selfsubjectreview",
    statusCode: response.statusCode,
    reason: body?.message ?? `OpenShift SelfSubjectReview HTTP ${response.statusCode}`
  };
}

export async function resolveKnowledgeOwner(authorization, options = {}) {
  const config = options.config ?? getOwnerIdentityConfig();
  if (config.mode === "token-hash") {
    const owner = stableOwnerFromAuthorization(authorization);
    return owner ? { ok: true, provider: "token-hash", owner } : { ok: false, provider: "token-hash", reason: "missing bearer token" };
  }
  if (["openshift-selfsubjectreview", "kubernetes-selfsubjectreview", "openshift-user"].includes(config.mode)) {
    return resolveOpenShiftUserIdentity(authorization, options);
  }
  return {
    ok: false,
    provider: config.mode || "unknown",
    reason: `unsupported CAS_KNOWLEDGE_OWNER_IDENTITY_MODE ${config.mode || "empty"}`
  };
}
