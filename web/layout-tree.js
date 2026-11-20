// Pure 4.x layout tree: model, migration, collapse formulas and the size solver.
// No DOM here — web/layout.js renders the tree; tests exercise this module.

export const LAYOUT_VERSION = 4;
export const SPLITTER = 6;
export const BAR = { H: 36, V: 32 };
export const PANEL_IDS = ['source', 'world', 'pack', 'scores', 'log', 'timeline'];
export const PANEL_LIMITS = {
  source: { minW: 250, minH: 140 },
  world: { minW: 232, minH: 180 },
  pack: { minW: 250, minH: 160 },
  scores: { minW: 200, minH: 140 },
  log: { minW: 200, minH: 120 },
  timeline: { minW: 200, minH: 90 },
};
const PANEL_TITLES = {
  source: '源码', world: '世界', pack: '数据包', scores: '计分板', log: '运行日志', timeline: '时间轴',
};

export function panelTitle(panel) { return PANEL_TITLES[panel] || panel; }
export function isPane(node) { return !!node && typeof node.panel === 'string'; }
export function isGroup(node) { return !!node && Array.isArray(node.children); }

export function createPane(panel, { weight = 1, size = null, collapsed = false, recordedSize = null } = {}) {
  const lim = PANEL_LIMITS[panel] || { minW: 200, minH: 120 };
  return {
    panel,
    weight: Math.max(1, Number(weight) || 1),
    size: Number.isFinite(size) ? Math.max(0, size) : null,
    collapsed: !!collapsed,
    recordedSize: Number.isFinite(recordedSize) ? Math.max(0, recordedSize) : null,
    minW: lim.minW,
    minH: lim.minH,
  };
}

export function createGroup(dir, children = [], { weight = 1, size = null } = {}) {
  return {
    dir: dir === 'V' ? 'V' : 'H',
    children,
    weight: Math.max(1, Number(weight) || 1),
    size: Number.isFinite(size) ? Math.max(0, size) : null,
    lastActive: null,
  };
}

export function cloneTree(value) { return JSON.parse(JSON.stringify(value)); }

export function barThickness(dir) { return dir === 'V' ? BAR.V : BAR.H; }

export function walkNodes(node, out = []) {
  if (!node) return out;
  out.push(node);
  if (isGroup(node)) for (const child of node.children) walkNodes(child, out);
  return out;
}

export function allPanes(node) {
  const out = [];
  if (!node) return out;
  if (isPane(node)) { out.push(node); return out; }
  for (const child of node.children) out.push(...allPanes(child));
  return out;
}

export function findPaneNode(node, panel) {
  if (!node) return null;
  if (isPane(node)) return node.panel === panel ? node : null;
  for (const child of node.children) {
    const found = findPaneNode(child, panel);
    if (found) return found;
  }
  return null;
}

export function parentGroupOf(root, target) {
  if (!root || !isGroup(root)) return null;
  for (const child of root.children) if (child === target) return root;
  for (const child of root.children) {
    if (isGroup(child)) {
      const found = parentGroupOf(child, target);
      if (found) return found;
    }
  }
  return null;
}

export function fullyCollapsed(node) {
  if (!node) return true;
  if (isPane(node)) return !!node.collapsed;
  if (!node.children.length) return true;
  return node.children.every(fullyCollapsed);
}

/**
 * Effective axis of a group. A fully collapsed group follows its parent (or
 * nearest non-fully-collapsed ancestor via the caller's parentDir).
 */
export function layoutDir(node, parentDir = null) {
  if (!node) return parentDir || 'H';
  if (isPane(node)) return parentDir || 'H';
  if (parentDir == null) return node.dir;
  if (fullyCollapsed(node)) return parentDir;
  return node.dir;
}

export function nodeMin(node, axis) {
  if (!node) return 0;
  if (isPane(node)) {
    if (node.collapsed) return barThickness(axis);
    return axis === 'H' ? node.minW : node.minH;
  }
  if (!node.children.length) return 0;
  if (fullyCollapsed(node)) {
    // A fully collapsed group is one capsule, not a sum of child bars.
    return barThickness(axis);
  }
  if (axis === node.dir) {
    let sum = 0;
    for (const child of node.children) sum += nodeMin(child, axis);
    return sum + splitterPairs(node).length * SPLITTER;
  }
  let max = 0;
  for (const child of node.children) max = Math.max(max, nodeMin(child, axis));
  return max;
}

export function groupMin(group) {
  return { w: nodeMin(group, 'H'), h: nodeMin(group, 'V') };
}

export function isExpandedNode(node) {
  return isPane(node) ? !node.collapsed : !fullyCollapsed(node);
}

/** Direct adjacent expanded sibling pairs get a splitter. */
export function splitterPairs(group) {
  const pairs = [];
  if (!isGroup(group)) return pairs;
  for (let i = 1; i < group.children.length; i++) {
    const left = group.children[i - 1];
    const right = group.children[i];
    if (isExpandedNode(left) && isExpandedNode(right)) pairs.push({ index: i, left, right });
  }
  return pairs;
}

export function expandedPanes(node) {
  return allPanes(node).filter((p) => !p.collapsed);
}

export function expansionTarget({
  available, splitters = 0, otherExpandedMins = 0, collapsedBars = 0,
  min = 0, recordedSize = null, fullyCollapsedBefore = false,
}) {
  const rec = Number.isFinite(recordedSize) && recordedSize > 0 ? recordedSize : min;
  if (fullyCollapsedBefore) {
    return Math.max(min, available - splitters - collapsedBars);
  }
  return Math.max(min, Math.min(rec, available - splitters - otherExpandedMins - collapsedBars));
}

export function collapsePane(pane) {
  if (!pane || pane.collapsed) return false;
  if (Number.isFinite(pane.size) && pane.size > 0) pane.recordedSize = pane.size;
  pane.collapsed = true;
  return true;
}

export function expandPane(pane) {
  if (!pane || !pane.collapsed) return false;
  pane.collapsed = false;
  const min = Math.min(pane.minW, pane.minH);
  const rec = Number.isFinite(pane.recordedSize) ? pane.recordedSize : 0;
  pane.weight = Math.max(1, rec > min ? rec - min : 1);
  return true;
}

/** Flatten empty groups and same-direction ancestors; root stays a group. */
function positiveWeight(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Preserve a flattened child group's own weight share on its children. */
function mergeSameDirChildren(parent, child) {
  const groupWeight = positiveWeight(child.weight);
  const total = child.children.reduce((sum, item) => sum + positiveWeight(item.weight), 0);
  for (const item of child.children) {
    item.weight = (groupWeight * positiveWeight(item.weight)) / total;
  }
  return child.children;
}

function normalizeNode(node) {
  if (isPane(node)) return node;
  const children = [];
  for (const child of node.children) {
    const norm = normalizeNode(child);
    if (norm) children.push(norm);
  }
  node.children = children;
  // Flatten same-direction child groups (transparent groups).
  let changed = true;
  while (changed) {
    changed = false;
    const next = [];
    for (const child of node.children) {
      if (isGroup(child) && child.dir === node.dir && child.children.length && !child.keep) {
        next.push(...mergeSameDirChildren(node, child));
        changed = true;
      } else {
        next.push(child);
      }
    }
    node.children = next;
  }
  if (!node.children.length) return null;
  if (node.children.length === 1) {
    const only = node.children[0];
    only.weight = positiveWeight(node.weight);
    if (Number.isFinite(node.size)) only.size = node.size;
    return only;
  }
  return node;
}

export function normalizeTree(root) {
  if (!isGroup(root)) return root;
  const children = [];
  for (const child of root.children) {
    const norm = normalizeNode(child);
    if (norm) children.push(norm);
  }
  root.children = children;
  // Root may flatten same-dir child groups too, but must remain a Group.
  let changed = true;
  while (changed) {
    changed = false;
    const next = [];
    for (const child of root.children) {
      if (isGroup(child) && child.dir === root.dir && child.children.length && !child.keep) {
        next.push(...mergeSameDirChildren(root, child));
        changed = true;
      } else {
        next.push(child);
      }
    }
    root.children = next;
  }
  return root;
}

export function removePaneFromTree(root, panel) {
  function remove(node) {
    if (isPane(node)) return node.panel === panel ? null : node;
    const children = [];
    for (const child of node.children) {
      const next = remove(child);
      if (next) children.push(next);
    }
    node.children = children;
    if (!node.children.length) return null;
    if (node.children.length === 1) return node.children[0];
    return node;
  }
  remove(root);
  normalizeTree(root);
  return root;
}

export function appendPaneToRoot(root, pane) {
  if (!isGroup(root)) return pane;
  root.children.push(pane);
  normalizeTree(root);
  return root;
}

export function ensureOneExpanded(root, preferredPanel = null) {
  const panes = allPanes(root);
  if (!panes.length) return null;
  let preferred = null;
  if (preferredPanel) {
    preferred = panes.find((p) => p === preferredPanel || p.panel === preferredPanel) || null;
  }
  if (preferred) {
    if (preferred.collapsed) preferred.collapsed = false;
    return preferred;
  }
  if (panes.some((p) => !p.collapsed)) return panes.find((p) => !p.collapsed);
  const first = panes[0];
  first.collapsed = false;
  return first;
}

export function panesInGroup(group) {
  return allPanes(group);
}

export function lastActivePane(group) {
  const panes = allPanes(group);
  if (!panes.length) return null;
  if (group.lastActive) {
    const found = panes.find((p) => p.panel === group.lastActive);
    if (found) return found;
  }
  return panes[0];
}

export function markPaneActive(root, panel) {
  function walk(node, ancestors) {
    if (isPane(node)) {
      if (node.panel === panel) {
        for (const group of ancestors) group.lastActive = panel;
        return true;
      }
      return false;
    }
    ancestors.push(node);
    for (const child of node.children) if (walk(child, ancestors)) return true;
    ancestors.pop();
    return false;
  }
  return walk(root, []);
}

export function refreshLastActive(root) {
  if (!root) return;
  function walk(node) {
    if (isPane(node)) return;
    walkChildren(node);
    const panes = allPanes(node);
    if (panes.length && !panes.some((p) => p.panel === node.lastActive)) {
      node.lastActive = panes[0].panel;
    }
  }
  function walkChildren(node) {
    for (const child of node.children) walk(child);
  }
  walk(root);
}

function nodeInTree(root, node) {
  if (root === node) return true;
  if (!isGroup(root)) return false;
  return root.children.some((child) => nodeInTree(child, node));
}

function detachPaneLoose(root, panel) {
  let source = null;
  function remove(node) {
    if (isPane(node)) {
      if (node.panel === panel) { source = node; return null; }
      return node;
    }
    const children = [];
    for (const child of node.children) {
      const next = remove(child);
      if (next) children.push(next);
    }
    node.children = children;
    if (!node.children.length) return null;
    return node;
  }
  remove(root);
  return source;
}

/**
 * Pure header-drag operation. Supported targets:
 *   { kind:'gap', group, index }
 *   { kind:'wrap', node, side:'left'|'right'|'top'|'bottom' }
 *   { kind:'root-edge', edge:'left'|'right'|'top'|'bottom' }
 * New pane/group wraps are marked keep=true so normalizeTree does not flatten
 * the nesting the user just created; later moves can still prune them.
 */
export function movePaneForDrop(root, panel, target) {
  if (!isGroup(root) || !target) return { ok: false };
  const source = findPaneNode(root, panel);
  if (!source) return { ok: false };
  const sourceParent = parentGroupOf(root, source);
  const sourceIndex = sourceParent ? sourceParent.children.indexOf(source) : -1;
  if (!sourceParent) return { ok: false };
  if (target.kind === 'wrap' && target.node === source) return { ok: false };
  if (target.kind === 'gap' && target.group === sourceParent) {
    if (sourceParent.children.length === 1) {
      source.collapsed = false;
      ensureOneExpanded(root, source.panel);
      return { ok: true, pane: source };
    }
    const gapIndex = Number.isInteger(target.index) ? target.index : sourceParent.children.length;
    if (gapIndex === sourceIndex || gapIndex === sourceIndex + 1) {
      source.collapsed = false;
      ensureOneExpanded(root, source.panel);
      return { ok: true, pane: source };
    }
  }
  if (target.kind === 'wrap' && target.node === sourceParent && sourceParent.children.length <= 1) {
    return { ok: false };
  }
  const pane = detachPaneLoose(root, panel);
  if (!pane) return { ok: false };
  const restore = () => {
    if (sourceParent && nodeInTree(root, sourceParent)) {
      sourceParent.children.splice(Math.max(0, sourceIndex), 0, pane);
      normalizeTree(root);
    }
  };
  if (target.kind === 'gap') {
    const group = target.group;
    if (!isGroup(group) || !nodeInTree(root, group)) { restore(); return { ok: false }; }
    let index = Number.isInteger(target.index) ? target.index : group.children.length;
    if (group === sourceParent && sourceIndex >= 0 && sourceIndex < index) index -= 1;
    index = Math.max(0, Math.min(group.children.length, index));
    group.children.splice(index, 0, pane);
  } else if (target.kind === 'wrap') {
    let node = target.node;
    const side = target.side;
    if (!node || !nodeInTree(root, node)) { restore(); return { ok: false }; }
    if (node === root) {
      const edge = side === 'top' ? 'top' : side === 'bottom' ? 'bottom' : side;
      target = { kind: 'root-edge', edge };
    } else {
      const parent = parentGroupOf(root, node);
      if (!parent) { restore(); return { ok: false }; }
      const index = parent.children.indexOf(node);
      const dir = side === 'left' || side === 'right' ? 'H' : 'V';
      const before = side === 'left' || side === 'top';
      const originalWeight = Math.max(1, Number(node.weight) || 1);
      if (isGroup(node)) node.keep = true;
      pane.weight = 1;
      node.weight = 1;
      const wrapper = createGroup(dir, before ? [pane, node] : [node, pane], { weight: originalWeight });
      wrapper.keep = true;
      parent.children.splice(index, 1, wrapper);
    }
  }
  if (target && target.kind === 'root-edge') {
    const edge = target.edge;
    if (edge === 'left') root.children.unshift(pane);
    else if (edge === 'right') root.children.push(pane);
    else {
      const wrapper = createGroup('V', edge === 'top' ? [pane, ...root.children] : [...root.children, pane]);
      wrapper.keep = true;
      root.children = [wrapper];
    }
  }
  normalizeTree(root);
  ensureOneExpanded(root, pane.panel);
  refreshLastActive(root);
  return { ok: true, pane };
}

/**
 * Swap two existing Pane node objects in place. No prune/flatten is performed;
 * pane weights/sizes/collapse fields travel with the objects they belong to.
 */
export function swapPaneForDrop(root, sourcePanel, targetPanel) {
  if (!isGroup(root) || !sourcePanel || !targetPanel || sourcePanel === targetPanel) {
    return { ok: false };
  }
  const source = findPaneNode(root, sourcePanel);
  const target = findPaneNode(root, targetPanel);
  if (!source || !target || !isPane(source) || !isPane(target)) return { ok: false };
  if (target.collapsed) return { ok: false };
  const sourceParent = parentGroupOf(root, source);
  const targetParent = parentGroupOf(root, target);
  if (!sourceParent || !targetParent) return { ok: false };
  const sourceIndex = sourceParent.children.indexOf(source);
  const targetIndex = targetParent.children.indexOf(target);
  if (sourceIndex < 0 || targetIndex < 0) return { ok: false };
  sourceParent.children[sourceIndex] = target;
  targetParent.children[targetIndex] = source;
  const expandedIn = (group) => allPanes(group).some((p) => !p.collapsed);
  if (!expandedIn(sourceParent) || !expandedIn(targetParent)) {
    sourceParent.children[sourceIndex] = source;
    targetParent.children[targetIndex] = target;
    return { ok: false };
  }
  refreshLastActive(root);
  return { ok: true, pane: source };
}

export function halfRect(rect, side) {
  if (!rect) return null;
  const left = Number(rect.left) || 0;
  const top = Number(rect.top) || 0;
  const width = Math.max(0, Number(rect.width) || 0);
  const height = Math.max(0, Number(rect.height) || 0);
  if (side === 'left') return { left, top, width: width / 2, height };
  if (side === 'right') return { left: left + width / 2, top, width: width / 2, height };
  if (side === 'top') return { left, top, width, height: height / 2 };
  if (side === 'bottom') return { left, top: top + height / 2, width, height: height / 2 };
  return { left, top, width, height };
}

/** Collapsed runs with expanded siblings on both sides get one central bridge. */
export function collapsedBridgePairs(root) {
  const out = [];
  const isCollapsedNode = (node) => (isPane(node) ? node.collapsed : fullyCollapsed(node));
  const walk = (parent) => {
    if (!isGroup(parent)) return;
    let i = 0;
    while (i < parent.children.length) {
      const child = parent.children[i];
      if (!isCollapsedNode(child)) {
        if (isGroup(child)) walk(child);
        i += 1;
        continue;
      }
      const start = i;
      while (i < parent.children.length && isCollapsedNode(parent.children[i])) i += 1;
      const end = i - 1;
      let left = null;
      let right = null;
      for (let j = start - 1; j >= 0; j--) {
        if (isExpandedNode(parent.children[j])) { left = parent.children[j]; break; }
      }
      for (let j = end + 1; j < parent.children.length; j++) {
        if (isExpandedNode(parent.children[j])) { right = parent.children[j]; break; }
      }
      if (left && right) {
        out.push({
          group: parent,
          parent,
          start,
          end,
          run: parent.children.slice(start, end + 1),
          left,
          right,
          dir: parent.dir,
        });
      }
    }
  };
  walk(root);
  return out;
}

/** Resize the nearest expanded siblings; the collapsed capsule keeps its size. */
export function resizeCollapsedBridge(pair, leftSize) {
  if (!pair || !pair.left || !pair.right || !pair.parent) return { ok: false };
  if (pair.parent.manualLocked) return { ok: false };
  const left = pair.left;
  const right = pair.right;
  const total = (Number.isFinite(left.size) ? left.size : nodeMin(left, pair.dir))
    + (Number.isFinite(right.size) ? right.size : nodeMin(right, pair.dir));
  const minL = nodeMin(left, pair.dir);
  const minR = nodeMin(right, pair.dir);
  const l = Math.max(minL, Math.min(total - minR, Number(leftSize) || 0));
  const r = total - l;
  left.size = l;
  right.size = r;
  left.weight = Math.max(1, l - minL);
  right.weight = Math.max(1, r - minR);
  return { ok: true, left, right, total };
}

/**
 * Move an entire non-root group as a sibling/root-edge/tab-end. The group
 * object keeps its children, collapse state, sizes, weights and lastActive.
 */
export function moveGroupForDrop(root, group, target) {
  if (!isGroup(root) || !isGroup(group) || group === root || !target) return { ok: false };
  if (!nodeInTree(root, group)) return { ok: false };
  const parent = parentGroupOf(root, group);
  if (!parent) return { ok: false };
  const sourceIndex = parent.children.indexOf(group);
  if (sourceIndex < 0) return { ok: false };
  if (target.kind === 'gap') {
    const targetGroup = target.group;
    if (!isGroup(targetGroup) || !nodeInTree(root, targetGroup)) return { ok: false };
    if (targetGroup === group || nodeInTree(group, targetGroup)) return { ok: false };
    const rawIndex = Number.isInteger(target.index) ? target.index : targetGroup.children.length;
    if (targetGroup === parent && (rawIndex === sourceIndex || rawIndex === sourceIndex + 1)) {
      return { ok: false };
    }
  } else if (target.kind === 'root-edge') {
    if (!['left', 'right', 'top', 'bottom'].includes(target.edge)) return { ok: false };
    if (parent === root && root.children.length === 1) return { ok: false };
  } else if (target.kind !== 'tab-end') {
    return { ok: false };
  } else if (parent === root && sourceIndex === root.children.length - 1) {
    return { ok: false };
  }
  parent.children.splice(sourceIndex, 1);
  group.keep = true;
  if (target.kind === 'gap') {
    const targetGroup = target.group;
    let index = Number.isInteger(target.index) ? target.index : targetGroup.children.length;
    if (targetGroup === parent && sourceIndex < index) index -= 1;
    index = Math.max(0, Math.min(targetGroup.children.length, index));
    targetGroup.children.splice(index, 0, group);
  } else if (target.kind === 'root-edge') {
    const edge = target.edge;
    if (edge === 'left') root.children.unshift(group);
    else if (edge === 'right') root.children.push(group);
    else {
      const wrapper = createGroup('V', edge === 'top' ? [group, ...root.children] : [...root.children, group]);
      wrapper.keep = true;
      root.children = [wrapper];
    }
  } else {
    root.children.push(group);
  }
  normalizeTree(root);
  ensureOneExpanded(root);
  refreshLastActive(root);
  return { ok: true, group };
}

export function transferGroupBetweenRoots(sourceRoot, targetRoot, group, { copy = false } = {}) {
  if (!isGroup(sourceRoot) || !isGroup(targetRoot) || sourceRoot === targetRoot) return { ok: false };
  if (!isGroup(group) || group === sourceRoot || !nodeInTree(sourceRoot, group)) return { ok: false };
  const parent = parentGroupOf(sourceRoot, group);
  if (!parent) return { ok: false };
  // A tab cannot contain two instances of the same panel. Reject before any
  // detach/clone so a conflict leaves both source and target untouched.
  if (allPanes(group).some((p) => findPaneNode(targetRoot, p.panel))) return { ok: false };
  let nextGroup = group;
  if (copy) {
    nextGroup = cloneTree(group);
  } else {
    const index = parent.children.indexOf(group);
    if (index < 0) return { ok: false };
    parent.children.splice(index, 1);
    normalizeTree(sourceRoot);
    ensureOneExpanded(sourceRoot);
    refreshLastActive(sourceRoot);
  }
  nextGroup.keep = true;
  targetRoot.children.push(nextGroup);
  normalizeTree(targetRoot);
  ensureOneExpanded(targetRoot);
  refreshLastActive(targetRoot);
  return { ok: true, group: nextGroup };
}

export function rotateGroup(group) {
  if (!isGroup(group)) return false;
  group.dir = oppositeDir(group.dir);
  group.keep = true;
  return true;
}

export function reorderTabs(tabs, draggedId, targetId, after = false) {
  if (!Array.isArray(tabs) || draggedId === targetId) return false;
  const from = tabs.findIndex((t) => t.id === draggedId);
  if (from < 0) return false;
  const [tab] = tabs.splice(from, 1);
  let to = tabs.findIndex((t) => t.id === targetId);
  if (to < 0) { tabs.splice(from, 0, tab); return false; }
  if (after) to += 1;
  tabs.splice(to, 0, tab);
  return true;
}

export function clampMenuPosition({
  button, width, height, vw, vh, margin = 8, align = 'right',
}) {
  const bw = Math.max(1, width);
  const bh = Math.max(1, height);
  let left = align === 'left' ? button.left : button.right - bw;
  left = Math.max(margin, Math.min(vw - bw - margin, left));
  const below = vh - button.bottom - margin;
  const above = button.top - margin;
  let top;
  if (below >= bh || below >= above) top = button.bottom + 5;
  else top = button.top - bh - 5;
  top = Math.max(margin, Math.min(vh - bh - margin, top));
  return { left, top };
}

export function clonePaneForCopy(pane) {
  const copy = cloneTree(pane);
  delete copy.preferredSize;
  return copy;
}

export function addPaneToTab(tab, pane) {
  if (!tab || !isGroup(tab.root) || !isPane(pane)) return false;
  if (findPaneNode(tab.root, pane.panel)) return false;
  appendPaneToRoot(tab.root, cloneTree(pane));
  normalizeTree(tab.root);
  ensureOneExpanded(tab.root);
  refreshLastActive(tab.root);
  return true;
}

export function addMissingPaneToTab(tab, panel) {
  if (!tab || !PANEL_IDS.includes(panel) || findPaneNode(tab.root, panel)) return false;
  return addPaneToTab(tab, createPane(panel, { weight: 25 }));
}

export function resetTabTree(tab, templateRoot) {
  if (!tab || !isGroup(templateRoot)) return false;
  tab.root = cloneTree(templateRoot);
  tab.maximized = null;
  normalizeTree(tab.root);
  ensureOneExpanded(tab.root);
  refreshLastActive(tab.root);
  return true;
}

/** Clear a user-created tab while preserving its name/id/order. */
export function clearTabTree(tab) {
  if (!tab) return false;
  tab.root = createGroup('H', []);
  tab.maximized = null;
  return true;
}

/** Reset by stable id: known default tab gets root+name; user tab becomes empty. */
export function resetTabVariant(tab, defaultTab = null) {
  if (!tab) return false;
  if (defaultTab) {
    tab.name = defaultTab.name;
    return resetTabTree(tab, defaultTab.root);
  }
  return clearTabTree(tab);
}

function oppositeDir(dir) { return dir === 'H' ? 'V' : 'H'; }

function resetRestricted(node) {
  if (!node) return;
  if (isGroup(node)) {
    node.restricted = false;
    for (const child of node.children) resetRestricted(child);
  }
}

function lowestWeightExpandedPane(group, ctx) {
  const panes = expandedPanes(group);
  if (panes.length <= 1) return null;
  let best = null;
  for (const pane of panes) {
    if (pane === ctx.keepExpanded) continue;
    if (!best || pane.weight < best.weight) best = pane;
  }
  return best;
}

function layoutChildren(group, main, cross, ctx) {
  const dir = group.dir;
  group.manualLocked = false;
  let guard = 0;
  while (guard++ < 32) {
    group.restricted = false;
    const pairs = splitterPairs(group);
    const splitPx = pairs.length * SPLITTER;
    const expanded = [];
    const fixed = [];
    let fixedSum = 0;
    for (const child of group.children) {
      if (isExpandedNode(child)) expanded.push(child);
      else {
        fixed.push(child);
        fixedSum += nodeMin(child, dir);
      }
    }
    const minSum = expanded.reduce((n, child) => n + nodeMin(child, dir), 0);
    const free = main - splitPx - fixedSum - minSum;
    if (free >= 0 || expanded.length === 0) {
      // A pane explicitly expanded from a collapsed state asks for its recorded
      // size. Honour it (clamped by the other panes' minima), then distribute
      // the rest by weight. The request is consumed by this solve.
      const preferred = new Map();
      let preferredExtra = 0;
      for (const child of expanded) {
        if (!Number.isFinite(child.preferredSize)) continue;
        const othersMin = expanded.reduce((n, other) => n + (other === child ? 0 : nodeMin(other, dir)), 0);
        const room = Math.max(nodeMin(child, dir), main - splitPx - fixedSum - othersMin);
        const target = Math.max(nodeMin(child, dir), Math.min(room, child.preferredSize));
        if (target + 0.5 < child.preferredSize) group.manualLocked = true;
        preferred.set(child, target);
        preferredExtra += target - nodeMin(child, dir);
      }
      let remainingFree = Math.max(0, free - preferredExtra);
      const normal = expanded.filter((child) => !preferred.has(child));
      if (!normal.length && preferred.size && remainingFree > 0) {
        const extra = remainingFree / preferred.size;
        for (const [child, target] of preferred) preferred.set(child, target + extra);
        remainingFree = 0;
      }
      const normalWeight = normal.reduce((n, child) => n + Math.max(0.001, child.weight || 1), 0) || 1;
      for (const child of group.children) {
        let size;
        if (!isExpandedNode(child)) {
          size = nodeMin(child, dir);
        } else if (preferred.has(child)) {
          size = preferred.get(child);
          child.weight = Math.max(1, size - nodeMin(child, dir));
        } else {
          const share = Math.max(0.001, child.weight || 1) / normalWeight;
          size = nodeMin(child, dir) + (remainingFree > 0 ? remainingFree * share : 0);
        }
        child.size = size;
        solveNode(child, dir, size, cross, dir, ctx);
      }
      for (const child of expanded) child.preferredSize = undefined;
      if (free < 0) group.restricted = true;
      return;
    }
    // Space is insufficient: auto-collapse the lowest-weight expanded pane,
    // never the tab's kept-expanded pane and never the group's last one.
    const victim = lowestWeightExpandedPane(group, ctx);
    if (!victim) {
      group.restricted = true;
      const weightSum = expanded.reduce((n, child) => n + Math.max(0.001, child.weight || 1), 0) || 1;
      for (const child of group.children) {
        const size = isExpandedNode(child)
          ? nodeMin(child, dir) + 0 // stay clamped to min
          : nodeMin(child, dir);
        child.size = size;
        solveNode(child, dir, size, cross, dir, ctx);
        void weightSum;
      }
      return;
    }
    if (!Number.isFinite(victim.size) || victim.size <= 0) {
      // keep the old recorded size (auto-collapse must not overwrite it)
    }
    victim.collapsed = true;
    if (ctx.autoCollapsed) ctx.autoCollapsed.push(victim.panel);
  }
  group.restricted = true;
}

function solveNode(node, parentAxis, extent, cross, parentDir, ctx) {
  if (isPane(node)) {
    node.size = extent;
    return;
  }
  node.size = extent;
  const fully = fullyCollapsed(node);
  if (fully) {
    node.restricted = false;
    // One capsule in the parent; descendants are retained untouched for expand.
    return;
  }
  let main = extent;
  let crossInternal = cross;
  if (parentDir != null && node.dir !== parentAxis) {
    main = cross;
    crossInternal = extent;
  }
  layoutChildren(node, main, crossInternal, ctx);
}

export function solveTab(tab, width, height, { mutate = true, keepExpanded = null } = {}) {
  if (!tab || !isGroup(tab.root)) return tab;
  const working = mutate ? tab : cloneTree(tab);
  resetRestricted(working.root);
  const panes = allPanes(working.root);
  let protectedPane = null;
  if (keepExpanded) {
    protectedPane = panes.find((p) => p === keepExpanded || p.panel === keepExpanded) || null;
    if (protectedPane && protectedPane.collapsed) protectedPane.collapsed = false;
  }
  const expanded = panes.filter((p) => !p.collapsed);
  const keep = protectedPane || (expanded.length > 0 ? expanded[expanded.length - 1] : null);
  const ctx = { keepExpanded: keep, autoCollapsed: [] };
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const axis = working.root.dir;
  const main = axis === 'H' ? w : h;
  const cross = axis === 'H' ? h : w;
  solveNode(working.root, axis, main, cross, null, ctx);
  return working;
}

function sanitizePane(raw) {
  if (!raw || !PANEL_IDS.includes(raw.panel)) return null;
  const min = PANEL_LIMITS[raw.panel];
  return {
    panel: raw.panel,
    weight: Math.max(1, Number(raw.weight) || 1),
    size: Number.isFinite(raw.size) ? Math.max(0, raw.size) : null,
    collapsed: !!raw.collapsed,
    recordedSize: Number.isFinite(raw.recordedSize) ? Math.max(0, raw.recordedSize) : null,
    minW: min.minW,
    minH: min.minH,
  };
}

function sanitizeNode(raw, seen) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.panel === 'string') {
    if (seen.has(raw.panel)) return null;
    seen.add(raw.panel);
    return sanitizePane(raw);
  }
  if (!Array.isArray(raw.children)) return null;
  const dir = raw.dir === 'V' ? 'V' : 'H';
  const children = [];
  for (const child of raw.children) {
    const node = sanitizeNode(child, seen);
    if (node) children.push(node);
  }
  if (!children.length) return null;
  const group = {
    dir,
    children,
    weight: Math.max(1, Number(raw.weight) || 1),
    size: Number.isFinite(raw.size) ? Math.max(0, raw.size) : null,
    lastActive: typeof raw.lastActive === 'string' ? raw.lastActive : null,
  };
  if (raw.manualLocked) group.manualLocked = true;
  if (raw.keep) group.keep = true;
  return group;
}

function migrateV3(raw) {
  const tabs = [];
  for (const candidate of raw.tabs) {
    if (!candidate || typeof candidate !== 'object') continue;
    const id = typeof candidate.id === 'string' && candidate.id ? candidate.id : `tab-${tabs.length + 1}`;
    const name = typeof candidate.name === 'string' && candidate.name ? candidate.name.slice(0, 24) : '标签页';
    const panes = [];
    const makePane = (panel, grow) => {
      const pane = createPane(panel, { weight: Math.max(1, Number(grow) || 1), collapsed: !!(candidate.collapsed && candidate.collapsed[panel]) });
      panes.push(pane);
      return pane;
    };
    const makeStack = (stack) => {
      const items = Array.isArray(stack) ? stack : [];
      const nodes = items.filter((it) => it && PANEL_IDS.includes(it.panel) && it.panel !== 'timeline')
        .map((it) => makePane(it.panel, it.grow));
      if (!nodes.length) return null;
      if (nodes.length === 1) return nodes[0];
      return createGroup('V', nodes);
    };
    const columns = [];
    for (const col of Array.isArray(candidate.main) ? candidate.main : []) {
      const node = makeStack(col && col.stack);
      if (node) {
        node.weight = Math.max(1, Number(col.grow) || 30);
        columns.push(node);
      }
    }
    const dock = candidate.dock && candidate.dock.panel === 'timeline' ? makePane('timeline', 18) : null;
    if (dock) dock.weight = 18;
    let root;
    if (columns.length && dock) {
      const h = createGroup('H', columns, { weight: 82 });
      root = createGroup('H', [createGroup('V', [h, dock], { weight: 1 })]);
    } else if (columns.length) {
      root = createGroup('H', columns);
    } else if (dock) {
      root = createGroup('H', [dock]);
    } else {
      root = createGroup('H', []);
    }
    const tab = {
      id,
      name,
      root,
      maximized: typeof candidate.maximized === 'string' && PANEL_IDS.includes(candidate.maximized) ? candidate.maximized : null,
    };
    normalizeTree(tab.root);
    tabs.push(tab);
  }
  return tabs;
}

function addMissingPanels(tabs) {
  const seen = new Set();
  for (const tab of tabs) {
    for (const pane of allPanes(tab.root)) seen.add(pane.panel);
  }
  const missing = PANEL_IDS.filter((p) => !seen.has(p));
  if (!missing.length) return;
  const host = tabs[0];
  if (!host) return;
  for (const panel of missing) {
    const has = findPaneNode(host.root, panel);
    if (has) continue;
    appendPaneToRoot(host.root, createPane(panel, { weight: 25 }));
  }
}

export function sanitizeLayout(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tabs)) return null;
  const tabs = [];
  const usedIds = new Set();
  if (raw.version === 3 || (!Array.isArray(raw.tabs[0]?.root) && raw.tabs[0] && Array.isArray(raw.tabs[0].main))) {
    // v3 migration uses raw.version or a v3 shape probe.
  }
  const sourceTabs = (raw.version === 4 && raw.tabs.every((t) => t && t.root))
    ? raw.tabs
    : migrateV3(raw);
  for (const candidate of sourceTabs) {
    if (!candidate || typeof candidate !== 'object') continue;
    let id = typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id.trim() : '';
    if (!id || usedIds.has(id)) id = `tab-${tabs.length + 1}`;
    usedIds.add(id);
    const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim().slice(0, 24) : '标签页';
    const seen = new Set();
    let root = sanitizeNode(candidate.root, seen);
    if (!root) root = createGroup('H', []);
    if (!isGroup(root)) root = createGroup('H', [root]);
    normalizeTree(root);
    const tab = { id, name, root, maximized: null };
    if (typeof candidate.maximized === 'string' && PANEL_IDS.includes(candidate.maximized) && findPaneNode(root, candidate.maximized)) {
      tab.maximized = candidate.maximized;
    }
    ensureOneExpanded(root);
    tabs.push(tab);
  }
  if (!tabs.length) return null;
  addMissingPanels(tabs);
  for (const tab of tabs) {
    normalizeTree(tab.root);
    refreshLastActive(tab.root);
  }
  let activeId = typeof raw.activeId === 'string' ? raw.activeId : tabs[0].id;
  if (!tabs.some((t) => t.id === activeId)) activeId = tabs[0].id;
  const nextId = Number.isFinite(raw.nextId) ? Math.max(3, Math.floor(raw.nextId)) : tabs.length + 1;
  return { version: LAYOUT_VERSION, activeId, nextId, tabs };
}

function w(panel, weight) { return createPane(panel, { weight }); }

export function defaultLayout() {
  const workMain = createGroup('H', [
    w('source', 30),
    createGroup('V', [w('world', 69), w('scores', 31)], { weight: 36 }),
    createGroup('V', [w('pack', 67), w('log', 33)], { weight: 34 }),
  ], { weight: 82 });
  const workbench = {
    id: 'workbench',
    name: '工作台',
    root: createGroup('H', [createGroup('V', [workMain, w('timeline', 18)], { weight: 1 })]),
    maximized: null,
  };
  const observeMain = createGroup('H', [
    w('world', 62),
    createGroup('V', [w('scores', 45), w('log', 55)], { weight: 38 }),
  ], { weight: 82 });
  const observe = {
    id: 'observe',
    name: '观察',
    root: createGroup('H', [createGroup('V', [observeMain, w('timeline', 18)], { weight: 1 })]),
    maximized: null,
  };
  return { version: LAYOUT_VERSION, activeId: 'workbench', nextId: 3, tabs: [workbench, observe] };
}
