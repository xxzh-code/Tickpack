// Pure layout-tree/solver tests (no DOM). Run directly:
//   node --test test/layout.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BAR,
  SPLITTER,
  PANEL_LIMITS,
  createGroup,
  createPane,
  defaultLayout,
  fullyCollapsed,
  layoutDir,
  normalizeTree,
  nodeMin,
  splitterPairs,
  solveTab,
  allPanes,
  sanitizeLayout,
  expansionTarget,
  collapsePane,
  expandPane,
} from '../web/layout-tree.js';

function pane(panel, weight = 1) { return createPane(panel, { weight }); }

test('layout tree min sizes are declared per panel and recurse', () => {
  assert.deepEqual(PANEL_LIMITS.source, { minW: 250, minH: 140 });
  assert.deepEqual(PANEL_LIMITS.timeline, { minW: 200, minH: 90 });
  const h = createGroup('H', [pane('source'), pane('world')]);
  assert.equal(nodeMin(h, 'H'), 250 + SPLITTER + 232);
  assert.equal(nodeMin(h, 'V'), Math.max(140, 180));
  const v = createGroup('V', [pane('source'), pane('world')]);
  assert.equal(nodeMin(v, 'V'), 140 + SPLITTER + 180);
  assert.equal(nodeMin(v, 'H'), 250);
});

test('layoutDir follows the nearest non-fully-collapsed parent for folded groups', () => {
  const a = pane('source');
  const b = pane('world');
  const v = createGroup('V', [a, b]);
  assert.equal(fullyCollapsed(v), false);
  assert.equal(layoutDir(v, 'H'), 'V');
  a.collapsed = true;
  b.collapsed = true;
  assert.equal(fullyCollapsed(v), true);
  assert.equal(layoutDir(v, 'H'), 'H');
  assert.equal(layoutDir(v, 'V'), 'V');
});

test('splitters exist only between adjacent expanded siblings', () => {
  const a = pane('source');
  const b = pane('world');
  const c = pane('pack');
  const h = createGroup('H', [a, b, c]);
  assert.equal(splitterPairs(h).length, 2);
  b.collapsed = true;
  assert.equal(splitterPairs(h).length, 0);
  a.collapsed = false;
  c.collapsed = false;
  b.collapsed = false;
  const group = createGroup('H', [a, createGroup('H', [b, c])]);
  // The nested H group is a child, not a sibling; only one direct expanded pair.
  assert.equal(splitterPairs(group).length, 1);
});

test('size solver uses min + free * weight / total weight and fills the parent', () => {
  const a = pane('source', 1);
  const b = pane('world', 3);
  const h = createGroup('H', [a, b]);
  const tab = { root: h, maximized: null };
  solveTab(tab, 1000, 400);
  assert.equal(a.size + b.size + SPLITTER, 1000);
  const free = 1000 - SPLITTER - 250 - 232;
  assert.ok(Math.abs(a.size - (250 + free * 0.25)) < 1e-6);
  assert.ok(Math.abs(b.size - (232 + free * 0.75)) < 1e-6);
  assert.ok(a.size >= 250 && b.size >= 232);
});

test('collapsing records size, frees weight space and expanding restores the formula', () => {
  const a = pane('source');
  const b = pane('world');
  const h = createGroup('H', [a, b]);
  solveTab({ root: h }, 1000, 400);
  const before = a.size;
  collapsePane(a);
  solveTab({ root: h }, 1000, 400);
  assert.equal(a.collapsed, true);
  assert.equal(a.size, BAR.H);
  assert.equal(a.recordedSize, before);
  assert.equal(b.size, 1000 - BAR.H);
  expandPane(a);
  a.preferredSize = before;
  solveTab({ root: h }, 1000, 400);
  assert.equal(a.collapsed, false);
  assert.ok(a.size >= 250);
  assert.ok(b.size >= 232);
  assert.ok(Math.abs(a.size - before) < 1e-6);
  assert.ok(Math.abs(a.size + b.size + SPLITTER - 1000) < 1e-6);
});

test('expanding a pane from a fully collapsed group still fills the group', () => {
  const a = pane('source');
  const b = pane('world');
  const h = createGroup('H', [a, b]);
  collapsePane(a);
  collapsePane(b);
  expandPane(a);
  a.preferredSize = 300;
  solveTab({ root: h }, 1000, 400);
  assert.equal(b.collapsed, true);
  assert.equal(b.size, BAR.H);
  assert.equal(a.size, 1000 - BAR.H);
});

test('expansionTarget implements both mandatory expansion branches', () => {
  assert.equal(expansionTarget({
    available: 900, splitters: 6, otherExpandedMins: 232, collapsedBars: 36,
    min: 250, recordedSize: 500,
  }), 500);
  assert.equal(expansionTarget({
    available: 500, splitters: 6, otherExpandedMins: 0, collapsedBars: 36,
    min: 250, recordedSize: 700, fullyCollapsedBefore: true,
  }), 458);
  assert.equal(expansionTarget({
    available: 600, splitters: 6, otherExpandedMins: 300, collapsedBars: 0,
    min: 250, recordedSize: 500,
  }), 294);
});

test('insufficient space auto-collapses the lowest-weight expanded pane, never below min', () => {
  const a = pane('source', 1);
  const b = pane('world', 100);
  const h = createGroup('H', [a, b]);
  solveTab({ root: h }, 480, 400);
  assert.equal(a.collapsed, true);
  assert.equal(b.collapsed, false);
  assert.equal(a.size, BAR.H);
  assert.equal(a.size + b.size, 480);
  assert.ok(b.size >= 232);
});

test('a splitter move updates both weights and solves 1:1', () => {
  const a = pane('source', 1);
  const b = pane('world', 1);
  const h = createGroup('H', [a, b]);
  solveTab({ root: h }, 1000, 400);
  const startA = a.size;
  const startB = b.size;
  a.weight = Math.max(1, a.size - 250);
  b.weight = Math.max(1, b.size - 232);
  a.size += 40;
  a.weight += 40;
  b.size -= 40;
  b.weight = Math.max(1, b.size - 232);
  solveTab({ root: h }, 1000, 400);
  assert.ok(Math.abs(a.size - (startA + 40)) < 1e-6);
  assert.ok(Math.abs(b.size - (startB - 40)) < 1e-6);
  assert.ok(Math.abs(a.size + b.size + SPLITTER - 1000) < 1e-6);
});

test('a single expanded pane is never squeezed below min (restricted group)', () => {
  const only = pane('world');
  const h = createGroup('H', [only]);
  solveTab({ root: h }, 100, 400);
  assert.equal(h.restricted, true);
  assert.equal(only.size, 232);
});

test('manualResize keeps all panes expanded instead of auto-collapsing', () => {
  const source = pane('source');
  const world = pane('world');
  const root = createGroup('H', [source, world]);
  root.manualLocked = true;
  solveTab({ root }, 400, 400, { manualResize: true });
  assert.equal(source.collapsed, false);
  assert.equal(world.collapsed, false);
  assert.equal(root.restricted, true);
  assert.equal(root.manualLocked, false);
});

test('normalizeTree merges same-direction groups and prunes empty/single-child groups', () => {
  const a = pane('source');
  const b = pane('world');
  const c = pane('pack');
  const inner = createGroup('H', [a, b]);
  const root = createGroup('H', [inner, c]);
  normalizeTree(root);
  assert.equal(root.children.length, 3);
  assert.deepEqual(root.children.map((n) => n.panel), ['source', 'world', 'pack']);

  const only = createGroup('V', [createGroup('H', [a])]);
  const root2 = createGroup('H', [only, b]);
  normalizeTree(root2);
  assert.deepEqual(allPanes(root2).map((p) => p.panel), ['source', 'world']);
});

test('normalizeTree preserves a flattened group weight across its children', () => {
  const a = pane('source', 1);
  const b = pane('world', 1);
  const c = pane('pack', 2);
  const inner = createGroup('H', [b, c], { weight: 6 });
  const d = pane('scores', 1);
  const root = createGroup('H', [a, inner, d]);
  normalizeTree(root);
  assert.deepEqual(root.children.map((n) => n.panel), ['source', 'world', 'pack', 'scores']);
  // inner had weight 6, split 1:2 -> 2:4; total share is still 6.
  assert.equal(root.children[1].weight, 2);
  assert.equal(root.children[2].weight, 4);
});

test('normalizeTree preserves weight/size on a single-child group replacement', () => {
  const only = pane('source', 2);
  const group = createGroup('V', [only], { weight: 9, size: 444 });
  const root = createGroup('H', [group, pane('world')]);
  normalizeTree(root);
  const source = root.children.find((n) => n.panel === 'source');
  assert.ok(source);
  assert.equal(source.weight, 9);
  assert.equal(source.size, 444);
});

test('v3 migration keeps every panel and puts timeline inside the tree', () => {
  const v3 = {
    version: 3,
    activeId: 'workbench',
    nextId: 3,
    tabs: [{
      id: 'workbench',
      name: '工作台',
      main: [
        { grow: 30, stack: [{ panel: 'source', grow: 100 }] },
        { grow: 36, stack: [{ panel: 'world', grow: 69 }, { panel: 'scores', grow: 31 }] },
        { grow: 34, stack: [{ panel: 'pack', grow: 67 }, { panel: 'log', grow: 33 }] },
      ],
      dock: { panel: 'timeline', size: 150 },
      collapsed: { source: true },
      maximized: null,
    }],
  };
  const doc = sanitizeLayout(v3);
  assert.equal(doc.version, 4);
  const panels = allPanes(doc.tabs[0].root).map((p) => p.panel).sort();
  assert.deepEqual(panels, ['log', 'pack', 'scores', 'source', 'timeline', 'world']);
  assert.ok(doc.tabs[0].root.dir === 'H');
  assert.ok(allPanes(doc.tabs[0].root).some((p) => p.panel === 'timeline'));
  assert.equal(allPanes(doc.tabs[0].root).find((p) => p.panel === 'source').collapsed, true);
});

test('default workbench keeps root H, a V subtree and the timeline pane', () => {
  const doc = defaultLayout();
  const tab = doc.tabs[0];
  assert.equal(tab.root.dir, 'H');
  assert.equal(tab.root.children[0].dir, 'V');
  const panels = allPanes(tab.root).map((p) => p.panel);
  assert.ok(panels.includes('timeline'));
  assert.equal(panels.length, 6);
});
