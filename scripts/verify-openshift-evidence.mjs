#!/usr/bin/env node
import {
  buildOpenShiftEvidenceContext,
  collectOpenShiftEvidence,
  enrichInputWithOpenShiftEvidence
} from "../apps/gateway/src/openshiftEvidence.mjs";

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

function expect(id, condition, passDetail, failDetail = passDetail) {
  if (condition) pass(id, passDetail);
  else fail(id, failDetail);
}

const config = {
  provider: "openshift-api",
  apiUrl: "https://openshift.example",
  timeoutMs: 1000,
  tlsInsecure: true,
  logTailLines: 12
};

const transport = async (url) => {
  const target = new URL(url);
  const path = `${target.pathname}${target.search}`;
  if (path === "/apis/config.openshift.io/v1/clusterversions/version") {
    return {
      statusCode: 200,
      body: JSON.stringify({
        status: {
          desired: { version: "4.20.5" },
          conditions: [
            { type: "Available", status: "True" },
            { type: "Progressing", status: "False" },
            { type: "Degraded", status: "False" }
          ]
        }
      })
    };
  }
  if (path === "/api/v1/namespaces/default") {
    return {
      statusCode: 200,
      body: JSON.stringify({
        metadata: { name: "default" },
        status: { phase: "Active" }
      })
    };
  }
  if (path === "/api/v1/namespaces/default/pods/api-7c8d9") {
    return {
      statusCode: 200,
      body: JSON.stringify({
        metadata: { name: "api-7c8d9" },
        spec: { nodeName: "crc-node", containers: [{ name: "api" }] },
        status: {
          phase: "Running",
          containerStatuses: [
            {
              name: "api",
              restartCount: 2,
              state: { running: {} },
              lastState: { terminated: { reason: "OOMKilled" } }
            }
          ]
        }
      })
    };
  }
  if (path.startsWith("/api/v1/namespaces/default/events?")) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        items: [
          {
            reason: "Killing",
            message: "Container api failed liveness probe",
            lastTimestamp: "2026-06-21T09:00:00Z"
          }
        ]
      })
    };
  }
  if (path.startsWith("/api/v1/namespaces/default/pods/api-7c8d9/log?")) {
    return {
      statusCode: 200,
      body: "FATAL heap allocation failed\nprocess exited"
    };
  }
  return {
    statusCode: 404,
    body: JSON.stringify({ message: `not found: ${path}` })
  };
};

const clusterVersion = await collectOpenShiftEvidence(
  {
    question: "ClusterVersion 상태 요약",
    resourceRef: { kind: "ClusterVersion", name: "version" },
    scope: { namespaces: ["default"] }
  },
  {
    authorization: "Bearer test-token",
    config,
    transport
  }
);

expect(
  "evidence:clusterversion",
  clusterVersion.evidence.some((item) => item.id === "openshift:clusterversion:version"),
  "ClusterVersion evidence is collected through OpenShift API"
);
expect(
  "evidence:clusterversion-summary",
  clusterVersion.evidence.some((item) => item.summary.includes("Available=True")),
  "ClusterVersion condition summary is captured"
);

const pod = await collectOpenShiftEvidence(
  {
    question: "default namespace의 api pod가 왜 재시작됐어?",
    resourceRef: { kind: "Pod", name: "api-7c8d9" },
    scope: { namespaces: ["default"] }
  },
  {
    authorization: "Bearer test-token",
    config,
    transport
  }
);

expect("evidence:namespace", pod.evidence.some((item) => item.id === "openshift:namespace:default"), "namespace evidence is collected");
expect("evidence:pod", pod.evidence.some((item) => item.id === "openshift:pod:default:api-7c8d9"), "pod evidence is collected");
expect("evidence:events", pod.evidence.some((item) => item.id === "openshift:events:default:api-7c8d9"), "pod event evidence is collected");
expect(
  "evidence:previous-log",
  pod.evidence.some((item) => item.id === "openshift:previous-log:default:api-7c8d9:api"),
  "previous pod log evidence is collected"
);

const context = buildOpenShiftEvidenceContext(pod);
expect("evidence:context", context.includes("Collected read-only OpenShift evidence"), "evidence context is generated for the brain prompt");

const missing = await collectOpenShiftEvidence(
  {
    resourceRef: { kind: "Pod", name: "api-7c8d9" },
    scope: { namespaces: ["default"] }
  },
  {
    config,
    transport
  }
);
expect(
  "evidence:missing-token",
  missing.missing.some((item) => item.type === "openshift_api" && item.reason.includes("missing user bearer token")),
  "missing UserToken is recorded as missing evidence"
);

const enriched = await enrichInputWithOpenShiftEvidence(
  {
    question: "ClusterVersion 상태 요약",
    resourceRef: { kind: "ClusterVersion", name: "version" }
  },
  {
    authorization: "Bearer test-token",
    config,
    transport
  }
);
expect("evidence:enriched-input", enriched.cas_evidence_context.includes("openshift:clusterversion:version"), "input is enriched with evidence context");

const failures = checks.filter((check) => check.status === "FAIL");
if (failures.length > 0) {
  console.error(`OpenShift evidence verification failed with ${failures.length} failures.`);
  process.exitCode = 1;
} else {
  console.log(`OpenShift evidence verification passed with ${checks.length} checks.`);
}
