// Penna 工作台：左边成稿（分页、分段、待确认改动），右边 Agent 对话。
// 做法照 Penna 桌面版：Agent 的改动先作为待确认改动，用户采纳后才写进成稿。
import {
  ZH_MARK, sectionSpans, mergeSections, applySection, finalPrompt, stripSectionLabels,
  splitDrafts, draftText, splitOptions, splitNewSkill, parseSkill, splitTools, visibleProse,
  formatTagResults, formatCharacterResults, characterTrigger,
  FACTORY_PRESETS, QUICK_ACTIONS, BUILTIN_SKILLS, skillPrompt, PLAN_FIRST_PROMPT,
  draftFormatPrompt, POLISH_SYSTEM_PROMPT, MAX_PAGES,
} from './core.js';

const $ = sel => document.querySelector(sel);
const API = '/penna/api';
const theme = new URLSearchParams(location.search).get('theme');
if (theme) document.documentElement.dataset.theme = theme;

// ---------------- 状态 ----------------

let cfg = null;          // 设置（Key 不在这里）
let ws = null;           // 工作台：{current, pages:[{name, body}], chat:[], proposals:{页下标: {target, title}}}
let quote = null;        // 选中拿去讨论的那一段
let attachments = [];    // 待发送的图片（dataURL）
let skillRefs = [];      // 待发送消息里点名的技能 id
let outbox = [];         // 正在生成时又发的消息，排队
let streaming = null;    // 正在进行的回复：{abort}
let toolRounds = 0;      // 这一轮里替模型查了几次
let foundTags = new Set();
let editing = false;     // 成稿正在整篇编辑
let busySection = -1;    // 正在润色 / 翻译的段
const undo = {};         // 每页的撤销栈
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('penna') : null;
const clientId = Math.random().toString(36).slice(2);

const api = async (path, body, method) => {
  const r = await fetch(API + path, body === undefined ? { method: method || 'GET' } : {
    method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !j.error) j.error = `HTTP ${r.status}`;
  return j;
};

function toast(text, ms = 2200) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

// 很简单的 Markdown：粗体、行内代码、列表、段落。
function md(text) {
  const blocks = esc(text).split(/\n{2,}/);
  return blocks.map(b => {
    const lines = b.split('\n');
    const inline = s => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
    if (lines.every(l => /^\s*(?:[-*•]|\d+[.、)])\s+/.test(l))) {
      return `<ul>${lines.map(l => `<li>${inline(l.replace(/^\s*(?:[-*•]|\d+[.、)])\s+/, ''))}</li>`).join('')}</ul>`;
    }
    return `<p>${lines.map(l => inline(l.replace(/^#{1,6}\s+/, ''))).join('<br>')}</p>`;
  }).join('');
}

// ---------------- 存取 ----------------

const page = () => ws.pages[ws.current];
const proposalOf = i => ws.proposals?.[i] || null;

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 400);
}
async function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  await api('/workspace', ws, 'PUT');
  channel?.postMessage({ from: clientId, type: 'workspace' });
}
window.addEventListener('pagehide', () => {
  if (!saveTimer) return;
  fetch(API + '/workspace', { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ws) });
});
document.addEventListener('visibilitychange', () => { if (document.hidden && saveTimer) flush(); });

channel?.addEventListener('message', async e => {
  if (e.data?.from === clientId) return;
  if (e.data?.type === 'workspace' && !streaming && !saveTimer) {
    ws = normalizeWorkspace(await api('/workspace'));
    renderAll();
  }
  if (e.data?.type === 'config') {
    cfg = await api('/config');
    renderPresetSelect(); renderSkillSelect();
    // 这边开着的设置框是旧的，保存会把别处刚改的盖掉：换成新的
    if (draftCfg) { openSettings(settingsTab); toast('设置在另一个窗口里改过了，已刷新'); }
  }
});

function normalizeWorkspace(w) {
  w = w && typeof w === 'object' ? w : {};
  w.pages = Array.isArray(w.pages) && w.pages.length ? w.pages.slice(0, MAX_PAGES) : [{ name: '', body: '' }];
  w.current = Math.min(Math.max(0, w.current | 0), w.pages.length - 1);
  w.chat = Array.isArray(w.chat) ? w.chat : [];
  w.proposals = w.proposals && typeof w.proposals === 'object' ? w.proposals : {};
  for (const m of w.chat) { delete m.streaming; }
  return w;
}

/** 改某一页的成稿（用户自己动手的改动，直接生效，可以撤销）。 */
function setBody(i, body, { record = true } = {}) {
  const p = ws.pages[i];
  if (p.body === body) return;
  if (record) (undo[i] ||= []).push(p.body), undo[i].length > 50 && undo[i].shift();
  p.body = body;
  save();
}

// ---------------- 预设与技能 ----------------

function presets() {
  return FACTORY_PRESETS.map(p => ({ ...p, ...(cfg.presets?.[p.id] || {}) }));
}
const activePreset = () => presets().find(p => p.id === cfg.presetId) || presets()[0];
const allSkills = () => [
  ...BUILTIN_SKILLS,
  ...(cfg.customSkills || []).map(s => ({ ...s, id: 'custom:' + s.name, custom: true })),
];
const enabledSkills = () => allSkills().filter(s => !(cfg.disabledSkills || []).includes(s.id));
const skillOn = id => !(cfg.disabledSkills || []).includes(id);

async function saveConfig(next) {
  cfg = await api('/config', next);
  channel?.postMessage({ from: clientId, type: 'config' });
  renderPresetSelect();
  renderSkillSelect();
}

// ---------------- 页签 ----------------

function renderPages() {
  const nav = $('#pages');
  nav.replaceChildren(...[...ws.pages.map((p, i) => h('button', {
    class: i === ws.current ? 'on' : '',
    title: '单击切换，双击改名，右键删除这一页。节点里填页码 ' + (i + 1) + ' 就取这一页',
    onclick: () => { ws.current = i; editing = false; save(); renderAll(); },
    ondblclick: () => {
      const name = prompt('这一页的名字', p.name || '');
      if (name !== null) { p.name = name.trim().slice(0, 12); save(); renderPages(); }
    },
    oncontextmenu: e => {
      e.preventDefault();
      if (ws.pages.length <= 1) return toast('至少留一页');
      if (!confirm(`删掉第 ${i + 1} 页${p.name ? `「${p.name}」` : ''}？后面的页会往前挪。`)) return;
      ws.pages.splice(i, 1);
      const props = {};
      for (const [k, v] of Object.entries(ws.proposals)) {
        if (+k < i) props[k] = v; else if (+k > i) props[+k - 1] = v;
      }
      ws.proposals = props;
      ws.current = Math.min(ws.current, ws.pages.length - 1);
      save(); renderAll();
    },
  }, `${i + 1}${p.name ? ' ' + p.name : ''}`, proposalOf(i) ? h('span', { class: 'dot' }) : null)),
  ws.pages.length < MAX_PAGES ? h('button', {
    class: 'ghost', title: '加一页',
    onclick: () => { ws.pages.push({ name: '', body: '' }); ws.current = ws.pages.length - 1; save(); renderAll(); },
  }, '＋') : null].filter(Boolean));
}

// ---------------- 成稿 ----------------

function renderDraftTools() {
  const p = page();
  const pending = !!proposalOf(ws.current);
  $('#draft-tools').replaceChildren(
    h('button', { class: 'ghost small', disabled: pending, onclick: () => { editing = !editing; renderDraft(); renderDraftTools(); } },
      editing ? '✓ 完成' : '✎ 编辑'),
    h('button', {
      class: 'ghost small', disabled: pending || !(undo[ws.current] || []).length, title: '撤销上一次改动',
      onclick: () => { const prev = undo[ws.current].pop(); setBody(ws.current, prev, { record: false }); renderAll(); },
    }, '↶ 撤销'),
    h('button', {
      class: 'ghost small', disabled: pending || !p.body.trim(), title: '把整页翻译一遍，每段写上对照',
      onclick: translateAll,
    }, '译 对照'),
    h('button', {
      class: 'ghost small danger', disabled: pending || !p.body.trim(),
      onclick: () => { if (confirm('清空这一页的成稿？（可以撤销）')) { setBody(ws.current, ''); editing = false; renderAll(); } },
    }, '清空'),
  );
}

function renderDraft() {
  const box = $('#draft');
  const p = page();
  const prop = proposalOf(ws.current);
  if (prop) return box.replaceChildren(...renderProposal(prop));
  if (editing) {
    const ta = h('textarea', { class: 'body', spellcheck: 'false',
      placeholder: '一行一段，行首用【标注】分段，例如：\n【主体】1girl, solo, long silver hair\n〔译〕一个女孩，银色长发\n【场景】...' });
    ta.value = p.body;
    ta.addEventListener('input', () => { setBody(ws.current, ta.value, { record: false }); renderFinal(); });
    ta.addEventListener('focus', () => { (undo[ws.current] ||= []).push(p.body); }, { once: true });
    box.replaceChildren(ta);
    ta.focus();
    return;
  }
  if (!p.body.trim()) {
    return box.replaceChildren(h('div', { class: 'empty', html:
      '这一页还是空的。<br>在右边告诉 Agent 你想要的画面，它写好的提示词会放到这里；<br>' +
      '也可以点上面的「✎ 编辑」自己写。<br><span class="muted">ComfyUI 里加一个「Penna 提示词」节点，就能把这里的提示词接进工作流。</span>' }));
  }
  const spans = sectionSpans(p.body);
  const list = spans.length ? spans : [{ label: '', start: 0, textStart: 0, textEnd: p.body.length, end: p.body.length, zh: '' }];
  box.replaceChildren(...list.map((s, i) => sectionCard(p.body, s, i, list.length)));
}

function sectionCard(body, s, i, count) {
  const text = body.substring(s.textStart, s.textEnd);
  const whole = body.substring(s.start, s.end);
  const act = (label, title, fn, disabled) => h('button', { title, disabled, onclick: fn }, label);
  return h('div', { class: 'section' + (busySection === i ? ' busy' : '') },
    s.label || spansExist(body) ? h('div', {
      class: 'label', title: '点击改段名',
      onclick: () => {
        const name = prompt('段名（不超过 12 个字，留空就是不分段的文字）', s.label);
        if (name === null) return;
        const clean = name.replace(/[【】\r\n]/g, '').trim().slice(0, 12);
        setBody(ws.current, body.substring(0, s.start) + `【${clean}】` + body.substring(s.textStart));
        renderAll();
      },
    }, s.label ? `【${s.label}】` : '【】') : null,
    h('div', { class: 'text' }, text.trim() || '（空）'),
    s.zh ? h('div', { class: 'gloss' }, s.zh) : null,
    h('div', { class: 'acts' },
      act('复制', '复制这一段（不带标注和对照）', () => copy(text.trim())),
      act('润色', '让模型润色这一段，结果作为待确认改动', () => polishSection(i), busySection >= 0),
      act('翻译', '把这一段翻译成对照', () => translateSection(i), busySection >= 0),
      act('讨论', '带着这一段去和 Agent 讨论，Agent 只改这一段', () => { quote = whole; renderComposerExtra(); $('#input').focus(); }),
      act('↑', '上移', () => moveSection(i, -1), i === 0),
      act('↓', '下移', () => moveSection(i, 1), i === count - 1),
      act('删除', '删掉这一段（可以撤销）', () => {
        const pieces = sectionSpans(body).map(x => body.substring(x.start, x.end));
        pieces.splice(i, 1);
        setBody(ws.current, spansExist(body) ? pieces.join('\n') : '');
        renderAll();
      }),
    ));
}

const spansExist = body => sectionSpans(body).length > 0;

function moveSection(i, d) {
  const body = page().body;
  const pieces = sectionSpans(body).map(x => body.substring(x.start, x.end));
  if (!pieces.length) return;
  const [it] = pieces.splice(i, 1);
  pieces.splice(i + d, 0, it);
  setBody(ws.current, pieces.join('\n'));
  renderAll();
}

function acceptProposal(i) {
  const prop = proposalOf(i);
  if (!prop) return;
  setBody(i, prop.target);
  delete ws.proposals[i];
  save(); renderAll();
  toast(`第 ${i + 1} 页已采纳`);
}

function rejectProposal(i) {
  if (!proposalOf(i)) return;
  delete ws.proposals[i];
  save(); renderAll();
}

/** 待确认改动：按段列出旧的和新的，可以逐段或整体采纳、驳回。 */
function renderProposal(prop) {
  const i = ws.current;
  const base = page().body;
  const target = prop.target;
  const a = sectionSpans(base), b = sectionSpans(target);
  const finish = () => {
    if (page().body === proposalOf(i)?.target) delete ws.proposals[i];
    save(); renderAll();
  };
  const head = h('div', { class: 'proposal-head' },
    h('b', {}, `待确认：${prop.title || 'Agent 的改动'}`),
    h('button', { class: 'primary small', onclick: () => {
      setBody(i, target); delete ws.proposals[i]; finish();
    } }, '全部采纳'),
    h('button', { class: 'small', onclick: () => { delete ws.proposals[i]; finish(); } }, '全部驳回'));
  // 两边都没有分段标注：整篇对比
  if (!a.length || !b.length) {
    return [head, h('div', { class: 'diff' },
      base.trim() ? h('del', {}, base) : null, h('ins', {}, target))];
  }
  const labels = [];
  for (const s of b) if (!labels.includes(s.label)) labels.push(s.label);
  for (const s of a) if (!labels.includes(s.label)) labels.push(s.label);
  const cards = [];
  for (const label of labels) {
    const oldS = a.find(s => s.label === label), newS = b.find(s => s.label === label);
    const oldT = oldS ? base.substring(oldS.textStart, oldS.end) : null;
    const newT = newS ? target.substring(newS.textStart, newS.end) : null;
    if (oldT === newT) {
      cards.push(h('div', { class: 'diff' }, h('div', { class: 'dl' }, h('span', {}, `【${label}】`), h('small', { class: 'muted' }, '没变')),
        h('div', { class: 'same' }, oldT.split('\n')[0])));
      continue;
    }
    cards.push(h('div', { class: 'diff' },
      h('div', { class: 'dl' }, h('span', {}, `【${label}】${!oldS ? ' 新增' : !newS ? ' 删除' : ''}`),
        h('button', { class: 'small primary', onclick: () => { setBody(i, applySection(page().body, target, label)); finish(); } }, '采纳'),
        h('button', { class: 'small', onclick: () => {
          ws.proposals[i].target = applySection(ws.proposals[i].target, page().body, label);
          if (ws.proposals[i].target === page().body) delete ws.proposals[i];
          save(); renderAll();
        } }, '驳回')),
      oldT !== null ? h('del', {}, oldT) : null,
      newT !== null ? h('ins', {}, newT) : null));
  }
  return [head, ...cards];
}

function renderFinal() {
  const join = $('#join').value;
  const text = finalPrompt(page().body, join);
  $('#final').textContent = text || '（空）';
  $('#final').classList.toggle('muted', !text);
  $('#final-page').textContent = `第 ${ws.current + 1} 页${page().name ? '「' + page().name + '」' : ''}（节点 page 填 ${ws.current + 1}，或填 0 取当前页）`;
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制'); }
  catch {
    const ta = h('textarea'); ta.value = text; document.body.append(ta); ta.select();
    document.execCommand('copy'); ta.remove(); toast('已复制');
  }
}

// ---------------- 润色、翻译 ----------------

/** 不流式地问一次模型，拿回整段文字。 */
async function askOnce(purpose, messages, temperature = 0.7) {
  const r = await fetch(API + '/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ purpose, messages, temperature, topP: 1 }) });
  let text = '', error = null;
  for await (const ev of ndjson(r)) {
    if (ev.d) text += ev.d;
    if (ev.error) error = ev.error;
  }
  if (error && !text) throw new Error(error);
  return text.trim();
}

async function polishSection(i) {
  const body = page().body;
  const spans = sectionSpans(body);
  const s = spans[i] || { label: '', start: 0, textStart: 0, textEnd: body.length, end: body.length };
  const target = body.substring(s.textStart, s.textEnd);
  const ask = prompt('润色要求（留空就是普通润色：更具体、更有画面感，不改原意）', '');
  if (ask === null) return;
  busySection = i; renderDraft();
  try {
    const out = await askOnce('polish', [
      { role: 'system', content: POLISH_SYSTEM_PROMPT },
      { role: 'user', content: `【全文，仅供参考】\n${finalPrompt(body)}\n\n【要改写的部分】\n${target}\n\n【要求】\n${ask.trim() || '润色这部分：更具体、更有画面感，不改变原意。'}` },
    ]);
    if (!out) throw new Error('模型没有返回内容');
    if (page().body !== body) throw new Error('润色期间成稿被改动了，请重试');
    // 原来的对照对不上了，去掉
    const next = body.substring(0, s.textStart) + out.replace(/\s*\n\s*/g, ' ') + body.substring(s.end);
    ws.proposals[ws.current] = { target: next, title: `润色${s.label ? '【' + s.label + '】' : ''}` };
    save();
  } catch (e) { toast('润色失败：' + e.message, 4000); }
  busySection = -1; renderAll();
}

async function translateText(text) {
  const r = await api('/translate', { text, gloss: cfg.gloss === 'none' ? 'zh' : cfg.gloss });
  if (r.error) throw new Error(r.error);
  return r.text.replace(/\s*\n\s*/g, ' ').trim();
}

async function translateSection(i) {
  const body = page().body;
  const spans = sectionSpans(body);
  if (!spans.length) return toast('先分段（行首加【标注】）才能写对照');
  const s = spans[i];
  const text = body.substring(s.textStart, s.textEnd).trim();
  if (!text) return;
  busySection = i; renderDraft();
  try {
    const zh = await translateText(text);
    if (page().body !== body) throw new Error('这段已经变了');
    setBody(ws.current, body.substring(0, s.textEnd) + `\n${ZH_MARK}${zh}` + body.substring(s.end));
  } catch (e) { toast('翻译失败：' + e.message, 4000); }
  busySection = -1; renderAll();
}

async function translateAll() {
  const body = page().body;
  const spans = sectionSpans(body);
  if (!spans.length) return toast('先分段（行首加【标注】）才能写对照');
  busySection = 0; renderDraft();
  try {
    const zhs = await Promise.all(spans.map(s => {
      const t = body.substring(s.textStart, s.textEnd).trim();
      return t ? translateText(t) : '';
    }));
    if (page().body !== body) throw new Error('翻译期间成稿被改动了');
    let out = '';
    spans.forEach((s, k) => {
      out += (k ? '\n' : '') + body.substring(s.start, s.textEnd) + (zhs[k] ? `\n${ZH_MARK}${zhs[k]}` : '');
    });
    setBody(ws.current, out);
  } catch (e) { toast('翻译失败：' + e.message, 4000); }
  busySection = -1; renderAll();
}

// ---------------- 角色库 ----------------

function charCard(c, mine) {
  const insert = (withOutfit) => {
    const words = c.prompt ? c.prompt : [characterTrigger(c), c.looks, withOutfit ? c.outfit : ''].filter(Boolean).join(', ');
    addSection('角色', words);
  };
  return h('div', { class: 'char' },
    h('div', {}, h('span', { class: 'name' }, c.name), c.series ? h('span', { class: 'series' }, c.series) : null,
      c.zh ? h('span', { class: 'series' }, c.zh) : null,
      c.count ? h('span', { class: 'series' }, `${c.count} 张图`) : null,
      mine ? h('span', { class: 'series' }, '我存的') : null),
    c.note ? h('div', { class: 'kv muted' }, c.note) : null,
    c.zh_syn ? h('div', { class: 'kv' }, h('i', {}, '中文叫法：'), c.zh_syn) : null,
    c.alias ? h('div', { class: 'kv' }, h('i', {}, '又叫：'), c.alias.split(',').slice(0, 6).join('、')) : null,
    c.looks ? h('div', { class: 'kv' }, h('i', {}, '外貌：'), c.looks) : null,
    c.outfit ? h('div', { class: 'kv' }, h('i', {}, '服装：'), c.outfit) : null,
    c.prompt ? h('div', { class: 'kv' }, h('i', {}, '提示词：'), c.prompt) : null,
    h('div', { class: 'acts' },
      c.prompt ? h('button', { class: 'small', onclick: () => insert(true) }, '放进成稿')
        : [h('button', { class: 'small', onclick: () => insert(false), title: '触发词 + 外貌，不带衣服' }, '放进成稿（只要外貌）'),
          h('button', { class: 'small', onclick: () => insert(true) }, '放进成稿（含服装）')],
      h('button', { class: 'small ghost', onclick: () => copy(c.prompt || characterTrigger(c)) }, '复制触发词'),
      mine ? h('button', { class: 'small ghost danger', onclick: async () => {
        if (!confirm(`删掉「${c.name}」？`)) return;
        await api('/characters/remove', { name: c.name }); renderMine();
      } }, '删除') : null));
}

/** 往当前页加一段（用户手动的，直接生效）。 */
function addSection(label, text) {
  if (proposalOf(ws.current)) return toast('先处理这一页的待确认改动');
  const body = page().body;
  const line = `【${label}】${text}`;
  setBody(ws.current, body.trim() ? body.replace(/\s+$/, '') + '\n' + line : line);
  switchTab('draft');
  renderAll();
  toast('已放进第 ' + (ws.current + 1) + ' 页');
}

async function searchChars() {
  const q = $('#char-q').value.trim();
  if (!q) return;
  $('#char-results').replaceChildren(h('div', { class: 'muted' }, '查找中…'));
  const r = await api('/characters/search', { queries: [q], limit: 12 });
  const hits = r[0]?.hits || [];
  $('#char-results').replaceChildren(...(hits.length ? hits.map(c => charCard(c, !!c.prompt)) : [h('div', { class: 'muted' }, '没有找到。试试英文名（罗马音），或带上作品名，例如 saber fate')]));
}

async function renderMine() {
  const mine = await api('/characters/mine');
  $('#char-mine').replaceChildren(...(mine.length ? mine.map(c => charCard({ ...c, series: '', looks: '', outfit: '', alias: '' }, true))
    : [h('div', { class: 'muted' }, '还没有。对 Agent 说「把这个角色存进角色库」就会存到这里。')]));
}

function switchTab(tab) {
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('#draft').classList.toggle('hidden', tab !== 'draft');
  $('#chars').classList.toggle('hidden', tab !== 'chars');
  $('#draft-tools').classList.toggle('hidden', tab !== 'draft');
  if (tab === 'chars') renderMine();
}

// ---------------- 对话 ----------------

async function* ndjson(resp) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) { try { yield JSON.parse(line); } catch { /* 半行 */ } }
    }
  }
}

const lastUserMsg = () => [...ws.chat].reverse().find(m => m.role === 'user');

function send(raw) {
  const text = (raw ?? $('#input').value).trim();
  if (!text && !attachments.length) return;
  const msg = { role: 'user', text, time: Date.now() };
  if (attachments.length) msg.images = attachments;
  if (quote) msg.quote = quote;
  if (skillRefs.length) msg.skillIds = skillRefs;
  if (raw === undefined) $('#input').value = '';
  attachments = []; quote = null; skillRefs = [];
  if (streaming) {
    outbox.push(msg);
  } else {
    toolRounds = 0; foundTags = new Set();
    ws.chat.push(msg);
    startReply();
  }
  renderComposerExtra(); renderChat(true);
}

function sendNext() {
  if (streaming || !outbox.length) return;
  const msg = outbox.shift();
  toolRounds = 0; foundTags = new Set();
  ws.chat.push(msg);
  renderComposerExtra();
  startReply();
}

function systemPrompt() {
  const preset = activePreset();
  const p = page();
  const draft = p.body.trim();
  const others = ws.pages.map((x, i) => ({ ...x, i })).filter(x => x.i !== ws.current && x.body.trim());
  const mine = (window.__myChars || []).slice(0, 60).map(c => c.name.replace(/\s+/g, ' '));
  const gloss = cfg.gloss === 'none' ? null : cfg.gloss;
  return [
    preset.systemPrompt,
    draftFormatPrompt(gloss),
    skillPrompt(enabledSkills()),
    skillOn('grilling') ? PLAN_FIRST_PROMPT : '',
    skillOn('character-lib') && mine.length
      ? '【角色库】用户自己存了这些角色，提到它们时先用 <search-character> 查出提示词再写：' + mine.join('、') : '',
    `【成稿区】共 ${ws.pages.length} 页，当前是第 ${ws.current + 1} 页${p.name ? '「' + p.name + '」' : ''}。`,
    draft ? `【当前成稿】\n${p.body}` : '【当前成稿】（空）',
    others.length ? '【其他页】只供参考，不要改动，除非用户点名：\n' + others.map(x =>
      `第 ${x.i + 1} 页${x.name ? '「' + x.name + '」' : ''}：${finalPrompt(x.body).slice(0, 300)}`).join('\n') : '',
    proposalOf(ws.current) ? '【注意】这一页还有一份待用户确认的改动没处理，上面的【当前成稿】是改动前的样子。' : '',
  ].filter(Boolean).join('\n\n');
}

function messageContent(m) {
  const sentSkills = new Set(enabledSkills().map(s => s.id));
  let text = m.text || '';
  if (m.quote) {
    text += `\n\n【用户选中了成稿里的这一段，这次只讨论它】\n${m.quote}\n` +
      `要改它时，<draft> 里只写改后的这一段（原来有标注就保留${cfg.gloss === 'none' ? '' : '，下一行照样跟〔译〕'}），其他段不要写。`;
  }
  const refs = (m.skillIds || []).filter(id => !sentSkills.has(id))
    .map(id => allSkills().find(s => s.id === id)).filter(Boolean);
  if (refs.length) text += '\n\n【用户引用了下面的技能，请按它来完成这次请求】\n' + skillPrompt(refs).split('\n\n').slice(1).join('\n\n');
  return text;
}

async function startReply() {
  const preset = activePreset();
  const history = ws.chat.filter(m => m.role !== 'assistant' || (!m.failed && m.text));
  const messages = [{ role: 'system', content: systemPrompt() }];
  const images = {};
  for (const m of history) {
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: messageContent(m) });
    if (m.images?.length) images[messages.length - 1] = m.images;
  }
  const reply = { role: 'assistant', text: '', by: '', time: Date.now(), streaming: true };
  ws.chat.push(reply);
  const ctrl = new AbortController();
  streaming = { abort: () => ctrl.abort() };
  renderBusy(); renderChat(true);
  try {
    const r = await fetch(API + '/chat', {
      method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'agent', messages, images, temperature: preset.temperature, topP: preset.topP }),
    });
    for await (const ev of ndjson(r)) {
      if (ev.by) reply.by = ev.by;
      if (ev.d) { reply.text += ev.d; scheduleChat(); }
      if (ev.error) { reply.failed = true; reply.error = ev.error; }
    }
  } catch (e) {
    if (e.name === 'AbortError') reply.stopped = true;
    else { reply.failed = true; reply.error = String(e.message || e); }
  }
  delete reply.streaming;
  streaming = null;
  if (!reply.failed && !reply.stopped && reply.text) {
    if (await runTools(reply)) return;
    deliverDrafts(reply);
    await checkTags(reply);
    await deliverCharacters(reply);
    await deliverSkill(reply);
  }
  save(); renderBusy(); renderAll();
  sendNext();
}

/** 回复里要查标签、查角色：替它查完，把结果作为一条消息接上，让它接着写。 */
async function runTools(reply) {
  const prose = splitNewSkill(reply.text).prose;
  const { tagQueries, charQueries } = splitTools(prose);
  const tq = tagQueries.slice(0, 6), cq = skillOn('character-lib') ? charQueries.slice(0, 6) : [];
  if ((!tq.length && !cq.length) || toolRounds >= 3) return false;
  toolRounds++;
  const tool = { role: 'tool', text: '', toolSummary: '正在查…', time: Date.now(), streaming: true };
  ws.chat.push(tool);
  let cancelled = false;
  streaming = { abort: () => { cancelled = true; } };
  renderBusy(); renderChat(true);
  const [tags, chars] = await Promise.all([
    tq.length ? api('/tags/search', { queries: tq, online: cfg.tagSearchOnline }) : [],
    cq.length ? api('/characters/search', { queries: cq }) : [],
  ]);
  streaming = null;
  delete tool.streaming;
  if (cancelled) {
    tool.toolSummary = '已停止';
    save(); renderBusy(); renderAll();
    return true;
  }
  const tagList = Array.isArray(tags) ? tags : [];
  const charList = Array.isArray(chars) ? chars : [];
  for (const r of tagList) for (const hit of r.hits) foundTags.add(hit.tag.toLowerCase().replace(/\s+/g, '_'));
  tool.text = [tagList.length ? formatTagResults(tagList) : '', charList.length ? formatCharacterResults(charList) : '']
    .filter(Boolean).join('\n\n');
  const nTags = tagList.reduce((n, r) => n + r.hits.length, 0);
  const nChars = charList.reduce((n, r) => n + r.hits.length, 0);
  tool.toolSummary = [tagList.length ? `查了 Danbooru 标签 · ${nTags} 个` : '', charList.length ? `查了角色库 · ${nChars} 个` : '']
    .filter(Boolean).join(' · ');
  tool.toolDetails = [
    ...tagList.map(r => `「${r.query}」（${r.source}）：${r.hits.length ? r.hits.map(x => x.tag).join(', ') : '没有找到'}`),
    ...charList.map(r => `「${r.query}」（角色库）：${r.hits.length ? r.hits.map(x => x.name).join(', ') : '没有找到'}`),
  ];
  startReply();
  return true;
}

/** 回复里写完的成稿放进对应的页：空页直接填，有内容的作为待确认改动。 */
function deliverDrafts(reply) {
  const { drafts } = splitDrafts(splitTools(splitNewSkill(reply.text).prose).prose);
  const q = lastUserMsg()?.quote;
  const results = [];
  let first = null;
  for (const d of drafts) {
    if (!d.complete) continue;
    let i = ws.current;
    if (d.page) {
      const n = parseInt(d.page, 10);
      if (Number.isFinite(n) && n >= 1) i = Math.min(n, MAX_PAGES) - 1;
      else i = ws.pages.length; // 「新」之类：另开一页
      if (i >= MAX_PAGES) { results.push('页数到上限了，没放进去'); continue; }
      while (ws.pages.length <= i) ws.pages.push({ name: '', body: '' });
    }
    const p = ws.pages[i];
    if (d.name && (!p.name || d.page)) p.name = d.name.slice(0, 12);
    const text = draftText(d);
    const base = proposalOf(i)?.target ?? p.body;
    let target;
    if (q && i === ws.current && base.includes(q)) target = base.replace(q, text);
    else target = base.trim() ? mergeSections(base, text) : text;
    if (!p.body.trim() && !proposalOf(i)) {
      setBody(i, target);
      results.push(`第 ${i + 1} 页：已写入`);
    } else if (target !== p.body) {
      ws.proposals[i] = { target, title: 'Agent 的改动', from: reply.time };
      results.push(`第 ${i + 1} 页：待确认`);
    } else results.push(`第 ${i + 1} 页：没有变化`);
    if (first === null) first = i;
  }
  if (first !== null) { ws.current = first; editing = false; }
  if (results.length) reply.draftNote = results.join('；');
}

/** 查过标签之后写的成稿：拿词库核对一遍，对不上的列出来（只提醒，不改）。 */
async function checkTags(reply) {
  let k = ws.chat.length - 2;
  let searched = false;
  for (; k >= 0 && ws.chat[k].role !== 'user'; k--) {
    if (ws.chat[k].role === 'tool' && ws.chat[k].text.includes('<tag-results>')) searched = true;
  }
  if (!searched) return;
  const d = splitDrafts(splitTools(splitNewSkill(reply.text).prose).prose).drafts.filter(x => x.complete).at(-1);
  if (!d) return;
  const r = await api('/tags/check', { text: stripSectionLabels(draftText(d)) });
  const unknown = (r.unknown || []).filter(t => !foundTags.has(t));
  if (unknown.length) {
    reply.warn = `${unknown.length} 个标签不在词库里`;
    reply.warnDetails = unknown;
  }
}

async function deliverCharacters(reply) {
  const { saves } = splitTools(splitNewSkill(reply.text).prose);
  if (!saves.length || !skillOn('character-lib')) return;
  const names = [];
  for (const s of saves) {
    const r = await api('/characters/save', s);
    if (r.name) names.push(r.name);
  }
  if (names.length) {
    reply.note = [reply.note, `已存进角色库：${names.join('、')}`].filter(Boolean).join(' · ');
    loadMyChars();
  }
}

async function deliverSkill(reply) {
  const made = splitNewSkill(reply.text);
  if (!made.skill || !made.complete) return;
  const s = parseSkill(made.skill);
  if (!s.name || !s.body) return;
  const custom = cfg.customSkills || [];
  if (custom.some(x => x.name === s.name)) {
    reply.pendingSkill = s;
    reply.note = [reply.note, `已有同名技能「${s.name}」`].filter(Boolean).join(' · ');
    return;
  }
  await saveConfig({ ...cfg, customSkills: [...custom, s] });
  reply.note = [reply.note, `已加入技能：${s.name}`].filter(Boolean).join(' · ');
}

function stop() {
  streaming?.abort();
}

function regenerate() {
  if (streaming) return toast('正在生成，先停止');
  const at = ws.chat.map(m => m.role).lastIndexOf('user');
  if (at < 0) return toast('还没有可以重新运行的消息');
  ws.chat = ws.chat.slice(0, at + 1);
  toolRounds = 0; foundTags = new Set();
  startReply();
}

// ---------------- 对话界面 ----------------

let chatPending = false;
function scheduleChat() {
  if (chatPending) return;
  chatPending = true;
  requestAnimationFrame(() => { chatPending = false; renderChat(); });
}

function renderChat(forceBottom = false) {
  const box = $('#chat');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (!ws.chat.length) {
    box.replaceChildren(h('div', { class: 'empty', html:
      '告诉 Agent 你想要什么画面，例如：<br>「给初音未来画一张雨夜街头的半身图」<br>「把成稿转成 Danbooru 标签」<br>' +
      '<span class="muted">先在右上角「⚙ 设置」里添加一个模型接口。</span>' }));
    return;
  }
  const lastAssistant = ws.chat.map(m => m.role).lastIndexOf('assistant');
  box.replaceChildren(...ws.chat.map((m, i) => renderMessage(m, i === lastAssistant && i === ws.chat.length - 1)));
  if (forceBottom || nearBottom) box.scrollTop = box.scrollHeight;
}

function renderMessage(m, isLast) {
  if (m.role === 'user') {
    return h('div', { class: 'msg user' }, h('div', { class: 'bubble' },
      m.quote ? h('div', { class: 'quote' }, '讨论这一段：' + m.quote.split('\n')[0].slice(0, 80)) : null,
      m.images?.length ? h('div', { class: 'imgs' }, ...m.images.map(src => h('img', { src }))) : null,
      m.skillIds?.length ? h('div', { class: 'quote' }, '@' + m.skillIds.map(id => allSkills().find(s => s.id === id)?.name || id).join(' @')) : null,
      m.text));
  }
  if (m.role === 'tool') {
    const det = h('div', { class: 'details hidden' }, (m.toolDetails || []).join('\n'));
    return h('div', { class: 'tool-line' }, h('span', {
      class: 'chip click' + (m.streaming ? ' typing' : ''),
      title: '点开看查到了什么', onclick: () => det.classList.toggle('hidden'),
    }, '🔍 ' + (m.toolSummary || '')), det);
  }
  const prose = visibleProse(m.text);
  const opts = !m.streaming && isLast && !streaming ? splitOptions(splitDrafts(splitTools(splitNewSkill(m.text).prose).prose).prose) : null;
  const drafts = splitDrafts(splitTools(splitNewSkill(m.text).prose).prose).drafts;
  const bubble = h('div', { class: 'bubble' + (m.streaming && !m.text ? ' typing' : '') });
  bubble.innerHTML = prose ? md(prose) : '';
  if (m.streaming && m.text) bubble.lastElementChild?.classList.add('typing');
  if (!prose && !m.streaming && drafts.length) bubble.innerHTML = '<p class="muted">（只给了成稿）</p>';
  if (drafts.length) {
    // 待确认的改动处理掉之后，旧消息上的标记跟着变；被后面的回复换掉了的也说一声
    const mine = i => proposalOf(i) && (!proposalOf(i).from || proposalOf(i).from === m.time);
    const note = (m.draftNote || '成稿').replace(/第 (\d+) 页：待确认/g,
      (s, n) => (mine(n - 1) ? s : proposalOf(n - 1) ? `第 ${n} 页：见后面的改动` : `第 ${n} 页：已处理`));
    bubble.append(h('div', {}, h('span', { class: 'chip' + (note.includes('待确认') ? ' warn' : ' ok') },
      '📝 ' + (m.streaming || drafts.some(d => !d.complete) ? '正在写成稿…' : note))));
    // 这条回复留下的待确认改动：在这里就能采纳、驳回
    const pending = m.streaming ? [] : Object.keys(ws.proposals).map(Number)
      .filter(i => proposalOf(i)?.from === m.time).sort((a, b) => a - b);
    if (pending.length) {
      bubble.append(h('div', { class: 'options' },
        ...pending.flatMap(i => [
          pending.length > 1 ? h('span', { class: 'muted' }, `第 ${i + 1} 页`) : null,
          h('button', { class: 'primary', onclick: () => acceptProposal(i) }, '✓ 采纳'),
          h('button', { onclick: () => rejectProposal(i) }, '驳回'),
          h('button', { class: 'ghost', title: '在左边按段看改了什么，可以逐段采纳',
            onclick: () => { ws.current = i; editing = false; switchTab('draft'); save(); renderAll(); } }, '逐段看'),
        ]).filter(Boolean),
        pending.length > 1 ? h('button', { class: 'primary', onclick: () => pending.forEach(acceptProposal) }, '全部采纳') : null,
      ));
    }
  }
  if (m.warn) {
    const det = h('div', { class: 'details hidden' }, m.warnDetails.join(', '));
    bubble.append(h('span', { class: 'chip click warn', onclick: () => det.classList.toggle('hidden'),
      title: '词库不全，对不上的也可能是真的标签；点开看是哪几个' }, '⚠ ' + m.warn), det);
  }
  if (m.note) bubble.append(h('span', { class: 'chip ok' }, m.note));
  if (m.pendingSkill) {
    bubble.append(h('button', { class: 'small', onclick: async () => {
      const skill = m.pendingSkill;
      await saveConfig({ ...cfg, customSkills: (cfg.customSkills || []).map(x => x.name === skill.name ? skill : x) });
      delete m.pendingSkill; m.note = `已替换技能：${skill.name}`; save(); renderChat();
    } }, '替换同名技能'));
  }
  if (m.stopped) bubble.append(h('div', { class: 'muted' }, '（已停止）'));
  if (m.failed) bubble.append(h('div', { class: 'failed' }, '[出错] ' + (m.error || '')));
  if (opts?.options.length || opts?.sections) bubble.append(renderOptions(opts));
  return h('div', { class: 'msg' }, m.by ? h('div', { class: 'by' }, m.by) : null, bubble);
}

function renderOptions(opts) {
  if (!opts.multi) {
    return h('div', { class: 'options' }, ...opts.options.map(o => h('button', { onclick: () => send(o) }, o)));
  }
  const items = opts.sections
    ? sectionSpans(page().body).map(s => s.label).filter(Boolean)
    : opts.options;
  if (!items.length) return h('div', { class: 'options' }, h('button', { onclick: () => send('全部') }, '全部'));
  const boxes = items.map(o => {
    const cb = h('input', { type: 'checkbox', value: o });
    return { cb, el: h('label', {}, cb, o) };
  });
  return h('div', { class: 'options' }, ...boxes.map(b => b.el),
    h('button', { onclick: () => boxes.forEach(b => { b.cb.checked = true; }) }, '全选'),
    h('button', { onclick: () => {
      const picked = boxes.filter(b => b.cb.checked).map(b => b.cb.value);
      if (!picked.length) return toast('先勾选');
      send(picked.length === items.length ? '全部' : picked.join('、'));
    } }, '确定'));
}

function renderBusy() {
  $('#stop').classList.toggle('hidden', !streaming);
  $('#status').textContent = streaming ? (ws.chat.at(-1)?.role === 'tool' ? '正在查词库…' : '正在生成…') : '';
  $('#regen').disabled = !!streaming;
}

function renderComposerExtra() {
  const box = $('#composer-extra');
  box.replaceChildren(...[
    quote ? h('span', { class: 'chip' }, '讨论：' + quote.split('\n')[0].slice(0, 30),
      h('button', { class: 'small ghost', onclick: () => { quote = null; renderComposerExtra(); } }, '×')) : null,
    ...skillRefs.map(id => h('span', { class: 'chip' }, '@' + (allSkills().find(s => s.id === id)?.name || id),
      h('button', { class: 'small ghost', onclick: () => { skillRefs = skillRefs.filter(x => x !== id); renderComposerExtra(); } }, '×'))),
    ...attachments.map((src, k) => h('span', { class: 'att' }, h('img', { src }),
      h('button', { onclick: () => { attachments.splice(k, 1); renderComposerExtra(); } }, '×'))),
    ...outbox.map((m, k) => h('span', { class: 'queued' }, '排队：' + m.text.slice(0, 20),
      h('button', { class: 'small ghost', onclick: () => { outbox.splice(k, 1); renderComposerExtra(); } }, '×'))),
  ].filter(Boolean));
}

/** 图片缩到最长边 1280，存成 JPEG，免得工作台文件太大。 */
function readImage(file) {
  return new Promise((resolve, reject) => {
    if (file.size > 10 * 1024 * 1024) return reject(new Error('图片超过 10 MB'));
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.88));
      };
      img.onerror = () => reject(new Error('读不了这张图'));
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

async function addFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    try { attachments.push(await readImage(f)); } catch (e) { toast(e.message); }
  }
  renderComposerExtra();
}

// ---------------- 设置 ----------------

let settingsTab = 'api';
let draftCfg = null;

function openSettings(tab) {
  draftCfg = JSON.parse(JSON.stringify(cfg));
  settingsTab = tab || settingsTab;
  renderSettings();
  $('#modal').classList.remove('hidden');
}

function closeSettings() { $('#modal').classList.add('hidden'); draftCfg = null; }

function renderSettings() {
  const tabs = [['api', '模型接口'], ['agent', 'Agent'], ['skills', '技能'], ['other', '其他']];
  const content = h('div', { class: 'content' });
  ({ api: settingsApi, agent: settingsAgent, skills: settingsSkills, other: settingsOther })[settingsTab](content);
  $('#modal').replaceChildren(h('div', { class: 'dialog' },
    h('header', {}, h('b', {}, '设置'), h('button', { class: 'ghost', onclick: closeSettings }, '×')),
    h('div', { class: 'body' },
      h('nav', {}, ...tabs.map(([id, name]) => h('button', { class: id === settingsTab ? 'on' : '', onclick: () => { settingsTab = id; renderSettings(); } }, name))),
      content),
    h('footer', {},
      h('span', { class: 'grow muted' }, 'API Key 只存在本机 ComfyUI 的 user/default/penna 里，不会发回网页。'),
      h('button', { onclick: closeSettings }, '放弃'),
      h('button', { class: 'primary', onclick: async () => {
        await saveConfig(draftCfg); toast('已保存'); closeSettings(); renderAll();
      } }, '保存'))));
}

function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('small', { class: 'muted' }, hint) : null);
}
function bindInput(el, obj, key, fn) {
  el.value = obj[key] ?? '';
  el.addEventListener('input', () => { obj[key] = el.type === 'number' ? parseFloat(el.value) : el.value; fn?.(); });
  return el;
}

function settingsApi(box) {
  const llms = draftCfg.llms;
  const pin = (key) => {
    const sel = h('select', {}, h('option', { value: '' }, '按下面的顺序'), ...llms.map(l => h('option', { value: l.id }, l.name || '(未命名)')));
    sel.value = draftCfg[key] || '';
    sel.addEventListener('change', () => { draftCfg[key] = sel.value || null; });
    return sel;
  };
  box.append(
    h('div', { class: 'grid2' }, field('Agent 对话优先用', pin('activeLlmId')), field('润色优先用', pin('polishLlmId'))),
    h('div', { class: 'hint', html:
      'OpenAI 兼容接口（DeepSeek、硅基流动、OpenRouter、Kimi、本地 Ollama / LM Studio 等）选 OpenAI；Gemini 官方和 Vertex AI 选 Google。<br>' +
      'Base URL 只写到版本号那一层（通常以 /v1 结尾），例如 https://api.deepseek.com/v1、http://127.0.0.1:11434/v1。<br>' +
      '模型可以填好几个，用逗号隔开；前一个失败了自动换下一个，下面的接口也按顺序接力。' }),
  );
  llms.forEach((l, idx) => {
    const models = h('div', { class: 'models-list' });
    const status = h('small', { class: 'muted' });
    const modelInput = bindInput(h('input', { type: 'text', placeholder: '例如 deepseek-chat' }), l, 'model');
    const keyInput = h('input', { type: 'password', placeholder: l.hasKey ? '已保存，留空不改' : '没有就留空（本地模型不用）', autocomplete: 'off' });
    keyInput.value = l.key || '';
    keyInput.addEventListener('input', () => { l.key = keyInput.value; });
    const proto = h('select', {}, h('option', { value: 'openai' }, 'OpenAI'), h('option', { value: 'google' }, 'Google'));
    proto.value = l.protocol || 'openai';
    proto.addEventListener('change', () => { l.protocol = proto.value; });
    const enabled = h('input', { type: 'checkbox' });
    enabled.checked = l.enabled !== false;
    enabled.addEventListener('change', () => { l.enabled = enabled.checked; });
    box.append(h('div', { class: 'card' },
      h('div', { class: 'head' },
        proto,
        bindInput(h('input', { type: 'text', placeholder: '显示名称，例如 DeepSeek' }), l, 'name'),
        h('label', { class: 'muted' }, enabled, ' 启用'),
        h('button', { class: 'small ghost', disabled: idx === 0, onclick: () => { llms.splice(idx - 1, 0, llms.splice(idx, 1)[0]); renderSettings(); } }, '↑'),
        h('button', { class: 'small ghost danger', onclick: () => { llms.splice(idx, 1); renderSettings(); } }, '删除')),
      field('Base URL', bindInput(h('input', { type: 'text', placeholder: proto.value === 'google' ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://api.openai.com/v1' }), l, 'baseUrl')),
      h('div', { class: 'grid2' }, field('模型名称', modelInput), field('API Key', keyInput)),
      h('div', { class: 'row' },
        h('button', { class: 'small', onclick: async () => {
          status.textContent = '拉取中…';
          const r = await api('/models', { ...l });
          if (r.error) { status.textContent = r.error; return; }
          status.textContent = `${r.models.length} 个，点一下加进模型名称`;
          models.replaceChildren(...r.models.map(m => h('button', { onclick: () => {
            const list = (l.model || '').split(/[,，]/).map(x => x.trim()).filter(Boolean);
            if (!list.includes(m)) list.push(m);
            l.model = list.join(', '); modelInput.value = l.model;
          } }, m)));
        } }, '拉取模型'),
        h('button', { class: 'small', onclick: async () => {
          status.textContent = '测试中…';
          try {
            const r = await fetch(API + '/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ test: { ...l }, messages: [{ role: 'user', content: '回复"连接正常"四个字' }], temperature: 0 }) });
            let text = '', err = '';
            for await (const ev of ndjson(r)) { if (ev.d) text += ev.d; if (ev.error) err = ev.error; }
            status.textContent = text ? `连接正常：${text.slice(0, 40)}` : (err || '没有回复');
          } catch (e) { status.textContent = String(e); }
        } }, '测试连接'),
        status),
      models));
  });
  box.append(h('button', { onclick: () => {
    llms.push({ id: Math.random().toString(36).slice(2, 10), name: '', protocol: 'openai', baseUrl: '', model: '', enabled: true });
    renderSettings();
  } }, '＋ 添加接口'));
}

function settingsAgent(box) {
  draftCfg.presets ||= {};
  const sel = h('select', {}, ...FACTORY_PRESETS.map(p => h('option', { value: p.id }, p.name)));
  sel.value = draftCfg.presetId || 'anime';
  const id = sel.value;
  const base = FACTORY_PRESETS.find(p => p.id === id);
  const cur = { ...base, ...(draftCfg.presets[id] || {}) };
  const keep = () => { draftCfg.presets[id] = { systemPrompt: cur.systemPrompt, temperature: cur.temperature, topP: cur.topP }; };
  sel.addEventListener('change', () => { draftCfg.presetId = sel.value; renderSettings(); });
  const sys = bindInput(h('textarea', { rows: 14 }), cur, 'systemPrompt', keep);
  box.append(
    field('当前预设', sel, '预设决定 Agent 的写法（自然语言还是标签、什么风格）；系统提示后面会自动接上成稿格式和技能。'),
    field('系统提示', sys),
    h('div', { class: 'grid2' },
      field('温度（0~2）', bindInput(h('input', { type: 'number', step: '0.1', min: '0', max: '2' }), cur, 'temperature', keep)),
      field('Top P（0.1~1，1 表示不限制）', bindInput(h('input', { type: 'number', step: '0.05', min: '0.1', max: '1' }), cur, 'topP', keep))),
    h('button', { class: 'small', onclick: () => { delete draftCfg.presets[id]; renderSettings(); } }, '恢复这个预设的默认内容'),
  );
}

function settingsSkills(box) {
  draftCfg.disabledSkills ||= [];
  draftCfg.customSkills ||= [];
  const toggle = (sid) => {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = !draftCfg.disabledSkills.includes(sid);
    cb.addEventListener('change', () => {
      draftCfg.disabledSkills = draftCfg.disabledSkills.filter(x => x !== sid);
      if (!cb.checked) draftCfg.disabledSkills.push(sid);
    });
    return cb;
  };
  box.append(h('div', { class: 'hint' }, '开着的技能会一直带给 Agent，它按你的要求自己挑着用；也可以在输入框下面用「@ 技能」点名。关掉「画面规划」，Agent 就不会先问再写。'));
  for (const s of BUILTIN_SKILLS) {
    box.append(h('div', { class: 'skill' }, toggle(s.id), h('div', { class: 'd' }, s.name, h('small', {}, s.description))));
  }
  box.append(h('h4', {}, '我的技能'));
  draftCfg.customSkills.forEach((s, k) => {
    box.append(h('div', { class: 'skill' }, toggle('custom:' + s.name),
      h('div', { class: 'd' }, s.name, h('small', {}, s.description || '')),
      h('button', { class: 'small ghost', onclick: () => {
        const body = prompt('技能正文', s.body);
        if (body !== null) { s.body = body; renderSettings(); }
      } }, '改'),
      h('button', { class: 'small ghost danger', onclick: () => { draftCfg.customSkills.splice(k, 1); renderSettings(); } }, '删除')));
  });
  const file = h('input', { type: 'file', accept: '.md,.txt', hidden: true });
  file.addEventListener('change', async () => {
    for (const f of file.files) {
      const s = parseSkill(await f.text());
      if (!s.name) s.name = f.name.replace(/\.(md|txt)$/i, '');
      draftCfg.customSkills = draftCfg.customSkills.filter(x => x.name !== s.name).concat(s);
    }
    renderSettings();
  });
  box.append(file,
    h('div', { class: 'row' },
      h('button', { class: 'small', onclick: () => file.click() }, '导入 SKILL.md'),
      h('button', { class: 'small', onclick: () => {
        const name = prompt('技能名字'); if (!name) return;
        const description = prompt('什么时候用（一句话）', '') || '';
        const body = prompt('正文（写给 Agent 看的做法）', '') || '';
        draftCfg.customSkills.push({ name: name.trim(), description, body }); renderSettings();
      } }, '新建'),
      h('span', { class: 'muted' }, '也可以对 Agent 说「帮我写一个技能」，写好自动加进来。')));
}

function settingsOther(box) {
  const online = h('input', { type: 'checkbox' });
  online.checked = draftCfg.tagSearchOnline !== false;
  online.addEventListener('change', () => { draftCfg.tagSearchOnline = online.checked; });
  const gloss = h('select', {},
    h('option', { value: 'zh' }, '简体中文'), h('option', { value: 'zh-Hant' }, '繁體中文'),
    h('option', { value: 'ja' }, '日本語'), h('option', { value: 'none' }, '不要对照'));
  gloss.value = draftCfg.gloss || 'zh';
  gloss.addEventListener('change', () => { draftCfg.gloss = gloss.value; });
  box.append(
    h('label', { class: 'field' }, h('span', {}, 'Danbooru 标签搜索'),
      h('label', {}, online, ' 先问在线的 DanbooruSearch（懂意思，十几秒），连不上再查本地词库'),
      h('small', { class: 'muted' }, '本地词库：13.6 万个标签，带中文名、中文同义词、英文旧名和日文别名（Penna 和 danbooru-zh-dict 合并而成）。')),
    field('成稿每段的对照语言', gloss, 'Agent 写成稿时在每段下面跟一行这种语言的翻译（〔译〕），只给你看，不进最终提示词。'),
  );
}

// ---------------- 杂项渲染 ----------------

function renderPresetSelect() {
  const sel = $('#preset');
  sel.replaceChildren(...presets().map(p => h('option', { value: p.id }, p.name)));
  sel.value = activePreset().id;
}

function renderSkillSelect() {
  const sel = $('#skill-ref');
  sel.replaceChildren(h('option', { value: '' }, '@ 技能'), ...allSkills().map(s => h('option', { value: s.id, title: s.description }, s.name)));
}

function renderQuick() {
  $('#quick').replaceChildren(...QUICK_ACTIONS.map(a => h('button', {
    onclick: () => { const t = $('#input'); t.value = (t.value.trim() ? t.value.trim() + ' ' : '') + a.prompt; t.focus(); },
  }, a.label)));
}

function renderAll() {
  renderPages();
  renderDraftTools();
  renderDraft();
  renderFinal();
  renderChat();
  renderBusy();
  renderComposerExtra();
}

async function loadMyChars() {
  window.__myChars = await api('/characters/mine').catch(() => []);
}

// ---------------- 启动 ----------------

async function boot() {
  [cfg, ws] = await Promise.all([api('/config'), api('/workspace')]);
  ws = normalizeWorkspace(ws);
  loadMyChars();
  renderPresetSelect();
  renderSkillSelect();
  renderQuick();
  renderAll();
  if (!cfg.llms.length) setTimeout(() => openSettings('api'), 300);

  $('#preset').addEventListener('change', e => saveConfig({ ...cfg, presetId: e.target.value }));
  $('#open-settings').addEventListener('click', () => openSettings());
  document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#join').addEventListener('change', renderFinal);
  $('#copy-final').addEventListener('click', () => copy(finalPrompt(page().body, $('#join').value)));
  $('#char-go').addEventListener('click', searchChars);
  $('#char-q').addEventListener('keydown', e => { if (e.key === 'Enter') searchChars(); });
  $('#send').addEventListener('click', () => send());
  $('#stop').addEventListener('click', stop);
  $('#regen').addEventListener('click', regenerate);
  $('#new-chat').addEventListener('click', () => {
    if (streaming) return toast('正在生成，先停止');
    if (ws.chat.length && !confirm('清空对话？成稿不动。')) return;
    ws.chat = []; outbox = []; save(); renderAll();
  });
  $('#attach').addEventListener('click', () => $('#file').click());
  $('#file').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
  $('#skill-ref').addEventListener('change', e => {
    if (e.target.value && !skillRefs.includes(e.target.value)) skillRefs.push(e.target.value);
    e.target.value = ''; renderComposerExtra();
  });
  const input = $('#input');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  input.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  const right = document.querySelector('.right');
  right.addEventListener('dragover', e => e.preventDefault());
  right.addEventListener('drop', e => { e.preventDefault(); addFiles(e.dataTransfer.files); });
  $('#modal').addEventListener('mousedown', e => { if (e.target.id === 'modal') closeSettings(); });
}

boot().catch(e => {
  document.body.innerHTML = `<div class="empty">Penna 启动失败：${esc(e.message || e)}<br>确认 ComfyUI 已重启并加载了 comfyui-penna。</div>`;
});
