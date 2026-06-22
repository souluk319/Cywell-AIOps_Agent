import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outDir = resolve(root, "test-results", "visual");
const harnessPath = resolve(outDir, "cas-cockpit-smoke.html");
const sourcePath = resolve(root, "apps", "console-plugin", "src", "plugin", "useCASLauncher.tsx");

const checks = [];

function record(id, ok, detail, failureDetail = detail) {
  checks.push({ id, ok, detail: ok ? detail : failureDetail });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${id}: ${ok ? detail : failureDetail}`);
}

function chromeCandidates() {
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);

  if (process.platform === "win32") {
    const programFiles = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean);
    for (const base of programFiles) {
      candidates.push(resolve(base, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(resolve(base, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    candidates.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
  } else {
    candidates.push("/usr/bin/google-chrome");
    candidates.push("/usr/bin/google-chrome-stable");
    candidates.push("/usr/bin/chromium");
    candidates.push("/usr/bin/chromium-browser");
    candidates.push("/usr/bin/microsoft-edge");
  }

  return candidates;
}

function findChrome() {
  return chromeCandidates().find((candidate) => candidate && existsSync(candidate));
}

function extractLauncherStyles() {
  const source = readFileSync(sourcePath, "utf8");
  const match = source.match(/const styles = `([\s\S]*?)`;\n\nfunction SentinelIcon/);
  if (!match) {
    throw new Error("Could not extract CAS launcher styles from useCASLauncher.tsx");
  }
  return match[1];
}

function buildHarness(styles) {
  const icon = `<svg aria-hidden="true" viewBox="0 0 48 48" role="img"><path d="M24 5.5 38 10v11.4c0 9.1-5.4 16.8-14 21.1-8.6-4.3-14-12-14-21.1V10l14-4.5Z" fill="currentColor" opacity="0.16"></path><path d="M24 9.7 34 13v8.4c0 6.7-3.8 12.7-10 16.4-6.2-3.7-10-9.7-10-16.4V13l10-3.3Z" fill="none" stroke="currentColor" stroke-width="2.6"></path><path d="M20 24.2h8M24 18.4v11.7" stroke="currentColor" stroke-linecap="round" stroke-width="2.6"></path></svg>`;
  const globe = `<svg aria-hidden="true" viewBox="0 0 24 24" role="img"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"></circle><path d="M4 12h16M12 4c2.2 2.3 3.3 5 3.3 8S14.2 17.7 12 20M12 4c-2.2 2.3-3.3 5-3.3 8s1.1 5.7 3.3 8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2"></path></svg>`;

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CAS cockpit visual smoke</title>
<style>
html, body { margin: 0; min-height: 100%; background: #eef2f6; font-family: "Segoe UI", "Noto Sans KR", Arial, sans-serif; }
.fake-console { min-height: 100vh; color: #1f2933; }
.fake-topbar { height: 56px; background: #151515; color: #fff; display: flex; align-items: center; padding: 0 24px; font-weight: 700; }
.fake-main { display: grid; grid-template-columns: 240px 1fr; min-height: calc(100vh - 56px); }
.fake-nav { background: #fff; border-right: 1px solid #d7dee7; padding: 18px; display: grid; align-content: start; gap: 10px; }
.fake-content { padding: 24px; }
.fake-card { background: #fff; border: 1px solid #d7dee7; border-radius: 8px; padding: 18px; max-width: 760px; }
.qa-result { position: fixed; left: 8px; bottom: 8px; z-index: 20; max-width: 46vw; background: rgba(255,255,255,.92); border: 1px solid #d7dee7; border-radius: 4px; color: #16212c; font: 11px/1.4 Consolas, monospace; padding: 8px; white-space: pre-wrap; }
${styles}
</style>
</head>
<body>
<div class="fake-console">
  <div class="fake-topbar">Red Hat OpenShift</div>
  <div class="fake-main">
    <aside class="fake-nav"><strong>Administrator</strong><span>Home</span><span>Workloads</span><span>Observe</span><span>Storage</span><span>Networking</span></aside>
    <main class="fake-content"><section class="fake-card"><h1>Cluster dashboard</h1><p>CAS is opened from the AI launcher position and overlays the native console without a full-screen route.</p></section></main>
  </div>
</div>
<div class="cas-launcher-root" data-test="cas-launcher-root">
<section aria-label="Cywell AI Sentinel" class="cas-panel" data-test="cas-launcher-panel" role="dialog">
  <header class="cas-panel-header">${icon}<div class="cas-panel-title"><strong>Cywell AI Sentinel</strong><span>KOMSCO AI AGENT</span></div><div class="cas-header-tools"><nav aria-label="AI Sentinel 화면" class="cas-view-switcher" data-test="cas-view-switcher"><button aria-label="채팅" class="cas-view-button" data-active="true" type="button">C</button><button aria-label="새 대화" class="cas-view-button" data-test="cas-new-chat" type="button">+</button><button aria-label="상황" class="cas-view-button" type="button">S</button><button aria-label="근거" class="cas-view-button" type="button">G</button><button aria-label="다음 행동" class="cas-view-button" type="button">N</button></nav><button aria-label="대상 설정" class="cas-view-button" data-test="cas-target-toggle" type="button">◎</button><button aria-label="언어: 한국어. 영어로 전환" class="cas-view-button cas-language-toggle" data-language="ko" data-test="cas-language-toggle" type="button">${globe}<span>한</span></button><button aria-label="AI Sentinel 닫기" class="cas-close" type="button">x</button></div></header>
  <div class="cas-panel-body" data-target-open="true">
    <div class="cas-status-row" data-test="cas-brain-status" title="openshift-lightspeed · OpenShift Lightspeed readiness 확인됨"><span class="cas-status-light" data-state="ready"></span><span class="cas-status-label">연결됨</span></div>
    <div class="cas-target-popover" data-test="cas-target-fields">
      <div class="cas-target-heading"><div><strong>분석 대상</strong><div class="cas-target-current">현재 대상: default · ClusterVersion/version</div></div><button class="cas-link-button" type="button">닫기</button></div>
      <div class="cas-fields">
        <label class="cas-target-field"><span>Namespace</span><input aria-label="Namespace" value="default"></label>
        <label class="cas-target-field"><span>Kind</span><input aria-label="Kind" value="ClusterVersion"></label>
        <label class="cas-target-field"><span>Name</span><input aria-label="Name" value="version"></label>
      </div>
      <div class="cas-target-actions"><button class="cas-small-button" data-variant="secondary" type="button">닫기</button><button class="cas-small-button" data-variant="primary" type="button">적용</button></div>
    </div>
    <div class="cas-chat-surface" data-test="cas-chat-default-view">
    <div class="cas-chat-thread" data-test="cas-chat-thread">
      <article class="cas-message" data-role="user">
        <strong class="cas-message-role">운영자</strong>
        <div class="cas-answer cas-markdown" data-primary="false" data-test="cas-markdown-answer"><p class="cas-md-paragraph">ClusterVersion 상태를 한 문장으로 요약해줘.</p></div>
      </article>
      <article class="cas-message" data-pending="true" data-role="assistant">
        <strong class="cas-message-role">AI Sentinel</strong>
        <div class="cas-pending-answer" data-test="cas-pending-answer"><span>자료 확인 중</span><span aria-hidden="true" class="cas-pending-dots"><span></span><span></span><span></span></span></div>
      </article>
      <article class="cas-message" data-role="assistant">
        <strong class="cas-message-role">AI Sentinel</strong>
        <div class="cas-answer cas-markdown" data-primary="true" data-test="cas-markdown-answer">
          <p class="cas-md-paragraph"><strong>ClusterVersion version</strong>은 현재 4.20.5로 수렴 완료된 정상 상태로 보입니다.</p>
          <h3 class="cas-md-heading" data-level="3">근거</h3>
          <ul class="cas-md-list"><li><code class="cas-md-inline-code">Available=True</code></li><li><code class="cas-md-inline-code">Progressing=False</code></li></ul>
          <h3 class="cas-md-heading" data-level="3">다음 확인</h3>
          <ol class="cas-md-list"><li><code class="cas-md-inline-code">oc get clusterversion version -o yaml</code></li><li>Degraded 조건과 availableUpdates 확인</li></ol>
        </div>
        <div class="cas-rca-trace" data-test="cas-rca-trace"><span class="cas-rca-trace-label">수집 흐름</span><span class="cas-trace-chip" data-status="collected"><strong>OpenShift</strong><span>collected</span><span>1</span></span><span class="cas-trace-chip" data-status="collected"><strong>Metric</strong><span>collected</span><span>1</span></span><span class="cas-trace-chip" data-status="collected"><strong>Runbook</strong><span>collected</span><span>3</span></span><span class="cas-trace-chip" data-status="collected"><strong>Tool Plan</strong><span>collected</span><span>5</span></span><span class="cas-trace-chip" data-status="ok"><strong>Brain</strong><span>ok</span></span></div>
        <details class="cas-result-details" data-test="cas-evidence-panel"><summary>근거 5개 · RCA 후보 1개 · 부족한 증적 0개</summary><div class="cas-result-details-body"><div class="cas-evidence-list"><div class="cas-evidence-group"><div class="cas-panel-heading"><strong>OpenShift 상태/이벤트</strong><span class="cas-meta">1</span></div><div class="cas-meta">왜 보는가: OpenShift 상태, 이벤트, 로그는 RCA의 1차 사실 근거입니다.</div><div class="cas-evidence-item"><strong>openshift:clusterversion:version</strong><div>ClusterVersion desired=4.20.5 conditions=[Available=True, Progressing=False]</div><span>apis/config.openshift.io/v1/clusterversions/version</span></div></div><div class="cas-evidence-group"><div class="cas-panel-heading"><strong>Metric 관측값</strong><span class="cas-meta">1</span></div><div class="cas-evidence-item"><strong>metric:namespace_restart_increase_by_pod:default:Namespace:default</strong><div>namespace_restart_increase_by_pod returned no-series</div><span>thanos.api.v1.query</span></div></div></div></div></details>
      </article>
    </div>
    <form class="cas-compose">
      <div class="cas-suggestion-shell" data-visible="false"><div aria-label="추천 질문" class="cas-suggestion-list" data-test="cas-suggestion-list"><button class="cas-suggestion" data-active="true" type="button">ClusterVersion 상태를 한 문장으로 요약해줘.</button><button class="cas-suggestion" type="button">최근 Warning 이벤트 기준으로 장애 가능성이 높은 리소스를 알려줘.</button><button class="cas-suggestion" type="button">Pending 상태 Pod가 있다면 스케줄링 실패 원인을 분석해줘.</button><button class="cas-suggestion" type="button">Node NotReady 또는 pressure condition이 있는지 점검해줘.</button><button class="cas-suggestion" type="button">운영자가 지금 바로 봐야 할 Top 5 신호를 요약해줘.</button></div></div>
      <div class="cas-input-wrap"><textarea aria-label="AI Sentinel question" placeholder="무엇을 확인할까요?"></textarea><div class="cas-input-tools"><button aria-label="자주 확인" class="cas-compose-icon-button cas-suggestion-button" data-test="cas-suggestion-toggle" type="button">+</button><div aria-label="질문 모드" class="cas-mode-selector" data-test="cas-mode-selector"><button aria-expanded="false" aria-haspopup="menu" class="cas-mode-button" data-open="false" data-test="cas-mode-current" type="button"><svg aria-hidden="true" viewBox="0 0 24 24" role="img"><path d="M5 6.5h14v8.8H9.2L5 18.5v-12Z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="2"></path></svg><span>Ask</span><svg aria-hidden="true" class="cas-mode-chevron" viewBox="0 0 24 24" role="img"><path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path></svg></button><div class="cas-mode-menu" data-open="false" role="menu"><button aria-checked="true" class="cas-mode-option" data-active="true" data-test="cas-mode-ask" role="menuitemradio" type="button"><strong>Ask</strong><span>명확한 설명과 운영 가이드</span></button><button aria-checked="false" class="cas-mode-option" data-active="false" data-test="cas-mode-troubleshooting" role="menuitemradio" type="button"><strong>Troubleshooting</strong><span>장애 진단과 해결 방향 탐색</span></button></div></div></div><button aria-label="질의 전송" class="cas-send-button" data-test="cas-send-question" type="submit"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4.5 19.5 20 12 4.5 4.5 7 11.2 14 12l-7 .8-2.5 6.7Z" fill="currentColor"/></svg></button></div>
    </form>
    </div>
  </div>
</section>
<button aria-label="Cywell AI Sentinel" class="cas-launcher-button" data-test="cas-launcher-button" title="Cywell AI Sentinel" type="button">${icon}</button>
</div>
<pre id="qa-result" class="qa-result">pending</pre>
<script>
function runQa() {
  const panel = document.querySelector(".cas-panel").getBoundingClientRect();
  const body = document.querySelector(".cas-panel-body");
  const chatThread = document.querySelector(".cas-chat-thread");
  const chatThreadStyle = getComputedStyle(chatThread);
  const targetPopover = document.querySelector(".cas-target-popover");
  const targetRect = targetPopover.getBoundingClientRect();
  const chatRect = chatThread.getBoundingClientRect();
  const suggestionShell = document.querySelector(".cas-suggestion-shell");
  const suggestionShellStyle = getComputedStyle(suggestionShell);
  const composer = document.querySelector(".cas-compose");
  const textarea = document.querySelector(".cas-compose textarea");
  const inputTools = document.querySelector(".cas-input-tools").getBoundingClientRect();
  const inputWrap = document.querySelector(".cas-input-wrap").getBoundingClientRect();
  const modeMenuStyle = getComputedStyle(document.querySelector(".cas-mode-menu"));
  const expectedPanelHeight = Math.min(760, innerHeight - 112);
  const minTextareaHeight = innerWidth <= 620 ? 90 : 90;
  const maxTextareaHeight = innerWidth <= 620 ? 98 : 98;
  const maxComposerHeight = innerWidth <= 620 ? 112 : 116;
  const bad = [...document.querySelectorAll(".cas-panel *")].filter((el) => {
    const cs = getComputedStyle(el);
    return el.scrollWidth > el.clientWidth + 2 && cs.overflowX !== "auto" && cs.overflowX !== "scroll";
  }).map((el) => ({ cls: String(el.className || el.tagName), text: (el.textContent || "").trim().slice(0, 80), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth })).slice(0, 12);
  const result = {
    viewport: [innerWidth, innerHeight],
    panel: { left: Math.round(panel.left), right: Math.round(panel.right), top: Math.round(panel.top), bottom: Math.round(panel.bottom), width: Math.round(panel.width), height: Math.round(panel.height) },
    expectedPanelHeight: Math.round(expectedPanelHeight),
    documentOverflowX: document.documentElement.scrollWidth > innerWidth + 1,
    panelInViewport: panel.left >= -1 && panel.right <= innerWidth + 1 && panel.top >= -1 && panel.bottom <= innerHeight + 1,
    panelBodyScrollsVertically: body.scrollHeight > body.clientHeight,
    panelHeightStable: Math.abs(panel.height - expectedPanelHeight) <= 2,
    chatThreadOwnsScroll: chatThreadStyle.overflowY === "auto" || chatThreadStyle.overflowY === "scroll",
    chatThreadHasSpace: chatThread.clientHeight >= 160,
    targetCardVisible: targetPopover.clientHeight > 80,
    targetDoesNotOverlapThread: targetRect.bottom <= chatRect.top + 1,
    suggestionHidden: suggestionShellStyle.display === "none",
    modeInsideComposer: inputTools.left >= inputWrap.left - 1 && inputTools.right <= inputWrap.right + 1 && inputTools.bottom <= inputWrap.bottom + 1,
    modeDropdownClosed: modeMenuStyle.display === "none",
    composerHeight: composer.clientHeight,
    maxComposerHeight,
    textareaHeight: textarea.clientHeight,
    minTextareaHeight,
    maxTextareaHeight,
    compactComposer: composer.clientHeight <= maxComposerHeight,
    textareaFixedHeight: textarea.clientHeight >= minTextareaHeight && textarea.clientHeight <= maxTextareaHeight,
    horizontalOverflowItems: bad
  };
  result.pass = !result.documentOverflowX && result.panelInViewport && result.panelHeightStable && result.chatThreadOwnsScroll && result.chatThreadHasSpace && result.targetCardVisible && result.targetDoesNotOverlapThread && result.suggestionHidden && result.modeInsideComposer && result.modeDropdownClosed && result.compactComposer && result.textareaFixedHeight && bad.length === 0;
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
  const screenshotPath = resolve(outDir, `cas-cockpit-${viewport.id}.png`);
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
  if (!match) {
    throw new Error(`QA result not found for ${viewport.id}`);
  }

  const result = JSON.parse(match[1]);
  return { screenshotPath, result };
}

mkdirSync(outDir, { recursive: true });

const chromePath = findChrome();
record("visual:chrome", Boolean(chromePath), chromePath ?? "Chrome/Edge executable not found");

if (chromePath) {
  const styles = extractLauncherStyles();
  writeFileSync(harnessPath, buildHarness(styles), "utf8");
  record("visual:harness", existsSync(harnessPath), `harness=${harnessPath}`);

  const viewports = [
    { id: "desktop", width: 1440, height: 1000 },
    { id: "mobile-500", width: 500, height: 844 }
  ];

  for (const viewport of viewports) {
    const { screenshotPath, result } = runChrome(chromePath, viewport);
    record(`visual:${viewport.id}:panel`, result.panelInViewport, `panel=${JSON.stringify(result.panel)}`);
    record(
      `visual:${viewport.id}:stable-panel-height`,
      result.panelHeightStable,
      `panelHeight=${result.panel.height} expected=${result.expectedPanelHeight}`
    );
    record(`visual:${viewport.id}:thread-scroll-contract`, result.chatThreadOwnsScroll, "chat thread owns vertical scrolling");
    record(`visual:${viewport.id}:thread-space`, result.chatThreadHasSpace, "chat thread keeps readable space");
    record(`visual:${viewport.id}:target-card`, result.targetCardVisible, "target settings card is visible and labeled");
    record(`visual:${viewport.id}:target-no-overlap`, result.targetDoesNotOverlapThread, "target settings does not overlap the chat thread");
    record(`visual:${viewport.id}:suggestion-hidden`, result.suggestionHidden, "recommended questions do not occupy composer space while hidden");
    record(`visual:${viewport.id}:compact-composer`, result.compactComposer, `composerHeight=${result.composerHeight}`);
    record(`visual:${viewport.id}:textarea-height`, result.textareaFixedHeight, "composer textarea height is fixed");
    record(`visual:${viewport.id}:overflow-x`, !result.documentOverflowX, "no document horizontal overflow");
    record(
      `visual:${viewport.id}:text-overflow`,
      Array.isArray(result.horizontalOverflowItems) && result.horizontalOverflowItems.length === 0,
      `screenshot=${screenshotPath}`,
      JSON.stringify(result.horizontalOverflowItems)
    );
  }
}

const failures = checks.filter((check) => !check.ok);
if (failures.length) {
  console.error(`Console visual smoke verification failed with ${failures.length} failures.`);
  process.exit(1);
}

console.log(`Console visual smoke verification passed with ${checks.length} checks.`);
