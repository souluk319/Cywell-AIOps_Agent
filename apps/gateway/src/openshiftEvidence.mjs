import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const defaultApiUrl = "https://kubernetes.default.svc";
const defaultTimeoutMs = 8000;

export function getEvidenceConfig(env = process.env) {
  return {
    provider: env.CAS_EVIDENCE_PROVIDER ?? "openshift-api",
    apiUrl: (env.CAS_OPENSHIFT_API_URL ?? defaultApiUrl).replace(/\/+$/, ""),
    timeoutMs: Number(env.CAS_EVIDENCE_TIMEOUT_MS ?? defaultTimeoutMs),
    tlsInsecure: env.CAS_OPENSHIFT_API_TLS_INSECURE === "true",
    logTailLines: Number(env.CAS_EVIDENCE_LOG_TAIL_LINES ?? 80)
  };
}

export function getEvidenceTarget(input = {}) {
  return {
    namespace: input.scope?.namespaces?.[0] ?? input.namespace ?? input.resourceRef?.namespace ?? "default",
    kind: input.resourceRef?.kind ?? "Pod",
    name: input.resourceRef?.name ?? "api-7c8d9"
  };
}

function requestText(url, options = {}) {
  const target = new URL(url);
  const isHttps = target.protocol === "https:";
  const transport = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const request = transport(
      target,
      {
        method: options.method ?? "GET",
        headers: options.headers ?? {},
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
      request.destroy(new Error(`OpenShift API request timed out after ${options.timeoutMs}ms`));
    });
    request.on("error", reject);
    request.end();
  });
}

function truncate(value, maxLength = 360) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function makeUrl(config, path) {
  return new URL(path, `${config.apiUrl}/`).toString();
}

async function kubeRequest(path, options = {}) {
  const config = options.config ?? getEvidenceConfig();
  const transport = options.transport ?? requestText;
  const response = await transport(makeUrl(config, path), {
    method: "GET",
    headers: {
      authorization: options.authorization,
      accept: options.accept ?? "application/json"
    },
    timeoutMs: config.timeoutMs,
    tlsInsecure: config.tlsInsecure
  });

  return response;
}

async function kubeJson(path, options = {}) {
  const response = await kubeRequest(path, options);
  let json;
  try {
    json = response.body ? JSON.parse(response.body) : undefined;
  } catch {
    json = undefined;
  }
  return {
    ...response,
    json
  };
}

function eventTime(event = {}) {
  return event.eventTime ?? event.lastTimestamp ?? event.firstTimestamp ?? event.metadata?.creationTimestamp ?? "";
}

function summarizeConditions(conditions = []) {
  return conditions
    .filter((condition) => ["Available", "Progressing", "Degraded"].includes(condition.type))
    .map((condition) => `${condition.type}=${condition.status}`)
    .join(", ");
}

function summarizePod(pod = {}) {
  const statuses = pod.status?.containerStatuses ?? [];
  const restartSummary = statuses
    .map((status) => `${status.name}:restarts=${status.restartCount ?? 0}`)
    .join(", ");
  const stateSummary = statuses
    .map((status) => {
      const state = Object.keys(status.state ?? {})[0] ?? "unknown";
      const last = status.lastState?.terminated?.reason ? ` last=${status.lastState.terminated.reason}` : "";
      return `${status.name}:${state}${last}`;
    })
    .join(", ");
  return truncate(
    `Pod phase=${pod.status?.phase ?? "unknown"} node=${pod.spec?.nodeName ?? "unassigned"} restarts=[${restartSummary || "none"}] states=[${stateSummary || "none"}]`
  );
}

function summarizeDeployment(deployment = {}) {
  const status = deployment.status ?? {};
  return truncate(
    `Deployment replicas=${status.replicas ?? 0} ready=${status.readyReplicas ?? 0} updated=${status.updatedReplicas ?? 0} available=${status.availableReplicas ?? 0}`
  );
}

function summarizeClusterVersion(clusterVersion = {}) {
  const status = clusterVersion.status ?? {};
  const desired = status.desired?.version ?? status.history?.find((item) => item.state === "Completed")?.version ?? "unknown";
  return truncate(`ClusterVersion desired=${desired} conditions=[${summarizeConditions(status.conditions) || "none"}]`);
}

function evidenceItem(id, type, summary, source) {
  return {
    id,
    type,
    summary: truncate(summary),
    source,
    observed_at: new Date().toISOString()
  };
}

function missingItem(type, reason) {
  return {
    type,
    reason: truncate(reason, 240)
  };
}

async function captureJson(collection, id, type, source, path, options, summarize) {
  try {
    const response = await kubeJson(path, options);
    if (response.statusCode >= 200 && response.statusCode < 300 && response.json) {
      collection.evidence.push(evidenceItem(id, type, summarize(response.json), source));
      return response.json;
    }
    collection.missing.push(missingItem(type, `OpenShift API HTTP ${response.statusCode} for ${source}`));
  } catch (error) {
    collection.missing.push(missingItem(type, error?.message ?? `OpenShift API error for ${source}`));
  }
  return undefined;
}

async function collectNamespaceEvidence(collection, target, options) {
  await captureJson(
    collection,
    `openshift:namespace:${target.namespace}`,
    "namespace",
    `api/v1/namespaces/${target.namespace}`,
    `/api/v1/namespaces/${encodeURIComponent(target.namespace)}`,
    options,
    (namespace) => `Namespace phase=${namespace.status?.phase ?? "unknown"} name=${namespace.metadata?.name ?? target.namespace}`
  );
}

async function collectClusterVersionEvidence(collection, target, options) {
  const name = target.name || "version";
  await captureJson(
    collection,
    `openshift:clusterversion:${name}`,
    "clusterversion",
    `apis/config.openshift.io/v1/clusterversions/${name}`,
    `/apis/config.openshift.io/v1/clusterversions/${encodeURIComponent(name)}`,
    options,
    summarizeClusterVersion
  );
}

async function collectPodEvidence(collection, target, options) {
  const namespacePath = encodeURIComponent(target.namespace);
  const podPath = encodeURIComponent(target.name);
  const pod = await captureJson(
    collection,
    `openshift:pod:${target.namespace}:${target.name}`,
    "pod",
    `api/v1/namespaces/${target.namespace}/pods/${target.name}`,
    `/api/v1/namespaces/${namespacePath}/pods/${podPath}`,
    options,
    summarizePod
  );

  const eventSelector = new URLSearchParams({
    fieldSelector: `involvedObject.kind=Pod,involvedObject.name=${target.name}`,
    limit: "12"
  });
  await captureJson(
    collection,
    `openshift:events:${target.namespace}:${target.name}`,
    "event",
    `api/v1/namespaces/${target.namespace}/events`,
    `/api/v1/namespaces/${namespacePath}/events?${eventSelector.toString()}`,
    options,
    (events) => {
      const items = [...(events.items ?? [])]
        .sort((left, right) => eventTime(right).localeCompare(eventTime(left)))
        .slice(0, 5)
        .map((event) => `${event.reason ?? "Event"}:${event.message ?? ""}`);
      return `Recent pod events: ${items.length > 0 ? items.join(" | ") : "none"}`;
    }
  );

  const container =
    pod?.status?.containerStatuses?.find((status) => Number(status.restartCount ?? 0) > 0)?.name ??
    pod?.status?.containerStatuses?.[0]?.name ??
    pod?.spec?.containers?.[0]?.name;

  if (!container) {
    collection.missing.push(missingItem("pod_log", "pod container name unavailable for previous log collection"));
    return;
  }

  try {
    const logParams = new URLSearchParams({
      container,
      previous: "true",
      tailLines: String(options.config?.logTailLines ?? 80)
    });
    const response = await kubeRequest(`/api/v1/namespaces/${namespacePath}/pods/${podPath}/log?${logParams.toString()}`, {
      ...options,
      accept: "text/plain"
    });
    if (response.statusCode >= 200 && response.statusCode < 300) {
      collection.evidence.push(
        evidenceItem(
          `openshift:previous-log:${target.namespace}:${target.name}:${container}`,
          "pod_log",
          `Previous log tail for container ${container}: ${truncate(response.body, 500) || "empty"}`,
          `api/v1/namespaces/${target.namespace}/pods/${target.name}/log?previous=true`
        )
      );
      return;
    }
    collection.missing.push(missingItem("pod_log", `OpenShift API HTTP ${response.statusCode} for previous pod log`));
  } catch (error) {
    collection.missing.push(missingItem("pod_log", error?.message ?? "previous pod log unavailable"));
  }
}

async function collectDeploymentEvidence(collection, target, options) {
  await captureJson(
    collection,
    `openshift:deployment:${target.namespace}:${target.name}`,
    "deployment",
    `apis/apps/v1/namespaces/${target.namespace}/deployments/${target.name}`,
    `/apis/apps/v1/namespaces/${encodeURIComponent(target.namespace)}/deployments/${encodeURIComponent(target.name)}`,
    options,
    summarizeDeployment
  );
}

export async function collectOpenShiftEvidence(input = {}, options = {}) {
  const config = options.config ?? getEvidenceConfig();
  const target = getEvidenceTarget(input);
  const collection = {
    provider: config.provider,
    target,
    evidence: [],
    missing: []
  };

  if (config.provider === "none") {
    collection.missing.push(missingItem("openshift_api", "CAS_EVIDENCE_PROVIDER=none"));
    return collection;
  }

  const authorization = options.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    collection.missing.push(missingItem("openshift_api", "missing user bearer token for OpenShift evidence collection"));
    return collection;
  }

  const requestOptions = {
    authorization,
    config,
    transport: options.transport
  };

  const kind = String(target.kind ?? "").toLowerCase();
  if (target.namespace && !["clusterversion", "clusteroperator", "node"].includes(kind)) {
    await collectNamespaceEvidence(collection, target, requestOptions);
  }

  if (kind === "clusterversion") {
    await collectClusterVersionEvidence(collection, target, requestOptions);
  } else if (kind === "pod") {
    await collectPodEvidence(collection, target, requestOptions);
  } else if (kind === "deployment") {
    await collectDeploymentEvidence(collection, target, requestOptions);
  } else {
    collection.missing.push(missingItem("target_resource", `unsupported evidence target kind ${target.kind}`));
  }

  return collection;
}

export function buildOpenShiftEvidenceContext(collection = {}) {
  const evidence = collection.evidence ?? [];
  const missing = collection.missing ?? [];
  const lines = [];

  if (evidence.length > 0) {
    lines.push("Collected read-only OpenShift evidence:");
    for (const item of evidence.slice(0, 8)) {
      lines.push(`- ${item.id} [${item.type}]: ${item.summary} (source: ${item.source})`);
    }
  }

  if (missing.length > 0) {
    lines.push("Missing or unavailable evidence:");
    for (const item of missing.slice(0, 8)) {
      lines.push(`- ${item.type}: ${item.reason}`);
    }
  }

  return lines.join("\n");
}

export async function enrichInputWithOpenShiftEvidence(input = {}, options = {}) {
  const collection = await collectOpenShiftEvidence(input, options);
  return {
    ...input,
    cas_evidence: collection,
    cas_evidence_context: buildOpenShiftEvidenceContext(collection)
  };
}
