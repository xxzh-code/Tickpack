// Workspace layout shell: tabs + recursive group tree, splitters and persistence.
// Pure model/solver lives in layout-tree.js; this module renders it and owns DOM
// interaction only. Platform persistence goes through the host adapter.

import { icon, applyTruncationTitles } from './util.js';
import { rovingIndex, menuIndex, focusSelector, splitterPercent, resetPairSizes } from './a11y.js';
import {
  LAYOUT_VERSION,
  SPLITTER,
  panelTitle,
  isPane,
  isGroup,
  allPanes,
  walkNodes,
  findPaneNode,
  layoutDir,
  nodeMin,
  barThickness,
  fullyCollapsed,
  lastActivePane,
  markPaneActive,
  refreshLastActive,
  movePaneForDrop,
  swapPaneForDrop,
  halfRect,
  moveGroupForDrop,
  transferGroupBetweenRoots,
  collapsedBridgePairs,
  resizeCollapsedBridge,
  rotateGroup,
  reorderTabs,
  clonePaneForCopy,
  addPaneToTab,
  addMissingPaneToTab,
  resetTabTree,
  clearTabTree,
  resetTabVariant,
  clampMenuPosition,
  isExpandedNode,
  expandedPanes,
  solveTab,
  normalizeTree,
  removePaneFromTree,
  appendPaneToRoot,
  ensureOneExpanded,
  collapsePane,
  expandPane,
  sanitizeLayout,
  defaultLayout,
  cloneTree,
} from './layout-tree.js';

export const LAYOUT_KEY = 'tickpack.layout.v2';
export { LAYOUT_VERSION };

export const PANEL_DEFS = [
  { id: 'source', title: '源码' },
  { id: 'world', title: '世界' },
  { id: 'pack', title: '数据包' },
  { id: 'scores', title: '计分板' },
  { id: 'log', title: '运行日志' },
  { id: 'timeline', title: '时间轴' },
];
const MIN_GROW = 1;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function setIcon(button, name) {
  if (!button) return;
  const use = typeof button.querySelector === 'function' ? button.querySelector('use') : null;
  if (use) use.setAttribute('href', `#i-${name}`);
  else button.innerHTML = icon(name);
}

function collapseIcon(dir, index, count, collapsed) {
  if (dir === 'V') {
    const towardTop = index <= count - 1 - index;
    const collapse = towardTop ? 'chevrons-up' : 'chevrons-down';
    const expand = towardTop ? 'chevrons-down' : 'chevrons-up';
    return collapsed ? expand : collapse;
  }
  const towardLeft = index <= count - 1 - index;
  const collapse = towardLeft ? 'chevrons-left' : 'chevrons-right';
  const expand = towardLeft ? 'chevrons-right' : 'chevrons-left';
  return collapsed ? expand : collapse;
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
  let pendingFrame = 0;
  let pendingEmit = 0;
  let lastSize = { w: 0, h: 0 };
  let restrictedNotified = false;
  const nodeEls = new Map();
  let headerDrag = null;
  let groupDrag = null;
  let collapsedBridges = [];
  let bridgeRaf = 0;
  let dragGaps = [];
  let dragGhost = null;
  let dragLabel = null;
  let dragShield = null;
  let dragTargetBox = null;
  let protectedPanel = null;
  let tabDragId = null;
  let tabDropId = null;
  let tabDropAfter = false;
  let tabClickSuppressedUntil = 0;

  const notify = (message) => { if (typeof onNotify === 'function') onNotify(message); };
  const theaterLocked = () => typeof document !== 'undefined' && document.documentElement.dataset.view === 'theater';
  const activeTab = () => doc.tabs.find((t) => t.id === doc.activeId) || doc.tabs[0];

  function canPersist() {
    return !!(host && host.canPersist !== false && typeof host.storageSet === 'function');
  }

  function save() {
    if (theaterLocked()) return false;
    if (!canPersist()) return false;
    try { host.storageSet(LAYOUT_KEY, JSON.stringify(doc)); return true; } catch { return false; }
  }

  function load(requestedTab) {
    let parsed = null;
    if (host && typeof host.storageGet === 'function') {
      try {
        const raw = host.storageGet(LAYOUT_KEY);
        if (raw) parsed = sanitizeLayout(JSON.parse(raw));
      } catch { parsed = null; }
    }
    doc = parsed || defaultLayout();
    if (requestedTab) {
      const match = doc.tabs.find((t) => t.id === requestedTab);
      doc.activeId = match ? match.id : doc.tabs[0].id;
    }
    if (!doc.tabs.some((t) => t.id === doc.activeId)) doc.activeId = doc.tabs[0].id;
  }

  function workspaceBox() {
    let w = 1200;
    let h = 700;
    try {
      const cs = getComputedStyle(workspaceEl);
      w = workspaceEl.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      h = workspaceEl.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
    } catch { /* fallback */ }
    return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
  }

  function visiblePanels(tab) {
    if (!tab) return new Set();
    if (tab.maximized && !theaterLocked()) return new Set([tab.maximized]);
    return new Set(expandedPanes(tab.root).map((p) => p.panel));
  }

  function panelsOfTab(tab) {
    return allPanes(tab && tab.root).map((p) => p.panel);
  }

  function panelCount(tab) {
    return allPanes(tab && tab.root).length;
  }

  function focusKeyOf(element) {
    if (!element || !element.closest) return '';
    const keyed = element.closest('[data-focus-key]');
    if (keyed) return keyed.getAttribute('data-focus-key') || '';
    const tab = element.closest('.tab');
    if (tab && tab.dataset.tabId) return `tab:${tab.dataset.tabId}`;
    return '';
  }

  function captureFocusKey() {
    return focusKeyOf(document.activeElement);
  }

  function focusByKey(key) {
    if (!key) return false;
    const node = document.querySelector(focusSelector(key));
    if (!node) return false;
    try { node.focus({ preventScroll: true }); } catch { try { node.focus(); } catch { /* ignore */ } }
    return document.activeElement === node;
  }

  function restoreFocus(key) {
    if (focusByKey(key)) return;
    const active = activeTab();
    if (active) focusByKey(`tab:${active.id}`);
  }

  function focusTab(tabId) {
    return focusByKey(`tab:${tabId}`);
  }

  function focusPanelAfterDrop(panelId) {
    const slots = workspaceEl.querySelectorAll('.pane-slot[data-panel-id]');
    const slot = [...slots].find((node) => node.dataset.panelId === panelId);
    const head = slot && slot.querySelector('.panel-head');
    if (!head) return false;
    head.tabIndex = -1;
    try { head.focus({ preventScroll: true }); } catch { try { head.focus(); } catch { return false; } }
    return document.activeElement === head;
  }

  function emitChange() {
    const tab = activeTab();
    if (typeof onLayoutChange === 'function') {
      onLayoutChange({ tabId: tab ? tab.id : null, visiblePanels: visiblePanels(tab), tab });
    }
  }

  function scheduleEmit() {
    if (pendingEmit) return;
    pendingEmit = requestAnimationFrame(() => {
      pendingEmit = 0;
      emitChange();
    });
  }

  function findPaneInfo(panelId, tab = activeTab()) {
    if (!tab || !tab.root) return null;
    function walk(node, parentDir, parent, index) {
      if (isPane(node)) {
        if (node.panel === panelId) return { tab, pane: node, parent, index, dir: parentDir };
        return null;
      }
      const eff = layoutDir(node, parentDir);
      for (let i = 0; i < node.children.length; i++) {
        const got = walk(node.children[i], eff, node, i);
        if (got) return got;
      }
      return null;
    }
    return walk(tab.root, tab.root.dir, null, 0);
  }

  function updateControls(pane, info) {
    const panel = panelNodes[pane.panel];
    if (!panel) return;
    const title = panelTitle(pane.panel);
    const count = info && info.parent ? info.parent.children.length : 1;
    const dir = info ? info.dir : 'H';
    const collapseBtn = panel.querySelector && panel.querySelector('[data-action="collapse"]');
    if (collapseBtn) {
      collapseBtn.dataset.focusKey = `action:${pane.panel}:collapse`;
      setIcon(collapseBtn, collapseIcon(dir, info ? info.index : 0, count, pane.collapsed));
      collapseBtn.title = `${pane.collapsed ? '展开' : '折叠'} ${title}`;
      collapseBtn.setAttribute('aria-label', `${pane.collapsed ? '展开' : '折叠'} ${title}`);
      collapseBtn.setAttribute('aria-expanded', pane.collapsed ? 'false' : 'true');
    }
    const maxBtn = panel.querySelector && panel.querySelector('[data-action="maximize"]');
    const tab = activeTab();
    if (maxBtn) {
      maxBtn.dataset.focusKey = `action:${pane.panel}:maximize`;
      const maximized = !!(tab && tab.maximized === pane.panel);
      setIcon(maxBtn, maximized ? 'minimize' : 'maximize');
      maxBtn.title = maximized ? '还原' : '最大化';
      maxBtn.setAttribute('aria-label', maximized ? '还原' : '最大化');
      maxBtn.setAttribute('aria-pressed', maximized ? 'true' : 'false');
    }
    const menuBtn = panel.querySelector && panel.querySelector('[data-action="menu"]');
    if (menuBtn) {
      menuBtn.dataset.focusKey = `action:${pane.panel}:menu`;
      menuBtn.setAttribute('aria-expanded', 'false');
      setIcon(menuBtn, 'more-horizontal');
      menuBtn.title = '更多操作';
      menuBtn.setAttribute('aria-label', '更多操作');
      menuBtn.setAttribute('aria-haspopup', 'menu');
    }
  }

  function memberSummary(group) {
    return allPanes(group).map((p) => panelTitle(p.panel)).join('、');
  }

  function markActive(panelId) {
    if (theaterLocked()) return;
    const tab = activeTab();
    if (!tab) return;
    if (markPaneActive(tab.root, panelId)) save();
  }

  function expandCapsuleGroup(group, tab) {
    if (theaterLocked()) return;
    const pane = lastActivePane(group) || allPanes(group)[0];
    if (!pane) return;
    const info = findPaneInfo(pane.panel, tab);
    if (!info) return;
    expandWithWeight(pane, info);
    protectedPanel = pane.panel;
    markPaneActive(tab.root, pane.panel);
    save();
    renderAll();
  }

  function expandCapsulePane(group, panelId, tab) {
    if (theaterLocked()) return;
    const pane = allPanes(group).find((p) => p.panel === panelId);
    if (!pane) return;
    const info = findPaneInfo(panelId, tab);
    if (!info) return;
    expandWithWeight(pane, info);
    protectedPanel = pane.panel;
    markPaneActive(tab.root, panelId);
    save();
    renderAll();
  }

  function positionMenu(menu, button, { align = 'right' } = {}) {
    const winW = typeof window !== 'undefined' ? window.innerWidth : 1200;
    const winH = typeof window !== 'undefined' ? window.innerHeight : 800;
    const margin = 8;
    menu.style.position = 'fixed';
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.style.right = 'auto';
    menu.style.maxWidth = `${Math.max(160, winW - margin * 2)}px`;
    menu.style.maxHeight = `${Math.max(120, winH - margin * 2)}px`;
    menu.style.overflowY = 'auto';
    menu.style.visibility = 'hidden';
    document.body.appendChild(menu);
    menus.push(menu);
    const rect = typeof button.getBoundingClientRect === 'function'
      ? button.getBoundingClientRect()
      : { left: winW - 40, right: winW - 12, top: 28, bottom: 40 };
    const mw = menu.offsetWidth || menu.getBoundingClientRect().width || 180;
    const mh = menu.offsetHeight || menu.getBoundingClientRect().height || 120;
    const pos = clampMenuPosition({
      button: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      width: mw, height: mh, vw: winW, vh: winH, margin, align,
    });
    menu.style.left = `${Math.round(pos.left)}px`;
    menu.style.top = `${Math.round(pos.top)}px`;
    menu.style.visibility = 'visible';
  }

  function openCapsuleMenu(button, group, tab) {
    if (theaterLocked()) return;
    closeMenus();
    const menu = el('div', 'panel-menu');
    menu.setAttribute('role', 'menu');
    button.setAttribute('aria-haspopup', 'menu');
    if (button.dataset.action === 'capsule-menu') button.setAttribute('aria-expanded', 'true');
    addMenuItem(menu, `展开分栏（${allPanes(group).length}）`, () => {}, { heading: true });
    for (const pane of allPanes(group)) {
      addMenuItem(menu, panelTitle(pane.panel), () => expandCapsulePane(group, pane.panel, tab));
    }
    positionMenu(menu, button);
  }

  function makeCapsule(group, parentDir, info, tab) {
    const capsule = el('div', 'group-capsule');
    capsule.dataset.dir = parentDir;
    capsule.dataset.group = group.lastActive || '';
    capsule.style.flex = `0 0 ${barThickness(parentDir)}px`;
    capsule.style.minWidth = '0';
    capsule.style.minHeight = '0';
    nodeEls.set(group, capsule);
    const members = memberSummary(group);
    const body = el('button', 'capsule-body');
    body.type = 'button';
    body.setAttribute('aria-expanded', 'false');
    body.setAttribute('aria-label', `展开 ${members}（${allPanes(group).length} 个分栏）`);
    body.title = `${members}（${allPanes(group).length} 个分栏）`;
    const iconSpan = el('span', 'capsule-icon');
    iconSpan.innerHTML = icon('panes');
    body.append(iconSpan);
    body.append(el('span', 'capsule-count', String(allPanes(group).length)));
    body.append(el('span', 'capsule-summary', members));
    const chevron = el('span', 'capsule-chevron');
    chevron.innerHTML = icon(parentDir === 'V' ? 'chevron-down' : 'chevron-right');
    body.append(chevron);
    body.addEventListener('pointerdown', (ev) => startCapsuleDrag(ev, body, group, tab));
    body.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (performance.now() < (body._suppressClickUntil || 0)) {
        ev.preventDefault();
        return;
      }
      closeMenus();
      expandCapsuleGroup(group, tab);
    });
    body.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openCapsuleMenu(body, group, tab);
    });
    body.addEventListener('keydown', (ev) => {
      if (ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey)) {
        ev.preventDefault();
        ev.stopPropagation();
        openCapsuleMenu(body, group, tab);
      }
    });
    const menuBtn = el('button', 'capsule-menu icon-btn');
    menuBtn.type = 'button';
    menuBtn.dataset.action = 'capsule-menu';
    menuBtn.setAttribute('aria-expanded', 'false');
    menuBtn.title = '选择要展开的分栏';
    menuBtn.setAttribute('aria-label', '选择要展开的分栏');
    menuBtn.setAttribute('aria-haspopup', 'menu');
    menuBtn.innerHTML = icon('more-horizontal');
    menuBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openCapsuleMenu(menuBtn, group, tab);
    });
    capsule.append(body, menuBtn);
    return capsule;
  }

  function bindPaneActive(panel, panelId) {
    if (panel.dataset.layoutActiveBound === '1') return;
    panel.dataset.layoutActiveBound = '1';
    panel.addEventListener('pointerdown', () => markActive(panelId), { capture: true });
    panel.addEventListener('focusin', () => {
      if (theaterLocked()) return;
      const tab = activeTab();
      if (tab) markPaneActive(tab.root, panelId);
    });
  }

  function rectHas(rect, x, y) {
    return !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function ancestorGroups(tab, panelId) {
    const chain = [];
    function walk(node, path) {
      if (isPane(node)) {
        if (node.panel === panelId) {
          chain.push(...path.slice().reverse());
          return true;
        }
        return false;
      }
      path.push(node);
      for (const child of node.children) if (walk(child, path)) return true;
      path.pop();
      return false;
    }
    walk(tab.root, []);
    return chain;
  }

  function clearDragPreview() {
    for (const gap of dragGaps) gap.el.classList.remove('active');
    for (const el of document.querySelectorAll('.drag-target')) el.classList.remove('drag-target');
    if (dragTargetBox) {
      dragTargetBox.hidden = true;
      dragTargetBox.classList.remove('is-swap', 'is-half', 'is-left', 'is-right', 'is-top', 'is-bottom');
    }
    if (dragLabel) {
      dragLabel.textContent = '';
      dragLabel.hidden = true;
    }
    for (const tabEl of tabsEl.querySelectorAll('.tab')) tabEl.classList.remove('tab-drop-target');
    tabsEl.classList.remove('tab-drop-new');
    document.body.classList.remove('drag-valid', 'drag-invalid');
  }

  function buildDragGaps(tab) {
    dragGaps = [];
    for (const node of walkNodes(tab.root)) {
      if (!isGroup(node) || fullyCollapsed(node)) continue;
      const groupEl = nodeEls.get(node);
      if (!groupEl) continue;
      const gr = groupEl.getBoundingClientRect();
      const childRects = node.children.map((child) => {
        const el = nodeEls.get(child);
        return el ? el.getBoundingClientRect() : null;
      });
      if (!childRects.length) continue;
      const axis = node.dir;
      for (let i = 0; i <= node.children.length; i++) {
        let coord;
        if (i === 0) coord = axis === 'H' ? gr.left : gr.top;
        else if (i === node.children.length) coord = axis === 'H' ? gr.right : gr.bottom;
        else {
          const a = childRects[i - 1];
          const b = childRects[i];
          if (!a || !b) continue;
          coord = axis === 'H' ? (a.right + b.left) / 2 : (a.bottom + b.top) / 2;
        }
        const gap = el('div', `drag-gap drag-gap-${axis === 'H' ? 'v' : 'h'}`);
        gap.dataset.dir = axis;
        const hit = axis === 'H'
          ? { left: coord - 5, top: gr.top, width: 10, height: gr.height }
          : { left: gr.left, top: coord - 5, width: gr.width, height: 10 };
        gap.style.position = 'fixed';
        gap.style.left = `${hit.left}px`;
        gap.style.top = `${hit.top}px`;
        gap.style.width = `${Math.max(1, hit.width)}px`;
        gap.style.height = `${Math.max(1, hit.height)}px`;
        gap.style.pointerEvents = 'none';
        gap.style.zIndex = '160';
        document.body.appendChild(gap);
        dragGaps.push({ group: node, index: i, axis, coord, groupRect: gr, hit, el: gap });
      }
    }
  }

  function nearestGap(x, y) {
    let best = null;
    for (const gap of dragGaps) {
      const g = gap.groupRect;
      let distance;
      if (gap.axis === 'H') {
        if (y < g.top - 24 || y > g.bottom + 24) continue;
        distance = Math.abs(x - gap.coord);
      } else {
        if (x < g.left - 24 || x > g.right + 24) continue;
        distance = Math.abs(y - gap.coord);
      }
      if (distance <= 14 && (!best || distance < best.distance)) best = { gap, distance };
    }
    return best ? best.gap : null;
  }

  function paneUnderPoint(x, y, sourcePanelId) {
    const elements = document.elementsFromPoint
      ? document.elementsFromPoint(x, y)
      : [document.elementFromPoint ? document.elementFromPoint(x, y) : null];
    let slot = null;
    for (const at of elements) {
      if (!at || !at.closest || at.closest('.drag-shield')) continue;
      const found = at.closest('.pane-slot[data-panel-id]');
      if (found) { slot = found; break; }
    }
    if (!slot || slot.dataset.panelId === sourcePanelId) return null;
    if (slot.classList.contains('is-collapsed')) return null;
    const rect = slot.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const edges = [
      { side: 'left', d: x - rect.left },
      { side: 'right', d: rect.right - x },
      { side: 'top', d: y - rect.top },
      { side: 'bottom', d: rect.bottom - y },
    ].sort((a, b) => a.d - b.d);
    const limit = Math.min(48, Math.max(18, Math.min(rect.width, rect.height) * 0.3));
    const nearest = edges[0];
    return {
      paneId: slot.dataset.panelId,
      side: nearest.d <= limit ? nearest.side : null,
      nearestSide: nearest.side,
      center: nearest.d > limit,
      rect,
      slot,
    };
  }

  function tabDropTargetAt(x, y, sourceTab, copy) {
    if (!tabsEl || !rectHas(tabsEl.getBoundingClientRect(), x, y)) return null;
    let tabNode = null;
    for (const node of tabsEl.querySelectorAll('.tab')) {
      if (rectHas(node.getBoundingClientRect(), x, y)) { tabNode = node; break; }
    }
    if (!tabNode) {
      return { kind: 'tab-new', copy: !!copy, label: copy ? '复制到新标签页' : '移动到新标签页' };
    }
    const targetTab = doc.tabs.find((t) => t.id === tabNode.dataset.tabId);
    if (!targetTab) return null;
    const current = targetTab.id === sourceTab.id;
    const doCopy = !current && !!copy;
    return {
      kind: 'tab-end',
      tab: targetTab,
      tabNode,
      copy: doCopy,
      current,
      label: current
        ? '移到当前页末尾'
        : (doCopy ? `复制到「${targetTab.name}」末尾` : `移到「${targetTab.name}」末尾`),
    };
  }

  function detectDropTarget(tab, x, y, sourcePanelId, state) {
    const tabTarget = tabDropTargetAt(x, y, tab, state.copy);
    if (tabTarget) return tabTarget;
    const wr = workspaceEl.getBoundingClientRect();
    if (rectHas(wr, x, y)) {
      const edges = [
        { edge: 'left', d: x - wr.left },
        { edge: 'right', d: wr.right - x },
        { edge: 'top', d: y - wr.top },
        { edge: 'bottom', d: wr.bottom - y },
      ].sort((a, b) => a.d - b.d);
      if (edges[0].d <= 26) {
        const edge = edges[0].edge;
        return { kind: 'root-edge', edge, label: `根级：${edge}` };
      }
    }
    const gap = nearestGap(x, y);
    if (gap) {
      return { kind: 'gap', group: gap.group, index: gap.index, gap, label: '作为兄弟插入' };
    }
    const pane = paneUnderPoint(x, y, sourcePanelId);
    if (pane) {
      if (state.ancestorMode) {
        const chain = ancestorGroups(tab, pane.paneId);
        if (chain.length) {
          const node = chain[Math.min(chain.length - 1, Math.max(0, state.ancestorIndex))];
          const side = pane.side || pane.nearestSide;
          if (node === tab.root) {
            return { kind: 'root-edge', edge: side, label: '根级：包裹整个根内容' };
          }
          return { kind: 'wrap', node, side, label: `将包裹：${memberSummary(node)}` };
        }
      }
      if (pane.center) {
        return {
          kind: 'swap',
          node: findPaneNode(tab.root, pane.paneId),
          paneId: pane.paneId,
          rect: pane.rect,
          slot: pane.slot,
          label: `交换：${panelTitle(pane.paneId)}`,
        };
      }
      return { kind: 'wrap', node: findPaneNode(tab.root, pane.paneId), side: pane.side, label: `包裹：${panelTitle(pane.paneId)}` };
    }
    return null;
  }

  function updateDragTarget(x, y) {
    if (!headerDrag || !headerDrag.dragging) return;
    const { tab, panelId } = headerDrag;
    const target = detectDropTarget(tab, x, y, panelId, headerDrag);
    headerDrag.target = target;
    clearDragPreview();
    if (dragGhost) {
      dragGhost.style.left = `${x + 14}px`;
      dragGhost.style.top = `${y + 14}px`;
    }
    if (dragLabel) {
      dragLabel.style.left = `${x + 14}px`;
      dragLabel.style.top = `${y + 34}px`;
    }
    if (!target) {
      document.body.classList.add('drag-invalid');
      if (dragLabel) { dragLabel.hidden = false; dragLabel.textContent = '请拖到分栏中央交换，或拖到边缘/间隙/标签栏'; }
      return;
    }
    document.body.classList.add('drag-valid');
    if (dragLabel) {
      dragLabel.hidden = false;
      dragLabel.textContent = target.label || '';
    }
    if (target.gap) target.gap.el.classList.add('active');
    if (target.kind === 'tab-end' && target.tabNode) target.tabNode.classList.add('tab-drop-target');
    if (target.kind === 'tab-new') tabsEl.classList.add('tab-drop-new');
    let box = null;
    if (target.gap) {
      const hit = target.gap.hit;
      box = { left: hit.left, top: hit.top, width: hit.width, height: hit.height };
    } else if (target.kind === 'tab-end') {
      const r = target.tabNode.getBoundingClientRect();
      box = { left: r.left, top: r.top, width: r.width, height: r.height };
    } else if (target.kind === 'tab-new') {
      const r = tabsEl.getBoundingClientRect();
      box = { left: r.left, top: r.top, width: r.width, height: r.height };
    } else if (target.kind === 'root-edge') {
      const wr = workspaceEl.getBoundingClientRect();
      const band = 24;
      box = target.edge === 'left' ? { left: wr.left, top: wr.top, width: band, height: wr.height }
        : target.edge === 'right' ? { left: wr.right - band, top: wr.top, width: band, height: wr.height }
          : target.edge === 'top' ? { left: wr.left, top: wr.top, width: wr.width, height: band }
            : { left: wr.left, top: wr.bottom - band, width: wr.width, height: band };
    } else if (target.kind === 'swap') {
      const r = target.rect || (target.slot && target.slot.getBoundingClientRect());
      if (r) box = { left: r.left, top: r.top, width: r.width, height: r.height };
      if (dragTargetBox) dragTargetBox.classList.add('is-swap');
    } else if (target.kind === 'wrap') {
      const nodeEl = nodeEls.get(target.node);
      if (nodeEl) {
        const r = nodeEl.getBoundingClientRect();
        box = halfRect({ left: r.left, top: r.top, width: r.width, height: r.height }, target.side);
        if (dragTargetBox && box) {
          dragTargetBox.classList.add('is-half', `is-${target.side}`);
        }
      }
    }
    if (box && dragTargetBox) {
      dragTargetBox.hidden = false;
      dragTargetBox.style.left = `${box.left}px`;
      dragTargetBox.style.top = `${box.top}px`;
      dragTargetBox.style.width = `${Math.max(2, box.width)}px`;
      dragTargetBox.style.height = `${Math.max(2, box.height)}px`;
    }
  }

  function removeDragVisuals() {
    clearDragPreview();
    for (const gap of dragGaps) if (gap.el.parentNode) gap.el.parentNode.removeChild(gap.el);
    dragGaps = [];
    if (dragShield && dragShield.parentNode) dragShield.parentNode.removeChild(dragShield);
    if (dragTargetBox && dragTargetBox.parentNode) dragTargetBox.parentNode.removeChild(dragTargetBox);
    if (dragGhost && dragGhost.parentNode) dragGhost.parentNode.removeChild(dragGhost);
    if (dragLabel && dragLabel.parentNode) dragLabel.parentNode.removeChild(dragLabel);
    dragShield = null;
    dragTargetBox = null;
    dragGhost = null;
    dragLabel = null;
    document.body.classList.remove('dragging-pane', 'dragging-group', 'drag-valid', 'drag-invalid');
    for (const el of document.querySelectorAll('.drag-target')) el.classList.remove('drag-target');
  }

  function cleanupHeaderDrag() {
    if (!headerDrag) return;
    headerDrag.removers.forEach((fn) => fn());
    if (headerDrag.slot) headerDrag.slot.classList.remove('drag-source');
    removeDragVisuals();
    headerDrag = null;
  }

  function detectGroupDropTarget(tab, x, y, group, state) {
    const tabTarget = tabDropTargetAt(x, y, tab, state && state.copy);
    if (tabTarget) {
      if (tabTarget.kind === 'tab-end' && tabTarget.current
        && tab.root.children[tab.root.children.length - 1] === group) return null;
      return { ...tabTarget, label: `整组：${tabTarget.label}` };
    }
    const wr = workspaceEl.getBoundingClientRect();
    if (rectHas(wr, x, y)) {
      const edges = [
        { edge: 'left', d: x - wr.left },
        { edge: 'right', d: wr.right - x },
        { edge: 'top', d: y - wr.top },
        { edge: 'bottom', d: wr.bottom - y },
      ].sort((a, b) => a.d - b.d);
      if (edges[0].d <= 26) {
        if (tab.root.children.length === 1 && tab.root.children[0] === group) return null;
        return { kind: 'root-edge', edge: edges[0].edge, label: `整组：根级 ${edges[0].edge}` };
      }
    }
    const gap = nearestGap(x, y);
    if (gap) {
      if (gap.group === group || walkNodes(group).includes(gap.group)) return null;
      return { kind: 'gap', group: gap.group, index: gap.index, gap, label: '整组：作为兄弟插入' };
    }
    return null;
  }

  function updateGroupDragTarget(x, y) {
    if (!groupDrag || !groupDrag.dragging) return;
    const target = detectGroupDropTarget(groupDrag.tab, x, y, groupDrag.group, groupDrag);
    groupDrag.target = target;
    clearDragPreview();
    if (dragGhost) {
      dragGhost.style.left = `${x + 14}px`;
      dragGhost.style.top = `${y + 14}px`;
    }
    if (dragLabel) {
      dragLabel.style.left = `${x + 14}px`;
      dragLabel.style.top = `${y + 34}px`;
    }
    if (!target) {
      document.body.classList.add('drag-invalid');
      if (dragLabel) { dragLabel.hidden = false; dragLabel.textContent = '整组只能放到同标签页的间隙、根边缘或标签栏末尾'; }
      return;
    }
    document.body.classList.add('drag-valid');
    if (dragLabel) { dragLabel.hidden = false; dragLabel.textContent = target.label; }
    if (target.gap) target.gap.el.classList.add('active');
    if (target.kind === 'tab-end' && target.tabNode) target.tabNode.classList.add('tab-drop-target');
    if (target.kind === 'tab-new') tabsEl.classList.add('tab-drop-new');
    let box = null;
    if (target.gap) {
      const hit = target.gap.hit;
      box = { left: hit.left, top: hit.top, width: hit.width, height: hit.height };
    } else if (target.kind === 'tab-end') {
      const r = target.tabNode.getBoundingClientRect();
      box = { left: r.left, top: r.top, width: r.width, height: r.height };
    } else if (target.kind === 'tab-new') {
      const r = tabsEl.getBoundingClientRect();
      box = { left: r.left, top: r.top, width: r.width, height: r.height };
    } else if (target.kind === 'root-edge') {
      const wr = workspaceEl.getBoundingClientRect();
      const band = 24;
      box = target.edge === 'left' ? { left: wr.left, top: wr.top, width: band, height: wr.height }
        : target.edge === 'right' ? { left: wr.right - band, top: wr.top, width: band, height: wr.height }
          : target.edge === 'top' ? { left: wr.left, top: wr.top, width: wr.width, height: band }
            : { left: wr.left, top: wr.bottom - band, width: wr.width, height: band };
    }
    if (box && dragTargetBox) {
      dragTargetBox.hidden = false;
      dragTargetBox.style.left = `${box.left}px`;
      dragTargetBox.style.top = `${box.top}px`;
      dragTargetBox.style.width = `${Math.max(2, box.width)}px`;
      dragTargetBox.style.height = `${Math.max(2, box.height)}px`;
    }
  }

  function cleanupGroupDrag() {
    if (!groupDrag) return;
    if (groupDrag.dragging && groupDrag.body) {
      groupDrag.body._suppressClickUntil = performance.now() + 400;
    }
    groupDrag.removers.forEach((fn) => fn());
    const capsule = nodeEls.get(groupDrag.group);
    if (capsule) capsule.classList.remove('drag-source');
    removeDragVisuals();
    groupDrag = null;
  }

  function commitPaneTabDrop(panelId, sourceTab, target) {
    let targetTab = target.tab;
    if (target.kind === 'tab-new') targetTab = createTab({ activate: false });
    if (!targetTab) return false;
    let ok = false;
    if (targetTab.id === sourceTab.id) {
      ok = movePanel(panelId, targetTab.id, { toEnd: true });
    } else if (target.copy) {
      ok = copyPanel(panelId, targetTab.id);
    } else {
      ok = movePanel(panelId, targetTab.id);
    }
    if (!ok) return false;
    doc.activeId = targetTab.id;
    save();
    renderAll();
    requestAnimationFrame(() => {
      if (!focusPanelAfterDrop(panelId)) focusTab(doc.activeId);
    });
    return true;
  }

  function commitGroupTabDrop(group, sourceTab, target) {
    let targetTab = target.tab;
    if (target.kind === 'tab-new') targetTab = createTab({ activate: false });
    if (!targetTab) return false;
    let result;
    if (targetTab.id === sourceTab.id) {
      result = moveGroupForDrop(sourceTab.root, group, { kind: 'tab-end' });
    } else {
      result = transferGroupBetweenRoots(sourceTab.root, targetTab.root, group, { copy: !!target.copy });
    }
    if (!result.ok) return false;
    doc.activeId = targetTab.id;
    save();
    renderAll();
    requestAnimationFrame(() => {
      const capsule = nodeEls.get(result.group);
      const body = capsule && capsule.querySelector('.capsule-body');
      if (body) body.focus({ preventScroll: true });
      else focusTab(doc.activeId);
    });
    return true;
  }

  function startCapsuleDrag(ev, body, group, tab) {
    if (theaterLocked()) return;
    if (ev.button != null && ev.button !== 0) return;
    const state = {
      startX: ev.clientX,
      startY: ev.clientY,
      lastX: ev.clientX,
      lastY: ev.clientY,
      group,
      tab,
      body,
      dragging: false,
      copy: !!(ev.ctrlKey || ev.metaKey),
      target: null,
      removers: [],
    };
    groupDrag = state;
    const onMove = (mv) => {
      state.lastX = mv.clientX;
      state.lastY = mv.clientY;
      state.copy = !!(mv.ctrlKey || mv.metaKey);
      if (!state.dragging) {
        if (Math.hypot(mv.clientX - state.startX, mv.clientY - state.startY) < 5) return;
        state.dragging = true;
        body._suppressClickUntil = performance.now() + 400;
        if (typeof mv.preventDefault === 'function') mv.preventDefault();
        document.body.classList.add('dragging-group');
        const capsule = nodeEls.get(group);
        if (capsule) capsule.classList.add('drag-source');
        dragShield = el('div', 'drag-shield');
        dragTargetBox = el('div', 'drag-target-box');
        dragTargetBox.hidden = true;
        dragGhost = el('div', 'pane-drag-ghost', `整组：${memberSummary(group)}`);
        dragLabel = el('div', 'pane-drag-label');
        dragLabel.hidden = true;
        document.body.append(dragShield, dragTargetBox, dragGhost, dragLabel);
        buildDragGaps(tab);
      }
      updateGroupDragTarget(mv.clientX, mv.clientY);
    };
    const onUp = (mv) => {
      if (mv && Number.isFinite(mv.clientX)) { state.lastX = mv.clientX; state.lastY = mv.clientY; }
      if (mv) state.copy = !!(mv.ctrlKey || mv.metaKey);
      if (!state.dragging) { cleanupGroupDrag(); return; }
      const target = detectGroupDropTarget(tab, state.lastX, state.lastY, group, state);
      cleanupGroupDrag();
      if (!target) {
        notify('整组只能放到同标签页的间隙、根边缘或标签栏末尾');
        return;
      }
      if (target.kind === 'tab-end' || target.kind === 'tab-new') {
        if (!commitGroupTabDrop(group, tab, target)) notify('无法完成整组标签页移动');
        return;
      }
      const result = moveGroupForDrop(tab.root, group, target);
      if (!result.ok) {
        notify('无法完成整组移动');
        return;
      }
      save();
      renderAll();
      requestAnimationFrame(() => {
        const capsule = nodeEls.get(group);
        const nextBody = capsule && capsule.querySelector('.capsule-body');
        if (nextBody) nextBody.focus({ preventScroll: true });
        else focusTab(doc.activeId);
      });
    };
    const onCancel = () => cleanupGroupDrag();
    const onKey = (kev) => {
      if (kev.key === 'Escape') {
        kev.preventDefault();
        kev.stopPropagation();
        cleanupGroupDrag();
      } else if (kev.key === 'Control' || kev.key === 'Meta') {
        kev.preventDefault();
        state.copy = true;
        if (state.dragging) updateGroupDragTarget(state.lastX, state.lastY);
      }
    };
    const onKeyUp = (kev) => {
      if (kev.key !== 'Control' && kev.key !== 'Meta') return;
      kev.preventDefault();
      state.copy = false;
      if (state.dragging) updateGroupDragTarget(state.lastX, state.lastY);
    };
    const add = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      state.removers.push(() => target.removeEventListener(type, fn, opts));
    };
    add(window, 'pointermove', onMove);
    add(window, 'pointerup', onUp);
    add(window, 'pointercancel', onCancel);
    add(window, 'keydown', onKey, true);
    add(window, 'keyup', onKeyUp, true);
  }

  function startHeaderDrag(ev, panelId) {
    if (theaterLocked()) return;
    const tab = activeTab();
    const panel = panelNodes[panelId];
    if (!tab || !panel) return;
    const slot = panel.closest ? panel.closest('.pane-slot') : null;
    const state = {
      startX: ev.clientX,
      startY: ev.clientY,
      lastX: ev.clientX,
      lastY: ev.clientY,
      panelId,
      tab,
      slot,
      dragging: false,
      ancestorMode: !!ev.altKey,
      altHeld: !!ev.altKey,
      ancestorIndex: 0,
      copy: !!(ev.ctrlKey || ev.metaKey),
      target: null,
      removers: [],
    };
    headerDrag = state;
    const onMove = (mv) => {
      state.lastX = mv.clientX;
      state.lastY = mv.clientY;
      state.copy = !!(mv.ctrlKey || mv.metaKey);
      if (!state.dragging) {
        if (Math.hypot(mv.clientX - state.startX, mv.clientY - state.startY) < 5) return;
        state.dragging = true;
        if (typeof mv.preventDefault === 'function') mv.preventDefault();
        document.body.classList.add('dragging-pane');
        if (slot) slot.classList.add('drag-source');
        dragShield = el('div', 'drag-shield');
        dragTargetBox = el('div', 'drag-target-box');
        dragTargetBox.hidden = true;
        dragGhost = el('div', 'pane-drag-ghost', panelTitle(panelId));
        dragLabel = el('div', 'pane-drag-label');
        dragLabel.hidden = true;
        document.body.append(dragShield, dragTargetBox, dragGhost, dragLabel);
        buildDragGaps(tab);
      }
      updateDragTarget(mv.clientX, mv.clientY);
    };
    const onUp = (mv) => {
      if (mv && Number.isFinite(mv.clientX)) { state.lastX = mv.clientX; state.lastY = mv.clientY; }
      if (mv) state.copy = !!(mv.ctrlKey || mv.metaKey);
      if (!state.dragging) { cleanupHeaderDrag(); return; }
      const target = detectDropTarget(tab, state.lastX, state.lastY, panelId, state);
      cleanupHeaderDrag();
      if (!target) {
        notify('此处不能放置分栏');
        return;
      }
      if (target.kind === 'tab-end' || target.kind === 'tab-new') {
        if (!commitPaneTabDrop(panelId, tab, target)) notify('无法完成标签页移动');
        return;
      }
      const result = target.kind === 'swap'
        ? swapPaneForDrop(tab.root, panelId, target.paneId)
        : movePaneForDrop(tab.root, panelId, target);
      if (!result.ok) {
        notify('无法完成这次分栏移动');
        return;
      }
      result.pane.collapsed = false;
      protectedPanel = panelId;
      ensureOneExpanded(tab.root, panelId);
      markPaneActive(tab.root, panelId);
      refreshLastActive(tab.root);
      save();
      renderAll();
      requestAnimationFrame(() => {
        if (!focusPanelAfterDrop(panelId)) focusTab(doc.activeId);
      });
    };
    const onCancel = () => cleanupHeaderDrag();
    const onKey = (kev) => {
      if (kev.key === 'Escape') { kev.preventDefault(); kev.stopPropagation(); cleanupHeaderDrag(); }
      else if (kev.key === 'Control' || kev.key === 'Meta') {
        kev.preventDefault();
        state.copy = true;
        if (state.dragging) updateDragTarget(state.lastX, state.lastY);
      } else if (kev.key === 'Alt') {
        kev.preventDefault();
        if (!state.altHeld) {
          state.altHeld = true;
          state.ancestorMode = true;
          state.ancestorIndex = 0;
        }
        if (state.dragging) updateDragTarget(state.lastX, state.lastY);
      }
    };
    const onKeyUp = (kev) => {
      if (kev.key === 'Control' || kev.key === 'Meta') {
        kev.preventDefault();
        state.copy = false;
        if (state.dragging) updateDragTarget(state.lastX, state.lastY);
      } else if (kev.key === 'Alt') {
        kev.preventDefault();
        state.altHeld = false;
        state.ancestorMode = false;
        state.ancestorIndex = 0;
        if (state.dragging) updateDragTarget(state.lastX, state.lastY);
      }
    };
    const onWheel = (wev) => {
      if (!state.dragging) return;
      wev.preventDefault();
      if (!state.ancestorMode) return;
      const pane = paneUnderPoint(state.lastX, state.lastY, panelId);
      if (!pane) return;
      const chain = ancestorGroups(tab, pane.paneId);
      if (!chain.length) return;
      const dir = wev.deltaY > 0 ? 1 : -1;
      state.ancestorIndex = (state.ancestorIndex + dir + chain.length) % chain.length;
      updateDragTarget(state.lastX, state.lastY);
    };
    const add = (target, type, fn, opts) => {      target.addEventListener(type, fn, opts);
      state.removers.push(() => target.removeEventListener(type, fn, opts));
    };
    add(window, 'pointermove', onMove);
    add(window, 'pointerup', onUp);
    add(window, 'pointercancel', onCancel);
    add(window, 'keydown', onKey, true);
    add(window, 'keyup', onKeyUp, true);
    add(window, 'wheel', onWheel, { passive: false });
  }

  function makeSlot(pane, parentDir, info) {
    const slot = el('div', 'pane-slot');
    slot.dataset.panelId = pane.panel;
    slot.dataset.dir = parentDir;
    slot.style.flex = `0 0 ${Math.max(0, pane.size || 0)}px`;
    slot.style.minWidth = '0';
    slot.style.minHeight = '0';
    if (pane.collapsed) slot.classList.add('is-collapsed');
    const panel = panelNodes[pane.panel];
    if (!panel) {
      slot.append(el('div', 'panel-missing', '分栏不可用'));
      return slot;
    }
    panel.dataset.panelId = pane.panel;
    panel.classList.toggle('collapsed', pane.collapsed);
    panel.classList.toggle('maximized', activeTab().maximized === pane.panel);
    bindPaneActive(panel, pane.panel);
    updateControls(pane, info);
    slot.append(panel);
    nodeEls.set(pane, slot);
    return slot;
  }

  function updateSplitterAria(splitter, left, right) {
    if (!splitter || !left || !right) return;
    const l = Math.max(0, Number(left.size) || 0);
    const r = Math.max(0, Number(right.size) || 0);
    const pct = splitterPercent(l, r);
    splitter.setAttribute('aria-valuemin', '0');
    splitter.setAttribute('aria-valuemax', '100');
    splitter.setAttribute('aria-valuenow', String(pct));
    splitter.setAttribute('aria-valuetext', `${pct}% / ${100 - pct}%`);
  }

  function resetSplitterPair(group, index, dir, tab) {
    if (theaterLocked()) return false;
    if (!group || group.manualLocked) return false;
    const left = group.children[index - 1];
    const right = group.children[index];
    if (!left || !right || !isExpandedNode(left) || !isExpandedNode(right)) return false;
    const total = (Number.isFinite(left.size) ? left.size : nodeMin(left, dir))
      + (Number.isFinite(right.size) ? right.size : nodeMin(right, dir));
    const minL = nodeMin(left, dir);
    const minR = nodeMin(right, dir);
    const pair = resetPairSizes(total, minL, minR);
    const l = pair.left;
    const r = pair.right;
    left.size = l;
    right.size = r;
    left.weight = Math.max(MIN_GROW, l - minL);
    right.weight = Math.max(MIN_GROW, r - minR);
    const { w, h } = workspaceBox();
    solveTab(tab, w, h, { keepExpanded: protectedPanel });
    applyFrame();
    const splitter = [...document.querySelectorAll('.split')].find((el) => el._splitGroup === group && el._splitIndex === index);
    if (splitter) updateSplitterAria(splitter, left, right);
    save();
    emitChange();
    return true;
  }

  function nudgeSplitter(group, index, dir, delta, tab) {
    if (theaterLocked()) return false;
    if (!group || group.manualLocked) return false;
    const left = group.children[index - 1];
    const right = group.children[index];
    if (!left || !right) return false;
    const total = (Number.isFinite(left.size) ? left.size : nodeMin(left, dir))
      + (Number.isFinite(right.size) ? right.size : nodeMin(right, dir));
    const minL = nodeMin(left, dir);
    const minR = nodeMin(right, dir);
    const step = Math.max(1, Math.round(total * 0.02));
    const l = Math.max(minL, Math.min(total - minR, (Number.isFinite(left.size) ? left.size : minL) + delta * step));
    const r = total - l;
    left.size = l;
    right.size = r;
    left.weight = Math.max(MIN_GROW, l - minL);
    right.weight = Math.max(MIN_GROW, r - minR);
    const { w, h } = workspaceBox();
    solveTab(tab, w, h, { keepExpanded: protectedPanel });
    applyFrame();
    const splitter = [...document.querySelectorAll('.split')].find((el) => el._splitGroup === group && el._splitIndex === index);
    if (splitter) updateSplitterAria(splitter, left, right);
    save();
    emitChange();
    return true;
  }

  function openSplitterMenu(splitter, group, index, dir, tab, point = null) {
    if (theaterLocked()) return;
    closeMenus();
    const menu = el('div', 'panel-menu');
    addMenuItem(menu, '恢复 1:1', () => resetSplitterPair(group, index, dir, tab));
    addMenuItem(menu, '切换组方向 H↔V', () => {
      if (group === tab.root) return;
      rotateGroup(group);
      refreshLastActive(tab.root);
      save();
      renderAll();
    }, { disabled: group === tab.root });
    positionMenu(menu, splitter, point ? { point, align: 'left' } : {});
  }

  function makeSplitter(group, index, dir, tab) {
    const splitter = el('div', `split split-${dir === 'H' ? 'v' : 'h'}`);
    splitter.dataset.split = dir === 'H' ? 'v' : 'h';
    splitter.setAttribute('role', 'separator');
    splitter.setAttribute('aria-orientation', dir === 'H' ? 'vertical' : 'horizontal');
    splitter.tabIndex = theaterLocked() ? -1 : 0;
    if (theaterLocked()) {
      splitter.setAttribute('aria-disabled', 'true');
      splitter.style.pointerEvents = 'none';
    }
    splitter._splitGroup = group;
    splitter._splitIndex = index;
    splitter.style.flex = `0 0 ${SPLITTER}px`;
    splitter.title = theaterLocked() ? '' : '拖动调整 · 双击恢复 1:1 · 右键更多（含旋转）';
    splitter.addEventListener('pointerdown', (ev) => startSplitDrag(ev, group, index, dir, tab));
    splitter.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const now = performance.now();
      if (splitter._lastReset && now - splitter._lastReset < 400) return;
      splitter._lastReset = now;
      resetSplitterPair(group, index, dir, tab);
    });
    splitter.addEventListener('keydown', (ev) => {
      if (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) {
        ev.preventDefault();
        ev.stopPropagation();
        const r = splitter.getBoundingClientRect();
        openSplitterMenu(splitter, group, index, dir, tab, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
        return;
      }
      const dec = dir === 'H' ? 'ArrowLeft' : 'ArrowUp';
      const inc = dir === 'H' ? 'ArrowRight' : 'ArrowDown';
      if (ev.key !== dec && ev.key !== inc) return;
      ev.preventDefault();
      ev.stopPropagation();
      nudgeSplitter(group, index, dir, ev.key === dec ? -1 : 1, tab);
    });
    splitter.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openSplitterMenu(splitter, group, index, dir, tab, { x: ev.clientX, y: ev.clientY });
    });
    updateSplitterAria(splitter, group.children[index - 1], group.children[index]);
    return splitter;
  }

  function renderNode(node, parentDir, info, tab, isRoot = false) {
    if (isPane(node)) return makeSlot(node, parentDir, info);
    // One capsule for the outermost fully collapsed group; descendants stop here.
    if (!isRoot && info && info.parent && fullyCollapsed(node) && allPanes(node).length > 1) {
      return makeCapsule(node, parentDir, info, tab);
    }
    const effective = layoutDir(node, parentDir);
    const groupEl = el('div', 'pane-group');
    groupEl.dataset.dir = effective;
    groupEl.style.display = 'flex';
    groupEl.style.flexDirection = effective === 'H' ? 'row' : 'column';
    groupEl.style.minWidth = '0';
    groupEl.style.minHeight = '0';
    groupEl.style.flex = isRoot ? '1 1 auto' : `0 0 ${Math.max(0, node.size || 0)}px`;
    nodeEls.set(node, groupEl);
    node.children.forEach((child, index) => {
      groupEl.append(renderNode(child, effective, { tab, parent: node, index, dir: effective }, tab, false));
      const next = node.children[index + 1];
      if (next && isExpandedNode(child) && isExpandedNode(next)) {
        groupEl.append(makeSplitter(node, index + 1, effective, tab));
      }
    });
    return groupEl;
  }

  function openEmptyInsertMenu(button, tab) {
    if (theaterLocked()) return;
    closeMenus();
    const menu = el('div', 'panel-menu');
    const missing = PANEL_DEFS.filter((p) => !findPaneNode(tab.root, p.id));
    addMenuItem(menu, '插入分栏', () => {}, { heading: true });
    if (!missing.length) addMenuItem(menu, '全部分栏已存在', () => {}, { disabled: true });
    for (const def of missing) {
      addMenuItem(menu, def.title, () => addPanelToTab(tab.id, def.id));
    }
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'true');
    positionMenu(menu, button, { align: 'left' });
  }

  function openEmptyMoveMenu(button, tab) {
    if (theaterLocked()) return;
    closeMenus();
    const menu = el('div', 'panel-menu');
    const entries = [];
    for (const other of doc.tabs) {
      if (other.id === tab.id) continue;
      for (const pane of allPanes(other.root)) entries.push({ pane, source: other });
    }
    addMenuItem(menu, '从其他标签页移入', () => {}, { heading: true });
    if (!entries.length) addMenuItem(menu, '没有可移入的分栏', () => {}, { disabled: true });
    for (const entry of entries) {
      addMenuItem(menu, `${panelTitle(entry.pane.panel)} · ${entry.source.name}`, () => {
        movePanelFromTab(entry.pane.panel, entry.source.id, tab.id);
      });
    }
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'true');
    positionMenu(menu, button, { align: 'left' });
  }

  function emptyState(tab) {
    const box = el('div', 'tab-empty');
    const titleId = `tab-empty-title-${tab.id}`;
    const hintId = `tab-empty-hint-${tab.id}`;
    box.setAttribute('role', 'region');
    box.setAttribute('aria-labelledby', titleId);
    box.setAttribute('aria-describedby', hintId);
    const img = document.createElement('img');
    img.src = '../logo/logo-big.svg';
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.className = 'tab-empty-logo';
    box.append(img);
    const title = el('h2', 'tab-empty-title', '从空白页开始');
    title.id = titleId;
    box.append(title);
    const hint = el('p', 'tab-empty-hint', '点击下方按钮插入分栏，或从其他标签页移入；也可以重置这个标签页的布局。');
    hint.id = hintId;
    box.append(hint);
    const actions = el('div', 'tab-empty-actions');
    const insert = el('button', 'btn btn-soft btn-sm', '插入分栏');
    insert.type = 'button';
    insert.dataset.focusKey = `empty:${tab.id}:insert`;
    insert.innerHTML = `${icon('plus')}<span class="btn-label">插入分栏</span>`;
    insert.setAttribute('aria-haspopup', 'menu');
    insert.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openEmptyInsertMenu(insert, tab);
    });
    const move = el('button', 'btn btn-soft btn-sm', '移入分栏');
    move.type = 'button';
    move.dataset.focusKey = `empty:${tab.id}:move`;
    move.innerHTML = `${icon('pane-insert')}<span class="btn-label">移入分栏</span>`;
    move.setAttribute('aria-haspopup', 'menu');
    move.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openEmptyMoveMenu(move, tab);
    });
    const reset = el('button', 'btn btn-soft btn-sm', '重置布局');
    reset.type = 'button';
    reset.dataset.focusKey = `empty:${tab.id}:reset`;
    reset.innerHTML = `${icon('undo')}<span class="btn-label">重置布局</span>`;
    reset.addEventListener('click', (ev) => {
      ev.stopPropagation();
      resetTabById(tab.id);
    });
    actions.append(insert, move, reset);
    box.append(actions);
    return box;
  }

  function announceRestricted(tab) {
    let restricted = false;
    for (const node of walkNodes(tab.root)) {
      if (isGroup(node) && (node.restricted || node.manualLocked)) restricted = true;
    }
    if (restricted && !restrictedNotified) {
      restrictedNotified = true;
      notify('空间不足：已自动折叠部分分栏或进入受限布局');
    } else if (!restricted) {
      restrictedNotified = false;
    }
  }

  function updateBridgeAria(el, pair) {
    if (!el || !pair) return;
    const l = Number.isFinite(pair.left.size) ? pair.left.size : nodeMin(pair.left, pair.dir);
    const r = Number.isFinite(pair.right.size) ? pair.right.size : nodeMin(pair.right, pair.dir);
    const pct = splitterPercent(l, r);
    el.setAttribute('aria-valuemin', '0');
    el.setAttribute('aria-valuemax', '100');
    el.setAttribute('aria-valuenow', String(pct));
    el.setAttribute('aria-valuetext', `${pct}% / ${100 - pct}%`);
  }

  function bridgeRect(pair) {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const node of pair.run || []) {
      const el = nodeEls.get(node);
      if (!el || !el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    if (!Number.isFinite(left)) return null;
    return { left, top, width: right - left, height: bottom - top };
  }

  function positionCollapsedBridges() {
    for (const bridge of collapsedBridges) {
      const r = bridgeRect(bridge.pair);
      if (!r) { bridge.el.hidden = true; continue; }
      bridge.el.hidden = false;
      const half = 6;
      if (bridge.pair.dir === 'H') {
        // Sit just outside the collapsed run on its right edge so the capsule
        // label/icon remain fully readable; half the 12px grip is the anchor.
        bridge.el.style.left = `${Math.round(r.left + r.width + half)}px`;
        bridge.el.style.top = `${Math.round(r.top + r.height / 2)}px`;
      } else {
        bridge.el.style.left = `${Math.round(r.left + r.width / 2)}px`;
        bridge.el.style.top = `${Math.round(r.top + r.height + half)}px`;
      }
    }
  }

  function scheduleBridgePosition() {
    if (bridgeRaf) return;
    bridgeRaf = requestAnimationFrame(() => {
      bridgeRaf = 0;
      positionCollapsedBridges();
    });
  }

  function clearCollapsedBridges() {
    for (const bridge of collapsedBridges) if (bridge.el.parentNode) bridge.el.parentNode.removeChild(bridge.el);
    collapsedBridges = [];
    if (bridgeRaf) {
      cancelAnimationFrame(bridgeRaf);
      bridgeRaf = 0;
    }
  }

  function adjustCollapsedBridge(pair, leftSize, { saveNow = false } = {}) {
    if (!pair || theaterLocked()) return false;
    const result = resizeCollapsedBridge(pair, leftSize);
    if (!result.ok) return false;
    const tab = activeTab();
    if (!tab) return false;
    const { w, h } = workspaceBox();
    solveTab(tab, w, h, { keepExpanded: protectedPanel });
    applyFrame();
    const bridge = collapsedBridges.find((item) => item.pair === pair);
    if (bridge) updateBridgeAria(bridge.el, pair);
    scheduleBridgePosition();
    if (saveNow) {
      save();
      emitChange();
    }
    return true;
  }

  function resetCollapsedBridge(pair) {
    if (!pair) return false;
    const l = Number.isFinite(pair.left.size) ? pair.left.size : nodeMin(pair.left, pair.dir);
    const r = Number.isFinite(pair.right.size) ? pair.right.size : nodeMin(pair.right, pair.dir);
    return adjustCollapsedBridge(pair, (l + r) / 2, { saveNow: true });
  }

  function startCollapsedBridgeDrag(ev, pair, el) {
    if (theaterLocked() || (pair.parent && pair.parent.manualLocked)) return;
    if (ev.button != null && ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const start = pair.dir === 'H' ? ev.clientX : ev.clientY;
    const startLeft = Number.isFinite(pair.left.size) ? pair.left.size : nodeMin(pair.left, pair.dir);
    const startRight = Number.isFinite(pair.right.size) ? pair.right.size : nodeMin(pair.right, pair.dir);
    const startLeftWeight = pair.left.weight;
    const startRightWeight = pair.right.weight;
    let pos = start;
    let raf = 0;
    let done = false;
    const badge = document.createElement('span');
    badge.className = 'bridge-ratio';
    document.body.append(badge);
    const updateBadge = () => {
      const l = Number.isFinite(pair.left.size) ? pair.left.size : nodeMin(pair.left, pair.dir);
      const r = Number.isFinite(pair.right.size) ? pair.right.size : nodeMin(pair.right, pair.dir);
      const pct = splitterPercent(l, r);
      badge.textContent = `${pct}% / ${100 - pct}%`;
      const rect = el.getBoundingClientRect();
      badge.style.left = pair.dir === 'H' ? `${Math.round(rect.right + 6)}px` : `${Math.round(rect.left + rect.width / 2)}px`;
      badge.style.top = pair.dir === 'H' ? `${Math.round(rect.top + rect.height / 2)}px` : `${Math.round(rect.bottom + 6)}px`;
    };
    const apply = () => {
      raf = 0;
      adjustCollapsedBridge(pair, startLeft + (pos - start));
      updateBadge();
    };
    const onMove = (mv) => {
      pos = pair.dir === 'H' ? mv.clientX : mv.clientY;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const restore = () => {
      pair.left.size = startLeft;
      pair.right.size = startRight;
      pair.left.weight = startLeftWeight;
      pair.right.weight = startRightWeight;
      const tab = activeTab();
      if (tab) {
        const { w, h } = workspaceBox();
        solveTab(tab, w, h, { keepExpanded: protectedPanel });
        applyFrame();
      }
      updateBridgeAria(el, pair);
      scheduleBridgePosition();
    };
    const cleanup = (cancel = false) => {
      if (done) return;
      done = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (cancel) restore();
      else {
        adjustCollapsedBridge(pair, pair.left.size);
        save();
        emitChange();
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      el.classList.remove('active');
      if (badge.parentNode) badge.parentNode.removeChild(badge);
    };
    const onUp = () => cleanup(false);
    const onCancel = () => cleanup(true);
    const onKey = (kev) => {
      if (kev.key === 'Escape') {
        kev.preventDefault();
        kev.stopPropagation();
        cleanup(true);
      }
    };
    el.classList.add('active');
    updateBadge();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
  }

  function renderCollapsedBridges(tab) {
    clearCollapsedBridges();
    if (theaterLocked() || !tab) return;
    for (const pair of collapsedBridgePairs(tab.root)) {
      if (pair.parent && pair.parent.manualLocked) continue;
      if (!bridgeRect(pair)) continue;
      const el = document.createElement('div');
      el.className = 'collapsed-bridge';
      el.dataset.dir = pair.dir;
      el.tabIndex = 0;
      el.setAttribute('role', 'separator');
      el.setAttribute('aria-orientation', pair.dir === 'H' ? 'vertical' : 'horizontal');
      el.setAttribute('aria-label', '调整折叠段两侧比例（折叠条固定）');
      el.title = '调整折叠段两侧比例';
      updateBridgeAria(el, pair);
      el.addEventListener('pointerdown', (ev) => startCollapsedBridgeDrag(ev, pair, el));
      el.addEventListener('dblclick', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        resetCollapsedBridge(pair);
      });
      el.addEventListener('keydown', (ev) => {
        const dec = pair.dir === 'H' ? 'ArrowLeft' : 'ArrowUp';
        const inc = pair.dir === 'H' ? 'ArrowRight' : 'ArrowDown';
        if (ev.key !== dec && ev.key !== inc) return;
        ev.preventDefault();
        ev.stopPropagation();
        const current = Number.isFinite(pair.left.size) ? pair.left.size : nodeMin(pair.left, pair.dir);
        const total = (Number.isFinite(pair.left.size) ? pair.left.size : nodeMin(pair.left, pair.dir))
          + (Number.isFinite(pair.right.size) ? pair.right.size : nodeMin(pair.right, pair.dir));
        const step = Math.max(1, Math.round(total * 0.02));
        adjustCollapsedBridge(pair, current + (ev.key === dec ? -step : step), { saveNow: true });
      });
      document.body.append(el);
      collapsedBridges.push({ pair, el });
    }
    scheduleBridgePosition();
  }

  function renderWorkspace() {
    clearCollapsedBridges();
    workspaceEl.innerHTML = '';
    nodeEls.clear();
    const tab = activeTab();
    if (!tab) return;
    const root = el('div', 'pane-root');
    root.dataset.tabId = tab.id;
    if (panelCount(tab) === 0) {
      root.append(emptyState(tab));
    } else if (tab.maximized && !theaterLocked()) {
      root.dataset.maximized = '1';
      root.dataset.maxPlace = 'main';
      root.style.flexDirection = tab.root.dir === 'H' ? 'row' : 'column';
      const pane = findPaneNode(tab.root, tab.maximized);
      if (pane) {
        const info = findPaneInfo(tab.maximized, tab);
        const slot = makeSlot(pane, info ? info.dir : tab.root.dir, info);
        slot.classList.add('is-maximized');
        slot.style.flex = '1 1 auto';
        root.append(slot);
      }
    } else {
      const { w, h } = workspaceBox();
      lastSize = { w, h };
      solveTab(tab, w, h, { keepExpanded: protectedPanel });
      announceRestricted(tab);
      root.style.flexDirection = tab.root.dir === 'H' ? 'row' : 'column';
      root.append(renderNode(tab.root, tab.root.dir, { tab, parent: null, index: 0, dir: tab.root.dir }, tab, true));
    }
    workspaceEl.append(root);
    renderCollapsedBridges(tab);
  }

  function applyFrame() {
    for (const [node, element] of nodeEls) {
      if (isGroup(node)) {
        if (element.parentElement && element.parentElement.classList.contains('pane-root')) continue;
        element.style.flex = `0 0 ${Math.max(0, node.size || 0)}px`;
      } else {
        element.style.flex = `0 0 ${Math.max(0, node.size || 0)}px`;
      }
    }
    scheduleBridgePosition();
  }

  function scheduleFrame() {
    if (pendingFrame) return;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = 0;
      const tab = activeTab();
      if (!tab) return;
      const { w, h } = workspaceBox();
      if (w === lastSize.w && h === lastSize.h) { applyFrame(); scheduleEmit(); return; }
      lastSize = { w, h };
      renderWorkspace();
      emitChange();
    });
  }

  function clearTabDrop() {
    tabDropId = null;
    tabDropAfter = false;
    for (const tabEl of tabsEl.querySelectorAll('.tab')) {
      tabEl.classList.remove('tab-drop-before', 'tab-drop-after', 'tab-dragging');
    }
  }

  function tabKeydown(ev) {
    if (theaterLocked()) return;
    if (ev.altKey || ev.metaKey) return;
    const node = ev.target && ev.target.closest ? ev.target.closest('.tab') : null;
    if (!node) return;
    const id = node.dataset.tabId;
    const index = doc.tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    if (ev.target.closest('.tab-close') && (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar')) return;
    if (ev.key === 'F2') {
      ev.preventDefault();
      ev.stopPropagation();
      renameTabById(id);
      return;
    }
    if (ev.key === 'Delete') {
      ev.preventDefault();
      ev.stopPropagation();
      if (doc.tabs.length > 1) closeTab(id);
      focusByKey(`tab:${doc.activeId}`);
      return;
    }
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) {
      ev.preventDefault();
      ev.stopPropagation();
      const next = rovingIndex(index, doc.tabs.length, ev.key);
      const target = doc.tabs[next];
      if (!target) return;
      selectTab(target.id);
      focusTab(target.id);
      return;
    }
    if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
      ev.preventDefault();
      ev.stopPropagation();
      selectTab(id);
      focusTab(id);
    }
  }

  function globalTabKeys(ev) {
    if (theaterLocked()) return;
    if (!ev.ctrlKey || ev.altKey || ev.metaKey) return;
    if (ev.key !== 'PageUp' && ev.key !== 'PageDown') return;
    const active = document.activeElement;
    if (active && active.closest && active.closest('input, textarea, select, [contenteditable="true"], .panel-menu')) return;
    ev.preventDefault();
    ev.stopPropagation();
    const index = Math.max(0, doc.tabs.findIndex((t) => t.id === doc.activeId));
    const next = (index + (ev.key === 'PageDown' ? 1 : -1) + doc.tabs.length) % doc.tabs.length;
    selectTab(doc.tabs[next].id);
    focusTab(doc.tabs[next].id);
  }

  let tabsTruncateRaf = 0;
  function scheduleTabTruncationTitles() {
    if (tabsTruncateRaf) return;
    tabsTruncateRaf = requestAnimationFrame(() => {
      tabsTruncateRaf = 0;
      applyTruncationTitles(tabsEl);
    });
  }

  function renderTabs() {
    tabsEl.innerHTML = '';
    for (const tab of doc.tabs) {
      const node = el('div', 'tab' + (tab.id === doc.activeId ? ' active' : ''));
      node.dataset.tabId = tab.id;
      node.dataset.focusKey = `tab:${tab.id}`;
      node.tabIndex = tab.id === doc.activeId ? 0 : -1;
      node.setAttribute('role', 'tab');
      node.setAttribute('aria-selected', tab.id === doc.activeId ? 'true' : 'false');
      node.setAttribute('aria-current', tab.id === doc.activeId ? 'page' : 'false');
      node.setAttribute('aria-haspopup', 'menu');
      node.title = tab.name;
      const label = el('span', 'tab-label', tab.name);
      label.addEventListener('dblclick', (ev) => { ev.stopPropagation(); startRename(node, label, tab); });
      node.append(label);
      if (doc.tabs.length > 1) {
        const close = el('button', 'tab-close');
        close.type = 'button';
        close.dataset.focusKey = `tab-close:${tab.id}`;
        close.tabIndex = tab.id === doc.activeId ? 0 : -1;
        close.innerHTML = icon('x');
        close.title = '关闭标签页';
        close.setAttribute('aria-label', '关闭标签页');
        close.addEventListener('click', (ev) => { ev.stopPropagation(); closeTab(tab.id); });
        node.append(close);
      }
      node.addEventListener('click', () => {
        if (performance.now() < tabClickSuppressedUntil) return;
        selectTab(tab.id);
      });
      node.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openTabMenu(tab, node);
      });
      node.draggable = true;
      node.addEventListener('pointerdown', (ev) => {
        node._dragBlocked = !!(ev.target.closest && ev.target.closest('.tab-close, input, .tab-rename'));
      });
      node.addEventListener('dragstart', (ev) => {
        if (node._dragBlocked) { ev.preventDefault(); return; }
        tabDragId = tab.id;
        tabDropId = null;
        clearTabDrop();
        node.classList.add('tab-dragging');
        if (ev.dataTransfer) {
          ev.dataTransfer.effectAllowed = 'move';
          try { ev.dataTransfer.setData('text/plain', tab.id); } catch { /* ignore */ }
        }
      });
      node.addEventListener('dragover', (ev) => {
        if (!tabDragId || tabDragId === tab.id) return;
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
        const r = node.getBoundingClientRect();
        tabDropId = tab.id;
        tabDropAfter = ev.clientX > r.left + r.width / 2;
        for (const tabEl of tabsEl.querySelectorAll('.tab')) tabEl.classList.remove('tab-drop-before', 'tab-drop-after');
        node.classList.add(tabDropAfter ? 'tab-drop-after' : 'tab-drop-before');
      });
      node.addEventListener('dragleave', (ev) => {
        if (ev.relatedTarget && node.contains(ev.relatedTarget)) return;
        node.classList.remove('tab-drop-before', 'tab-drop-after');
      });
      node.addEventListener('drop', (ev) => {
        ev.preventDefault();
        if (!tabDragId || tabDragId === tab.id) return;
        const after = tabDropAfter;
        const moved = reorderTabs(doc.tabs, tabDragId, tab.id, after);
        clearTabDrop();
        tabDragId = null;
        tabClickSuppressedUntil = performance.now() + 250;
        if (moved) { save(); renderTabs(); }
      });
      node.addEventListener('dragend', () => {
        tabDragId = null;
        tabClickSuppressedUntil = performance.now() + 250;
        clearTabDrop();
      });
      tabsEl.append(node);
    }
    scheduleTabTruncationTitles();
  }

  function activateTabForAction(tabId) {
    if (doc.activeId === tabId) return;
    protectedPanel = null;
    doc.activeId = tabId;
    save();
    renderAll();
  }

  function renameTabById(tabId) {
    const tab = doc.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    activateTabForAction(tabId);
    const node = tabsEl.querySelector(`.tab[data-tab-id="${tab.id}"]`);
    const label = node && node.querySelector('.tab-label');
    if (node && label) startRename(node, label, tab);
  }

  function addPanelToTab(tabId, panelId) {
    if (theaterLocked()) return false;
    const tab = doc.tabs.find((t) => t.id === tabId);
    if (!tab || !PANEL_DEFS.some((p) => p.id === panelId)) return false;
    if (findPaneNode(tab.root, panelId)) return false;
    activateTabForAction(tabId);
    if (!addMissingPaneToTab(tab, panelId)) return false;
    protectedPanel = panelId;
    ensureOneExpanded(tab.root, panelId);
    refreshLastActive(tab.root);
    save();
    renderAll();
    return true;
  }

  function resetTabById(tabId) {
    if (theaterLocked()) return false;
    const tab = doc.tabs.find((t) => t.id === tabId);
    if (!tab) return false;
    const defaults = defaultLayout();
    const defaultTab = defaults.tabs.find((t) => t.id === tab.id);
    if (!resetTabVariant(tab, defaultTab || null)) return false;
    if (activeTab() === tab) protectedPanel = null;
    save();
    renderAll();
    notify(defaultTab ? `已重置「${tab.name}」` : `已清空「${tab.name}」`);
    return true;
  }

  function copyPanel(panelId, targetTabId, { newTab = false } = {}) {
    if (theaterLocked()) return false;
    const sourceTab = activeTab();
    const source = findPaneInfo(panelId, sourceTab);
    if (!source) return false;
    let target = targetTabId ? doc.tabs.find((t) => t.id === targetTabId) : null;
    if (!target && !newTab) return false;
    if (target && target.id === sourceTab.id) return false;
    if (target && findPaneNode(target.root, panelId)) return false;
    if (!target && newTab) {
      target = createTab({ activate: false });
    }
    if (!target) return false;
    if (!addPaneToTab(target, clonePaneForCopy(source.pane))) return false;
    ensureOneExpanded(target.root);
    refreshLastActive(target.root);
    save();
    renderAll();
    notify(`已复制「${panelTitle(panelId)}」到「${target.name}」`);
    return true;
  }

  function openTabMenu(tab, tabNode) {
    if (theaterLocked()) return;
    closeMenus();
    tabNode.setAttribute('aria-haspopup', 'menu');
    const menu = el('div', 'panel-menu');
    menu.setAttribute('role', 'menu');
    addMenuItem(menu, '重命名', () => renameTabById(tab.id));
    addMenuItem(menu, '添加分栏', () => {}, { heading: true });
    const missing = PANEL_DEFS.filter((p) => !findPaneNode(tab.root, p.id));
    if (!missing.length) addMenuItem(menu, '全部分栏已存在', () => {}, { disabled: true });
    for (const paneDef of missing) {
      addMenuItem(menu, paneDef.title, () => addPanelToTab(tab.id, paneDef.id));
    }
    addMenuSeparator(menu);
    addMenuItem(menu, '仅重置当前标签页', () => resetTabById(tab.id));
    addMenuItem(menu, '关闭标签页', () => closeTab(tab.id), { disabled: doc.tabs.length <= 1 });
    positionMenu(menu, tabNode, { align: 'left' });
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
      const hadFocus = document.activeElement === input;
      done = true;
      const name = cancel ? tab.name : input.value.trim().slice(0, 24);
      if (name && name !== tab.name) {
        tab.name = name;
        save();
        renderTabs();
      } else {
        renderTabs();
      }
      if (hadFocus) focusTab(tab.id);
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
    protectedPanel = null;
    doc.activeId = id;
    save();
    renderAll();
  }

  function createTab({ activate = true } = {}) {
    if (theaterLocked()) return null;
    const id = `tab-${doc.nextId++}`;
    const tab = { id, name: `标签页 ${doc.nextId - 1}`, root: { dir: 'H', children: [] }, maximized: null };
    doc.tabs.push(tab);
    if (activate) { doc.activeId = tab.id; protectedPanel = null; }
    save();
    renderAll();
    return tab;
  }

  function closeTab(id) {
    if (theaterLocked()) return false;
    if (doc.tabs.length <= 1) { notify('至少保留一个标签页'); return false; }
    const index = doc.tabs.findIndex((t) => t.id === id);
    if (index === -1) return false;
    const closing = doc.tabs[index];
    const remaining = doc.tabs.filter((_, i) => i !== index);
    const hostTab = remaining[Math.max(0, index - 1)] || remaining[0];
    for (const pane of allPanes(closing.root)) {
      if (remaining.some((t) => findPaneNode(t.root, pane.panel))) continue;
      appendPaneToRoot(hostTab.root, pane);
    }
    doc.tabs.splice(index, 1);
    if (doc.activeId === id) { doc.activeId = hostTab.id; protectedPanel = null; }
    ensureOneExpanded(hostTab.root);
    refreshLastActive(hostTab.root);
    save();
    renderAll();
    return true;
  }

  function ensureSourceExpandedAfterRemoval(tab) {
    if (!tab || !allPanes(tab.root).length) return;
    ensureOneExpanded(tab.root);
  }

  function movePanel(panelId, targetTabId, { toEnd = false } = {}) {
    if (theaterLocked()) return false;
    protectedPanel = null;
    const sourceTab = activeTab();
    const source = findPaneInfo(panelId, sourceTab);
    if (!source) return false;
    const target = doc.tabs.find((t) => t.id === targetTabId);
    if (!target) return false;
    if (target.id !== sourceTab.id && findPaneNode(target.root, panelId)) {
      doc.activeId = target.id;
      save();
      renderAll();
      return true;
    }
    if (target.id === sourceTab.id && !toEnd) return false;
    const pane = source.pane;
    if (sourceTab.maximized === panelId) sourceTab.maximized = null;
    removePaneFromTree(sourceTab.root, panelId);
    normalizeTree(sourceTab.root);
    ensureSourceExpandedAfterRemoval(sourceTab);
    appendPaneToRoot(target.root, pane);
    normalizeTree(target.root);
    ensureOneExpanded(target.root);
    refreshLastActive(sourceTab.root);
    refreshLastActive(target.root);
    doc.activeId = target.id;
    save();
    renderAll();
    return true;
  }

  function movePanelFromTab(panelId, sourceTabId, targetTabId) {
    if (theaterLocked()) return false;
    const sourceTab = doc.tabs.find((t) => t.id === sourceTabId);
    const target = doc.tabs.find((t) => t.id === targetTabId);
    if (!sourceTab || !target || sourceTab.id === target.id) return false;
    const source = findPaneInfo(panelId, sourceTab);
    if (!source) return false;
    if (findPaneNode(target.root, panelId)) return false;
    protectedPanel = null;
    const pane = source.pane;
    if (sourceTab.maximized === panelId) sourceTab.maximized = null;
    removePaneFromTree(sourceTab.root, panelId);
    normalizeTree(sourceTab.root);
    ensureSourceExpandedAfterRemoval(sourceTab);
    appendPaneToRoot(target.root, pane);
    normalizeTree(target.root);
    ensureOneExpanded(target.root);
    refreshLastActive(sourceTab.root);
    refreshLastActive(target.root);
    save();
    renderAll();
    return true;
  }

  function expandWithWeight(pane, info) {
    if (!pane) return;
    expandPane(pane);
    const axis = info && info.dir ? info.dir : 'H';
    const min = nodeMin(pane, axis);
    const target = Number.isFinite(pane.recordedSize) ? pane.recordedSize : min;
    pane.weight = Math.max(MIN_GROW, target - min);
    pane.preferredSize = target;
  }

  function toggleCollapse(panelId) {
    if (theaterLocked()) return;
    const tab = activeTab();
    const info = findPaneInfo(panelId, tab);
    if (!info) return;
    const pane = info.pane;
    if (tab.maximized === panelId) tab.maximized = null;
    markPaneActive(tab.root, panelId);
    if (pane.collapsed) {
      expandWithWeight(pane, info);
      protectedPanel = panelId;
    } else {
      if (protectedPanel === panelId) protectedPanel = null;
      const expanded = expandedPanes(tab.root);
      if (expanded.length === 1) {
        const other = allPanes(tab.root).find((p) => p !== pane);
        if (other) {
          const otherInfo = findPaneInfo(other.panel, tab);
          expandWithWeight(other, otherInfo);
        } else {
          notify('标签页至少保留一个展开分栏');
          return;
        }
      }
      collapsePane(pane);
    }
    save();
    renderAll();
  }

  function toggleMaximize(panelId) {
    if (theaterLocked()) return;
    const tab = activeTab();
    const info = findPaneInfo(panelId, tab);
    if (!info) return;
    if (info.pane.collapsed) {
      expandWithWeight(info.pane, info);
      protectedPanel = panelId;
      ensureOneExpanded(tab.root, panelId);
      markPaneActive(tab.root, panelId);
      refreshLastActive(tab.root);
    }
    tab.maximized = tab.maximized === panelId ? null : panelId;
    save();
    renderAll();
  }

  function menuItems(menu) {
    return [...menu.querySelectorAll('.panel-menu-item')].filter((item) => !item.disabled);
  }

  function focusMenuItem(menu, index) {
    const items = menuItems(menu);
    if (!items.length) return false;
    const item = items[Math.max(0, Math.min(items.length - 1, index))];
    try { item.focus({ preventScroll: true }); } catch { item.focus(); }
    return true;
  }

  function closeMenus({ restoreFocus = false } = {}) {
    const triggers = [];
    for (const menu of menus) {
      if (menu._trigger) triggers.push(menu._trigger);
      if (menu.parentNode) menu.parentNode.removeChild(menu);
    }
    menus = [];
    for (const trigger of triggers) {
      if (trigger && trigger.setAttribute && trigger.dataset.action === 'menu') trigger.setAttribute('aria-expanded', 'false');
      if (trigger && trigger.setAttribute && trigger.dataset.action === 'capsule-menu') trigger.setAttribute('aria-expanded', 'false');
      if (trigger && trigger.getAttribute && trigger.getAttribute('aria-haspopup')) trigger.setAttribute('aria-expanded', 'false');
    }
    if (restoreFocus && triggers[0]) {
      try { triggers[0].focus({ preventScroll: true }); } catch { try { triggers[0].focus(); } catch { /* ignore */ } }
    }
  }

  function addMenuSeparator(menu) {
    const separator = el('div', 'panel-menu-sep');
    separator.setAttribute('role', 'separator');
    menu.append(separator);
  }

  function addMenuItem(menu, label, handler, { disabled = false, heading = false } = {}) {
    if (heading) {
      const head = el('div', 'panel-menu-heading', label);
      head.setAttribute('role', 'presentation');
      menu.append(head);
      return;
    }
    const item = el('button', 'panel-menu-item', label);
    item.type = 'button';
    item.tabIndex = -1;
    item.setAttribute('role', 'menuitem');
    item.disabled = !!disabled;
    item.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    item.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeMenus({ restoreFocus: true });
      handler();
    });
    menu.append(item);
  }

  function menuKeydown(ev) {
    const menu = ev.currentTarget;
    const items = menuItems(menu);
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      closeMenus({ restoreFocus: true });
      return;
    }
    if (ev.key === 'Tab') {
      closeMenus({ restoreFocus: true });
      return;
    }
    const focused = document.activeElement;
    const current = items.indexOf(focused);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ev.key)) {
      ev.preventDefault();
      ev.stopPropagation();
      focusMenuItem(menu, menuIndex(current, items.length, ev.key));
    }
  }

  function positionMenu(menu, button, { align = 'right', point = null } = {}) {
    menu.setAttribute('role', 'menu');
    menu.tabIndex = -1;
    menu._trigger = button;
    menu.addEventListener('keydown', menuKeydown);
    const winW = typeof window !== 'undefined' ? window.innerWidth : 1200;
    const winH = typeof window !== 'undefined' ? window.innerHeight : 800;
    const margin = 8;
    menu.style.position = 'fixed';
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.style.right = 'auto';
    menu.style.maxWidth = `${Math.max(160, winW - margin * 2)}px`;
    menu.style.maxHeight = `${Math.max(120, winH - margin * 2)}px`;
    menu.style.overflowY = 'auto';
    menu.style.visibility = 'hidden';
    document.body.appendChild(menu);
    menus.push(menu);
    const rect = point
      ? { left: point.x, right: point.x, top: point.y, bottom: point.y }
      : (typeof button.getBoundingClientRect === 'function'
        ? button.getBoundingClientRect()
        : { left: winW - 40, right: winW - 12, top: 28, bottom: 40 });
    const mw = menu.offsetWidth || menu.getBoundingClientRect().width || 180;
    const mh = menu.offsetHeight || menu.getBoundingClientRect().height || 120;
    const pos = clampMenuPosition({
      button: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      width: mw, height: mh, vw: winW, vh: winH, margin, align,
    });
    menu.style.left = `${Math.round(pos.left)}px`;
    menu.style.top = `${Math.round(pos.top)}px`;
    menu.style.visibility = 'visible';
    menu._anchor = { button, align, point };
    focusMenuItem(menu, 0);
  }

  function repositionMenus() {
    for (const menu of menus) {
      const anchor = menu._anchor;
      if (!anchor) continue;
      if (!anchor.point && (!anchor.button || !anchor.button.isConnected)) {
        closeMenus();
        return;
      }
      const winW = window.innerWidth;
      const winH = window.innerHeight;
      const margin = 8;
      menu.style.maxWidth = `${Math.max(160, winW - margin * 2)}px`;
      menu.style.maxHeight = `${Math.max(120, winH - margin * 2)}px`;
      const rect = anchor.point
        ? { left: anchor.point.x, right: anchor.point.x, top: anchor.point.y, bottom: anchor.point.y }
        : anchor.button.getBoundingClientRect();
      const mw = menu.offsetWidth || menu.getBoundingClientRect().width || 180;
      const mh = menu.offsetHeight || menu.getBoundingClientRect().height || 120;
      const pos = clampMenuPosition({
        button: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
        width: mw, height: mh, vw: winW, vh: winH, margin, align: anchor.align,
      });
      menu.style.left = `${Math.round(pos.left)}px`;
      menu.style.top = `${Math.round(pos.top)}px`;
    }
  }

  function openPanelMenu(button, panelId, { point = null } = {}) {
    if (theaterLocked()) return;
    closeMenus();
    const tab = activeTab();
    const info = findPaneInfo(panelId, tab);
    if (!info) return;
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'true');
    const menu = el('div', 'panel-menu');
    menu.setAttribute('role', 'menu');
    menu.dataset.menuFor = panelId;
    addMenuItem(menu, info.pane.collapsed ? '展开' : '折叠', () => toggleCollapse(panelId));
    addMenuItem(menu, tab.maximized === panelId ? '取消最大化' : '最大化', () => toggleMaximize(panelId));
    addMenuSeparator(menu);
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
    addMenuSeparator(menu);
    addMenuItem(menu, '复制到标签页 →', () => {}, { heading: true });
    for (const other of doc.tabs) {
      if (other.id === tab.id) continue;
      const exists = !!findPaneNode(other.root, panelId);
      addMenuItem(menu, other.name, () => copyPanel(panelId, other.id), { disabled: exists });
    }
    addMenuItem(menu, '复制到新标签页', () => copyPanel(panelId, null, { newTab: true }));
    positionMenu(menu, button, point ? { point, align: 'left' } : {});
  }

  function startSplitDrag(ev, group, index, dir, tab) {
    if (theaterLocked()) return;
    if (ev.button != null && ev.button !== 0) return;
    ev.preventDefault();
    if (!group || group.manualLocked) return;
    const left = group.children[index - 1];
    const right = group.children[index];
    if (!left || !right || !isExpandedNode(left) || !isExpandedNode(right)) return;
    const splitter = ev.currentTarget;
    splitter.classList.add('active');
    document.body.classList.add('dragging-split');
    const badge = el('span', 'split-ratio');
    splitter.append(badge);
    const setBadge = () => {
      const l = Number.isFinite(left.size) ? left.size : nodeMin(left, dir);
      const r = Number.isFinite(right.size) ? right.size : nodeMin(right, dir);
      const totalNow = l + r;
      const pct = totalNow > 0 ? Math.round((l / totalNow) * 100) : 50;
      badge.textContent = `${pct}% / ${100 - pct}%`;
      updateSplitterAria(splitter, left, right);
    };
    setBadge();
    const start = dir === 'H' ? ev.clientX : ev.clientY;
    const startLeft = Number.isFinite(left.size) ? left.size : nodeMin(left, dir);
    const startRight = Number.isFinite(right.size) ? right.size : nodeMin(right, dir);
    const total = startLeft + startRight;
    const minLeft = nodeMin(left, dir);
    const minRight = nodeMin(right, dir);
    let moved = false;
    for (const child of group.children) {
      if (!isExpandedNode(child)) continue;
      child.preferredSize = undefined;
      child.weight = Math.max(MIN_GROW, (Number.isFinite(child.size) ? child.size : nodeMin(child, dir)) - nodeMin(child, dir));
    }
    const onMove = (mv) => {
      const pos = dir === 'H' ? mv.clientX : mv.clientY;
      if (Math.abs(pos - start) > 2) moved = true;
      pendingDelta = pos - start;
      if (moveRaf) return;
      moveRaf = requestAnimationFrame(() => {
        moveRaf = 0;
        applyDelta(pendingDelta);
      });
    };
    let moveRaf = 0;
    let pendingDelta = 0;
    const applyDelta = (delta) => {
      const nextLeft = Math.max(minLeft, Math.min(total - minRight, startLeft + delta));
      const nextRight = total - nextLeft;
      left.size = nextLeft;
      right.size = nextRight;
      left.weight = Math.max(MIN_GROW, nextLeft - minLeft);
      right.weight = Math.max(MIN_GROW, nextRight - minRight);
      const { w, h } = workspaceBox();
      solveTab(tab, w, h, { keepExpanded: protectedPanel });
      announceRestricted(tab);
      applyFrame();
      setBadge();
    };
    const onUp = () => {
      if (moveRaf) {
        cancelAnimationFrame(moveRaf);
        moveRaf = 0;
        applyDelta(pendingDelta);
      }
      splitter.classList.remove('active');
      document.body.classList.remove('dragging-split');
      if (badge.parentNode) badge.parentNode.removeChild(badge);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      save();
      emitChange();
      dragCleanup = null;
      const now = performance.now();
      if (moved) {
        splitter._lastTap = 0;
      } else if (splitter._lastTap && now - splitter._lastTap < 350) {
        splitter._lastTap = 0;
        splitter._lastReset = now;
        resetSplitterPair(group, index, dir, tab);
      } else {
        splitter._lastTap = now;
      }
    };
    dragCleanup = onUp;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function resetToDefaults() {
    if (theaterLocked()) return false;
    const previous = cloneTree(doc);
    protectedPanel = null;
    doc = defaultLayout();
    if (typeof host.storageRemove === 'function') {
      try { host.storageRemove(LAYOUT_KEY); } catch { /* ignore */ }
    }
    save();
    renderAll();
    if (typeof onReset === 'function') onReset(previous);
    else notify('已重置为默认布局');
  }

  function renderAll() {
    const focusKey = captureFocusKey();
    renderTabs();
    renderWorkspace();
    emitChange();
    restoreFocus(focusKey);
  }

  tabsEl.addEventListener('keydown', tabKeydown);
  tabsEl.addEventListener('auxclick', (ev) => {
    if (theaterLocked()) return;
    if (ev.button !== 1) return;
    const tab = ev.target.closest && ev.target.closest('.tab');
    if (!tab || doc.tabs.length <= 1) return;
    ev.preventDefault();
    closeTab(tab.dataset.tabId);
  });
  tabsEl.addEventListener('wheel', (ev) => {
    if (theaterLocked()) return;
    if (tabsEl.scrollWidth <= tabsEl.clientWidth) return;
    const delta = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
    if (!delta) return;
    ev.preventDefault();
    tabsEl.scrollLeft += delta;
  }, { passive: false });
  tabsEl.addEventListener('dblclick', (ev) => {
    if (theaterLocked()) return;
    if (ev.target.closest && ev.target.closest('.tab, button, input')) return;
    createTab({ activate: true });
  });
  document.addEventListener('keydown', globalTabKeys);

  workspaceEl.addEventListener('pointerdown', (ev) => {
    if (theaterLocked()) return;
    if (ev.button != null && ev.button !== 0) return;
    const target = ev.target;
    if (!target || !target.closest) return;
    if (target.closest('button, a, input, textarea, select, [contenteditable="true"], .panel-actions, .view-ctrls, .group-capsule, .split, .tab')) return;
    const head = target.closest('.panel-head');
    if (!head || !workspaceEl.contains(head)) return;
    if (activeTab() && activeTab().maximized) return;
    const panel = head.closest('.panel');
    if (!panel || !panel.dataset.panelId) return;
    startHeaderDrag(ev, panel.dataset.panelId);
  });

  workspaceEl.addEventListener('dblclick', (ev) => {
    if (theaterLocked()) return;
    const target = ev.target;
    if (!target || !target.closest) return;
    if (target.closest('button, a, input, textarea, select, [contenteditable="true"], .panel-actions, .view-ctrls, .split')) return;
    const head = target.closest('.panel-head');
    if (!head) return;
    const panel = head.closest('.panel');
    if (!panel || !panel.dataset.panelId) return;
    ev.preventDefault();
    toggleMaximize(panel.dataset.panelId);
  });

  workspaceEl.addEventListener('contextmenu', (ev) => {
    if (theaterLocked()) return;
    const target = ev.target;
    if (!target || !target.closest) return;
    if (target.closest('button, a, input, textarea, select, [contenteditable="true"], .panel-actions, .view-ctrls, .split, .group-capsule')) return;
    const head = target.closest('.panel-head');
    if (!head) return;
    const panel = head.closest('.panel');
    if (!panel || !panel.dataset.panelId) return;
    ev.preventDefault();
    const menuBtn = panel.querySelector('[data-action="menu"]');
    if (menuBtn) openPanelMenu(menuBtn, panel.dataset.panelId, { point: { x: ev.clientX, y: ev.clientY } });
  });

  workspaceEl.addEventListener('click', (ev) => {
    if (theaterLocked()) return;
    const target = ev.target;
    if (!target || !target.closest) return;
    if (target.closest('button, a, input, textarea, select, [contenteditable="true"], .panel-actions, .view-ctrls, .split')) return;
    const slot = target.closest('.pane-slot.is-collapsed');
    if (!slot) return;
    const panel = slot.querySelector('.panel');
    if (!panel || !panel.dataset.panelId) return;
    const info = findPaneInfo(panel.dataset.panelId);
    if (info && info.pane.collapsed) {
      ev.preventDefault();
      toggleCollapse(panel.dataset.panelId);
    }
  });

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

  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (t && t.closest && (t.closest('.panel-menu') || t.closest('[data-action]'))) return;
    if (menus.length) closeMenus();
  });

  if (newTabBtn) newTabBtn.addEventListener('click', () => createTab({ activate: true }));
  if (resetBtn) resetBtn.addEventListener('click', () => resetToDefaults());

  let resizeObserver = null;
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => scheduleFrame());
    resizeObserver.observe(workspaceEl);
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', scheduleFrame);
  window.addEventListener('resize', repositionMenus);
  }

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
    copyPanel,
    addPanelToTab,
    resetTab: resetTabById,
    moveTab(draggedId, targetId, after = false) {
      if (theaterLocked()) return false;
      const moved = reorderTabs(doc.tabs, draggedId, targetId, after);
      if (moved) { save(); renderTabs(); }
      return moved;
    },
    toggleCollapse,
    toggleMaximize,
    restoreLayout(raw) {
      if (theaterLocked()) return false;
      const next = sanitizeLayout(raw);
      if (!next) return false;
      doc = next;
      protectedPanel = null;
      save();
      renderAll();
      return true;
    },
    resetLayout() { resetToDefaults(); return doc; },
    visiblePanels() { return visiblePanels(activeTab()); },
    panelsOfTab,
    serialize: () => cloneTree(doc),
    save,
    cancelDrag() {
      if (dragCleanup) dragCleanup();
      dragCleanup = null;
    },
    dispose() {
      clearCollapsedBridges();
      if (resizeObserver) resizeObserver.disconnect();
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('resize', scheduleFrame);
        window.removeEventListener('resize', repositionMenus);
      }
    },
  };
  return api;
}
