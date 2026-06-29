#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const namespace = process.env.CAS_RELEASE_NAMESPACE || "cywell-ai-sentinel";
const releaseTag = process.env.CAS_RELEASE_TAG || "v0.1.4";
const releaseEvidencePath = process.env.CAS_RELEASE_EVIDENCE || "test-results/cas-crc-deployment.json";
const forceRelease = ["1", "true", "yes", "y", "on"].includes(String(process.env.CAS_RELEASE_FORCE ?? "").trim().toLowerCase());
const allowStaleEvidence = ["1", "true", "yes", "y", "on"].includes(String(process.env.CAS_RELEASE_ALLOW_STALE_EVIDENCE ?? "").trim().toLowerCase());
const evidenceMaxAgeHours = Number(process.env.CAS_RELEASE_EVIDENCE_MAX_AGE_HOURS ?? "24");
const appImageStreams = ["cas-gateway", "cas-console-plugin", "cas-knowledge-engine"];
const postgresImageStream = "cas-knowledge-postgres";
const releaseImageStreams = [...appImageStreams, postgresImageStream];
const checks = [];
const checkedAt = new Date().toISOString();
let deploymentEvidence = null;
const promotedImages = {};

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

function currentGitHead() {
  return run("git", ["rev-parse", "--short", "HEAD"]);
}

function currentGitBranch() {
  return run("git", ["branch", "--show-current"]);
}

function extractDigest(value) {
  const match = String(value ?? "").match(/sha256:[a-f0-9]{32,}/i);
  return match ? match[0].toLowerCase() : "";
}

function loadDeploymentEvidence() {
  const evidence = JSON.parse(readFileSync(releaseEvidencePath, "utf8"));
  if (evidence.status !== "PASS") {
    throw new Error(`${releaseEvidencePath} is not PASS; run npm run deploy:crc before release promotion`);
  }
  if (evidence.namespace !== namespace) {
    throw new Error(`${releaseEvidencePath} namespace ${evidence.namespace ?? "missing"} does not match release namespace ${namespace}`);
  }
  const evidenceHead = String(evidence.head ?? "");
  const head = currentGitHead();
  if (evidenceHead !== head && !allowStaleEvidence) {
    throw new Error(`${releaseEvidencePath} was generated for head ${evidenceHead || "missing"}, current head is ${head}; rerun npm run deploy:crc or set CAS_RELEASE_ALLOW_STALE_EVIDENCE=true intentionally`);
  }
  const checkedAtMs = Date.parse(evidence.checkedAt ?? "");
  if (!Number.isFinite(checkedAtMs)) {
    throw new Error(`${releaseEvidencePath} has no valid checkedAt timestamp`);
  }
  if (Number.isFinite(evidenceMaxAgeHours) && evidenceMaxAgeHours > 0) {
    const ageHours = (Date.now() - checkedAtMs) / 3600000;
    if (ageHours > evidenceMaxAgeHours && !allowStaleEvidence) {
      throw new Error(`${releaseEvidencePath} is ${ageHours.toFixed(1)}h old; rerun npm run deploy:crc or set CAS_RELEASE_ALLOW_STALE_EVIDENCE=true intentionally`);
    }
  }
  if (!evidence.verifiedImages || typeof evidence.verifiedImages !== "object") {
    throw new Error(`${releaseEvidencePath} does not contain verifiedImages; rerun npm run deploy:crc with the current verifier`);
  }
  for (const name of releaseImageStreams) {
    const image = evidence.verifiedImages[name];
    if (!image || image.verified !== true || !extractDigest(image.digest)) {
      throw new Error(`${releaseEvidencePath} missing verified digest evidence for ${name}`);
    }
  }
  pass("release:evidence:crc-deployment", `loaded PASS CRC deployment evidence from ${releaseEvidencePath}`, {
    evidenceCheckedAt: evidence.checkedAt,
    evidenceHead: evidence.head
  });
  return evidence;
}

function assertSourceMatchesDeploymentEvidence(name, sourceRef) {
  const expectedDigest = deploymentEvidence?.verifiedImages?.[name]?.digest ?? "";
  const actualDigest = extractDigest(sourceRef);
  if (!expectedDigest) {
    throw new Error(`${releaseEvidencePath} is missing verified digest evidence for ${name}`);
  }
  if (!actualDigest) {
    throw new Error(`${name} release source does not resolve to a digest-pinned image reference`);
  }
  if (actualDigest !== expectedDigest) {
    throw new Error(`${name} release source digest ${actualDigest} differs from verified CRC deployment digest ${expectedDigest}`);
  }
  pass(`release:evidence:${name}`, `${name} release source matches verified CRC deployment digest`, {
    image: sourceRef,
    digest: actualDigest
  });
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

function ensureImageStreamTag(name, tag, expectedDigest = "") {
  let lastError = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const resolved = getImageStreamTagReference(name, tag);
      if (resolved) {
        const actualDigest = extractDigest(resolved);
        const normalizedExpected = extractDigest(expectedDigest);
        if (!normalizedExpected || actualDigest === normalizedExpected) {
          pass(`release:imagestreamtag:${name}:${tag}`, `${name}:${tag} resolves${normalizedExpected ? " to expected digest" : ""}`, {
            image: resolved,
            digest: actualDigest
          });
          return resolved;
        }
        lastError = `${name}:${tag} resolves to ${actualDigest || "no digest"}, expected ${normalizedExpected}`;
      } else {
        lastError = `${name}:${tag} exists but has no resolved image reference`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    sleep(1000);
  }
  throw new Error(lastError || `${name}:${tag} did not resolve`);
}

function recordPromotedImage(name, image, sourceImage = image) {
  const digest = extractDigest(image);
  if (!digest) throw new Error(`${name}:${releaseTag} did not resolve to a digest-pinned image reference`);
  promotedImages[name] = {
    tag: releaseTag,
    sourceImage,
    image,
    digest,
    verifiedDigest: deploymentEvidence?.verifiedImages?.[name]?.digest ?? ""
  };
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
    const expectedDigest = deploymentEvidence.verifiedImages[name].digest;
    const sourceRef = ensureImageStreamTag(name, "dev", expectedDigest);
    assertSourceMatchesDeploymentEvidence(name, sourceRef);
    assertReleaseTargetMutable(name, sourceRef);
    run("oc", ["tag", "-n", namespace, `${name}:dev`, `${name}:${releaseTag}`, "--reference-policy=local"], { stdio: "inherit" });
    const promotedRef = ensureImageStreamTag(name, releaseTag, expectedDigest);
    recordPromotedImage(name, promotedRef, sourceRef);
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
  assertSourceMatchesDeploymentEvidence(postgresImageStream, digest);
  assertReleaseTargetMutable(postgresImageStream, digest);
  run(
    "oc",
    ["tag", "-n", namespace, "--source=docker", digest, `${postgresImageStream}:${releaseTag}`, "--reference-policy=local"],
    { stdio: "inherit" }
  );
  const promotedRef = ensureImageStreamTag(postgresImageStream, releaseTag);
  recordPromotedImage(postgresImageStream, promotedRef, digest);
}

try {
  deploymentEvidence = loadDeploymentEvidence();
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
        releaseEvidencePath,
        branch: currentGitBranch(),
        head: currentGitHead(),
        forceRelease,
        status: "PASS",
        summary: { total: checks.length, passed: checks.length, failed: 0 },
        promotedImages,
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
        releaseEvidencePath,
        branch: (() => {
          try {
            return currentGitBranch();
          } catch {
            return "";
          }
        })(),
        head: (() => {
          try {
            return currentGitHead();
          } catch {
            return "";
          }
        })(),
        status: "FAIL",
        promotedImages,
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
