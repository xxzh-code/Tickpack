// Workspace layout: tabs + panes + splitters, persisted through the web host.
//
// This module is SHELL LAYER and platform-agnostic: it receives the host
// adapter (already created by app.js) and uses only host.storageGet/Set for
// persistence. It never touches localStorage, files, or Blob directly.
//
// One layout document:
//   {
//     version: 2,
//     activeId: 'workbench',
//     nextId: 3,
//     tabs: [{
//       id, name,
//       main: [{ grow: 38, stack: [{ panel: 'source', grow: 100 }] }, ...],
//       dock: { panel: 'timeline', size: 150 } | null,
//       collapsed: { [panelId]: true },
//       maximized: panelId | null,
//     }],
//   }
// Panels are the real DOM nodes (owned by app.js); the layout only reparents
// them, so hidden panels keep their canvas/editor/text state.

import { icon } from './util.js';

export const LAYOUT_KEY = 'tickpack.layout.v2';
export const LAYOUT_VERSION = 3;

export const PANEL_DEFS = [
  { id: 'source', title: '源码' },
  { id: 'world', title: '世界' },
  { id: 'pack', title: '数据包' },
  { id: 'scores', title: '计分板' },
  { id: 'log', title: '运行日志' },
  { id: 'timeline', title: '时间轴' },
];
const PANEL_IDS = PANEL_DEFS.map((p) => p.id);
const MIN_GROW = 8;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function defaultLayout() {
  return {
    version: LAYOUT_VERSION,
    activeId: 'workbench',
    nextId: 3,
    tabs: [
      {
        id: 'workbench',
        name: '工作台',
        main: [
          { grow: 30, stack: [{ panel: 'source', grow: 100 }] },
          { grow: 36, stack: [{ panel: 'world', grow: 69 }, { panel: 'scores', grow: 31 }] },
          { grow: 34, stack: [{ panel: 'pack', grow: 67 }, { panel: 'log', grow: 33 }] },
        ],
        dock: { panel: 'timeline', size: 150 },
        collapsed: {},
        maximized: null,
      },
      {
        id: 'observe',
        name: '观察',
        main: [
          { grow: 62, stack: [{ panel: 'world', grow: 100 }] },
          { grow: 38, stack: [{ panel: 'scores', grow: 45 }, { panel: 'log', grow: 55 }] },
        ],
        dock: { panel: 'timeline', size: 150 },
        collapsed: {},
        maximized: null,
      },
    ],
  };
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Accept only a well-formed v2 layout; repair duplicate placements/missing panels.
 *  A panel MAY appear in several tabs (e.g. 世界 in 工作台 and 观察) — there is one
 *  DOM node and the active tab decides where it lives. Duplicates *within a tab*
 *  are removed. */
function sanitizeLayout(raw) {
  if (!isPlainObject(raw) || raw.version !== LAYOUT_VERSION || !Array.isArray(raw.tabs)) return null;
  const seenGlobal = new Set();
  const usedIds = new Set();
  const tabs = [];

  for (const candidate of raw.tabs) {
    if (!isPlainObject(candidate)) continue;
    let id = typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id.trim() : '';
    if (!id || usedIds.has(id)) id = `tab-${usedIds.size + 1}`;
    usedIds.add(id);
    const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim().slice(0, 24) : '标签页';
    const tab = { id, name, main: [], dock: null, collapsed: {}, maximized: null };
    const tabSeen = new Set();

    const main = Array.isArray(candidate.main) ? candidate.main : [];
    for (const col of main) {
      if (!isPlainObject(col) || !Array.isArray(col.stack)) continue;
      const stack = [];
      for (const item of col.stack) {
        if (!isPlainObject(item) || !PANEL_IDS.includes(item.panel)) continue;
        if (tabSeen.has(item.panel) || item.panel === 'timeline') continue;
        tabSeen.add(item.panel);
        seenGlobal.add(item.panel);
        stack.push({ panel: item.panel, grow: clampGrow(item.grow) });
      }
      if (stack.length) tab.main.push({ grow: clampGrow(col.grow), stack });
    }

    if (isPlainObject(candidate.dock) && candidate.dock.panel === 'timeline' && !tabSeen.has('timeline')) {
      tab.dock = { panel: 'timeline', size: clampDock(candidate.dock.size) };
      tabSeen.add('timeline');
      seenGlobal.add('timeline');
    }

    if (isPlainObject(candidate.collapsed)) {
      for (const pid of Object.keys(candidate.collapsed)) {
        if (PANEL_IDS.includes(pid) && candidate.collapsed[pid]) tab.collapsed[pid] = true;
      }
    }
    if (typeof candidate.maximized === 'string' && PANEL_IDS.includes(candidate.maximized)) {
      tab.maximized = candidate.maximized;
    }
    tabs.push(tab);
  }

  if (!tabs.length || seenGlobal.size === 0) return null;
  // Panels that ended up nowhere (e.g. old layout without scores/log) get a
  // default home so nothing silently disappears.
  const missing = PANEL_IDS.filter((p) => !seenGlobal.has(p));
  for (const pid of missing) {
    const hostTab = tabs[0];
    if (pid === 'timeline' && !hostTab.dock) hostTab.dock = { panel: 'timeline', size: 150 };
    else if (pid !== 'timeline') hostTab.main.push({ grow: 25, stack: [{ panel: pid, grow: 100 }] });
    seenGlobal.add(pid);
  }

  let activeId = typeof raw.activeId === 'string' ? raw.activeId : tabs[0].id;
  if (!tabs.some((t) => t.id === activeId)) activeId = tabs[0].id;
  const nextId = Number.isFinite(raw.nextId) ? Math.max(3, Math.floor(raw.nextId)) : tabs.length + 1;
  return { version: LAYOUT_VERSION, activeId, nextId, tabs };
}

function clampGrow(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 25;
  return Math.max(MIN_GROW, Math.min(1000, n));
}

function clampDock(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 150;
  return Math.max(90, Math.min(420, Math.round(n)));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const PANEL_TITLES = new Map(PANEL_DEFS.map((p) => [p.id, p.title]));

/** Point an existing icon button at another sprite symbol. */
function setIcon(button, name) {
  if (!button) return;
  const use = typeof button.querySelector === 'function' ? button.querySelector('use') : null;
  if (use) use.setAttribute('href', `#i-${name}`);
  else button.innerHTML = icon(name);
}

/** Collapse direction follows the panel's position, never a fixed glyph. */
function collapseDirection(tab, panelId, pos, collapsed) {
  if (pos.dock) return collapsed ? 'chevrons-up' : 'chevrons-down';
  const col = tab.main[pos.ci];
  const stackLen = col ? col.stack.length : 1;
  if (stackLen > 1) {
    const top = pos.si === 0;
    // stacked: collapse toward the nearest stack edge, expand back inward
    return collapsed ? (top ? 'chevrons-down' : 'chevrons-up') : (top ? 'chevrons-up' : 'chevrons-down');
  }
  const count = tab.main.length;
  const onLeft = pos.ci <= count - 1 - pos.ci; // middle column picks its nearer edge
  return collapsed
    ? (onLeft ? 'chevrons-right' : 'chevrons-left')
    : (onLeft ? 'chevrons-left' : 'chevrons-right');
}

export function createLayout({
  host,
  workspaceEl,
  tabsEl,
  newTabBtn,
  resetBtn,
  panelNodes,
  onLayoutChange,
  onNotify,
  onReset,
}) {
  let doc = null;
  let menus = [];
  let dragCleanup = null;

  const notify = (message) => {
    if (typeof onNotify === 'function') onNotify(message);
  };

  const activeTab = () => doc.tabs.find((t) => t.id === doc.activeId) || doc.tabs[0];

  function canPersist() {
    return !!(host && host.canPersist !== false && typeof host.storageSet === 'function');
  }

  function save() {
    if (!canPersist()) return false;
    try {
      host.storageSet(LAYOUT_KEY, JSON.stringify(doc));
      return true;
    } catch {
      return false;
    }
  }

  function load(requestedTab) {
    let parsed = null;
    if (host && typeof host.storageGet === 'function') {
      try {
        const raw = host.storageGet(LAYOUT_KEY);
        if (raw) parsed = sanitizeLayout(JSON.parse(raw));
      } catch {
        parsed = null;
      }
    }
    doc = parsed || defaultLayout();
    // debug `?tab=` opens that tab for the initial state (does not persist);
    // unknown ids fall back to the first tab.
    if (requestedTab) {
      const match = doc.tabs.find((t) => t.id === requestedTab);
      doc.activeId = match ? match.id : doc.tabs[0].id;
    }
    if (!doc.tabs.some((t) => t.id === doc.activeId)) doc.activeId = doc.tabs[0].id;
  }

  function visiblePanels(tab) {
    if (!tab) return new Set();
    if (tab.maximized) return new Set([tab.maximized]);
    const visible = new Set();
    for (const col of tab.main) {
      for (const item of col.stack) {
        if (!tab.collapsed[item.panel]) visible.add(item.panel);
      }
    }
    if (tab.dock && !tab.collapsed[tab.dock.panel]) visible.add(tab.dock.panel);
    return visible;
  }

  function panelCount(tab) {
    return tab.main.reduce((n, col) => n + col.stack.length, 0) + (tab.dock ? 1 : 0);
  }

  function emitChange() {
    const tab = activeTab();
    if (typeof onLayoutChange === 'function') {
      onLayoutChange({
        tabId: tab.id,
        tabName: tab.name,
        visiblePanels: visiblePanels(tab),
        tabCount: doc.tabs.length,
      });
    }
  }

  // ---------------------------------------------------------------- tabs ---
  function renderTabs() {
    tabsEl.innerHTML = '';
    for (const tab of doc.tabs) {
      const node = el('div', 'tab' + (tab.id === doc.activeId ? ' active' : ''));
      node.dataset.tabId = tab.id;
      node.setAttribute('role', 'tab');
      node.setAttribute('aria-selected', tab.id === doc.activeId ? 'true' : 'false');
      node.setAttribute('aria-current', tab.id === doc.activeId ? 'page' : 'false');
      node.title = tab.name;

      const label = el('span', 'tab-label', tab.name);
      label.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        startRename(node, label, tab);
      });
      node.append(label);

      if (doc.tabs.length > 1) {
        const close = el('button', 'tab-close');
        close.type = 'button';
        close.innerHTML = icon('x');
        close.title = '关闭标签页';
        close.setAttribute('aria-label', '关闭标签页');
        close.addEventListener('click', (ev) => {
          ev.stopPropagation();
          closeTab(tab.id);
        });
        node.append(close);
      }

      node.addEventListener('click', () => selectTab(tab.id));
      tabsEl.append(node);
    }
  }

  function startRename(tabNode, label, tab) {
    const input = el('input', 'tab-rename');
    input.value = tab.name;
    input.maxLength = 24;
    tabNode.replaceChild(input, label);
    input.focus();
    input.select();
    let done = false;
    const commit = (cancel) => {
      if (done) return;
      done = true;
      const name = cancel ? tab.name : input.value.trim().slice(0, 24);
      if (name && name !== tab.name) {
        tab.name = name;
        save();
      }
      renderAll();
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(false); }
      else if (ev.key === 'Escape') { ev.preventDefault(); commit(true); }
      ev.stopPropagation();
    });
    input.addEventListener('blur', () => commit(false));
    input.addEventListener('click', (ev) => ev.stopPropagation());
  }

  function selectTab(id) {
    if (!doc.tabs.some((t) => t.id === id)) return;
    closeMenus();
    if (doc.activeId === id) return;
    doc.activeId = id;
    save();
    renderAll();
  }

  function createTab({ activate = true } = {}) {
    const n = doc.nextId || doc.tabs.length + 1;
    doc.nextId = n + 1;
    const tab = {
      id: `tab-${n}`,
      name: `标签页 ${n}`,
      main: [],
      dock: null,
      collapsed: {},
      maximized: null,
    };
    doc.tabs.push(tab);
    if (activate) doc.activeId = tab.id;
    save();
    renderAll();
    return tab;
  }

  function closeTab(id) {
    if (doc.tabs.length <= 1) {
      notify('至少保留一个标签页');
      return false;
    }
    const index = doc.tabs.findIndex((t) => t.id === id);
    if (index === -1) return false;
    const closing = doc.tabs[index];
    const remaining = doc.tabs.filter((_, i) => i !== index);
    // Never orphan a panel: anything that only lived in the closing tab moves to
    // the previous tab, so every panel stays reachable after a close.
    for (const pid of PANEL_IDS) {
      if (!findPanelLocation(pid, closing)) continue;
      if (remaining.some((t) => findPanelLocation(pid, t))) continue;
      const hostTab = remaining[Math.max(0, index - 1)] || remaining[0];
      appendPanel(hostTab, pid);
    }
    doc.tabs.splice(index, 1);
    if (doc.activeId === id) {
      const next = doc.tabs[Math.max(0, index - 1)] || doc.tabs[0];
      doc.activeId = next.id;
    }
    save();
    renderAll();
    return true;
  }

  // ------------------------------------------------------------ panel ops ---
  /** Locate a panel inside one tab (the same panel may live in several tabs). */
  function findPanelLocation(panelId, tab = activeTab()) {
    if (!tab) return null;
    if (tab.dock && tab.dock.panel === panelId) return { tab, where: 'dock' };
    for (let ci = 0; ci < tab.main.length; ci++) {
      const si = tab.main[ci].stack.findIndex((it) => it.panel === panelId);
      if (si !== -1) return { tab, where: 'main', ci, si };
    }
    return null;
  }

  function tabHasPanel(tab, panelId) {
    return !!findPanelLocation(panelId, tab);
  }

  function removePanelFromTab(panelId, tab) {
    const loc = findPanelLocation(panelId, tab);
    if (!loc) return false;
    if (loc.where === 'dock') {
      tab.dock = null;
    } else {
      const col = tab.main[loc.ci];
      col.stack.splice(loc.si, 1);
      if (col.stack.length === 0) tab.main.splice(loc.ci, 1);
    }
    if (tab.maximized === panelId) tab.maximized = null;
    delete tab.collapsed[panelId];
    return true;
  }

  function appendPanel(tab, panelId) {
    if (panelId === 'timeline') {
      tab.dock = { panel: 'timeline', size: tab.dock ? tab.dock.size : 150 };
    } else {
      tab.main.push({ grow: 30, stack: [{ panel: panelId, grow: 100 }] });
    }
  }

  function movePanel(panelId, targetTabId, { toEnd = false } = {}) {
    const sourceTab = activeTab();
    if (!findPanelLocation(panelId, sourceTab)) return false;
    const target = doc.tabs.find((t) => t.id === targetTabId);
    if (!target) return false;

    // The target tab already shows this panel: just switch to it.
    if (tabHasPanel(target, panelId) && target !== sourceTab) {
      doc.activeId = target.id;
      save();
      renderAll();
      emitChange();
      return true;
    }
    if (sourceTab === target && !toEnd) return false;

    if (panelCount(sourceTab) <= 1) {
      notify('每个标签页至少保留一个分栏');
      return false;
    }
    removePanelFromTab(panelId, sourceTab);
    if (sourceTab === target) {
      appendPanel(target, panelId);
    } else {
      appendPanel(target, panelId);
      doc.activeId = target.id;
    }
    save();
    renderAll();
    emitChange();
    return true;
  }

  function toggleCollapse(panelId) {
    const tab = activeTab();
    const loc = findPanelLocation(panelId, tab);
    if (!loc) return;
    if (tab.maximized === panelId) tab.maximized = null;
    tab.collapsed[panelId] = !tab.collapsed[panelId];
    save();
    renderAll();
  }

  function toggleMaximize(panelId) {
    const tab = activeTab();
    const loc = findPanelLocation(panelId, tab);
    if (!loc) return;
    tab.maximized = tab.maximized === panelId ? null : panelId;
    if (tab.maximized) delete tab.collapsed[panelId];
    save();
    renderAll();
  }

  // -------------------------------------------------------------- menus ---
  function closeMenus() {
    for (const menu of menus) {
      if (menu.parentNode) menu.parentNode.removeChild(menu);
    }
    menus = [];
  }

  function addMenuItem(menu, label, handler, { disabled = false, heading = false } = {}) {
    if (heading) {
      const h = el('div', 'panel-menu-heading', label);
      menu.append(h);
      return;
    }
    const item = el('button', 'panel-menu-item', label);
    item.type = 'button';
    item.disabled = !!disabled;
    item.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeMenus();
      handler();
    });
    menu.append(item);
  }

  function openPanelMenu(button, panelId) {
    closeMenus();
    const tab = activeTab();
    const menu = el('div', 'panel-menu');
    menu.setAttribute('role', 'menu');
    menu.dataset.menuFor = panelId;
    addMenuItem(menu, tab.collapsed[panelId] ? '展开' : '折叠', () => toggleCollapse(panelId));
    addMenuItem(menu, tab.maximized === panelId ? '取消最大化' : '最大化', () => toggleMaximize(panelId));
    menu.append(el('div', 'panel-menu-sep'));
    addMenuItem(menu, '移动到标签页 →', () => {}, { heading: true });
    for (const other of doc.tabs) {
      if (other.id === tab.id) continue;
      addMenuItem(menu, other.name, () => movePanel(panelId, other.id));
    }
    addMenuItem(menu, '新建标签页', () => {
      const created = createTab({ activate: false });
      movePanel(panelId, created.id);
    });
    addMenuItem(menu, '本页末尾', () => movePanel(panelId, tab.id, { toEnd: true }));

    // Fixed positioning escapes the panel's overflow:hidden and any scroll area.
    const winW = typeof window !== 'undefined' ? window.innerWidth : 1200;
    const winH = typeof window !== 'undefined' ? window.innerHeight : 800;
    const rect = typeof button.getBoundingClientRect === 'function'
      ? button.getBoundingClientRect()
      : { bottom: 40, right: winW - 12 };
    menu.style.position = 'fixed';
    menu.style.top = `${Math.min(rect.bottom + 5, Math.max(8, winH - 260))}px`;
    menu.style.right = `${Math.max(8, winW - rect.right)}px`;
    menu.style.left = 'auto';
    document.body.appendChild(menu);
    menus.push(menu);
  }

  // ------------------------------------------------------------ splitters ---
  function startSplitDrag(ev, kind, ci, si, tab) {
    if (ev.button != null && ev.button !== 0) return;
    ev.preventDefault();
    const root = workspaceEl.querySelector('.pane-root');
    if (!root) return;
    const mainEl = root.querySelector('.pane-main');
    const startX = ev.clientX;
    const startY = ev.clientY;
    const splitter = ev.currentTarget;
    splitter.classList.add('active');

    let before;
    let after;
    let startBefore;
    let startAfter;
    let startDock = 0;
    let pixelsPerGrow = 0;
    let sumGrow = 0;
    if (kind === 'v') {
      before = tab.main[ci - 1];
      after = tab.main[ci];
      startBefore = before.grow;
      startAfter = after.grow;
      sumGrow = startBefore + startAfter;
      const cols = mainEl ? mainEl.querySelectorAll(':scope > .pane-col') : [];
      const a = cols[ci - 1];
      const b = cols[ci];
      if (a && b) {
        const pa = a.getBoundingClientRect();
        const pb = b.getBoundingClientRect();
        const span = pa.width + pb.width;
        if (span > 0 && sumGrow > 0) pixelsPerGrow = span / sumGrow;
      }
      if (!(pixelsPerGrow > 0)) {
        const total = mainEl ? Math.max(1, mainEl.clientWidth) : 1;
        pixelsPerGrow = total / Math.max(1, tab.main.reduce((n, col) => n + col.grow, 0));
      }
    } else if (kind === 'h') {
      const col = tab.main[ci];
      before = col.stack[si - 1];
      after = col.stack[si];
      startBefore = before.grow;
      startAfter = after.grow;
      sumGrow = startBefore + startAfter;
      const colEl = splitter.parentElement;
      const slots = colEl ? colEl.querySelectorAll(':scope > .pane-slot') : [];
      const a = slots[si - 1];
      const b = slots[si];
      if (a && b) {
        const pa = a.getBoundingClientRect();
        const pb = b.getBoundingClientRect();
        const span = pa.height + pb.height;
        if (span > 0 && sumGrow > 0) pixelsPerGrow = span / sumGrow;
      }
      if (!(pixelsPerGrow > 0)) {
        const total = colEl ? Math.max(1, colEl.clientHeight) : 1;
        pixelsPerGrow = total / Math.max(1, col.stack.reduce((n, item) => n + item.grow, 0));
      }
    } else {
      startDock = tab.dock.size;
    }

    const onMove = (mv) => {
      if (kind === 'v') {
        const dx = mv.clientX - startX;
        const delta = dx / pixelsPerGrow;
        const sum = sumGrow;
        const nextBefore = Math.max(MIN_GROW, Math.min(sum - MIN_GROW, startBefore + delta));
        before.grow = nextBefore;
        after.grow = sum - nextBefore;
        const cols = mainEl.querySelectorAll(':scope > .pane-col');
        if (cols[ci - 1]) cols[ci - 1].style.flexGrow = String(before.grow);
        if (cols[ci]) cols[ci].style.flexGrow = String(after.grow);
      } else if (kind === 'h') {
        const dy = mv.clientY - startY;
        const delta = dy / pixelsPerGrow;
        const sum = sumGrow;
        const nextBefore = Math.max(MIN_GROW, Math.min(sum - MIN_GROW, startBefore + delta));
        before.grow = nextBefore;
        after.grow = sum - nextBefore;
        const colEl = splitter.parentElement;
        const slots = colEl.querySelectorAll(':scope > .pane-slot');
        if (slots[si - 1]) slots[si - 1].style.flexGrow = String(before.grow);
        if (slots[si]) slots[si].style.flexGrow = String(after.grow);
      } else {
        const rootH = Math.max(1, root.clientHeight);
        const delta = mv.clientY - startY;
        tab.dock.size = clampDock(Math.min(rootH * 0.7, startDock - delta));
        const dockEl = root.querySelector('.pane-dock');
        if (dockEl) dockEl.style.flex = `0 0 ${tab.dock.size}px`;
      }
    };

    const onUp = () => {
      splitter.classList.remove('active');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('dragging-split');
      save();
      emitChange();
      dragCleanup = null;
    };
    dragCleanup = onUp;
    document.body.classList.add('dragging-split');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // ------------------------------------------------------------- render ---
  function makeSlot(panelId, tab, pos) {
    const slot = el('div', 'pane-slot');
    slot.dataset.panelId = panelId;
    slot.dataset.slot = pos.dock ? 'dock' : `${pos.ci}:${pos.si}`;
    const collapsed = !!tab.collapsed[panelId];
    if (!pos.dock) {
      const stack = tab.main[pos.ci] && tab.main[pos.ci].stack;
      const item = stack && stack[pos.si];
      if (item) {
        // Never leave an inline flex-grow on a collapsed slot: inline styles
        // beat the stylesheet's `.is-collapsed { flex: 0 0 auto }` and the slot
        // would keep growing (the old collapse bug).
        if (collapsed) slot.style.flexGrow = '';
        else slot.style.flexGrow = String(item.grow);
      }
    }
    if (collapsed) {
      slot.classList.add('is-collapsed');
      slot.style.minHeight = '0';
    } else {
      slot.style.minHeight = '';
    }
    if (tab.maximized === panelId) slot.classList.add('is-maximized');
    const panel = panelNodes[panelId];
    if (!panel) {
      slot.append(el('div', 'panel-missing', '分栏不可用'));
      return slot;
    }
    panel.dataset.panelId = panelId;
    panel.classList.toggle('collapsed', collapsed);
    panel.classList.toggle('maximized', tab.maximized === panelId);
    const title = PANEL_TITLES.get(panelId) || panelId;
    const collapseBtn = panel.querySelector && panel.querySelector('[data-action="collapse"]');
    if (collapseBtn) {
      setIcon(collapseBtn, collapseDirection(tab, panelId, pos, collapsed));
      collapseBtn.title = `${collapsed ? '展开' : '折叠'} ${title}`;
      collapseBtn.setAttribute('aria-label', `${collapsed ? '展开' : '折叠'} ${title}`);
      collapseBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
    const maximizeBtn = panel.querySelector && panel.querySelector('[data-action="maximize"]');
    if (maximizeBtn) {
      const maximized = tab.maximized === panelId;
      setIcon(maximizeBtn, maximized ? 'minimize' : 'maximize');
      maximizeBtn.title = maximized ? '还原' : '最大化';
      maximizeBtn.setAttribute('aria-label', maximized ? '还原' : '最大化');
      maximizeBtn.setAttribute('aria-pressed', maximized ? 'true' : 'false');
    }
    const menuBtn = panel.querySelector && panel.querySelector('[data-action="menu"]');
    if (menuBtn) {
      setIcon(menuBtn, 'more-horizontal');
      menuBtn.title = '更多操作';
      menuBtn.setAttribute('aria-label', '更多操作');
      menuBtn.setAttribute('aria-haspopup', 'menu');
    }
    slot.append(panel);
    return slot;
  }

  function makeSplitter(kind, ci, si, tab) {
    const splitter = el('div', `split split-${kind === 'dock' ? 'dock' : kind === 'v' ? 'v' : 'h'}`);
    splitter.dataset.split = kind;
    splitter.setAttribute('role', 'separator');
    splitter.setAttribute('aria-orientation', kind === 'v' ? 'vertical' : 'horizontal');
    splitter.addEventListener('pointerdown', (ev) => startSplitDrag(ev, kind, ci, si, tab));
    return splitter;
  }

  function emptyState() {
    const box = el('div', 'tab-empty');
    const img = document.createElement('img');
    img.src = '../logo/logo-middle.svg';
    img.alt = 'Tickpack';
    img.className = 'tab-empty-logo';
    box.append(img);
    box.append(el('p', 'tab-empty-title', '这个标签页还是空的'));
    box.append(el('span', 'tab-empty-hint', '在任意分栏标题的「更多」菜单里选择「移动到标签页」，把分栏移动到这里。'));
    const reset = el('button', 'btn btn-soft btn-sm', '重置布局');
    reset.type = 'button';
    reset.addEventListener('click', (ev) => {
      ev.stopPropagation();
      resetToDefaults();
    });
    box.append(reset);
    return box;
  }

  function resetToDefaults() {
    const previous = clone(doc);
    doc = defaultLayout();
    if (typeof host.storageRemove === 'function') {
      try { host.storageRemove(LAYOUT_KEY); } catch { /* ignore */ }
    }
    save();
    renderAll();
    if (typeof onReset === 'function') onReset(previous);
    else notify('已重置为默认布局');
  }

  function renderWorkspace() {
    workspaceEl.innerHTML = '';
    const tab = activeTab();
    if (!tab) return;
    const root = el('div', 'pane-root');
    root.dataset.tabId = tab.id;
    if (tab.maximized) {
      root.dataset.maximized = '1';
      root.dataset.maxPlace = tab.dock && tab.dock.panel === tab.maximized ? 'dock' : 'main';
    }

    if (panelCount(tab) === 0) {
      root.append(emptyState());
    } else {
      const main = el('div', 'pane-main');
      tab.main.forEach((col, ci) => {
        if (ci > 0) main.append(makeSplitter('v', ci, 0, tab));
        const colEl = el('div', 'pane-col');
        colEl.style.flexGrow = String(col.grow);
        if (col.stack.length === 1 && tab.collapsed[col.stack[0].panel]) colEl.classList.add('col-collapsed');
        if (tab.maximized && col.stack.some((it) => it.panel === tab.maximized)) colEl.classList.add('col-max');
        col.stack.forEach((item, si) => {
          if (si > 0) colEl.append(makeSplitter('h', ci, si, tab));
          colEl.append(makeSlot(item.panel, tab, { ci, si }));
        });
        main.append(colEl);
      });
      root.append(main);
      if (tab.dock) {
        root.append(makeSplitter('dock', 0, 0, tab));
        const dock = el('div', 'pane-dock');
        if (tab.collapsed[tab.dock.panel]) {
          dock.classList.add('dock-collapsed');
          dock.style.flex = '0 0 auto';
        } else {
          dock.style.flex = `0 0 ${tab.dock.size}px`;
        }
        dock.append(makeSlot(tab.dock.panel, tab, { dock: true }));
        root.append(dock);
      }
    }

    workspaceEl.append(root);
    // collapse/maximize state also lives on the panel nodes for CSS
    for (const [pid, node] of Object.entries(panelNodes)) {
      node.classList.toggle('collapsed', !!(tab.collapsed && tab.collapsed[pid]));
      node.classList.toggle('maximized', tab.maximized === pid);
    }
  }

  function renderAll() {
    renderTabs();
    renderWorkspace();
    emitChange();
  }

  // delegated panel-header actions (buttons live inside the panel nodes)
  workspaceEl.addEventListener('click', (ev) => {
    const actionBtn = ev.target.closest ? ev.target.closest('[data-action]') : null;
    if (!actionBtn) {
      if (!ev.target.closest || !ev.target.closest('.panel-menu')) closeMenus();
      return;
    }
    const panelEl = actionBtn.closest('.panel');
    if (!panelEl) return;
    const panelId = panelEl.dataset.panelId;
    if (!panelId) return;
    const action = actionBtn.dataset.action;
    if (action === 'collapse') toggleCollapse(panelId);
    else if (action === 'maximize') toggleMaximize(panelId);
    else if (action === 'menu') {
      if (menus.length) closeMenus();
      else openPanelMenu(actionBtn, panelId);
    }
  });

  // click anywhere else closes a floating panel menu
  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (t && t.closest && (t.closest('.panel-menu') || t.closest('[data-action]'))) return;
    if (menus.length) closeMenus();
  });

  if (newTabBtn) {
    newTabBtn.addEventListener('click', () => {
      createTab({ activate: true });
    });
  }
  if (resetBtn) {
    resetBtn.addEventListener('click', () => resetToDefaults());
  }

  // --------------------------------------------------------------- public ---
  const api = {
    init(requestedTab) {
      load(requestedTab);
      renderAll();
      return doc;
    },
    get activeTabId() { return doc ? doc.activeId : null; },
    get document() { return doc; },
    selectTab,
    createTab,
    closeTab,
    movePanel,
    toggleCollapse,
    toggleMaximize,
    /** Restore a previously snapshotted layout (undo for 重置布局). */
    restoreLayout(raw) {
      const next = sanitizeLayout(raw);
      if (!next) return false;
      doc = next;
      save();
      renderAll();
      return true;
    },
    resetLayout() {
      resetToDefaults();
      return doc;
    },
    visiblePanels() { return visiblePanels(activeTab()); },
    save,
    serialize: () => clone(doc),
    /** Stop an in-flight splitter drag (used by tests/teardown). */
    cancelDrag() {
      if (dragCleanup) dragCleanup();
    },
  };
  return api;
}
