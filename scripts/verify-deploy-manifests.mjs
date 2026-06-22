#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const files = [
  "deploy/kustomize/base/00-namespace.yaml",
  "deploy/kustomize/base/10-rbac.yaml",
  "deploy/kustomize/base/20-networkpolicy.yaml",
  "deploy/kustomize/base/21-lightspeed-ingress.yaml",
  "deploy/kustomize/base/30-gateway.yaml",
  "deploy/kustomize/base/40-console-plugin-workload.yaml",
  "deploy/kustomize/base/50-consoleplugin.yaml",
  "deploy/kustomize/base/kustomization.yaml",
  "deploy/kustomize/overlays/crc/buildconfigs.yaml",
  "deploy/kustomize/overlays/crc/kustomization.yaml",
  "apps/console-plugin/console-extensions.json"
];

const checks = [];

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

for (const file of files) {
  try {
    const text = await readFile(file, "utf8");
    pass(`file:${file}`, "readable");
    if (file.includes("rbac")) {
      for (const forbidden of ["delete", "patch", "update", "pods/exec", "pods/portforward"]) {
        if (text.includes(forbidden)) fail(`rbac:forbidden:${forbidden}`, `${forbidden} must not appear in MVP RBAC`);
      }
      for (const required of ["get", "list", "watch", "selfsubjectaccessreviews"]) {
        if (text.includes(required)) pass(`rbac:required:${required}`, `${required} present`);
        else fail(`rbac:required:${required}`, `${required} missing`);
      }
    }
    if (file.includes("networkpolicy")) {
      if (text.includes("policyTypes") && text.includes("Egress")) pass("networkpolicy:egress", "egress policy present");
      else fail("networkpolicy:egress", "egress policy missing");
      if (text.includes("openshift-lightspeed") && text.includes("port: 8443")) {
        pass("networkpolicy:lightspeed-egress", "egress to OpenShift Lightspeed 8443 present");
      } else {
        fail("networkpolicy:lightspeed-egress", "egress to OpenShift Lightspeed 8443 missing");
      }
      if (text.includes("openshift-monitoring") && text.includes("thanos-query") && text.includes("port: 9091")) {
        pass("networkpolicy:thanos-egress", "egress to OpenShift Monitoring Thanos 9091 present");
      } else {
        fail("networkpolicy:thanos-egress", "egress to OpenShift Monitoring Thanos 9091 missing");
      }
      if (text.includes("openshift-dns") && text.includes("protocol: UDP") && text.includes("port: 53") && text.includes("port: 5353")) {
        pass("networkpolicy:dns-egress", "egress to OpenShift DNS 53/5353 present");
      } else {
        fail("networkpolicy:dns-egress", "egress to OpenShift DNS 53/5353 missing");
      }
      if (text.includes("10.217.4.1/32") && text.includes("192.168.126.11/32") && text.includes("port: 443") && text.includes("port: 6443")) {
        pass("networkpolicy:kube-api-egress", "egress to Kubernetes API service and endpoint present");
      } else {
        fail("networkpolicy:kube-api-egress", "egress to Kubernetes API service or endpoint missing");
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
      if (text.includes("CAS_OPENSHIFT_API_URL") && text.includes("https://kubernetes.default.svc")) {
        pass("gateway:openshift-api-url", "gateway points at in-cluster Kubernetes API");
      } else {
        fail("gateway:openshift-api-url", "gateway Kubernetes API URL missing");
      }
      if (text.includes("CAS_RUNBOOK_PROVIDER") && text.includes("jsonl") && text.includes("komsco-ocp-mini.jsonl")) {
        pass("gateway:runbook-jsonl", "gateway includes curated JSONL runbook adapter config");
      } else {
        fail("gateway:runbook-jsonl", "gateway curated JSONL runbook config missing");
      }
      if (text.includes("CAS_METRIC_PROVIDER") && text.includes("thanos") && text.includes("thanos-querier.openshift-monitoring")) {
        pass("gateway:metric-thanos", "gateway includes Thanos metric adapter config");
      } else {
        fail("gateway:metric-thanos", "gateway Thanos metric config missing");
      }
      if (text.includes("automountServiceAccountToken: false")) {
        pass("gateway:no-serviceaccount-token", "gateway keeps ServiceAccount token automount disabled");
      } else {
        fail("gateway:no-serviceaccount-token", "gateway must keep ServiceAccount token automount disabled");
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
      if (text.includes("console.navigation/href") || text.includes("console.page/route")) {
        fail("console-extension:no-fullscreen-entry", "CAS must not register nav or full-screen route entry points");
      } else {
        pass("console-extension:no-fullscreen-entry", "no nav or full-screen route entry points");
      }
      if (text.includes("/opslens") || text.includes("cywell-opslens")) {
        fail("console-extension:opslens-isolation", "CAS extension must not reference OpsLens route or plugin id");
      } else {
        pass("console-extension:opslens-isolation", "no OpsLens route or plugin id referenced");
      }
    }
    if (file.includes("buildconfigs")) {
      for (const expected of ["kind: BuildConfig", "name: cas-gateway", "name: cas-console-plugin", "dockerfilePath: apps/gateway/Dockerfile", "dockerfilePath: apps/console-plugin/Dockerfile"]) {
        if (text.includes(expected)) pass(`buildconfig:${expected}`, `${expected} present`);
        else fail(`buildconfig:${expected}`, `${expected} missing`);
      }
    }
  } catch (error) {
    fail(`file:${file}`, error.message);
  }
}

const failures = checks.filter((check) => check.status === "FAIL");
if (failures.length > 0) {
  console.error(`Deploy manifest verification failed with ${failures.length} failures.`);
  process.exitCode = 1;
} else {
  console.log(`Deploy manifest verification passed with ${checks.length} checks.`);
}
