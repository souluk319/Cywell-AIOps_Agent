#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const namespace = process.env.CAS_PBS_PREFLIGHT_NAMESPACE || "cywell-ai-sentinel";
const overlayArg = process.argv.find((arg) => arg.startsWith("--overlay="))?.split("=")[1] ?? process.env.CAS_PBS_PREFLIGHT_OVERLAY ?? "pbs-live";
const overlay = overlayArg === "pbs-shadow" ? "pbs-shadow" : "pbs-live";
const overlayPath = `deploy/kustomize/overlays/${overlay}`;
const requireCluster = process.argv.includes("--require-cluster") || envBool("CAS_PBS_PREFLIGHT_REQUIRE_CLUSTER");
const requireSecret = process.argv.includes("--require-secret") || envBool("CAS_PBS_PREFLIGHT_REQUIRE_SECRET");
const skipApplied = process.argv.includes("--skip-applied") || envBool("CAS_PBS_PREFLIGHT_SKIP_APPLIED");
const checkedAt = new Date().toISOString();
const checks = [];

function envBool(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  return ["1", "true", "yes", "y", "on"].includes(String(raw).trim().toLowerCase());
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: options.timeoutMs ?? 60000,
    windowsHide: true
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? ""
  };
}

function record(status, id, detail, extra = {}) {
  checks.push({ status, id, detail, ...extra });
  console.log(`[${status}] ${id}: ${detail}`);
}

function pass(id, detail, extra) {
  record("PASS", id, detail, extra);
}

function warn(id, detail, extra) {
  record("WARN", id, detail, extra);
}

function fail(id, detail, extra) {
  record("FAIL", id, detail, extra);
}

function expect(id, condition, passDetail, failDetail = passDetail, extra = {}) {
  if (condition) pass(id, passDetail, extra);
  else fail(id, failDetail, extra);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderKustomize(path) {
  const attempts = [
    ["oc", ["kustomize", path]],
    ["kubectl", ["kustomize", path]]
  ];
  const errors = [];
  for (const [command, args] of attempts) {
    const result = run(command, args, { timeoutMs: 90000 });
    if (result.ok && result.stdout.trim()) {
      pass("preflight:render", `${command} kustomize rendered ${path}`);
      return result.stdout;
    }
    errors.push(`${command}: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  fail("preflight:render", `unable to render ${path}: ${errors.join("; ")}`);
  return "";
}

function renderedDoc(rendered, kind, name) {
  const kindPattern = new RegExp(`^kind:\\s*${escapeRegExp(kind)}\\s*$`, "m");
  const namePattern = new RegExp(`^\\s*name:\\s*${escapeRegExp(name)}\\s*$`, "m");
  return rendered.split(/^---\s*$/m).find((doc) => kindPattern.test(doc) && namePattern.test(doc)) ?? "";
}

function envBlock(deployment, envName) {
  const lines = deployment.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^\\s*- name:\\s*${escapeRegExp(envName)}\\s*$`).test(line));
  if (start < 0) return "";
  const indent = lines[start].match(/^(\s*)-/)?.[1] ?? "";
  const block = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (new RegExp(`^${escapeRegExp(indent)}- name:\\s*`).test(lines[index])) break;
    block.push(lines[index]);
  }
  return block.join("\n");
}

function envValue(deployment, envName) {
  return envBlock(deployment, envName).match(/^\s*value:\s*"?([^"\n]+)"?\s*$/m)?.[1] ?? "";
}

function envCount(deployment, envName) {
  return (deployment.match(new RegExp(`^\\s*- name:\\s*${escapeRegExp(envName)}\\s*$`, "gm")) ?? []).length;
}

function decodeSecretValue(secret, key) {
  const encoded = secret?.data?.[key];
  if (!encoded) return "";
  try {
    return Buffer.from(String(encoded), "base64").toString("utf8").trim();
  } catch {
    return "";
  }
}

function envFromConfig(deployment, envName, configName, key) {
  const block = envBlock(deployment, envName);
  return block.includes("configMapKeyRef:") && block.includes(`name: ${configName}`) && block.includes(`key: ${key}`);
}

function envFromSecret(deployment, envName, secretName, key) {
  const block = envBlock(deployment, envName);
  return (
    block.includes("secretKeyRef:") &&
    block.includes(`name: ${secretName}`) &&
    block.includes(`key: ${key}`) &&
    block.includes("optional: true") &&
    !/^\s*value:\s*/m.test(block)
  );
}

function envFromRequiredSecret(deployment, envName, secretName, key) {
  const block = envBlock(deployment, envName);
  return (
    block.includes("secretKeyRef:") &&
    block.includes(`name: ${secretName}`) &&
    block.includes(`key: ${key}`) &&
    !block.includes("optional: true") &&
    !/^\s*value:\s*/m.test(block)
  );
}

function configValue(configMap, key) {
  return configMap.match(new RegExp(`^\\s*${escapeRegExp(key)}:\\s*([^\\n]+)\\s*$`, "m"))?.[1]?.replace(/^"|"$/g, "") ?? "";
}

function noSecretMaterial(rendered) {
  const pbsBearer = envBlock(rendered, "CAS_PBS_BEARER_TOKEN");
  return (
    !renderedDoc(rendered, "Secret", "cas-pbs-auth") &&
    !/CAS_PBS_API_KEY/i.test(rendered) &&
    !/Authorization:\s*Bearer\s+\S+/i.test(rendered) &&
    !/^\s*value:\s*/m.test(pbsBearer)
  );
}

function policyHasNoBroadAccess(policy) {
  return !/namespaceSelector:\s*\{\}|cidr:\s*0\.0\.0\.0\/0|ipBlock:\s*\{\}|podSelector:\s*\{\}/.test(policy);
}

function pbsRuntimeEgressScoped(policy) {
  return (
    policy.includes("kubernetes.io/metadata.name: playbookstudio") &&
    policy.includes("podSelector:") &&
    policy.includes("app.kubernetes.io/name: playbookstudio") &&
    policy.includes("app.kubernetes.io/component: runtime") &&
    policy.includes("port: 8765")
  );
}

function writeEvidence(status) {
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/cas-pbs-preflight.json",
    JSON.stringify(
      {
        checkedAt,
        branch: run("git", ["branch", "--show-current"]).stdout.trim(),
        head: run("git", ["rev-parse", "--short", "HEAD"]).stdout.trim(),
        status,
        namespace,
        overlay,
        requireCluster,
        requireSecret,
        skipApplied,
        summary: {
          total: checks.length,
          passed: checks.filter((check) => check.status === "PASS").length,
          warned: checks.filter((check) => check.status === "WARN").length,
          failed: checks.filter((check) => check.status === "FAIL").length
        },
        checks
      },
      null,
      2
    )
  );
  console.log("Evidence: test-results/cas-pbs-preflight.json");
}

function getJson(id, args) {
  const result = run("oc", [...args, "-o", "json"], { timeoutMs: 30000 });
  if (!result.ok) {
    if (requireCluster) fail(id, result.stderr || result.stdout || "oc command failed");
    else warn(id, result.stderr || result.stdout || "oc command failed");
    return undefined;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    if (requireCluster) fail(id, `could not parse JSON: ${error.message}`);
    else warn(id, `could not parse JSON: ${error.message}`);
    return undefined;
  }
}

function getJsonOptional(id, args) {
  const result = run("oc", [...args, "-o", "json"], { timeoutMs: 30000 });
  if (!result.ok) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    if (requireCluster) fail(id, `could not parse JSON: ${error.message}`);
    else warn(id, `could not parse JSON: ${error.message}`);
    return undefined;
  }
}

function workloadContainer(workload, name) {
  const containers = workload?.spec?.template?.spec?.containers ?? [];
  return containers.find((container) => container.name === name) ?? containers[0] ?? {};
}

function workloadEnv(workload, name, containerName) {
  const container = workloadContainer(workload, containerName);
  return (container.env ?? []).find((entry) => entry.name === name) ?? {};
}

function workloadEnvValue(workload, name, containerName) {
  return workloadEnv(workload, name, containerName).value ?? "";
}

function workloadEnvSecretRef(workload, name, secretName, key, containerName) {
  const ref = workloadEnv(workload, name, containerName).valueFrom?.secretKeyRef;
  return ref?.name === secretName && ref?.key === key && ref?.optional !== true;
}

function selectorMatchesGateway(selector = {}) {
  const labels = selector.matchLabels ?? {};
  return labels["app.kubernetes.io/name"] === "cywell-ai-sentinel" && labels["app.kubernetes.io/component"] === "gateway";
}

function networkPolicyAllowsAnyIp(policy, ips, ports) {
  const spec = JSON.stringify(policy?.spec ?? {});
  return ips.some((ip) => spec.includes(`${ip}/32`) || spec.includes(`"cidr":"${ip}`)) && ports.some((port) => spec.includes(`"port":${port}`));
}

function collectKubernetesApiTargets() {
  const targets = [];
  const service = getJson("cluster:kubernetes-api-service", ["get", "service", "-n", "default", "kubernetes"]);
  if (service?.spec?.clusterIP && service.spec.clusterIP !== "None") targets.push({ ip: service.spec.clusterIP, port: 443, source: "service" });
  const endpoints = getJson("cluster:kubernetes-api-endpoints", ["get", "endpoints", "-n", "default", "kubernetes"]);
  for (const subset of endpoints?.subsets ?? []) {
    const ports = (subset.ports ?? []).map((port) => Number(port.port)).filter(Boolean);
    for (const address of subset.addresses ?? []) {
      if (!address.ip) continue;
      for (const port of ports.length ? ports : [6443]) targets.push({ ip: address.ip, port, source: "endpoint" });
    }
  }
  return targets;
}

function firstContainerImage(workload) {
  return workload.match(/^\s*image:\s*([^\s]+)\s*$/m)?.[1] ?? "";
}

function pinnedProductionImage(image) {
  return image.includes("@sha256:") || /^image-registry\.openshift-image-registry\.svc:5000\/cywell-ai-sentinel\/[^:]+:v0\.1\.4$/.test(image);
}

function deploymentReady(deploymentJson) {
  return (
    Number(deploymentJson?.status?.observedGeneration ?? 0) >= Number(deploymentJson?.metadata?.generation ?? 0) &&
    Number(deploymentJson?.status?.readyReplicas ?? 0) >= 1 &&
    Number(deploymentJson?.status?.availableReplicas ?? 0) >= 1
  );
}

const rendered = renderKustomize(overlayPath);
const deployment = renderedDoc(rendered, "Deployment", "cas-knowledge-engine");
const configMap = renderedDoc(rendered, "ConfigMap", "cas-pbs-config");
const liveConfigMap = renderedDoc(rendered, "ConfigMap", "cas-knowledge-live-config");
const postgresStatefulSet = renderedDoc(rendered, "StatefulSet", "cas-knowledge-postgres");
const pbsEgress = renderedDoc(rendered, "NetworkPolicy", "cas-knowledge-engine-pbs-egress");
const knowledgeIngress = renderedDoc(rendered, "NetworkPolicy", "cas-knowledge-engine-ingress");

expect("preflight:knowledge-deployment", Boolean(deployment), `${overlay} renders cas-knowledge-engine deployment`);
expect(
  "preflight:provider",
  envValue(deployment, "CAS_KNOWLEDGE_PROVIDER") === (overlay === "pbs-live" ? "pbs-http-live" : "pbs-http-shadow") &&
    envCount(deployment, "CAS_KNOWLEDGE_PROVIDER") === 1,
  `${overlay} renders the expected single PBS provider env`
);
for (const [envName, key] of [
  ["CAS_PBS_BASE_URL", "base-url"],
  ["CAS_PBS_AUTH_MODE", "auth-mode"],
  ["CAS_PBS_TIMEOUT_MS", "timeout-ms"],
  ["CAS_PBS_MAX_RESPONSE_BYTES", "max-response-bytes"],
  ["CAS_PBS_TLS_INSECURE", "tls-insecure"]
]) {
  expect(`preflight:config-env:${envName}`, envFromConfig(deployment, envName, "cas-pbs-config", key), `${envName} comes from cas-pbs-config/${key}`);
}
if (overlay === "pbs-live") {
  expect(
    "preflight:token-secret-ref",
    envFromRequiredSecret(deployment, "CAS_PBS_BEARER_TOKEN", "cas-pbs-auth", "bearer-token"),
    "CAS_PBS_BEARER_TOKEN is a required cas-pbs-auth/bearer-token Secret reference"
  );
} else {
  expect(
    "preflight:token-secret-ref",
    envFromSecret(deployment, "CAS_PBS_BEARER_TOKEN", "cas-pbs-auth", "bearer-token"),
    "CAS_PBS_BEARER_TOKEN is an optional cas-pbs-auth/bearer-token Secret reference"
  );
}
expect("preflight:no-secret-material", noSecretMaterial(rendered), "rendered PBS overlay contains no literal bearer/API token material");
expect("preflight:configmap", Boolean(configMap), `${overlay} renders cas-pbs-config`);
expect(
  "preflight:base-url-shape",
  /^https?:\/\//.test(configValue(configMap, "base-url")) && configValue(configMap, "base-url").includes(":8765"),
  "cas-pbs-config base-url is an HTTP(S) PBS backend URL on port 8765",
  `unexpected base-url: ${configValue(configMap, "base-url") || "<missing>"}`
);
expect(
  "preflight:timeout-bounds",
  Number(configValue(configMap, "timeout-ms")) >= 1000 && Number(configValue(configMap, "timeout-ms")) <= 60000,
  "cas-pbs-config timeout-ms is within operational bounds"
);
expect(
  "preflight:max-response-bounds",
  Number(configValue(configMap, "max-response-bytes")) >= 1048576 && Number(configValue(configMap, "max-response-bytes")) <= 52428800,
  "cas-pbs-config max-response-bytes is within operational bounds"
);
expect(
  "preflight:pbs-egress-policy",
  Boolean(pbsEgress) &&
    pbsEgress.includes("app.kubernetes.io/component: knowledge-engine") &&
    pbsRuntimeEgressScoped(pbsEgress) &&
    pbsEgress.includes("port: 5432") &&
    pbsEgress.includes("port: 53") &&
    policyHasNoBroadAccess(pbsEgress),
  "PBS egress is limited to DNS, Postgres, and labeled playbookstudio runtime pods on 8765"
);
expect(
  "preflight:knowledge-ingress-policy",
  Boolean(knowledgeIngress) &&
    knowledgeIngress.includes("app.kubernetes.io/component: knowledge-engine") &&
    knowledgeIngress.includes("app.kubernetes.io/component: gateway") &&
    knowledgeIngress.includes("port: 8080") &&
    policyHasNoBroadAccess(knowledgeIngress),
  "knowledge-engine ingress remains restricted to gateway pods on 8080"
);
if (overlay === "pbs-live") {
  const postgresImage = firstContainerImage(postgresStatefulSet);
  expect(
    "preflight:live-runtime-ready-gate",
    envValue(deployment, "CAS_PBS_REQUIRE_RUNTIME_READY") === "true",
    "pbs-live requires PBS runtime DB/vector readiness before reporting healthy"
  );
  expect(
    "preflight:live-corpus-ready-gate",
    envValue(deployment, "CAS_PBS_REQUIRE_CORPUS_READY") === "true" &&
      envValue(deployment, "CAS_PBS_REQUIRED_READY_SCOPES") === "official_docs,study_docs",
    "pbs-live requires corpus/index readiness for official_docs and study_docs"
  );
  expect(
    "preflight:live-owner-config",
    Boolean(liveConfigMap) && envFromConfig(deployment, "CAS_KNOWLEDGE_SINGLE_OWNER", "cas-knowledge-live-config", "service-owner"),
    "pbs-live resolves health/service owner from live ConfigMap"
  );
  expect(
    "preflight:live-database-secret-ref",
    envFromRequiredSecret(deployment, "DATABASE_URL", "cas-knowledge-postgres-live", "database-url") &&
      envFromRequiredSecret(postgresStatefulSet, "POSTGRES_DB", "cas-knowledge-postgres-live", "database") &&
      envFromRequiredSecret(postgresStatefulSet, "POSTGRES_USER", "cas-knowledge-postgres-live", "username") &&
      envFromRequiredSecret(postgresStatefulSet, "POSTGRES_PASSWORD", "cas-knowledge-postgres-live", "password"),
    "pbs-live requires cas-knowledge-postgres-live Secret for engine and Postgres credentials"
  );
  expect(
    "preflight:live-no-dev-defaults",
    !/cas-crc-dev|cas_knowledge_dev|postgresql:\/\/cas_knowledge:cas_knowledge_dev/.test(rendered) &&
      !renderedDoc(rendered, "Secret", "cas-knowledge-postgres"),
    "pbs-live render contains no CRC owner, dev DB password, or generated dev Postgres Secret"
  );
  expect(
    "preflight:live-postgres-image-pinned",
    pinnedProductionImage(postgresImage),
    "pbs-live Postgres image is pinned to an approved digest or internal v0.1.4 release image",
    `pbs-live Postgres image must be pinned to an approved digest or internal v0.1.4 release image; found ${postgresImage || "none"}`
  );
  expect(
    "preflight:live-no-shadow-writes",
    envValue(deployment, "CAS_PBS_SHADOW_WRITES") !== "true",
    "pbs-live does not enable shadow writes"
  );
}

const runtimeNamespace = getJson("cluster:pbs-namespace", ["get", "namespace", "playbookstudio"]);
if (runtimeNamespace) pass("cluster:pbs-namespace", "playbookstudio namespace exists");
const runtimeService = getJson("cluster:pbs-runtime-service", ["get", "service", "-n", "playbookstudio", "playbookstudio-runtime"]);
if (runtimeService) {
  const ports = runtimeService.spec?.ports ?? [];
  expect(
    "cluster:pbs-runtime-service-port",
    ports.some((port) => Number(port.port) === 8765 || Number(port.targetPort) === 8765),
    "playbookstudio-runtime exposes PBS backend port 8765"
  );
  const selector = runtimeService.spec?.selector ?? {};
  expect(
    "cluster:pbs-runtime-service-selector",
    selector["app.kubernetes.io/name"] === "playbookstudio" && selector["app.kubernetes.io/component"] === "runtime",
    "playbookstudio-runtime Service selector matches PBS egress podSelector labels",
    `selector must include app.kubernetes.io/name=playbookstudio and app.kubernetes.io/component=runtime: ${JSON.stringify(selector)}`
  );
  const selectorArg = Object.entries(selector)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  if (selectorArg) {
    const runtimePods = getJson("cluster:pbs-runtime-pods", ["get", "pods", "-n", "playbookstudio", "-l", selectorArg]);
    if (runtimePods) {
      const readyPods = (runtimePods.items ?? []).filter((pod) => {
        const ready = (pod.status?.conditions ?? []).some((condition) => condition.type === "Ready" && condition.status === "True");
        return pod.status?.phase === "Running" && ready;
      });
      expect(
        "cluster:pbs-runtime-ready-pods",
        readyPods.length > 0 &&
          readyPods.every(
            (pod) =>
              pod.metadata?.labels?.["app.kubernetes.io/name"] === "playbookstudio" &&
              pod.metadata?.labels?.["app.kubernetes.io/component"] === "runtime"
          ),
        "playbookstudio-runtime selects ready pods carrying the labels allowed by PBS egress",
        `selected pods must be Ready and labeled for PBS egress: ${JSON.stringify((runtimePods.items ?? []).map((pod) => ({ name: pod.metadata?.name, labels: pod.metadata?.labels, phase: pod.status?.phase })))}`
      );
    }
  } else {
    fail("cluster:pbs-runtime-service-selector-empty", "playbookstudio-runtime Service must have a selector so egress label checks are enforceable");
  }
}
const authSecret = getJson("cluster:pbs-auth-secret", ["get", "secret", "-n", namespace, "cas-pbs-auth"]);
if (authSecret) {
  const hasBearer = Boolean(authSecret.data?.["bearer-token"]);
  expect("cluster:pbs-auth-secret-key", hasBearer, "cas-pbs-auth Secret contains bearer-token key");
} else if (requireSecret) {
  fail("cluster:pbs-auth-secret-required", "cas-pbs-auth Secret is required for this preflight run");
} else {
  warn("cluster:pbs-auth-secret-optional", "cas-pbs-auth Secret is absent in the current cluster; live cutover must create it or run preflight with --require-secret");
}
if (overlay === "pbs-live") {
  let liveDatabaseUrl = "";
  if (requireCluster) {
    for (const imageName of ["cas-gateway", "cas-console-plugin", "cas-knowledge-engine", "cas-knowledge-postgres"]) {
      const imageTag = getJson(`cluster:release-image:${imageName}`, ["get", "imagestreamtag", "-n", namespace, `${imageName}:v0.1.4`]);
      if (imageTag) pass(`cluster:release-image:${imageName}:v0.1.4`, `${imageName}:v0.1.4 ImageStreamTag exists`);
    }
    const apiTargets = collectKubernetesApiTargets();
    const networkPolicies = getJson("cluster:gateway-networkpolicies", ["get", "networkpolicy", "-n", namespace]);
    if (networkPolicies) {
      const gatewayPolicies = (networkPolicies.items ?? []).filter((policy) => selectorMatchesGateway(policy.spec?.podSelector));
      const allowedTargets = apiTargets.filter((target) => networkPolicyAllowsAnyIp({ spec: { egress: gatewayPolicies.flatMap((policy) => policy.spec?.egress ?? []) } }, [target.ip], [target.port]));
      expect(
        "cluster:gateway-kubernetes-api-egress",
        apiTargets.length > 0 && allowedTargets.length > 0,
        "Gateway NetworkPolicy allows the target cluster Kubernetes API Service or endpoint for SelfSubjectReview/OpenShift evidence",
        `Gateway NetworkPolicies must allow at least one Kubernetes API target: ${JSON.stringify({ apiTargets, gatewayPolicies: gatewayPolicies.map((policy) => policy.metadata?.name) })}`
      );
    }
  }
  const liveDbSecret = getJson("cluster:knowledge-postgres-live-secret", ["get", "secret", "-n", namespace, "cas-knowledge-postgres-live"]);
  if (liveDbSecret) {
    const missingKeys = ["database", "username", "password", "database-url"].filter((key) => !liveDbSecret.data?.[key]);
    liveDatabaseUrl = decodeSecretValue(liveDbSecret, "database-url");
    expect(
      "cluster:knowledge-postgres-live-secret-keys",
      missingKeys.length === 0,
      "cas-knowledge-postgres-live Secret contains database, username, password, and database-url keys",
      `cas-knowledge-postgres-live Secret missing keys: ${missingKeys.join(", ")}`
    );
  } else if (requireSecret) {
    fail("cluster:knowledge-postgres-live-secret-required", "cas-knowledge-postgres-live Secret is required for live cutover");
  } else {
    warn("cluster:knowledge-postgres-live-secret-optional", "cas-knowledge-postgres-live Secret is absent; live cutover must create it or run preflight with --require-secret");
  }
  const legacyDbSecret = getJsonOptional("cluster:legacy-postgres-secret", ["get", "secret", "-n", namespace, "cas-knowledge-postgres"]);
  if (legacyDbSecret) {
    const detail = "legacy cas-knowledge-postgres Secret exists in the cluster; prune/delete it before pbs-live cutover so dev credentials cannot be reused";
    if (requireSecret) fail("cluster:legacy-postgres-secret", detail);
    else warn("cluster:legacy-postgres-secret", detail);
  } else {
    pass("cluster:legacy-postgres-secret-absent", "legacy cas-knowledge-postgres Secret is absent or not readable in this preflight context");
  }
  if (requireCluster && !skipApplied) {
    const appliedEngine = getJson("cluster:applied-knowledge-engine", ["get", "deployment", "-n", namespace, "cas-knowledge-engine"]);
    if (appliedEngine) {
      const engineContainer = workloadContainer(appliedEngine, "knowledge-engine");
      const serviceOwnerRef = workloadEnv(appliedEngine, "CAS_KNOWLEDGE_SINGLE_OWNER", "knowledge-engine").valueFrom?.configMapKeyRef;
      expect(
        "cluster:applied-knowledge-engine-contract",
        deploymentReady(appliedEngine) &&
          String(engineContainer.image ?? "").endsWith(":v0.1.4") &&
          workloadEnvValue(appliedEngine, "CAS_KNOWLEDGE_PROVIDER", "knowledge-engine") === "pbs-http-live" &&
          workloadEnvValue(appliedEngine, "CAS_KNOWLEDGE_REQUIRE_OWNER_HEADER", "knowledge-engine") === "true" &&
          workloadEnvSecretRef(appliedEngine, "DATABASE_URL", "cas-knowledge-postgres-live", "database-url", "knowledge-engine") &&
          serviceOwnerRef?.name === "cas-knowledge-live-config" &&
          serviceOwnerRef?.key === "service-owner",
        "applied cas-knowledge-engine is rolled out with v0.1.4 pbs-live env and live Secret refs",
        JSON.stringify({
          image: engineContainer.image,
          provider: workloadEnvValue(appliedEngine, "CAS_KNOWLEDGE_PROVIDER", "knowledge-engine"),
          readyReplicas: appliedEngine.status?.readyReplicas,
          availableReplicas: appliedEngine.status?.availableReplicas,
          serviceOwnerRef
        })
      );
    }
    const appliedGateway = getJson("cluster:applied-gateway", ["get", "deployment", "-n", namespace, "cas-gateway"]);
    if (appliedGateway) {
      const gatewayContainer = workloadContainer(appliedGateway, "gateway");
      expect(
        "cluster:applied-gateway-contract",
        deploymentReady(appliedGateway) &&
          String(gatewayContainer.image ?? "").endsWith(":v0.1.4") &&
          workloadEnvValue(appliedGateway, "CAS_KNOWLEDGE_ENGINE_URL", "gateway").includes("cas-knowledge-engine"),
        "applied cas-gateway is rolled out with v0.1.4 and routes knowledge traffic to cas-knowledge-engine",
        JSON.stringify({
          image: gatewayContainer.image,
          knowledgeUrl: workloadEnvValue(appliedGateway, "CAS_KNOWLEDGE_ENGINE_URL", "gateway"),
          readyReplicas: appliedGateway.status?.readyReplicas,
          availableReplicas: appliedGateway.status?.availableReplicas
        })
      );
    }
    const appliedPostgres = getJson("cluster:applied-knowledge-postgres", ["get", "statefulset", "-n", namespace, "cas-knowledge-postgres"]);
    if (appliedPostgres) {
      expect(
        "cluster:applied-postgres-live-secret-refs",
        Number(appliedPostgres.status?.readyReplicas ?? 0) >= 1 &&
          workloadEnvSecretRef(appliedPostgres, "POSTGRES_DB", "cas-knowledge-postgres-live", "database", "postgres") &&
          workloadEnvSecretRef(appliedPostgres, "POSTGRES_USER", "cas-knowledge-postgres-live", "username", "postgres") &&
          workloadEnvSecretRef(appliedPostgres, "POSTGRES_PASSWORD", "cas-knowledge-postgres-live", "password", "postgres"),
        "applied knowledge Postgres StatefulSet is ready and references cas-knowledge-postgres-live credentials",
        JSON.stringify({
          readyReplicas: appliedPostgres.status?.readyReplicas,
          currentReplicas: appliedPostgres.status?.currentReplicas
        })
      );
    }
    const postgresPods = getJson("cluster:applied-postgres-pods", [
      "get",
      "pods",
      "-n",
      namespace,
      "-l",
      "app.kubernetes.io/name=cywell-ai-sentinel,app.kubernetes.io/component=knowledge-postgres"
    ]);
    if (postgresPods) {
      const readyPostgresPod = (postgresPods.items ?? []).find((pod) => {
        const ready = (pod.status?.conditions ?? []).some((condition) => condition.type === "Ready" && condition.status === "True");
        return pod.status?.phase === "Running" && ready;
      });
      if (readyPostgresPod) {
        const dbProbe = run(
          "oc",
          [
            "exec",
            "-n",
            namespace,
            readyPostgresPod.metadata.name,
            "--",
            "sh",
            "-ec",
            [
              "psql -v ON_ERROR_STOP=1 -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" -tAc \"",
              "SELECT 'identity=' || CASE WHEN current_database() <> '' AND current_user <> '' THEN 't' ELSE 'f' END;",
              "SELECT 'vector_ext=' || CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector') THEN 't' ELSE 'f' END;",
              "SELECT 'pgcrypto_ext=' || CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname='pgcrypto') THEN 't' ELSE 'f' END;",
              "SELECT 'documents_table=' || CASE WHEN to_regclass('public.cas_knowledge_documents') IS NOT NULL THEN 't' ELSE 'f' END;",
              "SELECT 'vector_readiness_dim=' || COALESCE((SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid=to_regclass('public.cas_knowledge_vector_readiness') AND attname='embedding'), 'missing');",
              "\""
            ].join(" ")
          ],
          { timeoutMs: 30000 }
        );
        expect(
          "cluster:applied-postgres-runtime",
          dbProbe.ok &&
            dbProbe.stdout.includes("identity=t") &&
            dbProbe.stdout.includes("vector_ext=t") &&
            dbProbe.stdout.includes("pgcrypto_ext=t") &&
            dbProbe.stdout.includes("documents_table=t") &&
            dbProbe.stdout.includes("vector_readiness_dim=vector(768)"),
          "applied knowledge Postgres accepts live credentials and has CAS pgvector schema ready",
          dbProbe.stderr || dbProbe.stdout
        );
        if (liveDatabaseUrl) {
          const dbUrlProbe = run(
            "oc",
            [
              "exec",
              "-n",
              namespace,
              readyPostgresPod.metadata.name,
              "--",
              "env",
              `DATABASE_URL=${liveDatabaseUrl}`,
              "sh",
              "-ec",
              [
                "psql -v ON_ERROR_STOP=1 \"$DATABASE_URL\" -tAc \"",
                "SELECT 'engine_url_identity=' || CASE WHEN current_database() <> '' AND current_user <> '' THEN 't' ELSE 'f' END; ",
                "SELECT 'engine_url_vector_ext=' || CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector') THEN 't' ELSE 'f' END;",
                "\""
              ].join(" ")
            ],
            { timeoutMs: 30000 }
          );
          expect(
            "cluster:applied-engine-database-url-tcp",
            dbUrlProbe.ok &&
              dbUrlProbe.stdout.includes("engine_url_identity=t") &&
              dbUrlProbe.stdout.includes("engine_url_vector_ext=t"),
            "Knowledge Engine live DATABASE_URL reaches Postgres over TCP with live credentials",
            dbUrlProbe.stderr || dbUrlProbe.stdout
          );
        }
      } else {
        fail("cluster:applied-postgres-runtime", "no Ready knowledge Postgres pod found for live database runtime probe");
      }
    }
    const appliedKnowledgeIngress = getJson("cluster:applied-knowledge-ingress-policy", [
      "get",
      "networkpolicy",
      "-n",
      namespace,
      "cas-knowledge-engine-ingress"
    ]);
    if (appliedKnowledgeIngress) {
      const policy = JSON.stringify(appliedKnowledgeIngress.spec ?? {});
      expect(
        "cluster:applied-knowledge-ingress-scoped",
        policy.includes("gateway") && policy.includes("8080") && !policy.includes("\"podSelector\":{}"),
        "applied knowledge ingress NetworkPolicy allows only gateway pods on 8080",
        policy
      );
    }
    const appliedPbsEgress = getJson("cluster:applied-pbs-egress-policy", [
      "get",
      "networkpolicy",
      "-n",
      namespace,
      "cas-knowledge-engine-pbs-egress"
    ]);
    if (appliedPbsEgress) {
      const policy = JSON.stringify(appliedPbsEgress.spec ?? {});
      expect(
        "cluster:applied-pbs-egress-scoped",
        policy.includes("playbookstudio") && policy.includes("runtime") && policy.includes("8765") && !policy.includes("\"podSelector\":{}"),
        "applied PBS egress NetworkPolicy is restricted to labeled playbookstudio runtime pods on 8765",
        policy
      );
    }
  } else if (requireCluster && skipApplied) {
    pass("cluster:applied-workload-contract-skipped", "applied workload contract checks skipped for pre-apply live preflight");
  }
}

const failures = checks.filter((check) => check.status === "FAIL");
const warnings = checks.filter((check) => check.status === "WARN");
const finalStatus = failures.length > 0 ? "FAIL" : warnings.length > 0 ? "WARN" : "PASS";
writeEvidence(finalStatus);
if (failures.length > 0) process.exitCode = 1;
