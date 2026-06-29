#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

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
  "cas-pbs-preflight-pbs-live-preapply-cluster-required-secrets.json",
  "strict PBS live generated-site pre-apply evidence"
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

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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
    overlay: json.overlay,
    overlayPath: json.overlayPath,
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
  if (!evidence.exists || (!evidence.head && !evidence.fullHead) || (!meta.head && !meta.fullHead)) return false;
  return evidence.head === meta.head || evidence.fullHead === meta.fullHead;
}

function hasRealRenderHashes(evidence) {
  const files = evidence.outputFileSha256;
  return (
    evidence.mode === "real-render" &&
    typeof evidence.renderedSiteOverlaySha256 === "string" &&
    evidence.renderedSiteOverlaySha256.length >= 32 &&
    typeof evidence.redactedSummarySha256 === "string" &&
    evidence.redactedSummarySha256.length >= 32 &&
    files &&
    typeof files === "object" &&
    Object.values(files).length >= 5 &&
    Object.values(files).every((file) => file && typeof file.sha256 === "string" && file.sha256.length >= 32)
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
      pbsSource?.expectedHead &&
      (pbsSource?.head || pbsSource?.fullHead) &&
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
  const livePrereqsRender = artifacts.livePrereqsRender;
  if (livePrereqsRender?.exists && !hasRealRenderHashes(livePrereqsRender)) {
    localGateFailures.push({
      id: "cutover-bundle:live-prereqs-real-render",
      detail: "cas-pbs-live-prereqs-render.json must be produced by render:pbs:live-prereqs and include output, site-overlay, and redacted-summary hashes"
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
  const liveBlockers = livePreapply.failedChecks ?? [];
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
    blockers,
    nextActions: uniqueActions(blockers),
    commandPlan: commandPlan(),
    notes: [
      "This bundle contains redacted evidence metadata and hashes only; raw Secret values are not copied.",
      "BLOCKED means CRC/release evidence is coherent but strict live pre-apply still needs external PBS runtime or Secret state.",
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
  lines.push("", "## Blockers", "");
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
    const base = { checkedAt, branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", status: "PASS", summary: { total: 1, passed: 1, failed: 0 }, checks: [{ status: "PASS", id: "ok", detail: "ok" }] };
    for (const [, fileName] of requiredLocalEvidence) write(fileName, base);
    write("cas-pbs-live-prereqs-render.json", {
      ...base,
      mode: "real-render",
      outputFileSha256: {
        pbsAuthSecret: { path: "a", sha256: "a".repeat(64), underOutputDir: true },
        ownerAuthSecret: { path: "b", sha256: "b".repeat(64), underOutputDir: true },
        postgresSecret: { path: "c", sha256: "c".repeat(64), underOutputDir: true },
        liveConfig: { path: "d", sha256: "d".repeat(64), underOutputDir: true },
        summary: { path: "e", sha256: "e".repeat(64), underOutputDir: true }
      },
      renderedSiteOverlaySha256: "f".repeat(64),
      redactedSummarySha256: "1".repeat(64)
    });
    write("cas-pbs-source-contract.json", {
      ...base,
      requireSource: true,
      requireCleanSource: true,
      requireExpectedHead: true,
      pbsSource: { branch: "main", head: "def5678", fullHead: "def5678", treeStatus: "clean", requireCleanSource: true, expectedHead: "def5678", contractFileSha256: { "deploy/Dockerfile": "hash" } },
      checks: [{ status: "PASS", id: "ok", detail: "ok" }]
    });
    write("cas-pbs-preflight-pbs-live-preapply-cluster-required-secrets.json", {
      ...base,
      status: "FAIL",
      summary: { total: 3, passed: 1, failed: 2 },
      checks: [
        { status: "PASS", id: "preflight:render", detail: "rendered" },
        { status: "FAIL", id: "cluster:pbs-namespace", detail: "namespace missing" },
        { status: "FAIL", id: "cluster:pbs-auth-secret", detail: "secret missing" }
      ]
    });
    const bundle = buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" });
    const text = JSON.stringify(bundle);
    const checks = [
      ["cutover-bundle:self-test-status", bundle.status === "BLOCKED", "fixture with external live blockers renders BLOCKED"],
      ["cutover-bundle:self-test-blockers", bundle.blockers.length === 2 && bundle.nextActions.length >= 2, "fixture extracts live preapply blockers and next actions"],
      ["cutover-bundle:self-test-redaction", !/raw-secret-value|password-value|owner-hmac-secret-value/.test(text), "bundle does not copy raw Secret material"],
      ["cutover-bundle:self-test-artifact-hashes", bundle.artifactSummary.every((artifact) => artifact.sha256), "bundle records artifact hashes"],
      [
        "cutover-bundle:self-test-dirty-source-rejected",
        (() => {
          write("cas-pbs-source-contract.json", {
            ...base,
            requireSource: true,
            requireCleanSource: true,
            requireExpectedHead: true,
            pbsSource: { branch: "main", head: "def5678", fullHead: "def5678", treeStatus: "dirty", requireCleanSource: true, expectedHead: "def5678", contractFileSha256: { "deploy/Dockerfile": "hash" } },
            checks: [{ status: "PASS", id: "ok", detail: "ok" }]
          });
          return buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" }).status === "FAIL";
        })(),
        "fixture rejects dirty or unpinned PBS source evidence"
      ],
      [
        "cutover-bundle:self-test-prereq-self-test-rejected",
        (() => {
          write("cas-pbs-source-contract.json", {
            ...base,
            requireSource: true,
            requireCleanSource: true,
            requireExpectedHead: true,
            pbsSource: { branch: "main", head: "def5678", fullHead: "def5678", treeStatus: "clean", requireCleanSource: true, expectedHead: "def5678", contractFileSha256: { "deploy/Dockerfile": "hash" } },
            checks: [{ status: "PASS", id: "ok", detail: "ok" }]
          });
          write("cas-pbs-live-prereqs-render.json", { ...base, mode: "self-test" });
          return buildBundle(tempRoot, { branch: "v0.1.4", head: "abc1234", fullHead: "abc1234", treeStatus: "clean", statusShort: "" }).status === "FAIL";
        })(),
        "fixture rejects self-test prerequisite evidence as cutover proof"
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
