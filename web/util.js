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

/** Inline SVG sprite reference: `<svg class="icon"><use href="#i-name">`. */
export function icon(name, extra = '') {
  return `<svg class="icon${extra ? ` ${extra}` : ''}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
}

/** Temporary in-button success feedback; an absolute overlay avoids layout jump. */
export function flashButtonLabel(button, label, { iconName = 'copy', duration = 1200 } = {}) {
  if (!button) return;
  const original = button._feedbackOriginal || {
    aria: button.getAttribute('aria-label'),
    title: button.getAttribute('title'),
    position: button.style.position,
  };
  button._feedbackOriginal = original;
  const originalAria = original.aria;
  const originalTitle = original.title;
  const originalPosition = original.position;
  if (button._feedbackTimer) clearTimeout(button._feedbackTimer);
  if (button._feedbackEl && button._feedbackEl.parentNode) button._feedbackEl.parentNode.removeChild(button._feedbackEl);
  if (!button.style.position || button.style.position === 'static') button.style.position = 'relative';
  const feedback = document.createElement('span');
  feedback.className = 'btn-feedback';
  feedback.innerHTML = `${icon(iconName)}<span>${esc(label)}</span>`;
  button.appendChild(feedback);
  button._feedbackEl = feedback;
  button.setAttribute('aria-label', label);
  button.title = label;
  button._feedbackTimer = setTimeout(() => {
    button._feedbackTimer = 0;
    if (button._feedbackEl && button._feedbackEl.parentNode) button._feedbackEl.parentNode.removeChild(button._feedbackEl);
    button._feedbackEl = null;
    button._feedbackOriginal = null;
    button.style.position = originalPosition;
    if (originalAria == null) button.removeAttribute('aria-label');
    else button.setAttribute('aria-label', originalAria);
    if (originalTitle == null) button.removeAttribute('title');
    else button.setAttribute('title', originalTitle);
  }, duration);
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
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}
