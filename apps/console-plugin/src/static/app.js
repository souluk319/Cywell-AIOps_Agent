const params = new URLSearchParams(window.location.search);
const apiBase = params.get("apiBase") || "http://127.0.0.1:8080";

const form = document.querySelector("#query-form");
const statusEl = document.querySelector("#status");
const answerEl = document.querySelector("#answer");
const runIdEl = document.querySelector("#run-id");
const causeCardsEl = document.querySelector("#cause-cards");
const evidenceListEl = document.querySelector("#evidence-list");

function setStatus(text) {
  statusEl.textContent = text;
}

function renderRun(run) {
  runIdEl.textContent = run.run_id || "unknown run";
  answerEl.textContent = run.rca_result?.answer || "응답이 비어 있습니다.";
  causeCardsEl.innerHTML = "";
  evidenceListEl.innerHTML = "";

  for (const item of run.rca_result?.cause_candidates || []) {
    const card = document.createElement("article");
    card.className = "cause-card";
    card.innerHTML = `
      <strong>${item.cause}</strong>
      <div class="confidence">confidence ${Math.round(Number(item.confidence || 0) * 100)}%</div>
      <div class="source">evidence: ${(item.evidence_refs || []).join(", ")}</div>
    `;
    causeCardsEl.appendChild(card);
  }

  for (const item of run.evidence_bundle?.evidence || []) {
    const evidence = document.createElement("article");
    evidence.className = "evidence-item";
    evidence.innerHTML = `
      <strong>${item.id}</strong>
      <div>${item.summary}</div>
      <div class="source">${item.source}</div>
    `;
    evidenceListEl.appendChild(evidence);
  }

  for (const item of run.evidence_bundle?.missing || []) {
    const missing = document.createElement("article");
    missing.className = "evidence-item";
    missing.innerHTML = `
      <strong>missing: ${item.type}</strong>
      <div>${item.reason}</div>
      <div class="source">partial evidence</div>
    `;
    evidenceListEl.appendChild(missing);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("running");
  answerEl.textContent = "분석 중입니다.";
  causeCardsEl.innerHTML = "";
  evidenceListEl.innerHTML = "";

  const question = document.querySelector("#question").value;
  const namespace = document.querySelector("#namespace").value || "default";
  const pod = document.querySelector("#pod").value || "api-7c8d9";

  try {
    const response = await fetch(`${apiBase}/api/aiops/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question,
        scope: {
          cluster: "local-cluster",
          namespaces: [namespace]
        },
        resourceRef: {
          kind: "Pod",
          name: pod
        },
        mode: "read_only",
        stream: false,
        locale: "ko-KR"
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const run = await response.json();
    renderRun(run);
    setStatus(run.mode || "complete");
  } catch (error) {
    setStatus("error");
    answerEl.textContent = error instanceof Error ? error.message : "분석 요청에 실패했습니다.";
  }
});

