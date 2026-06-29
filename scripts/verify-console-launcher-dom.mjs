#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { chromium } from "playwright-core";

const root = resolve(".");
const distDir = resolve(root, "apps/console-plugin/dist");
const requireBrowser = process.argv.includes("--require-browser");
const calls = [];
const failures = [];
const pageErrors = [];

function expect(id, condition, passDetail, failDetail = passDetail) {
  if (condition) {
    console.log(`[PASS] ${id}: ${passDetail}`);
  } else {
    failures.push({ id, detail: failDetail });
    console.log(`[FAIL] ${id}: ${failDetail}`);
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function contentType(filePath) {
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function harnessHtml() {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cywell Launcher DOM Smoke</title>
</head>
<body>
  <button aria-label="OpenShift Lightspeed" data-test="lightspeed-launcher-button" style="position: fixed; right: 24px; bottom: 24px;">Lightspeed</button>
  <div id="root"></div>
  <div id="modal-root"></div>
  <script>
    window.loadPluginEntry = function loadPluginEntry(_name, container) {
      window.__cywellPluginContainer = container;
    };
  </script>
  <script src="/vendor/react.development.js"></script>
  <script src="/vendor/react-dom.development.js"></script>
  <script src="/api/plugins/cywell-ai-sentinel/plugin-entry.js"></script>
  <script>
    (async function mountPlugin() {
      const container = window.__cywellPluginContainer;
      const modalRoots = new Map();
      const sdkModule = {
        useModal: function useModal() {
          return function launchModal(Component, props, key) {
            const modalKey = key || "default";
            let entry = modalRoots.get(modalKey);
            if (!entry) {
              const mount = document.createElement("div");
              mount.setAttribute("data-modal-key", modalKey);
              document.getElementById("modal-root").appendChild(mount);
              entry = { mount, root: window.ReactDOM.createRoot(mount) };
              modalRoots.set(modalKey, entry);
            }
            window.__casLaunchCalls = (window.__casLaunchCalls || 0) + 1;
            entry.root.render(window.React.createElement(Component, props || {}));
          };
        }
      };
      const reactShare = {
        react: {
          "18.3.1": {
            from: "console-launcher-dom-smoke",
            eager: true,
            loaded: true,
            get: function getReact() {
              return function provideReact() {
                return window.React;
              };
            }
          }
        },
        "@openshift-console/dynamic-plugin-sdk": {
          "4.19.1": {
            from: "console-launcher-dom-smoke",
            eager: true,
            loaded: true,
            get: function getSdk() {
              return function provideSdk() {
                return sdkModule;
              };
            }
          }
        }
      };
      await container.init(reactShare);
      const factory = await container.get("useCASLauncher");
      const module = factory();
      const useCASLauncher = module.useCASLauncher || module.default || module;
      function Harness() {
        useCASLauncher();
        return window.React.createElement("div", { "data-test": "launcher-hook-mounted" }, "mounted");
      }
      let root = window.ReactDOM.createRoot(document.getElementById("root"));
      window.__rerenderLauncher = function rerenderLauncher() {
        root.render(window.React.createElement(Harness));
      };
      window.__remountLauncher = function remountLauncher() {
        root.unmount();
        root = window.ReactDOM.createRoot(document.getElementById("root"));
        root.render(window.React.createElement(Harness));
      };
      window.__rerenderLauncher();
      window.__cywellMounted = true;
    })().catch(function mountError(error) {
      console.error("launcher harness mount failed", error && error.stack ? error.stack : error);
    });
  </script>
</body>
</html>`;
}

function createHarnessServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/launcher") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(harnessHtml());
      return;
    }
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === "/vendor/react.development.js" || url.pathname === "/vendor/react-dom.development.js") {
      const vendorFile =
        basename(url.pathname) === "react.development.js"
          ? resolve(root, "node_modules/react/umd/react.development.js")
          : resolve(root, "node_modules/react-dom/umd/react-dom.development.js");
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(await readFile(vendorFile));
      return;
    }
    if (url.pathname.startsWith("/api/plugins/cywell-ai-sentinel/")) {
      const relativePath = decodeURIComponent(url.pathname.replace("/api/plugins/cywell-ai-sentinel/", ""));
      if (!relativePath || relativePath.includes("..")) {
        response.writeHead(404);
        response.end("missing plugin asset");
        return;
      }
      const filePath = join(distDir, relativePath);
      if (!existsSync(filePath)) {
        response.writeHead(404);
        response.end("missing plugin asset");
        return;
      }
      response.writeHead(200, { "content-type": contentType(filePath) });
      response.end(await readFile(filePath));
      return;
    }
    if (url.pathname.startsWith("/api/proxy/plugin/cywell-ai-sentinel/cas-api/api/aiops/")) {
      const body = await readRequestBody(request);
      const aiopsPath = url.pathname.replace("/api/proxy/plugin/cywell-ai-sentinel/cas-api", "");
      calls.push({ method: request.method, path: aiopsPath, body });
      if (request.method === "GET" && aiopsPath === "/api/aiops/brainz") {
        sendJson(response, 200, { status: "ok", brain: { provider: "openshift-lightspeed", status: "ready" } });
        return;
      }
      if (request.method === "POST" && aiopsPath === "/api/aiops/query") {
        sendJson(response, 200, {
          run_id: `launcher-${calls.filter((call) => call.path === "/api/aiops/query").length}`,
          mode: "lightspeed_read_only",
          conversation_id: body?.conversation_id || "conversation-launcher-1",
          audit: { answer_provider: "openshift-lightspeed" },
          rca_result: {
            answer: `answer for ${body?.question || "question"}`,
            cause_candidates: [{ cause: "validated launcher request", confidence: 0.91, evidence_refs: ["launcher"] }]
          },
          evidence_bundle: { evidence: [{ id: "launcher", source: "harness", summary: "launcher query reached CAS Gateway" }] }
        });
        return;
      }
    }
    response.writeHead(404);
    response.end("not found");
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolvePromise({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function run() {
  const serverHandle = await createHarnessServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });
    await page.goto(`${serverHandle.url}/launcher`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-test="launcher-hook-mounted"]', { timeout: 15000 });
    await page.waitForSelector('[data-test="cas-launcher-button"]', { timeout: 15000 });
    expect(
      "console-launcher-dom:single-button",
      (await page.locator('[data-test="cas-launcher-button"]').count()) === 1,
      "launcher hook renders exactly one CAS launcher button"
    );
    await page.waitForFunction(
      () => document.querySelector('[data-test="lightspeed-launcher-button"]')?.getAttribute("data-cas-suppressed-lightspeed") === "true",
      undefined,
      { timeout: 15000 }
    );
    const lightspeedStyle = await page.locator('[data-test="lightspeed-launcher-button"]').evaluate((element) => {
      const style = window.getComputedStyle(element);
      return { display: style.display, ariaHidden: element.getAttribute("aria-hidden"), suppressed: element.getAttribute("data-cas-suppressed-lightspeed") };
    });
    expect(
      "console-launcher-dom:native-lightspeed-suppressed",
      lightspeedStyle.display === "none" && lightspeedStyle.ariaHidden === "true" && lightspeedStyle.suppressed === "true",
      "CAS launcher suppresses a pre-existing OpenShift Lightspeed launcher",
      JSON.stringify(lightspeedStyle)
    );
    await page.evaluate(() => {
      const unrelatedControls = document.createElement("button");
      unrelatedControls.setAttribute("data-test", "tools-controls-toolbar");
      unrelatedControls.textContent = "Tools";
      document.body.appendChild(unrelatedControls);

      const childTitleButton = document.createElement("button");
      childTitleButton.setAttribute("data-test", "late-child-title-root");
      childTitleButton.setAttribute("style", "position: fixed; right: 24px; bottom: 84px;");
      const child = document.createElement("span");
      child.setAttribute("title", "OpenShift Lightspeed Assistant");
      child.textContent = "OLS";
      childTitleButton.appendChild(child);
      document.body.appendChild(childTitleButton);

      const classVariant = document.createElement("button");
      classVariant.setAttribute("data-test", "late-class-variant-root");
      classVariant.setAttribute("class", "pf-v6-c-button ols-chatbot-button-extra");
      classVariant.setAttribute("style", "position: fixed; right: 24px; bottom: 144px;");
      classVariant.textContent = "Ask Lightspeed";
      document.body.appendChild(classVariant);
    });
    await page.waitForFunction(
      () =>
        document.querySelector('[data-test="late-child-title-root"]')?.getAttribute("data-cas-suppressed-lightspeed") === "true" &&
        document.querySelector('[data-test="late-class-variant-root"]')?.getAttribute("data-cas-suppressed-lightspeed") === "true",
      undefined,
      { timeout: 15000 }
    );
    const unrelatedStyle = await page.locator('[data-test="tools-controls-toolbar"]').evaluate((element) => {
      const style = window.getComputedStyle(element);
      return { display: style.display, ariaHidden: element.getAttribute("aria-hidden"), suppressed: element.getAttribute("data-cas-suppressed-lightspeed") };
    });
    expect(
      "console-launcher-dom:unrelated-controls-not-suppressed",
      unrelatedStyle.display !== "none" && unrelatedStyle.ariaHidden !== "true" && unrelatedStyle.suppressed !== "true",
      "CAS launcher does not suppress unrelated data-test values containing tools/controls",
      JSON.stringify(unrelatedStyle)
    );
    const lateSuppression = await page.evaluate(() =>
      ["late-child-title-root", "late-class-variant-root"].map((testId) => {
        const element = document.querySelector(`[data-test="${testId}"]`);
        const style = element ? window.getComputedStyle(element) : null;
        return {
          testId,
          display: style?.display,
          ariaHidden: element?.getAttribute("aria-hidden"),
          suppressed: element?.getAttribute("data-cas-suppressed-lightspeed")
        };
      })
    );
    expect(
      "console-launcher-dom:native-lightspeed-variants-suppressed",
      lateSuppression.every((item) => item.display === "none" && item.ariaHidden === "true" && item.suppressed === "true"),
      "CAS launcher suppresses late native Lightspeed variants even when only child title or class variants match",
      JSON.stringify(lateSuppression)
    );
    const buttonStyle = await page.locator('[data-test="cas-launcher-button"]').evaluate((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        position: style.position,
        offsetRight: Math.round(window.innerWidth - rect.right),
        offsetBottom: Math.round(window.innerHeight - rect.bottom),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
    });
    expect(
      "console-launcher-dom:bottom-right-fixed",
      buttonStyle.position === "fixed" &&
        buttonStyle.width === 48 &&
        buttonStyle.height === 48 &&
        Math.abs(buttonStyle.offsetRight - 24) <= 1 &&
        Math.abs(buttonStyle.offsetBottom - 24) <= 1,
      "launcher button is a fixed 48px bottom-right control",
      JSON.stringify(buttonStyle)
    );
    await page.evaluate(() => window.__rerenderLauncher());
    await page.evaluate(() => window.__remountLauncher());
    await page.waitForTimeout(100);
    expect(
      "console-launcher-dom:no-duplicate-after-remount",
      (await page.locator('[data-test="cas-launcher-button"]').count()) === 1,
      "rerender/remount does not leave duplicate launcher buttons"
    );
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/aiops/brainz") && response.status() === 200),
      page.locator('[data-test="cas-launcher-button"]').click()
    ]);
    await page.waitForSelector('[data-test="cas-launcher-panel"]', { timeout: 15000 });
    expect("console-launcher-dom:panel-opens", (await page.locator('[data-test="cas-launcher-panel"]').count()) === 1, "launcher click opens the CAS panel");
    expect(
      "console-launcher-dom:brainz-on-open",
      calls.some((call) => call.method === "GET" && call.path === "/api/aiops/brainz"),
      "opening launcher checks Gateway brain readiness"
    );
    await page.getByLabel("AI Sentinel question").fill("Why did the console pod restart?");
    await page.getByLabel("Namespace").fill("openshift-console");
    await page.getByLabel("Resource name").fill("console-pod");
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/aiops/query") && response.status() === 200),
      page.locator('[data-test="cas-run-analysis"]').click()
    ]);
    await page.waitForSelector('[data-test="cas-conversation-id"]', { timeout: 15000 });
    const firstQuery = calls.find((call) => call.method === "POST" && call.path === "/api/aiops/query");
    expect(
      "console-launcher-dom:query-body",
      firstQuery?.body?.question === "Why did the console pod restart?" &&
        firstQuery.body?.scope?.namespaces?.[0] === "openshift-console" &&
        firstQuery.body?.resourceRef?.kind === "Pod" &&
        firstQuery.body?.resourceRef?.name === "console-pod" &&
        firstQuery.body?.mode === "read_only",
      "launcher posts read-only query body through the CAS Gateway",
      JSON.stringify(firstQuery?.body)
    );
    await page.getByLabel("AI Sentinel question").fill("Continue that analysis");
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/aiops/query") && response.status() === 200),
      page.locator('[data-test="cas-run-analysis"]').click()
    ]);
    const queryCalls = calls.filter((call) => call.method === "POST" && call.path === "/api/aiops/query");
    expect(
      "console-launcher-dom:conversation-preserved",
      queryCalls.length >= 2 && queryCalls[1].body?.conversation_id === "conversation-launcher-1",
      "launcher preserves Gateway conversation_id on the next query",
      JSON.stringify(queryCalls.map((call) => call.body))
    );
    expect("console-launcher-dom:browser-errors", pageErrors.length === 0, "browser reports no console errors or uncaught page errors", JSON.stringify(pageErrors));
  } catch (error) {
    failures.push({ id: "console-launcher-dom:smoke", detail: error instanceof Error ? error.message : String(error) });
    console.log(`[FAIL] console-launcher-dom:smoke: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (browser) await browser.close();
    serverHandle.server.close();
  }
}

try {
  await run();
} catch (error) {
  failures.push({ id: "console-launcher-dom:setup", detail: error instanceof Error ? error.message : String(error) });
}

if (failures.length > 0) {
  console.error(`Console launcher DOM verification failed with ${failures.length} failures.`);
  process.exit(1);
}
console.log("Console launcher DOM verification passed with 10 checks.");
