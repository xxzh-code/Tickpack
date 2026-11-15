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

export function splitterPercent(left, right) {
  const l = Math.max(0, Number(left) || 0);
  const r = Math.max(0, Number(right) || 0);
  const total = l + r;
  return total > 0 ? Math.round((l / total) * 100) : 50;
}

export function resetPairSizes(total, minLeft, minRight) {
  const t = Math.max(0, Number(total) || 0);
  const minL = Math.max(0, Number(minLeft) || 0);
  const minR = Math.max(0, Number(minRight) || 0);
  if (t < minL + minR) return { left: minL, right: minR };
  const left = Math.max(minL, Math.min(t - minR, t / 2));
  return { left, right: t - left };
}

export function normalizeSpeed(value, fallback = 10) {
  const n = Number(value);
  const base = Number.isFinite(n) ? n : fallback;
  return Math.min(60, Math.max(1, Math.round(base)));
}

export function speedStorageValue(value, fallback = 10) {
  return String(normalizeSpeed(value, fallback));
}

export function seekTick(value, total) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return Math.min(n, Math.max(0, Number(total) | 0));
}

export function importableName(name) {
  return /\.(tpk|tp|txt)$/i.test(String(name || ''));
}
