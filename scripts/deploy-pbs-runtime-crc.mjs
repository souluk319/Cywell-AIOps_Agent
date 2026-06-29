#!/usr/bin/env node
import { randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const namespace = "playbookstudio";
const deploymentName = "app";
const pbsOneShotJobs = ["db-migrate", "official-corpus-seed", "kmsc-corpus-seed", "learning-seed", "course-runtime-seed"];
const postSccRestartDeployments = ["postgres"];
const finalRestartDeployments = ["app"];
const deploymentReadySelectors = {
  app: "app.kubernetes.io/name=playbookstudio,app.kubernetes.io/component=runtime",
  postgres: "app.kubernetes.io/name=postgres"
};
const approvedPbsSourceHead = "6604777abb9e6bd44a83c6a12f36e31ac396489e";
const repoPinnedSourceDir = resolve(process.cwd(), "..", "PBS-Dev3-cywell-v014-source-pin-clone");
const repoDefaultSourceDir = existsSync(repoPinnedSourceDir) ? repoPinnedSourceDir : resolve(process.cwd(), "..", "PBS-Dev3");
const pbsSourceDir = resolve(process.env.CAS_PBS_SOURCE_DIR || repoDefaultSourceDir);
const overlayPath = join(pbsSourceDir, "deploy", "openshift-cywell-v014");
const evidencePath = join("test-results", "cas-pbs-runtime-crc-deployment.json");
const pbsBuildContext = resolve("test-results/pbs-runtime-build-context");
const localPbsRuntimeImage = `image-registry.openshift-image-registry.svc:5000/${namespace}/playbookstudio-app:crc-v014`;
const useLocalPbsRuntimeBuild = String(process.env.CAS_PBS_RUNTIME_USE_LOCAL_BUILD ?? "true").toLowerCase() === "true";
const usePbsSourceOverlay = String(process.env.CAS_PBS_RUNTIME_USE_SOURCE_OVERLAY ?? "true").toLowerCase() !== "false";
const useLocalEmbeddingStub = String(process.env.CAS_PBS_RUNTIME_USE_LOCAL_EMBEDDING_STUB ?? "true").toLowerCase() !== "false";
const pbsSourceOverlayPvc = "pbs-source-overlay";
const pbsSourceLoaderPod = "pbs-source-loader";
const pbsSourceOverlayPatchId = "wiki-loop-crc-compat-20260630";
let pbsRuntimeImage = "ghcr.io/jungyuoo/ocpops-playbookstudio-app:dev";
const checks = [];
const startedAt = new Date().toISOString();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    input: options.input,
    stdio: options.stdio ?? "pipe",
    timeout: options.timeoutMs ?? 900000,
    windowsHide: true
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout?.trim() ?? "",
    stderr: (result.stderr ?? result.error?.message ?? "").trim()
  };
}

function git(args, cwd = pbsSourceDir) {
  return run("git", args, { cwd, timeoutMs: 30000 });
}

function record(status, id, detail, extra = {}) {
  checks.push({ status, id, detail, ...extra });
  console.log(`[${status}] ${id}: ${detail}`);
}

function pass(id, detail, extra = {}) {
  record("PASS", id, detail, extra);
}

function fail(id, detail, extra = {}) {
  record("FAIL", id, detail, extra);
}

function expect(id, condition, passDetail, failDetail = passDetail, extra = {}) {
  if (condition) pass(id, passDetail, extra);
  else fail(id, failDetail, extra);
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function imageDigest(value) {
  const match = String(value || "").match(/sha256:[a-f0-9]{64}/i);
  return match ? match[0].toLowerCase() : "";
}

function b64(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

function yamlSecret(name, data) {
  const encoded = Object.entries(data)
    .filter(([, value]) => String(value ?? "").trim())
    .map(([key, value]) => `  ${key}: ${b64(value)}`)
    .join("\n");
  return [
    "apiVersion: v1",
    "kind: Secret",
    "metadata:",
    `  name: ${name}`,
    `  namespace: ${namespace}`,
    "type: Opaque",
    "data:",
    encoded
  ].join("\n") + "\n";
}

function existingSecretValue(name, key) {
  const result = run("oc", ["get", "secret", name, "-n", namespace, "-o", `jsonpath={.data.${key}}`], { timeoutMs: 30000 });
  if (!result.ok || !result.stdout) return "";
  try {
    return Buffer.from(result.stdout, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function applyYaml(yaml, detail) {
  const result = run("oc", ["apply", "-f", "-"], { input: yaml, timeoutMs: 120000 });
  expect(detail.id, result.ok, detail.pass, result.stderr || result.stdout || detail.fail, {
    stdout: result.ok ? result.stdout : undefined
  });
  return result.ok;
}

function getJson(id, args) {
  const result = run("oc", [...args, "-o", "json"], { timeoutMs: 120000 });
  if (!result.ok) {
    fail(id, result.stderr || result.stdout || `oc ${args.join(" ")} failed`);
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(id, `could not parse JSON: ${error.message}`);
    return null;
  }
}

function parseJsonOutput(id, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(id, `could not parse JSON: ${error.message}`);
    return null;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function grantAnyuidScc(serviceAccount, reason) {
  const grant = run("oc", ["adm", "policy", "add-scc-to-user", "anyuid", "-z", serviceAccount, "-n", namespace], {
    timeoutMs: 120000
  });
  expect(
    `pbs-runtime-crc:anyuid-grant:${serviceAccount}`,
    grant.ok,
    `${serviceAccount} can use anyuid SCC for CRC PBS runtime (${reason})`,
    grant.stderr || grant.stdout || `failed to grant anyuid SCC to ${serviceAccount}`
  );

  const binding = getJson(`pbs-runtime-crc:anyuid-binding-read:${serviceAccount}`, ["get", "rolebinding", "system:openshift:scc:anyuid", "-n", namespace]);
  const subjects = binding?.subjects ?? [];
  expect(
    `pbs-runtime-crc:anyuid-binding:${serviceAccount}`,
    binding?.roleRef?.kind === "ClusterRole" &&
      binding?.roleRef?.name === "system:openshift:scc:anyuid" &&
      subjects.some((subject) => subject.kind === "ServiceAccount" && subject.name === serviceAccount && subject.namespace === namespace),
    `${serviceAccount} is bound to system:openshift:scc:anyuid`,
    `${serviceAccount} is missing from system:openshift:scc:anyuid RoleBinding`
  );
}

function copyPbsRuntimeBuildContext() {
  rmSync(pbsBuildContext, { recursive: true, force: true });
  mkdirSync(pbsBuildContext, { recursive: true });
  mkdirSync(join(pbsBuildContext, "apps"), { recursive: true });
  mkdirSync(join(pbsBuildContext, "deploy"), { recursive: true });
  for (const directory of ["apps/web", "corpus", "db", "deploy/scripts", "src"]) {
    cpSync(join(pbsSourceDir, directory), join(pbsBuildContext, directory), {
      recursive: true,
      filter: (source) => {
        const normalized = source.replace(/\\/g, "/");
        return (
          !normalized.includes("/__pycache__") &&
          !normalized.endsWith(".pyc") &&
          !normalized.includes("/.pytest_cache") &&
          !normalized.includes("/node_modules") &&
          !normalized.includes("/dist")
        );
      }
    });
  }
  for (const file of ["pyproject.toml", "README.md"]) {
    cpSync(join(pbsSourceDir, file), join(pbsBuildContext, file));
  }
  writeFileSync(
    join(pbsBuildContext, "deploy", "Dockerfile.crc-app"),
    [
      "FROM ghcr.io/jungyuoo/ocpops-playbookstudio-app:dev",
      "WORKDIR /app",
      "COPY pyproject.toml README.md /app/",
      "COPY src /app/src",
      "COPY db /app/db",
      "COPY corpus /app/corpus",
      "COPY deploy/scripts /app/scripts",
      "ENV PYTHONPATH=/app/src",
      `LABEL org.opencontainers.image.revision=${approvedPbsSourceHead}`,
      ""
    ].join("\n")
  );
  pass("pbs-runtime-crc:local-build-context", "prepared pinned PBS runtime source-overlay build context");
}

function ensurePbsRuntimeBuildConfig() {
  applyYaml(
    [
      "apiVersion: image.openshift.io/v1",
      "kind: ImageStream",
      "metadata:",
      "  name: playbookstudio-app",
      `  namespace: ${namespace}`,
      "  labels:",
      "    app.kubernetes.io/name: playbookstudio",
      "    app.kubernetes.io/component: runtime",
      "    cywell.ai/runtime-contract: pbs-v0.1.4",
      "---",
      "apiVersion: build.openshift.io/v1",
      "kind: BuildConfig",
      "metadata:",
      "  name: playbookstudio-app",
      `  namespace: ${namespace}`,
      "  labels:",
      "    app.kubernetes.io/name: playbookstudio",
      "    app.kubernetes.io/component: runtime",
      "    cywell.ai/runtime-contract: pbs-v0.1.4",
      "spec:",
      "  runPolicy: Serial",
      "  source:",
      "    type: Binary",
      "    binary: {}",
      "  strategy:",
      "    type: Docker",
      "    dockerStrategy:",
      "      dockerfilePath: deploy/Dockerfile.crc-app",
      "  output:",
      "    to:",
      "      kind: ImageStreamTag",
      "      name: playbookstudio-app:crc-v014"
    ].join("\n") + "\n",
    {
      id: "pbs-runtime-crc:local-buildconfig",
      pass: "local CRC PBS runtime ImageStream and BuildConfig applied",
      fail: "failed to apply local CRC PBS runtime BuildConfig"
    }
  );
}

function waitForBuildComplete(build) {
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    const phase = run("oc", ["get", "build", build, "-n", namespace, "-o", "jsonpath={.status.phase}"], { timeoutMs: 30000 });
    if (phase.ok && phase.stdout === "Complete") {
      pass("pbs-runtime-crc:local-build-complete", `local PBS runtime build ${build} completed`);
      return true;
    }
    if (phase.ok && ["Cancelled", "Error", "Failed"].includes(phase.stdout)) {
      const describe = run("oc", ["describe", "build", build, "-n", namespace], { timeoutMs: 120000 });
      fail("pbs-runtime-crc:local-build-complete", describe.stdout || describe.stderr || `OpenShift build ${build} finished with phase ${phase.stdout}`);
      return false;
    }
    sleep(3000);
  }
  const describe = run("oc", ["describe", "build", build, "-n", namespace], { timeoutMs: 120000 });
  fail("pbs-runtime-crc:local-build-complete", describe.stdout || describe.stderr || `Timed out waiting for OpenShift build ${build}`);
  return false;
}

function latestPbsRuntimeBuild() {
  const builds = getJson("pbs-runtime-crc:local-build-list", ["get", "build", "-n", namespace, "-l", "buildconfig=playbookstudio-app"]);
  const items = builds?.items ?? [];
  return items
    .sort((left, right) => String(left.metadata?.creationTimestamp ?? "").localeCompare(String(right.metadata?.creationTimestamp ?? "")))
    .at(-1);
}

function localPbsRuntimeImageSourceEvidence() {
  const result = run("oc", ["get", "imagestreamtag", "playbookstudio-app:crc-v014", "-n", namespace, "-o", "json"], {
    timeoutMs: 30000
  });
  if (!result.ok || !result.stdout) {
    return { exists: false, revision: "", digest: "", reference: "", readError: result.stderr || result.stdout || "" };
  }
  try {
    const tag = JSON.parse(result.stdout);
    const configLabels = tag?.image?.dockerImageMetadata?.Config?.Labels ?? {};
    const containerLabels = tag?.image?.dockerImageMetadata?.ContainerConfig?.Labels ?? {};
    const labels = { ...containerLabels, ...configLabels };
    const reference = String(tag?.image?.dockerImageReference ?? "");
    return {
      exists: true,
      revision: String(labels["org.opencontainers.image.revision"] ?? "").trim(),
      digest: imageDigest(reference || tag?.image?.metadata?.name),
      reference,
      labels
    };
  } catch (error) {
    return { exists: true, revision: "", digest: "", reference: "", readError: error.message };
  }
}

function localPbsRuntimeImageSourceBound(idPrefix) {
  const source = localPbsRuntimeImageSourceEvidence();
  expect(
    `${idPrefix}:source-revision`,
    source.exists === true && source.revision === approvedPbsSourceHead && Boolean(source.digest),
    `local CRC PBS runtime image is bound to approved source ${approvedPbsSourceHead}`,
    `local CRC PBS runtime image must carry org.opencontainers.image.revision=${approvedPbsSourceHead} and a digest reference: ${JSON.stringify(source)}`,
    { localPbsRuntimeImage: source }
  );
  return source.exists === true && source.revision === approvedPbsSourceHead && Boolean(source.digest);
}

function ensureLocalPbsRuntimeImage() {
  if (!useLocalPbsRuntimeBuild) {
    fail(
      "pbs-runtime-crc:local-build-required",
      "CAS_PBS_RUNTIME_USE_LOCAL_BUILD=false would replay PBS Jobs from the upstream image instead of the approved pinned PBS source"
    );
    return "ghcr.io/jungyuoo/ocpops-playbookstudio-app:dev";
  }
  const existing = localPbsRuntimeImageSourceEvidence();
  if (existing.exists && existing.revision === approvedPbsSourceHead && existing.digest) {
    pass(
      "pbs-runtime-crc:local-build-reuse",
      "reusing existing source-bound local CRC PBS runtime ImageStreamTag playbookstudio-app:crc-v014",
      { localPbsRuntimeImage: existing }
    );
    return localPbsRuntimeImage;
  }
  if (existing.exists) {
    pass(
      "pbs-runtime-crc:local-build-rebuild-stale",
      "existing local CRC PBS runtime ImageStreamTag is not source-bound to the approved SHA; rebuilding it",
      { localPbsRuntimeImage: existing }
    );
  }
  copyPbsRuntimeBuildContext();
  ensurePbsRuntimeBuildConfig();
  const latest = latestPbsRuntimeBuild();
  if (latest && ["New", "Pending", "Running"].includes(latest.status?.phase)) {
    const build = latest.metadata?.name;
    pass("pbs-runtime-crc:local-build-reuse-running", `waiting for existing local PBS runtime build ${build}`);
    waitForBuildComplete(build);
    localPbsRuntimeImageSourceBound("pbs-runtime-crc:local-build-existing");
    return localPbsRuntimeImage;
  }
  const started = run("oc", ["start-build", "playbookstudio-app", "-n", namespace, `--from-dir=${pbsBuildContext}`, "--wait=false", "-o", "name"], {
    timeoutMs: 1200000
  });
  if (!started.ok) {
    fail("pbs-runtime-crc:local-build-start", started.stderr || started.stdout || "failed to start local PBS runtime build");
    return localPbsRuntimeImage;
  }
  const buildRef = started.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("build.build.openshift.io/") || line.startsWith("build/"));
  const build = buildRef?.split("/").pop();
  expect("pbs-runtime-crc:local-build-start", Boolean(build), `started local PBS runtime build ${build}`, `could not determine local PBS runtime build name: ${started.stdout}`);
  if (build) waitForBuildComplete(build);
  localPbsRuntimeImageSourceBound("pbs-runtime-crc:local-build");
  return localPbsRuntimeImage;
}

function resetOneShotJobs(id, detail) {
  const reset = run("oc", ["delete", "job", "-n", namespace, ...pbsOneShotJobs, "--ignore-not-found=true", "--wait=false"], {
    timeoutMs: 120000
  });
  expect(id, reset.ok, detail, reset.stderr || reset.stdout || "failed to reset PBS one-shot Jobs");
  const pods = run(
    "oc",
    ["delete", "pod", "-n", namespace, "-l", "app.kubernetes.io/component=seed", "--ignore-not-found=true", "--force", "--grace-period=0"],
    { timeoutMs: 120000 }
  );
  expect(
    `${id}:pods`,
    pods.ok,
    `${detail}; stale seed pods force-deleted`,
    pods.stderr || pods.stdout || "failed to force-delete stale PBS seed pods"
  );
  return reset.ok;
}

function forceDeletePods(id, selector, detail) {
  const pods = run("oc", ["delete", "pod", "-n", namespace, "-l", selector, "--ignore-not-found=true", "--force", "--grace-period=0"], {
    timeoutMs: 120000
  });
  expect(id, pods.ok, detail, pods.stderr || pods.stdout || `failed to force-delete pods for selector ${selector}`);
  return pods.ok;
}

function renderedOverlayDocuments() {
  const rendered = run("oc", ["kustomize", overlayPath], { timeoutMs: 120000 });
  if (!rendered.ok) {
    fail("pbs-runtime-crc:overlay-render", rendered.stderr || rendered.stdout || "failed to render PBS runtime overlay");
    return [];
  }
  pass("pbs-runtime-crc:overlay-render", "PBS runtime overlay rendered for ordered Job replay");
  return rendered.stdout
    .split(/\n---\s*\n/g)
    .map((doc) => doc.trim())
    .filter(Boolean);
}

function renderedJobYaml(documents, jobName) {
  const escaped = jobName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return documents.find(
    (doc) =>
      /^kind:\s*Job\s*$/m.test(doc) &&
      new RegExp(`^  name:\\s*${escaped}\\s*$`, "m").test(doc) &&
      new RegExp(`^  namespace:\\s*${namespace}\\s*$`, "m").test(doc)
  );
}

function waitForJob(jobName, documents) {
  const jobYaml = renderedJobYaml(documents, jobName);
  if (!jobYaml) {
    fail(`pbs-runtime-crc:job-render:${jobName}`, `${jobName} was not rendered in the PBS runtime overlay`);
    return;
  }
  pass(`pbs-runtime-crc:job-render:${jobName}`, `${jobName} rendered with playbookstudio namespace`);

  const deleted = run("oc", ["delete", "job", jobName, "-n", namespace, "--ignore-not-found=true", "--wait=false"], {
    timeoutMs: 120000
  });
  expect(
    `pbs-runtime-crc:job-reset:${jobName}`,
    deleted.ok,
    `${jobName} reset before ordered replay`,
    deleted.stderr || deleted.stdout || `${jobName} reset failed`
  );
  const deletedPods = run("oc", ["delete", "pod", "-n", namespace, "-l", `job-name=${jobName}`, "--ignore-not-found=true", "--force", "--grace-period=0"], {
    timeoutMs: 120000
  });
  expect(
    `pbs-runtime-crc:job-pods-reset:${jobName}`,
    deletedPods.ok,
    `${jobName} stale pods force-deleted before ordered replay`,
    deletedPods.stderr || deletedPods.stdout || `${jobName} stale pod cleanup failed`
  );

  const applied = applyYaml(jobYaml.replaceAll("ghcr.io/jungyuoo/ocpops-playbookstudio-app:dev", pbsRuntimeImage) + "\n", {
    id: `pbs-runtime-crc:job-apply:${jobName}`,
    pass: `${jobName} applied for ordered replay`,
    fail: `${jobName} apply failed`
  });
  if (!applied) return;

  const complete = run("oc", ["wait", "--for=condition=complete", `job/${jobName}`, "-n", namespace, "--timeout=1800s"], {
    timeoutMs: 1830000
  });
  if (!complete.ok) {
    const logs = run("oc", ["logs", `job/${jobName}`, "-n", namespace, "--tail=120"], { timeoutMs: 120000 });
    expect(
      `pbs-runtime-crc:job-complete:${jobName}`,
      false,
      `${jobName} completed`,
      [complete.stderr || complete.stdout || `${jobName} did not complete`, logs.stdout || logs.stderr].filter(Boolean).join("\n")
    );
    return;
  }
  pass(`pbs-runtime-crc:job-complete:${jobName}`, `${jobName} completed`);

  const podList = getJson(`pbs-runtime-crc:job-pod:${jobName}`, ["get", "pod", "-n", namespace, "-l", `job-name=${jobName}`]);
  const pod = podList?.items?.find((item) => item.status?.phase === "Succeeded") ?? podList?.items?.[0];
  const scc = pod?.metadata?.annotations?.["openshift.io/scc"] ?? "";
  expect(
    `pbs-runtime-crc:job-scc:${jobName}`,
    scc === "anyuid",
    `${jobName} ran under anyuid SCC`,
    `${jobName} pod SCC is ${scc || "missing"}`,
    { pod: pod?.metadata?.name, scc }
  );
  const sourceImage = localPbsRuntimeImageSourceEvidence();
  const podDigests = (pod?.status?.containerStatuses ?? []).map((container) => imageDigest(container.imageID)).filter(Boolean);
  expect(
    `pbs-runtime-crc:job-source-image:${jobName}`,
    sourceImage.exists === true &&
      sourceImage.revision === approvedPbsSourceHead &&
      Boolean(sourceImage.digest) &&
      podDigests.includes(sourceImage.digest),
    `${jobName} ran the source-bound local PBS runtime image`,
    `${jobName} must run local PBS runtime image digest ${sourceImage.digest || "missing"} built from ${approvedPbsSourceHead}: ${JSON.stringify({ sourceImage, pod: pod?.metadata?.name, podDigests })}`,
    { sourceImage, pod: pod?.metadata?.name, podDigests }
  );
}

function readyPodForSelector(id, selector) {
  const podList = getJson(id, ["get", "pod", "-n", namespace, "-l", selector]);
  const pods = podList?.items ?? [];
  return pods.find((pod) => (pod.status?.conditions ?? []).some((condition) => condition.type === "Ready" && condition.status === "True")) ?? null;
}

function expectReadyPodsUseLocalSourceImage(id, selector, detail) {
  const sourceImage = localPbsRuntimeImageSourceEvidence();
  const podList = getJson(`${id}:pods`, ["get", "pod", "-n", namespace, "-l", selector]);
  const readyPods = (podList?.items ?? []).filter((pod) =>
    (pod.status?.conditions ?? []).some((condition) => condition.type === "Ready" && condition.status === "True")
  );
  const podDigests = readyPods.map((pod) => ({
    name: pod.metadata?.name ?? "",
    digests: (pod.status?.containerStatuses ?? []).map((container) => imageDigest(container.imageID)).filter(Boolean)
  }));
  expect(
    id,
    sourceImage.exists === true &&
      sourceImage.revision === approvedPbsSourceHead &&
      Boolean(sourceImage.digest) &&
      readyPods.length > 0 &&
      podDigests.every((pod) => pod.digests.includes(sourceImage.digest)),
    detail,
    `ready pods must run local PBS runtime image digest ${sourceImage.digest || "missing"} built from ${approvedPbsSourceHead}: ${JSON.stringify({ sourceImage, podDigests })}`,
    { sourceImage, podDigests }
  );
}

function expectReadyPodScc(name, selector) {
  const pod = readyPodForSelector(`pbs-runtime-crc:ready-pod:${name}`, selector);
  if (!pod) {
    fail(`pbs-runtime-crc:ready-pod-scc:${name}`, `${name} has no Ready pod for selector ${selector}`);
    return;
  }
  const scc = pod.metadata?.annotations?.["openshift.io/scc"] ?? "";
  expect(
    `pbs-runtime-crc:ready-pod-scc:${name}`,
    scc === "anyuid",
    `${name} Ready pod runs under anyuid SCC`,
    `${name} Ready pod SCC is ${scc || "missing"}`,
    { pod: pod.metadata?.name, scc }
  );
}

function restartDeploymentAfterSccIfNeeded(name) {
  const selector = deploymentReadySelectors[name];
  const pod = selector ? readyPodForSelector(`pbs-runtime-crc:pre-restart-ready-pod:${name}`, selector) : null;
  const scc = pod?.metadata?.annotations?.["openshift.io/scc"] ?? "";
  if (pod && scc === "anyuid") {
    pass(`pbs-runtime-crc:rollout-restart-skip:${name}`, `${name} already has a Ready anyuid pod; rollout restart skipped`);
    return true;
  }
  const restart = run("oc", ["rollout", "restart", `deployment/${name}`, "-n", namespace], {
    timeoutMs: 120000
  });
  expect(
    `pbs-runtime-crc:rollout-restart:${name}`,
    restart.ok,
    `${name} deployment restarted after CRC SCC bootstrap`,
    restart.stderr || restart.stdout || `${name} rollout restart failed`
  );
  return restart.ok;
}

function scaleDeployment(name, replicas, id, detail) {
  const scaled = run("oc", ["scale", `deployment/${name}`, "-n", namespace, `--replicas=${replicas}`], {
    timeoutMs: 120000
  });
  expect(id, scaled.ok, detail, scaled.stderr || scaled.stdout || `${name} scale to ${replicas} failed`);
  return scaled.ok;
}

function patchRuntimeImage(image) {
  const setImage = run("oc", ["set", "image", "deployment/app", "-n", namespace, `app=${image}`], {
    timeoutMs: 120000
  });
  expect(
    "pbs-runtime-crc:runtime-image-patch",
    setImage.ok,
    "PBS app deployment uses selected CRC runtime image",
    setImage.stderr || setImage.stdout || "failed to patch PBS app runtime image",
    { image }
  );
  const configPatch = JSON.stringify({ data: { PLAYBOOKSTUDIO_APP_IMAGE: image } });
  const config = run("oc", ["patch", "configmap/playbookstudio-config", "-n", namespace, "--type=merge", "-p", configPatch], {
    timeoutMs: 120000
  });
  expect(
    "pbs-runtime-crc:runtime-image-config",
    config.ok,
    "PBS runtime ConfigMap advertises the selected CRC app image",
    config.stderr || config.stdout || "failed to patch PBS runtime ConfigMap image"
  );
}

function patchRuntimeHttpsReadiness() {
  const patch = JSON.stringify([
    {
      op: "replace",
      path: "/spec/template/spec/containers/0/readinessProbe/httpGet/scheme",
      value: "HTTPS"
    }
  ]);
  const result = run("oc", ["patch", "deployment/app", "-n", namespace, "--type=json", "-p", patch], {
    timeoutMs: 120000
  });
  expect(
    "pbs-runtime-crc:runtime-readiness-https",
    result.ok,
    "PBS app readiness probe uses HTTPS for the CRC runtime server",
    result.stderr || result.stdout || "failed to patch PBS app readiness probe to HTTPS"
  );
}

function patchAppSourceOverlayMount() {
  const deployment = getJson("pbs-runtime-crc:source-overlay-deployment-read", ["get", "deployment", "app", "-n", namespace]);
  if (!deployment) return;
  const podSpec = deployment.spec?.template?.spec ?? {};
  const volumes = Array.isArray(podSpec.volumes) ? podSpec.volumes : [];
  const containers = Array.isArray(podSpec.containers) ? podSpec.containers : [];
  const appContainerIndex = containers.findIndex((container) => container.name === "app");
  const appContainer = containers[appContainerIndex] ?? containers[0];
  const volumeMounts = Array.isArray(appContainer?.volumeMounts) ? appContainer.volumeMounts : [];
  const patch = [];
  if (!volumes.some((volume) => volume.name === "pbs-source-overlay")) {
    patch.push({
      op: "add",
      path: "/spec/template/spec/volumes/-",
      value: {
        name: "pbs-source-overlay",
        persistentVolumeClaim: { claimName: pbsSourceOverlayPvc }
      }
    });
  }
  if (!volumeMounts.some((mount) => mount.name === "pbs-source-overlay" && mount.mountPath === "/app/src")) {
    patch.push({
      op: "add",
      path: `/spec/template/spec/containers/${appContainerIndex >= 0 ? appContainerIndex : 0}/volumeMounts/-`,
      value: {
        name: "pbs-source-overlay",
        mountPath: "/app/src",
        subPath: "src"
      }
    });
  }
  if (patch.length === 0) {
    pass("pbs-runtime-crc:source-overlay-mount", "PBS app already mounts the pinned source overlay");
    return;
  }
  const result = run("oc", ["patch", "deployment/app", "-n", namespace, "--type=json", "-p", JSON.stringify(patch)], {
    timeoutMs: 120000
  });
  expect(
    "pbs-runtime-crc:source-overlay-mount",
    result.ok,
    "PBS app deployment mounts the pinned source overlay at /app/src",
    result.stderr || result.stdout || "failed to patch PBS app source overlay mount"
  );
}

function applyPbsSourceOverlayHotfixes() {
  const patchScript = [
    "from pathlib import Path",
    "path = Path('/overlay/src/play_book_studio/wiki_loop.py')",
    "text = path.read_text(encoding='utf-8').replace('\\r\\n', '\\n')",
    "old_corpus = \"\"\"    corpus = build_corpus_status(",
    "        database_url=settings.database_url,",
    "        embedding_model=settings.embedding_model,",
    "        connect_timeout_seconds=1,",
    "    )\"\"\"",
    "new_corpus = \"\"\"    corpus = build_corpus_status(",
    "        database_url=settings.database_url,",
    "        embedding_model=settings.embedding_model,",
    "    )\"\"\"",
    "new_upload = \"\"\"def _load_upload_reports(root_dir: Path, *, limit: int = 40) -> list[dict[str, Any]]:",
    "    settings = load_settings(root_dir)",
    "    reports_root = settings.object_storage_dir / 'uploads' / 'reports'",
    "    if not reports_root.is_dir():",
    "        return []",
    "    reports: list[dict[str, Any]] = []",
    "    paths = sorted(reports_root.glob('*/ingestion-report.json'), key=lambda item: item.stat().st_mtime, reverse=True)",
    "    for report_path in paths:",
    "        try:",
    "            payload = json.loads(report_path.read_text(encoding='utf-8'))",
    "        except Exception:",
    "            continue",
    "        if isinstance(payload, dict):",
    "            reports.append(payload)",
    "        if len(reports) >= limit:",
    "            break",
    "    return reports\"\"\"",
    "changed = False",
    "if old_corpus in text:",
    "    text = text.replace(old_corpus, new_corpus, 1)",
    "    changed = True",
    "elif new_corpus not in text:",
    "    raise SystemExit('expected wiki_loop corpus status call not found')",
    "upload_start = text.find('def _load_upload_reports(')",
    "upload_end = text.find('\\n\\ndef _load_graph_entities', upload_start)",
    "if upload_start >= 0 and upload_end > upload_start:",
    "    current_upload = text[upload_start:upload_end]",
    "    if current_upload != new_upload:",
    "        text = text[:upload_start] + new_upload + text[upload_end:]",
    "        changed = True",
    "elif new_upload not in text:",
    "    raise SystemExit('expected wiki_loop upload report loader not found')",
    "if changed:",
    "    path.write_text(text, encoding='utf-8')",
    "    print('patched')",
    "else:",
    "    print('already-patched')"
  ].join("\n");
  const patched = run("oc", ["exec", "-n", namespace, pbsSourceLoaderPod, "--", "python", "-c", patchScript], {
    timeoutMs: 120000
  });
  expect(
    "pbs-runtime-crc:source-overlay-hotfix:wiki-loop-corpus-status",
    patched.ok,
    "PBS source overlay applies wiki-loop corpus status compatibility hotfix",
    patched.stderr || patched.stdout || "failed to apply PBS source overlay wiki-loop compatibility hotfix"
  );
  const stamp = run("oc", ["exec", "-n", namespace, pbsSourceLoaderPod, "--", "sh", "-lc", `printf '%s' '${pbsSourceOverlayPatchId}' > /overlay/PBS_SOURCE_PATCHES`], {
    timeoutMs: 120000
  });
  expect(
    "pbs-runtime-crc:source-overlay-hotfix-stamp",
    stamp.ok,
    "PBS source overlay records applied CRC compatibility hotfixes",
    stamp.stderr || stamp.stdout || "failed to stamp PBS source overlay hotfix list"
  );
}

function ensurePbsSourceOverlay() {
  if (!usePbsSourceOverlay) {
    pass("pbs-runtime-crc:source-overlay-skipped", "using runtime image source without a CRC source overlay");
    return;
  }
  applyYaml(
    [
      "apiVersion: v1",
      "kind: PersistentVolumeClaim",
      "metadata:",
      `  name: ${pbsSourceOverlayPvc}`,
      `  namespace: ${namespace}`,
      "spec:",
      "  accessModes:",
      "  - ReadWriteOnce",
      "  resources:",
      "    requests:",
      "      storage: 1Gi"
    ].join("\n") + "\n",
    {
      id: "pbs-runtime-crc:source-overlay-pvc",
      pass: "PBS source overlay PVC applied",
      fail: "failed to apply PBS source overlay PVC"
    }
  );
  run("oc", ["delete", "pod", pbsSourceLoaderPod, "-n", namespace, "--ignore-not-found=true", "--wait=true"], {
    timeoutMs: 120000
  });
  applyYaml(
    [
      "apiVersion: v1",
      "kind: Pod",
      "metadata:",
      `  name: ${pbsSourceLoaderPod}`,
      `  namespace: ${namespace}`,
      "  labels:",
      "    app.kubernetes.io/name: pbs-source-loader",
      "    app.kubernetes.io/part-of: playbookstudio",
      "spec:",
      "  restartPolicy: Never",
      "  serviceAccountName: playbookstudio",
      "  containers:",
      "  - name: loader",
      `    image: ${pbsRuntimeImage}`,
      "    imagePullPolicy: IfNotPresent",
      "    command:",
      "    - sh",
      "    - -lc",
      "    - sleep 3600",
      "    volumeMounts:",
      "    - name: source-overlay",
      "      mountPath: /overlay",
      "  volumes:",
      "  - name: source-overlay",
      "    persistentVolumeClaim:",
      `      claimName: ${pbsSourceOverlayPvc}`
    ].join("\n") + "\n",
    {
      id: "pbs-runtime-crc:source-overlay-loader",
      pass: "PBS source overlay loader pod applied",
      fail: "failed to apply PBS source overlay loader pod"
    }
  );
  const ready = run("oc", ["wait", "--for=condition=Ready", `pod/${pbsSourceLoaderPod}`, "-n", namespace, "--timeout=300s"], {
    timeoutMs: 330000
  });
  expect(
    "pbs-runtime-crc:source-overlay-loader-ready",
    ready.ok,
    "PBS source overlay loader pod is ready",
    ready.stderr || ready.stdout || "PBS source overlay loader pod did not become ready"
  );
  const clean = run("oc", ["exec", "-n", namespace, pbsSourceLoaderPod, "--", "sh", "-lc", "rm -rf /overlay/src"], {
    timeoutMs: 120000
  });
  expect(
    "pbs-runtime-crc:source-overlay-clean",
    clean.ok,
    "stale PBS source overlay was removed",
    clean.stderr || clean.stdout || "failed to clean stale PBS source overlay"
  );
  const copied = run("oc", ["cp", "src", `${namespace}/${pbsSourceLoaderPod}:/overlay/src`], {
    cwd: pbsSourceDir,
    timeoutMs: 600000
  });
  expect(
    "pbs-runtime-crc:source-overlay-copy",
    copied.ok,
    "pinned PBS source was copied into the CRC source overlay PVC",
    copied.stderr || copied.stdout || "failed to copy pinned PBS source into source overlay PVC"
  );
  applyPbsSourceOverlayHotfixes();
  const stamp = run("oc", ["exec", "-n", namespace, pbsSourceLoaderPod, "--", "sh", "-lc", `printf '%s' '${approvedPbsSourceHead}' > /overlay/PBS_SOURCE_HEAD`], {
    timeoutMs: 120000
  });
  expect(
    "pbs-runtime-crc:source-overlay-stamp",
    stamp.ok,
    "PBS source overlay is stamped with the approved source SHA",
    stamp.stderr || stamp.stdout || "failed to stamp PBS source overlay"
  );
  patchAppSourceOverlayMount();
}

function ensureLocalEmbeddingStub(image) {
  if (!useLocalEmbeddingStub) {
    pass("pbs-runtime-crc:embedding-stub-skipped", "using configured external embedding runtime");
    return;
  }
  const server = [
    "import hashlib, json, math",
    "from http.server import BaseHTTPRequestHandler, HTTPServer",
    "def embed(text):",
    "    seed = hashlib.sha256(str(text or '').encode('utf-8')).digest()",
    "    values = [((seed[i % len(seed)] / 255.0) * 2.0 - 1.0) + (((i % 17) - 8) * 0.0001) for i in range(1024)]",
    "    norm = math.sqrt(sum(value * value for value in values)) or 1.0",
    "    return [round(value / norm, 8) for value in values]",
    "class Handler(BaseHTTPRequestHandler):",
    "    def do_GET(self):",
    "        self.send_response(200)",
    "        self.end_headers()",
    "        self.wfile.write(b'ok')",
    "    def do_POST(self):",
    "        length = int(self.headers.get('content-length') or '0')",
    "        payload = json.loads(self.rfile.read(length) or b'{}')",
    "        items = payload.get('input')",
    "        if isinstance(items, str):",
    "            items = [items]",
    "        if not isinstance(items, list):",
    "            items = []",
    "        model = str(payload.get('model') or 'deterministic-crc-embedding')",
    "        body = json.dumps({'object': 'list', 'model': model, 'data': [{'object': 'embedding', 'index': index, 'embedding': embed(text)} for index, text in enumerate(items)]}).encode('utf-8')",
    "        self.send_response(200)",
    "        self.send_header('content-type', 'application/json')",
    "        self.send_header('content-length', str(len(body)))",
    "        self.end_headers()",
    "        self.wfile.write(body)",
    "    def log_message(self, *_args):",
    "        return",
    "HTTPServer(('0.0.0.0', 8080), Handler).serve_forever()"
  ].join("\n");
  applyYaml(
    [
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: embedding-stub",
      `  namespace: ${namespace}`,
      "  labels:",
      "    app.kubernetes.io/name: embedding-stub",
      "    app.kubernetes.io/part-of: playbookstudio",
      "spec:",
      "  replicas: 1",
      "  selector:",
      "    matchLabels:",
      "      app.kubernetes.io/name: embedding-stub",
      "  template:",
      "    metadata:",
      "      labels:",
      "        app.kubernetes.io/name: embedding-stub",
      "        app.kubernetes.io/part-of: playbookstudio",
      "    spec:",
      "      serviceAccountName: playbookstudio",
      "      containers:",
      "      - name: embedding-stub",
      `        image: ${image}`,
      "        imagePullPolicy: IfNotPresent",
      "        command:",
      "        - python",
      "        - -c",
      "        args:",
      "        - |",
      ...server.split("\n").map((line) => `          ${line}`),
      "        ports:",
      "        - name: http",
      "          containerPort: 8080",
      "---",
      "apiVersion: v1",
      "kind: Service",
      "metadata:",
      "  name: embedding-stub",
      `  namespace: ${namespace}`,
      "  labels:",
      "    app.kubernetes.io/name: embedding-stub",
      "    app.kubernetes.io/part-of: playbookstudio",
      "spec:",
      "  selector:",
      "    app.kubernetes.io/name: embedding-stub",
      "  ports:",
      "  - name: http",
      "    port: 8080",
      "    targetPort: http"
    ].join("\n") + "\n",
    {
      id: "pbs-runtime-crc:embedding-stub-apply",
      pass: "local CRC embedding stub applied",
      fail: "failed to apply local CRC embedding stub"
    }
  );
  const rollout = run("oc", ["rollout", "status", "deployment/embedding-stub", "-n", namespace, "--timeout=300s"], {
    timeoutMs: 330000
  });
  expect(
    "pbs-runtime-crc:embedding-stub-rollout",
    rollout.ok,
    "local CRC embedding stub rolled out",
    rollout.stderr || rollout.stdout || "local CRC embedding stub rollout failed"
  );
  const configPatch = JSON.stringify({
    data: {
      EMBEDDING_BASE_URL: "http://embedding-stub:8080/v1",
      EMBEDDING_TIMEOUT_SECONDS: "20"
    }
  });
  const config = run("oc", ["patch", "configmap/playbookstudio-config", "-n", namespace, "--type=merge", "-p", configPatch], {
    timeoutMs: 120000
  });
  expect(
    "pbs-runtime-crc:embedding-config",
    config.ok,
    "PBS runtime ConfigMap uses the local CRC embedding stub",
    config.stderr || config.stdout || "failed to patch PBS embedding ConfigMap"
  );
}

function syncPostgresPassword() {
  const script = [
    "set -eu",
    `psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v role="$POSTGRES_USER" -v pass="$POSTGRES_PASSWORD" <<'SQL'`,
    `ALTER ROLE :"role" WITH PASSWORD :'pass';`,
    "SQL",
    `PGPASSWORD="$POSTGRES_PASSWORD" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select 1" >/dev/null`
  ].join("\n");
  const result = run("oc", ["exec", "-n", namespace, "deployment/postgres", "--", "sh", "-lc", script], {
    timeoutMs: 120000
  });
  expect(
    "pbs-runtime-crc:postgres-password-sync",
    result.ok,
    "Postgres role password matches the current playbookstudio Secret",
    result.stderr || result.stdout || "failed to synchronize Postgres role password with playbookstudio Secret"
  );
}

function applyPbsGraphFoundationMigration() {
  const migrationPath = join(pbsSourceDir, "db", "migrations", "0012_entity_graph_foundation.sql");
  const sql = readFileSync(migrationPath, "utf8");
  const result = run(
    "oc",
    [
      "exec",
      "-i",
      "-n",
      namespace,
      "deployment/postgres",
      "--",
      "sh",
      "-lc",
      `PGPASSWORD="$POSTGRES_PASSWORD" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"`
    ],
    {
      input: sql,
      timeoutMs: 120000
    }
  );
  expect(
    "pbs-runtime-crc:graph-foundation-migration",
    result.ok,
    "PBS pinned source graph foundation migration is applied for LLM Wiki topology",
    result.stderr || result.stdout || `failed to apply ${migrationPath}`
  );
}

function postgresReadySnapshot() {
  const result = run("oc", ["get", "pod", "-n", namespace, "-l", "app.kubernetes.io/name=postgres", "-o", "json"], { timeoutMs: 30000 });
  if (!result.ok) return null;
  const podList = parseJsonOutput("pbs-runtime-crc:postgres-stable-json", result.stdout);
  const pod = podList?.items?.find((item) =>
    (item.status?.conditions ?? []).some((condition) => condition.type === "Ready" && condition.status === "True")
  );
  if (!pod) return null;
  return {
    name: pod.metadata?.name ?? "",
    restartCount: Number(pod.status?.containerStatuses?.[0]?.restartCount ?? -1)
  };
}

function waitForPostgresStable() {
  const available = run("oc", ["wait", "--for=condition=available", "deployment/postgres", "-n", namespace, "--timeout=300s"], {
    timeoutMs: 330000
  });
  expect(
    "pbs-runtime-crc:postgres-available",
    available.ok,
    "postgres deployment is Available before ordered seed Jobs",
    available.stderr || available.stdout || "postgres deployment did not become Available"
  );

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const before = postgresReadySnapshot();
    if (before?.name && before.restartCount >= 0) {
      const ping = run(
        "oc",
        [
          "exec",
          "-n",
          namespace,
          "deployment/postgres",
          "--",
          "sh",
          "-lc",
          `PGPASSWORD="$POSTGRES_PASSWORD" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select 1" >/dev/null`
        ],
        { timeoutMs: 120000 }
      );
      if (ping.ok) {
        sleep(15000);
        const after = postgresReadySnapshot();
        if (after?.name === before.name && after.restartCount === before.restartCount) {
          pass("pbs-runtime-crc:postgres-stable", `postgres pod ${after.name} stayed ready without restarts before ordered seed Jobs`);
          return true;
        }
      }
    }
    sleep(5000);
  }
  fail("pbs-runtime-crc:postgres-stable", "postgres did not stay ready long enough before ordered seed Jobs");
  return false;
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

function verifyRuntimeHealth() {
  const probe = [
    "import json, ssl, urllib.request",
    "ctx=ssl._create_unverified_context()",
    "def fetch(path, *, method='GET', payload=None):",
    "    data = None if payload is None else json.dumps(payload).encode('utf-8')",
    "    headers = {'Accept':'application/json'}",
    "    if data is not None:",
    "        headers['Content-Type'] = 'application/json'",
    "    req=urllib.request.Request('https://127.0.0.1:8765'+path, data=data, headers=headers, method=method)",
    "    with urllib.request.urlopen(req, context=ctx, timeout=300) as response:",
    "        text=response.read(1048576).decode('utf-8','replace')",
    "        return response.status, (json.loads(text) if text else {})",
    "health_status, body=fetch('/api/health')",
    "wiki_run_status, wiki_run_body = 0, {}",
    "try:",
    "    wiki_status, wiki_body=fetch('/api/wiki-loop/status?user_id=local')",
    "except Exception as exc:",
    "    wiki_status, wiki_body=0, {'error': str(exc)}",
    "if wiki_status != 200 or not wiki_body.get('compiled_wiki_ready'):",
    "    try:",
    "        wiki_run_status, wiki_run_body=fetch('/api/wiki-loop/run', method='POST', payload={'user_id':'local'})",
    "        wiki_status, wiki_body=fetch('/api/wiki-loop/status?user_id=local')",
    "    except Exception as exc:",
    "        wiki_run_status, wiki_run_body=0, {'error': str(exc)}",
    "body['__casWikiLoopStatus']=wiki_body",
    "body['__casWikiLoopRun']={'status': wiki_run_status, 'body': wiki_run_body}",
    "print(json.dumps({'health_status': health_status, 'wiki_status': wiki_status, 'wiki_run_status': wiki_run_status, 'body': body}, ensure_ascii=False))"
  ].join("\n");
  const result = run("oc", ["exec", "-n", namespace, `deployment/${deploymentName}`, "--", "python", "-c", probe], {
    timeoutMs: 420000
  });
  if (!result.ok) {
    fail("pbs-runtime-crc:runtime-health-probe", result.stderr || result.stdout || "PBS runtime health probe failed");
    return;
  }
  const payload = parseJsonOutput("pbs-runtime-crc:runtime-health-json", result.stdout);
  if (!payload) return;
  const body = payload.body ?? {};
  const readiness = pbsRuntimeHealthReadiness(body);
  expect(
    "pbs-runtime-crc:runtime-health-ready",
    Number(payload.health_status) === 200 && pbsRuntimeHealthReady(body),
    "PBS runtime /api/health proves Postgres, pgvector, corpus scopes, and compiled wiki are ready",
    `PBS runtime health is not ready: ${JSON.stringify({ healthStatus: payload.health_status, wikiStatus: payload.wiki_status, wikiRunStatus: payload.wiki_run_status, readiness })}`,
    { healthStatus: payload.health_status, wikiStatus: payload.wiki_status, wikiRunStatus: payload.wiki_run_status, readiness }
  );
}

function writeEvidence() {
  mkdirSync("test-results", { recursive: true });
  const failures = checks.filter((check) => check.status === "FAIL");
  const warnings = checks.filter((check) => check.status === "WARN");
  const status = failures.length > 0 ? "FAIL" : warnings.length > 0 ? "WARN" : "PASS";
  const evidence = {
    status,
    startedAt,
    checkedAt: new Date().toISOString(),
    summary: {
      total: checks.length,
      passed: checks.filter((check) => check.status === "PASS").length,
      warned: warnings.length,
      failed: failures.length
    },
    pbsSource: sourceMetadata,
    overlayPath,
    namespace,
    checks
  };
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log(`Evidence: ${evidencePath}`);
  return status;
}

function tokenFromOc() {
  const result = run("oc", ["whoami", "-t"], { timeoutMs: 30000 });
  return result.ok ? result.stdout.trim() : "";
}

const sourceMetadata = {
  path: pbsSourceDir,
  branch: git(["branch", "--show-current"]).stdout,
  fullHead: git(["rev-parse", "HEAD"]).stdout,
  shortHead: git(["rev-parse", "--short", "HEAD"]).stdout,
  treeStatus: git(["status", "--short"]).stdout ? "dirty" : "clean",
  remoteOriginUrl: git(["config", "--get", "remote.origin.url"]).stdout
};

expect("pbs-runtime-crc:source-dir", existsSync(pbsSourceDir), `using PBS source directory ${pbsSourceDir}`);
expect("pbs-runtime-crc:overlay-path", existsSync(overlayPath), `using PBS runtime overlay ${overlayPath}`);
expect(
  "pbs-runtime-crc:approved-source-head",
  sourceMetadata.fullHead === approvedPbsSourceHead,
  `PBS source HEAD matches approved v0.1.4 SHA ${approvedPbsSourceHead}`,
  `PBS source HEAD ${sourceMetadata.fullHead || "unknown"} must match approved v0.1.4 SHA ${approvedPbsSourceHead}`
);
expect("pbs-runtime-crc:source-clean", sourceMetadata.treeStatus === "clean", "PBS source tree is clean", `PBS source tree is ${sourceMetadata.treeStatus}`);

if (checks.some((check) => check.status === "FAIL")) {
  const status = writeEvidence();
  process.exitCode = status === "PASS" ? 0 : 1;
  process.exit();
}

const postgresPassword = process.env.PLAYBOOKSTUDIO_POSTGRES_PASSWORD || existingSecretValue("playbookstudio-secret", "POSTGRES_PASSWORD") || `pbs-${randomBytes(24).toString("hex")}`;
const ocpToken = process.env.PLAYBOOKSTUDIO_OCP_API_TOKEN || process.env.OCP_API_TOKEN || existingSecretValue("playbookstudio-secret", "OCP_API_TOKEN") || tokenFromOc();
const lightspeedToken =
  process.env.PLAYBOOKSTUDIO_OPENSHIFT_LIGHTSPEED_API_TOKEN ||
  process.env.OPENSHIFT_LIGHTSPEED_API_TOKEN ||
  existingSecretValue("playbookstudio-secret", "OPENSHIFT_LIGHTSPEED_API_TOKEN") ||
  existingSecretValue("playbookstudio-secret", "OLS_AUTH_TOKEN") ||
  "";

expect(
  "pbs-runtime-crc:secret-inputs",
  postgresPassword.length >= 32 && ocpToken.length >= 20,
  "local CRC PBS Secret inputs are present and non-placeholder",
  "PLAYBOOKSTUDIO_POSTGRES_PASSWORD and PLAYBOOKSTUDIO_OCP_API_TOKEN/OCP_API_TOKEN must be non-placeholder values"
);

if (checks.some((check) => check.status === "FAIL")) {
  const status = writeEvidence();
  process.exitCode = status === "PASS" ? 0 : 1;
  process.exit();
}

applyYaml(
  [
    "apiVersion: v1",
    "kind: Namespace",
    "metadata:",
    `  name: ${namespace}`,
    "  labels:",
    "    app.kubernetes.io/part-of: playbookstudio",
    "    cywell.ai/runtime-contract: pbs-v0.1.4"
  ].join("\n") + "\n",
  {
    id: "pbs-runtime-crc:namespace-apply",
    pass: "playbookstudio namespace applied",
    fail: "failed to apply playbookstudio namespace"
  }
);

resetOneShotJobs("pbs-runtime-crc:jobs-reset:prebuild", "stale PBS one-shot Jobs reset before local runtime image build");
forceDeletePods(
  "pbs-runtime-crc:app-pods-reset:prebuild",
  "app.kubernetes.io/name=playbookstudio,app.kubernetes.io/component=runtime",
  "stale PBS app pods force-deleted before local runtime image build"
);

pbsRuntimeImage = ensureLocalPbsRuntimeImage();

applyYaml(
  yamlSecret("playbookstudio-secret", {
    POSTGRES_PASSWORD: postgresPassword,
    OCP_API_TOKEN: ocpToken,
    OPENSHIFT_LIGHTSPEED_API_TOKEN: lightspeedToken,
    OLS_AUTH_TOKEN: lightspeedToken
  }),
  {
    id: "pbs-runtime-crc:runtime-secret-apply",
    pass: "playbookstudio runtime Secret applied with redacted local CRC values",
    fail: "failed to apply playbookstudio runtime Secret"
  }
);

grantAnyuidScc("terminal-broker", "app fsGroup 0 and terminal workspace broker");
grantAnyuidScc("playbookstudio", "pgvector PVC initialization and PBS seed jobs");

resetOneShotJobs("pbs-runtime-crc:jobs-reset:stale", "stale PBS one-shot migration and seed Jobs reset before overlay apply");

const applyOverlay = run("oc", ["apply", "-k", overlayPath], { timeoutMs: 600000 });
expect(
  "pbs-runtime-crc:overlay-apply",
  applyOverlay.ok,
  "PBS runtime overlay applied",
  applyOverlay.stderr || applyOverlay.stdout || "failed to apply PBS runtime overlay",
  { stdout: applyOverlay.ok ? applyOverlay.stdout : undefined }
);

const renderedDocuments = renderedOverlayDocuments();
resetOneShotJobs("pbs-runtime-crc:jobs-reset:until-postgres", "PBS one-shot Jobs held until Postgres is ready");
patchRuntimeImage(pbsRuntimeImage);
patchRuntimeHttpsReadiness();
ensurePbsSourceOverlay();
ensureLocalEmbeddingStub(pbsRuntimeImage);
scaleDeployment("app", 0, "pbs-runtime-crc:app-scale-down", "PBS app deployment scaled down until ordered seed Jobs complete");

for (const name of postSccRestartDeployments) {
  restartDeploymentAfterSccIfNeeded(name);
}

const postgresRollout = run("oc", ["rollout", "status", "deployment/postgres", "-n", namespace, "--timeout=900s"], {
  timeoutMs: 930000
});
expect(
  "pbs-runtime-crc:rollout:postgres",
  postgresRollout.ok,
  "postgres deployment rolled out",
  postgresRollout.stderr || postgresRollout.stdout || "postgres rollout failed"
);
syncPostgresPassword();
waitForPostgresStable();

for (const jobName of pbsOneShotJobs) {
  waitForJob(jobName, renderedDocuments);
  if (jobName === "db-migrate") {
    applyPbsGraphFoundationMigration();
  }
}

const setEnv = run(
  "oc",
  [
    "set",
    "env",
    `deployment/${deploymentName}`,
    "-n",
    namespace,
    `PLAYBOOKSTUDIO_SOURCE_HEAD=${approvedPbsSourceHead}`,
    `PLAYBOOKSTUDIO_SOURCE_OVERLAY_PATCHES=${pbsSourceOverlayPatchId}`
  ],
  {
    timeoutMs: 120000
  }
);
expect(
  "pbs-runtime-crc:source-env-stamp",
  setEnv.ok,
  "PBS runtime deployment env stamps approved source SHA and CRC source overlay hotfixes",
  setEnv.stderr || setEnv.stdout || "failed to set PBS runtime source env stamps"
);

const sourcePatch = JSON.stringify({
  spec: {
    template: {
      metadata: {
        annotations: {
          "cywell.ai/pbs-source-head": approvedPbsSourceHead,
          "cywell.ai/pbs-source-overlay-patches": pbsSourceOverlayPatchId,
          "org.opencontainers.image.revision": approvedPbsSourceHead
        }
      }
    }
  }
});
const patch = run("oc", ["patch", `deployment/${deploymentName}`, "-n", namespace, "--type=merge", "-p", sourcePatch], {
  timeoutMs: 120000
});
expect(
  "pbs-runtime-crc:source-annotation-stamp",
  patch.ok,
  "PBS runtime deployment pod template annotations stamp approved source SHA",
  patch.stderr || patch.stdout || "failed to patch PBS runtime source annotations"
);

scaleDeployment("app", 1, "pbs-runtime-crc:app-scale-up", "PBS app deployment scaled up after ordered seed Jobs complete");

for (const name of finalRestartDeployments) {
  const restart = run("oc", ["rollout", "restart", `deployment/${name}`, "-n", namespace], {
    timeoutMs: 120000
  });
  expect(
    `pbs-runtime-crc:rollout-restart:${name}`,
    restart.ok,
    `${name} deployment restarted after CRC SCC bootstrap`,
    restart.stderr || restart.stdout || `${name} rollout restart failed`
  );
}

for (const name of ["app", "web"]) {
  const rollout = run("oc", ["rollout", "status", `deployment/${name}`, "-n", namespace, "--timeout=900s"], {
    timeoutMs: 930000
  });
  expect(
    `pbs-runtime-crc:rollout:${name}`,
    rollout.ok,
    `${name} deployment rolled out`,
    rollout.stderr || rollout.stdout || `${name} rollout failed`
  );
}

expectReadyPodScc("postgres", "app.kubernetes.io/name=postgres");
expectReadyPodScc("app", "app.kubernetes.io/name=playbookstudio,app.kubernetes.io/component=runtime");

const service = getJson("pbs-runtime-crc:runtime-service", ["get", "service", "-n", namespace, "playbookstudio-runtime"]);
if (service) {
  const ports = service.spec?.ports ?? [];
  const selector = service.spec?.selector ?? {};
  expect(
    "pbs-runtime-crc:runtime-service-contract",
    ports.some((port) => Number(port.port) === 8765) &&
      selector["app.kubernetes.io/name"] === "playbookstudio" &&
      selector["app.kubernetes.io/component"] === "runtime",
    "playbookstudio-runtime exposes port 8765 with Cywell runtime labels",
    `playbookstudio-runtime contract mismatch: ${JSON.stringify({ ports, selector })}`
  );
}

const deployment = getJson("pbs-runtime-crc:runtime-deployment", ["get", "deployment", "-n", namespace, deploymentName]);
if (deployment) {
  const annotations = deployment.spec?.template?.metadata?.annotations ?? {};
  const env = deployment.spec?.template?.spec?.containers?.find((container) => container.name === "app")?.env ?? [];
  const envHead = env.find((item) => item.name === "PLAYBOOKSTUDIO_SOURCE_HEAD")?.value;
  expect(
    "pbs-runtime-crc:runtime-source-stamped",
    annotations["cywell.ai/pbs-source-head"] === approvedPbsSourceHead &&
      annotations["org.opencontainers.image.revision"] === approvedPbsSourceHead &&
      envHead === approvedPbsSourceHead,
    "PBS runtime pod template is stamped with the approved source SHA",
    `PBS runtime source stamp mismatch: ${JSON.stringify({ annotations, envHead })}`
  );
}
expectReadyPodsUseLocalSourceImage(
  "pbs-runtime-crc:runtime-source-image-digest",
  "app.kubernetes.io/name=playbookstudio,app.kubernetes.io/component=runtime",
  "ready PBS runtime pods run the source-bound local PBS runtime image"
);

const endpoints = getJson("pbs-runtime-crc:runtime-endpoints", ["get", "endpoints", "-n", namespace, "playbookstudio-runtime"]);
if (endpoints) {
  const ready = (endpoints.subsets ?? []).some((subset) => (subset.addresses ?? []).length > 0 && (subset.ports ?? []).some((port) => Number(port.port) === 8765));
  expect(
    "pbs-runtime-crc:runtime-endpoints-ready",
    ready,
    "playbookstudio-runtime has a ready endpoint on port 8765",
    `playbookstudio-runtime endpoints are not ready on port 8765: ${JSON.stringify(endpoints.subsets ?? [])}`
  );
}

verifyRuntimeHealth();

checks.push({
  status: "PASS",
  id: "pbs-runtime-crc:redacted-secret-evidence",
  detail: "evidence stores only secret hashes",
  postgresPasswordSha256: sha256(postgresPassword),
  ocpTokenSha256: sha256(ocpToken),
  lightspeedTokenSha256: lightspeedToken ? sha256(lightspeedToken) : null
});

const finalStatus = writeEvidence();
process.exitCode = finalStatus === "PASS" ? 0 : 1;
