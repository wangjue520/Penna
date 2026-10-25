"""Danbooru 标签词库、角色库、在线语义搜索和机翻。

内置数据由 tools/merge_dict.py 把两份词库合成：
- danbooru-zh-dict（wangjue520）：12.6 万个标签的中文名、中文同义词、英文别名（含改名前的旧名）、日文别名、说明
- Penna（storyAura/Penna，MIT）：冷门标签、Pixiv 叫法，角色的外貌 / 服装特征词
  data/tags.tsv.gz        标签 分类 图数 中文名 中文同义词 英文别名 其他别名 说明
  data/characters.tsv.gz  角色名 作品 外貌 服装 别名 中文名 中文同义词 图数 说明
"""

import asyncio
import gzip
import json
import os
import re
import urllib.parse
import urllib.request

import aiohttp

NODE_DIR = os.path.dirname(os.path.abspath(__file__))
TAGS_FILE = os.path.join(NODE_DIR, "data", "tags.tsv.gz")
CHARS_FILE = os.path.join(NODE_DIR, "data", "characters.tsv.gz")

DANBOORU_SEARCH_URL = "https://sakizuki-danboorusearch.hf.space/mcp/mcp"

_SEPARATORS = re.compile(r"[,，、;；\n]+")
_ASCII = re.compile(r"^[\x00-\x7f]+$")


def normalize_tag(raw):
    """提示词里的一个标签还原成 Danbooru 的写法：去掉权重和外层括号、反斜杠转义，
    空格换成下划线，小写。标签自己的括号（ganyu (genshin impact)）留着。"""
    t = raw.strip()

    def paired(s):
        depth = 0
        for ch in s.replace(r"\(", "").replace(r"\)", ""):
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth < 0:
                    return False
        return depth == 0

    def depth(s):
        bare = s.replace(r"\(", "").replace(r"\)", "")
        return bare.count("(") - bare.count(")")

    while len(t) > 1 and ((t[0], t[-1]) in (("(", ")"), ("[", "]"), ("{", "}"))) and paired(t[1:-1]):
        t = re.sub(r":\s*[\d.]+\s*$", "", t[1:-1]).strip()
    while t.startswith("(") and depth(t) > 0:
        t = t[1:].strip()
    while t.endswith(")") and depth(t) < 0:
        t = t[:-1].strip()
    return re.sub(r"\s+", "_", t.replace(r"\(", "(").replace(r"\)", ")").lower())


def tags_in(prompt):
    """一条 Tag 式提示词里用到的标签（去重、保持先后）。"""
    flat = re.sub(r"\(([^()]*,[^()]*):\s*[\d.]+\s*\)", r"\1", prompt)
    out = []
    for piece in _SEPARATORS.split(flat):
        p = piece.strip()
        if not p or p in ("BREAK", "AND") or p.startswith("<"):
            continue
        t = normalize_tag(p)
        if t and t not in out:
            out.append(t)
    return out


def _bar(items):
    """「|a|b|」：判断某个词是不是其中一个（找「|词|」）或包含在哪个里面（找「词」）都只要一次 in。"""
    return "|" + "|".join(i.lower() for i in items) + "|" if items else ""


def _bare(name):
    """去掉译名后面带的作品：「芙宁娜（原神）」-> 「芙宁娜」。"""
    return re.sub(r"\s*[（(][^（）()]*[）)]\s*$", "", name)


class TagDictionary:
    def __init__(self):
        # (标签, 分类, 图数, 中文名, 中文同义词, 英文别名, 其他别名, 说明)，按图数从多到少
        self.rows = []
        self.alias = {}  # 英文别名 / 旧名 -> 现在的标签
        with gzip.open(TAGS_FILE, "rt", encoding="utf-8") as f:
            for line in f:
                p = line.rstrip("\n").split("\t")
                p += [""] * (8 - len(p))
                syn, en, other = (x.split("|") if x else [] for x in p[4:7])
                self.rows.append((p[0], int(p[1] or 0), int(p[2] or 0), p[3], syn, en, other, p[7]))
                for a in en:
                    self.alias.setdefault(a.lower(), p[0])
        self.by_tag = {r[0]: r for r in self.rows}
        self.known = set(self.by_tag) | set(self.alias)
        # 查中文用的：小写的中文名、去掉作品的中文名、同义词串、别名串
        self._zh = [(r[3].lower(), _bare(r[3]).lower(), _bar(r[4]), _bar(r[6]), _bar(r[5])) for r in self.rows]

    def has(self, tag):
        return normalize_tag(tag) in self.known

    def meaning(self, row):
        return row[3] or (row[4][0] if row[4] else "")

    def search(self, query, per_term=8):
        """每个词各找 per_term 个：完全对上的（标签、英文别名 / 中文名、同义词）最前，
        再是开头对上的、包含的；同一档里图多的在前。画师只在完全对上时出现。"""
        out = {}
        for raw in _SEPARATORS.split(query):
            term = raw.strip().lower()
            if not term:
                continue
            tiers = ([], [], [], [])
            if _ASCII.match(term):
                needle = re.sub(r"\s+", "_", term)
                if needle in self.by_tag:
                    tiers[0].append(self.by_tag[needle])
                if needle in self.alias:
                    tiers[0].append(self.by_tag[self.alias[needle]])
                key = f"|{needle}"
                for r, z in zip(self.rows, self._zh):
                    if len(tiers[3]) >= per_term and len(tiers[2]) >= per_term and len(tiers[1]) >= per_term:
                        break
                    if r[1] == 1:
                        continue
                    if r[0].startswith(needle):
                        tiers[1].append(r)
                    elif key in z[4]:
                        tiers[2].append(r)
                    elif needle in r[0] or needle in z[4]:
                        tiers[3].append(r)
            else:
                exact = f"|{term}|"
                for r, z in zip(self.rows, self._zh):
                    if len(tiers[3]) >= per_term and len(tiers[1]) >= per_term:
                        break
                    if z[0] == term or z[1] == term or exact in z[2]:
                        tiers[0].append(r)
                    elif r[1] == 1:
                        continue
                    elif exact in z[3]:
                        tiers[1].append(r)
                    elif term in z[0] or term in z[2]:
                        tiers[2].append(r)
                    elif term in z[3]:
                        tiers[3].append(r)
            n = 0
            for r in (r for t in tiers for r in t):
                if r[0] not in out:
                    out[r[0]] = {"tag": r[0], "zh": self.meaning(r)}
                n += 1
                if n >= per_term:
                    break
        return list(out.values())


class CharacterDict:
    def __init__(self):
        self.rows = []
        with gzip.open(CHARS_FILE, "rt", encoding="utf-8") as f:
            for line in f:
                p = line.rstrip("\n").split("\t")
                p += [""] * (9 - len(p))
                alias, syn = p[4].split("|") if p[4] else [], p[6].split("|") if p[6] else []
                self.rows.append({
                    "name": p[0], "series": p[1], "looks": p[2], "outfit": p[3],
                    "alias": ", ".join(alias), "zh": p[5], "zh_syn": "、".join(syn),
                    "count": int(p[7] or 0), "note": p[8],
                    # 下面几个只给查找用，不发给网页
                    "_names": _bar(alias + syn + [p[5], _bare(p[5])]),
                })

    def search(self, query, limit=5):
        """名字完全对上的最前，再是去掉括号后对上的、某个别名或中文名完全对上的，
        再是每个词都出现在名字、作品、别名或中文名里的；同档里图多的在前。"""
        q = re.sub(r"\s+", " ", re.sub(r"[_\\]", " ", query.lower())).strip()
        if not q:
            return []
        words = q.split(" ")
        exact, bare, loose = [], [], []
        key = f"|{q}|"
        for r in self.rows:
            name = r["name"]
            paren = name.find(" (")
            if name == q:
                exact.append(r)
            elif (paren > 0 and name[:paren] == q) or key in r["_names"]:
                bare.append(r)
            elif len(loose) < limit and all(w in name or w in r["series"] or w in r["_names"] for w in words):
                loose.append(r)
        return [{k: v for k, v in r.items() if not k.startswith("_")} for r in (exact + bare + loose)[:limit]]


_tags = None
_chars = None


def tag_dict():
    global _tags
    if _tags is None:
        _tags = TagDictionary()
    return _tags


def char_dict():
    global _chars
    if _chars is None:
        _chars = CharacterDict()
    return _chars


# ---------- 在线语义搜索（DanbooruSearch，MCP 协议） ----------

async def _mcp_call(session, tool, arguments):
    state = {"sid": None}

    async def post(body, want_reply):
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if state["sid"]:
            headers["Mcp-Session-Id"] = state["sid"]
            headers["MCP-Protocol-Version"] = "2025-03-26"
        async with session.post(DANBOORU_SEARCH_URL, json=body, headers=headers) as resp:
            state["sid"] = state["sid"] or resp.headers.get("mcp-session-id")
            text = await resp.text()
            if not want_reply:
                return None
            if resp.status != 200:
                raise RuntimeError(f"HTTP {resp.status}")
        # 回复可能是整个 JSON，也可能是事件流里的 data: 行
        candidates = [text] + [l[5:].strip() for l in text.splitlines() if l.startswith("data:")]
        for c in candidates:
            try:
                msg = json.loads(c)
            except ValueError:
                continue
            if isinstance(msg, dict) and msg.get("id") == body["id"]:
                if "error" in msg:
                    raise RuntimeError(str(msg["error"].get("message", msg["error"])))
                return msg.get("result", {})
        raise RuntimeError("回复看不懂")

    await post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-03-26", "capabilities": {},
        "clientInfo": {"name": "comfyui-penna", "version": "1.0"}}}, True)
    await post({"jsonrpc": "2.0", "method": "notifications/initialized"}, False)
    result = await post({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                         "params": {"name": tool, "arguments": arguments}}, True)
    text = "\n".join(c.get("text", "") for c in result.get("content", []) if isinstance(c, dict))
    if result.get("isError"):
        raise RuntimeError(text[:120])
    return text


async def _online_search(query):
    timeout = aiohttp.ClientTimeout(total=25)
    for _ in range(2):  # 这个服务偶尔握手失败或还在唤醒，再试一次
        try:
            async with aiohttp.ClientSession(timeout=timeout, trust_env=True) as s:
                text = await _mcp_call(s, "search_tags", {"query": query})
            data = json.loads(text)
            hits = [{"tag": r["tag"], "zh": r.get("cn_name") or ""}
                    for r in data.get("results", []) if isinstance(r, dict) and isinstance(r.get("tag"), str)]
            if hits:
                return hits
            return None
        except Exception:
            continue
    return None


async def search_tags(queries, online):
    async def one(q):
        if online:
            hits = await _online_search(q)
            if hits:
                return {"query": q, "source": "DanbooruSearch", "hits": hits}
        return {"query": q, "source": "内置词库", "hits": tag_dict().search(q)}

    return await asyncio.gather(*(one(q) for q in queries))


# ---------- 机翻（Google 网页接口，免 Key） ----------

GLOSS_TARGET = {"zh": "zh-CN", "zh-Hant": "zh-TW", "ja": "ja"}


def _translate_sync(text, target):
    query = urllib.parse.urlencode({"client": "gtx", "sl": "auto", "tl": target, "dt": "t"})
    req = urllib.request.Request(
        "https://translate.googleapis.com/translate_a/single?" + query,
        data=urllib.parse.urlencode({"q": text}).encode(),
        headers={"User-Agent": "Mozilla/5.0", "Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=25) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return "".join(seg[0] for seg in data[0] if seg and seg[0])


async def translate(text, gloss):
    # 这个接口拒 aiohttp 的请求（一律 429），urllib 就没事，放到线程里跑
    return await asyncio.to_thread(_translate_sync, text, GLOSS_TARGET.get(gloss, "zh-CN"))
