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
};

type RouteItem = {
  key: string;
  label: string;
  href: string;
  endpoint: string;
  phase: string;
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

function topologyCandidates(value: ActionResult) {
  const topology = recordValue(value.topology);
  const topologyGraph = topology ? recordValue(topology.graph) : null;
  const graph = recordValue(value.graph);
  return [graph, topologyGraph, topology, value].filter((candidate): candidate is ActionResult => Boolean(candidate));
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
  const candidates = topologyCandidates(value);
  const candidate = candidates.find(topologyListCandidate);
  if (!candidate) return null;
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
    counts: counts as TopologyPayload["counts"] | undefined
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

function TopologyDashboard({
  topology,
  selectedNodeId,
  setSelectedNodeId,
  typeFilter,
  setTypeFilter,
  askAboutNode
}: {
  topology: TopologyPayload | null;
  selectedNodeId: string | null;
  setSelectedNodeId: (nodeId: string | null) => void;
  typeFilter: string;
  setTypeFilter: (filter: string) => void;
  askAboutNode: (node: TopologyNode) => void;
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
                  {selectedNode.viewer_path && <div className="cas-knowledge-endpoint">{selectedNode.viewer_path}</div>}
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
  const [customerId, setCustomerId] = React.useState("default");
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
  const [topologyTypeFilter, setTopologyTypeFilter] = React.useState("all");
  const [selectedTopologyNodeId, setSelectedTopologyNodeId] = React.useState<string | null>(null);
  const autoTopologyLoadKey = React.useRef("");
  const topologyRequestSequence = React.useRef(0);
  const pathname = typeof window === "undefined" ? "/cywell/customer-data" : window.location.pathname;
  const activeKey = currentRouteKey(pathname);
  const activeRoute = routeItems.find((item) => item.key === activeKey) ?? routeItems[0];
  const capabilities = health?.capabilities?.length ? health.capabilities : fallbackCapabilities;
  const renderedTopology = topologyData ?? topologyPayload(actionResult);

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
      runAction(() =>
        requestJson("/api/knowledge/uploads/ingest", {
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
        })
      ),
    [customerId, runAction, selectedFileBase64, selectedFileMimeType, selectedFileName, uploadContent, uploadTitle]
  );

  const ingestUrl = React.useCallback(
    () =>
      runAction(() =>
        requestJson("/api/knowledge/uploads/url-ingest", {
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
        })
      ),
    [customerId, runAction, urlValue]
  );

  const loadUploadReports = React.useCallback(
    () => runAction(() => requestJson(`/api/knowledge/uploads/reports?customer_id=${encodeURIComponent(customerId)}`)),
    [customerId, runAction]
  );

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
            question
          })
        })
      ),
    [customerId, question, runAction]
  );

  const runWikiLoop = React.useCallback(
    () =>
      runAction(() =>
        requestJson("/api/knowledge/wiki-loop/run", {
          method: "POST",
          body: JSON.stringify({ customer_id: customerId })
        })
      ),
    [customerId, runAction]
  );

  const saveWikiNote = React.useCallback(
    () =>
      runAction(() =>
        requestJson("/api/knowledge/wiki-vault/notes", {
          method: "POST",
          body: JSON.stringify({
            customer_id: customerId,
            title: noteTitle,
            body: noteBody
          })
        })
      ),
    [customerId, noteBody, noteTitle, runAction]
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
      const activeDocumentId =
        node.document_source_id ||
        node.source_document_id ||
        node.document_id ||
        (nodeTone(node.type) === "document" ? node.id : "");
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
            enabled_upload_document_ids: activeDocumentId ? [activeDocumentId] : undefined,
            enabled_source_scopes: node.source_scope ? [node.source_scope] : undefined,
            restrict_uploaded_sources: Boolean(activeDocumentId)
          })
        })
      );
    },
    [customerId, runAction]
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
            <a aria-current={item.key === activeKey ? "page" : undefined} data-active={item.key === activeKey} href={item.href} key={item.key}>
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
              <div className="cas-knowledge-fields">
                <label>
                  Customer ID
                  <input
                    aria-label="Customer ID"
                    onChange={(event) => setCustomerId(event.currentTarget.value)}
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
                    selectedNodeId={selectedTopologyNodeId}
                    setSelectedNodeId={setSelectedTopologyNodeId}
                    setTypeFilter={setTopologyTypeFilter}
                    topology={renderedTopology}
                    typeFilter={topologyTypeFilter}
                  />
                </>
              )}
            </div>
            {actionResult && (
              <pre className="cas-knowledge-result" data-test="cas-knowledge-result" role={actionResult.status === "error" ? "alert" : undefined}>
                {prettyJson(actionResult)}
              </pre>
            )}
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
