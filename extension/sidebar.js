const storage = chrome.storage.sync;
const DEFAULT_MODEL = "gpt-5-chat-latest";
const DEFAULT_SETTINGS = { baseUrl: "", apiKey: "" };

const log = (...args) => console.log("[OWUI Sidebar]", ...args);

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
  models: [], // array of { id, label }
  selectedModel: DEFAULT_MODEL,
  selectedModelLabel: DEFAULT_MODEL,
  chatId: null,
  sessionId: crypto.randomUUID(),
  messages: [],
  isSending: false,
  captureEnabled: false,
  modelMenuOpen: false,
  pendingMessage: null,
  titleLocked: false,
  imageCache: new Map()
};

marked.setOptions({ breaks: true, gfm: true });

function setStatus(message, isError = false) {
  elements.status.textContent = message || "";
  elements.status.classList.toggle("error", isError);
  log("status", { message, isError });
}

function setSettingsHint(message, isError = false) {
  elements.settingsHint.textContent = message || "";
  elements.settingsHint.classList.toggle("error", isError);
}

function setMessageContent(target, content) {
  if (!target) return;
  try {
    // 配置 marked 选项
    marked.setOptions({
      breaks: true,      // 支持 GFM 换行
      gfm: true,         // 启用 GitHub 风格 Markdown
      headerIds: false,  // 禁用标题 ID
      mangle: false,     // 不转义 URL
      sanitize: false    // 允许 HTML（以显示图片）
    });
    
    // 渲染 Markdown
    const html = marked.parse(content || "");
    target.innerHTML = html;
  } catch (err) {
    console.error("Markdown 渲染失败:", err);
    target.textContent = content || "";
  }
}

function createMessageElement(role, content, options = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;
  const roleLabel = document.createElement("span");
  roleLabel.className = "role-label";
  const resolvedLabel =
    options.label ||
    (role === "assistant"
      ? getAssistantLabel(options.model)
      : role === "user"
        ? "YOU"
        : role.toUpperCase());
  roleLabel.textContent = resolvedLabel;
  const contentEl = document.createElement("div");
  contentEl.className = "message-content markdown-body";
  setMessageContent(contentEl, content || "");
  wrapper.appendChild(roleLabel);
  wrapper.appendChild(contentEl);
  return { wrapper, contentEl };
}

function appendMessage(role, content, options = {}) {
  const { wrapper, contentEl } = createMessageElement(role, content, options);
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
  state.imageCache.clear();
  elements.messages.innerHTML = "";
  if (showGreeting) {
    appendMessage("assistant", "你好！我是大厂乐乎，今天有什么可以帮忙的吗？", {
      label: getAssistantLabel()
    });
  }
}

function findModelEntry(modelId) {
  return state.models.find((m) => m.id === modelId) || null;
}

function getAssistantLabel(modelId = null) {
  if (!modelId) {
    if (state.selectedModelLabel) return state.selectedModelLabel;
    modelId = state.selectedModel;
  }
  if (!modelId) return state.selectedModelLabel || DEFAULT_MODEL;
  const entry = findModelEntry(modelId);
  if (entry && entry.label) return entry.label;
  if (modelId === state.selectedModel && state.selectedModelLabel) {
    return state.selectedModelLabel;
  }
  return modelId;
}

function updateModelButtonLabel() {
  const entry = findModelEntry(state.selectedModel);
  state.selectedModelLabel = entry ? entry.label : state.selectedModel;
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
    body: finalBody,
    cache: "no-store"
  });
  log("apiCall", { path, method, status: response.status });
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
  log("fetchChatSnapshot", { chatId });
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

function contentPartsFromText(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return [];
  return [{ type: "text", text: trimmed }];
}

function contentToPlainText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((piece) => {
        if (!piece) return "";
        if (typeof piece === "string") return piece;
        if (piece.text) return piece.text;
        if (piece.data) return piece.data;
        if (piece.content) return piece.content;
        return "";
      })
      .join("");
  }
  if (typeof content === "object" && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

function cloneContentParts(parts) {
  if (!Array.isArray(parts)) return [];
  return parts
    .map((part) => {
      if (!part) return null;
      if (typeof part === "string") {
        return { type: "text", text: part };
      }
      if (part.type === "text") {
        return { type: "text", text: part.text || "" };
      }
      if (part.type === "image_url") {
        const img = part.image_url && typeof part.image_url === "object" ? { ...part.image_url } : {};
        if (!img.url) return null;
        return { type: "image_url", image_url: img };
      }
      return null;
    })
    .filter(Boolean);
}

function partsFromContent(content) {
  if (!content) return [];
  if (typeof content === "string") return contentPartsFromText(content);
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return null;
        if (typeof part === "string") return { type: "text", text: part };
        if (part.type === "text" && part.text) return { type: "text", text: part.text };
        if (part.type === "image_url") {
          const img = part.image_url && typeof part.image_url === "object" ? { ...part.image_url } : {};
          if (!img.url) return null;
          return { type: "image_url", image_url: img };
        }
        if (part.text) return { type: "text", text: part.text };
        return null;
      })
      .filter(Boolean);
  }
  if (typeof content === "object") {
    if (typeof content.text === "string") {
      return [{ type: "text", text: content.text }];
    }
    if (content.content) {
      return partsFromContent(content.content);
    }
  }
  return [];
}

function mergeContentParts(target, incoming) {
  incoming.forEach((part) => {
    if (!part) return;
    if (part.type === "text") {
      const text = part.text || "";
      if (!text) return;
      if (target.length && target[target.length - 1].type === "text") {
        target[target.length - 1].text += text;
      } else {
        target.push({ type: "text", text });
      }
      return;
    }
    if (part.type === "image_url") {
      const url = part.image_url && part.image_url.url ? part.image_url.url : "";
      if (!url) return;
      target.push({ type: "image_url", image_url: { url } });
    }
  });
}

function collectImageUrls(parts) {
  const seen = new Set();
  const urls = [];
  (parts || []).forEach((part) => {
    if (part && part.type === "image_url") {
      const url = part.image_url && part.image_url.url ? part.image_url.url : "";
      if (url && !seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
  });
  return urls;
}

function makeAbsoluteOwUrl(url) {
  if (!url) return url;
  if (/^https?:/i.test(url) || url.startsWith("data:")) return url;
  try {
    const base = state.settings.baseUrl || "";
    if (!base) return url;
    const trimmedBase = base.replace(/\/$/, "");
    if (url.startsWith("//")) {
      const baseUrl = new URL(base);
      return `${baseUrl.protocol}${url}`;
    }
    if (url.startsWith("/")) {
      return `${trimmedBase}${url}`;
    }
    return `${trimmedBase}/${url}`;
  } catch (err) {
    return url;
  }
}

function partsToMarkdown(parts) {
  if (!Array.isArray(parts) || !parts.length) return "";
  const segments = [];
  parts.forEach((part) => {
    if (!part) return;
    if (part.type === "text") {
      if (part.text) segments.push(part.text);
    } else if (part.type === "image_url") {
      const url = part.image_url && part.image_url.url ? makeAbsoluteOwUrl(part.image_url.url) : "";
      if (url) segments.push(`![Generated Image](${url})`);
    }
  });
  return segments.join("\n\n").trim();
}

function textFromParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part) => part && part.type === "text" && part.text)
    .map((part) => part.text)
    .join("");
}

function markdownFromTextImages(text, images) {
  const md = [];
  if (text && text.trim()) {
    md.push(text.trim());
  }
  (images || []).forEach((url) => {
    if (!url) return;
    md.push(`![Generated Image](${url})`);
  });
  return md.join("\n\n").trim();
}

function normalizeCompletionContentPart(part) {
  if (!part) return null;
  if (typeof part === "string") {
    return { type: "text", text: part };
  }
  if (part.type === "text" && typeof part.text === "string") {
    return { type: "text", text: part.text };
  }
  if (part.type === "image_url" && part.image_url && typeof part.image_url.url === "string") {
    return { type: "image_url", image_url: { url: part.image_url.url } };
  }
  if (part.image_url && typeof part.image_url.url === "string") {
    return { type: "image_url", image_url: { url: part.image_url.url } };
  }
  if (typeof part.text === "string") {
    return { type: "text", text: part.text };
  }
  return null;
}

function formatCompletionMessageContent(content) {
  if (!content && content !== "") {
    return "";
  }
  if (Array.isArray(content)) {
    const normalized = content.map(normalizeCompletionContentPart).filter(Boolean);
    if (!normalized.length) return "";
    const textOnly = normalized.every((part) => part.type === "text");
    if (textOnly) {
      return normalized.map((part) => part.text || "").join("");
    }
    return normalized;
  }
  if (typeof content === "object") {
    if (Array.isArray(content.content_parts)) {
      const normalized = content.content_parts.map(normalizeCompletionContentPart).filter(Boolean);
      if (normalized.length) {
        const textOnly = normalized.every((part) => part.type === "text");
        if (textOnly) {
          return normalized.map((part) => part.text || "").join("");
        }
        return normalized;
      }
    }
    if (typeof content.text === "string") {
      return content.text;
    }
  }
  return String(content);
}

function formatMessagesForCompletion(messages) {
  return messages.map((msg) => ({
    role: msg.role,
    content: formatCompletionMessageContent(msg.content)
  }));
}

function buildOwContentParts(text, images = []) {
  const parts = [];
  // 只在有实际内容时添加文本 part
  if (text !== undefined && text !== null && text !== "") {
    parts.push({ type: "text", text: String(text) });
  }
  images.forEach((url) => {
    const trimmed = (url || "").trim();
    if (trimmed) {
      parts.push({ type: "image_url", image_url: { url: trimmed } });
    }
  });
  // 不要自动添加空的 text part
  return parts;
}

function messageTextContent(msg) {
  if (!msg) return "";
  if (typeof msg.rawText === "string") return msg.rawText;
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) return textFromParts(msg.content);
  return stripMarkdown(msg.content);
}

function shouldSkipAssistantForCompletion(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return true;
  if (isPlaceholderText(trimmed)) return true;
  if (/^处理中/.test(trimmed)) return true;
  if (trimmed.startsWith("后台处理")) return true;
  if (/^`{3}/.test(trimmed) && /"finish_reason"/.test(trimmed)) return true;
  if (trimmed === "你好！我是大厂乐乎，今天有什么可以帮忙的吗？") return true;
  return false;
}

function buildCompletionMessagesFromState(messages) {
  const systemMessages = [];
  const collected = [];
  let userSeen = 0;
  const MAX_USER_CONTEXT = 3;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || !msg.role) continue;
    if (msg.pending) continue;
    if (msg.role === "system") {
      const text = messageTextContent(msg);
      const trimmed = (text || "").trim();
      if (trimmed) {
        systemMessages.unshift({ role: "system", content: trimmed });
      }
      continue;
    }
    if (msg.role === "assistant") {
      const text = messageTextContent(msg);
      const trimmed = (text || "").trim();
      const images = Array.isArray(msg.rawImages) ? msg.rawImages.filter(Boolean) : [];
      if (!trimmed && !images.length) continue;
      if (trimmed && shouldSkipAssistantForCompletion(trimmed) && !images.length) continue;
      const content = images.length ? buildOwContentParts(trimmed, images) : trimmed;
      collected.push({ role: "assistant", content });
      continue;
    }
    if (msg.role === "user") {
      const text = messageTextContent(msg);
      const trimmed = (text || "").trim();
      if (!trimmed) continue;
      collected.push({ role: "user", content: trimmed });
      userSeen += 1;
      if (userSeen >= MAX_USER_CONTEXT) break;
    }
  }

  collected.reverse();
  while (collected.length && collected[0].role !== "user") {
    collected.shift();
  }
  return systemMessages.concat(collected);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function getImageDisplayUrl(url) {
  if (!url) return url;
  const abs = makeAbsoluteOwUrl(url);
  const key = abs || url;
  if (state.imageCache.has(key)) {
    return state.imageCache.get(key);
  }
  try {
    const headers = state.settings.apiKey ? headersWithAuth() : {};
    const response = await fetch(abs || url, { headers });
    log("fetchImage", { url, abs, status: response.status });
    if (!response.ok) {
      throw new Error(`image fetch ${response.status}`);
    }
    const blob = await response.blob();
    const dataUrl = await blobToDataUrl(blob);
    state.imageCache.set(key, dataUrl);
    return dataUrl;
  } catch (err) {
    console.warn("image fetch failed", url, err);
    return abs || url;
  }
}

async function buildDisplayMarkdownFromTextImages(text, images) {
  const segments = [];
  if (text && text.trim()) {
    segments.push(text.trim());
  }
  for (const url of images || []) {
    if (!url) continue;
    const displayUrl = await getImageDisplayUrl(url);
    if (displayUrl) {
      segments.push(`![Generated Image](${displayUrl})`);
    }
  }
  return segments.join("\n\n").trim() || text || "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPlaceholderText(text) {
  const t = (text ?? "").toString().trim();
  if (!t) return true;
  
  const normalized = t.replace(/\s+/g, "").replace(/\(/g, "（").replace(/\)/g, "）").replace(/\.\.\./g, "…");
  
  const keywords = [
    "后台生成中",
    "后台处理中",
    "处理中，请稍候",
    "模型生成中或无输出",
    "处理中",
    "后台处理中",
    "处理中请稍候",
    "处理超时",
    "思考中",
    "正在生成",
    "加载中"
  ];
  
  if (keywords.some((key) => normalized.includes(key))) return true;
  
  const presets = new Set([
    "", 
    "（模型生成中或无输出）", 
    "（处理中，请稍候…）",
    "后台处理中...",
    "处理中..."
  ]);
  
  return presets.has(normalized) || presets.has(t);
}

function extractImagesFromText(text) {
  const urls = [];
  if (!text) return urls;
  const regex = /!\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const url = (match[1] || "").trim();
    if (url && !urls.includes(url)) {
      urls.push(url);
    }
  }
  return urls;
}

function extractMessagesFromPayload(payload) {
  if (!payload) return [];
  const collected = [];

  const append = (source) => {
    if (!source) return;
    if (Array.isArray(source)) {
      source.forEach((item) => {
        if (item) collected.push(item);
      });
    } else if (typeof source === "object") {
      Object.values(source).forEach((item) => {
        if (item) collected.push(item);
      });
    }
  };

  append(payload.messages);
  if (payload.chat) {
    append(payload.chat.messages);
    append(payload.chat.history && payload.chat.history.messages);
  }
  append(payload.history && payload.history.messages);

  if (!collected.length) return [];

  const dedup = new Map();
  const hasMeaningfulContent = (msg) => {
    if (!msg) return false;
    if (typeof msg.content === "string" && msg.content.trim()) return true;
    if (Array.isArray(msg.content) && msg.content.length) return true;
    if (Array.isArray(msg.content_parts) && msg.content_parts.length) return true;
    if (Array.isArray(msg.images) && msg.images.length) return true;
    if (typeof msg.rawText === "string" && msg.rawText.trim()) return true;
    if (Array.isArray(msg.rawImages) && msg.rawImages.length) return true;
    return false;
  };

  collected.forEach((msg) => {
    if (!msg || (!msg.id && !msg._id)) return;
    const key = String(msg.id || msg._id);
    if (!dedup.has(key)) {
      dedup.set(key, msg);
      return;
    }
    const existing = dedup.get(key);
    const existingHasContent = hasMeaningfulContent(existing);
    const newHasContent = hasMeaningfulContent(msg);
    if (!existingHasContent && newHasContent) {
      dedup.set(key, msg);
    }
  });

  return Array.from(dedup.values());
}

async function pollAssistantContent(chatId, assistantMid, userMid, options = {}) {
  const shortWindowSec = Math.max(0.3, options.shortWindowSec ?? 5);
  const shortIntervalMs = Math.max(200, options.shortIntervalMs ?? 500);
  const longIntervalMs = Math.max(300, options.longIntervalMs ?? 800);
  const timeoutSec = Math.max(shortWindowSec, options.timeoutSec ?? 45);

  const evaluate = (messages) => {
    const sorted = [...messages].sort((a, b) => {
      const ta = Number(a?.timestamp || 0);
      const tb = Number(b?.timestamp || 0);
      return ta - tb;
    });

    const inspectMessage = (msg) => {
      if (!msg || msg.role !== "assistant") return null;
      const msgId = msg.id || msg._id;
      const matchesAssistant = msgId && String(msgId) === String(assistantMid);
      const matchesParent = userMid && msg.parentId && String(msg.parentId) === String(userMid);
      if (!matchesAssistant && !matchesParent) return null;

      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = partsToMarkdown(msg.content) || textFromParts(msg.content);
      }
      const images = [];
      if (Array.isArray(msg.images)) {
        msg.images.forEach((url) => {
          if (url && !images.includes(url)) images.push(url);
        });
      }
      if (Array.isArray(msg.content)) {
        collectImageUrls(msg.content).forEach((url) => {
          if (url && !images.includes(url)) images.push(url);
        });
      }
      extractImagesFromText(text).forEach((url) => {
        if (url && !images.includes(url)) images.push(url);
      });

      if ((text && !isPlaceholderText(text)) || images.length) {
        return { text, images };
      }
      return null;
    };

    for (const msg of sorted) {
      const res = inspectMessage(msg);
      if (res) return res;
    }

    if (userMid) {
      let userTimestamp = null;
      for (const msg of sorted) {
        if (msg && msg.id && String(msg.id) === String(userMid)) {
          const ts = Number(msg.timestamp || 0);
          if (!Number.isNaN(ts)) {
            userTimestamp = ts;
            break;
          }
        }
      }
      if (userTimestamp !== null) {
        for (const msg of sorted) {
          if (msg && msg.role === "assistant") {
            const ts = Number(msg.timestamp || 0);
            if (!Number.isNaN(ts) && ts >= userTimestamp) {
              const res = inspectMessage(msg);
              if (res) return res;
            }
          }
        }
      }
    }
    return null;
  };

  const attempt = async () => {
    const payload = await fetchChatSnapshot(chatId);
    const messages = extractMessagesFromPayload(payload);
    return evaluate(messages);
  };

  const start = Date.now();
  while (Date.now() - start < shortWindowSec * 1000) {
    try {
      const res = await attempt();
      if (res) return res;
    } catch (err) {
      console.debug("pollAssistantContent short window error", err);
    }
    await sleep(shortIntervalMs);
  }

  while (Date.now() - start < timeoutSec * 1000) {
    try {
      const res = await attempt();
      if (res) return res;
    } catch (err) {
      console.debug("pollAssistantContent long window error", err);
    }
    await sleep(longIntervalMs);
  }

  return { text: "", images: [] };
}
async function buildDisplayMarkdownFromParts(parts) {
  if (!Array.isArray(parts) || !parts.length) {
    return "";
  }
  const segments = [];
  for (const part of parts) {
    if (!part) continue;
    if (part.type === "text" && part.text) {
      segments.push(part.text);
    } else if (part.type === "image_url") {
      const rawUrl = part.image_url && part.image_url.url ? part.image_url.url : "";
      if (!rawUrl) continue;
      const displayUrl = await getImageDisplayUrl(rawUrl);
      if (displayUrl) {
        segments.push(`![Generated Image](${displayUrl})`);
      }
    }
  }
  return segments.join("\n\n").trim();
}

async function appendUserAndAssistant(chatId, model, userContent) {
  log("appendUserAndAssistant", { chatId, model, userContent });
  const chat = await fetchChatSnapshot(chatId);
  const chatClone = chat ? JSON.parse(JSON.stringify(chat)) : { id: chatId };
  const ts = Date.now();
  const userMid = crypto.randomUUID();
  const assistantMid = crypto.randomUUID();

  const messages = Array.isArray(chatClone?.messages) ? [...chatClone.messages] : [];
  const history = chatClone?.history ? { ...chatClone.history } : { current_id: null, messages: {} };
  const histMsgs = history.messages ? { ...history.messages } : {};

  const lastAssistant = [...messages].reverse().find((m) => m && m.role === "assistant" && m.id);

  const userMsg = {
    id: userMid,
    role: "user",
    content: userContent,
    content_parts: buildOwContentParts(userContent),
    timestamp: ts,
    models: model ? [model] : [],
    images: [],
    done: true  // 用户消息已完成
  };
  if (lastAssistant && lastAssistant.id) {
    userMsg.parentId = lastAssistant.id;
  }
  const assistantMsg = {
    id: assistantMid,
    role: "assistant",
    content: "",
    content_parts: [],  // 空数组，不要有占位符
    parentId: userMid,
    modelName: model,
    modelIdx: 0,
    timestamp: ts + 1,
    images: [],
    done: false,  // 标记为未完成
    stop: false   // 标记为生成中
  };
  if (model) {
    assistantMsg.models = [model];
  }

  messages.push(userMsg, assistantMsg);
  histMsgs[userMid] = { ...userMsg };
  histMsgs[assistantMid] = { ...assistantMsg };

  chatClone.messages = messages;
  chatClone.history = { current_id: assistantMid, messages: histMsgs };

  if (Array.isArray(chatClone?.models) && chatClone.models.length) {
    // keep existing models
  } else if (model) {
    chatClone.models = [model];
  }

  if (!state.titleLocked && (!chatClone?.title || String(chatClone.title).trim() === "")) {
    chatClone.title = buildChatTitle(userContent);
    state.titleLocked = true;
  }

  await apiCall(`/api/v1/chats/${chatId}?refresh=1`, {
    method: "POST",
    json: { chat: chatClone }
  });

  return { userMid, assistantMid };
}

async function persistAssistantCompletion(chatId, details) {
  log("persistAssistantCompletion", { chatId, details });
  const { userMid, assistantMid, text, images, model } = details;
  
  // 检查是否为占位符内容
  const assistantText = (text || "").trim();
  const assistantImages = Array.from(new Set((images || []).map((url) => (url || "").trim()).filter(Boolean)));
  
  if (isPlaceholderText(assistantText) && !assistantImages.length) {
    log("persistAssistantCompletion.skip", "placeholder content detected");
    return; // 跳过占位符内容
  }
  
  try {
    const chat = await fetchChatSnapshot(chatId);
    const chatClone = chat ? JSON.parse(JSON.stringify(chat)) : { id: chatId };
    const messages = Array.isArray(chatClone?.messages) ? [...chatClone.messages] : [];
    const history = chatClone?.history ? { ...chatClone.history } : { current_id: null, messages: {} };
    const histMsgs = history.messages ? { ...history.messages } : {};
    const finalContent = markdownFromTextImages(assistantText, assistantImages) || assistantText;
    const assistantObj = {
      id: assistantMid,
      role: "assistant",
      content: finalContent,
      content_parts: buildOwContentParts(assistantText || finalContent, assistantImages),
      timestamp: Date.now(),
      parentId: userMid || null,
      done: true,  // 标记为完成
      stop: true   // 标记停止生成
    };
    if (model) {
      assistantObj.modelName = model;
      assistantObj.modelIdx = 0;
      assistantObj.models = [model];
    }

    if (assistantImages.length) {
      assistantObj.images = assistantImages;
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

    chatClone.messages = messages;
    chatClone.history = history;
    if (Array.isArray(chatClone?.models) && chatClone.models.length) {
      // keep existing models
    } else if (model) {
      chatClone.models = [model];
    }

    await apiCall(`/api/v1/chats/${chatId}?refresh=1`, {
      method: "POST",
      json: { chat: chatClone }
    });

    const completedPayload = {
      chat_id: chatId,
      id: assistantMid,
      done: true,
      stop: true
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

function schedulePendingSync({
  chatId,
  pending,
  model,
  text,
  images,
  poll = true,
  onResolved,
  attempt = 0,
  maxAttempts = 150
}) {
  if (!chatId || !pending) return;
  const baseImages = Array.from(new Set((images || []).map((url) => (url || "").trim()).filter(Boolean)));
  const payload = {
    chatId,
    assistantMid: pending.assistantMid,
    userMid: pending.userMid,
    model,
    text: typeof text === "string" ? text : "",
    images: baseImages,
    poll,
    onResolved,
    attempt,
    maxAttempts
  };

  const task = async () => {
    let resolvedText = payload.text;
    let resolvedImages = payload.images;
    if (payload.poll) {
      try {
        const polled = await pollAssistantContent(payload.chatId, payload.assistantMid, payload.userMid, {
          shortWindowSec: 1.5,
          shortIntervalMs: 400,
          longIntervalMs: 800,
          timeoutSec: 1.8
        });
        if (polled) {
          if (polled.text && polled.text.trim()) {
            resolvedText = polled.text;
          }
          if (Array.isArray(polled.images) && polled.images.length) {
            resolvedImages = Array.from(
              new Set(polled.images.map((url) => (url || "").trim()).filter(Boolean))
            );
          }
        }
      } catch (err) {
        console.debug("pollAssistantContent background fallback", err);
      }
    }

    // 检查是否有实际内容（添加占位符检查）
    const hasRealContent = (resolvedText && resolvedText.trim() && !isPlaceholderText(resolvedText)) || 
                          (resolvedImages && resolvedImages.length);
    const hasResult = hasRealContent;
    if (!hasResult) {
      if (payload.attempt < payload.maxAttempts) {
        const nextAttempt = payload.attempt + 1;
        const delay = Math.min(3000, 1000 + payload.attempt * 200); // 递增延迟，最大3秒
        log("schedulePendingSync.retry", {
          chatId: payload.chatId,
          assistantMid: payload.assistantMid,
          attempt: nextAttempt,
          delay
        });
        setTimeout(() => {
          schedulePendingSync({
            chatId: payload.chatId,
            pending,
            model: payload.model,
            text: resolvedText,
            images: resolvedImages,
            poll: true,
            onResolved: payload.onResolved,
            attempt: nextAttempt,
            maxAttempts: payload.maxAttempts
          });
        }, delay);
      } else {
        log("schedulePendingSync.giveup", {
          chatId: payload.chatId,
          assistantMid: payload.assistantMid
        });
        if (typeof payload.onResolved === "function") {
          try {
            const timeoutText = resolvedText && resolvedText.trim() ? resolvedText : "处理超时，请稍后重试";
            await payload.onResolved({ text: timeoutText, images: resolvedImages, timeout: true });
          } catch (err) {
            console.debug("schedulePendingSync onResolved timeout failed", err);
          }
        }
      }
      return;
    }

    try {
      await persistAssistantCompletion(payload.chatId, {
        userMid: payload.userMid,
        assistantMid: payload.assistantMid,
        text: resolvedText,
        images: resolvedImages,
        model: payload.model
      });
      log("schedulePendingSync.persisted", {
        chatId: payload.chatId,
        assistantMid: payload.assistantMid,
        textPreview: (resolvedText || "").slice(0, 80),
        imageCount: resolvedImages.length
      });
    } catch (err) {
      console.warn("schedulePendingSync persist failed", err);
      throw err;
    }

    if (typeof payload.onResolved === "function") {
      try {
        await payload.onResolved({ text: resolvedText, images: resolvedImages, timeout: false });
      } catch (err) {
        console.debug("schedulePendingSync onResolved failed", err);
      }
    }

    try {
      const completedPayload = {
        chat_id: payload.chatId,
        id: payload.assistantMid,
        done: true,
        stop: true
      };
      if (payload.model) completedPayload.model = payload.model;
      if (state.sessionId) completedPayload.session_id = state.sessionId;
      await apiCall("/api/chat/completed", {
        method: "POST",
        json: completedPayload
      });
    } catch (err) {
      console.debug("schedulePendingSync completed fallback", err);
    }
  };

  task().catch((err) => {
    console.warn("schedulePendingSync task failed", err);
  });
}

function autoResizeTextarea() {
  const ta = elements.prompt;
  const style = getComputedStyle(ta);
  const line = parseFloat(style.lineHeight) || 20;
  const padding = parseFloat(style.paddingTop || "0") + parseFloat(style.paddingBottom || "0");
  const border = parseFloat(style.borderTopWidth || "0") + parseFloat(style.borderBottomWidth || "0");
  const base = line + padding + border;
  const max = line * 5 + padding + border;

  if (!ta.value) {
    ta.style.height = `${base}px`;
    ta.style.overflowY = "hidden";
    return;
  }

  ta.style.height = "auto";
  const scroll = ta.scrollHeight;
  const finalHeight = Math.min(Math.max(scroll, base), max);
  ta.style.height = `${finalHeight}px`;
  ta.style.overflowY = scroll > max ? "auto" : "hidden";
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

function extractModelEntries(data, out = []) {
  if (!data) return out;
  if (Array.isArray(data)) {
    data.forEach((item) => extractModelEntries(item, out));
    return out;
  }
  if (typeof data === "string") {
    const id = data.trim();
    if (id) out.push({ id, label: id });
    return out;
  }
  if (typeof data === "object") {
    const id = data.id || data.model || data.name || data.key || "";
    const label = data.display_name || data.title || data.name || data.id || data.model;
    if (id) {
      out.push({ id: String(id), label: label ? String(label) : String(id) });
      return out;
    }
    Object.values(data).forEach((val) => extractModelEntries(val, out));
  }
  return out;
}

async function refreshModels() {
  if (!state.settings.baseUrl || !state.settings.apiKey) {
    state.models = [];
    updateModelButtonLabel();
    return;
  }
  try {
    const data = await apiCall("/api/models");
    const entries = extractModelEntries(data);
    const dedupMap = new Map();
    entries.forEach((entry) => {
      if (!entry || !entry.id) return;
      if (!dedupMap.has(entry.id)) {
        dedupMap.set(entry.id, { id: entry.id, label: entry.label || entry.id });
      }
    });
    const list = Array.from(dedupMap.values());
    if (list.length) {
      state.models = list;
      if (!dedupMap.has(state.selectedModel)) {
        const first = list[0];
        state.selectedModel = first.id;
        state.selectedModelLabel = first.label;
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
  const models = state.models.length
    ? state.models
    : [{ id: state.selectedModel, label: state.selectedModelLabel || state.selectedModel }];
  models.forEach((model) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "model-option";
    item.textContent = model.label;
    const isSelected = model.id === state.selectedModel;
    if (isSelected) {
      item.classList.add("selected");
    }
    item.addEventListener("click", () => {
      state.selectedModel = model.id;
      state.selectedModelLabel = model.label;
      storage.set({ selectedModel: model.id });
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
      log("historyList.fetch", path);
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
    log("history.load", { chatId });
    const chat = await fetchChatSnapshot(chatId);
    const messages = Array.isArray(chat?.messages) ? chat.messages : [];
    state.chatId = chatId;
    state.sessionId = crypto.randomUUID();
    
    // 改进的消息处理逻辑
    const displayMessages = [];
    for (const m of messages) {
      if (!m || (m.role !== "user" && m.role !== "assistant")) continue;

      let displayContent = "";
      const rawContent = m.content;
      const textParts = [];
      const imageParts = [];

      // 处理不同格式的 content
      if (typeof rawContent === "string") {
        displayContent = rawContent;
        textParts.push(rawContent);
      } else if (Array.isArray(rawContent)) {
        // 处理 content parts 数组
        for (const part of rawContent) {
          if (part?.type === "text" && part.text) {
            textParts.push(part.text);
          } else if (part?.type === "image_url" && part.image_url?.url) {
            imageParts.push(part.image_url.url);
          }
        }
        
        displayContent = textParts.join("\n");
        if (imageParts.length > 0) {
          const imageMarkdown = imageParts.map(url => `![Image](${makeAbsoluteOwUrl(url)})`).join("\n");
          displayContent = displayContent ? `${displayContent}\n\n${imageMarkdown}` : imageMarkdown;
        }
      } else if (rawContent?.text) {
        displayContent = rawContent.text;
      }
      
      // 处理 images 数组
      if (Array.isArray(m.images) && m.images.length) {
        const imageMarkdown = m.images.map(url => `![Image](${makeAbsoluteOwUrl(url)})`).join("\n");
        displayContent = displayContent ? `${displayContent}\n\n${imageMarkdown}` : imageMarkdown;
      }

      if (displayContent) {
        const modelId =
          (Array.isArray(m.models) && m.models.length ? m.models[0] : null) ||
          m.modelName ||
          m.model ||
          (m.metadata && typeof m.metadata.model === "string" ? m.metadata.model : null);
        displayMessages.push({
          role: m.role,
          content: displayContent,
          model: modelId,
          rawText: textParts.join("\n"),
          rawImages: imageParts,
          pending: false
        });
      }
    }
    
    state.messages = displayMessages;
    elements.messages.innerHTML = "";
    state.messages.forEach((msg) => {
      if (msg.role === "assistant") {
        appendMessage(msg.role, msg.content, { label: getAssistantLabel(msg.model), model: msg.model });
      } else {
        appendMessage(msg.role, msg.content);
      }
    });
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

  log("sendPrompt.begin", { prompt, model: getCurrentModel(), chatId: state.chatId });
  closeModelMenu();

  const model = getCurrentModel();
  const assistantLabel = getAssistantLabel(model);
  appendMessage("user", prompt);
  elements.prompt.value = "";
  autoResizeTextarea();
  state.messages.push({ role: "user", content: prompt, rawText: prompt });
  state.isSending = true;
  elements.send.disabled = true;
  setStatus("思考中...");

  let contextInfo = null;
  let contextMessage = null;

  if (state.captureEnabled) {
    try {
      contextInfo = await captureCurrentPage();
      log("captureCurrentPage", contextInfo);
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
  log("ensureChatId", { chatId });
  let placeholder = null;
  if (chatId) {
    try {
      placeholder = await appendUserAndAssistant(chatId, model, prompt);
      state.pendingMessage = placeholder;
      log("placeholder.created", placeholder);
    } catch (err) {
      console.warn("append placeholder failed", err);
    }
  }

  const completionMessages = buildCompletionMessagesFromState(state.messages);
  const payloadMessages = [];
  if (contextMessage) {
    payloadMessages.push({ role: contextMessage.role || "system", content: contextMessage.content });
  }
  payloadMessages.push(...completionMessages);

  const body = {
    messages: formatMessagesForCompletion(payloadMessages),
    stream: true,
    model,
    session_id: state.sessionId
  };

  if (chatId) {
    body.chat_id = chatId;
  }
  if (state.pendingMessage?.assistantMid) {
    body.id = state.pendingMessage.assistantMid;
  }
  // OpenWebUI 要求使用占位 assistant 的 id，用于后续内容回写

  let assistantTextBuffer = "";
  const assistantParts = [];
  let assistantEntry = null;
  let assistantRecord = null;
  let lastPayload = null;

  const ensureAssistantRecord = () => {
    if (!assistantRecord) {
      assistantRecord = {
        role: "assistant",
        content: "",
        model,
        rawText: "",
        rawImages: [],
        pending: true
      };
      state.messages.push(assistantRecord);
    }
    return assistantRecord;
  };

  const updateAssistantMessage = async (text, images, { pending = false, placeholderText = null } = {}) => {
    const record = ensureAssistantRecord();
    const safeImages = Array.from(new Set((images || []).map((url) => (url || "").trim()).filter(Boolean)));
    const hasRealContent = Boolean(text && text.trim()) || safeImages.length > 0;
    record.pending = pending && !hasRealContent;
    record.model = model;
    record.rawImages = safeImages;
    if (record.pending) {
      record.rawText = "";
    } else {
      record.rawText = typeof text === "string" ? text : "";
    }

    let displayText = typeof text === "string" ? text : "";
    if (record.pending) {
      displayText = placeholderText || displayText || "后台处理中...";
    }

    const displayMarkdown = await buildDisplayMarkdownFromTextImages(displayText, safeImages);
    record.content = displayMarkdown || displayText || (record.pending ? "后台处理中..." : "(暂无响应)");
    if (assistantEntry) {
      setMessageContent(assistantEntry.contentEl, record.content);
    }
  };

  const syncAssistantDraft = () => {
    if (!assistantRecord) return;
    const draft = (assistantTextBuffer || "").trim();
    assistantRecord.pending = !draft;
    assistantRecord.rawText = assistantTextBuffer;
    assistantRecord.content = assistantTextBuffer;
    assistantRecord.model = model;
  };

  const handleResolvedResult = async ({ text, images, timeout = false } = {}) => {
    if (timeout) {
      const timeoutText = text && text.trim() ? text : "处理超时，请稍后重试";
      await updateAssistantMessage(timeoutText, images, { pending: false });
      setStatus(timeoutText, true);
      log("async.timeout", { chatId: state.chatId, assistantMid: state.pendingMessage?.assistantMid });
      return;
    }
    await updateAssistantMessage(text, images, { pending: false });
    const currentStatus = elements.status.textContent || "";
    if (/发送失败/.test(currentStatus) || /处理中/.test(currentStatus)) {
      setStatus("完成。");
    }
    log("async.resolved", { textPreview: (text || "").slice(0, 80), imageCount: (images || []).length });
  };

  try {
    log("completions.payload", {
      chatId: body.chat_id,
      model: body.model,
      messageCount: body.messages.length,
      hasParent: Boolean(body.parent_id)
    }, body);
    const response = await fetch(safeJoin(state.settings.baseUrl, "/api/chat/completions"), {
      method: "POST",
      headers: headersWithAuth({ "Content-Type": "application/json", Accept: "text/event-stream" }),
      body: JSON.stringify(body),
      cache: "no-store"
    });
    log("completions.request", { status: response.status, contentType: response.headers.get("content-type") });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error("completions.error", response.status, errorText);
      throw new Error(`HTTP ${response.status}${errorText ? `: ${errorText.slice(0, 200)}` : ""}`);
    }

    const contentType = response.headers.get("content-type") || "";
    assistantEntry = appendMessage("assistant", "", { label: assistantLabel, model });
    ensureAssistantRecord();

    if (contentType.includes("text/event-stream")) {
      await consumeStream(response, {
        onDelta(data) {
          lastPayload = data;
          const delta = data?.choices?.[0]?.delta;
          let consumed = false;
          if (delta && delta.content !== undefined) {
            const parts = partsFromContent(delta.content);
            if (parts.length) {
              mergeContentParts(assistantParts, parts);
              const addedText = textFromParts(parts);
              if (addedText) {
                assistantTextBuffer += addedText;
                if (assistantEntry) setMessageContent(assistantEntry.contentEl, assistantTextBuffer);
              }
              consumed = true;
            }
          }
          if (!consumed && delta && typeof delta.text === "string") {
            mergeContentParts(assistantParts, contentPartsFromText(delta.text));
            assistantTextBuffer += delta.text;
            if (assistantEntry) setMessageContent(assistantEntry.contentEl, assistantTextBuffer);
            consumed = true;
          }
          if (!consumed) {
            const chunk = extractAssistantMessage(data);
            if (chunk) {
              mergeContentParts(assistantParts, contentPartsFromText(chunk));
              assistantTextBuffer += chunk;
              if (assistantEntry) setMessageContent(assistantEntry.contentEl, assistantTextBuffer);
            }
          }
          const cid = extractChatId(data);
          if (cid) state.chatId = cid;
          syncAssistantDraft();
        },
        onFallbackText(text) {
          mergeContentParts(assistantParts, contentPartsFromText(text));
          assistantTextBuffer += text;
          if (assistantEntry) setMessageContent(assistantEntry.contentEl, assistantTextBuffer);
          syncAssistantDraft();
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
      log("completions.nonStream", { hasData: Boolean(data) });
      if (data) {
        lastPayload = data;
        const messageContent =
          data?.choices?.[0]?.message?.content ||
          data?.message?.content ||
          data?.content ||
          extractAssistantMessage(data);
        const parts = partsFromContent(messageContent);
        if (parts.length) {
          mergeContentParts(assistantParts, parts);
        } else {
          mergeContentParts(assistantParts, contentPartsFromText(extractAssistantMessage(data)));
        }
        assistantTextBuffer = textFromParts(assistantParts) || assistantTextBuffer;
        const cid = extractChatId(data, state.chatId);
        if (cid) state.chatId = cid;
      } else {
        mergeContentParts(assistantParts, contentPartsFromText(rawText));
        assistantTextBuffer += rawText;
      }
      if (assistantEntry) setMessageContent(assistantEntry.contentEl, assistantTextBuffer);
      syncAssistantDraft();
    }

    if (!assistantTextBuffer.trim()) {
      assistantTextBuffer = "";
      assistantParts.length = 0;
      if (assistantEntry) setMessageContent(assistantEntry.contentEl, "后台处理中...");
      syncAssistantDraft();
    }

    const assistantPartsSnapshot = cloneContentParts(assistantParts);
    let finalText = textFromParts(assistantPartsSnapshot) || assistantTextBuffer;
    let finalImages = collectImageUrls(assistantPartsSnapshot);
    let awaitingAsync = false;

    if (state.chatId && state.pendingMessage) {
      try {
        const polled = await pollAssistantContent(
          state.chatId,
          state.pendingMessage.assistantMid,
          state.pendingMessage.userMid
        );
        log("pollAssistantContent.result", polled);
        if (polled && (polled.text || (polled.images && polled.images.length))) {
          if (polled.text && polled.text.trim()) finalText = polled.text;
          if (polled.images && polled.images.length) finalImages = polled.images;
        }
      } catch (err) {
        console.debug("pollAssistantContent fallback", err);
      }
    }

    finalImages = Array.from(new Set((finalImages || []).map((url) => (url || "").trim()).filter(Boolean)));

    let scheduleText = finalText;
    const scheduleImages = finalImages;

    if (!finalImages.length && !(finalText && finalText.trim())) {
      awaitingAsync = true;
      scheduleText = "";
      await updateAssistantMessage("", [], { pending: true, placeholderText: "后台处理中..." });
    } else {
      await updateAssistantMessage(finalText, finalImages, { pending: false });
    }

    log("assistant.final", { finalText, finalImages, chatId: state.chatId, awaitingAsync });

    if (lastPayload) {
      const cid = extractChatId(lastPayload, state.chatId);
      if (cid) state.chatId = cid;
    }

    const pendingSnapshot = state.pendingMessage ? { ...state.pendingMessage } : null;
    if (state.chatId && pendingSnapshot) {
      schedulePendingSync({
        chatId: state.chatId,
        pending: pendingSnapshot,
        model,
        text: scheduleText,
        images: scheduleImages,
        poll: true,
        onResolved: handleResolvedResult,
        maxAttempts: 150
      });
      if (awaitingAsync) {
        setStatus("后台处理中...");
      }
    }

    if (contextInfo && contextInfo.succeeded) {
      setStatus(`完成。页面抓取方式: ${contextInfo.source}`);
    } else if (contextInfo) {
      setStatus(`已回答，页面抓取退化为 ${contextInfo.source}`);
    } else if (!awaitingAsync) {
      setStatus("完成。");
    }
  } catch (err) {
    console.error("发送失败", err);
    setStatus(`发送失败: ${err.message}`, true);
    if (!assistantEntry) {
      assistantEntry = appendMessage("assistant", "", { label: assistantLabel, model });
    }
    const fallbackText = err?.message ? `处理中...\n${err.message}` : "处理中...";
    await updateAssistantMessage("", [], { pending: true, placeholderText: fallbackText });
    if (state.chatId && state.pendingMessage) {
      const failureSnapshot = { ...state.pendingMessage };
      const failureImages = Array.from(
        new Set(collectImageUrls(assistantParts).map((url) => (url || "").trim()).filter(Boolean))
      );
      schedulePendingSync({
        chatId: state.chatId,
        pending: failureSnapshot,
        model,
        text: assistantTextBuffer || "(发送失败)",
        images: failureImages,
        poll: true,
        onResolved: handleResolvedResult
      });
    }
  } finally {
    state.pendingMessage = null;
    state.isSending = false;
    elements.send.disabled = false;
    log("sendPrompt.end");
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
