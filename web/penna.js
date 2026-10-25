// 在 ComfyUI 里打开 Penna 工作台：顶栏一个「Penna」按钮（快捷键 Alt+P），
// 点开是一个可拖动、可缩放的浮动窗口，里面嵌的是 /penna/app/ 这个独立页面。
// 不改 ComfyUI 原来的界面；关掉浮窗只是藏起来，正在生成的回复不会断。
import { app } from "../../scripts/app.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

const STORE = "penna.window";
let win = null;

function isDark() {
  const rgb = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
  if (!rgb) return true;
  const [r, g, b] = rgb.map(Number);
  return r * 0.299 + g * 0.587 + b * 0.114 < 128;
}

function loadBox() {
  try {
    const box = JSON.parse(localStorage.getItem(STORE));
    if (box && box.w > 300 && box.h > 200) return box;
  } catch { /* 没存过 */ }
  const w = Math.min(1180, innerWidth - 80), h = Math.min(760, innerHeight - 100);
  return { x: Math.max(20, (innerWidth - w) / 2), y: 60, w, h };
}

function saveBox() {
  if (!win) return;
  const r = win.getBoundingClientRect();
  try { localStorage.setItem(STORE, JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height })); } catch { /* 存不了就算了 */ }
}

function popOut() {
  window.open(`/penna/app/index.html?theme=${isDark() ? "dark" : "light"}`, "penna",
    "width=1280,height=820,menubar=no,toolbar=no");
}

function build() {
  const box = loadBox();
  win = document.createElement("div");
  win.id = "penna-window";
  Object.assign(win.style, {
    position: "fixed", left: box.x + "px", top: box.y + "px", width: box.w + "px", height: box.h + "px",
    zIndex: 1100, display: "flex", flexDirection: "column", resize: "both", overflow: "hidden",
    minWidth: "520px", minHeight: "320px", borderRadius: "10px",
    boxShadow: "0 12px 48px rgba(0,0,0,.45)", border: "1px solid rgba(128,128,128,.35)",
    background: isDark() ? "#1f2229" : "#fff",
  });
  const bar = document.createElement("div");
  Object.assign(bar.style, {
    display: "flex", alignItems: "center", gap: "6px", padding: "4px 8px", cursor: "move", userSelect: "none",
    fontSize: "13px", color: isDark() ? "#cfd3dc" : "#333", background: isDark() ? "#2a2e37" : "#eef1f7",
  });
  bar.innerHTML = '<b style="flex:1">🪶 Penna 羽毛笔</b>';
  const btn = (text, title, fn) => {
    const b = document.createElement("button");
    b.textContent = text;
    b.title = title;
    Object.assign(b.style, { border: "none", background: "transparent", color: "inherit", cursor: "pointer", fontSize: "13px", padding: "2px 8px", borderRadius: "4px" });
    b.onmouseenter = () => { b.style.background = "rgba(128,128,128,.2)"; };
    b.onmouseleave = () => { b.style.background = "transparent"; };
    b.onclick = e => { e.stopPropagation(); fn(); };
    bar.append(b);
  };
  btn("⧉ 新窗口", "在单独的浏览器窗口里打开（两边内容同步）", () => { popOut(); hide(); });
  btn("—", "收起（Alt+P 再打开）", hide);
  const frame = document.createElement("iframe");
  frame.src = `/penna/app/index.html?theme=${isDark() ? "dark" : "light"}`;
  Object.assign(frame.style, { flex: "1", border: "none", width: "100%", background: "transparent" });
  win.append(bar, frame);
  document.body.append(win);

  // 拖动标题栏移动；拖动时让 iframe 不吃鼠标，免得卡住
  bar.addEventListener("pointerdown", e => {
    if (e.target.tagName === "BUTTON") return;
    const sx = e.clientX - win.offsetLeft, sy = e.clientY - win.offsetTop;
    frame.style.pointerEvents = "none";
    const move = ev => {
      win.style.left = Math.min(Math.max(ev.clientX - sx, -win.offsetWidth + 120), innerWidth - 120) + "px";
      win.style.top = Math.min(Math.max(ev.clientY - sy, 0), innerHeight - 40) + "px";
    };
    const up = () => {
      frame.style.pointerEvents = "";
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      saveBox();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  });
  // 右下角缩放：结束时记住大小
  win.addEventListener("pointerdown", () => { frame.style.pointerEvents = "none"; });
  addEventListener("pointerup", () => { frame.style.pointerEvents = ""; saveBox(); });
  // 浮窗里的按键不要传给画布（不然打字会触发 ComfyUI 的快捷键）
  for (const type of ["keydown", "keyup", "keypress", "wheel"]) win.addEventListener(type, e => e.stopPropagation());
}

function show() {
  if (!win) build();
  win.style.display = "flex";
}
function hide() {
  if (win) { saveBox(); win.style.display = "none"; }
}
function toggle() {
  if (win && win.style.display !== "none") hide(); else show();
}

app.registerExtension({
  name: "Penna.Workbench",
  commands: [{ id: "Penna.Toggle", label: "打开 / 收起 Penna 提示词工作台", icon: "pi pi-pencil", function: toggle }],
  keybindings: [{ combo: { key: "p", alt: true }, commandId: "Penna.Toggle" }],
  actionBarButtons: [{ icon: "icon-[lucide--feather]", label: "Penna", tooltip: "Penna 提示词工作台（Alt+P）", onClick: toggle }],

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "PennaPrompt") return;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = created?.apply(this, arguments);
      const b = this.addWidget("button", "打开 Penna 工作台", null, show);
      b.options = { ...b.options, serialize: false };
      const w = ComfyWidgets.STRING(this, "将输出", ["STRING", { multiline: true }], app).widget;
      w.inputEl.readOnly = true;
      w.inputEl.style.opacity = "0.75";
      w.inputEl.placeholder = "工作台这一页还是空的";
      w.inputEl.title = "这次运行会输出的提示词，跟着工作台实时更新";
      // 只是显示用：不存进工作流，也不随任务发给后端
      w.serialize = false;
      w.options = { ...w.options, serialize: false };
      this.pennaPreview = w;
      // 改了页码、连接方式、前后缀，预览跟着变
      for (const name of ["page", "join", "prefix", "suffix"]) {
        const input = this.widgets.find(x => x.name === name);
        if (!input) continue;
        const cb = input.callback;
        input.callback = (...a) => { const res = cb?.apply(input, a); refreshPreview(this); return res; };
      }
      refreshPreview(this);
      return r;
    };
    const configure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = configure?.apply(this, arguments);
      refreshPreview(this);
      return r;
    };
    const executed = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      executed?.apply(this, arguments);
      const text = message?.penna_text?.[0];
      if (this.pennaPreview && text !== undefined) this.pennaPreview.value = text;
    };
  },
});

// ---------- 节点上的预览：工作台一保存就刷新 ----------

function refreshPreview(node) {
  clearTimeout(node.pennaTimer);
  node.pennaTimer = setTimeout(async () => {
    const value = name => node.widgets?.find(x => x.name === name)?.value;
    try {
      const r = await fetch("/penna/api/preview", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page: value("page") ?? 0, join: value("join") ?? "智能", prefix: value("prefix") ?? "", suffix: value("suffix") ?? "" }),
      });
      const { text } = await r.json();
      if (node.pennaPreview && typeof text === "string") node.pennaPreview.value = text;
    } catch { /* 后端没起来就算了 */ }
  }, 150);
}

function refreshAll() {
  for (const node of app.graph?._nodes ?? []) if (node.type === "PennaPrompt") refreshPreview(node);
}

// 工作台（浮窗或单独窗口）每次保存都会在这个频道里说一声
if ("BroadcastChannel" in window) {
  new BroadcastChannel("penna").addEventListener("message", e => { if (e.data?.type === "workspace") refreshAll(); });
}
window.addEventListener("focus", refreshAll);
