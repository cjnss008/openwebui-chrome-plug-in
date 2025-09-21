const storage = chrome.storage.sync;
const DEFAULT_SETTINGS = {
  baseUrl: "",
  apiKey: "",
  defaultModel: "gpt-5-chat-latest"
};

const elements = {
  messages: document.getElementById("messages"),
  prompt: document.getElementById("prompt"),
  send: document.getElementById("send"),
  status: document.getElementById("status"),
  newChat: document.getElementById("new-chat"),
  modelSelect: document.getElementById("model"),
  captureToggle: document.getElementById("capture-page"),
  settingsBtn: document.getElementById("settings"),
  settingsOverlay: document.getElementById("settings-overlay"),
  settingsClose: document.getElementById("close-settings"),
  settingBase: document.getElementById("setting-base"),
  settingKey: document.getElementById("setting-key"),
  settingModel: document.getElementById("setting-model"),
  saveSettings: document.getElementById("save-settings"),
  testSettings: document.getElementById("test-settings"),
  settingsHint: document.getElementById("settings-hint")
};

let state = {
  settings: { ...DEFAULT_SETTINGS },
  models: [],
  chatId: null,
  sessionId: crypto.randomUUID(),
  messages: [],
  isSending: false,
  captureEnabled: false
};

marked.setOptions({
  breaks: true,
  gfm: true
});

function setStatus(message, isError = false) {
  elements.status.textContent = message || "";
  elements.status.classList.toggle("error", isError);
}

function setSettingsHint(message, isError = false) {
  elements.settingsHint.textContent = message || "";
  elements.settingsHint.classList.toggle("error", isError);
}

function createMessageElement(role, content) {
  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;
  const roleLabel = document.createElement("span");
  roleLabel.className = "role-label";
  roleLabel.textContent = role === "assistant" ? "COPILOT" : "YOU";
  const contentEl = document.createElement("div");
  contentEl.className = "message-content markdown-body";
  try {
    const html = marked.parse(content || "");
    contentEl.innerHTML = html;
  } catch (err) {
    contentEl.textContent = content || "";
  }
  wrapper.appendChild(roleLabel);
  wrapper.appendChild(contentEl);
  return wrapper;
}

function appendMessage(role, content) {
  const el = createMessageElement(role, content);
  elements.messages.appendChild(el);
  requestAnimationFrame(() => {
    elements.messages.scrollTop = elements.messages.scrollHeight;
  });
}

function resetConversation() {
  state.messages = [];
  state.chatId = null;
  state.sessionId = crypto.randomUUID();
  elements.messages.innerHTML = "";
  appendMessage("assistant", "你好！我是基于 OpenWebUI 的 Copilot，随时为你服务。");
}

async function loadSettings() {
  const stored = await new Promise((resolve) => {
    storage.get(["baseUrl", "apiKey", "defaultModel"], (result) => resolve(result || {}));
  });
  state.settings = {
    baseUrl: stored.baseUrl || DEFAULT_SETTINGS.baseUrl,
    apiKey: stored.apiKey || DEFAULT_SETTINGS.apiKey,
    defaultModel: stored.defaultModel || DEFAULT_SETTINGS.defaultModel
  };
  applySettingsToUI();
  await refreshModels();
}

function applySettingsToUI() {
  elements.settingBase.value = state.settings.baseUrl;
  elements.settingKey.value = state.settings.apiKey;
  elements.settingModel.value = state.settings.defaultModel || DEFAULT_SETTINGS.defaultModel;
  updateModelSelect();
}

function updateModelSelect() {
  const select = elements.modelSelect;
  const models = state.models.length ? state.models : [];
  const current = state.settings.defaultModel || DEFAULT_SETTINGS.defaultModel;
  select.innerHTML = "";
  if (!models.length && current) {
    const opt = document.createElement("option");
    opt.value = current;
    opt.textContent = current;
    select.appendChild(opt);
  } else {
    models.forEach((model) => {
      const opt = document.createElement("option");
      opt.value = model;
      opt.textContent = model;
      select.appendChild(opt);
    });
    if (current && !models.includes(current)) {
      const opt = document.createElement("option");
      opt.value = current;
      opt.textContent = current + " (自定义)";
      select.appendChild(opt);
    }
  }
  select.value = current;
}

async function saveSettings() {
  const baseUrl = elements.settingBase.value.trim();
  const apiKey = elements.settingKey.value.trim();
  const defaultModel = elements.settingModel.value.trim() || DEFAULT_SETTINGS.defaultModel;
  state.settings = { baseUrl, apiKey, defaultModel };
  await new Promise((resolve) => storage.set(state.settings, resolve));
  applySettingsToUI();
  setSettingsHint("已保存。");
  await refreshModels();
}

async function refreshModels() {
  if (!state.settings.baseUrl || !state.settings.apiKey) {
    state.models = [];
    updateModelSelect();
    return;
  }
  try {
    const response = await fetch(safeJoin(state.settings.baseUrl, "/api/models"), {
      headers: buildAuthHeaders(state.settings.apiKey)
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    const models = Array.isArray(data?.data) ? data.data : data;
    const names = (models || [])
      .map((m) => (typeof m === "string" ? m : m?.id || m?.name))
      .filter((v) => typeof v === "string" && v.trim().length > 0);
    if (names.length) {
      state.models = [...new Set(names)];
      if (!state.models.includes(state.settings.defaultModel)) {
        state.settings.defaultModel = state.models[0];
      }
    }
  } catch (err) {
    console.warn("加载模型失败", err);
    state.models = [];
  }
  updateModelSelect();
}

function buildAuthHeaders(apiKey) {
  return {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
}

function safeJoin(base, path) {
  if (!base) return path;
  return `${base.replace(/\/$/, "")}${path}`;
}

async function testConnection({ baseUrl, apiKey }) {
  if (!baseUrl || !apiKey) {
    throw new Error("请填写地址和 API Key");
  }
  const response = await fetch(safeJoin(baseUrl, "/api/models"), {
    headers: buildAuthHeaders(apiKey)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return await response.json();
}

function autoResizeTextarea() {
  const ta = elements.prompt;
  ta.style.height = "auto";
  const max = parseInt(getComputedStyle(ta).lineHeight || "20", 10) * 5 + 24;
  ta.style.height = Math.min(ta.scrollHeight, max) + "px";
  if (ta.scrollHeight > max) {
    ta.style.overflowY = "auto";
  } else {
    ta.style.overflowY = "hidden";
  }
}

elements.prompt.addEventListener("input", autoResizeTextarea);

autoResizeTextarea();

async function ensureChatId() {
  if (state.chatId || !state.settings.baseUrl || !state.settings.apiKey) {
    return state.chatId;
  }
  try {
    const response = await fetch(safeJoin(state.settings.baseUrl, "/api/v1/chats/new"), {
      method: "POST",
      headers: buildAuthHeaders(state.settings.apiKey),
      body: JSON.stringify({ chat: {} })
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    const cid = data?.id || data?.data?.id || data?.chat?.id;
    if (cid) {
      state.chatId = cid;
    }
  } catch (err) {
    console.warn("创建新对话失败，继续使用临时会话", err);
  }
  return state.chatId;
}

function extractAssistantMessage(data) {
  const choice = data?.choices?.[0];
  if (choice?.message?.content) {
    return choice.message.content;
  }
  if (typeof data?.message === "string") {
    return data.message;
  }
  if (Array.isArray(data?.messages)) {
    const assistant = data.messages.find((m) => m.role === "assistant");
    if (assistant?.content) {
      return assistant.content;
    }
  }
  return "(未返回内容)";
}

function extractChatId(data, fallback = null) {
  for (const key of ["chat_id", "conversation_id"]) {
    if (typeof data?.[key] === "string" && data[key].length >= 8) {
      return data[key];
    }
  }
  if (typeof data?.chat?.id === "string") {
    return data.chat.id;
  }
  try {
    const meta = data?.choices?.[0]?.message?.metadata || {};
    for (const key of ["chat_id", "conversation_id"]) {
      if (typeof meta[key] === "string" && meta[key].length >= 8) {
        return meta[key];
      }
    }
  } catch (err) {
    /* ignore */
  }
  return fallback;
}

async function sendPrompt() {
  if (state.isSending) {
    return;
  }
  const prompt = elements.prompt.value.trim();
  if (!prompt) {
    return;
  }
  if (!state.settings.baseUrl || !state.settings.apiKey) {
    setStatus("请先填写设置。", true);
    openSettings();
    return;
  }
  state.isSending = true;
  elements.send.disabled = true;
  setStatus("思考中...");

  const model = elements.modelSelect.value || state.settings.defaultModel || DEFAULT_SETTINGS.defaultModel;
  const userMessage = { role: "user", content: prompt };
  state.messages.push(userMessage);
  appendMessage("user", prompt);
  elements.prompt.value = "";
  autoResizeTextarea();

  let contextMessage = null;
  let contextInfo = null;
  if (state.captureEnabled) {
    try {
      contextInfo = await captureCurrentPage();
      if (contextInfo?.content) {
        const lines = contextInfo.content.trim().slice(0, 8000);
        contextMessage = {
          role: "system",
          content: `当前页面地址: ${contextInfo.url}\n抓取方式: ${contextInfo.source}\n页面内容片段:\n${lines}`
        };
      }
    } catch (err) {
      console.warn("抓取页面失败", err);
    }
  }

  const payloadMessages = [];
  if (contextMessage) {
    payloadMessages.push(contextMessage);
  }
  state.messages.forEach((msg) => {
    payloadMessages.push({ role: msg.role, content: msg.content });
  });

  const body = {
    messages: payloadMessages,
    stream: false,
    model,
    session_id: state.sessionId
  };

  const existingChatId = await ensureChatId();
  if (existingChatId) {
    body.chat_id = existingChatId;
  }

  try {
    const response = await fetch(safeJoin(state.settings.baseUrl, "/api/chat/completions"), {
      method: "POST",
      headers: buildAuthHeaders(state.settings.apiKey),
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    const assistantText = extractAssistantMessage(data);
    const cid = extractChatId(data, existingChatId);
    if (cid) {
      state.chatId = cid;
    }
    const assistantMessage = { role: "assistant", content: assistantText };
    state.messages.push(assistantMessage);
    appendMessage("assistant", assistantText);
    if (contextInfo && contextInfo.succeeded) {
      setStatus(`完成。页面抓取方式: ${contextInfo.source}`);
    } else if (contextInfo) {
      setStatus(`已回答，页面抓取退化为 ${contextInfo.source}`);
    } else {
      setStatus("完成。");
    }
  } catch (err) {
    console.error("发送失败", err);
    setStatus(`发送失败: ${err.message}`, true);
    state.messages.pop(); // remove pending user message
    const allMessages = document.querySelectorAll(".message.user");
    if (allMessages.length) {
      allMessages[allMessages.length - 1].remove();
    }
  } finally {
    state.isSending = false;
    elements.send.disabled = false;
  }
}

elements.send.addEventListener("click", sendPrompt);

elements.prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendPrompt();
  }
});

elements.newChat.addEventListener("click", () => {
  resetConversation();
  setStatus("已新建对话。重置上下文。");
});

elements.modelSelect.addEventListener("change", (event) => {
  const value = event.target.value;
  if (value) {
    state.settings.defaultModel = value;
    storage.set({ defaultModel: value });
  }
});

elements.captureToggle.addEventListener("change", (event) => {
  state.captureEnabled = event.target.checked;
  storage.set({ captureEnabled: state.captureEnabled });
});

function openSettings() {
  elements.settingsOverlay.classList.remove("hidden");
}

function closeSettings() {
  elements.settingsOverlay.classList.add("hidden");
}

elements.settingsBtn.addEventListener("click", openSettings);

elements.settingsClose.addEventListener("click", closeSettings);

elements.saveSettings.addEventListener("click", () => {
  saveSettings().catch((err) => setSettingsHint(err.message, true));
});

elements.testSettings.addEventListener("click", async () => {
  try {
    setSettingsHint("测试中...");
    const baseUrl = elements.settingBase.value.trim();
    const apiKey = elements.settingKey.value.trim();
    await testConnection({ baseUrl, apiKey });
    setSettingsHint("连接成功，模型列表已更新。");
    await refreshModels();
  } catch (err) {
    setSettingsHint(`连接失败: ${err.message}`, true);
  }
});

async function restoreCapturePreference() {
  const stored = await new Promise((resolve) => storage.get(["captureEnabled"], (result) => resolve(result || {})));
  const enabled = stored.captureEnabled === true;
  state.captureEnabled = enabled;
  elements.captureToggle.checked = enabled;
}

async function captureCurrentPage() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.url || !tab.id) {
    return null;
  }
  if (!/^https?:/i.test(tab.url)) {
    return { url: tab.url, content: "", source: "unsupported", succeeded: false };
  }
  const url = tab.url;

  const attemptOrder = [fetchViaJina, fetchViaHtml, fetchViaDom];
  for (const attempt of attemptOrder) {
    try {
      const result = await attempt(url, tab.id);
      if (result && result.content && result.content.trim().length > 50) {
        return { ...result, url, source: result.source, succeeded: true };
      }
    } catch (err) {
      console.warn("抓取方式失败", attempt.name, err);
    }
  }
  return { url, content: "", source: "none", succeeded: false };
}

async function fetchViaJina(url) {
  const jinaUrl = `https://r.jina.ai/${encodeURI(url)}`;
  const response = await fetch(jinaUrl, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Jina 返回 ${response.status}`);
  }
  const text = await response.text();
  return { content: truncate(text), source: "jina" };
}

async function fetchViaHtml(url) {
  const response = await fetch(url, { method: "GET", credentials: "omit" });
  if (!response.ok) {
    throw new Error(`HTML 抓取返回 ${response.status}`);
  }
  const html = await response.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const bodyText = doc.body ? doc.body.innerText : "";
  return { content: truncate(bodyText), source: "html" };
}

async function fetchViaDom(url, tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const text = document.body ? document.body.innerText : "";
      return text.slice(0, 20000);
    }
  });
  return { content: truncate(result || ""), source: "dom" };
}

function truncate(text, limit = 10000) {
  if (!text) {
    return "";
  }
  if (text.length <= limit) {
    return text;
  }
  return text.slice(0, limit) + "\n...\n(内容已截断)";
}

function wireVisibilityUpdates() {
  chrome.runtime.sendMessage({ type: "panel-state", isOpen: true }).catch(() => {});
  document.addEventListener("visibilitychange", () => {
    const isVisible = document.visibilityState === "visible";
    chrome.runtime.sendMessage({ type: "panel-state", isOpen: isVisible }).catch(() => {});
  });
}

async function init() {
  wireVisibilityUpdates();
  await loadSettings();
  await restoreCapturePreference();
  resetConversation();
}

init().catch((err) => {
  console.error("初始化失败", err);
  setStatus(`初始化失败: ${err.message}`, true);
});
