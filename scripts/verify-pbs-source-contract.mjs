#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const args = new Set(process.argv.slice(2).filter((arg) => !arg.startsWith("--source-dir=")));
const sourceDirArg = process.argv.find((arg) => arg.startsWith("--source-dir="))?.split("=")[1];
const checkedAt = new Date().toISOString();
const repoDefaultSourceDir = resolve(process.cwd(), "..", "PBS-Dev3");
const sourceDir = resolve(sourceDirArg || process.env.CAS_PBS_SOURCE_DIR || repoDefaultSourceDir);
const requireSource = args.has("--require-source");
const requireCleanSource = args.has("--require-clean-source") || /^(1|true|yes|y|on)$/i.test(process.env.CAS_PBS_REQUIRE_CLEAN_SOURCE || "");
const requireExpectedHead = args.has("--require-expected-head") || /^(1|true|yes|y|on)$/i.test(process.env.CAS_PBS_REQUIRE_SOURCE_HEAD || "");
const expectedSourceHead = String(process.env.CAS_PBS_SOURCE_HEAD || "").trim();
const selfTest = args.has("--self-test");
const strictApprovedRemotePattern = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)souluk319\/PBS_DEV_Part3(?:\.git)?$/i;
const defaultApprovedRemotePattern = "^(?:git@github\\.com:|https://github\\.com/|ssh://git@github\\.com/)souluk319/PBS_DEV_Part3(?:\\.git)?$";
const approvedRemotePatterns = (process.env.CAS_PBS_APPROVED_REMOTE_PATTERN || defaultApprovedRemotePattern)
  .split(",")
  .map((pattern) => pattern.trim())
  .filter(Boolean)
  .map((pattern) => new RegExp(pattern, "i"));
const optionalEvidencePath = join("test-results", "cas-pbs-source-contract.json");
const requiredEvidencePath = join("test-results", "cas-pbs-source-contract-required.json");
const pinnedEvidencePath = join("test-results", "cas-pbs-source-contract-pinned.json");
const evidencePath = requireCleanSource && requireExpectedHead ? pinnedEvidencePath : requireSource ? requiredEvidencePath : optionalEvidencePath;
const checks = [];
const contractFiles = [
  "deploy/Dockerfile",
  "docker-compose.yml",
  "src/play_book_studio/http/server_handler_factory.py",
  "src/play_book_studio/http/upload_api.py",
  "src/play_book_studio/http/url_ingest_api.py",
  "src/play_book_studio/http/server_chat.py",
  "src/play_book_studio/http/wiki_vault.py",
  "src/play_book_studio/wiki_loop.py"
];

function runGitResult(gitArgs, cwd = process.cwd(), timeoutMs = 10000) {
  const result = spawnSync("git", gitArgs, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true
  });
  return {
    status: result.status ?? 1,
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? "",
    stderr: (result.stderr ?? result.error?.message ?? "").trim()
  };
}

function runGit(gitArgs, cwd = process.cwd()) {
  const result = runGitResult(gitArgs, cwd);
  return result.status === 0 ? result.stdout.trim() : "";
}

function gitMetadata(root) {
  const inside = runGit(["rev-parse", "--is-inside-work-tree"], root);
  if (inside !== "true") return { available: false };
  const status = runGit(["status", "--short"], root);
  return {
    available: true,
    branch: runGit(["branch", "--show-current"], root),
    head: runGit(["rev-parse", "--short", "HEAD"], root),
    fullHead: runGit(["rev-parse", "HEAD"], root),
    remoteOriginUrl: runGit(["config", "--get", "remote.origin.url"], root),
    treeStatus: status ? "dirty" : "clean",
    statusShort: status
  };
}

function fileSha256(root, relativePath) {
  const path = join(root, relativePath);
  if (!existsSync(path)) return "";
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function contractFileHashes(root) {
  return Object.fromEntries(contractFiles.map((relativePath) => [relativePath, fileSha256(root, relativePath)]));
}

function record(status, id, detail) {
  checks.push({ status, id, detail });
  console.log(`[${status}] ${id}: ${detail}`);
}

function pass(id, detail) {
  record("PASS", id, detail);
}

function warn(id, detail) {
  record("WARN", id, detail);
}

function fail(id, detail) {
  record("FAIL", id, detail);
}

function expect(id, condition, passDetail, failDetail = passDetail) {
  if (condition) pass(id, passDetail);
  else fail(id, failDetail);
}

function fullGitSha(value) {
  return /^[a-f0-9]{40}$/i.test(String(value ?? "").trim());
}

function approvedRemoteUrl(value) {
  const remote = String(value ?? "").trim();
  if (requireCleanSource && requireExpectedHead) return strictApprovedRemotePattern.test(remote);
  return Boolean(remote && approvedRemotePatterns.some((pattern) => pattern.test(remote)));
}

function remoteRefsContainingExpectedHead(root, expectedHead) {
  const proof = {
    remoteContainsExpectedHead: false,
    remoteRefsContainingExpectedHead: [],
    remoteVerifiedAt: checkedAt,
    remoteFetchOk: false,
    remoteVerificationError: ""
  };
  if (!fullGitSha(expectedHead)) {
    proof.remoteVerificationError = "expected PBS head is not a full 40-character SHA";
    return proof;
  }
  const fetch = runGitResult(["fetch", "--quiet", "--prune", "origin"], root, 60000);
  proof.remoteFetchOk = fetch.ok;
  if (!fetch.ok) {
    proof.remoteVerificationError = fetch.stderr || "git fetch --prune origin failed";
    return proof;
  }
  const contains = runGitResult(["branch", "-r", "--contains", expectedHead], root, 20000);
  if (!contains.ok) {
    proof.remoteVerificationError = contains.stderr || `git branch -r --contains ${expectedHead} failed`;
    return proof;
  }
  const refs = contains.stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/^\*\s*/, "").trim())
    .filter((line) => line.startsWith("origin/") && !line.includes(" -> "));
  proof.remoteRefsContainingExpectedHead = refs;
  proof.remoteContainsExpectedHead = refs.length > 0;
  if (!proof.remoteContainsExpectedHead) {
    proof.remoteVerificationError = `no fetched origin branch contains ${expectedHead}`;
  }
  return proof;
}

function readRequired(root, relativePath) {
  const path = join(root, relativePath);
  if (!existsSync(path)) {
    fail(`pbs-source:file:${relativePath}`, `${relativePath} is missing under ${root}`);
    return "";
  }
  pass(`pbs-source:file:${relativePath}`, `${relativePath} exists`);
  return readFileSync(path, "utf8");
}

function literal(text, value) {
  return text.includes(value);
}

function hasAll(text, values) {
  return values.every((value) => literal(text, value));
}

function sourceContractChecks(root) {
  const dockerfile = readRequired(root, "deploy/Dockerfile");
  const compose = readRequired(root, "docker-compose.yml");
  const serverFactory = readRequired(root, "src/play_book_studio/http/server_handler_factory.py");
  const uploadApi = readRequired(root, "src/play_book_studio/http/upload_api.py");
  const urlIngestApi = readRequired(root, "src/play_book_studio/http/url_ingest_api.py");
  const serverChat = readRequired(root, "src/play_book_studio/http/server_chat.py");
  const wikiVault = readRequired(root, "src/play_book_studio/http/wiki_vault.py");
  const wikiLoop = readRequired(root, "src/play_book_studio/wiki_loop.py");
  const cywellRuntimeSample = readRequired(process.cwd(), "deliverables/active/v0.1.4/pbs-runtime-service-contract.sample.yaml");
  const cywellPreflight = readRequired(process.cwd(), "scripts/verify-pbs-preflight.mjs");

  expect(
    "pbs-source:dockerfile:app-target",
    /FROM\s+python:3\.11-slim\s+AS\s+app/i.test(dockerfile),
    "PBS-Dev3 Dockerfile has an app runtime target",
    "PBS-Dev3 Dockerfile must expose a stable app runtime target"
  );
  expect(
    "pbs-source:dockerfile:runtime-port",
    /EXPOSE\s+8765/.test(dockerfile),
    "PBS-Dev3 app runtime exposes port 8765",
    "PBS-Dev3 app runtime must expose port 8765 to match Cywell pbs-live egress"
  );
  expect(
    "pbs-source:dockerfile:runtime-command",
    hasAll(dockerfile, ['"play_book_studio.cli"', '"ui"', '"--host"', '"0.0.0.0"', '"--port"', '"8765"']),
    "PBS-Dev3 app runtime command binds the UI/API server on 0.0.0.0:8765",
    "PBS-Dev3 app runtime command must bind the API server on 0.0.0.0:8765"
  );
  expect(
    "pbs-source:compose:app-port",
    compose.includes("${APP_HTTP_PORT:-8765}:8765"),
    "PBS-Dev3 compose app maps APP_HTTP_PORT to container port 8765",
    "PBS-Dev3 compose app must map runtime port 8765"
  );
  expect(
    "pbs-source:compose:health-endpoint",
    hasAll(compose, ["http://127.0.0.1:8765/api/health", "healthcheck"]),
    "PBS-Dev3 compose healthcheck uses /api/health on port 8765",
    "PBS-Dev3 compose healthcheck must prove the same /api/health endpoint Cywell probes"
  );
  expect(
    "pbs-source:compose:db-contract",
    hasAll(compose, ["pgvector/pgvector:pg16", "DATABASE_URL", "db-migrate", "condition: service_completed_successfully"]),
    "PBS-Dev3 compose declares pgvector, DATABASE_URL, and db-migrate dependency",
    "PBS-Dev3 compose must keep the database/migration contract explicit for Cywell live cutover"
  );
  expect(
    "pbs-source:route:health",
    serverFactory.includes('request_path == "/api/health"'),
    "PBS-Dev3 serves GET /api/health",
    "PBS-Dev3 must serve GET /api/health"
  );
  expect(
    "pbs-source:route:upload-ingest",
    serverFactory.includes('parsed_request.path == "/api/uploads/ingest"') && uploadApi.includes("def handle_upload_ingest("),
    "PBS-Dev3 serves POST /api/uploads/ingest through upload_api",
    "PBS-Dev3 must serve POST /api/uploads/ingest through upload_api"
  );
  expect(
    "pbs-source:route:url-ingest",
    serverFactory.includes('parsed_request.path == "/api/uploads/url-ingest"') && urlIngestApi.includes("build_url_ingest_response"),
    "PBS-Dev3 serves POST /api/uploads/url-ingest through url_ingest_api",
    "PBS-Dev3 must serve POST /api/uploads/url-ingest through url_ingest_api"
  );
  expect(
    "pbs-source:route:chat",
    serverFactory.includes('parsed_request.path == "/api/chat"') && serverChat.includes("def handle_chat("),
    "PBS-Dev3 serves POST /api/chat through server_chat",
    "PBS-Dev3 must serve POST /api/chat through server_chat"
  );
  expect(
    "pbs-source:route:wiki-vault",
    serverFactory.includes('request_path == "/api/wiki-vault"') && wikiVault.includes("def handle_wiki_vault("),
    "PBS-Dev3 serves GET /api/wiki-vault through wiki_vault",
    "PBS-Dev3 must serve GET /api/wiki-vault through wiki_vault"
  );
  expect(
    "pbs-source:route:wiki-vault-notes",
    serverFactory.includes('parsed_request.path == "/api/wiki-vault/notes"') && wikiVault.includes("def handle_wiki_vault_note_save("),
    "PBS-Dev3 serves POST /api/wiki-vault/notes through wiki_vault",
    "PBS-Dev3 must serve POST /api/wiki-vault/notes through wiki_vault"
  );
  expect(
    "pbs-source:route:wiki-loop-run",
    serverFactory.includes('parsed_request.path == "/api/wiki-loop/run"') && wikiLoop.includes("def run_wiki_loop_once("),
    "PBS-Dev3 serves POST /api/wiki-loop/run through wiki_loop",
    "PBS-Dev3 must serve POST /api/wiki-loop/run through wiki_loop"
  );
  expect(
    "pbs-source:route:wiki-loop-status",
    serverFactory.includes('request_path == "/api/wiki-loop/status"') && wikiLoop.includes("def build_wiki_loop_status("),
    "PBS-Dev3 serves GET /api/wiki-loop/status through wiki_loop",
    "PBS-Dev3 must serve GET /api/wiki-loop/status through wiki_loop"
  );
  expect(
    "pbs-source:owner-scope:upload-reports",
    uploadApi.includes("owner_user_id") && uploadApi.includes("upload report is not visible to this session"),
    "PBS-Dev3 upload reports expose owner-scoped visibility hooks used by Cywell PBS live calls",
    "PBS-Dev3 upload report route must retain owner-scoped visibility checks"
  );
  expect(
    "pbs-source:wiki-vault:topology-signals",
    hasAll(wikiVault, ["selected_uploads", "graph", "nodes", "edges", "chunk_previews"]),
    "PBS-Dev3 wiki vault exposes graph nodes/edges, selected uploads, and chunk previews",
    "PBS-Dev3 wiki vault must expose topology graph signals that the Cywell dashboard normalizes"
  );
  expect(
    "cywell-contract:runtime-sample",
    hasAll(cywellRuntimeSample, [
      "name: playbookstudio",
      "name: playbookstudio-runtime",
      "app.kubernetes.io/name: playbookstudio",
      "app.kubernetes.io/component: runtime",
      "port: 8765"
    ]),
    "Cywell runtime sample matches the PBS namespace/service/label/port contract",
    "Cywell runtime sample must match the PBS namespace/service/label/port contract"
  );
  expect(
    "cywell-contract:preflight-runtime",
    hasAll(cywellPreflight, [
      "playbookstudio-runtime",
      "app.kubernetes.io/name",
      "app.kubernetes.io/component",
      "8765",
      "cluster:pbs-runtime-service-endpoints"
    ]),
    "Cywell strict preflight checks the PBS service selector and ready endpoint contract",
    "Cywell strict preflight must check PBS service selector and ready endpoint contract"
  );
}

async function createSelfTestSource() {
  const root = await mkdtemp(join(tmpdir(), "cywell-pbs-source-contract-"));
  const write = async (relativePath, text) => {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  await write(
    "deploy/Dockerfile",
    `FROM python:3.11-slim AS app
EXPOSE 8765
CMD ["python", "-m", "play_book_studio.cli", "ui", "--no-browser", "--host", "0.0.0.0", "--port", "8765"]
`
  );
  await write(
    "docker-compose.yml",
    `services:
  postgres:
    image: pgvector/pgvector:pg16
  app:
    environment:
      DATABASE_URL: postgresql://playbookstudio:secret@postgres:5432/playbookstudio
    depends_on:
      db-migrate:
        condition: service_completed_successfully
    ports:
      - "\${APP_HTTP_PORT:-8765}:8765"
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/api/health', timeout=5)"]
  db-migrate:
    command: ["python", "-m", "play_book_studio.cli", "db-migrate"]
`
  );
  await write(
    "src/play_book_studio/http/server_handler_factory.py",
    `if request_path == "/api/health": pass
if request_path == "/api/wiki-vault": pass
if request_path == "/api/wiki-loop/status": pass
if parsed_request.path == "/api/chat": pass
if parsed_request.path == "/api/uploads/ingest": pass
if parsed_request.path == "/api/uploads/url-ingest": pass
if parsed_request.path == "/api/wiki-vault/notes": pass
if parsed_request.path == "/api/wiki-loop/run": pass
`
  );
  await write("src/play_book_studio/http/upload_api.py", `def handle_upload_ingest(): pass\nowner_user_id = ""\nraise Exception("upload report is not visible to this session")\n`);
  await write("src/play_book_studio/http/url_ingest_api.py", `def build_url_ingest_response(): pass\n`);
  await write("src/play_book_studio/http/server_chat.py", `def handle_chat(): pass\n`);
  await write("src/play_book_studio/http/wiki_vault.py", `def handle_wiki_vault(): pass\ndef handle_wiki_vault_note_save(): pass\nselected_uploads = []\ngraph = {"nodes": [], "edges": [], "chunk_previews": []}\n`);
  await write("src/play_book_studio/wiki_loop.py", `def run_wiki_loop_once(): pass\ndef build_wiki_loop_status(): pass\n`);
  return root;
}

async function runSelfTest() {
  const root = await createSelfTestSource();
  const remoteRoot = await createSelfTestSource();
  const bareRemote = await mkdtemp(join(tmpdir(), "cywell-pbs-source-remote-"));
  try {
    const before = checks.length;
    sourceContractChecks(root);
    const selfFailures = checks.slice(before).filter((check) => check.status === "FAIL");
    if (selfFailures.length === 0) pass("pbs-source:self-test", "synthetic PBS source contract fixture passes");
    else fail("pbs-source:self-test", `synthetic PBS source contract fixture failed: ${selfFailures.map((check) => check.id).join(", ")}`);

    runGitResult(["init", "-b", "main"], remoteRoot);
    runGitResult(["config", "user.email", "cywell-selftest@example.invalid"], remoteRoot);
    runGitResult(["config", "user.name", "Cywell Self Test"], remoteRoot);
    runGitResult(["add", "."], remoteRoot);
    runGitResult(["commit", "-m", "initial PBS contract fixture"], remoteRoot);
    runGitResult(["init", "--bare"], bareRemote);
    runGitResult(["remote", "add", "origin", bareRemote], remoteRoot);
    runGitResult(["push", "-u", "origin", "main"], remoteRoot, 60000);
    const pushedHead = runGit(["rev-parse", "HEAD"], remoteRoot);
    const pushedProof = remoteRefsContainingExpectedHead(remoteRoot, pushedHead);
    await writeFile(join(remoteRoot, "local-only-change.txt"), "not pushed\n");
    runGitResult(["add", "local-only-change.txt"], remoteRoot);
    runGitResult(["commit", "-m", "local only fixture change"], remoteRoot);
    const localOnlyHead = runGit(["rev-parse", "HEAD"], remoteRoot);
    const localOnlyProof = remoteRefsContainingExpectedHead(remoteRoot, localOnlyHead);
    expect(
      "pbs-source:self-test-remote-head-contained",
      pushedProof.remoteContainsExpectedHead === true && pushedProof.remoteRefsContainingExpectedHead.includes("origin/main"),
      "synthetic approved remote branch contains the pushed PBS source SHA",
      `expected pushed fixture SHA to be contained in origin/main: ${JSON.stringify(pushedProof)}`
    );
    expect(
      "pbs-source:self-test-local-only-head-rejected",
      localOnlyProof.remoteContainsExpectedHead === false,
      "synthetic local-only PBS source SHA is rejected because no origin branch contains it",
      `expected local-only fixture SHA to be rejected: ${JSON.stringify(localOnlyProof)}`
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
    await rm(bareRemote, { recursive: true, force: true });
  }
}

if (selfTest) {
  await runSelfTest();
}

let remoteHeadProof = null;
if (!existsSync(sourceDir)) {
  const detail = `PBS source directory not found at ${sourceDir}; set CAS_PBS_SOURCE_DIR or pass --source-dir`;
  if (requireSource) fail("pbs-source:source-dir", detail);
  else warn("pbs-source:source-dir", detail);
} else {
  pass("pbs-source:source-dir", `using PBS source directory ${sourceDir}`);
  const metadata = gitMetadata(sourceDir);
  if (requireExpectedHead && !expectedSourceHead) {
    fail("pbs-source:git-head-expected-required", "CAS_PBS_SOURCE_HEAD is required when --require-expected-head is set");
  } else if (requireExpectedHead && !fullGitSha(expectedSourceHead)) {
    fail("pbs-source:git-head-expected-full-sha", "CAS_PBS_SOURCE_HEAD must be the approved full 40-character PBS git SHA when --require-expected-head is set");
  }
  if (metadata.available) {
    pass("pbs-source:git-head", `PBS source git head ${metadata.head} on ${metadata.branch || "detached"}`);
    if (requireCleanSource && requireExpectedHead) {
      expect(
        "pbs-source:git-remote-approved",
        approvedRemoteUrl(metadata.remoteOriginUrl),
        `PBS source remote is approved: ${metadata.remoteOriginUrl}`,
        `PBS source remote.origin.url must match an approved PBS repository pattern; found ${metadata.remoteOriginUrl || "missing"}`
      );
    } else if (approvedRemoteUrl(metadata.remoteOriginUrl)) {
      pass("pbs-source:git-remote-approved", `PBS source remote is approved: ${metadata.remoteOriginUrl}`);
    } else {
      warn("pbs-source:git-remote-unverified", `PBS source remote.origin.url is not approved for strict release pinning: ${metadata.remoteOriginUrl || "missing"}`);
    }
    if (expectedSourceHead) {
      expect(
        "pbs-source:git-head-expected",
        fullGitSha(expectedSourceHead) && metadata.fullHead === expectedSourceHead,
        `PBS source head matches CAS_PBS_SOURCE_HEAD ${expectedSourceHead}`,
        `PBS source head ${metadata.fullHead || metadata.head} does not match CAS_PBS_SOURCE_HEAD ${expectedSourceHead}`
      );
    }
    if (requireCleanSource && requireExpectedHead && fullGitSha(expectedSourceHead) && approvedRemoteUrl(metadata.remoteOriginUrl)) {
      remoteHeadProof = remoteRefsContainingExpectedHead(sourceDir, expectedSourceHead);
      expect(
        "pbs-source:git-head-expected-remote-ref",
        remoteHeadProof.remoteContainsExpectedHead === true,
        `CAS_PBS_SOURCE_HEAD is contained in approved remote ref ${remoteHeadProof.remoteRefsContainingExpectedHead[0]}`,
        `CAS_PBS_SOURCE_HEAD ${expectedSourceHead} must be contained in at least one fetched approved origin branch ref: ${remoteHeadProof.remoteVerificationError || "no remote proof"}`
      );
    }
    if (requireCleanSource) {
      expect(
        "pbs-source:git-tree-clean",
        metadata.treeStatus === "clean",
        "PBS source git tree is clean",
        `PBS source git tree is dirty: ${metadata.statusShort}`
      );
    } else if (metadata.treeStatus !== "clean") {
      warn("pbs-source:git-tree-dirty", "PBS source git tree is dirty; evidence records file hashes for the checked contract files");
    } else {
      pass("pbs-source:git-tree-clean", "PBS source git tree is clean");
    }
  } else {
    warn("pbs-source:git-metadata", "PBS source directory is not a git worktree; evidence records file hashes only");
    if (requireExpectedHead) fail("pbs-source:git-head-expected", "PBS source must be a git worktree when --require-expected-head is set");
  }
  sourceContractChecks(sourceDir);
}

mkdirSync(dirname(evidencePath), { recursive: true });
const summary = {
  total: checks.length,
  passed: checks.filter((check) => check.status === "PASS").length,
  warned: checks.filter((check) => check.status === "WARN").length,
  failed: checks.filter((check) => check.status === "FAIL").length
};
const status = summary.failed ? "FAIL" : "PASS";
const cywellGit = gitMetadata(process.cwd());
const pbsSourceGit = existsSync(sourceDir) ? gitMetadata(sourceDir) : null;
writeFileSync(
  evidencePath,
  JSON.stringify(
    {
      status,
      checkedAt,
      branch: cywellGit.branch,
      head: cywellGit.head,
      fullHead: cywellGit.fullHead,
      treeStatus: cywellGit.treeStatus,
      statusShort: cywellGit.statusShort,
      sourceDir,
      pbsSource: existsSync(sourceDir)
        ? {
            ...pbsSourceGit,
            ...(typeof remoteHeadProof === "object" && remoteHeadProof ? remoteHeadProof : {}),
            expectedHead: expectedSourceHead || null,
            requireCleanSource,
            contractFileSha256: contractFileHashes(sourceDir)
          }
        : null,
      requireSource,
      requireCleanSource,
      requireExpectedHead,
      selfTest,
      summary,
      checks
    },
    null,
    2
  )
);

console.log(`PBS source contract verification final status: ${status}`);
console.log(`Evidence: ${evidencePath}`);
if (status !== "PASS") process.exit(1);
