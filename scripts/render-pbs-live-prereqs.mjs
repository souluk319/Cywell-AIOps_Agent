#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const args = new Set(process.argv.slice(2).filter((arg) => !arg.startsWith("--out-dir=")));
const outDirArg = process.argv.find((arg) => arg.startsWith("--out-dir="))?.split("=")[1];
const namespace = process.env.CAS_PBS_LIVE_NAMESPACE || "cywell-ai-sentinel";
const defaultOutDir = join("test-results", "pbs-live-prereqs");
const defaultTemplateDir = join("test-results", "pbs-live-prereqs-input-template");
const livePrereqRenderEvidencePath = "test-results/cas-pbs-live-prereqs-render.json";
const inputValidationEvidencePath = "test-results/cas-pbs-live-prereqs-input-validation.json";
const checkedAt = new Date().toISOString();
const postgresEnvNames = {
  database: "CAS_KNOWLEDGE_POSTGRES_DB",
  username: "CAS_KNOWLEDGE_POSTGRES_USER",
  password: "CAS_KNOWLEDGE_POSTGRES_PASSWORD",
  databaseUrl: "CAS_KNOWLEDGE_POSTGRES_DATABASE_URL"
};

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function envBool(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  return ["1", "true", "yes", "y", "on"].includes(String(raw).trim().toLowerCase());
}

function runGit(args) {
  const result = spawnSync("git", args, {
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
    timeout: options.timeoutMs ?? 60000,
    windowsHide: true
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? ""
  };
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function readEnvOrFile(env, valueName, fileName) {
  const direct = String(env[valueName] ?? "").trim();
  if (direct) return direct;
  const file = String(env[fileName] ?? "").trim();
  if (file && existsSync(file)) return readFileSync(file, "utf8").trim();
  return "";
}

function valueLooksPlaceholder(value) {
  const clean = String(value ?? "").trim().toLowerCase();
  return (
    !clean ||
    /[\x00-\x1f\x7f]/.test(clean) ||
    /^(changeme|change-me|todo|placeholder|example|sample|dummy|token|bearer-token|secret|password|dev|test|default|customer|tenant|none|null|x+|\*+)$/.test(clean) ||
    clean.includes("cas_knowledge_dev")
  );
}

function tokenLooksUsable(value) {
  const clean = String(value ?? "").trim();
  return clean.length >= 20 && !/\s/.test(clean) && !valueLooksPlaceholder(clean);
}

function hmacSecretLooksUsable(value) {
  const clean = String(value ?? "").trim();
  return clean.length >= 32 && !/\s/.test(clean) && !valueLooksPlaceholder(clean);
}

function parseCustomerAccessPolicy(text) {
  try {
    const policy = JSON.parse(text);
    return policy && typeof policy === "object" && !Array.isArray(policy) ? policy : null;
  } catch {
    return null;
  }
}

function entriesFromTable(table) {
  if (!table || typeof table !== "object" || Array.isArray(table)) return [];
  return Object.entries(table).flatMap(([principal, value]) =>
    Array.isArray(value)
      ? value.map((customer) => ({
          principal,
          customer: typeof customer === "string" ? customer.trim() : "",
          customerIsString: typeof customer === "string"
        }))
      : []
  );
}

function customerPolicyEntries(policy) {
  return [
    ...entriesFromTable(policy?.owners).map((entry) => ({ ...entry, table: "owners" })),
    ...entriesFromTable(policy?.users).map((entry) => ({ ...entry, table: "users" })),
    ...entriesFromTable(policy?.groups).map((entry) => ({ ...entry, table: "groups" }))
  ];
}

function containsWildcard(value) {
  if (typeof value === "string") return value.includes("*");
  if (Array.isArray(value)) return value.some((entry) => containsWildcard(entry));
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, entry]) => key.includes("*") || containsWildcard(entry));
  }
  return false;
}

function broadPrincipal(table, principal) {
  const clean = String(principal ?? "").trim().toLowerCase();
  return (
    !clean ||
    clean.includes("*") ||
    valueLooksPlaceholder(clean) ||
    (table === "groups" &&
      (clean === "system:authenticated" ||
        clean === "system:authenticated:oauth" ||
        clean === "system:unauthenticated" ||
        clean === "system:anonymous" ||
        clean === "system:serviceaccounts" ||
        clean.startsWith("system:serviceaccounts:")))
  );
}

function customerAccessTableIsConcrete(policy, table) {
  const value = policy?.[table];
  if (!value) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((grants) => Array.isArray(grants));
}

function customerAccessPolicyIsConcrete(policy) {
  const entries = customerPolicyEntries(policy);
  const allowedTopLevelKeys = new Set(["default", "owners", "users", "groups"]);
  const unknownTopLevelKeys = Object.keys(policy ?? {}).filter((key) => !allowedTopLevelKeys.has(key));
  const hasDefaultGrant = Object.hasOwn(policy ?? {}, "default");
  return (
    entries.length > 0 &&
    !hasDefaultGrant &&
    unknownTopLevelKeys.length === 0 &&
    !containsWildcard(policy) &&
    ["owners", "users", "groups"].every((table) => customerAccessTableIsConcrete(policy, table)) &&
    entries.every((entry) => Array.isArray(policy?.[entry.table]?.[entry.principal])) &&
    entries.every(
      (entry) =>
        entry.table &&
        entry.customerIsString &&
        entry.customer &&
        entry.principal &&
        !valueLooksPlaceholder(entry.customer) &&
        !broadPrincipal(entry.table, entry.principal)
    )
  );
}

function assertOutputUnderTestResults(outDir) {
  const root = resolve("test-results");
  const target = resolve(outDir);
  const targetRelative = relative(root, target);
  if (targetRelative.startsWith("..") || isAbsolute(targetRelative)) {
    throw new Error(`refusing to write live prerequisite material outside ignored test-results/: ${target}`);
  }
}

function pathInside(parent, child) {
  const relativePath = relative(resolve(parent), resolve(child));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function evidencePath(path) {
  const target = resolve(path);
  const repoRelative = relative(process.cwd(), target);
  if (repoRelative && !repoRelative.startsWith("..") && !isAbsolute(repoRelative)) return repoRelative;
  return target;
}

function assertRealOutputAllowed(outDir, { allowRepoOutput = false } = {}) {
  const target = resolve(outDir);
  const repoRoot = resolve(".");
  if (pathInside(repoRoot, target)) {
    if (allowRepoOutput) return;
    throw new Error(
      "refusing to write raw live Secret manifests inside the repository; set CAS_PBS_LIVE_PREREQS_OUT_DIR or --out-dir to an approved secure handoff path outside the repo, or explicitly set CAS_PBS_LIVE_PREREQS_ALLOW_REPO_OUTPUT=true only for disposable lab rehearsal"
    );
  }
}

function liveDatabaseUrlUsesService(urlText, targetNamespace = namespace) {
  try {
    const url = new URL(urlText);
    const allowedHosts = new Set([
      "cas-knowledge-postgres",
      `cas-knowledge-postgres.${targetNamespace}`,
      `cas-knowledge-postgres.${targetNamespace}.svc`,
      `cas-knowledge-postgres.${targetNamespace}.svc.cluster.local`
    ]);
    return url.protocol.startsWith("postgres") && allowedHosts.has(url.hostname) && (url.port === "" || url.port === "5432");
  } catch {
    return false;
  }
}

function databaseUrlMatchesSecret(urlText, values) {
  try {
    const url = new URL(urlText);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    return decodeURIComponent(url.username) === values.username && decodeURIComponent(url.password) === values.password && database === values.database;
  } catch {
    return false;
  }
}

function deriveDatabaseUrl(env, values, targetNamespace) {
  const explicit = String(env.CAS_KNOWLEDGE_POSTGRES_DATABASE_URL ?? "").trim();
  if (explicit) return explicit;
  if (!values.database || !values.username || !values.password) return "";
  const username = encodeURIComponent(values.username);
  const password = encodeURIComponent(values.password);
  const database = encodeURIComponent(values.database);
  return `postgresql://${username}:${password}@cas-knowledge-postgres.${targetNamespace}.svc.cluster.local:5432/${database}`;
}

function buildInputs(env = process.env) {
  const targetNamespace = env.CAS_PBS_LIVE_NAMESPACE || "cywell-ai-sentinel";
  const token = readEnvOrFile(env, "CAS_PBS_BEARER_TOKEN", "CAS_PBS_BEARER_TOKEN_FILE") || String(env.CAS_PBS_API_KEY ?? "").trim();
  const ownerHmacSecret = readEnvOrFile(env, "CAS_KNOWLEDGE_OWNER_HMAC_SECRET", "CAS_KNOWLEDGE_OWNER_HMAC_SECRET_FILE");
  const customerAccessText = readEnvOrFile(env, "CAS_KNOWLEDGE_CUSTOMER_ACCESS_JSON", "CAS_KNOWLEDGE_CUSTOMER_ACCESS_FILE");
  const customerAccess = parseCustomerAccessPolicy(customerAccessText);
  const postgresValues = {
    database: String(env.CAS_KNOWLEDGE_POSTGRES_DB ?? "").trim(),
    username: String(env.CAS_KNOWLEDGE_POSTGRES_USER ?? "").trim(),
    password: String(env.CAS_KNOWLEDGE_POSTGRES_PASSWORD ?? "").trim(),
    databaseUrl: ""
  };
  postgresValues.databaseUrl = deriveDatabaseUrl(env, postgresValues, targetNamespace);
  return {
    namespace: targetNamespace,
    serviceOwner: String(env.CAS_KNOWLEDGE_SERVICE_OWNER ?? "").trim(),
    token,
    ownerHmacSecret,
    customerAccess,
    customerAccessText,
    postgresValues
  };
}

function validateInputs(inputs) {
  const errors = [];
  if (!tokenLooksUsable(inputs.token)) errors.push("CAS_PBS_BEARER_TOKEN or CAS_PBS_BEARER_TOKEN_FILE must contain non-placeholder token material with at least 20 non-whitespace characters");
  if (!hmacSecretLooksUsable(inputs.ownerHmacSecret)) errors.push("CAS_KNOWLEDGE_OWNER_HMAC_SECRET or CAS_KNOWLEDGE_OWNER_HMAC_SECRET_FILE must contain non-placeholder HMAC material with at least 32 non-whitespace characters");
  if (valueLooksPlaceholder(inputs.serviceOwner)) errors.push("CAS_KNOWLEDGE_SERVICE_OWNER must be set to a non-placeholder service owner");
  if (!inputs.customerAccess) errors.push("CAS_KNOWLEDGE_CUSTOMER_ACCESS_JSON or CAS_KNOWLEDGE_CUSTOMER_ACCESS_FILE must contain valid JSON object policy");
  else if (!customerAccessPolicyIsConcrete(inputs.customerAccess)) {
    errors.push("customer access policy must have explicit owners/users/groups entries, no default grants, and no wildcard customer IDs");
  }
  const postgres = inputs.postgresValues;
  for (const key of ["database", "username", "password", "databaseUrl"]) {
    if (valueLooksPlaceholder(postgres[key])) errors.push(`${postgresEnvNames[key]} must be non-placeholder`);
  }
  if (postgres.password && postgres.password.length < 16) errors.push("CAS_KNOWLEDGE_POSTGRES_PASSWORD must be at least 16 characters");
  if (!liveDatabaseUrlUsesService(postgres.databaseUrl, inputs.namespace)) errors.push("CAS_KNOWLEDGE_POSTGRES_DATABASE_URL must target cas-knowledge-postgres Service DNS on port 5432");
  if (!databaseUrlMatchesSecret(postgres.databaseUrl, postgres)) errors.push("CAS_KNOWLEDGE_POSTGRES_DATABASE_URL credentials/database must match DB, USER, and PASSWORD inputs");
  return errors;
}

function secretYaml(name, data, targetNamespace) {
  const entries = Object.entries(data)
    .map(([key, value]) => `  ${key}: ${yamlString(value)}`)
    .join("\n");
  return [
    "apiVersion: v1",
    "kind: Secret",
    "metadata:",
    `  name: ${name}`,
    `  namespace: ${targetNamespace}`,
    "type: Opaque",
    "stringData:",
    entries,
    ""
  ].join("\n");
}

function configMapYaml(name, data, targetNamespace) {
  const entries = Object.entries(data)
    .map(([key, value]) => `  ${key}: ${yamlString(value)}`)
    .join("\n");
  return ["apiVersion: v1", "kind: ConfigMap", "metadata:", `  name: ${name}`, `  namespace: ${targetNamespace}`, "data:", entries, ""].join("\n");
}

function posixRelative(from, to) {
  return relative(from, to).replace(/\\/g, "/");
}

function siteKustomization(inputs, files, outDir) {
  const siteDir = resolve(outDir, "pbs-live-site");
  const pbsLiveOverlay = resolve("deploy/kustomize/overlays/pbs-live");
  const kustomization = [
    "apiVersion: kustomize.config.k8s.io/v1beta1",
    "kind: Kustomization",
    "resources:",
    `  - ${posixRelative(siteDir, pbsLiveOverlay)}`,
    "generatorOptions:",
    "  disableNameSuffixHash: true",
    "configMapGenerator:",
    "  - name: cas-knowledge-live-config",
    "    namespace: " + inputs.namespace,
    "    behavior: replace",
    "    literals:",
    `      - service-owner=${inputs.serviceOwner}`,
    "    files:",
    "      - customer-access-json=customer-access.json",
    ""
  ].join("\n");
  return { siteDir, kustomization };
}

function redactedSummary(inputs, files) {
  const postgresUrl = new URL(inputs.postgresValues.databaseUrl);
  return {
    checkedAt,
    namespace: inputs.namespace,
    files,
    casPbsAuth: {
      bearerTokenSha256: sha256(inputs.token),
      bearerTokenLength: inputs.token.length
    },
    casKnowledgeInternalAuth: {
      ownerHmacSecretSha256: sha256(inputs.ownerHmacSecret),
      ownerHmacSecretLength: inputs.ownerHmacSecret.length
    },
    casKnowledgePostgresLive: {
      database: inputs.postgresValues.database,
      username: inputs.postgresValues.username,
      passwordSha256: sha256(inputs.postgresValues.password),
      databaseUrlSha256: sha256(inputs.postgresValues.databaseUrl),
      databaseUrlHost: postgresUrl.hostname,
      databaseUrlPort: postgresUrl.port || "5432",
      databaseUrlDatabase: decodeURIComponent(postgresUrl.pathname.replace(/^\//, ""))
    },
    casKnowledgeLiveConfig: {
      serviceOwner: inputs.serviceOwner,
      customerEntryCount: customerPolicyEntries(inputs.customerAccess).length,
      customerTables: Object.fromEntries(["owners", "users", "groups"].map((key) => [key, Object.keys(inputs.customerAccess?.[key] ?? {}).length]))
    }
  };
}

function render(inputs, outDir, { write = true, allowRepoOutput = false } = {}) {
  const errors = validateInputs(inputs);
  if (errors.length) return { ok: false, errors, files: {} };
  const files = {
    pbsAuthSecret: resolve(outDir, "cas-pbs-auth.secret.yaml"),
    ownerAuthSecret: resolve(outDir, "cas-knowledge-internal-auth.secret.yaml"),
    postgresSecret: resolve(outDir, "cas-knowledge-postgres-live.secret.yaml"),
    liveConfig: resolve(outDir, "cas-knowledge-live-config.configmap.yaml"),
    customerAccessJson: resolve(outDir, "customer-access.json"),
    siteOverlay: resolve(outDir, "pbs-live-site"),
    siteKustomization: resolve(outDir, "pbs-live-site", "kustomization.yaml"),
    siteCustomerAccessJson: resolve(outDir, "pbs-live-site", "customer-access.json"),
    summary: resolve(outDir, "pbs-live-prereqs.summary.json")
  };
  if (write) {
    try {
      assertRealOutputAllowed(outDir, { allowRepoOutput });
    } catch (error) {
      return { ok: false, errors: [error instanceof Error ? error.message : String(error)], files };
    }
    mkdirSync(outDir, { recursive: true });
    mkdirSync(files.siteOverlay, { recursive: true });
    const pbsAuthSecret = secretYaml("cas-pbs-auth", { "bearer-token": inputs.token }, inputs.namespace);
    const ownerAuthSecret = secretYaml("cas-knowledge-internal-auth", { "owner-hmac-secret": inputs.ownerHmacSecret }, inputs.namespace);
    const postgresSecret = secretYaml(
        "cas-knowledge-postgres-live",
        {
          database: inputs.postgresValues.database,
          username: inputs.postgresValues.username,
          password: inputs.postgresValues.password,
          "database-url": inputs.postgresValues.databaseUrl
        },
        inputs.namespace
      );
    writeFileSync(files.pbsAuthSecret, pbsAuthSecret);
    writeFileSync(files.ownerAuthSecret, ownerAuthSecret);
    writeFileSync(files.postgresSecret, postgresSecret);
    writeFileSync(
      files.liveConfig,
      configMapYaml(
        "cas-knowledge-live-config",
        {
          "service-owner": inputs.serviceOwner,
          "customer-access-json": JSON.stringify(inputs.customerAccess)
        },
        inputs.namespace
      )
    );
    writeFileSync(files.customerAccessJson, JSON.stringify(inputs.customerAccess));
    writeFileSync(files.siteCustomerAccessJson, JSON.stringify(inputs.customerAccess));
    writeFileSync(files.siteKustomization, siteKustomization(inputs, files, outDir).kustomization);
    writeFileSync(files.summary, JSON.stringify(redactedSummary(inputs, files), null, 2));
  }
  return { ok: true, errors: [], files };
}

function sampleEnv() {
  const password = `LivePg-${randomBytes(12).toString("hex")}`;
  return {
    CAS_PBS_LIVE_NAMESPACE: "cywell-ai-sentinel",
    CAS_PBS_BEARER_TOKEN: `live-token-${randomBytes(24).toString("hex")}`,
    CAS_KNOWLEDGE_OWNER_HMAC_SECRET: randomBytes(32).toString("hex"),
    CAS_KNOWLEDGE_SERVICE_OWNER: "cas-pbs-live",
    CAS_KNOWLEDGE_CUSTOMER_ACCESS_JSON: JSON.stringify({
      groups: {
        "customer-a-ops": ["customer-a"],
        "customer-b-ops": ["customer-b"]
      }
    }),
    CAS_KNOWLEDGE_POSTGRES_DB: "cas_knowledge_live",
    CAS_KNOWLEDGE_POSTGRES_USER: "cas_knowledge_live",
    CAS_KNOWLEDGE_POSTGRES_PASSWORD: password,
    CAS_KNOWLEDGE_POSTGRES_DATABASE_URL: `postgresql://cas_knowledge_live:${encodeURIComponent(password)}@cas-knowledge-postgres.cywell-ai-sentinel.svc.cluster.local:5432/cas_knowledge_live`
  };
}

function inputTemplateFiles(targetNamespace = namespace) {
  const readme = [
    "# PBS Live Prerequisite Input Template",
    "",
    "Copy these files to an approved secure handoff location, replace placeholders there, and keep raw Secret values out of git.",
    "",
    "1. Store the PBS bearer token in `pbs-live-token.txt`.",
    "2. Store the Gateway -> Knowledge Engine owner HMAC secret in `cas-owner-hmac-secret.txt`.",
    "3. Review and replace `customer-access.example.json` with explicit owners/users/groups to customer workspace mappings.",
    "4. Set a live Postgres password from the target secret manager.",
    "5. Run `set-pbs-live-prereqs.template.ps1` after replacing placeholder paths and values.",
    "",
    "The renderer rejects wildcard/default ACLs, placeholder values, short tokens, weak HMAC material, and Postgres URLs that do not match the DB Secret fields.",
    ""
  ].join("\n");
  const powershell = [
    "# Copy this file outside the repository before filling real values.",
    "# Do not commit the filled copy.",
    `$env:CAS_PBS_LIVE_NAMESPACE="${targetNamespace}"`,
    '$env:CAS_PBS_BEARER_TOKEN_FILE="C:\\secure-handoff\\pbs-live-token.txt"',
    '$env:CAS_KNOWLEDGE_OWNER_HMAC_SECRET_FILE="C:\\secure-handoff\\cas-owner-hmac-secret.txt"',
    '$env:CAS_KNOWLEDGE_SERVICE_OWNER="cas-pbs-live"',
    '$env:CAS_KNOWLEDGE_CUSTOMER_ACCESS_FILE="C:\\secure-handoff\\customer-access.json"',
    '$env:CAS_KNOWLEDGE_POSTGRES_DB="cas_knowledge_live"',
    '$env:CAS_KNOWLEDGE_POSTGRES_USER="cas_knowledge_live"',
    '$env:CAS_KNOWLEDGE_POSTGRES_PASSWORD="<replace-with-secret-manager-value>"',
    `$env:CAS_KNOWLEDGE_POSTGRES_DATABASE_URL="postgresql://cas_knowledge_live:<url-encoded-password>@cas-knowledge-postgres.${targetNamespace}.svc.cluster.local:5432/cas_knowledge_live"`,
    "",
    "npm run render:pbs:live-prereqs",
    ""
  ].join("\n");
  const customerAccess = JSON.stringify(
    {
      groups: {
        "customer-a-ops": ["customer-a"],
        "customer-b-ops": ["customer-b"]
      },
      users: {
        "alice@example.com": ["customer-a"]
      }
    },
    null,
    2
  );
  return {
    "README.md": readme,
    "set-pbs-live-prereqs.template.ps1": powershell,
    "customer-access.example.json": `${customerAccess}\n`,
    "pbs-live-token.txt.example": "<replace-with-approved-pbs-bearer-token>\n",
    "cas-owner-hmac-secret.txt.example": "<replace-with-approved-32-plus-character-hmac-secret>\n"
  };
}

function writeInputTemplate(templateDir) {
  assertOutputUnderTestResults(templateDir);
  mkdirSync(templateDir, { recursive: true });
  const files = inputTemplateFiles();
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(templateDir, name), content);
  }
  return Object.keys(files).map((name) => join(templateDir, name));
}

function gitEvidence() {
  const status = runGit(["status", "--short"]);
  return {
    branch: runGit(["branch", "--show-current"]) || process.env.GITHUB_REF_NAME || "",
    head: runGit(["rev-parse", "--short", "HEAD"]),
    fullHead: runGit(["rev-parse", "HEAD"]),
    treeStatus: status ? "dirty" : "clean",
    statusShort: status
  };
}

function recordEvidence(status, checks, extra = {}, evidencePath = livePrereqRenderEvidencePath) {
  const git = gitEvidence();
  const summary = {
    total: checks.length,
    passed: checks.filter((check) => check.status === "PASS").length,
    warned: checks.filter((check) => check.status === "WARN").length,
    failed: checks.filter((check) => check.status === "FAIL").length
  };
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        checkedAt,
        branch: git.branch,
        head: git.head,
        fullHead: git.fullHead,
        treeStatus: git.treeStatus,
        status,
        summary,
        ...extra,
        checks
      },
      null,
      2
    )
  );
}

function recordInputValidationEvidence(inputs, errors, outputDir, evidencePath = inputValidationEvidencePath) {
  const checks = errors.map((error, index) => ({
    status: "FAIL",
    id: `pbs-live-prereqs:input-validation:${index + 1}`,
    detail: error
  }));
  recordEvidence("FAIL", checks, {
    mode: "input-validation",
    namespace: inputs.namespace,
    outputDir: relative(process.cwd(), outputDir),
    inputErrorCount: errors.length,
    inputErrors: errors,
    requiredInputs: [
      "CAS_PBS_BEARER_TOKEN or CAS_PBS_BEARER_TOKEN_FILE",
      "CAS_KNOWLEDGE_OWNER_HMAC_SECRET or CAS_KNOWLEDGE_OWNER_HMAC_SECRET_FILE",
      "CAS_KNOWLEDGE_SERVICE_OWNER",
      "CAS_KNOWLEDGE_CUSTOMER_ACCESS_JSON or CAS_KNOWLEDGE_CUSTOMER_ACCESS_FILE",
      "CAS_KNOWLEDGE_POSTGRES_DB",
      "CAS_KNOWLEDGE_POSTGRES_USER",
      "CAS_KNOWLEDGE_POSTGRES_PASSWORD",
      "CAS_KNOWLEDGE_POSTGRES_DATABASE_URL"
    ]
  }, evidencePath);
}

function siteRenderCommand(siteOverlay) {
  const attempts = [
    ["oc", ["kustomize", siteOverlay]],
    ["kubectl", ["kustomize", siteOverlay]]
  ];
  for (const [command, commandArgs] of attempts) {
    const result = runCommand(command, commandArgs, { timeoutMs: 90000 });
    if (result.ok && result.stdout.trim()) return { ...result, command, commandArgs };
  }
  return { ok: false, command: "oc/kubectl", commandArgs: ["kustomize", siteOverlay], stdout: "", stderr: "unable to render generated site overlay" };
}

function outputFileEvidence(files, rootDir) {
  const outputFiles = [
    "pbsAuthSecret",
    "ownerAuthSecret",
    "postgresSecret",
    "liveConfig",
    "customerAccessJson",
    "siteKustomization",
    "siteCustomerAccessJson",
    "summary"
  ];
  return Object.fromEntries(
    outputFiles.map((key) => [
      key,
      {
        path: evidencePath(files[key]),
        sha256: existsSync(files[key]) ? sha256File(files[key]) : "",
        underOutputDir: pathInside(rootDir, files[key])
      }
    ])
  );
}

function recordRenderEvidence(inputs, result, outputDir, mode = "real-render") {
  const checks = [];
  const record = (status, id, detail) => {
    checks.push({ status, id, detail });
    console.log(`[${status}] ${id}: ${detail}`);
  };
  record("PASS", "pbs-live-prereqs:real-render", "real PBS live prerequisite manifests rendered");
  const summary = JSON.parse(readFileSync(result.files.summary, "utf8"));
  const summaryText = JSON.stringify(summary);
  record(
    summary?.casPbsAuth?.bearerTokenSha256 &&
      summary?.casKnowledgeInternalAuth?.ownerHmacSecretSha256 &&
      !summaryText.includes(inputs.token) &&
      !summaryText.includes(inputs.ownerHmacSecret) &&
      !summaryText.includes(inputs.postgresValues.password)
      ? "PASS"
      : "FAIL",
    "pbs-live-prereqs:real-redacted-summary",
    "real render summary records hashes and metadata without raw Secret material"
  );
  const siteRender = siteRenderCommand(result.files.siteOverlay);
  record(
    siteRender.ok && siteRender.stdout.includes("name: cas-knowledge-live-config") ? "PASS" : "FAIL",
    "pbs-live-prereqs:real-site-overlay-render",
    siteRender.ok ? "generated pbs-live site overlay renders" : siteRender.stderr
  );
  const status = checks.some((check) => check.status === "FAIL") ? "FAIL" : "PASS";
  recordEvidence(status, checks, {
    mode,
    namespace: inputs.namespace,
    outputDir: evidencePath(outputDir),
    outputFileSha256: outputFileEvidence(result.files, outputDir),
    renderedSiteOverlaySha256: siteRender.ok ? sha256(siteRender.stdout) : "",
    renderedSiteOverlayCommand: `${siteRender.command} ${siteRender.commandArgs.join(" ")}`,
    redactedSummarySha256: sha256File(result.files.summary),
    customerAccessEntryCount: customerPolicyEntries(inputs.customerAccess).length
  });
  if (status === "FAIL") process.exitCode = 1;
}

function selfTest() {
  const checks = [];
  const record = (status, id, detail) => {
    checks.push({ status, id, detail });
    console.log(`[${status}] ${id}: ${detail}`);
  };
  const tmp = join("test-results", `pbs-live-prereqs-self-test-${Date.now()}-${process.pid}`);
  try {
    const inputs = buildInputs(sampleEnv());
    const rendered = render(inputs, tmp, { allowRepoOutput: true });
    record(rendered.ok ? "PASS" : "FAIL", "pbs-live-prereqs:sample-render", rendered.ok ? "sample live prerequisite manifests render" : rendered.errors.join("; "));
    const repoOutputRejected = render(inputs, join(tmp, "raw-secret-output"));
    const repoRootOutputRejected = render(inputs, ".");
    record(
      !repoOutputRejected.ok && repoOutputRejected.errors.some((error) => error.includes("refusing to write raw live Secret manifests inside the repository"))
        ? "PASS"
        : "FAIL",
      "pbs-live-prereqs:repo-raw-output-rejected",
      "real live prerequisite Secret manifests require an approved secure output path outside the repository unless lab override is explicit"
    );
    record(
      !repoRootOutputRejected.ok &&
        repoRootOutputRejected.errors.some((error) => error.includes("refusing to write raw live Secret manifests inside the repository")) &&
        !existsSync("cas-pbs-auth.secret.yaml") &&
        !existsSync("cas-knowledge-internal-auth.secret.yaml") &&
        !existsSync("cas-knowledge-postgres-live.secret.yaml")
        ? "PASS"
        : "FAIL",
      "pbs-live-prereqs:repo-root-output-rejected",
      "real live prerequisite Secret manifests cannot be written directly to the repository root"
    );
    const summary = rendered.ok ? JSON.parse(readFileSync(rendered.files.summary, "utf8")) : {};
    record(
      summary?.casPbsAuth?.bearerTokenSha256 && !JSON.stringify(summary).includes(inputs.token) ? "PASS" : "FAIL",
      "pbs-live-prereqs:redacted-summary",
      "summary records hashes and metadata without raw Secret material"
    );
    const badHmac = buildInputs({ ...sampleEnv(), CAS_KNOWLEDGE_OWNER_HMAC_SECRET: "change-me" });
    record(validateInputs(badHmac).some((error) => error.includes("CAS_KNOWLEDGE_OWNER_HMAC_SECRET")) ? "PASS" : "FAIL", "pbs-live-prereqs:bad-owner-hmac-rejected", "placeholder owner HMAC secret is rejected");
    const siteRender = rendered.ok ? siteRenderCommand(rendered.files.siteOverlay) : { ok: false, stdout: "", stderr: "render failed" };
    record(
      siteRender.ok &&
        siteRender.stdout.includes("name: cas-knowledge-live-config") &&
        siteRender.stdout.includes("customer-a-ops") &&
        !siteRender.stdout.includes('["*"]') &&
        !siteRender.stdout.includes("default:")
        ? "PASS"
        : "FAIL",
      "pbs-live-prereqs:site-overlay-render",
      siteRender.ok ? "generated pbs-live site overlay renders concrete ACL ConfigMap replacement" : siteRender.stderr
    );
    const wildcard = buildInputs({ ...sampleEnv(), CAS_KNOWLEDGE_CUSTOMER_ACCESS_JSON: JSON.stringify({ default: ["*"], groups: { ops: ["customer-a"] } }) });
    record(validateInputs(wildcard).some((error) => error.includes("customer access policy")) ? "PASS" : "FAIL", "pbs-live-prereqs:wildcard-acl-rejected", "wildcard/default ACL policy is rejected");
    const stringWildcard = buildInputs({ ...sampleEnv(), CAS_KNOWLEDGE_CUSTOMER_ACCESS_JSON: JSON.stringify({ owners: { "alice@example.com": ["customer-a"], "bob@example.com": "customer-*" } }) });
    record(validateInputs(stringWildcard).some((error) => error.includes("customer access policy")) ? "PASS" : "FAIL", "pbs-live-prereqs:string-wildcard-acl-rejected", "string wildcard ACL policy is rejected");
    const stringGrant = buildInputs({ ...sampleEnv(), CAS_KNOWLEDGE_CUSTOMER_ACCESS_JSON: JSON.stringify({ users: { "alice@example.com": ["customer-a"] }, groups: { "customer-a-ops": "customer-a" } }) });
    record(validateInputs(stringGrant).some((error) => error.includes("customer access policy")) ? "PASS" : "FAIL", "pbs-live-prereqs:string-grant-acl-rejected", "non-wildcard string ACL grants are rejected");
    const broadGroup = buildInputs({ ...sampleEnv(), CAS_KNOWLEDGE_CUSTOMER_ACCESS_JSON: JSON.stringify({ groups: { "system:authenticated": ["customer-a"] } }) });
    record(validateInputs(broadGroup).some((error) => error.includes("customer access policy")) ? "PASS" : "FAIL", "pbs-live-prereqs:broad-group-acl-rejected", "broad Kubernetes system groups are rejected");
    const nonStringAcl = buildInputs({ ...sampleEnv(), CAS_KNOWLEDGE_CUSTOMER_ACCESS_JSON: JSON.stringify({ groups: { "customer-a-ops": ["customer-a", { id: "customer-b" }, 42] } }) });
    record(validateInputs(nonStringAcl).some((error) => error.includes("customer access policy")) ? "PASS" : "FAIL", "pbs-live-prereqs:non-string-acl-rejected", "non-string customer ACL entries are rejected");
    const mismatch = buildInputs({ ...sampleEnv(), CAS_KNOWLEDGE_POSTGRES_DATABASE_URL: "postgresql://wrong:wrong@cas-knowledge-postgres.cywell-ai-sentinel.svc.cluster.local:5432/wrong" });
    record(validateInputs(mismatch).some((error) => error.includes("credentials/database")) ? "PASS" : "FAIL", "pbs-live-prereqs:db-url-mismatch-rejected", "database-url must match individual DB Secret fields");
    const emptyErrors = validateInputs(buildInputs({}));
    record(
      emptyErrors.includes("CAS_KNOWLEDGE_POSTGRES_DB must be non-placeholder") &&
        emptyErrors.includes("CAS_KNOWLEDGE_POSTGRES_USER must be non-placeholder") &&
        !emptyErrors.some((error) => error.includes("POSTGRES_DATABASE must be non-placeholder") || error.includes("POSTGRES_USERNAME"))
        ? "PASS"
        : "FAIL",
      "pbs-live-prereqs:input-error-env-names",
      "input validation errors name the actual supported Postgres env vars"
    );
    const templateDir = join(tmp, "input-template");
    const templateFiles = writeInputTemplate(templateDir);
    const templateText = templateFiles.map((file) => readFileSync(file, "utf8")).join("\n");
    record(
      templateFiles.length === 5 &&
        templateText.includes("CAS_PBS_BEARER_TOKEN_FILE") &&
        templateText.includes("CAS_KNOWLEDGE_CUSTOMER_ACCESS_FILE") &&
        !templateText.includes("live-token-") &&
        !templateText.includes("LivePg-")
        ? "PASS"
        : "FAIL",
      "pbs-live-prereqs:input-template",
      "input template writes non-secret handoff files under ignored test-results"
    );
    const invalidEvidencePath = join(tmp, "input-validation-evidence.json");
    recordInputValidationEvidence(buildInputs({}), emptyErrors, join(tmp, "invalid-output"), invalidEvidencePath);
    const invalidEvidence = JSON.parse(readFileSync(invalidEvidencePath, "utf8"));
    record(
      invalidEvidence.status === "FAIL" &&
        invalidEvidence.mode === "input-validation" &&
        invalidEvidence.fullHead &&
        invalidEvidence.inputErrorCount === emptyErrors.length &&
        invalidEvidence.summary?.total === emptyErrors.length &&
        invalidEvidence.summary?.failed === emptyErrors.length &&
        invalidEvidence.summary?.passed === 0 &&
        !JSON.stringify(invalidEvidence).includes("LivePg-") &&
        invalidEvidence.checks.every((check) => check.status === "FAIL")
        ? "PASS"
        : "FAIL",
      "pbs-live-prereqs:input-validation-evidence",
      "input validation failures write current-head redacted evidence"
    );
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  }
  const status = checks.some((check) => check.status === "FAIL") ? "FAIL" : "PASS";
  recordEvidence(status, checks, { mode: "self-test" }, "test-results/cas-pbs-live-prereqs-self-test.json");
  if (status === "FAIL") process.exitCode = 1;
}

if (args.has("--self-test")) {
  selfTest();
} else if (args.has("--write-input-template")) {
  const templateDir = resolve(outDirArg || defaultTemplateDir);
  const files = writeInputTemplate(templateDir);
  console.log("[PASS] PBS live prerequisite input template written");
  for (const file of files) console.log(`  ${file}`);
} else {
  const outDir = resolve(outDirArg || process.env.CAS_PBS_LIVE_PREREQS_OUT_DIR || defaultOutDir);
  const inputs = buildInputs(process.env);
  const result = render(inputs, outDir, {
    write: !args.has("--validate-only"),
    allowRepoOutput: args.has("--allow-repo-output") || envBool("CAS_PBS_LIVE_PREREQS_ALLOW_REPO_OUTPUT")
  });
  if (!result.ok) {
    for (const error of result.errors) console.error(`[FAIL] ${error}`);
    recordInputValidationEvidence(inputs, result.errors, outDir);
    process.exitCode = 1;
  } else if (args.has("--validate-only")) {
    console.log("[PASS] PBS live prerequisite inputs validated; no files written");
  } else {
    console.log("[PASS] PBS live prerequisite manifests rendered");
    console.log(`Output directory: ${outDir}`);
    recordRenderEvidence(inputs, result, outDir);
    console.log("Review with:");
    console.log(`  oc diff -f ${result.files.pbsAuthSecret}`);
    console.log(`  oc diff -f ${result.files.ownerAuthSecret}`);
    console.log(`  oc diff -f ${result.files.postgresSecret}`);
    console.log(`  oc diff -f ${result.files.liveConfig}`);
    console.log(`  oc diff -k ${result.files.siteOverlay}`);
  }
}
