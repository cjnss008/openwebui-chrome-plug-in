# OpenWebUI Copilot Sidebar

把 **Open WebUI** 无缝嵌入到浏览器右侧栏（Chrome/Edge Side Panel）的扩展（Manifest V3）。
支持像 Copilot 一样的分屏对话、**抓取该页面**（Jina Reader → Readability 兜底）、可选 **SSE 流式** 或 **轮询** 返回、模型选择与历史会话。

> 适合希望在“浏览任意网页时随手问”的使用场景，不打断阅读流。

---

## ✨ 特性

- **原生 Side Panel 体验**：点击扩展图标即可在浏览器右侧打开面板，跟随当前标签页持久显示（`chrome.sidePanel` API）。
- **一键“抓取该页面”**：优先使用 **Jina Reader** 将 URL 转为适合 LLM 的干净文本；失败时自动回退到 **Mozilla Readability** 在本地离线 DOM 上抽正文。
- **流式 or 轮询**：同时兼容 **Server-Sent Events**（`text/event-stream`，前端 `EventSource`/流式 `fetch`）与非流式轮询两种返回路径，可在设置中切换。
- **模型切换与历史**：下拉选择默认模型，查看/续写会话。
- **图片去重渲染**：同一条消息仅从**单一来源**渲染图片，避免“同图显示两次”。

---

## 🏗 架构

```
manifest.json      # MV3 声明（含 sidePanel、host_permissions、web_accessible_resources 等）
background.js      # Service worker：配置 side panel 打开行为等
sidebar.html/css   # 侧栏 UI
sidebar.js         # 交互逻辑：会话、抓取、SSE/轮询、状态管理、渲染
icons/             # 扩展内 SVG/PNG 静态资源
```

- 侧栏由 **Side Panel API** 提供；通过 `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` 让**点击扩展图标**即可打开侧栏。
- “抓取该页面”链路：  
  1) `https://r.jina.ai/<URL>` → 得到经抽取的 Markdown/纯文本；  
  2) 若失败 → `fetch(<URL>)` 抓原始 HTML → **Mozilla Readability** 本地解析正文。
- 流式返回：服务端以 **SSE** 推送（MIME `text/event-stream`，以空行分段），前端使用 **EventSource**/流式 `fetch` 渲染。

---

## 🚀 安装

1. 下载本仓库或 Release 包并解压。  
2. 打开 `chrome://extensions`（Edge 用 `edge://extensions`），启用 **开发者模式**。  
3. 点击 **“加载已解压的扩展程序”**，选择项目根目录。  
4. 首次打开侧栏 → 右上角 **设置**：  
   - **Base URL**：你的 Open WebUI 服务地址  
   - **API Key**：对应服务的访问令牌  
   - **默认模型**：如 `gpt-5-chat-latest` 等  
   - （可选）**启用 SSE**：若你的服务端已按 SSE 规范输出流。

> 说明：Side Panel 顶部的**灰色系统标题栏**由浏览器控制，扩展无权隐藏；可通过在 `manifest.json` 设置更短的 `short_name` 来让标题更精简。

---

## ⚙️ 权限

- `sidePanel`：使用浏览器侧边栏 API。  
- `activeTab` / `tabs` / `storage`：读取当前页 URL、保存配置。  
- `host_permissions`：  
  - `https://r.jina.ai/*`（Jina Reader）  
  - 你希望允许**兜底抓取**的站点域名（跨域 `fetch` 抓原始 HTML）。  
- `web_accessible_resources`：当需要让网页上下文访问扩展资源时声明（侧栏自身不强制）。

---

## 📝 抓取该页面（工作原理与建议）

- 开关打开后，发送问题会附带**当前页面的抽取文本**。  
- **优先 Jina**：直接把原始 URL **接在** `r.jina.ai/` 后面即可（不要对 `https://` 再做 `encodeURIComponent`）。  
- **失败兜底**：本地 `fetch` 原 HTML → **Readability** 解析正文（Firefox Reader View 同源实现）。  
- **长度保护**：建议对抓取文本设定 50–80KB 软上限，过长分片后再拼接到提示词，避免超过模型限制。  
- 如需“**先搜索再抓取**”，可使用 `s.jina.ai` 获取前 5 条结果及正文。

---

## 🔄 流式（SSE）与非流式（轮询）

- **SSE**：服务端以 `text/event-stream` 输出，消息以空行分段；前端通过 `EventSource` 接收并实时渲染。  
- **轮询**：服务端返回任务/消息 ID，前端定时请求最新结果。  
- 两种模式可在设置中切换，以兼容不同的后端部署形态。

---

## 🙋 常见问题（FAQ）

- **为什么顶部有灰色系统栏？能隐藏吗？**  
  不能。那是浏览器为 Side Panel 提供的系统标题栏；可通过 `short_name` 缩短标题文本以减轻视觉占用。
- **Jina Reader 会渲染页面脚本吗？**  
  它直接返回已清洗的正文（Markdown/纯文本），用于喂给 LLM；如需搜索入口可用 `s.jina.ai`。
- **SSE 不显示或断流？**  
  确认服务端响应头 `Content-Type: text/event-stream`，并按规范输出事件块；前端使用 `EventSource` 或流式 `fetch` 即可。

---

## 🧑‍💻 开发

```bash
git clone https://github.com/<your-account>/<repo>.git
cd <repo>
# 修改后在 chrome://extensions 中“重新加载”扩展
```

主要文件：
- `background.js`：Side Panel 打开行为、基础事件  
- `sidebar.html / .css / .js`：界面与核心逻辑  
- `icons/`：图标资源

---

## 🔐 隐私

- 扩展仅在本地浏览器运行；只有在你打开“抓取该页面”时才会抓取当前网址内容。  
- Open WebUI 的 Base URL 与 Token 保存在浏览器本地 `chrome.storage`。

---

## 效果图
<img width="3438" height="1782" alt="image" src="https://github.com/user-attachments/assets/547d0c4f-b9b2-4330-ad61-8f6ac3b0fec8" />
