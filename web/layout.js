// Workspace layout shell: tabs + recursive group tree, splitters and persistence.
// Pure model/solver lives in layout-tree.js; this module renders it and owns DOM
// interaction only. Platform persistence goes through the host adapter.

import { icon } from './util.js';
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
  rotateGroup,
  reorderTabs,
  clonePaneForCopy,
  addPaneToTab,
  addMissingPaneToTab,
  resetTabTree,
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
  const activeTab = () => doc.tabs.find((t) => t.id === doc.activeId) || doc.tabs[0];

  function canPersist() {
    return !!(host && host.canPersist !== false && typeof host.storageSet === 'function');
  }

  function save() {
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
    if (tab.maximized) return new Set([tab.maximized]);
    return new Set(expandedPanes(tab.root).map((p) => p.panel));
  }

  function panelsOfTab(tab) {
    return allPanes(tab && tab.root).map((p) => p.panel);
  }

  function panelCount(tab) {
    return allPanes(tab && tab.root).length;
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
      setIcon(collapseBtn, collapseIcon(dir, info ? info.index : 0, count, pane.collapsed));
      collapseBtn.title = `${pane.collapsed ? '展开' : '折叠'} ${title}`;
      collapseBtn.setAttribute('aria-label', `${pane.collapsed ? '展开' : '折叠'} ${title}`);
      collapseBtn.setAttribute('aria-expanded', pane.collapsed ? 'false' : 'true');
    }
    const maxBtn = panel.querySelector && panel.querySelector('[data-action="maximize"]');
    const tab = activeTab();
    if (maxBtn) {
      const maximized = !!(tab && tab.maximized === pane.panel);
      setIcon(maxBtn, maximized ? 'minimize' : 'maximize');
      maxBtn.title = maximized ? '还原' : '最大化';
      maxBtn.setAttribute('aria-label', maximized ? '还原' : '最大化');
      maxBtn.setAttribute('aria-pressed', maximized ? 'true' : 'false');
    }
    const menuBtn = panel.querySelector && panel.querySelector('[data-action="menu"]');
    if (menuBtn) {
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
    const tab = activeTab();
    if (!tab) return;
    if (markPaneActive(tab.root, panelId)) save();
  }

  function expandCapsuleGroup(group, tab) {
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
    closeMenus();
    const menu = el('div', 'panel-menu');
    menu.setAttribute('role', 'menu');
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
    iconSpan.innerHTML = icon('archive');
    body.append(iconSpan);
    body.append(el('span', 'capsule-count', String(allPanes(group).length)));
    body.append(el('span', 'capsule-summary', members));
    const chevron = el('span', 'capsule-chevron');
    chevron.innerHTML = icon(parentDir === 'V' ? 'chevron-down' : 'chevron-right');
    body.append(chevron);
    body.addEventListener('click', (ev) => {
      ev.stopPropagation();
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
    if (dragTargetBox) dragTargetBox.hidden = true;
    if (dragLabel) {
      dragLabel.textContent = '';
      dragLabel.hidden = true;
    }
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
    if (edges[0].d > limit) return null;
    return {
      paneId: slot.dataset.panelId,
      side: edges[0].side,
      rect,
      slot,
    };
  }

  function detectDropTarget(tab, x, y, sourcePanelId, state) {
    if (tabsEl && rectHas(tabsEl.getBoundingClientRect(), x, y)) {
      return { kind: 'gap', group: tab.root, index: tab.root.children.length, label: '追加到标签页末尾' };
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
          if (node === tab.root) {
            return { kind: 'root-edge', edge: pane.side, label: '根级：包裹整个根内容' };
          }
          return { kind: 'wrap', node, side: pane.side, label: `将包裹：${memberSummary(node)}` };
        }
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
      if (dragLabel) { dragLabel.hidden = false; dragLabel.textContent = 'V1 不交换中心；请拖到边缘、间隙或标签栏'; }
      return;
    }
    document.body.classList.add('drag-valid');
    if (dragLabel) {
      dragLabel.hidden = false;
      dragLabel.textContent = target.label || '';
    }
    if (target.gap) target.gap.el.classList.add('active');
    let box = null;
    if (target.gap) {
      const hit = target.gap.hit;
      box = { left: hit.left, top: hit.top, width: hit.width, height: hit.height };
    } else if (target.kind === 'root-edge') {
      const wr = workspaceEl.getBoundingClientRect();
      const band = 24;
      box = target.edge === 'left' ? { left: wr.left, top: wr.top, width: band, height: wr.height }
        : target.edge === 'right' ? { left: wr.right - band, top: wr.top, width: band, height: wr.height }
          : target.edge === 'top' ? { left: wr.left, top: wr.top, width: wr.width, height: band }
            : { left: wr.left, top: wr.bottom - band, width: wr.width, height: band };
    } else if (target.kind === 'wrap') {
      const nodeEl = nodeEls.get(target.node);
      if (nodeEl) {
        const r = nodeEl.getBoundingClientRect();
        box = { left: r.left, top: r.top, width: r.width, height: r.height };
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

  function cleanupHeaderDrag() {
    if (!headerDrag) return;
    headerDrag.removers.forEach((fn) => fn());
    if (headerDrag.slot) headerDrag.slot.classList.remove('drag-source');
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
    document.body.classList.remove('dragging-pane', 'drag-valid', 'drag-invalid');
    for (const el of document.querySelectorAll('.drag-target')) el.classList.remove('drag-target');
    headerDrag = null;
  }

  function startHeaderDrag(ev, panelId) {
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
      target: null,
      removers: [],
    };
    headerDrag = state;
    const onMove = (mv) => {
      state.lastX = mv.clientX;
      state.lastY = mv.clientY;
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
      if (!state.dragging) { cleanupHeaderDrag(); return; }
      const target = detectDropTarget(tab, state.lastX, state.lastY, panelId, state);
      cleanupHeaderDrag();
      if (!target) {
        notify('此处不能放置分栏');
        return;
      }
      const result = movePaneForDrop(tab.root, panelId, target);
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
    };
    const onCancel = () => cleanupHeaderDrag();
    const onKey = (kev) => {
      if (kev.key === 'Escape') { kev.preventDefault(); kev.stopPropagation(); cleanupHeaderDrag(); }
      else if (kev.key === 'Alt') {
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
      if (kev.key === 'Alt') {
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

  function makeSplitter(group, index, dir, tab) {
    const splitter = el('div', `split split-${dir === 'H' ? 'v' : 'h'}`);
    splitter.dataset.split = dir === 'H' ? 'v' : 'h';
    splitter.setAttribute('role', 'separator');
    splitter.setAttribute('aria-orientation', dir === 'H' ? 'vertical' : 'horizontal');
    splitter.style.flex = `0 0 ${SPLITTER}px`;
    splitter.title = group === tab.root ? '根组方向固定为 H' : '双击切换分栏方向';
    splitter.addEventListener('pointerdown', (ev) => startSplitDrag(ev, group, index, dir, tab));
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
    reset.addEventListener('click', (ev) => { ev.stopPropagation(); resetToDefaults(); });
    box.append(reset);
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

  function renderWorkspace() {
    workspaceEl.innerHTML = '';
    nodeEls.clear();
    const tab = activeTab();
    if (!tab) return;
    const root = el('div', 'pane-root');
    root.dataset.tabId = tab.id;
    if (panelCount(tab) === 0) {
      root.append(emptyState());
    } else if (tab.maximized) {
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
      label.addEventListener('dblclick', (ev) => { ev.stopPropagation(); startRename(node, label, tab); });
      node.append(label);
      if (doc.tabs.length > 1) {
        const close = el('button', 'tab-close');
        close.type = 'button';
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
    const tab = doc.tabs.find((t) => t.id === tabId);
    if (!tab) return false;
    activateTabForAction(tabId);
    if (!resetTabTree(tab, defaultLayout().tabs[0].root)) return false;
    protectedPanel = null;
    save();
    renderAll();
    notify('已重置当前标签页');
    return true;
  }

  function copyPanel(panelId, targetTabId, { newTab = false } = {}) {
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
    closeMenus();
    const menu = el('div', 'panel-menu');
    menu.setAttribute('role', 'menu');
    addMenuItem(menu, '重命名', () => renameTabById(tab.id));
    addMenuItem(menu, '添加分栏', () => {}, { heading: true });
    const missing = PANEL_DEFS.filter((p) => !findPaneNode(tab.root, p.id));
    if (!missing.length) addMenuItem(menu, '全部分栏已存在', () => {}, { disabled: true });
    for (const paneDef of missing) {
      addMenuItem(menu, paneDef.title, () => addPanelToTab(tab.id, paneDef.id));
    }
    menu.append(el('div', 'panel-menu-sep'));
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
      done = true;
      const name = cancel ? tab.name : input.value.trim().slice(0, 24);
      if (name && name !== tab.name) {
        tab.name = name;
        save();
        renderTabs();
      } else {
        renderTabs();
      }
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
    const id = `tab-${doc.nextId++}`;
    const tab = { id, name: `标签页 ${doc.nextId - 1}`, root: { dir: 'H', children: [] }, maximized: null };
    doc.tabs.push(tab);
    if (activate) { doc.activeId = tab.id; protectedPanel = null; }
    save();
    renderAll();
    return tab;
  }

  function closeTab(id) {
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

  function closeMenus() {
    for (const menu of menus) if (menu.parentNode) menu.parentNode.removeChild(menu);
    menus = [];
  }

  function addMenuItem(menu, label, handler, { disabled = false, heading = false } = {}) {
    if (heading) { menu.append(el('div', 'panel-menu-heading', label)); return; }
    const item = el('button', 'panel-menu-item', label);
    item.type = 'button';
    item.disabled = !!disabled;
    item.addEventListener('click', (ev) => { ev.stopPropagation(); closeMenus(); handler(); });
    menu.append(item);
  }

  function openPanelMenu(button, panelId) {
    closeMenus();
    const tab = activeTab();
    const info = findPaneInfo(panelId, tab);
    if (!info) return;
    const menu = el('div', 'panel-menu');
    menu.setAttribute('role', 'menu');
    menu.dataset.menuFor = panelId;
    addMenuItem(menu, info.pane.collapsed ? '展开' : '折叠', () => toggleCollapse(panelId));
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
    menu.append(el('div', 'panel-menu-sep'));
    addMenuItem(menu, '复制到标签页 →', () => {}, { heading: true });
    for (const other of doc.tabs) {
      if (other.id === tab.id) continue;
      const exists = !!findPaneNode(other.root, panelId);
      addMenuItem(menu, other.name, () => copyPanel(panelId, other.id), { disabled: exists });
    }
    addMenuItem(menu, '复制到新标签页', () => copyPanel(panelId, null, { newTab: true }));
    positionMenu(menu, button);
  }

  function startSplitDrag(ev, group, index, dir, tab) {
    if (ev.button != null && ev.button !== 0) return;
    ev.preventDefault();
    if (!group || group.manualLocked) return;
    const left = group.children[index - 1];
    const right = group.children[index];
    if (!left || !right || !isExpandedNode(left) || !isExpandedNode(right)) return;
    const splitter = ev.currentTarget;
    splitter.classList.add('active');
    document.body.classList.add('dragging-split');
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
    };
    const onUp = () => {
      if (moveRaf) {
        cancelAnimationFrame(moveRaf);
        moveRaf = 0;
        applyDelta(pendingDelta);
      }
      splitter.classList.remove('active');
      document.body.classList.remove('dragging-split');
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
        if (group !== tab.root) {
          rotateGroup(group);
          refreshLastActive(tab.root);
          save();
          renderAll();
        }
      } else {
        splitter._lastTap = now;
      }
    };
    dragCleanup = onUp;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function resetToDefaults() {
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
    renderTabs();
    renderWorkspace();
    emitChange();
  }

  workspaceEl.addEventListener('pointerdown', (ev) => {
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
      const moved = reorderTabs(doc.tabs, draggedId, targetId, after);
      if (moved) { save(); renderTabs(); }
      return moved;
    },
    toggleCollapse,
    toggleMaximize,
    restoreLayout(raw) {
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
      if (resizeObserver) resizeObserver.disconnect();
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('resize', scheduleFrame);
    },
  };
  return api;
}
