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

const requiredLocalEvidence = [
  ["crcDeployment", "cas-crc-deployment.json", "CRC deployment evidence"],
  ["releaseImages", "cas-release-images.json", "CRC release image promotion evidence"],
  ["deployManifests", "cas-deploy-manifests.json", "deployment manifest verification evidence"],
  ["livePrereqsRender", "cas-pbs-live-prereqs-render.json", "PBS live prerequisite real-render evidence"],
  ["sourceContract", "cas-pbs-source-contract.json", "PBS source contract evidence"]
];

const livePreapplyEvidence = [
  "livePreapply",
  "cas-pbs-preflight-pbs-live-site-preapply-cluster-required-secrets.json",
  "strict PBS live generated-site pre-apply evidence"
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
    namespace: json.namespace,
    releaseTag: json.releaseTag,
    sourceClusterIdentity: json.sourceClusterIdentity,
    outputDir: json.outputDir,
    overlay: json.overlay,
    overlayPath: json.overlayPath,
    requireCluster: json.requireCluster,
    requireSecret: json.requireSecret,
    skipApplied: json.skipApplied,
    outputFileSha256: json.outputFileSha256,
    renderedSiteOverlaySha256: json.renderedSiteOverlaySha256,
    redactedSummarySha256: json.redactedSummarySha256,
    requireSource: json.requireSource,
    requireCleanSource: json.requireCleanSource,
    requireExpectedHead: json.requireExpectedHead,
    summary: json.summary ?? {},
    clusterIdentity: json.clusterIdentity,
    pbsSource: json.pbsSource
      ? {
          branch: json.pbsSource.branch,
          head: json.pbsSource.head,
          fullHead: json.pbsSource.fullHead,
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
  if (id.includes("livePrereqsRender") || id.includes("live-prereqs")) return "Regenerate real live prereq evidence with npm run render:pbs:live-prereqs after approved Secret/ACL/Postgres inputs are supplied.";
  if (id.includes("source-contract-pinned")) return "Set CAS_PBS_SOURCE_HEAD to the approved PBS full SHA, clean the PBS checkout, then run npm run verify:release:source-pinning.";
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

function commandPlan() {
  return [
    "npm run verify",
    "npm run deploy:crc",
    "$env:CAS_RELEASE_FORCE=\"true\"; npm run release:crc:v0.1.4",
    "npm run render:pbs:live-prereqs",
    "$env:CAS_PBS_SOURCE_HEAD=\"<approved PBS full git SHA>\"; npm run verify:release:source-pinning",
    "npm run verify:pbs:preflight:live:site:preapply",
    "node ./scripts/render-pbs-cutover-bundle.mjs --require-live-ready",
    "oc apply -k .\\test-results\\pbs-live-prereqs\\pbs-live-site",
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

function clusterEvidenceFailures(artifacts) {
  const failures = [];
  const clusterArtifacts = [
    ["crcDeployment", artifacts.crcDeployment],
    ["releaseImages", artifacts.releaseImages],
    ["livePreapply", artifacts.livePreapply]
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

function renderedSiteOverlayHash(baseDir) {
  const overlayPath = resolveEvidencePath(baseDir, expectedGeneratedSiteOverlayPath);
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
  const pathUnder = (file, expectedDir) => {
    return file?.underOutputDir === true && resolvedPathUnder(baseDir, file?.path, expectedDir);
  };
  const allFilesUnderOutputDir = Object.values(files ?? {}).every((file) => pathUnder(file, expectedLivePrereqOutputDir));
  const siteFilesUnderGeneratedOverlay = ["siteKustomization", "siteCustomerAccessJson"].every((key) => pathUnder(files?.[key], expectedGeneratedSiteOverlayPath));
  return (
    evidence.mode === "real-render" &&
    outputDir === expectedLivePrereqOutputDir &&
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
    evidence.renderedSiteOverlaySha256 === renderedSiteOverlayHash(baseDir) &&
    sha256File(resolveEvidencePath(baseDir, files.summary.path)) === evidence.redactedSummarySha256
  );
}

function isStrictGeneratedSitePreapply(evidence, meta, livePrereqsRender, baseDir) {
  const currentSiteOverlayHash = renderedSiteOverlayHash(baseDir);
  return Boolean(
    evidence.exists &&
      evidence.fullHead === meta.fullHead &&
      evidence.treeStatus === "clean" &&
      evidence.overlay === "pbs-live" &&
      normalizePath(evidence.overlayPath) === expectedGeneratedSiteOverlayPath &&
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
  return Boolean(
    evidence.requireSource &&
      evidence.requireCleanSource &&
      evidence.requireExpectedHead &&
      pbsSource?.requireCleanSource === true &&
      pbsSource?.treeStatus === "clean" &&
      /^[a-f0-9]{40}$/i.test(String(pbsSource?.expectedHead ?? "")) &&
      /^[a-f0-9]{40}$/i.test(String(pbsSource?.fullHead ?? "")) &&
      pbsSource.fullHead === pbsSource.expectedHead &&
      pbsSource?.contractFileSha256 &&
      Object.values(pbsSource.contractFileSha256).every(Boolean)
  );
}

function buildBundle(baseDir = evidenceDir, meta = gitMetadata()) {
  const artifacts = Object.fromEntries(
    [...requiredLocalEvidence, livePreapplyEvidence].map((descriptor) => {
      const evidence = readEvidence(baseDir, descriptor);
      return [evidence.key, evidence];
    })
  );

  const localGateFailures = [];
  if (meta.treeStatus !== "clean" && !allowDirty) {
    localGateFailures.push({ id: "cutover-bundle:git-tree-clean", detail: "current git tree is dirty; commit and rerun release evidence before bundling cutover proof" });
  }
  for (const [key] of requiredLocalEvidence) {
    const evidence = artifacts[key];
    if (!evidence.exists) localGateFailures.push({ id: `cutover-bundle:${key}:missing`, detail: `${evidence.fileName} is missing` });
    else if (evidence.status !== "PASS") localGateFailures.push({ id: `cutover-bundle:${key}:status`, detail: `${evidence.fileName} status is ${evidence.status}, expected PASS` });
    if (!currentHeadMatches(evidence, meta)) {
      localGateFailures.push({ id: `cutover-bundle:${key}:head`, detail: `${evidence.fileName} head ${evidence.head || evidence.fullHead || "missing"} does not match current HEAD ${meta.head}` });
    }
  }
  localGateFailures.push(...clusterEvidenceFailures(artifacts));
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
      detail: "cas-pbs-source-contract.json must come from verify:release:source-pinning with clean PBS source and CAS_PBS_SOURCE_HEAD"
    });
  }

  const livePreapply = artifacts.livePreapply;
  if (livePreapply?.exists && !isStrictGeneratedSitePreapply(livePreapply, meta, livePrereqsRender, baseDir)) {
    localGateFailures.push({
      id: "cutover-bundle:live-preapply-generated-site",
      detail: `${livePreapply.fileName} must be current clean generated-site preapply evidence for ${expectedGeneratedSiteOverlayPath} with cluster, required-secret, skip-applied flags, and the same rendered site-overlay hash as current live prerequisite evidence`
    });
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

  const blockers = status === "FAIL" ? localGateFailures : liveBlockers;
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
    requireLiveReady,
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
      "PASS means local evidence is current and strict live pre-apply evidence is also PASS; live apply still requires verify:release:pbs-live after mutation."
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
      checks: [{ status: "PASS", id: "ok", detail: "ok" }]
    };
    const pbsFullHead = "d".repeat(40);
    const pbsShortHead = pbsFullHead.slice(0, 7);
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
    for (const [, fileName] of requiredLocalEvidence) write(fileName, base);
    writeLivePrereqEvidence();
    write("cas-pbs-source-contract.json", {
      ...base,
      requireSource: true,
      requireCleanSource: true,
      requireExpectedHead: true,
      pbsSource: { branch: "main", head: pbsShortHead, fullHead: pbsFullHead, treeStatus: "clean", requireCleanSource: true, expectedHead: pbsFullHead, contractFileSha256: { "deploy/Dockerfile": "hash" } },
      checks: [{ status: "PASS", id: "ok", detail: "ok" }]
    });
    writeLivePreapplyEvidence();
    const bundle = buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" });
    const text = JSON.stringify(bundle);
    const checks = [
      ["cutover-bundle:self-test-status", bundle.status === "BLOCKED", "fixture with external live blockers renders BLOCKED"],
      ["cutover-bundle:self-test-blockers", bundle.blockers.length === 2 && bundle.nextActions.length >= 2, "fixture extracts live preapply blockers and next actions"],
      ["cutover-bundle:self-test-redaction", !/raw-secret-value|password-value|owner-hmac-secret-value/.test(text), "bundle does not copy raw Secret material"],
      ["cutover-bundle:self-test-artifact-hashes", bundle.artifactSummary.every((artifact) => artifact.sha256), "bundle records artifact hashes"],
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
        "cutover-bundle:self-test-dirty-source-rejected",
        (() => {
          write("cas-pbs-source-contract.json", {
            ...base,
            requireSource: true,
            requireCleanSource: true,
            requireExpectedHead: true,
            pbsSource: { branch: "main", head: pbsShortHead, fullHead: pbsFullHead, treeStatus: "dirty", requireCleanSource: true, expectedHead: pbsFullHead, contractFileSha256: { "deploy/Dockerfile": "hash" } },
            checks: [{ status: "PASS", id: "ok", detail: "ok" }]
          });
          return buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" }).status === "FAIL";
        })(),
        "fixture rejects dirty or unpinned PBS source evidence"
      ],
      [
        "cutover-bundle:self-test-source-full-head-mismatch-rejected",
        (() => {
          write("cas-pbs-source-contract.json", {
            ...base,
            requireSource: true,
            requireCleanSource: true,
            requireExpectedHead: true,
            pbsSource: { branch: "main", head: pbsShortHead, fullHead: pbsFullHead, treeStatus: "clean", requireCleanSource: true, expectedHead: "0".repeat(40), contractFileSha256: { "deploy/Dockerfile": "hash" } },
            checks: [{ status: "PASS", id: "ok", detail: "ok" }]
          });
          return buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" }).status === "FAIL";
        })(),
        "fixture rejects PBS source-contract evidence when fullHead differs from expectedHead"
      ],
      [
        "cutover-bundle:self-test-prereq-self-test-rejected",
        (() => {
          write("cas-pbs-source-contract.json", {
            ...base,
            requireSource: true,
            requireCleanSource: true,
            requireExpectedHead: true,
            pbsSource: { branch: "main", head: pbsShortHead, fullHead: pbsFullHead, treeStatus: "clean", requireCleanSource: true, expectedHead: pbsFullHead, contractFileSha256: { "deploy/Dockerfile": "hash" } },
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
          write("cas-pbs-source-contract.json", {
            ...base,
            requireSource: true,
            requireCleanSource: true,
            requireExpectedHead: true,
            pbsSource: { branch: "main", head: pbsShortHead, fullHead: pbsFullHead, treeStatus: "clean", requireCleanSource: true, expectedHead: pbsFullHead, contractFileSha256: { "deploy/Dockerfile": "hash" } },
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
            failedBundle.nextActions.some((action) => action.includes("playbookstudio namespace"))
          );
        })(),
        "fixture preserves external live preapply blockers even when local evidence is invalid"
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
writeFileSync(jsonPath, `${JSON.stringify(bundle, null, 2)}\n`);
writeFileSync(markdownPath, markdownSummary(bundle));
mkdirSync(dirname(join("test-results", "cas-pbs-cutover-bundle.json")), { recursive: true });
writeFileSync(join("test-results", "cas-pbs-cutover-bundle.json"), `${JSON.stringify(bundle, null, 2)}\n`);

console.log(`PBS cutover bundle final status: ${bundle.status}`);
console.log(`Phase: ${bundle.phase}`);
console.log(`Evidence bundle: ${jsonPath}`);
console.log(`Summary: ${markdownPath}`);
if (bundle.blockers.length > 0) {
  console.log("Blockers:");
  for (const blocker of bundle.blockers) console.log(`- ${blocker.id}: ${blocker.detail}`);
}
if (requireLiveReady && bundle.status !== "PASS") {
  console.error(`PBS cutover bundle is ${bundle.status}; live-ready bundle requires PASS`);
  process.exit(1);
}
if (bundle.status === "FAIL") process.exit(1);
