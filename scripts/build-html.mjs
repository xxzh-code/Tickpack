#!/usr/bin/env node
// Tickpack single-file HTML build.
//
// Produces dist/tickpack.html: one self-contained file that can be double-clicked
// from disk (file://) with no server and no network requests.
//
//   node scripts/build-html.mjs
//
// What it does:
//   1. web/index.html is inlined: the <link rel=stylesheet> becomes <style>,
//      local assets (favicon/logo/…) become data: URLs, and the
//      <script type="module" src=web/boot.js> is replaced by one inline classic
//      script carrying the whole ES-module graph.
//   2. The module graph is discovered from the entry script (web/boot.js by
//      default) and rewritten into a tiny CommonJS-ish registry:
//          import { a as b } from './x.js'  ->  const { a: b } = __tpb_require("web/x.js");
//          import * as ns from './x.js'     ->  const ns = __tpb_require("web/x.js");
//          import './x.js'                  ->  __tpb_require("web/x.js");
//          export function/class/const ...  ->  plain declaration + exports.foo = foo;
//          export { a, b as c }             ->  exports.a = a; exports.c = b;
//          export { a } from './x.js'       ->  re-export through __tpb_require
//          export default name;             ->  exports.default = name;
//          import('./x.js') (string literal) -> Promise.resolve(__tpb_require("web/x.js"))
//      Only these patterns are supported. Anything else (computed dynamic import,
//      default import, `export *`, import.meta, bare/npm specifiers, circular
//      graphs, top-level await, …) fails the build with a precise BuildError
//      instead of emitting a broken HTML file.
//   3. Local image/font asset strings inside JS modules that resolve to real
//      files (e.g. layout.js `img.src = '/logo/logo-middle.svg'`) are rewritten
//      to data: URLs too, so dynamic images work from file://.
//
// The bundler is intentionally dependency-free (Node builtins only) and must not
// be imported by src/** or web/** — it is a shell build tool.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** Repository root (the directory that contains web/, src/, logo/). */
export const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');

/** Default output, relative to the repository root. */
export const DEFAULT_OUT_FILE = 'dist/tickpack.html';

/** Thrown for every unsupported source pattern or unresolvable reference. */
export class BuildError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BuildError';
  }
}

const BUNDLE_PLACEHOLDER = '<!--__TP_BUNDLE__-->';

const JS_EXT_RE = /\.m?js$/i;
const ASSET_EXT_RE = /\.(?:svg|png|jpe?g|webp|gif|ico|woff2?|ttf|otf|eot|mp3|ogg|wav)$/i;

const MIME_TYPES = new Map([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.eot', 'application/vnd.ms-fontobject'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
  ['.wav', 'audio/wav'],
  ['.json', 'application/json'],
]);

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

function fail(message) {
  throw new BuildError(message);
}

function toPosix(path) {
  return String(path).split(sep).join('/');
}

function isInside(root, absolute) {
  const rel = relative(root, absolute);
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return false;
  return true;
}

function readUtf8(absolute, what) {
  try {
    return readFileSync(absolute, 'utf8');
  } catch (error) {
    fail(`${what || 'file'} is missing or unreadable: ${absolute} (${error.message})`);
  }
}

function readFileBuffer(absolute, what) {
  try {
    return readFileSync(absolute);
  } catch (error) {
    fail(`${what || 'asset'} is missing or unreadable: ${absolute} (${error.message})`);
  }
}

function assertFile(absolute, what) {
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    fail(`${what || 'file'} not found: ${absolute}`);
  }
}

function fileToDataUri(absolute, suffix = '') {
  const ext = extname(absolute).toLowerCase();
  const mime = MIME_TYPES.get(ext) || 'application/octet-stream';
  const base64 = readFileBuffer(absolute).toString('base64');
  return `data:${mime};base64,${base64}${suffix}`;
}

function lineNumberAt(source, index) {
  return source.slice(0, Math.max(0, index)).split('\n').length;
}

function moduleError(id, source, index, message) {
  fail(`${id}:${lineNumberAt(source, index)}: ${message}`);
}

/** `name` or `name as alias` list (import/export specs). */
function parseSpecifierList(id, source, index, text, grammar) {
  const specs = [];
  for (const rawPart of text.split(',')) {
    const part = rawPart.trim();
    if (part === '') continue; // trailing comma
    const m = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(part);
    if (!m) {
      moduleError(id, source, index, `unsupported specifier '${part}' in ${grammar} (only \`name\` / \`name as alias\` are supported)`);
    }
    specs.push({ source: m[1], local: m[2] || m[1] });
  }
  if (specs.length === 0) moduleError(id, source, index, `empty ${grammar}`);
  return specs;
}

// ---------------------------------------------------------------------------
// Source analysis: mask strings/comments/template literals, collect strings
// and bracket depth. This lets the import/export rewrite ignore anything that
// only looks like module syntax inside strings/comments (e.g. the PRELUDE text).
// ---------------------------------------------------------------------------

const REGEX_PRECEDING_WORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'extends',
]);

function isIdentifierStart(ch) {
  return typeof ch === 'string' && /[A-Za-z_$]/.test(ch);
}

function analyzeSource(source) {
  const n = source.length;
  const mask = new Uint8Array(n); // 1 = real code (not string/comment/template text/regex)
  const strings = [];
  const comments = [];
  const stack = [{ kind: 'code', templateExpr: false, brace: 0, regexAllowed: true }];
  let i = 0;

  while (i < n) {
    const frame = stack[stack.length - 1];
    const ch = source[i];

    if (frame.kind === 'template') {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '`') {
        stack.pop();
        const parent = stack[stack.length - 1];
        if (parent && parent.kind === 'code') parent.regexAllowed = false;
        i += 1;
        continue;
      }
      if (ch === '$' && source[i + 1] === '{') {
        stack.push({ kind: 'code', templateExpr: true, brace: 0, regexAllowed: true });
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    // ---- code frame ------------------------------------------------------
    // comments
    if (ch === '/' && source[i + 1] === '/') {
      const start = i;
      i += 2;
      while (i < n && source[i] !== '\n') i += 1;
      comments.push({ start, end: i, block: false });
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i = Math.min(n, i + 2);
      comments.push({ start, end: i, block: true });
      continue;
    }

    // regex literal (heuristic: `/` starts a regex where an expression starts)
    if (ch === '/' && frame.regexAllowed) {
      const start = i;
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const c = source[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '\n') break;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
          j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      if (closed) {
        while (j < n && /[a-z]/i.test(source[j])) j += 1; // flags
        frame.regexAllowed = false;
        i = j;
        continue;
      }
      // Not a well-formed regex after all: treat the slash as an operator.
      mask[i] = 1;
      frame.regexAllowed = true;
      i += 1;
      continue;
    }

    // strings
    if (ch === '"' || ch === "'") {
      const start = i;
      const quote = ch;
      i += 1;
      while (i < n) {
        const c = source[i];
        if (c === '\\') {
          i += 2;
          continue;
        }
        i += 1;
        if (c === quote) break;
      }
      const contentStart = start + 1;
      const contentEnd = Math.max(contentStart, Math.min(n, i - 1));
      strings.push({ start, contentStart, contentEnd, quote, raw: source.slice(start, Math.min(n, i)) });
      frame.regexAllowed = false;
      continue;
    }

    // template literal
    if (ch === '`') {
      stack.push({ kind: 'template' });
      i += 1;
      continue;
    }

    // identifiers / keywords: division follows them, not a regex
    if (isIdentifierStart(ch)) {
      const start = i;
      i += 1;
      while (i < n && isIdentifierChar(source[i])) i += 1;
      const word = source.slice(start, i);
      for (let k = start; k < i; k++) mask[k] = 1;
      frame.regexAllowed = REGEX_PRECEDING_WORDS.has(word);
      continue;
    }

    // numbers
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] || ''))) {
      const start = i;
      i += 1;
      while (i < n && /[0-9A-Za-z_.]/.test(source[i])) i += 1;
      if (i < n && /[eE]/.test(source[i - 1]) && /[+-]/.test(source[i])) {
        i += 1;
        while (i < n && /[0-9_]/.test(source[i])) i += 1;
      }
      for (let k = start; k < i; k++) mask[k] = 1;
      frame.regexAllowed = false;
      continue;
    }

    // template-expression closing brace returns to template text
    if (frame.templateExpr) {
      if (ch === '{') {
        frame.brace += 1;
        mask[i] = 1;
        frame.regexAllowed = true;
        i += 1;
        continue;
      }
      if (ch === '}') {
        if (frame.brace === 0) {
          stack.pop();
          i += 1;
          continue;
        }
        frame.brace -= 1;
        mask[i] = 1;
        frame.regexAllowed = false;
        i += 1;
        continue;
      }
    }

    // punctuation / operators
    mask[i] = 1;
    if (ch === ')' || ch === ']' || ch === '}') frame.regexAllowed = false;
    else if (/\s/.test(ch)) {
      // keep previous expectation
    } else if (ch === '.') frame.regexAllowed = false;
    else frame.regexAllowed = true;
    i += 1;
  }

  // Bracket depth before every index (only real code brackets count).
  const depth = new Int32Array(n + 1);
  let d = 0;
  for (let k = 0; k < n; k++) {
    depth[k] = d;
    if (!mask[k]) continue;
    const c = source[k];
    if (c === '{' || c === '(' || c === '[') d += 1;
    else if (c === '}' || c === ')' || c === ']') {
      if (d > 0) d -= 1;
    }
  }
  depth[n] = d;

  return { mask, strings, comments, depth };
}

/** Remove comments from bundled JS (keeps line breaks; block comments -> space). */
function stripComments(source) {
  const analysis = analyzeSource(source);
  if (analysis.comments.length === 0) return source;
  const edits = analysis.comments.map((comment) => ({
    start: comment.start,
    end: comment.end,
    text: comment.block ? ' ' : '',
  }));
  return applyEdits(source, edits);
}

/** Code-only view of a source string (strings/comments/templates blanked out). */
function codeOnlyText(source) {
  const analysis = analyzeSource(source);
  let out = '';
  for (let i = 0; i < source.length; i++) out += analysis.mask[i] ? source[i] : ' ';
  return out;
}

function isLineStart(source, index) {
  let k = index - 1;
  while (k >= 0 && source[k] !== '\n') {
    if (!/\s/.test(source[k])) return false;
    k -= 1;
  }
  return true;
}

function isIdentifierChar(ch) {
  return typeof ch === 'string' && /[A-Za-z0-9_$]/.test(ch);
}

function skipWhitespace(source, index) {
  let k = index;
  while (k < source.length && /\s/.test(source[k])) k += 1;
  return k;
}

function findStatementEnd(source, analysis, start) {
  let depth = 0;
  for (let j = start; j < source.length; j++) {
    if (!analysis.mask[j]) continue;
    const ch = source[j];
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) return j + 1;
  }
  return -1;
}

/** Find top-level `import`/`export` keywords that remain in a source string. */
function findModuleKeywords(source) {
  const analysis = analyzeSource(source);
  const found = [];
  for (let i = 0; i < source.length; i++) {
    if (!analysis.mask[i] || analysis.depth[i] !== 0 || !isLineStart(source, i)) continue;
    for (const keyword of ['import', 'export']) {
      if (!source.startsWith(keyword, i)) continue;
      if (isIdentifierChar(source[i + keyword.length])) continue;
      found.push({ keyword, index: i });
    }
  }
  return found;
}

function applyEdits(source, edits) {
  const ordered = edits.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '';
  let cursor = 0;
  for (const edit of ordered) {
    if (edit.start < cursor) {
      fail(`internal build error: overlapping source edits at ${edit.start}-${edit.end}`);
    }
    out += source.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  out += source.slice(cursor);
  return out;
}

// ---------------------------------------------------------------------------
// Module resolution + transform
// ---------------------------------------------------------------------------

function resolveModuleSpecifier(spec, importerAbs, root) {
  if (typeof spec !== 'string' || spec === '') fail(`empty module specifier in ${toPosix(relative(root, importerAbs))}`);
  if (!/^\.{1,2}\//.test(spec)) {
    fail(
      `non-relative module specifier '${spec}' in ${toPosix(relative(root, importerAbs))}: ` +
        'the single-file build only supports relative .js modules (no npm/CDN imports).',
    );
  }
  if (spec.includes('?') || spec.includes('#')) {
    fail(`module specifier with query/hash is not supported: '${spec}' in ${toPosix(relative(root, importerAbs))}`);
  }
  let absolute = resolve(dirname(importerAbs), spec);
  if (!existsSync(absolute) && !extname(spec)) absolute = resolve(dirname(importerAbs), `${spec}.js`);
  assertFile(absolute, `imported module '${spec}' (from ${toPosix(relative(root, importerAbs))})`);
  if (!isInside(root, absolute)) fail(`import escapes the repository root: '${spec}'`);
  if (!JS_EXT_RE.test(absolute)) {
    fail(
      `only .js module files can be bundled, but '${spec}' in ` +
        `${toPosix(relative(root, importerAbs))} resolves to ${toPosix(relative(root, absolute))}`,
    );
  }
  return absolute;
}

/**
 * Resolve a local URL/attribute reference (absolute site path or path relative
 * to `baseDir`) to a real file inside the repo. Returns null for non-file
 * references (data:, #anchor, mailto:, …). Throws for external URLs.
 */
function resolveLocalFileReference(ref, baseDir, root, context) {
  const cleaned = String(ref).trim();
  if (cleaned === '') fail(`empty file reference ${context}`);
  if (
    cleaned.startsWith('data:') ||
    cleaned.startsWith('#') ||
    cleaned.startsWith('mailto:') ||
    cleaned.startsWith('tel:') ||
    cleaned.startsWith('javascript:') ||
    cleaned.startsWith('blob:')
  ) {
    return null;
  }
  if (/^(?:https?:)?\/\//i.test(cleaned)) {
    fail(`external resource reference is not allowed in the single-file build (${context}): ${cleaned}`);
  }

  let pathPart = cleaned;
  let suffix = '';
  const hashIndex = pathPart.indexOf('#');
  if (hashIndex >= 0) {
    suffix = pathPart.slice(hashIndex);
    pathPart = pathPart.slice(0, hashIndex);
  }
  const queryIndex = pathPart.indexOf('?');
  if (queryIndex >= 0) pathPart = pathPart.slice(0, queryIndex);
  if (pathPart === '') fail(`file reference has no path (${context}): ${cleaned}`);

  const absolute = pathPart.startsWith('/')
    ? resolve(root, pathPart.replace(/^\/+/, ''))
    : resolve(baseDir, pathPart);
  if (!isInside(root, absolute)) fail(`file reference escapes the repository root (${context}): ${cleaned}`);
  assertFile(absolute, `local file '${cleaned}' (${context})`);
  return { absolute, suffix };
}

/** Like resolveLocalFileReference, but the target must be an embeddable asset. */
function resolveAssetReference(ref, baseDir, root, context) {
  const resolved = resolveLocalFileReference(ref, baseDir, root, context);
  if (!resolved) return null;
  if (!ASSET_EXT_RE.test(resolved.absolute)) {
    fail(
      `local reference '${ref}' (${context}) resolves to ${toPosix(relative(root, resolved.absolute))}, ` +
        'which is not an embeddable asset (only images/fonts/audio are inlined).',
    );
  }
  return resolved;
}

/**
 * Rewrite one ES module into a plain function body for the bundle registry.
 * Throws BuildError for unsupported syntax; never returns a half-transformed body.
 */
function transformModule(source, id, absolute, root) {
  const analysis = analyzeSource(source);
  const n = source.length;
  const edits = [];
  const deps = []; // { id, absolute }
  const localExports = []; // { exported, local }
  const reexports = []; // { exported, local, variable }
  const imports = []; // { depId, names: string[], namespace?, dynamic? }
  const consumed = new Uint8Array(n);
  let reexportCounter = 0;
  let assetsInlined = 0;
  let dynamicImports = 0;
  let defaultExport = false;

  const addDependency = (spec, atIndex) => {
    let absoluteDep;
    try {
      absoluteDep = resolveModuleSpecifier(spec, absolute, root);
    } catch (error) {
      throw new BuildError(`${id}:${lineNumberAt(source, atIndex)}: ${error.message}`);
    }
    const depId = toPosix(relative(root, absoluteDep));
    if (!deps.some((dep) => dep.id === depId)) deps.push({ id: depId, absolute: absoluteDep });
    return depId;
  };

  const isKeywordAt = (index, keyword) => {
    if (!source.startsWith(keyword, index)) return false;
    if (isIdentifierChar(source[index + keyword.length])) return false;
    return true;
  };

  for (let i = 0; i < n; i++) {
    if (!analysis.mask[i] || analysis.depth[i] !== 0 || !isLineStart(source, i)) continue;

    // ---- import ... ------------------------------------------------------
    if (isKeywordAt(i, 'import')) {
      const afterWord = skipWhitespace(source, i + 'import'.length);
      const next = source[afterWord];
      if (next === '(') continue; // dynamic import handled in the second pass
      if (next === '.') {
        moduleError(id, source, i, '`import.meta` is not supported by the single-file build');
      }

      const end = findStatementEnd(source, analysis, i);
      if (end < 0) moduleError(id, source, i, 'unterminated import statement');
      const statement = source.slice(i, end).trim();
      let replacement;

      let m = /^import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]+)\2\s*;?$/.exec(statement);
      if (m) {
        const depId = addDependency(m[3], i);
        imports.push({ depId, namespace: true, names: [] });
        replacement = `const ${m[1]} = __tpb_require(${JSON.stringify(depId)});`;
      } else if ((m = /^import\s*\{([\s\S]*?)\}\s*from\s+(['"])([^'"]+)\2\s*;?$/.exec(statement))) {
        const specs = parseSpecifierList(id, source, i, m[1], 'named import');
        const depId = addDependency(m[3], i);
        imports.push({ depId, names: specs.map((spec) => spec.source) });
        const pattern = specs
          .map((spec) => (spec.source === spec.local ? spec.source : `${spec.source}: ${spec.local}`))
          .join(', ');
        replacement = `const { ${pattern} } = __tpb_require(${JSON.stringify(depId)});`;
      } else if ((m = /^import\s+(['"])([^'"]+)\2\s*;?$/.exec(statement))) {
        const depId = addDependency(m[2], i);
        imports.push({ depId, names: [] });
        replacement = `__tpb_require(${JSON.stringify(depId)});`;
      } else if (/^import\s+[A-Za-z_$][\w$]*\s*(?:,|from\b)/.test(statement)) {
        moduleError(
          id,
          source,
          i,
          'default imports are not supported by the single-file build ' +
            '(use named imports or `import * as ns`)',
        );
      } else {
        moduleError(id, source, i, `unsupported import syntax: ${statement.split('\n')[0]}`);
      }

      edits.push({ start: i, end, text: replacement });
      for (let k = i; k < end; k++) consumed[k] = 1;
      i = end - 1;
      continue;
    }

    // ---- export ... ------------------------------------------------------
    if (!isKeywordAt(i, 'export')) continue;
    const keywordEnd = skipWhitespace(source, i + 'export'.length);
    const rest = source.slice(keywordEnd);

    if (rest.startsWith('default')) {
      const end = findStatementEnd(source, analysis, i);
      if (end < 0) moduleError(id, source, i, 'unterminated export default statement');
      const statement = source.slice(i, end).trim();
      const m = /^export\s+default\s+([A-Za-z_$][\w$]*)\s*;?$/.exec(statement);
      if (!m) {
        moduleError(
          id,
          source,
          i,
          'only `export default <identifier>;` is supported by the single-file build',
        );
      }
      edits.push({ start: i, end, text: `exports.default = ${m[1]};` });
      defaultExport = true;
      i = end - 1;
      continue;
    }

    if (rest.startsWith('*')) {
      moduleError(id, source, i, '`export *` is not supported by the single-file build');
    }

    if (rest.startsWith('{')) {
      const end = findStatementEnd(source, analysis, i);
      if (end < 0) moduleError(id, source, i, 'unterminated export list');
      const statement = source.slice(i, end).trim();
      const m = /^export\s*\{([\s\S]*?)\}\s*(?:from\s+(['"])([^'"]+)\2\s*)?;?$/.exec(statement);
      if (!m) moduleError(id, source, i, `unsupported export list: ${statement.split('\n')[0]}`);
      const specs = parseSpecifierList(id, source, i, m[1], 'export list');
      if (m[3]) {
        const depId = addDependency(m[3], i);
        imports.push({ depId, names: specs.map((spec) => spec.source) });
        const variable = `__tpb_reexport_${reexportCounter++}`;
        const lines = [`const ${variable} = __tpb_require(${JSON.stringify(depId)});`];
        for (const spec of specs) {
          if (!/^[A-Za-z_$][\w$]*$/.test(spec.local)) {
            moduleError(id, source, i, `unsupported re-export name '${spec.local}'`);
          }
          reexports.push({ exported: spec.local, local: spec.source, variable });
        }
        edits.push({ start: i, end, text: lines.join('\n') });
      } else {
        for (const spec of specs) {
          if (!/^[A-Za-z_$][\w$]*$/.test(spec.local)) {
            moduleError(id, source, i, `unsupported export name '${spec.local}'`);
          }
          localExports.push({ exported: spec.local, local: spec.source });
        }
        edits.push({ start: i, end, text: '' });
      }
      i = end - 1;
      continue;
    }

    // export [async] function name / export class Name / export const NAME
    let m = /^async\s+function\s+([A-Za-z_$][\w$]*)/.exec(rest);
    if (m) {
      localExports.push({ exported: m[1], local: m[1] });
      edits.push({ start: i, end: i + 'export'.length, text: '' });
      continue;
    }
    m = /^function\s+([A-Za-z_$][\w$]*)/.exec(rest);
    if (m) {
      localExports.push({ exported: m[1], local: m[1] });
      edits.push({ start: i, end: i + 'export'.length, text: '' });
      continue;
    }
    m = /^class\s+([A-Za-z_$][\w$]*)/.exec(rest);
    if (m) {
      localExports.push({ exported: m[1], local: m[1] });
      edits.push({ start: i, end: i + 'export'.length, text: '' });
      continue;
    }
    if (/^(let|var)\b/.test(rest)) {
      moduleError(
        id,
        source,
        i,
        '`export let`/`export var` are not supported by the single-file build ' +
          '(export const, functions or classes instead)',
      );
    }
    m = /^const\s+([A-Za-z_$][\w$]*)/.exec(rest);
    if (m) {
      localExports.push({ exported: m[1], local: m[1] });
      edits.push({ start: i, end: i + 'export'.length, text: '' });
      continue;
    }
    if (/^const\s*[{[]/.test(rest)) {
      moduleError(
        id,
        source,
        i,
        'destructuring `export const { … }` is not supported by the single-file build',
      );
    }

    moduleError(
      id,
      source,
      i,
      'unsupported export syntax by the single-file build ' +
        '(supported: export function/class/const, export { … } [from …], export default <identifier>)',
    );
  }

  // ---- static dynamic imports: import('./x.js') --------------------------
  for (let i = 0; i < n; i++) {
    if (consumed[i] || !analysis.mask[i]) continue;
    if (!source.startsWith('import', i)) continue;
    if (i > 0 && isIdentifierChar(source[i - 1])) continue;
    if (isIdentifierChar(source[i + 'import'.length])) continue;
    const afterWord = skipWhitespace(source, i + 'import'.length);
    if (source[afterWord] === '.') {
      moduleError(id, source, i, '`import.meta` is not supported by the single-file build');
    }
    if (source[afterWord] !== '(') continue;
    const m = /^import\s*\(\s*(['"])([^'"]+)\1\s*\)/.exec(source.slice(i));
    if (!m) {
      moduleError(
        id,
        source,
        i,
        'only `import("<relative .js path>")` with a string literal is supported; ' +
          'computed dynamic imports cannot be bundled',
      );
    }
    const depId = addDependency(m[2], i);
    imports.push({ depId, names: [], dynamic: true });
    const end = i + m[0].length;
    edits.push({ start: i, end, text: `Promise.resolve(__tpb_require(${JSON.stringify(depId)}))` });
    for (let k = i; k < end; k++) consumed[k] = 1;
    dynamicImports += 1;
    i = end - 1;
  }

  // ---- local asset strings inside JS (e.g. img.src = '/logo/logo-middle.svg')
  for (const str of analysis.strings) {
    if (str.raw.includes('\\')) continue;
    const value = source.slice(str.contentStart, str.contentEnd);
    if (!ASSET_EXT_RE.test(value)) continue;
    if (!(value.startsWith('/') || value.startsWith('./') || value.startsWith('../'))) continue;
    const context = `${id}:${lineNumberAt(source, str.start)}`;
    const resolved = resolveAssetReference(value, dirname(absolute), root, context);
    if (!resolved) continue;
    const dataUri = fileToDataUri(resolved.absolute, resolved.suffix);
    edits.push({ start: str.contentStart, end: str.contentEnd, text: dataUri });
    assetsInlined += 1;
  }

  // Strip comments from bundled code: smaller output, and docs/comments must not
  // look like leftover module syntax to the self-containment checks.
  const body = stripComments(applyEdits(source, edits));

  // Defensive: after rewriting there must be no top-level module syntax left.
  const leftovers = findModuleKeywords(body);
  if (leftovers.length > 0) {
    const first = leftovers[0];
    moduleError(
      id,
      body,
      first.index,
      `unsupported module syntax was left in the bundled body (${first.keyword}); ` +
        'this is a bundler bug — refusing to emit a broken file',
    );
  }

  const footer = [];
  for (const spec of localExports) {
    footer.push(`exports.${spec.exported} = ${spec.local};`);
  }
  for (const spec of reexports) {
    footer.push(`exports.${spec.exported} = ${spec.variable}.${spec.local};`);
  }

  return {
    id,
    absolute,
    code: body,
    footer: footer.join('\n'),
    deps,
    imports,
    assetsInlined,
    dynamicImports,
    defaultExport,
    exportedNames: new Set([
      ...localExports.map((spec) => spec.exported),
      ...reexports.map((spec) => spec.exported),
      ...(defaultExport ? ['default'] : []),
    ]),
    exports: [
      ...localExports.map((spec) => spec.exported),
      ...reexports.map((spec) => spec.exported),
    ],
  };
}

function loadModuleGraph(entryAbs, root) {
  const modules = new Map(); // id -> transformed module (insertion order = postorder)
  const state = new Map(); // id -> 'visiting' | 'done'
  const reportedAssets = [];

  function load(absolute, chain) {
    const id = toPosix(relative(root, absolute));
    const current = state.get(id);
    if (current === 'done') return id;
    if (current === 'visiting') {
      const start = chain.indexOf(id);
      const cycle = [...chain.slice(start), id].join(' -> ');
      fail(`circular module dependency detected (the single-file build cannot bundle cycles): ${cycle}`);
    }
    state.set(id, 'visiting');
    const source = readUtf8(absolute, `module ${id}`);
    const transformed = transformModule(source, id, absolute, root);
    const nextChain = chain.concat(id);
    for (const dep of transformed.deps) load(dep.absolute, nextChain);
    state.set(id, 'done');
    modules.set(id, transformed);
    reportedAssets.push(...new Array(transformed.assetsInlined).fill(0));
    return id;
  }

  const entryId = load(resolve(entryAbs), []);

  // Static ESM would fail if a named import is not actually exported; catch that
  // at build time instead of shipping a broken single file.
  for (const mod of modules.values()) {
    for (const imp of mod.imports) {
      const dep = modules.get(imp.depId);
      if (!dep) fail(`internal build error: module ${imp.depId} was never loaded`);
      for (const name of imp.names) {
        if (!dep.exportedNames.has(name)) {
          fail(
            `${mod.id} imports '${name}' from '${imp.depId}', but that module does not export it ` +
              '(native ESM would throw a SyntaxError)',
          );
        }
      }
    }
  }

  return { modules, entryId };
}

function renderBundle(modules, entryId, options = {}) {
  const lines = [];
  lines.push('/* Tickpack single-file bundle — generated by scripts/build-html.mjs. Do not edit. */');
  lines.push('(function () {');
  lines.push('  "use strict";');
  lines.push('  var __tpb_modules = Object.create(null);');
  lines.push('  var __tpb_cache = Object.create(null);');
  lines.push('  function __tpb_require(id) {');
  lines.push('    var cached = __tpb_cache[id];');
  lines.push('    if (cached) return cached.exports;');
  lines.push('    var module = { exports: {} };');
  lines.push('    __tpb_cache[id] = module;');
  lines.push('    var factory = __tpb_modules[id];');
  lines.push('    if (!factory) throw new Error("Tickpack bundle: missing module " + id);');
  lines.push('    factory(module.exports);');
  lines.push('    return module.exports;');
  lines.push('  }');

  for (const [id, mod] of modules) {
    lines.push('');
    lines.push(`  // ---- ${id} ----`);
    lines.push(`  __tpb_modules[${JSON.stringify(id)}] = function (exports) {`);
    lines.push(mod.code);
    if (mod.footer) lines.push(mod.footer);
    lines.push('  };');
  }

  lines.push('');
  if (options.exposeGlobal) {
    lines.push(
      `  globalThis[${JSON.stringify(options.exposeGlobal)}] = __tpb_require(${JSON.stringify(entryId)});`,
    );
  } else {
    lines.push(`  __tpb_require(${JSON.stringify(entryId)});`);
  }
  lines.push('})();');
  return lines.join('\n') + '\n';
}

/**
 * Bundle an arbitrary entry module from this repository (used by tests and by
 * humans who want to smoke-test the bundled core without a browser).
 * Returns the standalone script source; it does not touch index.html.
 */
export function bundleEntryScript(entry, options = {}) {
  const root = options.root ? resolve(options.root) : DEFAULT_ROOT;
  const entryAbsolute = resolve(root, entry);
  assertFile(entryAbsolute, `bundle entry ${entry}`);
  if (!JS_EXT_RE.test(entryAbsolute)) fail(`bundle entry must be a .js module: ${entry}`);
  const { modules, entryId } = loadModuleGraph(entryAbsolute, root);
  const code = renderBundle(modules, entryId, { exposeGlobal: options.exposeGlobal });
  try {
    new Function(code);
  } catch (error) {
    fail(`bundled entry ${entry} is not valid classic JavaScript: ${error.message}`);
  }
  return { code, modules: modules.size, entry: entryId, moduleIds: [...modules.keys()] };
}

// ---------------------------------------------------------------------------
// HTML / CSS inlining
// ---------------------------------------------------------------------------

const HTML_ATTR_VALUE_RE = (name) =>
  new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i');

function htmlAttr(attributes, name) {
  const m = HTML_ATTR_VALUE_RE(name).exec(attributes);
  return m ? m[2] : null;
}

function inlineCssUrls(css, baseDir, root, context, report) {
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (whole, _quote, ref) => {
    const cleaned = ref.trim();
    if (cleaned.startsWith('data:') || cleaned.startsWith('#')) return whole;
    const resolved = resolveAssetReference(cleaned, baseDir, root, context);
    if (!resolved) return whole;
    report.assets.push(toPosix(relative(root, resolved.absolute)));
    return `url(${JSON.stringify(fileToDataUri(resolved.absolute, resolved.suffix))})`;
  });
}

function inlineStylesheetLinks(html, baseDir, root, report) {
  return html.replace(/<link\b([^>]*)>/gi, (whole, attributes) => {
    const rel = htmlAttr(attributes, 'rel');
    if (!rel || !/\bstylesheet\b/i.test(rel)) return whole;
    const href = htmlAttr(attributes, 'href');
    if (href === null) fail('stylesheet <link> without href in web/index.html');
    const resolved = resolveLocalFileReference(href, baseDir, root, 'stylesheet <link>');
    if (!resolved) fail(`stylesheet link must point at a local CSS file: ${href}`);
    if (!resolved.absolute.toLowerCase().endsWith('.css')) {
      fail(`stylesheet link is not a .css file: ${href}`);
    }
    const css = readUtf8(resolved.absolute, `stylesheet ${href}`);
    report.stylesheets.push(toPosix(relative(root, resolved.absolute)));
    const inlined = inlineCssUrls(css, dirname(resolved.absolute), root, `stylesheet ${href}`, report);
    return `<style>\n${inlined}\n</style>`;
  });
}

/**
 * Inline every remaining local asset reference in markup: src/href/poster/
 * srcset, inline style="…url()…", <style> blocks and JS asset strings in the
 * modules (handled separately). Inline scripts are protected so JS code is not
 * mistaken for markup.
 */
function inlineHtmlMarkup(html, baseDir, root, report) {
  const protectedBlocks = [];
  const protect = (block) => {
    protectedBlocks.push(block);
    return `\u0000TP_PROTECTED_${protectedBlocks.length - 1}\u0000`;
  };

  // Inline <script> blocks are code, not markup.
  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (whole, attributes) => {
    if (htmlAttr(attributes, 'src') !== null) {
      fail('an external <script src=…> survived until markup inlining (build bug)');
    }
    const type = htmlAttr(attributes, 'type');
    if (type && /module/i.test(type)) {
      fail('inline <script type="module"> is not supported; the build emits one classic script');
    }
    return protect(whole);
  });

  // <style> blocks may contain url() references too.
  html = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (whole, attributes, css) => {
    const inlined = inlineCssUrls(css, baseDir, root, 'inline <style>', report);
    return protect(`<style${attributes}>${inlined}</style>`);
  });

  // style="…url()…" attributes.
  html = html.replace(/(\bstyle\s*=\s*)(["'])([\s\S]*?)\2/gi, (whole, prefix, quote, css) => {
    const inlined = inlineCssUrls(css, baseDir, root, 'inline style attribute', report);
    return `${prefix}${quote}${inlined}${quote}`;
  });

  // src / href / poster attributes.
  html = html.replace(/(\b(?:src|href|poster)\s*=\s*)(["'])([\s\S]*?)\2/gi, (whole, prefix, quote, ref) => {
    const resolved = resolveAssetReference(ref, baseDir, root, 'HTML attribute');
    if (!resolved) return whole;
    report.assets.push(toPosix(relative(root, resolved.absolute)));
    return `${prefix}${quote}${fileToDataUri(resolved.absolute, resolved.suffix)}${quote}`;
  });

  // srcset="a 1x, b 2x".
  html = html.replace(/(\bsrcset\s*=\s*)(["'])([\s\S]*?)\2/gi, (whole, prefix, quote, value) => {
    const candidates = value.split(',').map((candidate) => {
      const trimmed = candidate.trim();
      if (trimmed === '') return null;
      const parts = trimmed.split(/\s+/);
      const resolved = resolveAssetReference(parts[0], baseDir, root, 'srcset candidate');
      if (!resolved) return trimmed;
      report.assets.push(toPosix(relative(root, resolved.absolute)));
      return [fileToDataUri(resolved.absolute, resolved.suffix), ...parts.slice(1)].join(' ');
    });
    return `${prefix}${quote}${candidates.filter((c) => c !== null).join(', ')}${quote}`;
  });

  // The brand <img> has an SVG→PNG onerror fallback pointing at /logo/…. The
  // SVG is now a data: URL, so the fallback is pointless and would leave a
  // /logo/ reference in the file. Drop local-asset fallback handlers.
  html = html.replace(/(\s+onerror\s*=\s*)(["'])([\s\S]*?)\2/gi, (whole, _prefix, _quote, code) => {
    if (/\/logo\/|\.(?:svg|png|jpe?g|webp|gif|ico)\b/i.test(code)) return '';
    return whole;
  });

  return html.replace(/\u0000TP_PROTECTED_(\d+)\u0000/g, (_m, index) => protectedBlocks[Number(index)]);
}

function extractEntryScript(html, baseDir, root) {
  let entryAbsolute = null;
  let count = 0;
  const result = html.replace(/<script\b([^>]*)>\s*<\/script>/gi, (whole, attributes) => {
    const src = htmlAttr(attributes, 'src');
    if (src === null) return whole; // empty inline script
    count += 1;
    if (count > 1) fail('web/index.html has more than one external <script src=…>; the build supports exactly one');
    const resolved = resolveLocalFileReference(src, baseDir, root, 'entry <script>');
    if (!resolved) fail(`entry script must be a local .js module: ${src}`);
    if (!JS_EXT_RE.test(resolved.absolute)) fail(`entry script is not a JS module: ${src}`);
    entryAbsolute = resolved.absolute;
    return BUNDLE_PLACEHOLDER;
  });
  if (!entryAbsolute) {
    fail('web/index.html has no external <script src="…boot.js"></script> entry point to bundle');
  }
  return { html: result, entryAbsolute };
}

function findExternalResourceRefs(text) {
  const refs = [];
  const attrRe = /(\b(?:src|href|poster|srcset)\s*=\s*)(["'])([\s\S]*?)\2/gi;
  let m;
  while ((m = attrRe.exec(text))) {
    if (/^(?:https?:)?\/\//i.test(m[3].trim())) refs.push(`${m[1].trim()} ${m[3].trim()}`);
  }
  const urlRe = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
  while ((m = urlRe.exec(text))) {
    if (/^(?:https?:)?\/\//i.test(m[2].trim())) refs.push(`url(${m[2].trim()})`);
  }
  return refs;
}

/** External URLs that remain anywhere (used by tests); data: payloads excluded. */
export function findExternalUrls(text) {
  const urls = [];
  const re = /https?:\/\/[^\s"'<>)\]]+/gi;
  let m;
  while ((m = re.exec(text))) urls.push(m[0]);
  return urls;
}

function validateOutput(html, bundle) {
  if (/<script\b[^>]*\bsrc\s*=/i.test(html)) fail('output still contains an external <script src=…>');
  if (/<link\b[^>]*\brel\s*=\s*["']?stylesheet/i.test(html)) fail('output still contains a stylesheet <link>');
  if (/<script\b[^>]*\btype\s*=\s*["']module/i.test(html)) fail('output still contains a module script');
  if (html.includes(BUNDLE_PLACEHOLDER)) fail('internal build error: bundle placeholder was not replaced');

  const leftovers = [];
  if (/\/web\//.test(html)) leftovers.push('/web/ absolute reference');
  if (/\/logo\//.test(html)) leftovers.push('/logo/ absolute reference');
  const bundleCode = codeOnlyText(bundle);
  if (/from\s*["']\.{0,2}\//.test(bundleCode)) leftovers.push('relative module specifier (import … from "./…")');
  if (/import\s*\(\s*["']\.{0,2}\//.test(bundleCode)) leftovers.push('relative dynamic import');
  if (leftovers.length > 0) {
    fail(`output still contains ${leftovers.join(', ')} — refusing to emit a non-self-contained file`);
  }

  const external = findExternalResourceRefs(html);
  if (external.length > 0) {
    fail(`output contains external resource references: ${external.slice(0, 5).join(' | ')}`);
  }

  try {
    // Parses without executing: catches leftover import/export, top-level await, …
    new Function(bundle);
  } catch (error) {
    fail(`bundled inline script is not valid classic JavaScript: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the single-file HTML.
 *
 * @param {{root?: string, outFile?: string, write?: boolean}} [options]
 * @returns {{outFile: string, bytes: number, modules: number, moduleIds: string[],
 *            entry: string, assets: string[], stylesheets: string[],
 *            assetsInlinedInJs: number, dynamicImports: number, elapsedMs: number}}
 */
export function buildSingleFileHtml(options = {}) {
  const started = performance.now();
  const root = options.root ? resolve(options.root) : DEFAULT_ROOT;
  const webDir = join(root, 'web');
  const htmlPath = join(webDir, 'index.html');
  const outFile = options.outFile ? resolve(root, options.outFile) : join(root, DEFAULT_OUT_FILE);

  assertFile(htmlPath, 'web/index.html');
  const report = { assets: [], stylesheets: [], assetsInlinedInJs: 0, dynamicImports: 0 };

  let html = readUtf8(htmlPath, 'web/index.html');

  // 1. Pull out the module entry script — the whole app becomes one inline script.
  const extracted = extractEntryScript(html, webDir, root);
  html = extracted.html;

  // 2. Inline <link rel=stylesheet>.
  html = inlineStylesheetLinks(html, webDir, root, report);

  // 3. Inline every remaining asset reference in markup.
  html = inlineHtmlMarkup(html, webDir, root, report);

  // 4. Discover + bundle the module graph.
  const { modules, entryId } = loadModuleGraph(extracted.entryAbsolute, root);
  const bundle = renderBundle(modules, entryId);
  for (const mod of modules.values()) {
    report.assetsInlinedInJs += mod.assetsInlined;
    report.dynamicImports += mod.dynamicImports;
  }

  // 5. Insert the inline script where the module script used to be.
  html = html.replace(BUNDLE_PLACEHOLDER, () => `<script>\n${bundle}</script>`);
  validateOutput(html, bundle);

  if (options.write !== false) {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, html, 'utf8');
  }

  const bytes = Buffer.byteLength(html, 'utf8');
  return {
    outFile,
    bytes,
    modules: modules.size,
    moduleIds: [...modules.keys()],
    entry: entryId,
    assets: [...new Set(report.assets)],
    stylesheets: [...new Set(report.stylesheets)],
    assetsInlinedInJs: report.assetsInlinedInJs,
    dynamicImports: report.dynamicImports,
    elapsedMs: performance.now() - started,
  };
}

/** Human-readable summary (used by the CLI and tests can ignore it). */
export function formatBuildReport(result) {
  const kb = (result.bytes / 1024).toFixed(1);
  return [
    'Tickpack single-file build',
    `  output:      ${toPosix(relative(DEFAULT_ROOT, result.outFile))} (${kb} KB)`,
    `  entry:       ${result.entry}`,
    `  modules:     ${result.modules}`,
    `  stylesheets: ${result.stylesheets.join(', ') || '(none)'}`,
    `  assets:      ${result.assets.length} HTML/CSS + ${result.assetsInlinedInJs} JS string references`,
    `  dynamic imports resolved: ${result.dynamicImports}`,
    `  time:        ${result.elapsedMs.toFixed(0)} ms`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const result = buildSingleFileHtml();
    console.log(formatBuildReport(result));
    console.log(`\nDone: ${result.outFile}`);
  } catch (error) {
    console.error(`build failed: ${error.message}`);
    if (!(error instanceof BuildError) && error && error.stack) console.error(error.stack);
    process.exitCode = 1;
  }
}

export default buildSingleFileHtml;
