// Small pure accessibility/keyboard helpers shared by the UI.

export function rovingIndex(current, length, key) {
  if (length <= 0) return -1;
  const cur = Math.max(0, Math.min(length - 1, current | 0));
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  if (key === 'ArrowRight') return (cur + 1) % length;
  if (key === 'ArrowLeft') return (cur - 1 + length) % length;
  return cur;
}

export function menuIndex(current, length, key) {
  if (length <= 0) return -1;
  const cur = Math.max(-1, Math.min(length - 1, current | 0));
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  if (key === 'ArrowDown') return cur < 0 ? 0 : (cur + 1) % length;
  if (key === 'ArrowUp') return cur <= 0 ? length - 1 : cur - 1;
  return cur;
}

export function sliderValue(current, total, key, page = 10) {
  const max = Math.max(0, total | 0);
  const cur = Math.max(0, Math.min(max, current | 0));
  if (key === 'Home') return 0;
  if (key === 'End') return max;
  const step = Math.max(1, page | 0);
  if (key === 'ArrowLeft' || key === 'ArrowDown') return Math.max(0, cur - 1);
  if (key === 'ArrowRight' || key === 'ArrowUp') return Math.min(max, cur + 1);
  if (key === 'PageUp') return Math.max(0, cur - step);
  if (key === 'PageDown') return Math.min(max, cur + step);
  return cur;
}

export function sliderKey(key) {
  return ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(key);
}

export function focusSelector(key) {
  if (!key) return '';
  return `[data-focus-key="${String(key).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
}
