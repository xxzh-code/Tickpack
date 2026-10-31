// Architecture guard: the core layer must stay platform-agnostic.
// If this test fails, a shell concern leaked into src/ — move it behind the
// host adapter (see docs/ARCH.md) instead of "making it work for now".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Remove line/block comments so prose cannot trip the guard. */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const FORBIDDEN = [
  [/\bwindow\b/, 'window'],
  [/\bdocument\b/, 'document'],
  [/\blocalStorage\b/, 'localStorage'],
  [/\bsessionStorage\b/, 'sessionStorage'],
  [/\bnavigator\b/, 'navigator'],
  [/\brequestAnimationFrame\b/, 'requestAnimationFrame'],
  [/\bfetch\s*\(/, 'fetch()'],
  [/\bnew Blob\b/, 'Blob'],
  [/URL\.createObjectURL/, 'URL.createObjectURL'],
  [/\bperformance\.now\b/, 'performance.now'],
  [/\bprocess\./, 'process.*'],
  [/\brequire\s*\(/, 'require()'],
  [/\b__dirname\b/, '__dirname'],
  [/\bisElectron\b/, 'isElectron branch'],
  [/\bisDesktop\b/, 'isDesktop branch'],
  [/\bisWeb\b/, 'isWeb branch'],
  [/from\s+['"]node:/, 'node: builtin import'],
  [/from\s+['"](fs|path|os|child_process|http|https|crypto)['"]/, 'Node builtin import'],
];

test('core layer (src/**) uses no platform APIs and no environment branches', () => {
  const files = walk(SRC);
  assert.ok(files.length >= 10, 'expected the core sources to be found');
  const problems = [];

  for (const file of files) {
    const rel = relative(SRC, file).replace(/\\/g, '/');
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const [re, what] of FORBIDDEN) {
      if (re.test(code)) problems.push(`${rel}: ${what}`);
    }
    // Core imports must stay relative and inside the core.
    for (const m of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (!spec.startsWith('.')) problems.push(`${rel}: non-relative import '${spec}'`);
    }
  }

  assert.deepEqual(problems, [], `platform leakage in core:\n${problems.join('\n')}`);
});

test('core exports only the documented session/compile/sim surface', async () => {
  const api = await import('../src/api.js');
  for (const name of ['compile', 'PRELUDE', 'Simulator', 'SAMPLES', 'packToZip', 'TickpackSession']) {
    assert.ok(name in api, `src/api.js must export ${name}`);
  }
  assert.equal(typeof api.TickpackSession, 'function');
});

test('web shell keeps its platform access in shell modules, not in the session', () => {
  // The browser shell is allowed to touch window/document; the session is not.
  // This is a lightweight tripwire: app/boot/world/editor may use DOM, host-web
  // must be the only place that implements the host adapter.
  const host = readFileSync(fileURLToPath(new URL('../web/host-web.js', import.meta.url)), 'utf8');
  assert.match(host, /export function createWebHost/);
  for (const method of [
    'exportDatapack',
    'importTextFile',
    'exportTextFile',
    'copyText',
    'storageGet',
    'storageSet',
    'storageRemove',
  ]) {
    assert.match(host, new RegExp(method), `host-web must implement ${method}`);
  }
});
