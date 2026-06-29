#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs.filter((arg) => !arg.startsWith("--out-dir=") && !arg.startsWith("--evidence-dir=")));
const outDirArg = rawArgs.find((arg) => arg.startsWith("--out-dir="))?.split("=")[1];
const evidenceDirArg = rawArgs.find((arg) => arg.startsWith("--evidence-dir="))?.split("=")[1];
const outDir = outDirArg || process.env.CAS_PBS_CUTOVER_BUNDLE_DIR || join("test-results", "pbs-cutover-bundle");
const evidenceDir = evidenceDirArg || process.env.CAS_PBS_CUTOVER_EVIDENCE_DIR || "test-results";
const requireLiveReady = args.has("--require-live-ready") || /^(1|true|yes|y|on)$/i.test(process.env.CAS_PBS_CUTOVER_REQUIRE_LIVE_READY || "");
const allowDirty = args.has("--allow-dirty") || /^(1|true|yes|y|on)$/i.test(process.env.CAS_PBS_CUTOVER_BUNDLE_ALLOW_DIRTY || "");
const selfTest = args.has("--self-test");
const checkedAt = new Date().toISOString();
const maxLivePreapplyAgeMinutesInput = Number(process.env.CAS_PBS_CUTOVER_MAX_PREAPPLY_AGE_MINUTES || 120);
const maxLivePreapplyAgeMinutes = Number.isFinite(maxLivePreapplyAgeMinutesInput) && maxLivePreapplyAgeMinutesInput > 0 ? maxLivePreapplyAgeMinutesInput : 120;
const maxSourceProofAgeMinutesInput = Number(process.env.CAS_PBS_CUTOVER_MAX_SOURCE_PROOF_AGE_MINUTES || maxLivePreapplyAgeMinutes);
const maxSourceProofAgeMinutes = Number.isFinite(maxSourceProofAgeMinutesInput) && maxSourceProofAgeMinutesInput > 0 ? maxSourceProofAgeMinutesInput : maxLivePreapplyAgeMinutes;
const expectedLiveClusterIdentityJson = String(process.env.CAS_RELEASE_EXPECTED_CLUSTER_IDENTITY_JSON || "").trim();
const strictApprovedPbsRemotePattern = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)souluk319\/PBS_DEV_Part3(?:\.git)?$/i;
const approvedCywellRemotePattern = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)souluk319\/Cywell-AIOps_Agent(?:\.git)?$/i;
const approvedPbsSourceHead = "6604777abb9e6bd44a83c6a12f36e31ac396489e";
const maxEvidenceFutureSkewMs = 5 * 60 * 1000;

const requiredLocalEvidence = [
  ["crcDeployment", "cas-crc-deployment.json", "CRC deployment evidence"],
  ["releaseImages", "cas-release-images.json", "CRC release image promotion evidence"],
  ["deployManifests", "cas-deploy-manifests.json", "deployment manifest verification evidence"],
  ["livePrereqsRender", "cas-pbs-live-prereqs-render.json", "PBS live prerequisite real-render evidence"],
  ["sourceContract", "cas-pbs-source-contract-pinned.json", "strict pinned PBS source contract evidence"]
];

const livePreapplyEvidence = [
  "livePreapply",
  "cas-pbs-preflight-pbs-live-site-preapply-cluster-required-secrets.json",
  "strict PBS live generated-site pre-apply evidence"
];

const liveClusterCutoverEvidence = [
  "liveClusterCutover",
  "cas-pbs-live-smoke-cluster-cutover.json",
  "strict PBS live cluster cutover smoke evidence"
];

const expectedLivePrereqOutputDir = "test-results/pbs-live-prereqs";
const expectedGeneratedSiteOverlayPath = "test-results/pbs-live-prereqs/pbs-live-site";
const requiredLivePrereqOutputFileKeys = [
  "pbsAuthSecret",
  "ownerAuthSecret",
  "postgresSecret",
  "liveConfig",
  "customerAccessJson",
  "siteKustomization",
  "siteCustomerAccessJson",
  "summary"
];
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

function runGit(gitArgs) {
  const result = spawnSync("git", gitArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function runCommand(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: options.timeoutMs ?? 90000,
    windowsHide: true
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? ""
  };
}

function gitMetadata() {
  const status = runGit(["status", "--short"]);
  return {
    branch: runGit(["branch", "--show-current"]),
    head: runGit(["rev-parse", "--short", "HEAD"]),
    fullHead: runGit(["rev-parse", "HEAD"]),
    treeStatus: status ? "dirty" : "clean",
    statusShort: status
  };
}

function sha256Text(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function normalizePath(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

function assertOutputUnderTestResults(targetDir) {
  const root = resolve("test-results");
  const target = resolve(targetDir);
  const targetRelative = relative(root, target);
  if (targetRelative.startsWith("..") || targetRelative === "" || resolve(target) === root) {
    throw new Error(`refusing to write cutover bundle outside a child of test-results/: ${target}`);
  }
}

function readEvidence(baseDir, [key, fileName, label]) {
  const path = join(baseDir, fileName);
  if (!existsSync(path)) {
    return {
      key,
      label,
      path,
      fileName,
      exists: false,
      status: "MISSING",
      checkedAt: "",
      summary: {},
      failedChecks: [],
      warnedChecks: [],
      sha256: ""
    };
  }
  let json;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      key,
      label,
      path,
      fileName,
      exists: true,
      status: "INVALID",
      checkedAt: "",
      summary: {},
      failedChecks: [{ id: `${key}:invalid-json`, detail: error.message }],
      warnedChecks: [],
      sha256: sha256File(path)
    };
  }
  const checks = Array.isArray(json.checks) ? json.checks : [];
  return {
    key,
    label,
    path,
    fileName,
    exists: true,
    status: String(json.status ?? "UNKNOWN"),
    checkedAt: String(json.checkedAt ?? ""),
    branch: json.branch,
    head: json.head,
    fullHead: json.fullHead,
    treeStatus: json.treeStatus,
    mode: json.mode,
    evidenceMode: json.evidenceMode,
    cutover: json.cutover,
    clusterSmoke: json.clusterSmoke,
    writeSmoke: json.writeSmoke,
    readOnlyException: json.readOnlyException,
    namespace: json.namespace,
    releaseTag: json.releaseTag,
    sourceClusterIdentity: json.sourceClusterIdentity,
    cywellSource: json.cywellSource,
    outputDir: json.outputDir,
    overlay: json.overlay,
    overlayPath: json.overlayPath,
    requireCluster: json.requireCluster,
    requireSecret: json.requireSecret,
    skipApplied: json.skipApplied,
    outputFileSha256: json.outputFileSha256,
    renderedSiteOverlaySha256: json.renderedSiteOverlaySha256,
    redactedSummarySha256: json.redactedSummarySha256,
    pbsPinnedSourceEvidencePath: json.pbsPinnedSourceEvidencePath,
    pbsRuntimeSourceEvidence: json.pbsRuntimeSourceEvidence,
    requireSource: json.requireSource,
    requireCleanSource: json.requireCleanSource,
    requireExpectedHead: json.requireExpectedHead,
    summary: json.summary ?? {},
    clusterIdentity: json.clusterIdentity,
    checkStatuses: checks.map((check) => ({ id: String(check.id ?? ""), status: String(check.status ?? "") })),
    passedCheckIds: checks.filter((check) => check?.status === "PASS").map((check) => String(check.id ?? "")),
    pbsSource: json.pbsSource
      ? {
          branch: json.pbsSource.branch,
          head: json.pbsSource.head,
          fullHead: json.pbsSource.fullHead,
          remoteOriginUrl: json.pbsSource.remoteOriginUrl,
          remoteContainsExpectedHead: json.pbsSource.remoteContainsExpectedHead,
          remoteRefsContainingExpectedHead: json.pbsSource.remoteRefsContainingExpectedHead,
          remoteVerifiedAt: json.pbsSource.remoteVerifiedAt,
          remoteFetchOk: json.pbsSource.remoteFetchOk,
          remoteVerificationError: json.pbsSource.remoteVerificationError,
          treeStatus: json.pbsSource.treeStatus,
          requireCleanSource: json.pbsSource.requireCleanSource,
          expectedHead: json.pbsSource.expectedHead,
          contractFileSha256: json.pbsSource.contractFileSha256
        }
      : undefined,
    failedChecks: checks
      .filter((check) => check?.status === "FAIL")
      .map((check) => ({ id: String(check.id ?? ""), detail: String(check.detail ?? "") })),
    warnedChecks: checks
      .filter((check) => check?.status === "WARN")
      .map((check) => ({ id: String(check.id ?? ""), detail: String(check.detail ?? "") })),
    sha256: sha256File(path)
  };
}

function blockerAction(blocker) {
  const id = blocker.id || "";
  const detail = blocker.detail || "";
  if (id.includes("live-preapply-generated-site")) {
    return "After real live prereqs are rendered, rerun npm run verify:pbs:preflight:live:site:preapply with the same CAS_PBS_LIVE_PREREQS_OUT_DIR so the generated site overlay hash binds to the prereq evidence.";
  }
  if (id.includes("live-prereq-secret-hash-binding")) {
    return "Apply the reviewed live prereq Secret manifests generated by render:pbs:live-prereqs, then rerun live-site preapply so cluster Secret hashes match the redacted summary.";
  }
  if (id.includes("livePrereqsRender") || id.includes("live-prereqs")) return "Regenerate real live prereq evidence with npm run render:pbs:live-prereqs after approved Secret/ACL/Postgres inputs are supplied.";
  if (id.includes("live-runtime-source-revision")) return "Stamp every ready PBS runtime pod with the approved PBS full SHA using an accepted annotation, label, or env value, then rerun live-site preapply.";
  if (id.includes("source-contract-pinned")) return "Regenerate pinned source evidence with CAS_PBS_SOURCE_HEAD on the approved clean PBS checkout, verify the approved remote ref contains that SHA, and resolve any exact contract-file hash-set drift.";
  if (id.includes("pbs-namespace")) return "Deploy or grant access to the real playbookstudio namespace.";
  if (id.includes("pbs-runtime-service")) return "Expose playbookstudio-runtime on port 8765 with the required runtime labels and ready Endpoints.";
  if (id.includes("pbs-auth-secret")) return "Create cas-pbs-auth/bearer-token from approved secret material outside git.";
  if (id.includes("knowledge-postgres-live-secret")) return "Create cas-knowledge-postgres-live with matching database, username, password, and database-url keys.";
  if (id.includes("legacy-postgres-secret")) return "Delete or prune the legacy CRC cas-knowledge-postgres dev Secret before live apply.";
  if (id.includes("release-image")) return "Regenerate CRC release image evidence and ensure v0.1.4 ImageStreamTags match promoted digests.";
  if (id.includes("customer-acl")) return "Render concrete customer workspace ACL policy through render:pbs:live-prereqs.";
  return detail;
}

function uniqueActions(blockers) {
  return [...new Set(blockers.map(blockerAction).filter(Boolean))];
}

function uniqueBlockers(blockers) {
  const seen = new Set();
  return blockers.filter((blocker) => {
    const key = `${blocker.id || ""}\n${blocker.detail || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function commandPlan() {
  return [
    "npm run verify",
    "npm run deploy:crc",
    "$env:CAS_RELEASE_FORCE=\"true\"; npm run release:crc:v0.1.4",
    "$env:CAS_PBS_LIVE_PREREQS_OUT_DIR=\"C:\\\\secure-handoff\\\\pbs-live-prereqs\"",
    "npm run render:pbs:live-prereqs",
    "$env:CAS_PBS_SOURCE_HEAD=\"6604777abb9e6bd44a83c6a12f36e31ac396489e\"; npm run verify:release:source-pinning",
    "npm run verify:pbs:preflight:live:site:preapply",
    "oc apply -k \"$env:CAS_PBS_LIVE_PREREQS_OUT_DIR\\pbs-live-site\"",
    "npm run verify:pbs:preflight:live:site",
    "npm run verify:pbs:cutover:cluster",
    "node ./scripts/render-pbs-cutover-bundle.mjs --require-live-ready",
    "npm run verify:release:pbs-live"
  ];
}

function currentHeadMatches(evidence, meta) {
  if (!evidence.exists || !evidence.fullHead || !meta.fullHead) return false;
  return evidence.fullHead === meta.fullHead;
}

const clusterIdentityFields = ["server", "namespace", "namespaceUid", "infrastructureName"];

function completeClusterIdentity(identity) {
  return Boolean(identity && clusterIdentityFields.every((field) => String(identity[field] ?? "").trim()));
}

function clusterIdentityMatches(expected = {}, actual = {}) {
  return clusterIdentityFields.every((field) => String(expected[field] ?? "") === String(actual[field] ?? ""));
}

function clusterIdentitySummary(identity = {}) {
  return clusterIdentityFields.map((field) => `${field}=${identity[field] ?? "missing"}`).join(", ");
}

function expectedLiveClusterIdentity() {
  if (!expectedLiveClusterIdentityJson) return null;
  try {
    return JSON.parse(expectedLiveClusterIdentityJson);
  } catch {
    return { invalid: true };
  }
}

function evidenceTimeMs(evidence) {
  const value = Date.parse(String(evidence?.checkedAt ?? ""));
  return Number.isFinite(value) ? value : 0;
}

function livePreapplyTimingValid(livePreapply, livePrereqsRender, releaseImages) {
  const preapplyTime = evidenceTimeMs(livePreapply);
  if (!preapplyTime) return false;
  const maxAgeMs = Math.max(1, maxLivePreapplyAgeMinutes) * 60 * 1000;
  const now = Date.parse(checkedAt);
  if (preapplyTime > now + maxEvidenceFutureSkewMs) return false;
  if (now - preapplyTime > maxAgeMs) return false;
  const prerequisiteTimes = [livePrereqsRender, releaseImages].map(evidenceTimeMs).filter(Boolean);
  if (prerequisiteTimes.some((time) => time > now + maxEvidenceFutureSkewMs)) return false;
  return prerequisiteTimes.every((time) => preapplyTime >= time);
}

function sourceContractTimingValid(evidence) {
  const sourceTime = evidenceTimeMs(evidence);
  const remoteTime = Date.parse(String(evidence?.pbsSource?.remoteVerifiedAt ?? ""));
  if (!sourceTime || !Number.isFinite(remoteTime)) return false;
  const maxAgeMs = Math.max(1, maxSourceProofAgeMinutes) * 60 * 1000;
  const now = Date.parse(checkedAt);
  if (sourceTime > now + maxEvidenceFutureSkewMs || remoteTime > now + maxEvidenceFutureSkewMs) return false;
  if (now - sourceTime > maxAgeMs || now - remoteTime > maxAgeMs) return false;
  const oneMinuteMs = 60 * 1000;
  return Math.abs(remoteTime - sourceTime) <= oneMinuteMs;
}

function releaseImagesCywellSourcePinned(evidence) {
  const source = evidence?.cywellSource ?? {};
  const remoteTime = evidenceTimeMs({ checkedAt: source.remoteVerifiedAt });
  const maxAgeMs = Math.max(1, maxSourceProofAgeMinutes) * 60 * 1000;
  const now = Date.parse(checkedAt);
  return Boolean(
    source.remoteApproved === true &&
      source.remoteFetchOk === true &&
      source.remoteContainsHead === true &&
      Array.isArray(source.remoteRefsContainingHead) &&
      source.remoteRefsContainingHead.some((ref) => typeof ref === "string" && ref.startsWith("origin/")) &&
      typeof source.remoteVerifiedAt === "string" &&
      remoteTime &&
      remoteTime <= now + maxEvidenceFutureSkewMs &&
      now - remoteTime <= maxAgeMs &&
      approvedCywellRemotePattern.test(String(source.remoteOriginUrl ?? "").trim())
  );
}

function clusterEvidenceFailures(artifacts, liveReadyRequired = requireLiveReady) {
  const failures = [];
  const clusterArtifacts = [
    ["crcDeployment", artifacts.crcDeployment],
    ["releaseImages", artifacts.releaseImages],
    ["livePreapply", artifacts.livePreapply],
    ["liveClusterCutover", artifacts.liveClusterCutover]
  ].filter(([, evidence]) => evidence?.exists);
  const anchor = artifacts.crcDeployment?.exists ? artifacts.crcDeployment : clusterArtifacts.find(([, evidence]) => completeClusterIdentity(evidence.clusterIdentity))?.[1];
  if (!anchor) return failures;
  if (!completeClusterIdentity(anchor.clusterIdentity)) {
    failures.push({
      id: `cutover-bundle:${anchor.key}:cluster-identity`,
      detail: `${anchor.fileName} must record full clusterIdentity before live cutover evidence can be bundled`
    });
    return failures;
  }
  const expectedClusterIdentity = expectedLiveClusterIdentity();
  if (liveReadyRequired && !expectedLiveClusterIdentityJson) {
    failures.push({
      id: "cutover-bundle:expected-live-cluster-required",
      detail: "CAS_RELEASE_EXPECTED_CLUSTER_IDENTITY_JSON must be set for --require-live-ready so live cutover evidence cannot be assembled for the wrong cluster or namespace"
    });
  } else if (expectedClusterIdentity?.invalid || (expectedClusterIdentity && !completeClusterIdentity(expectedClusterIdentity))) {
    failures.push({
      id: "cutover-bundle:expected-live-cluster-invalid",
      detail: "CAS_RELEASE_EXPECTED_CLUSTER_IDENTITY_JSON must be valid JSON with server, namespace, namespaceUid, and infrastructureName"
    });
  } else if (expectedClusterIdentity && !clusterIdentityMatches(expectedClusterIdentity, anchor.clusterIdentity)) {
    failures.push({
      id: "cutover-bundle:expected-live-cluster",
      detail: `${anchor.fileName} clusterIdentity (${clusterIdentitySummary(anchor.clusterIdentity)}) does not match expected live cluster (${clusterIdentitySummary(expectedClusterIdentity)})`
    });
  }
  for (const [key, evidence] of clusterArtifacts) {
    if (!completeClusterIdentity(evidence.clusterIdentity)) {
      failures.push({
        id: `cutover-bundle:${key}:cluster-identity`,
        detail: `${evidence.fileName} must record full clusterIdentity before live cutover evidence can be bundled`
      });
    } else if (!clusterIdentityMatches(anchor.clusterIdentity, evidence.clusterIdentity)) {
      failures.push({
        id: `cutover-bundle:${key}:cluster-identity`,
        detail: `${evidence.fileName} clusterIdentity (${clusterIdentitySummary(evidence.clusterIdentity)}) does not match ${anchor.fileName} (${clusterIdentitySummary(anchor.clusterIdentity)})`
      });
    }
  }
  const releaseImages = artifacts.releaseImages;
  if (releaseImages?.exists) {
    if (!releaseImagesCywellSourcePinned(releaseImages)) {
      failures.push({
        id: "cutover-bundle:releaseImages:cywell-source-pinned",
        detail: `${releaseImages.fileName} must prove the Cywell release HEAD is contained in an approved fetched origin/* ref before live cutover`
      });
    }
    if (!completeClusterIdentity(releaseImages.sourceClusterIdentity)) {
      failures.push({
        id: "cutover-bundle:releaseImages:source-cluster-identity",
        detail: `${releaseImages.fileName} must record sourceClusterIdentity from the CRC deployment evidence`
      });
    } else if (!clusterIdentityMatches(releaseImages.clusterIdentity, releaseImages.sourceClusterIdentity)) {
      failures.push({
        id: "cutover-bundle:releaseImages:source-cluster-identity",
        detail: `${releaseImages.fileName} clusterIdentity does not match its sourceClusterIdentity`
      });
    }
  }
  return failures;
}

function resolveEvidencePath(baseDir, recordedPath) {
  const normalized = normalizePath(recordedPath);
  if (!normalized) return "";
  if (normalized.startsWith("test-results/")) return resolve(baseDir, normalized.slice("test-results/".length));
  return resolve(recordedPath);
}

function resolvedPathUnder(baseDir, recordedPath, expectedDir) {
  const actualPath = resolveEvidencePath(baseDir, recordedPath);
  const expectedRoot = resolveEvidencePath(baseDir, expectedDir);
  const pathRelativeToRoot = relative(expectedRoot, actualPath);
  return Boolean(pathRelativeToRoot) && !pathRelativeToRoot.startsWith("..") && !isAbsolute(pathRelativeToRoot);
}

function generatedSiteOverlayPath(livePrereqsRender = {}) {
  const outputDir = normalizePath(livePrereqsRender.outputDir || expectedLivePrereqOutputDir).replace(/\/+$/, "");
  return normalizePath(`${outputDir}/pbs-live-site`);
}

function renderedSiteOverlayHash(baseDir, siteOverlayPath = expectedGeneratedSiteOverlayPath) {
  const overlayPath = resolveEvidencePath(baseDir, siteOverlayPath);
  const attempts = [
    ["oc", ["kustomize", overlayPath]],
    ["kubectl", ["kustomize", overlayPath]]
  ];
  for (const [command, commandArgs] of attempts) {
    const result = runCommand(command, commandArgs);
    if (result.ok && result.stdout.trim()) return sha256Text(result.stdout);
  }
  return "";
}

function recordedFileHashesMatch(evidence, baseDir) {
  const files = evidence.outputFileSha256;
  if (!files || typeof files !== "object") return false;
  return Object.values(files).every((file) => {
    const actualPath = resolveEvidencePath(baseDir, file?.path);
    return file?.path && existsSync(actualPath) && sha256File(actualPath) === file.sha256;
  });
}

function hasRealRenderHashes(evidence, baseDir) {
  const files = evidence.outputFileSha256;
  const fileKeys = files && typeof files === "object" ? Object.keys(files).sort() : [];
  const expectedKeys = [...requiredLivePrereqOutputFileKeys].sort();
  const outputDir = normalizePath(evidence.outputDir);
  const siteOverlayPath = generatedSiteOverlayPath(evidence);
  const pathUnder = (file, expectedDir) => {
    return file?.underOutputDir === true && resolvedPathUnder(baseDir, file?.path, expectedDir);
  };
  const allFilesUnderOutputDir = outputDir && Object.values(files ?? {}).every((file) => pathUnder(file, outputDir));
  const siteFilesUnderGeneratedOverlay = ["siteKustomization", "siteCustomerAccessJson"].every((key) => pathUnder(files?.[key], siteOverlayPath));
  return (
    evidence.mode === "real-render" &&
    Boolean(outputDir) &&
    typeof evidence.renderedSiteOverlaySha256 === "string" &&
    evidence.renderedSiteOverlaySha256.length >= 32 &&
    typeof evidence.redactedSummarySha256 === "string" &&
    evidence.redactedSummarySha256.length >= 32 &&
    files &&
    typeof files === "object" &&
    fileKeys.length === expectedKeys.length &&
    fileKeys.every((key, index) => key === expectedKeys[index]) &&
    Object.values(files).every((file) => file && typeof file.sha256 === "string" && file.sha256.length >= 32) &&
    allFilesUnderOutputDir &&
    siteFilesUnderGeneratedOverlay &&
    recordedFileHashesMatch(evidence, baseDir) &&
    evidence.renderedSiteOverlaySha256 === renderedSiteOverlayHash(baseDir, siteOverlayPath) &&
    sha256File(resolveEvidencePath(baseDir, files.summary.path)) === evidence.redactedSummarySha256
  );
}

function isStrictGeneratedSitePreapply(evidence, meta, livePrereqsRender, baseDir) {
  const siteOverlayPath = generatedSiteOverlayPath(livePrereqsRender);
  const currentSiteOverlayHash = renderedSiteOverlayHash(baseDir, siteOverlayPath);
  return Boolean(
    evidence.exists &&
      evidence.fullHead === meta.fullHead &&
      evidence.treeStatus === "clean" &&
      evidence.overlay === "pbs-live" &&
      normalizePath(evidence.overlayPath) === siteOverlayPath &&
      evidence.renderedSiteOverlaySha256 &&
      evidence.renderedSiteOverlaySha256 === livePrereqsRender?.renderedSiteOverlaySha256 &&
      evidence.renderedSiteOverlaySha256 === currentSiteOverlayHash &&
      evidence.requireCluster === true &&
      evidence.requireSecret === true &&
      evidence.skipApplied === true
  );
}

function sourceContractPinned(evidence) {
  const pbsSource = evidence.pbsSource;
  const hashes = pbsSource?.contractFileSha256 ?? {};
  const hashKeys = Object.keys(hashes).sort();
  const expectedKeys = [...requiredPbsContractFiles].sort();
  const exactHashSet =
    hashKeys.length === expectedKeys.length &&
    expectedKeys.every((key, index) => hashKeys[index] === key && /^[a-f0-9]{64}$/i.test(String(hashes[key] ?? "")));
  return Boolean(
    evidence.requireSource &&
      evidence.requireCleanSource &&
      evidence.requireExpectedHead &&
      pbsSource?.requireCleanSource === true &&
      pbsSource?.treeStatus === "clean" &&
      /^[a-f0-9]{40}$/i.test(String(pbsSource?.expectedHead ?? "")) &&
      /^[a-f0-9]{40}$/i.test(String(pbsSource?.fullHead ?? "")) &&
      pbsSource.fullHead === pbsSource.expectedHead &&
      pbsSource.expectedHead === approvedPbsSourceHead &&
      approvedPbsRemoteUrl(pbsSource?.remoteOriginUrl) &&
      pbsSource.remoteFetchOk === true &&
      pbsSource.remoteContainsExpectedHead === true &&
      Array.isArray(pbsSource.remoteRefsContainingExpectedHead) &&
      pbsSource.remoteRefsContainingExpectedHead.some((ref) => typeof ref === "string" && ref.startsWith("origin/")) &&
      typeof pbsSource.remoteVerifiedAt === "string" &&
      sourceContractTimingValid(evidence) &&
      exactHashSet
  );
}

function approvedPbsRemoteUrl(value) {
  const remote = String(value ?? "").trim();
  return Boolean(remote && strictApprovedPbsRemotePattern.test(remote));
}

function livePreapplyRuntimeSourceMatches(livePreapply, sourceContract) {
  const expectedHead = sourceContract?.pbsSource?.expectedHead;
  const runtimeSources = Array.isArray(livePreapply?.pbsRuntimeSourceEvidence) ? livePreapply.pbsRuntimeSourceEvidence : [];
  return Boolean(
    /^[a-f0-9]{40}$/i.test(String(expectedHead ?? "")) &&
      runtimeSources.length > 0 &&
      runtimeSources.every((source) => source?.revision === expectedHead)
  );
}

function buildBundle(baseDir = evidenceDir, meta = gitMetadata(), options = {}) {
  const liveReadyRequired = options.requireLiveReady ?? requireLiveReady;
  const artifacts = Object.fromEntries(
    [...requiredLocalEvidence, livePreapplyEvidence, liveClusterCutoverEvidence].map((descriptor) => {
      const evidence = readEvidence(baseDir, descriptor);
      return [evidence.key, evidence];
    })
  );

  const localGateFailures = [];
  if (meta.treeStatus !== "clean" && !allowDirty) {
    localGateFailures.push({ id: "cutover-bundle:git-tree-clean", detail: "current git tree is dirty; commit and rerun release evidence before bundling cutover proof" });
  }
  if (liveReadyRequired && allowDirty) {
    localGateFailures.push({ id: "cutover-bundle:allow-dirty-live-ready", detail: "live-ready cutover bundles cannot be rendered with --allow-dirty or CAS_PBS_CUTOVER_BUNDLE_ALLOW_DIRTY" });
  }
  for (const [key] of requiredLocalEvidence) {
    const evidence = artifacts[key];
    if (!evidence.exists) localGateFailures.push({ id: `cutover-bundle:${key}:missing`, detail: `${evidence.fileName} is missing` });
    else if (evidence.status !== "PASS") localGateFailures.push({ id: `cutover-bundle:${key}:status`, detail: `${evidence.fileName} status is ${evidence.status}, expected PASS` });
    if (evidence.exists && evidence.treeStatus !== "clean") {
      localGateFailures.push({ id: `cutover-bundle:${key}:clean-source`, detail: `${evidence.fileName} must be produced from a clean git tree; found ${evidence.treeStatus || "missing"}` });
    }
    if (!currentHeadMatches(evidence, meta)) {
      localGateFailures.push({ id: `cutover-bundle:${key}:head`, detail: `${evidence.fileName} head ${evidence.head || evidence.fullHead || "missing"} does not match current HEAD ${meta.head}` });
    }
  }
  localGateFailures.push(...clusterEvidenceFailures(artifacts, liveReadyRequired));
  const livePrereqsRender = artifacts.livePrereqsRender;
  if (livePrereqsRender?.exists && !hasRealRenderHashes(livePrereqsRender, baseDir)) {
    localGateFailures.push({
      id: "cutover-bundle:live-prereqs-real-render",
      detail: "cas-pbs-live-prereqs-render.json must be produced by render:pbs:live-prereqs and its recorded output, site-overlay, and redacted-summary hashes must match the current generated files"
    });
  }
  if (livePrereqsRender?.exists && livePrereqsRender.treeStatus !== "clean") {
    localGateFailures.push({
      id: "cutover-bundle:live-prereqs-clean-source",
      detail: `cas-pbs-live-prereqs-render.json was generated from ${livePrereqsRender.treeStatus || "unknown"} Cywell source`
    });
  }
  const sourceContract = artifacts.sourceContract;
  if (sourceContract?.exists && !sourceContractPinned(sourceContract)) {
    localGateFailures.push({
      id: "cutover-bundle:source-contract-pinned",
      detail: `cas-pbs-source-contract-pinned.json must come from verify:release:source-pinning with clean PBS source, CAS_PBS_SOURCE_HEAD, approved remote identity, successful fresh remote fetch, and approved remote ref containment proof no older than ${maxSourceProofAgeMinutes} minutes`
    });
  }

  const livePreapply = artifacts.livePreapply;
  if (livePreapply?.exists && sourceContract?.exists && !livePreapplyRuntimeSourceMatches(livePreapply, sourceContract)) {
    localGateFailures.push({
      id: "cutover-bundle:live-runtime-source-revision",
      detail: `${livePreapply.fileName} must record ready PBS runtime pods stamped with the same full SHA as ${sourceContract.fileName}`
    });
  }
  if (livePreapply?.exists && !isStrictGeneratedSitePreapply(livePreapply, meta, livePrereqsRender, baseDir)) {
    localGateFailures.push({
      id: "cutover-bundle:live-preapply-generated-site",
      detail: `${livePreapply.fileName} must be current clean generated-site preapply evidence for ${generatedSiteOverlayPath(livePrereqsRender)} with cluster, required-secret, skip-applied flags, and the same rendered site-overlay hash as current live prerequisite evidence`
    });
  }
  if (livePreapply?.exists && !livePreapplyTimingValid(livePreapply, livePrereqsRender, artifacts.releaseImages)) {
    localGateFailures.push({
      id: "cutover-bundle:live-preapply-fresh",
      detail: `${livePreapply.fileName} must be newer than release/prereq evidence and no older than ${maxLivePreapplyAgeMinutes} minutes`
    });
  }
  const liveClusterCutover = artifacts.liveClusterCutover;
  if (liveReadyRequired) {
    if (!liveClusterCutover?.exists) {
      localGateFailures.push({
        id: "cutover-bundle:live-cluster-cutover-smoke-missing",
        detail: `${liveClusterCutoverEvidence[1]} is required for --require-live-ready so the bundle proves post-apply upload -> RAG -> LLM Wiki -> topology lineage`
      });
    } else if (liveClusterCutover.status !== "PASS") {
      localGateFailures.push({
        id: "cutover-bundle:live-cluster-cutover-smoke-status",
        detail: `${liveClusterCutover.fileName} status is ${liveClusterCutover.status}, expected PASS`
      });
    }
    if (liveClusterCutover?.exists && liveClusterCutover.mode !== "cluster-cutover") {
      localGateFailures.push({
        id: "cutover-bundle:live-cluster-cutover-smoke-mode",
        detail: `${liveClusterCutover.fileName} must be generated by verify-pbs-live-smoke.mjs --cutover --cluster`
      });
    }
    if (
      liveClusterCutover?.exists &&
      (liveClusterCutover.cutover !== true ||
        liveClusterCutover.clusterSmoke !== true ||
        liveClusterCutover.writeSmoke !== true ||
        liveClusterCutover.readOnlyException === true)
    ) {
      localGateFailures.push({
        id: "cutover-bundle:live-cluster-cutover-smoke-write-lineage",
        detail: `${liveClusterCutover.fileName} must be generated by write-enabled verify-pbs-live-smoke.mjs --cutover --cluster without a read-only exception`
      });
    }
    if (
      liveClusterCutover?.exists &&
      !liveClusterCutover.checkStatuses?.some((check) => check.id === "pbs-live:cluster-write-lineage" && check.status === "PASS")
    ) {
      localGateFailures.push({
        id: "cutover-bundle:live-cluster-cutover-smoke-lineage-check",
        detail: `${liveClusterCutover.fileName} must include PASS pbs-live:cluster-write-lineage evidence for upload -> RAG -> LLM Wiki -> topology lineage`
      });
    }
    if (liveClusterCutover?.exists && !currentHeadMatches(liveClusterCutover, meta)) {
      localGateFailures.push({
        id: "cutover-bundle:live-cluster-cutover-smoke-head",
        detail: `${liveClusterCutover.fileName} head ${liveClusterCutover.head || liveClusterCutover.fullHead || "missing"} does not match current HEAD ${meta.head}`
      });
    }
    if (liveClusterCutover?.exists && liveClusterCutover.treeStatus !== "clean") {
      localGateFailures.push({
        id: "cutover-bundle:live-cluster-cutover-smoke-clean-source",
        detail: `${liveClusterCutover.fileName} must be produced from a clean git tree; found ${liveClusterCutover.treeStatus || "missing"}`
      });
    }
  }
  const liveBlockers = livePreapply.failedChecks ?? [];
  const localActions = uniqueActions(localGateFailures);
  const externalActions = uniqueActions(liveBlockers);
  let status = "PASS";
  let phase = "live-preapply-ready";
  if (localGateFailures.length > 0) {
    status = "FAIL";
    phase = "local-evidence-invalid";
  } else if (!livePreapply.exists) {
    status = "INCOMPLETE";
    phase = "live-preapply-evidence-missing";
  } else if (livePreapply.status === "PASS") {
    status = "PASS";
    phase = "live-preapply-ready";
  } else {
    status = "BLOCKED";
    phase = "external-live-prerequisites-missing";
  }

  const blockers = uniqueBlockers([...localGateFailures, ...liveBlockers]);
  const artifactSummary = Object.values(artifacts).map((artifact) => ({
    key: artifact.key,
    path: artifact.path,
    exists: artifact.exists,
    status: artifact.status,
    checkedAt: artifact.checkedAt,
    head: artifact.head,
    mode: artifact.mode,
    treeStatus: artifact.treeStatus,
    clusterIdentity: artifact.clusterIdentity,
    sourceClusterIdentity: artifact.sourceClusterIdentity,
    pbsSource: artifact.pbsSource,
    summary: artifact.summary,
    sha256: artifact.sha256,
    failed: artifact.failedChecks.length,
    warned: artifact.warnedChecks.length
  }));

  return {
    checkedAt,
    status,
    phase,
    branch: meta.branch,
    head: meta.head,
    fullHead: meta.fullHead,
    treeStatus: meta.treeStatus,
    requireLiveReady: liveReadyRequired,
    artifacts,
    artifactSummary,
    localGateFailures,
    externalLiveBlockers: liveBlockers,
    blockers,
    nextActions: [...new Set([...localActions, ...externalActions])],
    commandPlan: commandPlan(),
    notes: [
      "This bundle contains redacted evidence metadata and hashes only; raw Secret values are not copied.",
      "BLOCKED means CRC/release evidence is coherent but strict live pre-apply still needs external PBS runtime or Secret state.",
      "FAIL/local-evidence-invalid means local proof is not live-ready yet; external live pre-apply blockers are still reported separately when evidence exists.",
      "PASS means local evidence is current and strict live pre-apply evidence is PASS; --require-live-ready additionally requires cluster cutover smoke evidence for upload -> RAG -> LLM Wiki -> topology lineage."
    ]
  };
}

function markdownSummary(bundle) {
  const lines = [
    "# PBS Live Cutover Evidence Bundle",
    "",
    `- status: ${bundle.status}`,
    `- phase: ${bundle.phase}`,
    `- branch: ${bundle.branch}`,
    `- head: ${bundle.head}`,
    `- treeStatus: ${bundle.treeStatus}`,
    "",
    "## Artifacts",
    "",
    "| key | status | checks | sha256 |",
    "| --- | --- | --- | --- |"
  ];
  for (const artifact of bundle.artifactSummary) {
    const checks = artifact.summary?.total === undefined ? "" : `${artifact.summary.passed ?? 0}/${artifact.summary.total ?? 0} passed`;
    lines.push(`| ${artifact.key} | ${artifact.status} | ${checks} | ${artifact.sha256 ? artifact.sha256.slice(0, 16) : ""} |`);
  }
  lines.push("", "## Local Evidence Blockers", "");
  if (bundle.localGateFailures.length === 0) lines.push("- none");
  for (const blocker of bundle.localGateFailures) lines.push(`- ${blocker.id}: ${blocker.detail}`);
  lines.push("", "## External Live Preapply Blockers", "");
  if (bundle.externalLiveBlockers.length === 0) lines.push("- none");
  for (const blocker of bundle.externalLiveBlockers) lines.push(`- ${blocker.id}: ${blocker.detail}`);
  lines.push("", "## Active Blockers", "");
  if (bundle.blockers.length === 0) lines.push("- none");
  for (const blocker of bundle.blockers) lines.push(`- ${blocker.id}: ${blocker.detail}`);
  lines.push("", "## Next Actions", "");
  if (bundle.nextActions.length === 0) lines.push("- none");
  for (const action of bundle.nextActions) lines.push(`- ${action}`);
  lines.push("", "## Command Plan", "");
  for (const command of bundle.commandPlan) lines.push(`- \`${command}\``);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function runSelfTest() {
  const tempRoot = await mkdtemp(join(tmpdir(), "cas-pbs-cutover-bundle-"));
  try {
    const write = (name, json) => writeFileSync(join(tempRoot, name), `${JSON.stringify(json, null, 2)}\n`);
    const clusterIdentity = {
      server: "https://api.example.invalid:6443",
      namespace: "cywell-ai-sentinel",
      namespaceUid: "namespace-uid-1",
      infrastructureName: "crc-test"
    };
    const base = {
      checkedAt,
      branch: "v0.1.4",
      head: "abc1234",
      fullHead: "abc1234",
      treeStatus: "clean",
      clusterIdentity,
      sourceClusterIdentity: clusterIdentity,
      status: "PASS",
      summary: { total: 1, passed: 1, failed: 0 },
      checks: [{ status: "PASS", id: "ok", detail: "ok" }],
      cywellSource: {
        remoteOriginUrl: "git@github.com:souluk319/Cywell-AIOps_Agent.git",
        remoteApproved: true,
        remoteFetchOk: true,
        remoteContainsHead: true,
        remoteRefsContainingHead: ["origin/v0.1.4"],
        remoteVerifiedAt: checkedAt
      }
    };
    const pbsFullHead = approvedPbsSourceHead;
    const pbsShortHead = pbsFullHead.slice(0, 7);
    const contractFileSha256 = Object.fromEntries(requiredPbsContractFiles.map((file) => [file, sha256Text(file)]));
    const approvedPbsRemote = "git@github.com:souluk319/PBS_DEV_Part3.git";
    const pinnedPbsSource = (overrides = {}) => ({
      branch: "main",
      head: pbsShortHead,
      fullHead: pbsFullHead,
      remoteOriginUrl: approvedPbsRemote,
      remoteContainsExpectedHead: true,
      remoteRefsContainingExpectedHead: ["origin/main"],
      remoteVerifiedAt: checkedAt,
      remoteFetchOk: true,
      treeStatus: "clean",
      requireCleanSource: true,
      expectedHead: pbsFullHead,
      contractFileSha256,
      ...overrides
    });
    const tempEvidencePath = (recordedPath) => join(tempRoot, normalizePath(recordedPath).replace(/^test-results\//, ""));
    const writeTempEvidenceFile = (recordedPath, content) => {
      const actualPath = tempEvidencePath(recordedPath);
      mkdirSync(dirname(actualPath), { recursive: true });
      writeFileSync(actualPath, content);
      return actualPath;
    };
    const livePrereqFilePaths = {
      pbsAuthSecret: `${expectedLivePrereqOutputDir}/cas-pbs-auth.secret.yaml`,
      ownerAuthSecret: `${expectedLivePrereqOutputDir}/cas-knowledge-internal-auth.secret.yaml`,
      postgresSecret: `${expectedLivePrereqOutputDir}/cas-knowledge-postgres-live.secret.yaml`,
      liveConfig: `${expectedLivePrereqOutputDir}/cas-knowledge-live-config.configmap.yaml`,
      customerAccessJson: `${expectedLivePrereqOutputDir}/customer-access.json`,
      siteKustomization: `${expectedGeneratedSiteOverlayPath}/kustomization.yaml`,
      siteCustomerAccessJson: `${expectedGeneratedSiteOverlayPath}/customer-access.json`,
      summary: `${expectedLivePrereqOutputDir}/pbs-live-prereqs.summary.json`
    };
    const livePrereqFileContent = {
      pbsAuthSecret: "apiVersion: v1\nkind: Secret\nmetadata:\n  name: cas-pbs-auth\n",
      ownerAuthSecret: "apiVersion: v1\nkind: Secret\nmetadata:\n  name: cas-knowledge-internal-auth\n",
      postgresSecret: "apiVersion: v1\nkind: Secret\nmetadata:\n  name: cas-knowledge-postgres-live\n",
      liveConfig: "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cas-knowledge-live-config\n",
      customerAccessJson: "{\"users\":{\"alice@example.com\":[\"customer-a\"]}}\n",
      siteKustomization:
        "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nconfigMapGenerator:\n- name: cas-knowledge-live-config\n  files:\n  - customer-access-json=customer-access.json\ngeneratorOptions:\n  disableNameSuffixHash: true\n",
      siteCustomerAccessJson: "{\"users\":{\"alice@example.com\":[\"customer-a\"]}}\n",
      summary: "{\"redacted\":true}\n"
    };
    const livePrereqOutputFiles = (keys = requiredLivePrereqOutputFileKeys) =>
      Object.fromEntries(
        keys.map((key) => {
          const path = livePrereqFilePaths[key];
          const content = livePrereqFileContent[key];
          writeTempEvidenceFile(path, content);
          return [key, { path, sha256: sha256Text(content), underOutputDir: true }];
        })
      );
    const writeLivePrereqEvidence = (options = {}) => {
      const outputFileSha256 = livePrereqOutputFiles(options.keys);
      write("cas-pbs-live-prereqs-render.json", {
        ...base,
        mode: options.mode ?? "real-render",
        outputDir: options.outputDir ?? expectedLivePrereqOutputDir,
        outputFileSha256,
        renderedSiteOverlaySha256: renderedSiteOverlayHash(tempRoot),
        redactedSummarySha256: outputFileSha256.summary?.sha256 ?? "",
        ...(options.extra ?? {})
      });
    };
    const writeLivePreapplyEvidence = (extra = {}) =>
      write("cas-pbs-preflight-pbs-live-site-preapply-cluster-required-secrets.json", {
        ...base,
        status: "FAIL",
        overlay: "pbs-live",
        overlayPath: expectedGeneratedSiteOverlayPath,
        renderedSiteOverlaySha256: renderedSiteOverlayHash(tempRoot),
        pbsRuntimeSourceEvidence: [{ name: "playbookstudio-runtime-abc", revisionKey: "org.opencontainers.image.revision", revision: pbsFullHead, imageIDs: ["image@example@sha256:abc"] }],
        requireCluster: true,
        requireSecret: true,
        skipApplied: true,
        summary: { total: 3, passed: 1, failed: 2 },
        checks: [
          { status: "PASS", id: "preflight:render", detail: "rendered" },
          { status: "FAIL", id: "cluster:pbs-namespace", detail: "namespace missing" },
          { status: "FAIL", id: "cluster:pbs-auth-secret", detail: "secret missing" }
        ],
        ...extra
      });
    const writeLiveClusterCutoverEvidence = (extra = {}) =>
      write("cas-pbs-live-smoke-cluster-cutover.json", {
        ...base,
        mode: "cluster-cutover",
        evidenceMode: "cluster-cutover",
        cutover: true,
        clusterSmoke: true,
        writeSmoke: true,
        summary: { total: 1, passed: 1, failed: 0 },
        checks: [{ status: "PASS", id: "pbs-live:cluster-write-lineage", detail: "upload -> RAG -> LLM Wiki -> topology lineage passed" }],
        ...extra
      });
    for (const [, fileName] of requiredLocalEvidence) write(fileName, base);
    writeLivePrereqEvidence();
    write("cas-pbs-source-contract-pinned.json", {
      ...base,
      requireSource: true,
      requireCleanSource: true,
      requireExpectedHead: true,
      pbsSource: pinnedPbsSource(),
      checks: [{ status: "PASS", id: "ok", detail: "ok" }]
    });
    writeLivePreapplyEvidence();
    const bundle = buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" });
    const text = JSON.stringify(bundle);
    const checks = [
      ["cutover-bundle:self-test-status", bundle.status === "BLOCKED", "fixture with external live blockers renders BLOCKED"],
      ["cutover-bundle:self-test-blockers", bundle.blockers.length === 2 && bundle.nextActions.length >= 2, "fixture extracts live preapply blockers and next actions"],
      ["cutover-bundle:self-test-redaction", !/raw-secret-value|password-value|owner-hmac-secret-value/.test(text), "bundle does not copy raw Secret material"],
      ["cutover-bundle:self-test-artifact-hashes", bundle.artifactSummary.filter((artifact) => artifact.exists).every((artifact) => artifact.sha256), "bundle records artifact hashes for every present artifact"],
      [
        "cutover-bundle:self-test-live-ready-smoke-required",
        (() => {
          writeLivePreapplyEvidence({
            status: "PASS",
            summary: { total: 1, passed: 1, failed: 0 },
            checks: [{ status: "PASS", id: "preflight:ready", detail: "ready" }]
          });
          const missingSmoke = buildBundle(
            tempRoot,
            { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" },
            { requireLiveReady: true }
          );
          writeLiveClusterCutoverEvidence({
            cutover: false,
            writeSmoke: false,
            checks: [{ status: "SKIP", id: "pbs-live:cluster-write-smoke", detail: "write smoke skipped" }]
          });
          const weakSmoke = buildBundle(
            tempRoot,
            { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" },
            { requireLiveReady: true }
          );
          writeLiveClusterCutoverEvidence();
          const validSmoke = buildBundle(
            tempRoot,
            { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" },
            { requireLiveReady: true }
          );
          writeLivePreapplyEvidence();
          return (
            missingSmoke.localGateFailures.some((blocker) => blocker.id === "cutover-bundle:live-cluster-cutover-smoke-missing") &&
            weakSmoke.localGateFailures.some((blocker) => blocker.id === "cutover-bundle:live-cluster-cutover-smoke-write-lineage") &&
            weakSmoke.localGateFailures.some((blocker) => blocker.id === "cutover-bundle:live-cluster-cutover-smoke-lineage-check") &&
            !validSmoke.localGateFailures.some((blocker) => blocker.id === "cutover-bundle:live-cluster-cutover-smoke-missing") &&
            !validSmoke.localGateFailures.some((blocker) => blocker.id === "cutover-bundle:live-cluster-cutover-smoke-lineage-check")
          );
        })(),
        "fixture requires cluster cutover smoke evidence before --require-live-ready can pass"
      ],
      [
        "cutover-bundle:self-test-prereq-hash-drift-rejected",
        (() => {
          writeTempEvidenceFile(livePrereqFilePaths.liveConfig, `${livePrereqFileContent.liveConfig}# drift\n`);
          const drifted = buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" });
          writeLivePrereqEvidence();
          return drifted.status === "FAIL" && drifted.localGateFailures.some((blocker) => blocker.id === "cutover-bundle:live-prereqs-real-render");
        })(),
        "fixture rejects prerequisite render evidence when generated files drift after hash recording"
      ],
      [
        "cutover-bundle:self-test-prereq-path-escape-rejected",
        (() => {
          const outputFileSha256 = livePrereqOutputFiles();
          const escapedPath = `${expectedLivePrereqOutputDir}/../escaped-live-config.yaml`;
          writeTempEvidenceFile(escapedPath, livePrereqFileContent.liveConfig);
          outputFileSha256.liveConfig = {
            path: escapedPath,
            sha256: sha256Text(livePrereqFileContent.liveConfig),
            underOutputDir: true
          };
          write("cas-pbs-live-prereqs-render.json", {
            ...base,
            mode: "real-render",
            outputDir: expectedLivePrereqOutputDir,
            outputFileSha256,
            renderedSiteOverlaySha256: renderedSiteOverlayHash(tempRoot),
            redactedSummarySha256: outputFileSha256.summary?.sha256 ?? ""
          });
          const escaped = buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" });
          writeLivePrereqEvidence();
          return escaped.status === "FAIL" && escaped.localGateFailures.some((blocker) => blocker.id === "cutover-bundle:live-prereqs-real-render");
        })(),
        "fixture rejects prerequisite render evidence whose recorded paths escape the generated output tree"
      ],
      [
        "cutover-bundle:self-test-preapply-hash-mismatch-rejected",
        (() => {
          writeLivePreapplyEvidence({ renderedSiteOverlaySha256: "0".repeat(64) });
          const mismatched = buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" });
          writeLivePreapplyEvidence();
          return mismatched.status === "FAIL" && mismatched.localGateFailures.some((blocker) => blocker.id === "cutover-bundle:live-preapply-generated-site");
        })(),
        "fixture rejects preapply evidence that rendered a different generated site overlay hash"
      ],
      [
        "cutover-bundle:self-test-aged-preapply-rejected",
        (() => {
          const staleCheckedAt = new Date(Date.parse(checkedAt) - (maxLivePreapplyAgeMinutes + 5) * 60 * 1000).toISOString();
          writeLivePreapplyEvidence({ checkedAt: staleCheckedAt });
          const stale = buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" });
          writeLivePreapplyEvidence();
          return stale.status === "FAIL" && stale.localGateFailures.some((blocker) => blocker.id === "cutover-bundle:live-preapply-fresh");
        })(),
        "fixture rejects generated-site preapply evidence older than the cutover freshness window"
      ],
      [
        "cutover-bundle:self-test-future-preapply-rejected",
        (() => {
          const futureCheckedAt = new Date(Date.parse(checkedAt) + maxEvidenceFutureSkewMs + 60 * 1000).toISOString();
          writeLivePreapplyEvidence({ checkedAt: futureCheckedAt });
          const future = buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" });
          writeLivePreapplyEvidence();
          return future.status === "FAIL" && future.localGateFailures.some((blocker) => blocker.id === "cutover-bundle:live-preapply-fresh");
        })(),
        "fixture rejects generated-site preapply evidence future-dated beyond clock skew"
      ],
      [
        "cutover-bundle:self-test-cluster-mismatch-rejected",
        (() => {
          writeLivePreapplyEvidence({ clusterIdentity: { ...clusterIdentity, namespaceUid: "other-namespace" } });
          const mismatched = buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" });
          writeLivePreapplyEvidence();
          return mismatched.status === "FAIL" && mismatched.localGateFailures.some((blocker) => blocker.id === "cutover-bundle:livePreapply:cluster-identity");
        })(),
        "fixture rejects live preapply evidence from a different cluster identity"
      ],
      [
        "cutover-bundle:self-test-cywell-source-remote-proof-rejected",
        (() => {
          write("cas-release-images.json", {
            ...base,
            cywellSource: {
              remoteOriginUrl: "git@github.com:souluk319/Cywell-AIOps_Agent.git",
              remoteApproved: true,
              remoteFetchOk: false,
              remoteContainsHead: false,
              remoteRefsContainingHead: [],
              remoteVerifiedAt: checkedAt,
              remoteVerificationError: "no fetched origin branch contains the Cywell release head"
            }
          });
          const unproven = buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" });
          write("cas-release-images.json", base);
          return unproven.status === "FAIL" && unproven.localGateFailures.some((blocker) => blocker.id === "cutover-bundle:releaseImages:cywell-source-pinned");
        })(),
        "fixture rejects release image evidence without approved Cywell remote ref containment proof"
      ],
      [
        "cutover-bundle:self-test-runtime-source-mismatch-rejected",
        (() => {
          writeLivePreapplyEvidence({
            pbsRuntimeSourceEvidence: [{ name: "playbookstudio-runtime-abc", revisionKey: "org.opencontainers.image.revision", revision: "e".repeat(40), imageIDs: ["image@example@sha256:abc"] }]
          });
          const mismatched = buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" });
          writeLivePreapplyEvidence();
          return mismatched.status === "FAIL" && mismatched.localGateFailures.some((blocker) => blocker.id === "cutover-bundle:live-runtime-source-revision");
        })(),
        "fixture rejects live runtime pods that are not stamped with the pinned PBS source revision"
      ],
      [
        "cutover-bundle:self-test-dirty-local-evidence-rejected",
        (() => {
          write("cas-deploy-manifests.json", { ...base, treeStatus: "dirty" });
          const dirtyEvidence = buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" });
          write("cas-deploy-manifests.json", base);
          return dirtyEvidence.status === "FAIL" && dirtyEvidence.localGateFailures.some((blocker) => blocker.id === "cutover-bundle:deployManifests:clean-source");
        })(),
        "fixture rejects required local evidence generated from a dirty git tree"
      ],
      [
        "cutover-bundle:self-test-dirty-source-rejected",
        (() => {
          write("cas-pbs-source-contract-pinned.json", {
            ...base,
            requireSource: true,
            requireCleanSource: true,
            requireExpectedHead: true,
            pbsSource: pinnedPbsSource({ treeStatus: "dirty" }),
            checks: [{ status: "PASS", id: "ok", detail: "ok" }]
          });
          return buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" }).status === "FAIL";
        })(),
        "fixture rejects dirty or unpinned PBS source evidence"
      ],
      [
        "cutover-bundle:self-test-source-full-head-mismatch-rejected",
        (() => {
          write("cas-pbs-source-contract-pinned.json", {
            ...base,
            requireSource: true,
            requireCleanSource: true,
            requireExpectedHead: true,
            pbsSource: pinnedPbsSource({ expectedHead: "0".repeat(40) }),
            checks: [{ status: "PASS", id: "ok", detail: "ok" }]
          });
          return buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" }).status === "FAIL";
        })(),
        "fixture rejects PBS source-contract evidence when fullHead differs from expectedHead"
      ],
      [
        "cutover-bundle:self-test-unapproved-source-head-rejected",
        (() => {
          const wrongHead = "e".repeat(40);
          write("cas-pbs-source-contract-pinned.json", {
            ...base,
            requireSource: true,
            requireCleanSource: true,
            requireExpectedHead: true,
            pbsSource: pinnedPbsSource({ head: wrongHead.slice(0, 7), fullHead: wrongHead, expectedHead: wrongHead }),
            checks: [{ status: "PASS", id: "ok", detail: "ok" }]
          });
          const unapproved = buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" });
          write("cas-pbs-source-contract-pinned.json", {
            ...base,
            requireSource: true,
            requireCleanSource: true,
            requireExpectedHead: true,
            pbsSource: pinnedPbsSource(),
            checks: [{ status: "PASS", id: "ok", detail: "ok" }]
          });
          return unapproved.status === "FAIL" && unapproved.localGateFailures.some((blocker) => blocker.id === "cutover-bundle:source-contract-pinned");
        })(),
        "fixture rejects PBS source-contract evidence for a full but unapproved release SHA"
      ],
      [
        "cutover-bundle:self-test-source-contract-hash-set-rejected",
        (() => {
          const missingHashSet = { ...contractFileSha256 };
          delete missingHashSet["src/play_book_studio/wiki_loop.py"];
          write("cas-pbs-source-contract-pinned.json", {
            ...base,
            requireSource: true,
            requireCleanSource: true,
            requireExpectedHead: true,
            pbsSource: pinnedPbsSource({ contractFileSha256: missingHashSet }),
            checks: [{ status: "PASS", id: "ok", detail: "ok" }]
          });
          const missing = buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" });
          write("cas-pbs-source-contract-pinned.json", {
            ...base,
            requireSource: true,
            requireCleanSource: true,
            requireExpectedHead: true,
            pbsSource: pinnedPbsSource({ contractFileSha256: { ...contractFileSha256, "unexpected.py": sha256Text("unexpected.py") } }),
            checks: [{ status: "PASS", id: "ok", detail: "ok" }]
          });
          const extra = buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" });
          write("cas-pbs-source-contract-pinned.json", {
            ...base,
            requireSource: true,
            requireCleanSource: true,
            requireExpectedHead: true,
            pbsSource: pinnedPbsSource({ contractFileSha256: { ...contractFileSha256, "deploy/Dockerfile": "short-hash" } }),
            checks: [{ status: "PASS", id: "ok", detail: "ok" }]
          });
          const short = buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" });
          write("cas-pbs-source-contract-pinned.json", {
            ...base,
            requireSource: true,
            requireCleanSource: true,
            requireExpectedHead: true,
            pbsSource: pinnedPbsSource(),
            checks: [{ status: "PASS", id: "ok", detail: "ok" }]
          });
          return [missing, extra, short].every(
            (bundle) => bundle.status === "FAIL" && bundle.localGateFailures.some((blocker) => blocker.id === "cutover-bundle:source-contract-pinned")
          );
        })(),
        "fixture rejects missing, extra, or short PBS source contract hashes"
      ],
      [
        "cutover-bundle:self-test-source-remote-proof-rejected",
        (() => {
          write("cas-pbs-source-contract-pinned.json", {
            ...base,
            requireSource: true,
            requireCleanSource: true,
            requireExpectedHead: true,
            pbsSource: pinnedPbsSource({
              remoteContainsExpectedHead: false,
              remoteRefsContainingExpectedHead: [],
              remoteVerificationError: "no fetched origin branch contains the expected PBS SHA"
            }),
            checks: [{ status: "PASS", id: "ok", detail: "ok" }]
          });
          const unproven = buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" });
          write("cas-pbs-source-contract-pinned.json", {
            ...base,
            requireSource: true,
            requireCleanSource: true,
            requireExpectedHead: true,
            pbsSource: pinnedPbsSource(),
            checks: [{ status: "PASS", id: "ok", detail: "ok" }]
          });
          return unproven.status === "FAIL" && unproven.localGateFailures.some((blocker) => blocker.id === "cutover-bundle:source-contract-pinned");
        })(),
        "fixture rejects pinned PBS source evidence without approved remote ref containment proof"
      ],
      [
        "cutover-bundle:self-test-stale-source-proof-rejected",
        (() => {
          const staleCheckedAt = new Date(Date.parse(checkedAt) - (maxSourceProofAgeMinutes + 5) * 60 * 1000).toISOString();
          write("cas-pbs-source-contract-pinned.json", {
            ...base,
            checkedAt: staleCheckedAt,
            requireSource: true,
            requireCleanSource: true,
            requireExpectedHead: true,
            pbsSource: pinnedPbsSource({ remoteVerifiedAt: staleCheckedAt }),
            checks: [{ status: "PASS", id: "ok", detail: "ok" }]
          });
          const stale = buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" });
          write("cas-pbs-source-contract-pinned.json", {
            ...base,
            requireSource: true,
            requireCleanSource: true,
            requireExpectedHead: true,
            pbsSource: pinnedPbsSource(),
            checks: [{ status: "PASS", id: "ok", detail: "ok" }]
          });
          return stale.status === "FAIL" && stale.localGateFailures.some((blocker) => blocker.id === "cutover-bundle:source-contract-pinned");
        })(),
        "fixture rejects stale pinned PBS source remote proof"
      ],
      [
        "cutover-bundle:self-test-future-source-proof-rejected",
        (() => {
          const futureCheckedAt = new Date(Date.parse(checkedAt) + maxEvidenceFutureSkewMs + 60 * 1000).toISOString();
          write("cas-pbs-source-contract-pinned.json", {
            ...base,
            checkedAt: futureCheckedAt,
            requireSource: true,
            requireCleanSource: true,
            requireExpectedHead: true,
            pbsSource: pinnedPbsSource({ remoteVerifiedAt: futureCheckedAt }),
            checks: [{ status: "PASS", id: "ok", detail: "ok" }]
          });
          const future = buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" });
          write("cas-pbs-source-contract-pinned.json", {
            ...base,
            requireSource: true,
            requireCleanSource: true,
            requireExpectedHead: true,
            pbsSource: pinnedPbsSource(),
            checks: [{ status: "PASS", id: "ok", detail: "ok" }]
          });
          return future.status === "FAIL" && future.localGateFailures.some((blocker) => blocker.id === "cutover-bundle:source-contract-pinned");
        })(),
        "fixture rejects future-dated pinned PBS source remote proof"
      ],
      [
        "cutover-bundle:self-test-prereq-self-test-rejected",
        (() => {
          write("cas-pbs-source-contract-pinned.json", {
            ...base,
            requireSource: true,
            requireCleanSource: true,
            requireExpectedHead: true,
            pbsSource: pinnedPbsSource(),
            checks: [{ status: "PASS", id: "ok", detail: "ok" }]
          });
          write("cas-pbs-live-prereqs-render.json", { ...base, mode: "self-test" });
          return buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" }).status === "FAIL";
        })(),
        "fixture rejects self-test prerequisite evidence as cutover proof"
      ],
      [
        "cutover-bundle:self-test-missing-prereq-output-rejected",
        (() => {
          write("cas-pbs-source-contract-pinned.json", {
            ...base,
            requireSource: true,
            requireCleanSource: true,
            requireExpectedHead: true,
            pbsSource: pinnedPbsSource(),
            checks: [{ status: "PASS", id: "ok", detail: "ok" }]
          });
          writeLivePrereqEvidence({ keys: ["pbsAuthSecret", "postgresSecret", "liveConfig", "summary"] });
          return buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" }).status === "FAIL";
        })(),
        "fixture rejects prerequisite render evidence missing owner-HMAC and site ACL hashes"
      ],
      [
        "cutover-bundle:self-test-prereq-output-dir-rejected",
        (() => {
          writeLivePrereqEvidence({ outputDir: "test-results/other-prereqs" });
          return buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" }).status === "FAIL";
        })(),
        "fixture rejects prerequisite render evidence from an unexpected output directory"
      ],
      [
        "cutover-bundle:self-test-fail-retains-external-blockers",
        (() => {
          const failedBundle = buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" });
          return (
            failedBundle.status === "FAIL" &&
            failedBundle.localGateFailures.some((blocker) => blocker.id === "cutover-bundle:live-prereqs-real-render") &&
            failedBundle.externalLiveBlockers.some((blocker) => blocker.id === "cluster:pbs-namespace") &&
            failedBundle.blockers.some((blocker) => blocker.id === "cluster:pbs-namespace") &&
            failedBundle.nextActions.some((action) => action.includes("playbookstudio namespace"))
          );
        })(),
        "fixture preserves external live preapply blockers in active blockers even when local evidence is invalid"
      ]
    ];
    for (const [id, ok, detail] of checks) {
      console.log(`[${ok ? "PASS" : "FAIL"}] ${id}: ${detail}`);
      if (!ok) process.exitCode = 1;
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (selfTest) {
  await runSelfTest();
  process.exit(process.exitCode ?? 0);
}

assertOutputUnderTestResults(outDir);
const bundle = buildBundle();
mkdirSync(outDir, { recursive: true });
const jsonPath = join(outDir, "cutover-bundle.json");
const markdownPath = join(outDir, "README.md");
const compatibilityJsonPath = join("test-results", "cas-pbs-cutover-bundle.json");
writeFileSync(jsonPath, `${JSON.stringify(bundle, null, 2)}\n`);
writeFileSync(markdownPath, markdownSummary(bundle));
mkdirSync(dirname(compatibilityJsonPath), { recursive: true });
writeFileSync(compatibilityJsonPath, `${JSON.stringify(bundle, null, 2)}\n`);

console.log(`PBS cutover bundle final status: ${bundle.status}`);
console.log(`Phase: ${bundle.phase}`);
console.log(`Evidence bundle: ${jsonPath}`);
console.log(`Summary: ${markdownPath}`);
console.log(`Compatibility copy: ${compatibilityJsonPath}`);
if (bundle.blockers.length > 0) {
  console.log("Blockers:");
  for (const blocker of bundle.blockers) console.log(`- ${blocker.id}: ${blocker.detail}`);
}
if (requireLiveReady && bundle.status !== "PASS") {
  console.error(`PBS cutover bundle is ${bundle.status}; live-ready bundle requires PASS`);
  process.exit(1);
}
if (bundle.status === "FAIL") process.exit(1);
