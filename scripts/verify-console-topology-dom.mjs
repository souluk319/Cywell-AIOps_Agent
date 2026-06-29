#!/usr/bin/env node
import { createServer } from "node:http";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";

const checks = [];
const calls = [];
const root = process.cwd();
const distDir = resolve(root, "apps/console-plugin/dist");
const requireBrowser =
  process.argv.includes("--require-browser") ||
  ["1", "true", "yes", "y", "on"].includes(String(process.env.CAS_TOPOLOGY_DOM_REQUIRE_BROWSER ?? "").toLowerCase());

function record(status, id, detail, evidence) {
  checks.push({ status, id, detail, evidence });
  console.log(`[${status}] ${id}: ${detail}`);
  if (evidence) console.log(evidence);
}

function pass(id, detail) {
  record("PASS", id, detail);
}

function fail(id, detail, evidence) {
  record("FAIL", id, detail, evidence);
}

function skip(id, detail) {
  record("SKIP", id, detail);
}

function expect(id, condition, detail, evidence) {
  if (condition) pass(id, detail);
  else fail(id, detail, evidence);
}

async function exists(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function contentType(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".html") return "text/html; charset=utf-8";
  return "application/octet-stream";
}

function readRequestBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let data = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      data += chunk;
    });
    request.on("end", () => {
      if (!data) {
        resolveBody(null);
        return;
      }
      try {
        resolveBody(JSON.parse(data));
      } catch {
        resolveBody(data);
      }
    });
    request.on("error", rejectBody);
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function denseTopologyGraph() {
  const nodes = Array.from({ length: 28 }, (_, index) => {
    const type = index % 5 === 0 ? "document" : index % 5 === 1 ? "wiki-note" : index % 5 === 2 ? "term" : index % 5 === 3 ? "runtime" : "image";
    return {
      node_id: `dense-node-${index}`,
      kind: type,
      title: `Dense Customer Topology Node ${index} With Long Operational Label`,
      summary: `Dense topology node ${index} validates layout behavior with realistic long customer text.`,
      status: index % 3 === 0 ? "indexed" : "linked"
    };
  });
  const links = nodes.slice(1).map((node, index) => ({
    source_id: index % 4 === 0 ? node.node_id : "dense-node-0",
    target_id: index % 4 === 0 ? "dense-node-0" : node.node_id,
    kind: index % 2 === 0 ? "relates" : "mentions"
  }));
  return {
    counts: { nodes: nodes.length, edges: links.length, documents: 6, notes: 6 },
    nodes,
    links
  };
}

function topologyResponse(customerId) {
  if (customerId === "empty-topology") {
    return {
      status: "ok",
      customer_id: customerId,
      topology: {
        graph: {
          counts: { nodes: 0, edges: 0, documents: 0, notes: 0 },
          nodes: [],
          links: []
        }
      }
    };
  }
  if (customerId === "mixed-scope-topology") {
    return {
      status: "ok",
      customer_id: customerId,
      relations: [{ source_id: "wrapper-noise-source", target_id: "wrapper-noise-target", kind: "noise" }],
      topology: {
        graph: {
          counts: { nodes: 2, edges: 1, documents: 1, notes: 1 },
          nodes: [
            { node_id: "mixed-doc", kind: "document", title: "Mixed Scope Document" },
            { node_id: "mixed-note", kind: "wiki-note", title: "Mixed Scope Wiki" }
          ],
          links: [{ source_id: "mixed-note", target_id: "mixed-doc", kind: "summarizes" }]
        }
      }
    };
  }
  if (customerId === "orphan-topology") {
    return {
      status: "ok",
      customer_id: customerId,
      topology: {
        graph: {
          counts: { nodes: 1, edges: 1, documents: 0, notes: 1 },
          nodes: [{ node_id: "pbs-orphan-note", kind: "wiki-note", title: "Orphan Edge Wiki Note" }],
          links: [{ source_id: "pbs-orphan-note", target_id: "pbs-missing-endpoint", kind: "references" }]
        }
      }
    };
  }
  if (customerId === "slow-topology") {
    return {
      status: "ok",
      customer_id: customerId,
      topology: {
        graph: {
          counts: { nodes: 2, edges: 1, documents: 1, notes: 1 },
          nodes: [
            { node_id: "slow-doc", kind: "document", title: "Slow Customer Document" },
            { node_id: "slow-note", kind: "wiki-note", title: "Slow Customer Wiki" }
          ],
          links: [{ source_id: "slow-note", target_id: "slow-doc", kind: "summarizes" }]
        }
      }
    };
  }
  if (customerId === "pbs-rich-topology") {
    return {
      status: "ok",
      customer_id: customerId,
      topology: {
        graph: {
          counts: {
            nodes: 6,
            edges: 3,
            document_node_count: 1,
            upload_node_count: 1,
            note_count: 1,
            compiled_note_count: 1,
            wikilink_count: 1,
            tag_count: 1,
            entity_node_count: 1,
            concept_node_count: 1,
            graph_relation_count: 3
          },
          nodes: [
            { node_id: "pbs-rich-note", kind: "note", title: "Rich Wiki Note", degree: 9, weight: 0.92, compiled_wiki: true, viewer_path: "/wiki/rich" },
            { node_id: "pbs-rich-upload", kind: "upload_document", title: "Rich Upload", degree: 3, source_kind: "upload", source_url: "cas://pbs/rich-upload" },
            { node_id: "pbs-rich-link", kind: "wikilink", title: "HAProxy", degree: 4 },
            { node_id: "pbs-rich-tag", kind: "tag", title: "router", degree: 2 },
            { node_id: "pbs-rich-entity", kind: "entity", entity_kind: "openshift_resource", title: "route shard", degree: 5 },
            { node_id: "pbs-rich-concept", kind: "concept", title: "latency", degree: 4 }
          ],
          links: [
            { source_id: "pbs-rich-note", target_id: "pbs-rich-link", kind: "links_to" },
            { source_id: "pbs-rich-note", target_id: "pbs-rich-tag", kind: "tagged" },
            { source_id: "pbs-rich-entity", target_id: "pbs-rich-concept", kind: "explains" }
          ]
        },
        pbs: {
          top_wikilinks: [{ label: "HAProxy", count: 4 }],
          top_tags: [{ label: "router", count: 2 }],
          selected_uploads: [
            {
              document_source_id: "pbs-rich-upload",
              title: "Rich Upload",
              source_scope: "user_upload",
              ready_for_chat: true,
              chunk_count: 7
            }
          ],
          selected_context: [
            {
              id: "pbs-rich-note",
              title: "Rich Wiki Note",
              body: "Compiled wiki context for HAProxy router latency.",
              document_source_id: "pbs-rich-upload",
              viewer_path: "/wiki/rich",
              source_scope: "wiki_vault"
            }
          ],
          relations: [
            { source: "pbs-rich-upload", target: "pbs-rich-note", type: "compiled_to" },
            { source: "pbs-rich-note", target: "HAProxy", type: "links_to" }
          ]
        }
      }
    };
  }
  if (customerId === "workflow-customer") {
    return {
      status: "ok",
      customer_id: customerId,
      topology: {
        graph: {
          counts: { nodes: 3, edges: 2, documents: 1, notes: 1, upload_node_count: 1, note_count: 1, graph_relation_count: 2 },
          nodes: [
            {
              node_id: "workflow-doc-1",
              kind: "upload_document",
              title: "Workflow Router Report",
              summary: "Selected customer upload that feeds RAG and LLM Wiki.",
              document_source_id: "workflow-doc-1",
              source_scope: "user_upload",
              ready_for_chat: true,
              chunk_count: 3
            },
            {
              node_id: "workflow-wiki-1",
              kind: "wiki-note",
              title: "Workflow Router Wiki",
              summary: "Compiled wiki note for the selected workflow document.",
              document_source_id: "workflow-doc-1",
              source_scope: "wiki_vault",
              compiled_wiki: true,
              revision: 2,
              previous_revision: 1,
              viewer_path: "/wiki/workflow-router"
            },
            { node_id: "workflow-runtime", kind: "runtime", title: "PBS Runtime" }
          ],
          links: [
            { source_id: "workflow-wiki-1", target_id: "workflow-doc-1", kind: "compiled_from", source_document_id: "workflow-doc-1" },
            { source_id: "workflow-runtime", target_id: "workflow-wiki-1", kind: "feeds", source_document_id: "workflow-doc-1" }
          ]
        },
        pbs: {
          selected_uploads: [
            {
              document_source_id: "workflow-doc-1",
              title: "Workflow Router Report",
              source_scope: "user_upload",
              ready_for_chat: true,
              chunk_count: 3
            }
          ],
          selected_context: [
            {
              id: "workflow-wiki-1",
              title: "Workflow Router Wiki",
              body: "Compiled wiki context for the workflow router report.",
              document_source_id: "workflow-doc-1",
              source_scope: "wiki_vault"
            }
          ],
          relations: [{ source: "workflow-doc-1", target: "workflow-wiki-1", type: "compiled_to" }]
        }
      }
    };
  }
  const graph =
    customerId === "dense-topology"
      ? denseTopologyGraph()
      : {
          counts: { nodes: 4, edges: 3, documents: 1, notes: 1 },
          nodes: [
            {
              node_id: "doc-router",
              kind: "document",
              title: "ACME Router Evidence",
              summary: "Uploaded customer runbook for router latency.",
              status: "indexed"
            },
            {
              node_id: "wiki-router",
              kind: "wiki-note",
              title: "ACME Router Wiki",
              summary: "LLM Wiki note compiled from ACME Router Evidence.",
              document_source_id: "doc-router",
              source_scope: "user_upload",
              revision: 4,
              previous_revision: 3,
              provenance: { source_document_id: "doc-router", source: "wiki-loop" }
            },
            { node_id: "term-latency", kind: "term", title: "latency" },
            { node_id: "pbs-runtime", kind: "runtime", title: "PBS Runtime" }
          ],
          links: [
            { source_id: "wiki-router", target_id: "doc-router", kind: "summarizes", provenance: { source_document_id: "doc-router" } },
            { source_id: "doc-router", target_id: "term-latency", kind: "mentions" },
            { source_id: "pbs-runtime", target_id: "wiki-router", kind: "feeds" }
          ]
        };
  return {
    status: "ok",
    customer_id: customerId,
    topology: {
      graph
    }
  };
}

function workflowReportItems(customerId) {
  if (customerId === "empty-reports") return [];
  return [
    {
      id: "workflow-doc-1",
      document_source_id: "workflow-doc-1",
      title: "Workflow Router Report",
      filename: "workflow-router-report.md",
      summary: `Router evidence for ${customerId}.`,
      source_scope: "user_upload",
      ready_for_chat: true,
      chunk_count: 3,
      graph_summary: { nodes: 4, edges: 2 },
      chunk_previews: [{ id: "workflow-chunk-1", text: "router latency evidence" }]
    },
    {
      id: "workflow-doc-2",
      document_source_id: "workflow-doc-2",
      title: "Workflow Secondary Evidence",
      filename: "workflow-secondary.md",
      summary: "Secondary namespace events.",
      source_scope: "user_upload",
      ready_for_chat: true,
      chunk_count: 2
    }
  ];
}

function harnessHtml() {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cywell Topology DOM Smoke</title>
</head>
<body>
  <div id="root"></div>
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
      const reactShare = {
        react: {
          "18.3.1": {
            from: "console-topology-dom-smoke",
            eager: true,
            loaded: true,
            get: function getReact() {
              return function provideReact() {
                return window.React;
              };
            }
          }
        }
      };
      await container.init(reactShare);
      const factory = await container.get("CywellKnowledgeRoute");
      const module = factory();
      const Component = module.default || module;
      window.__cywellMounted = true;
      window.ReactDOM.createRoot(document.getElementById("root")).render(window.React.createElement(Component));
    })().catch(function mountError(error) {
      console.error("topology harness mount failed", error && error.stack ? error.stack : error);
    });
  </script>
</body>
</html>`;
}

function createHarnessServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (["/cywell/customer-data", "/cywell/rag", "/cywell/llm-wiki", "/cywell/topology"].includes(url.pathname)) {
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
      if (!(await exists(filePath))) {
        response.writeHead(404);
        response.end("missing plugin asset");
        return;
      }
      response.writeHead(200, { "content-type": contentType(filePath) });
      response.end(await readFile(filePath));
      return;
    }

    if (url.pathname.startsWith("/api/proxy/plugin/cywell-ai-sentinel/cas-api/api/knowledge/")) {
      const body = await readRequestBody(request);
      const knowledgePath = url.pathname.replace("/api/proxy/plugin/cywell-ai-sentinel/cas-api", "");
      calls.push({ method: request.method, path: knowledgePath, query: Object.fromEntries(url.searchParams.entries()), body });
      if (request.method === "GET" && knowledgePath === "/api/knowledge/healthz") {
        sendJson(response, 200, {
          status: "ok",
          service: "cas-knowledge-engine",
          engine: { provider: "local", status: "ok" },
          capabilities: []
        });
        return;
      }
      if (request.method === "GET" && knowledgePath === "/api/knowledge/topology") {
        if (url.searchParams.get("customer_id") === "broken-topology") {
          sendJson(response, 500, { status: "error", code: "topology-fixture-failure", error: "forced topology failure" });
          return;
        }
        if (url.searchParams.get("customer_id") === "slow-topology") {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
        }
        sendJson(response, 200, topologyResponse(url.searchParams.get("customer_id") || "default"));
        return;
      }
      if (request.method === "GET" && knowledgePath === "/api/knowledge/uploads/reports") {
        const customerId = url.searchParams.get("customer_id") || "default";
        const items = workflowReportItems(customerId);
        sendJson(response, 200, {
          status: "ok",
          customer_id: customerId,
          items,
          reports: items,
          counts: { documents: items.length }
        });
        return;
      }
      if (request.method === "POST" && knowledgePath === "/api/knowledge/uploads/ingest") {
        if (body?.customer_id === "slow-upload") {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
        }
        sendJson(response, 200, {
          status: "indexed",
          document: {
            id: "uploaded-workflow-doc",
            document_source_id: "uploaded-workflow-doc",
            title: body?.file_name || body?.filename || "Uploaded Workflow Document",
            filename: body?.file_name || body?.filename,
            source_scope: "user_upload",
            ready_for_chat: true,
            chunk_count: 2
          },
          chunks_indexed: 2
        });
        return;
      }
      if (request.method === "POST" && knowledgePath === "/api/knowledge/uploads/url-ingest") {
        sendJson(response, 200, {
          status: "indexed",
          schema_version: "url_ingestion_report_v1",
          pages: [
            {
              id: "url-workflow-doc",
              document_source_id: "url-workflow-doc",
              title: "URL Workflow Runbook",
              url: body?.url,
              source_scope: "user_upload",
              ready_for_chat: true,
              chunk_count: 4
            }
          ],
          upload_results: [
            {
              id: "url-workflow-doc",
              document_source_id: "url-workflow-doc",
              title: "URL Workflow Runbook",
              source_scope: "user_upload",
              ready_for_chat: true,
              chunk_count: 4
            }
          ],
          summary: { imported_url_count: 1 }
        });
        return;
      }
      if (request.method === "GET" && knowledgePath === "/api/knowledge/wiki-vault") {
        if (url.searchParams.get("customer_id") === "vault-empty-topology") {
          sendJson(response, 200, {
            status: "ok",
            customer_id: "vault-empty-topology",
            topology: {
              graph: {
                counts: { nodes: 0, edges: 0, documents: 0, notes: 0 },
                nodes: [],
                links: []
              }
            }
          });
          return;
        }
        sendJson(response, 200, topologyResponse(url.searchParams.get("customer_id") || "default"));
        return;
      }
      if (request.method === "POST" && knowledgePath === "/api/knowledge/rag/query") {
        if (body?.question === "slow-selected-rag") await delay(250);
        sendJson(response, 200, {
          status: "ok",
          answer: `RAG answer for ${body?.question ?? "topology node"}`,
          citations: [{ document_id: body?.active_document_id || "doc-router", title: "ACME Router Evidence", snippet: "router latency evidence" }],
          trace: { retriever: "dom-smoke" }
        });
        return;
      }
      if (request.method === "POST" && knowledgePath === "/api/knowledge/wiki-loop/run") {
        sendJson(response, 200, {
          status: "done",
          run_id: "workflow-wiki-run",
          stages: [{ name: "compile", status: "done" }],
          summary: { compiled_note_count: 1 }
        });
        return;
      }
      if (request.method === "POST" && knowledgePath === "/api/knowledge/wiki-vault/notes") {
        sendJson(response, 200, {
          status: "saved",
          overlay_id: "workflow-note-overlay",
          note_id: "workflow-note-1",
          document_id: body?.document_id,
          target_ref: body?.target_ref,
          title: body?.title,
          payload: body?.payload
        });
        return;
      }
      sendJson(response, 404, { status: "error", error: `missing harness route ${request.method} ${knowledgePath}` });
      return;
    }

    response.writeHead(404);
    response.end("not found");
  });

  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveServer({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function launchBrowser() {
  const executableCandidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    process.env.MSEDGE_BIN,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe") : "",
    process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe") : "",
    process.env["PROGRAMFILES(X86)"] ? join(process.env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe") : "",
    process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, "Microsoft/Edge/Application/msedge.exe") : "",
    process.env["PROGRAMFILES(X86)"] ? join(process.env["PROGRAMFILES(X86)"], "Microsoft/Edge/Application/msedge.exe") : "",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge"
  ].filter(Boolean);

  const attempts = [
    { channel: "msedge", headless: true },
    { channel: "chrome", headless: true },
    ...(await Promise.all(
      executableCandidates.map(async (executablePath) => ((await exists(executablePath)) ? { executablePath, headless: true } : null))
    )).filter(Boolean)
  ];

  const errors = [];
  for (const launchOptions of attempts) {
    try {
      return await chromium.launch({ ...launchOptions, args: ["--no-sandbox"] });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { skipped: errors.join("\n") };
}

async function assertViewportLayout(page, viewport, customerId) {
  await page.setViewportSize(viewport);
  await page.getByLabel("Customer ID").fill(customerId);
  await Promise.all([
    page.waitForResponse((response) => response.url().includes(`/api/knowledge/topology?customer_id=${customerId}`) && response.status() === 200),
    page.locator('[data-test="cas-knowledge-topology"]').click()
  ]);
  await page.waitForSelector('[data-test="cas-topology-node"]', { timeout: 15000 });

  const layout = await page.evaluate(() => {
    const canvas = document.querySelector('[data-test="cas-topology-canvas"]');
    const nodes = Array.from(document.querySelectorAll('[data-test="cas-topology-node"]'));
    const rects = nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    });
    const intersections = [];
    for (let leftIndex = 0; leftIndex < rects.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < rects.length; rightIndex += 1) {
        const left = rects[leftIndex];
        const right = rects[rightIndex];
        const overlap =
          left.left < right.right - 1 &&
          left.right > right.left + 1 &&
          left.top < right.bottom - 1 &&
          left.bottom > right.top + 1;
        if (overlap) intersections.push([leftIndex, rightIndex]);
      }
    }
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      bodyOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      canvasOverflow: canvas ? canvas.scrollWidth - canvas.clientWidth : 0,
      nodeCount: nodes.length,
      intersections,
      labels: nodes.map((node) => node.textContent)
    };
  });
  expect(
    `console-topology-dom:${viewport.width}w-no-horizontal-overflow`,
    layout.bodyOverflow <= 1 && layout.canvasOverflow <= 1,
    `topology layout has no horizontal overflow at ${viewport.width}px`,
    JSON.stringify(layout)
  );
  expect(
    `console-topology-dom:${viewport.width}w-no-node-overlap`,
    layout.nodeCount > 0 && layout.intersections.length === 0,
    `topology nodes do not overlap at ${viewport.width}px`,
    JSON.stringify(layout)
  );
}

const requiredAssets = [
  resolve(distDir, "plugin-entry.js"),
  resolve(distDir, "exposed-CywellKnowledgeRoute-chunk.js"),
  resolve(root, "node_modules/react/umd/react.development.js"),
  resolve(root, "node_modules/react-dom/umd/react-dom.development.js")
];
for (const asset of requiredAssets) {
  if (!(await exists(asset))) {
    fail("console-topology-dom:assets", `required asset is missing: ${asset}`);
  }
}

let serverHandle;
let browser;
try {
  if (checks.some((check) => check.status === "FAIL")) {
    throw new Error("required assets missing");
  }
  serverHandle = await createHarnessServer();
  const launchResult = await launchBrowser();
  if (launchResult?.skipped) {
    if (requireBrowser) {
      fail("console-topology-dom:browser", "no local Chrome or Edge executable is available for required DOM smoke", launchResult.skipped);
    } else {
      skip("console-topology-dom:browser", "no local Chrome or Edge executable is available for DOM smoke");
    }
  } else {
    browser = launchResult;
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    const reportLoad = page.waitForResponse(
      (response) => response.url().includes("/api/knowledge/uploads/reports?customer_id=workflow-customer") && response.status() === 200
    );
    await page.goto(`${serverHandle.url}/cywell/customer-data?customer_id=workflow-customer`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-test="cas-knowledge-panel-customer-data"]', { timeout: 15000 });
    await Promise.all([reportLoad, page.locator('[data-test="cas-knowledge-upload-reports"]').click()]);
    await page.waitForSelector('[data-test="cas-corpus-document"]', { timeout: 15000 });
    const corpusText = await page.locator('[data-test="cas-corpus-workbench"]').innerText();
    expect(
      "console-topology-dom:corpus-reports-browser-flow",
      corpusText.includes("Workflow Router Report") &&
        corpusText.includes("workflow-doc-1") &&
        corpusText.includes("3 chunks") &&
        corpusText.includes("router latency evidence"),
      "customer data browser flow renders report cards, document IDs, and chunk previews",
      corpusText
    );
    await page.locator('[data-test="cas-corpus-document"]').filter({ hasText: "Workflow Router Report" }).click();
    const selectedScopeText = await page.locator('[data-test="cas-knowledge-scope-bar"]').innerText();
    expect(
      "console-topology-dom:corpus-selected-scope-visible",
      selectedScopeText.includes("Selected document") && selectedScopeText.includes("Workflow Router Report") && selectedScopeText.includes("workflow-doc-1"),
      "selecting a corpus document exposes selected-document scope in the browser",
      selectedScopeText
    );

    await page.goto(`${serverHandle.url}/cywell/customer-data?customer_id=url-customer`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-test="cas-knowledge-panel-customer-data"]', { timeout: 15000 });
    await page.getByLabel("URL ingest").fill("https://example.com/workflow-runbook");
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/knowledge/uploads/url-ingest") && response.status() === 200),
      page.locator('[data-test="cas-knowledge-url-ingest"]').click()
    ]);
    const urlIngestCall = calls.findLast?.(
      (call) => call.method === "POST" && call.path === "/api/knowledge/uploads/url-ingest" && call.body?.customer_id === "url-customer"
    );
    const urlCorpusText = await page.locator('[data-test="cas-corpus-workbench"]').innerText();
    const urlScopeText = await page.locator('[data-test="cas-knowledge-scope-bar"]').innerText();
    expect(
      "console-topology-dom:url-ingest-joins-corpus-browser-flow",
      urlIngestCall?.body?.url === "https://example.com/workflow-runbook" &&
        urlIngestCall?.body?.source_kind === "url" &&
        urlIngestCall?.body?.source_scope === "user_upload" &&
        urlIngestCall?.body?.visibility === "private_user" &&
        urlIngestCall?.body?.index === true &&
        urlIngestCall?.body?.auto_compile_wiki === true &&
        urlCorpusText.includes("URL Workflow Runbook") &&
        urlScopeText.includes("url-workflow-doc"),
      "URL ingest browser flow selects PBS pages/upload_results into the customer corpus",
      JSON.stringify({ body: urlIngestCall?.body, urlCorpusText, urlScopeText })
    );

    await page.goto(`${serverHandle.url}/cywell/customer-data?customer_id=upload-customer`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-test="cas-knowledge-panel-customer-data"]', { timeout: 15000 });
    await page.getByLabel("Document title").fill("Uploaded Workflow Evidence");
    await page.getByLabel("Upload content").fill("uploaded workflow content for router shard evidence");
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/knowledge/uploads/ingest") && response.status() === 200),
      page.locator('[data-test="cas-knowledge-upload"]').click()
    ]);
    const uploadCall = calls.findLast?.(
      (call) => call.method === "POST" && call.path === "/api/knowledge/uploads/ingest" && call.body?.customer_id === "upload-customer"
    );
    const uploadCorpusText = await page.locator('[data-test="cas-corpus-workbench"]').innerText();
    const uploadResultHighlights = await page.locator('[data-test="cas-knowledge-result-highlights"]').innerText();
    expect(
      "console-topology-dom:upload-index-browser-flow",
      uploadCall?.body?.file_name === "Uploaded Workflow Evidence" &&
        uploadCall?.body?.filename === "Uploaded Workflow Evidence" &&
        uploadCall?.body?.source_kind === "upload" &&
        uploadCall?.body?.source_scope === "user_upload" &&
        uploadCall?.body?.visibility === "private_user" &&
        uploadCall?.body?.index === true &&
        uploadCall?.body?.content === "uploaded workflow content for router shard evidence" &&
        uploadCorpusText.includes("uploaded-workflow-doc") &&
        uploadResultHighlights.includes("uploaded-workflow-doc") &&
        uploadResultHighlights.includes("2 chunks indexed"),
      "upload browser flow sends private upload payload, selects corpus item, and surfaces indexed result",
      JSON.stringify({ body: uploadCall?.body, uploadCorpusText, uploadResultHighlights })
    );

    await page.goto(`${serverHandle.url}/cywell/customer-data?customer_id=base64-upload-customer`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-test="cas-knowledge-panel-customer-data"]', { timeout: 15000 });
    await page.locator('[data-test="cas-knowledge-file-input"]').setInputFiles({
      name: "base64-workflow-evidence.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("base64 uploaded workflow evidence")
    });
    await page.waitForFunction(() => document.body.textContent?.includes("selected base64-workflow-evidence.md"));
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/knowledge/uploads/ingest") && response.status() === 200),
      page.locator('[data-test="cas-knowledge-upload"]').click()
    ]);
    const base64UploadCall = calls.findLast?.(
      (call) => call.method === "POST" && call.path === "/api/knowledge/uploads/ingest" && call.body?.customer_id === "base64-upload-customer"
    );
    expect(
      "console-topology-dom:file-input-base64-upload-browser-flow",
      base64UploadCall?.body?.file_name === "base64-workflow-evidence.md" &&
        base64UploadCall?.body?.filename === "base64-workflow-evidence.md" &&
        base64UploadCall?.body?.mime_type === "text/markdown" &&
        base64UploadCall?.body?.content_base64 === Buffer.from("base64 uploaded workflow evidence").toString("base64") &&
        base64UploadCall?.body?.source_kind === "upload" &&
        base64UploadCall?.body?.source_scope === "user_upload" &&
        base64UploadCall?.body?.visibility === "private_user" &&
        base64UploadCall?.body?.force_reingest === false &&
        base64UploadCall?.body?.index === true,
      "file-input browser flow sends PBS-compatible base64 private upload payload",
      JSON.stringify(base64UploadCall?.body)
    );

    await page.goto(`${serverHandle.url}/cywell/customer-data?customer_id=slow-upload`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-test="cas-knowledge-panel-customer-data"]', { timeout: 15000 });
    await page.getByLabel("Document title").fill("Slow Upload Evidence");
    const slowUploadResponse = page.waitForResponse(
      (response) => response.url().includes("/api/knowledge/uploads/ingest") && response.status() === 200
    );
    await page.locator('[data-test="cas-knowledge-upload"]').click();
    await page.getByLabel("Customer ID").fill("upload-switched");
    await slowUploadResponse;
    await page.waitForTimeout(100);
    const staleUploadScopeText = await page.locator('[data-test="cas-knowledge-scope-bar"]').innerText();
    const staleUploadCorpus =
      (await page.locator('[data-test="cas-corpus-workbench"]').count()) > 0
        ? await page.locator('[data-test="cas-corpus-workbench"]').innerText()
        : "";
    const staleUploadResultText =
      (await page.locator('[data-test="cas-knowledge-result"]').count()) > 0
        ? await page.locator('[data-test="cas-knowledge-result"]').innerText()
        : "";
    expect(
      "console-topology-dom:late-upload-response-ignored",
      staleUploadScopeText.includes("Full corpus") &&
        !staleUploadScopeText.includes("uploaded-workflow-doc") &&
        !staleUploadCorpus.includes("uploaded-workflow-doc") &&
        !staleUploadResultText.includes("uploaded-workflow-doc"),
      "late upload responses cannot restore a previous customer corpus selection",
      JSON.stringify({ staleUploadScopeText, staleUploadCorpus, staleUploadResultText })
    );

    const selectedRagReports = page.waitForResponse(
      (response) => response.url().includes("/api/knowledge/uploads/reports?customer_id=workflow-customer") && response.status() === 200
    );
    await page.goto(`${serverHandle.url}/cywell/rag?customer_id=workflow-customer&document_id=workflow-doc-1`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-test="cas-knowledge-panel-rag"]', { timeout: 15000 });
    await selectedRagReports;
    await page.waitForFunction(() => document.querySelector('[data-test="cas-knowledge-scope-bar"]')?.textContent?.includes("Workflow Router Report"));
    const ragNavHref = await page.locator('nav[aria-label="Cywell Knowledge"] a').filter({ hasText: "RAG" }).getAttribute("href");
    const wikiNavHref = await page.locator('nav[aria-label="Cywell Knowledge"] a').filter({ hasText: "LLM Wiki" }).getAttribute("href");
    const topologyNavHref = await page.locator('nav[aria-label="Cywell Knowledge"] a').filter({ hasText: "Topology" }).getAttribute("href");
    expect(
      "console-topology-dom:knowledge-nav-preserves-scope-query",
      [ragNavHref, wikiNavHref, topologyNavHref].every(
        (href) => href?.includes("customer_id=workflow-customer") && href.includes("document_id=workflow-doc-1")
      ),
      "knowledge menu links preserve the active customer/document scope across feature routes",
      JSON.stringify({ ragNavHref, wikiNavHref, topologyNavHref })
    );
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/knowledge/rag/query") && response.status() === 200),
      page.locator('[data-test="cas-knowledge-rag-query"]').click()
    ]);
    const selectedRagCall = calls.findLast?.(
      (call) => call.method === "POST" && call.path === "/api/knowledge/rag/query" && call.body?.customer_id === "workflow-customer"
    );
    expect(
      "console-topology-dom:selected-document-rag-browser-flow",
      selectedRagCall?.body?.active_document_id === "workflow-doc-1" &&
        selectedRagCall?.body?.document_source_id === "workflow-doc-1" &&
        Array.isArray(selectedRagCall?.body?.enabled_upload_document_ids) &&
        selectedRagCall.body.enabled_upload_document_ids.includes("workflow-doc-1") &&
        Array.isArray(selectedRagCall?.body?.enabled_source_scopes) &&
        selectedRagCall.body.enabled_source_scopes.length === 1 &&
        selectedRagCall.body.enabled_source_scopes[0] === "user_upload" &&
        selectedRagCall?.body?.restrict_uploaded_sources === true,
      "selected-document RAG browser flow sends document-scoped retrieval payload",
      JSON.stringify(selectedRagCall?.body)
    );
    const selectedRagAnswer = await page.locator('[data-test="cas-knowledge-result-answer"]').innerText();
    const selectedRagCitationText = await page.locator('[data-test="cas-knowledge-result-citation"]').first().innerText();
    expect(
      "console-topology-dom:rag-result-summary-visible",
      selectedRagAnswer.includes("RAG answer for") && selectedRagCitationText.includes("ACME Router Evidence"),
      "RAG result answer and citation render outside debug JSON",
      JSON.stringify({ selectedRagAnswer, selectedRagCitationText })
    );
    const invalidDocumentReports = page.waitForResponse(
      (response) => response.url().includes("/api/knowledge/uploads/reports?customer_id=workflow-customer") && response.status() === 200
    );
    await page.goto(`${serverHandle.url}/cywell/rag?customer_id=workflow-customer&document_id=missing-doc`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-test="cas-knowledge-panel-rag"]', { timeout: 15000 });
    await invalidDocumentReports;
    await page.waitForFunction(() => document.querySelector('[data-test="cas-knowledge-scope-bar"]')?.textContent?.includes("Workflow Router Report"));
    const repairedScopeText = await page.locator('[data-test="cas-knowledge-scope-bar"]').innerText();
    const repairedUrl = page.url();
    const invalidDocumentCallStart = calls.length;
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/knowledge/rag/query") && response.status() === 200),
      page.locator('[data-test="cas-knowledge-rag-query"]').click()
    ]);
    const repairedRagCall = calls
      .slice(invalidDocumentCallStart)
      .find((call) => call.method === "POST" && call.path === "/api/knowledge/rag/query" && call.body?.customer_id === "workflow-customer");
    expect(
      "console-topology-dom:invalid-document-deeplink-repairs-scope",
      repairedScopeText.includes("workflow-doc-1") &&
        !repairedScopeText.includes("missing-doc") &&
        repairedUrl.includes("document_id=workflow-doc-1") &&
        repairedRagCall?.body?.active_document_id === "workflow-doc-1" &&
        repairedRagCall?.body?.document_source_id === "workflow-doc-1" &&
        Array.isArray(repairedRagCall?.body?.enabled_upload_document_ids) &&
        repairedRagCall.body.enabled_upload_document_ids.includes("workflow-doc-1"),
      "invalid document_id deep links are repaired to a real customer corpus document before RAG runs",
      JSON.stringify({ repairedScopeText, repairedUrl, body: repairedRagCall?.body })
    );
    await page.getByLabel("RAG question").fill("slow-selected-rag");
    const slowSelectedRagResponse = page.waitForResponse(
      (response) => response.url().includes("/api/knowledge/rag/query") && response.status() === 200
    );
    await page.locator('[data-test="cas-knowledge-rag-query"]').click();
    await page.locator('[data-test="cas-knowledge-scope-all"]').click();
    await slowSelectedRagResponse;
    await page.waitForTimeout(100);
    const staleRagScopeText = await page.locator('[data-test="cas-knowledge-scope-bar"]').innerText();
    const staleRagResultText =
      (await page.locator('[data-test="cas-knowledge-result"]').count()) > 0
        ? await page.locator('[data-test="cas-knowledge-result"]').innerText()
        : "";
    expect(
      "console-topology-dom:late-rag-response-ignored-after-scope-change",
      staleRagScopeText.includes("Full corpus") && !staleRagResultText.includes("slow-selected-rag"),
      "late selected-document RAG responses cannot render after switching to full-corpus scope",
      JSON.stringify({ staleRagScopeText, staleRagResultText })
    );
    const fullCorpusUrl = page.url();
    expect(
      "console-topology-dom:full-corpus-url-unpinned",
      !fullCorpusUrl.includes("document_id=") &&
        !fullCorpusUrl.includes("documentId=") &&
        !fullCorpusUrl.includes("note_id=") &&
        !fullCorpusUrl.includes("noteId="),
      "switching to full-corpus scope removes document and note pins from the URL",
      fullCorpusUrl
    );
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector('[data-test="cas-knowledge-panel-rag"]', { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('[data-test="cas-knowledge-scope-bar"]')?.textContent?.includes("Full corpus"));
    const reloadedFullCorpusScopeText = await page.locator('[data-test="cas-knowledge-scope-bar"]').innerText();
    expect(
      "console-topology-dom:full-corpus-reload-stays-unpinned",
      reloadedFullCorpusScopeText.includes("Full corpus") && !reloadedFullCorpusScopeText.includes("workflow-doc-1"),
      "reloading a full-corpus URL does not restore stale selected-document scope",
      JSON.stringify({ url: page.url(), reloadedFullCorpusScopeText })
    );
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/knowledge/rag/query") && response.status() === 200),
      page.locator('[data-test="cas-knowledge-rag-query"]').click()
    ]);
    const allCorpusRagCall = calls.findLast?.(
      (call) => call.method === "POST" && call.path === "/api/knowledge/rag/query" && call.body?.customer_id === "workflow-customer"
    );
    expect(
      "console-topology-dom:full-corpus-rag-browser-flow",
      allCorpusRagCall?.body?.active_document_id === undefined &&
        allCorpusRagCall?.body?.restrict_uploaded_sources === false &&
        Array.isArray(allCorpusRagCall?.body?.enabled_source_scopes) &&
        allCorpusRagCall.body.enabled_source_scopes.includes("user_upload") &&
        allCorpusRagCall.body.enabled_source_scopes.includes("wiki_vault"),
      "full-corpus RAG browser flow removes document pinning but keeps private source lanes",
      JSON.stringify(allCorpusRagCall?.body)
    );
    await page.getByLabel("Customer ID").fill("workflow-switched");
    await page.waitForFunction(
      () =>
        document.querySelector('[data-test="cas-knowledge-scope-bar"]')?.textContent?.includes("Full corpus") &&
        document.querySelector('input[aria-label="Customer ID"]')?.value === "workflow-switched"
    );
    const switchedScopeText = await page.locator('[data-test="cas-knowledge-scope-bar"]').innerText();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/knowledge/rag/query") && response.status() === 200),
      page.locator('[data-test="cas-knowledge-rag-query"]').click()
    ]);
    const switchedCustomerRagCall = calls.findLast?.(
      (call) => call.method === "POST" && call.path === "/api/knowledge/rag/query" && call.body?.customer_id === "workflow-switched"
    );
    expect(
      "console-topology-dom:customer-change-clears-selected-corpus-scope",
      switchedScopeText.includes("Full corpus") &&
        !switchedScopeText.includes("workflow-doc-1") &&
        switchedCustomerRagCall?.body?.active_document_id === undefined &&
        switchedCustomerRagCall?.body?.document_source_id === undefined &&
        switchedCustomerRagCall?.body?.enabled_upload_document_ids === undefined &&
        switchedCustomerRagCall?.body?.restrict_uploaded_sources === false &&
        Array.isArray(switchedCustomerRagCall?.body?.enabled_source_scopes) &&
        switchedCustomerRagCall.body.enabled_source_scopes.includes("user_upload") &&
        switchedCustomerRagCall.body.enabled_source_scopes.includes("wiki_vault"),
      "changing customers clears stale selected-document retrieval scope before the next RAG query",
      JSON.stringify({ switchedScopeText, body: switchedCustomerRagCall?.body })
    );

    const emptyReportsLoad = page.waitForResponse(
      (response) => response.url().includes("/api/knowledge/uploads/reports?customer_id=empty-reports") && response.status() === 200
    );
    await page.goto(`${serverHandle.url}/cywell/rag?customer_id=empty-reports&document_id=ghost-doc`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-test="cas-knowledge-panel-rag"]', { timeout: 15000 });
    await emptyReportsLoad;
    await page.waitForFunction(() => document.querySelector('[data-test="cas-knowledge-scope-bar"]')?.textContent?.includes("Full corpus"));
    const emptyReportsScopeText = await page.locator('[data-test="cas-knowledge-scope-bar"]').innerText();
    const emptyReportsUrl = page.url();
    const emptyReportsCallStart = calls.length;
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/knowledge/rag/query") && response.status() === 200),
      page.locator('[data-test="cas-knowledge-rag-query"]').click()
    ]);
    const emptyReportsRagCall = calls
      .slice(emptyReportsCallStart)
      .find((call) => call.method === "POST" && call.path === "/api/knowledge/rag/query" && call.body?.customer_id === "empty-reports");
    expect(
      "console-topology-dom:invalid-document-deeplink-clears-empty-reports-scope",
      emptyReportsScopeText.includes("Full corpus") &&
        !emptyReportsScopeText.includes("ghost-doc") &&
        !emptyReportsUrl.includes("document_id=ghost-doc") &&
        !emptyReportsRagCall?.body?.active_document_id &&
        !emptyReportsRagCall?.body?.document_source_id &&
        !emptyReportsRagCall?.body?.enabled_upload_document_ids,
      "invalid document_id deep links are cleared when reports contain no repair target",
      JSON.stringify({ emptyReportsScopeText, emptyReportsUrl, body: emptyReportsRagCall?.body })
    );

    const noteReports = page.waitForResponse(
      (response) => response.url().includes("/api/knowledge/uploads/reports?customer_id=workflow-customer") && response.status() === 200
    );
    await page.goto(`${serverHandle.url}/cywell/llm-wiki?customer_id=workflow-customer&document_id=workflow-doc-1`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-test="cas-knowledge-panel-llm-wiki"]', { timeout: 15000 });
    await noteReports;
    await page.waitForFunction(() => document.querySelector('[data-test="cas-knowledge-scope-bar"]')?.textContent?.includes("workflow-doc-1"));
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/knowledge/wiki-loop/run") && response.status() === 200),
      page.locator('[data-test="cas-knowledge-wiki-loop"]').click()
    ]);
    const wikiStageText = await page.locator('[data-test="cas-knowledge-result-stage"]').first().innerText();
    expect(
      "console-topology-dom:wiki-loop-stage-summary-visible",
      wikiStageText.includes("compile") && wikiStageText.includes("done"),
      "LLM Wiki run stages render outside debug JSON",
      wikiStageText
    );
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/knowledge/wiki-vault/notes") && response.status() === 200),
      page.locator('[data-test="cas-knowledge-save-note"]').click()
    ]);
    const noteCall = calls.findLast?.(
      (call) => call.method === "POST" && call.path === "/api/knowledge/wiki-vault/notes" && call.body?.customer_id === "workflow-customer"
    );
    const noteResultText = await page.locator('[data-test="cas-knowledge-result"]').innerText();
    expect(
      "console-topology-dom:selected-document-note-browser-flow",
      noteCall?.body?.document_id === "workflow-doc-1" &&
        noteCall?.body?.target_ref === "workflow-doc-1" &&
        noteCall?.body?.note_type === "document-note" &&
        noteCall?.body?.payload?.document_id === "workflow-doc-1" &&
        noteCall?.body?.payload?.target_ref === "workflow-doc-1" &&
        noteCall?.body?.title === "운영 Wiki 노트" &&
        String(noteCall?.body?.body ?? "").includes("[[router]] latency") &&
        noteResultText.includes("workflow-note-overlay"),
      "selected-document wiki note browser flow sends document lineage and surfaces saved result",
      JSON.stringify({ body: noteCall?.body, noteResultText })
    );

    const continuityTopologyLoad = page.waitForResponse(
      (response) => response.url().includes("/api/knowledge/topology?customer_id=workflow-customer") && response.status() === 200
    );
    await page.locator('nav[aria-label="Cywell Knowledge"] a').filter({ hasText: "Topology" }).click();
    await page.waitForSelector('[data-test="cas-knowledge-panel-topology"]', { timeout: 15000 });
    await continuityTopologyLoad;
    await page.waitForFunction(() => document.body.textContent?.includes("Workflow Router Wiki"));
    const continuityUrl = page.url();
    const continuityDashboardText = await page.locator('[data-test="cas-topology-dashboard"]').innerText();
    await page.locator('[data-test="cas-topology-node"]').filter({ hasText: "Workflow Router Wiki" }).click();
    const continuityRagStart = calls.length;
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/knowledge/rag/query") && response.status() === 200),
      page.locator('[data-test="cas-topology-rag-action"]').click()
    ]);
    const continuityRagCall = calls
      .slice(continuityRagStart)
      .find((call) => call.method === "POST" && call.path === "/api/knowledge/rag/query" && call.body?.customer_id === "workflow-customer");
    expect(
      "console-topology-dom:continuous-upload-rag-wiki-topology-lineage-flow",
      continuityUrl.includes("/cywell/topology") &&
        continuityUrl.includes("customer_id=workflow-customer") &&
        continuityUrl.includes("document_id=workflow-doc-1") &&
        continuityDashboardText.includes("Workflow Router Report") &&
        continuityDashboardText.includes("Workflow Router Wiki") &&
        continuityRagCall?.body?.active_document_id === "workflow-doc-1" &&
        continuityRagCall?.body?.document_source_id === "workflow-doc-1" &&
        Array.isArray(continuityRagCall?.body?.enabled_upload_document_ids) &&
        continuityRagCall.body.enabled_upload_document_ids.includes("workflow-doc-1") &&
        continuityRagCall?.body?.restrict_uploaded_sources === true &&
        String(continuityRagCall?.body?.question ?? "").includes("Workflow Router Wiki"),
      "one browser journey preserves a selected customer document from upload reports through RAG, LLM Wiki, topology, and topology-to-RAG",
      JSON.stringify({ continuityUrl, continuityDashboardText, body: continuityRagCall?.body })
    );

    const initialTopologyLoad = page.waitForResponse(
      (response) => response.url().includes("/api/knowledge/topology?customer_id=default") && response.status() === 200
    );
    await page.goto(`${serverHandle.url}/cywell/topology`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-test="cas-knowledge-panel-topology"]', { timeout: 15000 });
    await initialTopologyLoad;
    await page.waitForFunction(() => document.querySelectorAll('[data-test="cas-topology-node"]').length === 4);
    expect("console-topology-dom:route", true, "topology route mounts in a real browser");
    expect(
      "console-topology-dom:auto-load",
      calls.some((call) => call.method === "GET" && call.path === "/api/knowledge/topology" && call.query?.customer_id === "default"),
      "topology route auto-loads the selected customer topology on entry"
    );

    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/knowledge/topology?customer_id=acme-topology") && response.status() === 200),
      page.getByLabel("Customer ID").fill("acme-topology")
    ]);
    await page.waitForFunction(() => document.querySelectorAll('[data-test="cas-topology-node"]').length === 4);

    const topologyCall = [...calls].reverse().find((call) => call.method === "GET" && call.path === "/api/knowledge/topology");
    expect(
      "console-topology-dom:customer-query",
      topologyCall?.query?.customer_id === "acme-topology",
      "topology load uses the selected customer_id",
      JSON.stringify(topologyCall)
    );
    expect(
      "console-topology-dom:nav-current",
      (await page.locator('nav[aria-label="Cywell Knowledge"] a[aria-current="page"]').innerText()) === "Topology",
      "topology nav exposes the active route with aria-current"
    );

    const kpiText = await page.locator('[data-test="cas-topology-kpis"]').innerText();
    const normalizedKpiText = kpiText.toLowerCase();
    expect(
      "console-topology-dom:kpis",
      normalizedKpiText.includes("4\nnodes") &&
        normalizedKpiText.includes("3\nedges") &&
        normalizedKpiText.includes("1\ndocs") &&
        normalizedKpiText.includes("1\nnotes"),
      "topology dashboard renders node, edge, document, and note KPIs",
      kpiText
    );
    expect(
      "console-topology-dom:nodes-edges",
      (await page.locator('[data-test="cas-topology-node"]').count()) === 4 &&
        (await page.locator('[data-test="cas-topology-edge"]').count()) === 3,
      "topology dashboard renders all graph nodes and SVG edges"
    );
    const tones = await page.locator('[data-test="cas-topology-node"]').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-tone")).sort()
    );
    expect(
      "console-topology-dom:node-tones",
      ["document", "runtime", "term", "wiki-note"].every((tone) => tones.includes(tone)),
      "topology nodes carry expected visual tones",
      JSON.stringify(tones)
    );
    const edgeCoordinatesOk = await page.locator('[data-test="cas-topology-edge"]').evaluateAll((edges) =>
      edges.every((edge) => ["x1", "x2", "y1", "y2"].every((attribute) => Number.isFinite(Number(edge.getAttribute(attribute)))))
    );
    expect("console-topology-dom:edge-coordinates", edgeCoordinatesOk, "topology SVG edges have numeric coordinates");

    await page.locator('[data-test="cas-topology-node"]').filter({ hasText: "ACME Router Wiki" }).click();
    const selectedWikiNode = page.locator('[data-test="cas-topology-node"]').filter({ hasText: "ACME Router Wiki" });
    expect(
      "console-topology-dom:selected-node-a11y",
      (await selectedWikiNode.getAttribute("aria-pressed")) === "true" &&
        (await selectedWikiNode.getAttribute("aria-label"))?.includes("ACME Router Wiki") &&
        (await selectedWikiNode.getAttribute("title")) === "ACME Router Wiki",
      "selected topology node exposes accessible pressed state and full label"
    );
    const inspectorText = await page.locator('[data-test="cas-topology-inspector"]').innerText();
    expect(
      "console-topology-dom:inspector",
      inspectorText.includes("ACME Router Wiki") &&
        inspectorText.includes("wiki-router") &&
        inspectorText.includes("rev 4") &&
        inspectorText.includes("source doc-router") &&
        inspectorText.includes("edge source doc-router") &&
        inspectorText.includes("summarizes"),
      "node inspector renders selected node lineage, edge lineage, and direct relation text",
      inspectorText
    );

    await page.getByRole("button", { name: "Docs" }).click();
    expect(
      "console-topology-dom:filter-docs",
      (await page.locator('[data-test="cas-topology-node"]').count()) === 1 &&
        (await page.getByRole("button", { name: "Docs" }).getAttribute("aria-pressed")) === "true",
      "node type filter narrows visible graph nodes"
    );
    await page.locator('[data-test="cas-topology-node-search"]').fill("ACME Router Wiki");
    const filteredIndexText = await page.locator('[data-test="cas-topology-node-index"]').innerText();
    expect(
      "console-topology-dom:filter-scoped-node-index-empty",
      (await page.locator('[data-test="cas-topology-node-index-item"]').count()) === 0 &&
        filteredIndexText.includes("No matching nodes.") &&
        (await page.locator('[data-test="cas-topology-node"]').count()) === 1,
      "node index search is explicitly scoped to the current node-type filter",
      filteredIndexText
    );
    await page.locator('[data-test="cas-topology-node-search"]').fill("");
    await page.getByRole("button", { name: "All" }).click();
    expect(
      "console-topology-dom:filter-all",
      (await page.locator('[data-test="cas-topology-node"]').count()) === 4 &&
        (await page.getByRole("button", { name: "All" }).getAttribute("aria-pressed")) === "true",
      "All filter restores the topology graph"
    );

    await page.locator('[data-test="cas-topology-node"]').filter({ hasText: "ACME Router Wiki" }).click();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/knowledge/rag/query") && response.status() === 200),
      page.locator('[data-test="cas-topology-rag-action"]').click()
    ]);
    const ragCall = calls.findLast?.((call) => call.method === "POST" && call.path === "/api/knowledge/rag/query");
    const resultText = await page.locator('[data-test="cas-knowledge-result"]').innerText();
    expect(
      "console-topology-dom:node-rag",
      ragCall?.body?.customer_id === "acme-topology" &&
        String(ragCall?.body?.question ?? "").includes("ACME Router Wiki") &&
        ragCall?.body?.active_document_id === "doc-router" &&
        Array.isArray(ragCall?.body?.enabled_upload_document_ids) &&
        ragCall.body.enabled_upload_document_ids.includes("doc-router") &&
        ragCall?.body?.restrict_uploaded_sources === true &&
        Array.isArray(ragCall?.body?.enabled_source_scopes) &&
        ragCall.body.enabled_source_scopes.includes("user_upload") &&
        resultText.includes("RAG answer for ACME Router Wiki") &&
        (await page.locator('[data-test="cas-topology-dashboard"]').count()) === 1,
      "topology inspector RAG action posts a node-derived source-scoped question while preserving the dashboard",
      JSON.stringify({ ragCall, resultText })
    );
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/knowledge/topology?customer_id=empty-topology") && response.status() === 200),
      page.getByLabel("Customer ID").fill("empty-topology")
    ]);
    await page.waitForFunction(() => document.querySelectorAll('[data-test="cas-topology-node"]').length === 0);
    const emptyTopologyText = await page.locator('[data-test="cas-topology-dashboard"]').innerText();
    expect(
      "console-topology-dom:empty-topology-no-stale-nodes",
      emptyTopologyText.includes("No topology nodes are available") &&
        !emptyTopologyText.includes("ACME Router Wiki") &&
        (await page.locator('[data-test="cas-topology-edge"]').count()) === 0 &&
        (await page.locator('[data-test="cas-topology-dashboard"] .cas-topology-empty[role="status"][aria-live="polite"]').count()) === 1,
      "empty topology clears previous graph nodes and edges",
      emptyTopologyText
    );
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/knowledge/topology?customer_id=acme-topology") && response.status() === 200),
      page.getByLabel("Customer ID").fill("acme-topology")
    ]);
    await page.waitForFunction(() => document.querySelectorAll('[data-test="cas-topology-node"]').length === 4);
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/knowledge/topology?customer_id=broken-topology") && response.status() === 500),
      page.getByLabel("Customer ID").fill("broken-topology")
    ]);
    await page.waitForFunction(() => document.querySelectorAll('[data-test="cas-topology-node"]').length === 0);
    const failedTopologyText = await page.locator('[data-test="cas-topology-dashboard"]').innerText();
    const failedResultText = await page.locator('[data-test="cas-knowledge-result"]').innerText();
    expect(
      "console-topology-dom:failed-reload-clears-stale-graph",
      failedTopologyText.includes("No topology nodes are available") &&
        !failedTopologyText.includes("ACME Router Wiki") &&
        failedResultText.includes("forced topology failure") &&
        (await page.getByRole("alert").count()) === 1,
      "failed topology reload clears stale graph and exposes the load error",
      JSON.stringify({ failedTopologyText, failedResultText })
    );
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/knowledge/topology?customer_id=orphan-topology") && response.status() === 200),
      page.getByLabel("Customer ID").fill("orphan-topology")
    ]);
    await page.waitForFunction(() => document.querySelectorAll('[data-test="cas-topology-node"]').length === 2);
    const orphanKpiText = await page.locator('[data-test="cas-topology-kpis"]').innerText();
    const orphanDashboardText = await page.locator('[data-test="cas-topology-dashboard"]').innerText();
    expect(
      "console-topology-dom:orphan-edge-fallback-node",
      orphanKpiText.toLowerCase().includes("2\nnodes") &&
        orphanKpiText.toLowerCase().includes("1\nedges") &&
        (await page.locator('[data-test="cas-topology-edge"]').count()) === 1 &&
        orphanDashboardText.includes("pbs-missing-endpoint") &&
        orphanDashboardText.includes("pbs-orphan-note -> pbs-missing-endpoint"),
      "orphan topology edges create fallback endpoint nodes and reconcile visible KPI counts",
      JSON.stringify({ orphanKpiText, orphanDashboardText })
    );
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/knowledge/topology?customer_id=mixed-scope-topology") && response.status() === 200),
      page.getByLabel("Customer ID").fill("mixed-scope-topology")
    ]);
    await page.waitForFunction(() => document.querySelectorAll('[data-test="cas-topology-node"]').length === 2);
    const mixedScopeText = await page.locator('[data-test="cas-topology-dashboard"]').innerText();
    expect(
      "console-topology-dom:mixed-scope-uses-single-graph-candidate",
      mixedScopeText.includes("Mixed Scope Wiki") &&
        mixedScopeText.includes("mixed-note -> mixed-doc") &&
        !mixedScopeText.includes("wrapper-noise-source") &&
        (await page.locator('[data-test="cas-topology-edge"]').count()) === 1,
      "topology normalization derives nodes and edges from the same nested graph candidate",
      mixedScopeText
    );
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/knowledge/topology?customer_id=pbs-rich-topology") && response.status() === 200),
      page.getByLabel("Customer ID").fill("pbs-rich-topology")
    ]);
    await page.waitForFunction(() => document.querySelectorAll('[data-test="cas-topology-node"]').length === 6);
    const richKpiText = await page.locator('[data-test="cas-topology-kpis"]').innerText();
    const richLeaderText = await page.locator('[data-test="cas-topology-signal-leaders"]').innerText();
    expect(
      "console-topology-dom:pbs-rich-kpis",
      richKpiText.toLowerCase().includes("6\nnodes") &&
        richKpiText.toLowerCase().includes("3\nedges") &&
        richKpiText.toLowerCase().includes("1\ncompiled") &&
        richKpiText.toLowerCase().includes("2\nentities") &&
        richKpiText.toLowerCase().includes("1\nwikilinks") &&
        richKpiText.toLowerCase().includes("1\ntags") &&
        richKpiText.toLowerCase().includes("3\nrelations"),
      "PBS-rich topology summary counts render as dashboard signal KPIs",
      richKpiText
    );
    const richTones = await page.locator('[data-test="cas-topology-node"]').evaluateAll((nodes) =>
      Array.from(new Set(nodes.map((node) => node.getAttribute("data-tone")).filter(Boolean))).sort()
    );
    expect(
      "console-topology-dom:pbs-rich-node-tones",
      ["concept", "document", "entity", "link", "tag", "wiki-note"].every((tone) => richTones.includes(tone)),
      "PBS-rich topology renders document, wiki, link, tag, entity, and concept tones",
      JSON.stringify(richTones)
    );
    expect(
      "console-topology-dom:pbs-rich-signal-leaders",
      richLeaderText.includes("Rich Wiki Note") && richLeaderText.includes("9 links") && richLeaderText.includes("route shard"),
      "PBS-rich topology exposes high-signal nodes in Signal leaders",
      richLeaderText
    );
    const tokenPanelText = await page.locator('[data-test="cas-topology-token-panel"]').innerText();
    const contextPanelText = await page.locator('[data-test="cas-topology-context-panel"]').innerText();
    const vaultRelationsText = await page.locator('[data-test="cas-topology-vault-relations"]').innerText();
    const richViewerText = await page.locator('[data-test="cas-knowledge-viewer"]').innerText();
    const richWikiViewerHref = await page
      .locator('[data-test="cas-knowledge-viewer-link"]')
      .filter({ hasText: "Rich Wiki Note" })
      .first()
      .getAttribute("href");
    expect(
      "console-topology-dom:pbs-rich-sidechannels",
      tokenPanelText.includes("HAProxy 4") &&
        tokenPanelText.includes("#router 2") &&
        contextPanelText.includes("Rich Upload") &&
        contextPanelText.includes("pbs-rich-upload") &&
        contextPanelText.includes("7 chunks") &&
        contextPanelText.includes("Rich Wiki Note") &&
        contextPanelText.includes("/wiki/rich") &&
        vaultRelationsText.includes("compiled_to") &&
        vaultRelationsText.includes("pbs-rich-upload -> pbs-rich-note"),
      "PBS-rich topology renders Wiki Vault tokens, selected uploads/context, and recent relation side-channel panels",
      JSON.stringify({ tokenPanelText, contextPanelText, vaultRelationsText })
    );
    expect(
      "console-topology-dom:pbs-rich-viewer-links",
      richViewerText.includes("Rich Wiki Note") &&
        richViewerText.includes("/wiki/rich") &&
        String(richWikiViewerHref ?? "").includes("/cywell/llm-wiki?customer_id=pbs-rich-topology") &&
        String(richWikiViewerHref ?? "").includes("note_id=pbs-rich-note") &&
        String(richWikiViewerHref ?? "").includes("document_id=pbs-rich-upload"),
      "PBS-rich topology exposes Wiki note viewer deep links with source document lineage",
      JSON.stringify({ richViewerText, richWikiViewerHref })
    );
    const richTopologyUrl = page.url();
    await page.locator('[data-test="cas-knowledge-viewer-link"]').filter({ hasText: "Rich Wiki Note" }).first().click();
    await page.waitForFunction(() => window.location.href.includes("/cywell/llm-wiki") && window.location.href.includes("document_id=pbs-rich-upload"));
    const richWikiScopeText = await page.locator('[data-test="cas-knowledge-scope-bar"]').innerText();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/knowledge/wiki-loop/run") && response.status() === 200),
      page.locator('[data-test="cas-knowledge-wiki-loop"]').click()
    ]);
    const richWikiRunCalls = calls.filter(
      (call) => call.method === "POST" && call.path === "/api/knowledge/wiki-loop/run" && call.body?.customer_id === "pbs-rich-topology"
    );
    const richWikiRunCall = richWikiRunCalls.at(-1);
    expect(
      "console-topology-dom:wiki-note-deeplink-uses-document-scope",
      richWikiScopeText.includes("pbs-rich-upload") && richWikiRunCall?.body?.document_id === "pbs-rich-upload",
      "wiki-note deep links with document_id activate selected-document scope for LLM Wiki requests",
      JSON.stringify({ richWikiScopeText, url: page.url(), calls: richWikiRunCalls.map((call) => call.body) })
    );
    await page.goBack();
    await page.waitForFunction(
      (expectedUrl) =>
        window.location.href === expectedUrl &&
        document.querySelector('nav[aria-label="Cywell Knowledge"] a[aria-current="page"]')?.textContent === "Topology",
      richTopologyUrl
    );
    expect(
      "console-topology-dom:popstate-restores-route-state",
      (await page.locator('nav[aria-label="Cywell Knowledge"] a[aria-current="page"]').innerText()) === "Topology" &&
        page.url() === richTopologyUrl,
      "browser back reconciles URL state after an in-app viewer deep link",
      JSON.stringify({ url: page.url(), richTopologyUrl })
    );
    await page.waitForFunction(() => document.querySelectorAll('[data-test="cas-topology-node"]').length === 6);
    await page.getByRole("button", { name: "Links", exact: true }).click();
    expect(
      "console-topology-dom:pbs-rich-link-filter",
      (await page.locator('[data-test="cas-topology-node"]').count()) === 1 &&
        (await page.locator('[data-test="cas-topology-dashboard"]').innerText()).includes("HAProxy"),
      "PBS wikilink nodes can be filtered independently from generic terms"
    );
    await page.locator('[data-test="cas-topology-node"]').filter({ hasText: "HAProxy" }).click();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/knowledge/rag/query") && response.status() === 200),
      page.locator('[data-test="cas-topology-rag-action"]').click()
    ]);
    const richSignalRagCall = calls.findLast?.(
      (call) => call.method === "POST" && call.path === "/api/knowledge/rag/query" && call.body?.customer_id === "pbs-rich-topology"
    );
    expect(
      "console-topology-dom:pbs-rich-signal-rag-scope",
      richSignalRagCall?.body?.active_document_id === "pbs-rich-upload" &&
        Array.isArray(richSignalRagCall?.body?.enabled_upload_document_ids) &&
        richSignalRagCall.body.enabled_upload_document_ids.includes("pbs-rich-upload") &&
        richSignalRagCall?.body?.restrict_uploaded_sources === true,
      "PBS-rich signal nodes derive RAG document scope from selected Wiki context/upload lineage",
      JSON.stringify(richSignalRagCall?.body)
    );
    await page.getByRole("button", { name: "All" }).click();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/knowledge/topology?customer_id=vault-empty-topology") && response.status() === 200),
      page.getByLabel("Customer ID").fill("vault-empty-topology")
    ]);
    await page.waitForFunction(() => document.querySelectorAll('[data-test="cas-topology-node"]').length === 4);
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/knowledge/wiki-vault?customer_id=vault-empty-topology") && response.status() === 200),
      page.getByRole("button", { name: "Load Vault" }).click()
    ]);
    await page.waitForFunction(() => document.querySelectorAll('[data-test="cas-topology-node"]').length === 0);
    const emptyVaultText = await page.locator('[data-test="cas-topology-dashboard"]').innerText();
    expect(
      "console-topology-dom:empty-vault-clears-stale-topology",
      emptyVaultText.includes("No topology nodes are available") && !emptyVaultText.includes("ACME Router Wiki"),
      "empty wiki vault topology clears previously loaded graph data",
      emptyVaultText
    );
    const slowResponse = page.waitForResponse(
      (response) => response.url().includes("/api/knowledge/topology?customer_id=slow-topology") && response.status() === 200
    );
    await page.getByLabel("Customer ID").fill("slow-topology");
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/knowledge/topology?customer_id=acme-topology") && response.status() === 200),
      page.getByLabel("Customer ID").fill("acme-topology")
    ]);
    await page.waitForFunction(() => document.querySelectorAll('[data-test="cas-topology-node"]').length === 4);
    await slowResponse;
    await page.waitForTimeout(50);
    const raceTopologyText = await page.locator('[data-test="cas-topology-dashboard"]').innerText();
    expect(
      "console-topology-dom:late-topology-response-ignored",
      raceTopologyText.includes("ACME Router Wiki") && !raceTopologyText.includes("Slow Customer Wiki"),
      "late topology responses cannot overwrite the newest customer graph",
      raceTopologyText
    );
    await assertViewportLayout(page, { width: 1024, height: 768 }, "dense-topology");
    expect(
      "console-topology-dom:dense-visible-cap",
      (await page.locator('[data-test="cas-topology-node"]').count()) === 7 &&
        (await page.locator('[data-test="cas-topology-visible-count"]').innerText()) === "Showing 7 of 28 nodes",
      "dense topology caps canvas nodes and reports total visible count"
    );
    await page.locator('[data-test="cas-topology-node-search"]').fill("Dense Customer Topology Node 27");
    await page.locator('[data-test="cas-topology-node-index-item"]').filter({ hasText: "Dense Customer Topology Node 27" }).click();
    const denseInspectorText = await page.locator('[data-test="cas-topology-inspector"]').innerText();
    expect(
      "console-topology-dom:dense-node-index",
      denseInspectorText.includes("Dense Customer Topology Node 27") && denseInspectorText.includes("dense-node-27"),
      "dense topology exposes hidden canvas nodes through searchable node index",
      denseInspectorText
    );
    await assertViewportLayout(page, { width: 390, height: 844 }, "dense-topology");

    const unexpectedConsoleErrors = consoleErrors.filter(
      (message) => !message.includes("Failed to load resource: the server responded with a status of 500")
    );
    expect(
      "console-topology-dom:browser-errors",
      unexpectedConsoleErrors.length === 0 && pageErrors.length === 0,
      "browser reports no console errors or uncaught page errors",
      JSON.stringify({ consoleErrors, unexpectedConsoleErrors, pageErrors })
    );
  }
} catch (error) {
  fail("console-topology-dom:smoke", error instanceof Error ? error.message : "unknown topology DOM smoke failure");
} finally {
  if (browser?.close) await browser.close();
  if (serverHandle?.server) {
    await new Promise((resolveClose) => serverHandle.server.close(resolveClose));
  }
}

const failures = checks.filter((check) => check.status === "FAIL");
if (failures.length > 0) {
  console.error(`Console topology DOM verification failed with ${failures.length} failures.`);
  process.exitCode = 1;
} else if (requireBrowser && checks.some((check) => check.status === "SKIP")) {
  console.error("Console topology DOM verification failed because required browser mode produced a skip.");
  process.exitCode = 1;
} else if (checks.every((check) => check.status === "SKIP")) {
  console.log("Console topology DOM verification skipped.");
} else {
  console.log(`Console topology DOM verification passed with ${checks.length} checks.`);
}
