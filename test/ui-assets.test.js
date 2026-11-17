import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const read = (rel) => readFile(new URL(rel, ROOT), 'utf8');
const exists = async (rel) => {
  try { await access(new URL(rel, ROOT)); return true; } catch { return false; }
};

test('UI assets: every sprite symbol has a standalone SVG and an inline copy', async () => {
  const sprite = await read('web/icons/tickpack-icons.svg');
  const ids = [...sprite.matchAll(/<symbol id="i-([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 43, '43 symbols expected');
  assert.equal(new Set(ids).size, ids.length, 'symbol ids are unique');

  for (const id of ids) {
    assert.equal(await exists(`web/icons/${id}.svg`), true, `missing web/icons/${id}.svg`);
  }

  const html = await read('web/index.html');
  const inline = [...html.matchAll(/<symbol id="i-([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.equal(inline.length, 43, 'sprite must be inlined once (43 symbols)');
  for (const id of ids) assert.ok(inline.includes(id), `inline sprite missing ${id}`);

  const refs = [...html.matchAll(/#i-([a-z0-9-]+)/g)].map((m) => m[1]);
  for (const ref of refs) assert.ok(ids.includes(ref), `index.html references unknown icon ${ref}`);
  assert.ok(refs.length >= 30, 'expected the static UI to use icons');
});

test('UI assets: no Unicode control glyphs remain as controls', async () => {
  const glyphs = ['▶', '❚', '↺', '«', '»', '□', '⋯', '‹', '›', '⌃', '▾', '▸', '＋', '−', '✦'];
  const files = ['web/index.html', 'web/app.js', 'web/layout.js', 'web/datapack.js', 'web/world.js', 'web/timeline.js'];
  for (const file of files) {
    const text = await read(file);
    for (const glyph of glyphs) {
      assert.equal(text.includes(glyph), false, `${file} still contains control glyph ${glyph}`);
    }
  }
});
