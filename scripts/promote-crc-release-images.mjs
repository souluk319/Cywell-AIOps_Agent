#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const namespace = process.env.CAS_RELEASE_NAMESPACE || "cywell-ai-sentinel";
const releaseTag = process.env.CAS_RELEASE_TAG || "v0.1.4";
const forceRelease = ["1", "true", "yes", "y", "on"].includes(String(process.env.CAS_RELEASE_FORCE ?? "").trim().toLowerCase());
const appImageStreams = ["cas-gateway", "cas-console-plugin", "cas-knowledge-engine"];
const postgresImageStream = "cas-knowledge-postgres";
const checks = [];
const checkedAt = new Date().toISOString();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    timeout: options.timeoutMs ?? 120000,
    windowsHide: true
  });
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}\n${result.stderr ?? result.error?.message ?? ""}`.trim();
    throw new Error(`${command} ${args.join(" ")} failed\n${detail}`);
  }
  return result.stdout?.trim() ?? "";
}

function pass(id, detail, extra = {}) {
  checks.push({ status: "PASS", id, detail, ...extra });
  console.log(`[PASS] ${id}: ${detail}`);
}

function getJson(args) {
  return JSON.parse(run("oc", [...args, "-o", "json"]));
}

function getImageStreamTagReference(name, tag) {
  try {
    const imageTag = getJson(["get", "imagestreamtag", `${name}:${tag}`, "-n", namespace]);
    return imageTag?.image?.dockerImageReference ?? imageTag?.image?.metadata?.name ?? "";
  } catch {
    return "";
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ensureImageStream(name) {
  try {
    run("oc", ["get", "imagestream", name, "-n", namespace, "-o", "name"]);
    pass(`release:imagestream:${name}`, `${name} ImageStream exists`);
  } catch {
    run("oc", ["create", "imagestream", name, "-n", namespace], { stdio: "inherit" });
    pass(`release:imagestream:${name}`, `${name} ImageStream created`);
  }
}

function ensureImageStreamTag(name, tag) {
  let lastError = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const resolved = getImageStreamTagReference(name, tag);
      if (resolved) {
        pass(`release:imagestreamtag:${name}:${tag}`, `${name}:${tag} resolves`, { image: resolved });
        return resolved;
      }
      lastError = `${name}:${tag} exists but has no resolved image reference`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    sleep(1000);
  }
  throw new Error(lastError || `${name}:${tag} did not resolve`);
}

function assertReleaseTargetMutable(name, sourceRef) {
  const targetRef = getImageStreamTagReference(name, releaseTag);
  if (!targetRef) {
    pass(`release:target:${name}:${releaseTag}`, `${name}:${releaseTag} does not exist yet`);
    return;
  }
  if (targetRef === sourceRef) {
    pass(`release:target:${name}:${releaseTag}:unchanged`, `${name}:${releaseTag} already matches source`, { image: targetRef });
    return;
  }
  if (forceRelease) {
    pass(`release:target:${name}:${releaseTag}:force`, `${name}:${releaseTag} differs and CAS_RELEASE_FORCE=true allows retag`, {
      previous: targetRef,
      next: sourceRef
    });
    return;
  }
  throw new Error(`${name}:${releaseTag} already resolves to a different image; set CAS_RELEASE_FORCE=true to retag intentionally`);
}

function promoteAppReleaseTags() {
  for (const name of appImageStreams) {
    ensureImageStream(name);
    const sourceRef = ensureImageStreamTag(name, "dev");
    assertReleaseTargetMutable(name, sourceRef);
    run("oc", ["tag", "-n", namespace, `${name}:dev`, `${name}:${releaseTag}`, "--reference-policy=local"], { stdio: "inherit" });
    ensureImageStreamTag(name, releaseTag);
  }
}

function normalizeDigestReference(imageId) {
  const stripped = String(imageId ?? "").replace(/^[a-z-]+:\/\//, "");
  const digest = stripped.match(/(.+@sha256:[a-f0-9]{32,})/i)?.[1] ?? "";
  if (!digest) return "";
  if (digest.startsWith("pgvector/")) return `docker.io/${digest}`;
  return digest;
}

function findRunningPostgresDigest() {
  const pods = getJson([
    "get",
    "pods",
    "-n",
    namespace,
    "-l",
    "app.kubernetes.io/name=cywell-ai-sentinel,app.kubernetes.io/component=knowledge-postgres"
  ]);
  for (const pod of pods.items ?? []) {
    if (pod.status?.phase !== "Running") continue;
    const status = (pod.status?.containerStatuses ?? []).find((container) => container.name === "postgres");
    const digest = normalizeDigestReference(status?.imageID);
    if (digest) return { digest, pod: pod.metadata?.name ?? "" };
  }
  return { digest: "", pod: "" };
}

function promotePostgresReleaseTag() {
  ensureImageStream(postgresImageStream);
  const { digest, pod } = findRunningPostgresDigest();
  if (!digest) throw new Error("could not resolve a digest-pinned imageID from the running cas-knowledge-postgres pod");
  pass("release:postgres:digest-source", `resolved running Postgres image digest from ${pod}`, { image: digest });
  assertReleaseTargetMutable(postgresImageStream, digest);
  run(
    "oc",
    ["tag", "-n", namespace, "--source=docker", digest, `${postgresImageStream}:${releaseTag}`, "--reference-policy=local"],
    { stdio: "inherit" }
  );
  ensureImageStreamTag(postgresImageStream, releaseTag);
}

try {
  promoteAppReleaseTags();
  promotePostgresReleaseTag();
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/cas-release-images.json",
    JSON.stringify(
      {
        checkedAt,
        namespace,
        releaseTag,
        forceRelease,
        status: "PASS",
        summary: { total: checks.length, passed: checks.length, failed: 0 },
        checks
      },
      null,
      2
    )
  );
  console.log("CAS release image promotion final status: PASS");
  console.log("Evidence: test-results/cas-release-images.json");
} catch (error) {
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/cas-release-images.json",
    JSON.stringify(
      {
        checkedAt,
        namespace,
        releaseTag,
        status: "FAIL",
        error: error instanceof Error ? error.message : String(error),
        checks
      },
      null,
      2
    )
  );
  console.error(error instanceof Error ? error.message : String(error));
  console.error("Evidence: test-results/cas-release-images.json");
  process.exitCode = 1;
}
