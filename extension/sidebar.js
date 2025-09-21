const storage = chrome.storage.sync;
const DEFAULT_MODEL = "gpt-5-chat-latest";
const DEFAULT_SETTINGS = { baseUrl: "", apiKey: "" };

const elements = {
  messages: document.getElementById("messages"),
  prompt: document.getElementById("prompt"),
  send: document.getElementById("send"),
  status: document.getElementById("status"),
  newChat: document.getElementById("new-chat"),
  modelTrigger: document.getElementById("model-trigger"),
  modelTriggerLabel: document.getElementById("model-trigger-label"),
  modelMenu: document.getElementById("model-menu"),
  captureToggle: document.getElementById("capture-page"),
  settingsBtn: document.getElementById("settings"),
  settingsOverlay: document.getElementById("settings-overlay"),
  settingsClose: document.getElementById("close-settings"),
  settingBase: document.getElementById("setting-base"),
  settingKey: document.getElementById("setting-key"),
  saveSettings: document.getElementById("save-settings"),
  testSettings: document.getElementById("test-settings"),
  settingsHint: document.getElementById("settings-hint"),
  historyBtn: document.getElementById("history-btn"),
  historyOverlay: document.getElementById("history-overlay"),
  historyClose: document.getElementById("close-history"),
  historyList: document.getElementById("history-list"),
  historyEmpty: document.getElementById("history-empty"),
  closePanel: document.getElementById("close-panel")
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  models: [],
  selectedModel: DEFAULT_MODEL,
  chatId: null,
  sessionId: crypto.randomUUID(),
  messages: [],
  isSending: false,
  captureEnabled: false,
  modelMenuOpen: false,
  pendingMessage: null,
  titleLocked: false
};

marked.setOptions({ breaks: true, gfm: true });

function setStatus(message, isError = false) {
  elements.status.textContent = message || "";
  elements.status.classList.toggle("error", isError);
}

function setSettingsHint(message, isError = false) {
  elements.settingsHint.textContent = message || "";
  elements.settingsHint.classList.toggle("error", isError);
}

function setMessageContent(target, content) {
  if (!target) return;
  try {
    target.innerHTML = marked.parse(content || "");
  } catch (err) {
    target.textContent = content || "";
  }
}

function createMessageElement(role, content) {
  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;
  const roleLabel = document.createElement("span");
  roleLabel.className = "role-label";
  roleLabel.textContent = role === "assistant" ? "COPILOT" : "YOU";
  const contentEl = document.createElement("div");
  contentEl.className = "message-content markdown-body";
  setMessageContent(contentEl, content || "");
  wrapper.appendChild(roleLabel);
  wrapper.appendChild(contentEl);
  return { wrapper, contentEl };
}

function appendMessage(role, content) {
  const { wrapper, contentEl } = createMessageElement(role, content);
  elements.messages.appendChild(wrapper);
  requestAnimationFrame(() => {
    elements.messages.scrollTop = elements.messages.scrollHeight;
  });
  return { wrapper, contentEl };
}

function resetConversation(showGreeting = true) {
  state.messages = [];
  state.chatId = null;
  state.sessionId = crypto.randomUUID();
  state.pendingMessage = null;
  state.titleLocked = false;
  elements.messages.innerHTML = "";
  if (showGreeting) {
    appendMessage("assistant", "你好！我是大厂乐乎，今天有什么可以帮忙的吗？");
  }
}

function updateModelButtonLabel() {
  elements.modelTriggerLabel.textContent = "模型";
}

function headersWithAuth(extra = {}) {
  if (!state.settings.apiKey) {
    throw new Error("缺少 API Key");
  }
  return { Authorization: `Bearer ${state.settings.apiKey}`, ...extra };
}

function safeJoin(base, path) {
  if (!base) return path;
  return `${base.replace(/\/$/, "")}${path}`;
}

async function apiCall(path, { method = "GET", json, headers = {}, body } = {}) {
  if (!state.settings.baseUrl || !state.settings.apiKey) {
    throw new Error("请先配置 OpenWebUI 地址与 API Key");
  }
  const finalHeaders = headersWithAuth(headers);
  let finalBody = body;
  if (json !== undefined) {
    finalHeaders["Content-Type"] = "application/json";
    finalBody = JSON.stringify(json);
  }
  const response = await fetch(safeJoin(state.settings.baseUrl, path), {
    method,
    headers: finalHeaders,
    body: finalBody
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

async function fetchChatSnapshot(chatId) {
  const data = await apiCall(`/api/v1/chats/${chatId}?refresh=1`);
  return data?.chat ? data.chat : data || {};
}

function stripMarkdown(input) {
  if (!input) return "";
  let s = String(input);
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  s = s.replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ""));
  s = s.replace(/`/g, "");
  ["**", "__", "*", "_", "~~"].forEach((mark) => {
    s = s.split(mark).join("");
  });
  s = s.replace(/^[#>\-\+\*]\s*/gm, "");
  s = s.replace(/\|\s*-{2,}\s*\|/g, "|");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function buildChatTitle(seedText) {
  const baseText = stripMarkdown(seedText).replace(/\s+/g, " ").trim().slice(0, 16) || "会话";
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${baseText} · ${ts}`;
}

async function appendUserAndAssistant(chatId, model, userContent) {
  const chat = await fetchChatSnapshot(chatId);
  const ts = Date.now();
  const userMid = crypto.randomUUID();
  const assistantMid = crypto.randomUUID();

  const messages = Array.isArray(chat?.messages) ? [...chat.messages] : [];
  const history = chat?.history ? { ...chat.history } : { current_id: null, messages: {} };
  const histMsgs = history.messages ? { ...history.messages } : {};

  const userMsg = {
    id: userMid,
    role: "user",
    content: userContent,
    timestamp: ts,
    models: model ? [model] : []
  };
  const assistantMsg = {
    id: assistantMid,
    role: "assistant",
    content: "",
    parentId: userMid,
    modelName: model,
    modelIdx: 0,
    timestamp: ts + 1
  };

  messages.push(userMsg, assistantMsg);
  histMsgs[userMid] = userMsg;
  histMsgs[assistantMid] = assistantMsg;

  const payloadChat = {
    id: chatId,
    messages,
    history: { current_id: assistantMid, messages: histMsgs }
  };

  if (!state.titleLocked && (!chat?.title || String(chat.title).trim() === "")) {
    payloadChat.title = buildChatTitle(userContent);
    state.titleLocked = true;
  }

  await apiCall(`/api/v1/chats/${chatId}?refresh=1`, {
    method: "POST",
    json: { chat: payloadChat }
  });

  return { userMid, assistantMid };
}

async function persistAssistantCompletion(chatId, details) {
  const { userMid, assistantMid, text, model } = details;
  try {
    const chat = await fetchChatSnapshot(chatId);
    const messages = Array.isArray(chat?.messages) ? [...chat.messages] : [];
    const history = chat?.history ? { ...chat.history } : { current_id: null, messages: {} };
    const histMsgs = history.messages ? { ...history.messages } : {};

    const assistantObj = {
      id: assistantMid,
      role: "assistant",
      content: text,
      timestamp: Date.now(),
      parentId: userMid || null
    };
    if (model) {
      assistantObj.modelName = model;
      assistantObj.modelIdx = 0;
    }

    let replaced = false;
    for (let i = 0; i < messages.length; i += 1) {
      if (String(messages[i]?.id) === String(assistantMid)) {
        messages[i] = { ...messages[i], ...assistantObj };
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      messages.push(assistantObj);
    }

    histMsgs[String(assistantMid)] = { ...assistantObj };
    history.messages = histMsgs;
    history.current_id = String(assistantMid);

    await apiCall(`/api/v1/chats/${chatId}?refresh=1`, {
      method: "POST",
      json: { chat: { id: chatId, messages, history } }
    });

    const completedPayload = {
      chat_id: chatId,
      id: assistantMid
    };
    if (model) completedPayload.model = model;
    if (state.sessionId) completedPayload.session_id = state.sessionId;

    await apiCall("/api/chat/completed", {
      method: "POST",
      json: completedPayload
    });
  } catch (err) {
    console.warn("persistAssistantCompletion failed", err);
  }
}

function autoResizeTextarea() {
  const ta = elements.prompt;
  ta.style.height = "auto";
  const line = parseInt(getComputedStyle(ta).lineHeight || "20", 10);
  const max = line * 5 + 20;
  ta.style.height = `${Math.min(ta.scrollHeight, max)}px`;
  ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
}

elements.prompt.addEventListener("input", autoResizeTextarea);
autoResizeTextarea();

async function loadSettings() {
  const stored = await new Promise((resolve) => {
    storage.get(["baseUrl", "apiKey", "selectedModel", "capturePage"], (result) => resolve(result || {}));
  });
  state.settings = {
    baseUrl: stored.baseUrl || DEFAULT_SETTINGS.baseUrl,
    apiKey: stored.apiKey || DEFAULT_SETTINGS.apiKey
  };
  state.selectedModel = stored.selectedModel || DEFAULT_MODEL;
  state.captureEnabled = stored.capturePage === true;
  applySettingsToUI();
  updateModelButtonLabel();
  elements.captureToggle.checked = state.captureEnabled;
  await refreshModels();
}

function applySettingsToUI() {
  elements.settingBase.value = state.settings.baseUrl;
  elements.settingKey.value = state.settings.apiKey;
}

async function saveSettings() {
  const baseUrl = elements.settingBase.value.trim();
  const apiKey = elements.settingKey.value.trim();
  state.settings = { baseUrl, apiKey };
  await new Promise((resolve) => storage.set({ baseUrl, apiKey }, resolve));
  setSettingsHint("已保存。");
  await refreshModels();
}

function extractModelNames(data) {
  if (!data) return [];
  if (Array.isArray(data)) {
    return data
      .map((m) => (typeof m === "string" ? m : m?.id || m?.name))
      .filter((v) => typeof v === "string" && v.trim().length > 0);
  }
  if (typeof data === "object") {
    if (Array.isArray(data.data)) return extractModelNames(data.data);
    if (Array.isArray(data.models)) return extractModelNames(data.models);
    if (Array.isArray(data.items)) return extractModelNames(data.items);
  }
  return [];
}

async function refreshModels() {
  if (!state.settings.baseUrl || !state.settings.apiKey) {
    state.models = [];
    updateModelButtonLabel();
    return;
  }
  try {
    const data = await apiCall("/api/models");
    const names = [...new Set(extractModelNames(data))];
    if (names.length) {
      state.models = names;
      if (!state.models.includes(state.selectedModel)) {
        state.selectedModel = state.models[0];
        storage.set({ selectedModel: state.selectedModel });
      }
    }
  } catch (err) {
    console.warn("加载模型失败", err);
    state.models = [];
  }
  updateModelButtonLabel();
  if (state.modelMenuOpen) {
    renderModelMenu();
  }
}

async function ensureChatId() {
  if (state.chatId || !state.settings.baseUrl || !state.settings.apiKey) {
    return state.chatId;
  }
  try {
    const payload = { chat: {} };
    if (state.selectedModel) {
      payload.chat.models = [state.selectedModel];
    }
    const data = await apiCall("/api/v1/chats/new", { method: "POST", json: payload });
    const cid = data?.id || data?.data?.id || data?.chat?.id;
    if (cid) {
      state.chatId = cid;
      state.titleLocked = false;
    }
  } catch (err) {
    console.warn("创建新对话失败", err);
  }
  return state.chatId;
}

function getCurrentModel() {
  return state.selectedModel || DEFAULT_MODEL;
}

function renderModelMenu() {
  const menu = elements.modelMenu;
  menu.innerHTML = "";
  const models = state.models.length ? state.models : [state.selectedModel || DEFAULT_MODEL];
  models.forEach((model) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "model-option";
    item.textContent = model;
    const isSelected = model === state.selectedModel;
    if (isSelected) {
      item.classList.add("selected");
    }
    item.addEventListener("click", () => {
      state.selectedModel = model;
      storage.set({ selectedModel: model });
      updateModelButtonLabel();
      closeModelMenu();
    });
    menu.appendChild(item);
  });
}

function toggleModelMenu() {
  if (state.modelMenuOpen) {
    closeModelMenu();
    return;
  }
  renderModelMenu();
  state.modelMenuOpen = true;
  elements.modelMenu.classList.remove("hidden");
}

function closeModelMenu() {
  if (!state.modelMenuOpen) return;
  state.modelMenuOpen = false;
  elements.modelMenu.classList.add("hidden");
}

elements.modelTrigger.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleModelMenu();
});

document.addEventListener("click", (event) => {
  if (!state.modelMenuOpen) return;
  if (!elements.modelMenu.contains(event.target) && !elements.modelTrigger.contains(event.target)) {
    closeModelMenu();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeModelMenu();
  }
});

async function testConnection({ baseUrl, apiKey }) {
  const response = await fetch(safeJoin(baseUrl, "/api/models"), {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

function extractChats(data) {
  const list = [];
  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node === "object") {
      if (node.id || node.chat_id || node.uuid) {
        list.push(node);
        return;
      }
      Object.values(node).forEach(visit);
    }
  };
  visit(data);
  return list;
}

async function loadHistoryList() {
  elements.historyList.innerHTML = "";
  elements.historyEmpty.classList.add("hidden");
  const endpoints = [
    "/api/v1/chats/pinned",
    "/api/v1/chats/list?limit=50",
    "/api/v1/chats?limit=50"
  ];
  const seen = new Map();

  for (const path of endpoints) {
    try {
      const data = await apiCall(path);
      extractChats(data).forEach((chat) => {
        const id = chat.id || chat.chat_id || chat.uuid;
        if (!id || seen.has(id)) return;
        seen.set(id, chat);
      });
    } catch (err) {
      console.warn("history endpoint failed", path, err);
    }
  }

  const chats = Array.from(seen.values());
  if (!chats.length) {
    elements.historyEmpty.classList.remove("hidden");
    return;
  }

  chats.sort((a, b) => {
    const ta = new Date(a.updated_at || a.last_message_ts || a.created_at || 0).getTime();
    const tb = new Date(b.updated_at || b.last_message_ts || b.created_at || 0).getTime();
    return tb - ta;
  });

  chats.forEach((chat) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "history-item";
    const title = chat.title || chat.name || "未命名对话";
    const ts = chat.updated_at || chat.last_message_ts || chat.created_at;
    const meta = ts ? new Date(ts).toLocaleString() : "";
    item.innerHTML = `<span class="history-item-title">${title}</span><span class="history-item-meta">${meta}</span>`;
    const chatId = chat.id || chat.chat_id || chat.uuid;
    item.addEventListener("click", () => loadHistoryChat(chatId));
    elements.historyList.appendChild(item);
  });
}

async function loadHistoryChat(chatId) {
  if (!chatId) return;
  setStatus("正在载入历史对话...");
  try {
    const chat = await fetchChatSnapshot(chatId);
    const messages = Array.isArray(chat?.messages) ? chat.messages : [];
    state.chatId = chatId;
    state.sessionId = crypto.randomUUID();
    state.messages = messages
      .filter((m) => m && (m.role === "user" || m.role === "assistant"))
      .map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : (m.content?.text || "") }));
    elements.messages.innerHTML = "";
    state.messages.forEach((msg) => appendMessage(msg.role, msg.content));
    setStatus("已切换到历史对话，可继续聊天。");
    closeHistory();
  } catch (err) {
    console.error("载入历史对话失败", err);
    setStatus(`载入失败: ${err.message}`, true);
  }
}

elements.historyBtn.addEventListener("click", () => {
  if (!state.settings.baseUrl || !state.settings.apiKey) {
    setStatus("请先在设置中配置连接。", true);
    openSettings();
    return;
  }
  closeModelMenu();
  elements.historyOverlay.classList.remove("hidden");
  loadHistoryList();
});

elements.historyClose.addEventListener("click", () => {
  elements.historyOverlay.classList.add("hidden");
});

elements.closePanel.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && tab.id !== undefined) {
    chrome.runtime.sendMessage({ type: "close-panel", tabId: tab.id }).catch(() => {});
  }
});

async function sendPrompt() {
  if (state.isSending) return;
  const prompt = elements.prompt.value.trim();
  if (!prompt) return;
  if (!state.settings.baseUrl || !state.settings.apiKey) {
    setStatus("请先填写设置。", true);
    openSettings();
    return;
  }

  closeModelMenu();

  const model = getCurrentModel();
  appendMessage("user", prompt);
  elements.prompt.value = "";
  autoResizeTextarea();
  state.messages.push({ role: "user", content: prompt });
  state.isSending = true;
  elements.send.disabled = true;
  setStatus("思考中...");

  let contextInfo = null;
  let contextMessage = null;

  if (state.captureEnabled) {
    try {
      contextInfo = await captureCurrentPage();
      if (contextInfo?.content) {
        const truncated = contextInfo.content.trim().slice(0, 8000);
        contextMessage = {
          role: "system",
          content: `当前页面地址: ${contextInfo.url}\n抓取方式: ${contextInfo.source}\n页面内容片段:\n${truncated}`
        };
      }
    } catch (err) {
      console.warn("抓取页面失败", err);
    }
  }

  let chatId = await ensureChatId();
  let placeholder = null;
  if (chatId) {
    try {
      placeholder = await appendUserAndAssistant(chatId, model, prompt);
      state.pendingMessage = placeholder;
    } catch (err) {
      console.warn("append placeholder failed", err);
    }
  }

  const payloadMessages = [];
  if (contextMessage) payloadMessages.push(contextMessage);
  state.messages.forEach((msg) => {
    payloadMessages.push({ role: msg.role, content: msg.content });
  });

  const body = {
    messages: payloadMessages,
    stream: true,
    model,
    session_id: state.sessionId
  };

  if (chatId) {
    body.chat_id = chatId;
  }

  let assistantBuffer = "";
  let assistantEntry = null;
  let lastPayload = null;

  try {
    const response = await fetch(safeJoin(state.settings.baseUrl, "/api/chat/completions"), {
      method: "POST",
      headers: headersWithAuth({ "Content-Type": "application/json" }),
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    assistantEntry = appendMessage("assistant", "");

    if (contentType.includes("text/event-stream")) {
      await consumeStream(response, {
        onDelta(data) {
          lastPayload = data;
          const chunk = extractAssistantMessage(data);
          if (chunk) {
            assistantBuffer += chunk;
            setMessageContent(assistantEntry.contentEl, assistantBuffer);
          }
          const cid = extractChatId(data);
          if (cid) state.chatId = cid;
        },
        onFallbackText(text) {
          assistantBuffer += text;
          setMessageContent(assistantEntry.contentEl, assistantBuffer);
        }
      });
    } else {
      const rawText = await response.text();
      let data = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch (err) {
        data = null;
      }
      if (data) {
        lastPayload = data;
        assistantBuffer = extractAssistantMessage(data) || "(未返回内容)";
        const cid = extractChatId(data, state.chatId);
        if (cid) state.chatId = cid;
      } else {
        assistantBuffer = rawText || "(未返回内容)";
      }
      setMessageContent(assistantEntry.contentEl, assistantBuffer);
    }

    if (!assistantBuffer.trim()) {
      assistantBuffer = "(暂无响应)";
      setMessageContent(assistantEntry.contentEl, assistantBuffer);
    }

    state.messages.push({ role: "assistant", content: assistantBuffer });

    if (lastPayload) {
      const cid = extractChatId(lastPayload, state.chatId);
      if (cid) state.chatId = cid;
    }

    if (state.chatId && state.pendingMessage) {
      await persistAssistantCompletion(state.chatId, {
        userMid: state.pendingMessage.userMid,
        assistantMid: state.pendingMessage.assistantMid,
        text: assistantBuffer,
        model
      });
    }

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
    state.messages.pop();
    if (assistantEntry && assistantEntry.wrapper.parentElement) {
      assistantEntry.wrapper.remove();
    }
    const userNodes = elements.messages.querySelectorAll(".message.user");
    if (userNodes.length) {
      userNodes[userNodes.length - 1].remove();
    }
    if (state.chatId && state.pendingMessage) {
      await persistAssistantCompletion(state.chatId, {
        userMid: state.pendingMessage.userMid,
        assistantMid: state.pendingMessage.assistantMid,
        text: "(发送失败)",
        model: getCurrentModel()
      });
    }
  } finally {
    state.pendingMessage = null;
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
  closeModelMenu();
  resetConversation();
  setStatus("已新建对话，当前上下文已清空。");
});

elements.captureToggle.addEventListener("change", (event) => {
  const checked = event.target.checked;
  state.captureEnabled = checked;
  storage.set({ capturePage: checked });
});

elements.settingsBtn.addEventListener("click", () => {
  closeModelMenu();
  elements.settingsOverlay.classList.remove("hidden");
});

elements.settingsClose.addEventListener("click", () => {
  elements.settingsOverlay.classList.add("hidden");
});

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

function openSettings() {
  closeModelMenu();
  elements.settingsOverlay.classList.remove("hidden");
}

function closeHistory() {
  elements.historyOverlay.classList.add("hidden");
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
        return { ...result, url, succeeded: true };
      }
    } catch (err) {
      console.warn("抓取方式失败", attempt.name, err);
    }
  }
  return { url, content: "", source: "none", succeeded: false };
}

async function fetchViaJina(url) {
  const response = await fetch(`https://r.jina.ai/${encodeURI(url)}`);
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
  if (!text) return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...\n(内容已截断)`;
}

async function consumeStream(response, handlers) {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    handlers.onFallbackText?.(text);
    return;
  }
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const processEvent = (raw) => {
    const lines = raw.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr) continue;
      if (dataStr === "[DONE]") {
        return;
      }
      try {
        const json = JSON.parse(dataStr);
        handlers.onDelta?.(json);
      } catch (err) {
        handlers.onFallbackText?.(dataStr);
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      if (buffer.trim()) {
        processEvent(buffer.trim());
      }
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (raw.trim()) {
        processEvent(raw.trim());
      }
    }
  }
}

function extractAssistantMessage(data) {
  const choice = data?.choices?.[0];
  if (choice?.message?.content) {
    return normalizeContent(choice.message.content);
  }
  if (choice?.delta?.content) {
    return normalizeContent(choice.delta.content);
  }
  if (typeof data?.message === "string") {
    return data.message;
  }
  if (Array.isArray(data?.messages)) {
    const assistant = data.messages.find((m) => m.role === "assistant");
    if (assistant?.content) {
      return normalizeContent(assistant.content);
    }
  }
  return "";
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((piece) => {
        if (typeof piece === "string") return piece;
        if (piece?.text) return piece.text;
        if (piece?.type === "text" && piece?.data) return piece.data;
        return "";
      })
      .join("");
  }
  if (content?.text) return content.text;
  return "";
}

function extractChatId(data, fallback = null) {
  const keys = ["chat_id", "conversation_id"];
  for (const key of keys) {
    if (typeof data?.[key] === "string" && data[key].length >= 8) {
      return data[key];
    }
  }
  if (typeof data?.chat?.id === "string") {
    return data.chat.id;
  }
  try {
    const meta = data?.choices?.[0]?.message?.metadata || data?.choices?.[0]?.delta?.metadata || {};
    for (const key of keys) {
      if (typeof meta?.[key] === "string" && meta[key].length >= 8) {
        return meta[key];
      }
    }
  } catch (err) {
    /* ignore */
  }
  return fallback;
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
  resetConversation();
}

init().catch((err) => {
  console.error("初始化失败", err);
  setStatus(`初始化失败: ${err.message}`, true);
});
