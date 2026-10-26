// The block world: a 33x33 top-down plane with a gentle fit-to-content camera,
// beveled block tiles, placement "pop" animation and particle sparkles.
// Pure canvas 2D, no dependencies.

import { blockColor, isGlass, shade, withAlpha } from './blocks.js';
import { clamp } from './util.js';

const BOARD_LO = -16; // block coordinates: -16 .. 16 inclusive
const BOARD_HI = 17; // world-unit edge (block x occupies [x, x+1))
const BOARD_SIZE = BOARD_HI - BOARD_LO; // 33
const LIMITED_BOARD = BOARD_SIZE;
const POP_MS = 190;
const PARTICLE_MS = 760;

const FULL_CAM = { cx: 0.5, cz: 0.5, span: LIMITED_BOARD };

function easeOutBack(t) {
  const c1 = 1.28;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

export function createWorld(canvas) {
  const ctx = canvas.getContext('2d');
  const wrap = canvas.parentElement;

  let w = 0;
  let h = 0;
  let dpr = 1;
  let side = 0; // square world viewport size in px
  let cell = 12;
  let pad = 18;

  let blocks = new Map(); // key "x,y,z" -> { x, y, z, block }
  let pen = { x: 0.5, z: 0.5, yaw: 0 };
  let hasPen = false;
  let tick = 0;
  let blockCount = 0;

  const cam = { ...FULL_CAM };
  let camTarget = { ...FULL_CAM };
  let lastNow = 0;

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
    pad = Math.max(10, Math.min(26, Math.min(w, h) * 0.055));
  }

  const ro = new ResizeObserver(resize);
  ro.observe(wrap);
  resize();

  function applyLayout() {
    side = Math.min(w, h) - pad * 2;
    cell = side / cam.span;
    // screen = w/2 + (world - cam.center) * cell
  }

  const wx2px = (wx) => w / 2 + (wx - cam.cx) * cell;
  const wz2py = (wz) => h / 2 + (wz - cam.cz) * cell;

  function visibleRange() {
    return {
      x0: cam.cx - cam.span / 2,
      x1: cam.cx + cam.span / 2,
      z0: cam.cz - cam.span / 2,
      z1: cam.cz + cam.span / 2,
    };
  }

  // ------------------------------------------------------------ camera fit
  function updateCameraTarget() {
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
      minX = Math.min(minX, pen.x - 0.4);
      maxX = Math.max(maxX, pen.x + 0.4);
      minZ = Math.min(minZ, pen.z - 0.4);
      maxZ = Math.max(maxZ, pen.z + 0.4);
    }

    // Empty-ish worlds stay at the full board: the 33x33 frame is the default.
    if (count < 4) {
      camTarget = { ...FULL_CAM };
      return;
    }

    const bw = maxX - minX;
    const bh = maxZ - minZ;
    const extent = Math.max(bw, bh);

    let span = clamp(Math.max(extent + 5, 12), 12, BOARD_SIZE);
    if (extent >= 26) span = BOARD_SIZE;
    const half = span / 2;

    let cx = (minX + maxX) / 2;
    let cz = (minZ + maxZ) / 2;
    cx = clamp(cx, BOARD_LO + half, BOARD_HI - half);
    cz = clamp(cz, BOARD_LO + half, BOARD_HI - half);
    camTarget = { cx, cz, span };
  }

  function snapCamera() {
    cam.cx = camTarget.cx;
    cam.cz = camTarget.cz;
    cam.span = camTarget.span;
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
    // panel plate that always fills the canvas
    ctx.save();
    ctx.shadowColor = 'rgba(95, 232, 224, 0.18)';
    ctx.shadowBlur = 26;
    ctx.fillStyle = 'rgba(7, 11, 16, 0.72)';
    roundRect(4, 4, w - 8, h - 8, 12);
    ctx.fill();
    ctx.restore();

    const g = ctx.createLinearGradient(0, 0, w * 0.4, h);
    g.addColorStop(0, 'rgba(20, 29, 39, 0.92)');
    g.addColorStop(0.55, 'rgba(12, 18, 25, 0.95)');
    g.addColorStop(1, 'rgba(9, 13, 19, 0.97)');
    ctx.fillStyle = g;
    roundRect(4, 4, w - 8, h - 8, 12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120, 160, 180, 0.14)';
    ctx.lineWidth = 1;
    roundRect(4.5, 4.5, w - 9, h - 9, 12);
    ctx.stroke();
  }

  function drawBoard() {
    const x0 = wx2px(BOARD_LO);
    const y0 = wz2py(BOARD_LO);
    const s = cell * BOARD_SIZE;

    // board surface
    const g = ctx.createLinearGradient(x0, y0, x0 + s * 0.3, y0 + s);
    g.addColorStop(0, 'rgba(16, 24, 33, 0.9)');
    g.addColorStop(0.6, 'rgba(11, 17, 24, 0.92)');
    g.addColorStop(1, 'rgba(8, 12, 17, 0.94)');
    ctx.fillStyle = g;
    ctx.fillRect(x0, y0, s, s);

    // board border
    ctx.strokeStyle = 'rgba(120, 160, 180, 0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(s), Math.round(s));

    // grid lines, clipped to the visible slice of the board
    const r = visibleRange();
    const gx0 = Math.max(BOARD_LO, Math.floor(r.x0) - 1);
    const gx1 = Math.min(BOARD_HI, Math.ceil(r.x1) + 1);
    const gz0 = Math.max(BOARD_LO, Math.floor(r.z0) - 1);
    const gz1 = Math.min(BOARD_HI, Math.ceil(r.z1) + 1);

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(190, 215, 235, 0.05)';
    ctx.beginPath();
    for (let gx = gx0; gx <= gx1; gx++) {
      const x = Math.round(wx2px(gx)) + 0.5;
      ctx.moveTo(x, wz2py(gz0));
      ctx.lineTo(x, wz2py(gz1));
    }
    for (let gz = gz0; gz <= gz1; gz++) {
      const y = Math.round(wz2py(gz)) + 0.5;
      ctx.moveTo(wx2px(gx0), y);
      ctx.lineTo(wx2px(gx1), y);
    }
    ctx.stroke();

    // axis lines are a touch brighter
    ctx.strokeStyle = 'rgba(95, 232, 224, 0.14)';
    ctx.beginPath();
    if (0 >= gx0 && 0 <= gx1) {
      const x = Math.round(wx2px(0)) + 0.5;
      ctx.moveTo(x, wz2py(gz0));
      ctx.lineTo(x, wz2py(gz1));
    }
    if (0 >= gz0 && 0 <= gz1) {
      const y = Math.round(wz2py(0)) + 0.5;
      ctx.moveTo(wx2px(gx0), y);
      ctx.lineTo(wx2px(gx1), y);
    }
    ctx.stroke();
  }

  function drawViewfinder() {
    const br = Math.max(10, Math.min(24, cell * 1.4));
    const insetX = 10;
    const insetY = 10;
    const farX = w - 10;
    const farY = h - 10;
    ctx.strokeStyle = 'rgba(95, 232, 224, 0.32)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(insetX, insetY + br); ctx.lineTo(insetX, insetY); ctx.lineTo(insetX + br, insetY);
    ctx.moveTo(farX - br, insetY); ctx.lineTo(farX, insetY); ctx.lineTo(farX, insetY + br);
    ctx.moveTo(insetX, farY - br); ctx.lineTo(insetX, farY); ctx.lineTo(insetX + br, farY);
    ctx.moveTo(farX - br, farY); ctx.lineTo(farX, farY); ctx.lineTo(farX, farY - br);
    ctx.stroke();
  }

  function drawTile(wx, wz, block, popStart, now) {
    const name = block;
    const color = blockColor(name);
    const glass = isGlass(name);

    let scale = 1;
    if (popStart != null) {
      const p = clamp((now - popStart) / POP_MS, 0, 1);
      scale = 0.28 + 0.72 * easeOutBack(p);
    }

    const cx0 = wx2px(wx + 0.5);
    const cy0 = wz2py(wz + 0.5);
    const s = cell * 0.84 * scale;
    const r = Math.max(1.5, s * 0.2);
    const x = cx0 - s / 2;
    const y = cy0 - s / 2;

    if (glass) ctx.globalAlpha = 0.55;

    // dark base / drop shadow
    ctx.fillStyle = withAlpha(shade(color, -0.7), 0.85);
    roundRect(x + s * 0.05, y + s * 0.08, s, s, r);
    ctx.fill();

    // body gradient (light from top-left)
    const g = ctx.createLinearGradient(x, y, x + s, y + s);
    g.addColorStop(0, shade(color, 0.34));
    g.addColorStop(0.42, color);
    g.addColorStop(1, shade(color, -0.26));
    ctx.fillStyle = g;
    roundRect(x, y, s, s, r);
    ctx.fill();

    // top bevel highlight
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    roundRect(x + s * 0.13, y + s * 0.11, s * 0.74, s * 0.24, Math.max(1, r * 0.55));
    ctx.fill();

    // inner border
    ctx.strokeStyle = withAlpha(shade(color, -0.5), glass ? 0.5 : 0.85);
    ctx.lineWidth = 1;
    roundRect(x + 0.5, y + 0.5, Math.max(1, s - 1), Math.max(1, s - 1), r);
    ctx.stroke();

    if (glass) {
      ctx.strokeStyle = 'rgba(235, 250, 255, 0.65)';
      roundRect(x + 0.75, y + 0.75, Math.max(1, s - 1.5), Math.max(1, s - 1.5), r);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  function drawBlocks(now) {
    const r = visibleRange();
    for (const [k, b] of blocks) {
      if (b.y !== 0) continue;
      if (b.x + 1 < r.x0 - 1 || b.x > r.x1 + 1 || b.z + 1 < r.z0 - 1 || b.z > r.z1 + 1) continue;
      drawTile(b.x, b.z, b.block, pops.get(k), now);
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
      const alpha = Math.pow(1 - t, 1.5);
      const px = wx2px(p.x) + Math.sin(p.seed * 9.1) * cell * 0.55 * t;
      const py = wz2py(p.z) + Math.cos(p.seed * 5.3) * cell * 0.55 * t - t * cell * 1.2;
      const rad = cell * (0.12 + 0.3 * t) * (0.7 + p.seed * 0.5);

      ctx.save();
      ctx.globalAlpha = alpha;
      const g = ctx.createRadialGradient(px, py, 0, px, py, rad * 3.2);
      g.addColorStop(0, 'rgba(255, 240, 190, 0.95)');
      g.addColorStop(0.45, 'rgba(246, 211, 60, 0.55)');
      g.addColorStop(1, 'rgba(246, 211, 60, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px, py, rad * 3.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = 'rgba(255, 252, 235, 0.95)';
      ctx.lineWidth = Math.max(1, cell * 0.07);
      ctx.beginPath();
      ctx.moveTo(px - rad, py); ctx.lineTo(px + rad, py);
      ctx.moveTo(px, py - rad); ctx.lineTo(px, py + rad);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawPen(now) {
    if (!hasPen) return;
    const px = wx2px(pen.x);
    const py = wz2py(pen.z);
    const pulse = 0.5 + 0.5 * Math.sin(now / 320);

    const glowR = cell * (2.4 + pulse * 0.5);
    const g = ctx.createRadialGradient(px, py, 0, px, py, glowR);
    g.addColorStop(0, `rgba(95, 232, 224, ${0.26 + pulse * 0.08})`);
    g.addColorStop(0.55, 'rgba(95, 232, 224, 0.09)');
    g.addColorStop(1, 'rgba(95, 232, 224, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, glowR, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = `rgba(95, 232, 224, ${0.32 + pulse * 0.2})`;
    ctx.lineWidth = Math.max(1, cell * 0.08);
    ctx.beginPath();
    ctx.arc(px, py, cell * 0.64, 0, Math.PI * 2);
    ctx.stroke();

    const r = cell * 0.6;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(((pen.yaw || 0) * Math.PI) / 180);
    ctx.beginPath();
    ctx.moveTo(0, r);
    ctx.lineTo(-r * 0.78, -r * 0.82);
    ctx.lineTo(0, -r * 0.34);
    ctx.lineTo(r * 0.78, -r * 0.82);
    ctx.closePath();
    ctx.fillStyle = '#f2fbff';
    ctx.shadowColor = 'rgba(95, 232, 224, 0.9)';
    ctx.shadowBlur = cell * 0.9;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(5, 22, 28, 0.85)';
    ctx.lineWidth = Math.max(0.8, cell * 0.06);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, r * 0.9, Math.max(0.8, cell * 0.07), 0, Math.PI * 2);
    ctx.fillStyle = '#5fe8e0';
    ctx.fill();
    ctx.restore();
  }

  function drawCornerLabel() {
    ctx.save();
    ctx.font = `500 ${Math.max(9, Math.min(11, 11))}px ui-monospace, Consolas, monospace`;
    ctx.fillStyle = 'rgba(124, 139, 158, 0.75)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`elapsed ${tick}`, 13, h - 10);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(124, 139, 158, 0.4)';
    ctx.fillText(cam.span < BOARD_SIZE - 0.5 ? `y=0 · zoom ${(BOARD_SIZE / cam.span).toFixed(1)}×` : 'y=0 · 33×33', w - 13, h - 10);
    ctx.restore();
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
      camTarget = { ...FULL_CAM };
      snapCamera();
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

      const penEntity = entities.find((e) => Array.isArray(e.tags) && e.tags.includes('pen'));
      if (penEntity) {
        hasPen = true;
        pen = { x: penEntity.x, z: penEntity.z, yaw: penEntity.yaw || 0 };
      } else {
        hasPen = false;
      }

      updateCameraTarget();
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

    getPen: () => ({ ...pen, visible: hasPen }),
    blockCount: () => blockCount,
    particleCount: () => particles.length,

    render(now = performance.now()) {
      const dt = lastNow ? Math.min(0.05, (now - lastNow) / 1000) : 0;
      lastNow = now;

      // ease the camera toward the content fit
      const k = 1 - Math.exp(-dt * 6.5);
      cam.span += (camTarget.span - cam.span) * k;
      cam.cx += (camTarget.cx - cam.cx) * k;
      cam.cz += (camTarget.cz - cam.cz) * k;
      if (Math.abs(cam.span - camTarget.span) < 0.002) cam.span = camTarget.span;
      applyLayout();

      ctx.clearRect(0, 0, w, h);
      drawBackdrop();
      drawBoard();
      drawBlocks(now);
      drawParticles(now);
      drawPen(now);
      drawViewfinder();
      drawCornerLabel();

      for (const [k2, start] of pops) if (now - start > POP_MS + 60) pops.delete(k2);
    },
  };

  return api;
}
