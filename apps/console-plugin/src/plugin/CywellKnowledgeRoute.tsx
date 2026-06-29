import * as React from "react";

const API_BASE = "/api/proxy/plugin/cywell-ai-sentinel/cas-api";
const TOPOLOGY_CANVAS_NODE_LIMIT = 7;

type KnowledgeCapability = {
  id: string;
  label: string;
  phase?: string;
  endpoint: string;
  source: string;
  state: string;
};

type KnowledgeHealth = {
  status?: "ok" | "degraded";
  service?: string;
  product?: string;
  engine?: {
    provider?: string;
    status?: string;
    endpoint?: string | null;
  };
  capabilities?: KnowledgeCapability[];
};

type ActionResult = Record<string, unknown>;

type TopologyNode = {
  id: string;
  type: string;
  label: string;
  summary?: string;
  status?: string;
  degree?: number;
  weight?: number;
  viewer_path?: string;
  note_type?: string;
  compiled_wiki?: boolean;
  entity_kind?: string;
  source_kind?: string;
  source_url?: string;
  source_scope?: string;
  ready_for_chat?: boolean;
  basic_index_ready?: boolean;
  revision?: number;
  previous_revision?: number;
  document_id?: string;
  document_source_id?: string;
  source_document_id?: string;
  updated_at?: string | number;
  metadata?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
};

type TopologyEdge = {
  id?: string;
  source: string;
  target: string;
  type: string;
  source_document_id?: string;
  document_id?: string;
  revision?: number;
  previous_revision?: number;
  updated_at?: string | number;
  metadata?: ActionResult;
  provenance?: ActionResult;
};

type TopologyPayload = {
  status?: string;
  customer_id?: string;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  counts?: {
    documents?: number;
    notes?: number;
    nodes?: number;
    edges?: number;
    relations?: number;
    uploads?: number;
    compiled?: number;
    wikilinks?: number;
    tags?: number;
    entities?: number;
    concepts?: number;
  };
  top_wikilinks?: TopologyToken[];
  top_tags?: TopologyToken[];
  selected_context?: TopologyContextItem[];
  selected_uploads?: TopologyUploadItem[];
  relations?: TopologyRelationSignal[];
};

type TopologyToken = {
  label: string;
  count?: number;
};

type TopologyContextItem = {
  id?: string;
  title: string;
  body?: string;
  document_source_id?: string;
  viewer_path?: string;
  source_scope?: string;
};

type TopologyUploadItem = {
  id?: string;
  document_source_id?: string;
  title: string;
  filename?: string;
  viewer_path?: string;
  source_scope?: string;
  ready_for_chat?: boolean;
  chunk_count?: number;
};

type TopologyRelationSignal = {
  source: string;
  target: string;
  type: string;
  label?: string;
};

type RouteItem = {
  key: string;
  label: string;
  href: string;
  endpoint: string;
  phase: string;
};

type ViewerKind = "document" | "wiki-note" | "citation" | "source";

type ViewerTarget = {
  kind: ViewerKind;
  id: string;
  title: string;
  summary?: string;
  body?: string;
  viewer_path?: string;
  source_url?: string;
  source_scope?: string;
  document_source_id?: string;
  chunk_count?: number;
  ready_for_chat?: boolean;
  chunk_previews?: ActionResult[];
  metadata?: ActionResult;
};

const routeItems: RouteItem[] = [
  {
    key: "customer-data",
    label: "고객 데이터",
    href: "/cywell/customer-data",
    endpoint: "/api/knowledge/uploads/ingest",
    phase: "Phase 3"
  },
  {
    key: "rag",
    label: "RAG",
    href: "/cywell/rag",
    endpoint: "/api/knowledge/rag/query",
    phase: "Phase 4"
  },
  {
    key: "llm-wiki",
    label: "LLM Wiki",
    href: "/cywell/llm-wiki",
    endpoint: "/api/knowledge/wiki-loop/run",
    phase: "Phase 5"
  },
  {
    key: "topology",
    label: "Topology",
    href: "/cywell/topology",
    endpoint: "/api/knowledge/topology",
    phase: "Phase 5"
  }
];

const fallbackCapabilities: KnowledgeCapability[] = [
  {
    id: "facade",
    label: "Knowledge facade",
    phase: "phase-1",
    endpoint: "/api/knowledge/healthz",
    source: "CAS Gateway",
    state: "ready"
  }
];

function emptyTopology(customerId: string): TopologyPayload {
  return {
    status: "empty",
    customer_id: customerId,
    counts: { nodes: 0, edges: 0, documents: 0, notes: 0, uploads: 0, compiled: 0, wikilinks: 0, tags: 0, entities: 0 },
    nodes: [],
    edges: []
  };
}

const styles = `
.cas-knowledge-route {
  --cas-knowledge-ink: #18202a;
  --cas-knowledge-muted: #5b6674;
  --cas-knowledge-line: #d8dee8;
  --cas-knowledge-soft: #f5f7fa;
  --cas-knowledge-surface: #ffffff;
  --cas-knowledge-accent: #087f8c;
  --cas-knowledge-warning: #a66200;
  color: var(--cas-knowledge-ink);
  display: grid;
  gap: 18px;
  padding: 24px;
}

.cas-knowledge-header {
  display: grid;
  gap: 8px;
}

.cas-knowledge-header h1 {
  font-size: 24px;
  line-height: 1.2;
  margin: 0;
}

.cas-knowledge-header p,
.cas-knowledge-muted {
  color: var(--cas-knowledge-muted);
  margin: 0;
}

.cas-knowledge-status {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.cas-knowledge-badge {
  align-items: center;
  background: var(--cas-knowledge-soft);
  border: 1px solid var(--cas-knowledge-line);
  border-radius: 999px;
  color: var(--cas-knowledge-muted);
  display: inline-flex;
  font-size: 12px;
  gap: 6px;
  line-height: 1;
  padding: 7px 9px;
}

.cas-knowledge-badge[data-state="ok"],
.cas-knowledge-badge[data-state="ready"] {
  color: var(--cas-knowledge-accent);
}

.cas-knowledge-badge[data-state="degraded"],
.cas-knowledge-badge[data-state="not_configured"] {
  color: var(--cas-knowledge-warning);
}

.cas-knowledge-layout {
  display: grid;
  gap: 16px;
  grid-template-columns: minmax(180px, 220px) minmax(0, 1fr);
}

.cas-knowledge-nav {
  align-content: start;
  border-right: 1px solid var(--cas-knowledge-line);
  display: grid;
  gap: 6px;
  padding-right: 14px;
}

.cas-knowledge-nav a {
  border-radius: 6px;
  color: var(--cas-knowledge-ink);
  padding: 9px 10px;
  text-decoration: none;
}

.cas-knowledge-nav a[data-active="true"] {
  background: #e9f7f8;
  color: var(--cas-knowledge-accent);
  font-weight: 700;
}

.cas-knowledge-main {
  display: grid;
  gap: 16px;
  min-width: 0;
}

.cas-knowledge-panel,
.cas-knowledge-card {
  background: var(--cas-knowledge-surface);
  border: 1px solid var(--cas-knowledge-line);
  border-radius: 8px;
}

.cas-knowledge-panel {
  display: grid;
  gap: 14px;
  min-width: 0;
  padding: 18px;
}

.cas-knowledge-panel h2,
.cas-knowledge-card h3 {
  font-size: 18px;
  line-height: 1.3;
  margin: 0;
}

.cas-knowledge-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.cas-knowledge-card {
  display: grid;
  gap: 8px;
  padding: 14px;
}

.cas-knowledge-endpoint {
  background: var(--cas-knowledge-soft);
  border: 1px solid var(--cas-knowledge-line);
  border-radius: 4px;
  color: var(--cas-knowledge-muted);
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
  padding: 7px 8px;
}

.cas-knowledge-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.cas-knowledge-button {
  background: var(--cas-knowledge-accent);
  border: 1px solid var(--cas-knowledge-accent);
  border-radius: 4px;
  color: #fff;
  cursor: pointer;
  font: inherit;
  font-weight: 700;
  padding: 8px 10px;
}

.cas-knowledge-button[data-secondary="true"] {
  background: #fff;
  border-color: var(--cas-knowledge-line);
  color: var(--cas-knowledge-muted);
}

.cas-knowledge-button:disabled {
  cursor: progress;
  opacity: 0.65;
}

.cas-knowledge-form {
  display: grid;
  gap: 10px;
}

.cas-knowledge-fields {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.cas-knowledge-form label {
  color: var(--cas-knowledge-muted);
  display: grid;
  font-size: 12px;
  font-weight: 700;
  gap: 5px;
}

.cas-knowledge-form input,
.cas-knowledge-form textarea {
  border: 1px solid var(--cas-knowledge-line);
  border-radius: 4px;
  color: var(--cas-knowledge-ink);
  font: inherit;
  padding: 8px 9px;
  width: 100%;
}

.cas-knowledge-form textarea {
  min-height: 118px;
  resize: vertical;
}

.cas-knowledge-result {
  background: #111827;
  border-radius: 6px;
  color: #f9fafb;
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  max-height: 320px;
  overflow: auto;
  padding: 12px;
  white-space: pre-wrap;
}

.cas-knowledge-viewer {
  border: 1px solid var(--cas-knowledge-line);
  border-radius: 8px;
  display: grid;
  gap: 10px;
  min-width: 0;
  padding: 12px;
}

.cas-knowledge-viewer h3 {
  font-size: 16px;
  line-height: 1.3;
  margin: 0;
}

.cas-knowledge-viewer-list {
  display: grid;
  gap: 6px;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
}

.cas-knowledge-viewer-link {
  background: #fff;
  border: 1px solid var(--cas-knowledge-line);
  border-radius: 6px;
  color: var(--cas-knowledge-ink);
  cursor: pointer;
  display: grid;
  font: inherit;
  gap: 4px;
  min-width: 0;
  padding: 8px;
  text-align: left;
  text-decoration: none;
}

.cas-knowledge-viewer-link[data-active="true"] {
  border-color: var(--cas-knowledge-accent);
  box-shadow: 0 0 0 2px rgba(8, 127, 140, 0.14);
}

.cas-knowledge-viewer-link strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cas-knowledge-viewer-body {
  background: #fbfcfe;
  border: 1px solid var(--cas-knowledge-line);
  border-radius: 6px;
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 10px;
}

.cas-knowledge-viewer-body p {
  margin: 0;
}

.cas-knowledge-scope {
  border: 1px solid var(--cas-knowledge-line);
  border-radius: 8px;
  display: grid;
  gap: 8px;
  padding: 10px;
}

.cas-knowledge-scope-row {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.cas-knowledge-result-panel {
  border: 1px solid var(--cas-knowledge-line);
  border-radius: 8px;
  display: grid;
  gap: 10px;
  padding: 12px;
}

.cas-knowledge-result-panel h3 {
  font-size: 16px;
  margin: 0;
}

.cas-knowledge-citation-list,
.cas-knowledge-stage-list {
  display: grid;
  gap: 8px;
}

.cas-knowledge-citation,
.cas-knowledge-stage {
  background: #fbfcfe;
  border: 1px solid var(--cas-knowledge-line);
  border-radius: 6px;
  display: grid;
  gap: 4px;
  padding: 8px;
}

.cas-topology-dashboard {
  display: grid;
  gap: 14px;
  min-width: 0;
}

.cas-topology-toolbar {
  align-items: center;
  background: #fbfcfe;
  border: 1px solid var(--cas-knowledge-line);
  border-radius: 8px;
  display: grid;
  gap: 10px;
  grid-template-columns: minmax(0, 1fr);
  justify-content: space-between;
  min-width: 0;
  padding: 10px;
}

.cas-topology-segments {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
}

.cas-topology-segments button {
  background: #fff;
  border: 1px solid var(--cas-knowledge-line);
  border-radius: 4px;
  color: var(--cas-knowledge-muted);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  padding: 7px 9px;
}

.cas-topology-segments button[data-active="true"] {
  background: #e9f7f8;
  border-color: #85cfd6;
  color: var(--cas-knowledge-accent);
}

.cas-topology-stats {
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
}

.cas-topology-metric {
  border-left: 3px solid var(--cas-knowledge-line);
  display: grid;
  gap: 3px;
  min-width: 0;
  padding: 3px 8px;
}

.cas-topology-metric strong {
  font-size: 20px;
  line-height: 1.1;
}

.cas-topology-metric span {
  color: var(--cas-knowledge-muted);
  font-size: 11px;
  font-weight: 700;
  line-height: 1.1;
  text-transform: uppercase;
}

.cas-topology-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
}

.cas-topology-workspace {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.cas-topology-canvas {
  background:
    linear-gradient(#e6ebf2 1px, transparent 1px),
    linear-gradient(90deg, #e6ebf2 1px, transparent 1px),
    #f8fafc;
  background-size: 28px 28px;
  border: 1px solid var(--cas-knowledge-line);
  border-radius: 8px;
  min-height: 460px;
  min-width: 0;
  overflow: hidden;
  position: relative;
}

.cas-topology-browser {
  border: 1px solid var(--cas-knowledge-line);
  border-radius: 8px;
  display: grid;
  gap: 10px;
  min-width: 0;
  padding: 10px;
}

.cas-topology-browser label {
  color: var(--cas-knowledge-muted);
  display: grid;
  font-size: 12px;
  font-weight: 700;
  gap: 5px;
}

.cas-topology-browser input {
  border: 1px solid var(--cas-knowledge-line);
  border-radius: 4px;
  color: var(--cas-knowledge-ink);
  font: inherit;
  padding: 8px 9px;
  width: 100%;
}

.cas-topology-node-list {
  display: grid;
  gap: 6px;
  max-height: 240px;
  overflow: auto;
}

.cas-topology-node-list-item {
  align-items: center;
  background: #fff;
  border: 1px solid var(--cas-knowledge-line);
  border-radius: 6px;
  color: var(--cas-knowledge-ink);
  cursor: pointer;
  display: grid;
  gap: 5px;
  grid-template-columns: minmax(0, 1fr) auto auto;
  min-width: 0;
  padding: 8px;
  text-align: left;
}

.cas-topology-node-list-item[data-selected="true"] {
  border-color: var(--cas-knowledge-accent);
  box-shadow: 0 0 0 2px rgba(8, 127, 140, 0.14);
}

.cas-topology-node-list-item strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cas-topology-node-list-item span {
  color: var(--cas-knowledge-muted);
  font-size: 11px;
  white-space: nowrap;
}

.cas-topology-edges {
  height: 100%;
  inset: 0;
  pointer-events: none;
  position: absolute;
  width: 100%;
}

.cas-topology-edge {
  stroke: #8a97a8;
  stroke-linecap: round;
  stroke-width: 0.36;
}

.cas-topology-node {
  align-items: start;
  background: #fff;
  border: 2px solid #8a97a8;
  border-radius: 6px;
  box-shadow: 0 7px 16px rgba(24, 32, 42, 0.11);
  color: var(--cas-knowledge-ink);
  cursor: pointer;
  display: grid;
  gap: 3px;
  min-height: 62px;
  justify-items: start;
  overflow: hidden;
  padding: 8px 9px;
  position: absolute;
  text-align: left;
  transform: translate(-50%, -50%);
  width: 124px;
}

.cas-topology-node[data-tone="document"] {
  border-color: #087f8c;
}

.cas-topology-node[data-tone="wiki-note"] {
  border-color: #5c7cfa;
}

.cas-topology-node[data-tone="term"] {
  border-color: #a66200;
}

.cas-topology-node[data-tone="link"] {
  border-color: #4c6ef5;
}

.cas-topology-node[data-tone="tag"] {
  border-color: #c2255c;
}

.cas-topology-node[data-tone="entity"] {
  border-color: #2f6f4e;
}

.cas-topology-node[data-tone="concept"] {
  border-color: #0b7285;
}

.cas-topology-node[data-tone="image"] {
  border-color: #7866d9;
}

.cas-topology-node[data-tone="runtime"] {
  border-color: #2f6f4e;
}

.cas-topology-node[data-selected="true"] {
  outline: 3px solid rgba(8, 127, 140, 0.22);
}

.cas-topology-node strong {
  display: -webkit-box;
  font-size: 12px;
  line-height: 1.2;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  white-space: normal;
  word-break: break-word;
}

.cas-topology-node[data-selected="true"] strong {
  color: var(--cas-knowledge-accent);
}

.cas-topology-node span {
  color: var(--cas-knowledge-muted);
  font-size: 11px;
  line-height: 1;
}

.cas-topology-side {
  border: 1px solid var(--cas-knowledge-line);
  border-radius: 8px;
  align-content: start;
  display: grid;
  gap: 12px;
  min-width: 0;
  padding: 12px;
}

.cas-topology-side h3 {
  font-size: 16px;
  line-height: 1.3;
  margin: 0;
}

.cas-topology-node-summary {
  color: var(--cas-knowledge-muted);
  font-size: 12px;
  line-height: 1.45;
  margin: 0;
}

.cas-topology-relations {
  display: grid;
  gap: 8px;
  max-height: 260px;
  overflow: auto;
}

.cas-topology-token-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.cas-topology-relation {
  border: 1px solid var(--cas-knowledge-line);
  border-radius: 6px;
  display: grid;
  gap: 4px;
  padding: 8px;
}

.cas-topology-relation strong {
  font-size: 12px;
}

.cas-topology-relation span {
  overflow-wrap: anywhere;
}

.cas-topology-relation-grid {
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  max-height: 260px;
  overflow: auto;
}

.cas-topology-empty {
  align-items: center;
  color: var(--cas-knowledge-muted);
  display: grid;
  min-height: 220px;
  place-items: center;
  text-align: center;
}

.cas-topology-visible-count {
  background: rgba(255, 255, 255, 0.92);
  bottom: 10px;
  left: 10px;
  position: absolute;
}

@media (min-width: 1180px) {
  .cas-topology-toolbar {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .cas-topology-grid {
    grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
  }

  .cas-topology-canvas {
    min-height: 520px;
  }
}

@media (max-width: 820px) {
  .cas-knowledge-route {
    padding: 16px;
  }

  .cas-knowledge-layout {
    grid-template-columns: 1fr;
  }

  .cas-knowledge-nav {
    border-right: 0;
    border-bottom: 1px solid var(--cas-knowledge-line);
    grid-template-columns: repeat(2, minmax(0, 1fr));
    padding: 0 0 12px;
  }

  .cas-knowledge-fields {
    grid-template-columns: 1fr;
  }

  .cas-topology-canvas {
    min-height: 360px;
  }

  .cas-topology-node {
    min-height: 54px;
    padding: 6px 7px;
    width: 100px;
  }
}

@media (max-width: 600px) {
  .cas-topology-canvas {
    align-content: start;
    display: grid;
    gap: 8px;
    min-height: 0;
    padding: 10px;
  }

  .cas-topology-edges {
    display: none;
  }

  .cas-topology-node {
    min-height: 0;
    position: static;
    transform: none;
    width: 100%;
  }

  .cas-topology-node-list-item {
    grid-template-columns: 1fr;
  }

  .cas-topology-visible-count {
    position: static;
  }
}
`;

function currentRouteKey(pathname: string) {
  const match = routeItems.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));
  return match?.key ?? "customer-data";
}

function routeTitle(routeKey: string) {
  return routeItems.find((item) => item.key === routeKey)?.label ?? "고객 데이터";
}

function engineState(health: KnowledgeHealth | null, error: string | null) {
  if (error) return "degraded";
  if (health?.service === "cas-knowledge-engine" && health.status === "ok") return "ready";
  return health?.engine?.status ?? "checking";
}

function prettyJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function recordValue(value: unknown): ActionResult | null {
  return typeof value === "object" && value !== null ? (value as ActionResult) : null;
}

function stringValue(value: unknown) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function firstString(record: ActionResult | null | undefined, keys: string[]) {
  if (!record) return undefined;
  for (const key of keys) {
    const text = stringValue(record[key]);
    if (text) return text;
  }
  return undefined;
}

function currentSearchParams() {
  return typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
}

function initialCustomerId() {
  const params = currentSearchParams();
  return params.get("customer_id") || params.get("customerId") || "default";
}

function initialViewerTarget(): ViewerTarget | null {
  const params = currentSearchParams();
  const documentId = stringValue(params.get("document_id") || params.get("documentId"));
  if (documentId) {
    return {
      kind: "document",
      id: documentId,
      title: documentId,
      document_source_id: documentId,
      viewer_path: typeof window === "undefined" ? undefined : `${window.location.pathname}${window.location.search}`
    };
  }
  const noteId = stringValue(params.get("note_id") || params.get("noteId"));
  if (noteId) {
    return {
      kind: "wiki-note",
      id: noteId,
      title: noteId,
      viewer_path: typeof window === "undefined" ? undefined : `${window.location.pathname}${window.location.search}`
    };
  }
  return null;
}

function initialDocumentId() {
  const target = initialViewerTarget();
  return target?.document_source_id || target?.id || "";
}

function viewerTargetFromRecord(record: ActionResult | null | undefined, fallbackKind: ViewerKind = "document"): ViewerTarget | null {
  if (!record) return null;
  const id =
    firstString(record, [
      "id",
      "document_source_id",
      "source_document_id",
      "document_id",
      "note_id",
      "chunk_id",
      "citation_id"
    ]) ?? "";
  const documentSourceId = firstString(record, ["document_source_id", "source_document_id", "document_id"]);
  const noteId = firstString(record, ["note_id"]);
  const kind =
    fallbackKind === "citation"
      ? "citation"
      : noteId || firstString(record, ["note_type", "book_slug", "overlay_id"])
        ? "wiki-note"
        : fallbackKind;
  const title = firstString(record, ["title", "filename", "file_name", "label", "name"]) ?? id;
  if (!id && !title) return null;
  const chunkPreviews = Array.isArray(record.chunk_previews)
    ? record.chunk_previews.filter((item): item is ActionResult => typeof item === "object" && item !== null)
    : undefined;
  const metadata = recordValue(record.metadata) ?? recordValue(record.provenance) ?? undefined;
  return {
    kind,
    id: id || title,
    title: title || id,
    summary: firstString(record, ["summary", "snippet", "markdown"]),
    body: firstString(record, ["body", "text", "answer"]),
    viewer_path: firstString(record, ["viewer_path", "viewerPath"]),
    source_url: firstString(record, ["source_url", "url"]),
    source_scope: firstString(record, ["source_scope"]),
    document_source_id: documentSourceId,
    chunk_count: Number.isFinite(Number(record.chunk_count)) ? Number(record.chunk_count) : undefined,
    ready_for_chat: typeof record.ready_for_chat === "boolean" ? record.ready_for_chat : undefined,
    chunk_previews: chunkPreviews,
    metadata
  };
}

function viewerTargetFromTopologyNode(node: TopologyNode): ViewerTarget {
  const tone = nodeTone(node.type);
  const documentId = node.document_source_id || node.source_document_id || node.document_id || (tone === "document" ? node.id : undefined);
  return {
    kind: tone === "wiki-note" ? "wiki-note" : tone === "document" ? "document" : "source",
    id: node.id,
    title: node.label,
    summary: node.summary,
    viewer_path: node.viewer_path,
    source_url: node.source_url,
    source_scope: node.source_scope,
    document_source_id: documentId,
    chunk_count: Number.isFinite(Number(node.metadata?.chunk_count)) ? Number(node.metadata?.chunk_count) : undefined,
    ready_for_chat: node.ready_for_chat,
    metadata: node.metadata ?? node.provenance
  };
}

function viewerHref(target: ViewerTarget, customerId: string) {
  const params = new URLSearchParams();
  params.set("customer_id", customerId);
  if (target.kind === "wiki-note") {
    params.set("note_id", target.id);
    return `/cywell/llm-wiki?${params.toString()}`;
  }
  const documentId = target.document_source_id || target.id;
  params.set("document_id", documentId);
  return `/cywell/customer-data?${params.toString()}`;
}

function routeHref(baseHref: string, customerId: string, documentId: string) {
  const params = new URLSearchParams();
  const scopedCustomerId = customerId.trim();
  const scopedDocumentId = documentId.trim();
  if (scopedCustomerId) params.set("customer_id", scopedCustomerId);
  if (scopedDocumentId) params.set("document_id", scopedDocumentId);
  const query = params.toString();
  return query ? `${baseHref}?${query}` : baseHref;
}

function viewerTargetKey(target: ViewerTarget) {
  return `${target.kind}:${target.id}:${target.title}`;
}

function mergeViewerTarget(left: ViewerTarget, right: ViewerTarget) {
  return {
    ...left,
    ...right,
    summary: left.summary || right.summary,
    body: left.body || right.body,
    viewer_path: left.viewer_path || right.viewer_path,
    source_url: left.source_url || right.source_url,
    source_scope: left.source_scope || right.source_scope,
    document_source_id: left.document_source_id || right.document_source_id,
    chunk_count: left.chunk_count ?? right.chunk_count,
    ready_for_chat: left.ready_for_chat ?? right.ready_for_chat,
    chunk_previews: left.chunk_previews ?? right.chunk_previews,
    metadata: left.metadata ?? right.metadata
  };
}

function collectViewerTargets(value: ActionResult | null, topology: TopologyPayload | null, customerId: string) {
  const targets: ViewerTarget[] = [];
  const add = (target: ViewerTarget | null) => {
    if (!target) return;
    const key = viewerTargetKey(target);
    const existingIndex = targets.findIndex((item) => viewerTargetKey(item) === key);
    if (existingIndex >= 0) {
      targets[existingIndex] = mergeViewerTarget(targets[existingIndex], target);
    } else {
      targets.push(target);
    }
  };
  const addRecordList = (items: unknown, kind: ViewerKind) => {
    if (!Array.isArray(items)) return;
    for (const item of items) add(viewerTargetFromRecord(recordValue(item), kind));
  };
  if (value) {
    add(viewerTargetFromRecord(recordValue(value.document), "document"));
    add(viewerTargetFromRecord(recordValue(value.note), "wiki-note"));
    addRecordList(value.items, "document");
    addRecordList(value.reports, "document");
    addRecordList(value.documents, "document");
    addRecordList(value.pages, "document");
    addRecordList(value.upload_results, "document");
    addRecordList(value.uploadResults, "document");
    addRecordList(value.citations, "citation");
    addRecordList(value.sources, "citation");
    addRecordList(value.notes, "wiki-note");
  }
  for (const node of topology?.nodes ?? []) add(viewerTargetFromTopologyNode(node));
  for (const upload of topology?.selected_uploads ?? []) {
    add(
      viewerTargetFromRecord(
        {
          id: upload.id ?? upload.document_source_id,
          document_source_id: upload.document_source_id,
          title: upload.title,
          filename: upload.filename,
          viewer_path: upload.viewer_path,
          source_scope: upload.source_scope,
          ready_for_chat: upload.ready_for_chat,
          chunk_count: upload.chunk_count
        },
        "document"
      )
    );
  }
  for (const context of topology?.selected_context ?? []) {
    add(
      viewerTargetFromRecord(
        {
          id: context.id,
          document_source_id: context.document_source_id,
          title: context.title,
          body: context.body,
          viewer_path: context.viewer_path,
          source_scope: context.source_scope,
          note_type: "wiki_context"
        },
        "wiki-note"
      )
    );
  }
  return targets.map((target) => ({
    ...target,
    viewer_path: target.viewer_path || viewerHref(target, customerId)
  }));
}

function mergeViewerTargets(...groups: ViewerTarget[][]) {
  const merged: ViewerTarget[] = [];
  for (const group of groups) {
    for (const target of group) {
      const key = viewerTargetKey(target);
      const existingIndex = merged.findIndex((item) => viewerTargetKey(item) === key);
      if (existingIndex >= 0) merged[existingIndex] = mergeViewerTarget(merged[existingIndex], target);
      else merged.push(target);
    }
  }
  return merged;
}

function topologyCandidateRecords(value: ActionResult) {
  const topology = recordValue(value.topology);
  const topologyGraph = topology ? recordValue(topology.graph) : null;
  const graph = recordValue(value.graph);
  return [
    {
      candidate: graph,
      sidecars: [recordValue(graph?.pbs), recordValue(value.pbs), value, graph]
    },
    {
      candidate: topologyGraph,
      sidecars: [recordValue(topologyGraph?.pbs), topology ? recordValue(topology.pbs) : null, topology, topologyGraph]
    },
    {
      candidate: topology,
      sidecars: [topology ? recordValue(topology.pbs) : null, topology]
    },
    {
      candidate: value,
      sidecars: [recordValue(value.pbs), value]
    }
  ]
    .filter((entry): entry is { candidate: ActionResult; sidecars: Array<ActionResult | null> } => Boolean(entry.candidate))
    .map((entry) => ({
      candidate: entry.candidate,
      sidecars: entry.sidecars.filter((sidecar): sidecar is ActionResult => Boolean(sidecar))
    }));
}

function firstTopologyList(candidates: ActionResult[], keys: string[]) {
  for (const candidate of candidates) {
    for (const key of keys) {
      const value = candidate[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

function firstRecordList(candidates: ActionResult[], keys: string[]) {
  return firstTopologyList(candidates, keys).filter((item): item is ActionResult => typeof item === "object" && item !== null);
}

function topologyTokenList(candidates: ActionResult[], key: string): TopologyToken[] {
  const values = firstTopologyList(candidates, [key]);
  return values
    .map((item) => {
      const record = recordValue(item);
      const label = record ? String(record.label ?? record.name ?? record.title ?? "").trim() : String(item ?? "").trim();
      const count = record && Number.isFinite(Number(record.count)) ? Number(record.count) : undefined;
      return label ? { label, count } : null;
    })
    .filter((item): item is TopologyToken => Boolean(item))
    .slice(0, 16);
}

function topologyContextList(candidates: ActionResult[]): TopologyContextItem[] {
  return firstRecordList(candidates, ["selected_context", "selectedContext", "context"])
    .map((item) => {
      const id = item.id ? String(item.id) : item.note_id ? String(item.note_id) : undefined;
      const title = String(item.title ?? item.name ?? id ?? "Wiki context");
      return {
        id,
        title,
        body: item.body || item.summary || item.markdown ? String(item.body ?? item.summary ?? item.markdown) : undefined,
        document_source_id: item.document_source_id || item.source_document_id || item.document_id ? String(item.document_source_id ?? item.source_document_id ?? item.document_id) : undefined,
        viewer_path: item.viewer_path ? String(item.viewer_path) : undefined,
        source_scope: item.source_scope ? String(item.source_scope) : undefined
      };
    })
    .slice(0, 8);
}

function topologyUploadList(candidates: ActionResult[]): TopologyUploadItem[] {
  return firstRecordList(candidates, ["selected_uploads", "selectedUploads", "uploads"])
    .map((item) => {
      const id = item.id || item.document_source_id ? String(item.id ?? item.document_source_id) : undefined;
      return {
        id,
        document_source_id: item.document_source_id || item.source_document_id || item.document_id ? String(item.document_source_id ?? item.source_document_id ?? item.document_id) : id,
        title: String(item.title ?? item.filename ?? item.file_name ?? id ?? "Upload"),
        filename: item.filename || item.file_name ? String(item.filename ?? item.file_name) : undefined,
        viewer_path: item.viewer_path ? String(item.viewer_path) : undefined,
        source_scope: item.source_scope ? String(item.source_scope) : undefined,
        ready_for_chat: typeof item.ready_for_chat === "boolean" ? item.ready_for_chat : undefined,
        chunk_count: Number.isFinite(Number(item.chunk_count)) ? Number(item.chunk_count) : undefined
      };
    })
    .slice(0, 8);
}

function topologyRelationSignals(candidates: ActionResult[]): TopologyRelationSignal[] {
  return firstRecordList(candidates, ["relations", "relation_signals", "vault_relations"])
    .map((item) => {
      const source = nodeRef(item.source ?? item.from ?? item.subject ?? item.source_id ?? item.subject_id);
      const target = nodeRef(item.target ?? item.to ?? item.object ?? item.target_id ?? item.object_id);
      const type = String(item.type ?? item.kind ?? item.relation ?? item.label ?? "relates");
      return source && target ? { source, target, type, label: item.label ? String(item.label) : undefined } : null;
    })
    .filter((item): item is TopologyRelationSignal => Boolean(item))
    .slice(0, 24);
}

function topologyListCandidate(candidate: ActionResult) {
  return ["nodes", "entities", "vertices", "edges", "links", "relations", "relationships"].some((key) => Array.isArray(candidate[key]));
}

function nodeRef(value: unknown) {
  const record = recordValue(value);
  if (!record) return String(value ?? "").trim();
  return String(record.id ?? record.node_id ?? record.key ?? record.slug ?? record.entity_id ?? record.document_source_id ?? "").trim();
}

function countAtLeast(value: unknown, minimum: number) {
  const count = Number(value);
  return Math.max(Number.isFinite(count) ? count : 0, minimum);
}

function countAlias(source: ActionResult | undefined, keys: string[], fallback: number) {
  if (!source) return fallback;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) return countAtLeast(value, fallback);
  }
  return fallback;
}

function topologyPayload(value: ActionResult | null): TopologyPayload | null {
  if (!value) return null;
  const candidateRecord = topologyCandidateRecords(value).find((entry) => topologyListCandidate(entry.candidate));
  const candidate = candidateRecord?.candidate;
  if (!candidate || !candidateRecord) return null;
  const sidecarCandidates = candidateRecord.sidecars;
  const rawNodes = firstTopologyList([candidate], ["nodes", "entities", "vertices"]);
  const rawEdges = firstTopologyList([candidate], ["edges", "links", "relations", "relationships"]);
  const countsCandidate = recordValue(candidate.counts) ?? recordValue(candidate.summary);
  const nodesById = new Map<string, TopologyNode>();
  const ensureNode = (id: string, fallbackType = "pbs-endpoint") => {
    if (!id || nodesById.has(id)) return;
    nodesById.set(id, { id, type: fallbackType, label: id });
  };
  rawNodes
    .filter((node): node is ActionResult => typeof node === "object" && node !== null)
    .forEach((node, index) => {
      const id = nodeRef(node) || `pbs-node-${index}`;
      const metadata = recordValue(node.metadata);
      const provenance = recordValue(node.provenance);
      const sourceDocumentId =
        node.source_document_id ?? node.document_id ?? node.document_source_id ?? metadata?.source_document_id ?? provenance?.source_document_id;
      nodesById.set(id, {
        id,
        type: String(node.type ?? node.kind ?? node.entity_type ?? node.category ?? "unknown"),
        label: String(node.label ?? node.title ?? node.name ?? node.summary ?? id),
        summary: node.summary || node.body || node.image_summary ? String(node.summary ?? node.body ?? node.image_summary) : undefined,
        status: node.status || node.source || node.vision_status ? String(node.status ?? node.source ?? node.vision_status) : undefined,
        degree: Number.isFinite(Number(node.degree)) ? Number(node.degree) : undefined,
        weight: Number.isFinite(Number(node.weight)) ? Number(node.weight) : undefined,
        viewer_path: node.viewer_path ? String(node.viewer_path) : undefined,
        note_type: node.note_type ? String(node.note_type) : undefined,
        compiled_wiki: typeof node.compiled_wiki === "boolean" ? node.compiled_wiki : undefined,
        entity_kind: node.entity_kind ? String(node.entity_kind) : undefined,
        source_kind: node.source_kind ? String(node.source_kind) : undefined,
        source_url: node.source_url ? String(node.source_url) : undefined,
        source_scope: node.source_scope ? String(node.source_scope) : undefined,
        ready_for_chat: typeof node.ready_for_chat === "boolean" ? node.ready_for_chat : undefined,
        basic_index_ready: typeof node.basic_index_ready === "boolean" ? node.basic_index_ready : undefined,
        revision: Number.isFinite(Number(node.revision)) ? Number(node.revision) : undefined,
        previous_revision: Number.isFinite(Number(node.previous_revision)) ? Number(node.previous_revision) : undefined,
        document_id: node.document_id ? String(node.document_id) : undefined,
        document_source_id: node.document_source_id ? String(node.document_source_id) : undefined,
        source_document_id: sourceDocumentId ? String(sourceDocumentId) : undefined,
        updated_at: typeof node.updated_at === "string" || typeof node.updated_at === "number" ? node.updated_at : undefined,
        metadata: metadata ?? undefined,
        provenance: provenance ?? undefined
      });
    });
  const edges = rawEdges
    .filter((edge): edge is ActionResult => typeof edge === "object" && edge !== null)
    .map((edge) => {
      const source = nodeRef(edge.source ?? edge.from ?? edge.subject ?? edge.source_id ?? edge.subject_id);
      const target = nodeRef(edge.target ?? edge.to ?? edge.object ?? edge.target_id ?? edge.object_id);
      const metadata = recordValue(edge.metadata);
      const provenance = recordValue(edge.provenance);
      const sourceDocumentId =
        edge.source_document_id ?? edge.document_id ?? edge.document_source_id ?? metadata?.source_document_id ?? provenance?.source_document_id;
      if (source) ensureNode(source);
      if (target) ensureNode(target);
      return {
        id: edge.id ? String(edge.id) : undefined,
        source,
        target,
        type: String(edge.type ?? edge.kind ?? edge.relation ?? "relates"),
        source_document_id: sourceDocumentId ? String(sourceDocumentId) : undefined,
        document_id: edge.document_id ? String(edge.document_id) : undefined,
        revision: Number.isFinite(Number(edge.revision)) ? Number(edge.revision) : undefined,
        previous_revision: Number.isFinite(Number(edge.previous_revision)) ? Number(edge.previous_revision) : undefined,
        updated_at: typeof edge.updated_at === "string" || typeof edge.updated_at === "number" ? edge.updated_at : undefined,
        metadata: metadata ?? undefined,
        provenance: provenance ?? undefined
      };
    })
    .filter((edge) => edge.source && edge.target);
  const nodes = [...nodesById.values()];
  const documentCount = countAlias(
    countsCandidate,
    ["documents", "documents_count", "document_count", "document_node_count", "upload_node_count"],
    nodes.filter((node) => nodeTone(node.type) === "document").length
  );
  const noteCount = countAlias(
    countsCandidate,
    ["notes", "notes_count", "note_count", "wiki_note_count"],
    nodes.filter((node) => nodeTone(node.type) === "wiki-note").length
  );
  const counts = countsCandidate
    ? {
        ...countsCandidate,
        documents: documentCount,
        uploads: countAlias(countsCandidate, ["uploads", "uploads_count", "upload_count", "upload_node_count"], 0),
        notes: noteCount,
        compiled: countAlias(countsCandidate, ["compiled", "compiled_count", "compiled_note_count"], 0),
        wikilinks: countAlias(countsCandidate, ["wikilinks", "wikilinks_count", "wikilink_count"], nodes.filter((node) => nodeTone(node.type) === "link").length),
        tags: countAlias(countsCandidate, ["tags", "tags_count", "tag_count"], nodes.filter((node) => nodeTone(node.type) === "tag").length),
        entities:
          countAlias(countsCandidate, ["entities", "entities_count", "entity_count", "entity_node_count"], nodes.filter((node) => nodeTone(node.type) === "entity").length) +
          countAlias(countsCandidate, ["concepts", "concepts_count", "concept_count", "concept_node_count"], nodes.filter((node) => nodeTone(node.type) === "concept").length),
        relations: countAlias(countsCandidate, ["relations", "relations_count", "relation_count", "graph_relation_count", "edge_count"], edges.length),
        nodes: countAtLeast(countsCandidate.nodes, nodes.length),
        edges: countAtLeast(countsCandidate.edges, edges.length)
      }
    : undefined;
  return {
    status: value.status ? String(value.status) : candidate?.status ? String(candidate.status) : undefined,
    customer_id: value.customer_id ? String(value.customer_id) : candidate?.customer_id ? String(candidate.customer_id) : undefined,
    nodes,
    edges,
    counts: counts as TopologyPayload["counts"] | undefined,
    top_wikilinks: topologyTokenList(sidecarCandidates, "top_wikilinks"),
    top_tags: topologyTokenList(sidecarCandidates, "top_tags"),
    selected_context: topologyContextList(sidecarCandidates),
    selected_uploads: topologyUploadList(sidecarCandidates),
    relations: topologyRelationSignals(sidecarCandidates)
  };
}

function nodeTone(type: string) {
  return normalizeTopologyKind(type);
}

function normalizeTopologyKind(type: string) {
  const normalized = type.toLowerCase().replace(/_/g, "-");
  if (normalized.includes("document") || normalized.includes("upload") || normalized.includes("source")) return "document";
  if (normalized.includes("wikilink") || normalized === "link" || normalized.includes("link")) return "link";
  if (normalized.includes("wiki") || normalized.includes("note")) return "wiki-note";
  if (normalized.includes("tag")) return "tag";
  if (normalized.includes("concept")) return "concept";
  if (normalized.includes("entity")) return "entity";
  if (normalized.includes("term")) return "term";
  if (normalized.includes("image") || normalized.includes("figure")) return "image";
  if (normalized.includes("runtime")) return "runtime";
  return "unknown";
}

function nodeDegreeMap(edges: TopologyEdge[]) {
  const degreeById = new Map<string, number>();
  for (const edge of edges) {
    degreeById.set(edge.source, (degreeById.get(edge.source) ?? 0) + 1);
    degreeById.set(edge.target, (degreeById.get(edge.target) ?? 0) + 1);
  }
  return degreeById;
}

function edgeLineageText(edge: TopologyEdge) {
  const parts = [];
  if (edge.source_document_id) parts.push(`edge source ${edge.source_document_id}`);
  if (edge.revision !== undefined) parts.push(`rev ${edge.revision}`);
  return parts.join(" | ");
}

function layoutTopology(nodes: TopologyNode[], edges: TopologyEdge[]) {
  const degreeById = nodeDegreeMap(edges);
  const ordered = [...nodes]
    .map((node) => ({ ...node, degree: node.degree ?? degreeById.get(node.id) ?? 0 }))
    .sort((left, right) => (right.degree ?? 0) - (left.degree ?? 0) || (right.weight ?? 0) - (left.weight ?? 0) || left.label.localeCompare(right.label))
    .slice(0, TOPOLOGY_CANVAS_NODE_LIMIT);
  const total = Math.max(ordered.length, 1);
  return ordered.map((node, index) => {
    if (index === 0) {
      return { node, x: 50, y: 50 };
    }
    const ringIndex = index - 1;
    const ringSize = Math.max(total - 1, 1);
    const angle = (Math.PI * 2 * ringIndex) / Math.max(ringSize, 1) - Math.PI / 2;
    const radius = 34;
    return {
      node,
      x: 50 + Math.cos(angle) * radius,
      y: 50 + Math.sin(angle) * radius
    };
  });
}

async function requestJson(path: string, options?: RequestInit) {
  const { headers, ...requestOptions } = options ?? {};
  const response = await fetch(`${API_BASE}${path}`, {
    ...requestOptions,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(headers as Record<string, string> | undefined)
    }
  });
  const body = (await response.json()) as ActionResult;
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : typeof body.code === "string" ? body.code : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function CapabilityGrid({ capabilities }: { capabilities: KnowledgeCapability[] }) {
  return (
    <div className="cas-knowledge-grid" data-test="cas-knowledge-capabilities">
      {capabilities.map((capability) => (
        <article className="cas-knowledge-card" key={capability.id}>
          <h3>{capability.label}</h3>
          <div className="cas-knowledge-status">
            <span className="cas-knowledge-badge" data-state={capability.state}>
              {capability.state}
            </span>
            <span className="cas-knowledge-badge">{capability.phase}</span>
          </div>
          <div className="cas-knowledge-endpoint">{capability.endpoint}</div>
          <p className="cas-knowledge-muted">{capability.source}</p>
        </article>
      ))}
    </div>
  );
}

function ViewerLink({
  target,
  customerId,
  active,
  openViewer
}: {
  target: ViewerTarget;
  customerId: string;
  active?: boolean;
  openViewer: (target: ViewerTarget) => void;
}) {
  return (
    <a
      className="cas-knowledge-viewer-link"
      data-active={active}
      data-test="cas-knowledge-viewer-link"
      href={viewerHref(target, customerId)}
      onClick={(event) => {
        event.preventDefault();
        openViewer(target);
      }}
    >
      <strong>{target.title}</strong>
      <span className="cas-knowledge-muted">
        {[target.kind, target.document_source_id || target.id, target.source_scope, target.chunk_count !== undefined ? `${target.chunk_count} chunks` : ""]
          .filter(Boolean)
          .join(" · ")}
      </span>
    </a>
  );
}

function KnowledgeViewer({
  customerId,
  selected,
  targets,
  openViewer
}: {
  customerId: string;
  selected: ViewerTarget | null;
  targets: ViewerTarget[];
  openViewer: (target: ViewerTarget) => void;
}) {
  const active =
    selected ??
    targets[0] ??
    targets.find((target) => target.kind === "document") ??
    targets.find((target) => target.kind === "wiki-note") ??
    null;
  if (!active && targets.length === 0) return null;
  const previewRows = active?.chunk_previews ?? [];
  return (
    <section className="cas-knowledge-viewer" data-test="cas-knowledge-viewer">
      <div className="cas-knowledge-status">
        <h3>Viewer</h3>
        {active && <span className="cas-knowledge-badge">{active.kind}</span>}
        {active?.ready_for_chat === true && <span className="cas-knowledge-badge" data-state="ready">ready</span>}
      </div>
      {targets.length > 0 && (
        <div className="cas-knowledge-viewer-list">
          {targets.slice(0, 8).map((target) => (
            <ViewerLink
              active={Boolean(active && active.kind === target.kind && active.id === target.id)}
              customerId={customerId}
              key={`${target.kind}-${target.id}-${target.document_source_id ?? ""}-${target.title}`}
              openViewer={openViewer}
              target={target}
            />
          ))}
        </div>
      )}
      {active && (
        <div className="cas-knowledge-viewer-body">
          <strong>{active.title}</strong>
          <span className="cas-knowledge-muted">
            {[active.document_source_id || active.id, active.source_scope, active.chunk_count !== undefined ? `${active.chunk_count} chunks` : ""]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {active.viewer_path && <div className="cas-knowledge-endpoint">{active.viewer_path}</div>}
          {active.source_url && <div className="cas-knowledge-endpoint">{active.source_url}</div>}
          {(active.summary || active.body) && <p className="cas-topology-node-summary">{active.summary ?? active.body}</p>}
          {previewRows.length > 0 && (
            <div className="cas-topology-relations" data-test="cas-knowledge-viewer-previews">
              {previewRows.slice(0, 3).map((preview, index) => (
                <div className="cas-topology-relation" key={`preview-${active.id}-${index}`}>
                  <strong>{firstString(preview, ["heading_title"]) ?? `chunk ${index + 1}`}</strong>
                  <span className="cas-knowledge-muted">{firstString(preview, ["markdown", "text", "snippet"]) ?? ""}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function CorpusWorkbench({
  customerId,
  reports,
  selectedDocumentId,
  selectDocument,
  openViewer
}: {
  customerId: string;
  reports: ViewerTarget[];
  selectedDocumentId: string;
  selectDocument: (target: ViewerTarget) => void;
  openViewer: (target: ViewerTarget) => void;
}) {
  if (reports.length === 0) return null;
  return (
    <section className="cas-knowledge-viewer" data-test="cas-corpus-workbench">
      <div className="cas-knowledge-status">
        <h3>Customer corpus</h3>
        <span className="cas-knowledge-badge">{reports.length} sources</span>
      </div>
      <div className="cas-knowledge-viewer-list">
        {reports.slice(0, 12).map((target) => {
          const active = selectedDocumentId === (target.document_source_id || target.id);
          const previewText = firstString(target.chunk_previews?.[0], ["markdown", "text", "snippet"]);
          return (
            <button
              className="cas-knowledge-viewer-link"
              data-active={active}
              data-test="cas-corpus-document"
              key={`${target.kind}-${target.id}`}
              onClick={() => selectDocument(target)}
              type="button"
            >
              <strong>{target.title}</strong>
              <span className="cas-knowledge-muted">
                {[target.document_source_id || target.id, target.source_scope, target.chunk_count !== undefined ? `${target.chunk_count} chunks` : ""]
                  .filter(Boolean)
                .join(" · ")}
              </span>
              <span className="cas-knowledge-muted">{target.ready_for_chat === true ? "ready for RAG" : "index pending"}</span>
              {target.summary && <span>{target.summary}</span>}
              {previewText && <span className="cas-knowledge-muted">{previewText}</span>}
            </button>
          );
        })}
      </div>
      {reports.slice(0, 6).map((target) => (
        <ViewerLink
          active={selectedDocumentId === (target.document_source_id || target.id)}
          customerId={customerId}
          key={`viewer-${target.kind}-${target.id}`}
          openViewer={openViewer}
          target={target}
        />
      ))}
    </section>
  );
}

function ScopeBar({
  activeDocumentId,
  corpusCount,
  customerId,
  scopeMode,
  selectedTarget,
  setScopeMode
}: {
  activeDocumentId: string;
  corpusCount: number;
  customerId: string;
  scopeMode: "all" | "selected";
  selectedTarget: ViewerTarget | null;
  setScopeMode: (mode: "all" | "selected") => void;
}) {
  return (
    <section className="cas-knowledge-scope" data-test="cas-knowledge-scope-bar">
      <div className="cas-knowledge-scope-row">
        <strong>Scope</strong>
        <button
          className="cas-knowledge-button"
          data-secondary={scopeMode === "all" ? undefined : "true"}
          data-test="cas-knowledge-scope-all"
          onClick={() => setScopeMode("all")}
          type="button"
        >
          Full corpus
        </button>
        <button
          className="cas-knowledge-button"
          data-secondary={scopeMode === "selected" ? undefined : "true"}
          data-test="cas-knowledge-scope-selected"
          disabled={!selectedTarget}
          onClick={() => setScopeMode("selected")}
          type="button"
        >
          Selected document
        </button>
      </div>
      <div className="cas-knowledge-scope-row">
        <span className="cas-knowledge-badge">{customerId}</span>
        <span className="cas-knowledge-badge">{corpusCount} corpus items</span>
        {scopeMode === "selected" && selectedTarget ? (
          <span className="cas-knowledge-badge" data-test="cas-knowledge-active-document">
            {selectedTarget.title}
          </span>
        ) : (
          <span className="cas-knowledge-badge" data-test="cas-knowledge-active-document">
            all private user_upload + wiki_vault
          </span>
        )}
        {activeDocumentId && <span className="cas-knowledge-muted">{activeDocumentId}</span>}
      </div>
    </section>
  );
}

function KnowledgeResultSummary({ result }: { result: ActionResult }) {
  const citations = Array.isArray(result.citations)
    ? result.citations.filter((item): item is ActionResult => typeof item === "object" && item !== null)
    : [];
  const stages = Array.isArray(result.stages)
    ? result.stages.filter((item): item is ActionResult => typeof item === "object" && item !== null)
    : [];
  const notes = Array.isArray(result.notes)
    ? result.notes.filter((item): item is ActionResult => typeof item === "object" && item !== null)
    : [];
  const topology = topologyPayload(result);
  const document = recordValue(result.document);
  const summary = recordValue(result.summary);
  const highlights = [
    firstString(result, ["document_id", "document_source_id"]) ?? firstString(document, ["document_source_id", "document_id", "id"]),
    firstString(result, ["overlay_id", "note_id"]),
    Number.isFinite(Number(result.chunks_indexed)) ? `${Number(result.chunks_indexed)} chunks indexed` : undefined,
    Number.isFinite(Number(summary?.imported_url_count)) ? `${Number(summary?.imported_url_count)} URLs imported` : undefined
  ].filter((item): item is string => Boolean(item));
  const answer = firstString(result, ["answer", "summary", "message", "error", "detail", "code"]);
  const isError = result.status === "error";
  return (
    <section className="cas-knowledge-result-panel" data-test="cas-knowledge-result" role={isError ? "alert" : undefined}>
      <div className="cas-knowledge-status" data-test="cas-knowledge-result-summary">
        <h3>{isError ? "Action failed" : "Result"}</h3>
        <span className="cas-knowledge-badge" data-state={isError ? "error" : "ready"}>
          {String(result.status ?? "ok")}
        </span>
      </div>
      {answer && <p data-test="cas-knowledge-result-answer">{answer}</p>}
      {highlights.length > 0 && (
        <div className="cas-knowledge-scope-row" data-test="cas-knowledge-result-highlights">
          {highlights.map((highlight) => (
            <span className="cas-knowledge-badge" key={highlight}>
              {highlight}
            </span>
          ))}
        </div>
      )}
      {citations.length > 0 && (
        <div className="cas-knowledge-citation-list" data-test="cas-knowledge-result-citations">
          {citations.slice(0, 5).map((citation, index) => (
            <div className="cas-knowledge-citation" data-test="cas-knowledge-result-citation" key={`citation-${index}`}>
              <strong>{firstString(citation, ["title", "id", "document_id"]) ?? `citation ${index + 1}`}</strong>
              <span className="cas-knowledge-muted">
                {[firstString(citation, ["document_source_id", "document_id"]), firstString(citation, ["source_scope", "source_collection"])]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <span>{firstString(citation, ["snippet", "text", "body"]) ?? ""}</span>
            </div>
          ))}
        </div>
      )}
      {stages.length > 0 && (
        <div className="cas-knowledge-stage-list" data-test="cas-knowledge-result-stages">
          {stages.map((stage, index) => (
            <div className="cas-knowledge-stage" data-test="cas-knowledge-result-stage" key={`stage-${index}`}>
              <strong>{firstString(stage, ["name", "id", "stage"]) ?? `stage ${index + 1}`}</strong>
              <span className="cas-knowledge-muted">{firstString(stage, ["status", "detail", "summary"]) ?? ""}</span>
            </div>
          ))}
        </div>
      )}
      {notes.length > 0 && <span className="cas-knowledge-badge">{notes.length} wiki notes</span>}
      {topology && <span className="cas-knowledge-badge">{topology.nodes.length} nodes / {topology.edges.length} edges</span>}
      <details>
        <summary>Debug JSON</summary>
        <pre className="cas-knowledge-result">
          {prettyJson(result)}
        </pre>
      </details>
    </section>
  );
}

function TopologyDashboard({
  topology,
  selectedNodeId,
  setSelectedNodeId,
  typeFilter,
  setTypeFilter,
  askAboutNode,
  customerId,
  openViewer
}: {
  topology: TopologyPayload | null;
  selectedNodeId: string | null;
  setSelectedNodeId: (nodeId: string | null) => void;
  typeFilter: string;
  setTypeFilter: (filter: string) => void;
  askAboutNode: (node: TopologyNode) => void;
  customerId: string;
  openViewer: (target: ViewerTarget) => void;
}) {
  const [nodeQuery, setNodeQuery] = React.useState("");
  const topologyNodes = topology?.nodes ?? [];
  const topologyEdges = topology?.edges ?? [];
  const degreeById = nodeDegreeMap(topologyEdges);
  const nodesWithDegree = topologyNodes.map((node) => ({ ...node, degree: node.degree ?? degreeById.get(node.id) ?? 0 }));
  const visibleNodes = typeFilter === "all" ? nodesWithDegree : nodesWithDegree.filter((node) => nodeTone(node.type) === typeFilter);
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = topologyEdges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target));
  const positioned = layoutTopology(visibleNodes, visibleEdges);
  const positionById = new Map(positioned.map((item) => [item.node.id, item]));
  const renderedNodeIds = new Set(positioned.map((item) => item.node.id));
  const selectedNode = visibleNodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedViewerTarget = selectedNode ? viewerTargetFromTopologyNode(selectedNode) : null;
  const selectedRelations = selectedNode
    ? visibleEdges
        .filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id)
        .sort((left, right) => left.type.localeCompare(right.type))
        .slice(0, 12)
    : [];
  const relationRows = visibleEdges.slice(0, 24);
  const normalizedQuery = nodeQuery.trim().toLowerCase();
  const browsableNodes = visibleNodes
    .filter((node) => {
      if (!normalizedQuery) return true;
      return `${node.label} ${node.id} ${node.type} ${node.summary ?? ""}`.toLowerCase().includes(normalizedQuery);
    })
    .sort((left, right) => (right.degree ?? 0) - (left.degree ?? 0) || (right.weight ?? 0) - (left.weight ?? 0) || left.label.localeCompare(right.label));
  const signalLeaders = [...nodesWithDegree]
    .sort((left, right) => (right.degree ?? 0) - (left.degree ?? 0) || (right.weight ?? 0) - (left.weight ?? 0) || left.label.localeCompare(right.label))
    .slice(0, 8);
  const topWikilinks = topology?.top_wikilinks ?? [];
  const topTags = topology?.top_tags ?? [];
  const selectedUploads = topology?.selected_uploads ?? [];
  const selectedContext = topology?.selected_context ?? [];
  const vaultRelations = topology?.relations ?? [];
  const counts = {
    nodes: topology?.counts?.nodes ?? topologyNodes.length,
    edges: topology?.counts?.edges ?? topologyEdges.length,
    documents: topology?.counts?.documents ?? topologyNodes.filter((node) => nodeTone(node.type) === "document").length,
    uploads: topology?.counts?.uploads ?? 0,
    notes: topology?.counts?.notes ?? topologyNodes.filter((node) => nodeTone(node.type) === "wiki-note").length,
    compiled: topology?.counts?.compiled ?? topologyNodes.filter((node) => node.compiled_wiki).length,
    wikilinks: topology?.counts?.wikilinks ?? topologyNodes.filter((node) => nodeTone(node.type) === "link").length,
    tags: topology?.counts?.tags ?? topologyNodes.filter((node) => nodeTone(node.type) === "tag").length,
    entities:
      topology?.counts?.entities ??
      topologyNodes.filter((node) => ["entity", "concept"].includes(nodeTone(node.type))).length,
    relations: topology?.counts?.relations ?? topologyEdges.length
  };
  const typeOptions = [
    { key: "all", label: "All" },
    { key: "document", label: "Docs" },
    { key: "wiki-note", label: "Wiki" },
    { key: "term", label: "Terms" },
    { key: "link", label: "Links" },
    { key: "tag", label: "Tags" },
    { key: "entity", label: "Entities" },
    { key: "concept", label: "Concepts" },
    { key: "runtime", label: "Runtime" },
    { key: "image", label: "Images" }
  ];

  React.useEffect(() => {
    if (visibleNodes.length === 0) {
      if (selectedNodeId) setSelectedNodeId(null);
      return;
    }
    if (!selectedNodeId || !visibleNodeIds.has(selectedNodeId)) {
      setSelectedNodeId(visibleNodes[0].id);
    }
  }, [selectedNodeId, setSelectedNodeId, visibleNodeIds, visibleNodes]);

  if (!topology || topologyNodes.length === 0) {
    return (
      <section className="cas-topology-dashboard" data-test="cas-topology-dashboard">
        <div aria-live="polite" className="cas-topology-empty" role="status">
          No topology nodes are available for this customer yet.
        </div>
      </section>
    );
  }

  return (
    <section className="cas-topology-dashboard" data-test="cas-topology-dashboard">
      <div className="cas-topology-toolbar">
        <div className="cas-topology-stats" data-test="cas-topology-kpis">
          <div className="cas-topology-metric">
            <strong>{counts.nodes}</strong>
            <span>nodes</span>
          </div>
          <div className="cas-topology-metric">
            <strong>{counts.edges}</strong>
            <span>edges</span>
          </div>
          <div className="cas-topology-metric">
            <strong>{counts.documents}</strong>
            <span>docs</span>
          </div>
          <div className="cas-topology-metric">
            <strong>{counts.notes}</strong>
            <span>notes</span>
          </div>
          <div className="cas-topology-metric">
            <strong>{counts.compiled}</strong>
            <span>compiled</span>
          </div>
          <div className="cas-topology-metric">
            <strong>{counts.entities}</strong>
            <span>entities</span>
          </div>
          <div className="cas-topology-metric">
            <strong>{counts.wikilinks}</strong>
            <span>wikilinks</span>
          </div>
          <div className="cas-topology-metric">
            <strong>{counts.tags}</strong>
            <span>tags</span>
          </div>
          <div className="cas-topology-metric">
            <strong>{counts.relations}</strong>
            <span>relations</span>
          </div>
        </div>
        <div className="cas-topology-segments" aria-label="Topology node type filter">
          {typeOptions.map((option) => (
            <button
              aria-pressed={typeFilter === option.key}
              data-active={typeFilter === option.key}
              key={option.key}
              onClick={() => setTypeFilter(option.key)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="cas-topology-grid">
        <div className="cas-topology-workspace">
          <div className="cas-topology-canvas" data-test="cas-topology-canvas">
            {visibleNodes.length === 0 && (
              <div aria-live="polite" className="cas-topology-empty" role="status">
                No nodes match this filter.
              </div>
            )}
            <svg aria-hidden="true" className="cas-topology-edges" viewBox="0 0 100 100" preserveAspectRatio="none">
              {visibleEdges.map((edge, index) => {
                const source = positionById.get(edge.source);
                const target = positionById.get(edge.target);
                if (!source || !target || !renderedNodeIds.has(edge.source) || !renderedNodeIds.has(edge.target)) return null;
                return (
                  <line
                    className="cas-topology-edge"
                    data-test="cas-topology-edge"
                    key={`${edge.source}-${edge.target}-${edge.type}-${index}`}
                    x1={source.x}
                    x2={target.x}
                    y1={source.y}
                    y2={target.y}
                  />
                );
              })}
            </svg>
            {positioned.map(({ node, x, y }) => (
              <button
                className="cas-topology-node"
                aria-label={`${node.label}, ${node.type}, ${node.degree ?? 0} links`}
                aria-pressed={selectedNode?.id === node.id}
                data-selected={selectedNode?.id === node.id}
                data-test="cas-topology-node"
                data-tone={nodeTone(node.type)}
                key={node.id}
                onClick={() => setSelectedNodeId(node.id)}
                style={{ left: `${x}%`, top: `${y}%` }}
                title={node.label}
                type="button"
              >
                <strong>{node.label}</strong>
                <span>{node.type}</span>
                <span>{node.degree ?? 0} links</span>
              </button>
            ))}
            {visibleNodes.length > positioned.length && (
              <div className="cas-knowledge-badge cas-topology-visible-count" data-test="cas-topology-visible-count">
                Showing {positioned.length} of {visibleNodes.length} nodes
              </div>
            )}
          </div>
          <div className="cas-topology-browser" data-test="cas-topology-node-index">
            <label>
              Node index
              <input
                aria-label="Search topology nodes"
                data-test="cas-topology-node-search"
                onChange={(event) => setNodeQuery(event.currentTarget.value)}
                placeholder="Search nodes"
                value={nodeQuery}
              />
            </label>
            <div className="cas-topology-node-list">
              {browsableNodes.length === 0 && <p className="cas-knowledge-muted">No matching nodes.</p>}
              {browsableNodes.map((node) => (
                <button
                  aria-pressed={selectedNode?.id === node.id}
                  className="cas-topology-node-list-item"
                  data-selected={selectedNode?.id === node.id}
                  data-test="cas-topology-node-index-item"
                  key={node.id}
                  onClick={() => setSelectedNodeId(node.id)}
                  title={node.label}
                  type="button"
                >
                  <strong>{node.label}</strong>
                  <span>{node.type}</span>
                  <span>{node.degree ?? 0} links</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <aside className="cas-topology-side" data-test="cas-topology-inspector">
          <h3>{selectedNode?.label ?? "No node selected"}</h3>
          {visibleNodes.length === 0 && <p className="cas-knowledge-muted">Select another filter to inspect nodes.</p>}
          {visibleNodes.length > 0 && !selectedNode && (
            <p className="cas-knowledge-muted">Select a node from the canvas or node index.</p>
          )}
          {selectedNode && (
            <>
              <div className="cas-knowledge-status">
                <span className="cas-knowledge-badge">{selectedNode.type}</span>
                {selectedNode.status && <span className="cas-knowledge-badge">{selectedNode.status}</span>}
                <span className="cas-knowledge-badge">degree {selectedNode.degree ?? 0}</span>
                {selectedNode.revision !== undefined && <span className="cas-knowledge-badge">rev {selectedNode.revision}</span>}
              </div>
              <div className="cas-knowledge-endpoint">{selectedNode.id}</div>
              {selectedNode.source_document_id && (
                <div className="cas-knowledge-endpoint">{`source ${selectedNode.source_document_id}`}</div>
              )}
              {selectedNode.summary && <p className="cas-topology-node-summary">{selectedNode.summary}</p>}
              {(selectedNode.entity_kind || selectedNode.source_kind || selectedNode.viewer_path || selectedNode.source_url) && (
                <div className="cas-topology-relations">
                  {selectedNode.entity_kind && <span className="cas-knowledge-badge">entity {selectedNode.entity_kind}</span>}
                  {selectedNode.source_kind && <span className="cas-knowledge-badge">source {selectedNode.source_kind}</span>}
                  {selectedViewerTarget && (
                    <ViewerLink customerId={customerId} openViewer={openViewer} target={selectedViewerTarget} />
                  )}
                  {selectedNode.source_url && <div className="cas-knowledge-endpoint">{selectedNode.source_url}</div>}
                </div>
              )}
              <button
                className="cas-knowledge-button"
                data-secondary="true"
                data-test="cas-topology-rag-action"
                onClick={() => askAboutNode(selectedNode)}
                type="button"
              >
                Ask RAG about this node
              </button>
            </>
          )}
          <div className="cas-topology-relations" data-test="cas-topology-signal-leaders">
            <h3>Signal leaders</h3>
            {signalLeaders.map((node) => (
              <button
                className="cas-topology-node-list-item"
                data-selected={selectedNode?.id === node.id}
                key={`leader-${node.id}`}
                onClick={() => setSelectedNodeId(node.id)}
                type="button"
              >
                <strong>{node.label}</strong>
                <span>{nodeTone(node.type)}</span>
                <span>{node.degree ?? 0} links</span>
              </button>
            ))}
          </div>
          {(topWikilinks.length > 0 || topTags.length > 0) && (
            <div className="cas-topology-relations" data-test="cas-topology-token-panel">
              <h3>Vault signals</h3>
              {topWikilinks.length > 0 && (
                <div className="cas-topology-token-row" data-test="cas-topology-top-wikilinks">
                  {topWikilinks.slice(0, 8).map((item) => (
                    <span className="cas-knowledge-badge" key={`wikilink-${item.label}`}>
                      {item.count !== undefined ? `${item.label} ${item.count}` : item.label}
                    </span>
                  ))}
                </div>
              )}
              {topTags.length > 0 && (
                <div className="cas-topology-token-row" data-test="cas-topology-top-tags">
                  {topTags.slice(0, 8).map((item) => (
                    <span className="cas-knowledge-badge" key={`tag-${item.label}`}>
                      {item.count !== undefined ? `#${item.label} ${item.count}` : `#${item.label}`}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          {(selectedUploads.length > 0 || selectedContext.length > 0) && (
            <div className="cas-topology-relations" data-test="cas-topology-context-panel">
              <h3>Vault context</h3>
              {selectedUploads.slice(0, 4).map((upload) => (
                <div className="cas-topology-relation" data-test="cas-topology-selected-upload" key={`upload-${upload.document_source_id ?? upload.id ?? upload.title}`}>
                  <ViewerLink
                    customerId={customerId}
                    openViewer={openViewer}
                    target={{
                      kind: "document",
                      id: upload.document_source_id ?? upload.id ?? upload.title,
                      title: upload.title,
                      document_source_id: upload.document_source_id,
                      viewer_path: upload.viewer_path,
                      source_scope: upload.source_scope,
                      chunk_count: upload.chunk_count,
                      ready_for_chat: upload.ready_for_chat
                    }}
                  />
                  <span className="cas-knowledge-muted">
                    {[
                      upload.document_source_id,
                      upload.source_scope,
                      upload.chunk_count !== undefined ? `${upload.chunk_count} chunks` : "",
                      upload.ready_for_chat === true ? "ready" : ""
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
              ))}
              {selectedContext.slice(0, 4).map((context) => (
                <div className="cas-topology-relation" data-test="cas-topology-selected-context" key={`context-${context.id ?? context.title}`}>
                  <ViewerLink
                    customerId={customerId}
                    openViewer={openViewer}
                    target={{
                      kind: "wiki-note",
                      id: context.id ?? context.title,
                      title: context.title,
                      document_source_id: context.document_source_id,
                      viewer_path: context.viewer_path,
                      source_scope: context.source_scope,
                      body: context.body
                    }}
                  />
                  {context.body && <span className="cas-knowledge-muted">{context.body.replace(/\s+/g, " ").slice(0, 110)}</span>}
                  <span className="cas-knowledge-muted">
                    {[context.document_source_id, context.source_scope, context.viewer_path].filter(Boolean).join(" · ")}
                  </span>
                </div>
              ))}
            </div>
          )}
          {vaultRelations.length > 0 && (
            <div className="cas-topology-relations" data-test="cas-topology-vault-relations">
              <h3>Vault relations</h3>
              {vaultRelations.slice(0, 6).map((relation, index) => (
                <div className="cas-topology-relation" key={`vault-${relation.source}-${relation.target}-${relation.type}-${index}`}>
                  <strong>{relation.type}</strong>
                  <span className="cas-knowledge-muted">{`${relation.source} -> ${relation.target}`}</span>
                </div>
              ))}
            </div>
          )}
          <div className="cas-topology-relations">
            {selectedRelations.length === 0 && <p className="cas-knowledge-muted">No direct relations in the current view.</p>}
            {selectedRelations.map((edge, index) => (
              <div className="cas-topology-relation" key={`${edge.source}-${edge.target}-${edge.type}-${index}`}>
                <strong>{edge.type}</strong>
                <span className="cas-knowledge-muted">
                  {`${edge.source} -> ${edge.target}`}
                </span>
                {edgeLineageText(edge) && <span className="cas-knowledge-muted">{edgeLineageText(edge)}</span>}
              </div>
            ))}
          </div>
        </aside>
      </div>
      {relationRows.length > 0 && (
        <div className="cas-topology-relation-grid" data-test="cas-topology-relation-grid">
          {relationRows.map((edge, index) => (
            <div className="cas-topology-relation" key={`${edge.source}-${edge.target}-${edge.type}-${index}`}>
              <strong>{edge.type}</strong>
              <span className="cas-knowledge-muted">{`${edge.source} -> ${edge.target}`}</span>
              {edgeLineageText(edge) && <span className="cas-knowledge-muted">{edgeLineageText(edge)}</span>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default function CywellKnowledgeRoute() {
  const [health, setHealth] = React.useState<KnowledgeHealth | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [customerId, setCustomerId] = React.useState(initialCustomerId);
  const [uploadTitle, setUploadTitle] = React.useState("customer-runbook.txt");
  const [uploadContent, setUploadContent] = React.useState(
    "OpenShift router latency increased after ingress certificate rotation. Check route shards, HAProxy logs, and namespace events."
  );
  const [selectedFileName, setSelectedFileName] = React.useState("");
  const [selectedFileBase64, setSelectedFileBase64] = React.useState("");
  const [selectedFileMimeType, setSelectedFileMimeType] = React.useState("");
  const [urlValue, setUrlValue] = React.useState("");
  const [question, setQuestion] = React.useState("router latency 원인과 확인할 증적은?");
  const [noteTitle, setNoteTitle] = React.useState("운영 Wiki 노트");
  const [noteBody, setNoteBody] = React.useState("운영 메모: [[router]] latency는 route shard와 연결된다.");
  const [isRunning, setIsRunning] = React.useState(false);
  const [actionResult, setActionResult] = React.useState<ActionResult | null>(null);
  const [topologyData, setTopologyData] = React.useState<TopologyPayload | null>(null);
  const [corpusTargets, setCorpusTargets] = React.useState<ViewerTarget[]>([]);
  const [selectedDocumentId, setSelectedDocumentId] = React.useState(initialDocumentId);
  const [selectedViewerTarget, setSelectedViewerTarget] = React.useState<ViewerTarget | null>(initialViewerTarget);
  const [scopeMode, setScopeMode] = React.useState<"all" | "selected">(initialDocumentId() ? "selected" : "all");
  const [topologyTypeFilter, setTopologyTypeFilter] = React.useState("all");
  const [selectedTopologyNodeId, setSelectedTopologyNodeId] = React.useState<string | null>(null);
  const autoTopologyLoadKey = React.useRef("");
  const topologyRequestSequence = React.useRef(0);
  const pathname = typeof window === "undefined" ? "/cywell/customer-data" : window.location.pathname;
  const activeKey = currentRouteKey(pathname);
  const activeRoute = routeItems.find((item) => item.key === activeKey) ?? routeItems[0];
  const capabilities = health?.capabilities?.length ? health.capabilities : fallbackCapabilities;
  const renderedTopology = topologyData ?? topologyPayload(actionResult);
  const resultViewerTargets = React.useMemo(
    () => collectViewerTargets(actionResult, renderedTopology, customerId),
    [actionResult, customerId, renderedTopology]
  );
  const allViewerTargets = React.useMemo(() => mergeViewerTargets(corpusTargets, resultViewerTargets), [corpusTargets, resultViewerTargets]);
  const selectedCorpusTarget =
    corpusTargets.find((target) => (target.document_source_id || target.id) === selectedDocumentId) ??
    (selectedViewerTarget?.kind === "document" ? selectedViewerTarget : null);
  const activeDocumentId = scopeMode === "selected" ? selectedCorpusTarget?.document_source_id || selectedCorpusTarget?.id || "" : "";
  const activeSourceScopes =
    scopeMode === "selected" && selectedCorpusTarget?.source_scope ? [selectedCorpusTarget.source_scope] : ["user_upload", "wiki_vault"];

  const changeCustomerId = React.useCallback((nextCustomerId: string) => {
    setCustomerId(nextCustomerId);
    setActionResult(null);
    setTopologyData(null);
    setCorpusTargets([]);
    setSelectedDocumentId("");
    setSelectedViewerTarget(null);
    setScopeMode("all");
    setSelectedTopologyNodeId(null);
    autoTopologyLoadKey.current = "";
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const scopedCustomerId = nextCustomerId.trim();
      if (scopedCustomerId) params.set("customer_id", scopedCustomerId);
      else params.delete("customer_id");
      params.delete("document_id");
      params.delete("documentId");
      params.delete("note_id");
      params.delete("noteId");
      const query = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    }
  }, []);

  const openViewer = React.useCallback(
    (target: ViewerTarget) => {
      setSelectedViewerTarget(target);
      if (target.kind === "document") setSelectedDocumentId(target.document_source_id || target.id);
      if (typeof window !== "undefined") {
        window.history.pushState(null, "", viewerHref(target, customerId));
      }
    },
    [customerId]
  );

  const selectCorpusDocument = React.useCallback(
    (target: ViewerTarget) => {
      setSelectedDocumentId(target.document_source_id || target.id);
      setScopeMode("selected");
      openViewer(target);
    },
    [openViewer]
  );

  React.useEffect(() => {
    if (!renderedTopology?.nodes.length) return;
    if (!selectedTopologyNodeId || !renderedTopology.nodes.some((node) => node.id === selectedTopologyNodeId)) {
      setSelectedTopologyNodeId(renderedTopology.nodes[0].id);
    }
  }, [renderedTopology, selectedTopologyNodeId]);

  const refreshHealth = React.useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`${API_BASE}/api/knowledge/healthz`, {
        headers: { accept: "application/json" },
        signal
      });
      const body = (await response.json()) as KnowledgeHealth;
      setHealth(body);
      setError(response.ok ? null : body.engine?.status ?? `HTTP ${response.status}`);
    } catch (loadError) {
      if (!signal?.aborted) {
        setError(loadError instanceof Error ? loadError.message : "knowledge health check failed");
      }
    }
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    void refreshHealth(controller.signal);
    return () => controller.abort();
  }, [refreshHealth]);

  const runAction = React.useCallback(
    async (action: () => Promise<ActionResult>) => {
      setIsRunning(true);
      try {
        const result = await action();
        setActionResult(result);
        await refreshHealth();
      } catch (actionError) {
        setActionResult({
          status: "error",
          error: actionError instanceof Error ? actionError.message : "knowledge action failed"
        });
      } finally {
        setIsRunning(false);
      }
    },
    [refreshHealth]
  );

  const runTopologyRequest = React.useCallback(
    async (requestCustomerId: string, action: () => Promise<ActionResult>, options: { clearFirst?: boolean } = {}) => {
      const requestId = topologyRequestSequence.current + 1;
      topologyRequestSequence.current = requestId;
      setIsRunning(true);
      if (options.clearFirst) setTopologyData(emptyTopology(requestCustomerId));
      try {
        const result = await action();
        if (requestId !== topologyRequestSequence.current) return;
        setTopologyData(topologyPayload(result) ?? emptyTopology(requestCustomerId));
        setActionResult(result);
        await refreshHealth();
      } catch (actionError) {
        if (requestId !== topologyRequestSequence.current) return;
        setTopologyData(emptyTopology(requestCustomerId));
        setActionResult({
          status: "error",
          error: actionError instanceof Error ? actionError.message : "knowledge action failed"
        });
      } finally {
        if (requestId === topologyRequestSequence.current) setIsRunning(false);
      }
    },
    [refreshHealth]
  );

  const uploadDocument = React.useCallback(
    () =>
      runAction(async () => {
        const result = await requestJson("/api/knowledge/uploads/ingest", {
          method: "POST",
          body: JSON.stringify({
            customer_id: customerId,
            file_name: uploadTitle,
            filename: uploadTitle,
            source_scope: "user_upload",
            visibility: "private_user",
            source_kind: "upload",
            source_metadata: {
              customer_id: customerId,
              selected_file_name: selectedFileName || uploadTitle
            },
            force_reingest: false,
            index: true,
            ...(selectedFileBase64
              ? {
                  content_base64: selectedFileBase64,
                  mime_type: selectedFileMimeType
                }
              : { content: uploadContent })
          })
        });
        const targets = collectViewerTargets(result, null, customerId).filter((target) => target.kind === "document");
        if (targets.length > 0) {
          setCorpusTargets((current) => mergeViewerTargets(targets, current));
          selectCorpusDocument(targets[0]);
        }
        return result;
      }),
    [customerId, runAction, selectCorpusDocument, selectedFileBase64, selectedFileMimeType, selectedFileName, uploadContent, uploadTitle]
  );

  const ingestUrl = React.useCallback(
    () =>
      runAction(async () => {
        const result = await requestJson("/api/knowledge/uploads/url-ingest", {
          method: "POST",
          body: JSON.stringify({
            customer_id: customerId,
            url: urlValue,
            source_scope: "user_upload",
            visibility: "private_user",
            source_kind: "url",
            source_metadata: {
              customer_id: customerId
            },
            force_reingest: false,
            index: true,
            auto_compile_wiki: true
          })
        });
        const targets = collectViewerTargets(result, null, customerId).filter((target) => target.kind === "document");
        if (targets.length > 0) {
          setCorpusTargets((current) => mergeViewerTargets(targets, current));
          selectCorpusDocument(targets[0]);
        }
        return result;
      }),
    [customerId, runAction, selectCorpusDocument, urlValue]
  );

  const loadUploadReports = React.useCallback(
    () =>
      runAction(async () => {
        const result = await requestJson(`/api/knowledge/uploads/reports?customer_id=${encodeURIComponent(customerId)}`);
        const targets = collectViewerTargets(result, null, customerId).filter((target) => target.kind === "document");
        setCorpusTargets(targets);
        if (targets.length > 0 && selectedDocumentId && !targets.some((target) => (target.document_source_id || target.id) === selectedDocumentId)) {
          setSelectedDocumentId(targets[0].document_source_id || targets[0].id);
        }
        return result;
      }),
    [customerId, runAction, selectedDocumentId]
  );

  React.useEffect(() => {
    if (!selectedDocumentId || corpusTargets.length > 0) return;
    void loadUploadReports();
  }, [corpusTargets.length, loadUploadReports, selectedDocumentId]);

  const loadSelectedFile = React.useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    setSelectedFileName(file.name);
    setSelectedFileMimeType(file.type);
    setUploadTitle(file.name);
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    setSelectedFileBase64(btoa(binary));
    try {
      setUploadContent(await file.text());
    } catch {
      setUploadContent(`Binary upload selected: ${file.name} (${bytes.length} bytes)`);
    }
  }, []);

  const askRag = React.useCallback(
    () =>
      runAction(() =>
        requestJson("/api/knowledge/rag/query", {
          method: "POST",
          body: JSON.stringify({
            customer_id: customerId,
            question,
            active_document_id: activeDocumentId || undefined,
            document_source_id: activeDocumentId || undefined,
            enabled_upload_document_ids: activeDocumentId ? [activeDocumentId] : undefined,
            enabled_source_scopes: activeSourceScopes,
            restrict_uploaded_sources: Boolean(activeDocumentId)
          })
        })
      ),
    [activeDocumentId, activeSourceScopes, customerId, question, runAction]
  );

  const runWikiLoop = React.useCallback(
    () =>
      runAction(() =>
        requestJson("/api/knowledge/wiki-loop/run", {
          method: "POST",
          body: JSON.stringify({ customer_id: customerId, document_id: activeDocumentId || undefined })
        })
      ),
    [activeDocumentId, customerId, runAction]
  );

  const saveWikiNote = React.useCallback(
    () =>
      runAction(() =>
        requestJson("/api/knowledge/wiki-vault/notes", {
          method: "POST",
          body: JSON.stringify({
            customer_id: customerId,
            document_id: activeDocumentId || undefined,
            target_ref: activeDocumentId || undefined,
            note_type: activeDocumentId ? "document-note" : "manual",
            payload: activeDocumentId ? { target_ref: activeDocumentId, document_id: activeDocumentId } : undefined,
            title: noteTitle,
            body: noteBody
          })
        })
      ),
    [activeDocumentId, customerId, noteBody, noteTitle, runAction]
  );

  const loadVault = React.useCallback(
    () =>
      runTopologyRequest(
        customerId,
        () => requestJson(`/api/knowledge/wiki-vault?customer_id=${encodeURIComponent(customerId)}`),
        { clearFirst: true }
      ),
    [customerId, runTopologyRequest]
  );

  const loadTopology = React.useCallback(
    () =>
      runTopologyRequest(
        customerId,
        () => requestJson(`/api/knowledge/topology?customer_id=${encodeURIComponent(customerId)}`),
        { clearFirst: true }
      ),
    [customerId, runTopologyRequest]
  );

  React.useEffect(() => {
    if (activeKey !== "topology") return;
    const key = `${activeKey}:${customerId}`;
    if (autoTopologyLoadKey.current === key) return;
    autoTopologyLoadKey.current = key;
    void loadTopology();
  }, [activeKey, customerId, loadTopology]);

  const askAboutTopologyNode = React.useCallback(
    (node: TopologyNode) => {
      const nextQuestion = `${node.label} 노드와 연결된 운영 증적과 원인은?`;
      const topologyNodes = renderedTopology?.nodes ?? [];
      const topologyEdges = renderedTopology?.edges ?? [];
      const nodeById = new Map(topologyNodes.map((topologyNode) => [topologyNode.id, topologyNode]));
      const contextById = new Map((renderedTopology?.selected_context ?? []).map((context) => [context.id || context.title, context]));
      const uploadById = new Map((renderedTopology?.selected_uploads ?? []).map((upload) => [upload.document_source_id || upload.id || upload.title, upload]));
      const documentIdForNodeId = (nodeId: string) => {
        const topologyNode = nodeById.get(nodeId);
        const context = contextById.get(nodeId) || (topologyNode?.label ? contextById.get(topologyNode.label) : undefined);
        const upload = uploadById.get(nodeId) || (topologyNode?.label ? uploadById.get(topologyNode.label) : undefined);
        return (
          topologyNode?.document_source_id ||
          topologyNode?.source_document_id ||
          topologyNode?.document_id ||
          context?.document_source_id ||
          upload?.document_source_id ||
          (topologyNode && nodeTone(topologyNode.type) === "document" ? topologyNode.id : "") ||
          ""
        );
      };
      const connectedDocumentIds = [
        ...new Set(
          topologyEdges
            .filter((edge) => edge.source === node.id || edge.target === node.id)
            .flatMap((edge) => [edge.source_document_id || edge.document_id || "", documentIdForNodeId(edge.source), documentIdForNodeId(edge.target)])
            .filter(Boolean)
        )
      ];
      const fallbackSelectedUploadId =
        connectedDocumentIds.length === 0 && (renderedTopology?.selected_uploads ?? []).length === 1
          ? renderedTopology?.selected_uploads?.[0]?.document_source_id || ""
          : "";
      const activeDocumentId =
        node.document_source_id ||
        node.source_document_id ||
        node.document_id ||
        (nodeTone(node.type) === "document" ? node.id : "") ||
        connectedDocumentIds[0] ||
        fallbackSelectedUploadId ||
        "";
      setQuestion(nextQuestion);
      void runAction(() =>
        requestJson("/api/knowledge/rag/query", {
          method: "POST",
          body: JSON.stringify({
            customer_id: customerId,
            question: nextQuestion,
            topology_node_id: node.id,
            topology_node_type: node.type,
            active_document_id: activeDocumentId || undefined,
            document_source_id: activeDocumentId || undefined,
            enabled_upload_document_ids: activeDocumentId ? [activeDocumentId, ...connectedDocumentIds].filter(Boolean) : undefined,
            enabled_source_scopes: node.source_scope ? [node.source_scope] : ["user_upload", "wiki_vault"],
            restrict_uploaded_sources: Boolean(activeDocumentId)
          })
        })
      );
    },
    [customerId, renderedTopology, runAction]
  );

  return (
    <main className="cas-knowledge-route" data-test="cas-knowledge-route">
      <style>{styles}</style>
      <header className="cas-knowledge-header">
        <h1>Cywell Knowledge</h1>
        <p>PBS 기반 고객 데이터, RAG, LLM Wiki, Topology 통합면</p>
        <div className="cas-knowledge-status">
          <span className="cas-knowledge-badge" data-state={health?.status ?? "checking"} data-test="cas-knowledge-facade-status">
            facade {health?.status ?? "checking"}
          </span>
          <span className="cas-knowledge-badge" data-state={engineState(health, error)} data-test="cas-knowledge-engine-status">
            engine {engineState(health, error)}
          </span>
          <span className="cas-knowledge-badge">UserToken scope</span>
        </div>
      </header>

      <section className="cas-knowledge-layout">
        <nav aria-label="Cywell Knowledge" className="cas-knowledge-nav">
          {routeItems.map((item) => (
            <a
              aria-current={item.key === activeKey ? "page" : undefined}
              data-active={item.key === activeKey}
              href={routeHref(item.href, customerId, activeDocumentId)}
              key={item.key}
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="cas-knowledge-main">
          <section className="cas-knowledge-panel" data-test={`cas-knowledge-panel-${activeKey}`}>
            <div className="cas-knowledge-status">
              <h2>{routeTitle(activeKey)}</h2>
              <span className="cas-knowledge-badge">{activeRoute.phase}</span>
            </div>
            <div className="cas-knowledge-endpoint">{activeRoute.endpoint}</div>
            <div className="cas-knowledge-form">
              <ScopeBar
                activeDocumentId={activeDocumentId}
                corpusCount={corpusTargets.length}
                customerId={customerId}
                scopeMode={scopeMode}
                selectedTarget={selectedCorpusTarget}
                setScopeMode={setScopeMode}
              />
              <div className="cas-knowledge-fields">
                <label>
                  Customer ID
                  <input
                    aria-label="Customer ID"
                    onChange={(event) => changeCustomerId(event.currentTarget.value)}
                    value={customerId}
                  />
                </label>
                <label>
                  Document title
                  <input
                    aria-label="Document title"
                    onChange={(event) => setUploadTitle(event.currentTarget.value)}
                    value={uploadTitle}
                  />
                </label>
              </div>

              {activeKey === "customer-data" && (
                <>
                  <label>
                    Upload content
                    <textarea
                      aria-label="Upload content"
                      onChange={(event) => setUploadContent(event.currentTarget.value)}
                      value={uploadContent}
                    />
                  </label>
                  <label>
                    Local file
                    <input aria-label="Local file" data-test="cas-knowledge-file-input" onChange={loadSelectedFile} type="file" />
                  </label>
                  {selectedFileName && <p className="cas-knowledge-muted">selected {selectedFileName}</p>}
                  <div className="cas-knowledge-fields">
                    <label>
                      URL ingest
                      <input aria-label="URL ingest" onChange={(event) => setUrlValue(event.currentTarget.value)} value={urlValue} />
                    </label>
                  </div>
                  <div className="cas-knowledge-actions">
                    <button className="cas-knowledge-button" data-test="cas-knowledge-upload" disabled={isRunning} onClick={uploadDocument} type="button">
                      Upload and index
                    </button>
                    <button
                      className="cas-knowledge-button"
                      data-secondary="true"
                      data-test="cas-knowledge-url-ingest"
                      disabled={isRunning || !urlValue.trim()}
                      onClick={ingestUrl}
                      type="button"
                    >
                      Ingest URL
                    </button>
                    <button
                      className="cas-knowledge-button"
                      data-secondary="true"
                      data-test="cas-knowledge-upload-reports"
                      disabled={isRunning}
                      onClick={loadUploadReports}
                      type="button"
                    >
                      Load reports
                    </button>
                  </div>
                  <CorpusWorkbench
                    customerId={customerId}
                    openViewer={openViewer}
                    reports={corpusTargets}
                    selectDocument={selectCorpusDocument}
                    selectedDocumentId={selectedDocumentId}
                  />
                </>
              )}

              {activeKey === "rag" && (
                <>
                  <label>
                    Question
                    <textarea aria-label="RAG question" onChange={(event) => setQuestion(event.currentTarget.value)} value={question} />
                  </label>
                  <div className="cas-knowledge-actions">
                    <button className="cas-knowledge-button" data-test="cas-knowledge-rag-query" disabled={isRunning} onClick={askRag} type="button">
                      Ask RAG
                    </button>
                  </div>
                </>
              )}

              {activeKey === "llm-wiki" && (
                <>
                  <div className="cas-knowledge-fields">
                    <label>
                      Note title
                      <input aria-label="Wiki note title" onChange={(event) => setNoteTitle(event.currentTarget.value)} value={noteTitle} />
                    </label>
                  </div>
                  <label>
                    Wiki note
                    <textarea aria-label="Wiki note body" onChange={(event) => setNoteBody(event.currentTarget.value)} value={noteBody} />
                  </label>
                  <div className="cas-knowledge-actions">
                    <button className="cas-knowledge-button" data-test="cas-knowledge-wiki-loop" disabled={isRunning} onClick={runWikiLoop} type="button">
                      Run wiki loop
                    </button>
                    <button
                      className="cas-knowledge-button"
                      data-secondary="true"
                      data-test="cas-knowledge-save-note"
                      disabled={isRunning}
                      onClick={saveWikiNote}
                      type="button"
                    >
                      Save note
                    </button>
                    <button className="cas-knowledge-button" data-secondary="true" disabled={isRunning} onClick={loadVault} type="button">
                      Load vault
                    </button>
                  </div>
                </>
              )}

              {activeKey === "topology" && (
                <>
                  <div className="cas-knowledge-actions">
                    <button className="cas-knowledge-button" data-test="cas-knowledge-topology" disabled={isRunning} onClick={loadTopology} type="button">
                      Load topology
                    </button>
                    <button className="cas-knowledge-button" data-secondary="true" disabled={isRunning} onClick={loadVault} type="button">
                      Load vault
                    </button>
                  </div>
                  <TopologyDashboard
                    askAboutNode={askAboutTopologyNode}
                    customerId={customerId}
                    openViewer={openViewer}
                    selectedNodeId={selectedTopologyNodeId}
                    setSelectedNodeId={setSelectedTopologyNodeId}
                    setTypeFilter={setTopologyTypeFilter}
                    topology={renderedTopology}
                    typeFilter={topologyTypeFilter}
                  />
                </>
              )}
            </div>
            <KnowledgeViewer customerId={customerId} openViewer={openViewer} selected={selectedViewerTarget} targets={allViewerTargets} />
            {actionResult && <KnowledgeResultSummary result={actionResult} />}
          </section>

          <section className="cas-knowledge-panel">
            <div className="cas-knowledge-status">
              <h2>Knowledge API</h2>
              <span className="cas-knowledge-badge" data-state={health?.service ? "ready" : "degraded"}>
                {health?.service ?? "cas-knowledge-facade"}
              </span>
            </div>
            <CapabilityGrid capabilities={capabilities} />
          </section>
        </div>
      </section>
    </main>
  );
}
