"""Penna 工作台的网址和接口，都挂在 /penna 下，不碰 ComfyUI 原有的东西。

    /penna/app/          工作台页面（浮窗里嵌的就是它，也可以单独开一个浏览器窗口）
    /penna/api/...       设置、工作台存取、模型代理、查标签、查角色、机翻
"""

import asyncio
import json
import os

import aiohttp
from aiohttp import web
from server import PromptServer

from . import penna_dict, penna_llm, penna_node, penna_store

APP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app")
_TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml"}

routes = PromptServer.instance.routes


@routes.get("/penna/app")
async def app_root(_request):
    raise web.HTTPFound("/penna/app/index.html")


@routes.get("/penna/app/{name}")
async def app_file(request):
    name = request.match_info["name"] or "index.html"
    path = os.path.normpath(os.path.join(APP_DIR, name))
    if not path.startswith(APP_DIR) or not os.path.isfile(path):
        raise web.HTTPNotFound()
    ext = os.path.splitext(path)[1]
    return web.FileResponse(path, headers={"Content-Type": f"{_TYPES.get(ext, 'application/octet-stream')}; charset=utf-8",
                                           "Cache-Control": "no-cache"})


# ---------- 设置 / 工作台 / 角色 ----------

@routes.get("/penna/api/config")
async def get_config(_request):
    return web.json_response(penna_store.public_config())


@routes.post("/penna/api/config")
async def post_config(request):
    return web.json_response(penna_store.save_config(await request.json()))


@routes.get("/penna/api/workspace")
async def get_workspace(_request):
    return web.json_response(penna_store.load_workspace())


@routes.put("/penna/api/workspace")
async def put_workspace(request):
    penna_store.save_workspace(await request.json())
    return web.json_response({"ok": True})


@routes.post("/penna/api/preview")
async def preview(request):
    """节点这次运行会输出什么：和节点用同一套拼法，节点上的预览框靠它实时更新。"""
    j = await request.json()
    text = penna_node.PennaPrompt._compose(int(j.get("page", 0)), j.get("join", "智能"),
                                           j.get("prefix", ""), j.get("suffix", ""))
    return web.json_response({"text": text})


@routes.get("/penna/api/characters/mine")
async def my_characters(_request):
    return web.json_response(penna_store.load_characters())


@routes.post("/penna/api/characters/save")
async def save_character(request):
    j = await request.json()
    return web.json_response({"name": penna_store.put_character(j.get("name", ""), j.get("prompt", ""))})


@routes.post("/penna/api/characters/remove")
async def remove_character(request):
    penna_store.remove_character((await request.json()).get("name", ""))
    return web.json_response({"ok": True})


@routes.post("/penna/api/characters/search")
async def search_characters(request):
    """[{query, hits}]：用户自己存的排前面，再是内置的。"""
    j = await request.json()
    limit = int(j.get("limit", 5))
    mine = penna_store.load_characters()
    out = []
    for q in j.get("queries", []):
        ql = q.strip().lower()
        own = [{"name": c["name"], "prompt": c["prompt"], "series": "", "looks": "", "outfit": "", "alias": ""}
               for c in mine if ql and ql in c["name"].lower()]
        out.append({"query": q, "hits": own + penna_dict.char_dict().search(q, limit)})
    return web.json_response(out)


# ---------- 标签 ----------

@routes.post("/penna/api/tags/search")
async def search_tags(request):
    j = await request.json()
    online = bool(j.get("online", penna_store.load_config().get("tagSearchOnline", True)))
    return web.json_response(await penna_dict.search_tags(j.get("queries", [])[:6], online))


@routes.post("/penna/api/tags/check")
async def check_tags(request):
    """成稿里不在词库里的标签。"""
    j = await request.json()
    d = penna_dict.tag_dict()
    return web.json_response({"unknown": [t for t in penna_dict.tags_in(j.get("text", "")) if not d.has(t)]})


@routes.post("/penna/api/translate")
async def translate(request):
    j = await request.json()
    try:
        return web.json_response({"text": await penna_dict.translate(j.get("text", ""), j.get("gloss", "zh"))})
    except Exception as e:  # 网络不通、被墙
        return web.json_response({"error": f"翻译失败：{e}"}, status=502)


# ---------- 模型 ----------

@routes.post("/penna/api/models")
async def list_models(request):
    """拉取模型列表。网页还没保存的接口也能拉：没带 key 就用已存的。"""
    j = await request.json()
    saved = penna_store.find_llm(j.get("id")) or {}
    llm = {**saved, **{k: v for k, v in j.items() if k != "key"}, "key": j.get("key") or saved.get("key", "")}
    try:
        return web.json_response({"models": await penna_llm.list_models(llm)})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=502)


@routes.post("/penna/api/chat")
async def chat(request):
    """流式对话。回的是一行一个 JSON：{"by": 哪个模型} {"d": 增量文字} {"error": 原因} {"done": true}。
    按用途排好的模型一个个试，前一个还没吐字就失败了换下一个。
    带 test 时只用指定的那个接口（设置里的「测试连接」）。"""
    j = await request.json()
    resp = web.StreamResponse(headers={"Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache"})
    await resp.prepare(request)

    async def send(obj):
        await resp.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))

    if j.get("test"):
        saved = penna_store.find_llm(j["test"].get("id")) or {}
        t = j["test"]
        llm = {**saved, **{k: v for k, v in t.items() if k != "key"}, "key": t.get("key") or saved.get("key", "")}
        models = [m.strip() for m in (llm.get("model") or "").replace("，", ",").split(",") if m.strip()]
        chain = [(f"{llm.get('name', '')} · {m}", llm, m) for m in models]
    else:
        chain = penna_store.llm_chain(j.get("purpose", "agent"))
    if not chain:
        await send({"error": "请先在设置里添加模型接口并填写模型名称"})
        return resp

    messages = j.get("messages", [])
    images = j.get("images", {})
    temperature = float(j.get("temperature", 0.7))
    top_p = float(j.get("topP", 1))
    errors = []
    timeout = aiohttp.ClientTimeout(total=None, sock_connect=30, sock_read=180)
    try:
        async with aiohttp.ClientSession(timeout=timeout, trust_env=True) as session:
            for name, llm, model in chain:
                started = False
                try:
                    await send({"by": name})
                    async for delta in penna_llm.stream_chat(session, llm, model, messages, images, temperature, top_p):
                        started = True
                        await send({"d": delta})
                    await send({"done": True})
                    return resp
                except (ConnectionResetError, asyncio.CancelledError):
                    raise
                except Exception as e:  # 这个模型不行：没吐字就换下一个
                    msg = str(e) or type(e).__name__
                    if started:
                        await send({"error": f"{name}：{msg}"})
                        return resp
                    errors.append(f"{name}：{msg}")
            await send({"error": "所有模型都失败了\n" + "\n".join(errors)})
    except (ConnectionResetError, asyncio.CancelledError):
        pass  # 网页那边点了停止
    return resp
