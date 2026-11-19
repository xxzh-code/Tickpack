// The block world: an unbounded top-down canvas with an auto-fitting camera,
// manual pan/zoom, flat block tiles, a restrained placement "pop" and particles.
// Colours come from the active theme palette (web/theme.js) so light/dark both
// look native; there are no gradients or glows in the world rendering.
//
// Camera = { cx, cz, span }: world centre and the number of world units across
// the smaller canvas side. There is no board clamp — blocks may exist anywhere;
// the 33x33 board is only drawn as a subtle reference frame.

import { blockColor, isGlass } from './blocks.js';
import { clamp, prefersReducedMotion } from './util.js';
import { CANVAS_THEMES } from './theme.js';
import {
  ISO_YAW,
  ISO_PITCH,
  projectScreen,
  visibleCubeFaces,
  sortBlocksByDepth,
  sortFacesByDepth,
  fitCameraToBounds,
  shouldUse3D,
  nextViewMode,
  panCamera3D,
  zoomCamera3D,
  formatY,
} from './world3d.js';

const BOARD_LO = -16; // reference board: block coordinates -16 .. 16 inclusive
const BOARD_HI = 17; // world-unit edge (block x occupies [x, x+1))
const BOARD_SIZE = BOARD_HI - BOARD_LO; // 33
const DEFAULT_CAM = { cx: 0.5, cz: 0.5, span: BOARD_SIZE, cy: 0, yaw: ISO_YAW, pitch: ISO_PITCH, zoom: 18 };
const DEFAULT_3D_ZOOM = 18;

const MIN_SPAN = 4;
const MAX_SPAN = 400;
const FIT_MIN_SPAN = 12; // auto-fit never zooms in further than this
const FIT_PADDING = 1.5; // blocks of padding around the content
const FIT_GROW = 1.25; // refit while running after the content grows this much
const FEW_BLOCKS = 8; // below this a run keeps the default 33x33 framing
const POP_MS = 140;
const PARTICLE_MS = 760;
const PARTICLE_COLORS = {
  flame: '#f59e0b',
  end_rod: '#67e8f9',
  happy_villager: '#86efac',
};
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
  let dprQuery = null;
  let side = 0; // square viewport size in px
  let cell = 12;
  let pad = 18;

  let blocks = new Map(); // key "x,y,z" -> { x, y, z, block }
  let pen = { x: 0.5, y: 0, z: 0.5, yaw: 0, pitch: 0 };
  let hasPen = false;
  let hostPlayer = null;
  let tick = 0;
  let blockCount = 0;

  const cam = { ...DEFAULT_CAM, mode: '2d' };
  let camTarget = { ...DEFAULT_CAM, mode: '2d' };
  let mode = '2d';
  let forcedView = null; // ?view=2d|3d pins the renderer mode
  let ever3D = false;
  let lastMode = '2d';
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
  let reduceMotion = !!prefersReducedMotion();
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotionChange = () => {
      reduceMotion = !!motionQuery.matches;
      if (reduceMotion) {
        pops.clear();
        particles.length = 0;
        snapCamera();
      }
    };
    if (typeof motionQuery.addEventListener === 'function') motionQuery.addEventListener('change', onMotionChange);
    else if (typeof motionQuery.addListener === 'function') motionQuery.addListener(onMotionChange);
  }

  function key(x, y, z) {
    return `${x},${y},${z}`;
  }

  function resize() {
    // CSS size comes from the wrap (the canvas is styled width/height:100%);
    // backing store is CSS px * devicePixelRatio so 1 CSS px = 1 logical unit.
    const rect = wrap.getBoundingClientRect();
    w = Math.max(1, rect.width);
    h = Math.max(1, rect.height);
    dpr = Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const bw = Math.max(1, Math.round(rect.width * dpr));
    const bh = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    pad = Math.max(8, Math.min(24, Math.min(w, h) * 0.05));
    applyLayout();
    if (autoFit && !fitLocked) applyTarget(computeFit());
  }

  function watchDpr() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const ratio = window.devicePixelRatio || 1;
    try {
      dprQuery = window.matchMedia(`(resolution: ${ratio}dppx)`);
    } catch {
      dprQuery = null;
      return;
    }
    if (!dprQuery) return;
    if (typeof dprQuery.addEventListener === 'function') dprQuery.addEventListener('change', onDprChange);
    else if (typeof dprQuery.addListener === 'function') dprQuery.addListener(onDprChange);
  }

  function onDprChange() {
    if (dprQuery) {
      if (typeof dprQuery.removeEventListener === 'function') dprQuery.removeEventListener('change', onDprChange);
      else if (typeof dprQuery.removeListener === 'function') dprQuery.removeListener(onDprChange);
    }
    watchDpr();
    scheduleResize();
  }

  let resizeRaf = 0;
  function scheduleResize() {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      resize();
      // Resize + draw in the same frame: a resized backing store is never shown
      // empty while a splitter is being dragged.
      if (typeof api !== 'undefined') api.render(performance.now());
    });
  }

  const ro = new ResizeObserver(scheduleResize);
  ro.observe(wrap);
  resize();
  watchDpr();
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', scheduleResize);
  }
  // One more pass after the initial layout settles (panels are moved into the
  // active tab after this module is created).
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => scheduleResize());

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
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let count = 0;

    for (const b of blocks.values()) {
      count += 1;
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y || 0);
      minZ = Math.min(minZ, b.z);
      maxX = Math.max(maxX, b.x + 1);
      maxY = Math.max(maxY, (b.y || 0) + 1);
      maxZ = Math.max(maxZ, b.z + 1);
    }
    if (hasPen) {
      minX = Math.min(minX, pen.x - 0.5);
      maxX = Math.max(maxX, pen.x + 0.5);
      minY = Math.min(minY, (pen.y || 0) - 0.5);
      maxY = Math.max(maxY, (pen.y || 0) + 0.8);
      minZ = Math.min(minZ, pen.z - 0.5);
      maxZ = Math.max(maxZ, pen.z + 0.5);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minZ)) return null;
    return { minX, minY, minZ, maxX, maxY, maxZ, count };
  }

  function fitForBounds(b) {
    const bw = b.maxX - b.minX;
    const bh = b.maxZ - b.minZ;
    const span = clamp((Math.max(bw, bh) + FIT_PADDING * 2) * 1.25, FIT_MIN_SPAN, MAX_SPAN);
    return { cx: (b.minX + b.maxX) / 2, cz: (b.minZ + b.maxZ) / 2, span };
  }

  function fitForBounds3D(b) {
    return fitCameraToBounds(b, w, h, {
      yaw: cam.yaw,
      pitch: cam.pitch,
      padding: Math.max(34, Math.min(80, Math.min(w, h) * 0.1)),
    });
  }

  /** The camera the auto-fit wants right now (defaults to the 33x33 board). */
  function computeFit() {
    const b = contentBounds();
    if (mode === '3d') {
      const fitted = fitForBounds3D(b || {
        minX: BOARD_LO, minY: 0, minZ: BOARD_LO, maxX: BOARD_HI, maxY: 1, maxZ: BOARD_HI,
      });
      return { ...fitted, mode: '3d' };
    }
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
    if (!target) return;
    if (target.mode) mode = target.mode;
    camTarget = {
      ...camTarget,
      cx: target.cx,
      cz: target.cz,
      cy: target.cy != null ? target.cy : camTarget.cy,
      span: clamp(target.span != null ? target.span : camTarget.span, MIN_SPAN, MAX_SPAN),
      zoom: clamp(target.zoom != null ? target.zoom : camTarget.zoom, 0.05, 400),
      yaw: target.yaw != null ? target.yaw : camTarget.yaw,
      pitch: clamp(target.pitch != null ? target.pitch : camTarget.pitch, -88, 88),
    };
    if (instant || reduceMotion) snapCamera();
  }

  function snapCamera() {
    cam.cx = camTarget.cx;
    cam.cy = camTarget.cy;
    cam.cz = camTarget.cz;
    cam.span = camTarget.span;
    cam.zoom = camTarget.zoom;
    cam.yaw = camTarget.yaw;
    cam.pitch = camTarget.pitch;
    applyLayout();
  }

  function setMode(nextMode, { fitNow = true } = {}) {
    if (nextMode !== '2d' && nextMode !== '3d') return;
    if (mode === nextMode) return;
    mode = nextMode;
    camTarget.mode = mode;
    if (fitNow) {
      const target = computeFit();
      if (mode === '3d') {
        camTarget.yaw = target.yaw;
        camTarget.pitch = target.pitch;
      }
      applyTarget(target, { instant: true });
    }
  }

  function updateViewMode() {
    if (forcedView) {
      const next = nextViewMode({ forcedView, ever3D, is3D: false });
      ever3D = next.ever3D;
      setMode(next.mode);
      return;
    }
    const is3D = shouldUse3D(blocks.values(), hasPen ? { ...pen, visible: true } : null);
    const next = nextViewMode({ ever3D, is3D });
    ever3D = next.ever3D;
    setMode(next.mode);
  }

  /** Called by the app when the run starts/pauses/finishes; debounced so a
   *  click/drag does not make the camera chase every intermediate frame.
   *  `instant` is used when the timeline is not playing (pause / finish / scrub):
   *  the final framing is guaranteed before the next paint instead of easing in
   *  over several frames (also keeps headless screenshots deterministic). */
  function requestFit(delay = 160, instant = false) {
    if (!autoFit || fitLocked) return;
    fitPending = true;
    fitAt = performance.now() + (reduceMotion ? 0 : Math.max(0, delay));
    fitInstant = !!instant || reduceMotion;
  }

  /** Explicit fit (button / F / double-click): also re-enables auto-fit. */
  function fit() {
    autoFit = true;
    fitLocked = false;
    fitPending = false;
    if (forcedView) mode = forcedView;
    const target = computeFit();
    applyTarget(target, { instant: true });
    const b = contentBounds();
    lastFitDim = b
      ? (mode === '3d'
        ? Math.max(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ)
        : Math.max(b.maxX - b.minX, b.maxZ - b.minZ))
      : 0;
    return target;
  }

  function zoomAt(px, py, factor) {
    autoFit = false;
    fitLocked = false;
    fitPending = false;
    if (mode === '3d') {
      const next = zoomCamera3D(cam, px, py, factor, w, h);
      if (Math.abs(next.zoom - cam.zoom) < 0.0001) return next.zoom;
      cam.cx = next.cx; cam.cy = next.cy; cam.cz = next.cz; cam.zoom = next.zoom;
      camTarget = { ...cam, mode };
      applyLayout();
      return cam.zoom;
    }
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
    if (mode === '3d') {
      const next = panCamera3D(cam, dxPx, dyPx);
      cam.cx = next.cx; cam.cy = next.cy; cam.cz = next.cz;
    } else {
      cam.cx -= dxPx / cell;
      cam.cz -= dyPx / cell;
    }
    camTarget = { ...cam, mode };
  }

  /** Debug screenshot parameters: ?view=3d&zoom=2&cx=0&cz=0&fit=0&yaw=45&pitch=35 */
  function applyQuery(search) {
    const q = new URLSearchParams(search || '');
    const num = (v) => {
      if (v == null || v === '') return null;
      const n = Number.parseFloat(v);
      return Number.isFinite(n) ? n : null;
    };
    const view = q.get('view');
    if (view === '3d' || view === '3') { forcedView = '3d'; ever3D = true; }
    else if (view === '2d' || view === '2') { forcedView = '2d'; ever3D = false; }
    if (forcedView) {
      mode = forcedView;
      cam.mode = mode;
      camTarget.mode = mode;
    }
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
    if (z != null && z > 0) {
      if (mode === '3d') cam.zoom = clamp(z * 18, 0.05, 400);
      else cam.span = clamp(BOARD_SIZE / z, MIN_SPAN, MAX_SPAN);
    }
    const x = num(q.get('cx'));
    if (x != null) cam.cx = x + 0.5;
    const y = num(q.get('cy'));
    if (y != null) cam.cy = y;
    const zz = num(q.get('cz'));
    if (zz != null) cam.cz = zz + 0.5;
    const yaw = num(q.get('yaw'));
    if (yaw != null) cam.yaw = yaw;
    const pitch = num(q.get('pitch'));
    if (pitch != null) cam.pitch = clamp(pitch, -88, 88);
    camTarget = { ...cam, mode };
    snapCamera();
    if (forcedView === '3d' && !pins) {
      autoFit = true;
      fitLocked = false;
      applyTarget(computeFit(), { instant: true });
    }
  }

  /** Refit while running only when it would help: content leaving the frame or
   *  growing substantially. Keeps the camera calm between those moments. */
  function autoFitWhileRunning() {
    if (!autoFit || fitLocked) return;
    const b = contentBounds();
    if (!b) return;
    const target = computeFit();
    if (mode === '3d') {
      const centerDist = Math.hypot(target.cx - camTarget.cx, target.cy - camTarget.cy, target.cz - camTarget.cz);
      const dim = Math.max(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ);
      const grew = dim > lastFitDim * FIT_GROW + 0.75;
      const zoomRatio = target.zoom / camTarget.zoom;
      if (centerDist > 0.75 || grew || zoomRatio < 0.82 || zoomRatio > 1.5) {
        applyTarget({ ...target, mode: '3d' });
        lastFitDim = dim;
      }
      return;
    }
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

  function shadeColor(hex, shade) {
    if (typeof hex !== 'string' || hex[0] !== '#' || (hex.length !== 7 && hex.length !== 4)) return hex;
    const full = hex.length === 4
      ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
      : hex;
    const n = Number.parseInt(full.slice(1), 16);
    const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) * shade)));
    const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) * shade)));
    const b = Math.max(0, Math.min(255, Math.round((n & 255) * shade)));
    return `rgb(${r}, ${g}, ${b})`;
  }

  function drawPolygon(points, fill, stroke, alpha = 1) {
    if (!points.length) return;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
    ctx.globalAlpha = 1;
  }

  function to3d(x, y, z) {
    return projectScreen({ x, y, z }, cam, w, h);
  }

  function drawPlane3D() {
    const y = 0;
    const corners = [
      to3d(BOARD_LO, y, BOARD_LO), to3d(BOARD_HI, y, BOARD_LO),
      to3d(BOARD_HI, y, BOARD_HI), to3d(BOARD_LO, y, BOARD_HI),
    ];
    drawPolygon(corners, palette.boardFill, palette.boardEdge, 0.9);
    const zoom = cam.zoom;
    const step = zoom >= 8 ? 1 : zoom >= 3 ? 5 : zoom >= 1 ? 10 : 25;
    ctx.strokeStyle = palette.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let g = BOARD_LO; g <= BOARD_HI; g += step) {
      const a = to3d(g, y, BOARD_LO);
      const b = to3d(g, y, BOARD_HI);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      const c = to3d(BOARD_LO, y, g);
      const d = to3d(BOARD_HI, y, g);
      ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y);
    }
    ctx.stroke();
    ctx.strokeStyle = palette.gridMajor;
    ctx.beginPath();
    for (let g = BOARD_LO; g <= BOARD_HI; g += step * 5) {
      const a = to3d(g, y, BOARD_LO);
      const b = to3d(g, y, BOARD_HI);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      const c = to3d(BOARD_LO, y, g);
      const d = to3d(BOARD_HI, y, g);
      ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y);
    }
    ctx.stroke();
    ctx.strokeStyle = palette.axis;
    const ax0 = to3d(0, y, BOARD_LO); const ax1 = to3d(0, y, BOARD_HI);
    const az0 = to3d(BOARD_LO, y, 0); const az1 = to3d(BOARD_HI, y, 0);
    ctx.beginPath();
    ctx.moveTo(ax0.x, ax0.y); ctx.lineTo(ax1.x, ax1.y);
    ctx.moveTo(az0.x, az0.y); ctx.lineTo(az1.x, az1.y);
    ctx.stroke();
    if (zoom > 5) {
      const label = to3d(BOARD_LO, y, BOARD_LO);
      ctx.font = '500 9px ui-monospace, Consolas, monospace';
      ctx.fillStyle = palette.labelDim;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('33 × 33 · 3D', label.x + 6, label.y + 6);
    }
  }

  function drawBlocks3D() {
    const list = sortBlocksByDepth([...blocks.values()], cam);
    for (const b of list) {
      const faces = sortFacesByDepth(visibleCubeFaces(b, cam));
      const color = blockColor(b.block);
      const glass = isGlass(b.block);
      for (const face of faces) {
        const pts = face.corners.map((p) => to3d(p.x, p.y, p.z));
        drawPolygon(pts, shadeColor(color, face.shade), palette.tileEdge, glass ? 0.48 : 1);
      }
    }
  }

  function drawParticles3D(now) {
    if (reduceMotion) { particles.length = 0; return; }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      const age = now - p.born;
      if (age > PARTICLE_MS) { particles.splice(i, 1); continue; }
      const t = age / PARTICLE_MS;
      const alpha = Math.pow(1 - t, 1.4);
      const proj = to3d(p.x, (p.y || 0) + t * 1.2, p.z);
      const size = Math.max(1.5, cam.zoom * 0.17 * (1 - t * 0.5));
      ctx.globalAlpha = alpha;
      ctx.fillStyle = PARTICLE_COLORS[p.particle] || palette.particle;
      ctx.fillRect(proj.x - size / 2, proj.y - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }

  function drawPen3D() {
    if (!hasPen) return;
    const zBase = to3d(pen.x, pen.y || 0, pen.z);
    const zTop = to3d(pen.x, (pen.y || 0) + 0.9, pen.z);
    if (cam.zoom < 2.4) {
      ctx.fillStyle = palette.pen;
      ctx.beginPath();
      ctx.arc(zTop.x, zTop.y, Math.max(2.2, cam.zoom * 0.9), 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.strokeStyle = palette.penInk;
    ctx.lineWidth = Math.max(1, cam.zoom * 0.06);
    ctx.beginPath();
    ctx.moveTo(zBase.x, zBase.y);
    ctx.lineTo(zTop.x, zTop.y);
    ctx.stroke();
    const yaw = ((pen.yaw || 0) * Math.PI) / 180;
    const pitch = ((pen.pitch || 0) * Math.PI) / 180;
    const fwd = to3d(
      pen.x + Math.sin(yaw),
      (pen.y || 0) + 0.9 - Math.sin(pitch),
      pen.z + Math.cos(yaw),
    );
    let dx = fwd.x - zTop.x;
    let dy = fwd.y - zTop.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const r = Math.max(3, cam.zoom * 0.58);
    ctx.beginPath();
    ctx.moveTo(zTop.x + dx * r, zTop.y + dy * r);
    ctx.lineTo(zTop.x - dx * r * 0.55 - dy * r * 0.7, zTop.y - dy * r * 0.55 + dx * r * 0.7);
    ctx.lineTo(zTop.x - dx * r * 0.55 + dy * r * 0.7, zTop.y - dy * r * 0.55 - dx * r * 0.7);
    ctx.closePath();
    ctx.fillStyle = palette.pen;
    ctx.fill();
    ctx.strokeStyle = palette.penInk;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawTile(wx, wz, block, popStart, now) {
    const color = blockColor(block);
    const glass = isGlass(block);

    let scale = 1;
    if (!reduceMotion && popStart != null) {
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
    if (reduceMotion) {
      particles.length = 0;
      return;
    }
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
      ctx.fillStyle = PARTICLE_COLORS[p.particle] || palette.particle;
      ctx.fillRect(px - size / 2, py - size / 2, size, size);
    }
    ctx.globalAlpha = 1;

    // P1.5 wave intent: when particles are emitted at the host player, draw a
    // subtle pulse ring so the intent is visible even if the player has no body.
    if (hostPlayer && particles.some((p) => Math.hypot(p.x - hostPlayer.x, p.z - hostPlayer.z) < 2)) {
      const px = wx2px(hostPlayer.x);
      const py = wz2py(hostPlayer.z);
      const pulse = 0.5 + 0.5 * Math.sin(now / 140);
      ctx.save();
      ctx.strokeStyle = palette.particle;
      ctx.globalAlpha = 0.28 + pulse * 0.28;
      ctx.lineWidth = Math.max(1, cell * 0.08);
      ctx.beginPath();
      ctx.arc(px, py, Math.max(4, cell * (1.1 + pulse * 0.16)), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
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
    const y = mode === '3d' ? (hasPen ? pen.y : cam.cy) : (hasPen ? pen.y : 0);
    const zoom = mode === '3d' ? cam.zoom / DEFAULT_3D_ZOOM : BOARD_SIZE / cam.span;
    ctx.fillText(`y=${formatY(y)} · ×${formatZoom(zoom)}`, w - 10, h - 8);
    ctx.restore();
  }

  function reportCamera() {
    if (!onCamera) return;
    const zoom = mode === '3d' ? cam.zoom / DEFAULT_3D_ZOOM : BOARD_SIZE / cam.span;
    const y = mode === '3d' ? (hasPen ? pen.y : cam.cy) : (hasPen ? pen.y : 0);
    const key = `${mode}|${cam.cx.toFixed(3)}|${cam.cy.toFixed(3)}|${cam.cz.toFixed(3)}|${cam.span.toFixed(3)}|${cam.zoom.toFixed(3)}|${cam.yaw.toFixed(2)}|${cam.pitch.toFixed(2)}|${hasPen ? pen.y.toFixed(2) : ''}|${autoFit}`;
    if (key === lastReportKey) return;
    lastReportKey = key;
    onCamera({
      mode, cx: cam.cx, cy: cam.cy, cz: cam.cz, span: cam.span, zoom,
      yaw: cam.yaw, pitch: cam.pitch, y, autoFit,
    });
  }

  // ------------------------------------------------------------- public API

  const api = {
    reset() {
      blocks = new Map();
      pops.clear();
      particles.length = 0;
      hasPen = false;
      hostPlayer = null;
      blockCount = 0;
      tick = 0;
      lastFitDim = 0;
      fitPending = false;
      if (!forcedView) {
        ever3D = false;
        mode = '2d';
        cam.mode = '2d';
        camTarget.mode = '2d';
      }
      if (!fitLocked) {
        autoFit = true;
        applyTarget(computeFit(), { instant: true });
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
        const y = Number.isFinite(b.y) ? b.y : 0;
        next.set(key(b.x, y, b.z), { x: b.x, y, z: b.z, block: b.block });
      }

      const changes = [];
      for (const [k, b] of next) {
        const prev = blocks.get(k);
        if (!prev || prev.block !== b.block) {
          changes.push(b);
          if (!instant && !reduceMotion) pops.set(k, now);
        }
      }
      if (instant || reduceMotion) pops.clear();

      blocks = next;
      blockCount = next.size;

      // the pen (turtle); a host player entity is deliberately ignored for layout
      const penEntity = entities.find((e) => Array.isArray(e.tags) && e.tags.includes('pen'));
      const playerEntity = entities.find((e) => e && e.type === 'player');
      hostPlayer = playerEntity
        ? { x: Number(playerEntity.x) || 0, z: Number(playerEntity.z) || 0 }
        : null;
      if (penEntity) {
        hasPen = true;
        pen = {
          x: penEntity.x,
          y: penEntity.y || 0,
          z: penEntity.z,
          yaw: penEntity.yaw || 0,
          pitch: penEntity.pitch || 0,
        };
      } else {
        hasPen = false;
      }

      updateViewMode();
      autoFitWhileRunning();
      return changes;
    },

    applyEvents(events) {
      if (reduceMotion) return;
      const now = performance.now();
      for (const ev of events || []) {
        if (ev && ev.type === 'particle') {
          particles.push({
            x: Number(ev.x) || 0,
            y: Number(ev.y) || 0,
            z: Number(ev.z) || 0,
            particle: String(ev.particle || ev.name || '').replace(/^minecraft:/, ''),
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
      mode,
      cx: cam.cx,
      cy: cam.cy,
      cz: cam.cz,
      span: cam.span,
      zoom: mode === '3d' ? cam.zoom / DEFAULT_3D_ZOOM : BOARD_SIZE / cam.span,
      yaw: cam.yaw,
      pitch: cam.pitch,
      y: mode === '3d' ? (hasPen ? pen.y : cam.cy) : (hasPen ? pen.y : 0),
      autoFit,
    }),

    getPen: () => ({ ...pen, visible: hasPen }),
    blockCount: () => blockCount,
    particleCount: () => particles.length,

    /** True while a render would visibly advance (camera ease, fit, pop, fx). */
    needsFrame() {
      if (fitPending) return true;
      if (pops.size || particles.length) return true;
      if (camTarget.mode && camTarget.mode !== mode) return true;
      return Math.abs(cam.span - camTarget.span) > 0.003
        || Math.abs(cam.cx - camTarget.cx) > 0.003
        || Math.abs(cam.cy - camTarget.cy) > 0.003
        || Math.abs(cam.cz - camTarget.cz) > 0.003
        || Math.abs(cam.zoom - camTarget.zoom) > 0.003
        || Math.abs(cam.yaw - camTarget.yaw) > 0.01
        || Math.abs(cam.pitch - camTarget.pitch) > 0.01;
    },

    render(now = performance.now()) {
      const dt = lastNow ? Math.min(0.05, (now - lastNow) / 1000) : 0;
      lastNow = now;

      if (fitPending && now >= fitAt) {
        fitPending = false;
        applyTarget(computeFit(), { instant: fitInstant });
        fitInstant = false;
      }

      const k = 1 - Math.exp(-dt * CAM_EASE);
      if (reduceMotion) {
        cam.span = camTarget.span;
        cam.cx = camTarget.cx;
        cam.cy = camTarget.cy;
        cam.cz = camTarget.cz;
        cam.zoom = camTarget.zoom;
        cam.yaw = camTarget.yaw;
        cam.pitch = camTarget.pitch;
      } else {
        cam.span += (camTarget.span - cam.span) * k;
        cam.cx += (camTarget.cx - cam.cx) * k;
        cam.cy += (camTarget.cy - cam.cy) * k;
        cam.cz += (camTarget.cz - cam.cz) * k;
        cam.zoom += (camTarget.zoom - cam.zoom) * k;
        cam.yaw += (camTarget.yaw - cam.yaw) * k;
        cam.pitch += (camTarget.pitch - cam.pitch) * k;
        if (Math.abs(cam.span - camTarget.span) < 0.003) cam.span = camTarget.span;
        if (Math.abs(cam.cx - camTarget.cx) < 0.003) cam.cx = camTarget.cx;
        if (Math.abs(cam.cy - camTarget.cy) < 0.003) cam.cy = camTarget.cy;
        if (Math.abs(cam.cz - camTarget.cz) < 0.003) cam.cz = camTarget.cz;
        if (Math.abs(cam.zoom - camTarget.zoom) < 0.003) cam.zoom = camTarget.zoom;
        if (Math.abs(cam.yaw - camTarget.yaw) < 0.01) cam.yaw = camTarget.yaw;
        if (Math.abs(cam.pitch - camTarget.pitch) < 0.01) cam.pitch = camTarget.pitch;
      }
      applyLayout();

      ctx.clearRect(0, 0, w, h);
      drawBackdrop();
      if (mode === '3d') {
        drawPlane3D();
        drawBlocks3D();
        drawParticles3D(now);
        drawPen3D();
      } else {
        drawPlane();
        drawBlocks(now);
        drawParticles(now);
        drawPen();
      }
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
