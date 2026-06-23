#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const gatewayPort = process.env.CAS_LOCAL_GATEWAY_PORT ?? "18080";
const consolePort = process.env.CAS_LOCAL_CONSOLE_PORT ?? "18081";
const host = process.env.CAS_LOCAL_HOST ?? "127.0.0.1";

function run(label, args, options = {}) {
  console.log(`[cas-local] ${label}: ${npmCommand} ${args.join(" ")}`);
  const result = spawnSync(npmCommand, args, {
    cwd: process.cwd(),
    env: process.env,
    shell: process.platform === "win32",
    stdio: "inherit",
    ...options
  });
  if (result.error) {
    console.error(`[cas-local] ${label} failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[cas-local] ${label} exited with code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

function start(label, args, env) {
  const child = spawn(npmCommand, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env
    },
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${label}] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${label}] ${chunk}`);
  });
  child.on("exit", (code) => {
    if (shuttingDown) return;
    console.error(`[cas-local] ${label} exited with code ${code}`);
    shutdown(code || 1);
  });
  return child;
}

let shuttingDown = false;
const children = [];

function shutdown(code = 0) {
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("build console static assets", ["run", "-w", "@cywell-ai-sentinel/console-plugin", "build"]);

children.push(
  start("gateway", ["run", "-w", "@cywell-ai-sentinel/gateway", "dev"], {
    HOST: host,
    PORT: gatewayPort,
    CAS_BRAIN_PROVIDER: "mock",
    CAS_EVIDENCE_PROVIDER: "none",
    CAS_METRIC_PROVIDER: "none",
    CAS_RUNBOOK_PROVIDER: "jsonl",
    CAS_RUNBOOK_CORPUS_PATH: "apps/gateway/runbooks/komsco-ops-sim.jsonl"
  })
);

children.push(
  start("console", ["run", "-w", "@cywell-ai-sentinel/console-plugin", "serve"], {
    HOST: host,
    PORT: consolePort,
    CAS_GATEWAY_URL: `http://${host}:${gatewayPort}`
  })
);

console.log("");
console.log("[cas-local] CAS local workbench");
console.log(`[cas-local] open: http://${host}:${consolePort}/workbench.html`);
console.log(`[cas-local] gateway: http://${host}:${gatewayPort}/api/aiops/healthz`);
console.log("[cas-local] press Ctrl+C to stop both servers");
