"""Penna 的本地数据：设置（含 API Key）、工作台（各页成稿和对话）、自存的角色。

都放在 ComfyUI 的用户目录 user/default/penna 下，跟着 ComfyUI 走，不进插件目录，
更新插件不会把它们冲掉。
"""

import json
import os
import re
import threading
import uuid

import folder_paths

DATA_DIR = os.path.join(folder_paths.get_user_directory(), "default", "penna")
CONFIG_FILE = os.path.join(DATA_DIR, "config.json")
WORKSPACE_FILE = os.path.join(DATA_DIR, "workspace.json")
CHARACTERS_FILE = os.path.join(DATA_DIR, "characters.json")

_lock = threading.Lock()

DEFAULT_CONFIG = {
    "llms": [],
    "activeLlmId": None,
    "polishLlmId": None,
    "presetId": "anime",
    "presets": {},
    "disabledSkills": [],
    "customSkills": [],
    "tagSearchOnline": True,
    "gloss": "zh",
}


def _read(path, fallback):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return fallback


def _write(path, data):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


# ---------- 设置 ----------

def load_config():
    with _lock:
        cfg = _read(CONFIG_FILE, {})
    return {**DEFAULT_CONFIG, **cfg}


def public_config():
    """给网页看的设置：Key 不出本机，只告诉它填没填。"""
    cfg = load_config()
    cfg["llms"] = [
        {**{k: v for k, v in l.items() if k != "key"}, "hasKey": bool(l.get("key"))}
        for l in cfg["llms"]
    ]
    return cfg


def save_config(incoming):
    """网页发回来的设置。Key 的规矩：带了非空的 key 就换成新的，clearKey 为真就清掉，
    都没有就保留原来的。"""
    with _lock:
        old = {**DEFAULT_CONFIG, **_read(CONFIG_FILE, {})}
        old_keys = {l.get("id"): l.get("key", "") for l in old["llms"]}
        llms = []
        for l in incoming.get("llms", []):
            lid = str(l.get("id") or uuid.uuid4().hex[:8])
            key = l.get("key") or ""
            if not key and not l.get("clearKey"):
                key = old_keys.get(lid, "")
            llms.append({
                "id": lid,
                "name": str(l.get("name", "")),
                "protocol": "google" if l.get("protocol") == "google" else "openai",
                "baseUrl": str(l.get("baseUrl", "")).strip(),
                "model": str(l.get("model", "")),
                "enabled": bool(l.get("enabled", True)),
                "key": key.strip(),
            })
        cfg = {**old}
        for k in DEFAULT_CONFIG:
            if k in incoming and k != "llms":
                cfg[k] = incoming[k]
        cfg["llms"] = llms
        _write(CONFIG_FILE, cfg)
    return public_config()


def llm_chain(purpose):
    """按用途排好的 (显示名, 接口, 模型) 列表：指定的接口排最前，其余按列表顺序；
    一个接口填了几个模型就各算一个。"""
    cfg = load_config()
    pinned = cfg.get("polishLlmId" if purpose == "polish" else "activeLlmId")
    usable = [l for l in cfg["llms"] if l.get("enabled", True)]
    usable = [l for l in usable if l["id"] == pinned] + [l for l in usable if l["id"] != pinned]
    chain = []
    for l in usable:
        models = [m.strip() for m in re.split(r"[,，\n]", l.get("model", "")) if m.strip()]
        for m in models:
            chain.append((f"{l['name']} · {m}" if len(models) > 1 else l["name"] or m, l, m))
    return chain


def find_llm(llm_id):
    for l in load_config()["llms"]:
        if l["id"] == llm_id:
            return l
    return None


# ---------- 工作台 ----------

def load_workspace():
    with _lock:
        ws = _read(WORKSPACE_FILE, None)
    if not isinstance(ws, dict) or not ws.get("pages"):
        ws = {"current": 0, "pages": [{"name": "", "body": ""}], "chat": [], "proposal": None}
    return ws


def save_workspace(ws):
    with _lock:
        _write(WORKSPACE_FILE, ws)


# ---------- 自存的角色 ----------

def load_characters():
    with _lock:
        data = _read(CHARACTERS_FILE, [])
    return data if isinstance(data, list) else []


def put_character(name, prompt):
    """存一个角色；同名的换成新的，新的排最前。"""
    name, prompt = name.strip(), prompt.strip()
    if not name or not prompt:
        return None
    with _lock:
        cards = [c for c in _read(CHARACTERS_FILE, []) if c.get("name") != name]
        cards.insert(0, {"name": name, "prompt": prompt})
        _write(CHARACTERS_FILE, cards)
    return name


def remove_character(name):
    with _lock:
        cards = [c for c in _read(CHARACTERS_FILE, []) if c.get("name") != name]
        _write(CHARACTERS_FILE, cards)
