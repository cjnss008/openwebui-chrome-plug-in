# app.py
# -*- coding: utf-8 -*-
import os, re, time, json, threading, logging, requests, base64, mimetypes, io, uuid
from typing import Any, Dict, List, Tuple, Optional
from fastapi import FastAPI, Request, Response
from wechatpy.enterprise.crypto import WeChatCrypto
from wechatpy.enterprise import parse_message
from urllib.parse import urljoin, urlparse
# 可选：图片压缩
try:
    from PIL import Image
    _PIL_OK = True
except Exception:
    _PIL_OK = False


def _build_fixed_room_title(seed_text: str) -> str:
    import re as _re, time as _time
    base = _strip_md_for_wechat(seed_text or "").strip()
    base = _re.sub(r'\s+', ' ', base)[:16] or "会话"
    ts = _time.strftime("%Y%m%d-%H%M", _time.localtime())
    return f"{base} · {ts}"
def _pick_chat_id(user_token: str, fallback_chat_id: str):
    """
    兼容旧调用：尝试回读 chat，返回 (chat_id, chat_json)。失败则返回 fallback。
    """
    try:
        js = owui_fetch_chat(user_token, fallback_chat_id)
        return fallback_chat_id, js
    except Exception:
        return fallback_chat_id, {}
# ----------------------------- LOGGING -----------------------------
logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(name)s: %(message)s")
log = logging.getLogger("wecom-bridge")

# ---- Placeholder detector (placed early to be available to worker threads) ----
def _is_placeholder_text(s: str) -> bool:
    try:
        t = ("" if s is None else str(s)).strip()
    except Exception:
        return False
    if not t:
        return True
    t_norm = t.replace("(", "（").replace(")", "）").replace("...", "…")
    # Substring match to be robust across variants
    for key in ("后台生成中", "后台处理中", "处理中，请稍候", "模型生成中或无输出"):
        if key in t_norm:
            return True
    if t_norm in {"", "（模型生成中或无输出）", "（处理中，请稍候…）"}:
        return True
    return False


def _mask(s: str, head: int = 4, tail: int = 4) -> str:
    if not s: return ""
    if len(s) <= head + tail: return s[0] + "***"
    return s[:head] + "..." + s[-tail:]
# ----------------------------- ENV -----------------------------
def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    v = os.getenv(name, default)
    if name in {"WECOM_AESKEY", "WECOM_KF_SECRET", "WECOM_APP_SECRET", "WECOM_TOKEN"} and v:
        logging.info("ENV %s=%r", name, _mask(v))
    else:
        logging.info("ENV %s=%r", name, v)
    return v
APPID = _env("WECOM_CORP_ID")
KF_SECRET = _env("WECOM_KF_SECRET")
TOKEN = _env("WECOM_TOKEN")
AESKEY = _env("WECOM_AESKEY")
OWUI = _env("OWUI_BASE") or "http://open-webui:8080"
DEFAULT_MODEL = (_env("OWUI_DEFAULT_MODEL") or "").strip()
STORE_FILE = _env("STORE_FILE") or "/data/bindings.json"
OPEN_KFID = _env("WECOM_KF_OPENKFID") or ""
LAST_IMAGE_TTL = int(_env("WECOM_LAST_IMAGE_TTL") or "900")  # 最近图片有效期（秒）
DEBUG_HTTP = int(_env("DEBUG_HTTP") or "0")  # 1 打印请求/响应摘要
RATE_LIMIT_COOLDOWN_SEC = int(_env("WECOM_KF_RL_COOLDOWN_SEC") or "60")
MAX_CONTEXT_MSGS = int(_env("OWUI_MAX_CONTEXT_MSGS") or "30")
POLL_TIMEOUT_SEC = float(_env("WECOM_POLL_TIMEOUT_SEC") or "300")
POLL_INTERVAL_SEC = float(_env("WECOM_POLL_INTERVAL_SEC") or "0.6")
OWUI_FORCE_ASSISTANT_PLACEHOLDER_WHEN_EMPTY = int(_env("OWUI_FORCE_ASSISTANT_PLACEHOLDER_WHEN_EMPTY") or "0")
# —— 关键修复：启动期丢弃旧消息 + 持久去重配置 ——
KF_DROP_OLD_MSGS_SEC = int(_env("KF_DROP_OLD_MSGS_SEC") or "120")  # 建议设置 5~15
SEEN_PERSIST_MAX = int(_env("SEEN_PERSIST_MAX") or "2000")
BOOT_TS = time.time()
# —— Outbox（95001 延迟重投）配置 ——
OUTBOX_TICK_SEC = float(_env("OUTBOX_TICK_SEC") or "1.0")
OUTBOX_MAX = int(_env("OUTBOX_MAX") or "1000")
OUTBOX_PER_USER_MAX = int(_env("OUTBOX_PER_USER_MAX") or "100")
OUTBOX_MAX_RETRIES = int(_env("OUTBOX_MAX_RETRIES") or "8")
OUTBOX_BASE_BACKOFF = float(_env("OUTBOX_BASE_BACKOFF") or "4.0")  # 秒
OUTBOX_BACKOFF_CAP = float(_env("OUTBOX_BACKOFF_CAP") or "60.0")  # 秒
missing = [k for k, v in {
    "WECOM_CORP_ID": APPID,
    "WECOM_KF_SECRET": KF_SECRET,
    "WECOM_TOKEN": TOKEN,
    "WECOM_AESKEY": AESKEY,
}.items() if not v]
if AESKEY and len(AESKEY) != 43:
    missing.append("WECOM_AESKEY(长度不是43)")
if missing:
    raise SystemExit("缺少/非法环境变量: " + ", ".join(missing))
# --------------------------- FASTAPI ---------------------------
app = FastAPI()
crypto = WeChatCrypto(TOKEN, AESKEY, APPID)
# ---------------------- WeCom KF AccessToken -------------------
_tok = {"val": None, "exp": 0.0}
def get_kf_access_token() -> str:
    now = time.time()
    if _tok["val"] and now < _tok["exp"] - 60:
        return _tok["val"]  # type: ignore
    r = requests.get("https://qyapi.weixin.qq.com/cgi-bin/gettoken",
                     params={"corpid": APPID, "corpsecret": KF_SECRET}, timeout=8)
    r.raise_for_status()
    j = r.json()
    if "access_token" not in j:
        raise RuntimeError(f"gettoken failed: {j}")
    _tok["val"] = j["access_token"];
    _tok["exp"] = now + j.get("expires_in", 7200)
    return _tok["val"]  # type: ignore
# ----------------------------- Store ---------------------------
def _load_store() -> Dict[str, Dict[str, Any]]:
    try:
        with open(STORE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}
def _save_store(d: Dict[str, Dict[str, Any]]):
    os.makedirs(os.path.dirname(STORE_FILE), exist_ok=True)
    with open(STORE_FILE, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
def _user(store: Dict[str, Dict[str, Any]], ext_uid: str) -> Dict[str, Any]:
    u = store.get(ext_uid) or {}
    u.setdefault("token", "")
    u.setdefault("model", DEFAULT_MODEL)
    u.setdefault("state", "MENU")
    u.setdefault("current_chat_id", "")
    u.setdefault("cache", {})
    u.setdefault("last_image", "")
    u.setdefault("last_image_ts", 0.0)
    u.setdefault("_models_cache", {"ts": 0.0, "list": []})
    if not (u.get("session_id") or "").strip():
        u["session_id"] = uuid.uuid4().hex
    store[ext_uid] = u
    return u
# —— 持久去重工具 ——
def _seen_load() -> Dict[str, float]:
    try:
        store = _load_store()
        return dict(store.get("__seen__", {}))
    except Exception:
        return {}
def _seen_has(msgid: str) -> bool:
    if not msgid: return False
    return msgid in _seen_load()
def _seen_add(msgid: str):
    if not msgid: return
    store = _load_store()
    seen = dict(store.get("__seen__", {}))
    seen[msgid] = time.time()
    if len(seen) > SEEN_PERSIST_MAX:
        for k, _ in sorted(seen.items(), key=lambda kv: kv[1])[:len(seen) - SEEN_PERSIST_MAX]:
            seen.pop(k, None)
    store["__seen__"] = seen
    _save_store(store)
def _set_last_image(ext_uid: str, data_url: str):
    store = _load_store()
    u = _user(store, ext_uid)
    u["last_image"] = data_url
    u["last_image_ts"] = time.time()
    _save_store(store)
def _get_last_image_if_fresh(u: Dict[str, Any]) -> str:
    ts = float(u.get("last_image_ts") or 0)
    du = (time.time() - ts)
    data_url = (u.get("last_image") or "").strip()
    if data_url and du <= LAST_IMAGE_TTL and data_url.startswith("data:image/"):
        return data_url
    return ""
# -------------------------- URL helpers ------------------------
def _abs_owui_url(u: str) -> str:
    if not u or u.startswith("data:"):
        return u
    p = urlparse(u)
    if p.scheme in ("http", "https"):
        return u
    if u.startswith("/"):
        return urljoin(OWUI, u)
    return urljoin(OWUI, "/" + u)
# --------------------------- OWUI HTTP 包装 ---------------------
def _shorten(obj: Any, n: int = 300) -> str:
    try:
        s = json.dumps(obj, ensure_ascii=False)
    except Exception:
        s = str(obj)
    return (s[:n] + ("..." if len(s) > n else ""))
def _owui_req(method: str, path: str, token: str, **kwargs) -> requests.Response:
    # HARD BLOCK tasks endpoints to avoid fetching HTML app shell
    _pl = str(path).lower()
    if ('tasks' in _pl) or ('disabled-tasks' in _pl) or ('tasks_disabled' in _pl):
        log.error('HARD BLOCK: attempted to call tasks endpoint: %s', path)
        raise RuntimeError('Tasks endpoints disabled; use chat-poll + /api/chat/completed.')
    url = f"{OWUI}{path}"
    headers = kwargs.pop("headers", {})
    headers["Authorization"] = f"Bearer {token}"
    if method.upper() == 'GET' and 'Accept' not in headers:
        headers['Accept'] = 'application/json'
    tid = f"T{uuid.uuid4().hex[:8]}"
    body_preview = ""
    if DEBUG_HTTP:
        if "json" in kwargs:
            body_preview = f" json={_shorten(kwargs['json'], 400)}"
        elif "data" in kwargs:
            body_preview = f" data={_shorten(kwargs['data'], 200)}"
    t0 = time.time()
    try:
        r = requests.request(method, url, headers=headers, timeout=120, **kwargs)
        dt = time.time() - t0
        lvl = log.info if r.ok else log.error
        resp_preview = ""
        if not r.ok or DEBUG_HTTP:
            resp_preview = f" body={_shorten((r.text or '')[:500], 500)}"
        lvl("OWUI %s %s -> %s (%s) tid=%s in %.2fs%s%s",
            method, path, r.status_code, r.reason, tid, dt, body_preview, resp_preview)
        return r
    except Exception as e:
        dt = time.time() - t0
        log.exception("OWUI %s %s EXC tid=%s in %.2fs: %s", method, path, tid, dt, e)
        raise
def _improve_http_error(r: requests.Response, default_msg: str = "") -> requests.HTTPError:
    msg = f"{default_msg} | {r.status_code} {r.reason}"
    try:
        js = r.json()
        if isinstance(js, dict) and js.get("detail"):
            msg += f": {js.get('detail')}"
        else:
            txt = (r.text or "").strip()
            if txt:
                msg += f": {txt[:300]}"
    except Exception:
        txt = (r.text or "").strip()
        if txt:
            msg += f": {txt[:300]}"
    return requests.HTTPError(msg, response=r)
def _is_model_not_found_error(e: Exception) -> bool:
    s = str(e).lower()
    keywords = [
        "model not found", "no such model", "invalid model", "missing model",
        "could not find", "unknown model", "unavailable model",
        "缺少 model", "模型不可用", "模型不存在", "模型未找到"
    ]
    return any(k in s for k in keywords)
def _is_http_status(e: Exception, code: int) -> bool:
    if isinstance(e, requests.HTTPError) and getattr(e, "response", None) is not None:
        try:
            return int(e.response.status_code) == code
        except Exception:
            pass
    s = str(e)
    return f" {code} " in s or f"{code} " in s
# --------------------------- 工具：消息/图片 ---------------------
_IMG_MD_RE = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")
_IMG_URL_RE = re.compile(r"(https?://[^\s)]+?\.(?:png|jpg|jpeg|gif|webp)(?:\?[^\s)]*)?)", re.IGNORECASE)
def _extract_images_from_text(text: str) -> List[str]:
    urls: List[str] = []
    urls += _IMG_MD_RE.findall(text or "")
    urls += _IMG_URL_RE.findall(text or "")
    seen = set();
    out = []
    for u in urls:
        if u not in seen:
            out.append(u);
            seen.add(u)
    return out
def _strip_images_placeholder(text: str) -> str:
    s = _IMG_MD_RE.sub("【图片】", text or "")
    s = _IMG_URL_RE.sub("【图片】", s)
    return s
def _strip_md_for_wechat(s: str) -> str:
    if not s:
        return s
    s = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", s)
    s = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1 (\2)", s)
    s = re.sub(r"```.+?```", lambda m: m.group(0).replace("```", ""), s, flags=re.S)
    s = s.replace("`", "")
    for mark in ("**", "__", "*", "_", "~~"):
        s = s.replace(mark, "")
    s = re.sub(r"^[#>\-\+\*]\s*", "", s, flags=re.M)
    s = re.sub(r"\|\s*-{2,}\s*\|", "|", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()
def _ensure_str_content(msg_obj: Dict[str, Any]) -> str:
    c = msg_obj.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        parts = []
        for it in c:
            if isinstance(it, dict):
                if it.get("type") in ("text", "markdown") and it.get("text"):
                    parts.append(str(it.get("text")))
                elif "content" in it and isinstance(it["content"], str):
                    parts.append(it["content"])
        return "".join(parts).strip()
    if isinstance(msg_obj.get("response"), str):
        return msg_obj["response"]
    return ""



def _mk_content_parts(text: str, images: list[str]) -> list[dict]:
    parts = []
    t = (text or "").strip()
    if t:
        parts.append({"type": "text", "text": t})
    for u in images or []:
        if not u:
            continue
        parts.append({"type": "image_url", "image_url": {"url": u}})
    return parts
def _extract_all_images_from_msg(m: dict, fallback_text: str = "") -> list[str]:
    urls = []
    content = m.get("content")
    if isinstance(content, list):
        for p in content:
            if isinstance(p, dict) and p.get("type") == "image_url":
                u = ((p.get("image_url") or {}).get("url") or "").strip()
                if u:
                    urls.append(u)
    if isinstance(m.get("images"), list):
        for u in m["images"]:
            if isinstance(u, str) and u.strip():
                urls.append(u.strip())
    for g in re.finditer(r"!\[[^\]]*\]\((.*?)\)", fallback_text or ""):
        u = (g.group(1) or "").strip()
        if u:
            urls.append(u)
    out, seen = [], set()
    for u in urls:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def _extract_images_from_msgobj(msg_obj: Dict[str, Any], text: str) -> List[str]:
    images: List[str] = []
    if isinstance(msg_obj.get("images"), list):
        for it in msg_obj["images"]:
            if isinstance(it, str):
                images.append(it)
            elif isinstance(it, dict):
                u = it.get("url") or it.get("image_url") or ((it.get("image_url") or {}).get("url"))
                if u: images.append(u)
    cnt = msg_obj.get("content")
    if isinstance(cnt, list):
        for p in cnt:
            if isinstance(p, dict) and p.get("type") == "image_url":
                iu = p.get("image_url")
                if isinstance(iu, dict) and iu.get("url"):
                    images.append(iu["url"])
    images += _extract_images_from_text(text)
    seen = set();
    im_out = []
    for u in images:
        if u and u not in seen:
            im_out.append(u);
            seen.add(u)
    return im_out
def _extract_images_from_content_parts(user_content: Any) -> List[str]:
    out: List[str] = []
    if isinstance(user_content, list):
        for p in user_content:
            if isinstance(p, dict) and p.get("type") == "image_url":
                iu = p.get("image_url")
                if isinstance(iu, dict) and iu.get("url"):
                    out.append(iu["url"])
    return out
def _content_has_image(content: Any) -> bool:
    if isinstance(content, list):
        for p in content:
            if isinstance(p, dict) and p.get("type") == "image_url":
                return True
    return False
def _split_text_and_images_payload(user_content: Any) -> Tuple[str, List[str]]:
    if isinstance(user_content, str):
        return user_content.strip(), []
    text_parts, imgs = [], []
    if isinstance(user_content, list):
        for p in user_content:
            if isinstance(p, dict):
                if p.get("type") == "text" and p.get("text"):
                    text_parts.append(str(p["text"]))
                elif p.get("type") == "image_url":
                    iu = p.get("image_url") or {}
                    u = iu.get("url") if isinstance(iu, dict) else None
                    if u: imgs.append(u)
    return ("".join(text_parts).strip(), imgs)
# >>> 将历史对话构建为 /api/chat/completions 的 messages
def _build_messages_for_completion(user_token: str, chat_id: str,
                                   *, max_msgs: int = MAX_CONTEXT_MSGS) -> List[Dict[str, Any]]:
    js = owui_fetch_chat(user_token, chat_id)
    msgs: List[Dict[str, Any]] = []
    chat_obj = (js.get("chat") or {}) if isinstance(js, dict) else {}
    if isinstance(chat_obj.get("messages"), list):
        msgs = chat_obj["messages"]
    elif isinstance(js, dict) and isinstance(js.get("messages"), list):
        msgs = js["messages"]
    else:
        hist = (chat_obj.get("history") or {}).get("messages") or {}
        if isinstance(hist, dict):
            msgs = list(hist.values())
    msgs = sorted(msgs, key=lambda m: float(m.get("timestamp") or 0))
    out: List[Dict[str, Any]] = []
    for m in msgs:
        role = (m.get("role") or "").strip()
        if role not in ("user", "assistant"):
            continue
        text = _ensure_str_content(m)
        imgs = _extract_images_from_msgobj(m, text)
        if role == "assistant" and (not text.strip()) and (not imgs):
            continue
        if imgs:
            parts: List[Dict[str, Any]] = []
            if text.strip():
                parts.append({"type": "text", "text": text})
            for url in imgs:
                parts.append({"type": "image_url", "image_url": {"url": url}})
            content: Any = parts
        else:
            content = text
        out.append({"role": role, "content": content})
    # 仅保留“最后一条用户带图消息”之后的上下文，避免误用旧图
    last_user_img_idx = None
    for i in range(len(out) - 1, -1, -1):
        m = out[i]
        if m.get("role") == "user" and _content_has_image(m.get("content")):
            last_user_img_idx = i
            break
    if last_user_img_idx is not None:
        out = out[last_user_img_idx:]
    if len(out) > max_msgs:
        out = out[-max_msgs:]
    if DEBUG_HTTP:
        try:
            def _brief_content(c: Any) -> str:
                if isinstance(c, list):
                    txt = "".join([p.get("text", "") for p in c if isinstance(p, dict) and p.get("type") == "text"])
                    return (txt[:60] + ("..." if len(txt) > 60 else "")) or "[media]"
                s = str(c or "")
                return s[:60] + ("..." if len(s) > 60 else "")
            preview = " | ".join([f"{m['role']}:{_brief_content(m['content'])}" for m in out[-5:]])
            log.info("[ctx.preview] %s", preview)
        except Exception:
            pass
    log.info("[ctx] built %s messages for completion (chat_id=%s)", len(out), chat_id)
    return out
# --------------------------- Chat Completions ------------------
def owui_chat_complete_raw(
        user_token: str,
        messages: List[Dict[str, Any]],
        model: Optional[str] = None,
        chat_id: Optional[str] = None,
        assistant_id: Optional[str] = None,
        session_id: Optional[str] = None,
        background_tasks: Optional[Dict[str, bool]] = None,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"messages": messages, "stream": False}
    if chat_id:
        payload["chat_id"] = chat_id
    if assistant_id:
        payload["id"] = assistant_id
    if (model or "").strip():
        payload["model"] = (model or "").strip()
    if (session_id or "").strip():
        payload["session_id"] = session_id
    if isinstance(background_tasks, dict):
        payload["background_tasks"] = background_tasks
    log.info("[complete.req] chat_id=%s assistant_id=%s model=%s session_id=%s msgs=%s",
             chat_id, assistant_id, model, _mask(session_id or ""), len(messages))
    r = _owui_req("POST", "/api/chat/completions", user_token,
                  headers={"Content-Type": "application/json"}, json=payload)
    if not r.ok:
        raise _improve_http_error(r, "Open WebUI 调用失败")
    return r.json()
def _pick_chat_id_from_resp(js: Dict[str, Any]) -> Optional[str]:
    for key in ("chat_id", "conversation_id"):
        v = (js.get(key) or "")
        if isinstance(v, str) and len(v) >= 8:
            return v
    if isinstance(js.get("chat"), dict):
        v = js["chat"].get("id")
        if isinstance(v, str) and len(v) >= 8:
            return v
    try:
        meta = js.get("choices", [{}])[0].get("message", {}).get("metadata", {}) or {}
        v = meta.get("chat_id") or meta.get("conversation_id")
        if isinstance(v, str) and len(v) >= 8:
            return v
    except Exception:
        pass
    return None
def _deep_find_first(js: Any, key: str) -> Optional[Any]:
    found: Optional[Any] = None
    def walk(x):
        nonlocal found
        if found is not None:
            return
        if isinstance(x, dict):
            if key in x and x[key] not in (None, ""):
                found = x[key];
                return
            for v in x.values(): walk(v)
        elif isinstance(x, list):
            for v in x: walk(v)
    walk(js)
    return found
def _parse_task_result(js: Dict[str, Any]) -> Tuple[str, List[str]]:
    try:
        choices = js.get("choices")
        if isinstance(choices, list) and choices:
            msg_obj = choices[0].get("message") or {}
            txt = _ensure_str_content(msg_obj).strip()
            imgs = _extract_images_from_msgobj(msg_obj, txt)
            if txt or imgs:
                return txt, imgs
    except Exception:
        pass
    def dig(x) -> Tuple[str, List[str]]:
        if isinstance(x, dict):
            txt = ""
            out_imgs: List[str] = []
            if "message" in x:
                txt = _ensure_str_content(x["message"]).strip() or txt
                out_imgs += _extract_images_from_msgobj(x["message"], txt)
            if not txt:
                if "content" in x and isinstance(x["content"], str):
                    txt = x["content"].strip()
                elif "text" in x and isinstance(x["text"], str):
                    txt = x["text"].strip()
            for k in ("images", "files", "artifacts", "attachments", "image_urls"):
                v = x.get(k)
                if isinstance(v, list):
                    for it in v:
                        if isinstance(it, str) and it:
                            out_imgs.append(it)
                        elif isinstance(it, dict):
                            u = it.get("url") or it.get("src") or it.get("image_url") or it.get("file")
                            if isinstance(u, dict):
                                u = u.get("url")
                            if isinstance(u, str) and u:
                                out_imgs.append(u)
            # ✅ 兼容 Gemini 返回：candidates[].content.parts[].inline_data{mime_type,data}
            try:
                candidates = x.get("candidates")
                if isinstance(candidates, list):
                    for c in candidates:
                        content = (c or {}).get("content") or {}
                        parts = content.get("parts") or []
                        for p in parts:
                            inline = (p or {}).get("inline_data") or (p or {}).get("inlineData")
                            if isinstance(inline, dict) and inline.get("data"):
                                mime = inline.get("mime_type") or inline.get("mimeType") or "image/png"
                                b64 = inline.get("data")
                                out_imgs.append(f"data:{mime};base64,{b64}")
            except Exception:
                pass
            # ✅ 兼容 OpenAI 风格：data[].b64_json / 可选 mime_type
            try:
                data_list = x.get("data")
                if isinstance(data_list, list):
                    for it in data_list:
                        b64 = (it or {}).get("b64_json")
                        if b64:
                            mime = (it or {}).get("mime_type") or "image/png"
                            out_imgs.append(f"data:{mime};base64,{b64}")
            except Exception:
                pass
            for k in ("result", "response", "output", "data", "task"):
                if k in x:
                    t2, i2 = dig(x[k])
                    if t2 or i2:
                        txt = txt or t2
                        out_imgs = out_imgs or i2
            out_imgs = list(dict.fromkeys(out_imgs))
            return txt, out_imgs
        elif isinstance(x, list):
            for it in x:
                t2, i2 = dig(it)
                if t2 or i2:
                    return t2, i2
        return "", []
    return dig(js)

def _harvest_and_send_recent_images(user_token: str, chat_id: str, assistant_id: Optional[str],
                                    window_sec: int, tick: float, ext_uid: str):
    deadline = time.time() + max(2, window_sec)
    while time.time() < deadline:
        try:
            js = owui_fetch_chat(user_token, chat_id)
            chat = (js.get("chat") or js or {})
            msgs = list(chat.get("messages") or [])
            candidates = []
            if assistant_id:
                for m in msgs:
                    if m.get("id") == assistant_id:
                        candidates = [m]
                        break
            if not candidates:
                candidates = [m for m in reversed(msgs) if m.get("role") == "assistant"][:3]
            sent = 0
            for m in candidates:
                txt = _ensure_str_content(m)
                imgs = _extract_all_images_from_msg(m, txt)
                for u in imgs:
                    _send_wecom_image_any(ext_uid, u)
                    sent += 1
            if sent:
                log.info("harvest images: sent=%s", sent)
                return
        except Exception as e:
            log.warning("harvest images fail: %s", e)
        time.sleep(max(0.2, tick))


def _poll_task_result(user_token: str, task_id: str,
                      timeout_sec: float = POLL_TIMEOUT_SEC,
                      interval_sec: float = POLL_INTERVAL_SEC) -> Tuple[str, List[str]]:
    if not (task_id or "").strip():
        return "", []
    t0 = time.time()
    last_err: Optional[Exception] = None
    paths = [
        f"/api/TASKS_DISABLED/{task_id}",
        f"/api/v1/TASKS_DISABLED/{task_id}",
        f"/api/TASKS_DISABLED/{task_id}/result",
        f"/api/v1/TASKS_DISABLED/{task_id}/result",
        f"/api/TASKS_DISABLED/result/{task_id}",
        f"/api/TASKS_DISABLED/result?id={task_id}",
    ]
    while (time.time() - t0) < timeout_sec:
        for p in paths:
            try:
                r = _owui_req("GET", p, user_token, headers={"Accept": "application/json"})
                if not r.ok:
                    continue
                if "application/json" not in (r.headers.get("content-type") or "").lower():
                    continue
                js = r.json() or {}
                txt, imgs = _parse_task_result(js)
                if txt or imgs:
                    log.info("[task] result via %s: text_len=%s imgs=%s", p, len(txt), len(imgs))
                    return txt, imgs
                node = js
                for k in ("data", "task"):
                    if isinstance(node.get(k), dict):
                        node = node[k]
                st = str(node.get("state") or js.get("state") or "").lower()
                if st in ("failed", "error"):
                    log.warning("[task] %s -> %s", p, st)
                    return "", []
            except Exception as e:
                last_err = e
        time.sleep(interval_sec)
    if last_err:
        log.debug("[task] poll timeout: %s", last_err)
    return "", []
def _poll_assistant_content(user_token: str, chat_id: str, assistant_mid: str,
                            user_mid: Optional[str] = None,
                            timeout_sec: float = POLL_TIMEOUT_SEC,
                            interval_sec: float = POLL_INTERVAL_SEC) -> Tuple[str, List[str]]:
    t0 = time.time()
    last_err = None
    while (time.time() - t0) < timeout_sec:
        try:
            js = owui_fetch_chat(user_token, chat_id)
            msgs: List[Dict[str, Any]] = []
            chat_obj = (js.get("chat") or {}) if isinstance(js, dict) else {}
            if isinstance(chat_obj.get("messages"), list):
                msgs = chat_obj["messages"]
            elif isinstance(js, dict) and isinstance(js.get("messages"), list):
                msgs = js["messages"]
            else:
                hist = (chat_obj.get("history") or {}).get("messages") or {}
                if isinstance(hist, dict):
                    msgs = list(hist.values())
            msgs = sorted(msgs, key=lambda m: float(m.get("timestamp") or 0))
            for m in msgs:
                if (m.get("role") == "assistant") and (str(m.get("id")) == str(assistant_mid)):
                    text = _ensure_str_content(m).strip()
                    imgs = _extract_images_from_msgobj(m, text)
                    if (text and not _is_placeholder_text(text)) or imgs:
                        return text, imgs
            if user_mid:
                ts_user = None
                for m in msgs:
                    if str(m.get("id")) == str(user_mid):
                        try:
                            ts_user = float(m.get("timestamp") or 0)
                        except Exception:
                            ts_user = None
                        break
                for m in msgs:
                    if m.get("role") == "assistant" and str(m.get("parentId")) == str(user_mid):
                        text = _ensure_str_content(m).strip()
                        imgs = _extract_images_from_msgobj(m, text)
                        if (text and not _is_placeholder_text(text)) or imgs:
                            return text, imgs
                if ts_user:
                    for m in msgs:
                        if m.get("role") == "assistant":
                            try:
                                ts_m = float(m.get("timestamp") or 0)
                            except Exception:
                                ts_m = 0.0
                            if ts_m >= ts_user:
                                text = _ensure_str_content(m).strip()
                                imgs = _extract_images_from_msgobj(m, text)
                                if (text and not _is_placeholder_text(text)) or imgs:
                                    return text, imgs
        except Exception as e:
            last_err = e
            log.debug("poll chat error: %s", e)
        time.sleep(interval_sec)
    if last_err:
        log.debug("poll timeout (last_err=%s)", last_err)
    return "", []
def owui_chat_complete(
    user_token: str,
    messages,
    chat_id: str | None = None,
    model: str | None = None,
    assistant_id: str | None = None,
    session_id: str | None = None,
    user_id: str | None = None,
    poll: bool = True,
):
    """Kick completion and synchronously poll *chat* (no tasks).
    Returns: (text, images, chat_id_created, raw_response_dict)
    """
    # 1) fire completion request (no streaming)
    data = owui_chat_complete_raw(
        user_token=user_token,
        messages=messages,
        chat_id=chat_id,
        model=model,
        assistant_id=assistant_id,
        session_id=session_id,
        # keep title generation enabled so OWUI auto-titles as before
        background_tasks={"title_generation": False},
    )

    # 2) short-circuit if direct content is returned immediately
    direct_txt = (data.get("choices") or [{}])[0].get("message", {}).get("content", "") if isinstance(data, dict) else ""
    direct_imgs = (data.get("choices") or [{}])[0].get("message", {}).get("images", []) if isinstance(data, dict) else []
    if (direct_txt and direct_txt.strip()) or direct_imgs:
        return direct_txt or "", direct_imgs or [], chat_id, data

    # 3) find the newest/current chat id
    new_chat_id, _ = _pick_chat_id(user_token, chat_id)

    # 4) optionally poll the chat for the assistant's message (by assistant_id)
    if not poll:
        return "", [], new_chat_id, data

    # --- safe inits to avoid UnboundLocalError ---
    got_text, got_imgs = "", []

    # --- polling timeouts ---
    try:
        SHORT = float(os.getenv("WECOM_SHORT_WINDOW_SEC", "5"))
    except Exception:
        SHORT = 5.0
    # Short interval for the short window, capped to >=0.2s
    INTERVAL = max(0.2, min(globals().get("POLL_INTERVAL_SEC", 0.5), 0.5))
    DEFAULT_TIMEOUT = float(globals().get("POLL_TIMEOUT_SEC", 12.0))

    # 4a) short-window poll (fast UI feedback)
    if new_chat_id:
        try:
            c_text, c_imgs = _poll_assistant_content(
                user_token, new_chat_id, assistant_id or "", user_mid=user_id,
                timeout_sec=max(0.3, SHORT),
                interval_sec=INTERVAL,
            )
            if (c_imgs) or (c_text and c_text.strip() and c_text.strip() != "…"):
                got_text, got_imgs = c_text or "", c_imgs or []
        except Exception as e:
            log.warning("short poll failed: %s", e)

    # 4b) if still nothing, continue polling up to the normal timeout
    if not ((got_text and got_text.strip()) or got_imgs) and new_chat_id:
        left = max(0.0, DEFAULT_TIMEOUT - SHORT)
        if left >= 0.2:
            try:
                c_text, c_imgs = _poll_assistant_content(
                    user_token, new_chat_id, assistant_id or "", user_mid=user_id,
                    timeout_sec=left,
                    interval_sec=max(0.3, globals().get("POLL_INTERVAL_SEC", 0.7)),
                )
                if (c_imgs) or (c_text and c_text.strip() and c_text.strip() != "…"):
                    got_text, got_imgs = c_text or "", c_imgs or []
            except Exception as e:
                log.warning("long poll failed: %s", e)

    log.info("complete(polled): text_len=%s preview=%r imgs=%s", len(got_text or ""), (got_text or "")[:60].replace("\n"," "), len(got_imgs or []))
    return got_text or "", got_imgs or [], new_chat_id, data
def _deep_find_msg_ids(js: Any) -> Tuple[Optional[str], Optional[str]]:
    user_mid = None
    assistant_mid = None
    def walk(x):
        nonlocal user_mid, assistant_mid
        if isinstance(x, dict):
            role = x.get("role")
            mid = x.get("id") or x.get("_id")
            if role == "user" and mid and not user_mid:
                user_mid = str(mid)
            if role == "assistant" and mid and not assistant_mid:
                assistant_mid = str(mid)
            for v in x.values(): walk(v)
        elif isinstance(x, list):
            for v in x: walk(v)
    walk(x=js)
    return user_mid, assistant_mid
def owui_seed_chat_messages(user_token: str, chat_id: str, model: str, user_content: Any) -> Tuple[str, str]:
    ts = int(time.time() * 1000)
    user_mid = str(uuid.uuid4())
    assistant_mid = str(uuid.uuid4())
    content_text, imgs = _split_text_and_images_payload(user_content)
    user_msg = {
        "id": user_mid,
        "role": "user",
        "content": content_text,
        "timestamp": ts,
        "models": [model],
    }
    if imgs:
        user_msg["images"] = imgs
    # ❗ 避免 WebUI “加载中”卡死：占位内容不再为空
    assistant_msg = {
        "id": assistant_mid,
        "role": "assistant",
        "content": "",
        "parentId": user_mid,
        "modelName": model,
        "modelIdx": 0,
        "timestamp": ts + 1,
    }
    payload = {
        "chat": {
            "id": chat_id,
            "messages": [user_msg, assistant_msg],
            "history": {
                "current_id": assistant_mid,
                "messages": {
                    user_mid: user_msg,
                    assistant_mid: assistant_msg,
                },
            },
        }
    }
    r = _owui_req("POST", f"/api/v1/chats/{chat_id}?refresh=1", user_token,
                  headers={"Content-Type": "application/json"}, json=payload)
    if not r.ok:
        raise _improve_http_error(r, "注入占位消息失败(/api/v1/chats/{id})")
    log.info("[seed] chat_id=%s user_mid=%s assistant_mid=%s", chat_id, user_mid, assistant_mid)
    return user_mid, assistant_mid
def _log_chat_summary(user_token: str, chat_id: str, note: str = ""):
    try:
        js = owui_fetch_chat(user_token, chat_id)
        chat_obj = (js.get("chat") or {}) if isinstance(js, dict) else {}
        msgs = chat_obj.get("messages") or []
        hist = (chat_obj.get("history") or {})
        hist_msgs = (hist.get("messages") or {})
        cur = hist.get("current_id")
        title = chat_obj.get("title") or js.get("title")
        log.info("[chat-summary%s] chat_id=%s messages.len=%s history.messages.len=%s current_id=%s title=%r",
                 f' {note}' if note else "", chat_id, len(msgs), len(hist_msgs), cur, title)
    except Exception as e:
        log.warning("chat-summary failed: %s", e)

def owui_append_user_message(user_token: str, chat_id: str, model: str, user_content: Any) -> str:
    """
    只追加“用户消息”到会话，且 **串联 parentId 到最后一条 assistant**，
    双写到 messages[] 与 history.messages{}，并更新 history.current_id。
    """
    ts = int(time.time() * 1000)
    user_mid = str(uuid.uuid4())
    chat_resp = owui_fetch_chat(user_token, chat_id)
    chat = (chat_resp.get("chat") or chat_resp or {})
    messages = list(chat.get("messages") or [])
    history = chat.get("history") or {"current_id": None, "messages": {}}
    hist_msgs = dict(history.get("messages") or {})
    if not hist_msgs and messages:
        try:
            hist_msgs = {str(m.get("id")): m for m in messages if isinstance(m, dict) and m.get("id")}
        except Exception:
            pass
    # 找到最后一条 assistant 以串联 parentId
    last_asst = None
    for m in reversed(messages):
        if isinstance(m, dict) and m.get("role") == "assistant" and m.get("id"):
            last_asst = m.get("id"); break

    content_text, imgs = _split_text_and_images_payload(user_content)
    user_msg = {
        "id": user_mid, "role": "user",
        "content": content_text, "timestamp": ts,
        "models": [model] if model else []
    }
    if imgs:
        user_msg["images"] = imgs
    if last_asst:
        user_msg["parentId"] = last_asst

    messages = messages + [user_msg]
    hist_msgs[user_mid] = user_msg
    payload = {
        "chat": {
            "id": chat_id,
            "messages": messages,
            "history": { "current_id": user_mid, "messages": hist_msgs }
        }
    }
    r = _owui_req("POST", f"/api/v1/chats/{chat_id}?refresh=1", user_token,
                  headers={"Content-Type": "application/json"}, json=payload)
    if not r.ok:
        raise _improve_http_error(r, "只追加用户消息失败(/api/v1/chats/{id})")
    log.info("[append-user] chat_id=%s user_mid=%s parent=%s", chat_id, user_mid, last_asst)
    return user_mid

def owui_append_assistant_message(user_token: str, chat_id: str, model: str,
                                  assistant_text: str, images: List[str],
                                  parent_id: Optional[str] = None) -> str:
    """
    仅追加“助手消息”到指定会话（不触发任何生成任务）。
    适配 OpenWebUI /api/v1/chats/{id} 结构，避免 UI 出现“加载中”。
    """
    ts = int(time.time() * 1000)
    assistant_mid = str(uuid.uuid4())
    chat_resp = owui_fetch_chat(user_token, chat_id)
    chat = (chat_resp.get("chat") or chat_resp or {})
    messages = list(chat.get("messages") or [])
    history = chat.get("history") or {"current_id": None, "messages": {}}
    hist_msgs = dict(history.get("messages") or {})
    if not hist_msgs and messages:
        try:
            hist_msgs = {str(m.get("id")): m for m in messages if isinstance(m, dict) and m.get("id")}
        except Exception:
            pass
    assistant_msg = {
        "id": assistant_mid,
        "role": "assistant",
        "content": _mk_content_parts(assistant_text or "", images or []),
        "parentId": parent_id,
        "modelName": model,
        "modelIdx": 0,
        "timestamp": ts,
    }
    messages = messages + [assistant_msg]
    hist_msgs[assistant_mid] = assistant_msg
    payload = {
        "chat": {
            "id": chat_id,
            "messages": messages,
            "history": {
                "current_id": assistant_mid,
                "messages": hist_msgs,
            },
        }
    }
    r = _owui_req("POST", f"/api/v1/chats/{chat_id}?refresh=1", user_token,
                  headers={"Content-Type": "application/json"}, json=payload)
    if not r.ok:
        raise _improve_http_error(r, "只追加助手消息失败(/api/v1/chats/{id})")
    log.info("[append-assistant] chat_id=%s assistant_mid=%s", chat_id, assistant_mid)
    return assistant_mid
def owui_append_user_and_assistant(user_token: str, chat_id: str, model: str, user_content: Any) -> Tuple[str, str]:
    ts = int(time.time() * 1000)
    user_mid = str(uuid.uuid4())
    assistant_mid = str(uuid.uuid4())
    chat_resp = owui_fetch_chat(user_token, chat_id)
    chat = (chat_resp.get("chat") or chat_resp or {})
    messages = list(chat.get("messages") or [])
    history = chat.get("history") or {"current_id": None, "messages": {}}
    hist_msgs = dict(history.get("messages") or {})
    if not hist_msgs and messages:
        try:
            hist_msgs = {str(m.get("id")): m for m in messages if isinstance(m, dict) and m.get("id")}
        except Exception:
            pass
    content_text, imgs = _split_text_and_images_payload(user_content)
    user_msg = {
        "id": user_mid,
        "role": "user",
        "content": content_text,
        "timestamp": ts,
        "models": [model],
    }
    if imgs:
        user_msg["images"] = imgs
    assistant_msg = {
        "id": assistant_mid,
        "role": "assistant",
        "content": "",  # 同上，避免 UI “加载中”
        "parentId": user_mid,
        "modelName": model,
        "modelIdx": 0,
        "timestamp": ts + 1,
    }
    messages = messages + [user_msg, assistant_msg]
    hist_msgs[user_mid] = user_msg
    hist_msgs[assistant_mid] = assistant_msg
    payload = {
        "chat": {
            "id": chat_id,
            "messages": messages,
            "history": {
                "current_id": assistant_mid,
                "messages": hist_msgs,
            },
        }
    }
    r = _owui_req("POST", f"/api/v1/chats/{chat_id}?refresh=1", user_token,
                  headers={"Content-Type": "application/json"}, json=payload)
    if not r.ok:
        raise _improve_http_error(r, "追加消息失败(/api/v1/chats/{id})")
    log.info("[append] chat_id=%s user_mid=%s assistant_mid=%s", chat_id, user_mid, assistant_mid)
    return user_mid, assistant_mid
def owui_create_new_chat_form(user_token: str,
                              title: Optional[str] = None,
                              models: Optional[List[str]] = None) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    payload_chat: Dict[str, Any] = {}
    if title is not None:
        payload_chat["title"] = title
    if models is not None:
        payload_chat["models"] = models
    payload = {"chat": payload_chat}
    r = _owui_req("POST", "/api/v1/chats/new", user_token,
                  headers={"Content-Type": "application/json"}, json=payload)
    if not r.ok:
        return (None, None, None)
    js = r.json() or {}
    cid = js.get("id") or (js.get("data") or {}).get("id") or (js.get("chat") or {}).get("id")
    u_mid, a_mid = _deep_find_msg_ids(js)
    log.info("create chat ok: id=%s user_mid=%s assistant_id=%s", cid, u_mid, a_mid)
    return (cid, u_mid, a_mid)
def _try_completed(payload: Dict[str, Any], user_token: str) -> bool:
    r = _owui_req("POST", "/api/chat/completed", user_token,
                  headers={"Content-Type": "application/json"}, json=payload)
    if r.ok:
        return True
    try:
        log.error("OWUI ERR POST /api/chat/completed %s: %s", r.status_code, (r.text or "")[:200])
    except Exception:
        pass
    return False

def owui_completed_save(user_token: str, chat_id: str,
                        user_mid: Optional[str], assistant_mid: Optional[str],
                        user_text: Any, assistant_text: str,
                        images: List[str],
                        *, model: Optional[str] = None,
                        session_id: Optional[str] = None) -> bool:

    # Ensure we only persist real content (skip placeholders)
    _txt = (assistant_text or "").strip()
    _imgs = images or []
    if ("_is_placeholder_text" in globals()) and _is_placeholder_text(_txt) and not _imgs:
        log.info("skip completed_save: placeholder/empty")
        return False
    if not assistant_mid:
        assistant_mid = str(uuid.uuid4())
    ts = int(time.time() * 1000)

    # 1) Overwrite or append assistant message with same id
    try:
        chat_resp = owui_fetch_chat(user_token, chat_id)
        chat = (chat_resp.get("chat") or chat_resp or {})
        messages = list(chat.get("messages") or [])
        history = chat.get("history") or {"current_id": None, "messages": {}}
        hist_msgs = dict(history.get("messages") or {})
    except Exception as e:
        log.warning("completed_save: fetch chat failed: %s", e)
        chat = {"messages": [], "history": {"current_id": None, "messages": {}}}
        messages, hist_msgs = [], {}

    parent_id = user_mid
    if not parent_id:
        for m in reversed(messages):
            if isinstance(m, dict) and m.get("role") == "user" and m.get("id"):
                parent_id = m.get("id"); break

    assistant_obj = {
        "id": assistant_mid,
        "role": "assistant",
        "content": _txt,
        "timestamp": ts,
        "parentId": parent_id,
    }
    if model:
        assistant_obj["modelName"] = model
        assistant_obj["modelIdx"] = 0
    if _imgs:
        assistant_obj["images"] = _imgs

    replaced = False
    for i, m in enumerate(messages):
        if str(m.get("id")) == str(assistant_mid):
            messages[i] = assistant_obj
            replaced = True
            break
    if not replaced:
        messages.append(assistant_obj)

    hist_msgs[str(assistant_mid)] = dict(assistant_obj)
    history["messages"] = hist_msgs
    history["current_id"] = str(assistant_mid)

    payload_chat = {
        "id": chat_id,
        "messages": messages,
        "history": history,
    }
    r1 = _owui_req("POST", f"/api/v1/chats/{chat_id}?refresh=1", user_token,
                   headers={"Content-Type": "application/json"},
                   json={"chat": payload_chat})
    if not r1.ok:
        log.error("persist assistant overwrite failed: %s %s", r1.status_code, (r1.text or "")[:200])

    # 2) Mark completed (required by OpenWebUI to exit 'generating')
    payload_completed = {
        "chat_id": chat_id,
        "id": assistant_mid,
    }
    if session_id:
        payload_completed["session_id"] = session_id
    if model:
        payload_completed["model"] = model

    r2 = _owui_req("POST", "/api/chat/completed", user_token,
                   headers={"Content-Type": "application/json"},
                   json=payload_completed)
    if not r2.ok:
        log.error("OWUI completed failed: %s %s", r2.status_code, (r2.text or "")[:200])
        return False

    log.info("completed() OK for chat_id=%s assistant_id=%s", chat_id, assistant_mid)
    return True

def owui_fetch_chat(user_token: str, chat_id: str) -> Dict[str, Any]:
    r = _owui_req("GET", f"/api/v1/chats/{chat_id}?refresh=1", user_token, headers={"Accept": "application/json"})
    if not r.ok:
        raise _improve_http_error(r, "获取会话详情失败")
    return r.json() or {}
def owui_update_chat_form(user_token: str, chat: Dict[str, Any]) -> None:
    cid = chat.get("id")
    if not cid:
        raise ValueError("chat.id 为空")
    payload = {"chat": chat}
    r = _owui_req("POST", f"/api/v1/chats/{cid}", user_token,
                  headers={"Content-Type": "application/json"}, json=payload)
    if not r.ok:
        raise _improve_http_error(r, "更新会话失败(/api/v1/chats/{id})")
def _sort_chats_with_pinned(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    def _key(x):
        return (0 if x.get("pinned") else 1, -int(x.get("updated_at") or 0))
    return sorted(items, key=_key)
def owui_list_chats(user_token: str, limit: int = 100) -> List[Dict[str, Any]]:
    try:
        r = _owui_req("GET", "/api/v1/chats/pinned", user_token)
        if r.ok:
            arr = r.json() or []
            if isinstance(arr, list):
                others = []
                r2 = _owui_req("GET", f"/api/v1/chats/list?limit={limit}", user_token)
                if r2.ok:
                    others = r2.json() or []
                merged = _sort_chats_with_pinned((arr or []) + (others or []))
                out = []
                seen = set()
                for it in merged:
                    cid = it.get("id")
                    if cid and cid not in seen:
                        out.append({"id": cid, "title": it.get("title", ""), "pinned": bool(it.get("pinned"))})
                        seen.add(cid)
                return out[:limit]
    except Exception:
        pass
    r = _owui_req("GET", f"/api/v1/chats/list?limit={limit}", user_token)
    if not r.ok:
        raise _improve_http_error(r, "获取历史对话失败")
    arr = r.json() or []
    if isinstance(arr, list):
        arr = _sort_chats_with_pinned(arr)
        return [{"id": x.get("id"), "title": x.get("title", ""), "pinned": bool(x.get("pinned"))}
                for x in arr[:limit] if x.get("id")]
    return []
# ------------------------ KF 发送文本/图片 + Outbox ----------------------
RATE_LIMIT_UNTIL: Dict[str, float] = {}
def _under_rl(external_userid: str) -> bool:
    ts = RATE_LIMIT_UNTIL.get(external_userid, 0.0)
    return ts > time.time()
def _mark_rl(external_userid: str, seconds: int = RATE_LIMIT_COOLDOWN_SEC):
    until = time.time() + max(1, seconds)
    RATE_LIMIT_UNTIL[external_userid] = until
# ===== Outbox（持久化重投） =====
_OUTBOX_LOCK = threading.Lock()
_OUTBOX_CACHE: List[Dict[str, Any]] = []
def _outbox_load_from_store() -> List[Dict[str, Any]]:
    store = _load_store()
    return list(store.get("__outbox__", []))
def _outbox_save_to_store(items: List[Dict[str, Any]]):
    store = _load_store()
    store["__outbox__"] = items
    _save_store(store)
def _outbox_init():
    global _OUTBOX_CACHE
    with _OUTBOX_LOCK:
        _OUTBOX_CACHE = _outbox_load_from_store()
def _outbox_enqueue(item: Dict[str, Any]):
    global _OUTBOX_CACHE
    with _OUTBOX_LOCK:
        # 限制总量/每用户
        items = _OUTBOX_CACHE
        per = [x for x in items if x.get("to") == item.get("to")]
        # ❗ 文本去重：同一用户只保留队列中“最新一条文本”，避免冷却后刷屏
        if item.get("kind") == "text":
            items = [x for x in items if not (x.get("to") == item.get("to") and x.get("kind") == "text")]
        if len(items) >= OUTBOX_MAX or len([x for x in items if x.get("to") == item.get("to")]) >= OUTBOX_PER_USER_MAX:
            log.warning("[outbox] queue is full (total=%s, user=%s), dropping oldest", len(items), len(per))
            items.sort(key=lambda x: float(x.get("due_ts", 0)))
            items.pop(0)
        items.append(item)
        _OUTBOX_CACHE = items
        _outbox_save_to_store(items)
        log.info("[outbox] enqueued: id=%s kind=%s to=%s due=%.0fs",
                 item.get("id"), item.get("kind"), item.get("to"), item.get("due_ts", 0) - time.time())
def _outbox_dequeue_by_id(eid: str):
    global _OUTBOX_CACHE
    with _OUTBOX_LOCK:
        items = [x for x in _OUTBOX_CACHE if x.get("id") != eid]
        _OUTBOX_CACHE = items
        _outbox_save_to_store(items)
def _outbox_list_due(now: float) -> List[Dict[str, Any]]:
    with _OUTBOX_LOCK:
        return [x for x in _OUTBOX_CACHE if float(x.get("due_ts", 0)) <= now]
def _outbox_reschedule(e: Dict[str, Any], later_sec: float):
    e["tries"] = int(e.get("tries", 0)) + 1
    e["due_ts"] = time.time() + max(1.0, later_sec)
    with _OUTBOX_LOCK:
        _outbox_save_to_store(_OUTBOX_CACHE)
def _backoff_delay(tries: int) -> float:
    return min(OUTBOX_BACKOFF_CAP, OUTBOX_BASE_BACKOFF * (2 ** max(0, tries - 1)))
def _outbox_worker():
    log.info("[outbox] worker started")
    while True:
        now = time.time()
        due = _outbox_list_due(now)
        if not due:
            time.sleep(OUTBOX_TICK_SEC)
            continue
        for e in sorted(due, key=lambda x: float(x.get("due_ts", 0)))[:20]:
            eid = e.get("id")
            to = e.get("to")
            kind = e.get("kind")
            tries = int(e.get("tries", 0))
            if _under_rl(to):
                # 仍在冷却，按冷却剩余时间顺延
                delay = max(1.0, RATE_LIMIT_UNTIL[to] - time.time() + 1.0)
                _outbox_reschedule(e, delay)
                continue
            ok = False
            try:
                if kind == "text":
                    ok, code = __send_kf_text_raw(to, e.get("text", ""))
                    if not ok and code == 95001:
                        _mark_rl(to)
                elif kind == "image_bytes":
                    data_b64 = e.get("data_b64") or ""
                    filename = e.get("filename") or "image.jpg"
                    if data_b64:
                        data = base64.b64decode(data_b64)
                        ok, code = __send_kf_image_bytes_raw(to, data, filename)
                        if not ok and code == 95001:
                            _mark_rl(to)
                else:
                    log.warning("[outbox] unknown kind=%s id=%s, dropping", kind, eid)
                    ok = True  # 丢弃
            except Exception as ex:
                log.warning("[outbox] send exception: %s", ex)
                ok = False
                code = None
            if ok:
                _outbox_dequeue_by_id(eid)
            else:
                if tries + 1 >= OUTBOX_MAX_RETRIES:
                    log.error("[outbox] exceeded max retries for id=%s, dropping", eid)
                    _outbox_dequeue_by_id(eid)
                else:
                    # 按回退/冷却顺延
                    if _under_rl(to):
                        delay = max(1.0, RATE_LIMIT_UNTIL[to] - time.time() + 1.0)
                    else:
                        delay = _backoff_delay(tries + 1)
                    _outbox_reschedule(e, delay)
        time.sleep(OUTBOX_TICK_SEC)
def _outbox_start_once():
    _outbox_init()
    t = threading.Thread(target=_outbox_worker, daemon=True)
    t.start()
# ===== 发送底层（不会入队） =====
def __send_kf_text_raw(external_userid: str, content: str) -> Tuple[bool, Optional[int]]:
    content = _strip_md_for_wechat(content or "")
    url = "https://qyapi.weixin.qq.com/cgi-bin/kf/send_msg"
    payload: Dict[str, Any] = {
        "touser": external_userid,
        "msgtype": "text",
        "text": {"content": content[:2000]},
    }
    if OPEN_KFID:
        payload["open_kfid"] = OPEN_KFID
    r = requests.post(url, params={"access_token": get_kf_access_token()}, json=payload, timeout=8)
    try:
        r.raise_for_status()
        js = r.json()
        if js.get("errcode") != 0:
            code = int(js.get("errcode") or 0)
            return False, code
        else:
            log.info("kf/send_msg resp={'errcode': 0, 'errmsg': 'ok', 'msgid': '%s'}", js.get("msgid", ""))
            return True, None
    except Exception:
        log.exception("kf/send_msg http error: %s", getattr(r, "text", "")[:300])
        return False, None
def __send_kf_image_bytes_raw(external_userid: str, data: bytes, filename: str = "image.jpg") -> Tuple[
    bool, Optional[int]]:
    media_id = _kf_upload_image_bytes(data, filename=filename)
    if not media_id:
        log.error("【图片】上传失败")
        return False, None
    payload: Dict[str, Any] = {
        "touser": external_userid,
        "msgtype": "image",
        "image": {"media_id": media_id},
    }
    if OPEN_KFID:
        payload["open_kfid"] = OPEN_KFID
    r = requests.post("https://qyapi.weixin.qq.com/cgi-bin/kf/send_msg",
                      params={"access_token": get_kf_access_token()}, json=payload, timeout=20)
    try:
        r.raise_for_status()
        js = r.json()
        if js.get("errcode") != 0:
            code = int(js.get("errcode") or 0)
            return False, code
        log.info("kf/send_msg image ok")
        return True, None
    except Exception:
        log.exception("kf/send_msg image http error: %s", getattr(r, "text", "")[:300])
        return False, None
# ===== 对外发送（会入队重投） =====
def send_kf_text(external_userid: str, content: str) -> bool:
    if _is_placeholder_text(content):
        log.info("skip send_kf_text: placeholder filtered")
        return False
    if _under_rl(external_userid):
        # 冷却中：直接入队（文本合并策略在 _outbox_enqueue）
        _outbox_enqueue({
            "id": f"t_{uuid.uuid4().hex}",
            "to": external_userid,
            "kind": "text",
            "text": content or "",
            "tries": 0,
            "due_ts": RATE_LIMIT_UNTIL[external_userid] + 1.0
        })
        log.warning("reply to %s queued (95001 冷却中)", external_userid)
        return False
    ok, code = __send_kf_text_raw(external_userid, content)
    if not ok and code == 95001:
        _mark_rl(external_userid)
        _outbox_enqueue({
            "id": f"t_{uuid.uuid4().hex}",
            "to": external_userid,
            "kind": "text",
            "text": content or "",
            "tries": 0,
            "due_ts": RATE_LIMIT_UNTIL[external_userid] + 1.0
        })
        log.error("kf/send_msg 95001 -> queued for retry")
    return ok
_WECHAT_IMAGE_LIMIT = 2 * 1024 * 1024
def _maybe_downscale_to_limit(data: bytes, filename: str) -> bytes:
    if len(data) <= _WECHAT_IMAGE_LIMIT or not _PIL_OK:
        return data
    try:
        im = Image.open(io.BytesIO(data))
        max_side = 1280
        w, h = im.size
        ratio = min(1.0, max_side / max(w, h))
        if ratio < 1.0:
            im = im.resize((int(w * ratio), int(h * ratio)))
        buf = io.BytesIO()
        ext = (os.path.splitext(filename)[-1] or ".jpg").lower()
        if ext in (".png", ".webp"):
            im = im.convert("RGB")
            ext = ".jpg"
        quality = 85
        while quality >= 60:
            buf.seek(0);
            buf.truncate(0)
            im.save(buf, format="JPEG", quality=quality, optimize=True)
            if buf.tell() <= _WECHAT_IMAGE_LIMIT:
                return buf.getvalue()
            quality -= 5
    except Exception as e:
        log.warning("downscale failed: %s", e)
    return data
def _kf_upload_image_bytes(data: bytes, filename: str = "image.png") -> Optional[str]:
    data = _maybe_downscale_to_limit(data, filename)
    mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    files = {"media": (filename, data, mime)}
    access = get_kf_access_token()
    try:
        r = requests.post("https://qyapi.weixin.qq.com/cgi-bin/kf/media/upload",
                          params={"access_token": access, "media_type": "image"},
                          files=files, timeout=20)
        if r.ok:
            j = r.json()
            if j.get("errcode") == 0 and j.get("media_id"):
                return j["media_id"]
            else:
                log.warning("kf/media/upload resp=%s", j)
    except Exception as e:
        log.warning("kf/media/upload failed: %s", e)
    try:
        r = requests.post("https://qyapi.weixin.qq.com/cgi-bin/media/upload",
                          params={"access_token": access, "type": "image"},
                          files=files, timeout=20)
        if r.ok:
            j = r.json()
            if j.get("media_id"):
                return j["media_id"]
            else:
                log.warning("media/upload resp=%s", j)
    except Exception as e:
        log.warning("media/upload fallback failed: %s", e)
    return None
def send_kf_image_by_bytes(external_userid: str, data: bytes, filename: str = "image.jpg") -> bool:
    data = _maybe_downscale_to_limit(data, filename)
    if _under_rl(external_userid):
        item = {
            "id": f"i_{uuid.uuid4().hex}",
            "to": external_userid,
            "kind": "image_bytes",
            "data_b64": base64.b64encode(data).decode("utf-8"),
            "filename": filename,
            "tries": 0,
            "due_ts": RATE_LIMIT_UNTIL[external_userid] + 1.0
        }
        _outbox_enqueue(item)
        log.warning("image to %s queued (95001 冷却中) id=%s", external_userid, item["id"])
        return False
    ok, code = __send_kf_image_bytes_raw(external_userid, data, filename)
    if not ok and code == 95001:
        _mark_rl(external_userid)
        item = {
            "id": f"i_{uuid.uuid4().hex}",
            "to": external_userid,
            "kind": "image_bytes",
            "data_b64": base64.b64encode(data).decode("utf-8"),
            "filename": filename,
            "tries": 0,
            "due_ts": RATE_LIMIT_UNTIL[external_userid] + 1.0
        }
        _outbox_enqueue(item)
        log.error("kf/send_msg image 95001 -> queued for retry (id=%s)", item["id"])
    return ok
def send_kf_image_by_url(external_userid: str, url: str, user_token: Optional[str] = None):
    try:
        if url.startswith("data:image/"):
            head, b64 = url.split(",", 1)
            mime = "image/png"
            m = re.search(r"data:(.*?);base64", head)
            if m: mime = m.group(1)
            ext = mimetypes.guess_extension(mime) or ".png"
            data = base64.b64decode(b64)
            send_kf_image_by_bytes(external_userid, data, filename=f"image{ext}")
            return
        abs_url = _abs_owui_url(url)
        headers = {}
        o = urlparse(OWUI.rstrip("/"))
        p = urlparse(abs_url)
        if (p.scheme, p.netloc) == (o.scheme, o.netloc) and (user_token or ""):
            headers["Authorization"] = f"Bearer {user_token}"
        # 有些 /api/v1/files 存在短暂生成延迟，做 3 次重试
        _last = None
        for _try in range(3):
            r = requests.get(abs_url, headers=headers, timeout=25)
            if r.ok and r.content:
                break
            _last = r
            time.sleep(0.8)
        r = r if (r.ok and r.content) else _last
        if (not r) or (not r.ok) or (not r.content):
            raise RuntimeError(f"download failed status={getattr(r,'status_code',-1)} size={len(getattr(r,'content',b''))}")
            raise RuntimeError(f"download failed status={r.status_code} size={len(r.content)}")
        ctype = (r.headers.get("content-type") or "").lower()
        ext = (os.path.splitext(p.path or "")[-1] or "").lower()
        is_img_ext = ext in (".png", ".jpg", ".jpeg", ".gif", ".webp")
        if (not ctype.startswith("image/")) and (not is_img_ext):
            raise RuntimeError(f"not image content-type={ctype or 'unknown'} path={p.path}")
        if ext not in (".png", ".jpg", ".jpeg", ".gif", ".webp"):
            if "/jpeg" in ctype:
                ext = ".jpg"
            elif "/png" in ctype:
                ext = ".png"
            elif "/gif" in ctype:
                ext = ".gif"
            else:
                ext = ".jpg"
        send_kf_image_by_bytes(external_userid, r.content, filename=f"image{ext}")
    except Exception as e:
        log.warning("download/send image failed: %s", e)
# --------------------------- Helpers ---------------------------
def _extract(xml: str, tag: str) -> Optional[str]:
    m = re.search(fr"<{tag}><!\[CDATA\[(.+?)\]\]></{tag}>", xml)
    return m.group(1) if m else None
def _extract_token_from_xml(xml: str) -> Optional[str]:
    return _extract(xml, "Token")
def _extract_open_kfid_from_xml(xml: str) -> Optional[str]:
    return _extract(xml, "OpenKfId")
def _kf_download_image_data_url(media_id: str) -> Optional[str]:
    """
    从企业微信拉取图片媒体并转为 data URL（用于缓存 recent last_image）
    """
    access = get_kf_access_token()
    # 新接口优先
    urls = [
        ("https://qyapi.weixin.qq.com/cgi-bin/kf/media/get", {"access_token": access, "media_id": media_id}),
        ("https://qyapi.weixin.qq.com/cgi-bin/media/get", {"access_token": access, "media_id": media_id}),
    ]
    for u, params in urls:
        try:
            r = requests.get(u, params=params, timeout=15)
            if not r.ok or not r.content:
                continue
            ctype = (r.headers.get("content-type") or "image/jpeg").split(";")[0]
            if not ctype.startswith("image/"):
                # 可能返回 json 错误
                try:
                    js = r.json()
                    log.warning("kf media get non-image: %s", js)
                except Exception:
                    pass
                continue
            b64 = base64.b64encode(r.content).decode("utf-8")
            return f"data:{ctype};base64,{b64}"
        except Exception as e:
            log.debug("kf media get error: %s", e)
    return None
SEEN_MSGIDS: Dict[str, float] = {}
SEEN_TTL = 300.0
def _gc_seen():
    now = time.time()
    for k in list(SEEN_MSGIDS.keys()):
        if SEEN_MSGIDS[k] < now:
            SEEN_MSGIDS.pop(k, None)
# --------------------------- 模型名解析 ---------------------------
def owui_models(user_token: str) -> List[Dict[str, str]]:
    r = _owui_req("GET", "/api/models", user_token)
    if not r.ok:
        raise _improve_http_error(r, "获取模型失败")
    js = r.json()
    out: List[Dict[str, str]] = []
    def _push(it: Dict[str, Any]):
        mid = (it.get("id") or it.get("name") or "").strip()
        nm = (it.get("display_name") or it.get("name") or it.get("label") or mid).strip()
        if mid:
            out.append({"id": mid, "name": nm})
    if isinstance(js, dict) and "data" in js:
        for it in js.get("data", []):
            if isinstance(it, dict): _push(it)
    elif isinstance(js, list):
        for it in js:
            if isinstance(it, dict): _push(it)
    seen = set();
    res = []
    for it in out:
        if it["id"] not in seen:
            res.append(it);
            seen.add(it["id"])
    return res
def _resolve_model_name(u: Dict[str, Any], token: str, model_id: str) -> str:
    if not model_id: return "未设置"
    cache = u.get("_models_cache") or {"ts": 0.0, "list": []}
    ls = cache.get("list") or []
    now = time.time()
    if (now - float(cache.get("ts") or 0)) > 120 or not ls:
        try:
            ls = owui_models(token)
            u["_models_cache"] = {"ts": now, "list": ls}
        except Exception as e:
            log.warning("models refresh failed: %s", e)
    for it in ls:
        if it.get("id") == model_id:
            return it.get("name") or model_id
    return model_id
def _pick_first_available_model(token: str) -> Optional[str]:
    try:
        ms = owui_models(token)
        return ms[0]["id"] if ms else None
    except Exception as e:
        log.warning("auto-pick model failed: %s", e)
        return None
def _apply_chat_model(user_token: str, chat_id: str, model_id: str) -> None:
    try:
        owui_update_chat_form(user_token, {"id": chat_id, "models": [model_id]})
    except Exception as e:
        log.warning("update chat model failed: %s", e)
# --------------------------- UI 文案 ---------------------------
def _main_menu_text(user_token: Optional[str] = None, u: Optional[Dict[str, Any]] = None) -> str:
    model_line = ""
    if user_token and u:
        try:
            mdl_id = (u.get("model") or "").strip()
            mdl_name = _resolve_model_name(u, user_token, mdl_id) if mdl_id else "未设置"
            model_line = f"（当前默认模型：{mdl_name}）\n"
        except Exception:
            model_line = "（当前默认模型：未知）\n"
    return (
        f"{model_line}"
        "📋 主菜单：\n"
        "1. 新建聊天（直接输入内容也等同 1）\n"
        "2. 展示历史对话（输入数字即可进入）\n"
        "3. 选择模型开始新对话（输入数字即可进入）\n"
        "4. 修改会话标题（输入数字即可进入）\n"
        "5. 查看操作指南\n"
        "（在任意界面，仅输入“取消”或“返回”可回到主菜单）"
    )
GUIDE_TEXT = (
    "🧭 操作指南\n"
    "• 第一次使用：发送 “绑定<API Key>” 或 “绑定 sk-xxx”\n"
    "• 新建聊天：回主菜单发 1，或直接输入内容\n"
    "• 历史对话：发 2 → 选编号 → 自动切入并显示最近10条\n"
    "• 切换模型：发 3 → 选编号 → 用该模型开启新对话\n"
    "• 修改标题：发 4 → 选对话 → 输入新标题 → 确认保存\n"
    "• 返回上一级：任意界面仅输入“取消/返回”\n"
    "• 说明：若回答含图片，会即时把图片发到微信；历史预览中图片用【图片】占位。"
)
def _ensure_binded(u: Dict[str, Any]) -> Optional[str]:
    if not (u.get("token") or "").strip():
        return "请先发送：绑定<Open WebUI 的 API Key>（支持：绑定<key> 或 绑定 sk-xxx）"
    return None
# --------------------------- KF 同步 ---------------------------
def kf_sync_by_token(event_token: str, open_kfid: Optional[str] = None,
                     limit: int = 1000, max_pages: int = 10) -> List[Dict[str, Any]]:
    access = get_kf_access_token()
    url = "https://qyapi.weixin.qq.com/cgi-bin/kf/sync_msg"
    cursor = ""
    pulled: List[Dict[str, Any]] = []
    pages = 0
    while pages < max_pages:
        body: Dict[str, Any] = {"token": event_token, "limit": max(1, min(1000, limit))}
        if cursor:
            body["cursor"] = cursor
        if open_kfid:
            body["open_kfid"] = open_kfid
        r = requests.post(url, params={"access_token": access}, json=body, timeout=10)
        if not r.ok:
            log.error("kf/sync_msg http %s: %s", r.status_code, (r.text or "")[:200])
            break
        js = r.json() or {}
        msgs = js.get("msg_list") or []
        if isinstance(msgs, list):
            pulled.extend(msgs)
        has_more = int(js.get("has_more") or 0)
        cursor = js.get("next_cursor") or ""
        pages += 1
        if not has_more or not cursor:
            break
    log.info("[KF SYNC] pulled %s msgs", len(pulled))
    return pulled
# --------------------------- Command ---------------------------
def _get_latest_chat_image_url(user_token: str, chat_id: str) -> Optional[str]:
    if not (user_token and chat_id):
        return None
    try:
        js = owui_fetch_chat(user_token, chat_id)
        msgs: List[Dict[str, Any]] = []
        chat_obj = (js.get("chat") or {}) if isinstance(js, dict) else {}
        if isinstance(chat_obj.get("messages"), list):
            msgs = chat_obj["messages"]
        elif isinstance(js, dict) and isinstance(js.get("messages"), list):
            msgs = js["messages"]
        else:
            hist = (chat_obj.get("history") or {}).get("messages") or {}
            if isinstance(hist, dict):
                msgs = list(hist.values())
        msgs = sorted(msgs, key=lambda m: float(m.get("timestamp") or 0), reverse=True)
        for m in msgs:
            if (m.get("role") == "user") and isinstance(m.get("images"), list) and m["images"]:
                return str(m["images"][0])
    except Exception as e:
        log.debug("latest image lookup failed: %s", e)
    return None
def _compose_user_content_consuming(u: Dict[str, Any], text: str) -> Any:
    user_tok = (u.get("token") or "").strip()
    chat_id = (u.get("current_chat_id") or "").strip()
    img = _get_latest_chat_image_url(user_tok, chat_id) if (user_tok and chat_id) else None
    if not img:
        img = _get_last_image_if_fresh(u)
        if img:
            # 只在使用 last_image 时才消费清空
            u["last_image"] = ""
            u["last_image_ts"] = 0.0
    if img:
        return [
            {"type": "image_url", "image_url": {"url": img}},
            {"type": "text", "text": text},
        ]
    return text

def handle_command(ext_uid: str, text: str) -> str:
    text = (text or "").strip()
    if not text:
        return "（请发送文字，或先发一张图片）"
    store = _load_store()
    u = _user(store, ext_uid)
    log.info("[cmd] ext_uid=%s state=%s text=%r", ext_uid, u.get("state"), text[:100])
    if text in ("返回", "取消"):
        prev = u.get("state")
        u["state"] = "MENU"
        u["current_chat_id"] = ""
        u["cache"] = {}
        _save_store(store)
        log.info("[state] %s -> MENU", prev)
        return _main_menu_text(u.get("token") or None, u)
    m = re.match(r"^绑定\s*(\S+)$", text)
    if m:
        u["token"] = m.group(1).strip()
        u["current_chat_id"] = ""
        u["state"] = "MENU"
        _save_store(store)
        log.info("[bind] ext_uid=%s token=%s", ext_uid, _mask(u['token']))
        return "✅ 已绑定。\n" + _main_menu_text(u["token"], u)
    need = _ensure_binded(u)
    if need:
        return need
    token: str = u["token"]
    state = u.get("state", "MENU")
    session_id = (u.get("session_id") or "").strip() or uuid.uuid4().hex
    if text in ("帮助", "help", "/help", "操作指南", "指南"):
        return GUIDE_TEXT
    if state == "MENU":
        if text == "5":
            return GUIDE_TEXT
        if text == "2":
            try:
                chats = owui_list_chats(token, limit=100)
                log.info("list chats got %s items (pinned first)", len(chats))
            except Exception as e:
                log.exception("list chats error")
                return f"获取历史对话失败：{e}"
            if not chats:
                return "（暂无历史对话）\n" + _main_menu_text(token, u)
            u["state"] = "PICK_CHAT"
            u["cache"]["chats"] = chats
            _save_store(store)
            lines = [f"历史对话（置顶优先，输入数字进入）："]
            for i, c in enumerate(chats, 1):
                pin = "📌 " if c.get("pinned") else ""
                title = (c.get("title") or "").strip() or c.get("id")
                lines.append(f"{i}. {pin}{title}")
            lines.append("\n发送编号进入；发送“取消/返回”回主菜单。")
            return "\n".join(lines)
        elif text == "3":
            try:
                models = owui_models(token)[:200]
            except Exception as e:
                log.exception("models error")
                return f"获取模型失败：{e}"
            if not models:
                return "后端未返回任何模型，请在 OpenWebUI 检查 Provider/Model。"
            u["state"] = "PICK_MODEL"
            u["cache"]["models"] = models
            _save_store(store)
            lines = ["可用模型（输入数字选择）："]
            for i, it in enumerate(models, 1):
                lines.append(f"{i}. {it['name']}")
            lines.append("\n发送编号选择；发送“取消/返回”回主菜单。")
            return "\n".join(lines)
        elif text == "4":
            try:
                chats = owui_list_chats(token, limit=100)
            except Exception as e:
                log.exception("list chats error (rename)")
                return f"获取历史对话失败：{e}"
            if not chats:
                return "（暂无可修改的对话）\n" + _main_menu_text(token, u)
            u["state"] = "RENAME_PICK"
            u["cache"]["chats"] = chats
            _save_store(store)
            lines = ["选择要修改标题的对话（输入数字）："]
            for i, c in enumerate(chats, 1):
                pin = "📌 " if c.get("pinned") else ""
                title = (c.get("title") or "").strip() or c.get("id")
                lines.append(f"{i}. {pin}{title}")
            lines.append("\n发送编号选择；发送“取消/返回”回主菜单。")
            return "\n".join(lines)
        elif text == "1" or text == "":
            prev = u.get("state")
            u["state"] = "IN_CHAT"
            u["current_chat_id"] = ""
            _save_store(store)
            log.info("[state] %s -> IN_CHAT (new blank)", prev)
            return "已进入新对话。直接发送你的问题吧～（发送“取消/返回”回主菜单）"
        else:
            # 一句话建新房间：创建 -> 只追加“用户消息” -> 调用完成（不轮询）
            u["state"] = "IN_CHAT"
            u["current_chat_id"] = ""
            _save_store(store)
            mdl = (u.get("model") or DEFAULT_MODEL or "").strip()
            if not mdl:
                return "未设置默认模型。请先发 3 选择模型。"
            try:
                new_cid, _, _ = owui_create_new_chat_form(token, title=_build_fixed_room_title(text), models=[mdl])
                # ✅ 立刻写入当前会话，避免后续消息又新建房间
                u["current_chat_id"] = new_cid or ""
                _save_store(store)
                user_content = _compose_user_content_consuming(u, text)
                user_mid = owui_append_user_message(token, new_cid, mdl, user_content)
                # 先给微信一个“已收到，正在生成”的立即反馈
                try:
                    send_kf_text(ext_uid, "⌛ 已收到请求，正在生成解答…")
                except Exception:
                    pass
                messages_for_llm = _build_messages_for_completion(token, new_cid)
                assistant_mid_seed = None
                try:
                    if OWUI_FORCE_ASSISTANT_PLACEHOLDER_WHEN_EMPTY:
                        _placeholder_text = "" if not OWUI_FORCE_ASSISTANT_PLACEHOLDER_WHEN_EMPTY else ""
                    else:
                        _placeholder_text = ""
                    assistant_mid_seed = owui_append_assistant_message(token, new_cid, mdl, _placeholder_text, [], parent_id=user_mid)
                    log.info("placeholder seeded (new chat); no completed yet")
                    _log_chat_summary(token, new_cid, "after placeholder (new chat)")
                except Exception as _e:
                    log.warning("placeholder append/completed (new) failed: %s", _e)
                txt, imgs, created, raw = owui_chat_complete(
                    user_token=token, messages=messages_for_llm, model=mdl,
                    chat_id=new_cid, assistant_id=assistant_mid_seed, session_id=session_id,
                    poll=True,   # FIXED: enable polling
                    user_id=user_mid
                )
                cid = created or new_cid
                if cid and cid != u.get("current_chat_id"):
                    u["current_chat_id"] = cid
                    _save_store(store)
                if (txt.strip() or imgs):
                    ok = owui_completed_save(token, cid, user_mid, assistant_mid_seed or None, user_content, ("" if _is_placeholder_text(txt) or not txt else txt), imgs,
                        model=mdl, session_id=session_id
                    )
                    if ok and assistant_mid_seed:
                        _try_completed(token, {"chat_id": cid, "id": assistant_mid_seed, "session_id": session_id, "model": mdl})
                    if not ok:
                        log.error("failed to persist completion to history (cid=%s)", cid)
                if not txt.strip() and imgs:
                    txt = "✅ 已生成图片（见上图）"
                elif not txt.strip():
                    txt = "（模型生成中或无输出）"
                for url in imgs[:4]:
                    send_kf_image_by_url(ext_uid, url, token)
                return txt
            except Exception as e:
                if _is_model_not_found_error(e):
                    picked = _pick_first_available_model(token)
                    if picked:
                        u["model"] = picked;
                        _save_store(store)
                        return "默认模型不可用，请发 3 重新选择。"
                    return "默认模型不可用，且无法自动选择。请发 3 选择模型。"
                log.exception("chat new error")
                return f"生成失败：{e}"
    if state == "PICK_CHAT":
        if re.fullmatch(r"[1-9]\d*", text):
            idx = int(text) - 1
            chats = u.get("cache", {}).get("chats") or []
            if 0 <= idx < len(chats):
                picked = chats[idx]
                chat_id = picked.get("id")
                title = picked.get("title") or chat_id
                prev = u.get("state")
                u["state"] = "IN_CHAT"
                u["current_chat_id"] = chat_id
                _save_store(store)
                log.info("[state] %s -> IN_CHAT (chat_id=%s title=%r)", prev, chat_id, title)
                history_lines: List[str] = []
                try:
                    js = owui_fetch_chat(token, chat_id)
                    msgs: List[Dict[str, Any]] = []
                    chat_obj = (js.get("chat") or {}) if isinstance(js, dict) else {}
                    if isinstance(chat_obj.get("messages"), list):
                        msgs = chat_obj["messages"]
                    elif isinstance(js, dict) and isinstance(js.get("messages"), list):
                        msgs = js["messages"]
                    else:
                        hist = (chat_obj.get("history") or {}).get("messages") or {}
                        if isinstance(hist, dict):
                            msgs = list(hist.values())
                    msgs = sorted(msgs, key=lambda m: float(m.get("timestamp") or 0))[-10:]
                    if msgs:
                        for m in msgs:
                            role = (m.get("role") or "assistant").strip()
                            text_part = _ensure_str_content(m)
                            imgs_in = _extract_images_from_msgobj(m, text_part)
                            who = "你" if role == "user" else "助手"
                            if text_part:
                                brief = (_strip_images_placeholder(text_part))[:277]
                                if len(text_part) > 280: brief += "..."
                            else:
                                brief = "【图片】" if imgs_in else "（空）"
                            history_lines.append(f"• {who}: {brief}")
                    else:
                        history_lines.append("（无历史消息）")
                except Exception as e:
                    log.warning("fetch history error: %s", e)
                    history_lines.append("（历史接口不可用或无消息）")
                return f"✅ 已切换到对话：{title}\n最近 10 条：\n" + "\n".join(
                    history_lines) + "\n\n现在直接回复即可继续该对话；发送“取消/返回”回主菜单。"
            return "编号无效，请重新选择；或发送“取消/返回”。"
        return "请直接发送编号选择对话；或发送“取消/返回”。"
    if state == "PICK_MODEL":
        if re.fullmatch(r"[1-9]\d*", text):
            idx = int(text) - 1
            models = u.get("cache", {}).get("models") or []
            if 0 <= idx < len(models):
                mdl_obj = models[idx]
                mdl_id = mdl_obj["id"]
                mdl_name = mdl_obj["name"]
                u["model"] = mdl_id
                pending_chat_id = u.get("cache", {}).get("pending_chat_id", "")
                if pending_chat_id:
                    prev = u.get("state")
                    u["state"] = "IN_CHAT"
                    u["current_chat_id"] = pending_chat_id
                    u["cache"]["pending_chat_id"] = ""
                    _save_store(store)
                    log.info("[state] %s -> IN_CHAT (resume chat_id=%s model=%s)", prev, pending_chat_id, mdl_id)
                    return f"✅ 已切换到模型：{mdl_name}\n现在继续该对话即可。（“取消/返回”回主菜单）"
                else:
                    prev = u.get("state")
                    u["state"] = "IN_CHAT"
                    u["current_chat_id"] = ""
                    _save_store(store)
                    log.info("[state] %s -> IN_CHAT (new chat, model=%s)", prev, mdl_id)
                    return f"✅ 已切换到模型：{mdl_name}\n已进入新对话，直接发送你的问题吧。（“取消/返回”回主菜单）"
            lines = ["编号无效，请重新选择："]
            for i, it in enumerate(models, 1):
                lines.append(f"{i}. {it['name']}")
            lines.append("\n发送编号选择；发送“取消/返回”回主菜单。")
            return "\n".join(lines)
        return "请直接发送编号选择模型；或发送“取消/返回”。"
    if state == "RENAME_PICK":
        if re.fullmatch(r"[1-9]\d*", text):
            idx = int(text) - 1
            chats = u.get("cache", {}).get("chats") or []
            if 0 <= idx < len(chats):
                picked = chats[idx]
                u["cache"]["rename_chat_id"] = picked.get("id")
                u["cache"]["rename_old_title"] = (picked.get("title") or picked.get("id"))
                u["state"] = "RENAME_TITLE"
                _save_store(store)
                return f"请输入新的对话标题（原：{u['cache']['rename_old_title']}）。\n发送“取消/返回”可放弃。"
            return "编号无效，请重新选择；或发送“取消/返回”。"
        return "请直接发送编号选择要修改的对话；或发送“取消/返回”。"
    if state == "RENAME_TITLE":
        if not text:
            return "标题不能为空，请重新输入；或发送“取消/返回”。"
        u["cache"]["rename_new_title"] = text
        u["state"] = "RENAME_CONFIRM"
        _save_store(store)
        old_t = u["cache"].get("rename_old_title", "")
        return f"确认保存吗？\n原：{old_t}\n新：{text}\n回复“保存/是”确认；或“取消/返回”放弃。"
    if state == "RENAME_CONFIRM":
        if text in ("保存", "是", "Y", "y", "确认", "OK", "ok"):
            cid = u["cache"].get("rename_chat_id", "")
            nt = u["cache"].get("rename_new_title", "").strip()
            if not cid or not nt:
                u["state"] = "MENU";
                _save_store(store)
                return "数据异常，已返回主菜单。"
            try:
                owui_update_chat_form(token, {"id": cid, "title": nt})
            except Exception as e:
                if "401" in str(e):
                    return "保存失败：权限不足（该会话不属于当前 API Key）。请在 WebUI 下同一账号使用，或先用当前 Key 新建会话。"
                return f"保存失败：{e}"
            u["state"] = "MENU";
            _save_store(store)
            return "✅ 已保存。\n（输入“返回/取消”回主菜单）"
        else:
            u["state"] = "MENU";
            _save_store(store)
            return "已放弃修改。\n（输入“返回/取消”回主菜单）"
    if state == "IN_CHAT":
        if not text:
            return "请输入要发送的内容；或“取消/返回”回主菜单。"
        chat_id = (u.get("current_chat_id") or "").strip()
        try:
            if chat_id:
                mdl = (u.get("model") or DEFAULT_MODEL or "").strip()
                user_content = _compose_user_content_consuming(u, text)
                try:
                    # ❗ 改为只追加“用户消息”，不追加助手占位
                    user_mid = owui_append_user_message(token, chat_id, mdl, user_content)
                except Exception as e:
                    if _is_http_status(e, 401) or _is_http_status(e, 404):
                        log.warning("append to chat(%s) unauthorized/not found, creating new chat...", chat_id)
                        new_cid, _, _ = owui_create_new_chat_form(token, title=_build_fixed_room_title(text), models=[mdl] if mdl else None)
                        if not new_cid:
                            raise
                        user_mid = owui_append_user_message(token, new_cid, mdl, user_content)
                        u["current_chat_id"] = new_cid;
                        _save_store(store)
                        chat_id = new_cid
                    else:
                        raise
                # 立即回执
                try:
                    send_kf_text(ext_uid, "⌛ 已收到请求，正在生成解答…")
                except Exception:
                    pass
                messages_for_llm = _build_messages_for_completion(token, chat_id)
                # --- Scheme A: assistant placeholder, immediately completed ---
                try:
                    if OWUI_FORCE_ASSISTANT_PLACEHOLDER_WHEN_EMPTY:
                        _placeholder_text = "" if not OWUI_FORCE_ASSISTANT_PLACEHOLDER_WHEN_EMPTY else ""
                    else:
                        _placeholder_text = ""
                    assistant_mid_seed = owui_append_assistant_message(token, chat_id, mdl, _placeholder_text, [], parent_id=user_mid)
                    log.info("placeholder seeded; no completed yet")
                    _log_chat_summary(token, chat_id, "after placeholder")
                except Exception as _e:
                    log.warning("placeholder append/completed failed: %s", _e)
                try:
                    txt, imgs, _, _ = owui_chat_complete(
                        user_token=token, messages=messages_for_llm, chat_id=chat_id,
                        model=mdl, assistant_id=assistant_mid_seed, session_id=session_id,
                        poll=True,   # FIXED: enable polling
                        user_id=user_mid
                    )
                except Exception as e:
                    if _is_model_not_found_error(e):
                        picked = _pick_first_available_model(token)
                        if picked:
                            u["model"] = picked;
                            _save_store(store)
                            _apply_chat_model(token, chat_id, picked)
                            txt, imgs, _, _ = owui_chat_complete(
                                user_token=token, messages=messages_for_llm, chat_id=chat_id,
                                model=picked, assistant_id=None, session_id=session_id,
                                poll=True,   # FIXED: enable polling
                                user_id=user_mid
                            )
                        else:
                            raise
                    else:
                        raise
                if (txt.strip() or imgs):
                    owui_completed_save(token, chat_id, user_mid, assistant_mid_seed or None, user_content, ("" if _is_placeholder_text(txt) or not txt else txt), imgs,
                        model=mdl, session_id=session_id
                    )
                if not txt.strip() and imgs:
                    txt = "✅ 已生成图片（见上图）"
                elif not txt.strip():
                    txt = "（模型生成中或无输出）"
                for url in imgs[:4]:
                    send_kf_image_by_url(ext_uid, url, token)
                return txt
            else:
                mdl = (u.get("model") or DEFAULT_MODEL or "").strip()
                if not mdl:
                    return "未设置默认模型。请先发 3 选择模型。"
                new_cid, _, _ = owui_create_new_chat_form(token, title=_build_fixed_room_title(text), models=[mdl])
                # ✅ 一创建就保存为当前会话
                u["current_chat_id"] = new_cid or ""
                _save_store(store)
                user_content = _compose_user_content_consuming(u, text)
                user_mid = owui_append_user_message(token, new_cid, mdl, user_content)
                # 回执
                try:
                    send_kf_text(ext_uid, "⌛ 已收到请求，正在生成解答…")
                except Exception:
                    pass
                messages_for_llm = _build_messages_for_completion(token, new_cid)
                assistant_mid_seed = None
                try:
                    txt, imgs, created, _ = owui_chat_complete(
                        user_token=token, messages=messages_for_llm, model=mdl,
                        chat_id=new_cid, assistant_id=assistant_mid_seed, session_id=session_id,
                        poll=True,   # FIXED: enable polling
                        user_id=user_mid
                    )
                except Exception as e:
                    if _is_model_not_found_error(e):
                        picked = _pick_first_available_model(token)
                        if picked:
                            u["model"] = picked;
                            _save_store(store)
                            _apply_chat_model(token, new_cid, picked)
                            txt, imgs, created, _ = owui_chat_complete(
                                user_token=token, messages=messages_for_llm, model=picked,
                                chat_id=new_cid, assistant_id=None, session_id=session_id,
                                poll=True,   # FIXED: enable polling
                                user_id=user_mid
                            )
                        else:
                            raise
                    else:
                        raise
                cid = created or new_cid
                if cid:
                    u["current_chat_id"] = cid;
                    _save_store(store)
                    if (txt.strip() or imgs):
                        owui_completed_save(token, cid, user_mid, assistant_mid_seed or None, user_content, ("" if _is_placeholder_text(txt) or not txt else txt), imgs,
                            model=mdl, session_id=session_id
                        )
                if not txt.strip() and imgs:
                    txt = "✅ 已生成图片（见上图）"
                elif not txt.strip():
                    txt = "（模型生成中或无输出）"
                for url in imgs[:4]:
                    send_kf_image_by_url(ext_uid, url, token)
                return txt
        except Exception as e:
            if chat_id and _is_model_not_found_error(e):
                try:
                    picked = _pick_first_available_model(token)
                    if picked:
                        u["model"] = picked;
                        _save_store(store)
                        _apply_chat_model(token, chat_id, picked)
                        return f"该会话原模型不可用，已切换为：{picked}，请重试。"
                    else:
                        return "该会话原模型不可用，且无法自动选择。请发“返回”回主菜单。"
                except Exception as e2:
                    log.exception("models error while chat_id recovery")
                    return f"该会话原模型不可用，且获取模型失败：{e2}\n请发“返回”回主菜单。"
            if not chat_id and _is_model_not_found_error(e):
                picked = _pick_first_available_model(token)
                if picked:
                    u["model"] = picked;
                    _save_store(store)
                    return f"（默认模型不可用，已自动切换为：{picked}）请重试。"
                return "默认模型不可用，且无法自动选择。请发 3 选择模型。"
            log.exception("chat in_chat error")
            return f"生成失败：{e}"
    u["state"] = "MENU";
    _save_store(store)
    return _main_menu_text(token, u)
# ------------------------- KF 回调处理 -------------------------
def _auto_process_incoming_image(ext_uid: str, data_url: str):
    """
    【修复版】
    收到图片后“不再创建/写入 WebUI 会话”，仅：
      1) 缓存为 recent last_image（供下一条文字合并）
      2) 立即回微信引导语（该文本若遇 95001 将入队重投）
    """
    store = _load_store()
    u = _user(store, ext_uid)
    need = _ensure_binded(u)
    if need:
        send_kf_text(ext_uid, need)  # 未绑定时直接提示（具备 outbox 重投）
        return
    try:
        _set_last_image(ext_uid, data_url)
    except Exception:
        pass
    send_kf_text(ext_uid, "🖼️ 已收到图片。请描述要如何处理（如：把衣服改成红色、去除背景等）。")
@app.get("/wecom/kf/callback")
async def kf_verify(msg_signature: str, timestamp: str, nonce: str, echostr: str):
    plain = crypto.check_signature(msg_signature, timestamp, nonce, echostr)
    return Response(content=plain, media_type="text/plain")
@app.post("/wecom/kf/callback")
async def kf_incoming(request: Request, msg_signature: str, timestamp: str, nonce: str):
    raw = await request.body()
    xml = crypto.decrypt_message(raw.decode(), msg_signature, timestamp, nonce)
    msg = parse_message(xml)
    event_token = getattr(msg, "token", None) or _extract_token_from_xml(xml)
    if not event_token:
        log.warning("unexpected msg (no event token), raw=%s", xml[:300])
        return Response(content="success", media_type="text/plain")
    open_kfid_from_event = _extract_open_kfid_from_xml(xml)
    def _worker():
        try:
            _gc_seen()
            batch = kf_sync_by_token(event_token, open_kfid=open_kfid_from_event or (OPEN_KFID or None))
            last_text: Dict[str, Tuple[str, str]] = {}
            # —— 修复：把“图片”也带上 msgid，一并持久去重
            new_images_by_user: Dict[str, Tuple[str, str]] = {}  # ext_uid -> (msgid, data_url)
            for m in batch:
                msgid = (m.get("msgid") or "").strip()
                if not msgid or _seen_has(msgid) or SEEN_MSGIDS.get(msgid):
                    continue
                # 丢弃启动窗口前的历史消息（避免重放）
                mt = int(m.get("send_time") or m.get("msgtime") or m.get("create_time") or 0)
                if mt and mt < (BOOT_TS - KF_DROP_OLD_MSGS_SEC):
                    _seen_add(msgid)  # ✅ 持久记录
                    SEEN_MSGIDS[msgid] = time.time() + SEEN_TTL
                    continue
                ext_uid = (m.get("external_userid") or m.get("openid") or m.get("from") or "").strip()
                if not ext_uid:
                    _seen_add(msgid);
                    SEEN_MSGIDS[msgid] = time.time() + SEEN_TTL
                    continue
                mtype = (m.get("msgtype") or "").strip()
                if mtype == "text":
                    content = ((m.get("text") or {}).get("content") or "").strip()
                    if content:
                        last_text[ext_uid] = (msgid, content)
                elif mtype == "image":
                    media_id = ((m.get("image") or {}).get("media_id") or "").strip()
                    if media_id:
                        data_url = _kf_download_image_data_url(media_id) or ""
                        if data_url:
                            new_images_by_user[ext_uid] = (msgid, data_url)
                # 先把本轮都记入临时已见（防止本次循环重复）
                SEEN_MSGIDS[msgid] = time.time() + SEEN_TTL
            if not last_text and not new_images_by_user:
                return
            # 1) 先处理所有“带图片的用户”：仅缓存最近图片 + 引导语
            for ext_uid, (img_mid, data_url) in new_images_by_user.items():
                _auto_process_incoming_image(ext_uid, data_url)
                _seen_add(img_mid)  # ✅ 持久去重，重启后不会再触发
            # 2) 再处理文字（这时最近图片已缓存，下一条文字会和图片合并送给模型）
            for ext_uid, (txt_mid, content) in last_text.items():
                content = (content or "").strip()
                if not content:
                    _seen_add(txt_mid)
                    continue
                try:
                    reply = handle_command(ext_uid, content)
                except Exception as e:
                    log.exception("handle_command error")
                    reply = f"处理失败：{e}"
                _seen_add(txt_mid)  # ✅ 文字也持久去重
                if reply.strip() in ("✅ 已生成图片（见上图）", "（模型生成中或无输出）", "") or _is_placeholder_text(reply):
                    continue
                (
                None if _is_placeholder_text(reply) else send_kf_text(ext_uid, reply)
            ) if not _is_placeholder_text(reply) else True
        except Exception:
            log.exception("kf worker error")
    threading.Thread(target=_worker, daemon=True).start()
    return Response(content="success", media_type="text/plain")
# --------------------------- Debug endpoints --------------------
@app.get("/debug/state")
def debug_state(ext_uid: Optional[str] = None):
    store = _load_store()
    if not ext_uid or ext_uid not in store:
        return {"ok": False, "error": "missing or unknown ext_uid"}
    u = dict(store[ext_uid])
    if u.get("token"): u["token"] = _mask(u["token"])
    return {"ok": True, "user": u}
@app.get("/debug/ping-openwebui")
def debug_ping_openwebui(ext_uid: Optional[str] = None, token: Optional[str] = None):
    try:
        if not token and ext_uid:
            store = _load_store()
            u = store.get(ext_uid) or {}
            user_token= u.get("token")
        if not token:
            return {"ok": False, "error": "no token provided"}
        ms = owui_models(token)
        first = ms[0] if ms else None
        cid, u_mid, a_mid = owui_create_new_chat_form(token, title=_build_fixed_room_title("API创建"), models=[first["id"]] if first else [])
        return {"ok": True, "models_count": len(ms), "first_model": first, "new_chat_id": cid, "user_mid": u_mid,
                "assistant_mid": a_mid}
    except Exception as e:
        return {"ok": False, "error": str(e)}
@app.get("/debug/ratelimit")
def debug_ratelimit():
    now = time.time()
    view = {k: max(0, int(v - now)) for k, v in RATE_LIMIT_UNTIL.items() if v > now}
    return {"ok": True, "cooldown_left_sec": view}
@app.get("/healthz")
def healthz():
    return {"ok": True}
# —— 启动 outbox worker
_outbox_start_once()


def owui_overwrite_assistant_message(user_token: str, chat_id: str, assistant_id: str,
                                     text: str, images: list[str], model: str,
                                     parent_id: str | None = None, session_id: str = "") -> None:
    # Fetch chat
    js = owui_fetch_chat(user_token, chat_id)
    chat = (js.get("chat") or js or {})
    messages = list(chat.get("messages") or [])
    history = chat.get("history") or {"current_id": None, "messages": {}}
    hist_msgs = dict(history.get("messages") or {})
    final_parts = _mk_content_parts(text, images)
    found = False
    for it in messages:
        if isinstance(it, dict) and str(it.get("id")) == str(assistant_id) and it.get("role") == "assistant":
            it["content"] = final_parts
            if parent_id:
                it["parentId"] = parent_id
            it["modelName"] = model
            found = True
            break
    if assistant_id in hist_msgs and isinstance(hist_msgs[assistant_id], dict):
        hist_msgs[assistant_id]["content"] = final_parts
        if parent_id:
            hist_msgs[assistant_id]["parentId"] = parent_id
        hist_msgs[assistant_id]["modelName"] = model
        found = True
    if not found:
        new_assistant = {"id": assistant_id, "role":"assistant", "content": final_parts,
                         "parentId": parent_id, "modelName": model, "modelIdx": 0, "timestamp": int(time.time()*1000)}
        messages.append(new_assistant)
        hist_msgs[assistant_id] = new_assistant
    history["current_id"] = assistant_id
    payload = {"chat": {"id": chat_id, "messages": messages, "history": {"current_id": assistant_id, "messages": hist_msgs}}}
    r = _owui_req("POST", f"/api/v1/chats/{chat_id}", user_token, headers={"Content-Type":"application/json"}, json=payload)
    if not r.ok:
        raise _improve_http_error(r, "覆盖助手成品失败(/api/v1/chats/{id})")
    # Completed close
    try:
        comp_body = {"chat_id": chat_id, "id": assistant_id, "session_id": session_id, "model": model}
        r2 = _owui_req("POST", "/api/chat/completed", user_token, headers={"Content-Type":"application/json"}, json=comp_body)
        if r2.ok:
            log.info("OWUI POST /api/chat/completed -> %s (%s)", r2.status_code, r2.reason)
        else:
            log.warning("chat/completed non-200: %s %s", r2.status_code, r2.reason)
    except Exception as e:
        log.warning("chat/completed failed: %s", e)




def _poll_until_final(user_token: str, chat_id: str, assistant_id: str, timeout_sec: float = 30.0, interval_sec: float = 0.6) -> tuple[str, list[str]]:
    import time as _t
    t0 = _t.time()
    last_txt = ""
    imgs: list[str] = []
    while _t.time() - t0 <= timeout_sec:
        r = _owui_req("GET", f"/api/v1/chats/{chat_id}?refresh=1", user_token)
        if not r.ok:
            _t.sleep(interval_sec); 
            continue
        js = r.json() if 'application/json' in (r.headers.get('Content-Type') or '') else {}
        chat = js.get("chat") or js or {}
        msgs = list(chat.get("messages") or [])
        for m in msgs[::-1]:
            if isinstance(m, dict) and str(m.get("id")) == str(assistant_id) and m.get("role") == "assistant":
                txt = ""
                c = m.get("content")
                if isinstance(c, list):
                    for p in c:
                        if isinstance(p, dict) and p.get("type") == "text" and p.get("text"):
                            txt += str(p["text"])
                elif isinstance(c, str):
                    txt = c
                imgs = _extract_all_images_from_msg(m, txt)
                if txt.strip() and not _is_placeholder_text(txt):
                    log.info("complete(polled): text_len=%s preview=%r imgs=%s", len(txt), txt[:60], len(imgs))
                    return txt, imgs
                last_txt = txt or last_txt
                break
        _t.sleep(interval_sec)
    return last_txt.strip(), imgs



# ====== APPENDED PATCH: CI block for OWUI /tasks endpoints ======
try:
    _ORIG__OWUI_REQ = _owui_req  # keep original
except NameError:
    _ORIG__OWUI_REQ = None

def _owui_req(method: str, path: str, token: str, **kwargs):
    """
    Patched OWUI request helper:
    - force JSON Accept header
    - HARD BLOCK any legacy /tasks endpoints (case-insensitive)
    """
    _p = str(path)
    _pl = _p.lower()
    if ("tasks" in _pl) or ("disabled-tasks" in _pl) or ("tasks_disabled" in _pl):
        try:
            log.error("HARD BLOCK: attempted to call %s", _p)
        except Exception:
            pass
        raise RuntimeError(f"OWUI /tasks endpoints are disabled: {path}")

    headers = kwargs.pop("headers", {}) or {}
    headers.setdefault("Accept", "application/json")
    kwargs["headers"] = headers

    if _ORIG__OWUI_REQ is not None:
        return _ORIG__OWUI_REQ(method, path, token, **kwargs)

    # Fallback if original is not available:
    import requests
    base = OWUI_BASE.rstrip("/")
    url = f"{base}{path}"
    return requests.request(method.upper(), url, **kwargs)

# Disable any task-based pollers if defined earlier:
def _poll_task_result(*args, **kwargs):
    raise RuntimeError("poll_task_result disabled; use chat polling via /api/v1/chats/{chat_id} only")
# ====== END PATCH ======
# >>> _PLACEHOLDER_GUARD >>>

PLACEHOLDER_TEXTS = {
    "（后台生成中…）",
    "（处理中，请稍候…）",
    "（模型生成中或无输出）",
    "（模型生成完成，但无文本输出）",
    "⌛ 已收到请求，正在生成解答…",
    "",
}
def _is_placeholder_text(s: str) -> bool:
    try:
        t = (s or "").strip()
    except Exception:
        return True
    if t in PLACEHOLDER_TEXTS:
        return True
    t_norm = t.replace("(", "（").replace(")", "）").replace("...", "…")
    if "后台生成中" in t_norm or "处理中" in t_norm:
        return True
    return False

# <<< _PLACEHOLDER_GUARD <<<

# >>> _POLL_OVERRIDE >>>

from typing import Optional, Tuple, List, Dict, Any
def _poll_assistant_content(
    user_token: str,
    chat_id: str,
    assistant_mid: Optional[str] = None,
    timeout_sec: float = 20.0,
    interval_sec: float = 0.7,
    **kwargs  # swallow unknown kw like user_mid
) -> Tuple[str, List[str]]:
    """
    Poll only /api/v1/chats/{chat_id}; if assistant_mid is None, target the latest assistant.
    Treat placeholder/empty text without images as "not ready"; continue polling.
    """
    def _latest_assistant_id(js: Dict[str, Any]) -> Optional[str]:
        msgs = []
        if isinstance(js, dict):
            if isinstance(js.get("messages"), list):
                msgs = js["messages"]
            else:
                hist = ((js.get("chat") or {}).get("history") or {}).get("messages") or {}
                if isinstance(hist, dict):
                    msgs = list(hist.values())
        msgs = [m for m in msgs if isinstance(m, dict) and m.get("role") == "assistant" and m.get("id")]
        msgs.sort(key=lambda m: float(m.get("timestamp") or 0), reverse=True)
        return str(msgs[0]["id"]) if msgs else None

    import time
    t0 = time.time()
    last_err = None
    while (time.time() - t0) < float(timeout_sec):
        try:
            js = owui_fetch_chat(user_token, chat_id)
            target_id = assistant_mid or _latest_assistant_id(js)
            if not target_id:
                time.sleep(float(interval_sec)); continue
            # gather messages
            msgs = []
            if isinstance(js, dict) and isinstance(js.get("messages"), list):
                msgs = js["messages"]
            if not msgs and isinstance(js, dict):
                hist = ((js.get("chat") or {}).get("history") or {}).get("messages") or {}
                if isinstance(hist, dict):
                    msgs = list(hist.values())
            for m in msgs:
                if (m.get("role") == "assistant") and (str(m.get("id")) == str(target_id)):
                    txt = _ensure_str_content(m).strip()
                    imgs = _extract_images_from_msgobj(m, txt)
                    if (not imgs) and _is_placeholder_text(txt):
                        break
                    if txt or imgs:
                        return txt, imgs
        except Exception as e:
            last_err = e
            try:
                log.debug("poll chat error: %s", e)
            except Exception:
                pass
        time.sleep(float(interval_sec))

    if last_err:
        try: log.debug("poll timeout last_err=%s", last_err)
        except Exception: pass

    # one last attempt
    try:
        js = owui_fetch_chat(user_token, chat_id)
        target_id = assistant_mid or _latest_assistant_id(js)
        if target_id:
            msgs = []
            if isinstance(js, dict) and isinstance(js.get("messages"), list):
                msgs = js["messages"]
            else:
                hist = ((js.get("chat") or {}).get("history") or {}).get("messages") or {}
                if isinstance(hist, dict):
                    msgs = list(hist.values())
            for m in msgs:
                if (m.get("role") == "assistant") and (str(m.get("id")) == str(target_id)):
                    txt = _ensure_str_content(m).strip()
                    imgs = _extract_images_from_msgobj(m, txt)
                    return txt, imgs
    except Exception as e:
        try: log.debug("final poll read error: %s", e)
        except Exception: pass
    return "", []

# <<< _POLL_OVERRIDE <<<

# --- begin: non-intrusive fragment wrapper for send_kf_text ---
try:
    _send_kf_text_callthrough  # type: ignore[name-defined]
except NameError:
    _send_kf_text_callthrough = send_kf_text  # keep original callable

def send_kf_text(external_userid: str, content: str) -> bool:
    """
    Fragment wrapper (minimal and non-intrusive):
    - Split every 600 chars, up to 5 parts; overflow is dropped.
    - Add numbering "（i/n）- " only when n > 1 (1/1 not shown).
    - Sleep a short interval between parts to align with 91005 frequency.
    - Delegate each part to the original send_kf_text via _send_kf_text_callthrough.
    """
    import os
    import time

    s = content or ""
    # Preserve original behavior for placeholders / empty
    if not s:
        return _send_kf_text_callthrough(external_userid, s)

    # Fast path: <=600 -> call through without numbering to avoid noise
    if len(s) <= 600:
        return _send_kf_text_callthrough(external_userid, s)

    # Build up to 5 fragments, 600 chars each
    parts = []
    i, n = 0, len(s)
    while i < n and len(parts) < 5:
        j = min(n, i + 600)
        parts.append(s[i:j])
        i = j

    total = len(parts)
    delay = float(os.getenv("WECOM_FRAGMENT_DELAY_SEC", "0.9"))

    all_ok = True
    for idx, p in enumerate(parts, 1):
        msg = (f"（{idx}/{total}）- {p}" if total > 1 else p)
        ok = _send_kf_text_callthrough(external_userid, msg)
        all_ok = all_ok and ok
        # small pause between parts to avoid 91005 rate limit
        if idx < total:
            time.sleep(delay)
    return all_ok
# --- end: non-intrusive fragment wrapper for send_kf_text ---
