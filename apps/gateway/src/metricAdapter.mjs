import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const defaultThanosUrl = "https://thanos-querier.openshift-monitoring.svc.cluster.local:9091";
const defaultTimeoutMs = 8000;

export function getMetricConfig(env = process.env) {
  return {
    provider: env.CAS_METRIC_PROVIDER ?? "none",
    thanosUrl: (env.CAS_THANOS_URL ?? defaultThanosUrl).replace(/\/+$/, ""),
    timeoutMs: Number(env.CAS_METRIC_TIMEOUT_MS ?? defaultTimeoutMs),
    tlsInsecure: env.CAS_METRIC_TLS_INSECURE === "true"
  };
}

function truncate(value, maxLength = 360) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function missingItem(type, reason) {
  return {
    type,
    reason: truncate(reason, 240)
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
        method: "GET",
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
      request.destroy(new Error(`Thanos query timed out after ${options.timeoutMs}ms`));
    });
    request.on("error", reject);
    request.end();
  });
}

function queryUrl(config, query) {
  const url = new URL("/api/v1/query", `${config.thanosUrl}/`);
  url.searchParams.set("query", query);
  return url.toString();
}

function targetSlug(target = {}) {
  return [target.namespace, target.kind, target.name].filter(Boolean).join(":") || "cluster";
}

function targetFromInput(input = {}) {
  return {
    namespace: input.scope?.namespaces?.[0] ?? input.namespace ?? input.resourceRef?.namespace ?? "default",
    kind: input.resourceRef?.kind ?? "Pod",
    name: input.resourceRef?.name ?? "api-7c8d9"
  };
}

function metricEvidence(queryName, target, summary, query) {
  return {
    id: `metric:${queryName}:${targetSlug(target)}`,
    type: "metric",
    summary: truncate(summary),
    source: "thanos.api.v1.query",
    observed_at: new Date().toISOString(),
    query
  };
}

function resultSummary(queryName, target, result = []) {
  if (!Array.isArray(result) || result.length === 0) {
    return `${queryName} for ${targetSlug(target)} returned no-series`;
  }
  const samples = result.slice(0, 3).map((series) => {
    const metric = series.metric ?? {};
    const label = metric.pod ?? metric.container ?? metric.namespace ?? metric.job ?? target.name ?? "series";
    const value = Array.isArray(series.value) ? series.value[1] : series.value ?? "n/a";
    return `${label}=${value}`;
  });
  return `${queryName} for ${targetSlug(target)} returned ${result.length} series: ${samples.join(", ")}`;
}

async function runMetricQuery(collection, querySpec, target, options) {
  const config = options.config ?? getMetricConfig();
  const transport = options.transport ?? requestText;
  const url = queryUrl(config, querySpec.query);
  try {
    const response = await transport(url, {
      method: "GET",
      headers: {
        authorization: options.authorization,
        accept: "application/json"
      },
      timeoutMs: config.timeoutMs,
      tlsInsecure: config.tlsInsecure
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      collection.missing.push(missingItem("metric", `Thanos HTTP ${response.statusCode} for ${querySpec.name}`));
      return;
    }
    const body = response.body ? JSON.parse(response.body) : {};
    if (body.status && body.status !== "success") {
      collection.missing.push(missingItem("metric", `Thanos status=${body.status} for ${querySpec.name}`));
      return;
    }
    const result = body.data?.result ?? [];
    collection.evidence.push(metricEvidence(querySpec.name, target, resultSummary(querySpec.name, target, result), querySpec.query));
  } catch (error) {
    collection.missing.push(missingItem("metric", error?.message ?? `Thanos query failed for ${querySpec.name}`));
  }
}

function podQueries(target) {
  const namespace = String(target.namespace ?? "default").replace(/"/g, '\\"');
  const pod = String(target.name ?? "").replace(/"/g, '\\"');
  return [
    {
      name: "pod_restart_increase",
      query: `sum(increase(kube_pod_container_status_restarts_total{namespace="${namespace}",pod="${pod}"}[30m]))`
    },
    {
      name: "pod_memory_working_set",
      query: `sum(container_memory_working_set_bytes{namespace="${namespace}",pod="${pod}",container!="",image!=""})`
    },
    {
      name: "pod_memory_limit",
      query: `sum(kube_pod_container_resource_limits{namespace="${namespace}",pod="${pod}",resource="memory"})`
    }
  ];
}

function clusterQueries(target) {
  const namespace = String(target.namespace ?? "default").replace(/"/g, '\\"');
  return [
    {
      name: "namespace_restart_increase_by_pod",
      query: `topk(5, sum by (pod) (increase(kube_pod_container_status_restarts_total{namespace="${namespace}"}[30m])))`
    }
  ];
}

export async function collectMetricEvidence(input = {}, options = {}) {
  const config = options.config ?? getMetricConfig();
  const target = targetFromInput(input);
  const collection = {
    provider: config.provider,
    evidence: [],
    missing: []
  };

  if (config.provider === "none") {
    collection.missing.push(missingItem("metric", "CAS_METRIC_PROVIDER=none"));
    return collection;
  }
  if (config.provider !== "thanos") {
    collection.missing.push(missingItem("metric", `unsupported metric provider ${config.provider}`));
    return collection;
  }
  if (!options.authorization?.startsWith("Bearer ")) {
    collection.missing.push(missingItem("metric", "missing user bearer token for Thanos query"));
    return collection;
  }

  const queries = String(target.kind ?? "").toLowerCase() === "pod" ? podQueries(target) : clusterQueries(target);
  for (const query of queries) {
    await runMetricQuery(collection, query, target, { ...options, config });
  }
  return collection;
}

export async function collectMetricOverview(input = {}, options = {}) {
  const namespace = input.namespace ?? input.scope?.namespaces?.[0] ?? "default";
  return collectMetricEvidence(
    {
      ...input,
      scope: {
        ...(input.scope ?? {}),
        namespaces: [namespace]
      },
      resourceRef: {
        namespace,
        kind: "Namespace",
        name: namespace
      }
    },
    options
  );
}
