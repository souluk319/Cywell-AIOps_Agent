#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { assertReadOnlyToolPlan } from "../packages/contracts/src/index.js";
import { buildLightspeedPayload, createLightspeedBackedRun } from "../apps/gateway/src/lightspeedBrain.mjs";
import { enrichInputWithSimulation, listSimulationScenarios } from "../apps/gateway/src/simulationLab.mjs";

const scenarioFile = "apps/gateway/simulations/komsco-ops-scenarios.json";
const corpusPath = "apps/gateway/runbooks/komsco-ops-sim.jsonl";
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

function truncate(value, maxLength = 220) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function podObject(scenario) {
  const { target, pod } = scenario;
  const state =
    pod.state === "waiting"
      ? { waiting: { reason: pod.waitingReason ?? "Waiting" } }
      : pod.state === "terminated"
        ? { terminated: { reason: pod.lastReason ?? "Error" } }
        : { running: { startedAt: "2026-06-22T00:00:00Z" } };
  return {
    metadata: {
      namespace: target.namespace,
      name: target.name,
      labels: {
        app: target.container
      }
    },
    spec: {
      nodeName: pod.nodeName || undefined,
      containers: [
        {
          name: target.container,
          image: `registry.internal/${target.namespace}/${target.container}:2026.06.22`
        }
      ]
    },
    status: {
      phase: pod.phase,
      containerStatuses: [
        {
          name: target.container,
          restartCount: pod.restartCount,
          state,
          lastState: pod.lastReason
            ? {
                terminated: {
                  reason: pod.lastReason,
                  exitCode: pod.lastReason === "OOMKilled" ? 137 : 1,
                  finishedAt: "2026-06-22T00:03:00Z"
                }
              }
            : {}
        }
      ]
    }
  };
}

function eventList(scenario) {
  return {
    items: scenario.events.map((event, index) => ({
      metadata: { name: `${scenario.target.name}.${index}` },
      ...event,
      involvedObject: {
        kind: "Pod",
        namespace: scenario.target.namespace,
        name: scenario.target.name
      }
    }))
  };
}

function openshiftTransportFor(scenario) {
  return async (url) => {
    const target = new URL(url);
    const path = `${target.pathname}${target.search}`;
    const namespace = encodeURIComponent(scenario.target.namespace);
    const podName = encodeURIComponent(scenario.target.name);

    if (path === `/api/v1/namespaces/${namespace}`) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          metadata: { name: scenario.target.namespace },
          status: { phase: "Active" }
        })
      };
    }

    if (path === `/api/v1/namespaces/${namespace}/pods/${podName}`) {
      return {
        statusCode: 200,
        body: JSON.stringify(podObject(scenario))
      };
    }

    if (path.startsWith(`/api/v1/namespaces/${namespace}/events?`)) {
      return {
        statusCode: 200,
        body: JSON.stringify(eventList(scenario))
      };
    }

    if (path.startsWith(`/api/v1/namespaces/${namespace}/pods/${podName}/log?`)) {
      if (!scenario.previousLog) {
        return {
          statusCode: 404,
          body: "previous container log unavailable"
        };
      }
      return {
        statusCode: 200,
        body: scenario.previousLog
      };
    }

    return {
      statusCode: 404,
      body: JSON.stringify({ message: `simulation path not found: ${path}` })
    };
  };
}

function metricResponse(value, scenario) {
  if (value === null || value === undefined || value === "") {
    return {
      statusCode: 200,
      body: JSON.stringify({
        status: "success",
        data: { resultType: "vector", result: [] }
      })
    };
  }
  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: {
        resultType: "vector",
        result: [
          {
            metric: {
              namespace: scenario.target.namespace,
              pod: scenario.target.name,
              container: scenario.target.container
            },
            value: [Date.now() / 1000, String(value)]
          }
        ]
      }
    })
  };
}

function metricTransportFor(scenario) {
  return async (url) => {
    const target = new URL(url);
    const query = target.searchParams.get("query") ?? "";
    if (query.includes("kube_pod_container_status_restarts_total")) {
      return metricResponse(scenario.metrics.pod_restart_increase, scenario);
    }
    if (query.includes("container_memory_working_set_bytes")) {
      return metricResponse(scenario.metrics.pod_memory_working_set, scenario);
    }
    if (query.includes("kube_pod_container_resource_limits")) {
      return metricResponse(scenario.metrics.pod_memory_limit, scenario);
    }
    return metricResponse(null, scenario);
  };
}

function sseAnswer(answer) {
  const chunks = answer.match(/.{1,36}/g) ?? [answer];
  const lines = ['data: {"event":"start","data":{"conversation_id":"conv-sim-001"}}', ""];
  for (const chunk of chunks) {
    lines.push(`data: ${JSON.stringify({ event: "token", data: { token: chunk } })}`, "");
  }
  lines.push('data: {"event":"end","data":{"referenced_documents":[],"truncated":false}}', "");
  return lines.join("\n");
}

function brainTransportFor(scenario) {
  return async (_url, options = {}) => {
    const payload = JSON.parse(options.body ?? "{}");
    const hasCustomerContext = String(payload.query ?? "").includes("KOMSCO Synthetic");
    const answer = [
      `${scenario.title}의 원인 후보는 수집된 OpenShift 이벤트, metric, KOMSCO synthetic runbook 근거를 기준으로 판단해야 합니다.`,
      hasCustomerContext
        ? "고객 지식 코퍼스가 프롬프트에 포함되어 서비스 특성, 운영 정책, 안전한 다음 확인 순서를 함께 반영했습니다."
        : "고객 지식 코퍼스가 프롬프트에 충분히 포함되지 않았습니다.",
      "안전한 다음 확인은 pod 상태, 이벤트, previous log, metric, runbook 근거를 재확인하고 변경 작업은 승인 절차로 분리하는 것입니다."
    ].join(" ");

    return {
      statusCode: 200,
      headers: { "content-type": "text/event-stream" },
      body: sseAnswer(answer)
    };
  };
}

function lower(value) {
  return String(value ?? "").toLowerCase();
}

async function runScenario(scenario) {
  console.log(`\n[SIM] ${scenario.id}: ${scenario.title}`);
  const input = {
    question: scenario.question,
    scope: {
      cluster: "crc-synthetic",
      namespaces: [scenario.target.namespace]
    },
    resourceRef: {
      kind: scenario.target.kind,
      name: scenario.target.name
    },
    mode: "read_only",
    locale: "ko-KR",
    simulation_id: scenario.id
  };

  const enriched = await enrichInputWithSimulation(input, {
    authorization: "Bearer synthetic-user-token",
    corpusPath
  });

  const payload = buildLightspeedPayload(enriched);
  const run = await createLightspeedBackedRun(enriched, {
    authorization: "Bearer synthetic-user-token",
    config: {
      provider: "openshift-lightspeed",
      lightspeedUrl: "https://lightspeed.example",
      timeoutMs: 1000,
      tlsInsecure: true
    },
    transport: brainTransportFor(scenario)
  });

  const evidence = enriched.cas_evidence?.evidence ?? [];
  const missing = enriched.cas_evidence?.missing ?? [];
  const runbookIds = evidence.filter((item) => item.type === "runbook").map((item) => item.id);
  const metricEvidence = evidence.filter((item) => item.type === "metric");
  const context = lower(enriched.cas_evidence_context);
  const payloadQuery = lower(payload.query);
  const guard = assertReadOnlyToolPlan(run.tool_plan);
  const expectedHitCount = scenario.expectedRunbookIds.filter((id) => runbookIds.includes(id)).length;
  const missingTerms = scenario.expectedTerms.filter((term) => {
    const normalizedTerm = lower(term);
    return !payloadQuery.includes(normalizedTerm) && !context.includes(normalizedTerm);
  });
  const learningSignals = [scenario.learning?.objective, ...(scenario.learning?.checkpoints ?? []).slice(0, 2)]
    .filter(Boolean)
    .map(lower);
  const missingLearningSignals = learningSignals.filter((term) => !payloadQuery.includes(term) && !context.includes(term));

  expect(`${scenario.id}:openshift-evidence`, evidence.some((item) => item.type === "pod") && evidence.some((item) => item.type === "event"), "pod and event evidence collected");
  expect(`${scenario.id}:simulation-learning-evidence`, evidence.some((item) => item.id === `simulation:learning:${scenario.id}`), "learning objective is attached as simulation evidence");
  expect(`${scenario.id}:metric-evidence`, metricEvidence.length >= 3, "pod restart, memory working set, and memory limit metrics collected or recorded as no-series");
  expect(`${scenario.id}:runbook-hit`, expectedHitCount >= 1, `customer-specific runbook hit found: ${runbookIds.join(", ")}`);
  expect(
    `${scenario.id}:runbook-excerpt`,
    missingTerms.length === 0,
    `customer terms present in brain prompt: ${scenario.expectedTerms.join(", ")}`,
    `missing customer terms in brain prompt: ${missingTerms.join(", ")}`
  );
  expect(
    `${scenario.id}:learning-context`,
    missingLearningSignals.length === 0,
    "learning objective and checkpoints are present in brain prompt",
    `missing learning signals in brain prompt: ${missingLearningSignals.join(", ")}`
  );
  expect(`${scenario.id}:brain-run`, run.mode === "lightspeed_read_only" && run.audit?.answer_provider === "openshift-lightspeed", "Lightspeed-backed CAS run created");
  expect(`${scenario.id}:guardrail`, guard.ok === true, "tool plan remains read-only");
  expect(
    `${scenario.id}:evidence-status`,
    run.evidence_bundle?.evidence_status?.some((item) => item.type === "metric" && item.status === "collected") &&
      run.evidence_bundle?.evidence_status?.some((item) => item.type === "runbook" && item.status === "collected"),
    "run output marks metric and runbook evidence collected"
  );

  console.log(
    `[SIM] ${scenario.id} evidence=${evidence.length} metric=${metricEvidence.length} runbook=${runbookIds.length} missing=${missing.length} answer="${truncate(run.rca_result?.answer, 140)}"`
  );
}

const scenarioDocument = JSON.parse(await readFile(scenarioFile, "utf8"));
expect("simulation:scenario-schema", scenarioDocument.schema === "cas_ops_simulation_v1", "scenario document schema is valid");
expect("simulation:scenario-count", scenarioDocument.scenarios?.length >= 8, "at least eight synthetic operations scenarios are available");
expect(
  "simulation:scenario-learning",
  scenarioDocument.scenarios?.every(
    (scenario) =>
      scenario.category &&
      scenario.learning?.objective &&
      scenario.learning?.cycle?.length >= 4 &&
      scenario.learning?.checkpoints?.length >= 3 &&
      scenario.learning?.followUps?.length >= 3
  ),
  "each scenario carries a learning objective, cycle, checkpoints, and follow-up questions"
);

const catalog = listSimulationScenarios();
expect("simulation:catalog-api", catalog.scenarios.length >= 8, "Gateway simulation catalog exposes scenarios");
expect("simulation:catalog-actions", catalog.scenarios.every((scenario) => scenario.remediations?.length >= 1), "each simulation scenario exposes at least one remediation action");
expect(
  "simulation:catalog-learning",
  catalog.scenarios.every((scenario) => scenario.category && scenario.learning?.objective && scenario.learning?.cycle?.length >= 4),
  "Gateway simulation catalog exposes learning metadata for the UI"
);
const resolved = await enrichInputWithSimulation(
  {
    simulation_id: "issuance-api-oom",
    simulation_action_id: "simulate-memory-baseline-review",
    question: "해결 시뮬레이션 후 상태 확인"
  },
  { authorization: "Bearer synthetic-user-token" }
);
expect("simulation:gateway-provider", resolved.cas_evidence?.evidence?.some((item) => item.id?.startsWith("simulation:action:")), "Gateway simulation provider creates action evidence");

for (const scenario of scenarioDocument.scenarios) {
  await runScenario(scenario);
}

const failures = checks.filter((check) => check.status === "FAIL");
if (failures.length > 0) {
  console.error(`KOMSCO operations simulation failed with ${failures.length} failures.`);
  process.exitCode = 1;
} else {
  console.log(`KOMSCO operations simulation passed with ${checks.length} checks.`);
}
