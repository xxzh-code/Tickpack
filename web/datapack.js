// Generated datapack browser: a compact, collapsible file tree + read-only line
// view. During a run it follows the last executed command, highlights its line,
// auto-scrolls it into view, and reports the matching *user* source line
// (via the `# source line N` comments emitted by the compiler).

import { esc } from './util.js';

/** Shorten pack paths for the tree: data/tp/function/main/s0 -> tp/main/s0 */
function treePath(path) {
  if (path === 'pack.mcmeta') return path;
  if (path.startsWith('data/')) return path.slice(5).replace('/function/', '/');
  return path;
}

function natsort(a, b) {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

function buildTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const path of Object.keys(files)) {
    const short = treePath(path);
    const parts = short.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (!node.dirs.has(seg)) {
        node.dirs.set(seg, {
          name: seg,
          short: parts.slice(0, i + 1).join('/'),
          dirs: new Map(),
          files: [],
        });
      }
      node = node.dirs.get(seg);
    }
    node.files.push({ path, short, name: parts[parts.length - 1] });
  }
  return root;
}

/** Nearest `# source line N` at or above 1-based `line`. */
function looseSourceLine(files, file, line) {
  const text = files[file];
  if (!text || !line) return null;
  const lines = text.split('\n');
  const start = Math.min(line, lines.length) - 1;
  for (let i = start; i >= 0 && i > start - 40; i--) {
    const m = /#\s*source line\s+(\d+)/.exec(lines[i]);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * A command is "directly mapped" when it sits right below a comment block that
 * contains `# source line N` (the compiler's traceability marker). This is the
 * line that corresponds to the user's statement, not state-machine bookkeeping.
 */
function directSourceLine(files, file, line) {
  const text = files[file];
  if (!text || !line) return null;
  const lines = text.split('\n');
  for (let i = line - 2; i >= 0; i--) {
    const raw = lines[i];
    if (raw == null) break;
    const t = raw.trim();
    if (!t.startsWith('#')) break;
    const m = /^#\s*source line\s+(\d+)/.exec(t);
    if (m) return Number(m[1]);
  }
  return null;
}

const isMainState = (f) => /\/main\/s\d+\.mcfunction$/.test(f || '');
const isSnippet = (f) => /\/snippet\//.test(f || '');

export function createDatapack({ treeEl, pathEl, codeEl, execEl, packMetaEl, copyBtn, onSourceLine }) {
  let files = {};
  let prelude = '';
  let currentPath = null; // real pack path, or '__prelude__'
  let exec = null; // { file, line, fn, tick, sourceLine }
  let lineEls = [];
  let treeRows = [];

  const expanded = new Set(); // short folder paths that are open

  function expandAncestors(path) {
    if (path === '__prelude__') return;
    const short = treePath(path);
    const parts = short.split('/');
    for (let i = 1; i < parts.length; i++) {
      expanded.add(parts.slice(0, i).join('/'));
    }
  }

  function renderTree() {
    const root = buildTree(files);
    treeRows = [];
    const frag = document.createDocumentFragment();
    const scrollTop = treeEl.scrollTop;

    function walk(node, depth) {
      const dirs = [...node.dirs.values()].sort((a, b) => natsort(a.name, b.name));
      for (const child of dirs) {
        const isOpen = expanded.has(child.short);
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'tree-row tree-dir' + (isOpen ? '' : ' collapsed');
        row.style.setProperty('--depth', depth);
        row.innerHTML = `<span class="tw">${isOpen ? '▾' : '▸'}</span><span class="tname">${esc(child.name)}</span>`;
        row.title = isOpen ? `collapse ${child.short}/` : `expand ${child.short}/`;
        row.addEventListener('click', () => {
          if (expanded.has(child.short)) expanded.delete(child.short);
          else expanded.add(child.short);
          renderTree();
        });
        frag.appendChild(row);
        if (isOpen) walk(child, depth + 1);
      }
      const sorted = [...node.files].sort((a, b) => natsort(a.name, b.name));
      for (const f of sorted) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'tree-row tree-file' + (f.path === currentPath ? ' active' : '');
        row.style.setProperty('--depth', depth);
        row.dataset.path = f.path;
        row.title = f.path;
        const ext = f.name.endsWith('.json') ? 'json' : f.name.endsWith('.mcfunction') ? 'mc' : 'txt';
        row.innerHTML = `<span class="ext ext-${ext}">${ext === 'mc' ? 'ƒ' : ext === 'json' ? '{ }' : '·'}</span><span class="tname">${esc(f.name)}</span>`;
        row.addEventListener('click', () => viewFile(f.path));
        frag.appendChild(row);
        treeRows.push(row);
      }
    }

    walk(root, 0);

    if (prelude) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tree-row tree-file prelude-row' + (currentPath === '__prelude__' ? ' active' : '');
      row.dataset.path = '__prelude__';
      row.title = 'standard library — read-only, prepended to every program';
      row.innerHTML = '<span class="ext ext-txt">✦</span><span class="tname">prelude.tp</span><span class="ro">stdlib</span>';
      row.addEventListener('click', () => viewFile('__prelude__'));
      frag.append(row);
      treeRows.push(row);
    }

    treeEl.innerHTML = '';
    treeEl.appendChild(frag);
    treeEl.scrollTop = scrollTop;

    if (packMetaEl) {
      const count = Object.keys(files).length;
      packMetaEl.textContent = count ? `${count} files` : '';
    }
  }

  function scrollTreeToActive() {
    const active = treeRows.find((r) => r.classList.contains('active'));
    if (!active || !active.scrollIntoView) return;
    active.scrollIntoView({ block: 'center' });
    // snap the scroll offset to whole rows so nothing is cut in half at an edge
    const rowH = active.offsetHeight || 19;
    treeEl.scrollTop = Math.max(0, Math.round(treeEl.scrollTop / rowH) * rowH);
  }

  function renderCode() {
    lineEls = [];
    let text = '';
    if (currentPath === '__prelude__') text = prelude;
    else if (currentPath && files[currentPath] != null) text = String(files[currentPath]);

    if (!text) {
      codeEl.innerHTML = '<div class="code-empty">select a file</div>';
      return;
    }
    const lines = text.split('\n');
    const html = lines.map((line, i) => {
      const no = i + 1;
      const isComment = /^\s*#/.test(line);
      const isHeader = /^# Tickpack/.test(line);
      const isSrc = /^\s*#\s*source line\s+\d+/.test(line);
      return `<div class="code-line${isComment ? ' comment' : ''}${isHeader ? ' header' : ''}${isSrc ? ' srcline' : ''}" data-line="${no}">` +
        `<span class="ln">${no}</span><code>${esc(line) || ' '}</code></div>`;
    }).join('');
    codeEl.innerHTML = html;
    lineEls = [...codeEl.children];
    applyExecHighlight(false);
  }

  function applyExecHighlight(scroll) {
    if (!lineEls.length) return;
    for (const el of lineEls) el.classList.remove('cur');
    if (!exec || currentPath !== exec.file) return;
    const target = lineEls[exec.line - 1];
    if (!target) return;
    target.classList.add('cur');
    if (scroll) {
      const view = codeEl;
      const top = target.offsetTop - view.clientHeight / 2 + target.offsetHeight / 2;
      view.scrollTop = Math.max(0, top);
    }
  }

  function viewFile(path, { scroll = true } = {}) {
    if (path !== '__prelude__' && files[path] == null) return;
    currentPath = path;
    expandAncestors(path);
    pathEl.textContent = path === '__prelude__' ? 'stdlib/prelude.tp' : path;
    pathEl.title = path;
    pathEl.classList.toggle('readonly', path === '__prelude__');
    renderTree();
    renderCode();
    scrollTreeToActive();
    if (scroll) codeEl.scrollTop = 0;
  }

  function renderExec() {
    if (!execEl) return;
    if (!exec || !exec.file) {
      execEl.hidden = true;
      execEl.innerHTML = '';
      return;
    }
    execEl.hidden = false;
    execEl.innerHTML =
      `<span class="exec-dot"></span>` +
      `<b>${esc(exec.fn || exec.file)}</b>` +
      (exec.line ? `<span class="exec-line">:${exec.line}</span>` : '') +
      (exec.tick != null ? `<span class="exec-tick">t${exec.tick}</span>` : '') +
      (exec.sourceLine ? `<span class="exec-src">↳ main.tp:${exec.sourceLine}</span>` : '');
    execEl.title = exec.sourceLine
      ? `${exec.file}:${exec.line} ← generated from main.tp line ${exec.sourceLine}`
      : `${exec.file}:${exec.line}`;
  }

  function emitSourceLine() {
    if (onSourceLine) onSourceLine(exec ? exec.sourceLine : null);
  }

  /**
   * Choose the command that best represents "the line currently executing".
   * The real trace ends every tick in `tp:tick` bookkeeping and may pass through
   * `tp:main/dispatch`; prefer the last real state-machine / stdlib command, and
   * among those prefer one that maps back to a user source line.
   * Returns { file, line, fn, tick, sourceLine } or null.
   */
  function pickExecuting(events) {
    const isTimeline = (fn) => /^tp:main\/s\d+/.test(fn || '')
      || /^tp:snippet\//.test(fn || '')
      || /^tp:fn\//.test(fn || '');

    let lastAny = null;
    let lastTimeline = null;
    let lastDirect = null;
    let lastDirectTimeline = null;

    for (const ev of events || []) {
      if (!ev || ev.type !== 'command' || !ev.file) continue;
      lastAny = ev;
      const direct = directSourceLine(files, ev.file, ev.line);
      if (direct != null) lastDirect = { ev, direct };
      if (!isTimeline(ev.fn)) continue;
      lastTimeline = ev;
      if (direct != null) lastDirectTimeline = { ev, direct };
    }

    // Prefer a command that *directly* follows a `# source line` comment:
    // that is the user statement, not loop bookkeeping at the end of a state.
    let chosen = null;
    if (lastDirectTimeline) chosen = { ev: lastDirectTimeline.ev, direct: lastDirectTimeline.direct };
    else if (lastTimeline) chosen = { ev: lastTimeline, direct: null };
    else if (lastDirect) chosen = { ev: lastDirect.ev, direct: lastDirect.direct };
    else if (lastAny) chosen = { ev: lastAny, direct: null };
    if (!chosen) return null;

    return {
      file: chosen.ev.file,
      line: chosen.ev.line,
      fn: chosen.ev.fn,
      tick: chosen.ev.tick,
      sourceLine: chosen.direct
        ?? directSourceLine(files, chosen.ev.file, chosen.ev.line)
        ?? looseSourceLine(files, chosen.ev.file, chosen.ev.line),
    };
  }

  const api = {
    setFiles(nextFiles, meta) {
      files = nextFiles || {};
      currentPath = null;
      expanded.clear();
      const preferred = 'data/tp/function/tick.mcfunction';
      const first = files[preferred] != null
        ? preferred
        : Object.keys(files).find((p) => p.endsWith('.mcfunction'))
          || Object.keys(files).find((p) => p.endsWith('.json'))
          || Object.keys(files)[0];
      if (first) viewFile(first);
      else renderTree();
      if (meta) api.setMeta(meta);
      emitSourceLine();
    },

    setPrelude(text) {
      prelude = typeof text === 'string' ? text : '';
      renderTree();
    },

    viewFile,

    pickExecuting,

    setExecuting(nextExec, { follow = false } = {}) {
      if (nextExec && nextExec.file) {
        exec = {
          ...nextExec,
          sourceLine: nextExec.sourceLine
            ?? directSourceLine(files, nextExec.file, nextExec.line)
            ?? looseSourceLine(files, nextExec.file, nextExec.line),
        };
        expandAncestors(nextExec.file);
      } else {
        exec = null;
      }
      renderExec();
      if (exec && follow && exec.file && currentPath !== exec.file && files[exec.file] != null) {
        viewFile(exec.file);
      } else {
        applyExecHighlight(true);
      }
      emitSourceLine();
    },

    clearExecuting() {
      exec = null;
      renderExec();
      applyExecHighlight(false);
      emitSourceLine();
    },

    setMeta(meta) {
      if (packMetaEl && meta) {
        const states = meta.stateCount != null ? `${meta.stateCount} states` : '';
        const fns = meta.functionCount != null ? `${meta.functionCount} fns` : '';
        packMetaEl.textContent = [states, fns].filter(Boolean).join(' · ');
      }
    },

    currentFile: () => currentPath,
    currentText() {
      if (currentPath === '__prelude__') return prelude;
      return currentPath ? files[currentPath] || '' : '';
    },
    reset() {
      files = {};
      currentPath = null;
      expanded.clear();
      renderTree();
      codeEl.innerHTML = '<div class="code-empty">press ▶ Run to compile</div>';
      pathEl.textContent = '—';
      pathEl.classList.remove('readonly');
      api.clearExecuting();
      if (packMetaEl) packMetaEl.textContent = '';
    },
  };

  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const text = api.currentText();
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = 'copied ✓';
        setTimeout(() => { copyBtn.textContent = 'copy'; }, 1200);
      } catch {
        copyBtn.textContent = 'copy failed';
        setTimeout(() => { copyBtn.textContent = 'copy'; }, 1200);
      }
    });
  }

  api.reset();
  return api;
}
