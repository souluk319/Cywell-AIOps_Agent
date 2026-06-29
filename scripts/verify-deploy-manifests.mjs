#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

const files = [
  "deploy/kustomize/base/00-namespace.yaml",
  "deploy/kustomize/base/10-rbac.yaml",
  "deploy/kustomize/base/20-networkpolicy.yaml",
  "deploy/kustomize/base/30-gateway.yaml",
  "deploy/kustomize/base/35-knowledge-engine.yaml",
  "deploy/kustomize/base/36-knowledge-postgres.yaml",
  "deploy/kustomize/base/40-console-plugin-workload.yaml",
  "deploy/kustomize/base/50-consoleplugin.yaml",
  "deploy/kustomize/base/kustomization.yaml",
  "deploy/kustomize/overlays/crc/buildconfigs.yaml",
  "deploy/kustomize/overlays/crc/21-lightspeed-ingress.yaml",
  "deploy/kustomize/overlays/crc/gateway-crc-api-egress.yaml",
  "deploy/kustomize/overlays/crc/gateway-lightspeed-tls-insecure-patch.yaml",
  "deploy/kustomize/overlays/crc/kustomization.yaml",
  "deploy/kustomize/overlays/pbs-shadow/kustomization.yaml",
  "deploy/kustomize/overlays/pbs-shadow/knowledge-engine-pbs-shadow-patch.yaml",
  "deploy/kustomize/overlays/pbs-shadow/pbs-egress-networkpolicy.yaml",
  "deploy/kustomize/overlays/pbs-live/kustomization.yaml",
  "deploy/kustomize/overlays/pbs-live/delete-dev-knowledge-env-patch.yaml",
  "deploy/kustomize/overlays/pbs-live/gateway-customer-access-live-patch.yaml",
  "deploy/kustomize/overlays/pbs-live/knowledge-engine-pbs-live-patch.yaml",
  "deploy/kustomize/overlays/pbs-live/knowledge-postgres-live-secretrefs-patch.yaml",
  "package.json",
  "scripts/deploy-crc-dev.mjs",
  "scripts/promote-crc-release-images.mjs",
  "scripts/verify-crc-deployment.mjs",
  "scripts/verify-pbs-live-smoke.mjs",
  "scripts/verify-pbs-preflight.mjs",
  "scripts/render-pbs-live-prereqs.mjs",
  "scripts/render-pbs-cutover-bundle.mjs",
  "scripts/verify-pbs-source-contract.mjs",
  "apps/gateway/src/server.mjs",
  "apps/knowledge-engine/src/cas_knowledge_engine/engine.py",
  "apps/knowledge-engine/src/cas_knowledge_engine/pbs_client.py",
  "apps/knowledge-engine/src/cas_knowledge_engine/storage.py",
  "apps/knowledge-engine/src/cas_knowledge_engine/selftest.py",
  "apps/console-plugin/console-extensions.json"
];

const checks = [];
const checkedAt = new Date().toISOString();

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30000,
    windowsHide: true
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error
  };
}

function run(command, args) {
  return runCommand(command, args).stdout.trim();
}

function record(status, id, detail) {
  checks.push({ status, id, detail });
  console.log(`[${status}] ${id}: ${detail}`);
}

function pass(id, detail) {
  record("PASS", id, detail);
}

function fail(id, detail) {
  record("FAIL", id, detail);
}

function expect(id, condition, passDetail, failDetail = passDetail) {
  if (condition) pass(id, passDetail);
  else fail(id, failDetail);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderKustomize(id, path) {
  const attempts = [
    ["oc", ["kustomize", path]],
    ["kubectl", ["kustomize", path]]
  ];
  const errors = [];
  for (const [command, args] of attempts) {
    const result = runCommand(command, args, { timeoutMs: 60000 });
    if (result.status === 0 && result.stdout.trim()) {
      pass(`render:${id}`, `${command} kustomize rendered ${path}`);
      return result.stdout;
    }
    errors.push(`${command}: ${result.error?.message || result.stderr.trim() || `exit ${result.status}`}`);
  }
  fail(`render:${id}`, `unable to render ${path}: ${errors.join("; ")}`);
  return "";
}

function renderedDoc(rendered, kind, name) {
  const kindPattern = new RegExp(`^kind:\\s*${escapeRegExp(kind)}\\s*$`, "m");
  const namePattern = new RegExp(`^  name:\\s*${escapeRegExp(name)}\\s*$`, "m");
  return rendered.split(/^---\s*$/m).find((doc) => kindPattern.test(doc) && namePattern.test(doc)) ?? "";
}

function lineMatches(text, pattern) {
  return text.split(/\r?\n/).filter((line) => pattern.test(line)).length;
}

function knowledgeIngressSelectsKnowledge(doc) {
  return (
    doc.includes("podSelector:") &&
    doc.includes("matchLabels:") &&
    doc.includes("app.kubernetes.io/name: cywell-ai-sentinel") &&
    doc.includes("app.kubernetes.io/component: knowledge-engine")
  );
}

function knowledgeIngressAllowsGatewayOnly(doc) {
  const ports = [...doc.matchAll(/^\s*-?\s*port:\s*(\d+)\s*$/gm)].map((match) => match[1]);
  return (
    /^\s*policyTypes:\r?\n\s*-\s*Ingress\s*$/m.test(doc) &&
    lineMatches(doc, /^\s*- from:\s*$/) === 1 &&
    lineMatches(doc, /^\s*- podSelector:\s*$/) === 1 &&
    doc.includes("app.kubernetes.io/component: gateway") &&
    lineMatches(doc, /^\s*-?\s*protocol:\s*TCP\s*$/) === 1 &&
    ports.length === 1 &&
    ports[0] === "8080" &&
    !/namespaceSelector:|ipBlock:|podSelector:\s*\{\}|matchLabels:\s*\{\}/.test(doc)
  );
}

function assertKnowledgeIngress(renderId, rendered) {
  const knowledgeIngress = renderedDoc(rendered, "NetworkPolicy", "cas-knowledge-engine-ingress");
  expect(`render:${renderId}:knowledge-ingress-policy`, Boolean(knowledgeIngress), `${renderId} renders knowledge-engine ingress policy`);
  expect(
    `render:${renderId}:knowledge-ingress-selector`,
    knowledgeIngressSelectsKnowledge(knowledgeIngress),
    `${renderId} knowledge-engine ingress policy selects knowledge-engine pods`
  );
  expect(
    `render:${renderId}:knowledge-ingress-gateway-only`,
    knowledgeIngressAllowsGatewayOnly(knowledgeIngress),
    `${renderId} knowledge-engine ingress policy only allows gateway pods on TCP 8080`
  );
}

function restrictivePolicy(policy) {
  return Boolean(policy) && !/namespaceSelector:\s*\{\}|cidr:\s*0\.0\.0\.0\/0|ipBlock:\s*\{\}|podSelector:\s*\{\}|matchLabels:\s*\{\}/.test(policy);
}

function gatewayIngressScoped(policy) {
  return (
    restrictivePolicy(policy) &&
    policy.includes("name: cas-gateway-ingress") &&
    policy.includes("app.kubernetes.io/component: gateway") &&
    policy.includes("- Ingress") &&
    policy.includes("kubernetes.io/metadata.name: openshift-console") &&
    policy.includes("app.kubernetes.io/component: console-plugin") &&
    policy.includes("port: 9443")
  );
}

function consolePluginIngressScoped(policy) {
  return (
    restrictivePolicy(policy) &&
    policy.includes("name: cas-console-plugin-ingress") &&
    policy.includes("app.kubernetes.io/component: console-plugin") &&
    policy.includes("- Ingress") &&
    policy.includes("kubernetes.io/metadata.name: openshift-console") &&
    policy.includes("port: 9443")
  );
}

function consolePluginEgressScoped(policy) {
  return (
    restrictivePolicy(policy) &&
    policy.includes("name: cas-console-plugin-egress") &&
    policy.includes("app.kubernetes.io/component: console-plugin") &&
    policy.includes("- Egress") &&
    policy.includes("kubernetes.io/metadata.name: openshift-dns") &&
    policy.includes("app.kubernetes.io/component: gateway") &&
    policy.includes("port: 53") &&
    policy.includes("port: 5353") &&
    policy.includes("port: 9443")
  );
}

function postgresIngressScoped(policy) {
  return (
    restrictivePolicy(policy) &&
    policy.includes("name: cas-knowledge-postgres-ingress") &&
    policy.includes("app.kubernetes.io/component: knowledge-postgres") &&
    policy.includes("- Ingress") &&
    policy.includes("app.kubernetes.io/component: knowledge-engine") &&
    policy.includes("port: 5432")
  );
}

function postgresEgressDefaultDeny(policy) {
  return (
    policy.includes("name: cas-knowledge-postgres-egress") &&
    policy.includes("app.kubernetes.io/component: knowledge-postgres") &&
    policy.includes("- Egress") &&
    policy.includes("egress: []")
  );
}

function assertWorkloadIsolationPolicies(renderId, rendered) {
  expect(
    `render:${renderId}:gateway-ingress-policy`,
    gatewayIngressScoped(renderedDoc(rendered, "NetworkPolicy", "cas-gateway-ingress")),
    `${renderId} gateway ingress is limited to OpenShift Console and console-plugin on TCP 9443`
  );
  expect(
    `render:${renderId}:console-plugin-ingress-policy`,
    consolePluginIngressScoped(renderedDoc(rendered, "NetworkPolicy", "cas-console-plugin-ingress")),
    `${renderId} console-plugin ingress is limited to OpenShift Console on TCP 9443`
  );
  expect(
    `render:${renderId}:console-plugin-egress-policy`,
    consolePluginEgressScoped(renderedDoc(rendered, "NetworkPolicy", "cas-console-plugin-egress")),
    `${renderId} console-plugin egress is limited to DNS and cas-gateway`
  );
  expect(
    `render:${renderId}:postgres-ingress-policy`,
    postgresIngressScoped(renderedDoc(rendered, "NetworkPolicy", "cas-knowledge-postgres-ingress")),
    `${renderId} Postgres ingress is limited to knowledge-engine on TCP 5432`
  );
  expect(
    `render:${renderId}:postgres-egress-default-deny`,
    postgresEgressDefaultDeny(renderedDoc(rendered, "NetworkPolicy", "cas-knowledge-postgres-egress")),
    `${renderId} Postgres egress is explicit default deny`
  );
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

function noPbsSecretMaterial(text) {
  const pbsBearer = envBlock(text, "CAS_PBS_BEARER_TOKEN");
  return (
    !/secretGenerator:/i.test(text) &&
    !renderedDoc(text, "Secret", "cas-pbs-auth") &&
    !/CAS_PBS_API_KEY/i.test(text) &&
    !/Authorization:\s*Bearer\s+\S+/i.test(text) &&
    !/^\s*value:\s*/m.test(pbsBearer)
  );
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

function knowledgeEgressScoped(policy) {
  return (
    policy.includes("name: cas-knowledge-engine-egress") &&
    policy.includes("app.kubernetes.io/component: knowledge-engine") &&
    policy.includes("- Egress") &&
    policy.includes("kubernetes.io/metadata.name: openshift-dns") &&
    policy.includes("app.kubernetes.io/component: knowledge-postgres") &&
    policy.includes("port: 53") &&
    policy.includes("port: 5353") &&
    policy.includes("port: 5432") &&
    !/namespaceSelector:\s*\{\}|cidr:\s*0\.0\.0\.0\/0|ipBlock:\s*\{\}|podSelector:\s*\{\}/.test(policy)
  );
}

function runRenderedChecks() {
  const base = renderKustomize("base", "deploy/kustomize/base");
  const crc = renderKustomize("crc", "deploy/kustomize/overlays/crc");
  const shadow = renderKustomize("pbs-shadow", "deploy/kustomize/overlays/pbs-shadow");
  const live = renderKustomize("pbs-live", "deploy/kustomize/overlays/pbs-live");

  const baseDeployment = renderedDoc(base, "Deployment", "cas-knowledge-engine");
  const baseGatewayDeployment = renderedDoc(base, "Deployment", "cas-gateway");
  const crcGatewayDeployment = renderedDoc(crc, "Deployment", "cas-gateway");
  expect("render:base:gateway-deployment", Boolean(baseGatewayDeployment), "base renders cas-gateway Deployment");
  expect(
    "render:base:gateway-owner-identity",
    envValue(baseGatewayDeployment, "CAS_KNOWLEDGE_OWNER_IDENTITY_MODE") === "openshift-selfsubjectreview" &&
      envValue(baseGatewayDeployment, "CAS_KNOWLEDGE_OWNER_IDENTITY_TIMEOUT_MS") === "3000",
    "base gateway verifies knowledge owners through OpenShift SelfSubjectReview"
  );
  expect(
    "render:base:gateway-owner-hmac-secret",
    envFromRequiredSecret(baseGatewayDeployment, "CAS_KNOWLEDGE_OWNER_HMAC_SECRET", "cas-knowledge-internal-auth", "owner-hmac-secret"),
    "base gateway signs owner headers with internal Secret material"
  );
  expect(
    "render:base:gateway-customer-acl-dev-mode",
    envValue(baseGatewayDeployment, "CAS_KNOWLEDGE_REQUIRE_CUSTOMER_ACCESS") === "false",
    "base/CRC gateway keeps customer ACL disabled for owner-scoped dev mode"
  );
  expect(
    "render:base:openshift-api-tls",
    envValue(baseGatewayDeployment, "CAS_OPENSHIFT_API_TLS_INSECURE") === "false" &&
      envValue(baseGatewayDeployment, "CAS_OPENSHIFT_API_CA_FILE") === "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
    "base gateway verifies OpenShift API TLS with mounted cluster CA"
  );
  expect(
    "render:base:lightspeed-tls",
    envValue(baseGatewayDeployment, "CAS_LIGHTSPEED_TLS_INSECURE") === "false" &&
      envValue(baseGatewayDeployment, "CAS_LIGHTSPEED_CA_FILE") === "/var/run/secrets/openshift/service-ca/service-ca.crt" &&
      base.includes("service.beta.openshift.io/inject-cabundle") &&
      base.includes("cas-openshift-service-ca"),
    "base gateway verifies Lightspeed TLS with mounted OpenShift service CA"
  );
  expect("render:base:knowledge-deployment", Boolean(baseDeployment), "base renders cas-knowledge-engine Deployment");
  expect(
    "render:base:provider-local",
    envValue(baseDeployment, "CAS_KNOWLEDGE_PROVIDER") === "pbs-compatible-local",
    "base knowledge engine provider remains pbs-compatible-local"
  );
  expect(
    "render:base:knowledge-owner-hmac-secret",
    envFromRequiredSecret(baseDeployment, "CAS_KNOWLEDGE_OWNER_HMAC_SECRET", "cas-knowledge-internal-auth", "owner-hmac-secret"),
    "base knowledge engine verifies signed owner headers with internal Secret material"
  );
  expect(
    "render:base:no-pbs-overlay",
    !/pbs-http-shadow|pbs-http-live|CAS_PBS_|cas-pbs-config|cas-knowledge-engine-pbs-egress/.test(base),
    "base render has no PBS HTTP overlay wiring"
  );
  assertKnowledgeIngress("base", base);
  assertWorkloadIsolationPolicies("base", base);
  expect(
    "render:base:knowledge-egress-policy",
    knowledgeEgressScoped(renderedDoc(base, "NetworkPolicy", "cas-knowledge-engine-egress")),
    "base renders scoped knowledge-engine DNS/Postgres egress policy"
  );
  expect(
    "render:base:no-crc-lab-policies",
    !base.includes("10.217.4.1/32") &&
      !base.includes("192.168.126.11/32") &&
      !base.includes("cas-gateway-to-lightspeed-app-server"),
    "base render excludes CRC-specific Kubernetes API egress and lab Lightspeed ingress"
  );
  expect(
    "render:crc:api-egress",
    Boolean(renderedDoc(crc, "NetworkPolicy", "cas-gateway-crc-api-egress")) &&
      crc.includes("10.217.4.1/32") &&
      crc.includes("192.168.126.11/32"),
    "CRC overlay renders CRC-specific Kubernetes API egress"
  );
  expect(
    "render:crc:lightspeed-ingress",
    Boolean(renderedDoc(crc, "NetworkPolicy", "cas-gateway-to-lightspeed-app-server")) && crc.includes("cywell.io/lab-scope: crc-dev"),
    "CRC overlay renders lab-scoped Lightspeed ingress prerequisite"
  );
  expect(
    "render:crc:lightspeed-tls-lab-override",
    envValue(crcGatewayDeployment, "CAS_LIGHTSPEED_TLS_INSECURE") === "true",
    "CRC overlay owns the lab-only Lightspeed TLS insecure override"
  );

  const shadowDeployment = renderedDoc(shadow, "Deployment", "cas-knowledge-engine");
  expect("render:pbs-shadow:knowledge-deployment", Boolean(shadowDeployment), "PBS shadow renders cas-knowledge-engine Deployment");
  expect(
    "render:pbs-shadow:provider",
    envValue(shadowDeployment, "CAS_KNOWLEDGE_PROVIDER") === "pbs-http-shadow",
    "PBS shadow render sets pbs-http-shadow provider"
  );
  expect(
    "render:pbs-shadow:no-provider-duplicate",
    envCount(shadowDeployment, "CAS_KNOWLEDGE_PROVIDER") === 1,
    "PBS shadow render has a single provider env"
  );
  expect(
    "render:pbs-shadow:database-url",
    envCount(shadowDeployment, "DATABASE_URL") === 1,
    "PBS shadow render keeps DATABASE_URL from base"
  );
  for (const [envName, key] of [
    ["CAS_PBS_BASE_URL", "base-url"],
    ["CAS_PBS_AUTH_MODE", "auth-mode"],
    ["CAS_PBS_TIMEOUT_MS", "timeout-ms"],
    ["CAS_PBS_MAX_RESPONSE_BYTES", "max-response-bytes"],
    ["CAS_PBS_TLS_INSECURE", "tls-insecure"]
  ]) {
    expect(
      `render:pbs-shadow:config:${envName}`,
      envFromConfig(shadowDeployment, envName, "cas-pbs-config", key),
      `${envName} comes from cas-pbs-config/${key}`
    );
  }
  expect(
    "render:pbs-shadow:optional-token-secret",
    envFromSecret(shadowDeployment, "CAS_PBS_BEARER_TOKEN", "cas-pbs-auth", "bearer-token"),
    "PBS shadow token is an optional Secret reference"
  );
  expect(
    "render:pbs-shadow:writes-disabled",
    envValue(shadowDeployment, "CAS_PBS_SHADOW_WRITES") === "false",
    "PBS shadow writes are disabled in rendered overlay"
  );
  expect("render:pbs-shadow:no-pbs-secret-material", noPbsSecretMaterial(shadow), "PBS shadow render contains no literal PBS token material");
  assertKnowledgeIngress("pbs-shadow", shadow);
  assertWorkloadIsolationPolicies("pbs-shadow", shadow);
  expect(
    "render:pbs-shadow:knowledge-egress-policy",
    knowledgeEgressScoped(renderedDoc(shadow, "NetworkPolicy", "cas-knowledge-engine-egress")),
    "PBS shadow inherits scoped knowledge-engine DNS/Postgres egress policy"
  );

  const shadowEgress = renderedDoc(shadow, "NetworkPolicy", "cas-knowledge-engine-pbs-egress");
  expect("render:pbs-shadow:egress-policy", Boolean(shadowEgress), "PBS shadow renders knowledge-engine PBS egress policy");
  expect(
    "render:pbs-shadow:egress-selector",
    shadowEgress.includes("app.kubernetes.io/component: knowledge-engine"),
    "PBS shadow egress selects only knowledge-engine pods"
  );
  expect(
    "render:pbs-shadow:egress-dns",
    shadowEgress.includes("kubernetes.io/metadata.name: openshift-dns") &&
      shadowEgress.includes("port: 53") &&
      shadowEgress.includes("port: 5353"),
    "PBS shadow egress allows OpenShift DNS"
  );
  expect(
    "render:pbs-shadow:egress-postgres",
    shadowEgress.includes("app.kubernetes.io/component: knowledge-postgres") && shadowEgress.includes("port: 5432"),
    "PBS shadow egress preserves Postgres access"
  );
  expect(
    "render:pbs-shadow:egress-pbs-runtime",
    pbsRuntimeEgressScoped(shadowEgress),
    "PBS shadow egress allows only labeled PBS runtime pods on 8765"
  );
  expect(
    "render:pbs-shadow:egress-no-broad",
    !/namespaceSelector:\s*\{\}|cidr:\s*0\.0\.0\.0\/0|port:\s*(80|443|6443)\b/.test(shadowEgress),
    "PBS shadow egress policy has no broad web/API egress"
  );

  const liveDeployment = renderedDoc(live, "Deployment", "cas-knowledge-engine");
  const liveGatewayDeployment = renderedDoc(live, "Deployment", "cas-gateway");
  expect("render:pbs-live:gateway-deployment", Boolean(liveGatewayDeployment), "PBS live renders cas-gateway Deployment");
  expect(
    "render:pbs-live:gateway-customer-acl-required",
    envValue(liveGatewayDeployment, "CAS_KNOWLEDGE_REQUIRE_CUSTOMER_ACCESS") === "true" &&
      envFromConfig(liveGatewayDeployment, "CAS_KNOWLEDGE_CUSTOMER_ACCESS_JSON", "cas-knowledge-live-config", "customer-access-json") &&
      live.includes("customer-access-json: '{}'") &&
      !live.includes("[\"*\"]"),
    "PBS live gateway requires customer workspace ACL and the tracked default overlay fails closed"
  );
  expect("render:pbs-live:knowledge-deployment", Boolean(liveDeployment), "PBS live renders cas-knowledge-engine Deployment");
  expect(
    "render:pbs-live:provider",
    envValue(liveDeployment, "CAS_KNOWLEDGE_PROVIDER") === "pbs-http-live",
    "PBS live render sets pbs-http-live provider"
  );
  expect(
    "render:pbs-live:no-provider-duplicate",
    envCount(liveDeployment, "CAS_KNOWLEDGE_PROVIDER") === 1,
    "PBS live render has a single provider env"
  );
  expect(
    "render:pbs-live:no-shadow-provider",
    !liveDeployment.includes("pbs-http-shadow"),
    "PBS live render does not retain shadow provider"
  );
  expect(
    "render:pbs-live:writes-disabled",
    !liveDeployment.includes('CAS_PBS_SHADOW_WRITES\n          value: "true"') &&
      envValue(liveDeployment, "CAS_PBS_SHADOW_WRITES") !== "true",
    "PBS live render does not enable shadow writes"
  );
  expect(
    "render:pbs-live:runtime-ready-required",
    envValue(liveDeployment, "CAS_PBS_REQUIRE_RUNTIME_READY") === "true",
    "PBS live render requires PBS DB/vector runtime readiness"
  );
  expect(
    "render:pbs-live:corpus-ready-required",
    envValue(liveDeployment, "CAS_PBS_REQUIRE_CORPUS_READY") === "true" &&
      envValue(liveDeployment, "CAS_PBS_REQUIRED_READY_SCOPES") === "official_docs,study_docs",
    "PBS live render requires PBS corpus/index readiness and required scopes"
  );
  expect(
    "render:pbs-live:required-token-secret",
    envFromRequiredSecret(liveDeployment, "CAS_PBS_BEARER_TOKEN", "cas-pbs-auth", "bearer-token"),
    "PBS live token is a required Secret reference"
  );
  expect(
    "render:pbs-live:owner-config",
    envFromConfig(liveDeployment, "CAS_KNOWLEDGE_SINGLE_OWNER", "cas-knowledge-live-config", "service-owner"),
    "PBS live owner comes from live ConfigMap instead of dev inline value"
  );
  expect(
    "render:pbs-live:database-url-secret",
    envFromRequiredSecret(liveDeployment, "DATABASE_URL", "cas-knowledge-postgres-live", "database-url"),
    "PBS live DATABASE_URL comes from required live Postgres Secret"
  );
  const livePostgres = renderedDoc(live, "StatefulSet", "cas-knowledge-postgres");
  expect(
    "render:pbs-live:postgres-live-secret",
    envFromRequiredSecret(livePostgres, "POSTGRES_DB", "cas-knowledge-postgres-live", "database") &&
      envFromRequiredSecret(livePostgres, "POSTGRES_USER", "cas-knowledge-postgres-live", "username") &&
      envFromRequiredSecret(livePostgres, "POSTGRES_PASSWORD", "cas-knowledge-postgres-live", "password"),
    "PBS live Postgres reads required DB credentials from live Secret"
  );
  expect(
    "render:pbs-live:no-dev-defaults",
    !/cas-crc-dev|cas_knowledge_dev|postgresql:\/\/cas_knowledge:cas_knowledge_dev/.test(live) &&
      !renderedDoc(live, "Secret", "cas-knowledge-postgres"),
    "PBS live render contains no CRC owner, dev DB password, or dev Postgres Secret"
  );
  expect(
    "render:pbs-live:no-dev-images",
    !/image:\s*\S+:dev\b/.test(live) &&
      live.includes("cas-gateway:v0.1.4") &&
      live.includes("cas-console-plugin:v0.1.4") &&
      live.includes("cas-knowledge-engine:v0.1.4") &&
      live.includes("cas-knowledge-postgres:v0.1.4"),
    "PBS live render uses v0.1.4 release image tags, not mutable dev tags"
  );
  expect(
    "render:pbs-live:postgres-release-image",
    /image:\s*image-registry\.openshift-image-registry\.svc:5000\/cywell-ai-sentinel\/cas-knowledge-postgres:v0\.1\.4/.test(livePostgres),
    "PBS live Postgres uses the internal v0.1.4 release image tag"
  );
  expect("render:pbs-live:no-pbs-secret-material", noPbsSecretMaterial(live), "PBS live render contains no literal PBS token material");
  assertKnowledgeIngress("pbs-live", live);
  assertWorkloadIsolationPolicies("pbs-live", live);
  expect(
    "render:pbs-live:knowledge-egress-policy",
    knowledgeEgressScoped(renderedDoc(live, "NetworkPolicy", "cas-knowledge-engine-egress")),
    "PBS live inherits scoped knowledge-engine DNS/Postgres egress policy"
  );

  const liveEgress = renderedDoc(live, "NetworkPolicy", "cas-knowledge-engine-pbs-egress");
  expect("render:pbs-live:egress-policy", Boolean(liveEgress), "PBS live inherits knowledge-engine PBS egress policy");
  expect(
    "render:pbs-live:egress-pbs-runtime-scoped",
    pbsRuntimeEgressScoped(liveEgress),
    "PBS live egress allows only labeled PBS runtime pods on 8765"
  );
  expect(
    "render:pbs-live:egress-no-broad",
    !/namespaceSelector:\s*\{\}|cidr:\s*0\.0\.0\.0\/0|port:\s*(80|443|6443)\b/.test(liveEgress),
    "PBS live egress policy has no broad web/API egress"
  );
}

runRenderedChecks();

for (const file of files) {
  try {
    const text = await readFile(file, "utf8");
    pass(`file:${file}`, "readable");
    if (file.includes("rbac")) {
      for (const forbidden of ["delete", "patch", "update", "pods/exec", "pods/portforward"]) {
        if (text.includes(forbidden)) fail(`rbac:forbidden:${forbidden}`, `${forbidden} must not appear in MVP RBAC`);
      }
      for (const required of ["get", "list", "watch", "selfsubjectreviews"]) {
        if (text.includes(required)) pass(`rbac:required:${required}`, `${required} present`);
        else fail(`rbac:required:${required}`, `${required} missing`);
      }
      expect(
        "rbac:selfsubjectreview-api-group",
        text.includes('apiGroups: ["authentication.k8s.io"]') && !text.includes("selfsubjectaccessreviews"),
        "Gateway owner verification RBAC matches authentication.k8s.io SelfSubjectReview",
        "Gateway owner verification RBAC must match authentication.k8s.io SelfSubjectReview"
      );
    }
    if (file.includes("cas_knowledge_engine/engine.py")) {
      expect(
        "knowledge-engine:upload-policy",
        text.includes("UPLOAD_ALLOWED_EXTENSIONS") &&
          text.includes("UPLOAD_BLOCKED_EXTENSIONS") &&
          text.includes("UPLOAD_ALLOWED_MIME_TYPES") &&
          text.includes("OFFICE_ZIP_MAX_ENTRY_BYTES") &&
          text.includes("validate_encoded_upload_size") &&
          text.includes("validate_upload_policy") &&
          text.includes("base64.b64decode(encoded, validate=True)"),
        "knowledge engine enforces upload extension, MIME, strict base64, and OOXML zip limits",
        "knowledge engine upload policy must reject unsafe extensions/MIME, invalid base64, and oversized OOXML zips"
      );
      expect(
        "knowledge-engine:url-ingest-ssrf-redirect-guard",
        text.includes("NoRedirectHandler") &&
          text.includes("validated_public_http_url") &&
          text.includes("URL credentials are not allowed") &&
          text.includes("URL redirects are blocked") &&
          text.includes("build_opener(NoRedirectHandler)"),
        "knowledge engine URL ingest blocks private targets, credentials, and redirects",
        "knowledge engine URL ingest must block private targets, credentials, and redirects"
      );
      expect(
        "knowledge-engine:pbs-topology-single-candidate",
        text.includes("def _pbs_graph_candidate") &&
          text.includes("candidate = self._pbs_graph_candidate(body)") &&
          !text.includes("raw_nodes = self._pbs_first_list(candidates"),
        "PBS live topology normalization uses one graph candidate for nodes and edges",
        "PBS live topology normalization must not mix wrapper and nested graph candidates"
      );
      expect(
        "knowledge-engine:pbs-live-response-scope",
          text.includes("def _pbs_scope_mismatches") &&
          text.includes("pbs-scope-mismatch") &&
          text.includes("customer_workspace_id") &&
          text.includes("workspace_id") &&
          text.includes("tenant_id") &&
          text.includes("scope_mismatches") &&
          text.includes("_pbs_scoped_body"),
        "PBS live response bodies are checked against requested customer/owner scope",
        "PBS live adapter must reject response bodies outside the requested customer/owner scope"
      );
      expect(
        "knowledge-engine:pbs-style-upload-reports",
        text.includes("def _upload_report_item") &&
          text.includes("graph_summary") &&
          text.includes("chunk_previews") &&
          text.includes("ready_for_chat") &&
          text.includes("basic_index_ready") &&
          text.includes('"items": items') &&
          text.includes('"graph": {') &&
          text.includes("viewer_path") &&
          text.includes("source_scope"),
        "local upload reports and Wiki Vault selected uploads expose PBS-style graph summary, graph alias, viewer paths, and chunk previews",
        "local upload reports and Wiki Vault must preserve PBS-style items, graph_summary, graph alias, viewer_path, source_scope, chunk_previews, and readiness fields"
      );
      expect(
        "knowledge-engine:rag-source-scope",
        text.includes("active_document_id") &&
          text.includes("enabled_upload_document_ids") &&
          text.includes("enabled_source_scopes") &&
          text.includes("restrict_uploaded_sources") &&
          text.includes("document_source_id") &&
          text.includes("viewer_path") &&
          text.includes("source_collection"),
        "local RAG honors selected upload/source scope and emits source lineage citations",
        "local RAG must preserve active document/source filters and citation lineage fields"
      );
      expect(
        "knowledge-engine:private-source-lane-policy",
        text.includes("PRIVATE_INGEST_SOURCE_SCOPE") &&
          text.includes("canonical_private_ingest_payload") &&
          text.includes("canonical_private_rag_payload") &&
          text.includes("source_scope=user_upload") &&
          text.includes("visibility=private_user") &&
          text.includes("PRIVATE_RAG_SOURCE_SCOPES") &&
          text.includes("PRIVATE_RAG_DEFAULT_SOURCE_SCOPES") &&
          text.includes("RESERVED_SOURCE_METADATA_KEYS") &&
          text.includes("private RAG source scopes are not allowed"),
        "knowledge engine rejects privileged PBS source lanes, defaults private RAG scopes, and strips reserved nested metadata",
        "knowledge engine must reject caller-controlled official/study source lanes, default private RAG scopes, and strip reserved nested metadata before private ingest, retrieval, or PBS outbound calls"
      );
      expect(
        "knowledge-engine:pbs-rag-scope-proof",
        text.includes("_pbs_missing_scope_proof") &&
          text.includes("_pbs_scope_proof_present") &&
          text.includes("scope_proof") &&
          text.includes("$.citations") &&
          text.includes("source_collection"),
        "knowledge engine rejects PBS live RAG citations without customer or owner scope proof",
        "knowledge engine must reject PBS live RAG citations without customer or owner scope proof"
      );
      expect(
        "knowledge-engine:wiki-loop-staged-contract",
        text.includes("run_id") &&
          text.includes('"wiki_compile"') &&
          text.includes('"topology_refresh"') &&
          text.includes("compiled_wiki_status") &&
          text.includes("last_run") &&
          text.includes("overlay_id") &&
          text.includes("book_slug") &&
          text.includes("note_type"),
        "local LLM Wiki loop and note save expose PBS-style staged run/status and overlay metadata",
        "local LLM Wiki must preserve PBS-style run_id, stages, compiled_wiki_status, last_run, overlay_id, book_slug, and note_type"
      );
    }
    if (file.includes("apps/gateway/src/server.mjs")) {
      expect(
        "gateway:customer-access-acl",
        text.includes("CAS_KNOWLEDGE_CUSTOMER_ACCESS_JSON") &&
          text.includes("CAS_KNOWLEDGE_REQUIRE_CUSTOMER_ACCESS") &&
          text.includes("validateCustomerAccessPolicy") &&
          text.includes("knowledge-customer-policy-invalid") &&
          text.includes("knowledge-customer-required") &&
          text.includes("system:authenticated") &&
          text.includes("customer access policy must not use default grants") &&
          text.includes("knowledge-customer-forbidden") &&
          text.includes("knowledge-customer-mismatch") &&
          text.includes("customerScopeKeys") &&
          text.includes("normalizedKnowledgeRequestBody") &&
          text.includes("scrubCustomerScopeAliases") &&
          text.includes("customerAccessAllowed"),
        "gateway enforces strict configured customer workspace ACL and strips nested scope aliases before proxying private knowledge requests",
        "gateway must enforce configured customer workspace ACL, reject invalid policies, require explicit customer_id, block broad principals, and prevent nested scope alias smuggling before proxying private knowledge requests"
      );
    }
    if (file.includes("cas_knowledge_engine/storage.py")) {
      expect(
        "knowledge-storage:pbs-compatible-schema",
        text.includes("PBS_COMPAT_TABLES") &&
          text.includes("document_sources") &&
          text.includes("parsed_documents") &&
          text.includes("document_chunks") &&
          text.includes("chunk_embeddings") &&
          text.includes("graph_entities") &&
          text.includes("graph_entity_mentions") &&
          text.includes("graph_entity_relations") &&
          text.includes("LOCAL_EMBEDDING_MODEL") &&
          text.includes("cas-local-hash-v1") &&
          text.includes("embedding_model") &&
          text.includes("embedding vector(768)") &&
          text.includes("_save_pbs_compat_rows") &&
          text.includes("cas://knowledge/") &&
          text.includes("local_embedding_literal") &&
          text.includes("INSERT INTO chunk_embeddings") &&
          text.includes("graph_signals") &&
          text.includes("customer_id") &&
          text.includes("idx_graph_entities_key_customer_scope") &&
          text.includes("INSERT INTO graph_entity_mentions") &&
          text.includes("INSERT INTO graph_entity_relations") &&
          text.includes("co_occurs") &&
          text.includes("mention_count"),
        "knowledge Postgres store creates PBS-compatible document, chunk, local embedding, and customer-scoped graph shadow rows"
      );
    }
    if (file.includes("cas_knowledge_engine/pbs_client.py")) {
      expect(
        "pbs-client:service-token-required",
        text.includes("CAS_PBS_BEARER_TOKEN is required for service-token auth") &&
          text.includes("service-token auth requires HTTPS or mTLS") &&
          text.includes("CAS_PBS_ALLOW_INSECURE_TOKEN_HTTP") &&
          text.includes("_local_http_url"),
        "PBS client fails closed when service-token auth lacks token or uses non-local HTTP",
        "PBS client must fail closed without service-token material and must not send tokens over non-local HTTP"
      );
    }
    if (file.includes("cas_knowledge_engine/selftest.py")) {
      expect(
        "knowledge-engine:selftest-upload-url-guards",
        text.includes("upload rejects executable extensions") &&
          text.includes("upload rejects invalid base64 payloads") &&
          text.includes("office upload rejects oversized compressed XML") &&
          text.includes("URL ingest rejects loopback targets before ingest"),
        "knowledge engine self-test covers unsafe upload and URL ingest rejection",
        "knowledge engine self-test must cover unsafe upload and URL ingest rejection"
      );
    }
    if (file.includes("base/20-networkpolicy")) {
      if (text.includes("policyTypes") && text.includes("Egress")) pass("networkpolicy:egress", "egress policy present");
      else fail("networkpolicy:egress", "egress policy missing");
      if (!/namespaceSelector:\s*\{\}|cidr:\s*0\.0\.0\.0\/0|ipBlock:\s*\{\}|podSelector:\s*\{\}/.test(text)) {
        pass("networkpolicy:no-broad-egress", "base NetworkPolicies do not contain broad namespace, pod, or internet egress");
      } else {
        fail("networkpolicy:no-broad-egress", "base NetworkPolicies must not contain broad namespace, pod, or internet egress");
      }
      if (text.includes("openshift-lightspeed") && text.includes("port: 8443")) {
        pass("networkpolicy:lightspeed-egress", "egress to OpenShift Lightspeed 8443 present");
      } else {
        fail("networkpolicy:lightspeed-egress", "egress to OpenShift Lightspeed 8443 missing");
      }
      if (text.includes("knowledge-engine") && text.includes("port: 8080")) {
        pass("networkpolicy:knowledge-engine-egress", "egress to CAS knowledge engine 8080 present");
      } else {
        fail("networkpolicy:knowledge-engine-egress", "egress to CAS knowledge engine 8080 missing");
      }
      if (
        text.includes("name: cas-knowledge-engine-egress") &&
        text.includes("app.kubernetes.io/component: knowledge-engine") &&
        text.includes("app.kubernetes.io/component: knowledge-postgres") &&
        text.includes("port: 5432")
      ) {
        pass("networkpolicy:knowledge-engine-base-egress", "knowledge-engine base egress is limited to DNS and Postgres");
      } else {
        fail("networkpolicy:knowledge-engine-base-egress", "knowledge-engine base egress DNS/Postgres policy missing");
      }
      const knowledgeIngress = renderedDoc(text, "NetworkPolicy", "cas-knowledge-engine-ingress");
      if (knowledgeIngressSelectsKnowledge(knowledgeIngress) && knowledgeIngressAllowsGatewayOnly(knowledgeIngress)) {
        pass("networkpolicy:knowledge-engine-ingress", "ingress to CAS knowledge engine is restricted to gateway pods");
      } else {
        fail("networkpolicy:knowledge-engine-ingress", "knowledge engine ingress restriction missing");
      }
      if (gatewayIngressScoped(renderedDoc(text, "NetworkPolicy", "cas-gateway-ingress"))) {
        pass("networkpolicy:gateway-ingress", "gateway ingress is restricted to OpenShift Console and console-plugin");
      } else {
        fail("networkpolicy:gateway-ingress", "gateway ingress restriction missing");
      }
      if (consolePluginIngressScoped(renderedDoc(text, "NetworkPolicy", "cas-console-plugin-ingress"))) {
        pass("networkpolicy:console-plugin-ingress", "console-plugin ingress is restricted to OpenShift Console");
      } else {
        fail("networkpolicy:console-plugin-ingress", "console-plugin ingress restriction missing");
      }
      if (consolePluginEgressScoped(renderedDoc(text, "NetworkPolicy", "cas-console-plugin-egress"))) {
        pass("networkpolicy:console-plugin-egress", "console-plugin egress is restricted to DNS and gateway");
      } else {
        fail("networkpolicy:console-plugin-egress", "console-plugin egress restriction missing");
      }
      if (text.includes("openshift-dns") && text.includes("protocol: UDP") && text.includes("port: 53") && text.includes("port: 5353")) {
        pass("networkpolicy:dns-egress", "egress to OpenShift DNS 53/5353 present");
      } else {
        fail("networkpolicy:dns-egress", "egress to OpenShift DNS 53/5353 missing");
      }
      if (!text.includes("10.217.4.1/32") && !text.includes("192.168.126.11/32")) {
        pass("networkpolicy:no-crc-api-egress-in-base", "base NetworkPolicies do not hard-code CRC Kubernetes API endpoint egress");
      } else {
        fail("networkpolicy:no-crc-api-egress-in-base", "base NetworkPolicies must not hard-code CRC Kubernetes API endpoint egress");
      }
    }
    if (file.includes("pbs-shadow/kustomization")) {
      if (text.includes("../../base") && text.includes("cas-pbs-config") && text.includes("disableNameSuffixHash: true")) {
        pass("pbs-shadow:kustomization", "PBS shadow overlay composes base with stable PBS config");
      } else {
        fail("pbs-shadow:kustomization", "PBS shadow overlay must compose base and stable config");
      }
      if (text.includes("playbookstudio-runtime.playbookstudio.svc.cluster.local:8765")) {
        pass("pbs-shadow:base-url-placeholder", "PBS shadow overlay has an explicit in-cluster PBS base URL placeholder");
      } else {
        fail("pbs-shadow:base-url-placeholder", "PBS shadow overlay PBS base URL placeholder missing");
      }
      if (text.includes("base-url=https://playbookstudio-runtime.playbookstudio.svc.cluster.local:8765")) {
        pass("pbs-shadow:service-token-https", "PBS shadow/live service-token transport defaults to HTTPS");
      } else {
        fail("pbs-shadow:service-token-https", "PBS shadow/live service-token transport must default to HTTPS");
      }
      if (/bearer-token|CAS_PBS_BEARER|secretKeyRef|Authorization:\s*Bearer/i.test(text)) {
        fail("pbs-shadow:no-token-literal", "PBS shadow kustomization must not contain token literals");
      } else {
        pass("pbs-shadow:no-token-literal", "PBS shadow kustomization contains no token literals");
      }
    }
    if (file.includes("knowledge-engine-pbs-shadow-patch")) {
      if (text.includes("CAS_KNOWLEDGE_PROVIDER") && text.includes("pbs-http-shadow")) {
        pass("pbs-shadow:provider", "PBS shadow overlay sets pbs-http-shadow provider");
      } else {
        fail("pbs-shadow:provider", "PBS shadow provider patch missing");
      }
      if (text.includes("CAS_PBS_BASE_URL") && text.includes("configMapKeyRef") && text.includes("cas-pbs-config")) {
        pass("pbs-shadow:base-url-config", "PBS shadow base URL comes from ConfigMap");
      } else {
        fail("pbs-shadow:base-url-config", "PBS shadow base URL ConfigMap ref missing");
      }
      if (text.includes("CAS_PBS_BEARER_TOKEN") && text.includes("secretKeyRef") && text.includes("optional: true")) {
        pass("pbs-shadow:optional-token-secret", "PBS shadow token comes from optional Secret");
      } else {
        fail("pbs-shadow:optional-token-secret", "PBS shadow optional Secret token ref missing");
      }
      if (text.includes("CAS_PBS_SHADOW_WRITES") && text.includes('value: "false"')) {
        pass("pbs-shadow:writes-disabled", "PBS shadow writes are disabled by default");
      } else {
        fail("pbs-shadow:writes-disabled", "PBS shadow writes must default false");
      }
      if (text.includes("CAS_PBS_TLS_INSECURE") && text.includes("CAS_PBS_MAX_RESPONSE_BYTES")) {
        pass("pbs-shadow:safety-env", "PBS shadow safety env is configured");
      } else {
        fail("pbs-shadow:safety-env", "PBS shadow safety env missing");
      }
      if (/value:\s*['"]?(?:[A-Za-z0-9+/_-]{24,}|eyJ)/.test(text)) {
        fail("pbs-shadow:no-secret-literal", "PBS shadow patch appears to contain a literal secret");
      } else {
        pass("pbs-shadow:no-secret-literal", "PBS shadow patch contains no literal secrets");
      }
    }
    if (file.includes("pbs-egress-networkpolicy")) {
      if (text.includes("cas-knowledge-engine-pbs-egress") && text.includes("component: knowledge-engine")) {
        pass("pbs-egress:selector", "PBS egress policy selects only knowledge engine");
      } else {
        fail("pbs-egress:selector", "PBS egress selector missing");
      }
      if (text.includes("openshift-dns") && text.includes("port: 53") && text.includes("port: 5353")) {
        pass("pbs-egress:dns", "PBS egress policy allows DNS");
      } else {
        fail("pbs-egress:dns", "PBS egress DNS allow rule missing");
      }
      if (text.includes("component: knowledge-postgres") && text.includes("port: 5432")) {
        pass("pbs-egress:postgres", "PBS egress policy preserves Postgres egress");
      } else {
        fail("pbs-egress:postgres", "PBS egress Postgres allow rule missing");
      }
      if (text.includes("kubernetes.io/metadata.name: playbookstudio") && text.includes("port: 8765")) {
        pass("pbs-egress:pbs-runtime", "PBS egress policy allows PBS runtime namespace on 8765");
      } else {
        fail("pbs-egress:pbs-runtime", "PBS egress PBS runtime allow rule missing");
      }
      if (text.includes("podSelector") && text.includes("app.kubernetes.io/name: playbookstudio") && text.includes("app.kubernetes.io/component: runtime")) {
        pass("pbs-egress:pbs-runtime-podselector", "PBS egress policy scopes runtime access by pod labels");
      } else {
        fail("pbs-egress:pbs-runtime-podselector", "PBS egress policy must scope runtime access by pod labels");
      }
    }
    if (file.includes("pbs-live/kustomization")) {
      if (
        text.includes("../pbs-shadow") &&
        text.includes("knowledge-engine-pbs-live-patch.yaml") &&
        text.includes("newTag: v0.1.4") &&
        text.includes("cas-knowledge-live-config") &&
        text.includes("customer-access-json") &&
        text.includes("customer-access-json={}") &&
        text.includes("gateway-customer-access-live-patch.yaml") &&
        text.includes("delete-dev-knowledge-env-patch.yaml") &&
        !text.includes("delete-dev-postgres-secret.yaml") &&
        text.includes("knowledge-postgres-live-secretrefs-patch.yaml")
      ) {
        pass("pbs-live:kustomization", "PBS live overlay builds on PBS shadow overlay with release images and live config");
      } else {
        fail("pbs-live:kustomization", "PBS live overlay must build on PBS shadow overlay without stale dev Secret delete patches");
      }
    }
    if (file.includes("gateway-customer-access-live-patch")) {
      if (
        text.includes("CAS_KNOWLEDGE_REQUIRE_CUSTOMER_ACCESS") &&
        text.includes('value: "true"') &&
        text.includes("CAS_KNOWLEDGE_CUSTOMER_ACCESS_JSON") &&
        text.includes("configMapKeyRef") &&
        text.includes("cas-knowledge-live-config") &&
        text.includes("customer-access-json") &&
        text.includes("optional: false")
      ) {
        pass("pbs-live:gateway-customer-acl", "PBS live gateway requires customer access policy ConfigMap");
      } else {
        fail("pbs-live:gateway-customer-acl", "PBS live gateway customer access policy env refs missing");
      }
    }
    if (file.includes("delete-dev-knowledge-env-patch")) {
      if (text.includes("CAS_KNOWLEDGE_SINGLE_OWNER") && text.includes("DATABASE_URL") && text.includes("$patch: delete")) {
        pass("pbs-live:delete-dev-knowledge-env", "PBS live deletes dev knowledge-engine owner and database env before re-adding live refs");
      } else {
        fail("pbs-live:delete-dev-knowledge-env", "PBS live must delete inherited dev knowledge-engine env");
      }
    }
    if (file.includes("knowledge-engine-pbs-live-patch")) {
      if (text.includes("CAS_KNOWLEDGE_PROVIDER") && text.includes("pbs-http-live")) {
        pass("pbs-live:provider", "PBS live overlay sets pbs-http-live provider");
      } else {
        fail("pbs-live:provider", "PBS live provider patch missing");
      }
      if (text.includes("CAS_PBS_REQUIRE_RUNTIME_READY") && text.includes('value: "true"')) {
        pass("pbs-live:runtime-ready-required", "PBS live overlay requires runtime readiness");
      } else {
        fail("pbs-live:runtime-ready-required", "PBS live overlay runtime readiness requirement missing");
      }
      if (
        text.includes("CAS_PBS_REQUIRE_CORPUS_READY") &&
        text.includes('value: "true"') &&
        text.includes("CAS_PBS_REQUIRED_READY_SCOPES") &&
        text.includes("official_docs,study_docs")
      ) {
        pass("pbs-live:corpus-ready-required", "PBS live overlay requires corpus/index readiness for required scopes");
      } else {
        fail("pbs-live:corpus-ready-required", "PBS live overlay corpus readiness requirement missing");
      }
      if (
        text.includes("CAS_PBS_BEARER_TOKEN") &&
        text.includes("secretKeyRef") &&
        text.includes("name: cas-pbs-auth") &&
        text.includes("key: bearer-token") &&
        text.includes("optional: false")
      ) {
        pass("pbs-live:required-token-secret", "PBS live token comes from required Secret");
      } else {
        fail("pbs-live:required-token-secret", "PBS live required Secret token ref missing");
      }
      if (
        text.includes("CAS_KNOWLEDGE_SINGLE_OWNER") &&
        text.includes("configMapKeyRef") &&
        text.includes("cas-knowledge-live-config") &&
        text.includes("service-owner") &&
        text.includes("DATABASE_URL") &&
        text.includes("cas-knowledge-postgres-live") &&
        text.includes("database-url")
      ) {
        pass("pbs-live:live-owner-db-refs", "PBS live owner and database URL come from live config/secret refs");
      } else {
        fail("pbs-live:live-owner-db-refs", "PBS live owner and database URL live refs missing");
      }
      if (/value:\s*['"]?(?:[A-Za-z0-9+/_-]{24,}|eyJ)/.test(text)) {
        fail("pbs-live:no-token-literal", "PBS live patch appears to contain a literal secret");
      } else {
        pass("pbs-live:no-token-literal", "PBS live patch contains no token literals");
      }
    }
    if (file.includes("knowledge-postgres-live-secretrefs-patch")) {
      if (
        text.includes("cas-knowledge-postgres-live") &&
        text.includes("key: database") &&
        text.includes("key: username") &&
        text.includes("key: password") &&
        text.includes("optional: false")
      ) {
        pass("pbs-live:postgres-live-secretrefs", "PBS live Postgres uses required live Secret refs");
      } else {
        fail("pbs-live:postgres-live-secretrefs", "PBS live Postgres live Secret refs missing");
      }
    }
    if (file.includes("overlays/crc/kustomization")) {
      if (!/pbs-shadow|pbs-live/i.test(text) && text.includes("gateway-crc-api-egress.yaml") && text.includes("21-lightspeed-ingress.yaml")) {
        pass("crc-overlay:no-pbs-overlays", "CRC overlay composes base/local deployment path plus CRC-only API and Lightspeed policies");
      } else {
        fail("crc-overlay:no-pbs-overlays", "CRC overlay must compose base/local deployment path with CRC-only policies and no PBS overlays");
      }
      if (text.includes("gateway-lightspeed-tls-insecure-patch.yaml")) {
        pass("crc-overlay:lightspeed-tls-override-owned", "CRC overlay explicitly owns lab-only Lightspeed TLS insecure override");
      } else {
        fail("crc-overlay:lightspeed-tls-override-owned", "CRC overlay must own any Lightspeed TLS insecure override explicitly");
      }
    }
    if (file.includes("gateway-lightspeed-tls-insecure-patch")) {
      if (text.includes("CAS_LIGHTSPEED_TLS_INSECURE") && text.includes('value: "true"')) {
        pass("crc-overlay:lightspeed-tls-insecure-patch", "CRC-only Lightspeed TLS insecure patch is explicit");
      } else {
        fail("crc-overlay:lightspeed-tls-insecure-patch", "CRC-only Lightspeed TLS insecure patch missing expected env override");
      }
    }
    if (file.includes("gateway-crc-api-egress")) {
      if (text.includes("cywell.io/lab-scope: crc-dev") && text.includes("10.217.4.1/32") && text.includes("192.168.126.11/32")) {
        pass("crc-overlay:gateway-api-egress", "CRC overlay owns CRC-specific Kubernetes API egress");
      } else {
        fail("crc-overlay:gateway-api-egress", "CRC-specific Kubernetes API egress policy missing expected lab scope and endpoint CIDRs");
      }
    }
    if (file.includes("deploy-crc-dev")) {
      if (text.includes("deploy/kustomize/base")) {
        pass("crc-deploy:uses-base", "CRC deploy script still applies the base manifests");
      } else {
        fail("crc-deploy:uses-base", "CRC deploy script must keep applying deploy/kustomize/base");
      }
      if (!/pbs-shadow|pbs-live/i.test(text)) {
        pass("crc-deploy:no-pbs-overlays", "CRC deploy script does not apply PBS shadow/live overlays");
      } else {
        fail("crc-deploy:no-pbs-overlays", "CRC deploy script must not apply PBS shadow/live overlays by default");
      }
      expect(
        "crc-deploy:namespace-before-buildconfigs",
        text.indexOf("deploy/kustomize/base/00-namespace.yaml") >= 0 &&
          text.indexOf("deploy/kustomize/base/00-namespace.yaml") < text.indexOf("deploy/kustomize/overlays/crc/buildconfigs.yaml"),
        "CRC deploy script creates the namespace before applying namespaced BuildConfigs"
      );
      expect(
        "crc-deploy:operator-pause-optional",
        text.includes("tryRun") && text.includes("No v0.1.3 OLM operator found"),
        "CRC deploy script does not require a pre-existing v0.1.3 operator on clean clusters"
      );
      expect(
        "crc-deploy:local-secret-generation",
        text.includes("cas-knowledge-postgres") &&
          text.includes("cas-knowledge-internal-auth") &&
          text.includes("randomBytes") &&
          text.includes("owner-hmac-secret"),
        "CRC deploy script creates local-only random Postgres and owner-HMAC Secrets when missing"
      );
      expect(
        "crc-deploy:no-python-bytecode-context",
        text.includes("__pycache__") && text.includes(".pyc"),
        "CRC deploy build context excludes generated Python bytecode"
      );
      expect(
        "crc-deploy:crc-only-policies",
        text.includes("deploy/kustomize/overlays/crc/21-lightspeed-ingress.yaml") &&
          text.includes("deploy/kustomize/overlays/crc/gateway-crc-api-egress.yaml"),
        "CRC deploy script applies CRC-only Lightspeed ingress and Kubernetes API egress policies outside base"
      );
      expect(
        "crc-deploy:source-annotations",
        text.includes("cywell.io/source-head") &&
          text.includes("cywell.io/source-tree-status") &&
          text.includes("CAS_ALLOW_DIRTY_CRC_DEPLOY") &&
          text.includes("annotateDeploymentSource") &&
          text.includes("git([\"rev-parse\", \"HEAD\"])"),
        "CRC deploy script stamps workload pod templates with current clean git source annotations",
        "CRC deploy script must stamp workload pod templates with git source annotations and refuse dirty tracked trees by default"
      );
    }
    if (file === "package.json") {
      if (
        text.includes('"verify:console:topology-dom"') &&
        text.includes("verify:console-plugin") &&
        text.includes('"verify:console:topology-dom:built"') &&
        text.includes("verify-console-topology-dom.mjs --require-browser")
      ) {
        pass("package:topology-dom-required", "package.json requires browser-backed topology DOM verification and builds ignored dist when invoked directly");
      } else {
        fail("package:topology-dom-required", "package.json must require browser-backed topology DOM verification with a direct-script build prerequisite");
      }
      if (
        text.includes('"verify:console:integration"') &&
        text.includes("verify:console-plugin") &&
        text.includes('"verify:console:integration:built"')
      ) {
        pass("package:console-integration-build-prereq", "package.json builds ignored dist before direct console integration verification");
      } else {
        fail("package:console-integration-build-prereq", "package.json must build ignored dist before direct console integration verification");
      }
      if (text.includes('"verify:pbs:preflight"') && text.includes("verify-pbs-preflight.mjs")) {
        pass("package:pbs-preflight-script", "package.json exposes verify:pbs:preflight");
      } else {
        fail("package:pbs-preflight-script", "package.json must expose verify:pbs:preflight");
      }
      if (
        text.includes('"render:pbs:live-prereqs"') &&
        text.includes("render-pbs-live-prereqs.mjs") &&
        text.includes('"verify:pbs:live-prereqs"') &&
        text.includes("--self-test") &&
        text.includes("verify:pbs:live-prereqs && npm run verify:pbs:cutover-bundle && npm run verify:pbs:source-contract")
      ) {
        pass("package:pbs-live-prereqs-renderer", "package.json exposes PBS live prerequisite renderer and includes its self-test in verify");
      } else {
        fail("package:pbs-live-prereqs-renderer", "package.json must expose render/verify scripts for PBS live prerequisites and include the self-test in verify");
      }
      if (text.includes('"verify:pbs:preflight:shadow"') && text.includes("--overlay=pbs-shadow")) {
        pass("package:pbs-preflight-shadow-script", "package.json exposes explicit PBS shadow preflight");
      } else {
        fail("package:pbs-preflight-shadow-script", "package.json must expose verify:pbs:preflight:shadow with --overlay=pbs-shadow");
      }
      if (text.includes('"verify:pbs:preflight:shadow:cluster"') && text.includes("--overlay=pbs-shadow --require-cluster")) {
        pass("package:pbs-preflight-shadow-cluster-script", "package.json exposes strict PBS shadow cluster preflight");
      } else {
        fail("package:pbs-preflight-shadow-cluster-script", "package.json must expose verify:pbs:preflight:shadow:cluster with --require-cluster");
      }
      if (text.includes('"verify:pbs:live"') && text.includes("verify-pbs-live-smoke.mjs")) {
        pass("package:pbs-live-script", "package.json exposes verify:pbs:live");
      } else {
        fail("package:pbs-live-script", "package.json must expose verify:pbs:live");
      }
      if (text.includes('"verify:pbs:preflight:live"') && text.includes("--require-cluster --require-secret")) {
        pass("package:pbs-preflight-live-script", "package.json exposes strict PBS live preflight");
      } else {
        fail("package:pbs-preflight-live-script", "package.json must expose strict PBS live preflight");
      }
      if (text.includes('"verify:pbs:preflight:live:preapply"') && text.includes("--skip-applied")) {
        pass("package:pbs-preflight-live-preapply-script", "package.json exposes pre-apply PBS live preflight without applied workload contract");
      } else {
        fail("package:pbs-preflight-live-preapply-script", "package.json must expose pre-apply PBS live preflight with --skip-applied");
      }
      if (text.includes('"verify:pbs:cutover"') && text.includes("--cutover")) {
        pass("package:pbs-cutover-script", "package.json exposes PBS cutover smoke");
      } else {
        fail("package:pbs-cutover-script", "package.json must expose PBS cutover smoke");
      }
      if (
        text.includes('"verify:pbs:cutover:cluster"') &&
        text.includes("verify:pbs:preflight:live:site") &&
        text.includes("--cutover --cluster")
      ) {
        pass("package:pbs-cutover-cluster-script", "package.json exposes in-cluster PBS cutover smoke");
      } else {
        fail("package:pbs-cutover-cluster-script", "package.json must run strict generated-site preflight before in-cluster PBS cutover smoke");
      }
      if (
        text.includes('"verify:release:pbs-live"') &&
        text.includes("verify:release:source-pinning") &&
        text.includes("verify:pbs:preflight:live:site:preapply") &&
        text.includes("render-pbs-cutover-bundle.mjs --require-live-ready") &&
        text.includes("verify:pbs:preflight:live:site") &&
        text.includes("--cutover --cluster")
      ) {
        pass("package:pbs-live-release-script", "package.json exposes non-skipping PBS live release gate with source pinning and live-ready bundle proof");
      } else {
        fail("package:pbs-live-release-script", "package.json must expose non-skipping PBS live release gate through source pinning, generated-site preapply, live-ready bundle proof, and cluster cutover smoke");
      }
      if (
        text.includes('"verify:release:source-pinning"') &&
        text.includes("--require-source") &&
        text.includes("--require-clean-source") &&
        text.includes("--require-expected-head")
      ) {
        pass("package:release-source-pinning-script", "package.json exposes strict PBS source pinning gate");
      } else {
        fail("package:release-source-pinning-script", "package.json must expose strict PBS source pinning gate");
      }
      if (
        text.includes('"verify:pbs:preflight:live:site:preapply"') &&
        text.includes("--overlay-path=test-results/pbs-live-prereqs/pbs-live-site") &&
        text.includes('"verify:pbs:preflight:live:site"')
      ) {
        pass("package:pbs-live-site-preflight-script", "package.json exposes strict PBS live preflight against generated site overlay");
      } else {
        fail("package:pbs-live-site-preflight-script", "package.json must expose strict PBS live preflight scripts for the generated site overlay");
      }
      if (text.includes('"release:crc:v0.1.4"') && text.includes("promote-crc-release-images.mjs")) {
        pass("package:release-crc-script", "package.json exposes CRC release image promotion");
      } else {
        fail("package:release-crc-script", "package.json must expose CRC release image promotion");
      }
      if (text.includes('"verify:pbs:source-contract"') && text.includes("verify-pbs-source-contract.mjs")) {
        pass("package:pbs-source-contract-script", "package.json exposes PBS source contract verification");
      } else {
        fail("package:pbs-source-contract-script", "package.json must expose PBS source contract verification");
      }
      if (
        text.includes('"render:pbs:cutover-bundle"') &&
        text.includes("render-pbs-cutover-bundle.mjs") &&
        text.includes('"verify:pbs:cutover-bundle"') &&
        text.includes("--self-test") &&
        text.includes("verify:pbs:cutover-bundle")
      ) {
        pass("package:pbs-cutover-bundle-script", "package.json exposes PBS cutover bundle renderer and self-test");
      } else {
        fail("package:pbs-cutover-bundle-script", "package.json must expose PBS cutover bundle renderer and self-test");
      }
    }
    if (file.includes("render-pbs-live-prereqs")) {
      expect(
        "pbs-live-prereqs:outputs",
        text.includes("cas-pbs-auth.secret.yaml") &&
          text.includes("cas-knowledge-internal-auth.secret.yaml") &&
          text.includes("cas-knowledge-postgres-live.secret.yaml") &&
          text.includes("cas-knowledge-live-config.configmap.yaml") &&
          text.includes("pbs-live-site") &&
          text.includes("behavior: replace"),
        "PBS live prerequisite renderer writes reviewed Secret manifests and a pbs-live site overlay with ConfigMap replacement",
        "PBS live prerequisite renderer must render cas-pbs-auth, cas-knowledge-internal-auth, cas-knowledge-postgres-live, cas-knowledge-live-config, and generated pbs-live-site manifests"
      );
      expect(
        "pbs-live-prereqs:validation-contract",
        text.includes("tokenLooksUsable") &&
          text.includes("hmacSecretLooksUsable") &&
          text.includes("customerAccessPolicyIsConcrete") &&
          text.includes("databaseUrlMatchesSecret") &&
          text.includes("containsWildcard") &&
          text.includes("broadPrincipal") &&
          text.includes("Object.hasOwn(policy ?? {}, \"default\")") &&
          text.includes("CAS_KNOWLEDGE_POSTGRES_DATABASE_URL must target cas-knowledge-postgres Service DNS"),
        "PBS live prerequisite renderer rejects weak tokens/HMAC material, wildcard/default/broad-principal ACLs, and mismatched Postgres URLs",
        "PBS live prerequisite renderer must validate token/HMAC shape, concrete customer ACL, broad principals, and matching service-scoped Postgres URL"
      );
      expect(
        "pbs-live-prereqs:redacted-evidence",
        text.includes("redactedSummary") &&
          text.includes("sha256(inputs.token)") &&
          text.includes("sha256(inputs.ownerHmacSecret)") &&
          text.includes("passwordSha256") &&
          text.includes("cas-pbs-live-prereqs-render.json") &&
          text.includes("fullHead") &&
          text.includes("treeStatus") &&
          text.includes("outputFileSha256") &&
          text.includes("renderedSiteOverlaySha256") &&
          text.includes("redactedSummarySha256") &&
          text.includes("real-render") &&
          text.includes("recordRenderEvidence") &&
          text.includes("cas-pbs-live-prereqs-self-test.json"),
        "PBS live prerequisite renderer records real-render redacted evidence with git/source and output hashes",
        "PBS live prerequisite renderer must write real-render redacted evidence with git source, output hashes, rendered overlay hash, and no raw Secret material while keeping self-test evidence separate"
      );
      expect(
        "pbs-live-prereqs:self-test",
        text.includes("--self-test") &&
          text.includes("site-overlay-render") &&
          text.includes("bad-owner-hmac-rejected") &&
          text.includes("wildcard-acl-rejected") &&
          text.includes("string-wildcard-acl-rejected") &&
          text.includes("broad-group-acl-rejected") &&
          text.includes("db-url-mismatch-rejected") &&
          text.includes("redacted-summary"),
        "PBS live prerequisite renderer has self-tests for rendering, redaction, ACL rejection, and DB URL mismatch",
        "PBS live prerequisite renderer must self-test render/redaction/ACL/DB URL validation"
      );
    }
    if (file.includes("verify-pbs-source-contract")) {
      expect(
        "pbs-source-contract:runtime-contract",
        text.includes("deploy/Dockerfile") &&
          text.includes("docker-compose.yml") &&
          text.includes("EXPOSE\\s+8765") &&
          text.includes("http://127.0.0.1:8765/api/health") &&
          text.includes("playbookstudio-runtime") &&
          text.includes("cluster:pbs-runtime-service-endpoints"),
        "PBS source contract verifier checks Dockerfile, compose, runtime port, health endpoint, and Cywell runtime service contract",
        "PBS source contract verifier must check real PBS source runtime port, health endpoint, and Cywell runtime service contract"
      );
      expect(
        "pbs-source-contract:api-surface",
        text.includes('/api/uploads/ingest') &&
          text.includes('/api/uploads/url-ingest') &&
          text.includes('/api/chat') &&
          text.includes('/api/wiki-vault') &&
          text.includes('/api/wiki-vault/notes') &&
          text.includes('/api/wiki-loop/run') &&
          text.includes('/api/wiki-loop/status') &&
          text.includes("owner_user_id") &&
          text.includes("selected_uploads"),
        "PBS source contract verifier checks upload, URL ingest, chat, Wiki Vault, Wiki loop, owner-scope, and topology signal API surface",
        "PBS source contract verifier must check the PBS API surface Cywell depends on"
      );
      expect(
        "pbs-source-contract:evidence",
        text.includes("cas-pbs-source-contract.json") &&
          text.includes("CAS_PBS_SOURCE_DIR") &&
          text.includes("CAS_PBS_SOURCE_HEAD") &&
          text.includes("CAS_PBS_REQUIRE_SOURCE_HEAD") &&
          text.includes("gitMetadata") &&
          text.includes("contractFileSha256") &&
          text.includes("--require-source") &&
          text.includes("--require-clean-source") &&
          text.includes("--require-expected-head") &&
          text.includes("--self-test"),
        "PBS source contract verifier writes pinned source evidence and supports explicit source/self-test modes",
        "PBS source contract verifier must write PBS source git/hash evidence and support explicit source/self-test modes"
      );
    }
    if (file.includes("render-pbs-cutover-bundle")) {
      expect(
        "pbs-cutover-bundle:artifacts",
        text.includes("cas-crc-deployment.json") &&
          text.includes("cas-release-images.json") &&
          text.includes("cas-deploy-manifests.json") &&
          text.includes("cas-pbs-live-prereqs-render.json") &&
          text.includes("cas-pbs-source-contract.json") &&
          text.includes("cas-pbs-preflight-pbs-live-site-preapply-cluster-required-secrets.json"),
        "PBS cutover bundle renderer collects CRC, release, manifest, prereq, source-contract, and live preapply evidence",
        "PBS cutover bundle renderer must collect the release evidence set needed for live cutover handoff"
      );
      expect(
        "pbs-cutover-bundle:blockers",
        text.includes("BLOCKED") &&
          text.includes("external-live-prerequisites-missing") &&
          text.includes("blockerAction") &&
          text.includes("pbs-namespace") &&
          text.includes("legacy-postgres-secret"),
        "PBS cutover bundle renderer turns live preapply failures into explicit external blocker actions",
        "PBS cutover bundle renderer must classify external live blockers instead of leaving operators to parse raw JSON"
      );
      expect(
        "pbs-cutover-bundle:current-evidence",
          text.includes("currentHeadMatches") &&
          text.includes("git-tree-clean") &&
          text.includes("sourceContractPinned") &&
          text.includes("hasRealRenderHashes") &&
          text.includes("isStrictGeneratedSitePreapply") &&
          text.includes("requiredLivePrereqOutputFileKeys") &&
          text.includes("expectedGeneratedSiteOverlayPath") &&
          text.includes("live-prereqs-real-render") &&
          text.includes("source-contract-pinned") &&
          text.includes("artifactSummary") &&
          text.includes("sha256File") &&
          text.includes("cas-pbs-cutover-bundle.json") &&
          text.includes("--require-live-ready"),
        "PBS cutover bundle renderer checks current-head evidence, clean source, strict PBS source pinning, real-render hashes, artifact hashes, and live-ready enforcement",
        "PBS cutover bundle renderer must bind bundle evidence to current source, reject dirty/unpinned PBS source evidence, reject self-test prereq evidence, and support strict live-ready mode"
      );
      expect(
        "pbs-cutover-bundle:self-test",
        text.includes("--self-test") &&
          text.includes("self-test-status") &&
          text.includes("self-test-blockers") &&
          text.includes("self-test-redaction") &&
          text.includes("self-test-artifact-hashes") &&
          text.includes("self-test-dirty-source-rejected") &&
          text.includes("self-test-prereq-self-test-rejected"),
        "PBS cutover bundle renderer self-tests blocker extraction, redaction, artifact hashing, dirty source rejection, and self-test evidence rejection",
        "PBS cutover bundle renderer must self-test blocker extraction, redaction, artifact hashing, dirty source rejection, and self-test evidence rejection"
      );
    }
    if (file.includes("promote-crc-release-images")) {
      expect(
        "release-crc:app-tags",
        text.includes("cas-gateway") &&
          text.includes("cas-console-plugin") &&
          text.includes("cas-knowledge-engine") &&
          text.includes("cas-knowledge-postgres") &&
          text.includes("v0.1.4") &&
          text.includes("reference-policy=local"),
        "CRC release promotion script tags app and Postgres images as local v0.1.4 ImageStreamTags"
      );
      expect(
        "release-crc:postgres-digest",
        text.includes("imageID") && text.includes("@sha256:") && text.includes("--source=docker"),
        "CRC release promotion script pins Postgres release tag from the running digest imageID"
      );
      expect(
        "release-crc:existing-tag-force-gate",
        text.includes("CAS_RELEASE_FORCE") &&
          text.includes("assertReleaseTargetMutable") &&
          text.includes("already resolves to a different image") &&
          text.includes("forceRelease"),
        "CRC release promotion refuses to mutate existing release tags unless force is explicit"
      );
      expect(
        "release-crc:verified-evidence-bound",
          text.includes("CAS_RELEASE_EVIDENCE") &&
          text.includes("cas-crc-deployment.json") &&
          text.includes("CAS_RELEASE_ALLOW_STALE_EVIDENCE") &&
          text.includes("CAS_RELEASE_EVIDENCE_MAX_AGE_HOURS") &&
          text.includes("currentGitFullHead") &&
          text.includes("currentClusterIdentity") &&
          text.includes("clusterIdentityMatches") &&
          text.includes("sourceEvidenceHead") &&
          text.includes("sourceEvidenceFullHead") &&
          text.includes("sourceEvidenceTreeStatus") &&
          text.includes("sourceClusterIdentity") &&
          text.includes("sourceEvidenceCheckedAt") &&
          text.includes("staleEvidenceAllowed") &&
          text.includes("verifiedImages") &&
          text.includes("assertSourceMatchesDeploymentEvidence") &&
          text.includes("current head is") &&
          text.includes("namespace") &&
          text.includes("missing verified digest evidence") &&
          text.includes("promotedImages") &&
          text.includes("normalizedExpected") &&
          text.includes("actualDigest === normalizedExpected") &&
          text.includes("differs from verified CRC deployment digest"),
        "CRC release promotion refuses stale evidence, dirty-source evidence, unverified app sources, or release evidence that is not tied to verified CRC deployment digests"
      );
    }
    if (file.includes("verify-crc-deployment")) {
      expect(
        "crc-deployment:verified-image-evidence",
        text.includes("verifiedImages") &&
          text.includes("appRuntimeImages") &&
          text.includes("runtime:verified-image:${imageStream}") &&
          text.includes("runtime:verified-image:cas-knowledge-postgres") &&
          text.includes("dockerImageReference") &&
          text.includes("imageID"),
        "CRC deployment verifier records digest evidence for app ImageStreamTags and running Postgres imageID"
      );
      expect(
        "crc-deployment:source-annotation-evidence",
        text.includes("runtime:source-annotation:${image.imageStream}") &&
          text.includes("sourceAnnotationsMatch") &&
          text.includes("cywell.io/source-head") &&
          text.includes("cywell.io/source-tree-status") &&
          text.includes("fullHead") &&
          text.includes("treeStatus") &&
          text.includes("clusterIdentity"),
        "CRC deployment verifier requires ready pods and Deployment templates to match current clean git source annotations and records cluster identity",
        "CRC deployment verifier must bind evidence to current clean git source annotations and cluster identity"
      );
    }
    if (file.includes("verify-pbs-live-smoke")) {
      if (text.includes("--cutover") && text.includes("CAS_PBS_LIVE_CUTOVER") && text.includes("write-smoke-required") && text.includes("pbs-live:cutover-auth")) {
        pass("pbs-live-smoke:cutover-mode", "PBS live smoke has a cutover mode that requires write smoke and PBS auth material");
      } else {
        fail("pbs-live-smoke:cutover-mode", "PBS live smoke must support cutover mode with required write smoke and PBS auth material");
      }
      expect(
        "pbs-live-smoke:no-readonly-release-bypass",
        text.includes("requestedReadOnlyException") &&
          text.includes("pbs-live:read-only-exception-forbidden") &&
          text.includes("cutover and cluster release smoke require write lineage"),
        "PBS live release smoke cannot bypass write lineage with read-only exception"
      );
      expect(
        "pbs-live-smoke:mode-specific-evidence",
        text.includes("evidenceMode") && text.includes("cas-pbs-live-smoke-${evidenceMode}.json"),
        "PBS live smoke writes mode-specific evidence artifacts"
      );
      if (text.includes("compiled_wiki_ready") && text.includes("cutover-topology-ready")) {
        pass("pbs-live-smoke:readiness-topology", "PBS live smoke checks compiled wiki and cutover topology readiness");
      } else {
        fail("pbs-live-smoke:readiness-topology", "PBS live smoke must check compiled wiki and cutover topology readiness");
      }
      if (
        text.includes("--cluster") &&
        text.includes("CAS_PBS_LIVE_CLUSTER_SMOKE") &&
        text.includes("cluster-gateway-health") &&
        text.includes("cluster-console-plugin-gateway-service") &&
        text.includes("cluster-write-lineage") &&
        text.includes("cluster-customer-acl-fail-closed") &&
        text.includes("exactLineageOk") &&
        text.includes("cluster-direct-engine-blocked") &&
        text.includes("typeof directBody?.blocked") &&
        text.includes("appliedPbsEgressScoped") &&
        text.includes("serviceHost(")
      ) {
        pass("pbs-live-smoke:cluster-cutover-mode", "PBS live smoke has in-cluster gateway, console-plugin-to-gateway, namespace-aware service, and applied policy checks");
      } else {
        fail("pbs-live-smoke:cluster-cutover-mode", "PBS live smoke must support in-cluster gateway, console-plugin-to-gateway, namespace-aware service, and applied policy checks");
      }
    }
    if (file.includes("verify-pbs-preflight")) {
      if (text.includes("cas-pbs-config") && text.includes("cas-pbs-auth") && text.includes("cas-knowledge-engine-pbs-egress")) {
        pass("pbs-preflight:overlay-contract", "PBS preflight checks config, secret, and egress policy");
      } else {
        fail("pbs-preflight:overlay-contract", "PBS preflight must check config, secret, and egress policy");
      }
      expect(
        "pbs-preflight:tls-insecure-disabled",
        text.includes("preflight:tls-insecure-disabled") && text.includes('configValue(configMap, "tls-insecure") === "false"'),
        "PBS preflight rejects tls-insecure=true regressions"
      );
      if (text.includes("playbookstudio-runtime") && text.includes("port 8765") && text.includes("cluster:pbs-runtime-service-endpoints-ready")) {
        pass("pbs-preflight:runtime-service-contract", "PBS preflight checks runtime service, endpoint readiness, and backend port");
      } else {
        fail("pbs-preflight:runtime-service-contract", "PBS preflight must check runtime service/backend port and ready endpoints");
      }
      if (
        text.includes("CAS_PBS_REQUIRE_RUNTIME_READY") &&
        text.includes("CAS_PBS_REQUIRE_CORPUS_READY") &&
        text.includes("cas-knowledge-postgres-live") &&
        text.includes("validOverlays") &&
        text.includes("overlayPathArg") &&
        text.includes("CAS_PBS_PREFLIGHT_OVERLAY_PATH") &&
        text.includes("currentClusterIdentity") &&
        text.includes("cluster:release-images-evidence-cluster-identity") &&
        text.includes("evidenceSuffix") &&
        text.includes("service-token-transport") &&
        text.includes("appliedPbsEgressScoped") &&
        text.includes("appliedKnowledgeIngressScoped") &&
        text.includes("appliedKnowledgeIngressUnionScoped") &&
        text.includes("cluster:applied-knowledge-ingress-union-scoped") &&
        text.includes("appliedKnowledgeEgressUnionScoped") &&
        text.includes("cluster:applied-knowledge-egress-union-scoped") &&
        text.includes("cluster:applied-gateway-networkpolicy-union-scoped") &&
        text.includes("cluster:applied-console-plugin-networkpolicy-union-scoped") &&
        text.includes("cluster:applied-postgres-networkpolicy-union-scoped") &&
        text.includes("liveDatabaseUrlUsesService") &&
        text.includes("liveDatabaseUrlMatchesSecret") &&
        text.includes("cluster:knowledge-postgres-live-secret-content") &&
        text.includes("cluster:pbs-auth-secret-content") &&
        text.includes("cluster:internal-owner-auth-secret-content") &&
        text.includes("ownerHmacSecretLooksUsable") &&
        text.includes("statefulSetReady") &&
        text.includes("readyPodsUsePromotedDigest") &&
        text.includes("cluster:applied-pbs-config-values") &&
        text.includes("cluster:applied-live-customer-acl") &&
        text.includes("preflight:live-customer-acl-concrete") &&
        text.includes('Object.hasOwn(policy, "default")') &&
        text.includes("system:authenticated") &&
        text.includes("!Array.isArray(customers)") &&
        text.includes("placeholder(clean)") &&
        text.includes("sourceEvidenceHead") &&
        text.includes("staleEvidenceAllowed") &&
        text.includes("non-stale-source") &&
        text.includes("image.dockerImageReference") &&
        text.includes("digestPinnedImageReference") &&
        text.includes("CAS_RELEASE_IMAGES_EVIDENCE") &&
        text.includes("loadReleaseImagesEvidence") &&
        text.includes("promotedImages") &&
        text.includes("cluster:release-image-evidence:") &&
        text.includes("must match promoted evidence digest") &&
        text.includes("must resolve to image.dockerImageReference with @sha256:") &&
        text.includes("cluster:pbs-runtime-ready-pods") &&
        text.includes("cluster:gateway-kubernetes-api-egress") &&
        text.includes("ipBlockMatches") &&
        text.includes("networkPolicyPortMatches") &&
        text.includes("cluster:release-image:") &&
        text.includes("preflight:live-postgres-image-pinned") &&
        text.includes("cluster:pbs-runtime-service-endpoints-ready") &&
        text.includes("updatedReplicas") &&
        text.includes("unavailableReplicas") &&
        text.includes("pinnedProductionImage") &&
        text.includes("skipApplied") &&
        text.includes("pbs-live")
      ) {
        pass("pbs-preflight:live-readiness-gate", "PBS preflight checks overlays, live runtime, corpus, Secret, release images, Postgres image pinning, applied policies, API egress, and PBS pod-label gates");
      } else {
        fail("pbs-preflight:live-readiness-gate", "PBS preflight must check overlays, live runtime, corpus, Secret, release images, Postgres image pinning, applied policies, API egress, and PBS pod-label gates");
      }
    }
    if (file.includes("21-lightspeed-ingress")) {
      if (text.includes("namespace: openshift-lightspeed") && text.includes("cywell-ai-sentinel") && text.includes("port: 8443")) {
        pass("lightspeed-ingress:cas-gateway", "Lightspeed app server allows CAS gateway ingress on 8443");
      } else {
        fail("lightspeed-ingress:cas-gateway", "CAS gateway ingress to Lightspeed app server missing");
      }
    }
    if (file.includes("30-gateway")) {
      if (text.includes("CAS_BRAIN_PROVIDER") && text.includes("openshift-lightspeed")) {
        pass("gateway:brain-provider", "gateway is configured for openshift-lightspeed brain");
      } else {
        fail("gateway:brain-provider", "gateway must configure openshift-lightspeed brain");
      }
      if (text.includes("CAS_LIGHTSPEED_URL") && text.includes("lightspeed-app-server.openshift-lightspeed")) {
        pass("gateway:lightspeed-url", "gateway points at in-cluster Lightspeed app server");
      } else {
        fail("gateway:lightspeed-url", "gateway Lightspeed URL missing");
      }
      if (text.includes("CAS_EVIDENCE_PROVIDER") && text.includes("openshift-api")) {
        pass("gateway:evidence-provider", "gateway is configured to collect OpenShift API evidence");
      } else {
        fail("gateway:evidence-provider", "gateway OpenShift evidence provider missing");
      }
      if (text.includes("CAS_KNOWLEDGE_OWNER_IDENTITY_MODE") && text.includes("openshift-selfsubjectreview")) {
        pass("gateway:owner-identity", "gateway verifies knowledge owner identity through OpenShift SelfSubjectReview");
      } else {
        fail("gateway:owner-identity", "gateway must verify knowledge owner identity through OpenShift SelfSubjectReview");
      }
      if (text.includes("CAS_OPENSHIFT_API_URL") && text.includes("https://kubernetes.default.svc")) {
        pass("gateway:openshift-api-url", "gateway points at in-cluster Kubernetes API");
      } else {
        fail("gateway:openshift-api-url", "gateway Kubernetes API URL missing");
      }
      if (
        text.includes("CAS_OPENSHIFT_API_CA_FILE") &&
        text.includes("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt") &&
        text.includes("CAS_OPENSHIFT_API_TLS_INSECURE") &&
        text.includes('value: "false"') &&
        text.includes("kube-root-ca.crt")
      ) {
        pass("gateway:openshift-api-tls", "gateway verifies Kubernetes API TLS with mounted namespace CA bundle");
      } else {
        fail("gateway:openshift-api-tls", "gateway must verify Kubernetes API TLS with mounted namespace CA bundle");
      }
      if (
        text.includes("CAS_LIGHTSPEED_CA_FILE") &&
        text.includes("/var/run/secrets/openshift/service-ca/service-ca.crt") &&
        text.includes("CAS_LIGHTSPEED_TLS_INSECURE") &&
        text.includes('value: "false"') &&
        text.includes("service.beta.openshift.io/inject-cabundle") &&
        text.includes("cas-openshift-service-ca")
      ) {
        pass("gateway:lightspeed-tls", "gateway verifies Lightspeed TLS with mounted OpenShift service CA bundle");
      } else {
        fail("gateway:lightspeed-tls", "gateway must verify Lightspeed TLS with mounted OpenShift service CA bundle");
      }
      if (text.includes("CAS_KNOWLEDGE_ENGINE_URL") && text.includes("cas-knowledge-engine.cywell-ai-sentinel.svc.cluster.local")) {
        pass("gateway:knowledge-engine-url", "gateway points at in-cluster CAS knowledge engine");
      } else {
        fail("gateway:knowledge-engine-url", "gateway CAS knowledge engine URL missing");
      }
      if (text.includes("CAS_MAX_REQUEST_BYTES") && text.includes("26214400")) {
        pass("gateway:max-request-bytes", "gateway request body limit is explicit");
      } else {
        fail("gateway:max-request-bytes", "gateway request body limit env missing");
      }
    }
    if (file.includes("35-knowledge-engine")) {
      if (text.includes("kind: PersistentVolumeClaim") && text.includes("cas-knowledge-engine-data")) {
        pass("knowledge-engine:pvc", "knowledge engine PVC present");
      } else {
        fail("knowledge-engine:pvc", "knowledge engine PVC missing");
      }
      if (text.includes("kind: Deployment") && text.includes("name: cas-knowledge-engine")) {
        pass("knowledge-engine:deployment", "knowledge engine deployment present");
      } else {
        fail("knowledge-engine:deployment", "knowledge engine deployment missing");
      }
      if (text.includes("kind: Service") && text.includes("port: 8080")) {
        pass("knowledge-engine:service", "knowledge engine service on 8080 present");
      } else {
        fail("knowledge-engine:service", "knowledge engine service missing");
      }
      if (text.includes("CAS_KNOWLEDGE_DATA_DIR") && text.includes("/var/lib/cas-knowledge")) {
        pass("knowledge-engine:data-dir", "knowledge engine persistent data dir configured");
      } else {
        fail("knowledge-engine:data-dir", "knowledge engine persistent data dir missing");
      }
      if (text.includes("DATABASE_URL") && text.includes("cas-knowledge-postgres")) {
        pass("knowledge-engine:database-url", "knowledge engine receives DATABASE_URL from Postgres secret");
      } else {
        fail("knowledge-engine:database-url", "knowledge engine DATABASE_URL missing");
      }
      if (text.includes("CAS_KNOWLEDGE_PROVIDER") && text.includes("pbs-compatible-local")) {
        pass("knowledge-engine:provider-env", "knowledge engine provider mode is explicit");
      } else {
        fail("knowledge-engine:provider-env", "knowledge engine provider env missing");
      }
      if (text.includes("CAS_KNOWLEDGE_MAX_REQUEST_BYTES") && text.includes("26214400")) {
        pass("knowledge-engine:max-request-bytes", "knowledge engine request body limit is explicit");
      } else {
        fail("knowledge-engine:max-request-bytes", "knowledge engine request body limit env missing");
      }
      if (text.includes("CAS_KNOWLEDGE_OWNER_MODE") && text.includes("CAS_KNOWLEDGE_SINGLE_OWNER")) {
        pass("knowledge-engine:owner-scope-env", "knowledge engine owner scope env is explicit");
      } else {
        fail("knowledge-engine:owner-scope-env", "knowledge engine owner scope env missing");
      }
      if (text.includes("CAS_KNOWLEDGE_REQUIRE_OWNER_HEADER") && text.includes('value: "true"')) {
        pass("knowledge-engine:owner-required-env", "knowledge engine requires trusted owner header");
      } else {
        fail("knowledge-engine:owner-required-env", "knowledge engine trusted owner header requirement missing");
      }
    }
    if (file.includes("36-knowledge-postgres")) {
      if (text.includes("kind: StatefulSet") && text.includes("name: cas-knowledge-postgres")) {
        pass("knowledge-postgres:statefulset", "knowledge Postgres StatefulSet present");
      } else {
        fail("knowledge-postgres:statefulset", "knowledge Postgres StatefulSet missing");
      }
      if (text.includes("pgvector/pgvector:pg16")) {
        pass("knowledge-postgres:pgvector-image", "knowledge Postgres uses pgvector image");
      } else {
        fail("knowledge-postgres:pgvector-image", "knowledge Postgres pgvector image missing");
      }
      if (
        !renderedDoc(text, "Secret", "cas-knowledge-postgres") &&
        text.includes("secretKeyRef") &&
        text.includes("name: cas-knowledge-postgres") &&
        text.includes("key: password") &&
        !/cas_knowledge_dev|postgresql:\/\/cas_knowledge:cas_knowledge_dev/.test(text)
      ) {
        pass("knowledge-postgres:external-dev-secret-ref", "knowledge Postgres expects an external CRC dev Secret and no literal DB password is tracked");
      } else {
        fail("knowledge-postgres:external-dev-secret-ref", "knowledge Postgres must reference external Secret keys without tracked dev credentials");
      }
      if (text.includes("system:openshift:scc:anyuid") && text.includes("cas-knowledge-db")) {
        pass("knowledge-postgres:anyuid", "knowledge Postgres anyuid SCC binding present for pgvector image");
      } else {
        fail("knowledge-postgres:anyuid", "knowledge Postgres anyuid SCC binding missing");
      }
      if (postgresIngressScoped(renderedDoc(text, "NetworkPolicy", "cas-knowledge-postgres-ingress"))) {
        pass("knowledge-postgres:ingress-policy", "knowledge Postgres ingress policy allows knowledge engine");
      } else {
        fail("knowledge-postgres:ingress-policy", "knowledge Postgres ingress policy missing");
      }
      if (postgresEgressDefaultDeny(renderedDoc(text, "NetworkPolicy", "cas-knowledge-postgres-egress"))) {
        pass("knowledge-postgres:egress-default-deny", "knowledge Postgres egress is explicit default deny");
      } else {
        fail("knowledge-postgres:egress-default-deny", "knowledge Postgres egress default-deny policy missing");
      }
    }
    if (file.includes("50-consoleplugin")) {
      if (text.includes("name: cywell-ai-sentinel")) pass("consoleplugin:name", "cywell-ai-sentinel name present");
      else fail("consoleplugin:name", "ConsolePlugin name must be cywell-ai-sentinel");
      if (text.includes("alias: cas-api")) pass("consoleplugin:proxy", "cas-api proxy alias present");
      else fail("consoleplugin:proxy", "ConsolePlugin proxy alias must be cas-api");
      if (text.includes("cywell-opslens") || text.includes("opslens-api")) {
        fail("consoleplugin:opslens-isolation", "CAS ConsolePlugin must not reference OpsLens names");
      } else {
        pass("consoleplugin:opslens-isolation", "no OpsLens names referenced");
      }
    }
    if (file.includes("console-extensions")) {
      if (text.includes("console.context-provider")) pass("console-extension:launcher", "CAS context-provider launcher present");
      else fail("console-extension:launcher", "CAS must register a global launcher context-provider");
      if (text.includes("useCASLauncher")) pass("console-extension:launcher-hook", "useCASLauncher codeRef present");
      else fail("console-extension:launcher-hook", "useCASLauncher codeRef missing");
      if (text.includes("console.navigation/section") && text.includes('"id": "cywell"')) {
        pass("console-extension:cywell-section", "Cywell navigation section present");
      } else {
        fail("console-extension:cywell-section", "Cywell navigation section missing");
      }
      for (const expectedRoute of ["/cywell/ai-sentinel", "/cywell/customer-data", "/cywell/rag", "/cywell/llm-wiki", "/cywell/topology"]) {
        if (text.includes(expectedRoute)) pass(`console-extension:route:${expectedRoute}`, `${expectedRoute} present`);
        else fail(`console-extension:route:${expectedRoute}`, `${expectedRoute} missing`);
      }
      if (text.includes("console.page/route") && text.includes("CywellKnowledgeRoute") && text.includes("AISentinelRoute")) {
        pass("console-extension:route-components", "Cywell route components present");
      } else {
        fail("console-extension:route-components", "Cywell route components missing");
      }
      if (text.includes("/opslens") || text.includes("cywell-opslens")) {
        fail("console-extension:opslens-isolation", "CAS extension must not reference OpsLens route or plugin id");
      } else {
        pass("console-extension:opslens-isolation", "no OpsLens route or plugin id referenced");
      }
    }
    if (file.includes("buildconfigs")) {
      for (const name of ["cas-gateway", "cas-console-plugin", "cas-knowledge-engine"]) {
        expect(
          `buildconfig:imagestream:${name}`,
          Boolean(renderedDoc(text, "ImageStream", name)),
          `ImageStream ${name} is declared for clean CRC binary builds`
        );
        expect(
          `buildconfig:buildconfig:${name}`,
          Boolean(renderedDoc(text, "BuildConfig", name)),
          `BuildConfig ${name} is declared for clean CRC binary builds`
        );
      }
      expect(
        "buildconfig:imagestream:cas-knowledge-postgres",
        Boolean(renderedDoc(text, "ImageStream", "cas-knowledge-postgres")),
        "ImageStream cas-knowledge-postgres is declared for CRC release-image promotion"
      );
      for (const expected of [
        "kind: ImageStream",
        "kind: BuildConfig",
        "name: cas-gateway",
        "name: cas-console-plugin",
        "name: cas-knowledge-engine",
        "name: cas-knowledge-postgres",
        "dockerfilePath: apps/gateway/Dockerfile",
        "dockerfilePath: apps/console-plugin/Dockerfile",
        "dockerfilePath: apps/knowledge-engine/Dockerfile"
      ]) {
        if (text.includes(expected)) pass(`buildconfig:${expected}`, `${expected} present`);
        else fail(`buildconfig:${expected}`, `${expected} missing`);
      }
    }
  } catch (error) {
    fail(`file:${file}`, error.message);
  }
}

const failures = checks.filter((check) => check.status === "FAIL");
const gitStatus = run("git", ["status", "--short"]);
mkdirSync("test-results", { recursive: true });
writeFileSync(
  "test-results/cas-deploy-manifests.json",
  JSON.stringify(
    {
      checkedAt,
      branch: run("git", ["branch", "--show-current"]),
      head: run("git", ["rev-parse", "--short", "HEAD"]),
      fullHead: run("git", ["rev-parse", "HEAD"]),
      treeStatus: gitStatus ? "dirty" : "clean",
      statusShort: gitStatus,
      status: failures.length > 0 ? "FAIL" : "PASS",
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
if (failures.length > 0) {
  console.error(`Deploy manifest verification failed with ${failures.length} failures.`);
  process.exitCode = 1;
} else {
  console.log(`Deploy manifest verification passed with ${checks.length} checks.`);
}
console.log("Evidence: test-results/cas-deploy-manifests.json");
