#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const checks = [];

function record(status, id, detail) {
  checks.push({ status, id, detail });
  console.log(`[${status}] ${id}: ${detail}`);
}

function pass(id, detail) {
  record("PASS", id, detail);
}

function fail(id, detail) {
  record("FAIL", id, detail);
}

function expectText(id, text, needle, passDetail, failDetail = passDetail) {
  if (text.includes(needle)) pass(id, passDetail);
  else fail(id, failDetail);
}

function rejectText(id, text, needle, passDetail, failDetail = passDetail) {
  if (!text.includes(needle)) pass(id, passDetail);
  else fail(id, failDetail);
}

const launcherSource = await readFile("apps/console-plugin/src/plugin/useCASLauncher.tsx", "utf8");
const manifest = await readFile("apps/console-plugin/dist/plugin-manifest.json", "utf8");
const launcherBundle = await readFile("apps/console-plugin/dist/exposed-useCASLauncher-chunk.js", "utf8");

expectText(
  "console-chat:brainz",
  launcherSource,
  "/api/aiops/brainz",
  "launcher checks Gateway brain readiness before query flow"
);
expectText(
  "console-chat:query",
  launcherSource,
  "/api/aiops/query",
  "launcher posts questions through the CAS Gateway query endpoint"
);
expectText(
  "console-chat:overview",
  launcherSource,
  "/api/aiops/overview",
  "launcher loads the CAS overview cockpit endpoint"
);
expectText(
  "console-chat:conversation",
  launcherSource,
  "conversation_id",
  "launcher preserves Gateway/Lightspeed conversation_id"
);
expectText(
  "console-chat:thread",
  launcherSource,
  "data-test=\"cas-chat-thread\"",
  "launcher renders a chat thread surface"
);
expectText(
  "console-chat:assistant-message",
  launcherSource,
  "data-test={`cas-message-${message.role}`}",
  "launcher renders role-addressable chat messages"
);
expectText(
  "console-chat:fallback-visible",
  launcherSource,
  "data-test=\"cas-fallback-notice\"",
  "launcher visibly marks fallback responses"
);
expectText(
  "console-chat:replacement-language",
  launcherSource,
  "Lightspeed replacement",
  "launcher copy states CAS is the Lightspeed replacement"
);
expectText(
  "console-chat:usertoken-copy",
  launcherSource,
  "UserToken proxy",
  "launcher marks UserToken proxy integration"
);
expectText(
  "console-cockpit:health-strip",
  launcherSource,
  "data-test=\"cas-health-strip\"",
  "launcher renders a health strip for the RCA cockpit"
);
expectText(
  "console-cockpit:rca-candidate",
  launcherSource,
  "data-test=\"cas-rca-candidate\"",
  "launcher renders an RCA candidate card"
);
expectText(
  "console-cockpit:evidence-timeline",
  launcherSource,
  "data-test=\"cas-evidence-timeline\"",
  "launcher renders an evidence timeline"
);
expectText(
  "console-cockpit:action-queue",
  launcherSource,
  "data-test=\"cas-action-queue\"",
  "launcher renders an action queue"
);
expectText(
  "console-cockpit:risk-workloads",
  launcherSource,
  "data-test=\"cas-risk-workloads\"",
  "launcher renders risk workloads"
);
rejectText(
  "console-chat:no-route-ui",
  manifest,
  "console.page/route",
  "built plugin does not register a full-screen route"
);
rejectText(
  "console-chat:no-nav-ui",
  manifest,
  "console.navigation/href",
  "built plugin does not register navigation"
);
expectText(
  "console-chat:context-provider",
  manifest,
  "console.context-provider",
  "built plugin remains a launcher context-provider"
);
expectText(
  "console-chat:bundle-brainz",
  launcherBundle,
  "/api/aiops/brainz",
  "built launcher bundle contains brainz integration"
);
expectText(
  "console-chat:bundle-query",
  launcherBundle,
  "/api/aiops/query",
  "built launcher bundle contains query integration"
);
expectText(
  "console-chat:bundle-overview",
  launcherBundle,
  "/api/aiops/overview",
  "built launcher bundle contains overview integration"
);
expectText(
  "console-chat:bundle-fallback",
  launcherBundle,
  "cas-fallback-notice",
  "built launcher bundle contains fallback notice surface"
);
expectText(
  "console-cockpit:bundle-health-strip",
  launcherBundle,
  "cas-health-strip",
  "built launcher bundle contains health strip surface"
);
expectText(
  "console-cockpit:bundle-rca-candidate",
  launcherBundle,
  "cas-rca-candidate",
  "built launcher bundle contains RCA candidate surface"
);
expectText(
  "console-cockpit:bundle-action-queue",
  launcherBundle,
  "cas-action-queue",
  "built launcher bundle contains action queue surface"
);
expectText(
  "console-cockpit:bundle-risk-workloads",
  launcherBundle,
  "cas-risk-workloads",
  "built launcher bundle contains risk workload surface"
);
expectText(
  "console-cockpit:bundle-evidence-timeline",
  launcherBundle,
  "cas-evidence-timeline",
  "built launcher bundle contains evidence timeline surface"
);

const failures = checks.filter((check) => check.status === "FAIL");
if (failures.length > 0) {
  console.error(`Console integration verification failed with ${failures.length} failures.`);
  process.exitCode = 1;
} else {
  console.log(`Console integration verification passed with ${checks.length} checks.`);
}
