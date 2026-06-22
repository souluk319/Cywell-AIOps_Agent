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

function questionBankSize(text) {
  const match = text.match(/const OCP_AIOPS_QUESTION_BANK = \[([\s\S]*?)\];/);
  if (!match) return 0;
  return (match[1].match(/"[^"]+"/g) ?? []).length;
}

const launcherSource = await readFile("apps/console-plugin/src/plugin/useCASLauncher.tsx", "utf8");
const providerSource = await readFile("apps/console-plugin/src/plugin/CASContextProvider.tsx", "utf8");
const staticAppSource = await readFile("apps/console-plugin/src/static/app.js", "utf8");
const manifest = await readFile("apps/console-plugin/dist/plugin-manifest.json", "utf8");
const launcherBundle = await readFile("apps/console-plugin/dist/exposed-useCASLauncher-chunk.js", "utf8");
const providerBundle = await readFile("apps/console-plugin/dist/exposed-CASContextProvider-chunk.js", "utf8");

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
  "console-chat:default-view",
  launcherSource,
  "data-test=\"cas-chat-default-view\"",
  "launcher defaults to a chat-first surface"
);
expectText(
  "console-chat:view-switcher",
  launcherSource,
  "data-test=\"cas-view-switcher\"",
  "launcher exposes header icon view switching"
);
expectText(
  "console-chat:enter-send",
  launcherSource,
  "handleQuestionKeyDown",
  "launcher supports Enter to send and Shift+Enter for newline"
);
expectText(
  "console-chat:stop-action",
  launcherSource,
  "data-test=\"cas-stop-analysis\"",
  "launcher exposes a stop action while a query is running"
);
expectText(
  "console-chat:copy-retry",
  launcherSource,
  "copyMessage",
  "launcher exposes assistant message copy and retry helpers"
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
  "console-chat:suggestion-list",
  launcherSource,
  "data-test=\"cas-suggestion-list\"",
  "launcher renders recommended question suggestions"
);
expectText(
  "console-chat:suggestion-count",
  launcherSource,
  "RECOMMENDED_QUESTION_COUNT = 5",
  "launcher shows five recommended questions"
);
expectText(
  "console-chat:suggestion-randomizer",
  launcherSource,
  "pickQuestionSuggestions",
  "launcher rotates recommended questions from the question bank"
);
if (questionBankSize(launcherSource) >= 50) {
  pass("console-chat:question-bank", "launcher carries at least 50 OpenShift AIOps recommended questions");
} else {
  fail("console-chat:question-bank", `expected at least 50 questions, got ${questionBankSize(launcherSource)}`);
}
expectText(
  "console-chat:empty-submit-uses-suggestion",
  launcherSource,
  "normalizeQuestion(question, activeSuggestion)",
  "empty input submits the currently visible recommended question"
);
expectText(
  "console-chat:focus-hides-suggestions",
  launcherSource,
  "onFocus={() => setShowSuggestions(false)}",
  "question examples disappear when the user focuses the input"
);
expectText(
  "console-chat:send-icon",
  launcherSource,
  "data-test=\"cas-send-question\"",
  "query action is an icon button inside the composer"
);
expectText(
  "console-chat:target-fields-collapsed",
  launcherSource,
  "data-test=\"cas-target-fields\"",
  "target namespace/resource controls are collapsed behind a toolbar"
);
expectText(
  "console-proxy:csrf-cookie",
  launcherSource,
  "csrf-token",
  "launcher reads OpenShift Console CSRF cookie for proxied POST requests"
);
expectText(
  "console-proxy:csrf-header",
  launcherSource,
  "X-CSRFToken",
  "launcher sends the OpenShift Console CSRF header for Gateway POST requests"
);
expectText(
  "console-proxy:same-origin-credentials",
  launcherSource,
  "credentials: \"same-origin\"",
  "launcher explicitly sends same-origin console cookies through the plugin proxy"
);
expectText(
  "console-proxy:error-detail",
  launcherSource,
  "gatewayErrorMessage",
  "launcher preserves proxy error detail for actionable diagnostics"
);
expectText(
  "console-static:csrf-header",
  staticAppSource,
  "X-CSRFToken",
  "static fallback app also sends the OpenShift Console CSRF header"
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
  "console-chat:provider-renders-launcher",
  providerSource,
  "<CASLauncher />",
  "context provider directly renders the CAS launcher"
);
rejectText(
  "console-chat:no-modal-side-effect",
  launcherSource,
  "useModal",
  "launcher does not depend on modal side effects for visibility"
);
expectText(
  "console-chat:bundle-provider-launcher",
  providerBundle,
  "CASLauncher",
  "built context provider imports and renders the CAS launcher"
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
  "console-chat:bundle-default-view",
  launcherBundle,
  "cas-chat-default-view",
  "built launcher bundle contains the chat-first surface"
);
expectText(
  "console-chat:bundle-view-switcher",
  launcherBundle,
  "cas-view-switcher",
  "built launcher bundle contains header view switching"
);
expectText(
  "console-chat:bundle-stop-action",
  launcherBundle,
  "cas-stop-analysis",
  "built launcher bundle contains a stop action"
);
expectText(
  "console-chat:bundle-suggestions",
  launcherBundle,
  "cas-suggestion-list",
  "built launcher bundle contains recommended question suggestions"
);
expectText(
  "console-chat:bundle-send-icon",
  launcherBundle,
  "cas-send-question",
  "built launcher bundle contains the composer send icon button"
);
expectText(
  "console-chat:bundle-target-fields",
  launcherBundle,
  "cas-target-fields",
  "built launcher bundle contains collapsed target controls"
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
