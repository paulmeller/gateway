// ═══════════════════════════════════════════════════════════════════
// AgentStep Gateway UI — single-file SPA
// ═══════════════════════════════════════════════════════════════════

// ── State ──
let apiKey = window.__MA_API_KEY__ || localStorage.getItem("ma-api-key") || "";
if (window.__MA_API_KEY__) localStorage.setItem("ma-api-key", apiKey);

let sessions = [];
let activeSessionId = null;
let sseAbort = null;
let sseLastSeq = 0;
let sseReconnectTimer = null;
let sseReconnectDelay = 1000;
let isRunning = false;
let agents = [];
let environments = [];
let allEvents = [];
let expandedEventIds = new Set();
let seenEventSeqs = new Set();
let lastAppendedRole = "";
let pendingUserTexts = new Set();
let onboardingStep = 0;
let onboardVaultId = null;
let onboardEngine = "claude";
let onboardProvider = "docker";
let vaults = [];

const MODELS = {
  claude: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"],
  opencode: ["anthropic/claude-sonnet-4-6", "openai/gpt-4o-mini"],
  codex: ["gpt-5.4-mini", "gpt-5.4"],
  gemini: ["gemini-3.1-pro-preview", "gemini-3", "gemini-2.5-flash"],
  factory: ["claude-sonnet-4-6", "gpt-5.4", "gemini-3.1-pro-preview"],
};

const PROVIDER_TOKENS = {
  sprites: { key: "SPRITE_TOKEN", label: "Sprites.dev Token", placeholder: "user/org/.../token" },
  e2b: { key: "E2B_API_KEY", label: "E2B API Key", placeholder: "e2b_..." },
  vercel: { key: "VERCEL_TOKEN", label: "Vercel Token", placeholder: "..." },
  daytona: { key: "DAYTONA_API_KEY", label: "Daytona API Key", placeholder: "..." },
  fly: { key: "FLY_API_TOKEN", label: "Fly.io API Token", placeholder: "fo1_..." },
  modal: { key: "MODAL_TOKEN_ID", label: "Modal Token ID", placeholder: "..." },
};

// ── Util ──
function esc(s) {
  if (!s) return "";
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function $(id) { return document.getElementById(id); }

function renderMarkdown(text) {
  if (typeof marked !== "undefined" && typeof DOMPurify !== "undefined") {
    return DOMPurify.sanitize(marked.parse(text));
  }
  return esc(text);
}

// ── API wrapper ──
async function api(path, opts = {}) {
  const headers = { "content-type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;
  const res = await fetch(path, { ...opts, headers: { ...headers, ...opts.headers } });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const e = await res.json(); if (e.error?.message) msg = e.error.message; } catch {}
    if (res.status === 401) showToast(msg, "error");
    throw new Error(msg);
  }
  return res.json();
}

// ── Toast ──
function showToast(msg, type = "success") {
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ── Init ──
$("apiKeyInput").value = apiKey;
$("apiKeyInput").addEventListener("input", (e) => {
  apiKey = e.target.value;
  localStorage.setItem("ma-api-key", apiKey);
});

// Event delegation — handle all clicks via data attributes
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  const id = el.dataset.id;
  const key = el.dataset.key;

  switch (action) {
    case "select-session": selectSession(id); break;
    case "delete-session": deleteSession(id); break;
    case "archive-session": archiveSession(id); break;
    case "delete-agent": deleteAgent(id); break;
    case "agent-config": showAgentConfig(id); break;
    case "edit-agent": showEditAgentModal(id); break;
    case "delete-env": deleteEnv(id); break;
    case "delete-vault": deleteVault(id); break;
    case "add-entry": showAddEntryModal(id); break;
    case "edit-entry": editVaultEntry(id, key); break;
    case "delete-entry": deleteVaultEntry(id, key); break;
    case "toggle-event": toggleEvent(id); break;
    case "close-modal": closeModal(); break;
    case "back-to-config": backToConfig(); break;
  }
});

// Tab switching
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => switchTab(t.dataset.tab))
);

// Textarea auto-grow
$("chatInput").addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 150) + "px";
});

if (apiKey) checkOnboarding();

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${name}`));
  const params = new URLSearchParams(window.location.search);
  if (name === "chat") params.delete("tab"); else params.set("tab", name);
  const qs = params.toString();
  history.pushState(null, "", qs ? `/?${qs}` : "/");
  if (name === "config") { activeAgentId = null; renderConfigLayout(); }
  if (name === "events") loadSessionsForEvents();
}

function toggleKeyVisibility() {
  const el = $("apiKeyInput");
  el.type = el.type === "password" ? "text" : "password";
}

// ═══════════════════════════════════════════════════════════════════
// ONBOARDING
// ═══════════════════════════════════════════════════════════════════

async function checkOnboarding() {
  try {
    const [a, e] = await Promise.all([api("/v1/agents?limit=1"), api("/v1/environments?limit=1")]);
    if ((a.data || []).length === 0 || (e.data || []).filter(x => x.state === "ready").length === 0) {
      agents = a.data || [];
      environments = (e.data || []).filter(x => x.state === "ready");
      onboardingStep = agents.length === 0 ? 0 : environments.length === 0 ? 1 : 2;
      renderOnboarding();
    } else {
      await loadSessions();
      loadResources();
      restoreFromUrl();
    }
  } catch (e) { await loadSessions(); loadResources(); restoreFromUrl(); }
}

function restoreFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get("tab");
  if (tab && ["chat", "config", "events"].includes(tab)) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${tab}`));
    if (tab === "config") {
      const agentId = params.get("agent");
      if (agentId) {
        activeAgentId = agentId;
        loadResources().then(() => renderAgentConfigPage());
      } else {
        loadResources();
        loadVaults();
      }
    }
    if (tab === "events") loadSessionsForEvents();
  }
  const id = params.get("session");
  if (id && sessions.some((s) => s.id === id)) selectSession(id);
}

window.addEventListener("popstate", () => restoreFromUrl());

function renderOnboarding() {
  const el = $("messages");
  const steps = ["Agent", "Environment", "Secrets", "Chat"];
  const stepIndicator = steps.map((s, i) =>
    `<span class="onboard-step">` +
    `<span class="onboard-num ${i < onboardingStep ? 'done' : i === onboardingStep ? 'current' : ''}">${i < onboardingStep ? '\u2713' : i + 1}</span>` +
    `<span class="onboard-label ${i <= onboardingStep ? 'active' : ''}">${s}</span>` +
    (i < steps.length - 1 ? `<span class="onboard-arrow">\u2192</span>` : '') +
    `</span>`
  ).join("");

  let content = "";

  if (onboardingStep === 0) {
    content = `
      <h2 class="onboard-title">Create your first agent</h2>
      <p class="onboard-desc">Pick an engine and model to get started.</p>
      <div class="onboard-form">
        <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="obAgentName" value="Coder" /></div>
        <div class="form-group"><label class="form-label">Engine</label>
          <select class="form-select" id="obEngine" onchange="updateObModels()">
            <option value="claude">Claude \u2014 Max subscription or API key</option>
            <option value="opencode">OpenCode \u2014 Multi-provider</option>
            <option value="codex">Codex \u2014 GPT-5.4 models</option>
            <option value="gemini">Gemini \u2014 Google AI models</option>
            <option value="factory">Factory \u2014 Multi-provider Droid</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Model</label><select class="form-select" id="obModel"></select></div>
        <button class="btn btn-primary btn-full" onclick="onboardCreateAgent()">Create Agent</button>
      </div>`;
  } else if (onboardingStep === 1) {
    content = `
      <h2 class="onboard-title">Set up an environment</h2>
      <p class="onboard-desc">Where should your agent run?</p>
      <div class="onboard-form">
        <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="obEnvName" value="dev" /></div>
        <div class="form-group"><label class="form-label">Provider</label>
          <select class="form-select" id="obProvider" onchange="onboardProvider=this.value">
            <optgroup label="Local">
              <option value="docker">Docker</option>
              <option value="apple-container">Apple Container (macOS 26+)</option>
              <option value="apple-firecracker">mvm Firecracker (M3+)</option>
              <option value="podman">Podman</option>
            </optgroup>
            <optgroup label="Cloud">
              <option value="sprites">sprites.dev</option>
              <option value="e2b">E2B</option>
              <option value="fly">Fly.io</option>
              <option value="vercel">Vercel</option>
              <option value="daytona">Daytona</option>
              <option value="modal">Modal</option>
            </optgroup>
          </select>
        </div>
        <button class="btn btn-primary btn-full" onclick="onboardCreateEnv()">Create Environment</button>
      </div>`;
  } else if (onboardingStep === 2) {
    const fields = [];
    const backendKeys = { claude: [{ key: "ANTHROPIC_API_KEY", label: "Anthropic API Key", placeholder: "sk-ant-...", alt: "or CLAUDE_CODE_OAUTH_TOKEN" }], opencode: [{ key: "OPENAI_API_KEY", label: "OpenAI API Key", placeholder: "sk-..." }], codex: [{ key: "OPENAI_API_KEY", label: "OpenAI API Key", placeholder: "sk-..." }], gemini: [{ key: "GEMINI_API_KEY", label: "Gemini API Key", placeholder: "AIza..." }], factory: [{ key: "FACTORY_API_KEY", label: "Factory API Key", placeholder: "fk-..." }] };
    const providerKeys = { sprites: [{ key: "SPRITE_TOKEN", label: "Sprites.dev Token", placeholder: "user/org/.../token" }] };
    (backendKeys[onboardEngine] || []).forEach(f => fields.push(f));
    (providerKeys[onboardProvider] || []).forEach(f => fields.push(f));

    const fieldHtml = fields.map((f, i) => `
      <div class="form-group">
        <label class="form-label">${f.label}${f.alt ? ` <span class="form-hint">${f.alt}</span>` : ''}</label>
        <input class="form-input" id="obSecret${i}" type="password" placeholder="${f.placeholder}" data-key="${f.key}" />
      </div>`).join("");

    content = `
      <h2 class="onboard-title">Add your secrets</h2>
      <p class="onboard-desc">Keys are stored in a vault and injected into the container at runtime.</p>
      <div class="onboard-form">
        ${fieldHtml}
        <button class="btn btn-primary btn-full" onclick="onboardSaveSecrets(${fields.length})">Save & Continue</button>
        <button class="btn btn-secondary btn-full" onclick="onboardingStep=3;renderOnboarding()">Skip (use server .env)</button>
      </div>`;
  } else if (onboardingStep === 3) {
    content = `
      <h2 class="onboard-title">Ready to go!</h2>
      <p class="onboard-desc">Your agent and environment are set up.</p>
      <div class="onboard-summary">
        <div class="summary-row"><span class="summary-label">Agent</span><span class="summary-value">${esc(agents[0]?.name || "")}</span></div>
        <div class="summary-row"><span class="summary-label">Engine</span><span class="summary-mono">${agents[0]?.engine || ""}</span></div>
        <div class="summary-row"><span class="summary-label">Model</span><span class="summary-mono">${agents[0]?.model || ""}</span></div>
        <div class="summary-row"><span class="summary-label">Environment</span><span class="summary-value">${esc(environments[0]?.name || "")}</span></div>
        <div class="summary-row"><span class="summary-label">Secrets</span><span class="${onboardVaultId ? 'summary-ok' : 'summary-dim'}">${onboardVaultId ? '\u2713 Vault configured' : 'Using server .env'}</span></div>
      </div>
      <button class="btn btn-primary btn-full" onclick="onboardStart()" style="margin-top:16px">Start Chatting</button>`;
  }

  el.innerHTML = `
    <div class="onboard-container">
      <div class="onboard-steps">${stepIndicator}</div>
      ${content}
    </div>`;

  if (onboardingStep === 0) setTimeout(updateObModels, 0);
}

function updateObModels() {
  const backend = $("obEngine")?.value || "claude";
  const models = MODELS[backend] || MODELS.claude;
  const el = $("obModel");
  if (el) el.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join("");
}

async function onboardCreateAgent() {
  const name = $("obAgentName")?.value?.trim();
  const backend = $("obEngine")?.value;
  const model = $("obModel")?.value;
  if (!name) return;
  try {
    const body = { name, model, engine: backend };
    if (backend === "claude") body.tools = [{ type: "agent_toolset_20260401" }];
    await api("/v1/agents", { method: "POST", body: JSON.stringify(body) });
    const a = await api("/v1/agents?limit=50");
    agents = a.data || [];
    onboardEngine = backend;
    onboardingStep = 1;
    renderOnboarding();
    showToast("Agent created");
  } catch (e) { showToast(e.message, "error"); }
}

async function onboardCreateEnv() {
  const name = $("obEnvName")?.value?.trim();
  const provider = $("obProvider")?.value || "docker";
  if (!name) return;
  onboardProvider = provider;
  try {
    await api("/v1/environments", { method: "POST", body: JSON.stringify({ name, config: { type: "cloud", provider } }) });
    const e = await api("/v1/environments?limit=50");
    environments = (e.data || []).filter(x => x.state === "ready");
    onboardingStep = 2;
    renderOnboarding();
    showToast("Environment created");
  } catch (e) { showToast(e.message, "error"); }
}

async function onboardSaveSecrets(fieldCount) {
  try {
    const entries = [];
    for (let i = 0; i < fieldCount; i++) {
      const el = $(`obSecret${i}`);
      if (el && el.value.trim()) {
        let key = el.dataset.key;
        const val = el.value.trim();
        if (key === "ANTHROPIC_API_KEY" && val.startsWith("sk-ant-oat")) key = "CLAUDE_CODE_OAUTH_TOKEN";
        entries.push({ key, value: val });
      }
    }
    if (entries.length === 0) { onboardingStep = 3; renderOnboarding(); return; }
    const vault = await api("/v1/vaults", { method: "POST", body: JSON.stringify({ agent_id: agents[0].id, name: "secrets" }) });
    onboardVaultId = vault.id;
    for (const e of entries) {
      await api(`/v1/vaults/${vault.id}/entries/${e.key}`, { method: "PUT", body: JSON.stringify({ value: e.value }) });
    }
    onboardingStep = 3;
    renderOnboarding();
    showToast(`${entries.length} secret(s) saved`);
  } catch (e) { showToast(e.message, "error"); }
}

async function onboardStart() {
  if (!agents[0] || !environments[0]) return;
  try {
    const sessionBody = { agent: agents[0].id, environment_id: environments[0].id };
    if (onboardVaultId) sessionBody.vault_ids = [onboardVaultId];
    const data = await api("/v1/sessions", { method: "POST", body: JSON.stringify(sessionBody) });
    $("messages").innerHTML = "";
    $("chatInputArea").style.display = "block";
    await loadSessions();
    await loadResources();
    selectSession(data.id);
    showToast("Session created \u2014 start chatting!");
  } catch (e) { showToast(e.message, "error"); }
}

// ═══════════════════════════════════════════════════════════════════
// CHAT
// ═══════════════════════════════════════════════════════════════════

async function loadSessions() {
  try {
    const data = await api("/v1/sessions?limit=50&order=desc");
    sessions = data.data || [];
    renderSessionList();
  } catch (e) { console.error(e); }
}

function renderSessionList() {
  const el = $("sessionList");
  if (!sessions.length) {
    el.innerHTML = '<p class="sidebar-empty">No sessions</p>';
    return;
  }
  el.innerHTML = sessions.map((s) => `
    <div class="session-item ${s.id === activeSessionId ? 'active' : ''}" data-action="select-session" data-id="${esc(s.id)}">
      <div class="session-title">${esc(s.title || s.id.slice(0, 16))}</div>
      <div class="session-meta">
        <span class="badge badge-${s.status}">${s.status}</span>
        <span>${new Date(s.created_at).toLocaleDateString()}</span>
      </div>
      <div class="session-actions">
        <button class="btn-icon-sm" data-action="archive-session" data-id="${esc(s.id)}" title="Archive">\u2715</button>
      </div>
    </div>
  `).join("");
}

async function selectSession(id) {
  activeSessionId = id;
  seenEventSeqs.clear();
  pendingUserTexts.clear();
  lastAppendedRole = "";
  renderSessionList();
  const chatEmpty = $("chatEmpty");
  if (chatEmpty) chatEmpty.style.display = "none";
  $("chatInputArea").style.display = "block";
  const params = new URLSearchParams(window.location.search);
  params.set("session", id);
  history.pushState(null, "", `/?${params.toString()}`);
  disconnectSSE();

  // Show loading
  $("messages").innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';

  try {
    const data = await api(`/v1/sessions/${id}/events?limit=200&order=asc`);
    const msgs = [];
    for (const evt of (data.data || [])) {
      seenEventSeqs.add(evt.seq);
      const m = eventToMessage(evt);
      if (m) msgs.push(m);
    }
    renderMessages(msgs);
    sseLastSeq = data.data?.length ? data.data[data.data.length - 1].seq : 0;
    connectSSE(id, sseLastSeq);
  } catch (e) { showToast(e.message, "error"); }
}

async function deleteSession(id) {
  try {
    await api(`/v1/sessions/${id}`, { method: "DELETE" });
    if (activeSessionId === id) activeSessionId = null;
    await loadSessions();
    showToast("Session deleted");
  } catch (e) { showToast(e.message, "error"); }
}

async function archiveSession(id) {
  try {
    await api(`/v1/sessions/${id}/archive`, { method: "POST" });
    if (activeSessionId === id) activeSessionId = null;
    await loadSessions();
    showToast("Session archived");
  } catch (e) { showToast(e.message, "error"); }
}

function eventToMessage(evt) {
  if (evt.type === "user.message") {
    const text = (Array.isArray(evt.content) ? evt.content.map((b) => b.text || "").join("") : (typeof evt.content === "string" ? evt.content : ""));
    // Skip if this was already shown optimistically via sendMessage()
    if (pendingUserTexts.has(text)) {
      pendingUserTexts.delete(text);
      return null;
    }
    return { role: "user", content: text, type: evt.type, seq: evt.seq };
  }
  if (evt.type === "agent.message") {
    const text = (Array.isArray(evt.content) ? evt.content.map((b) => b.text || "").join("") : (typeof evt.content === "string" ? evt.content : ""));
    if (text) return { role: "assistant", content: text, type: evt.type, seq: evt.seq };
  }
  if (evt.type === "agent.thinking") {
    return { role: "thinking", content: "Thinking...", type: evt.type, seq: evt.seq };
  }
  if (evt.type === "agent.tool_use" || evt.type === "agent.custom_tool_use") {
    const name = evt.name || evt.tool_name || "tool";
    const input = evt.input ? JSON.stringify(evt.input, null, 2) : "";
    return { role: "tool", content: name, detail: input, type: evt.type, seq: evt.seq };
  }
  if (evt.type === "agent.tool_result") {
    const text = (Array.isArray(evt.content) ? evt.content.map((b) => b.text || "").join("") : (typeof evt.content === "string" ? evt.content : ""));
    if (text) return { role: "tool-result", content: text, type: evt.type, seq: evt.seq };
  }
  if (evt.type === "session.status_running") { isRunning = true; renderTyping(); }
  if (evt.type === "session.status_idle") { isRunning = false; renderTyping(); loadSessions(); }
  if (evt.type === "session.error") {
    isRunning = false; renderTyping(); loadSessions();
    const errorMsg = evt.error?.message || evt.payload?.error?.message || "An unknown error occurred";
    return { role: "error", content: errorMsg, type: evt.type, seq: evt.seq };
  }
  return null;
}

function renderMessages(msgs) {
  const el = $("messages");
  let html = "";
  let prevRole = "";
  for (const m of msgs) {
    html += renderSingleMessage(m, prevRole);
    const effectiveRole = (m.role === "tool" || m.role === "tool-result" || m.role === "thinking") ? "assistant" : m.role;
    prevRole = effectiveRole;
  }
  html += '<div id="typing" style="display:none"><div class="typing"><div class="typing-dots"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>Agent is thinking...</div></div>';
  html += '<div id="messagesEnd"></div>';
  el.innerHTML = html;
  if (isRunning) renderTyping();
  scrollToBottom();
}

function renderSingleMessage(m, prevRole) {
  const effectiveRole = (m.role === "tool" || m.role === "tool-result" || m.role === "thinking") ? "assistant" : m.role;
  const showRole = effectiveRole !== prevRole;
  const roleLabel = m.role === "tool" || m.role === "tool-result" || m.role === "thinking" ? "agent" : m.role;
  const roleHtml = showRole ? `<div class="message-role">${roleLabel}</div>` : "";

  if (m.role === "tool") {
    const detailHtml = m.detail ? `<details class="tool-detail"><summary>Input</summary><pre>${esc(m.detail)}</pre></details>` : "";
    return `<div class="message tool">${roleHtml}<div class="message-content tool-use">\u2699 ${esc(m.content)}${detailHtml}</div></div>`;
  }
  if (m.role === "tool-result") {
    const truncated = m.content.length > 500 ? m.content.slice(0, 500) + "..." : m.content;
    return `<div class="message tool-result">${roleHtml}<div class="message-content tool-result-content"><details><summary>Result</summary><pre>${esc(truncated)}</pre></details></div></div>`;
  }
  if (m.role === "thinking") {
    return `<div class="message thinking">${roleHtml}<div class="message-content thinking-content">${esc(m.content)}</div></div>`;
  }

  const rendered = m.role === "assistant" ? renderMarkdown(m.content) : esc(m.content);
  return `<div class="message ${m.role}">${roleHtml}<div class="message-content">${rendered}</div></div>`;
}

function appendMessage(m) {
  if (seenEventSeqs.has(m.seq)) return;
  seenEventSeqs.add(m.seq);

  // For thinking events, remove previous thinking indicator
  if (m.role === "thinking") {
    document.querySelectorAll(".message.thinking").forEach(el => el.remove());
  }

  const typing = $("typing");
  const end = $("messagesEnd");
  if (!typing || !end) return;

  const effectiveRole = (m.role === "tool" || m.role === "tool-result" || m.role === "thinking") ? "assistant" : m.role;
  const html = renderSingleMessage(m, lastAppendedRole);
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html;
  const div = wrapper.firstElementChild;
  if (div) {
    lastAppendedRole = effectiveRole;
    typing.before(div);
  }
  scrollToBottom();
}

function renderTyping() {
  const el = $("typing");
  if (el) el.style.display = isRunning ? "block" : "none";
  if (isRunning) scrollToBottom();
}

function scrollToBottom() {
  const el = $("messagesEnd");
  if (el) el.scrollIntoView({ behavior: "smooth" });
}

async function sendMessage() {
  const input = $("chatInput");
  const text = input.value.trim();
  if (!text || !activeSessionId) return;
  input.value = "";
  input.style.height = "auto";
  pendingUserTexts.add(text);
  appendMessage({ role: "user", content: text, seq: Date.now() });
  isRunning = true;
  renderTyping();
  try {
    await api(`/v1/sessions/${activeSessionId}/events`, {
      method: "POST",
      body: JSON.stringify({ events: [{ type: "user.message", content: [{ type: "text", text }] }] }),
    });
  } catch (e) { showToast(e.message, "error"); }
}

function handleChatKey(e) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

// ── SSE with reconnect ──
function connectSSE(sessionId, afterSeq) {
  disconnectSSE();
  sseReconnectDelay = 1000;

  function connect() {
    const ctrl = new AbortController();
    sseAbort = ctrl;

    fetch(`/v1/sessions/${sessionId}/stream?after_seq=${afterSeq}`, {
      headers: { "x-api-key": apiKey },
      signal: ctrl.signal,
    }).then((res) => {
      if (!res.ok) throw new Error(`SSE HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      function pump() {
        reader.read().then(({ done, value }) => {
          if (done) {
            // Stream ended — reconnect if still on same session
            if (activeSessionId === sessionId) scheduleReconnect(sessionId);
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop();
          for (const part of parts) {
            const evt = parseSSE(part);
            if (evt && evt.type !== "ping") {
              if (evt.seq) { afterSeq = evt.seq; sseLastSeq = evt.seq; }
              const m = eventToMessage(evt);
              if (m) appendMessage(m);
            }
          }
          sseReconnectDelay = 1000; // reset on successful data
          pump();
        }).catch((err) => {
          if (err.name !== "AbortError" && activeSessionId === sessionId) {
            scheduleReconnect(sessionId);
          }
        });
      }
      pump();
    }).catch((err) => {
      if (err.name !== "AbortError" && activeSessionId === sessionId) {
        scheduleReconnect(sessionId);
      }
    });
  }

  function scheduleReconnect(sid) {
    if (sseReconnectTimer) clearTimeout(sseReconnectTimer);
    sseReconnectTimer = setTimeout(() => {
      if (activeSessionId === sid) {
        afterSeq = sseLastSeq;
        connect();
      }
    }, sseReconnectDelay);
    sseReconnectDelay = Math.min(sseReconnectDelay * 2, 30000);
  }

  connect();
}

function disconnectSSE() {
  if (sseAbort) { sseAbort.abort(); sseAbort = null; }
  if (sseReconnectTimer) { clearTimeout(sseReconnectTimer); sseReconnectTimer = null; }
}

function parseSSE(block) {
  let data = null;
  for (const line of block.split("\n")) {
    if (line.startsWith("data: ")) {
      try { data = JSON.parse(line.slice(6)); } catch {}
    }
  }
  return data;
}

// ── New Session Modal ──
async function showNewSessionModal() {
  await loadResources();
  const html = `<div class="modal-overlay" data-action="close-modal">
    <div class="modal" onclick="if(!event.target.closest('[data-action]'))event.stopPropagation()">
      <h2>New Session</h2>
      <div class="form-group">
        <label class="form-label">Agent</label>
        <select class="form-select" id="modalAgent">${agents.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("")}</select>
      </div>
      <div class="form-group">
        <label class="form-label">Environment</label>
        <select class="form-select" id="modalEnv">${environments.filter((e) => e.state === "ready").map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join("")}</select>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="createSession()">Create</button>
      </div>
    </div>
  </div>`;
  $("modals").innerHTML = html;
}

async function createSession() {
  const agentId = $("modalAgent")?.value;
  const envId = $("modalEnv")?.value;
  if (!agentId || !envId) return;
  try {
    const vaultsData = await api(`/v1/vaults?agent_id=${agentId}`);
    const vaultIds = (vaultsData.data || []).map(v => v.id);
    const body = { agent: agentId, environment_id: envId };
    if (vaultIds.length > 0) body.vault_ids = vaultIds;
    const data = await api("/v1/sessions", { method: "POST", body: JSON.stringify(body) });
    closeModal();
    await loadSessions();
    selectSession(data.id);
    showToast("Session created");
  } catch (e) { showToast(e.message, "error"); }
}

function closeModal() { $("modals").innerHTML = ""; }

// ═══════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════

async function loadResources() {
  try {
    const [a, e] = await Promise.all([api("/v1/agents?limit=50"), api("/v1/environments?limit=50")]);
    agents = a.data || [];
    environments = e.data || [];
    renderAgents();
    renderEnvs();
  } catch (e) { console.error(e); }
}

function renderAgents() {
  const el = $("agentsList");
  if (!agents.length) { el.innerHTML = '<p class="empty-text">No agents yet</p>'; return; }
  el.innerHTML = agents.map((a) => `
    <div class="card-item">
      <div><div class="name">${esc(a.name)}</div><div class="detail">${esc(a.model)} / ${a.engine}</div></div>
      <div class="card-actions">
        <button class="btn btn-sm btn-secondary" data-action="agent-config" data-id="${esc(a.id)}">Config</button>
        <button class="btn btn-sm btn-danger" data-action="delete-agent" data-id="${esc(a.id)}">Delete</button>
      </div>
    </div>
  `).join("");
}

function toYaml(obj, indent = 0) {
  const pad = "  ".repeat(indent);
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      lines.push(`${pad}${k}:`);
      v.forEach(item => {
        if (typeof item === "object") {
          lines.push(`${pad}  -`);
          lines.push(toYaml(item, indent + 2).replace(/^/, `${pad}    `).replace(/\n/g, `\n`));
        } else {
          lines.push(`${pad}  - ${item}`);
        }
      });
    } else if (typeof v === "object") {
      if (Object.keys(v).length === 0) continue;
      lines.push(`${pad}${k}:`);
      lines.push(toYaml(v, indent + 1));
    } else {
      lines.push(`${pad}${k}: ${v}`);
    }
  }
  return lines.join("\n");
}

let _configData = {};
let activeAgentId = null;
let editFormat = "yaml";

function showAgentConfig(id) {
  activeAgentId = id;
  const params = new URLSearchParams(window.location.search);
  params.set("tab", "config");
  params.set("agent", id);
  history.pushState(null, "", `/?${params.toString()}`);
  renderAgentConfigPage();
}

function renderAgentConfigPage() {
  if (!activeAgentId) return;
  const agent = agents.find(a => a.id === activeAgentId);
  if (!agent) { activeAgentId = null; return; }
  _configData = { yaml: toYaml(agent), json: JSON.stringify(agent, null, 2) };

  const toolsHtml = (agent.tools || []).map(t => {
    if (t.type === "agent_toolset_20260401") {
      const overrides = (t.configs || []).map(c =>
        `<div class="tool-override">${esc(c.name)}: ${c.enabled === false ? 'disabled' : 'enabled'}</div>`
      ).join("");
      return `<div class="config-card">
        <div class="config-card-header">
          <span class="config-card-icon">\u2699</span>
          <div><div class="config-card-title">Built-in tools</div><div class="config-card-sub">agent_toolset_20260401</div></div>
        </div>
        ${overrides || '<div class="config-card-sub" style="margin-top:4px">All tools enabled (default)</div>'}
      </div>`;
    }
    if (t.type === "custom") {
      return `<div class="config-card">
        <div class="config-card-header">
          <span class="config-card-icon">\u{1F527}</span>
          <div><div class="config-card-title">${esc(t.name)}</div><div class="config-card-sub">${esc(t.description || "Custom tool")}</div></div>
        </div>
      </div>`;
    }
    return `<div class="config-card"><div class="config-card-sub">${esc(JSON.stringify(t))}</div></div>`;
  }).join("");

  const mcpHtml = Object.keys(agent.mcp_servers || {}).length > 0
    ? Object.entries(agent.mcp_servers).map(([name, cfg]) =>
      `<div class="config-card">
        <div class="config-card-header">
          <span class="config-card-icon">\u{1F310}</span>
          <div><div class="config-card-title">${esc(name)}</div><div class="config-card-sub">${(cfg).type || "stdio"} ${(cfg).url ? '- ' + esc((cfg).url) : ''}</div></div>
        </div>
      </div>`
    ).join("")
    : '<div class="config-card-sub">None configured</div>';

  const el = $("panel-config");
  el.innerHTML = `
    <div class="agent-config-page">
      <div class="agent-breadcrumb">
        <a data-action="back-to-config">Agents</a> <span class="breadcrumb-sep">/</span> <span>${esc(agent.name)}</span>
      </div>
      <div class="agent-config-header">
        <div>
          <h2>${esc(agent.name)} <span class="badge badge-agent">Active</span></h2>
          <div class="agent-config-id">${esc(agent.id)} \u00B7 Last updated ${new Date(agent.updated_at).toLocaleString()}</div>
        </div>
        <div class="card-actions">
          <button class="btn btn-secondary btn-sm" data-action="edit-agent" data-id="${esc(agent.id)}">\u270E Edit</button>
        </div>
      </div>

      <div class="agent-config-sections">
        <div class="config-section">
          <div class="config-section-label">Model</div>
          <div class="config-section-value mono">${esc(agent.model)}</div>
        </div>

        <div class="config-section">
          <div class="config-section-label">Engine</div>
          <div class="config-section-value mono">${esc(agent.engine)}</div>
        </div>

        <div class="config-section">
          <div class="config-section-label">System prompt</div>
          <div class="config-section-value">${agent.system
            ? `<pre class="system-prompt-pre">${esc(agent.system)}</pre>`
            : '<span class="config-card-sub">None</span>'
          }</div>
        </div>

        <div class="config-section">
          <div class="config-section-label">Tools</div>
          <div class="config-section-value">${toolsHtml || '<span class="config-card-sub">None</span>'}</div>
        </div>

        <div class="config-section">
          <div class="config-section-label">MCP servers</div>
          <div class="config-section-value">${mcpHtml}</div>
        </div>

        ${agent.threads_enabled ? `<div class="config-section">
          <div class="config-section-label">Threads</div>
          <div class="config-section-value"><span class="badge badge-agent">Enabled</span></div>
        </div>` : ''}

        ${agent.confirmation_mode ? `<div class="config-section">
          <div class="config-section-label">Confirmation mode</div>
          <div class="config-section-value"><span class="badge badge-status">Enabled</span></div>
        </div>` : ''}
      </div>
    </div>`;
}

function showEditAgentModal(id) {
  const agent = agents.find(a => a.id === id);
  if (!agent) return;
  editFormat = "yaml";
  _configData = { yaml: toYaml(agent), json: JSON.stringify(agent, null, 2) };

  $("modals").innerHTML = `
    <div class="modal-overlay" data-action="close-modal">
      <div class="modal modal-editor" onclick="event.stopPropagation()">
        <div class="modal-header">
          <h2>Edit agent</h2>
          <button class="btn-icon" onclick="closeModal()">\u2715</button>
        </div>
        <div class="editor-tabs">
          <button class="editor-tab active" onclick="switchEditorTab('yaml',this)">YAML</button>
          <button class="editor-tab" onclick="switchEditorTab('json',this)">JSON</button>
          <button class="btn-icon" style="margin-left:auto" onclick="copyEditorContent()" title="Copy">\u2398</button>
        </div>
        <textarea class="editor-textarea" id="editorContent" spellcheck="false">${esc(_configData.yaml)}</textarea>
        <div class="modal-actions">
          <button class="btn btn-primary" onclick="saveAgentEdit('${esc(id)}')">Save new version</button>
        </div>
      </div>
    </div>`;
}

function switchEditorTab(format, btn) {
  editFormat = format;
  document.querySelectorAll(".editor-tab").forEach(t => t.classList.remove("active"));
  btn.classList.add("active");
  const el = $("editorContent");
  if (el) el.value = format === "yaml" ? _configData.yaml : _configData.json;
}

function copyEditorContent() {
  const el = $("editorContent");
  if (el) { navigator.clipboard.writeText(el.value); showToast("Copied"); }
}

async function saveAgentEdit(id) {
  const el = $("editorContent");
  if (!el) return;
  try {
    // Parse the edited content (JSON only for now — YAML editing requires a parser)
    let body;
    if (editFormat === "json") {
      body = JSON.parse(el.value);
    } else {
      showToast("Switch to JSON tab to save edits", "error");
      return;
    }
    // Only send updatable fields
    const update = {};
    if (body.name) update.name = body.name;
    if (body.model) update.model = body.model;
    if (body.system !== undefined) update.system = body.system;
    if (body.tools) update.tools = body.tools;
    if (body.mcp_servers) update.mcp_servers = body.mcp_servers;

    await api(`/v1/agents/${id}`, { method: "PATCH", body: JSON.stringify(update) });
    closeModal();
    await loadResources();
    renderAgentConfigPage();
    showToast("Agent updated");
  } catch (e) { showToast(e.message, "error"); }
}

function backToConfig() {
  activeAgentId = null;
  const params = new URLSearchParams(window.location.search);
  params.delete("agent");
  params.set("tab", "config");
  history.pushState(null, "", `/?${params.toString()}`);
  renderConfigLayout();
}

function renderConfigLayout() {
  const el = $("panel-config");
  el.innerHTML = `
    <div class="config-layout">
      <div class="config-col">
        <h2>Agents <button class="btn btn-sm btn-secondary" onclick="showCreateAgentModal()">+ New</button></h2>
        <div class="card" id="agentsList"><p class="empty-text">Loading...</p></div>
      </div>
      <div class="config-col">
        <h2>Environments <button class="btn btn-sm btn-secondary" onclick="showCreateEnvModal()">+ New</button></h2>
        <div class="card" id="envsList"><p class="empty-text">Loading...</p></div>
      </div>
      <div class="config-col">
        <h2>Secrets <button class="btn btn-sm btn-secondary" onclick="showCreateVaultModal()">+ New</button></h2>
        <div class="card" id="vaultsList"><p class="empty-text">Loading...</p></div>
      </div>
    </div>`;
  loadResources();
  loadVaults();
}

function renderEnvs() {
  const el = $("envsList");
  if (!environments.length) { el.innerHTML = '<p class="empty-text">No environments yet</p>'; return; }
  el.innerHTML = environments.map((e) => `
    <div class="card-item">
      <div><div class="name">${esc(e.name)}</div><div class="detail">${e.state}${e.config?.provider ? ' / ' + e.config.provider : ''}</div></div>
      <button class="btn btn-sm btn-danger" data-action="delete-env" data-id="${esc(e.id)}">Delete</button>
    </div>
  `).join("");
}

function showCreateAgentModal() {
  $("modals").innerHTML = `<div class="modal-overlay" data-action="close-modal">
    <div class="modal" onclick="if(!event.target.closest('[data-action]'))event.stopPropagation()">
      <h2>Create Agent</h2>
      <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="agentName" value="Coder" /></div>
      <div class="form-group"><label class="form-label">Engine</label>
        <select class="form-select" id="agentEngine" onchange="updateModelOptions()">
          <option value="claude">Claude</option><option value="opencode">OpenCode</option><option value="codex">Codex</option><option value="gemini">Gemini</option><option value="factory">Factory</option>
        </select>
      </div>
      <div class="form-group"><label class="form-label">Model</label><select class="form-select" id="agentModel"></select></div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="createAgent()">Create</button>
      </div>
    </div>
  </div>`;
  updateModelOptions();
}

function updateModelOptions() {
  const backend = $("agentEngine")?.value;
  const models = MODELS[backend] || MODELS.claude;
  $("agentModel").innerHTML = models.map((m) => `<option value="${m}">${m}</option>`).join("");
}

async function createAgent() {
  const name = $("agentName")?.value?.trim();
  const backend = $("agentEngine")?.value;
  const model = $("agentModel")?.value;
  if (!name) return;
  try {
    const body = { name, model, engine: backend };
    if (backend === "claude") body.tools = [{ type: "agent_toolset_20260401" }];
    await api("/v1/agents", { method: "POST", body: JSON.stringify(body) });
    closeModal(); loadResources(); showToast("Agent created");
  } catch (e) { showToast(e.message, "error"); }
}

async function deleteAgent(id) {
  try { await api(`/v1/agents/${id}`, { method: "DELETE" }); loadResources(); showToast("Agent deleted"); }
  catch (e) { showToast(e.message, "error"); }
}

function showCreateEnvModal() {
  $("modals").innerHTML = `<div class="modal-overlay" data-action="close-modal">
    <div class="modal" onclick="if(!event.target.closest('[data-action]'))event.stopPropagation()">
      <h2>Create Environment</h2>
      <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="envName" value="dev" /></div>
      <div class="form-group"><label class="form-label">Provider</label>
        <select class="form-select" id="envProvider" onchange="toggleEnvToken()">
          <optgroup label="Local">
            <option value="docker">Docker</option>
            <option value="apple-container">Apple Container (macOS 26+)</option>
            <option value="apple-firecracker">mvm Firecracker (M3+)</option>
            <option value="podman">Podman</option>
          </optgroup>
          <optgroup label="Cloud">
            <option value="sprites">sprites.dev</option>
            <option value="e2b">E2B</option>
            <option value="fly">Fly.io</option>
            <option value="vercel">Vercel</option>
            <option value="daytona">Daytona</option>
            <option value="modal">Modal</option>
          </optgroup>
        </select>
      </div>
      <div class="form-group" id="envTokenGroup" style="display:none">
        <label class="form-label" id="envTokenLabel">Token</label>
        <input class="form-input" id="envToken" type="password" />
        <p class="form-hint">Saved to vault for this environment.</p>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="createEnv()">Create</button>
      </div>
    </div>
  </div>`;
}

function toggleEnvToken() {
  const provider = $("envProvider")?.value;
  const group = $("envTokenGroup");
  const label = $("envTokenLabel");
  const input = $("envToken");
  const info = PROVIDER_TOKENS[provider];
  if (info) {
    group.style.display = "block";
    label.textContent = info.label;
    input.placeholder = info.placeholder;
  } else {
    group.style.display = "none";
  }
}

async function createEnv() {
  const name = $("envName")?.value?.trim();
  const provider = $("envProvider")?.value;
  const token = $("envToken")?.value?.trim();
  if (!name) return;
  try {
    const tokenInfo = PROVIDER_TOKENS[provider];
    if (token && tokenInfo && agents.length > 0) {
      let vaultId = null;
      const existing = await api("/v1/vaults?limit=50");
      const found = (existing.data || []).find(v => v.name === "secrets");
      if (found) { vaultId = found.id; }
      else {
        const vault = await api("/v1/vaults", { method: "POST", body: JSON.stringify({ agent_id: agents[0].id, name: "secrets" }) });
        vaultId = vault.id;
      }
      await api(`/v1/vaults/${vaultId}/entries/${tokenInfo.key}`, { method: "PUT", body: JSON.stringify({ value: token }) });
    }
    await api("/v1/environments", { method: "POST", body: JSON.stringify({ name, config: { type: "cloud", provider } }) });
    closeModal(); loadResources(); loadVaults(); showToast("Environment created");
  } catch (e) { showToast(e.message, "error"); }
}

async function deleteEnv(id) {
  try {
    await api(`/v1/environments/${id}`, { method: "DELETE" });
    loadResources(); showToast("Environment deleted");
  } catch (e) {
    if (e.message && e.message.includes("active sessions")) {
      if (confirm("This environment has active sessions. Archive them and delete?")) {
        try {
          const data = await api(`/v1/sessions?environment_id=${id}&limit=100`);
          for (const s of (data.data || [])) {
            try { await api(`/v1/sessions/${s.id}/archive`, { method: "POST" }); } catch {}
          }
          await api(`/v1/environments/${id}`, { method: "DELETE" });
          loadResources(); loadSessions(); showToast("Environment and sessions cleaned up");
        } catch (e2) { showToast(e2.message, "error"); }
      }
    } else {
      showToast(e.message, "error");
    }
  }
}

// ── Vaults/Secrets ──
async function loadVaults() {
  try {
    const data = await api("/v1/vaults?limit=50");
    vaults = data.data || [];
    renderVaults();
  } catch (e) { console.error(e); }
}

async function renderVaults() {
  const el = $("vaultsList");
  if (!el) return;
  if (!vaults.length) { el.innerHTML = '<p class="empty-text">No vaults yet</p>'; return; }

  // Fetch all vault entries in parallel
  const entriesByVault = await Promise.all(
    vaults.map(v => api(`/v1/vaults/${v.id}/entries`).catch(() => ({ data: [] })))
  );

  let html = "";
  vaults.forEach((v, i) => {
    const entries = entriesByVault[i].data || [];
    const entryHtml = entries.map(e =>
      `<div class="vault-entry">
        <span class="vault-key">${esc(e.key)}</span>
        <div class="vault-entry-actions">
          <span class="vault-preview">${e.value.slice(0, 8)}...${e.value.slice(-4)}</span>
          <button class="btn-icon-sm" data-action="edit-entry" data-id="${esc(v.id)}" data-key="${esc(e.key)}" title="Edit">\u270E</button>
          <button class="btn-icon-sm" data-action="delete-entry" data-id="${esc(v.id)}" data-key="${esc(e.key)}" title="Delete">\u2715</button>
        </div>
      </div>`
    ).join("");

    html += `<div class="vault-block">
      <div class="card-item">
        <div><div class="name">${esc(v.name)}</div><div class="detail">${entries.length} entries</div></div>
        <div class="card-actions">
          <button class="btn btn-sm btn-secondary" data-action="add-entry" data-id="${esc(v.id)}">+ Entry</button>
          <button class="btn btn-sm btn-danger" data-action="delete-vault" data-id="${esc(v.id)}">Delete</button>
        </div>
      </div>
      ${entryHtml}
    </div>`;
  });
  el.innerHTML = html || '<p class="empty-text">No vaults</p>';
}

function showCreateVaultModal() {
  $("modals").innerHTML = `<div class="modal-overlay" data-action="close-modal">
    <div class="modal" onclick="if(!event.target.closest('[data-action]'))event.stopPropagation()">
      <h2>Create Vault</h2>
      <div class="form-group"><label class="form-label">Agent</label>
        <select class="form-select" id="vaultAgent">${agents.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("")}</select>
      </div>
      <div class="form-group"><label class="form-label">Vault Name</label><input class="form-input" id="vaultName" value="secrets" /></div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="createVault()">Create</button>
      </div>
    </div>
  </div>`;
}

async function createVault() {
  const agentId = $("vaultAgent")?.value;
  const name = $("vaultName")?.value?.trim();
  if (!agentId || !name) return;
  try {
    await api("/v1/vaults", { method: "POST", body: JSON.stringify({ agent_id: agentId, name }) });
    closeModal(); loadVaults(); showToast("Vault created");
  } catch (e) { showToast(e.message, "error"); }
}

async function deleteVault(id) {
  try { await api(`/v1/vaults/${id}`, { method: "DELETE" }); loadVaults(); showToast("Vault deleted"); }
  catch (e) { showToast(e.message, "error"); }
}

function showAddEntryModal(vaultId) {
  $("modals").innerHTML = `<div class="modal-overlay" data-action="close-modal">
    <div class="modal" onclick="if(!event.target.closest('[data-action]'))event.stopPropagation()">
      <h2>Add Secret</h2>
      <div class="form-group"><label class="form-label">Key</label>
        <select class="form-select" id="entryKey">
          <option value="ANTHROPIC_API_KEY">ANTHROPIC_API_KEY</option>
          <option value="CLAUDE_CODE_OAUTH_TOKEN">CLAUDE_CODE_OAUTH_TOKEN</option>
          <option value="OPENAI_API_KEY">OPENAI_API_KEY</option>
          <option value="SPRITE_TOKEN">SPRITE_TOKEN</option>
          <option value="custom">Custom key...</option>
        </select>
      </div>
      <div class="form-group" id="customKeyGroup" style="display:none"><label class="form-label">Custom Key Name</label><input class="form-input" id="customKeyName" /></div>
      <div class="form-group"><label class="form-label">Value</label><input class="form-input" id="entryValue" type="password" /></div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="addEntry('${esc(vaultId)}')">Save</button>
      </div>
    </div>
  </div>`;
  $("entryKey").addEventListener("change", (e) => {
    $("customKeyGroup").style.display = e.target.value === "custom" ? "block" : "none";
  });
}

async function addEntry(vaultId) {
  let key = $("entryKey")?.value;
  if (key === "custom") key = $("customKeyName")?.value?.trim();
  const value = $("entryValue")?.value;
  if (!key || !value) { showToast("Key and value required", "error"); return; }
  try {
    await api(`/v1/vaults/${vaultId}/entries/${key}`, { method: "PUT", body: JSON.stringify({ value }) });
    closeModal(); loadVaults(); showToast("Secret saved");
  } catch (e) { showToast(e.message, "error"); }
}

function editVaultEntry(vaultId, key) {
  $("modals").innerHTML = `<div class="modal-overlay" data-action="close-modal">
    <div class="modal" onclick="if(!event.target.closest('[data-action]'))event.stopPropagation()">
      <h2>Edit ${esc(key)}</h2>
      <div class="form-group"><label class="form-label">New Value</label><input class="form-input" id="editEntryValue" type="password" /></div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="updateEntry('${esc(vaultId)}','${esc(key)}')">Save</button>
      </div>
    </div>
  </div>`;
}

async function updateEntry(vaultId, key) {
  const value = $("editEntryValue")?.value;
  if (!value) { showToast("Value required", "error"); return; }
  try {
    await api(`/v1/vaults/${vaultId}/entries/${key}`, { method: "PUT", body: JSON.stringify({ value }) });
    closeModal(); loadVaults(); showToast("Secret updated");
  } catch (e) { showToast(e.message, "error"); }
}

async function deleteVaultEntry(vaultId, key) {
  try { await api(`/v1/vaults/${vaultId}/entries/${key}`, { method: "DELETE" }); loadVaults(); showToast("Secret deleted"); }
  catch (e) { showToast(e.message, "error"); }
}

// ═══════════════════════════════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════════════════════════════

async function loadSessionsForEvents() {
  try {
    const data = await api("/v1/sessions?limit=50&order=desc");
    const select = $("eventsSessionSelect");
    select.innerHTML = '<option value="">Select session...</option>' +
      (data.data || []).map((s) => `<option value="${esc(s.id)}">${esc(s.title || s.id.slice(0, 20))} (${s.status})</option>`).join("");
  } catch (e) { console.error(e); }
}

async function loadEvents() {
  const sessionId = $("eventsSessionSelect")?.value;
  if (!sessionId) return;
  try {
    const data = await api(`/v1/sessions/${sessionId}/events?limit=200&order=asc`);
    allEvents = (data.data || []).map((evt, i, arr) => ({
      ...evt,
      deltaMs: i > 0 && evt.processed_at && arr[i - 1].processed_at
        ? new Date(evt.processed_at) - new Date(arr[i - 1].processed_at)
        : null,
    }));
    expandedEventIds.clear();
    renderEvents();
  } catch (e) { showToast(e.message, "error"); }
}

function renderEvents() {
  const el = $("eventsList");
  const stats = $("eventsStats");
  if (!allEvents.length) { el.innerHTML = '<div class="empty-state"><p>No events</p></div>'; stats.textContent = ""; return; }

  let totalIn = 0, totalOut = 0;
  allEvents.forEach((e) => {
    if (e.model_usage) { totalIn += e.model_usage.input_tokens || 0; totalOut += e.model_usage.output_tokens || 0; }
  });
  stats.textContent = `${allEvents.length} events` + (totalIn ? ` \u00B7 ${totalIn}\u2193 ${totalOut}\u2191 tokens` : "");

  el.innerHTML = allEvents.map((evt) => {
    const expanded = expandedEventIds.has(evt.id);
    const badge = badgeClass(evt.type);
    let preview = "";
    if (evt.type === "user.message" || evt.type === "agent.message") {
      const text = (Array.isArray(evt.content) ? evt.content.map((b) => b.text || "").join("") : (typeof evt.content === "string" ? evt.content : ""));
      preview = text.length > 100 ? text.slice(0, 100) + "..." : text;
    } else if (evt.name) { preview = evt.name; }

    let tokens = "";
    if (evt.model_usage) tokens = `<span class="tokens">${evt.model_usage.input_tokens || 0}\u2193 ${evt.model_usage.output_tokens || 0}\u2191</span>`;

    return `<div class="event-row" data-action="toggle-event" data-id="${esc(evt.id)}">
      <span class="seq">${evt.seq}</span>
      <span class="badge ${badge}">${evt.type}</span>
      <span class="preview">${esc(preview)}</span>
      ${tokens}
      ${evt.deltaMs != null ? `<span class="delta">+${evt.deltaMs}ms</span>` : ''}
    </div>
    ${expanded ? `<div class="event-detail"><pre>${esc(JSON.stringify(evt, null, 2))}</pre></div>` : ''}`;
  }).join("");
}

function toggleEvent(id) {
  expandedEventIds.has(id) ? expandedEventIds.delete(id) : expandedEventIds.add(id);
  renderEvents();
}

function badgeClass(type) {
  if (type.startsWith("user.")) return "badge-user";
  if (type.startsWith("agent.")) return "badge-agent";
  if (type.startsWith("session.error")) return "badge-error";
  if (type.startsWith("session.")) return "badge-status";
  if (type.startsWith("span.")) return "badge-span";
  return "badge-idle";
}

function copyEvents() {
  navigator.clipboard.writeText(JSON.stringify(allEvents, null, 2));
  showToast("Copied JSON");
}
