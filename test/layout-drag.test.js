// Pure header-drag/capsule operations for the group-tree layout (no DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BAR,
  createGroup,
  createPane,
  collapsePane,
  nodeMin,
  allPanes,
  findPaneNode,
  movePaneForDrop,
  normalizeTree,
  rotateGroup,
  lastActivePane,
  refreshLastActive,
  solveTab,
  defaultLayout,
  ensureOneExpanded,
  reorderTabs,
  clampMenuPosition,
  addPaneToTab,
  addMissingPaneToTab,
  resetTabTree,
  resetTabVariant,
  clearTabTree,
  clonePaneForCopy,
} from '../web/layout-tree.js';

function pane(panel, weight = 1) { return createPane(panel, { weight }); }
function byPanel(root) { return allPanes(root).map((p) => p.panel).join(','); }

test('fully collapsed group is one capsule of thickness T, not child-bar sum', () => {
  const a = pane('source');
  const b = pane('world');
  const g = createGroup('H', [a, b]);
  collapsePane(a); collapsePane(b);
  assert.equal(nodeMin(g, 'H'), BAR.H);
  assert.equal(nodeMin(g, 'V'), BAR.V);
  solveTab({ root: createGroup('H', [g, pane('pack')]) }, 1000, 600);
  assert.equal(g.size, BAR.H);
});

test('lastActive falls back to the first leaf and updates per group', () => {
  const a = pane('source');
  const b = pane('world');
  const g = createGroup('H', [a, b]);
  assert.equal(lastActivePane(g), a);
  g.lastActive = 'world';
  assert.equal(lastActivePane(g), b);
  g.lastActive = 'missing';
  refreshLastActive(g);
  assert.equal(g.lastActive, 'source');
});

test('gap insert moves a pane to the exact requested sibling index', () => {
  const a = pane('source'); const b = pane('world'); const c = pane('pack');
  const root = createGroup('H', [a, b, c]);
  const result = movePaneForDrop(root, 'source', { kind: 'gap', group: root, index: 3 });
  assert.equal(result.ok, true);
  assert.deepEqual(root.children.map((n) => n.panel), ['world', 'pack', 'source']);
});

test('pane edge drop creates a preserved H wrapper', () => {
  const a = pane('source'); const b = pane('world'); const c = pane('pack');
  const root = createGroup('H', [a, b, c]);
  const result = movePaneForDrop(root, 'source', { kind: 'wrap', node: b, side: 'left' });
  assert.equal(result.ok, true);
  assert.equal(root.children.length, 2);
  const wrapper = root.children[0];
  assert.equal(wrapper.dir, 'H');
  assert.equal(wrapper.keep, true);
  assert.deepEqual(wrapper.children.map((n) => n.panel), ['source', 'world']);
});

test('ancestor group wrap nests the whole target group', () => {
  const a = pane('source'); const b = pane('world'); const c = pane('pack');
  const h = createGroup('H', [a, b]);
  const root = createGroup('V', [h, c]);
  const result = movePaneForDrop(root, 'pack', { kind: 'wrap', node: h, side: 'right' });
  assert.equal(result.ok, true);
  assert.equal(root.children.length, 1);
  const wrapper = root.children[0];
  assert.equal(wrapper.dir, 'H');
  assert.equal(wrapper.children.length, 2);
  assert.ok(wrapper.children[1].panel === 'pack');
});

test('root top edge wraps all root content in a V group while root stays H', () => {
  const a = pane('source'); const b = pane('world');
  const root = createGroup('H', [a, b]);
  const result = movePaneForDrop(root, 'source', { kind: 'root-edge', edge: 'top' });
  assert.equal(result.ok, true);
  assert.equal(root.dir, 'H');
  assert.equal(root.children.length, 1);
  const v = root.children[0];
  assert.equal(v.dir, 'V');
  assert.deepEqual(v.children.map((n) => n.panel), ['source', 'world']);
});

test('the dropped pane is protected from auto-collapse; other low-weight panes fold first', () => {
  const root = defaultLayout().tabs[0].root;
  const moved = movePaneForDrop(root, 'timeline', { kind: 'root-edge', edge: 'top' });
  assert.equal(moved.ok, true);
  assert.equal(moved.pane.collapsed, false);
  solveTab({ root }, 1100, 360, { keepExpanded: 'timeline' });
  const timeline = findPaneNode(root, 'timeline');
  assert.equal(timeline.collapsed, false);
  assert.ok(allPanes(root).some((p) => p !== timeline && p.collapsed));
  assert.ok(timeline.size >= 90);
});

test('a capsule/menu expansion keeps the chosen pane expanded during solve', () => {
  const a = pane('source'); const b = pane('world');
  const group = createGroup('V', [a, b]);
  const root = createGroup('H', [group]);
  collapsePane(a); collapsePane(b);
  const chosen = ensureOneExpanded(root, 'world');
  assert.equal(chosen.panel, 'world');
  solveTab({ root }, 200, 260, { keepExpanded: 'world' });
  assert.equal(findPaneNode(root, 'world').collapsed, false);
});

test('same-group end drop is a valid no-op and keeps the pane', () => {
  const a = pane('source');
  const root = createGroup('H', [a]);
  const result = movePaneForDrop(root, 'source', { kind: 'gap', group: root, index: 1 });
  // root itself is the source parent; moving to its end is a valid no-op.
  assert.equal(result.ok, true);
  assert.equal(byPanel(root), 'source');
});

test('normalize after a gap move prunes and keeps the root filling', () => {
  const a = pane('source'); const b = pane('world'); const c = pane('pack');
  const root = createGroup('H', [a, createGroup('H', [b]), c]);
  normalizeTree(root);
  assert.deepEqual(root.children.map((n) => n.panel), ['source', 'world', 'pack']);
  const result = movePaneForDrop(root, 'world', { kind: 'gap', group: root, index: 0 });
  assert.equal(result.ok, true);
  assert.deepEqual(root.children.map((n) => n.panel), ['world', 'source', 'pack']);
});

test('root left/right edge inserts at the root H ends', () => {
  const a = pane('source'); const b = pane('world'); const c = pane('pack');
  const root = createGroup('H', [a, b, c]);
  assert.equal(movePaneForDrop(root, 'pack', { kind: 'root-edge', edge: 'left' }).ok, true);
  assert.deepEqual(root.children.map((n) => n.panel), ['pack', 'source', 'world']);
  assert.equal(movePaneForDrop(root, 'source', { kind: 'root-edge', edge: 'right' }).ok, true);
  assert.deepEqual(root.children.map((n) => n.panel), ['pack', 'world', 'source']);
});

test('double-click rotation flips a group and marks it keep', () => {
  const a = pane('source'); const b = pane('world');
  const g = createGroup('H', [a, b]);
  assert.equal(rotateGroup(g), true);
  assert.equal(g.dir, 'V');
  assert.equal(g.keep, true);
});

test('capsule multi-pane groups are the only capsule candidates', () => {
  const a = pane('source'); const b = pane('world');
  const g = createGroup('H', [a, b]);
  collapsePane(a); collapsePane(b);
  assert.equal(allPanes(g).length, 2);
  assert.equal(nodeMin(g, 'H'), BAR.H);
  // A single-pane group is pruned by normalize, so it cannot become a capsule.
  const single = createGroup('H', [pane('pack')]);
  const root = createGroup('H', [single, b]);
  normalizeTree(root);
  assert.equal(root.children[0].panel, 'pack');
});

test('clamped menu flips above a bottom-left capsule and stays in the viewport', () => {
  const pos = clampMenuPosition({
    button: { left: 8, right: 44, top: 800, bottom: 840 },
    width: 200, height: 300, vw: 1440, vh: 900, margin: 8, align: 'right',
  });
  assert.equal(pos.left, 8);
  assert.ok(pos.top + 300 <= 900);
  assert.ok(pos.top < 800);
});

test('tab reorder and reset preserve ids/names/order and leave other tabs alone', () => {
  const doc = defaultLayout();
  const second = doc.tabs[1];
  assert.equal(reorderTabs(doc.tabs, 'observe', 'workbench', false), true);
  assert.deepEqual(doc.tabs.map((t) => t.id), ['observe', 'workbench']);
  assert.equal(doc.activeId, 'workbench');
  const tab = doc.tabs[1];
  tab.name = 'Custom';
  tab.maximized = 'world';
  const before = tab.id;
  assert.equal(resetTabTree(tab, defaultLayout().tabs[0].root), true);
  assert.equal(tab.id, before);
  assert.equal(tab.name, 'Custom');
  assert.equal(tab.maximized, null);
  assert.equal(allPanes(tab.root).length, 6);
  assert.equal(doc.tabs[0], second);
  assert.equal(doc.tabs[1], tab);
});

test('reset by stable id restores default name/root, clears user tabs', () => {
  const templates = defaultLayout();
  const tplWork = templates.tabs.find((t) => t.id === 'workbench');
  const tplObserve = templates.tabs.find((t) => t.id === 'observe');
  const work = { id: 'workbench', name: '我的工作台', root: createGroup('H', [createPane('log')]), maximized: 'log' };
  assert.equal(resetTabVariant(work, tplWork), true);
  assert.equal(work.name, '工作台');
  assert.deepEqual(allPanes(work.root).map((p) => p.panel).sort(), ['log', 'pack', 'scores', 'source', 'timeline', 'world']);

  const observe = { id: 'observe', name: 'OBS', root: createGroup('H', []), maximized: null };
  assert.equal(resetTabVariant(observe, tplObserve), true);
  assert.equal(observe.name, '观察');
  assert.ok(allPanes(observe.root).length > 0);

  const user = { id: 'tab-9', name: '我的空白页', root: createGroup('H', [createPane('scores')]), maximized: null };
  assert.equal(resetTabVariant(user, null), true);
  assert.equal(user.name, '我的空白页');
  assert.equal(allPanes(user.root).length, 0);
  assert.equal(user.root.dir, 'H');
});

test('copy/add helpers reject duplicates and preserve a copied collapsed pane', () => {
  const target = defaultLayout().tabs[1];
  const source = createPane('source', { weight: 7, collapsed: true, recordedSize: 333 });
  assert.equal(addPaneToTab(target, clonePaneForCopy(source)), true);
  const copy = findPaneNode(target.root, 'source');
  assert.equal(copy.weight, 7);
  assert.equal(copy.collapsed, true);
  assert.equal(copy.recordedSize, 333);
  assert.equal(addPaneToTab(target, clonePaneForCopy(source)), false);
  assert.equal(addMissingPaneToTab(target, 'source'), false);
  assert.equal(addMissingPaneToTab(target, 'world'), false); // observe already has world
  assert.equal(addMissingPaneToTab(target, 'timeline'), false);
});
