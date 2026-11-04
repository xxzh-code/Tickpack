// Tests for the single-file HTML build (scripts/build-html.mjs).
//
// Runs the builder in-process (no child processes: the sandbox blocks spawn),
// then checks that dist/tickpack.html is genuinely self-contained:
//  - one inline classic script carrying the whole module graph, no module imports
//  - styles inlined, local images/fonts embedded as data: URLs
//  - no /web/ or /logo/ absolute refs and no external http(s) resources
//  - the bundled script parses as classic JavaScript without executing DOM code
//
// Run with: node test/build.test.js   (also importable by a test runner)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildSingleFileHtml,
  bundleEntryScript,
  findExternalUrls,
  BuildError,
  DEFAULT_OUT_FILE,
} from '../scripts/build-html.mjs';

const OUT_FILE = fileURLToPath(new URL(`../${DEFAULT_OUT_FILE}`, import.meta.url));
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function attrValue(attributes, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(attributes);
  return m ? m[2] : null;
}

/** All <script> elements: { attributes, code, hasSrc, isModule, isJs }. */
function extractScripts(html) {
  const scripts = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attributes = m[1];
    const type = attrValue(attributes, 'type');
    scripts.push({
      attributes,
      code: m[2],
      hasSrc: attrValue(attributes, 'src') !== null,
      isModule: type !== null && /\bmodule\b/i.test(type),
      isJs: type === null || /\b(?:javascript|module|ecmascript)\b/i.test(type),
    });
  }
  return scripts;
}

/** Asset URLs that would cause a network/file request (excluding data: URIs). */
function externalAssetUrls(html) {
  const found = [];
  const attrRe = /(\b(?:src|href|poster|srcset)\s*=\s*)(["'])([\s\S]*?)\2/gi;
  let m;
  while ((m = attrRe.exec(html))) {
    if (/^(?:https?:)?\/\//i.test(m[3].trim())) found.push(m[3].trim());
  }
  const urlRe = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
  while ((m = urlRe.exec(html))) {
    if (/^(?:https?:)?\/\//i.test(m[2].trim())) found.push(m[2].trim());
  }
  return found;
}

// ---------------------------------------------------------------------------

test('produces dist/tickpack.html as one self-contained single file', () => {
  const started = performance.now();
  const report = buildSingleFileHtml();
  const elapsed = performance.now() - started;

  // --- build report / timing -------------------------------------------------
  assert.ok(elapsed < 1000, `build must stay fast, took ${elapsed.toFixed(0)} ms`);
  assert.ok(report.elapsedMs < 1000, `builder-reported ${report.elapsedMs.toFixed(0)} ms`);
  assert.equal(report.outFile, OUT_FILE);
  assert.equal(report.entry, 'web/boot.js');
  assert.ok(report.modules >= 20, `expected the whole module graph, got ${report.modules} modules`);
  assert.ok(report.moduleIds.includes('web/boot.js'));
  assert.ok(report.moduleIds.includes('web/app.js'));
  assert.ok(report.moduleIds.includes('src/api.js'));
  assert.ok(report.moduleIds.includes('src/sim/sim.js'));
  assert.ok(report.stylesheets.includes('web/style.css'));
  assert.ok(report.assets.length >= 2, 'favicon + brand logo should be embedded');

  // --- file exists / size sane ----------------------------------------------
  assert.ok(existsSync(report.outFile), `missing ${report.outFile}`);
  const bytes = statSync(report.outFile).size;
  assert.equal(bytes, report.bytes);
  assert.ok(bytes > 200 * 1024, `single-file build looks too small (${bytes} bytes)`);
  assert.ok(bytes < 8 * 1024 * 1024, `single-file build looks too large (${bytes} bytes)`);

  const html = readFileSync(report.outFile, 'utf8');
  assert.match(html, /^<!DOCTYPE html>/i);
  assert.match(html, /<html lang="zh-CN"/);
  assert.match(html, /<title>Tickpack[^<]*循环就是时钟<\/title>/);
  assert.match(html, /循环就是时钟/); // tagline survives

  // --- styles inlined --------------------------------------------------------
  assert.match(html, /<style>[\s\S]*\.topbar[\s\S]*<\/style>/);
  assert.ok(!/<link\b[^>]*\brel\s*=\s*["']?stylesheet/i.test(html), 'stylesheet <link> must be inlined');

  // --- scripts: one big inline classic script, no external/module script ----
  assert.ok(!/<script\b[^>]*\bsrc\s*=/i.test(html), 'no external <script src=…> may remain');
  assert.ok(!/<script\b[^>]*\btype\s*=\s*["']module/i.test(html), 'no <script type="module"> may remain');

  const scripts = extractScripts(html);
  const jsScripts = scripts.filter((script) => script.isJs && !script.hasSrc);
  assert.ok(jsScripts.length >= 2, 'expected the prepaint theme script + the bundled app script');
  for (const script of jsScripts) {
    assert.doesNotThrow(
      () => new Function(script.code),
      'every inline script must parse as classic JavaScript (no import/export/import.meta/top-level await)',
    );
  }
  const bundle = jsScripts.reduce((biggest, script) =>
    script.code.length > biggest.code.length ? script : biggest,
  );
  assert.ok(bundle.code.length > 200 * 1024, `bundled script looks too small (${bundle.code.length} bytes)`);
  assert.match(bundle.code, /Tickpack single-file bundle/);
  assert.match(bundle.code, /__tpb_require\("web\/boot\.js"\)/);

  // --- local assets embedded as data: URLs ----------------------------------
  assert.match(html, /href="data:image\/svg\+xml;base64,/, 'favicon must be a data: URL');
  const brand = /<img\b([^>]*\bclass\s*=\s*["'][^"']*brand-logo[^"']*["'][^>]*)>/i.exec(html);
  assert.ok(brand, 'brand logo <img> must survive');
  assert.match(attrValue(brand[1], 'src') || '', /^data:image\/svg\+xml;base64,/);
  assert.ok(!/onerror\s*=\s*["'][^"']*\/logo\//i.test(html), 'local logo fallback must be dropped');

  // layout.js sets a logo via JS at runtime -> its string is a data: URL too
  assert.ok(
    /img\.src\s*=\s*["']data:image\/svg\+xml;base64,/.test(bundle.code),
    'runtime JS asset string (/logo/logo-middle.svg) must be embedded',
  );

  // --- no absolute site refs, no relative module specifiers -----------------
  assert.ok(!/\/web\//.test(html), 'output must not reference /web/');
  assert.ok(!/\/logo\//.test(html), 'output must not reference /logo/');
  assert.ok(!/\bfrom\s*["']\.{0,2}\//.test(html), 'no relative `import … from "./…"` may remain');
  assert.ok(!/\bimport\s*\(\s*["']\.{0,2}\//.test(html), 'no relative dynamic import may remain');
  assert.ok(!/\bimport\.meta\b/.test(html), 'no import.meta may remain');

  // --- no external resources -------------------------------------------------
  assert.deepEqual(externalAssetUrls(html), []);
  const externalUrls = findExternalUrls(html).filter((url) => url !== SVG_NAMESPACE);
  assert.deepEqual(externalUrls, [], 'no external http(s) URLs may remain (except SVG xmlns)');

  // --- the app boot is really in there --------------------------------------
  assert.match(bundle.code, /startApp\(/);
  assert.match(bundle.code, /"src\/api\.js"/);
  assert.match(bundle.code, /"src\/lang\/compile\.js"/);

  // --- deterministic output --------------------------------------------------
  const second = buildSingleFileHtml();
  assert.equal(second.bytes, report.bytes);
  assert.equal(readFileSync(report.outFile, 'utf8'), html);
});

// The bundler rewrites ESM, so evaluate the rewritten graph in plain Node (no
// browser, no DOM): if module wiring/ordering/live-binding assumptions were
// wrong, this fails even though the HTML would merely look fine.

test('bundled core (src/api.js) evaluates in plain Node and still works', () => {
  const core = bundleEntryScript('src/api.js', { exposeGlobal: '__tpCoreSmoke' });
  assert.ok(core.modules >= 12, `expected the core graph, got ${core.modules} modules`);
  assert.ok(core.moduleIds.includes('src/lang/compile.js'));
  assert.ok(core.moduleIds.includes('src/sim/sim.js'));

  try {
    new Function(core.code)();
    const api = globalThis.__tpCoreSmoke;
    assert.ok(api, 'bundle entry exports must be exposed');
    assert.equal(typeof api.compile, 'function');
    assert.equal(typeof api.Simulator, 'function');
    assert.equal(typeof api.packToZip, 'function');
    assert.equal(typeof api.TickpackSession, 'function');
    assert.ok(Array.isArray(api.SAMPLES) && api.SAMPLES.length >= 3);

    // End-to-end through the rewritten modules: compile -> reset -> step.
    const compiled = api.compile('say "bundled core"');
    assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));
    const sim = new api.Simulator(compiled.files);
    sim.reset();
    const events = sim.step();
    assert.ok(events.some((event) => event.type === 'say'), 'bundled simulator must trace the say');
  } finally {
    delete globalThis.__tpCoreSmoke;
  }
});

test('bundled web app graph evaluates in plain Node and exposes startApp', () => {
  const web = bundleEntryScript('web/app.js', { exposeGlobal: '__tpWebSmoke' });
  assert.ok(web.modules >= 10, `expected the web graph, got ${web.modules} modules`);
  try {
    new Function(web.code)();
    const app = globalThis.__tpWebSmoke;
    assert.equal(typeof app.startApp, 'function');
  } finally {
    delete globalThis.__tpWebSmoke;
  }
});

test('unsupported or missing modules fail the build loudly', () => {
  assert.throws(() => bundleEntryScript('web/does-not-exist.js'), BuildError);
});
