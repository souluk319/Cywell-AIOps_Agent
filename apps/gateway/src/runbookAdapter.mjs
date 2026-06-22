import { existsSync, readFileSync } from "node:fs";

const defaultTopK = 3;

export function getRunbookConfig(env = process.env) {
  return {
    provider: env.CAS_RUNBOOK_PROVIDER ?? "none",
    corpusPath: env.CAS_RUNBOOK_CORPUS_PATH ?? "",
    topK: Number(env.CAS_RUNBOOK_TOP_K ?? defaultTopK)
  };
}

function truncate(value, maxLength = 360) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function missingItem(type, reason) {
  return {
    type,
    reason: truncate(reason, 240)
  };
}

function evidenceItem(section, score) {
  const bookSlug = section.book_slug ?? "runbook";
  const sectionId = section.section_id ?? section.anchor_id ?? section.anchor ?? "section";
  const label = `${section.title ?? bookSlug} > ${section.section_path_label ?? section.heading ?? sectionId}`;
  const excerpt = truncate(section.text ?? section.search_text ?? "", 220);
  return {
    id: `runbook:${bookSlug}:${sectionId}`,
    type: "runbook",
    summary: truncate(excerpt ? `${label}: ${excerpt}` : label),
    source: section.viewer_path ?? section.source_uri ?? "playbookstudio.jsonl",
    observed_at: new Date().toISOString(),
    score: Number(score.toFixed(3))
  };
}

function sectionText(section = {}) {
  const blocks = Array.isArray(section.blocks) ? section.blocks : [];
  const blockText = blocks
    .map((block) => block.text ?? block.code ?? block.copy_text ?? "")
    .join(" ");
  return truncate(
    [
      section.title,
      section.heading,
      section.section_path_label,
      section.text,
      Array.isArray(section.keywords) ? section.keywords.join(" ") : "",
      blockText
    ].join(" "),
    3000
  );
}

function normalizeRecord(record = {}) {
  if (record.canonical_model === "cas_runbook_section_v1" || record.section_id) {
    return [
      {
        ...record,
        search_text: sectionText(record)
      }
    ];
  }

  if (!Array.isArray(record.sections)) return [];
  return record.sections.map((section) => ({
    book_slug: record.book_slug,
    title: record.title,
    version: record.version,
    locale: record.locale,
    source_uri: record.source_uri,
    section_id: section.section_id,
    heading: section.heading,
    section_path_label: section.section_path_label,
    viewer_path: section.viewer_path,
    blocks: section.blocks,
    search_text: sectionText({
      ...section,
      title: record.title,
      source_uri: record.source_uri
    })
  }));
}

const corpusCache = new Map();

export function loadRunbookCorpus(config = getRunbookConfig()) {
  const cacheKey = `${config.provider}:${config.corpusPath}`;
  if (corpusCache.has(cacheKey)) return corpusCache.get(cacheKey);
  if (config.provider !== "jsonl") {
    const corpus = { sections: [], missing: [missingItem("runbook", `CAS_RUNBOOK_PROVIDER=${config.provider}`)] };
    corpusCache.set(cacheKey, corpus);
    return corpus;
  }
  if (!config.corpusPath) {
    const corpus = { sections: [], missing: [missingItem("runbook", "CAS_RUNBOOK_CORPUS_PATH is not configured")] };
    corpusCache.set(cacheKey, corpus);
    return corpus;
  }
  if (!existsSync(config.corpusPath)) {
    const corpus = { sections: [], missing: [missingItem("runbook", `runbook corpus not found: ${config.corpusPath}`)] };
    corpusCache.set(cacheKey, corpus);
    return corpus;
  }

  const sections = [];
  const parseErrors = [];
  const lines = readFileSync(config.corpusPath, "utf8").split(/\r?\n/).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    try {
      sections.push(...normalizeRecord(JSON.parse(line)));
    } catch (error) {
      parseErrors.push(`line ${index + 1}: ${error?.message ?? "parse error"}`);
    }
  }

  const missing = parseErrors.length > 0 ? [missingItem("runbook", `ignored invalid JSONL records: ${parseErrors.slice(0, 2).join("; ")}`)] : [];
  const corpus = { sections, missing };
  corpusCache.set(cacheKey, corpus);
  return corpus;
}

function tokenize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^0-9a-z가-힣_./:-]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2);
}

function workloadNameHints(name) {
  const raw = String(name ?? "").toLowerCase().trim();
  if (!raw) return [];
  const hints = new Set([raw]);
  const parts = raw.split("-").filter(Boolean);
  if (parts.length >= 4) {
    hints.add(parts.slice(0, -2).join("-"));
  }
  return [...hints].filter((hint) => hint.length >= 2);
}

function queryText(input = {}) {
  const target = input.resourceRef ?? {};
  return [
    input.question,
    input.namespace,
    input.scope?.namespaces?.join(" "),
    target.kind,
    target.name,
    workloadNameHints(target.name).join(" "),
    input.cas_evidence?.evidence?.map((item) => `${item.id} ${item.summary}`).join(" ")
  ].join(" ");
}

function scoreSection(section, tokens) {
  const haystack = String(section.search_text ?? "").toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      if (token.includes("-") && token.length > 6) score += 6;
      else if (token.length > 10) score += 3;
      else if (token.length > 5) score += 2;
      else score += 1;
    }
  }
  if (section.heading && tokens.some((token) => String(section.heading).toLowerCase().includes(token))) score += 3;
  return score;
}

export async function collectRunbookEvidence(input = {}, options = {}) {
  const config = options.config ?? getRunbookConfig();
  const corpus = loadRunbookCorpus(config);
  const collection = {
    provider: config.provider,
    evidence: [],
    missing: [...corpus.missing]
  };

  if (corpus.sections.length === 0) {
    if (collection.missing.length === 0) {
      collection.missing.push(missingItem("runbook", "runbook corpus has no searchable sections"));
    }
    return collection;
  }

  const tokens = tokenize(queryText(input));
  const scored = corpus.sections
    .map((section) => ({ section, score: scoreSection(section, tokens) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, config.topK));

  const hits = scored.length > 0 ? scored : corpus.sections.slice(0, Math.max(1, config.topK)).map((section) => ({ section, score: 0.1 }));
  collection.evidence.push(...hits.map((hit) => evidenceItem(hit.section, hit.score)));
  return collection;
}
