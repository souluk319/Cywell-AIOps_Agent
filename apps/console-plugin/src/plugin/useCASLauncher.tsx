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

type MissingEvidence = {
  type: string;
  reason: string;
};

type RCAResult = {
  run_id?: string;
  mode?: string;
  conversation_id?: string | null;
  audit?: {
    answer_provider?: string;
    brain?: {
      provider?: string;
      status?: string;
      endpoint?: string;
    };
  };
  rca_result?: {
    answer?: string;
    cause_candidates?: CauseCandidate[];
  };
  evidence_bundle?: {
    evidence?: EvidenceItem[];
    missing?: MissingEvidence[];
  };
};

type BrainStatus = {
  state: "checking" | "ready" | "degraded";
  provider: string;
  detail: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  result?: RCAResult;
};

const initialQuestion = "ClusterVersion 상태를 한 문장으로 요약해줘.";
const lightspeedLauncherSelectors = [
  '[data-test="lightspeed-launcher-button"]',
  '[data-test="lightspeed-chat-button"]',
  '[data-test="ols-chatbot-button"]',
  '[data-test*="lightspeed" i]',
  '[data-test*="ols-chatbot" i]',
  '[data-test*="openshift-lightspeed" i]',
  '[aria-label*="Lightspeed" i]',
  '[title*="Lightspeed" i]',
  '[id*="lightspeed" i]',
  '[id*="ols-chatbot" i]',
  '[class*="lightspeed" i]',
  '[class*="ols-chatbot" i]',
  ".ols-chatbot-button",
  "#ols-chatbot-button"
];
const lightspeedLauncherRootSelector = [
  "button",
  '[role="button"]',
  "a",
  '[data-test*="launcher" i]',
  '[data-test*="lightspeed" i]',
  '[data-test*="ols-chatbot" i]',
  '[data-test*="openshift-lightspeed" i]',
  '[id*="lightspeed" i]',
  '[id*="ols-chatbot" i]',
  '[class*="launcher" i]',
  '[class*="lightspeed" i]',
  '[class*="ols-chatbot" i]'
].join(",");

const styles = `
.cas-launcher-root {
  --cas-ink: #16212c;
  --cas-muted: #5a6877;
  --cas-line: #d7dee7;
  --cas-surface: #ffffff;
  --cas-soft: #f5f7fa;
  --cas-soft-strong: #edf4f6;
  --cas-accent: #087f8c;
  --cas-accent-strong: #05606a;
  --cas-warning: #a66200;
  --cas-danger: #b1382e;
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
  max-height: min(760px, calc(100vh - 112px));
  overflow: hidden;
  position: fixed;
  right: var(--pf-t--global--spacer--lg, 24px);
  width: min(560px, calc(100vw - 32px));
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
.cas-section-title,
.cas-message strong,
.cas-evidence-item strong {
  display: block;
}

.cas-panel-title span,
.cas-meta,
.cas-evidence-item span,
.cas-conversation {
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
  max-height: calc(min(760px, calc(100vh - 112px)) - 65px);
  overflow: auto;
  padding: 14px 16px 16px;
}

.cas-status-row {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.cas-badge {
  align-items: center;
  background: var(--cas-soft-strong);
  border: 1px solid var(--cas-line);
  border-radius: 999px;
  color: var(--cas-muted);
  display: inline-flex;
  font-size: 12px;
  gap: 6px;
  line-height: 1;
  padding: 6px 8px;
}

.cas-badge[data-state="ready"] {
  color: var(--cas-accent-strong);
}

.cas-badge[data-state="degraded"] {
  color: var(--cas-warning);
}

.cas-chat-thread {
  display: grid;
  gap: 10px;
}

.cas-message {
  border: 1px solid var(--cas-line);
  border-radius: 8px;
  display: grid;
  gap: 8px;
  padding: 11px 12px;
}

.cas-message[data-role="user"] {
  background: #f7fbfc;
  border-color: rgba(8, 127, 140, 0.26);
}

.cas-message[data-role="assistant"] {
  background: var(--cas-soft);
}

.cas-message[data-role="system"] {
  background: #fff8ed;
  border-color: rgba(166, 98, 0, 0.24);
}

.cas-answer {
  margin: 0;
  white-space: pre-wrap;
}

.cas-cause-list,
.cas-evidence-list,
.cas-missing-list {
  display: grid;
  gap: 8px;
}

.cas-cause,
.cas-evidence-item,
.cas-missing-item {
  background: #fff;
  border: 1px solid var(--cas-line);
  border-radius: 6px;
  padding: 9px 10px;
}

.cas-missing-item {
  border-color: rgba(166, 98, 0, 0.24);
}

.cas-compose {
  border-top: 1px solid var(--cas-line);
  display: grid;
  gap: 10px;
  padding-top: 12px;
}

.cas-compose textarea,
.cas-compose input {
  border: 1px solid var(--cas-line);
  border-radius: 4px;
  color: var(--cas-ink);
  font: inherit;
  padding: 9px 10px;
  width: 100%;
}

.cas-compose textarea {
  min-height: 80px;
  resize: vertical;
}

.cas-fields {
  display: grid;
  gap: 8px;
  grid-template-columns: 1fr 1fr;
}

.cas-actions {
  align-items: center;
  display: flex;
  gap: 8px;
  justify-content: space-between;
}

.cas-submit,
.cas-secondary {
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
  font-weight: 700;
  padding: 9px 12px;
}

.cas-submit {
  background: var(--cas-accent);
  border: 0;
  color: #fff;
}

.cas-secondary {
  background: #fff;
  border: 1px solid var(--cas-line);
  color: var(--cas-muted);
}

.cas-submit:disabled,
.cas-secondary:disabled {
  cursor: progress;
  opacity: 0.68;
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

  .cas-fields,
  .cas-actions {
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

function createMessageId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function modeLabel(mode?: string) {
  if (mode === "lightspeed_read_only") return "Lightspeed real answer";
  if (mode === "lightspeed_fallback_mock") return "Fallback mock RCA";
  if (mode === "mock_read_only") return "Mock RCA";
  return mode || "ready";
}

function resultProvider(result?: RCAResult) {
  return result?.audit?.answer_provider ?? result?.audit?.brain?.provider ?? "cas-gateway";
}

function normalizeQuestion(value: string) {
  return value.trim() || initialQuestion;
}

function EvidenceSummary({ result }: { result: RCAResult }) {
  const causes = result.rca_result?.cause_candidates ?? [];
  const evidence = result.evidence_bundle?.evidence ?? [];
  const missing = result.evidence_bundle?.missing ?? [];

  return (
    <>
      {causes.length > 0 && (
        <div className="cas-cause-list" data-test="cas-cause-list">
          {causes.map((cause) => (
            <div className="cas-cause" key={`${cause.cause}-${cause.confidence}`}>
              <strong>{cause.cause}</strong>
              <div className="cas-meta">
                confidence {Math.round(Number(cause.confidence || 0) * 100)}% · evidence{" "}
                {(cause.evidence_refs ?? []).join(", ") || "none"}
              </div>
            </div>
          ))}
        </div>
      )}

      {evidence.length > 0 && (
        <div className="cas-evidence-list" data-test="cas-evidence-panel">
          <strong className="cas-section-title">증적</strong>
          {evidence.map((item) => (
            <div className="cas-evidence-item" key={item.id}>
              <strong>{item.id}</strong>
              <div>{item.summary}</div>
              <span>{item.source}</span>
            </div>
          ))}
        </div>
      )}

      {missing.length > 0 && (
        <div className="cas-missing-list" data-test="cas-missing-evidence">
          <strong className="cas-section-title">부족한 증적</strong>
          {missing.map((item) => (
            <div className="cas-missing-item" key={`${item.type}-${item.reason}`}>
              <strong>{item.type}</strong>
              <div className="cas-meta">{item.reason}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function CASLauncher() {
  const [isOpen, setIsOpen] = React.useState(false);
  const [question, setQuestion] = React.useState(initialQuestion);
  const [namespace, setNamespace] = React.useState("default");
  const [resourceName, setResourceName] = React.useState("version");
  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const [isRunning, setIsRunning] = React.useState(false);
  const [brainStatus, setBrainStatus] = React.useState<BrainStatus>({
    state: "checking",
    provider: "openshift-lightspeed",
    detail: "연결 확인 중"
  });
  const [messages, setMessages] = React.useState<ChatMessage[]>([
    {
      id: "system-ready",
      role: "system",
      content: "CAS가 OpenShift Lightspeed 기능을 내부 뇌로 사용해 읽기 전용 분석을 수행합니다."
    }
  ]);

  React.useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const suppressed = new Map<HTMLElement, { display: string; ariaHidden: string | null }>();
    const suppressLightspeedLaunchers = () => {
      for (const selector of lightspeedLauncherSelectors) {
        document.querySelectorAll<HTMLElement>(selector).forEach((element) => {
          const launcher = element.closest<HTMLElement>(lightspeedLauncherRootSelector) ?? element;
          if (launcher.closest(".cas-launcher-root") || suppressed.has(launcher)) return;
          suppressed.set(launcher, {
            display: launcher.style.getPropertyValue("display"),
            ariaHidden: launcher.getAttribute("aria-hidden")
          });
          launcher.style.setProperty("display", "none", "important");
          launcher.setAttribute("aria-hidden", "true");
          launcher.setAttribute("data-cas-suppressed-lightspeed", "true");
        });
      }
    };
    suppressLightspeedLaunchers();
    const observer = new MutationObserver(suppressLightspeedLaunchers);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      suppressed.forEach((previous, element) => {
        if (previous.display) element.style.setProperty("display", previous.display);
        else element.style.removeProperty("display");
        if (previous.ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", previous.ariaHidden);
        element.removeAttribute("data-cas-suppressed-lightspeed");
      });
    };
  }, []);

  const refreshBrainStatus = React.useCallback(async () => {
    setBrainStatus((current) => ({ ...current, state: "checking", detail: "연결 확인 중" }));
    try {
      const response = await fetch(`${API_BASE}/api/aiops/brainz`, {
        headers: { accept: "application/json" }
      });
      const body = await response.json();
      const provider = body?.brain?.provider ?? "openshift-lightspeed";
      if (!response.ok || body?.status !== "ok") {
        setBrainStatus({
          state: "degraded",
          provider,
          detail: "Gateway는 응답하지만 Lightspeed readiness가 degraded입니다."
        });
        return;
      }
      setBrainStatus({
        state: "ready",
        provider,
        detail: "OpenShift Lightspeed readiness 확인됨"
      });
    } catch (error) {
      setBrainStatus({
        state: "degraded",
        provider: "openshift-lightspeed",
        detail: error instanceof Error ? error.message : "brainz 확인 실패"
      });
    }
  }, []);

  React.useEffect(() => {
    if (isOpen) void refreshBrainStatus();
  }, [isOpen, refreshBrainStatus]);

  const runQuery = React.useCallback(
    async (event?: React.FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      const submittedQuestion = normalizeQuestion(question);
      const userMessage: ChatMessage = {
        id: createMessageId("user"),
        role: "user",
        content: submittedQuestion
      };
      const pendingMessageId = createMessageId("assistant");
      setMessages((current) => [
        ...current,
        userMessage,
        {
          id: pendingMessageId,
          role: "assistant",
          content: "분석 중입니다. Gateway를 통해 Lightspeed brain에 질의하고 있습니다."
        }
      ]);
      setIsRunning(true);

      try {
        const response = await fetch(`${API_BASE}/api/aiops/query`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json"
          },
          body: JSON.stringify({
            question: submittedQuestion,
            scope: {
              cluster: "local-cluster",
              namespaces: [namespace || "default"]
            },
            resourceRef: {
              kind: resourceName === "version" ? "ClusterVersion" : "Pod",
              name: resourceName || "version"
            },
            mode: "read_only",
            stream: false,
            locale: "ko-KR",
            conversation_id: conversationId
          })
        });

        if (!response.ok) {
          throw new Error(`CAS Gateway HTTP ${response.status}`);
        }

        const body = (await response.json()) as RCAResult;
        setConversationId(body.conversation_id ?? conversationId);
        setMessages((current) =>
          current.map((message) =>
            message.id === pendingMessageId
              ? {
                  ...message,
                  content: body.rca_result?.answer ?? "Gateway 응답은 도착했지만 answer 필드가 비어 있습니다.",
                  result: body
                }
              : message
          )
        );
      } catch (queryError) {
        setMessages((current) =>
          current.map((message) =>
            message.id === pendingMessageId
              ? {
                  ...message,
                  content: queryError instanceof Error ? queryError.message : "분석 요청에 실패했습니다."
                }
              : message
          )
        );
      } finally {
        setIsRunning(false);
      }
    },
    [conversationId, namespace, question, resourceName]
  );

  const resetConversation = React.useCallback(() => {
    setConversationId(null);
    setMessages([
      {
        id: "system-ready",
        role: "system",
        content: "새 대화를 시작했습니다. CAS는 읽기 전용 분석만 수행합니다."
      }
    ]);
  }, []);

  return (
    <div className="cas-launcher-root" data-test="cas-launcher-root">
      <style>{styles}</style>
      {isOpen && (
        <section aria-label="Cywell AI Sentinel" className="cas-panel" data-test="cas-launcher-panel" role="dialog">
          <header className="cas-panel-header">
            <SentinelIcon />
            <div className="cas-panel-title">
              <strong>Cywell AI Sentinel</strong>
              <span>OpenShift RCA Agent · Lightspeed replacement</span>
            </div>
            <button aria-label="Close AI Sentinel" className="cas-close" onClick={() => setIsOpen(false)} type="button">
              x
            </button>
          </header>

          <div className="cas-panel-body">
            <div className="cas-status-row">
              <span className="cas-badge" data-state={brainStatus.state} data-test="cas-brain-status">
                {brainStatus.state === "checking" ? "checking" : brainStatus.state} · {brainStatus.provider}
              </span>
              <span className="cas-badge" data-test="cas-provider-badge">
                UserToken proxy
              </span>
              {conversationId && (
                <span className="cas-conversation" data-test="cas-conversation-id">
                  conversation {conversationId}
                </span>
              )}
            </div>

            <div className="cas-meta">{brainStatus.detail}</div>

            <div className="cas-chat-thread" data-test="cas-chat-thread">
              {messages.map((message) => {
                const isFallback = message.result?.mode === "lightspeed_fallback_mock";
                return (
                  <article
                    className="cas-message"
                    data-role={message.role}
                    data-test={`cas-message-${message.role}`}
                    key={message.id}
                  >
                    <strong>{message.role === "user" ? "운영자" : message.role === "assistant" ? "AI Sentinel" : "시스템"}</strong>
                    <p className="cas-answer">{message.content}</p>
                    {message.result && (
                      <>
                        <div className="cas-meta">
                          {modeLabel(message.result.mode)} · provider {resultProvider(message.result)}
                          {message.result.run_id ? ` · ${message.result.run_id}` : ""}
                        </div>
                        {isFallback && (
                          <div className="cas-badge" data-state="degraded" data-test="cas-fallback-notice">
                            fallback active
                          </div>
                        )}
                        <EvidenceSummary result={message.result} />
                      </>
                    )}
                  </article>
                );
              })}
            </div>

            <form className="cas-compose" onSubmit={runQuery}>
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
                  aria-label="Resource name"
                  onChange={(event) => setResourceName(event.currentTarget.value)}
                  placeholder="resource"
                  value={resourceName}
                />
              </div>
              <div className="cas-actions">
                <button className="cas-secondary" disabled={isRunning} onClick={resetConversation} type="button">
                  새 대화
                </button>
                <button className="cas-submit" data-test="cas-run-analysis" disabled={isRunning} type="submit">
                  {isRunning ? "분석 중" : "질의"}
                </button>
              </div>
            </form>
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
