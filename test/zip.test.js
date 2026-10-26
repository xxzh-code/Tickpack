// The downloaded datapack must be a real .zip (Minecraft loads it directly),
// so validate the bytes structurally here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packToZip, crc32 } from '../src/zip.js';
import { compile } from '../src/api.js';
import { SAMPLES } from '../src/samples.js';

const enc = new TextEncoder();

function parseZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // find EOCD from the end (no comment expected)
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, 'no end-of-central-directory record');
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  assert.equal(cdSize, eocd - cdOffset);

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(p, true), 0x02014b50, 'bad central directory signature');
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, crc, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  assert.equal(p, eocd, 'central directory size mismatch');

  for (const e of entries) {
    assert.equal(view.getUint32(e.localOffset, true), 0x04034b50, 'bad local header signature');
    const nameLen = view.getUint16(e.localOffset + 26, true);
    const extraLen = view.getUint16(e.localOffset + 28, true);
    const dataStart = e.localOffset + 30 + nameLen + extraLen;
    e.data = bytes.subarray(dataStart, dataStart + e.size);
  }
  return entries;
}

test('packToZip produces a valid store-only zip for a compiled datapack', () => {
  const out = compile(SAMPLES.find((s) => s.id === 'square').source);
  assert.equal(out.ok, true);
  const bytes = packToZip(out.files);
  assert.ok(bytes.length > 1000);
  assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);

  const entries = parseZip(bytes);
  assert.equal(entries.length, Object.keys(out.files).length);
  const names = entries.map((e) => e.name).sort();
  assert.deepEqual(names, Object.keys(out.files).sort());

  for (const entry of entries) {
    assert.equal(entry.method, 0);
    assert.equal(entry.compSize, entry.size);
    const text = new TextDecoder().decode(entry.data);
    assert.equal(text, out.files[entry.name], `content mismatch for ${entry.name}`);
    assert.equal(entry.crc, crc32(enc.encode(out.files[entry.name])), `crc mismatch for ${entry.name}`);
  }

  // Minecraft needs pack.mcmeta at the root and the function tags
  assert.ok(names.includes('pack.mcmeta'));
  assert.ok(names.includes('data/minecraft/tags/function/tick.json'));
});

test('crc32 matches known vectors', () => {
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(enc.encode('')), 0x00000000);
});

test('empty pack still produces a readable zip', () => {
  const bytes = packToZip({});
  const entries = parseZip(bytes);
  assert.equal(entries.length, 0);
  assert.equal(bytes.length, 22);
});
