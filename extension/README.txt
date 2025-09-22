OpenWebUI Copilot Sidebar (Async/SSE aware)

1) 在 chrome://extensions 打开“开发者模式”，加载此文件夹。
2) 在侧边栏设置中填入：
   - Base URL: https://c.lol2.com.cn
   - API Key : （你的 OpenWebUI Key）
   - Model   : gpt-5-chat-latest
3) 插件已自动兼容：
   - SSE 模式（text/event-stream）
   - 异步 task_id 模式（/api/chat/completions 返回 JSON）→ 自动轮询 /api/v1/chats/<chat_id>
4) 若 WebUI 房间顶部一直“加载中”，确保插件在 completions 与 completed 里使用同一个 assistant 消息 id（插件已处理），并且 completed 会带上 model 与 session_id（已处理）。