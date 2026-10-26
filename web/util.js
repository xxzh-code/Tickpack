// Small DOM + formatting helpers shared by the Tickpack UI modules.
// No dependencies, no framework — just enough to keep the app code readable.

export const $ = (sel, root = document) => root.querySelector(sel);

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Replay a CSS "flash" animation on a node (used for value changes). */
export function flash(node, className = 'flash') {
  if (!node) return;
  node.classList.remove(className);
  // force style flush so the animation restarts
  void node.offsetWidth;
  node.classList.add(className);
}

let toastEl = null;
let toastTimer = 0;

/** Bottom-right transient message. kind: info | error | ok */
export function showToast(message, kind = 'info') {
  if (!toastEl) {
    toastEl = document.getElementById('toast');
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'toast';
      toastEl.className = 'toast';
      document.body.appendChild(toastEl);
    }
  }
  toastEl.textContent = message;
  toastEl.dataset.kind = kind;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2600);
}

/** Compact integer formatting with thousands separators only for big numbers. */
export function fmtInt(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return Math.abs(n) >= 10000 ? n.toLocaleString('en-US') : String(n);
}

export function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
