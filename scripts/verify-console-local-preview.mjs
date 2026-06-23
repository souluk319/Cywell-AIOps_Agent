#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outDir = resolve(root, "test-results", "local-preview");
const previewUrl = process.env.CAS_LOCAL_PREVIEW_URL ?? "http://127.0.0.1:9001/workbench.html";
const checks = [];

function record(id, ok, detail) {
  checks.push({ id, ok, detail });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${id}: ${detail}`);
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

function assertDom(dom, id, ok, detail) {
  record(id, ok, detail);
  if (!ok) {
    writeFileSync(resolve(outDir, "cas-local-preview-failed-dom.html"), dom, "utf8");
  }
}

mkdirSync(outDir, { recursive: true });

const chromePath = findChrome();
record("local-preview:chrome", Boolean(chromePath), chromePath ?? "Chrome/Edge executable not found");
if (!chromePath) process.exit(1);

const screenshotPath = resolve(outDir, "cas-local-preview.png");
const domPath = resolve(outDir, "cas-local-preview-dom.html");
const chromeArgs = [
  "--headless=new",
  "--disable-gpu",
  "--force-device-scale-factor=1",
  "--hide-scrollbars",
  "--window-size=1440,1000",
  "--virtual-time-budget=3500"
];

execFileSync(chromePath, [...chromeArgs, `--screenshot=${screenshotPath}`, previewUrl], { stdio: "ignore" });
const dom = execFileSync(chromePath, [...chromeArgs, "--dump-dom", previewUrl], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"]
});
writeFileSync(domPath, dom, "utf8");

assertDom(dom, "local-preview:actual-launcher-panel", dom.includes('data-test="cas-launcher-panel"'), "renders CASLauncher panel");
assertDom(dom, "local-preview:conversation-sidebar", dom.includes('data-test="cas-conversation-sidebar"'), "renders external conversation wing");
assertDom(dom, "local-preview:sidebar-new-chat", dom.includes('data-test="cas-sidebar-new-chat"'), "new chat exists in sidebar");
assertDom(dom, "local-preview:no-old-save-chat", !dom.includes("현재 대화 저장") && !dom.includes('id="save-chat"'), "old manual save workbench UI is gone");
assertDom(dom, "local-preview:no-header-new-chat", !dom.includes('data-test="cas-new-chat"'), "header has no old new-chat action");
assertDom(
  dom,
  "local-preview:no-internal-workspace",
  !dom.includes("cas-panel-workspace") && !dom.includes("cas-panel-split") && !dom.includes("cas-panel-fullscreen"),
  "no internal workspace/split/fullscreen wrapper"
);

record("local-preview:screenshot", existsSync(screenshotPath), screenshotPath);
record("local-preview:dom", existsSync(domPath), domPath);

const failures = checks.filter((check) => !check.ok);
if (failures.length) {
  console.error(`CAS local preview verification failed with ${failures.length} failures.`);
  process.exit(1);
}

console.log(`CAS local preview verification passed with ${checks.length} checks.`);
