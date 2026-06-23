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

function expectOrder(id, text, needles, passDetail, failDetail = passDetail) {
  let cursor = -1;
  for (const needle of needles) {
    const index = text.indexOf(needle, cursor + 1);
    if (index < 0) {
      fail(id, `${failDetail}: missing ${needle}`);
      return;
    }
    if (index < cursor) {
      fail(id, `${failDetail}: wrong order at ${needle}`);
      return;
    }
    cursor = index;
  }
  pass(id, passDetail);
}

function questionBankSize(text, name) {
  const start = text.indexOf(`const ${name} = [`);
  if (start < 0) return 0;
  const end = text.indexOf("];", start);
  if (end < 0) return 0;
  return (text.slice(start, end).match(/"[^"]+"/g) ?? []).length;
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
  "console-chat:targets",
  launcherSource,
  "/api/aiops/targets",
  "launcher loads target catalog options for the analysis target selector"
);
expectText(
  "console-simulation:catalog",
  launcherSource,
  "/api/aiops/simulations",
  "launcher loads the CAS Simulation Lab catalog endpoint"
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
  "console-chat:fixed-panel-height",
  launcherSource,
  "height: min(760px, calc(100vh - 112px))",
  "launcher uses a fixed panel height so pending/results do not resize the outer chat window"
);
expectText(
  "console-chat:internal-thread-scroll",
  launcherSource,
  "grid-template-rows: minmax(0, 1fr) auto",
  "chat surface gives the message thread the flexible scroll area"
);
expectText(
  "console-chat:scrollbar-stability",
  launcherSource,
  "scrollbar-gutter: stable",
  "chat thread reserves scrollbar gutter to reduce layout jump"
);
expectText(
  "console-chat:pending-indicator",
  launcherSource,
  "data-test=\"cas-pending-answer\"",
  "launcher renders a compact pending indicator instead of a long loading paragraph"
);
expectText(
  "console-chat:suggestion-popover",
  launcherSource,
  "className=\"cas-suggestion-shell\"",
  "recommended questions live in a popover instead of a fixed composer block"
);
expectText(
  "console-chat:suggestion-toggle",
  launcherSource,
  "data-test=\"cas-suggestion-toggle\"",
  "composer exposes a compact plus button for frequent checks"
);
expectText(
  "console-chat:no-fixed-suggestion-space",
  launcherSource,
  ".cas-suggestion-shell[data-visible=\"false\"] {\n  display: none;",
  "hidden recommendations do not reserve vertical space while reading answers"
);
expectText(
  "console-chat:sse-reader",
  launcherSource,
  "readSseStream",
  "launcher consumes streaming Gateway events"
);
expectText(
  "console-chat:stream-request",
  launcherSource,
  "stream: true",
  "launcher requests streamed answers from the Gateway"
);
expectText(
  "console-chat:stream-token",
  launcherSource,
  "event === \"token\"",
  "launcher appends streamed answer tokens"
);
expectText(
  "console-chat:mode-selector",
  launcherSource,
  "data-test=\"cas-mode-selector\"",
  "launcher exposes Ask/Troubleshooting mode selection"
);
expectText(
  "console-chat:mode-inside-input",
  launcherSource,
  "className=\"cas-input-tools\"",
  "launcher keeps Ask/Troubleshooting as a compact input tool instead of a separate composer row"
);
expectOrder(
  "console-chat:plus-before-mode",
  launcherSource,
  ["data-test=\"cas-suggestion-toggle\"", "data-test=\"cas-mode-selector\""],
  "frequent-check plus button sits immediately to the left of Ask/Troubleshooting mode",
  "plus/frequent checks should be attached to the composer mode controls"
);
expectText(
  "console-chat:mode-current-only",
  launcherSource,
  "data-test=\"cas-mode-current\"",
  "launcher shows only the currently selected Ask/Troubleshooting mode while the dropdown is closed"
);
expectText(
  "console-chat:mode-dropdown",
  launcherSource,
  "className=\"cas-mode-menu\"",
  "launcher renders alternate modes in a dropdown menu instead of listing all choices in the composer"
);
expectText(
  "console-chat:mode-ask",
  launcherSource,
  "data-test={`cas-mode-${mode}`}",
  "launcher renders mode buttons with addressable test ids"
);
expectText(
  "console-chat:mode-request",
  launcherSource,
  "brain_mode: effectiveChatMode",
  "launcher sends the selected mode to the Gateway brain contract"
);
expectText(
  "console-chat:mode-readonly-split",
  launcherSource,
  "mode: \"read_only\"",
  "launcher keeps CAS safety mode separate from the Lightspeed mode"
);
expectText(
  "console-chat:scroll-lock",
  launcherSource,
  "autoScrollRef.current = nearBottom",
  "chat autoscroll unlocks when the operator scrolls away from the bottom"
);
expectText(
  "console-chat:scroll-bottom-button",
  launcherSource,
  "data-test=\"cas-scroll-bottom\"",
  "launcher shows a bottom-jump button when autoscroll is unlocked"
);
expectText(
  "console-chat:auto-scroll-no-animation-jank",
  launcherSource,
  "behavior: \"auto\"",
  "chat autoscroll avoids smooth-scroll animation during submit/pending transitions"
);
rejectText(
  "console-chat:no-lightspeed-loading-copy",
  launcherSource,
  "Gateway를 통해 Lightspeed brain",
  "loading copy does not expose the internal Lightspeed call as the primary user experience"
);
expectText(
  "console-chat:view-switcher",
  launcherSource,
  "data-test=\"cas-view-switcher\"",
  "launcher exposes header icon view switching"
);
expectOrder(
  "console-chat:new-chat-adjacent-to-chat",
  launcherSource,
  ["data-test={`cas-view-${view}`}", "view === \"chat\" &&", "data-test=\"cas-new-chat\""],
  "new chat action is rendered immediately after the chat icon",
  "new chat must sit next to chat, not after unrelated dashboard views"
);
expectText(
  "console-chat:language-toggle",
  launcherSource,
  "data-test=\"cas-language-toggle\"",
  "launcher exposes a header globe language toggle"
);
expectText(
  "console-tutorial:toggle",
  launcherSource,
  "data-test=\"cas-tutorial-toggle\"",
  "launcher exposes a header tutorial/help toggle"
);
expectText(
  "console-tutorial:overlay",
  launcherSource,
  "data-test=\"cas-tutorial-overlay\"",
  "launcher renders a first-run tutorial overlay"
);
expectText(
  "console-tutorial:first-run-storage",
  launcherSource,
  "TUTORIAL_STORAGE_KEY",
  "launcher stores tutorial completion in localStorage"
);
expectText(
  "console-tutorial:step-navigation",
  launcherSource,
  "applyTutorialStep",
  "tutorial steps can change the active CAS view"
);
expectText(
  "console-tutorial:simulation-step",
  launcherSource,
  "id: \"simulation\"",
  "tutorial includes a Simulation Lab learning step"
);
expectOrder(
  "console-chat:language-toggle-before-close",
  launcherSource,
  ["data-test=\"cas-view-switcher\"", "data-test=\"cas-language-toggle\"", "className=\"cas-close\""],
  "launcher places the language toggle immediately before the far-right close action",
  "language toggle should render after the view switcher and before close"
);
expectOrder(
  "console-tutorial:help-before-language",
  launcherSource,
  ["data-test=\"cas-target-toggle\"", "data-test=\"cas-tutorial-toggle\"", "data-test=\"cas-language-toggle\""],
  "tutorial/help sits after target settings and before language"
);
expectText(
  "console-chat:language-icon",
  launcherSource,
  "function GlobeIcon",
  "launcher renders a globe icon for Korean/English language switching"
);
expectText(
  "console-chat:localized-view-labels",
  launcherSource,
  "viewLabels",
  "launcher localizes header view labels and view titles"
);
expectText(
  "console-chat:korean-view-label",
  launcherSource,
  "상황",
  "launcher includes Korean Situation label for header view functions"
);
expectText(
  "console-chat:korean-grounds-label",
  launcherSource,
  "근거",
  "launcher includes Korean Grounds label for header view functions"
);
expectText(
  "console-chat:korean-next-actions-label",
  launcherSource,
  "다음 확인",
  "launcher labels the former Next Actions surface as Next Checks in Korean"
);
expectText(
  "console-simulation:korean-label",
  launcherSource,
  "시뮬레이션",
  "launcher includes Korean Simulation label for the Simulation Lab"
);
rejectText(
  "console-chat:no-old-control-label",
  launcherSource,
  "openCockpit: \"관제 열기\"",
  "launcher no longer uses the old cockpit-open label"
);
expectText(
  "console-chat:locale-map",
  launcherSource,
  "localeByLanguage",
  "launcher maps language state to Gateway locale"
);
expectText(
  "console-chat:english-locale",
  launcherSource,
  "en-US",
  "launcher supports English locale for Gateway requests"
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
  "console-chat:markdown-answer",
  launcherSource,
  "data-test=\"cas-markdown-answer\"",
  "launcher renders assistant answers through the safe Markdown renderer"
);
expectText(
  "console-chat:markdown-blocks",
  launcherSource,
  "parseMarkdownBlocks",
  "launcher parses Markdown headings, lists, paragraphs, and code blocks"
);
expectText(
  "console-chat:markdown-inline",
  launcherSource,
  "renderInlineMarkdown",
  "launcher renders Markdown bold and inline code without raw HTML injection"
);
rejectText(
  "console-chat:no-dangerous-html",
  launcherSource,
  "dangerouslySetInnerHTML",
  "launcher does not inject raw Markdown as HTML"
);
expectText(
  "console-chat:fallback-visible",
  launcherSource,
  "data-test=\"cas-fallback-notice\"",
  "launcher visibly marks fallback responses"
);
expectText(
  "console-chat:komsco-agent-subtitle",
  launcherSource,
  "KOMSCO EDITION",
  "launcher header copy brands the customer edition as KOMSCO EDITION"
);
expectText(
  "console-chat:status-light",
  launcherSource,
  "cas-status-light",
  "launcher uses a compact signal-light status instead of debug badges"
);
rejectText(
  "console-chat:no-usertoken-debug-copy",
  launcherSource,
  "UserToken proxy",
  "launcher does not render UserToken proxy debug copy in the chat shell"
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
if (questionBankSize(launcherSource, "OCP_AIOPS_QUESTION_BANK_KO") >= 50) {
  pass("console-chat:question-bank-ko", "launcher carries at least 50 Korean OpenShift AIOps recommended questions");
} else {
  fail("console-chat:question-bank-ko", `expected at least 50 Korean questions, got ${questionBankSize(launcherSource, "OCP_AIOPS_QUESTION_BANK_KO")}`);
}
if (questionBankSize(launcherSource, "OCP_AIOPS_QUESTION_BANK_EN") >= 50) {
  pass("console-chat:question-bank-en", "launcher carries at least 50 English OpenShift AIOps recommended questions");
} else {
  fail("console-chat:question-bank-en", `expected at least 50 English questions, got ${questionBankSize(launcherSource, "OCP_AIOPS_QUESTION_BANK_EN")}`);
}
expectText(
  "console-chat:empty-submit-opens-suggestions",
  launcherSource,
  "setShowSuggestions(true)",
  "empty input opens recommended questions instead of silently sending a hidden random suggestion"
);
expectText(
  "console-chat:visible-suggestion-submit",
  launcherSource,
  "if (showSuggestions) {\n          await submitQuestion(activeSuggestion);",
  "visible recommended question can be submitted after the suggestion menu is open"
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
  "console-actions:open-button-nowrap",
  launcherSource,
  "white-space: nowrap",
  "Next Actions open/run buttons do not wrap into vertical letters"
);
expectText(
  "console-actions:long-label-clamp",
  launcherSource,
  "-webkit-line-clamp: 2",
  "long Next Actions labels are clamped instead of stretching cards"
);
expectText(
  "console-actions:executable-question",
  launcherSource,
  "executableActionQuestion(action, language)",
  "Next Checks execute a concrete CAS question instead of acting as display-only rows"
);
rejectText(
  "console-actions:no-events-href",
  launcherSource,
  "value.startsWith(\"/events/\")",
  "Next Actions do not treat CRC-fragile Events routes as direct links"
);
expectText(
  "console-actions:targeted-run",
  launcherSource,
  "action.target?.name, action.target?.namespace, action.target?.kind",
  "Next Checks pass their target into the chat query"
);
expectText(
  "console-actions:troubleshooting-run",
  launcherSource,
  "\"troubleshooting\"",
  "Next Checks run in Troubleshooting mode by default"
);
expectText(
  "console-actions:run-button-test-id",
  launcherSource,
  "data-test=\"cas-next-check-run\"",
  "Next Checks expose an executable run button for visual and E2E checks"
);
expectText(
  "console-actions:default-actions",
  launcherSource,
  "defaultNextCheckActions(target)",
  "Next Checks render executable default checks even when the overview action payload is empty or still loading"
);
expectText(
  "console-actions:target-prop",
  launcherSource,
  "target={{",
  "Next Checks receive the currently selected analysis target"
);
expectText(
  "console-actions:language-prop",
  launcherSource,
  "language={language}",
  "Next Checks receive the current language instead of reading an undefined outer variable"
);
expectText(
  "console-actions:language-contract",
  launcherSource,
  "language: Language;",
  "Overview cockpit declares language as an explicit render contract"
);
rejectText(
  "console-actions:no-direct-href-navigation",
  launcherSource,
  "href={action.href}",
  "Next Actions do not navigate the browser to unverified Console routes"
);
expectText(
  "console-actions:localized-labels",
  launcherSource,
  "displayActionLabel(action, language)",
  "Next Actions display labels are localized without changing the Gateway action contract"
);
expectText(
  "console-chat:target-fields-header",
  launcherSource,
  "data-test=\"cas-target-fields\"",
  "target namespace/resource controls are hidden behind a header icon"
);
expectText(
  "console-chat:target-namespace-select",
  launcherSource,
  "data-test=\"cas-target-namespace-select\"",
  "target namespace is selected from known options instead of raw typing only"
);
expectText(
  "console-chat:target-all-namespaces-option",
  launcherSource,
  "targetAllNamespaces",
  "target selector exposes an All namespaces option for broad RCA discovery"
);
expectText(
  "console-chat:target-all-namespaces-sentinel",
  launcherSource,
  "__all_namespaces__",
  "All namespaces uses an internal sentinel instead of a fake Kubernetes namespace"
);
expectText(
  "console-chat:target-kind-filtered-by-namespace",
  launcherSource,
  "matchingKinds(targetOptions, namespace)",
  "target kind choices are filtered by the selected namespace scope"
);
expectText(
  "console-chat:target-kind-select",
  launcherSource,
  "data-test=\"cas-target-kind-select\"",
  "target kind is selected from known options instead of raw typing only"
);
expectText(
  "console-chat:target-name-select",
  launcherSource,
  "data-test=\"cas-target-name-select\"",
  "target name is selected from known options instead of raw typing only"
);
expectText(
  "console-chat:target-layout-row",
  launcherSource,
  "data-target-open={showTargetControls ? \"true\" : \"false\"}",
  "panel body switches layout when target settings are open"
);
expectText(
  "console-chat:view-switch-closes-target",
  launcherSource,
  "setShowTargetControls(false);",
  "switching header views closes target settings so panels are not hidden behind the target editor"
);
expectText(
  "console-tutorial:close-recovers-chat",
  launcherSource,
  "setActiveView(\"chat\");",
  "finishing or skipping the tutorial returns the user to a connected chat baseline"
);
expectText(
  "console-chat:target-title",
  launcherSource,
  "copy.targetTitle",
  "target settings renders a clear Analysis Target title"
);
expectText(
  "console-chat:target-current",
  launcherSource,
  "copy.targetCurrent",
  "target settings shows the currently applied target"
);
expectText(
  "console-chat:target-apply",
  launcherSource,
  "copy.targetApply",
  "target settings has an explicit apply action"
);
expectText(
  "console-chat:new-chat-header",
  launcherSource,
  "data-test=\"cas-new-chat\"",
  "new chat is a header icon instead of a full-width footer control"
);
rejectText(
  "console-chat:no-footer-toolbar",
  launcherSource,
  "className=\"cas-compose-toolbar\"",
  "composer no longer renders target/recommendation metadata under the input"
);
rejectText(
  "console-chat:no-footer-actions",
  launcherSource,
  "className=\"cas-actions\"",
  "composer no longer renders a footer action row"
);
rejectText(
  "console-chat:no-system-ready-message",
  launcherSource,
  "id: \"system-ready\"",
  "chat no longer starts with an internal explanatory system message"
);
rejectText(
  "console-chat:no-visible-provider-meta",
  launcherSource,
  "className=\"cas-result-meta\"",
  "chat answers no longer render provider/debug metadata as visible answer text"
);
rejectText(
  "console-chat:no-lightspeed-answer-label",
  launcherSource,
  "Lightspeed real answer",
  "chat answers do not expose internal provider labels"
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
  "console-cockpit:evidence-status",
  launcherSource,
  "data-test=\"cas-evidence-status\"",
  "launcher renders evidence collection status"
);
expectText(
  "console-cockpit:evidence-groups",
  launcherSource,
  "data-test=\"cas-evidence-groups\"",
  "launcher renders OpenShift/Metric/Runbook evidence groups"
);
expectText(
  "console-cockpit:metric-provider",
  launcherSource,
  "data-test=\"cas-metric-provider\"",
  "launcher shows Metric provider state in the Situation tab"
);
expectText(
  "console-cockpit:metric-provider-compact-status",
  launcherSource,
  "data-kind=\"status\"",
  "Metric provider status uses compact status typography instead of numeric score typography"
);
expectText(
  "console-chat:tool-plan-panel",
  launcherSource,
  "data-test=\"cas-tool-plan-panel\"",
  "launcher keeps the read-only Tool Plan in the folded answer panel"
);
expectText(
  "console-chat:rca-trace",
  launcherSource,
  "data-test=\"cas-rca-trace\"",
  "launcher surfaces OpenShift/Metric/Runbook/Tool Plan/Brain collection flow on the answer card"
);
expectText(
  "console-chat:trace-chips",
  launcherSource,
  "cas-trace-chip",
  "launcher renders compact trace chips for collected and missing evidence"
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
expectText(
  "console-simulation:lab",
  launcherSource,
  "data-test=\"cas-simulation-lab\"",
  "launcher renders the Simulation Lab surface"
);
expectText(
  "console-simulation:cards",
  launcherSource,
  "data-test=\"cas-simulation-card\"",
  "launcher renders data-driven simulation scenario cards"
);
expectText(
  "console-simulation:learning",
  launcherSource,
  "data-test=\"cas-simulation-learning\"",
  "launcher renders scenario learning objectives"
);
expectText(
  "console-simulation:cycle",
  launcherSource,
  "data-test=\"cas-simulation-cycle\"",
  "launcher renders the guided simulation cycle"
);
expectText(
  "console-simulation:query-contract",
  launcherSource,
  "simulation_id: simulationId",
  "launcher sends simulation_id through the Gateway query contract"
);
expectText(
  "console-simulation:action-contract",
  launcherSource,
  "simulation_action_id: simulationActionId",
  "launcher sends simulation_action_id for remediation simulation"
);
expectText(
  "console-simulation:troubleshooting-override",
  launcherSource,
  "modeOverride?: ChatMode",
  "simulation runs can override Ask mode into Troubleshooting mode"
);
expectText(
  "console-simulation:effective-mode",
  launcherSource,
  "brain_mode: effectiveChatMode",
  "Gateway requests use the effective chat mode"
);
expectText(
  "console-simulation:next-actions",
  launcherSource,
  "data-test=\"cas-simulation-next-actions\"",
  "assistant simulation answers expose next-step buttons"
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
  "console-simulation:bundle-catalog",
  launcherBundle,
  "/api/aiops/simulations",
  "built launcher bundle contains Simulation Lab catalog integration"
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
  "console-chat:bundle-language-toggle",
  launcherBundle,
  "cas-language-toggle",
  "built launcher bundle contains the header language toggle"
);
expectText(
  "console-tutorial:bundle-overlay",
  launcherBundle,
  "cas-tutorial-overlay",
  "built launcher bundle contains the tutorial overlay"
);
expectText(
  "console-tutorial:bundle-toggle",
  launcherBundle,
  "cas-tutorial-toggle",
  "built launcher bundle contains the tutorial toggle"
);
expectText(
  "console-chat:bundle-english-locale",
  launcherBundle,
  "en-US",
  "built launcher bundle contains English locale support"
);
expectText(
  "console-chat:bundle-stop-action",
  launcherBundle,
  "cas-stop-analysis",
  "built launcher bundle contains a stop action"
);
expectText(
  "console-chat:bundle-markdown-answer",
  launcherBundle,
  "cas-markdown-answer",
  "built launcher bundle contains Markdown answer rendering"
);
expectText(
  "console-chat:bundle-markdown-code",
  launcherBundle,
  "cas-md-inline-code",
  "built launcher bundle contains inline code styling for Markdown answers"
);
expectText(
  "console-chat:bundle-rca-trace",
  launcherBundle,
  "cas-rca-trace",
  "built launcher bundle contains the visible RCA collection flow"
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
  "console-chat:bundle-mode-selector",
  launcherBundle,
  "cas-mode-selector",
  "built launcher bundle contains Ask/Troubleshooting mode selector"
);
expectText(
  "console-chat:bundle-brain-mode",
  launcherBundle,
  "brain_mode",
  "built launcher bundle sends selected Lightspeed mode"
);
expectText(
  "console-chat:bundle-suggestion-toggle",
  launcherBundle,
  "cas-suggestion-toggle",
  "built launcher bundle contains the frequent-check plus button"
);
expectText(
  "console-chat:bundle-scroll-bottom",
  launcherBundle,
  "cas-scroll-bottom",
  "built launcher bundle contains bottom-jump control for unlocked scroll"
);
expectText(
  "console-chat:bundle-stream-reader",
  launcherBundle,
  "text/event-stream",
  "built launcher bundle contains streaming response reader"
);
expectText(
  "console-chat:bundle-new-chat",
  launcherBundle,
  "cas-new-chat",
  "built launcher bundle contains header new-chat action"
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
expectText(
  "console-cockpit:bundle-evidence-status",
  launcherBundle,
  "cas-evidence-status",
  "built launcher bundle contains evidence status surface"
);
expectText(
  "console-cockpit:bundle-evidence-groups",
  launcherBundle,
  "cas-evidence-groups",
  "built launcher bundle contains evidence groups surface"
);
expectText(
  "console-simulation:bundle-lab",
  launcherBundle,
  "cas-simulation-lab",
  "built launcher bundle contains Simulation Lab surface"
);

const failures = checks.filter((check) => check.status === "FAIL");
if (failures.length > 0) {
  console.error(`Console integration verification failed with ${failures.length} failures.`);
  process.exitCode = 1;
} else {
  console.log(`Console integration verification passed with ${checks.length} checks.`);
}
