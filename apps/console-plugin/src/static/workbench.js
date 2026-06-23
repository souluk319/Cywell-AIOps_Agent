const STORAGE_KEY = "cas:conversations:v0.1.2";
const apiBase = new URLSearchParams(window.location.search).get("apiBase") || "";

const workbench = document.querySelector(".workbench");
const thread = document.querySelector("#chat-thread");
const form = document.querySelector("#composer");
const questionEl = document.querySelector("#question");
const namespaceEl = document.querySelector("#namespace");
const kindEl = document.querySelector("#kind");
const nameEl = document.querySelector("#resource-name");
const modeButton = document.querySelector("#mode-button");
const sendButton = document.querySelector("#send-button");
const toggleSidebarButton = document.querySelector("#toggle-sidebar");
const newChatButton = document.querySelector("#new-chat");
const saveChatButton = document.querySelector("#save-chat");
const searchEl = document.querySelector("#conversation-search");
const listEl = document.querySelector("#conversation-list");
const countEl = document.querySelector("#conversation-count");

let messages = [];
let conversationId = null;
let activeSavedId = null;
let isRunning = false;
let abortController = null;

function nowIso() {
  return new Date().toISOString();
}

function loadStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveStore(items) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, 80)));
}

function target() {
  return {
    namespace: namespaceEl.value || "default",
    kind: kindEl.value || "Pod",
    name: nameEl.value || "version"
  };
}

function setTarget(nextTarget = {}) {
  namespaceEl.value = nextTarget.namespace || "default";
  kindEl.value = nextTarget.kind || "Pod";
  nameEl.value = nextTarget.name || "version";
}

function titleFromMessages() {
  const firstQuestion = messages.find((message) => message.role === "user")?.content;
  if (firstQuestion) return firstQuestion.replace(/\s+/g, " ").trim().slice(0, 54);
  const currentTarget = target();
  return `${currentTarget.namespace} ${currentTarget.kind}/${currentTarget.name}`;
}

function renderMessages() {
  thread.innerHTML = "";
  if (messages.length === 0) {
    messages = [
      {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: "CAS local workbench입니다. 왼쪽 사이드바에서 대화를 저장하고 다시 불러올 수 있습니다."
      }
    ];
  }
  for (const message of messages) {
    const article = document.createElement("article");
    article.className = "message";
    article.dataset.role = message.role;
    article.innerHTML = `
      <div class="message-role">${message.role === "user" ? "운영자" : "AI Sentinel"}</div>
      <div class="message-content"></div>
    `;
    article.querySelector(".message-content").textContent = message.content;
    thread.appendChild(article);
  }
  thread.scrollTop = thread.scrollHeight;
}

function renderConversationList() {
  const query = searchEl.value.trim().toLowerCase();
  const items = loadStore()
    .filter((item) => {
      if (!query) return true;
      const haystack = [
        item.title,
        item.target?.namespace,
        item.target?.kind,
        item.target?.name,
        ...(item.messages || []).map((message) => message.content)
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    })
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));

  countEl.textContent = String(items.length);
  listEl.innerHTML = "";
  for (const item of items) {
    const button = document.createElement("button");
    button.className = "conversation-item";
    button.type = "button";
    button.dataset.active = item.id === activeSavedId ? "true" : "false";
    button.innerHTML = `
      <strong></strong>
      <span></span>
    `;
    button.querySelector("strong").textContent = item.title || "Untitled RCA";
    button.querySelector("span").textContent = `${item.target?.namespace || "-"} · ${new Date(item.updated_at).toLocaleString("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    })}`;
    button.addEventListener("click", () => loadConversation(item.id));
    listEl.appendChild(button);
  }
}

function saveCurrentConversation() {
  const store = loadStore();
  const id = activeSavedId || `cas-conv-${Date.now()}`;
  const existing = store.find((item) => item.id === id);
  const saved = {
    id,
    title: titleFromMessages(),
    created_at: existing?.created_at || nowIso(),
    updated_at: nowIso(),
    conversation_id: conversationId,
    target: target(),
    chat_mode: modeButton.dataset.mode || "troubleshooting",
    messages
  };
  const nextStore = [saved, ...store.filter((item) => item.id !== id)];
  saveStore(nextStore);
  activeSavedId = id;
  renderConversationList();
}

function loadConversation(id) {
  const item = loadStore().find((candidate) => candidate.id === id);
  if (!item) return;
  activeSavedId = item.id;
  conversationId = item.conversation_id || null;
  messages = Array.isArray(item.messages) && item.messages.length > 0 ? item.messages : [];
  setTarget(item.target);
  modeButton.dataset.mode = item.chat_mode || "troubleshooting";
  modeButton.textContent = modeButton.dataset.mode === "ask" ? "Ask" : "Troubleshooting";
  renderMessages();
  renderConversationList();
}

function startNewConversation() {
  activeSavedId = null;
  conversationId = null;
  messages = [];
  renderMessages();
}

function appendMessage(role, content) {
  const message = {
    id: `${role}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role,
    content
  };
  messages.push(message);
  renderMessages();
  return message;
}

function updateMessage(id, content) {
  messages = messages.map((message) => (message.id === id ? { ...message, content } : message));
  renderMessages();
}

async function readSse(response, assistantId) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const rawEvent of events) {
      const lines = rawEvent.split("\n");
      const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
      const dataText = lines.find((line) => line.startsWith("data:"))?.slice(5).trim();
      if (!event || !dataText) continue;
      const data = JSON.parse(dataText);
      if (event === "status") {
        updateMessage(assistantId, data.message || "처리 중");
      }
      if (event === "token") {
        answer += data.token || "";
        updateMessage(assistantId, answer || "답변 작성 중");
      }
      if (event === "final_answer") {
        conversationId = data.conversation_id || conversationId;
        updateMessage(assistantId, data.rca_result?.answer || answer || "응답이 비어 있습니다.");
      }
      if (event === "error") {
        throw new Error(data.error || "stream error");
      }
    }
  }
}

async function submitQuestion(event) {
  event.preventDefault();
  if (isRunning) {
    abortController?.abort();
    return;
  }
  const question = questionEl.value.trim();
  if (!question) return;

  appendMessage("user", question);
  const assistant = appendMessage("assistant", "자료 확인 중");
  abortController = new AbortController();
  isRunning = true;
  sendButton.dataset.running = "true";
  sendButton.textContent = "■";

  const currentTarget = target();
  try {
    const response = await fetch(`${apiBase}/api/aiops/query`, {
      method: "POST",
      signal: abortController.signal,
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        question,
        scope: {
          cluster: "local-workbench",
          namespaces: [currentTarget.namespace]
        },
        resourceRef: {
          kind: currentTarget.kind,
          name: currentTarget.name
        },
        mode: "read_only",
        brain_mode: modeButton.dataset.mode || "troubleshooting",
        stream: true,
        locale: "ko-KR",
        conversation_id: conversationId
      })
    });
    if (!response.ok) throw new Error(`CAS Gateway HTTP ${response.status}`);
    await readSse(response, assistant.id);
    saveCurrentConversation();
  } catch (error) {
    updateMessage(assistant.id, error instanceof Error ? error.message : "요청 실패");
  } finally {
    isRunning = false;
    sendButton.dataset.running = "false";
    sendButton.textContent = "➤";
    abortController = null;
  }
}

toggleSidebarButton.addEventListener("click", () => {
  workbench.dataset.sidebar = workbench.dataset.sidebar === "open" ? "closed" : "open";
});

newChatButton.addEventListener("click", startNewConversation);
saveChatButton.addEventListener("click", saveCurrentConversation);
searchEl.addEventListener("input", renderConversationList);
modeButton.addEventListener("click", () => {
  const nextMode = modeButton.dataset.mode === "ask" ? "troubleshooting" : "ask";
  modeButton.dataset.mode = nextMode;
  modeButton.textContent = nextMode === "ask" ? "Ask" : "Troubleshooting";
});
namespaceEl.addEventListener("change", () => {
  if (namespaceEl.value === "__all_namespaces__") {
    kindEl.value = "Namespace";
    nameEl.value = "__all_namespaces__";
  }
});
form.addEventListener("submit", submitQuestion);

renderMessages();
renderConversationList();
