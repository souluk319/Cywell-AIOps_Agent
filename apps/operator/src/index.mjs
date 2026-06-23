import https from "node:https";
import { readFileSync } from "node:fs";

const namespace =
  process.env.POD_NAMESPACE ??
  readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/namespace", "utf8").trim();
const token = readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8").trim();
const ca = readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt");
const apiHost = process.env.KUBERNETES_SERVICE_HOST ?? "kubernetes.default.svc";
const apiPort = process.env.KUBERNETES_SERVICE_PORT ?? "443";
const apiBase = `https://${apiHost}:${apiPort}`;

const version = process.env.CAS_OPERATOR_VERSION ?? "0.1.3";
const defaultTargetNamespace = process.env.CAS_TARGET_NAMESPACE ?? namespace;
const defaultGatewayImage =
  process.env.CAS_GATEWAY_IMAGE ??
  "image-registry.openshift-image-registry.svc:5000/cywell-ai-sentinel/cas-gateway:v0.1.3-crc";
const defaultConsolePluginImage =
  process.env.CAS_CONSOLE_PLUGIN_IMAGE ??
  "image-registry.openshift-image-registry.svc:5000/cywell-ai-sentinel/cas-console-plugin:v0.1.3-crc";
const intervalMs = Number(process.env.CAS_RECONCILE_INTERVAL_MS ?? 15000);

function log(message, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), message, ...extra }));
}

function resourcePath(object, name = object.metadata?.name) {
  const ns = object.metadata?.namespace;
  switch (`${object.apiVersion}/${object.kind}`) {
    case "v1/Namespace":
      return { collection: "/api/v1/namespaces", item: `/api/v1/namespaces/${name}` };
    case "v1/ServiceAccount":
      return {
        collection: `/api/v1/namespaces/${ns}/serviceaccounts`,
        item: `/api/v1/namespaces/${ns}/serviceaccounts/${name}`
      };
    case "v1/Service":
      return {
        collection: `/api/v1/namespaces/${ns}/services`,
        item: `/api/v1/namespaces/${ns}/services/${name}`
      };
    case "apps/v1/Deployment":
      return {
        collection: `/apis/apps/v1/namespaces/${ns}/deployments`,
        item: `/apis/apps/v1/namespaces/${ns}/deployments/${name}`
      };
    case "rbac.authorization.k8s.io/v1/Role":
      return {
        collection: `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/roles`,
        item: `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/roles/${name}`
      };
    case "rbac.authorization.k8s.io/v1/RoleBinding":
      return {
        collection: `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings`,
        item: `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings/${name}`
      };
    case "rbac.authorization.k8s.io/v1/ClusterRole":
      return {
        collection: "/apis/rbac.authorization.k8s.io/v1/clusterroles",
        item: `/apis/rbac.authorization.k8s.io/v1/clusterroles/${name}`
      };
    case "rbac.authorization.k8s.io/v1/ClusterRoleBinding":
      return {
        collection: "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings",
        item: `/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/${name}`
      };
    case "networking.k8s.io/v1/NetworkPolicy":
      return {
        collection: `/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies`,
        item: `/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies/${name}`
      };
    case "console.openshift.io/v1/ConsolePlugin":
      return {
        collection: "/apis/console.openshift.io/v1/consoleplugins",
        item: `/apis/console.openshift.io/v1/consoleplugins/${name}`
      };
    default:
      throw new Error(`unsupported object ${object.apiVersion}/${object.kind}`);
  }
}

function request(method, path, body, contentType = "application/json") {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${apiBase}${path}`,
      {
        method,
        ca,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(payload ? { "content-type": contentType, "content-length": Buffer.byteLength(payload) } : {})
        }
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let parsed;
          try {
            parsed = raw ? JSON.parse(raw) : undefined;
          } catch {
            parsed = raw;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const error = new Error(`${method} ${path} failed: ${res.statusCode} ${raw}`);
            error.statusCode = res.statusCode;
            error.body = parsed;
            reject(error);
          }
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function get(path) {
  try {
    return await request("GET", path);
  } catch (error) {
    if (error.statusCode === 404) return undefined;
    throw error;
  }
}

function cleanForApply(object) {
  return JSON.parse(JSON.stringify(object));
}

async function applyObject(object) {
  const paths = resourcePath(object);
  const current = await get(paths.item);
  if (!current) {
    await request("POST", paths.collection, cleanForApply(object));
    return "created";
  }
  await request("PATCH", paths.item, cleanForApply(object), "application/merge-patch+json");
  return "patched";
}

function labels(component) {
  return {
    "app.kubernetes.io/name": "cywell-ai-sentinel",
    "app.kubernetes.io/component": component,
    "app.kubernetes.io/part-of": "cywell-ai-sentinel",
    "app.kubernetes.io/managed-by": "cywell-ai-sentinel-operator"
  };
}

function metadata(name, targetNamespace, component) {
  return {
    name,
    namespace: targetNamespace,
    labels: labels(component)
  };
}

function buildObjects({ targetNamespace, gatewayImage, consolePluginImage }) {
  return [
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: targetNamespace,
        labels: {
          "app.kubernetes.io/name": "cywell-ai-sentinel",
          "app.kubernetes.io/part-of": "cywell-ai-sentinel"
        }
      }
    },
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: metadata("cas-gateway", targetNamespace, "gateway"),
      automountServiceAccountToken: false
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: metadata("cas-readonly-evidence", targetNamespace, "gateway"),
      rules: [
        { apiGroups: [""], resources: ["pods", "pods/log", "events"], verbs: ["get", "list", "watch"] },
        { apiGroups: ["apps"], resources: ["deployments", "replicasets"], verbs: ["get", "list", "watch"] }
      ]
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRole",
      metadata: {
        name: "cas-self-access-review",
        labels: labels("gateway")
      },
      rules: [
        {
          apiGroups: ["authorization.k8s.io"],
          resources: ["selfsubjectaccessreviews"],
          verbs: ["create"]
        }
      ]
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: metadata("cas-readonly-evidence", targetNamespace, "gateway"),
      subjects: [{ kind: "ServiceAccount", name: "cas-gateway", namespace: targetNamespace }],
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "Role",
        name: "cas-readonly-evidence"
      }
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRoleBinding",
      metadata: {
        name: "cas-self-access-review",
        labels: labels("gateway")
      },
      subjects: [{ kind: "ServiceAccount", name: "cas-gateway", namespace: targetNamespace }],
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: "cas-self-access-review"
      }
    },
    gatewayNetworkPolicy(targetNamespace),
    lightspeedIngressPolicy(),
    gatewayDeployment(targetNamespace, gatewayImage),
    gatewayService(targetNamespace),
    consolePluginDeployment(targetNamespace, consolePluginImage),
    consolePluginService(targetNamespace),
    consolePlugin(targetNamespace)
  ];
}

function gatewayNetworkPolicy(targetNamespace) {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: metadata("cas-gateway-egress", targetNamespace, "gateway"),
    spec: {
      podSelector: {
        matchLabels: {
          "app.kubernetes.io/name": "cywell-ai-sentinel",
          "app.kubernetes.io/component": "gateway"
        }
      },
      policyTypes: ["Egress"],
      egress: [
        {
          to: [
            { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "openshift-dns" } } },
            { ipBlock: { cidr: "10.217.4.10/32" } }
          ],
          ports: [
            { protocol: "UDP", port: 53 },
            { protocol: "TCP", port: 53 },
            { protocol: "UDP", port: 5353 },
            { protocol: "TCP", port: 5353 }
          ]
        },
        {
          to: [{ namespaceSelector: {} }],
          ports: [
            { protocol: "TCP", port: 443 },
            { protocol: "TCP", port: 6443 }
          ]
        },
        { to: [{ ipBlock: { cidr: "10.217.4.1/32" } }], ports: [{ protocol: "TCP", port: 443 }] },
        { to: [{ ipBlock: { cidr: "192.168.126.11/32" } }], ports: [{ protocol: "TCP", port: 6443 }] },
        {
          to: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "openshift-lightspeed" } },
              podSelector: { matchLabels: { "app.kubernetes.io/name": "lightspeed-service-api" } }
            }
          ],
          ports: [{ protocol: "TCP", port: 8443 }]
        },
        {
          to: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "openshift-monitoring" } },
              podSelector: { matchLabels: { "app.kubernetes.io/name": "thanos-query" } }
            }
          ],
          ports: [{ protocol: "TCP", port: 9091 }]
        }
      ]
    }
  };
}

function lightspeedIngressPolicy() {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: "cas-gateway-to-lightspeed-app-server",
      namespace: "openshift-lightspeed",
      labels: {
        ...labels("gateway"),
        "cywell.io/lab-scope": "crc-dev"
      }
    },
    spec: {
      podSelector: {
        matchLabels: {
          "app.kubernetes.io/component": "application-server",
          "app.kubernetes.io/managed-by": "lightspeed-operator",
          "app.kubernetes.io/name": "lightspeed-service-api",
          "app.kubernetes.io/part-of": "openshift-lightspeed"
        }
      },
      policyTypes: ["Ingress"],
      ingress: [
        {
          from: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "cywell-ai-sentinel" } },
              podSelector: {
                matchLabels: {
                  "app.kubernetes.io/name": "cywell-ai-sentinel",
                  "app.kubernetes.io/component": "gateway"
                }
              }
            }
          ],
          ports: [{ protocol: "TCP", port: 8443 }]
        }
      ]
    }
  };
}

function gatewayDeployment(targetNamespace, image) {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: metadata("cas-gateway", targetNamespace, "gateway"),
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          "app.kubernetes.io/name": "cywell-ai-sentinel",
          "app.kubernetes.io/component": "gateway"
        }
      },
      template: {
        metadata: {
          labels: {
            "app.kubernetes.io/name": "cywell-ai-sentinel",
            "app.kubernetes.io/component": "gateway",
            "app.kubernetes.io/part-of": "cywell-ai-sentinel"
          }
        },
        spec: {
          serviceAccountName: "cas-gateway",
          automountServiceAccountToken: false,
          containers: [
            {
              name: "gateway",
              image,
              imagePullPolicy: "Always",
              env: [
                { name: "HOST", value: "0.0.0.0" },
                { name: "PORT", value: "9443" },
                { name: "CAS_TLS_CERT_FILE", value: "/var/run/secrets/cas/tls/tls.crt" },
                { name: "CAS_TLS_KEY_FILE", value: "/var/run/secrets/cas/tls/tls.key" },
                { name: "CAS_BRAIN_PROVIDER", value: "openshift-lightspeed" },
                {
                  name: "CAS_LIGHTSPEED_URL",
                  value: "https://lightspeed-app-server.openshift-lightspeed.svc.cluster.local:8443"
                },
                { name: "CAS_LIGHTSPEED_TIMEOUT_MS", value: "90000" },
                { name: "CAS_LIGHTSPEED_TLS_INSECURE", value: "true" },
                { name: "CAS_EVIDENCE_PROVIDER", value: "openshift-api" },
                { name: "CAS_OPENSHIFT_API_URL", value: "https://kubernetes.default.svc" },
                { name: "CAS_OPENSHIFT_API_TLS_INSECURE", value: "true" },
                { name: "CAS_EVIDENCE_TIMEOUT_MS", value: "8000" },
                { name: "CAS_RUNBOOK_PROVIDER", value: "jsonl" },
                {
                  name: "CAS_RUNBOOK_CORPUS_PATH",
                  value: "/opt/app-root/src/apps/gateway/runbooks/komsco-ops-sim.jsonl"
                },
                { name: "CAS_RUNBOOK_TOP_K", value: "5" },
                { name: "CAS_METRIC_PROVIDER", value: "thanos" },
                {
                  name: "CAS_THANOS_URL",
                  value: "https://thanos-querier.openshift-monitoring.svc.cluster.local:9091"
                },
                { name: "CAS_METRIC_TIMEOUT_MS", value: "8000" },
                { name: "CAS_METRIC_TLS_INSECURE", value: "true" }
              ],
              ports: [{ name: "https", containerPort: 9443 }],
              readinessProbe: {
                httpGet: { path: "/api/aiops/healthz", port: "https", scheme: "HTTPS" },
                initialDelaySeconds: 5,
                periodSeconds: 10
              },
              volumeMounts: [
                { name: "service-serving-cert", mountPath: "/var/run/secrets/cas/tls", readOnly: true }
              ]
            }
          ],
          volumes: [{ name: "service-serving-cert", secret: { secretName: "cas-gateway-tls" } }]
        }
      }
    }
  };
}

function gatewayService(targetNamespace) {
  return service("cas-gateway", targetNamespace, "gateway", "cas-gateway-tls");
}

function consolePluginService(targetNamespace) {
  return service("cas-console-plugin", targetNamespace, "console-plugin", "cas-console-plugin-tls");
}

function service(name, targetNamespace, component, tlsSecret) {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      ...metadata(name, targetNamespace, component),
      annotations: { "service.beta.openshift.io/serving-cert-secret-name": tlsSecret }
    },
    spec: {
      selector: {
        "app.kubernetes.io/name": "cywell-ai-sentinel",
        "app.kubernetes.io/component": component
      },
      ports: [{ name: "https", port: 9443, targetPort: "https" }]
    }
  };
}

function consolePluginDeployment(targetNamespace, image) {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: metadata("cas-console-plugin", targetNamespace, "console-plugin"),
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          "app.kubernetes.io/name": "cywell-ai-sentinel",
          "app.kubernetes.io/component": "console-plugin"
        }
      },
      template: {
        metadata: {
          labels: {
            "app.kubernetes.io/name": "cywell-ai-sentinel",
            "app.kubernetes.io/component": "console-plugin",
            "app.kubernetes.io/part-of": "cywell-ai-sentinel"
          }
        },
        spec: {
          automountServiceAccountToken: false,
          containers: [
            {
              name: "console-plugin",
              image,
              imagePullPolicy: "Always",
              env: [
                { name: "HOST", value: "0.0.0.0" },
                { name: "PORT", value: "9443" },
                { name: "CAS_GATEWAY_URL", value: "https://cas-gateway:9443" },
                { name: "CAS_CONSOLE_TLS_CERT_FILE", value: "/var/run/secrets/cas/tls/tls.crt" },
                { name: "CAS_CONSOLE_TLS_KEY_FILE", value: "/var/run/secrets/cas/tls/tls.key" }
              ],
              ports: [{ name: "https", containerPort: 9443 }],
              readinessProbe: {
                httpGet: { path: "/healthz", port: "https", scheme: "HTTPS" },
                initialDelaySeconds: 5,
                periodSeconds: 10
              },
              volumeMounts: [
                { name: "service-serving-cert", mountPath: "/var/run/secrets/cas/tls", readOnly: true }
              ]
            }
          ],
          volumes: [{ name: "service-serving-cert", secret: { secretName: "cas-console-plugin-tls" } }]
        }
      }
    }
  };
}

function consolePlugin(targetNamespace) {
  return {
    apiVersion: "console.openshift.io/v1",
    kind: "ConsolePlugin",
    metadata: {
      name: "cywell-ai-sentinel",
      labels: labels("console-plugin")
    },
    spec: {
      displayName: "AI Sentinel",
      backend: {
        type: "Service",
        service: {
          name: "cas-console-plugin",
          namespace: targetNamespace,
          port: 9443,
          basePath: "/"
        }
      },
      i18n: { loadType: "Preload" },
      proxy: [
        {
          alias: "cas-api",
          authorization: "UserToken",
          endpoint: {
            type: "Service",
            service: {
              name: "cas-gateway",
              namespace: targetNamespace,
              port: 9443
            }
          }
        }
      ]
    }
  };
}

async function patchConsoleOperator() {
  const current = await get("/apis/operator.openshift.io/v1/consoles/cluster");
  const existingPlugins = Array.isArray(current?.spec?.plugins) ? current.spec.plugins : [];
  const plugins = existingPlugins.filter((plugin) => plugin !== "lightspeed-console-plugin");
  for (const preservedPlugin of ["cywell-opslens"]) {
    if (existingPlugins.includes(preservedPlugin) && !plugins.includes(preservedPlugin)) {
      plugins.push(preservedPlugin);
    }
  }
  if (!plugins.includes("cywell-ai-sentinel")) plugins.push("cywell-ai-sentinel");

  const existingCapabilities = Array.isArray(current?.spec?.customization?.capabilities)
    ? current.spec.customization.capabilities
    : [];
  const capabilityByName = new Map(existingCapabilities.map((capability) => [capability.name, capability]));
  capabilityByName.set("LightspeedButton", {
    name: "LightspeedButton",
    visibility: { state: "Disabled" }
  });
  if (!capabilityByName.has("GettingStartedBanner")) {
    capabilityByName.set("GettingStartedBanner", {
      name: "GettingStartedBanner",
      visibility: { state: "Enabled" }
    });
  }

  await request(
    "PATCH",
    "/apis/operator.openshift.io/v1/consoles/cluster",
    {
      spec: {
        plugins,
        customization: {
          capabilities: [...capabilityByName.values()]
        }
      }
    },
    "application/merge-patch+json"
  );
}

async function listInstallations() {
  const path = `/apis/ai.cywell.co.kr/v1alpha1/namespaces/${namespace}/cywellaisentinels`;
  const list = await get(path);
  return list?.items ?? [];
}

async function updateStatus(cr, patch) {
  const name = cr.metadata.name;
  await request(
    "PATCH",
    `/apis/ai.cywell.co.kr/v1alpha1/namespaces/${namespace}/cywellaisentinels/${name}/status`,
    {
      status: {
        ...patch,
        observedGeneration: cr.metadata.generation,
        lastReconciledAt: new Date().toISOString()
      }
    },
    "application/merge-patch+json"
  );
}

async function reconcile(cr) {
  const targetNamespace = cr.spec?.targetNamespace ?? defaultTargetNamespace;
  const gatewayImage = cr.spec?.images?.gateway ?? defaultGatewayImage;
  const consolePluginImage = cr.spec?.images?.consolePlugin ?? defaultConsolePluginImage;

  const applied = [];
  for (const object of buildObjects({ targetNamespace, gatewayImage, consolePluginImage })) {
    const action = await applyObject(object);
    applied.push(`${object.kind}/${object.metadata.name}:${action}`);
  }
  await patchConsoleOperator();
  await updateStatus(cr, {
    phase: "Ready",
    version,
    targetNamespace,
    gatewayImage,
    consolePluginImage,
    applied
  });
  log("reconciled CywellAISentinel", { name: cr.metadata.name, targetNamespace, applied: applied.length });
}

async function loop() {
  try {
    const installations = await listInstallations();
    if (installations.length === 0) {
      log("no CywellAISentinel resources found", { namespace });
    }
    for (const cr of installations) {
      try {
        await reconcile(cr);
      } catch (error) {
        log("reconcile failed", { name: cr.metadata.name, error: error.message });
        await updateStatus(cr, { phase: "Error", reason: error.message }).catch(() => {});
      }
    }
  } catch (error) {
    log("operator loop failed", { error: error.message });
  }
}

log("Cywell AI Sentinel operator started", { namespace, version });
await loop();
setInterval(loop, intervalMs);
