// Bottom timeline: auto-scaling tick ruler, one colored mark per tick where
// blocks changed, a draggable playhead with a handle. Scrubbing calls back into
// the app, which restores the per-tick snapshot.

import { clamp } from './util.js';
import { withAlpha } from './blocks.js';

// The ruler never starts below 40 ticks, then grows in readable steps so the
// playhead does not jump every frame while a run is in progress.
const MIN_DOMAIN = 40;
const DOMAIN_STEPS = [40, 50, 60, 75, 100, 125, 150, 200, 250, 300, 400, 500, 600, 750, 1000, 1250, 1500, 2000, 2500, 3000];
const PAD = 14;

function domainFor(total) {
  if (total <= 0) return MIN_DOMAIN;
  const need = Math.max(total + 5, Math.ceil(total * 1.15));
  for (const s of DOMAIN_STEPS) if (s >= need) return s;
  return Math.ceil(need / 1000) * 1000;
}

function niceStep(pxPerTick) {
  const candidates = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];
  for (const c of candidates) {
    if (c * pxPerTick >= 52) return c;
  }
  return 5000;
}

export function createTimeline({ canvas, labelEl, onSeek }) {
  const ctx = canvas.getContext('2d');
  let w = 0;
  let h = 0;
  let dpr = 1;

  let total = 0; // highest tick reached
  let cursor = 0; // tick currently displayed
  let marks = new Map(); // tick -> { colors: [color], count }
  let hover = null; // tick under the pointer
  let dragging = false;
  let dirty = true;

  const ro = new ResizeObserver(() => {
    const rect = canvas.getBoundingClientRect();
    w = Math.max(80, Math.floor(rect.width));
    h = Math.max(40, Math.floor(rect.height));
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dirty = true;
  });
  ro.observe(canvas);

  const domain = () => domainFor(total);
  const xOf = (t) => PAD + (t / domain()) * (w - PAD * 2);
  const tickAt = (x) => {
    const t = ((x - PAD) / Math.max(1, w - PAD * 2)) * domain();
    return clamp(Math.round(t), 0, Math.max(0, total));
  };

  function updateLabel() {
    if (!labelEl) return;
    labelEl.innerHTML =
      `<span class="tl-elapsed">elapsed</span> ` +
      `<span class="tl-cursor">${cursor}</span> ` +
      `<span class="tl-sep">/</span> ` +
      `<span class="tl-total">${total}</span>`;
  }

  function roundRect(x, y, rw, rh, r) {
    const rr = Math.min(r, rw / 2, rh / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + rw, y, x + rw, y + rh, rr);
    ctx.arcTo(x + rw, y + rh, x, y + rh, rr);
    ctx.arcTo(x, y + rh, x, y, rr);
    ctx.arcTo(x, y, x + rw, y, rr);
    ctx.closePath();
  }

  function draw() {
    if (!w || !h) return;
    const baseY = h - 15;
    const topY = 7;
    const dom = domain();
    const pxPerTick = (w - PAD * 2) / dom;
    ctx.clearRect(0, 0, w, h);

    // ---- activity band: one column per tick, height = blocks placed that tick
    const markW = clamp(pxPerTick * 0.55, 2.2, 7);
    const maxBar = Math.max(8, baseY - topY - 6);
    for (const [t, mark] of marks) {
      if (t > total) continue;
      const x = xOf(t);
      const colors = mark.colors;
      const count = mark.count || colors.length;
      const barH = clamp(4 + count * 2.3, 5, maxBar);
      const c0 = colors[0] || '#5fe8e0';

      const grad = ctx.createLinearGradient(0, baseY - 4 - barH, 0, baseY - 3);
      grad.addColorStop(0, withAlpha(c0, 0.85));
      grad.addColorStop(1, withAlpha(c0, 0.14));
      ctx.fillStyle = grad;
      roundRect(x - markW / 2, baseY - 4 - barH, markW, barH, 1.4);
      ctx.fill();

      // stacked block-color caps at the top of the column
      for (let i = 0; i < colors.length && i < 3; i++) {
        ctx.fillStyle = withAlpha(colors[i], 0.95);
        ctx.fillRect(x - markW / 2, baseY - 4 - barH + i * 2.8, markW, 2.5);
      }
      ctx.fillStyle = colors[colors.length - 1] || c0;
      ctx.fillRect(x - markW / 2, baseY - 4 - barH, markW, 1.5);
    }

    // ---- rail
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD, baseY + 0.5);
    ctx.lineTo(w - PAD, baseY + 0.5);
    ctx.stroke();

    const step = niceStep(pxPerTick);

    // faint vertical ruler grid
    ctx.strokeStyle = 'rgba(140, 165, 190, 0.055)';
    ctx.beginPath();
    for (let t = 0; t <= dom + 0.5; t += step) {
      const x = Math.round(xOf(t)) + 0.5;
      ctx.moveTo(x, topY);
      ctx.lineTo(x, baseY);
    }
    ctx.stroke();

    // labels + ticks
    ctx.font = '500 9.5px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let t = 0; t <= dom + 0.5; t += step) {
      const x = Math.round(xOf(t)) + 0.5;
      ctx.strokeStyle = 'rgba(190, 210, 230, 0.22)';
      ctx.beginPath();
      ctx.moveTo(x, baseY);
      ctx.lineTo(x, baseY + 4);
      ctx.stroke();
      ctx.fillStyle = t <= cursor ? 'rgba(140, 195, 200, 0.9)' : 'rgba(105, 122, 142, 0.65)';
      ctx.fillText(String(t), x, baseY + 7);
    }

    // ---- progress rail (drawn over the ruler line)
    if (cursor > 0) {
      const xc = xOf(cursor);
      const grad = ctx.createLinearGradient(xOf(0), 0, xc, 0);
      grad.addColorStop(0, 'rgba(95, 232, 224, 0.35)');
      grad.addColorStop(1, 'rgba(95, 232, 224, 0.95)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(PAD, baseY + 0.5);
      ctx.lineTo(xc, baseY + 0.5);
      ctx.stroke();
    }

    // ---- end-of-run marker
    if (total > 0) {
      const xe = xOf(total);
      ctx.save();
      ctx.translate(xe, baseY - 10);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = 'rgba(246, 211, 60, 0.95)';
      ctx.shadowColor = 'rgba(246, 211, 60, 0.7)';
      ctx.shadowBlur = 7;
      ctx.fillRect(-2.4, -2.4, 4.8, 4.8);
      ctx.restore();
    }

    // ---- hover guide
    if (hover != null && !dragging) {
      const xh = Math.round(xOf(hover)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xh, topY);
      ctx.lineTo(xh, baseY);
      ctx.stroke();
      ctx.setLineDash([]);

      const mk = marks.get(hover);
      const label = mk
        ? `t=${hover} · ${mk.count} block${mk.count === 1 ? '' : 's'} · ${mk.cmds || 0} cmd`
        : `t=${hover}`;
      ctx.font = '600 9.5px ui-monospace, Consolas, monospace';
      const tw = ctx.measureText(label).width + 10;
      const bx = clamp(xh - tw / 2, 2, w - tw - 2);
      ctx.fillStyle = 'rgba(16, 24, 32, 0.95)';
      ctx.strokeStyle = 'rgba(95, 232, 224, 0.35)';
      roundRect(bx, 1, tw, 13, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(200, 240, 240, 0.95)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + 5, 8);
    }

    // ---- playhead line + handle
    const x = xOf(cursor);
    ctx.save();
    ctx.strokeStyle = 'rgba(95, 232, 224, 0.95)';
    ctx.shadowColor = 'rgba(95, 232, 224, 0.85)';
    ctx.shadowBlur = 9;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, topY + 6);
    ctx.lineTo(x, baseY + 3);
    ctx.stroke();
    ctx.restore();

    // top handle
    ctx.save();
    ctx.shadowColor = 'rgba(95, 232, 224, 0.7)';
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#eafffd';
    roundRect(x - 4, topY - 4, 8, 15, 3);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = 'rgba(6, 24, 28, 0.85)';
    roundRect(x - 1.5, topY - 1, 3, 9, 1.5);
    ctx.fill();

    // bottom pointer
    ctx.fillStyle = 'rgba(95, 232, 224, 0.95)';
    ctx.beginPath();
    ctx.moveTo(x - 4, baseY + 4);
    ctx.lineTo(x + 4, baseY + 4);
    ctx.lineTo(x, baseY + 9);
    ctx.closePath();
    ctx.fill();
  }

  function seekFromEvent(ev) {
    const rect = canvas.getBoundingClientRect();
    const t = tickAt(ev.clientX - rect.left);
    if (t !== cursor) onSeek && onSeek(t);
    return t;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (total <= 0) return;
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('dragging');
    seekFromEvent(e);
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const t = tickAt(e.clientX - rect.left);
    if (dragging) {
      seekFromEvent(e);
    }
    if (t !== hover) {
      hover = t;
      dirty = true;
    }
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    canvas.classList.remove('dragging');
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    if (hover != null) { hover = null; dirty = true; }
  });

  const api = {
    reset() {
      total = 0;
      cursor = 0;
      marks = new Map();
      hover = null;
      dirty = true;
      updateLabel();
    },
    setData(nextTotal, nextCursor) {
      total = Math.max(0, nextTotal | 0);
      cursor = clamp(nextCursor | 0, 0, total);
      dirty = true;
      updateLabel();
    },
    setCursor(nextCursor) {
      cursor = clamp(nextCursor | 0, 0, Math.max(total, 0));
      dirty = true;
      updateLabel();
    },
    addMark(tick, colors, count = 1, cmds = 0) {
      if (!colors || !colors.length) return;
      const prev = marks.get(tick);
      if (prev) {
        const seen = new Set(prev.colors);
        for (const c of colors) if (!seen.has(c) && prev.colors.length < 4) prev.colors.push(c);
        prev.count += count;
        prev.cmds = Math.max(prev.cmds || 0, cmds);
      } else {
        marks.set(tick, { colors: colors.slice(0, 4), count, cmds });
      }
      dirty = true;
    },
    render() {
      if (!dirty) return;
      dirty = false;
      draw();
    },
    markDirty() { dirty = true; },
    markCount() { return marks.size; },
  };

  updateLabel();
  return api;
}
