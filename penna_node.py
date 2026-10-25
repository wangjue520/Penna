"""「Penna 提示词」节点：把工作台某一页的成稿交给工作流。

成稿里的【分段标注】和〔译〕对照行只给人看，交付前去掉，和 Penna 的「最终提示词」一样。
"""

import re

from . import penna_store

_ZH_LINE = re.compile(r"^(?:〔译〕|译[:：])")
_LABEL = re.compile(r"^【[^】\n]{0,12}】[ \t]*")
_END_PUNCT = tuple(",，.。;；!！?？")


def final_prompt(body, join="智能"):
    lines = []
    for raw in body.split("\n"):
        line = raw.strip()
        if not line or _ZH_LINE.match(line):
            continue
        line = _LABEL.sub("", line).strip()
        if line:
            lines.append(line)
    if join == "换行":
        return "\n".join(lines)
    out = ""
    for line in lines:
        if not out:
            out = line
        elif join == "空格" or out.endswith(_END_PUNCT):
            out += " " + line
        else:
            out += ", " + line
    return out


def page_prompt(page, join):
    ws = penna_store.load_workspace()
    pages = ws.get("pages") or []
    if not pages:
        return ""
    idx = ws.get("current", 0) if page <= 0 else page - 1
    if idx < 0 or idx >= len(pages):
        return ""
    return final_prompt(pages[idx].get("body", ""), join)


class PennaPrompt:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "page": ("INT", {"default": 0, "min": 0, "max": 10,
                                 "tooltip": "取 Penna 工作台的第几页；0 表示当前页"}),
                "join": (["智能", "逗号", "换行", "空格"],
                         {"default": "智能",
                          "tooltip": "各段怎么连起来。智能：上一段以标点结尾就接空格，否则接逗号"}),
            },
            "optional": {
                "prefix": ("STRING", {"default": "", "multiline": False, "tooltip": "接在最前面，例如画质词"}),
                "suffix": ("STRING", {"default": "", "multiline": False, "tooltip": "接在最后面"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("提示词",)
    FUNCTION = "run"
    CATEGORY = "Penna"
    OUTPUT_NODE = False
    DESCRIPTION = "输出 Penna 工作台里某一页的最终提示词（去掉分段标注和对照译文）"

    @staticmethod
    def _compose(page, join, prefix, suffix):
        parts = [p.strip().strip(",") for p in (prefix, page_prompt(page, join), suffix) if p and p.strip()]
        return ", ".join(parts)

    @classmethod
    def IS_CHANGED(cls, page, join, prefix="", suffix=""):
        # 成稿变了就重新执行
        return cls._compose(page, join, prefix, suffix)

    def run(self, page, join, prefix="", suffix=""):
        text = self._compose(page, join, prefix, suffix)
        return {"ui": {"penna_text": [text]}, "result": (text,)}


NODE_CLASS_MAPPINGS = {"PennaPrompt": PennaPrompt}
NODE_DISPLAY_NAME_MAPPINGS = {"PennaPrompt": "Penna 提示词"}
