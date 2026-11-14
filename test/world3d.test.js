// Pure orthographic 3D projection tests for web/world3d.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ISO_YAW,
  ISO_PITCH,
  cameraBasis,
  projectPoint,
  projectScreen,
  visibleCubeFaces,
  sortBlocksByDepth,
  boundsOfBlocks,
  fitCameraToBounds,
  shouldUse3D,
  faceShade,
  nextViewMode,
  panCamera3D,
  zoomCamera3D,
} from '../web/world3d.js';

test('camera basis is orthonormal and looks down at the origin', () => {
  const b = cameraBasis(ISO_YAW, ISO_PITCH);
  const dot = (a, c) => a.x * c.x + a.y * c.y + a.z * c.z;
  assert.ok(Math.abs(dot(b.right, b.right) - 1) < 1e-9);
  assert.ok(Math.abs(dot(b.up, b.up) - 1) < 1e-9);
  assert.ok(Math.abs(dot(b.depth, b.depth) - 1) < 1e-9);
  assert.ok(Math.abs(dot(b.right, b.up)) < 1e-9);
  assert.ok(Math.abs(dot(b.right, b.depth)) < 1e-9);
  assert.ok(b.depth.y > 0);
});

test('orthographic projection puts the target at screen centre and y up', () => {
  const cam = { cx: 0, cy: 0, cz: 0, yaw: ISO_YAW, pitch: ISO_PITCH, zoom: 20 };
  assert.deepEqual(projectPoint({ x: 0, y: 0, z: 0 }, cam), { x: 0, y: -0, depth: 0 });
  const up = projectPoint({ x: 0, y: 2, z: 0 }, cam);
  assert.ok(up.y < 0, 'higher y must project upwards (negative canvas y)');
  const screen = projectScreen({ x: 0, y: 0, z: 0 }, cam, 800, 600);
  assert.equal(screen.x, 400);
  assert.equal(screen.y, 300);
});

test('visible cube faces cull back faces and keep top/side faces', () => {
  const cam = { cx: 0, cy: 0, cz: 0, yaw: ISO_YAW, pitch: ISO_PITCH, zoom: 20 };
  const faces = visibleCubeFaces({ x: 0, y: 0, z: 0 }, cam);
  assert.ok(faces.length >= 3);
  assert.ok(faces.some((f) => f.normal.y === 1));
  assert.ok(faces.some((f) => f.normal.y === -1) === false);
  assert.ok(faces.every((f) => f.corners.length === 4));
  assert.ok(faceShade({ x: 0, y: 1, z: 0 }) > faceShade({ x: 0, y: -1, z: 0 }));
});

test('cube depth sort is far-to-near along the camera direction', () => {
  const cam = { cx: 0, cy: 0, cz: 0, yaw: ISO_YAW, pitch: ISO_PITCH, zoom: 20 };
  const blocks = [
    { x: 3, y: 0, z: 3 },
    { x: -3, y: 0, z: -3 },
    { x: 0, y: 2, z: 0 },
  ];
  const sorted = sortBlocksByDepth(blocks, cam);
  assert.notEqual(sorted[0], blocks[0]);
  // The near block (towards +x/+y/+z for this yaw/pitch) comes last.
  assert.equal(sorted[sorted.length - 1].x, 3);
});

test('3D fit frames every projected bound corner inside the canvas', () => {
  const bounds = { minX: -4, minY: -2, minZ: -3, maxX: 5, maxY: 9, maxZ: 4 };
  const cam = fitCameraToBounds(bounds, 800, 500, { padding: 40 });
  assert.equal(cam.mode, '3d');
  assert.ok(cam.zoom > 0);
  for (const x of [bounds.minX, bounds.maxX]) {
    for (const y of [bounds.minY, bounds.maxY]) {
      for (const z of [bounds.minZ, bounds.maxZ]) {
        const p = projectScreen({ x, y, z }, cam, 800, 500);
        assert.ok(p.x >= 39 && p.x <= 761, `x inside: ${p.x}`);
        assert.ok(p.y >= 39 && p.y <= 461, `y inside: ${p.y}`);
      }
    }
  }
});

test('3D auto-switch detects y or pitch while flat y=0 stays 2D', () => {
  assert.equal(shouldUse3D([{ x: 0, y: 0, z: 0 }], { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }), false);
  assert.equal(shouldUse3D([{ x: 0, y: 1, z: 0 }], null), true);
  assert.equal(shouldUse3D([], { x: 0, y: 0, z: 0, yaw: 0, pitch: 35, visible: true }), true);
  const b = boundsOfBlocks([{ x: 1, y: 2, z: 3 }], { x: 0.5, y: 4, z: 0.5, visible: true });
  assert.equal(b.minY, 2);
  assert.ok(b.maxY >= 4.8);
});

test('auto 3D mode is sticky through a seek back to flat tick 0', () => {
  const seen = nextViewMode({ ever3D: false, is3D: true });
  assert.deepEqual(seen, { mode: '3d', ever3D: true });
  const seekBack = nextViewMode({ ever3D: seen.ever3D, is3D: false });
  assert.deepEqual(seekBack, { mode: '3d', ever3D: true });
  assert.deepEqual(nextViewMode({ forcedView: '2d', ever3D: true, is3D: true }), { mode: '2d', ever3D: true });
  assert.deepEqual(nextViewMode({ ever3D: false, is3D: false }), { mode: '2d', ever3D: false });
});

test('3D pan translates the projected scene by the drag delta', () => {
  const cam = { cx: 0, cy: 0, cz: 0, yaw: ISO_YAW, pitch: ISO_PITCH, zoom: 20 };
  const p = { x: 1, y: 2, z: -1 };
  const before = projectScreen(p, cam, 800, 600);
  const moved = panCamera3D(cam, 30, -12);
  const after = projectScreen(p, moved, 800, 600);
  assert.ok(Math.abs(after.x - (before.x + 30)) < 1e-6);
  assert.ok(Math.abs(after.y - (before.y - 12)) < 1e-6);
});

test('3D zoom keeps the world point under the pointer stationary', () => {
  const cam = { cx: 0, cy: 0, cz: 0, yaw: ISO_YAW, pitch: ISO_PITCH, zoom: 20 };
  const basis = cameraBasis(ISO_YAW, ISO_PITCH);
  const px = 610; const py = 180;
  const anchor = {
    x: cam.cx + (basis.right.x * (px - 400) + basis.up.x * -(py - 300)) / cam.zoom,
    y: cam.cy + (basis.right.y * (px - 400) + basis.up.y * -(py - 300)) / cam.zoom,
    z: cam.cz + (basis.right.z * (px - 400) + basis.up.z * -(py - 300)) / cam.zoom,
  };
  const before = projectScreen(anchor, cam, 800, 600);
  const zoomed = zoomCamera3D(cam, px, py, 1.8, 800, 600);
  const after = projectScreen(anchor, zoomed, 800, 600);
  assert.ok(Math.abs(after.x - before.x) < 1e-6);
  assert.ok(Math.abs(after.y - before.y) < 1e-6);
  assert.ok(Math.abs(zoomed.zoom - 36) < 1e-6);
});
