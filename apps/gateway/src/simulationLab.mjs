import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { enrichInputWithOpenShiftEvidence } from "./openshiftEvidence.mjs";

const defaultScenarioPath = fileURLToPath(new URL("../simulations/komsco-ops-scenarios.json", import.meta.url));
const defaultCorpusPath = fileURLToPath(new URL("../runbooks/komsco-ops-sim.jsonl", import.meta.url));

let scenarioCache;

function nowSeconds() {
  return Date.now() / 1000;
}

function truncate(value, maxLength = 280) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function loadDocument(path = defaultScenarioPath) {
  if (scenarioCache?.path === path) return scenarioCache.document;
  const document = JSON.parse(readFileSync(path, "utf8"));
  scenarioCache = { path, document };
  return document;
}

export function listSimulationScenarios(options = {}) {
  const document = loadDocument(options.scenarioPath);
  return {
    schema: document.schema,
    description: document.description,
    scenarios: (document.scenarios ?? []).map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      summary: scenario.summary ?? scenario.question,
      risk: scenario.risk ?? "high",
      question: scenario.question,
      target: scenario.target,
      signals: {
        warnings: scenario.events?.filter((event) => event.type === "Warning").length ?? 0,
        restarts: Number(scenario.pod?.restartCount ?? 0),
        metric_series: Object.values(scenario.metrics ?? {}).filter((value) => value !== null && value !== undefined).length
      },
      remediations: scenario.remediations ?? []
    }))
  };
}

export function getSimulationScenario(id, options = {}) {
  const document = loadDocument(options.scenarioPath);
  return (document.scenarios ?? []).find((scenario) => scenario.id === id);
}

function scenarioRemediation(scenario, actionId) {
  if (!actionId) return undefined;
  return (scenario.remediations ?? []).find((action) => action.id === actionId);
}

function resolvedScenario(scenario, action) {
  if (!action) return scenario;
  const resolution = action.resolution ?? {};
  return {
    ...scenario,
    title: `${scenario.title} - simulated recovery`,
    question: action.question ?? scenario.question,
    pod: {
      ...(scenario.pod ?? {}),
      ...(resolution.pod ?? {})
    },
    events: resolution.events ?? [
      {
        type: "Normal",
        reason: "SimulationRecovered",
        message: `Simulated action ${action.label} applied. Active failure signal is cleared for training.`,
        lastTimestamp: new Date().toISOString()
      }
    ],
    previousLog: resolution.previousLog ?? scenario.previousLog,
    metrics: {
      ...(scenario.metrics ?? {}),
      ...(resolution.metrics ?? {})
    },
    simulationAction: action
  };
}

function podObject(scenario) {
  const { target, pod } = scenario;
  const state =
    pod?.state === "waiting"
      ? { waiting: { reason: pod.waitingReason ?? "Waiting" } }
      : pod?.state === "terminated"
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
      nodeName: pod?.nodeName || undefined,
      containers: [
        {
          name: target.container,
          image: `registry.internal/${target.namespace}/${target.container}:2026.06.22`
        }
      ]
    },
    status: {
      phase: pod?.phase ?? "Unknown",
      containerStatuses: [
        {
          name: target.container,
          restartCount: Number(pod?.restartCount ?? 0),
          state,
          lastState: pod?.lastReason
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
    items: (scenario.events ?? []).map((event, index) => ({
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

    if (path === `/api/v1/namespaces/${namespace}/pods?limit=50`) {
      return {
        statusCode: 200,
        body: JSON.stringify({ items: [podObject(scenario)] })
      };
    }

    if (path === `/api/v1/namespaces/${namespace}/events?limit=80` || path.startsWith(`/api/v1/namespaces/${namespace}/events?`)) {
      return {
        statusCode: 200,
        body: JSON.stringify(eventList(scenario))
      };
    }

    if (path.startsWith(`/api/v1/namespaces/${namespace}/pods/${podName}/log?`)) {
      if (!scenario.previousLog) {
        return {
          statusCode: 404,
          body: "previous container log unavailable in simulation"
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
            value: [nowSeconds(), String(value)]
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
      return metricResponse(scenario.metrics?.pod_restart_increase, scenario);
    }
    if (query.includes("container_memory_working_set_bytes")) {
      return metricResponse(scenario.metrics?.pod_memory_working_set, scenario);
    }
    if (query.includes("kube_pod_container_resource_limits")) {
      return metricResponse(scenario.metrics?.pod_memory_limit, scenario);
    }
    return metricResponse(null, scenario);
  };
}

function simulationEvidence(scenario, action) {
  const items = [
    {
      id: `simulation:scenario:${scenario.id}`,
      type: "simulation",
      summary: truncate(`${scenario.title}: ${scenario.summary ?? scenario.question}`),
      source: "cas.simulation.scenario",
      observed_at: new Date().toISOString()
    }
  ];
  if (action) {
    items.push({
      id: `simulation:action:${scenario.id}:${action.id}`,
      type: "simulation",
      summary: truncate(`Simulated operator action selected: ${action.label}. ${action.description ?? ""}`),
      source: "cas.simulation.action",
      observed_at: new Date().toISOString()
    });
  }
  return items;
}

export async function enrichInputWithSimulation(input = {}, options = {}) {
  const scenario = getSimulationScenario(input.simulation_id, options);
  if (!scenario) {
    throw new Error(`unknown simulation_id: ${input.simulation_id ?? "empty"}`);
  }
  const action = scenarioRemediation(scenario, input.simulation_action_id);
  const activeScenario = resolvedScenario(scenario, action);
  const target = activeScenario.target;
  const simulationQuestion =
    input.question ||
    action?.question ||
    activeScenario.question ||
    `Analyze ${target.namespace}/${target.kind}/${target.name} using CAS simulation evidence.`;
  const enriched = await enrichInputWithOpenShiftEvidence(
    {
      ...input,
      question: simulationQuestion,
      scope: {
        ...(input.scope ?? {}),
        cluster: input.scope?.cluster ?? "cas-simulation",
        namespaces: [target.namespace]
      },
      resourceRef: {
        kind: target.kind,
        name: target.name,
        namespace: target.namespace
      },
      simulation: {
        id: activeScenario.id,
        title: activeScenario.title,
        action_id: action?.id
      }
    },
    {
      authorization: options.authorization,
      config: {
        provider: "openshift-api",
        apiUrl: "https://openshift.example",
        timeoutMs: 1000,
        tlsInsecure: true,
        logTailLines: 80
      },
      metricConfig: {
        provider: "thanos",
        thanosUrl: "https://thanos.example",
        timeoutMs: 1000,
        tlsInsecure: true
      },
      runbookConfig: {
        provider: "jsonl",
        corpusPath: options.corpusPath ?? defaultCorpusPath,
        topK: 5
      },
      transport: openshiftTransportFor(activeScenario),
      metricTransport: metricTransportFor(activeScenario)
    }
  );

  enriched.cas_evidence.evidence = [...simulationEvidence(activeScenario, action), ...(enriched.cas_evidence.evidence ?? [])];
  enriched.cas_evidence_context = [
    "CAS Simulation Lab evidence:",
    `- scenario=${activeScenario.id} title=${activeScenario.title}`,
    action ? `- simulated_action=${action.id}: ${action.label}` : "- simulated_action=none",
    enriched.cas_evidence_context
  ]
    .filter(Boolean)
    .join("\n");
  return enriched;
}
