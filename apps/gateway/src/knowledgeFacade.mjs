const KNOWLEDGE_ROUTES = {
  health: "/api/knowledge/healthz",
  capabilities: "/api/knowledge/capabilities",
  uploadIngest: "/api/knowledge/uploads/ingest",
  uploadReports: "/api/knowledge/uploads/reports",
  urlIngest: "/api/knowledge/uploads/url-ingest",
  ragQuery: "/api/knowledge/rag/query",
  wikiLoopRun: "/api/knowledge/wiki-loop/run",
  wikiVault: "/api/knowledge/wiki-vault",
  topology: "/api/knowledge/topology"
};

const KNOWLEDGE_CAPABILITIES = [
  {
    id: "customer-data-upload",
    label: "고객 데이터 업로드",
    phase: "phase-3",
    endpoint: KNOWLEDGE_ROUTES.uploadIngest,
    source: "PBS upload_api.py",
    state: "facade"
  },
  {
    id: "url-ingest",
    label: "URL ingest",
    phase: "phase-3",
    endpoint: KNOWLEDGE_ROUTES.urlIngest,
    source: "PBS url_ingest_api.py",
    state: "facade"
  },
  {
    id: "upload-reports",
    label: "업로드 리포트",
    phase: "phase-3",
    endpoint: KNOWLEDGE_ROUTES.uploadReports,
    source: "PBS upload reports",
    state: "facade"
  },
  {
    id: "rag-query",
    label: "RAG 질의",
    phase: "phase-4",
    endpoint: KNOWLEDGE_ROUTES.ragQuery,
    source: "PBS retrieval pipeline",
    state: "facade"
  },
  {
    id: "llm-wiki-loop",
    label: "LLM Wiki loop",
    phase: "phase-5",
    endpoint: KNOWLEDGE_ROUTES.wikiLoopRun,
    source: "PBS wiki_loop.py",
    state: "facade"
  },
  {
    id: "wiki-vault",
    label: "Wiki Vault",
    phase: "phase-5",
    endpoint: KNOWLEDGE_ROUTES.wikiVault,
    source: "PBS wiki_vault.py",
    state: "facade"
  },
  {
    id: "topology-dashboard",
    label: "Topology dashboard",
    phase: "phase-5",
    endpoint: KNOWLEDGE_ROUTES.topology,
    source: "PBS graph/wiki vault payload",
    state: "facade"
  }
];

export function getKnowledgeConfig(env = process.env) {
  const engineUrl = String(env.CAS_KNOWLEDGE_ENGINE_URL ?? "").trim().replace(/\/+$/, "");
  const timeoutMs = Number(env.CAS_KNOWLEDGE_ENGINE_TIMEOUT_MS ?? 30000);
  return {
    engineUrl: engineUrl || null,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000,
    provider: "playbookstudio-pbs"
  };
}

export function buildKnowledgeCapabilities() {
  return KNOWLEDGE_CAPABILITIES.map((capability) => ({ ...capability }));
}

export function buildKnowledgeHealth({ config = getKnowledgeConfig(), product } = {}) {
  const engineConfigured = Boolean(config.engineUrl);
  return {
    status: engineConfigured ? "ok" : "degraded",
    service: "cas-knowledge-facade",
    product: product ?? "Cywell AI Sentinel",
    engine: {
      provider: config.provider,
      status: engineConfigured ? "configured" : "not_configured",
      endpoint: config.engineUrl,
      timeout_ms: config.timeoutMs
    },
    routes: { ...KNOWLEDGE_ROUTES },
    capabilities: buildKnowledgeCapabilities()
  };
}

export function buildKnowledgeUnavailable(pathname, { config = getKnowledgeConfig() } = {}) {
  return {
    code: "knowledge-engine-not-configured",
    status: "pending",
    service: "cas-knowledge-facade",
    route: pathname,
    engine: {
      provider: config.provider,
      status: config.engineUrl ? "proxy-not-implemented" : "not_configured",
      endpoint: config.engineUrl,
      timeout_ms: config.timeoutMs
    },
    message: "PBS knowledge engine integration is planned for v0.1.4 follow-up phases."
  };
}
