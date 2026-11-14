// Pure keyboard/focus helpers for the UI (no DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rovingIndex,
  menuIndex,
  sliderValue,
  sliderKey,
  focusSelector,
} from '../web/a11y.js';

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
