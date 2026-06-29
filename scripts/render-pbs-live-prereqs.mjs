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
const checkedAt = new Date().toISOString();

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
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
    Array.isArray(value) ? value.map((customer) => ({ principal, customer: String(customer).trim() })) : []
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
    ["owners", "users", "groups"].every((table) => !policy?.[table] || (typeof policy[table] === "object" && !Array.isArray(policy[table]))) &&
    entries.every((entry) => Array.isArray(policy?.[entry.table]?.[entry.principal])) &&
    entries.every(
      (entry) =>
        entry.table &&
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
    customerAccess,
    customerAccessText,
    postgresValues
  };
}

function validateInputs(inputs) {
  const errors = [];
  if (!tokenLooksUsable(inputs.token)) errors.push("CAS_PBS_BEARER_TOKEN or CAS_PBS_BEARER_TOKEN_FILE must contain non-placeholder token material with at least 20 non-whitespace characters");
  if (valueLooksPlaceholder(inputs.serviceOwner)) errors.push("CAS_KNOWLEDGE_SERVICE_OWNER must be set to a non-placeholder service owner");
  if (!inputs.customerAccess) errors.push("CAS_KNOWLEDGE_CUSTOMER_ACCESS_JSON or CAS_KNOWLEDGE_CUSTOMER_ACCESS_FILE must contain valid JSON object policy");
  else if (!customerAccessPolicyIsConcrete(inputs.customerAccess)) {
    errors.push("customer access policy must have explicit owners/users/groups entries, no default grants, and no wildcard customer IDs");
  }
  const postgres = inputs.postgresValues;
  for (const key of ["database", "username", "password", "databaseUrl"]) {
    if (valueLooksPlaceholder(postgres[key])) errors.push(`CAS_KNOWLEDGE_POSTGRES_${key === "databaseUrl" ? "DATABASE_URL" : key.toUpperCase()} must be non-placeholder`);
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
    casKnowledgePostgresLive: {
      database: inputs.postgresValues.database,
      username: inputs.postgresValues.username,
      passwordSha256: sha256(inputs.postgresValues.password),
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

function render(inputs, outDir, { write = true } = {}) {
  const errors = validateInputs(inputs);
  if (errors.length) return { ok: false, errors, files: {} };
  const files = {
    pbsAuthSecret: resolve(outDir, "cas-pbs-auth.secret.yaml"),
    postgresSecret: resolve(outDir, "cas-knowledge-postgres-live.secret.yaml"),
    liveConfig: resolve(outDir, "cas-knowledge-live-config.configmap.yaml"),
    customerAccessJson: resolve(outDir, "customer-access.json"),
    siteOverlay: resolve(outDir, "pbs-live-site"),
    siteKustomization: resolve(outDir, "pbs-live-site", "kustomization.yaml"),
    siteCustomerAccessJson: resolve(outDir, "pbs-live-site", "customer-access.json"),
    summary: resolve(outDir, "pbs-live-prereqs.summary.json")
  };
  if (write) {
    assertOutputUnderTestResults(outDir);
    mkdirSync(outDir, { recursive: true });
    mkdirSync(files.siteOverlay, { recursive: true });
    const pbsAuthSecret = secretYaml("cas-pbs-auth", { "bearer-token": inputs.token }, inputs.namespace);
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

function recordEvidence(status, checks) {
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/cas-pbs-live-prereqs-render.json",
    JSON.stringify(
      {
        checkedAt,
        branch: runGit(["branch", "--show-current"]) || process.env.GITHUB_REF_NAME || "",
        head: runGit(["rev-parse", "--short", "HEAD"]),
        status,
        checks
      },
      null,
      2
    )
  );
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
    const rendered = render(inputs, tmp);
    record(rendered.ok ? "PASS" : "FAIL", "pbs-live-prereqs:sample-render", rendered.ok ? "sample live prerequisite manifests render" : rendered.errors.join("; "));
    const summary = rendered.ok ? JSON.parse(readFileSync(rendered.files.summary, "utf8")) : {};
    record(
      summary?.casPbsAuth?.bearerTokenSha256 && !JSON.stringify(summary).includes(inputs.token) ? "PASS" : "FAIL",
      "pbs-live-prereqs:redacted-summary",
      "summary records hashes and metadata without raw Secret material"
    );
    const siteRender = rendered.ok ? runCommand("oc", ["kustomize", rendered.files.siteOverlay], { timeoutMs: 90000 }) : { ok: false, stdout: "", stderr: "render failed" };
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
    const broadGroup = buildInputs({ ...sampleEnv(), CAS_KNOWLEDGE_CUSTOMER_ACCESS_JSON: JSON.stringify({ groups: { "system:authenticated": ["customer-a"] } }) });
    record(validateInputs(broadGroup).some((error) => error.includes("customer access policy")) ? "PASS" : "FAIL", "pbs-live-prereqs:broad-group-acl-rejected", "broad Kubernetes system groups are rejected");
    const mismatch = buildInputs({ ...sampleEnv(), CAS_KNOWLEDGE_POSTGRES_DATABASE_URL: "postgresql://wrong:wrong@cas-knowledge-postgres.cywell-ai-sentinel.svc.cluster.local:5432/wrong" });
    record(validateInputs(mismatch).some((error) => error.includes("credentials/database")) ? "PASS" : "FAIL", "pbs-live-prereqs:db-url-mismatch-rejected", "database-url must match individual DB Secret fields");
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  }
  const status = checks.some((check) => check.status === "FAIL") ? "FAIL" : "PASS";
  recordEvidence(status, checks);
  if (status === "FAIL") process.exitCode = 1;
}

if (args.has("--self-test")) {
  selfTest();
} else {
  const outDir = resolve(outDirArg || defaultOutDir);
  const inputs = buildInputs(process.env);
  const result = render(inputs, outDir, { write: !args.has("--validate-only") });
  if (!result.ok) {
    for (const error of result.errors) console.error(`[FAIL] ${error}`);
    process.exitCode = 1;
  } else if (args.has("--validate-only")) {
    console.log("[PASS] PBS live prerequisite inputs validated; no files written");
  } else {
    console.log("[PASS] PBS live prerequisite manifests rendered");
    console.log(`Output directory: ${outDir}`);
    console.log("Review with:");
    console.log(`  oc diff -f ${result.files.pbsAuthSecret}`);
    console.log(`  oc diff -f ${result.files.postgresSecret}`);
    console.log(`  oc diff -f ${result.files.liveConfig}`);
    console.log(`  oc diff -k ${result.files.siteOverlay}`);
  }
}
