// Pure keyboard/focus helpers for the UI (no DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rovingIndex,
  menuIndex,
  sliderValue,
  sliderKey,
  focusSelector,
  splitterPercent,
  resetPairSizes,
  normalizeSpeed,
  speedStorageValue,
  seekTick,
  importableName,
  diagnosticStep,
  toggleLineComment,
  runButtonLabel,
  shouldContinueFrame,
} from '../web/a11y.js';
import { documentTitle } from '../web/util.js';
import { themeColor } from '../web/theme.js';

test('tab roving index wraps and supports Home/End', () => {
  assert.equal(rovingIndex(0, 3, 'ArrowRight'), 1);
  assert.equal(rovingIndex(2, 3, 'ArrowRight'), 0);
  assert.equal(rovingIndex(0, 3, 'ArrowLeft'), 2);
  assert.equal(rovingIndex(1, 3, 'Home'), 0);
  assert.equal(rovingIndex(1, 3, 'End'), 2);
  assert.equal(rovingIndex(1, 0, 'ArrowRight'), -1);
});

test('menu index starts at first item and wraps', () => {
  assert.equal(menuIndex(-1, 3, 'ArrowDown'), 0);
  assert.equal(menuIndex(0, 3, 'ArrowDown'), 1);
  assert.equal(menuIndex(2, 3, 'ArrowDown'), 0);
  assert.equal(menuIndex(0, 3, 'ArrowUp'), 2);
  assert.equal(menuIndex(1, 3, 'Home'), 0);
  assert.equal(menuIndex(1, 3, 'End'), 2);
});

test('timeline slider keys step, page and clamp', () => {
  assert.equal(sliderValue(5, 40, 'ArrowRight'), 6);
  assert.equal(sliderValue(5, 40, 'ArrowLeft'), 4);
  assert.equal(sliderValue(5, 40, 'PageDown', 10), 15);
  assert.equal(sliderValue(5, 40, 'PageUp', 10), 0);
  assert.equal(sliderValue(5, 40, 'Home'), 0);
  assert.equal(sliderValue(5, 40, 'End'), 40);
  assert.equal(sliderValue(40, 40, 'ArrowRight'), 40);
  assert.equal(sliderKey('PageDown'), true);
  assert.equal(sliderKey('x'), false);
});

test('focus selectors escape quotes and backslashes', () => {
  assert.equal(focusSelector('tab:a'), '[data-focus-key="tab:a"]');
  assert.equal(focusSelector('a"b'), '[data-focus-key="a\\"b"]');
  assert.equal(focusSelector(''), '');
});

test('splitter ratio and 1:1 reset honour both minima', () => {
  assert.equal(splitterPercent(75, 25), 75);
  assert.equal(splitterPercent(0, 0), 50);
  assert.deepEqual(resetPairSizes(100, 20, 20), { left: 50, right: 50 });
  assert.deepEqual(resetPairSizes(100, 70, 20), { left: 70, right: 30 });
  assert.deepEqual(resetPairSizes(50, 40, 30), { left: 40, right: 30 });
});

test('speed normalization clamps to 1..60 and persists a rounded value', () => {
  assert.equal(normalizeSpeed(10), 10);
  assert.equal(normalizeSpeed(0), 1);
  assert.equal(normalizeSpeed(-5), 1);
  assert.equal(normalizeSpeed(100), 60);
  assert.equal(normalizeSpeed(12.6), 13);
  assert.equal(speedStorageValue(12.6), '13');
  assert.equal(speedStorageValue('bad'), '10');
});

test('log tick and drop filename helpers accept only valid targets', () => {
  assert.equal(seekTick('0', 10), 0);
  assert.equal(seekTick('7', 10), 7);
  assert.equal(seekTick('12', 10), 10);
  assert.equal(seekTick('-1', 10), null);
  assert.equal(seekTick('x', 10), null);
  assert.equal(importableName('demo.tpk'), true);
  assert.equal(importableName('DEMO.TXT'), true);
  assert.equal(importableName('demo.tp'), true);
  assert.equal(importableName('demo.mcfunction'), false);
  assert.equal(importableName('demo'), false);
});

test('document title and theme-color helpers stay in sync', () => {
  assert.equal(documentTitle({ sampleTitle: '螺旋' }), 'Tickpack · 螺旋');
  assert.equal(documentTitle({ sampleTitle: '螺旋', dirty: true }), 'Tickpack · 螺旋 •');
  assert.equal(documentTitle({ sampleTitle: '螺旋', dirty: true, theater: true }), 'Tickpack · 剧场 •');
  assert.equal(documentTitle({}), 'Tickpack');
  assert.equal(themeColor('light'), '#eef1f4');
  assert.equal(themeColor('dark'), '#0b0f14');
});

test('Ctrl+/ line comment toggles indented selections', () => {
  const added = toggleLineComment('walk\n  jump', 0, 11);
  assert.equal(added.text, '# walk\n  # jump');
  const removed = toggleLineComment(added.text, 0, added.text.length);
  assert.equal(removed.text, 'walk\n  jump');
  const single = toggleLineComment('  say hi', 2, 2);
  assert.equal(single.text, '  # say hi');
  assert.equal(toggleLineComment('  # say hi', single.start, single.end).text, '  say hi');
});

test('diagnostic F8 steps wrap and run label follows session', () => {
  assert.equal(diagnosticStep(-1, 3, 1), 0);
  assert.equal(diagnosticStep(0, 3, 1), 1);
  assert.equal(diagnosticStep(2, 3, 1), 0);
  assert.equal(diagnosticStep(-1, 3, -1), 2);
  assert.equal(diagnosticStep(0, 3, -1), 2);
  assert.equal(diagnosticStep(0, 0, 1), -1);
  assert.equal(runButtonLabel(false), '运行');
  assert.equal(runButtonLabel(true), '重跑');
});

test('frame scheduler continues only for playing/world/timeline work', () => {
  assert.equal(shouldContinueFrame({}), false);
  assert.equal(shouldContinueFrame({ playing: true }), true);
  assert.equal(shouldContinueFrame({ world: true }), true);
  assert.equal(shouldContinueFrame({ timeline: true }), true);
  assert.equal(shouldContinueFrame({ playing: false, world: false, timeline: false }), false);
});
