// Pure orthographic 3D projection helpers for the block world.
// No DOM/canvas here; web/world.js supplies the drawing.

export const ISO_YAW = 45;
export const ISO_PITCH = 35.264;

const DEG = Math.PI / 180;

export function rad(deg) { return deg * DEG; }

/** Camera basis: right, up and depth (toward the camera). */
export function cameraBasis(yawDeg = ISO_YAW, pitchDeg = ISO_PITCH) {
  const yaw = rad(yawDeg);
  const pitch = rad(pitchDeg);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  return {
    yaw: yawDeg,
    pitch: pitchDeg,
    right: { x: cy, y: 0, z: -sy },
    up: { x: -sp * sy, y: cp, z: -sp * cy },
    depth: { x: cp * sy, y: sp, z: cp * cy },
  };
}

export function projectPoint(point, camera) {
  const basis = cameraBasis(camera.yaw, camera.pitch);
  const dx = (point.x || 0) - (camera.cx || 0);
  const dy = (point.y || 0) - (camera.cy || 0);
  const dz = (point.z || 0) - (camera.cz || 0);
  const zoom = camera.zoom || 1;
  return {
    x: (dx * basis.right.x + dy * basis.right.y + dz * basis.right.z) * zoom,
    y: -(dx * basis.up.x + dy * basis.up.y + dz * basis.up.z) * zoom,
    depth: dx * basis.depth.x + dy * basis.depth.y + dz * basis.depth.z,
  };
}

export function projectScreen(point, camera, width, height) {
  const p = projectPoint(point, camera);
  return { x: width / 2 + p.x, y: height / 2 + p.y, depth: p.depth };
}

const CUBE_FACES = [
  { normal: { x: 0, y: 1, z: 0 }, corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
  { normal: { x: 0, y: -1, z: 0 }, corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { normal: { x: 0, y: 0, z: 1 }, corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { normal: { x: 0, y: 0, z: -1 }, corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
  { normal: { x: 1, y: 0, z: 0 }, corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { normal: { x: -1, y: 0, z: 0 }, corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
];

export function visibleCubeFaces(block, camera) {
  const basis = cameraBasis(camera.yaw, camera.pitch);
  const faces = [];
  for (const face of CUBE_FACES) {
    const facing = face.normal.x * basis.depth.x
      + face.normal.y * basis.depth.y
      + face.normal.z * basis.depth.z;
    if (facing <= 0.0001) continue;
    const corners = face.corners.map(([dx, dy, dz]) => ({
      x: block.x + dx,
      y: (block.y || 0) + dy,
      z: block.z + dz,
    }));
    const center = {
      x: block.x + (face.normal.x < 0 ? 0 : face.normal.x > 0 ? 1 : 0.5),
      y: (block.y || 0) + (face.normal.y < 0 ? 0 : face.normal.y > 0 ? 1 : 0.5),
      z: block.z + (face.normal.z < 0 ? 0 : face.normal.z > 0 ? 1 : 0.5),
    };
    faces.push({
      normal: face.normal,
      corners,
      center,
      shade: faceShade(face.normal),
      depth: projectPoint(center, camera).depth,
    });
  }
  return faces;
}

export function faceShade(normal) {
  const lx = -0.42;
  const ly = 0.86;
  const lz = -0.28;
  const len = Math.hypot(lx, ly, lz) || 1;
  const dot = (normal.x * lx + normal.y * ly + normal.z * lz) / len;
  return 0.62 + 0.38 * Math.max(0, dot);
}

export function depthOfBlock(block, camera) {
  return projectPoint({
    x: block.x + 0.5,
    y: (block.y || 0) + 0.5,
    z: block.z + 0.5,
  }, camera).depth;
}

export function sortBlocksByDepth(list, camera) {
  return list
    .map((block) => ({ block, key: depthOfBlock(block, camera) }))
    .sort((a, b) => a.key - b.key)
    .map((item) => item.block);
}

export function sortFacesByDepth(faces) {
  return faces.slice().sort((a, b) => a.depth - b.depth);
}

export function boundsOfBlocks(blocks, pen = null) {
  let minX = Infinity; let minY = Infinity; let minZ = Infinity;
  let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
  for (const b of blocks || []) {
    if (!b) continue;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y || 0);
    minZ = Math.min(minZ, b.z);
    maxX = Math.max(maxX, b.x + 1);
    maxY = Math.max(maxY, (b.y || 0) + 1);
    maxZ = Math.max(maxZ, b.z + 1);
  }
  if (pen && pen.visible !== false) {
    minX = Math.min(minX, pen.x - 0.6);
    maxX = Math.max(maxX, pen.x + 0.6);
    minY = Math.min(minY, (pen.y || 0) - 0.6);
    maxY = Math.max(maxY, (pen.y || 0) + 0.8);
    minZ = Math.min(minZ, pen.z - 0.6);
    maxZ = Math.max(maxZ, pen.z + 0.6);
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

export function fitCameraToBounds(bounds, width, height, {
  yaw = ISO_YAW, pitch = ISO_PITCH, padding = 46, minZoom = 2, maxZoom = 120,
} = {}) {
  const box = bounds || { minX: -16, minY: 0, minZ: -16, maxX: 17, maxY: 1, maxZ: 17 };
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const cz = (box.minZ + box.maxZ) / 2;
  const base = { cx, cy, cz, yaw, pitch, zoom: 1 };
  const basis = cameraBasis(yaw, pitch);
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  const corners = [];
  for (const x of [box.minX, box.maxX]) for (const y of [box.minY, box.maxY]) for (const z of [box.minZ, box.maxZ]) corners.push({ x, y, z });
  for (const p of corners) {
    const dx = p.x - cx; const dy = p.y - cy; const dz = p.z - cz;
    const sx = dx * basis.right.x + dy * basis.right.y + dz * basis.right.z;
    const sy = -(dx * basis.up.x + dy * basis.up.y + dz * basis.up.z);
    minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
    minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
  }
  const availW = Math.max(32, width - padding * 2);
  const availH = Math.max(32, height - padding * 2);
  const spanX = Math.max(0.001, maxX - minX);
  const spanY = Math.max(0.001, maxY - minY);
  const zoom = Math.max(minZoom, Math.min(maxZoom, Math.min(availW / spanX, availH / spanY)));
  return { mode: '3d', cx, cy, cz, yaw, pitch, zoom };
}

export function shouldUse3D(blocks, pen) {
  for (const b of blocks || []) if (b && Math.abs(b.y || 0) > 0.001) return true;
  if (!pen || pen.visible === false) return false;
  return Math.abs(pen.y || 0) > 0.001 || Math.abs(pen.pitch || 0) > 0.01;
}

/** Auto mode is sticky: once 3D was seen, seek/replay back to flat stays 3D. */
export function nextViewMode({ forcedView = null, ever3D = false, is3D = false } = {}) {
  if (forcedView === '2d' || forcedView === '3d') {
    return { mode: forcedView, ever3D: forcedView === '3d' ? true : ever3D };
  }
  if (is3D) return { mode: '3d', ever3D: true };
  return { mode: ever3D ? '3d' : '2d', ever3D };
}

export function panCamera3D(camera, dxPx, dyPx) {
  const basis = cameraBasis(camera.yaw, camera.pitch);
  const zoom = Math.max(0.0001, camera.zoom);
  return {
    ...camera,
    cx: camera.cx - (basis.right.x * dxPx + basis.up.x * -dyPx) / zoom,
    cy: camera.cy - (basis.right.y * dxPx + basis.up.y * -dyPx) / zoom,
    cz: camera.cz - (basis.right.z * dxPx + basis.up.z * -dyPx) / zoom,
  };
}

export function zoomCamera3D(camera, px, py, factor, width, height) {
  const nextZoom = Math.max(0.05, camera.zoom * factor);
  if (Math.abs(nextZoom - camera.zoom) < 1e-6) return { ...camera };
  const basis = cameraBasis(camera.yaw, camera.pitch);
  const old = Math.max(0.0001, camera.zoom);
  const dx = px - width / 2;
  const dy = py - height / 2;
  const ratio = 1 - old / nextZoom;
  return {
    ...camera,
    cx: camera.cx + (basis.right.x * dx / old + basis.up.x * -dy / old) * ratio,
    cy: camera.cy + (basis.right.y * dx / old + basis.up.y * -dy / old) * ratio,
    cz: camera.cz + (basis.right.z * dx / old + basis.up.z * -dy / old) * ratio,
    zoom: nextZoom,
  };
}

export function formatY(value) {
  const v = Number(value) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
