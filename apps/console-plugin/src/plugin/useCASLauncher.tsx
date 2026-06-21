import * as React from "react";
import { useModal } from "@openshift-console/dynamic-plugin-sdk";

const API_BASE = "/api/proxy/plugin/cywell-ai-sentinel/cas-api";

type CauseCandidate = {
  cause: string;
  confidence: number;
  evidence_refs?: string[];
};

type EvidenceItem = {
  id: string;
  source: string;
  summary: string;
};

type RCAResult = {
  run_id?: string;
  mode?: string;
  rca_result?: {
    answer?: string;
    cause_candidates?: CauseCandidate[];
  };
  evidence_bundle?: {
    evidence?: EvidenceItem[];
    missing?: Array<{ type: string; reason: string }>;
  };
};

const styles = `
.cas-launcher-root {
  --cas-ink: #14202b;
  --cas-muted: #5d6c7b;
  --cas-line: #d6dee8;
  --cas-surface: #ffffff;
  --cas-soft: #f5f8fb;
  --cas-accent: #087f8c;
  --cas-accent-strong: #055f6a;
  color: var(--cas-ink);
  font-family: var(--pf-t--global--font--family--body, "Red Hat Text", "Noto Sans KR", "Segoe UI", Arial, sans-serif);
}

.cas-launcher-button {
  align-items: center;
  background: var(--cas-surface);
  border: 1px solid rgba(8, 127, 140, 0.24);
  border-radius: 12px;
  bottom: var(--pf-t--global--spacer--lg, 24px);
  box-shadow: var(--pf-t--global--box-shadow--lg, 0 10px 28px rgba(3, 22, 30, 0.22));
  color: var(--cas-accent);
  cursor: pointer;
  display: inline-flex;
  height: var(--pf-t--global--spacer--2xl, 48px);
  justify-content: center;
  padding: 0;
  position: fixed;
  right: var(--pf-t--global--spacer--lg, 24px);
  width: var(--pf-t--global--spacer--2xl, 48px);
  z-index: var(--pf-t--global--z-index--md, 300);
}

.cas-launcher-button:hover,
.cas-launcher-button:focus {
  border-color: var(--cas-accent);
  color: var(--cas-accent-strong);
  outline: 2px solid rgba(8, 127, 140, 0.22);
  outline-offset: 2px;
}

.cas-launcher-button svg {
  height: 30px;
  width: 30px;
}

.cas-panel {
  background: var(--cas-surface);
  border: 1px solid var(--cas-line);
  border-radius: 8px;
  bottom: calc(var(--pf-t--global--spacer--2xl, 48px) + var(--pf-t--global--spacer--lg, 24px) + 10px);
  box-shadow: var(--pf-t--global--box-shadow--lg, 0 18px 44px rgba(3, 22, 30, 0.24));
  max-height: min(720px, calc(100vh - 112px));
  overflow: hidden;
  position: fixed;
  right: var(--pf-t--global--spacer--lg, 24px);
  width: min(520px, calc(100vw - 32px));
  z-index: calc(var(--pf-t--global--z-index--md, 300) + 1);
}

.cas-panel-header {
  align-items: center;
  border-bottom: 1px solid var(--cas-line);
  display: flex;
  gap: 12px;
  padding: 14px 16px;
}

.cas-panel-title {
  flex: 1;
  min-width: 0;
}

.cas-panel-title strong,
.cas-result strong,
.cas-evidence strong {
  display: block;
}

.cas-panel-title span,
.cas-status,
.cas-meta,
.cas-evidence span {
  color: var(--cas-muted);
  font-size: 12px;
}

.cas-close {
  align-items: center;
  background: transparent;
  border: 0;
  color: var(--cas-muted);
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  height: 32px;
  justify-content: center;
  padding: 0;
  width: 32px;
}

.cas-panel-body {
  display: grid;
  gap: 12px;
  max-height: calc(min(720px, calc(100vh - 112px)) - 65px);
  overflow: auto;
  padding: 14px 16px 16px;
}

.cas-form {
  display: grid;
  gap: 10px;
}

.cas-form textarea,
.cas-form input {
  border: 1px solid var(--cas-line);
  border-radius: 4px;
  color: var(--cas-ink);
  font: inherit;
  padding: 9px 10px;
  width: 100%;
}

.cas-form textarea {
  min-height: 82px;
  resize: vertical;
}

.cas-fields {
  display: grid;
  gap: 8px;
  grid-template-columns: 1fr 1fr;
}

.cas-submit {
  background: var(--cas-accent);
  border: 0;
  border-radius: 4px;
  color: #fff;
  cursor: pointer;
  font: inherit;
  font-weight: 700;
  padding: 10px 12px;
}

.cas-submit:disabled {
  cursor: progress;
  opacity: 0.68;
}

.cas-result,
.cas-evidence {
  background: var(--cas-soft);
  border: 1px solid var(--cas-line);
  border-radius: 6px;
  padding: 12px;
}

.cas-answer {
  margin: 8px 0 0;
  white-space: pre-wrap;
}

.cas-cause-list,
.cas-evidence-list {
  display: grid;
  gap: 8px;
  margin-top: 10px;
}

.cas-cause,
.cas-evidence-item {
  background: #fff;
  border: 1px solid var(--cas-line);
  border-radius: 4px;
  padding: 10px;
}

@media (max-width: 620px) {
  .cas-panel {
    bottom: calc(var(--pf-t--global--spacer--2xl, 48px) + 22px);
    right: 8px;
    width: calc(100vw - 16px);
  }

  .cas-launcher-button {
    bottom: 12px;
    right: 12px;
  }

  .cas-fields {
    grid-template-columns: 1fr;
  }
}
`;

function SentinelIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" role="img">
      <path
        d="M24 5.5 38 10v11.4c0 9.1-5.4 16.8-14 21.1-8.6-4.3-14-12-14-21.1V10l14-4.5Z"
        fill="currentColor"
        opacity="0.16"
      />
      <path
        d="M24 6.5 37 11v10.2c0 8.2-5 15.1-13 19-8-3.9-13-10.8-13-19V11l13-4.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path d="M16 25.5h16M19.5 18.5h9M19.5 32.5h9" stroke="currentColor" strokeLinecap="round" strokeWidth="3" />
      <circle cx="33.5" cy="18.5" r="3" fill="currentColor" />
    </svg>
  );
}

function CASLauncher() {
  const [isOpen, setIsOpen] = React.useState(false);
  const [question, setQuestion] = React.useState("default namespace의 api pod가 왜 재시작됐어?");
  const [namespace, setNamespace] = React.useState("default");
  const [pod, setPod] = React.useState("api-7c8d9");
  const [status, setStatus] = React.useState("ready");
  const [result, setResult] = React.useState<RCAResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const runQuery = React.useCallback(
    async (event?: React.FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      setStatus("running");
      setError(null);
      setResult(null);

      try {
        const response = await fetch(`${API_BASE}/api/aiops/query`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            question,
            scope: {
              cluster: "local-cluster",
              namespaces: [namespace || "default"]
            },
            resourceRef: {
              kind: "Pod",
              name: pod || "api-7c8d9"
            },
            mode: "read_only",
            stream: false,
            locale: "ko-KR"
          })
        });

        if (!response.ok) {
          throw new Error(`CAS Gateway HTTP ${response.status}`);
        }

        const body = (await response.json()) as RCAResult;
        setResult(body);
        setStatus(body.mode || "complete");
      } catch (queryError) {
        setError(queryError instanceof Error ? queryError.message : "분석 요청에 실패했습니다.");
        setStatus("error");
      }
    },
    [namespace, pod, question]
  );

  const causes = result?.rca_result?.cause_candidates ?? [];
  const evidence = result?.evidence_bundle?.evidence ?? [];

  return (
    <div className="cas-launcher-root" data-test="cas-launcher-root">
      <style>{styles}</style>
      {isOpen && (
        <section aria-label="Cywell AI Sentinel" className="cas-panel" data-test="cas-launcher-panel" role="dialog">
          <header className="cas-panel-header">
            <SentinelIcon />
            <div className="cas-panel-title">
              <strong>Cywell AI Sentinel</strong>
              <span>OpenShift RCA Agent · Lightspeed-backed</span>
            </div>
            <button aria-label="Close AI Sentinel" className="cas-close" onClick={() => setIsOpen(false)} type="button">
              x
            </button>
          </header>
          <div className="cas-panel-body">
            <form className="cas-form" onSubmit={runQuery}>
              <textarea
                aria-label="AI Sentinel question"
                onChange={(event) => setQuestion(event.currentTarget.value)}
                value={question}
              />
              <div className="cas-fields">
                <input
                  aria-label="Namespace"
                  onChange={(event) => setNamespace(event.currentTarget.value)}
                  placeholder="namespace"
                  value={namespace}
                />
                <input
                  aria-label="Pod"
                  onChange={(event) => setPod(event.currentTarget.value)}
                  placeholder="pod"
                  value={pod}
                />
              </div>
              <button className="cas-submit" data-test="cas-run-analysis" disabled={status === "running"} type="submit">
                {status === "running" ? "Analyzing" : "Run RCA"}
              </button>
            </form>

            <div className="cas-status" data-test="cas-launcher-status">
              상태: {status}
              {result?.run_id ? ` · ${result.run_id}` : ""}
            </div>

            {(result || error) && (
              <article className="cas-result" data-test="cas-rca-result">
                <strong>분석 결과</strong>
                <p className="cas-answer">{error ?? result?.rca_result?.answer ?? "응답이 비어 있습니다."}</p>
                {causes.length > 0 && (
                  <div className="cas-cause-list">
                    {causes.map((cause) => (
                      <div className="cas-cause" key={cause.cause}>
                        <strong>{cause.cause}</strong>
                        <div className="cas-meta">
                          confidence {Math.round(Number(cause.confidence || 0) * 100)}% · evidence{" "}
                          {(cause.evidence_refs ?? []).join(", ")}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </article>
            )}

            {evidence.length > 0 && (
              <article className="cas-evidence">
                <strong>증적</strong>
                <div className="cas-evidence-list">
                  {evidence.map((item) => (
                    <div className="cas-evidence-item" key={item.id}>
                      <strong>{item.id}</strong>
                      <div>{item.summary}</div>
                      <span>{item.source}</span>
                    </div>
                  ))}
                </div>
              </article>
            )}
          </div>
        </section>
      )}
      <button
        aria-label="Cywell AI Sentinel"
        className="cas-launcher-button"
        data-test="cas-launcher-button"
        onClick={() => setIsOpen((current) => !current)}
        title="Cywell AI Sentinel"
        type="button"
      >
        <SentinelIcon />
      </button>
    </div>
  );
}

function CASLauncherMount() {
  return <CASLauncher />;
}

export function useCASLauncher() {
  const launchModal = useModal();
  const launchedRef = React.useRef(false);

  React.useEffect(() => {
    if (!launchedRef.current && launchModal) {
      launchModal(CASLauncherMount, {}, "cywell-ai-sentinel-launcher");
      launchedRef.current = true;
    }
  }, [launchModal]);

  return null;
}

export default useCASLauncher;
