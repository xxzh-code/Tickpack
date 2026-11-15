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

export function diagnosticStep(current, length, delta = 1) {
  if (length <= 0) return -1;
  if (current < 0) return delta < 0 ? length - 1 : 0;
  return (current + delta + length) % length;
}

export function toggleLineComment(text, start = 0, end = start) {
  const src = String(text || '');
  const a = Math.max(0, Math.min(start, end));
  const b = Math.max(start, end);
  const firstStart = src.lastIndexOf('\n', Math.max(0, a - 1)) + 1;
  const endProbe = Math.max(a, b - 1);
  let lastEnd = src.indexOf('\n', endProbe);
  if (lastEnd < 0) lastEnd = src.length;
  const lines = src.slice(firstStart, lastEnd).split('\n');
  const nonEmpty = lines.filter((line) => line.trim() !== '');
  const canUncomment = nonEmpty.length > 0
    && nonEmpty.every((line) => /^[ \t]*#(?: |$)/.test(line));
  const removed = [];
  const added = [];
  let offset = firstStart;
  const output = [];
  for (const line of lines) {
    const indent = (line.match(/^[ \t]*/) || [''])[0];
    const body = line.slice(indent.length);
    if (canUncomment) {
      if (body.startsWith('# ')) {
        output.push(indent + body.slice(2));
        removed.push(offset + indent.length);
      } else if (body === '#') {
        output.push(indent);
        removed.push(offset + indent.length);
      } else {
        output.push(line);
      }
    } else {
      output.push(indent + '# ' + body);
      added.push(offset + indent.length);
    }
    offset += line.length + 1;
  }
  if (!canUncomment && lines.length === 0) return { text: src, start: a, end: b };
  const nextText = src.slice(0, firstStart) + output.join('\n') + src.slice(lastEnd);
  let nextStart = a;
  let nextEnd = b;
  for (const pos of added) {
    if (a >= pos) nextStart += 2;
    if (b >= pos) nextEnd += 2;
  }
  for (const pos of removed) {
    const delta = src[pos] === '#' && src[pos + 1] === ' ' ? 2 : 1;
    if (a >= pos + delta) nextStart -= delta;
    if (b >= pos + delta) nextEnd -= delta;
  }
  return { text: nextText, start: nextStart, end: nextEnd };
}

export function runButtonLabel(hasSession) {
  return hasSession ? '重跑' : '运行';
}

export function shouldContinueFrame({ playing = false, world = false, timeline = false } = {}) {
  return !!(playing || world || timeline);
}
