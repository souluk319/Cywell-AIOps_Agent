#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const namespace = process.env.CAS_PBS_PREFLIGHT_NAMESPACE || "cywell-ai-sentinel";
const overlayArg = process.argv.find((arg) => arg.startsWith("--overlay="))?.split("=")[1] ?? process.env.CAS_PBS_PREFLIGHT_OVERLAY ?? "pbs-live";
const rawOverlayPathArg = process.argv.find((arg) => arg.startsWith("--overlay-path="))?.split("=")[1] ?? process.env.CAS_PBS_PREFLIGHT_OVERLAY_PATH ?? "";
const livePrereqsOutputDir = process.env.CAS_PBS_LIVE_PREREQS_OUT_DIR || "test-results/pbs-live-prereqs";
const livePrereqsSiteOverlayPath = normalizePath(`${livePrereqsOutputDir.replace(/[\\/]+$/, "")}/pbs-live-site`);
const overlayPathArg = rawOverlayPathArg === "live-prereqs-site" ? livePrereqsSiteOverlayPath : rawOverlayPathArg;
const validOverlays = new Set(["pbs-shadow", "pbs-live"]);
const overlayNameValid = validOverlays.has(overlayArg);
const overlay = overlayNameValid ? overlayArg : overlayArg || "invalid";
const overlayPath = overlayPathArg || `deploy/kustomize/overlays/${overlay}`;
const requireCluster = process.argv.includes("--require-cluster") || envBool("CAS_PBS_PREFLIGHT_REQUIRE_CLUSTER");
const requireSecret = process.argv.includes("--require-secret") || envBool("CAS_PBS_PREFLIGHT_REQUIRE_SECRET");
const skipApplied = process.argv.includes("--skip-applied") || envBool("CAS_PBS_PREFLIGHT_SKIP_APPLIED");
const checkedAt = new Date().toISOString();
const checks = [];
const releaseImagesEvidencePath = process.env.CAS_RELEASE_IMAGES_EVIDENCE || "test-results/cas-release-images.json";
const pbsPinnedSourceEvidencePath = process.env.CAS_PBS_SOURCE_EVIDENCE || "test-results/cas-pbs-source-contract-pinned.json";
const livePrereqsEvidencePath = process.env.CAS_PBS_LIVE_PREREQS_EVIDENCE || "test-results/cas-pbs-live-prereqs-render.json";
const maxPinnedSourceEvidenceAgeMinutesInput = Number(process.env.CAS_PBS_PREFLIGHT_MAX_SOURCE_PROOF_AGE_MINUTES || 120);
const maxPinnedSourceEvidenceAgeMinutes = Number.isFinite(maxPinnedSourceEvidenceAgeMinutesInput) && maxPinnedSourceEvidenceAgeMinutesInput > 0 ? maxPinnedSourceEvidenceAgeMinutesInput : 120;
const evidencePhase = skipApplied ? "preapply" : overlay === "pbs-shadow" && !requireCluster ? "diagnostic" : "applied";
const evidenceScope = requireCluster ? "cluster" : "local";
const evidenceOverlay = overlayPathArg ? evidenceToken(lastPathSegment(overlayPath) || `${overlay}-custom`) : overlay;
const evidenceSuffix = [evidenceOverlay, evidencePhase, evidenceScope, requireSecret ? "required-secrets" : "optional-secrets"].join("-");
const evidencePath = `test-results/cas-pbs-preflight-${evidenceSuffix}.json`;
const pbsRuntimeSourceEvidence = [];
const pbsRuntimeHealthEvidence = [];
let pbsRuntimeProbePodName = "";
let pbsRuntimeServicePresent = false;
let strictPinnedPbsSourceEvidence = null;
const strictApprovedPbsRemotePattern = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)souluk319\/PBS_DEV_Part3(?:\.git)?$/i;
const approvedCywellRemotePattern = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)souluk319\/Cywell-AIOps_Agent(?:\.git)?$/i;
const approvedPbsSourceHead = "6604777abb9e6bd44a83c6a12f36e31ac396489e";
const maxEvidenceFutureSkewMs = 5 * 60 * 1000;
const requiredPbsContractFiles = [
  "deploy/Dockerfile",
  "deploy/openshift/core.yaml",
  "deploy/openshift-cywell-v014/README.md",
  "deploy/openshift-cywell-v014/kustomization.yaml",
  "deploy/openshift-cywell-v014/runtime-service.yaml",
  "deploy/openshift-cywell-v014/runtime-contract-patch.yaml",
  "deploy/openshift-cywell-v014/runtime-tls-patch.yaml",
  "deploy/openshift-cywell-v014/configmap-runtime-patch.yaml",
  "deploy/openshift-cywell-v014/lightspeed-networkpolicy-patch.yaml",
  "deploy/openshift-cywell-v014/terminal-broker-subject-patch.yaml",
  "docker-compose.yml",
  "src/play_book_studio/config/settings.py",
  "src/play_book_studio/http/server.py",
  "src/play_book_studio/http/public_chat_gateway.py",
  "src/play_book_studio/http/server_handler_factory.py",
  "src/play_book_studio/http/server_handler_base.py",
  "src/play_book_studio/http/upload_api.py",
  "src/play_book_studio/http/url_ingest_api.py",
  "src/play_book_studio/http/server_chat.py",
  "src/play_book_studio/http/wiki_vault.py",
  "src/play_book_studio/wiki_loop.py"
];

function envBool(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  return ["1", "true", "yes", "y", "on"].includes(String(raw).trim().toLowerCase());
}

function normalizePath(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

function sha256Text(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function fullGitSha(value) {
  return /^[a-f0-9]{40}$/i.test(String(value ?? "").trim());
}

function lastPathSegment(value) {
  return normalizePath(value).split("/").filter(Boolean).pop() ?? "";
}

function evidenceToken(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: options.timeoutMs ?? 60000,
    windowsHide: true,
    input: options.input
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? ""
  };
}

function resultIsNotFound(result) {
  return /not\s*found|NotFound/i.test(`${result.stderr}\n${result.stdout}`);
}

function currentClusterIdentity() {
  const value = (args) => {
    const result = run("oc", args, { timeoutMs: 10000 });
    return result.ok ? result.stdout.trim() : "";
  };
  return {
    context: value(["config", "current-context"]),
    server: value(["whoami", "--show-server"]),
    namespace,
    namespaceUid: value(["get", "namespace", namespace, "-o", "jsonpath={.metadata.uid}"]),
    infrastructureName: value(["get", "infrastructure", "cluster", "-o", "jsonpath={.status.infrastructureName}"])
  };
}

function clusterIdentityMatches(expected = {}, actual = {}) {
  return (
    expected.namespace === actual.namespace &&
    expected.namespaceUid === actual.namespaceUid &&
    expected.server === actual.server &&
    expected.infrastructureName === actual.infrastructureName
  );
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

function parseJsonObjectStream(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return parsed?.kind === "List" && Array.isArray(parsed.items) ? parsed.items : [parsed];
  } catch {
    const objects = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < trimmed.length; index += 1) {
      const char = trimmed[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === "\"") inString = false;
        continue;
      }
      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "{") {
        if (depth === 0) start = index;
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          const parsed = JSON.parse(trimmed.slice(start, index + 1));
          if (parsed?.kind === "List" && Array.isArray(parsed.items)) objects.push(...parsed.items);
          else objects.push(parsed);
          start = -1;
        }
      }
    }
    if (depth !== 0 || objects.length === 0) throw new Error("could not split rendered JSON objects");
    return objects;
  }
}

function renderKustomizeObjects(rendered) {
  if (!rendered.trim()) return [];
  const attempts = [
    ["oc", ["create", "--dry-run=client", "-f", "-", "-o", "json"]],
    ["kubectl", ["create", "--dry-run=client", "-f", "-", "-o", "json"]]
  ];
  const errors = [];
  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      input: rendered,
      timeout: 90000,
      windowsHide: true
    });
    if (result.status === 0 && result.stdout.trim()) {
      try {
        const objects = parseJsonObjectStream(result.stdout);
        pass("preflight:render-json", `${command} parsed rendered ${overlayPath} into ${objects.length} Kubernetes objects`);
        return objects;
      } catch (error) {
        errors.push(`${command}: ${error.message}`);
      }
    } else {
      errors.push(`${command}: ${result.stderr?.trim() || result.error?.message || `exit ${result.status}`}`);
    }
  }
  fail("preflight:render-json", `unable to parse rendered ${overlayPath} as Kubernetes JSON: ${errors.join("; ")}`);
  return [];
}

function renderedDoc(rendered, kind, name) {
  const kindPattern = new RegExp(`^kind:\\s*${escapeRegExp(kind)}\\s*$`, "m");
  const namePattern = new RegExp(`^\\s*name:\\s*${escapeRegExp(name)}\\s*$`, "m");
  return rendered.split(/^---\s*$/m).find((doc) => kindPattern.test(doc) && namePattern.test(doc)) ?? "";
}

function renderedObject(objects, kind, name) {
  return objects.find((object) => object?.kind === kind && object?.metadata?.name === name);
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

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { __error: error.message };
  }
}

function livePrereqSecretHashBinding(authSecret, ownerAuthSecret, liveDbSecret) {
  const reasons = [];
  const evidence = existsSync(livePrereqsEvidencePath) ? readJsonFile(livePrereqsEvidencePath) : null;
  if (!evidence) reasons.push(`${livePrereqsEvidencePath} is missing`);
  if (evidence?.__error) reasons.push(`${livePrereqsEvidencePath} could not be parsed: ${evidence.__error}`);
  if (evidence && evidence.status !== "PASS") reasons.push(`live prerequisite evidence status is ${evidence.status || "missing"}`);
  if (evidence && evidence.mode !== "real-render") reasons.push(`live prerequisite evidence mode is ${evidence.mode || "missing"}`);
  if (evidence && evidence.treeStatus !== "clean") reasons.push(`live prerequisite evidence source tree is ${evidence.treeStatus || "missing"}`);
  const summaryPath = evidence?.outputFileSha256?.summary?.path;
  const summary = summaryPath && existsSync(summaryPath) ? readJsonFile(summaryPath) : null;
  if (!summaryPath) reasons.push("live prerequisite evidence does not record the redacted summary path");
  if (summary?.__error) reasons.push(`${summaryPath} could not be parsed: ${summary.__error}`);
  if (summaryPath && !summary) reasons.push(`${summaryPath} is missing`);
  if (summary && sha256Text(JSON.stringify(summary, null, 2)) !== evidence?.redactedSummarySha256) {
    reasons.push("live prerequisite redacted summary hash does not match evidence");
  }
  const bearerToken = decodeSecretValue(authSecret, "bearer-token");
  const ownerHmacSecret = decodeSecretValue(ownerAuthSecret, "owner-hmac-secret");
  const liveDbValues = {
    database: decodeSecretValue(liveDbSecret, "database"),
    username: decodeSecretValue(liveDbSecret, "username"),
    password: decodeSecretValue(liveDbSecret, "password"),
    databaseUrl: decodeSecretValue(liveDbSecret, "database-url")
  };
  if (summary) {
    if (sha256Text(bearerToken) !== summary.casPbsAuth?.bearerTokenSha256) reasons.push("cas-pbs-auth bearer-token does not match the approved live prereq render hash");
    if (sha256Text(ownerHmacSecret) !== summary.casKnowledgeInternalAuth?.ownerHmacSecretSha256) reasons.push("cas-knowledge-internal-auth owner-hmac-secret does not match the approved live prereq render hash");
    if (liveDbValues.database !== summary.casKnowledgePostgresLive?.database) reasons.push("cas-knowledge-postgres-live database does not match the approved live prereq render");
    if (liveDbValues.username !== summary.casKnowledgePostgresLive?.username) reasons.push("cas-knowledge-postgres-live username does not match the approved live prereq render");
    if (sha256Text(liveDbValues.password) !== summary.casKnowledgePostgresLive?.passwordSha256) reasons.push("cas-knowledge-postgres-live password does not match the approved live prereq render hash");
    if (sha256Text(liveDbValues.databaseUrl) !== summary.casKnowledgePostgresLive?.databaseUrlSha256) reasons.push("cas-knowledge-postgres-live database-url does not match the approved live prereq render hash");
  }
  return {
    ok: reasons.length === 0,
    reasons,
    evidencePath: livePrereqsEvidencePath,
    summaryPath: summaryPath || "",
    secretHashes: {
      bearerTokenSha256: bearerToken ? sha256Text(bearerToken) : "",
      ownerHmacSecretSha256: ownerHmacSecret ? sha256Text(ownerHmacSecret) : "",
      postgresPasswordSha256: liveDbValues.password ? sha256Text(liveDbValues.password) : "",
      postgresDatabaseUrlSha256: liveDbValues.databaseUrl ? sha256Text(liveDbValues.databaseUrl) : ""
    }
  };
}

function valueLooksPlaceholder(value) {
  const clean = String(value ?? "").trim().toLowerCase();
  return (
    !clean ||
    /[\x00-\x1f\x7f]/.test(clean) ||
    /^(changeme|change-me|todo|placeholder|example|sample|dummy|token|bearer-token|secret|password|dev|test|none|null|x+|\*+)$/.test(clean) ||
    clean.includes("cas_knowledge_dev")
  );
}

function bearerTokenLooksUsable(value) {
  const clean = String(value ?? "").trim();
  return clean.length >= 20 && !/\s/.test(clean) && !valueLooksPlaceholder(clean);
}

function ownerHmacSecretLooksUsable(value) {
  const clean = String(value ?? "").trim();
  return clean.length >= 32 && !/\s/.test(clean) && !valueLooksPlaceholder(clean);
}

function postgresSecretValuesUsable(secret) {
  const values = {
    database: decodeSecretValue(secret, "database"),
    username: decodeSecretValue(secret, "username"),
    password: decodeSecretValue(secret, "password"),
    databaseUrl: decodeSecretValue(secret, "database-url")
  };
  return (
    Object.values(values).every((value) => !valueLooksPlaceholder(value)) &&
    values.password.length >= 16 &&
    liveDatabaseUrlUsesService(values.databaseUrl) &&
    liveDatabaseUrlMatchesSecret(values.databaseUrl, values)
  );
}

function liveDatabaseUrlMatchesSecret(urlText, values) {
  try {
    const url = new URL(urlText);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    return decodeURIComponent(url.username) === values.username && decodeURIComponent(url.password) === values.password && database === values.database;
  } catch {
    return false;
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
  return cleanScalar(configMap.match(new RegExp(`^\\s*${escapeRegExp(key)}:\\s*([^\\n]+)\\s*$`, "m"))?.[1] ?? "");
}

function cleanScalar(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function configMapDataValue(configMapJson, key) {
  return cleanScalar(configMapJson?.data?.[key] ?? "");
}

function customerAccessPolicyIsConcrete(jsonText) {
  try {
    const policy = JSON.parse(jsonText);
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) return false;
    if (Object.hasOwn(policy, "default")) return false;
    const allowedTopLevelKeys = new Set(["owners", "users", "groups"]);
    if (Object.keys(policy).some((key) => !allowedTopLevelKeys.has(key))) return false;
    const placeholder = (value) => /^(changeme|change-me|todo|placeholder|example|sample|dummy|default|customer|tenant|none|null|x+|\*+)$/i.test(String(value ?? "").trim());
    const broadPrincipal = (table, principal) => {
      const clean = String(principal ?? "").trim().toLowerCase();
      return (
        !clean ||
        clean.includes("*") ||
        placeholder(clean) ||
        (table === "groups" &&
          (clean === "system:authenticated" ||
            clean === "system:authenticated:oauth" ||
            clean === "system:unauthenticated" ||
            clean === "system:anonymous" ||
            clean === "system:serviceaccounts" ||
            clean.startsWith("system:serviceaccounts:")))
      );
    };
    let entries = 0;
    for (const table of ["owners", "users", "groups"]) {
      const map = policy[table];
      if (map === undefined) continue;
      if (!map || typeof map !== "object" || Array.isArray(map)) return false;
      for (const [principal, customers] of Object.entries(map)) {
        if (broadPrincipal(table, principal) || !Array.isArray(customers)) return false;
        for (const value of customers) {
          if (typeof value !== "string") return false;
          const clean = value.trim();
          entries += 1;
          if (!clean || clean.includes("*") || placeholder(clean)) return false;
        }
      }
    }
    return entries > 0;
  } catch {
    return false;
  }
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

function matchLabels(selector = {}) {
  return selector?.matchLabels ?? {};
}

function labelsEqual(actual = {}, expected = {}) {
  const actualEntries = Object.entries(actual);
  const expectedEntries = Object.entries(expected);
  return actualEntries.length === expectedEntries.length && expectedEntries.every(([key, value]) => actual[key] === value);
}

function selectorMatches(selector = {}, expected = {}) {
  return labelsEqual(matchLabels(selector), expected) && !selector.matchExpressions?.length;
}

function selectorSelectsLabels(selector = {}, labels = {}) {
  const requiredLabels = selector.matchLabels ?? {};
  for (const [key, value] of Object.entries(requiredLabels)) {
    if (labels[key] !== value) return false;
  }
  for (const expression of selector.matchExpressions ?? []) {
    const key = expression.key;
    const values = expression.values ?? [];
    if (expression.operator === "In" && !values.includes(labels[key])) return false;
    if (expression.operator === "NotIn" && values.includes(labels[key])) return false;
    if (expression.operator === "Exists" && !(key in labels)) return false;
    if (expression.operator === "DoesNotExist" && key in labels) return false;
    if (!["In", "NotIn", "Exists", "DoesNotExist"].includes(expression.operator)) return false;
  }
  return true;
}

function peerHasNoBroadAccess(peer = {}) {
  const broadSelector = (selector) => selector && Object.keys(selector).length === 0;
  const broadCidr = peer.ipBlock?.cidr === "0.0.0.0/0" || peer.ipBlock?.cidr === "::/0";
  return !broadSelector(peer.namespaceSelector) && !broadSelector(peer.podSelector) && !broadCidr;
}

function portsEqual(actual = [], expected = []) {
  const normalize = (ports) => ports.map((port) => `${port.protocol ?? "TCP"}:${Number(port.port)}`).sort();
  return JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected));
}

function policyTypesEqual(actual = [], expected = []) {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function appliedKnowledgeIngressScoped(policy) {
  const spec = policy?.spec ?? {};
  const ingress = spec.ingress ?? [];
  if (!selectorMatches(spec.podSelector, { "app.kubernetes.io/name": "cywell-ai-sentinel", "app.kubernetes.io/component": "knowledge-engine" })) {
    return false;
  }
  if (!policyTypesEqual(spec.policyTypes ?? [], ["Ingress"])) return false;
  if (ingress.length !== 1 || (spec.egress ?? []).length > 0) return false;
  const rule = ingress[0];
  const from = rule.from ?? [];
  return (
    from.length === 1 &&
    peerHasNoBroadAccess(from[0]) &&
    selectorMatches(from[0].podSelector, { "app.kubernetes.io/name": "cywell-ai-sentinel", "app.kubernetes.io/component": "gateway" }) &&
    !from[0].namespaceSelector &&
    !from[0].ipBlock &&
    portsEqual(rule.ports ?? [], [{ protocol: "TCP", port: 8080 }])
  );
}

function ingressPolicyApplies(policy) {
  const types = policy?.spec?.policyTypes ?? [];
  if (types.length === 0) return true;
  return types.includes("Ingress");
}

function egressPolicyApplies(policy) {
  const types = policy?.spec?.policyTypes ?? [];
  if (types.length === 0) return (policy?.spec?.egress ?? []).length > 0;
  return types.includes("Egress");
}

function ingressRuleAllowsOnlyGateway8080(rule = {}) {
  const from = rule.from ?? [];
  return (
    from.length > 0 &&
    from.every(
      (peer) =>
        peerHasNoBroadAccess(peer) &&
        selectorMatches(peer.podSelector, { "app.kubernetes.io/name": "cywell-ai-sentinel", "app.kubernetes.io/component": "gateway" }) &&
        !peer.namespaceSelector &&
        !peer.ipBlock
    ) &&
    portsEqual(rule.ports ?? [], [{ protocol: "TCP", port: 8080 }])
  );
}

function appliedKnowledgeIngressUnionScoped(policies = [], knowledgeLabels = {}) {
  const selectedPolicies = policies.filter(
    (policy) => ingressPolicyApplies(policy) && selectorSelectsLabels(policy.spec?.podSelector ?? {}, knowledgeLabels)
  );
  let hasGatewayAllow = false;
  for (const policy of selectedPolicies) {
    for (const rule of policy.spec?.ingress ?? []) {
      if (!ingressRuleAllowsOnlyGateway8080(rule)) {
        return {
          ok: false,
          reason: "knowledge-engine ingress union contains a peer or port outside gateway:8080",
          policies: selectedPolicies.map((item) => item.metadata?.name).filter(Boolean)
        };
      }
      hasGatewayAllow = true;
    }
  }
  return {
    ok: selectedPolicies.length > 0 && hasGatewayAllow,
    reason:
      selectedPolicies.length === 0
        ? "no applied ingress NetworkPolicy selects knowledge-engine pods"
        : "no applied ingress NetworkPolicy allows gateway:8080 to knowledge-engine pods",
    policies: selectedPolicies.map((item) => item.metadata?.name).filter(Boolean)
  };
}

function appliedPbsEgressScoped(policy) {
  const spec = policy?.spec ?? {};
  const egress = spec.egress ?? [];
  if (!selectorMatches(spec.podSelector, { "app.kubernetes.io/name": "cywell-ai-sentinel", "app.kubernetes.io/component": "knowledge-engine" })) {
    return false;
  }
  if (!policyTypesEqual(spec.policyTypes ?? [], ["Egress"])) return false;
  if (egress.length !== 3 || (spec.ingress ?? []).length > 0) return false;
  const dnsRule = egress.find((rule) => portsEqual(rule.ports ?? [], [
    { protocol: "TCP", port: 53 },
    { protocol: "UDP", port: 53 },
    { protocol: "TCP", port: 5353 },
    { protocol: "UDP", port: 5353 }
  ]));
  const postgresRule = egress.find((rule) => portsEqual(rule.ports ?? [], [{ protocol: "TCP", port: 5432 }]));
  const pbsRule = egress.find((rule) => portsEqual(rule.ports ?? [], [{ protocol: "TCP", port: 8765 }]));
  const dnsOk =
    dnsRule &&
    (dnsRule.to ?? []).length === 1 &&
    peerHasNoBroadAccess(dnsRule.to[0]) &&
    selectorMatches(dnsRule.to[0].namespaceSelector, { "kubernetes.io/metadata.name": "openshift-dns" }) &&
    !dnsRule.to[0].podSelector &&
    !dnsRule.to[0].ipBlock;
  const postgresOk =
    postgresRule &&
    (postgresRule.to ?? []).length === 1 &&
    peerHasNoBroadAccess(postgresRule.to[0]) &&
    selectorMatches(postgresRule.to[0].podSelector, {
      "app.kubernetes.io/name": "cywell-ai-sentinel",
      "app.kubernetes.io/component": "knowledge-postgres"
    }) &&
    !postgresRule.to[0].namespaceSelector &&
    !postgresRule.to[0].ipBlock;
  const pbsOk =
    pbsRule &&
    (pbsRule.to ?? []).length === 1 &&
    peerHasNoBroadAccess(pbsRule.to[0]) &&
    selectorMatches(pbsRule.to[0].namespaceSelector, { "kubernetes.io/metadata.name": "playbookstudio" }) &&
    selectorMatches(pbsRule.to[0].podSelector, {
      "app.kubernetes.io/name": "playbookstudio",
      "app.kubernetes.io/component": "runtime"
    }) &&
    !pbsRule.to[0].ipBlock;
  return Boolean(dnsOk && postgresOk && pbsOk && egress.every((rule) => (rule.to ?? []).every(peerHasNoBroadAccess)));
}

function egressRuleKind(rule = {}) {
  const to = rule.to ?? [];
  if (to.length !== 1 || !to.every(peerHasNoBroadAccess)) return "";
  if (
    portsEqual(rule.ports ?? [], [
      { protocol: "TCP", port: 53 },
      { protocol: "UDP", port: 53 },
      { protocol: "TCP", port: 5353 },
      { protocol: "UDP", port: 5353 }
    ]) &&
    selectorMatches(to[0].namespaceSelector, { "kubernetes.io/metadata.name": "openshift-dns" }) &&
    !to[0].podSelector &&
    !to[0].ipBlock
  ) {
    return "dns";
  }
  if (
    portsEqual(rule.ports ?? [], [{ protocol: "TCP", port: 5432 }]) &&
    selectorMatches(to[0].podSelector, {
      "app.kubernetes.io/name": "cywell-ai-sentinel",
      "app.kubernetes.io/component": "knowledge-postgres"
    }) &&
    !to[0].namespaceSelector &&
    !to[0].ipBlock
  ) {
    return "postgres";
  }
  if (
    portsEqual(rule.ports ?? [], [{ protocol: "TCP", port: 8765 }]) &&
    selectorMatches(to[0].namespaceSelector, { "kubernetes.io/metadata.name": "playbookstudio" }) &&
    selectorMatches(to[0].podSelector, {
      "app.kubernetes.io/name": "playbookstudio",
      "app.kubernetes.io/component": "runtime"
    }) &&
    !to[0].ipBlock
  ) {
    return "pbs-runtime";
  }
  return "";
}

function appliedKnowledgeEgressUnionScoped(policies = [], knowledgeLabels = {}) {
  const selectedPolicies = policies.filter((policy) => egressPolicyApplies(policy) && selectorSelectsLabels(policy.spec?.podSelector ?? {}, knowledgeLabels));
  const allowedKinds = new Set();
  for (const policy of selectedPolicies) {
    for (const rule of policy.spec?.egress ?? []) {
      const kind = egressRuleKind(rule);
      if (!kind) {
        return {
          ok: false,
          reason: "knowledge-engine egress union contains a destination or port outside DNS/Postgres/PBS runtime",
          policies: selectedPolicies.map((item) => item.metadata?.name).filter(Boolean)
        };
      }
      allowedKinds.add(kind);
    }
  }
  const missing = ["dns", "postgres", "pbs-runtime"].filter((kind) => !allowedKinds.has(kind));
  return {
    ok: selectedPolicies.length > 0 && missing.length === 0,
    reason: missing.length ? `missing required egress kinds: ${missing.join(", ")}` : "",
    policies: selectedPolicies.map((item) => item.metadata?.name).filter(Boolean)
  };
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
  const gitStatus = run("git", ["status", "--short"]).stdout.trim();
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        checkedAt,
        branch: run("git", ["branch", "--show-current"]).stdout.trim(),
        head: run("git", ["rev-parse", "--short", "HEAD"]).stdout.trim(),
        fullHead: run("git", ["rev-parse", "HEAD"]).stdout.trim(),
        treeStatus: gitStatus ? "dirty" : "clean",
        statusShort: gitStatus,
        status,
        namespace,
        clusterIdentity: currentClusterIdentity(),
        overlay,
        overlayPath,
        renderedSiteOverlaySha256: sha256Text(rendered),
        requireCluster,
        requireSecret,
        skipApplied,
        releaseImagesEvidencePath,
        pbsPinnedSourceEvidencePath,
        strictPinnedPbsSourceEvidence,
        pbsRuntimeSourceEvidence,
        pbsRuntimeHealthEvidence,
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
  console.log(`Evidence: ${evidencePath}`);
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
  if (!result.ok) {
    const detail = result.stderr || result.stdout || "oc command failed";
    if (resultIsNotFound(result)) return { value: undefined, missing: true, readError: false, detail };
    if (requireCluster) fail(id, detail);
    else warn(id, detail);
    return { value: undefined, missing: false, readError: true, detail };
  }
  try {
    return { value: JSON.parse(result.stdout), missing: false, readError: false, detail: "" };
  } catch (error) {
    if (requireCluster) fail(id, `could not parse JSON: ${error.message}`);
    else warn(id, `could not parse JSON: ${error.message}`);
    return { value: undefined, missing: false, readError: true, detail: error.message };
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

function workloadEnvConfigRef(workload, name, configName, key, containerName) {
  const ref = workloadEnv(workload, name, containerName).valueFrom?.configMapKeyRef;
  return ref?.name === configName && ref?.key === key && ref?.optional !== true;
}

function selectorMatchesGateway(selector = {}) {
  const labels = selector.matchLabels ?? {};
  return labels["app.kubernetes.io/name"] === "cywell-ai-sentinel" && labels["app.kubernetes.io/component"] === "gateway";
}

function ipBlockMatches(ipBlock, ip) {
  const cidr = String(ipBlock?.cidr ?? "");
  return cidr === ip || cidr === `${ip}/32`;
}

function networkPolicyPortMatches(portRule, port) {
  return Number(portRule?.port) === Number(port);
}

function networkPolicyAllowsAnyIp(policy, ips, ports) {
  return (policy?.spec?.egress ?? []).some((rule) => {
    const peerOk = (rule.to ?? []).some((peer) => ips.some((ip) => ipBlockMatches(peer.ipBlock, ip)));
    const portOk = (rule.ports ?? []).some((portRule) => ports.some((port) => networkPolicyPortMatches(portRule, port)));
    return peerOk && portOk;
  });
}

function dnsEgressRule(rule = {}) {
  const to = rule.to ?? [];
  return (
    to.length > 0 &&
    portsEqual(rule.ports ?? [], [
      { protocol: "TCP", port: 53 },
      { protocol: "UDP", port: 53 },
      { protocol: "TCP", port: 5353 },
      { protocol: "UDP", port: 5353 }
    ]) &&
    to.every((peer) => {
      if (!peerHasNoBroadAccess(peer)) return false;
      if (selectorMatches(peer.namespaceSelector, { "kubernetes.io/metadata.name": "openshift-dns" }) && !peer.podSelector && !peer.ipBlock) return true;
      if (peer.ipBlock && !peer.namespaceSelector && !peer.podSelector) return true;
      return false;
    })
  );
}

function podEgressRule(rule = {}, port, labels) {
  const to = rule.to ?? [];
  return (
    to.length === 1 &&
    peerHasNoBroadAccess(to[0]) &&
    selectorMatches(to[0].podSelector, labels) &&
    !to[0].namespaceSelector &&
    !to[0].ipBlock &&
    portsEqual(rule.ports ?? [], [{ protocol: "TCP", port }])
  );
}

function namespacedPodEgressRule(rule = {}, port, namespaceName, podLabels) {
  const to = rule.to ?? [];
  return (
    to.length === 1 &&
    peerHasNoBroadAccess(to[0]) &&
    selectorMatches(to[0].namespaceSelector, { "kubernetes.io/metadata.name": namespaceName }) &&
    selectorMatches(to[0].podSelector, podLabels) &&
    !to[0].ipBlock &&
    portsEqual(rule.ports ?? [], [{ protocol: "TCP", port }])
  );
}

function apiEgressRule(rule = {}, apiTargets = []) {
  return apiTargets.some((target) => networkPolicyAllowsAnyIp({ spec: { egress: [rule] } }, [target.ip], [target.port]));
}

function gatewayIngressRule(rule = {}) {
  const from = rule.from ?? [];
  return (
    from.length > 0 &&
    from.every((peer) => {
      if (!peerHasNoBroadAccess(peer)) return false;
      if (selectorMatches(peer.namespaceSelector, { "kubernetes.io/metadata.name": "openshift-console" }) && !peer.podSelector && !peer.ipBlock) return true;
      if (
        selectorMatches(peer.podSelector, { "app.kubernetes.io/name": "cywell-ai-sentinel", "app.kubernetes.io/component": "console-plugin" }) &&
        !peer.namespaceSelector &&
        !peer.ipBlock
      ) {
        return true;
      }
      return false;
    }) &&
    portsEqual(rule.ports ?? [], [{ protocol: "TCP", port: 9443 }])
  );
}

function consoleIngressRule(rule = {}) {
  const from = rule.from ?? [];
  return (
    from.length === 1 &&
    peerHasNoBroadAccess(from[0]) &&
    selectorMatches(from[0].namespaceSelector, { "kubernetes.io/metadata.name": "openshift-console" }) &&
    !from[0].podSelector &&
    !from[0].ipBlock &&
    portsEqual(rule.ports ?? [], [{ protocol: "TCP", port: 9443 }])
  );
}

function postgresIngressRule(rule = {}) {
  const from = rule.from ?? [];
  return (
    from.length === 1 &&
    peerHasNoBroadAccess(from[0]) &&
    selectorMatches(from[0].podSelector, { "app.kubernetes.io/name": "cywell-ai-sentinel", "app.kubernetes.io/component": "knowledge-engine" }) &&
    !from[0].namespaceSelector &&
    !from[0].ipBlock &&
    portsEqual(rule.ports ?? [], [{ protocol: "TCP", port: 5432 }])
  );
}

function appliedPolicyUnionScoped({ policies = [], labels = {}, ingressRule, egressRule, requireIngress = false, requireEgress = false }) {
  const ingressPolicies = policies.filter((policy) => ingressPolicyApplies(policy) && selectorSelectsLabels(policy.spec?.podSelector ?? {}, labels));
  const egressPolicies = policies.filter((policy) => egressPolicyApplies(policy) && selectorSelectsLabels(policy.spec?.podSelector ?? {}, labels));
  const badIngress = [];
  const badEgress = [];
  for (const policy of ingressPolicies) {
    for (const rule of policy.spec?.ingress ?? []) {
      if (!ingressRule(rule)) badIngress.push(policy.metadata?.name ?? "unnamed");
    }
  }
  for (const policy of egressPolicies) {
    for (const rule of policy.spec?.egress ?? []) {
      if (!egressRule(rule)) badEgress.push(policy.metadata?.name ?? "unnamed");
    }
  }
  const missing = [];
  if (requireIngress && ingressPolicies.length === 0) missing.push("ingress");
  if (requireEgress && egressPolicies.length === 0) missing.push("egress");
  return {
    ok: badIngress.length === 0 && badEgress.length === 0 && missing.length === 0,
    ingressPolicies: ingressPolicies.map((policy) => policy.metadata?.name).filter(Boolean),
    egressPolicies: egressPolicies.map((policy) => policy.metadata?.name).filter(Boolean),
    badIngress,
    badEgress,
    missing
  };
}

function gatewayEgressRule(rule = {}, apiTargets = []) {
  return (
    dnsEgressRule(rule) ||
    namespacedPodEgressRule(rule, 8443, "openshift-lightspeed", { "app.kubernetes.io/name": "lightspeed-service-api" }) ||
    podEgressRule(rule, 8080, { "app.kubernetes.io/name": "cywell-ai-sentinel", "app.kubernetes.io/component": "knowledge-engine" }) ||
    apiEgressRule(rule, apiTargets)
  );
}

function consoleEgressRule(rule = {}) {
  return dnsEgressRule(rule) || podEgressRule(rule, 9443, { "app.kubernetes.io/name": "cywell-ai-sentinel", "app.kubernetes.io/component": "gateway" });
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

function runtimeServiceEndpointsReady(endpoints) {
  return (endpoints?.subsets ?? []).some((subset) => {
    const hasReadyAddress = (subset.addresses ?? []).some((address) => Boolean(address.ip || address.hostname));
    const hasPort = (subset.ports ?? []).some((port) => Number(port.port) === 8765);
    return hasReadyAddress && hasPort;
  });
}

function pbsBaseUrlTargetsRuntimeService(value) {
  try {
    const url = new URL(String(value ?? ""));
    return (
      ["http:", "https:"].includes(url.protocol) &&
      url.port === "8765" &&
      [
        "playbookstudio-runtime.playbookstudio.svc.cluster.local",
        "playbookstudio-runtime.playbookstudio.svc",
        "playbookstudio-runtime.playbookstudio"
      ].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function evidenceTimeMs(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function strictPinnedSourceEvidenceValid(evidence) {
  const source = evidence?.pbsSource ?? {};
  const hashes = source.contractFileSha256 ?? {};
  const hashKeys = Object.keys(hashes).sort();
  const expectedHashKeys = [...requiredPbsContractFiles].sort();
  const reasons = [];
  const evidenceCheckedAtMs = evidenceTimeMs(evidence?.checkedAt);
  const remoteVerifiedAtMs = evidenceTimeMs(source.remoteVerifiedAt);
  const maxAgeMs = Math.max(1, maxPinnedSourceEvidenceAgeMinutes) * 60 * 1000;
  const nowMs = Date.parse(checkedAt);
  const envHead = String(process.env.CAS_PBS_SOURCE_HEAD || "").trim();
  const exactHashSet =
    hashKeys.length === expectedHashKeys.length &&
    expectedHashKeys.every((key, index) => hashKeys[index] === key && /^[a-f0-9]{64}$/i.test(String(hashes[key] ?? "")));

  if (evidence?.status !== "PASS") reasons.push(`status is ${evidence?.status || "missing"}`);
  if (evidence?.requireSource !== true || evidence?.requireCleanSource !== true || evidence?.requireExpectedHead !== true) {
    reasons.push("evidence was not generated by strict source pinning flags");
  }
  if (source.treeStatus !== "clean") reasons.push(`PBS source tree is ${source.treeStatus || "missing"}`);
  if (!fullGitSha(source.expectedHead) || !fullGitSha(source.fullHead) || source.fullHead !== source.expectedHead) {
    reasons.push("PBS expectedHead/fullHead must be matching full SHAs");
  }
  if (source.expectedHead !== approvedPbsSourceHead || source.fullHead !== approvedPbsSourceHead) {
    reasons.push(`PBS source evidence must match the v0.1.4 approved SHA ${approvedPbsSourceHead}`);
  }
  if (fullGitSha(envHead) && source.expectedHead !== envHead) {
    reasons.push(`CAS_PBS_SOURCE_HEAD ${envHead} does not match pinned source evidence ${source.expectedHead || "missing"}`);
  }
  if (fullGitSha(envHead) && envHead !== approvedPbsSourceHead) {
    reasons.push(`CAS_PBS_SOURCE_HEAD ${envHead} is not the v0.1.4 approved PBS SHA ${approvedPbsSourceHead}`);
  }
  if (!strictApprovedPbsRemotePattern.test(String(source.remoteOriginUrl ?? "").trim())) {
    reasons.push(`PBS remote is not the approved repository: ${source.remoteOriginUrl || "missing"}`);
  }
  if (source.remoteFetchOk !== true) reasons.push("strict source pinning did not record a successful git fetch --prune origin");
  if (
    source.remoteContainsExpectedHead !== true ||
    !Array.isArray(source.remoteRefsContainingExpectedHead) ||
    !source.remoteRefsContainingExpectedHead.some((ref) => typeof ref === "string" && ref.startsWith("origin/"))
  ) {
    reasons.push("no fetched approved origin/* ref contains the pinned PBS SHA");
  }
  if (!evidenceCheckedAtMs || !remoteVerifiedAtMs) {
    reasons.push("pinned source evidence is missing checkedAt or remoteVerifiedAt");
  } else if (evidenceCheckedAtMs > nowMs + maxEvidenceFutureSkewMs || remoteVerifiedAtMs > nowMs + maxEvidenceFutureSkewMs) {
    reasons.push("pinned source proof is future-dated beyond the accepted clock skew");
  } else if (nowMs - evidenceCheckedAtMs > maxAgeMs || nowMs - remoteVerifiedAtMs > maxAgeMs) {
    reasons.push(`pinned source proof is older than ${maxPinnedSourceEvidenceAgeMinutes} minutes`);
  } else if (Math.abs(remoteVerifiedAtMs - evidenceCheckedAtMs) > 60 * 1000) {
    reasons.push("remoteVerifiedAt is not from the same strict source pinning run as checkedAt");
  }
  if (!exactHashSet) reasons.push("strict source evidence does not include the exact required PBS contract file SHA-256 set");

  return {
    ok: reasons.length === 0,
    head: reasons.length === 0 ? source.expectedHead : "",
    expectedHead: source.expectedHead || "",
    remoteOriginUrl: source.remoteOriginUrl || "",
    remoteRefsContainingExpectedHead: source.remoteRefsContainingExpectedHead || [],
    remoteFetchOk: source.remoteFetchOk === true,
    remoteVerifiedAt: source.remoteVerifiedAt || "",
    approvedHead: approvedPbsSourceHead,
    evidenceCheckedAt: evidence?.checkedAt || "",
    reason: reasons.join("; ")
  };
}

function readStrictPinnedPbsSourceEvidence() {
  if (strictPinnedPbsSourceEvidence) return strictPinnedPbsSourceEvidence;
  if (!existsSync(pbsPinnedSourceEvidencePath)) {
    strictPinnedPbsSourceEvidence = {
      ok: false,
      head: "",
      reason: `${pbsPinnedSourceEvidencePath} is missing; run verify:release:source-pinning before live cutover`
    };
    return strictPinnedPbsSourceEvidence;
  }
  try {
    const evidence = JSON.parse(readFileSync(pbsPinnedSourceEvidencePath, "utf8"));
    strictPinnedPbsSourceEvidence = strictPinnedSourceEvidenceValid(evidence);
    return strictPinnedPbsSourceEvidence;
  } catch (error) {
    strictPinnedPbsSourceEvidence = {
      ok: false,
      head: "",
      reason: `could not parse ${pbsPinnedSourceEvidencePath}: ${error.message}`
    };
    return strictPinnedPbsSourceEvidence;
  }
}

function readPinnedPbsSourceHead() {
  if (overlay === "pbs-live" && requireCluster) {
    const pinned = readStrictPinnedPbsSourceEvidence();
    return pinned.ok ? pinned.head : "";
  }
  const envHead = String(process.env.CAS_PBS_SOURCE_HEAD || "").trim();
  if (fullGitSha(envHead)) return envHead;
  if (!existsSync(pbsPinnedSourceEvidencePath)) return "";
  try {
    const evidence = JSON.parse(readFileSync(pbsPinnedSourceEvidencePath, "utf8"));
    const source = evidence.pbsSource ?? {};
    if (
      evidence.status === "PASS" &&
      evidence.requireSource === true &&
      evidence.requireCleanSource === true &&
      evidence.requireExpectedHead === true &&
      source.treeStatus === "clean" &&
      source.fullHead === source.expectedHead &&
      source.expectedHead === approvedPbsSourceHead &&
      fullGitSha(source.expectedHead)
    ) {
      return source.expectedHead;
    }
  } catch {
    return "";
  }
  return "";
}

const runtimeRevisionKeys = [
  "cywell.ai/pbs-source-head",
  "playbookstudio.io/source-revision",
  "app.kubernetes.io/revision",
  "org.opencontainers.image.revision"
];
const runtimeRevisionEnvNames = ["PBS_SOURCE_REVISION", "PLAYBOOKSTUDIO_SOURCE_HEAD", "SOURCE_REVISION", "GIT_COMMIT"];

function firstRuntimeRevision(pod) {
  const labels = pod.metadata?.labels ?? {};
  const annotations = pod.metadata?.annotations ?? {};
  for (const key of runtimeRevisionKeys) {
    const value = String(annotations[key] || labels[key] || "").trim();
    if (value) return { key, value };
  }
  for (const container of pod.spec?.containers ?? []) {
    for (const env of container.env ?? []) {
      if (runtimeRevisionEnvNames.includes(env.name) && env.value) return { key: `env:${env.name}`, value: String(env.value).trim() };
    }
  }
  return { key: "", value: "" };
}

function runtimePodSourceSummary(pod) {
  const revision = firstRuntimeRevision(pod);
  return {
    name: pod.metadata?.name,
    revisionKey: revision.key,
    revision: revision.value,
    imageIDs: (pod.status?.containerStatuses ?? []).map((container) => container.imageID).filter(Boolean)
  };
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pbsRuntimeHealthReadiness(body) {
  const explicit = body?.provider_config?.pbs_http?.readiness ?? body?.readiness ?? body?.runtime?.readiness;
  if (explicit) return explicit;
  const runtime = body?.runtime && typeof body.runtime === "object" ? body.runtime : {};
  const dbCorpus = runtime?.db_corpus && typeof runtime.db_corpus === "object" ? runtime.db_corpus : {};
  if (Object.keys(dbCorpus).length > 0) {
    const wikiStatus = body?.__casWikiLoopStatus && typeof body.__casWikiLoopStatus === "object" ? body.__casWikiLoopStatus : {};
    const readyScopes = Array.isArray(dbCorpus.ready_scopes) ? dbCorpus.ready_scopes.map(String) : [];
    const sourceCounts = dbCorpus.source_counts && typeof dbCorpus.source_counts === "object" ? dbCorpus.source_counts : {};
    const chunkCounts = dbCorpus.chunk_counts && typeof dbCorpus.chunk_counts === "object" ? dbCorpus.chunk_counts : {};
    const missingEmbeddingEntries = numberValue(dbCorpus.missing_embedding_index_entries);
    const staleEmbeddingEntries = numberValue(dbCorpus.stale_embedding_index_entries);
    const embeddingEntries = numberValue(dbCorpus.embedding_index_entries);
    const indexableChunks = numberValue(dbCorpus.indexable_chunks);
    const officialSources = numberValue(sourceCounts.official_docs);
    const studySources = numberValue(sourceCounts.study_docs);
    const officialChunks = numberValue(chunkCounts.official_docs);
    const studyChunks = numberValue(chunkCounts.study_docs);
    return {
      database_runtime: runtime.database_runtime === true,
      db_ready: dbCorpus.ready === true && dbCorpus.database === "postgres",
      pgvector_ready: dbCorpus.ready === true && (dbCorpus.pgvector_ready === true || dbCorpus.vector_backend === "pgvector"),
      embedding_index_parity:
        dbCorpus.embedding_index_parity === true &&
        missingEmbeddingEntries === 0 &&
        staleEmbeddingEntries === 0 &&
        embeddingEntries !== null &&
        embeddingEntries > 0 &&
        indexableChunks !== null &&
        indexableChunks > 0,
      compiled_wiki_ready: wikiStatus.compiled_wiki_ready === true || runtime.compiled_wiki_ready === true,
      corpus_counts_ready:
        officialSources !== null &&
        officialSources > 0 &&
        studySources !== null &&
        studySources > 0 &&
        officialChunks !== null &&
        officialChunks > 0 &&
        studyChunks !== null &&
        studyChunks > 0,
      ready_scopes: readyScopes,
      db_corpus: dbCorpus,
      wiki_status: wikiStatus
    };
  }
  return body ?? {};
}

function pbsRuntimeHealthReady(body) {
  const readiness = pbsRuntimeHealthReadiness(body);
  const readyScopes = Array.isArray(readiness.ready_scopes) ? readiness.ready_scopes.map(String) : [];
  return (
    readiness.database_runtime === true &&
    readiness.db_ready === true &&
    readiness.pgvector_ready === true &&
    readiness.embedding_index_parity === true &&
    readiness.compiled_wiki_ready === true &&
    readiness.corpus_counts_ready === true &&
    ["official_docs", "study_docs"].every((scope) => readyScopes.includes(scope))
  );
}

function runPbsRuntimeHealthProbe(podName, bearerToken) {
  const probeUrl = `${String(pbsBaseUrl).replace(/\/+$/, "")}/api/health`;
  const script = [
    "import json, os, ssl, sys, urllib.parse, urllib.request",
    "config=json.loads(sys.stdin.read() or '{}')",
    "url=config.get('url')",
    "service_ca='/var/run/secrets/kubernetes.io/serviceaccount/service-ca.crt'",
    "ssl_context=ssl.create_default_context(cafile=service_ca) if os.path.isfile(service_ca) else ssl.create_default_context()",
    "headers={'Accept':'application/json'}",
    "token=config.get('token','')",
    "headers.update({'Authorization':'Bearer '+token} if token else {})",
    "def fetch_json(target):",
    "    request=urllib.request.Request(target,headers=headers)",
    "    response=urllib.request.urlopen(request,timeout=10,context=ssl_context)",
    "    text=response.read(1048576).decode('utf-8','replace')",
    "    return response.status, (json.loads(text) if text else {})",
    "try:",
    "    status, body=fetch_json(url)",
    "    base=url.rsplit('/api/health',1)[0]",
    "    wiki_status_code, wiki_status=fetch_json(base + '/api/wiki-loop/status?user_id=local')",
    "    if isinstance(body, dict):",
    "        body['__casWikiLoopStatus']=wiki_status",
    "    print(json.dumps({'ok':200 <= status < 300 and 200 <= wiki_status_code < 300,'status':status,'wikiStatus':wiki_status_code,'body':body}))",
    "except Exception as error:",
    "    print(json.dumps({'ok':False,'error':str(error)}))",
    "    sys.exit(2)"
  ].join("\n");
  for (const python of ["python", "python3"]) {
    const result = run(
      "oc",
      [
        "exec",
        "-i",
        "-n",
        "playbookstudio",
        podName,
        "--",
        python,
        "-c",
        script
      ],
      { timeoutMs: 30000, input: JSON.stringify({ url: probeUrl, token: bearerToken || "" }) }
    );
    if (!result.ok && /executable file not found|not found|No such file/i.test(result.stderr)) continue;
    try {
      const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() || "{}");
      return { ...parsed, python, stderr: result.stderr };
    } catch {
      return { ok: false, python, error: result.stderr || result.stdout || "runtime health probe did not return JSON" };
    }
  }
  return { ok: false, error: "no python executable available in the PBS runtime pod" };
}

function firstContainerImage(workload) {
  return workload.match(/^\s*image:\s*([^\s]+)\s*$/m)?.[1] ?? "";
}

function pinnedProductionImage(image) {
  return image.includes("@sha256:") || /^image-registry\.openshift-image-registry\.svc:5000\/cywell-ai-sentinel\/[^:]+:v0\.1\.4$/.test(image);
}

function digestPinnedImageReference(image) {
  return /@sha256:[a-f0-9]{32,}/i.test(String(image ?? ""));
}

function imageDigest(image) {
  return String(image ?? "").match(/sha256:[a-f0-9]{32,}/i)?.[0]?.toLowerCase() ?? "";
}

function selectorArgFromLabels(labels = {}) {
  return Object.entries(labels)
    .filter(([_key, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

function workloadSelectorLabels(workload) {
  return workload?.spec?.selector?.matchLabels ?? workload?.spec?.template?.metadata?.labels ?? {};
}

function podReady(pod) {
  return (
    pod?.status?.phase === "Running" &&
    !pod?.metadata?.deletionTimestamp &&
    (pod.status?.conditions ?? []).some((condition) => condition.type === "Ready" && condition.status === "True") &&
    (pod.status?.containerStatuses ?? []).every((container) => container.ready && container.state?.running)
  );
}

function podContainerDigest(pod, containerName) {
  const status = (pod?.status?.containerStatuses ?? []).find((container) => container.name === containerName) ?? (pod?.status?.containerStatuses ?? [])[0];
  return imageDigest(status?.imageID);
}

function currentGitHead() {
  const result = run("git", ["rev-parse", "--short", "HEAD"]);
  return result.ok ? result.stdout.trim() : "";
}

function currentGitFullHead() {
  const result = run("git", ["rev-parse", "HEAD"]);
  return result.ok ? result.stdout.trim() : "";
}

let releaseImagesEvidenceCurrent = false;

function releaseEvidenceCywellSourceValid(evidence) {
  const source = evidence?.cywellSource ?? {};
  const remoteTime = evidenceTimeMs(source.remoteVerifiedAt);
  const maxAgeMs = Math.max(1, maxPinnedSourceEvidenceAgeMinutes) * 60 * 1000;
  return Boolean(
    source.remoteApproved === true &&
      source.remoteFetchOk === true &&
      source.remoteContainsHead === true &&
      Array.isArray(source.remoteRefsContainingHead) &&
      source.remoteRefsContainingHead.some((ref) => typeof ref === "string" && ref.startsWith("origin/")) &&
      approvedCywellRemotePattern.test(String(source.remoteOriginUrl ?? "")) &&
      remoteTime &&
      remoteTime <= Date.parse(checkedAt) + maxEvidenceFutureSkewMs &&
      Date.parse(checkedAt) - remoteTime <= maxAgeMs
  );
}

function loadReleaseImagesEvidence() {
  if (overlay !== "pbs-live") return null;
  if (!existsSync(releaseImagesEvidencePath)) {
    const detail = `${releaseImagesEvidencePath} is missing; run release:crc:v0.1.4 before strict pbs-live preflight`;
    if (requireCluster) fail("cluster:release-images-evidence", detail);
    else warn("cluster:release-images-evidence", detail);
    return null;
  }
  try {
    const evidence = JSON.parse(readFileSync(releaseImagesEvidencePath, "utf8"));
    const head = currentGitHead();
    const fullHead = currentGitFullHead();
    const evidenceFullHead = String(evidence.fullHead ?? "");
    const sourceEvidenceFullHead = String(evidence.sourceEvidenceFullHead ?? "");
    const valid =
      evidence.status === "PASS" &&
      evidence.namespace === namespace &&
      evidence.releaseTag === "v0.1.4" &&
      (!fullHead || evidenceFullHead === fullHead) &&
      (!fullHead || sourceEvidenceFullHead === fullHead) &&
      evidence.staleEvidenceAllowed !== true &&
      releaseEvidenceCywellSourceValid(evidence) &&
      evidence.promotedImages &&
      typeof evidence.promotedImages === "object";
    releaseImagesEvidenceCurrent = valid;
    expect(
      "cluster:release-images-evidence",
      valid,
      "release image promotion evidence is PASS, current-head, non-stale-source, namespace-scoped, and contains promoted image digests",
      `${releaseImagesEvidencePath} must be PASS for namespace ${namespace}, current full head ${fullHead || head || "unknown"}, releaseTag v0.1.4, include promotedImages, fullHead/sourceEvidenceFullHead must match current head, staleEvidenceAllowed must not be true, and cywellSource must prove the current HEAD is in an approved fetched origin/* ref`
    );
    if (requireCluster && evidence.clusterIdentity) {
      expect(
        "cluster:release-images-evidence-cluster-identity",
        clusterIdentityMatches(evidence.clusterIdentity, currentClusterIdentity()),
        "release image promotion evidence was generated for the current cluster identity",
        `${releaseImagesEvidencePath} cluster identity must match current context/server/namespace UID/infrastructure`
      );
    }
    return evidence;
  } catch (error) {
    fail("cluster:release-images-evidence", `could not parse ${releaseImagesEvidencePath}: ${error.message}`);
    return null;
  }
}

function liveDatabaseUrlUsesService(urlText) {
  try {
    const url = new URL(urlText);
    const allowedHosts = new Set([
      "cas-knowledge-postgres",
      `cas-knowledge-postgres.${namespace}`,
      `cas-knowledge-postgres.${namespace}.svc`,
      `cas-knowledge-postgres.${namespace}.svc.cluster.local`
    ]);
    return url.protocol.startsWith("postgres") && allowedHosts.has(url.hostname) && (url.port === "" || url.port === "5432");
  } catch {
    return false;
  }
}

function deploymentReady(deploymentJson) {
  const desired = Number(deploymentJson?.spec?.replicas ?? 1);
  return (
    Number(deploymentJson?.status?.observedGeneration ?? 0) >= Number(deploymentJson?.metadata?.generation ?? 0) &&
    Number(deploymentJson?.status?.updatedReplicas ?? 0) >= desired &&
    Number(deploymentJson?.status?.readyReplicas ?? 0) >= desired &&
    Number(deploymentJson?.status?.availableReplicas ?? 0) >= desired &&
    Number(deploymentJson?.status?.unavailableReplicas ?? 0) === 0
  );
}

function statefulSetReady(statefulSet) {
  const desired = Number(statefulSet?.spec?.replicas ?? 1);
  return (
    Number(statefulSet?.status?.observedGeneration ?? 0) >= Number(statefulSet?.metadata?.generation ?? 0) &&
    Number(statefulSet?.status?.readyReplicas ?? 0) >= desired &&
    Number(statefulSet?.status?.currentReplicas ?? 0) >= desired &&
    Number(statefulSet?.status?.updatedReplicas ?? 0) >= desired &&
    (!statefulSet?.status?.currentRevision || statefulSet.status.currentRevision === statefulSet.status.updateRevision)
  );
}

function releaseDigestFor(evidence, imageName) {
  return imageDigest(evidence?.promotedImages?.[imageName]?.digest);
}

function readyPodsUsePromotedDigest(id, workload, containerName, imageName, releaseEvidence) {
  const selector = selectorArgFromLabels(workloadSelectorLabels(workload));
  if (!selector) {
    fail(id, `${workload?.metadata?.name ?? imageName} must have matchLabels so ready pod release digests can be verified`);
    return;
  }
  const pods = getJson(id, ["get", "pods", "-n", namespace, "-l", selector]);
  if (!pods) return;
  const expectedDigest = releaseDigestFor(releaseEvidence, imageName);
  const readyPods = (pods.items ?? []).filter(podReady);
  const podDigests = readyPods.map((pod) => ({
    name: pod.metadata?.name,
    digest: podContainerDigest(pod, containerName)
  }));
  expect(
    id,
    Boolean(expectedDigest) && readyPods.length > 0 && podDigests.every((item) => item.digest === expectedDigest),
    `${workload?.metadata?.name ?? imageName} ready pods run the promoted ${imageName}:v0.1.4 digest`,
    `${workload?.metadata?.name ?? imageName} ready pod digests must match promoted digest ${expectedDigest || "missing"}: ${JSON.stringify(podDigests)}`
  );
}

expect(
  "preflight:overlay-name",
  overlayNameValid,
  `${overlay} is a supported PBS preflight overlay`,
  `unsupported PBS preflight overlay '${overlayArg}'; expected pbs-shadow or pbs-live`
);
const rendered = renderKustomize(overlayPath);
const renderedObjects = renderKustomizeObjects(rendered);
const deployment = renderedDoc(rendered, "Deployment", "cas-knowledge-engine");
const gatewayDeployment = renderedDoc(rendered, "Deployment", "cas-gateway");
const configMap = renderedDoc(rendered, "ConfigMap", "cas-pbs-config");
const liveConfigMap = renderedDoc(rendered, "ConfigMap", "cas-knowledge-live-config");
const postgresStatefulSet = renderedDoc(rendered, "StatefulSet", "cas-knowledge-postgres");
const pbsEgress = renderedDoc(rendered, "NetworkPolicy", "cas-knowledge-engine-pbs-egress");
const knowledgeIngress = renderedDoc(rendered, "NetworkPolicy", "cas-knowledge-engine-ingress");
const pbsEgressObject = renderedObject(renderedObjects, "NetworkPolicy", "cas-knowledge-engine-pbs-egress");
const knowledgeIngressObject = renderedObject(renderedObjects, "NetworkPolicy", "cas-knowledge-engine-ingress");

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
const pbsBaseUrl = configValue(configMap, "base-url");
const pbsAuthMode = configValue(configMap, "auth-mode");
expect(
  "preflight:base-url-shape",
  pbsBaseUrlTargetsRuntimeService(pbsBaseUrl),
  "cas-pbs-config base-url targets playbookstudio-runtime Service DNS on port 8765",
  `unexpected base-url: ${pbsBaseUrl || "<missing>"}`
);
expect(
  "preflight:service-token-transport",
  pbsAuthMode !== "service-token" || pbsBaseUrl.startsWith("https://"),
  "service-token PBS auth uses HTTPS transport in rendered overlay",
  "service-token PBS auth must not use plain HTTP for non-local live/shadow traffic"
);
expect(
  "preflight:tls-insecure-disabled",
  configValue(configMap, "tls-insecure") === "false",
  "PBS TLS verification is enabled in rendered overlay",
  "PBS shadow/live overlays must keep tls-insecure=false"
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
  Boolean(pbsEgress) && Boolean(pbsEgressObject) && appliedPbsEgressScoped(pbsEgressObject),
  "PBS egress is exactly limited to DNS, Postgres, and labeled playbookstudio runtime pods on 8765"
);
expect(
  "preflight:knowledge-ingress-policy",
  Boolean(knowledgeIngress) && Boolean(knowledgeIngressObject) && appliedKnowledgeIngressScoped(knowledgeIngressObject),
  "knowledge-engine ingress is exactly restricted to gateway pods on 8080"
);
if (overlay === "pbs-live") {
  const postgresImage = firstContainerImage(postgresStatefulSet);
  const renderedCustomerAccess = configValue(liveConfigMap, "customer-access-json");
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
    "preflight:live-gateway-customer-acl",
    Boolean(gatewayDeployment) &&
      Boolean(liveConfigMap) &&
      envValue(gatewayDeployment, "CAS_KNOWLEDGE_REQUIRE_CUSTOMER_ACCESS") === "true" &&
      envFromConfig(gatewayDeployment, "CAS_KNOWLEDGE_CUSTOMER_ACCESS_JSON", "cas-knowledge-live-config", "customer-access-json") &&
      Boolean(renderedCustomerAccess),
    "pbs-live requires Gateway customer workspace ACL from live ConfigMap"
  );
  expect(
    "preflight:live-customer-acl-concrete",
    customerAccessPolicyIsConcrete(renderedCustomerAccess),
    "pbs-live customer workspace ACL maps real users/groups to explicit customer workspaces",
    "pbs-live customer workspace ACL must replace the wildcard placeholder before cutover"
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
  if (requireCluster) {
    const pinned = readStrictPinnedPbsSourceEvidence();
    expect(
      "cluster:pinned-pbs-source-evidence",
      pinned.ok,
      "strict pinned PBS source evidence is PASS, clean, approved-remote, fresh, fetch-backed, and hash-bound",
      `strict live preflight requires fresh ${pbsPinnedSourceEvidencePath} from verify:release:source-pinning; ${pinned.reason || "pinned source evidence is invalid"}`,
      { strictPinnedPbsSourceEvidence: pinned }
    );
  }
}

const runtimeNamespace = getJson("cluster:pbs-namespace", ["get", "namespace", "playbookstudio"]);
if (runtimeNamespace) pass("cluster:pbs-namespace", "playbookstudio namespace exists");
const runtimeService = getJson("cluster:pbs-runtime-service", ["get", "service", "-n", "playbookstudio", "playbookstudio-runtime"]);
if (runtimeService) {
  pbsRuntimeServicePresent = true;
  const ports = runtimeService.spec?.ports ?? [];
  expect(
    "cluster:pbs-runtime-service-port",
    ports.some((port) => Number(port.port) === 8765),
    "playbookstudio-runtime Service exposes PBS backend service port 8765",
    `playbookstudio-runtime Service must expose spec.ports[].port=8765 because CAS calls the Service DNS on :8765: ${JSON.stringify(ports)}`
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
      const readyPods = (runtimePods.items ?? []).filter((pod) => podReady(pod));
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
      const readyPodSource = readyPods.map(runtimePodSourceSummary);
      pbsRuntimeProbePodName = readyPods[0]?.metadata?.name || pbsRuntimeProbePodName;
      pbsRuntimeSourceEvidence.push(...readyPodSource);
      if (overlay === "pbs-live" && requireCluster) {
        const expectedPbsSourceHead = readPinnedPbsSourceHead();
        expect(
          "cluster:pbs-runtime-source-head-required",
          /^[a-f0-9]{40}$/i.test(expectedPbsSourceHead),
          "approved PBS full source SHA is available for runtime pod verification",
          `set CAS_PBS_SOURCE_HEAD or run verify:release:source-pinning to create ${pbsPinnedSourceEvidencePath} before live cutover`
        );
        if (/^[a-f0-9]{40}$/i.test(expectedPbsSourceHead)) {
          expect(
            "cluster:pbs-runtime-source-revision",
            readyPodSource.length > 0 && readyPodSource.every((pod) => pod.revision === expectedPbsSourceHead),
            "ready PBS runtime pods are stamped with the approved PBS source revision",
            `ready PBS runtime pods must expose one of ${runtimeRevisionKeys.join(", ")} or ${runtimeRevisionEnvNames.join(", ")} equal to ${expectedPbsSourceHead}: ${JSON.stringify(readyPodSource)}`,
            { expectedPbsSourceHead, pbsRuntimeSourceEvidence: readyPodSource }
          );
        }
      }
    }
    const runtimeEndpoints = getJson("cluster:pbs-runtime-service-endpoints", ["get", "endpoints", "-n", "playbookstudio", "playbookstudio-runtime"]);
    if (runtimeEndpoints) {
      expect(
        "cluster:pbs-runtime-service-endpoints-ready",
        runtimeServiceEndpointsReady(runtimeEndpoints),
        "playbookstudio-runtime Service has at least one ready endpoint on PBS backend port 8765",
        `playbookstudio-runtime Endpoints must expose a ready address and port 8765: ${JSON.stringify(runtimeEndpoints.subsets ?? [])}`
      );
    }
  } else {
    fail("cluster:pbs-runtime-service-selector-empty", "playbookstudio-runtime Service must have a selector so egress label checks are enforceable");
  }
}
let pbsBearerToken = "";
const authSecret = getJson("cluster:pbs-auth-secret", ["get", "secret", "-n", namespace, "cas-pbs-auth"]);
if (authSecret) {
  const hasBearer = Boolean(authSecret.data?.["bearer-token"]);
  expect("cluster:pbs-auth-secret-key", hasBearer, "cas-pbs-auth Secret contains bearer-token key");
  const bearerToken = decodeSecretValue(authSecret, "bearer-token");
  pbsBearerToken = bearerToken;
  expect(
    "cluster:pbs-auth-secret-content",
    bearerTokenLooksUsable(bearerToken),
    "cas-pbs-auth bearer-token decodes to usable non-placeholder service-token material",
    "cas-pbs-auth bearer-token must be non-empty, non-placeholder, whitespace-free, and at least 20 characters"
  );
} else if (requireSecret) {
  fail("cluster:pbs-auth-secret-required", "cas-pbs-auth Secret is required for this preflight run");
} else {
  warn("cluster:pbs-auth-secret-optional", "cas-pbs-auth Secret is absent in the current cluster; live cutover must create it or run preflight with --require-secret");
}
if (overlay === "pbs-live" && requireCluster && pbsRuntimeServicePresent) {
  const probe = pbsRuntimeProbePodName ? runPbsRuntimeHealthProbe(pbsRuntimeProbePodName, pbsAuthMode === "service-token" ? pbsBearerToken : "") : { ok: false, error: "no ready PBS runtime pod selected for health probe" };
  const readiness = pbsRuntimeHealthReadiness(probe.body);
  pbsRuntimeHealthEvidence.push({
    pod: pbsRuntimeProbePodName || null,
    ok: Boolean(probe.ok),
    status: probe.status ?? null,
    python: probe.python ?? null,
    readiness
  });
  expect(
    "cluster:pbs-runtime-health-ready",
    probe.ok === true && pbsRuntimeHealthReady(probe.body),
    "playbookstudio-runtime /api/health reports DB, pgvector, corpus/index, compiled wiki, and required ready scopes through the Service DNS",
    `playbookstudio-runtime /api/health must be reachable from a runtime pod through ${pbsBaseUrl} and report database_runtime/db_ready/pgvector_ready/embedding_index_parity/compiled_wiki_ready plus official_docs,study_docs ready scopes: ${JSON.stringify({ pod: pbsRuntimeProbePodName || null, status: probe.status ?? null, error: probe.error ?? probe.stderr ?? "", readiness })}`,
    { pbsRuntimeHealthEvidence: pbsRuntimeHealthEvidence[pbsRuntimeHealthEvidence.length - 1] }
  );
}
const ownerAuthSecret = getJson("cluster:internal-owner-auth-secret", ["get", "secret", "-n", namespace, "cas-knowledge-internal-auth"]);
if (ownerAuthSecret) {
  const hasOwnerHmac = Boolean(ownerAuthSecret.data?.["owner-hmac-secret"]);
  expect("cluster:internal-owner-auth-secret-key", hasOwnerHmac, "cas-knowledge-internal-auth Secret contains owner-hmac-secret key");
  const ownerHmacSecret = decodeSecretValue(ownerAuthSecret, "owner-hmac-secret");
  expect(
    "cluster:internal-owner-auth-secret-content",
    ownerHmacSecretLooksUsable(ownerHmacSecret),
    "cas-knowledge-internal-auth owner-hmac-secret decodes to usable non-placeholder signing material",
    "cas-knowledge-internal-auth owner-hmac-secret must be non-empty, non-placeholder, whitespace-free, and at least 32 characters"
  );
} else if (requireSecret) {
  fail("cluster:internal-owner-auth-secret-required", "cas-knowledge-internal-auth Secret is required for Gateway/Knowledge Engine owner signing");
} else {
  warn("cluster:internal-owner-auth-secret-optional", "cas-knowledge-internal-auth Secret is absent; live cutover must create it or run preflight with --require-secret");
}
if (overlay === "pbs-live") {
  let liveDatabaseUrl = "";
  const releaseImagesEvidence = loadReleaseImagesEvidence();
  let apiTargets = [];
  if (requireCluster) {
    for (const imageName of ["cas-gateway", "cas-console-plugin", "cas-knowledge-engine", "cas-knowledge-postgres"]) {
      const imageTag = getJson(`cluster:release-image:${imageName}`, ["get", "imagestreamtag", "-n", namespace, `${imageName}:v0.1.4`]);
      if (imageTag) {
        const dockerImageReference = imageTag.image?.dockerImageReference ?? "";
        const promotedDigest = imageDigest(releaseImagesEvidence?.promotedImages?.[imageName]?.digest);
        const clusterDigest = imageDigest(dockerImageReference);
        pass(`cluster:release-image:${imageName}:v0.1.4`, `${imageName}:v0.1.4 ImageStreamTag exists`);
        expect(
          `cluster:release-image-reference:${imageName}:v0.1.4`,
          digestPinnedImageReference(dockerImageReference),
          `${imageName}:v0.1.4 resolves to a digest-pinned image reference`,
          `${imageName}:v0.1.4 must resolve to image.dockerImageReference with @sha256:; found ${dockerImageReference || "none"}`
        );
        expect(
          `cluster:release-image-evidence:${imageName}:v0.1.4`,
          releaseImagesEvidenceCurrent && Boolean(promotedDigest) && clusterDigest === promotedDigest,
          `${imageName}:v0.1.4 digest matches promoted release image evidence`,
          `${imageName}:v0.1.4 digest ${clusterDigest || "missing"} must match current promoted evidence digest ${promotedDigest || "missing"}; regenerate ${releaseImagesEvidencePath} from a clean pushed HEAD if the evidence is stale`
        );
      }
    }
    apiTargets = collectKubernetesApiTargets();
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
    expect(
      "cluster:knowledge-postgres-live-database-url-service",
      liveDatabaseUrlUsesService(liveDatabaseUrl),
      "cas-knowledge-postgres-live database-url targets the knowledge Postgres Service on port 5432",
      "cas-knowledge-postgres-live database-url must use cas-knowledge-postgres Service DNS on port 5432, not localhost or a pod-local endpoint"
    );
    expect(
      "cluster:knowledge-postgres-live-secret-content",
      postgresSecretValuesUsable(liveDbSecret),
      "cas-knowledge-postgres-live Secret decodes to non-placeholder matching database, username, password, and service DATABASE_URL",
      "cas-knowledge-postgres-live Secret values must be non-placeholder and database-url username/password/database must match the individual keys"
    );
  } else if (requireSecret) {
    fail("cluster:knowledge-postgres-live-secret-required", "cas-knowledge-postgres-live Secret is required for live cutover");
  } else {
    warn("cluster:knowledge-postgres-live-secret-optional", "cas-knowledge-postgres-live Secret is absent; live cutover must create it or run preflight with --require-secret");
  }
  if (requireSecret) {
    const binding = livePrereqSecretHashBinding(authSecret, ownerAuthSecret, liveDbSecret);
    expect(
      "cluster:live-prereq-secret-hash-binding",
      binding.ok,
      "live cluster Secret values match the approved render:pbs:live-prereqs redacted hashes",
      `live cluster Secret values must match ${livePrereqsEvidencePath} and its redacted summary: ${binding.reasons.join("; ")}`,
      { livePrereqSecretHashBinding: binding }
    );
  }
  const legacyDbSecret = getJsonOptional("cluster:legacy-postgres-secret", ["get", "secret", "-n", namespace, "cas-knowledge-postgres"]);
  if (legacyDbSecret.value) {
    const detail = "legacy cas-knowledge-postgres Secret exists in the cluster; prune/delete it before pbs-live cutover so dev credentials cannot be reused";
    if (requireSecret) fail("cluster:legacy-postgres-secret", detail);
    else warn("cluster:legacy-postgres-secret", detail);
  } else if (!legacyDbSecret.readError) {
    pass("cluster:legacy-postgres-secret-absent", "legacy cas-knowledge-postgres Secret is absent");
  }
  if (requireCluster && !skipApplied) {
    let appliedKnowledgeLabels = {
      "app.kubernetes.io/name": "cywell-ai-sentinel",
      "app.kubernetes.io/component": "knowledge-engine"
    };
    const appliedPbsConfig = getJson("cluster:applied-pbs-config", ["get", "configmap", "-n", namespace, "cas-pbs-config"]);
    if (appliedPbsConfig) {
      expect(
        "cluster:applied-pbs-config-values",
        configMapDataValue(appliedPbsConfig, "base-url") === pbsBaseUrl &&
          configMapDataValue(appliedPbsConfig, "auth-mode") === pbsAuthMode &&
          configMapDataValue(appliedPbsConfig, "timeout-ms") === configValue(configMap, "timeout-ms") &&
          configMapDataValue(appliedPbsConfig, "max-response-bytes") === configValue(configMap, "max-response-bytes") &&
          configMapDataValue(appliedPbsConfig, "tls-insecure") === "false",
        "applied cas-pbs-config matches rendered PBS live transport settings",
        `applied cas-pbs-config must match rendered live values and keep tls-insecure=false: ${JSON.stringify(appliedPbsConfig.data ?? {})}`
      );
    }
    const appliedLiveConfig = getJson("cluster:applied-live-config", ["get", "configmap", "-n", namespace, "cas-knowledge-live-config"]);
    if (appliedLiveConfig) {
      const appliedCustomerAccess = configMapDataValue(appliedLiveConfig, "customer-access-json");
      expect(
        "cluster:applied-live-customer-acl",
        configMapDataValue(appliedLiveConfig, "service-owner") === configValue(liveConfigMap, "service-owner") &&
          appliedCustomerAccess === configValue(liveConfigMap, "customer-access-json") &&
          customerAccessPolicyIsConcrete(appliedCustomerAccess),
        "applied live customer ACL matches rendered config and contains explicit customer mappings",
        "applied live customer ACL must match rendered config and must not use the wildcard placeholder"
      );
    }
    const appliedEngine = getJson("cluster:applied-knowledge-engine", ["get", "deployment", "-n", namespace, "cas-knowledge-engine"]);
    if (appliedEngine) {
      appliedKnowledgeLabels = { ...appliedKnowledgeLabels, ...(appliedEngine.spec?.template?.metadata?.labels ?? {}) };
      const engineContainer = workloadContainer(appliedEngine, "knowledge-engine");
      const serviceOwnerRef = workloadEnv(appliedEngine, "CAS_KNOWLEDGE_SINGLE_OWNER", "knowledge-engine").valueFrom?.configMapKeyRef;
      expect(
        "cluster:applied-knowledge-engine-contract",
        deploymentReady(appliedEngine) &&
          String(engineContainer.image ?? "").endsWith(":v0.1.4") &&
          workloadEnvValue(appliedEngine, "CAS_KNOWLEDGE_PROVIDER", "knowledge-engine") === "pbs-http-live" &&
          workloadEnvValue(appliedEngine, "CAS_KNOWLEDGE_REQUIRE_OWNER_HEADER", "knowledge-engine") === "true" &&
          workloadEnvSecretRef(appliedEngine, "CAS_KNOWLEDGE_OWNER_HMAC_SECRET", "cas-knowledge-internal-auth", "owner-hmac-secret", "knowledge-engine") &&
          workloadEnvConfigRef(appliedEngine, "CAS_PBS_BASE_URL", "cas-pbs-config", "base-url", "knowledge-engine") &&
          workloadEnvConfigRef(appliedEngine, "CAS_PBS_AUTH_MODE", "cas-pbs-config", "auth-mode", "knowledge-engine") &&
          workloadEnvConfigRef(appliedEngine, "CAS_PBS_TIMEOUT_MS", "cas-pbs-config", "timeout-ms", "knowledge-engine") &&
          workloadEnvConfigRef(appliedEngine, "CAS_PBS_MAX_RESPONSE_BYTES", "cas-pbs-config", "max-response-bytes", "knowledge-engine") &&
          workloadEnvConfigRef(appliedEngine, "CAS_PBS_TLS_INSECURE", "cas-pbs-config", "tls-insecure", "knowledge-engine") &&
          workloadEnvValue(appliedEngine, "CAS_PBS_REQUIRE_RUNTIME_READY", "knowledge-engine") === "true" &&
          workloadEnvValue(appliedEngine, "CAS_PBS_REQUIRE_CORPUS_READY", "knowledge-engine") === "true" &&
          workloadEnvValue(appliedEngine, "CAS_PBS_REQUIRED_READY_SCOPES", "knowledge-engine") === "official_docs,study_docs" &&
          workloadEnvSecretRef(appliedEngine, "CAS_PBS_BEARER_TOKEN", "cas-pbs-auth", "bearer-token", "knowledge-engine") &&
          workloadEnvSecretRef(appliedEngine, "DATABASE_URL", "cas-knowledge-postgres-live", "database-url", "knowledge-engine") &&
          serviceOwnerRef?.name === "cas-knowledge-live-config" &&
          serviceOwnerRef?.key === "service-owner",
        "applied cas-knowledge-engine is rolled out with v0.1.4 pbs-live env, readiness gates, HMAC, and live Secret refs",
        JSON.stringify({
          image: engineContainer.image,
          provider: workloadEnvValue(appliedEngine, "CAS_KNOWLEDGE_PROVIDER", "knowledge-engine"),
          pbsBaseUrlRef: workloadEnv(appliedEngine, "CAS_PBS_BASE_URL", "knowledge-engine").valueFrom?.configMapKeyRef,
          readyReplicas: appliedEngine.status?.readyReplicas,
          availableReplicas: appliedEngine.status?.availableReplicas,
          serviceOwnerRef
        })
      );
      readyPodsUsePromotedDigest(
        "cluster:applied-knowledge-engine-promoted-digest",
        appliedEngine,
        "knowledge-engine",
        "cas-knowledge-engine",
        releaseImagesEvidence
      );
    }
    const appliedGateway = getJson("cluster:applied-gateway", ["get", "deployment", "-n", namespace, "cas-gateway"]);
    if (appliedGateway) {
      const gatewayContainer = workloadContainer(appliedGateway, "gateway");
      expect(
        "cluster:applied-gateway-contract",
        deploymentReady(appliedGateway) &&
          String(gatewayContainer.image ?? "").endsWith(":v0.1.4") &&
          workloadEnvValue(appliedGateway, "CAS_KNOWLEDGE_OWNER_IDENTITY_MODE", "gateway") === "openshift-selfsubjectreview" &&
          workloadEnvValue(appliedGateway, "CAS_KNOWLEDGE_REQUIRE_CUSTOMER_ACCESS", "gateway") === "true" &&
          workloadEnvConfigRef(appliedGateway, "CAS_KNOWLEDGE_CUSTOMER_ACCESS_JSON", "cas-knowledge-live-config", "customer-access-json", "gateway") &&
          workloadEnvSecretRef(appliedGateway, "CAS_KNOWLEDGE_OWNER_HMAC_SECRET", "cas-knowledge-internal-auth", "owner-hmac-secret", "gateway") &&
          workloadEnvValue(appliedGateway, "CAS_KNOWLEDGE_ENGINE_URL", "gateway").includes("cas-knowledge-engine"),
        "applied cas-gateway is rolled out with v0.1.4, SelfSubjectReview owner identity, customer ACL, HMAC, and knowledge routing",
        JSON.stringify({
          image: gatewayContainer.image,
          knowledgeUrl: workloadEnvValue(appliedGateway, "CAS_KNOWLEDGE_ENGINE_URL", "gateway"),
          readyReplicas: appliedGateway.status?.readyReplicas,
          availableReplicas: appliedGateway.status?.availableReplicas
        })
      );
      readyPodsUsePromotedDigest("cluster:applied-gateway-promoted-digest", appliedGateway, "gateway", "cas-gateway", releaseImagesEvidence);
    }
    const appliedConsole = getJson("cluster:applied-console-plugin", ["get", "deployment", "-n", namespace, "cas-console-plugin"]);
    if (appliedConsole) {
      const consoleContainer = workloadContainer(appliedConsole, "console-plugin");
      expect(
        "cluster:applied-console-plugin-contract",
        deploymentReady(appliedConsole) && String(consoleContainer.image ?? "").endsWith(":v0.1.4"),
        "applied cas-console-plugin is fully rolled out with v0.1.4 image",
        JSON.stringify({
          image: consoleContainer.image,
          updatedReplicas: appliedConsole.status?.updatedReplicas,
          readyReplicas: appliedConsole.status?.readyReplicas,
          availableReplicas: appliedConsole.status?.availableReplicas
        })
      );
      readyPodsUsePromotedDigest("cluster:applied-console-plugin-promoted-digest", appliedConsole, "console-plugin", "cas-console-plugin", releaseImagesEvidence);
    }
    const appliedPostgres = getJson("cluster:applied-knowledge-postgres", ["get", "statefulset", "-n", namespace, "cas-knowledge-postgres"]);
    if (appliedPostgres) {
      const postgresContainer = workloadContainer(appliedPostgres, "postgres");
      expect(
        "cluster:applied-postgres-live-secret-refs",
        statefulSetReady(appliedPostgres) &&
          String(postgresContainer.image ?? "").endsWith(":v0.1.4") &&
          workloadEnvSecretRef(appliedPostgres, "POSTGRES_DB", "cas-knowledge-postgres-live", "database", "postgres") &&
          workloadEnvSecretRef(appliedPostgres, "POSTGRES_USER", "cas-knowledge-postgres-live", "username", "postgres") &&
          workloadEnvSecretRef(appliedPostgres, "POSTGRES_PASSWORD", "cas-knowledge-postgres-live", "password", "postgres"),
        "applied knowledge Postgres StatefulSet is fully rolled out with v0.1.4 and references cas-knowledge-postgres-live credentials",
        JSON.stringify({
          image: postgresContainer.image,
          readyReplicas: appliedPostgres.status?.readyReplicas,
          currentReplicas: appliedPostgres.status?.currentReplicas,
          updatedReplicas: appliedPostgres.status?.updatedReplicas,
          currentRevision: appliedPostgres.status?.currentRevision,
          updateRevision: appliedPostgres.status?.updateRevision
        })
      );
      readyPodsUsePromotedDigest("cluster:applied-postgres-promoted-digest", appliedPostgres, "postgres", "cas-knowledge-postgres", releaseImagesEvidence);
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
              "-i",
              "-n",
              namespace,
              readyPostgresPod.metadata.name,
              "--",
              "sh",
              "-ec",
              [
                "DATABASE_URL=$(cat); export DATABASE_URL;",
                "psql -v ON_ERROR_STOP=1 \"$DATABASE_URL\" -tAc \"",
                "SELECT 'engine_url_identity=' || CASE WHEN current_database() <> '' AND current_user <> '' THEN 't' ELSE 'f' END; ",
                "SELECT 'engine_url_vector_ext=' || CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector') THEN 't' ELSE 'f' END;",
                "\""
              ].join(" ")
            ],
            { timeoutMs: 30000, input: liveDatabaseUrl }
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
      expect(
        "cluster:applied-knowledge-ingress-scoped",
        appliedKnowledgeIngressScoped(appliedKnowledgeIngress),
        "applied knowledge ingress NetworkPolicy allows only gateway pods on 8080",
        JSON.stringify(appliedKnowledgeIngress.spec ?? {})
      );
    }
    const appliedNetworkPolicies = getJson("cluster:applied-networkpolicy-union", ["get", "networkpolicy", "-n", namespace]);
    if (appliedNetworkPolicies) {
      const policies = appliedNetworkPolicies.items ?? [];
      const union = appliedKnowledgeIngressUnionScoped(appliedNetworkPolicies.items ?? [], appliedKnowledgeLabels);
      expect(
        "cluster:applied-knowledge-ingress-union-scoped",
        union.ok,
        "applied knowledge-engine ingress union allows only gateway pods on TCP 8080",
        JSON.stringify(union)
      );
      const egressUnion = appliedKnowledgeEgressUnionScoped(appliedNetworkPolicies.items ?? [], appliedKnowledgeLabels);
      expect(
        "cluster:applied-knowledge-egress-union-scoped",
        egressUnion.ok,
        "applied knowledge-engine egress union allows only DNS, Postgres, and labeled PBS runtime pods",
        JSON.stringify(egressUnion)
      );
      const gatewayUnion = appliedPolicyUnionScoped({
        policies,
        labels: { "app.kubernetes.io/name": "cywell-ai-sentinel", "app.kubernetes.io/component": "gateway" },
        ingressRule: gatewayIngressRule,
        egressRule: (rule) => gatewayEgressRule(rule, apiTargets),
        requireIngress: true,
        requireEgress: true
      });
      expect(
        "cluster:applied-gateway-networkpolicy-union-scoped",
        gatewayUnion.ok,
        "applied gateway NetworkPolicy union allows only console/plugin ingress and DNS/Lightspeed/knowledge/Kubernetes-API egress",
        JSON.stringify(gatewayUnion)
      );
      const consoleUnion = appliedPolicyUnionScoped({
        policies,
        labels: { "app.kubernetes.io/name": "cywell-ai-sentinel", "app.kubernetes.io/component": "console-plugin" },
        ingressRule: consoleIngressRule,
        egressRule: consoleEgressRule,
        requireIngress: true,
        requireEgress: true
      });
      expect(
        "cluster:applied-console-plugin-networkpolicy-union-scoped",
        consoleUnion.ok,
        "applied console-plugin NetworkPolicy union allows only OpenShift Console ingress and DNS/gateway egress",
        JSON.stringify(consoleUnion)
      );
      const postgresUnion = appliedPolicyUnionScoped({
        policies,
        labels: { "app.kubernetes.io/name": "cywell-ai-sentinel", "app.kubernetes.io/component": "knowledge-postgres" },
        ingressRule: postgresIngressRule,
        egressRule: () => false,
        requireIngress: true,
        requireEgress: true
      });
      expect(
        "cluster:applied-postgres-networkpolicy-union-scoped",
        postgresUnion.ok,
        "applied knowledge-postgres NetworkPolicy union allows only knowledge-engine ingress and default-deny egress",
        JSON.stringify(postgresUnion)
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
      expect(
        "cluster:applied-pbs-egress-scoped",
        appliedPbsEgressScoped(appliedPbsEgress),
        "applied PBS egress NetworkPolicy is restricted exactly to DNS, Postgres, and labeled playbookstudio runtime pods on 8765",
        JSON.stringify(appliedPbsEgress.spec ?? {})
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
