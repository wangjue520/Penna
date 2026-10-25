# comfyui-penna

把 [Penna 羽毛笔](https://github.com/storyAura/Penna)（Windows 桌面端的文生图提示词工作台）的核心功能搬进 ComfyUI。ComfyUI 原来的界面不动，只在顶栏多一个「Penna」按钮。

## 安装

在 `ComfyUI/custom_nodes` 下：

```bash
git clone -b comfyui https://github.com/wangjue520/Penna comfyui-penna
```

或者在 ComfyUI-Manager 里「Install via Git URL」，填 `https://github.com/wangjue520/Penna`，再切到 `comfyui` 分支。也可以下载这个分支的 ZIP，解压到 `custom_nodes`，确保结构是 `custom_nodes/comfyui-penna/__init__.py`。

装好后重启 ComfyUI，不需要额外装 Python 依赖。

## 怎么用

1. 重启 ComfyUI，顶栏出现 **Penna** 按钮（快捷键 **Alt+P**），点开是一个浮动窗口：拖标题栏移动，拖右下角缩放，「⧉ 新窗口」可以在单独的浏览器窗口里打开（两边内容同步）。
2. 第一次打开会弹出设置：「模型接口」里添加一个 OpenAI 兼容接口（DeepSeek、硅基流动、OpenRouter、Ollama 等）或 Google 接口，填 Base URL、模型名称、API Key，点「测试连接」，再点「保存」。
3. 在右边跟 Agent 说你想要的画面。它写的提示词放到左边的成稿区：空页直接写入，已有内容时作为**待确认改动**按段显示红绿对比，可以逐段或整体采纳、驳回。
4. 工作流里加一个 **「Penna 提示词」** 节点（分类 Penna），输出接到 CLIP 文本编码之类的节点：
   - `page`：取第几页，0 表示工作台当前页
   - `join`：各段怎么连起来（智能 / 逗号 / 换行 / 空格）
   - `prefix` / `suffix`：接在前后的固定词，例如画质词
   - 成稿改了，节点下次运行会自动重新取；节点上的「上次输出」显示这次用的提示词

## 从 Penna 搬过来的

- 成稿分页（最多 10 页）、【标注】分段、〔译〕对照行；每段可复制、润色、翻译、拿去讨论、上下移、删除，可以撤销
- Agent 对话：6 个预设（动漫 / 写实 / 协同 / 反推润色 / 意译 / 自由改稿）、11 个内置技能、自定义技能（导入 SKILL.md 或让 Agent 写）、选项按钮、图片附件、消息排队、停止和重新运行
- 写标签前替 Agent 查 Danbooru 词库（在线 DanbooruSearch 语义搜索，连不上用本地 13.6 万标签），写完核对，不在词库里的标出来
- 角色库：内置约 7.5 万个 Danbooru 角色（触发词、外貌、服装、中文名），可以按中文名、昵称、旧名查；自己存的角色
- 模型接口按顺序接力，失败自动换下一个

没搬：本地反推（ComfyUI 里有 WD14 等打标节点）、固定区、档案库、MCP、机翻多引擎（这里只用免 Key 的 Google 网页接口）。

## 内置词库

由 `tools/merge_dict.py` 把两份词库合成，放在 `data/`：

| | 标签 | 角色 |
|---|---|---|
| [danbooru-zh-dict](https://github.com/wangjue520/danbooru-zh-dict) | 12.6 万（图数 ≥50），中文名、中文同义词、英文别名（含改名前的旧名）、日文别名、说明 | 3.6 万个角色的中文名、昵称 |
| [Penna](https://github.com/storyAura/Penna) | 补上 1 万个图数 20~49 的冷门标签和 Pixiv 叫法 | 6.9 万个角色的外貌 / 服装特征词 |
| 合并后 | **13.6 万** | **7.5 万**，1427 个旧名换成 Danbooru 现在的名字（如 gojou satoru → gojo satoru，旧名仍可查） |

更新数据：下载 danbooru-zh-dict 的 `dist/danbooru_zh_dict.csv` 和 Penna 的 `assets/danbooru_tags.tsv.gz`、`assets/danbooru_characters.tsv.gz`，运行

```
python tools/merge_dict.py danbooru_zh_dict.csv danbooru_tags.tsv.gz danbooru_characters.tsv.gz
```

## 数据放在哪

`ComfyUI/user/default/penna/`：`config.json`（设置，含 API Key，明文存在本机）、`workspace.json`（各页成稿和对话）、`characters.json`（自存的角色）。更新插件不会动它们。

## 许可

Penna 原作 © storyAura，MIT 许可（见 LICENSE.Penna）；内置数据合并自 Penna 和 danbooru-zh-dict。
