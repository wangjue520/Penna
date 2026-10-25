"""调大模型：OpenAI 兼容接口和 Google（Gemini / Vertex AI）接口，流式输出。

Key 只存在本机设置里，网页只发「用哪类用途」和消息，由这里补上 Key 再转发出去。
"""

import json
import re

import aiohttp

_NORMAL_FINISH = {"STOP", "MAX_TOKENS", "FINISH_REASON_UNSPECIFIED"}
_GEMINI_DEFAULT = "https://generativelanguage.googleapis.com/v1beta"


class LlmError(Exception):
    pass


def _endpoint(base, path):
    base = (base or "").strip().rstrip("/")
    for tail in ("/chat/completions", "/models"):
        if base.endswith(tail):
            base = base[: -len(tail)]
    return base + path


def _gemini_base(base):
    base = (base or "").strip().rstrip("/")
    if not base:
        return _GEMINI_DEFAULT
    if "aiplatform.googleapis.com" in base and "/publishers/" not in base:
        if re.match(r"^https?://[^/]+$", base):
            base += "/v1"
        return base + "/publishers/google"
    return base


def _split_data_url(url):
    m = re.match(r"data:([^;]+);base64,(.*)$", url, re.S)
    return (m.group(1), m.group(2)) if m else ("image/png", url)


def _openai_messages(messages, images):
    out = []
    for i, m in enumerate(messages):
        imgs = images.get(str(i)) or images.get(i) or []
        if not imgs:
            out.append(m)
            continue
        content = [{"type": "text", "text": m["content"]}] if m.get("content") else []
        content += [{"type": "image_url", "image_url": {"url": u}} for u in imgs]
        out.append({"role": m["role"], "content": content})
    return out


def _gemini_body(messages, images, temperature, top_p):
    system, contents = [], []
    for i, m in enumerate(messages):
        text = m.get("content") or ""
        imgs = images.get(str(i)) or images.get(i) or []
        if not text.strip() and not imgs:
            continue
        if m["role"] == "system":
            if text.strip():
                system.append(text)
            continue
        role = "model" if m["role"] == "assistant" else "user"
        if not contents or contents[-1]["role"] != role:
            contents.append({"role": role, "texts": [], "images": []})
        if text.strip():
            contents[-1]["texts"].append(text)
        contents[-1]["images"] += imgs
    body = {
        "contents": [
            {"role": c["role"], "parts":
                ([{"text": "\n\n".join(c["texts"])}] if c["texts"] else [])
                + [{"inlineData": dict(zip(("mimeType", "data"), _split_data_url(u)))} for u in c["images"]]}
            for c in contents
        ],
        "generationConfig": {"temperature": temperature, **({"topP": top_p} if top_p < 1 else {})},
    }
    if system:
        body["systemInstruction"] = {"parts": [{"text": "\n\n".join(system)}]}
    return body


def _error_text(status, body):
    try:
        j = json.loads(body)
        err = j.get("error", j) if isinstance(j, dict) else j
        if isinstance(err, list) and err:
            err = err[0].get("error", err[0])
        msg = err.get("message") if isinstance(err, dict) else str(err)
    except ValueError:
        msg = body.strip()[:200]
    return f"HTTP {status}：{msg or '无详情'}"


async def stream_chat(session, llm, model, messages, images, temperature, top_p):
    """逐段吐出回复文字。出错抛 LlmError。"""
    key = (llm.get("key") or "").strip()
    if llm.get("protocol") == "google":
        url = _gemini_base(llm.get("baseUrl")) + f"/models/{model}:streamGenerateContent"
        headers = {"Content-Type": "application/json"}
        if key:
            headers["x-goog-api-key"] = key
        payload = _gemini_body(messages, images, temperature, top_p)
        params = {"alt": "sse"}
    else:
        url = _endpoint(llm.get("baseUrl") or "https://api.openai.com/v1", "/chat/completions")
        headers = {"Content-Type": "application/json"}
        if key:
            headers["Authorization"] = f"Bearer {key}"
        payload = {"model": model, "messages": _openai_messages(messages, images),
                   "temperature": temperature, "stream": True}
        if top_p < 1:
            payload["top_p"] = top_p
        params = None

    async with session.post(url, json=payload, headers=headers, params=params) as resp:
        if resp.status != 200:
            raise LlmError(_error_text(resp.status, await resp.text()))
        yielded = False
        plain = []
        buf = b""
        async for chunk in resp.content.iter_any():
            buf += chunk
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    if line:
                        plain.append(line)
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    return
                try:
                    j = json.loads(data)
                except ValueError:
                    continue
                delta = _delta(j, llm.get("protocol") == "google")
                if delta:
                    yielded = True
                    yield delta
        if buf.strip():
            plain.append(buf.decode("utf-8", "replace"))
        if not yielded:
            # 有的接口无视 stream:true，直接回一整个 JSON
            try:
                j = json.loads("\n".join(plain))
                text = j["choices"][0]["message"]["content"]
            except (ValueError, KeyError, IndexError, TypeError):
                text = None
            if not text:
                raise LlmError("模型没有返回可识别的内容")
            yield text


def _delta(j, google):
    if not isinstance(j, dict):
        return None
    if j.get("error"):
        e = j["error"]
        raise LlmError(f"模型返回错误：{e.get('message') if isinstance(e, dict) else e}")
    if not google:
        try:
            return j["choices"][0]["delta"].get("content")
        except (KeyError, IndexError, TypeError, AttributeError):
            return None
    blocked = (j.get("promptFeedback") or {}).get("blockReason")
    if blocked:
        raise LlmError(f"请求被 Google 拦截：{blocked}")
    cands = j.get("candidates") or []
    if not cands:
        return None
    parts = (cands[0].get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts if isinstance(p, dict) and not p.get("thought"))
    reason = cands[0].get("finishReason")
    if not text and reason and reason not in _NORMAL_FINISH:
        raise LlmError(f"Google 中止了回复：{reason}")
    return text


async def list_models(llm):
    key = (llm.get("key") or "").strip()
    timeout = aiohttp.ClientTimeout(total=30)
    async with aiohttp.ClientSession(timeout=timeout, trust_env=True) as s:
        if llm.get("protocol") == "google":
            base = _gemini_base(llm.get("baseUrl"))
            if "aiplatform.googleapis.com" in base:
                raise LlmError("Vertex AI 不能拉取模型，请手动填模型名")
            async with s.get(base + "/models", params={"pageSize": "1000"},
                             headers={"x-goog-api-key": key} if key else {}) as r:
                body = await r.text()
                if r.status != 200:
                    raise LlmError(_error_text(r.status, body))
            j = json.loads(body)
            return [m["name"].replace("models/", "") for m in j.get("models", [])
                    if "generateContent" in m.get("supportedGenerationMethods", ["generateContent"])]
        async with s.get(_endpoint(llm.get("baseUrl") or "https://api.openai.com/v1", "/models"),
                         headers={"Authorization": f"Bearer {key}"} if key else {}) as r:
            body = await r.text()
            if r.status != 200:
                raise LlmError(_error_text(r.status, body))
        j = json.loads(body)
        data = j.get("data", j) if isinstance(j, dict) else j
        return [m["id"] for m in data if isinstance(m, dict) and isinstance(m.get("id"), str)]
