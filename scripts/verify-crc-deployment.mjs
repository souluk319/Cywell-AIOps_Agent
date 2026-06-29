#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const namespace = "cywell-ai-sentinel";
const checks = [];
const checkedAt = new Date().toISOString();
const appRuntimeImages = [
  { imageStream: "cas-gateway", podPrefix: "cas-gateway-", container: "gateway" },
  { imageStream: "cas-console-plugin", podPrefix: "cas-console-plugin-", container: "console-plugin" },
  { imageStream: "cas-knowledge-engine", podPrefix: "cas-knowledge-engine-", container: "knowledge-engine" }
];
const verifiedImages = {};

function run(command, args, timeoutMs = 30000) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? result.error?.message ?? ""
  };
}

function runWithInput(command, args, input, timeoutMs = 30000) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    input,
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? result.error?.message ?? ""
  };
}

const crcWhoami = run("oc", ["whoami"], 10000);
const crcWhoamiToken = run("oc", ["whoami", "-t"], 10000);
const crcKnowledgeSmokeUser = crcWhoami.ok ? crcWhoami.stdout.trim() : "";
const crcKnowledgeSmokeToken = crcWhoamiToken.ok ? crcWhoamiToken.stdout.trim() : "";
const crcSelfSubjectReview = crcKnowledgeSmokeToken
  ? runWithInput(
      "oc",
      ["create", "--raw", "/apis/authentication.k8s.io/v1/selfsubjectreviews", "-f", "-"],
      JSON.stringify({
        apiVersion: "authentication.k8s.io/v1",
        kind: "SelfSubjectReview"
      }),
      10000
    )
  : { ok: false, stdout: "", stderr: "missing oc token" };
let crcSelfSubjectUserInfo = {};
try {
  crcSelfSubjectUserInfo = JSON.parse(crcSelfSubjectReview.stdout || "{}")?.status?.userInfo ?? {};
} catch {
  crcSelfSubjectUserInfo = {};
}
const crcKnowledgeSmokeSubject = crcSelfSubjectUserInfo.uid
  ? `uid:${crcSelfSubjectUserInfo.uid}`
  : crcSelfSubjectUserInfo.username
    ? `username:${crcSelfSubjectUserInfo.username}`
    : "";
const crcKnowledgeSmokeOwner = crcKnowledgeSmokeSubject
  ? `k8s-user-${createHash("sha256").update(crcKnowledgeSmokeSubject).digest("hex").slice(0, 32)}`
  : "";

function record(status, id, detail, extra = {}) {
  checks.push({ status, id, detail, ...extra });
  console.log(`[${status}] ${id}: ${detail}`);
}

function pass(id, detail, extra) {
  record("PASS", id, detail, extra);
}

function fail(id, detail, extra) {
  record("FAIL", id, detail, extra);
}

function expect(id, condition, passDetail, failDetail = passDetail, extra = {}) {
  if (condition) pass(id, passDetail, extra);
  else fail(id, failDetail, extra);
}

function extractDigest(value) {
  const match = String(value ?? "").match(/sha256:[a-f0-9]{32,}/i);
  return match ? match[0].toLowerCase() : "";
}

function getJson(id, args) {
  const result = run("oc", [...args, "-o", "json"]);
  if (!result.ok) {
    fail(id, result.stderr || result.stdout || "oc command failed");
    return undefined;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(id, `could not parse JSON: ${error.message}`);
    return undefined;
  }
}

function deploymentReady(deployment) {
  const desired = Number(deployment?.spec?.replicas ?? 1);
  return (
    Number(deployment?.status?.observedGeneration ?? 0) >= Number(deployment?.metadata?.generation ?? 0) &&
    Number(deployment?.status?.updatedReplicas ?? 0) >= desired &&
    Number(deployment?.status?.availableReplicas ?? 0) >= desired &&
    Number(deployment?.status?.unavailableReplicas ?? 0) === 0 &&
    deployment?.status?.conditions?.some((condition) => condition.type === "Available" && condition.status === "True")
  );
}

function execNode(pod, code, timeoutMs = 30000) {
  return run("oc", ["exec", "-n", namespace, pod, "--", "node", "-e", code], timeoutMs);
}

function execPod(pod, args, timeoutMs = 30000) {
  return run("oc", ["exec", "-n", namespace, pod, "--", ...args], timeoutMs);
}

function parseLastJsonLine(stdout) {
  for (const line of String(stdout ?? "").split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      return JSON.parse(trimmed);
    } catch {
      continue;
    }
  }
  return null;
}

function podReady(pod) {
  return (
    pod?.status?.phase === "Running" &&
    !pod?.metadata?.deletionTimestamp &&
    pod?.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True") &&
    pod?.status?.containerStatuses?.every((container) => container.ready && container.state?.running)
  );
}

function imageStreamDigestReference(imageStreamTag) {
  return imageStreamTag?.image?.dockerImageReference ?? imageStreamTag?.image?.metadata?.name ?? "";
}

function verifyAppRuntimeImage({ imageStream, container }, pod, imageStreamTagByName) {
  const imageStreamTagName = `${imageStream}:dev`;
  const imageStreamTag = imageStreamTagByName.get(imageStreamTagName);
  const imageStreamReference = imageStreamDigestReference(imageStreamTag);
  const imageStreamDigest = extractDigest(imageStreamReference);
  const containerStatus = (pod?.status?.containerStatuses ?? []).find((status) => status.name === container);
  const runtimeDigest = extractDigest(containerStatus?.imageID);
  const matched = Boolean(pod && imageStreamTag && imageStreamDigest && runtimeDigest && imageStreamDigest === runtimeDigest);
  verifiedImages[imageStream] = {
    tag: "dev",
    imageStreamTag: imageStreamTagName,
    imageStreamReference,
    imageStreamDigest,
    pod: pod?.metadata?.name ?? "",
    container,
    image: containerStatus?.image ?? "",
    imageID: containerStatus?.imageID ?? "",
    runtimeDigest,
    digest: imageStreamDigest,
    verified: matched
  };
  expect(
    `runtime:verified-image:${imageStream}`,
    matched,
    `${imageStream}:dev ImageStreamTag digest matches the ready runtime pod imageID`,
    `${imageStream}:dev ImageStreamTag digest does not match the ready runtime pod imageID`,
    verifiedImages[imageStream]
  );
}

function verifyPostgresRuntimeImage(pod) {
  const containerStatus = (pod?.status?.containerStatuses ?? []).find((status) => status.name === "postgres");
  const runtimeDigest = extractDigest(containerStatus?.imageID);
  const matched = Boolean(pod && runtimeDigest);
  verifiedImages["cas-knowledge-postgres"] = {
    tag: "running",
    imageStreamTag: "",
    imageStreamReference: "",
    imageStreamDigest: "",
    pod: pod?.metadata?.name ?? "",
    container: "postgres",
    image: containerStatus?.image ?? "",
    imageID: containerStatus?.imageID ?? "",
    runtimeDigest,
    digest: runtimeDigest,
    verified: matched
  };
  expect(
    "runtime:verified-image:cas-knowledge-postgres",
    matched,
    "running cas-knowledge-postgres imageID is digest-pinned for release promotion evidence",
    "running cas-knowledge-postgres pod does not expose a digest-pinned imageID",
    verifiedImages["cas-knowledge-postgres"]
  );
}

function knowledgeIngressPolicyShape(policy) {
  const selector = policy?.spec?.podSelector?.matchLabels ?? {};
  const policyTypes = policy?.spec?.policyTypes ?? [];
  const ingress = policy?.spec?.ingress ?? [];
  const rule = ingress[0] ?? {};
  const peers = rule.from ?? [];
  const peer = peers[0] ?? {};
  const peerSelector = peer.podSelector?.matchLabels ?? {};
  const ports = rule.ports ?? [];
  const port = ports[0] ?? {};
  return (
    selector["app.kubernetes.io/name"] === "cywell-ai-sentinel" &&
    selector["app.kubernetes.io/component"] === "knowledge-engine" &&
    policyTypes.includes("Ingress") &&
    ingress.length === 1 &&
    peers.length === 1 &&
    !peer.namespaceSelector &&
    !peer.ipBlock &&
    peerSelector["app.kubernetes.io/name"] === "cywell-ai-sentinel" &&
    peerSelector["app.kubernetes.io/component"] === "gateway" &&
    ports.length === 1 &&
    port.protocol === "TCP" &&
    Number(port.port) === 8080
  );
}

function gatewayIngressPolicyShape(policy) {
  const selector = policy?.spec?.podSelector?.matchLabels ?? {};
  const policyTypes = policy?.spec?.policyTypes ?? [];
  const ingress = policy?.spec?.ingress ?? [];
  const rule = ingress[0] ?? {};
  const peers = rule.from ?? [];
  const ports = rule.ports ?? [];
  const port = ports[0] ?? {};
  return (
    selector["app.kubernetes.io/name"] === "cywell-ai-sentinel" &&
    selector["app.kubernetes.io/component"] === "gateway" &&
    policyTypes.includes("Ingress") &&
    ingress.length === 1 &&
    peers.length === 2 &&
    peers.some((peer) => peer.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] === "openshift-console") &&
    peers.some((peer) => peer.podSelector?.matchLabels?.["app.kubernetes.io/component"] === "console-plugin") &&
    ports.length === 1 &&
    port.protocol === "TCP" &&
    Number(port.port) === 9443
  );
}

function consolePluginIngressPolicyShape(policy) {
  const selector = policy?.spec?.podSelector?.matchLabels ?? {};
  const policyTypes = policy?.spec?.policyTypes ?? [];
  const ingress = policy?.spec?.ingress ?? [];
  const rule = ingress[0] ?? {};
  const peers = rule.from ?? [];
  const ports = rule.ports ?? [];
  const port = ports[0] ?? {};
  return (
    selector["app.kubernetes.io/name"] === "cywell-ai-sentinel" &&
    selector["app.kubernetes.io/component"] === "console-plugin" &&
    policyTypes.includes("Ingress") &&
    ingress.length === 1 &&
    peers.length === 1 &&
    peers[0]?.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] === "openshift-console" &&
    ports.length === 1 &&
    port.protocol === "TCP" &&
    Number(port.port) === 9443
  );
}

function postgresIngressPolicyShape(policy) {
  const selector = policy?.spec?.podSelector?.matchLabels ?? {};
  const policyTypes = policy?.spec?.policyTypes ?? [];
  const ingress = policy?.spec?.ingress ?? [];
  const rule = ingress[0] ?? {};
  const peers = rule.from ?? [];
  const peerSelector = peers[0]?.podSelector?.matchLabels ?? {};
  const ports = rule.ports ?? [];
  const port = ports[0] ?? {};
  return (
    selector["app.kubernetes.io/name"] === "cywell-ai-sentinel" &&
    selector["app.kubernetes.io/component"] === "knowledge-postgres" &&
    policyTypes.includes("Ingress") &&
    ingress.length === 1 &&
    peers.length === 1 &&
    peerSelector["app.kubernetes.io/name"] === "cywell-ai-sentinel" &&
    peerSelector["app.kubernetes.io/component"] === "knowledge-engine" &&
    ports.length === 1 &&
    port.protocol === "TCP" &&
    Number(port.port) === 5432
  );
}

function policyDefaultDenyEgress(policy) {
  return (
    policy?.spec?.policyTypes?.includes("Egress") &&
    (!("egress" in (policy?.spec ?? {})) || (Array.isArray(policy?.spec?.egress) && policy.spec.egress.length === 0))
  );
}

function peerIsBroad(peer) {
  if (peer?.namespaceSelector && Object.keys(peer.namespaceSelector).length === 0) return true;
  if (peer?.namespaceSelector?.matchLabels && Object.keys(peer.namespaceSelector.matchLabels).length === 0) return true;
  if (peer?.podSelector && Object.keys(peer.podSelector).length === 0) return true;
  if (peer?.podSelector?.matchLabels && Object.keys(peer.podSelector.matchLabels).length === 0) return true;
  if (peer?.ipBlock?.cidr === "0.0.0.0/0") return true;
  return false;
}

function policyIsRestrictive(policy) {
  const peers = [];
  for (const rule of policy?.spec?.egress ?? []) peers.push(...(rule.to ?? []));
  for (const rule of policy?.spec?.ingress ?? []) peers.push(...(rule.from ?? []));
  if (peers.length === 0) return policyDefaultDenyEgress(policy);
  return peers.every((peer) => !peerIsBroad(peer));
}

function policySelectsLabels(policy, labels) {
  const matchLabels = policy?.spec?.podSelector?.matchLabels ?? {};
  return Object.entries(matchLabels).every(([key, value]) => labels[key] === value);
}

function policiesSelectingLabels(policies, labels) {
  return (policies?.items ?? []).filter((policy) => policySelectsLabels(policy, labels));
}

const images = getJson("images:istags", ["get", "istag", "-n", namespace]);
const imageNames = (images?.items ?? []).map((item) => item.metadata?.name);
const imageStreamTagByName = new Map((images?.items ?? []).map((item) => [item.metadata?.name, item]));
expect("images:gateway", imageNames.includes("cas-gateway:dev"), "cas-gateway:dev exists", "cas-gateway:dev missing");
expect(
  "runtime:crc-user-token",
  Boolean(crcKnowledgeSmokeUser) && Boolean(crcKnowledgeSmokeToken) && Boolean(crcKnowledgeSmokeOwner),
  "current oc user token resolves through SelfSubjectReview for verified Gateway owner smoke",
  "current oc user/token SelfSubjectReview unavailable; login before running CRC deployment smoke"
);
expect(
  "images:console-plugin",
  imageNames.includes("cas-console-plugin:dev"),
  "cas-console-plugin:dev exists",
  "cas-console-plugin:dev missing"
);
expect(
  "images:knowledge-engine",
  imageNames.includes("cas-knowledge-engine:dev"),
  "cas-knowledge-engine:dev exists",
  "cas-knowledge-engine:dev missing"
);

const deployments = getJson("runtime:deployments", ["get", "deploy", "-n", namespace]);
const deploymentByName = new Map((deployments?.items ?? []).map((deployment) => [deployment.metadata.name, deployment]));
expect(
  "runtime:gateway-dev-image",
  deploymentByName.get("cas-gateway")?.spec?.template?.spec?.containers?.[0]?.image?.endsWith("/cas-gateway:dev"),
  "cas-gateway deployment is pinned to dev image",
  "cas-gateway deployment is not pinned to dev image"
);
expect(
  "runtime:console-plugin-dev-image",
  deploymentByName.get("cas-console-plugin")?.spec?.template?.spec?.containers?.[0]?.image?.endsWith("/cas-console-plugin:dev"),
  "cas-console-plugin deployment is pinned to dev image",
  "cas-console-plugin deployment is not pinned to dev image"
);
expect(
  "runtime:knowledge-engine-dev-image",
  deploymentByName.get("cas-knowledge-engine")?.spec?.template?.spec?.containers?.[0]?.image?.endsWith("/cas-knowledge-engine:dev"),
  "cas-knowledge-engine deployment is pinned to dev image",
  "cas-knowledge-engine deployment is not pinned to dev image"
);
expect("runtime:gateway-ready", deploymentReady(deploymentByName.get("cas-gateway")), "cas-gateway available", "cas-gateway not available");
expect(
  "runtime:console-plugin-ready",
  deploymentReady(deploymentByName.get("cas-console-plugin")),
  "cas-console-plugin available",
  "cas-console-plugin not available"
);
expect(
  "runtime:knowledge-engine-ready",
  deploymentReady(deploymentByName.get("cas-knowledge-engine")),
  "cas-knowledge-engine available",
  "cas-knowledge-engine not available"
);
const statefulsets = getJson("runtime:statefulsets", ["get", "statefulset", "-n", namespace]);
const statefulsetByName = new Map((statefulsets?.items ?? []).map((statefulset) => [statefulset.metadata.name, statefulset]));
expect(
  "runtime:knowledge-postgres-ready",
  Number(statefulsetByName.get("cas-knowledge-postgres")?.status?.readyReplicas ?? 0) >= 1,
  "cas-knowledge-postgres ready",
  "cas-knowledge-postgres not ready"
);
const networkPolicies = getJson("runtime:networkpolicies", ["get", "networkpolicy", "-n", namespace]);
const networkPolicyByName = new Map((networkPolicies?.items ?? []).map((policy) => [policy.metadata.name, policy]));
const gatewaySelectedPolicies = policiesSelectingLabels(networkPolicies, {
  "app.kubernetes.io/name": "cywell-ai-sentinel",
  "app.kubernetes.io/component": "gateway"
});
const consolePluginSelectedPolicies = policiesSelectingLabels(networkPolicies, {
  "app.kubernetes.io/name": "cywell-ai-sentinel",
  "app.kubernetes.io/component": "console-plugin"
});
const knowledgeSelectedPolicies = policiesSelectingLabels(networkPolicies, {
  "app.kubernetes.io/name": "cywell-ai-sentinel",
  "app.kubernetes.io/component": "knowledge-engine"
});
const postgresSelectedPolicies = policiesSelectingLabels(networkPolicies, {
  "app.kubernetes.io/name": "cywell-ai-sentinel",
  "app.kubernetes.io/component": "knowledge-postgres"
});
expect(
  "runtime:gateway-ingress-policy",
  Boolean(networkPolicyByName.get("cas-gateway-ingress")),
  "cas-gateway ingress NetworkPolicy exists",
  "cas-gateway ingress NetworkPolicy is missing"
);
expect(
  "runtime:gateway-ingress-console-only",
  gatewayIngressPolicyShape(networkPolicyByName.get("cas-gateway-ingress")),
  "cas-gateway ingress allows OpenShift Console and console-plugin pods on TCP 9443",
  "cas-gateway ingress policy shape is too broad or incomplete"
);
expect(
  "runtime:knowledge-ingress-policy",
  Boolean(networkPolicyByName.get("cas-knowledge-engine-ingress")),
  "cas-knowledge-engine ingress NetworkPolicy exists",
  "cas-knowledge-engine ingress NetworkPolicy is missing"
);
expect(
  "runtime:knowledge-ingress-gateway-only",
  knowledgeIngressPolicyShape(networkPolicyByName.get("cas-knowledge-engine-ingress")),
  "cas-knowledge-engine ingress allows only gateway pods on TCP 8080",
  "cas-knowledge-engine ingress policy shape is too broad or incomplete"
);
expect(
  "runtime:gateway-egress-no-broad-peers",
  policyIsRestrictive(networkPolicyByName.get("cas-gateway-egress")),
  "cas-gateway egress NetworkPolicy has no broad namespace, pod, or internet peers",
  "cas-gateway egress NetworkPolicy contains broad peers"
);
expect(
  "runtime:gateway-crc-api-egress-policy",
  policyIsRestrictive(networkPolicyByName.get("cas-gateway-crc-api-egress")) &&
    JSON.stringify(networkPolicyByName.get("cas-gateway-crc-api-egress")?.spec ?? {}).includes("10.217.4.1/32") &&
    JSON.stringify(networkPolicyByName.get("cas-gateway-crc-api-egress")?.spec ?? {}).includes("192.168.126.11/32"),
  "cas-gateway CRC API egress NetworkPolicy allows only CRC Kubernetes API service/endpoint IPs",
  "cas-gateway CRC API egress NetworkPolicy is missing or too broad"
);
expect(
  "runtime:gateway-effective-policies-no-broad-peers",
  gatewaySelectedPolicies.length >= 2 && gatewaySelectedPolicies.every(policyIsRestrictive),
  "all NetworkPolicies selecting cas-gateway have no broad namespace, pod, or internet peers",
  `broad or missing gateway-selected NetworkPolicy set: ${gatewaySelectedPolicies.map((policy) => policy.metadata?.name).join(",")}`
);
expect(
  "runtime:console-plugin-ingress-policy",
  consolePluginIngressPolicyShape(networkPolicyByName.get("cas-console-plugin-ingress")),
  "cas-console-plugin ingress allows only OpenShift Console on TCP 9443",
  "cas-console-plugin ingress policy is missing or too broad"
);
expect(
  "runtime:console-plugin-egress-policy",
  policyIsRestrictive(networkPolicyByName.get("cas-console-plugin-egress")),
  "cas-console-plugin egress is restricted to DNS and cas-gateway",
  "cas-console-plugin egress policy is missing or too broad"
);
expect(
  "runtime:console-plugin-effective-policies-no-broad-peers",
  consolePluginSelectedPolicies.length >= 2 && consolePluginSelectedPolicies.every(policyIsRestrictive),
  "all NetworkPolicies selecting cas-console-plugin have no broad namespace, pod, or internet peers",
  `broad or missing console-plugin-selected NetworkPolicy set: ${consolePluginSelectedPolicies.map((policy) => policy.metadata?.name).join(",")}`
);
expect(
  "runtime:knowledge-egress-no-broad-peers",
  policyIsRestrictive(networkPolicyByName.get("cas-knowledge-engine-egress")),
  "cas-knowledge-engine egress NetworkPolicy has no broad namespace, pod, or internet peers",
  "cas-knowledge-engine egress NetworkPolicy is missing or contains broad peers"
);
expect(
  "runtime:knowledge-effective-policies-no-broad-peers",
  knowledgeSelectedPolicies.length >= 2 && knowledgeSelectedPolicies.every(policyIsRestrictive),
  "all NetworkPolicies selecting cas-knowledge-engine have no broad namespace, pod, or internet peers",
  `broad or missing knowledge-selected NetworkPolicy set: ${knowledgeSelectedPolicies.map((policy) => policy.metadata?.name).join(",")}`
);
expect(
  "runtime:postgres-ingress-policy",
  postgresIngressPolicyShape(networkPolicyByName.get("cas-knowledge-postgres-ingress")),
  "cas-knowledge-postgres ingress allows only knowledge-engine on TCP 5432",
  "cas-knowledge-postgres ingress policy is missing or too broad"
);
expect(
  "runtime:postgres-egress-default-deny",
  policyDefaultDenyEgress(networkPolicyByName.get("cas-knowledge-postgres-egress")),
  "cas-knowledge-postgres egress is explicit default deny",
  "cas-knowledge-postgres egress default-deny policy is missing"
);
expect(
  "runtime:postgres-effective-policies-no-broad-peers",
  postgresSelectedPolicies.length >= 2 && postgresSelectedPolicies.every(policyIsRestrictive),
  "all NetworkPolicies selecting cas-knowledge-postgres have no broad namespace, pod, or internet peers",
  `broad or missing postgres-selected NetworkPolicy set: ${postgresSelectedPolicies.map((policy) => policy.metadata?.name).join(",")}`
);
const gatewayEnv = deploymentByName.get("cas-gateway")?.spec?.template?.spec?.containers?.[0]?.env ?? [];
const gatewayEnvByName = new Map(gatewayEnv.map((item) => [item.name, item.value]));
const knowledgeEnv = deploymentByName.get("cas-knowledge-engine")?.spec?.template?.spec?.containers?.[0]?.env ?? [];
const knowledgeEnvByName = new Map(knowledgeEnv.map((item) => [item.name, item.value ?? item.valueFrom?.secretKeyRef?.name]));
const envSecretRef = (env, name, secretName, key) => {
  const item = env.find((entry) => entry.name === name);
  return item?.valueFrom?.secretKeyRef?.name === secretName && item?.valueFrom?.secretKeyRef?.key === key;
};
expect(
  "runtime:gateway-brain-env",
  gatewayEnvByName.get("CAS_BRAIN_PROVIDER") === "openshift-lightspeed" &&
    gatewayEnvByName.get("CAS_LIGHTSPEED_URL")?.includes("lightspeed-app-server.openshift-lightspeed"),
  "cas-gateway is configured to use OpenShift Lightspeed as brain",
  "cas-gateway Lightspeed brain env is missing"
);
expect(
  "runtime:gateway-evidence-env",
  gatewayEnvByName.get("CAS_EVIDENCE_PROVIDER") === "openshift-api" &&
    gatewayEnvByName.get("CAS_OPENSHIFT_API_URL")?.includes("kubernetes.default.svc") &&
    gatewayEnvByName.get("CAS_OPENSHIFT_API_TLS_INSECURE") === "false" &&
    gatewayEnvByName.get("CAS_OPENSHIFT_API_CA_FILE") === "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
  "cas-gateway is configured to collect OpenShift API evidence",
  "cas-gateway OpenShift evidence env or TLS CA config is missing"
);
expect(
  "runtime:gateway-owner-identity-env",
  gatewayEnvByName.get("CAS_KNOWLEDGE_OWNER_IDENTITY_MODE") === "openshift-selfsubjectreview",
  "cas-gateway verifies knowledge owner identity through OpenShift SelfSubjectReview",
  "cas-gateway knowledge owner identity env is missing"
);
expect(
  "runtime:gateway-knowledge-env",
  gatewayEnvByName.get("CAS_KNOWLEDGE_ENGINE_URL")?.includes("cas-knowledge-engine"),
  "cas-gateway is configured to proxy CAS knowledge engine",
  "cas-gateway knowledge engine env is missing"
);
expect(
  "runtime:gateway-owner-hmac-env",
  envSecretRef(gatewayEnv, "CAS_KNOWLEDGE_OWNER_HMAC_SECRET", "cas-knowledge-internal-auth", "owner-hmac-secret"),
  "cas-gateway signs owner headers with the internal auth Secret",
  "cas-gateway owner HMAC Secret ref is missing"
);
expect(
  "runtime:gateway-request-limit-env",
  gatewayEnvByName.get("CAS_MAX_REQUEST_BYTES") === "26214400",
  "cas-gateway declares request body limit",
  "cas-gateway request body limit env is missing"
);
expect(
  "runtime:knowledge-database-env",
  knowledgeEnvByName.get("DATABASE_URL") === "cas-knowledge-postgres",
  "cas-knowledge-engine reads DATABASE_URL from Postgres secret",
  "cas-knowledge-engine DATABASE_URL secret env is missing"
);
expect(
  "runtime:knowledge-provider-env",
  knowledgeEnvByName.get("CAS_KNOWLEDGE_PROVIDER") === "pbs-compatible-local",
  "cas-knowledge-engine declares PBS-compatible provider mode",
  "cas-knowledge-engine provider env is missing"
);
expect(
  "runtime:knowledge-owner-env",
  knowledgeEnvByName.get("CAS_KNOWLEDGE_OWNER_MODE") === "trusted-header" &&
    knowledgeEnvByName.get("CAS_KNOWLEDGE_SINGLE_OWNER") === "cas-crc-dev",
  "cas-knowledge-engine declares trusted-header owner scope mode",
  "cas-knowledge-engine owner scope env is missing"
);
expect(
  "runtime:knowledge-owner-required-env",
  knowledgeEnvByName.get("CAS_KNOWLEDGE_REQUIRE_OWNER_HEADER") === "true",
  "cas-knowledge-engine requires trusted owner header",
  "cas-knowledge-engine trusted owner header requirement is missing"
);
expect(
  "runtime:knowledge-owner-hmac-env",
  envSecretRef(knowledgeEnv, "CAS_KNOWLEDGE_OWNER_HMAC_SECRET", "cas-knowledge-internal-auth", "owner-hmac-secret"),
  "cas-knowledge-engine verifies signed owner headers with the internal auth Secret",
  "cas-knowledge-engine owner HMAC Secret ref is missing"
);
expect(
  "runtime:knowledge-request-limit-env",
  knowledgeEnvByName.get("CAS_KNOWLEDGE_MAX_REQUEST_BYTES") === "26214400",
  "cas-knowledge-engine declares request body limit",
  "cas-knowledge-engine request body limit env is missing"
);

const devOperator = deploymentByName.get("cywell-ai-sentinel-operator");
if (devOperator) {
  expect(
    "runtime:operator-paused",
    Number(devOperator.spec?.replicas ?? 0) === 0 && Number(devOperator.status?.availableReplicas ?? 0) === 0,
    "v0.1.3 operator is paused so v0.1.4 dev manifests own runtime workloads",
    "v0.1.3 operator is not paused"
  );
}

const consolePlugin = getJson("console:plugin-cr", ["get", "consoleplugin", "cywell-ai-sentinel"]);
const proxy = consolePlugin?.spec?.proxy?.find((item) => item.alias === "cas-api");
expect(
  "console:plugin-contract",
  consolePlugin?.spec?.backend?.service?.name === "cas-console-plugin" && proxy?.endpoint?.service?.name === "cas-gateway",
  "ConsolePlugin backend and cas-api proxy are configured",
  "ConsolePlugin backend/proxy contract is incomplete"
);
expect(
  "console:proxy-usertoken",
  proxy?.authorization === "UserToken",
  "cas-api proxy forwards UserToken",
  `expected UserToken, got ${proxy?.authorization ?? "missing"}`
);

const consoleOperator = getJson("console:operator", ["get", "console.operator.openshift.io", "cluster"]);
const enabledPlugins = consoleOperator?.spec?.plugins ?? [];
const capabilities = consoleOperator?.spec?.customization?.capabilities ?? [];
const capabilityByName = new Map(capabilities.map((capability) => [capability.name, capability]));
expect("console:opslens-still-enabled", enabledPlugins.includes("cywell-opslens"), "cywell-opslens remains enabled");
expect("console:cas-enabled", enabledPlugins.includes("cywell-ai-sentinel"), "cywell-ai-sentinel is enabled");
expect(
  "console:lightspeed-replaced",
  !enabledPlugins.includes("lightspeed-console-plugin"),
  "lightspeed-console-plugin is disabled so CAS owns the AI launcher position",
  "lightspeed-console-plugin is still enabled"
);
expect(
  "console:lightspeed-button-hidden",
  capabilityByName.get("LightspeedButton")?.visibility?.state === "Disabled",
  "OpenShift native LightspeedButton capability is disabled so CAS is the visible AI launcher",
  "OpenShift native LightspeedButton capability is still enabled"
);

const pods = getJson("runtime:pods", ["get", "pods", "-n", namespace, "-l", "app.kubernetes.io/name=cywell-ai-sentinel"]);
const gatewayPod = pods?.items?.find((pod) => pod.metadata?.name?.startsWith("cas-gateway-") && podReady(pod));
const consolePod = pods?.items?.find((pod) => pod.metadata?.name?.startsWith("cas-console-plugin-") && podReady(pod));
const knowledgePod = pods?.items?.find((pod) => pod.metadata?.name?.startsWith("cas-knowledge-engine-") && podReady(pod));
const postgresPod = pods?.items?.find((pod) => pod.metadata?.name?.startsWith("cas-knowledge-postgres-") && podReady(pod));

for (const image of appRuntimeImages) {
  const pod = pods?.items?.find((item) => item.metadata?.name?.startsWith(image.podPrefix) && podReady(item));
  verifyAppRuntimeImage(image, pod, imageStreamTagByName);
}
verifyPostgresRuntimeImage(postgresPod);

expect("runtime:knowledge-pod", Boolean(knowledgePod), "knowledge engine pod is running", "no running knowledge engine pod");
expect("runtime:knowledge-postgres-pod", Boolean(postgresPod), "knowledge Postgres pod is running", "no running knowledge Postgres pod");

if (postgresPod) {
  const postgresExtensions = execPod(postgresPod.metadata.name, [
    "sh",
    "-ec",
    "psql -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" -tAc \"SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension WHERE extname IN ('pgcrypto','vector')\""
  ]);
  expect(
    "runtime:knowledge-postgres-extensions",
    postgresExtensions.ok && postgresExtensions.stdout.includes("pgcrypto") && postgresExtensions.stdout.includes("vector"),
    "knowledge Postgres has pgcrypto and vector extensions",
    postgresExtensions.stderr || postgresExtensions.stdout
  );

  const postgresTables = execPod(postgresPod.metadata.name, [
    "sh",
    "-ec",
    "psql -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" -tAc \"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('cas_knowledge_documents','cas_knowledge_chunks','cas_knowledge_notes','cas_knowledge_events','cas_knowledge_vector_readiness')\""
  ]);
  expect(
    "runtime:knowledge-postgres-tables",
    postgresTables.ok && postgresTables.stdout.trim() === "5",
    "knowledge Postgres has CAS knowledge tables",
    postgresTables.stderr || postgresTables.stdout
  );

  const pbsCompatTables = execPod(postgresPod.metadata.name, [
    "sh",
    "-ec",
    "psql -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" -tAc \"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('tenants','workspaces','document_sources','parsed_documents','document_chunks','chunk_embeddings','graph_entities','graph_entity_mentions','graph_entity_relations')\""
  ]);
  expect(
    "runtime:knowledge-postgres-pbs-compatible-schema",
    pbsCompatTables.ok && pbsCompatTables.stdout.trim() === "9",
    "knowledge Postgres has PBS-compatible document/chunk/embedding/graph tables",
    pbsCompatTables.stderr || pbsCompatTables.stdout
  );

  const vectorColumn = execPod(postgresPod.metadata.name, [
    "sh",
    "-ec",
    "psql -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" -tAc \"SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid='cas_knowledge_vector_readiness'::regclass AND attname='embedding'\""
  ]);
  expect(
    "runtime:knowledge-postgres-vector-dimension",
    vectorColumn.ok && vectorColumn.stdout.trim() === "vector(768)",
    "knowledge Postgres exposes vector(768) readiness column",
    vectorColumn.stderr || vectorColumn.stdout
  );
}

if (gatewayPod) {
  const health = execNode(
    gatewayPod.metadata.name,
    "const https=require('https');https.get('https://127.0.0.1:9443/api/aiops/healthz',{rejectUnauthorized:false},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{console.log(JSON.stringify({status:r.statusCode,body:b}));});}).on('error',e=>{console.error(e.message);process.exit(1);});"
  );
  let healthOk = false;
  try {
    const parsed = JSON.parse(health.stdout);
    const body = JSON.parse(parsed.body);
    healthOk = parsed.status === 200 && body.status === "ok";
  } catch {
    healthOk = false;
  }
  expect("runtime:gateway-health", health.ok && healthOk, "gateway healthz ok", health.stderr || health.stdout);

  const knowledgeHealth = execNode(
    gatewayPod.metadata.name,
    "const https=require('https');https.get('https://127.0.0.1:9443/api/knowledge/healthz',{rejectUnauthorized:false},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{console.log(JSON.stringify({status:r.statusCode,body:b}));});}).on('error',e=>{console.error(e.message);process.exit(1);});"
  );
  let knowledgeHealthOk = false;
  try {
    const parsed = JSON.parse(knowledgeHealth.stdout);
    const body = JSON.parse(parsed.body);
    knowledgeHealthOk =
      parsed.status === 200 &&
      body.service === "cas-knowledge-engine" &&
      body.status === "ok" &&
      body.provider === undefined &&
      body.engine?.provider === undefined &&
      Array.isArray(body.capabilities) &&
      body.storage === undefined &&
      body.counts === undefined &&
      body.provider_config === undefined &&
      body.engine?.endpoint === undefined;
  } catch {
    knowledgeHealthOk = false;
  }
  expect(
    "runtime:knowledge-health-through-gateway",
    knowledgeHealth.ok && knowledgeHealthOk,
    "gateway exposes sanitized knowledge engine public health",
    knowledgeHealth.stderr || knowledgeHealth.stdout
  );

  const knowledgeSmokeCode = [
    "const https=require('https');",
    `const smokeToken=${JSON.stringify(crcKnowledgeSmokeToken)};`,
    "const customerId='crc-smoke';",
    "const lineageToken=`crc-lineage-${Date.now()}`;",
    "const fileName=`crc-runbook-${lineageToken}.txt`; ",
    "function req(path,method='GET',body,auth=true,extraHeaders={}){return new Promise((resolve,reject)=>{const payload=body?JSON.stringify(body):undefined;const headers={'content-type':'application/json','content-length':payload?Buffer.byteLength(payload):0,...extraHeaders};if(auth)headers.authorization=`Bearer ${smokeToken}`;const r=https.request(`https://127.0.0.1:9443${path}`,{method,rejectUnauthorized:false,headers},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b)}));});r.on('error',reject);if(payload)r.write(payload);r.end();});}",
    "(async()=>{",
    "const noOwner=await req('/api/knowledge/rag/query','POST',{customer_id:customerId,question:'router latency evidence'},false);",
    "const spoofRemote=await req('/api/knowledge/rag/query','POST',{customer_id:customerId,question:'router latency evidence'},false,{'x-remote-user':'spoofed-crc-user'});",
    "const spoofOpenShift=await req('/api/knowledge/rag/query','POST',{customer_id:customerId,question:'router latency evidence'},false,{'x-openshift-user':'spoofed-crc-user'});",
    "const upload=await req('/api/knowledge/uploads/ingest','POST',{customer_id:customerId,file_name:fileName,filename:fileName,content:`${lineageToken} OpenShift router latency links to route shards, HAProxy logs, certificates, and namespace events.`,source_scope:'user_upload',visibility:'private_user',source_kind:'upload',source_metadata:{customer_id:customerId,verifier:'crc',lineage_token:lineageToken},force_reingest:false,index:true});",
    "const uploadedDocumentId=upload.body.document?.id;",
    "const uploadWikiNote=Array.isArray(upload.body.wiki?.notes)?upload.body.wiki.notes.find(n=>n.document_id===uploadedDocumentId):null;",
    "const base64=Buffer.from('Base64 customer uploads remain searchable after gateway proxying.','utf8').toString('base64');",
    "const encoded=await req('/api/knowledge/uploads/ingest','POST',{customer_id:customerId,filename:`crc-base64-${lineageToken}.txt`,content_base64:base64,mime_type:'text/plain'});",
    "const url=await req('/api/knowledge/uploads/url-ingest','POST',{customer_id:customerId,url:`https://93.184.216.34/${lineageToken}/crc-runbook`,content:'URL ingest keeps PBS wiki compilation metadata for CRC topology knowledge.',source_scope:'user_upload',visibility:'private_user',source_kind:'url',source_metadata:{customer_id:customerId,verifier:'crc'},force_reingest:false,index:true,auto_compile_wiki:true});",
    "const rag=await req('/api/knowledge/rag/query','POST',{customer_id:customerId,question:`${lineageToken} router latency evidence`});",
    "const ragCitations=Array.isArray(rag.body.citations)?rag.body.citations:[];",
    "const ragLineageOk=Boolean(uploadedDocumentId)&&ragCitations.some(c=>c.document_id===uploadedDocumentId||c.title===upload.body.document?.title||String(c.snippet||'').includes(lineageToken));",
    "const wiki=await req('/api/knowledge/wiki-loop/run','POST',{customer_id:customerId,document_id:uploadedDocumentId});",
    "const wikiNote=Array.isArray(wiki.body.notes)?wiki.body.notes.find(n=>n.document_id===uploadedDocumentId):null;",
    "const topology=await req(`/api/knowledge/topology?customer_id=${customerId}`);",
    "const nodes=Array.isArray(topology.body.nodes)?topology.body.nodes:[];",
    "const edges=Array.isArray(topology.body.edges)?topology.body.edges:[];",
    "const ids=new Set(nodes.map(n=>String(n.id||'')).filter(Boolean));",
    "const graphOk=nodes.length>0&&edges.length>0&&edges.every(e=>ids.has(String(e.source||''))&&ids.has(String(e.target||'')));",
    "const typeOk=nodes.some(n=>['document','upload_document','wiki-note','term','wikilink','tag','concept'].includes(String(n.type||'')));",
    "const docNode=nodes.find(n=>n.id===uploadedDocumentId&&['document','upload_document'].includes(String(n.type||'')));",
    "const noteNode=nodes.find(n=>n.type==='wiki-note'&&(n.id===wikiNote?.id||n.document_id===uploadedDocumentId||n.source_document_id===uploadedDocumentId));",
    "const topologyLineageOk=Boolean(docNode&&noteNode)&&edges.some(e=>e.source===noteNode.id&&e.target===docNode.id&&e.type==='summarizes');",
    "console.log(JSON.stringify({customerId,lineageToken,fileName,uploadedDocumentId,noOwnerStatus:noOwner.status,spoofRemoteStatus:spoofRemote.status,spoofOpenShiftStatus:spoofOpenShift.status,upload:upload.body.status,encoded:encoded.body.status,url:url.body.status,encodedParser:encoded.body.document?.metadata?.parser,pbsFileName:upload.body.document?.metadata?.pbs_payload?.file_name,pbsIndex:upload.body.document?.metadata?.pbs_payload?.index,urlWiki:url.body.document?.metadata?.pbs_payload?.auto_compile_wiki,uploadWikiRevision:uploadWikiNote?.revision,uploadWikiPreviousRevision:uploadWikiNote?.previous_revision,ragCitations:ragCitations.length,ragLineageOk,wikiNotes:wiki.body.notes_upserted||0,wikiNoteRevision:wikiNote?.revision,wikiNotePreviousRevision:wikiNote?.previous_revision,nodes:topology.body.counts?.nodes||0,edges:topology.body.counts?.edges||0,graphOk,typeOk,topologyLineageOk,topologyNoteRevision:noteNode?.revision}));",
    "})().catch(e=>{console.error(e.message);process.exit(1);});"
  ].join("");
  const knowledgeSmoke = execNode(gatewayPod.metadata.name, knowledgeSmokeCode, 30000);
  const knowledgeSmokeBody = parseLastJsonLine(knowledgeSmoke.stdout);
  expect(
    "runtime:knowledge-smoke-through-gateway",
    knowledgeSmoke.ok &&
      knowledgeSmokeBody?.upload === "indexed" &&
      knowledgeSmokeBody?.encoded === "indexed" &&
      knowledgeSmokeBody?.url === "indexed" &&
      knowledgeSmokeBody?.noOwnerStatus === 401 &&
      knowledgeSmokeBody?.spoofRemoteStatus === 401 &&
      knowledgeSmokeBody?.spoofOpenShiftStatus === 401 &&
      knowledgeSmokeBody?.encodedParser === "binary-text" &&
      knowledgeSmokeBody?.pbsFileName === knowledgeSmokeBody?.fileName &&
      knowledgeSmokeBody?.pbsIndex === true &&
      knowledgeSmokeBody?.urlWiki === true &&
      Number(knowledgeSmokeBody?.ragCitations ?? 0) > 0 &&
      Number(knowledgeSmokeBody?.wikiNotes ?? 0) > 0 &&
      Number(knowledgeSmokeBody?.nodes ?? 0) > 0 &&
      Number(knowledgeSmokeBody?.edges ?? 0) > 0 &&
      knowledgeSmokeBody?.graphOk === true &&
      knowledgeSmokeBody?.typeOk === true,
    "gateway supports upload -> RAG -> wiki -> topology smoke",
    knowledgeSmoke.stderr || knowledgeSmoke.stdout
  );
  expect(
    "runtime:knowledge-smoke-lineage",
    knowledgeSmoke.ok &&
      Boolean(knowledgeSmokeBody?.uploadedDocumentId) &&
      knowledgeSmokeBody?.uploadWikiRevision === 1 &&
      knowledgeSmokeBody?.uploadWikiPreviousRevision === 0 &&
      knowledgeSmokeBody?.ragLineageOk === true &&
      knowledgeSmokeBody?.wikiNoteRevision === 2 &&
      knowledgeSmokeBody?.wikiNotePreviousRevision === 1 &&
      knowledgeSmokeBody?.topologyLineageOk === true &&
      knowledgeSmokeBody?.topologyNoteRevision === 2,
    "gateway smoke preserves exact uploaded document lineage through RAG, LLM Wiki revision, and topology edge",
    knowledgeSmoke.stderr || knowledgeSmoke.stdout
  );
  if (postgresPod) {
    const persistedExactSmoke = knowledgeSmokeBody?.uploadedDocumentId
      ? execPod(postgresPod.metadata.name, [
          "sh",
          "-ec",
          `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT (SELECT COUNT(*) FROM cas_knowledge_documents WHERE id='${knowledgeSmokeBody.uploadedDocumentId}' AND customer_id='crc-smoke' AND owner_id='${crcKnowledgeSmokeOwner}') || ',' || (SELECT COUNT(*) FROM cas_knowledge_chunks WHERE document_id='${knowledgeSmokeBody.uploadedDocumentId}' AND customer_id='crc-smoke' AND owner_id='${crcKnowledgeSmokeOwner}') || ',' || (SELECT COUNT(*) FROM cas_knowledge_notes WHERE payload->>'document_id'='${knowledgeSmokeBody.uploadedDocumentId}' AND customer_id='crc-smoke' AND owner_id='${crcKnowledgeSmokeOwner}') || ',' || (SELECT COUNT(*) FROM cas_knowledge_events WHERE payload->>'document_id'='${knowledgeSmokeBody.uploadedDocumentId}' AND customer_id='crc-smoke' AND owner_id='${crcKnowledgeSmokeOwner}')"`
        ])
      : { ok: false, stdout: "", stderr: "knowledge smoke did not return uploadedDocumentId" };
    const persistedExactCounts = persistedExactSmoke.stdout.trim().split(",").map((value) => Number(value));
    expect(
      "runtime:knowledge-smoke-exact-persisted",
      persistedExactSmoke.ok &&
        persistedExactCounts.length === 4 &&
        persistedExactCounts[0] === 1 &&
        persistedExactCounts[1] >= 1 &&
        persistedExactCounts[2] === 1 &&
        persistedExactCounts[3] >= 1,
      "knowledge smoke persists exact uploaded document, chunks, note, and event rows in Postgres owner scope",
      persistedExactSmoke.stderr || persistedExactSmoke.stdout
    );
    const pbsCompatPersisted = execPod(postgresPod.metadata.name, [
      "sh",
      "-ec",
      `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT (SELECT COUNT(*) FROM document_sources WHERE metadata->>'cas_document_id'='${knowledgeSmokeBody.uploadedDocumentId}' AND metadata->>'customer_id'='crc-smoke' AND metadata->>'owner_id'='${crcKnowledgeSmokeOwner}') || ',' || (SELECT COUNT(*) FROM parsed_documents WHERE metadata->>'cas_document_id'='${knowledgeSmokeBody.uploadedDocumentId}') || ',' || (SELECT COUNT(*) FROM document_chunks WHERE metadata->>'cas_document_id'='${knowledgeSmokeBody.uploadedDocumentId}' AND metadata->>'customer_id'='crc-smoke' AND metadata->>'owner_id'='${crcKnowledgeSmokeOwner}') || ',' || (SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid='chunk_embeddings'::regclass AND attname='embedding')"`
    ]);
    const pbsCompatParts = pbsCompatPersisted.stdout.trim().split(",");
    expect(
      "runtime:knowledge-pbs-compat-shadow-persisted",
      pbsCompatPersisted.ok &&
        pbsCompatParts.length === 4 &&
        Number(pbsCompatParts[0]) === 1 &&
        Number(pbsCompatParts[1]) === 1 &&
        Number(pbsCompatParts[2]) >= 1 &&
        pbsCompatParts[3] === "vector(768)",
      "knowledge smoke also writes PBS-compatible document source, parsed document, and chunk shadow rows",
      pbsCompatPersisted.stderr || pbsCompatPersisted.stdout
    );
    const persistedSmoke = execPod(postgresPod.metadata.name, [
      "sh",
      "-ec",
      `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT COUNT(*) FROM cas_knowledge_documents WHERE customer_id='crc-smoke' AND owner_id='${crcKnowledgeSmokeOwner}'"`
    ]);
    expect(
      "runtime:knowledge-smoke-persisted",
      persistedSmoke.ok && Number(persistedSmoke.stdout.trim()) >= 1,
      "knowledge smoke persists document rows in Postgres owner scope",
      persistedSmoke.stderr || persistedSmoke.stdout
    );
  }

  const brainz = execNode(
    gatewayPod.metadata.name,
    "const https=require('https');https.get('https://127.0.0.1:9443/api/aiops/brainz',{rejectUnauthorized:false},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{console.log(JSON.stringify({status:r.statusCode,body:b}));});}).on('error',e=>{console.error(e.message);process.exit(1);});",
    30000
  );
  let brainzOk = false;
  try {
    const parsed = JSON.parse(brainz.stdout);
    const body = JSON.parse(parsed.body);
    brainzOk = parsed.status === 200 && body.brain?.provider === "openshift-lightspeed";
  } catch {
    brainzOk = false;
  }
  expect("runtime:gateway-brainz", brainz.ok && brainzOk, "gateway brainz confirms OpenShift Lightspeed readiness", brainz.stderr || brainz.stdout);
} else {
  fail("runtime:gateway-health", "no running gateway pod");
}

if (consolePod) {
  const manifest = execNode(
    consolePod.metadata.name,
    "const https=require('https');https.get('https://127.0.0.1:9443/plugin-manifest.json',{rejectUnauthorized:false},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{const j=JSON.parse(b);console.log(JSON.stringify({status:r.statusCode,types:j.extensions.map(e=>e.type),refs:JSON.stringify(j.extensions)}));});}).on('error',e=>{console.error(e.message);process.exit(1);});"
  );
  expect(
    "console:launcher-extension",
    manifest.ok &&
      manifest.stdout.includes("console.context-provider") &&
      manifest.stdout.includes("useCASLauncher") &&
      manifest.stdout.includes("console.navigation/href") &&
      manifest.stdout.includes("console.page/route") &&
      manifest.stdout.includes("CywellKnowledgeRoute") &&
      manifest.stdout.includes("/cywell/customer-data"),
    "CAS plugin registers launcher plus Cywell knowledge navigation/routes",
    manifest.stderr || manifest.stdout
  );
  const knowledgeChunk = execNode(
    consolePod.metadata.name,
    "const https=require('https');https.get('https://127.0.0.1:9443/exposed-CywellKnowledgeRoute-chunk.js',{rejectUnauthorized:false},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{console.log(JSON.stringify({status:r.statusCode,hasTopology:b.includes('cas-topology-dashboard'),hasNode:b.includes('cas-topology-node'),hasKpis:b.includes('cas-topology-kpis'),hasRelations:b.includes('cas-topology-relation-grid'),hasRagAction:b.includes('Ask RAG about this node')}));});}).on('error',e=>{console.error(e.message);process.exit(1);});"
  );
  expect(
    "console:topology-dashboard-bundle",
    knowledgeChunk.ok &&
      knowledgeChunk.stdout.includes("\"status\":200") &&
      knowledgeChunk.stdout.includes("\"hasTopology\":true") &&
      knowledgeChunk.stdout.includes("\"hasNode\":true") &&
      knowledgeChunk.stdout.includes("\"hasKpis\":true") &&
      knowledgeChunk.stdout.includes("\"hasRelations\":true") &&
      knowledgeChunk.stdout.includes("\"hasRagAction\":true"),
    "live console plugin bundle contains topology dashboard visualization",
    knowledgeChunk.stderr || knowledgeChunk.stdout
  );
  const directKnowledge = execNode(
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
  expect(
    "runtime:knowledge-direct-access-blocked",
    directKnowledge.ok && directKnowledge.stdout.includes("\"blocked\"") && !directKnowledge.stdout.includes("\"status\":200"),
    "console-plugin pod cannot directly reach cas-knowledge-engine; gateway is the ingress path",
    directKnowledge.stderr || directKnowledge.stdout
  );

  const queryCode = [
    "const https=require('https');",
    "const payload=JSON.stringify({question:'default namespace의 api pod가 왜 재시작됐어?',scope:{cluster:'local-cluster',namespaces:['default']},resourceRef:{kind:'Pod',name:'api-7c8d9'},mode:'read_only',stream:false});",
    "const req=https.request('https://127.0.0.1:9443/api/aiops/query',{method:'POST',rejectUnauthorized:false,headers:{'content-type':'application/json','content-length':Buffer.byteLength(payload)}},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{const j=JSON.parse(b);console.log(JSON.stringify({status:r.statusCode,mode:j.mode,topCause:j.rca_result?.cause_candidates?.[0]?.cause,evidence:j.evidence_bundle?.evidence?.length}));});});",
    "req.on('error',e=>{console.error(e.message);process.exit(1);});req.write(payload);req.end();"
  ].join("");
  const query = execNode(consolePod.metadata.name, queryCode);
  expect(
    "runtime:fallback-query-through-plugin",
    query.ok && query.stdout.includes("memory limit exceeded") && query.stdout.includes("lightspeed_fallback_mock"),
    "console plugin without token degrades visibly to fallback mock RCA",
    query.stderr || query.stdout
  );

  const token = run("oc", ["whoami", "-t"], 30000);
  if (!token.ok || !token.stdout) {
    fail("runtime:lightspeed-query-through-plugin", "could not obtain local oc user token");
  } else {
    const tokenB64 = Buffer.from(token.stdout, "utf8").toString("base64");
    const liveQueryCode = [
      "const https=require('https');",
      `const token=Buffer.from('${tokenB64}','base64').toString('utf8');`,
      "const payload=JSON.stringify({question:'ClusterVersion 상태를 한 문장으로 요약해줘.',scope:{cluster:'local-cluster',namespaces:['default']},resourceRef:{kind:'ClusterVersion',name:'version'},mode:'read_only',stream:false,locale:'ko-KR'});",
      "const req=https.request('https://127.0.0.1:9443/api/aiops/query',{method:'POST',rejectUnauthorized:false,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','content-length':Buffer.byteLength(payload)}},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{const j=JSON.parse(b);console.log(JSON.stringify({status:r.statusCode,mode:j.mode,provider:j.audit?.answer_provider,brain:j.audit?.brain?.status,evidence:j.audit?.evidence,answerLength:j.rca_result?.answer?.length||0,conversation:!!j.conversation_id,evidenceIds:(j.evidence_bundle?.evidence??[]).map(e=>e.id).slice(0,8)}));});});",
      "req.on('error',e=>{console.error(e.message);process.exit(1);});req.write(payload);req.end();"
    ].join("");
    const liveQuery = execNode(consolePod.metadata.name, liveQueryCode, 150000);
    expect(
      "runtime:lightspeed-query-through-plugin",
      liveQuery.ok &&
        liveQuery.stdout.includes("lightspeed_read_only") &&
        liveQuery.stdout.includes("openshift-lightspeed") &&
        liveQuery.stdout.includes("\"brain\":\"ok\"") &&
        liveQuery.stdout.includes("openshift:clusterversion:version"),
      "console plugin forwards user token, CAS collects OpenShift evidence, and Lightspeed answers",
      liveQuery.stderr || liveQuery.stdout
    );
  }
} else {
  fail("runtime:fallback-query-through-plugin", "no running console plugin pod");
}

const failures = checks.filter((check) => check.status === "FAIL");
const finalStatus = failures.length > 0 ? "FAIL" : "PASS";
mkdirSync("test-results", { recursive: true });
writeFileSync(
  "test-results/cas-crc-deployment.json",
  JSON.stringify(
    {
      checkedAt,
      branch: run("git", ["branch", "--show-current"]).stdout,
      head: run("git", ["rev-parse", "--short", "HEAD"]).stdout,
      namespace,
      verifiedImages,
      status: finalStatus,
      summary: {
        total: checks.length,
        passed: checks.filter((check) => check.status === "PASS").length,
        failed: failures.length
      },
      checks
    },
    null,
    2
  )
);
console.log(`CAS CRC deployment final status: ${finalStatus}`);
console.log("Evidence: test-results/cas-crc-deployment.json");
if (failures.length > 0) process.exitCode = 1;
