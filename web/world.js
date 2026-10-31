// The block world: an unbounded top-down canvas with an auto-fitting camera,
// manual pan/zoom, flat block tiles, a restrained placement "pop" and particles.
// Colours come from the active theme palette (web/theme.js) so light/dark both
// look native; there are no gradients or glows in the world rendering.
//
// Camera = { cx, cz, span }: world centre and the number of world units across
// the smaller canvas side. There is no board clamp — blocks may exist anywhere;
// the 33x33 board is only drawn as a subtle reference frame.

import { blockColor, isGlass } from './blocks.js';
import { clamp } from './util.js';
import { CANVAS_THEMES } from './theme.js';

const BOARD_LO = -16; // reference board: block coordinates -16 .. 16 inclusive
const BOARD_HI = 17; // world-unit edge (block x occupies [x, x+1))
const BOARD_SIZE = BOARD_HI - BOARD_LO; // 33
const DEFAULT_CAM = { cx: 0.5, cz: 0.5, span: BOARD_SIZE };

const MIN_SPAN = 4;
const MAX_SPAN = 400;
const FIT_MIN_SPAN = 12; // auto-fit never zooms in further than this
const FIT_PADDING = 1.5; // blocks of padding around the content
const FIT_GROW = 1.25; // refit while running after the content grows this much
const FEW_BLOCKS = 8; // below this a run keeps the default 33x33 framing
const POP_MS = 140;
const PARTICLE_MS = 760;
const CAM_EASE = 6.5;

function easeOutBack(t) {
  const c1 = 1.28;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function formatZoom(zoom) {
  if (zoom >= 10) return zoom.toFixed(0);
  if (zoom >= 1) return (Math.round(zoom * 10) / 10).toFixed(1);
  return zoom.toFixed(2);
}

export function createWorld(canvas, options = {}) {
  const ctx = canvas.getContext('2d');
  const wrap = canvas.parentElement;
  const onCamera = typeof options.onCamera === 'function' ? options.onCamera : null;

  let w = 0;
  let h = 0;
  let dpr = 1;
  let side = 0; // square viewport size in px
  let cell = 12;
  let pad = 18;

  let blocks = new Map(); // key "x,y,z" -> { x, y, z, block }
  let pen = { x: 0.5, z: 0.5, yaw: 0 };
  let hasPen = false;
  let tick = 0;
  let blockCount = 0;

  const cam = { ...DEFAULT_CAM };
  let camTarget = { ...DEFAULT_CAM };
  let lastNow = 0;
  let palette = CANVAS_THEMES.dark;

  let autoFit = true; // follow the drawing
  let fitLocked = false; // debug query pinned the camera: never auto-fit
  let lastFitDim = 0; // raw content size at the last auto-fit
  let fitPending = false;
  let fitAt = 0;
  let fitInstant = false;

  let lastReportKey = '';

  const pops = new Map(); // key -> start time
  const particles = [];

  function key(x, y, z) {
    return `${x},${y},${z}`;
  }

  function resize() {
    const rect = wrap.getBoundingClientRect();
    w = Math.max(160, Math.floor(rect.width));
    h = Math.max(160, Math.floor(rect.height));
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    pad = Math.max(8, Math.min(24, Math.min(w, h) * 0.05));
    applyLayout();
    if (autoFit && !fitLocked) applyTarget(computeFit());
  }

  const ro = new ResizeObserver(resize);
  ro.observe(wrap);
  resize();

  function applyLayout() {
    side = Math.min(w, h) - pad * 2;
    cell = side / cam.span;
  }

  const wx2px = (wx) => w / 2 + (wx - cam.cx) * cell;
  const wz2py = (wz) => h / 2 + (wz - cam.cz) * cell;

  function screenToWorld(px, py) {
    return { x: cam.cx + (px - w / 2) / cell, z: cam.cz + (py - h / 2) / cell };
  }

  function visibleRange() {
    return {
      x0: cam.cx - w / 2 / cell,
      x1: cam.cx + w / 2 / cell,
      z0: cam.cz - h / 2 / cell,
      z1: cam.cz + h / 2 / cell,
    };
  }

  // ------------------------------------------------------------ camera fit
  function contentBounds() {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    let count = 0;

    for (const b of blocks.values()) {
      if (b.y !== 0) continue;
      count += 1;
      if (b.x < minX) minX = b.x;
      if (b.x + 1 > maxX) maxX = b.x + 1;
      if (b.z < minZ) minZ = b.z;
      if (b.z + 1 > maxZ) maxZ = b.z + 1;
    }
    if (hasPen) {
      minX = Math.min(minX, pen.x - 0.5);
      maxX = Math.max(maxX, pen.x + 0.5);
      minZ = Math.min(minZ, pen.z - 0.5);
      maxZ = Math.max(maxZ, pen.z + 0.5);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minZ)) return null;
    return { minX, minZ, maxX, maxZ, count };
  }

  function fitForBounds(b) {
    const bw = b.maxX - b.minX;
    const bh = b.maxZ - b.minZ;
    const span = clamp((Math.max(bw, bh) + FIT_PADDING * 2) * 1.25, FIT_MIN_SPAN, MAX_SPAN);
    return { cx: (b.minX + b.maxX) / 2, cz: (b.minZ + b.maxZ) / 2, span };
  }

  /** The camera the auto-fit wants right now (defaults to the 33x33 board). */
  function computeFit() {
    const b = contentBounds();
    if (!b) return { ...DEFAULT_CAM };
    // A few blocks keep the familiar board framing — unless the pen ran away.
    if (b.count < FEW_BLOCKS) {
      const outsideBoard = b.minX < BOARD_LO - 1 || b.maxX > BOARD_HI + 1
        || b.minZ < BOARD_LO - 1 || b.maxZ > BOARD_HI + 1;
      if (!outsideBoard) return { ...DEFAULT_CAM };
    }
    return fitForBounds(b);
  }

  function applyTarget(target, { instant = false } = {}) {
    camTarget = {
      cx: target.cx,
      cz: target.cz,
      span: clamp(target.span, MIN_SPAN, MAX_SPAN),
    };
    if (instant) snapCamera();
  }

  function snapCamera() {
    cam.cx = camTarget.cx;
    cam.cz = camTarget.cz;
    cam.span = camTarget.span;
    applyLayout();
  }

  /** Called by the app when the run starts/pauses/finishes; debounced so a
   *  click/drag does not make the camera chase every intermediate frame.
   *  `instant` is used when the timeline is not playing (pause / finish / scrub):
   *  the final framing is guaranteed before the next paint instead of easing in
   *  over several frames (also keeps headless screenshots deterministic). */
  function requestFit(delay = 160, instant = false) {
    if (!autoFit || fitLocked) return;
    fitPending = true;
    fitAt = performance.now() + Math.max(0, delay);
    fitInstant = !!instant;
  }

  /** Explicit fit (button / F / double-click): also re-enables auto-fit. */
  function fit() {
    autoFit = true;
    fitLocked = false;
    fitPending = false;
    const target = computeFit();
    applyTarget(target, { instant: true });
    const b = contentBounds();
    lastFitDim = b ? Math.max(b.maxX - b.minX, b.maxZ - b.minZ) : 0;
    return target;
  }

  function zoomAt(px, py, factor) {
    autoFit = false;
    fitLocked = false;
    fitPending = false;
    const before = screenToWorld(px, py);
    const nextSpan = clamp(cam.span / factor, MIN_SPAN, MAX_SPAN);
    if (Math.abs(nextSpan - cam.span) < 0.0001) return nextSpan;
    cam.span = nextSpan;
    applyLayout();
    cam.cx = before.x - (px - w / 2) / cell;
    cam.cz = before.z - (py - h / 2) / cell;
    camTarget = { ...cam };
    return cam.span;
  }

  function zoomBy(factor, anchor) {
    return zoomAt(anchor ? anchor.x : w / 2, anchor ? anchor.y : h / 2, factor);
  }

  function panBy(dxPx, dyPx) {
    autoFit = false;
    fitLocked = false;
    fitPending = false;
    cam.cx -= dxPx / cell;
    cam.cz -= dyPx / cell;
    camTarget = { ...cam };
  }

  /** Debug screenshot parameters: ?zoom=2&cx=0&cz=0&fit=0 */
  function applyQuery(search) {
    const q = new URLSearchParams(search || '');
    const num = (v) => {
      if (v == null || v === '') return null;
      const n = Number.parseFloat(v);
      return Number.isFinite(n) ? n : null;
    };
    const hasZoom = q.has('zoom');
    const hasCx = q.has('cx');
    const hasCz = q.has('cz');
    const pins = hasZoom || hasCx || hasCz || q.get('fit') === '0';

    if (pins) {
      autoFit = false;
      fitLocked = true;
      fitPending = false;
    }
    const z = num(q.get('zoom'));
    if (z != null && z > 0) cam.span = clamp(BOARD_SIZE / z, MIN_SPAN, MAX_SPAN);
    const x = num(q.get('cx'));
    if (x != null) cam.cx = x + 0.5; // block-centred, i.e. cx=0 is the board centre
    const zz = num(q.get('cz'));
    if (zz != null) cam.cz = zz + 0.5;
    camTarget = { ...cam };
    snapCamera();
  }

  /** Refit while running only when it would help: content leaving the frame or
   *  growing substantially. Keeps the camera calm between those moments. */
  function autoFitWhileRunning() {
    if (!autoFit || fitLocked) return;
    const b = contentBounds();
    if (!b) return;
    const target = computeFit();
    const vis = {
      x0: camTarget.cx - camTarget.span / 2,
      x1: camTarget.cx + camTarget.span / 2,
      z0: camTarget.cz - camTarget.span / 2,
      z1: camTarget.cz + camTarget.span / 2,
    };
    const outside = b.minX < vis.x0 + 0.02 || b.maxX > vis.x1 - 0.02
      || b.minZ < vis.z0 + 0.02 || b.maxZ > vis.z1 - 0.02;
    const dim = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    const grew = dim > lastFitDim * FIT_GROW + 0.75;
    const tooSmall = b.count >= FEW_BLOCKS && target.span < camTarget.span * 0.5;

    if (outside || grew || tooSmall) {
      applyTarget(target);
      lastFitDim = dim;
    }
  }

  // ---------------------------------------------------------------- drawing

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

  function drawBackdrop() {
    ctx.fillStyle = palette.canvasBg;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = palette.canvasEdge;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  }

  function gridStepFor(cellPx) {
    if (cellPx >= 7) return 1;
    if (cellPx >= 2.5) return 5;
    if (cellPx >= 0.9) return 10;
    if (cellPx >= 0.3) return 25;
    return 100;
  }

  /** The whole visible plane, with a subtle reference frame where the board is. */
  function drawPlane() {
    const r = visibleRange();

    // board reference: faint plate + dashed outline, never a clip
    const bx = wx2px(BOARD_LO);
    const by = wz2py(BOARD_LO);
    const bs = cell * BOARD_SIZE;
    if (bx + bs > 0 && by + bs > 0 && bx < w && by < h) {
      ctx.fillStyle = 'rgba(16, 24, 33, 0.32)';
      ctx.fillRect(bx, by, bs, bs);
      ctx.save();
      ctx.strokeStyle = 'rgba(120, 160, 180, 0.24)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(Math.round(bx) + 0.5, Math.round(by) + 0.5, Math.round(bs), Math.round(bs));
      ctx.setLineDash([]);
      ctx.restore();
      if (bs > 130) {
        ctx.font = '500 9px ui-monospace, Consolas, monospace';
        ctx.fillStyle = 'rgba(124, 139, 158, 0.42)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('33 × 33 board', bx + 6, by + 6);
      }
    }

    // unbounded grid, stepping up as we zoom out
    const step = gridStepFor(cell);
    let gx0 = Math.ceil(r.x0 / step) * step;
    let gx1 = Math.floor(r.x1 / step) * step;
    let gz0 = Math.ceil(r.z0 / step) * step;
    let gz1 = Math.floor(r.z1 / step) * step;
    if ((gx1 - gx0) / step > 500) gx1 = gx0 + step * 500;
    if ((gz1 - gz0) / step > 500) gz1 = gz0 + step * 500;

    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = gx0; gx <= gx1; gx += step) {
      const x = Math.round(wx2px(gx)) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let gz = gz0; gz <= gz1; gz += step) {
      const y = Math.round(wz2py(gz)) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.strokeStyle = 'rgba(190, 215, 235, 0.05)';
    ctx.stroke();

    // stronger lines on every 5th step
    const major = step * 5;
    ctx.beginPath();
    for (let gx = Math.ceil(r.x0 / major) * major; gx <= r.x1; gx += major) {
      const x = Math.round(wx2px(gx)) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let gz = Math.ceil(r.z0 / major) * major; gz <= r.z1; gz += major) {
      const y = Math.round(wz2py(gz)) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.strokeStyle = 'rgba(190, 215, 235, 0.085)';
    ctx.stroke();

    // axes through the world origin
    ctx.strokeStyle = 'rgba(95, 232, 224, 0.16)';
    ctx.beginPath();
    if (0 >= r.x0 && 0 <= r.x1) {
      const x = Math.round(wx2px(0)) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    if (0 >= r.z0 && 0 <= r.z1) {
      const y = Math.round(wz2py(0)) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
  }

  /** The whole visible plane, with a flat reference frame where the board is. */
  function drawPlane() {
    const r = visibleRange();

    // board reference: flat tint + 1px outline, never a clip
    const bx = wx2px(BOARD_LO);
    const by = wz2py(BOARD_LO);
    const bs = cell * BOARD_SIZE;
    if (bx + bs > 0 && by + bs > 0 && bx < w && by < h) {
      ctx.fillStyle = palette.boardFill;
      ctx.fillRect(bx, by, bs, bs);
      ctx.strokeStyle = palette.boardEdge;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(bx) + 0.5, Math.round(by) + 0.5, Math.round(bs), Math.round(bs));
      if (bs > 130) {
        ctx.font = '500 9px ui-monospace, Consolas, monospace';
        ctx.fillStyle = palette.labelDim;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('33 × 33', bx + 6, by + 6);
      }
    }

    // unbounded grid, stepping up as we zoom out
    const step = gridStepFor(cell);
    let gx0 = Math.ceil(r.x0 / step) * step;
    let gx1 = Math.floor(r.x1 / step) * step;
    let gz0 = Math.ceil(r.z0 / step) * step;
    let gz1 = Math.floor(r.z1 / step) * step;
    if ((gx1 - gx0) / step > 500) gx1 = gx0 + step * 500;
    if ((gz1 - gz0) / step > 500) gz1 = gz0 + step * 500;

    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = gx0; gx <= gx1; gx += step) {
      const x = Math.round(wx2px(gx)) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let gz = gz0; gz <= gz1; gz += step) {
      const y = Math.round(wz2py(gz)) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.strokeStyle = palette.grid;
    ctx.stroke();

    // stronger lines on every 5th step
    const major = step * 5;
    ctx.beginPath();
    for (let gx = Math.ceil(r.x0 / major) * major; gx <= r.x1; gx += major) {
      const x = Math.round(wx2px(gx)) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let gz = Math.ceil(r.z0 / major) * major; gz <= r.z1; gz += major) {
      const y = Math.round(wz2py(gz)) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.strokeStyle = palette.gridMajor;
    ctx.stroke();

    // axes through the world origin
    ctx.strokeStyle = palette.axis;
    ctx.beginPath();
    if (0 >= r.x0 && 0 <= r.x1) {
      const x = Math.round(wx2px(0)) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    if (0 >= r.z0 && 0 <= r.z1) {
      const y = Math.round(wz2py(0)) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
  }

  function drawTile(wx, wz, block, popStart, now) {
    const color = blockColor(block);
    const glass = isGlass(block);

    let scale = 1;
    if (popStart != null) {
      const p = clamp((now - popStart) / POP_MS, 0, 1);
      scale = 0.4 + 0.6 * easeOutBack(p);
    }

    const cx0 = wx2px(wx + 0.5);
    const cy0 = wz2py(wz + 0.5);
    const s = cell * 0.84 * scale;
    const r = Math.max(1.5, s * 0.16);
    const x = cx0 - s / 2;
    const y = cy0 - s / 2;

    if (glass) ctx.globalAlpha = 0.5;
    ctx.fillStyle = color;
    roundRect(x, y, s, s, r);
    ctx.fill();

    // flat 1px top highlight strip (no gradients)
    if (s >= 6) {
      ctx.fillStyle = palette.tileGloss;
      ctx.fillRect(x + r, y + Math.max(1, s * 0.08), Math.max(1, s - r * 2), Math.max(1, s * 0.14));
    }

    ctx.strokeStyle = palette.tileEdge;
    ctx.lineWidth = 1;
    roundRect(x + 0.5, y + 0.5, Math.max(1, s - 1), Math.max(1, s - 1), r);
    ctx.stroke();
    if (glass) ctx.globalAlpha = 1;
  }

  function drawBlocks(now) {
    const r = visibleRange();
    const tiny = cell < 2.6;
    for (const [k, b] of blocks) {
      if (b.y !== 0) continue;
      if (b.x + 1 < r.x0 - 1 || b.x > r.x1 + 1 || b.z + 1 < r.z0 - 1 || b.z > r.z1 + 1) continue;
      if (tiny) {
        // level of detail: at zoomed-out scales a tile is a single glowing cell
        const s = Math.max(1.4, cell * 0.82);
        ctx.fillStyle = blockColor(b.block);
        ctx.fillRect(wx2px(b.x + 0.5) - s / 2, wz2py(b.z + 0.5) - s / 2, s, s);
      } else {
        drawTile(b.x, b.z, b.block, pops.get(k), now);
      }
    }
  }

  function drawParticles(now) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      const age = now - p.born;
      if (age > PARTICLE_MS) {
        particles.splice(i, 1);
        continue;
      }
      const t = age / PARTICLE_MS;
      const alpha = Math.pow(1 - t, 1.4);
      const px = wx2px(p.x) + Math.sin(p.seed * 9.1) * cell * 0.5 * t;
      const py = wz2py(p.z) + Math.cos(p.seed * 5.3) * cell * 0.5 * t - t * cell * 1.1;
      const size = Math.max(1.5, cell * 0.2 * (1 - t * 0.5));
      ctx.globalAlpha = alpha;
      ctx.fillStyle = palette.particle;
      ctx.fillRect(px - size / 2, py - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }

  function drawPen() {
    if (!hasPen) return;
    const px = wx2px(pen.x);
    const py = wz2py(pen.z);

    if (cell < 2.4) {
      // zoomed far out: a solid marker dot is more readable than an arrow
      ctx.fillStyle = palette.pen;
      ctx.beginPath();
      ctx.arc(px, py, Math.max(2.2, cell * 0.9), 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    const r = cell * 0.58;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(((pen.yaw || 0) * Math.PI) / 180);
    ctx.beginPath();
    ctx.moveTo(0, r);
    ctx.lineTo(-r * 0.78, -r * 0.82);
    ctx.lineTo(0, -r * 0.34);
    ctx.lineTo(r * 0.78, -r * 0.82);
    ctx.closePath();
    ctx.fillStyle = palette.pen;
    ctx.fill();
    ctx.strokeStyle = palette.penInk;
    ctx.lineWidth = Math.max(1, cell * 0.05);
    ctx.stroke();
    ctx.restore();
  }

  function drawCornerLabels() {
    ctx.save();
    ctx.font = '500 10px ui-monospace, Consolas, monospace';
    ctx.fillStyle = palette.label;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`已运行 ${tick}`, 10, h - 8);
    ctx.textAlign = 'right';
    ctx.fillStyle = palette.labelDim;
    ctx.fillText(`y=0 · ×${formatZoom(BOARD_SIZE / cam.span)}`, w - 10, h - 8);
    ctx.restore();
  }

  function reportCamera() {
    if (!onCamera) return;
    const zoom = BOARD_SIZE / cam.span;
    const key = `${cam.cx.toFixed(3)}|${cam.cz.toFixed(3)}|${cam.span.toFixed(3)}|${autoFit}`;
    if (key === lastReportKey) return;
    lastReportKey = key;
    onCamera({ cx: cam.cx, cz: cam.cz, span: cam.span, zoom, autoFit });
  }

  // ------------------------------------------------------------- public API

  const api = {
    reset() {
      blocks = new Map();
      pops.clear();
      particles.length = 0;
      hasPen = false;
      blockCount = 0;
      tick = 0;
      lastFitDim = 0;
      fitPending = false;
      if (!fitLocked) {
        autoFit = true;
        applyTarget(computeFit());
      }
    },

    /**
     * Replace the visible world state.
     * Returns the blocks that were added or changed (used for timeline marks).
     */
    setWorld(world, { instant = false, now = performance.now() } = {}) {
      const next = new Map();
      const entities = Array.isArray(world && world.entities) ? world.entities : [];
      for (const b of (world && world.blocks) || []) {
        if (!b || b.block === 'air' || b.block === 'minecraft:air') continue;
        next.set(key(b.x, b.y, b.z), { x: b.x, y: b.y, z: b.z, block: b.block });
      }

      const changes = [];
      for (const [k, b] of next) {
        const prev = blocks.get(k);
        if (!prev || prev.block !== b.block) {
          changes.push(b);
          if (!instant) pops.set(k, now);
        }
      }
      if (instant) pops.clear();

      blocks = next;
      blockCount = next.size;

      // the pen (turtle); a host player entity is deliberately ignored here
      const penEntity = entities.find((e) => Array.isArray(e.tags) && e.tags.includes('pen'));
      if (penEntity) {
        hasPen = true;
        pen = { x: penEntity.x, z: penEntity.z, yaw: penEntity.yaw || 0 };
      } else {
        hasPen = false;
      }

      autoFitWhileRunning();
      return changes;
    },

    applyEvents(events) {
      const now = performance.now();
      for (const ev of events || []) {
        if (ev && ev.type === 'particle') {
          particles.push({
            x: Number(ev.x) || 0,
            z: Number(ev.z) || 0,
            born: now,
            seed: Math.random(),
          });
          if (particles.length > 90) particles.splice(0, particles.length - 90);
        }
      }
    },

    setTick(n) {
      tick = n | 0;
    },

    /** Switch the flat canvas palette with the UI theme ('light' | 'dark'). */
    setTheme(name) {
      palette = CANVAS_THEMES[name === 'light' ? 'light' : 'dark'] || CANVAS_THEMES.dark;
    },

    /** Debounced re-fit; used when a run pauses/finishes or the timeline is scrubbed. */
    requestFit,

    /** Force-fit to content and turn auto-fit back on. */
    fit,

    zoomBy,

    zoomAt,

    panBy,

    applyQuery,

    isAutoFit: () => autoFit,

    getCamera: () => ({
      cx: cam.cx,
      cz: cam.cz,
      span: cam.span,
      zoom: BOARD_SIZE / cam.span,
      autoFit,
    }),

    getPen: () => ({ ...pen, visible: hasPen }),
    blockCount: () => blockCount,
    particleCount: () => particles.length,

    render(now = performance.now()) {
      const dt = lastNow ? Math.min(0.05, (now - lastNow) / 1000) : 0;
      lastNow = now;

      if (fitPending && now >= fitAt) {
        fitPending = false;
        applyTarget(computeFit(), { instant: fitInstant });
        fitInstant = false;
      }

      const k = 1 - Math.exp(-dt * CAM_EASE);
      cam.span += (camTarget.span - cam.span) * k;
      cam.cx += (camTarget.cx - cam.cx) * k;
      cam.cz += (camTarget.cz - cam.cz) * k;
      if (Math.abs(cam.span - camTarget.span) < 0.003) cam.span = camTarget.span;
      if (Math.abs(cam.cx - camTarget.cx) < 0.003) cam.cx = camTarget.cx;
      if (Math.abs(cam.cz - camTarget.cz) < 0.003) cam.cz = camTarget.cz;
      applyLayout();

      ctx.clearRect(0, 0, w, h);
      drawBackdrop();
      drawPlane();
      drawBlocks(now);
      drawParticles(now);
      drawPen(now);
      drawCornerLabels();
      reportCamera();

      for (const [k2, start] of pops) if (now - start > POP_MS + 60) pops.delete(k2);
    },
  };

  // -------------------------------------------------------- pointer controls
  const pointers = new Map();
  let drag = null; // { id, x, y }
  let pinch = null; // { dist }

  function localPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function pinchState() {
    const pts = [...pointers.values()];
    if (pts.length < 2) return null;
    const [a, b] = pts;
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
    };
  }

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = localPoint(e);
    const steps = clamp(-e.deltaY / 100, -3, 3);
    zoomAt(p.x, p.y, Math.pow(1.15, steps));
  }, { passive: false });

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.classList.add('panning');
    if (pointers.size === 1) {
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      pinch = null;
    } else if (pointers.size === 2) {
      drag = null;
      pinch = pinchState();
    }
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size >= 2) {
      const next = pinchState();
      if (next && pinch && pinch.dist > 0 && next.dist > 0) {
        const r = canvas.getBoundingClientRect();
        zoomAt(next.midX - r.left, next.midY - r.top, next.dist / pinch.dist);
      }
      pinch = next;
      return;
    }
    if (drag && e.pointerId === drag.id) {
      panBy(e.clientX - drag.x, e.clientY - drag.y);
      drag.x = e.clientX;
      drag.y = e.clientY;
    }
  });

  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (pointers.size === 0) {
      drag = null;
      pinch = null;
      canvas.classList.remove('panning');
    } else if (pointers.size === 1) {
      const [id, p] = [...pointers.entries()][0];
      drag = { id, x: p.x, y: p.y };
      pinch = null;
    }
  }

  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('dblclick', (e) => {
    e.preventDefault();
    fit();
  });

  return api;
}
