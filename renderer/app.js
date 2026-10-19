'use strict';

/* ==================== 全局状态 ==================== */
let state = {
  tasks: [],
  settings: {},
  startup: false
};
let currentFilter = 'upcoming';
let currentTab = 'plan';
let editingTaskId = null;
let parsedTasks = []; // 解析结果（待确认导入）
let pickedFileContent = null;
let batchMode = false;   // 是否处于批量管理模式
let selectedIds = new Set(); // 批量模式下选中的任务 id
let managing = false;    // 极简模式「管理」模式开关
let colRatio = 0.5;      // 左列占宽比例
let rowRatioLeft = 0.5;  // 左列上 pane 占高比例
let rowRatioRight = 0.5; // 右列上 pane 占高比例

const REPEAT_LABEL = { none: '不重复', daily: '每天', weekly: '每周', monthly: '每月', yearly: '每年' };
const WD = ['日', '一', '二', '三', '四', '五', '六'];

/* ==================== 工具函数 ==================== */
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function pad(n) { return String(n).padStart(2, '0'); }

function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToIso(str) {
  if (!str) return null;
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function fmt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function repeatSummary(t) {
  if (!t.repeat || t.repeat === 'none') return null;
  const base = REPEAT_LABEL[t.repeat] || t.repeat;
  let s;
  if (t.repeat === 'weekly' && t.repeatWeekdays && t.repeatWeekdays.length) {
    const days = t.repeatWeekdays.slice().sort((a, b) => a - b).map((n) => '周' + WD[n]).join('、');
    s = `每${t.repeatInterval > 1 ? t.repeatInterval + '周' : '周'} ${days}`;
  } else {
    s = `每${t.repeatInterval > 1 ? t.repeatInterval + '' : ''}${base}`;
  }
  if (t.repeatEnds) s += ' · 至 ' + fmt(t.repeatEnds);
  return s;
}

/* ==================== 初始化 ==================== */
async function refreshState() {
  const s = await window.api.getState();
  state = s;
  renderTasks();
  renderMinimal();
  fillSettings();
}

/* ==================== 标签页切换 ==================== */
function switchTab(tab) {
  currentTab = tab;
  $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + tab));
}

/* ==================== 极简模式（今日计划）渲染 ==================== */
const PANE_TYPES = { today: '今日', all: '全部', upcoming: '未来', overdue: '已过期' };

function defaultPanes() {
  return [
    { type: 'today', days: 7 },
    { type: 'all', days: 7 },
    { type: 'upcoming', days: 7 },
    { type: 'overdue', days: 7 }
  ];
}

function renderMinimal() {
  const now = new Date();
  const week = ['日', '一', '二', '三', '四', '五', '六'];
  const dateEl = $('#today-date');
  if (dateEl) dateEl.textContent = `${now.getMonth() + 1}月${now.getDate()}日 周${week[now.getDay()]}`;
  renderMinimalGrid();
}

function computeLayout() {
  const panes = (state.settings.panes && state.settings.panes.length === 4)
    ? state.settings.panes
    : defaultPanes();
  const leftSlots = [0, 1].map((s) => ({ cfg: panes[s], slot: s })).filter((x) => x.cfg && x.cfg.type);
  const rightSlots = [2, 3].map((s) => ({ cfg: panes[s], slot: s })).filter((x) => x.cfg && x.cfg.type);

  let left = [], right = [];
  if (leftSlots.length === 0 && rightSlots.length === 0) {
    // 全空
  } else if (leftSlots.length === 0) {
    // 左列空了，右列的块重新分配到左右对半
    if (rightSlots.length >= 2) { left = [rightSlots[0]]; right = [rightSlots[1]]; }
    else { left = [rightSlots[0]]; }
  } else if (rightSlots.length === 0) {
    if (leftSlots.length >= 2) { left = [leftSlots[0]]; right = [leftSlots[1]]; }
    else { left = [leftSlots[0]]; }
  } else {
    left = leftSlots;
    right = rightSlots;
  }
  return { left, right, panes };
}

function renderMinimalGrid() {
  const layout = $('#minimal-layout');
  if (!layout) return;
  const { left, right } = computeLayout();
  layout.innerHTML = '';

  if (left.length === 0 && right.length === 0) {
    layout.appendChild(buildFullEmpty());
    return;
  }

  const leftCol = buildColumn(left, rowRatioLeft);
  if (right.length === 0) {
    layout.appendChild(leftCol);
  } else {
    const rightCol = buildColumn(right, rowRatioRight);
    layout.appendChild(leftCol);
    layout.appendChild(buildSplitterV());
    layout.appendChild(rightCol);
    leftCol.style.flexGrow = colRatio;
    rightCol.style.flexGrow = 1 - colRatio;
    leftCol.style.flexBasis = '0';
    rightCol.style.flexBasis = '0';
  }

  initSplitters();
  initPaneDragSwap();
}

function buildColumn(items, rowRatio) {
  const col = document.createElement('div');
  col.className = 'minimal-col';
  items.forEach((item, i) => {
    if (i > 0) col.appendChild(buildSplitterH());
    col.appendChild(buildPane(item.cfg, item.slot));
  });
  const panes = col.querySelectorAll('.pane');
  if (panes.length === 1) {
    panes[0].style.flexGrow = 1;
    panes[0].style.flexBasis = '0';
  } else if (panes.length >= 2) {
    panes[0].style.flexGrow = rowRatio;
    panes[0].style.flexBasis = '0';
    panes[1].style.flexGrow = 1 - rowRatio;
    panes[1].style.flexBasis = '0';
  }
  return col;
}

function buildFullEmpty() {
  const empty = document.createElement('div');
  empty.className = 'pane-empty full';
  const wrap = document.createElement('div');
  wrap.className = 'add-pane-wrap';
  const label = document.createElement('div');
  label.className = 'add-pane-label';
  label.textContent = '所有区域已删除，选择要添加的区域类型：';
  const group = document.createElement('div');
  group.className = 'add-pane-types';
  Object.entries(PANE_TYPES).forEach(([type, name]) => {
    const b = document.createElement('button');
    b.textContent = name;
    b.addEventListener('click', () => addPane(type));
    group.appendChild(b);
  });
  wrap.appendChild(label);
  wrap.appendChild(group);
  empty.appendChild(wrap);
  return empty;
}

function paneTitle(cfg) {
  if (cfg.type === 'upcoming') return `未来 ${cfg.days || 7} 天`;
  return PANE_TYPES[cfg.type] || '区域';
}

function buildPane(cfg, index) {
  const pane = document.createElement('div');
  pane.className = 'pane';
  pane.dataset.slot = index;

  const header = document.createElement('div');
  header.className = 'pane-header';

  const title = document.createElement('h2');
  title.className = 'pane-title';
  title.textContent = paneTitle(cfg);

  const controls = document.createElement('div');
  controls.className = 'pane-controls';

  const sel = document.createElement('select');
  for (const [v, label] of Object.entries(PANE_TYPES)) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = label;
    if (v === cfg.type) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    cfg.type = sel.value;
    savePanes();
    renderMinimalGrid();
  });

  const daysWrap = document.createElement('span');
  daysWrap.className = 'days-wrap';
  if (cfg.type === 'upcoming') {
    const daysInput = document.createElement('input');
    daysInput.type = 'number';
    daysInput.min = 1;
    daysInput.max = 365;
    daysInput.value = cfg.days || 7;
    daysInput.addEventListener('change', () => {
      cfg.days = Math.max(1, parseInt(daysInput.value, 10) || 7);
      savePanes();
      renderMinimalGrid();
    });
    daysWrap.appendChild(daysInput);
    daysWrap.appendChild(document.createTextNode(' 天'));
  }

  const del = document.createElement('button');
  del.className = 'pane-del';
  del.textContent = '✕';
  del.title = '删除此区域';
  del.addEventListener('click', () => {
    cfg.type = null;
    savePanes();
    renderMinimalGrid();
  });

  controls.appendChild(sel);
  controls.appendChild(daysWrap);
  controls.appendChild(del);

  header.appendChild(title);
  header.appendChild(controls);
  pane.appendChild(header);

  const body = document.createElement('div');
  body.className = 'pane-body';
  const tasks = getPaneTasks(cfg);
  if (tasks.length === 0) {
    body.innerHTML = '<div class="mini-empty">暂无任务</div>';
  } else {
    tasks.forEach((t) => body.appendChild(buildMiniCard(t, cfg.type)));
  }
  pane.appendChild(body);

  return pane;
}

async function addPane(type) {
  const panes = (state.settings.panes && state.settings.panes.length === 4) ? state.settings.panes : defaultPanes();
  const emptyIdx = panes.findIndex((p) => !p || !p.type);
  if (emptyIdx === -1) {
    alert('最多 4 个区域，请先删除一个再添加。');
    return;
  }
  panes[emptyIdx] = { type: type || 'today', days: 7 };
  state.settings.panes = panes;
  await savePanes();
  renderMinimalGrid();
}

function getPaneTasks(cfg) {
  const now = Date.now();
  const days = cfg.days || 7;
  const horizon = now + days * 86400000;

  const entireDone = (t) => !!t.completed || !!t.finished;
  const beforeEnd = (t) => !t.repeatEnds || new Date(t.repeatEnds).getTime() > now;

  let tasks = [];
  switch (cfg.type) {
    case 'today':
      tasks = state.tasks.filter((t) => {
        if (!t.isToday) return false;
        if (entireDone(t)) return beforeEnd(t); // 整个完成：截止前变灰显示
        return true;
      });
      break;
    case 'all':
      tasks = state.tasks.filter((t) => entireDone(t) ? beforeEnd(t) : true);
      break;
    case 'upcoming':
      tasks = state.tasks.filter((t) => {
        if (entireDone(t)) return false; // 整个完成：未来消失
        if (t.targetCount) return t.remaining > 0;
        const ts = new Date(t.nextReminder || t.dueAt || 0).getTime();
        return ts >= now && ts <= horizon;
      });
      break;
    case 'overdue':
      tasks = state.tasks.filter((t) => !t.done && !entireDone(t) && t.dueAt && new Date(t.dueAt).getTime() < now);
      break;
    default:
      tasks = [];
  }
  // 排序：未完成（未打卡）优先排最上面
  tasks.sort((a, b) => {
    const ad = !!a.done || entireDone(a);
    const bd = !!b.done || entireDone(b);
    if (ad !== bd) return ad ? 1 : -1;
    const ta = new Date(a.nextReminder || a.dueAt || 0).getTime() || Number.MAX_SAFE_INTEGER;
    const tb = new Date(b.nextReminder || b.dueAt || 0).getTime() || Number.MAX_SAFE_INTEGER;
    return ta - tb;
  });
  return tasks;
}

function buildMiniCard(t, paneType) {
  const entireDone = !!t.completed || !!t.finished;
  const isTodayPane = paneType === 'today';
  const gray = isTodayPane ? (!!t.done || entireDone) : entireDone;
  const checked = isTodayPane ? !!t.done : entireDone;
  const card = document.createElement('div');
  card.className = 'mini-card' + (gray ? ' done' : '');

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'mini-check';
  check.checked = checked;
  check.addEventListener('change', async () => {
    if (isTodayPane) {
      await window.api.toggleTask(t.id); // 今日：打卡/撤销今天
    } else {
      if (check.checked) {
        await window.api.checkTask(t.id); // 未来/全部：打卡下一个未打卡日期
      } else if (confirm('取消完成？任务将恢复未完成状态。')) {
        await window.api.uncompleteTask(t.id);
      }
    }
    await refreshState();
  });

  const body = document.createElement('div');
  body.className = 'mini-body';
  const title = document.createElement('div');
  title.className = 'mini-title';
  title.textContent = t.title;
  const meta = document.createElement('div');
  meta.className = 'mini-meta';
  if (t.dueAt) {
    const s = document.createElement('span');
    s.textContent = fmt(t.dueAt);
    meta.appendChild(s);
  }
  const r = repeatSummary(t);
  if (r) {
    const s = document.createElement('span');
    s.textContent = '🔁 ' + r;
    meta.appendChild(s);
  }
  body.appendChild(title);
  body.appendChild(meta);

  // 打卡次数 ×N 加到 meta
  if (t.targetCount) {
    const tag = document.createElement('span');
    tag.className = 'ongoing-tag' + (t.finished ? ' reached' : '');
    tag.textContent = t.finished ? '已完成' : `×${t.remaining != null ? t.remaining : 0}`;
    meta.appendChild(tag);
  }

  // 「已完成」按钮（持续任务专属）
  let doneBtn = null;
  if (t.isOngoing) {
    const isDone = entireDone;
    doneBtn = document.createElement('button');
    doneBtn.className = 'ongoing-done' + (isDone ? ' checked' : '');
    doneBtn.textContent = isDone ? '已完成 ✓' : '标记完成';
    doneBtn.addEventListener('click', async () => {
      if (isDone) {
        openRemainModal(t); // 已完成 → 弹窗输入剩余量
      } else {
        await window.api.completeTask(t.id);
        await refreshState();
      }
    });
  }

  card.appendChild(check);
  card.appendChild(body);
  if (doneBtn) card.appendChild(doneBtn);

  return card;
}

/* ==================== 剩余量输入弹窗（部分撤销） ==================== */
let remainTaskId = null;

function openRemainModal(t) {
  remainTaskId = t.id;
  let total = t.targetCount;
  let unit = '次';
  if (!total && t.dueAt && t.repeatEnds) {
    total = Math.floor((new Date(t.repeatEnds).getTime() - new Date(t.dueAt).getTime()) / 86400000) + 1;
    unit = '天';
  }
  const input = $('#remain-input');
  input.max = total || 0;
  input.value = total || 0;
  $('#remain-hint').textContent = `还剩多少没完成？（最大 ${total} ${unit}）`;
  $('#remain-modal').classList.remove('hidden');
  setTimeout(() => input.focus(), 50);
}

function closeRemainModal() {
  $('#remain-modal').classList.add('hidden');
  remainTaskId = null;
}

async function savePanes() {
  await window.api.updateSettings({ panes: state.settings.panes });
}

function toggleManage() {
  managing = !managing;
  document.body.classList.toggle('managing', managing);
  $('#btn-manage').classList.toggle('active', managing);
  $('#btn-manage').textContent = managing ? '✓ 完成' : '⚙ 管理';
  const addBtn = $('#btn-add-pane');
  if (addBtn) addBtn.classList.toggle('hidden', !managing);
}

/* ==================== 分隔线拖拽 ==================== */
function buildSplitterV() {
  const s = document.createElement('div');
  s.className = 'splitter splitter-v';
  s.title = '拖动调整左右宽度';
  return s;
}
function buildSplitterH() {
  const s = document.createElement('div');
  s.className = 'splitter splitter-h';
  s.title = '拖动调整上下高度';
  return s;
}

function initSplitters() {
  const layout = $('#minimal-layout');
  const cols = $$('#minimal-layout .minimal-col');
  if (!layout || cols.length !== 2) return;

  const sv = layout.querySelector('.splitter-v');
  if (sv) {
    sv.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = layout.getBoundingClientRect();
      document.body.classList.add('dragging');
      const onMove = (ev) => {
        ev.preventDefault();
        const ratio = Math.min(0.75, Math.max(0.25, (ev.clientX - rect.left) / rect.width));
        colRatio = ratio;
        cols[0].style.flexGrow = ratio;
        cols[1].style.flexGrow = 1 - ratio;
        cols[0].style.flexBasis = '0';
        cols[1].style.flexBasis = '0';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('dragging');
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  const hs = layout.querySelectorAll('.splitter-h');
  hs.forEach((sh, hi) => {
    const col = sh.parentElement;
    sh.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = col.getBoundingClientRect();
      document.body.classList.add('dragging');
      const panes = col.querySelectorAll('.pane');
      const onMove = (ev) => {
        ev.preventDefault();
        const ratio = Math.min(0.85, Math.max(0.15, (ev.clientY - rect.top) / rect.height));
        if (hi === 0) rowRatioLeft = ratio; else rowRatioRight = ratio;
        if (panes[0]) { panes[0].style.flexGrow = ratio; panes[0].style.flexBasis = '0'; }
        if (panes[1]) { panes[1].style.flexGrow = 1 - ratio; panes[1].style.flexBasis = '0'; }
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('dragging');
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

/* ==================== 长按拖拽互换区域 ==================== */
function initPaneDragSwap() {
  const panes = $$('#minimal-layout .pane');
  panes.forEach((pane) => {
    const header = pane.querySelector('.pane-header');
    if (!header) return;
    let timer = null;
    header.addEventListener('mousedown', (e) => {
      if (!managing) return;
      if (e.target.closest('.pane-del, select, input')) return;
      timer = setTimeout(() => startPaneDrag(pane), 400);
    });
    header.addEventListener('mouseup', () => clearTimeout(timer));
    header.addEventListener('mouseleave', () => clearTimeout(timer));
  });
}

function startPaneDrag(pane) {
  const sourceSlot = parseInt(pane.dataset.slot, 10);
  pane.classList.add('drag-source');
  document.body.classList.add('pane-dragging');

  const onMove = (ev) => {
    ev.preventDefault();
    $$('#minimal-layout .pane').forEach((p) => p.classList.remove('drag-target'));
    const t = document.elementFromPoint(ev.clientX, ev.clientY);
    if (t) {
      const tp = t.closest('.pane');
      if (tp && tp !== pane) tp.classList.add('drag-target');
    }
  };
  const onUp = (ev) => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.classList.remove('pane-dragging');
    pane.classList.remove('drag-source');
    $$('#minimal-layout .pane').forEach((p) => p.classList.remove('drag-target'));
    const t = document.elementFromPoint(ev.clientX, ev.clientY);
    if (t) {
      const tp = t.closest('.pane');
      if (tp && tp !== pane) {
        const targetSlot = parseInt(tp.dataset.slot, 10);
        swapSlots(sourceSlot, targetSlot);
      }
    }
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function swapSlots(a, b) {
  const panes = state.settings.panes;
  if (!panes || panes.length !== 4) return;
  const tmp = panes[a];
  panes[a] = panes[b];
  panes[b] = tmp;
  savePanes();
  renderMinimalGrid();
}

/* ==================== 计划列表渲染 ==================== */
function filterTasks() {
  const now = Date.now();
  const todayStart = startOfToday();
  const todayEnd = todayStart + 86400000;

  let list = state.tasks.slice();
  switch (currentFilter) {
    case 'upcoming':
      list = list.filter((t) => !t.done && (t.nextReminder || t.dueAt) && new Date(t.nextReminder || t.dueAt).getTime() >= now);
      break;
    case 'today':
      list = list.filter((t) => !t.done && t.dueAt && new Date(t.dueAt).getTime() >= todayStart && new Date(t.dueAt).getTime() < todayEnd);
      break;
    case 'overdue':
      list = list.filter((t) => !t.done && t.dueAt && new Date(t.dueAt).getTime() < now);
      break;
    case 'done':
      list = list.filter((t) => t.done);
      break;
    case 'all':
    default:
      list = list.filter((t) => !t.done);
      break;
  }

  list.sort((a, b) => {
    const ta = new Date(a.nextReminder || a.dueAt || 0).getTime() || Number.MAX_SAFE_INTEGER;
    const tb = new Date(b.nextReminder || b.dueAt || 0).getTime() || Number.MAX_SAFE_INTEGER;
    return ta - tb;
  });
  return list;
}

function renderTasks() {
  const list = filterTasks();
  const container = $('#task-list');
  container.innerHTML = '';

  $('#empty-state').classList.toggle('hidden', list.length > 0);

  for (const t of list) {
    const card = document.createElement('div');
    card.className = 'task-card' + (t.done ? ' done' : '');

    // 批量选择框（批量模式显示，勾选加入 selectedIds）
    const sel = document.createElement('input');
    sel.type = 'checkbox';
    sel.className = 'task-select';
    sel.dataset.id = t.id;
    sel.checked = selectedIds.has(t.id);
    sel.addEventListener('change', () => {
      if (sel.checked) selectedIds.add(t.id);
      else selectedIds.delete(t.id);
      updateBatchBar();
    });

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'task-check';
    check.checked = !!t.done;
    check.addEventListener('change', async () => {
      await window.api.toggleTask(t.id);
      await refreshState();
    });

    const body = document.createElement('div');
    body.className = 'task-body';

    const title = document.createElement('div');
    title.className = 'task-title';
    title.textContent = t.title;

    const desc = document.createElement('div');
    desc.className = 'task-desc';
    desc.textContent = t.description || '';

    const meta = document.createElement('div');
    meta.className = 'task-meta';

    const now = Date.now();
    if (t.dueAt) {
      const dueMs = new Date(t.dueAt).getTime();
      const isRange = !!t.repeatEnds;
      const dueTag = document.createElement('span');
      dueTag.className = 'tag ' + (dueMs < now && !t.done && !isRange ? 'overdue' : 'due');
      const prefix = isRange ? '起 ' : (dueMs < now && !t.done ? '已过期 · ' : '');
      dueTag.textContent = prefix + fmt(t.dueAt);
      meta.appendChild(dueTag);
    }
    if (t.nextReminder) {
      const nTag = document.createElement('span');
      nTag.className = 'tag next';
      nTag.textContent = '下次提醒 ' + fmt(new Date(t.nextReminder).toISOString());
      meta.appendChild(nTag);
    }
    const r = repeatSummary(t);
    if (r) {
      const rTag = document.createElement('span');
      rTag.className = 'tag repeat';
      rTag.textContent = '🔁 ' + r;
      meta.appendChild(rTag);
    }
    if (t.reminderMinutes) {
      const mTag = document.createElement('span');
      mTag.className = 'tag';
      mTag.textContent = '提前 ' + t.reminderMinutes + ' 分钟';
      meta.appendChild(mTag);
    }

    body.appendChild(title);
    if (t.description) body.appendChild(desc);
    body.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'task-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'icon-btn';
    editBtn.textContent = '✏️ 编辑';
    editBtn.addEventListener('click', () => openTaskModal(t));

    const delBtn = document.createElement('button');
    delBtn.className = 'icon-btn danger';
    delBtn.textContent = '🗑';
    delBtn.title = '删除';
    delBtn.addEventListener('click', async () => {
      if (confirm(`确定删除「${t.title}」吗？`)) {
        await window.api.deleteTask(t.id);
        await refreshState();
      }
    });

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    card.appendChild(sel);
    card.appendChild(check);
    card.appendChild(body);
    card.appendChild(actions);
    container.appendChild(card);
  }

  updateBatchBar();
}

/* ==================== 批量管理 ==================== */
function setBatchMode(on) {
  batchMode = on;
  if (!on) selectedIds.clear();
  document.body.classList.toggle('batch-mode', on);
  $('#btn-batch').classList.toggle('active', on);
  $('#batch-bar').classList.toggle('hidden', !on);
  renderTasks();
}

function updateBatchBar() {
  const count = selectedIds.size;
  $('#batch-count').textContent = `已选 ${count} 项`;
  const has = count > 0;
  $('#batch-complete').disabled = !has;
  $('#batch-uncomplete').disabled = !has;
  $('#batch-delete').disabled = !has;
}

function batchSelectAll(on) {
  filterTasks().forEach((t) => {
    if (on) selectedIds.add(t.id);
    else selectedIds.delete(t.id);
  });
  renderTasks();
}

async function batchSetCompleted(completed) {
  const ids = [...selectedIds];
  if (!ids.length) return;
  await window.api.completeTasks(ids, completed);
  selectedIds.clear();
  await refreshState();
}

async function batchDelete() {
  const ids = [...selectedIds];
  if (!ids.length) return;
  if (!confirm(`确定删除选中的 ${ids.length} 项任务吗？此操作不可撤销。`)) return;
  await window.api.deleteTasks(ids);
  selectedIds.clear();
  await refreshState();
}

/* ==================== 任务编辑模态框 ==================== */
function openTaskModal(task) {
  editingTaskId = task ? task.id : null;
  $('#modal-title').textContent = task ? '编辑任务' : '新建任务';
  $('#f-title').value = task ? task.title : '';
  $('#f-desc').value = task ? task.description : '';
  $('#f-due').value = task && task.dueAt ? isoToLocalInput(task.dueAt) : '';
  $('#f-allday').checked = task ? !!task.allDay : false;

  const rep = task && task.repeat && task.repeat !== 'none' ? task.repeat : 'daily';
  $('#f-repeat').value = rep;
  $('#f-interval').value = task && task.repeatInterval ? task.repeatInterval : 1;
  $('#f-reminder').value = task ? task.reminderMinutes : (state.settings.defaultReminderMinutes || 30);
  $('#f-repeatends').value = task && task.repeatEnds ? isoToLocalInput(task.repeatEnds) : '';
  $('#f-targetcount').value = task && task.targetCount ? task.targetCount : '';

  // 任务类型 radio：持续任务 / 重复 / 一次性
  let ftype = 'once';
  if (task && task.isOngoing) ftype = 'ongoing';
  else if (task && task.repeat && task.repeat !== 'none') ftype = 'repeat';
  const radio = document.querySelector(`input[name="f-type"][value="${ftype}"]`);
  if (radio) radio.checked = true;

  $$('#f-weekdays input').forEach((c) => {
    c.checked = task && task.repeatWeekdays ? task.repeatWeekdays.includes(Number(c.value)) : false;
  });

  updateRepeatUI();
  $('#modal-backdrop').classList.remove('hidden');
  setTimeout(() => $('#f-title').focus(), 50);
}

function closeTaskModal() {
  $('#modal-backdrop').classList.add('hidden');
  editingTaskId = null;
}

function updateRepeatUI() {
  const type = document.querySelector('input[name="f-type"]:checked');
  const v = type ? type.value : 'once';
  const isRepeat = v === 'repeat';
  const isOngoing = v === 'ongoing';
  const active = isRepeat || isOngoing;
  const freq = $('#f-repeat').value;

  // 一次性：整个重复设置区域灰化
  $('#repeat-area').classList.toggle('muted', !active);

  // 周几选择：仅「重复」且每周时启用
  const weekly = isRepeat && freq === 'weekly';
  $('#weekday-row').classList.toggle('muted', !weekly);

  // 字段禁用
  $('#f-repeat').disabled = !active;
  $('#f-interval').disabled = !active;
  $('#f-repeatends').disabled = !active;
  $('#f-targetcount').disabled = !active;
  $$('#f-weekdays input').forEach((c) => { c.disabled = !weekly; });
}

async function saveTaskFromModal() {
  const title = $('#f-title').value.trim();
  if (!title) {
    alert('请填写任务标题。');
    $('#f-title').focus();
    return;
  }

  const type = document.querySelector('input[name="f-type"]:checked');
  const v = type ? type.value : 'once';
  const isOngoing = v === 'ongoing';
  const isRepeat = v === 'repeat';
  const repeat = isOngoing ? 'daily' : (isRepeat ? $('#f-repeat').value : 'none');
  const weekdays = repeat === 'weekly'
    ? $$('#f-weekdays input:checked').map((c) => Number(c.value))
    : [];

  const original = editingTaskId ? state.tasks.find((t) => t.id === editingTaskId) : null;
  const task = {
    id: editingTaskId || undefined,
    title,
    description: $('#f-desc').value,
    startAt: original ? original.startAt : null,
    dueAt: localInputToIso($('#f-due').value),
    allDay: $('#f-allday').checked,
    repeat,
    repeatInterval: (isRepeat || isOngoing) ? Math.max(1, parseInt($('#f-interval').value, 10) || 1) : 1,
    repeatWeekdays: weekdays,
    repeatEnds: (isRepeat || isOngoing) ? localInputToIso($('#f-repeatends').value) : null,
    targetCount: (isRepeat || isOngoing) ? (parseInt($('#f-targetcount').value, 10) || null) : null,
    isOngoing,
    reminderMinutes: Math.max(0, parseInt($('#f-reminder').value, 10) || 0)
  };

  if (!task.dueAt && repeat === 'none') {
    if (!confirm('未设置提醒时间，任务将不会被提醒。仍要保存吗？')) return;
  }

  await window.api.saveTask(task);
  closeTaskModal();
  await refreshState();
}

/* ==================== 导入 ==================== */
function setStatus(el, msg, cls) {
  el.textContent = msg;
  el.className = 'status' + (cls ? ' ' + cls : '');
}

async function handlePickFile() {
  const res = await window.api.readFile();
  if (!res) return;
  pickedFileContent = res.content;
  $('#chat-input').value = res.content;
  $('#file-name').textContent = '已选择：' + res.name;
}

async function handleParse() {
  const text = $('#chat-input').value.trim();
  if (!text) {
    setStatus($('#parse-status'), '请先粘贴聊天记录或选择文件。', 'error');
    return;
  }
  const btn = $('#btn-parse');
  btn.disabled = true;
  btn.textContent = '⏳ 解析中…';
  setStatus($('#parse-status'), '正在调用 AI 解析，请稍候…', '');

  try {
    const tasks = await window.api.parseChat(text, state.settings);
    parsedTasks = tasks;
    renderParseResult();
    setStatus($('#parse-status'), `解析成功，识别出 ${tasks.length} 条任务，请确认后导入。`, 'success');
  } catch (err) {
    setStatus($('#parse-status'), '解析失败：' + (err && err.message ? err.message : err), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🤖 AI 解析';
  }
}

function renderParseResult() {
  $('#parse-result').classList.remove('hidden');
  $('#result-count').textContent = parsedTasks.length;
  const listEl = $('#result-list');
  listEl.innerHTML = '';

  parsedTasks.forEach((task, idx) => {
    const row = document.createElement('div');
    row.className = 'result-item';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.idx = idx;

    const titleWrap = document.createElement('div');
    titleWrap.className = 'ri-title';
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.value = task.title;
    titleInput.addEventListener('input', () => { task.title = titleInput.value; });

    const timeInput = document.createElement('input');
    timeInput.type = 'datetime-local';
    timeInput.className = 'ri-time';
    timeInput.value = isoToLocalInput(task.dueAt);
    timeInput.addEventListener('input', () => { task.dueAt = localInputToIso(timeInput.value); });

    const repeatSel = document.createElement('select');
    repeatSel.className = 'ri-repeat';
    for (const [v, l] of Object.entries(REPEAT_LABEL)) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = l;
      if (v === task.repeat) opt.selected = true;
      repeatSel.appendChild(opt);
    }
    repeatSel.addEventListener('change', () => { task.repeat = repeatSel.value; });

    const del = document.createElement('button');
    del.className = 'ri-del';
    del.textContent = '✕';
    del.addEventListener('click', () => {
      parsedTasks.splice(idx, 1);
      renderParseResult();
    });

    titleWrap.appendChild(titleInput);
    row.appendChild(cb);
    row.appendChild(titleWrap);
    row.appendChild(timeInput);
    row.appendChild(repeatSel);
    row.appendChild(del);
    listEl.appendChild(row);
  });
}

async function handleImport() {
  const selected = parsedTasks.filter((_t, idx) => {
    const cb = $('#result-list').querySelector(`input[type="checkbox"][data-idx="${idx}"]`);
    return cb && cb.checked;
  });
  if (selected.length === 0) {
    alert('请先勾选要导入的任务。');
    return;
  }
  const n = await window.api.importTasks(selected);
  parsedTasks = [];
  $('#parse-result').classList.add('hidden');
  $('#chat-input').value = '';
  $('#file-name').textContent = '';
  pickedFileContent = null;
  setStatus($('#parse-status'), `已导入 ${n} 条任务。`, 'success');
  await refreshState();
  switchTab('plan');
}

/* ==================== 设置 ==================== */
function fillSettings() {
  $('#set-apikey').value = state.settings.apiKey || '';
  $('#set-apibase').value = state.settings.apiBase || 'https://api.deepseek.com';
  $('#set-model').value = state.settings.model || 'deepseek-chat';
  $('#set-reminder').value = state.settings.defaultReminderMinutes != null ? state.settings.defaultReminderMinutes : 30;
  $('#set-catchup').value = state.settings.catchUpWindowDays != null ? state.settings.catchUpWindowDays : 7;
  $('#set-startup').checked = !!state.startup;
  $('#set-notify-startup').checked = state.settings.notifyOnStartup !== false;
  $('#set-tray').checked = state.settings.closeToTray !== false;
}

async function handleSaveSettings() {
  const patch = {
    apiKey: $('#set-apikey').value.trim(),
    apiBase: $('#set-apibase').value.trim() || 'https://api.deepseek.com',
    model: $('#set-model').value.trim() || 'deepseek-chat',
    defaultReminderMinutes: Math.max(0, parseInt($('#set-reminder').value, 10) || 0),
    catchUpWindowDays: Math.max(1, parseInt($('#set-catchup').value, 10) || 7),
    closeToTray: $('#set-tray').checked,
    notifyOnStartup: $('#set-notify-startup').checked
  };
  await window.api.updateSettings(patch);
  await window.api.setStartup($('#set-startup').checked);
  await refreshState();
  setStatus($('#settings-status'), '设置已保存 ✓', 'success');
  setTimeout(() => setStatus($('#settings-status'), '', ''), 2500);
}

/* ==================== 事件绑定 ==================== */
function bindEvents() {
  // 标签页
  $$('.tab-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  // 筛选
  $$('.filter-btn').forEach((b) => b.addEventListener('click', () => {
    currentFilter = b.dataset.filter;
    $$('.filter-btn').forEach((x) => x.classList.toggle('active', x === b));
    renderTasks();
  }));

  // 批量管理
  $('#btn-batch').addEventListener('click', () => setBatchMode(!batchMode));
  $('#batch-exit').addEventListener('click', () => setBatchMode(false));
  $('#batch-select-all').addEventListener('click', () => batchSelectAll(true));
  $('#batch-select-none').addEventListener('click', () => batchSelectAll(false));
  $('#batch-complete').addEventListener('click', () => batchSetCompleted(true));
  $('#batch-uncomplete').addEventListener('click', () => batchSetCompleted(false));
  $('#batch-delete').addEventListener('click', batchDelete);

  // 新建/编辑
  $('#btn-add').addEventListener('click', () => openTaskModal(null));
  $('#modal-close').addEventListener('click', closeTaskModal);
  $('#f-cancel').addEventListener('click', closeTaskModal);
  $('#modal-backdrop').addEventListener('click', (e) => { if (e.target === $('#modal-backdrop')) closeTaskModal(); });
  $('#f-save').addEventListener('click', saveTaskFromModal);
  $('#f-repeat').addEventListener('change', updateRepeatUI);
  $$('input[name="f-type"]').forEach((r) => r.addEventListener('change', updateRepeatUI));

  // 导入
  $('#btn-pick-file').addEventListener('click', handlePickFile);
  $('#btn-parse').addEventListener('click', handleParse);
  $('#btn-clear').addEventListener('click', () => {
    $('#chat-input').value = '';
    $('#file-name').textContent = '';
    pickedFileContent = null;
    $('#parse-result').classList.add('hidden');
  });
  $('#btn-import').addEventListener('click', handleImport);
  $('#btn-check-all').addEventListener('click', () => $$('#result-list input[type="checkbox"]').forEach((c) => { c.checked = true; }));
  $('#btn-uncheck-all').addEventListener('click', () => $$('#result-list input[type="checkbox"]').forEach((c) => { c.checked = false; }));

  // 设置
  $('#btn-save-settings').addEventListener('click', handleSaveSettings);
  $('#btn-test-reminder').addEventListener('click', async () => {
    const ok = await window.api.testReminder();
    setStatus($('#settings-status'), ok ? '已发送测试通知，请查看屏幕右下角。' : '当前系统不支持通知。', ok ? 'success' : 'error');
    setTimeout(() => setStatus($('#settings-status'), '', ''), 3000);
  });
  $('#btn-minimize').addEventListener('click', () => window.api.hideWindow());
  $('#link-platform').addEventListener('click', (e) => {
    e.preventDefault();
    window.api.openExternal && window.api.openExternal('https://platform.deepseek.com');
  });

  // 极简模式：管理按钮 + 添加区域
  $('#btn-manage').addEventListener('click', toggleManage);
  $('#btn-add-pane').addEventListener('click', () => addPane('today'));

  // 剩余量输入弹窗
  $('#remain-close').addEventListener('click', closeRemainModal);
  $('#remain-cancel').addEventListener('click', closeRemainModal);
  $('#remain-ok').addEventListener('click', async () => {
    if (!remainTaskId) return;
    const remaining = Math.max(0, parseInt($('#remain-input').value, 10) || 0);
    await window.api.setRemaining(remainTaskId, remaining);
    closeRemainModal();
    await refreshState();
  });

  // 提醒事件：刷新列表
  window.api.onReminder(() => refreshState());
}

/* ==================== 启动 ==================== */
window.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  await refreshState();
  switchTab('today');
});
