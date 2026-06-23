import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createEvidenceStatus, createOverviewResult } from "../../../packages/contracts/src/index.js";
import { collectMetricEvidence, collectMetricOverview, getMetricConfig } from "./metricAdapter.mjs";
import { collectRunbookEvidence, getRunbookConfig } from "./runbookAdapter.mjs";

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

function getAuxiliaryConfigs(options = {}) {
  return {
    metricConfig: options.metricConfig ?? getMetricConfig(),
    runbookConfig: options.runbookConfig ?? getRunbookConfig()
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

function mergeAuxiliaryCollection(collection, auxiliary) {
  collection.evidence.push(...(auxiliary.evidence ?? []));
  collection.missing.push(...(auxiliary.missing ?? []));
}

function openshiftEvidenceOnly(collection = {}) {
  return (collection.evidence ?? []).filter((item) => !["metric", "runbook", "rag_reference"].includes(item.type));
}

function evidenceGroups({ openshift = [], metric = [], runbook = [], missing = [] } = {}) {
  return {
    openshift,
    metric,
    runbook,
    missing
  };
}

function workloadStatus(pod = {}) {
  const waiting = (pod.status?.containerStatuses ?? []).find((status) => status.state?.waiting)?.state?.waiting;
  const terminated = (pod.status?.containerStatuses ?? []).find((status) => status.lastState?.terminated)?.lastState?.terminated;
  if (waiting?.reason) return waiting.reason;
  if (terminated?.reason) return terminated.reason;
  return pod.status?.phase ?? "Unknown";
}

function workloadRisk(pod = {}, warningEvents = []) {
  const restartTotal = (pod.status?.containerStatuses ?? []).reduce(
    (sum, status) => sum + Number(status.restartCount ?? 0),
    0
  );
  const status = workloadStatus(pod);
  if (["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "OOMKilled"].includes(status)) return "high";
  if (pod.status?.phase === "Pending" || restartTotal >= 3 || warningEvents.length >= 2) return "high";
  if (restartTotal > 0 || warningEvents.length > 0 || pod.status?.phase !== "Running") return "medium";
  return "low";
}

function workloadReason(pod = {}, warningEvents = []) {
  const restartTotal = (pod.status?.containerStatuses ?? []).reduce(
    (sum, status) => sum + Number(status.restartCount ?? 0),
    0
  );
  const status = workloadStatus(pod);
  if (status === "OOMKilled") return "previous container terminated with OOMKilled";
  if (status && status !== "Running") return `${status} status observed`;
  if (restartTotal > 0 && warningEvents.length > 0) return `restartCount=${restartTotal} with ${warningEvents.length} warning events`;
  if (restartTotal > 0) return `restartCount=${restartTotal}`;
  if (warningEvents.length > 0) return `${warningEvents.length} warning events`;
  return "no active risk signal";
}

function podRestartTotal(pod = {}) {
  return (pod.status?.containerStatuses ?? []).reduce((sum, status) => sum + Number(status.restartCount ?? 0), 0);
}

function podEventList(events = [], podName) {
  return events.filter((event) => event.involvedObject?.kind === "Pod" && event.involvedObject?.name === podName);
}

function consoleHrefFor(resource = {}) {
  const namespace = resource.namespace ?? "default";
  const name = resource.name ?? "";
  if (resource.kind === "Deployment") return `/k8s/ns/${namespace}/deployments/${name}`;
  if (resource.kind === "Pod") return `/k8s/ns/${namespace}/pods/${name}`;
  return `/k8s/ns/${namespace}/pods`;
}

function eventTimeline(events = []) {
  return [...events]
    .filter((event) => event.type === "Warning" || event.reason)
    .sort((left, right) => eventTime(right).localeCompare(eventTime(left)))
    .slice(0, 8)
    .map((event, index) => ({
      id: `overview:timeline:${index + 1}`,
      ts: eventTime(event) || new Date().toISOString(),
      type: "event",
      summary: truncate(`${event.reason ?? "Event"}: ${event.message ?? "no message"}`, 180),
      source: "kubernetes.events"
    }));
}

function eventReasonCounts(events = []) {
  const counts = new Map();
  for (const event of events) {
    if (event.type !== "Warning") continue;
    const reason = event.reason ?? "Warning";
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));
}

function riskScore({ warningEvents, restartSpikes, pendingPods, riskyWorkloads }) {
  const penalty = warningEvents * 2 + restartSpikes * 5 + pendingPods * 8 + riskyWorkloads * 6;
  return Math.max(0, Math.min(100, 100 - penalty));
}

function riskLabel(score) {
  if (score < 60) return "high";
  if (score < 85) return "medium";
  return "low";
}

function topRcaCandidate(riskWorkloads = [], timeline = []) {
  const top = riskWorkloads[0];
  if (!top) {
    return {
      cause: "No active workload risk detected in selected scope",
      confidence: 0.35,
      evidence_refs: timeline.slice(0, 2).map((item) => item.id)
    };
  }
  const confidence = top.risk === "high" ? 0.74 : 0.58;
  return {
    cause: top.reason,
    confidence,
    evidence_refs: [top.id, ...timeline.slice(0, 2).map((item) => item.id)]
  };
}

function actionTargetFromWorkload(workload) {
  if (!workload?.namespace || !workload?.kind || !workload?.name) return undefined;
  return {
    namespace: workload.namespace,
    kind: workload.kind,
    name: workload.name
  };
}

function namespaceTarget(namespace) {
  return {
    namespace,
    kind: "Namespace",
    name: namespace
  };
}

function overviewActionQueue(namespace, topWorkload) {
  const actions = [];
  if (topWorkload) {
    const target = actionTargetFromWorkload(topWorkload);
    const resource = `${topWorkload.kind}/${topWorkload.name}`;
    actions.push({
      id: `check:rca:${topWorkload.namespace}:${topWorkload.kind}:${topWorkload.name}`,
      label: `RCA check: ${resource}`,
      type: "cas_query",
      target,
      question: `${topWorkload.namespace} namespace의 ${resource} 상태, 최근 Warning 이벤트, 재시작, 로그, 메트릭 근거를 연결해서 원인 후보와 다음 확인 순서를 알려줘.`
    });
    actions.push({
      id: `check:events:${topWorkload.namespace}:${topWorkload.kind}:${topWorkload.name}`,
      label: `Event check: ${topWorkload.name}`,
      type: "cas_query",
      target,
      question: `${topWorkload.namespace} namespace의 ${resource}와 관련된 최근 Warning 이벤트를 기준으로 readiness, scheduling, image, probe 문제 가능성을 구분해줘.`
    });
    actions.push({
      id: `check:metrics:${topWorkload.namespace}:${topWorkload.kind}:${topWorkload.name}`,
      label: `Metric check: ${topWorkload.name}`,
      type: "cas_query",
      target,
      question: `${topWorkload.namespace} namespace의 ${resource} 재시작 증가, 메모리 사용량, 메모리 limit 근거를 기준으로 리소스 병목 가능성을 확인해줘.`
    });
  }
  actions.push({
    id: `check:namespace-events:${namespace}`,
    label: "Namespace event check",
    type: "cas_query",
    target: namespaceTarget(namespace),
    question: `${namespace} namespace의 최근 Warning 이벤트, Pending Pod, 재시작 증가를 한 번에 확인해서 지금 우선 봐야 할 장애 후보를 정리해줘.`
  });
  actions.push({
    id: "check:cluster-version",
    label: "ClusterVersion check",
    type: "cas_query",
    target: {
      namespace: "default",
      kind: "ClusterVersion",
      name: "version"
    },
    question: "ClusterVersion/version 상태와 최근 조건을 기준으로 클러스터 자체 이상 징후가 있는지 확인해줘."
  });
  return actions;
}

function runbookActions(runbookEvidence = [], namespace = "default", topWorkload) {
  const target = actionTargetFromWorkload(topWorkload) ?? namespaceTarget(namespace);
  return runbookEvidence.slice(0, 3).map((item) => ({
    id: `check:runbook:${item.id}`,
    label: `Runbook check: ${compactRunbookLabel(item.summary)}`,
    type: "cas_query",
    target,
    question: `Runbook 근거 ${item.id} (${item.summary})를 현재 OpenShift/Metric 증거와 연결해서 원인 후보, 확인 순서, 사람이 실행해도 안전한 다음 확인 항목으로 정리해줘.`
  }));
}

function compactRunbookLabel(summary = "") {
  const text = String(summary || "Runbook").replace(/\s+/g, " ").trim();
  const title = text.split(":")[0]?.trim() || text;
  return truncate(title, 76);
}

function timelineEvidence(timeline = []) {
  return timeline.map((item) => ({
    id: item.id,
    type: item.type,
    summary: item.summary,
    source: item.source,
    observed_at: item.ts
  }));
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

async function finalizeEvidenceCollection(input, collection, options = {}) {
  const { metricConfig, runbookConfig } = getAuxiliaryConfigs(options);
  const enrichedInput = {
    ...input,
    cas_evidence: collection
  };
  const [metric, runbook] = await Promise.all([
    collectMetricEvidence(enrichedInput, {
      authorization: options.authorization,
      config: metricConfig,
      transport: options.metricTransport
    }),
    collectRunbookEvidence(enrichedInput, {
      config: runbookConfig
    })
  ]);
  mergeAuxiliaryCollection(collection, metric);
  mergeAuxiliaryCollection(collection, runbook);
  collection.evidence_groups = evidenceGroups({
    openshift: openshiftEvidenceOnly(collection),
    metric: metric.evidence ?? [],
    runbook: runbook.evidence ?? [],
    missing: collection.missing
  });
  collection.evidence_status = createEvidenceStatus(collection);
  return collection;
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
    return finalizeEvidenceCollection(input, collection, options);
  }

  const authorization = options.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    collection.missing.push(missingItem("openshift_api", "missing user bearer token for OpenShift evidence collection"));
    return finalizeEvidenceCollection(input, collection, options);
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

  return finalizeEvidenceCollection(input, collection, options);
}

export async function collectOpenShiftTargets(input = {}, options = {}) {
  const config = options.config ?? getEvidenceConfig();
  const currentNamespace = input.namespace ?? input.scope?.namespaces?.[0] ?? "default";
  const missing = [];
  const targets = new Map();
  const addTarget = (target = {}) => {
    const namespace = String(target.namespace ?? "").trim();
    const kind = String(target.kind ?? "").trim();
    const name = String(target.name ?? "").trim();
    if (!namespace || !kind || !name) return;
    targets.set(`${namespace}::${kind}::${name}`, { namespace, kind, name });
  };

  addTarget({ namespace: currentNamespace, kind: "ClusterVersion", name: "version" });

  if (config.provider === "none") {
    return {
      mode: "target_catalog",
      targets: [...targets.values()],
      missing: [missingItem("openshift_api", "CAS_EVIDENCE_PROVIDER=none")]
    };
  }

  const authorization = options.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return {
      mode: "target_catalog",
      targets: [...targets.values()],
      missing: [missingItem("openshift_api", "missing user bearer token for target catalog")]
    };
  }

  const requestOptions = {
    authorization,
    config,
    transport: options.transport
  };

  async function getList(type, path) {
    try {
      const response = await kubeJson(path, requestOptions);
      if (response.statusCode >= 200 && response.statusCode < 300 && response.json) {
        return response.json.items ?? [];
      }
      missing.push(missingItem(type, `OpenShift API HTTP ${response.statusCode} for ${path}`));
    } catch (error) {
      missing.push(missingItem(type, error?.message ?? `OpenShift API error for ${path}`));
    }
    return [];
  }

  const namespaces = await getList("namespace", "/api/v1/namespaces?limit=80");
  const namespaceNames = namespaces.map((item) => item.metadata?.name).filter(Boolean);
  const selectedNamespaces = [...new Set([currentNamespace, ...namespaceNames])].slice(0, 24);
  for (const namespace of selectedNamespaces) {
    addTarget({ namespace, kind: "Namespace", name: namespace });
  }

  await Promise.all(
    selectedNamespaces.map(async (namespace) => {
      const namespacePath = encodeURIComponent(namespace);
      const [pods, deployments] = await Promise.all([
        getList("pod", `/api/v1/namespaces/${namespacePath}/pods?limit=100`),
        getList("deployment", `/apis/apps/v1/namespaces/${namespacePath}/deployments?limit=80`)
      ]);
      for (const pod of pods) addTarget({ namespace, kind: "Pod", name: pod.metadata?.name });
      for (const deployment of deployments) addTarget({ namespace, kind: "Deployment", name: deployment.metadata?.name });
    })
  );

  return {
    mode: "target_catalog",
    targets: [...targets.values()].sort((left, right) => {
      const namespaceOrder = left.namespace.localeCompare(right.namespace);
      if (namespaceOrder !== 0) return namespaceOrder;
      const kindOrder = left.kind.localeCompare(right.kind);
      if (kindOrder !== 0) return kindOrder;
      return left.name.localeCompare(right.name);
    }),
    missing
  };
}

export async function collectOpenShiftOverview(input = {}, options = {}) {
  const config = options.config ?? getEvidenceConfig();
  const namespace = input.namespace ?? input.scope?.namespaces?.[0] ?? "default";
  const scope = {
    cluster: input.scope?.cluster ?? "local-cluster",
    namespaces: [namespace]
  };
  const missing = [];

  if (config.provider === "none") {
    return createOverviewResult({
      scope,
      health: {
        score: 0,
        risk: "unknown",
        summary: "OpenShift evidence provider is disabled"
      },
      missing: [missingItem("openshift_api", "CAS_EVIDENCE_PROVIDER=none")]
    });
  }

  const authorization = options.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return createOverviewResult({
      scope,
      health: {
        score: 0,
        risk: "unknown",
        summary: "UserToken is required to build the RCA cockpit"
      },
      missing: [missingItem("openshift_api", "missing user bearer token for OpenShift overview collection")]
    });
  }

  const requestOptions = {
    authorization,
    config,
    transport: options.transport
  };

  async function getList(type, path) {
    try {
      const response = await kubeJson(path, requestOptions);
      if (response.statusCode >= 200 && response.statusCode < 300 && response.json) {
        return response.json.items ?? [];
      }
      missing.push(missingItem(type, `OpenShift API HTTP ${response.statusCode} for ${path}`));
    } catch (error) {
      missing.push(missingItem(type, error?.message ?? `OpenShift API error for ${path}`));
    }
    return [];
  }

  async function getClusterVersion() {
    try {
      const response = await kubeJson("/apis/config.openshift.io/v1/clusterversions/version", requestOptions);
      if (response.statusCode >= 200 && response.statusCode < 300 && response.json) {
        return summarizeClusterVersion(response.json);
      }
      missing.push(missingItem("clusterversion", `OpenShift API HTTP ${response.statusCode} for ClusterVersion`));
    } catch (error) {
      missing.push(missingItem("clusterversion", error?.message ?? "ClusterVersion unavailable"));
    }
    return "ClusterVersion unavailable";
  }

  const namespacePath = encodeURIComponent(namespace);
  const [pods, events, clusterSummary] = await Promise.all([
    getList("pod", `/api/v1/namespaces/${namespacePath}/pods?limit=50`),
    getList("event", `/api/v1/namespaces/${namespacePath}/events?limit=80`),
    getClusterVersion()
  ]);

  const warningEvents = events.filter((event) => event.type === "Warning");
  const riskWorkloads = pods
    .map((pod) => {
      const podName = pod.metadata?.name ?? "unknown";
      const podEvents = podEventList(warningEvents, podName);
      const risk = workloadRisk(pod, podEvents);
      return {
        id: `openshift:workload:${namespace}:${podName}`,
        namespace,
        kind: "Pod",
        name: podName,
        status: workloadStatus(pod),
        restarts: podRestartTotal(pod),
        risk,
        reason: workloadReason(pod, podEvents),
        href: consoleHrefFor({ namespace, kind: "Pod", name: podName })
      };
    })
    .filter((item) => item.risk !== "low")
    .sort((left, right) => {
      const rank = { high: 2, medium: 1, low: 0 };
      return rank[right.risk] - rank[left.risk] || right.restarts - left.restarts;
    })
    .slice(0, 5);

  const pendingPods = pods.filter((pod) => pod.status?.phase === "Pending").length;
  const restartSpikes = pods.filter((pod) => podRestartTotal(pod) > 0).length;
  const calculatedScore = riskScore({
    warningEvents: warningEvents.length,
    restartSpikes,
    pendingPods,
    riskyWorkloads: riskWorkloads.length
  });
  const timeline = eventTimeline(events);
  const candidate = topRcaCandidate(riskWorkloads, timeline);
  const topWorkload = riskWorkloads[0];
  const criticalMissing = missing.some((item) => ["pod", "event"].includes(item.type));
  const score = criticalMissing ? 0 : calculatedScore;
  const risk = criticalMissing ? "unknown" : riskLabel(score);
  const summary = criticalMissing
    ? `Overview degraded for ${namespace}: required pod/event evidence is unavailable`
    : riskWorkloads.length > 0
      ? `${riskWorkloads.length} risky workloads detected in ${namespace}. ${clusterSummary}`
      : `No risky workloads detected in ${namespace}. ${clusterSummary}`;

  const { metricConfig, runbookConfig } = getAuxiliaryConfigs(options);
  const openShiftOverviewEvidence = timelineEvidence(timeline);
  const [metricOverview, runbookOverview] = await Promise.all([
    collectMetricOverview(
      {
        namespace,
        scope
      },
      {
        authorization,
        config: metricConfig,
        transport: options.metricTransport
      }
    ),
    collectRunbookEvidence(
      {
        question: `OpenShift ${namespace} namespace overview warning events restart RCA next checks`,
        namespace,
        scope,
        cas_evidence: {
          evidence: openShiftOverviewEvidence,
          missing
        }
      },
      {
        config: runbookConfig
      }
    )
  ]);
  const overviewMissing = [...missing, ...(metricOverview.missing ?? []), ...(runbookOverview.missing ?? [])];
  const groupedEvidence = evidenceGroups({
    openshift: openShiftOverviewEvidence,
    metric: metricOverview.evidence ?? [],
    runbook: runbookOverview.evidence ?? [],
    missing: overviewMissing
  });
  const overviewEvidenceStatus = createEvidenceStatus({
    evidence: [...groupedEvidence.openshift, ...groupedEvidence.metric, ...groupedEvidence.runbook],
    missing: overviewMissing
  });

  return createOverviewResult({
    scope,
    health: {
      score,
      risk,
      summary
    },
    signals: {
      warning_events: warningEvents.length,
      restart_spikes: restartSpikes,
      pending_pods: pendingPods,
      risky_workloads: riskWorkloads.length
    },
    event_reasons: eventReasonCounts(events),
    risk_workloads: riskWorkloads,
    rca_candidate: candidate,
    evidence_timeline: timeline,
    evidence_groups: groupedEvidence,
    evidence_status: overviewEvidenceStatus,
    actions: [...overviewActionQueue(namespace, topWorkload), ...runbookActions(runbookOverview.evidence ?? [], namespace, topWorkload)],
    missing: overviewMissing
  });
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
