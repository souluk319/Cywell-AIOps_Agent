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
const knowledgeRouteSource = await readFile("apps/console-plugin/src/plugin/CywellKnowledgeRoute.tsx", "utf8");
const staticAppSource = await readFile("apps/console-plugin/src/static/app.js", "utf8");
const manifest = await readFile("apps/console-plugin/dist/plugin-manifest.json", "utf8");
const manifestJson = JSON.parse(manifest);
const launcherBundle = await readFile("apps/console-plugin/dist/exposed-useCASLauncher-chunk.js", "utf8");
const knowledgeRouteBundle = await readFile("apps/console-plugin/dist/exposed-CywellKnowledgeRoute-chunk.js", "utf8");

rejectText(
  "console-static:no-inner-html",
  staticAppSource,
  "innerHTML",
  "standalone static app renders analysis content with text nodes instead of HTML injection"
);
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
  "console-nav:section",
  manifest,
  "console.navigation/section",
  "built plugin registers the Cywell navigation section"
);
expectText(
  "console-nav:href",
  manifest,
  "console.navigation/href",
  "built plugin registers Cywell navigation links"
);
expectText(
  "console-nav:customer-data",
  manifest,
  "/cywell/customer-data",
  "built plugin registers the customer data route"
);
expectText(
  "console-nav:rag",
  manifest,
  "/cywell/rag",
  "built plugin registers the RAG route"
);
expectText(
  "console-nav:llm-wiki",
  manifest,
  "/cywell/llm-wiki",
  "built plugin registers the LLM Wiki route"
);
expectText(
  "console-nav:topology",
  manifest,
  "/cywell/topology",
  "built plugin registers the topology route"
);
const topologyNavExtension = (manifestJson.extensions ?? []).find((extension) => {
  const startsWith = extension?.properties?.startsWith;
  return (
    extension?.type === "console.navigation/href" &&
    extension?.properties?.id === "cywell-topology" &&
    extension?.properties?.section === "cywell" &&
    extension?.properties?.name === "Topology" &&
    extension?.properties?.href === "/cywell/topology" &&
    Array.isArray(startsWith) &&
    startsWith.includes("/cywell/topology")
  );
});
expectText(
  "console-nav:topology-structural",
  topologyNavExtension ? JSON.stringify(topologyNavExtension) : "",
  "/cywell/topology",
  "built manifest structurally registers the Topology navigation item"
);
expectText(
  "console-route:registered",
  manifest,
  "console.page/route",
  "built plugin registers route pages"
);
expectText(
  "console-route:knowledge-module",
  manifest,
  "CywellKnowledgeRoute",
  "built plugin exposes the Cywell knowledge route module"
);
const cywellKnowledgeRouteExtension = (manifestJson.extensions ?? []).find((extension) => {
  const path = extension?.properties?.path;
  const paths = Array.isArray(path) ? path : [path];
  return (
    extension?.type === "console.page/route" &&
    paths.includes("/cywell/topology") &&
    extension?.properties?.component?.$codeRef === "CywellKnowledgeRoute"
  );
});
expectText(
  "console-route:topology-structural",
  cywellKnowledgeRouteExtension ? JSON.stringify(cywellKnowledgeRouteExtension) : "",
  "/cywell/topology",
  "built manifest structurally maps /cywell/topology to CywellKnowledgeRoute"
);
expectText(
  "console-route:sentinel-module",
  manifest,
  "AISentinelRoute",
  "built plugin exposes the AI Sentinel route module"
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
  "console-chat:bundle-fallback",
  launcherBundle,
  "cas-fallback-notice",
  "built launcher bundle contains fallback notice surface"
);
expectText(
  "console-knowledge:healthz",
  knowledgeRouteSource,
  "/api/knowledge/healthz",
  "knowledge route checks the Gateway knowledge facade"
);
expectText(
  "console-knowledge:route-surface",
  knowledgeRouteSource,
  "data-test=\"cas-knowledge-route\"",
  "knowledge route renders a testable route surface"
);
expectText(
  "console-knowledge:engine-status",
  knowledgeRouteSource,
  "data-test=\"cas-knowledge-engine-status\"",
  "knowledge route renders engine status"
);
expectText(
  "console-knowledge:upload-action",
  knowledgeRouteSource,
  "data-test=\"cas-knowledge-upload\"",
  "knowledge route renders upload action"
);
expectText(
  "console-knowledge:file-input",
  knowledgeRouteSource,
  "data-test=\"cas-knowledge-file-input\"",
  "knowledge route renders local file input"
);
expectText(
  "console-knowledge:file-base64",
  knowledgeRouteSource,
  "content_base64",
  "knowledge route sends selected files as base64 payloads"
);
expectText(
  "console-knowledge:pbs-file-name",
  knowledgeRouteSource,
  "file_name",
  "knowledge route sends PBS file_name upload contract"
);
expectText(
  "console-knowledge:pbs-source-scope",
  knowledgeRouteSource,
  "source_scope",
  "knowledge route sends PBS source scope contract"
);
expectText(
  "console-knowledge:pbs-reingest",
  knowledgeRouteSource,
  "force_reingest",
  "knowledge route sends PBS reingest contract"
);
expectText(
  "console-knowledge:pbs-url-wiki",
  knowledgeRouteSource,
  "auto_compile_wiki",
  "knowledge route sends PBS URL wiki compile contract"
);
expectText(
  "console-knowledge:upload-reports-action",
  knowledgeRouteSource,
  "data-test=\"cas-knowledge-upload-reports\"",
  "knowledge route renders upload reports action"
);
expectText(
  "console-knowledge:corpus-workbench",
  knowledgeRouteSource,
  "data-test=\"cas-corpus-workbench\"",
  "knowledge route renders customer corpus workbench"
);
expectText(
  "console-knowledge:corpus-document",
  knowledgeRouteSource,
  "data-test=\"cas-corpus-document\"",
  "knowledge route renders selectable corpus document cards"
);
expectText(
  "console-knowledge:viewer-panel",
  knowledgeRouteSource,
  "data-test=\"cas-knowledge-viewer\"",
  "knowledge route renders document/wiki viewer panel"
);
expectText(
  "console-knowledge:viewer-links",
  knowledgeRouteSource,
  "data-test=\"cas-knowledge-viewer-link\"",
  "knowledge route renders PBS viewer deep links"
);
expectText(
  "console-knowledge:viewer-query-params",
  knowledgeRouteSource,
  "document_id",
  "knowledge route supports document deep-link query params"
);
expectText(
  "console-knowledge:scope-bar",
  knowledgeRouteSource,
  "data-test=\"cas-knowledge-scope-bar\"",
  "knowledge route renders explicit corpus scope bar"
);
expectText(
  "console-knowledge:scope-all-selected",
  knowledgeRouteSource,
  "cas-knowledge-scope-all",
  "knowledge route exposes all-corpus and selected-document scope controls"
);
expectText(
  "console-knowledge:url-ingest-selects-corpus",
  knowledgeRouteSource,
  "selectCorpusDocument(targets[0])",
  "URL ingest joins the selected customer corpus workflow"
);
expectText(
  "console-knowledge:rag-action",
  knowledgeRouteSource,
  "data-test=\"cas-knowledge-rag-query\"",
  "knowledge route renders RAG query action"
);
expectText(
  "console-knowledge:wiki-action",
  knowledgeRouteSource,
  "data-test=\"cas-knowledge-wiki-loop\"",
  "knowledge route renders wiki loop action"
);
expectText(
  "console-knowledge:save-note-action",
  knowledgeRouteSource,
  "data-test=\"cas-knowledge-save-note\"",
  "knowledge route renders manual wiki note save action"
);
expectText(
  "console-knowledge:topology-action",
  knowledgeRouteSource,
  "data-test=\"cas-knowledge-topology\"",
  "knowledge route renders topology action"
);
expectText(
  "console-knowledge:topology-dashboard",
  knowledgeRouteSource,
  "data-test=\"cas-topology-dashboard\"",
  "knowledge route renders topology dashboard"
);
expectText(
  "console-knowledge:topology-canvas",
  knowledgeRouteSource,
  "data-test=\"cas-topology-canvas\"",
  "knowledge route renders topology graph canvas"
);
expectText(
  "console-knowledge:topology-auto-load",
  knowledgeRouteSource,
  "autoTopologyLoadKey",
  "knowledge route auto-loads topology on route/customer entry"
);
expectText(
  "console-knowledge:topology-node-index",
  knowledgeRouteSource,
  "data-test=\"cas-topology-node-index\"",
  "knowledge route renders searchable topology node index"
);
expectText(
  "console-knowledge:topology-kpis",
  knowledgeRouteSource,
  "data-test=\"cas-topology-kpis\"",
  "knowledge route renders topology KPI strip"
);
expectText(
  "console-knowledge:topology-inspector",
  knowledgeRouteSource,
  "data-test=\"cas-topology-inspector\"",
  "knowledge route renders topology node inspector"
);
expectText(
  "console-knowledge:topology-relation-grid",
  knowledgeRouteSource,
  "data-test=\"cas-topology-relation-grid\"",
  "knowledge route renders topology relation grid"
);
expectText(
  "console-knowledge:topology-rag-action",
  knowledgeRouteSource,
  "data-test=\"cas-topology-rag-action\"",
  "knowledge route renders topology-to-RAG inspector action"
);
expectText(
  "console-knowledge:topology-rag-scoped-source",
  knowledgeRouteSource,
  "enabled_upload_document_ids",
  "knowledge route sends selected topology document scope into RAG requests"
);
expectText(
  "console-knowledge:topology-rag-restrict-uploaded",
  knowledgeRouteSource,
  "restrict_uploaded_sources",
  "knowledge route can restrict topology RAG actions to selected uploaded sources"
);
expectText(
  "console-knowledge:rag-selected-corpus",
  knowledgeRouteSource,
  "selectedCorpusTarget",
  "knowledge route sends selected corpus document scope into RAG requests"
);
expectText(
  "console-knowledge:wiki-selected-document",
  knowledgeRouteSource,
  "document_id: activeDocumentId",
  "knowledge route sends selected corpus document into wiki loop requests"
);
expectText(
  "console-knowledge:note-selected-document",
  knowledgeRouteSource,
  "target_ref: activeDocumentId",
  "knowledge route links saved wiki notes to the selected document"
);
expectText(
  "console-knowledge:note-selected-document-dependency",
  knowledgeRouteSource,
  "[activeDocumentId, customerId, noteBody, noteTitle, runAction]",
  "knowledge route note save callback refreshes when selected document changes"
);
expectText(
  "console-knowledge:url-ingest-pbs-pages",
  knowledgeRouteSource,
  "addRecordList(value.pages, \"document\")",
  "knowledge route collects PBS URL ingest pages into the customer corpus workflow"
);
expectText(
  "console-knowledge:url-ingest-pbs-upload-results",
  knowledgeRouteSource,
  "addRecordList(value.upload_results, \"document\")",
  "knowledge route collects PBS URL ingest upload_results into the customer corpus workflow"
);
expectText(
  "console-knowledge:topology-edge-derived-scope",
  knowledgeRouteSource,
  "connectedDocumentIds",
  "knowledge route derives topology signal-node RAG scope from connected edge lineage"
);
expectText(
  "console-knowledge:topology-selected-context-scope",
  knowledgeRouteSource,
  "contextById",
  "knowledge route derives topology signal-node RAG scope from selected Wiki context lineage"
);
expectText(
  "console-knowledge:topology-nested-graph",
  knowledgeRouteSource,
  "topologyGraph",
  "knowledge route normalizes nested PBS topology.graph payloads"
);
expectText(
  "console-knowledge:topology-links-relations",
  knowledgeRouteSource,
  "\"links\", \"relations\", \"relationships\"",
  "knowledge route normalizes PBS links/relations edge payloads"
);
expectText(
  "console-knowledge:topology-node-id",
  knowledgeRouteSource,
  "node_id",
  "knowledge route normalizes PBS node_id payloads"
);
expectText(
  "console-knowledge:topology-lineage-fields",
  knowledgeRouteSource,
  "source_document_id",
  "knowledge route preserves topology lineage source_document_id fields"
);
expectText(
  "console-knowledge:topology-pbs-signal-fields",
  knowledgeRouteSource,
  "source_kind",
  "knowledge route preserves PBS topology source_kind, viewer, and entity signal fields"
);
expectText(
  "console-knowledge:topology-pbs-summary-counts",
  knowledgeRouteSource,
  "document_node_count",
  "knowledge route normalizes PBS topology summary count aliases"
);
expectText(
  "console-knowledge:topology-signal-leaders",
  knowledgeRouteSource,
  "data-test=\"cas-topology-signal-leaders\"",
  "knowledge route renders topology signal leaders"
);
expectText(
  "console-knowledge:topology-vault-token-panel",
  knowledgeRouteSource,
  "data-test=\"cas-topology-token-panel\"",
  "knowledge route renders PBS Wiki Vault token side-channel panel"
);
expectText(
  "console-knowledge:topology-vault-context-panel",
  knowledgeRouteSource,
  "data-test=\"cas-topology-context-panel\"",
  "knowledge route renders PBS Wiki Vault selected upload/context side-channel panel"
);
expectText(
  "console-knowledge:topology-vault-relations-panel",
  knowledgeRouteSource,
  "data-test=\"cas-topology-vault-relations\"",
  "knowledge route renders PBS Wiki Vault relation side-channel panel"
);
expectText(
  "console-knowledge:topology-edge-id",
  knowledgeRouteSource,
  "source_id",
  "knowledge route normalizes PBS source_id/target_id payloads"
);
expectText(
  "console-knowledge:result-surface",
  knowledgeRouteSource,
  "data-test=\"cas-knowledge-result\"",
  "knowledge route renders API result surface"
);
expectText(
  "console-knowledge:result-summary",
  knowledgeRouteSource,
  "data-test=\"cas-knowledge-result-summary\"",
  "knowledge route renders product result summary before debug JSON"
);
expectText(
  "console-knowledge:result-citations",
  knowledgeRouteSource,
  "data-test=\"cas-knowledge-result-citations\"",
  "knowledge route renders first-class citation result panels"
);
expectText(
  "console-knowledge:bundle-healthz",
  knowledgeRouteBundle,
  "/api/knowledge/healthz",
  "built knowledge route bundle contains knowledge facade integration"
);
expectText(
  "console-knowledge:bundle-upload",
  knowledgeRouteBundle,
  "/api/knowledge/uploads/ingest",
  "built knowledge route bundle contains upload integration"
);
expectText(
  "console-knowledge:bundle-base64-upload",
  knowledgeRouteBundle,
  "content_base64",
  "built knowledge route bundle contains base64 upload integration"
);
expectText(
  "console-knowledge:bundle-pbs-file-name",
  knowledgeRouteBundle,
  "file_name",
  "built knowledge route bundle contains PBS file_name contract"
);
expectText(
  "console-knowledge:bundle-upload-reports",
  knowledgeRouteBundle,
  "/api/knowledge/uploads/reports",
  "built knowledge route bundle contains upload reports integration"
);
expectText(
  "console-knowledge:bundle-corpus-workbench",
  knowledgeRouteBundle,
  "cas-corpus-workbench",
  "built knowledge route bundle contains customer corpus workbench"
);
expectText(
  "console-knowledge:bundle-viewer-panel",
  knowledgeRouteBundle,
  "cas-knowledge-viewer",
  "built knowledge route bundle contains viewer panel"
);
expectText(
  "console-knowledge:bundle-viewer-link",
  knowledgeRouteBundle,
  "cas-knowledge-viewer-link",
  "built knowledge route bundle contains viewer deep links"
);
expectText(
  "console-knowledge:bundle-scope-bar",
  knowledgeRouteBundle,
  "cas-knowledge-scope-bar",
  "built knowledge route bundle contains explicit corpus scope controls"
);
expectText(
  "console-knowledge:bundle-result-summary",
  knowledgeRouteBundle,
  "cas-knowledge-result-summary",
  "built knowledge route bundle contains product result summary panels"
);
expectText(
  "console-knowledge:bundle-rag",
  knowledgeRouteBundle,
  "/api/knowledge/rag/query",
  "built knowledge route bundle contains RAG integration"
);
expectText(
  "console-knowledge:bundle-note",
  knowledgeRouteBundle,
  "/api/knowledge/wiki-vault/notes",
  "built knowledge route bundle contains wiki note integration"
);
expectText(
  "console-knowledge:bundle-capabilities",
  knowledgeRouteBundle,
  "cas-knowledge-capabilities",
  "built knowledge route bundle contains capabilities panel"
);
expectText(
  "console-knowledge:bundle-topology-dashboard",
  knowledgeRouteBundle,
  "cas-topology-dashboard",
  "built knowledge route bundle contains topology dashboard"
);
expectText(
  "console-knowledge:bundle-topology-node",
  knowledgeRouteBundle,
  "cas-topology-node",
  "built knowledge route bundle contains topology nodes"
);
expectText(
  "console-knowledge:bundle-topology-node-index",
  knowledgeRouteBundle,
  "cas-topology-node-index",
  "built knowledge route bundle contains topology node index"
);
expectText(
  "console-knowledge:bundle-topology-kpis",
  knowledgeRouteBundle,
  "cas-topology-kpis",
  "built knowledge route bundle contains topology KPI strip"
);
expectText(
  "console-knowledge:bundle-topology-relation-grid",
  knowledgeRouteBundle,
  "cas-topology-relation-grid",
  "built knowledge route bundle contains topology relation grid"
);
expectText(
  "console-knowledge:bundle-topology-rag-action",
  knowledgeRouteBundle,
  "Ask RAG about this node",
  "built knowledge route bundle contains topology-to-RAG action"
);
expectText(
  "console-knowledge:bundle-topology-lineage-fields",
  knowledgeRouteBundle,
  "source_document_id",
  "built knowledge route bundle preserves topology lineage fields"
);
expectText(
  "console-knowledge:bundle-topology-sidechannels",
  knowledgeRouteBundle,
  "cas-topology-token-panel",
  "built knowledge route bundle contains PBS Wiki Vault side-channel panels"
);

const failures = checks.filter((check) => check.status === "FAIL");
if (failures.length > 0) {
  console.error(`Console integration verification failed with ${failures.length} failures.`);
  process.exitCode = 1;
} else {
  console.log(`Console integration verification passed with ${checks.length} checks.`);
}
