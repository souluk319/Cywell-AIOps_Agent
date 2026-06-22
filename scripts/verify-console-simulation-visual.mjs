#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outDir = resolve(root, "test-results", "visual");
const harnessPath = resolve(outDir, "cas-simulation-smoke.html");
const sourcePath = resolve(root, "apps", "console-plugin", "src", "plugin", "useCASLauncher.tsx");
const scenarioPath = resolve(root, "apps", "gateway", "simulations", "komsco-ops-scenarios.json");
const checks = [];

function record(id, ok, detail, failureDetail = detail) {
  checks.push({ id, ok, detail: ok ? detail : failureDetail });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${id}: ${ok ? detail : failureDetail}`);
}

function chromeCandidates() {
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  if (process.platform === "win32") {
    for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean)) {
      candidates.push(resolve(base, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(resolve(base, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    candidates.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
  } else {
    candidates.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser");
  }
  return candidates;
}

function findChrome() {
  return chromeCandidates().find((candidate) => candidate && existsSync(candidate));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function extractLauncherStyles() {
  const source = readFileSync(sourcePath, "utf8");
  const match = source.match(/const styles = `([\s\S]*?)`;\n\nfunction SentinelIcon/);
  if (!match) throw new Error("Could not extract CAS launcher styles");
  return match[1];
}

function scenarioCard(scenario) {
  const cycle = scenario.learning?.cycle ?? [];
  const remediations = scenario.remediations ?? [];
  return `<article class="cas-simulation-card" data-test="cas-simulation-card">
    <div class="cas-panel-heading">
      <strong>${escapeHtml(scenario.title)}</strong>
      <span class="cas-risk-pill" data-risk="${escapeHtml(scenario.risk ?? "medium")}">${escapeHtml(scenario.risk ?? "medium")}</span>
    </div>
    <div>${escapeHtml(scenario.summary ?? scenario.question)}</div>
    <div class="cas-meta">${escapeHtml(scenario.target.namespace)} · ${escapeHtml(scenario.target.kind)}/${escapeHtml(scenario.target.name)}</div>
    <div class="cas-learning-note" data-test="cas-simulation-learning">학습 목표: ${escapeHtml(scenario.learning?.objective ?? "")}</div>
    <div class="cas-learning-flow" data-test="cas-simulation-cycle">${cycle
      .map((step, index) => `<span class="cas-learning-chip">${index + 1}. ${escapeHtml(step)}</span>`)
      .join("")}</div>
    <div class="cas-meta">신호: warnings ${scenario.signals?.warnings ?? 0} · restarts ${scenario.signals?.restarts ?? 0} · metrics ${
      scenario.signals?.metric_series ?? 0
    }</div>
    <div class="cas-simulation-actions">
      <button class="cas-secondary" type="button">1. 문제 분석</button>
      ${remediations.map((action) => `<button class="cas-link-button" type="button">2. ${escapeHtml(action.label)}</button>`).join("")}
    </div>
  </article>`;
}

function buildHarness(styles, scenarios) {
  const cards = scenarios.map(scenarioCard).join("\n");
  const first = scenarios[0];
  const firstAction = first?.remediations?.[0];
  const followUps = firstAction?.followUps ?? first?.learning?.followUps ?? [];
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CAS simulation visual smoke</title>
<style>
html, body { margin: 0; min-height: 100%; background: #eef2f6; font-family: "Segoe UI", "Noto Sans KR", Arial, sans-serif; }
.fake-console { min-height: 100vh; color: #1f2933; }
.fake-topbar { height: 56px; background: #151515; color: #fff; display: flex; align-items: center; padding: 0 24px; font-weight: 700; }
.qa-result { position: fixed; left: 8px; bottom: 8px; z-index: 20; max-width: 46vw; background: rgba(255,255,255,.92); border: 1px solid #d7dee7; border-radius: 4px; color: #16212c; font: 11px/1.4 Consolas, monospace; padding: 8px; white-space: pre-wrap; }
${styles}
</style>
</head>
<body>
<div class="fake-console"><div class="fake-topbar">Red Hat OpenShift</div></div>
<div class="cas-launcher-root">
<section aria-label="Cywell AI Sentinel" class="cas-panel" role="dialog">
  <header class="cas-panel-header">
    <div class="cas-panel-title"><strong>Cywell AI Sentinel</strong><span>KOMSCO AI AGENT</span></div>
    <div class="cas-header-tools"><nav class="cas-view-switcher"><button class="cas-view-button">C</button><button class="cas-view-button">+</button><button class="cas-view-button">S</button><button class="cas-view-button">G</button><button class="cas-view-button">N</button></nav><button class="cas-view-button">?</button><button class="cas-close">x</button></div>
  </header>
  <div class="cas-panel-body">
    <div class="cas-status-row"><span class="cas-status-light" data-state="ready"></span><span class="cas-status-label">연결됨</span></div>
    <section class="cas-cockpit" data-test="cas-simulation-lab">
      <div class="cas-panel-heading"><strong>운영 시뮬레이션</strong><button class="cas-link-button">새로고침</button></div>
      <div class="cas-meta">목업 운영 세계를 선택하면 CAS가 실제처럼 증적, metric, Runbook을 수집해 분석합니다.</div>
      <div class="cas-simulation-list">${cards}</div>
      <article class="cas-message" data-role="assistant">
        <strong class="cas-message-role">AI Sentinel</strong>
        <div class="cas-answer cas-markdown" data-primary="true"><p class="cas-md-paragraph">시뮬레이션 분석 결과입니다. 다음 버튼으로 회복 확인까지 이어갑니다.</p></div>
        <div class="cas-simulation-next" data-test="cas-simulation-next-actions">
          <button class="cas-link-button">2. ${escapeHtml(firstAction?.label ?? "Recovery simulation")}</button>
          ${followUps.slice(0, 3).map((question) => `<button class="cas-link-button">3. ${escapeHtml(question)}</button>`).join("")}
          <button class="cas-link-button">다른 시나리오</button>
        </div>
      </article>
    </section>
  </div>
</section>
</div>
<pre id="qa-result" class="qa-result">pending</pre>
<script>
function runQa() {
  const panel = document.querySelector(".cas-panel").getBoundingClientRect();
  const cockpit = document.querySelector(".cas-cockpit");
  const cards = [...document.querySelectorAll(".cas-simulation-card")];
  const nextActions = document.querySelector("[data-test='cas-simulation-next-actions']");
  const bad = [...document.querySelectorAll(".cas-panel *")].filter((el) => {
    const cs = getComputedStyle(el);
    return el.scrollWidth > el.clientWidth + 2 && !["hidden", "auto", "scroll"].includes(cs.overflowX);
  }).map((el) => ({ cls: String(el.className || el.tagName), text: (el.textContent || "").trim().slice(0, 90), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth })).slice(0, 16);
  const result = {
    viewport: [innerWidth, innerHeight],
    panel: { left: Math.round(panel.left), right: Math.round(panel.right), top: Math.round(panel.top), bottom: Math.round(panel.bottom), width: Math.round(panel.width), height: Math.round(panel.height) },
    panelInViewport: panel.left >= -1 && panel.right <= innerWidth + 1 && panel.top >= -1 && panel.bottom <= innerHeight + 1,
    cockpitScrolls: cockpit.scrollHeight > cockpit.clientHeight && ["auto", "scroll"].includes(getComputedStyle(cockpit).overflowY),
    cardCount: cards.length,
    learningCount: document.querySelectorAll("[data-test='cas-simulation-learning']").length,
    cycleCount: document.querySelectorAll("[data-test='cas-simulation-cycle']").length,
    nextActionsVisible: Boolean(nextActions) && nextActions.getBoundingClientRect().height > 20,
    documentOverflowX: document.documentElement.scrollWidth > innerWidth + 1,
    horizontalOverflowItems: bad
  };
  result.pass = result.panelInViewport && result.cardCount >= 8 && result.learningCount >= 8 && result.cycleCount >= 8 && result.nextActionsVisible && result.cockpitScrolls && !result.documentOverflowX && bad.length === 0;
  document.body.setAttribute("data-qa-pass", String(result.pass));
  document.getElementById("qa-result").textContent = JSON.stringify(result, null, 2);
}
addEventListener("load", () => setTimeout(runQa, 80));
</script>
</body>
</html>`;
}

function runChrome(chromePath, viewport) {
  const url = pathToFileURL(harnessPath).href;
  const screenshotPath = resolve(outDir, `cas-simulation-${viewport.id}.png`);
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--force-device-scale-factor=1",
    "--hide-scrollbars",
    "--allow-file-access-from-files",
    `--window-size=${viewport.width},${viewport.height}`,
    "--virtual-time-budget=1500"
  ];

  execFileSync(chromePath, [...args, `--screenshot=${screenshotPath}`, url], { stdio: "ignore" });
  const dom = execFileSync(chromePath, [...args, "--dump-dom", url], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const match = dom.match(/<pre id="qa-result"[^>]*>([\s\S]*?)<\/pre>/);
  if (!match) throw new Error(`QA result not found for ${viewport.id}`);
  return { screenshotPath, result: JSON.parse(match[1]) };
}

mkdirSync(outDir, { recursive: true });

const chromePath = findChrome();
record("simulation-visual:chrome", Boolean(chromePath), chromePath ?? "Chrome/Edge executable not found");

if (chromePath) {
  const styles = extractLauncherStyles();
  const scenarios = JSON.parse(readFileSync(scenarioPath, "utf8")).scenarios ?? [];
  writeFileSync(harnessPath, buildHarness(styles, scenarios), "utf8");
  record("simulation-visual:harness", existsSync(harnessPath), `harness=${harnessPath}`);
  record("simulation-visual:scenario-count", scenarios.length >= 8, `scenarioCount=${scenarios.length}`);

  for (const viewport of [
    { id: "desktop", width: 1440, height: 1000 },
    { id: "mobile-500", width: 500, height: 844 }
  ]) {
    const { screenshotPath, result } = runChrome(chromePath, viewport);
    record(`simulation-visual:${viewport.id}:panel`, result.panelInViewport, `panel=${JSON.stringify(result.panel)}`);
    record(`simulation-visual:${viewport.id}:cards`, result.cardCount >= 8, `cards=${result.cardCount}`);
    record(`simulation-visual:${viewport.id}:learning`, result.learningCount >= 8 && result.cycleCount >= 8, `learning=${result.learningCount} cycle=${result.cycleCount}`);
    record(`simulation-visual:${viewport.id}:next-actions`, result.nextActionsVisible, "simulation answer next-step actions are visible");
    record(`simulation-visual:${viewport.id}:cockpit-scroll`, result.cockpitScrolls, "simulation cockpit scrolls inside the fixed panel");
    record(`simulation-visual:${viewport.id}:overflow-x`, !result.documentOverflowX, "no document horizontal overflow");
    record(
      `simulation-visual:${viewport.id}:text-overflow`,
      Array.isArray(result.horizontalOverflowItems) && result.horizontalOverflowItems.length === 0,
      `screenshot=${screenshotPath}`,
      JSON.stringify(result.horizontalOverflowItems)
    );
  }
}

const failures = checks.filter((check) => !check.ok);
if (failures.length) {
  console.error(`Console simulation visual verification failed with ${failures.length} failures.`);
  process.exit(1);
}

console.log(`Console simulation visual verification passed with ${checks.length} checks.`);
