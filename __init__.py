"""comfyui-penna：把 Penna 羽毛笔（storyAura/Penna）的提示词工作台搬进 ComfyUI。

顶栏多一个「Penna」按钮，点开是一个浮动窗口（也能单独开浏览器窗口）；
写好的提示词由「Penna 提示词」节点输出给工作流。ComfyUI 原来的界面不动。
"""

from . import penna_server  # noqa: F401  注册 /penna 下的网址
from .penna_node import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
