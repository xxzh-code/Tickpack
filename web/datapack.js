// Generated datapack browser: a compact, collapsible file tree + read-only line
// view. The shell hands it the session's current `exec`
// ({file,line,fn,tick,sourceLine}); this module only renders it — trace→source
// mapping and onboarding rules belong to the core session.

import { esc, flashButtonLabel, icon } from './util.js';

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

export function createDatapack({ treeEl, pathEl, codeEl, execEl, packMetaEl, copyBtn, copyText, onSourceLine }) {
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
        row.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        row.innerHTML = `<span class="tw">${icon(isOpen ? 'chevron-down' : 'chevron-right', 'tree-caret')}</span><span class="tname">${esc(child.name)}</span>`;
        row.title = isOpen ? `收起 ${child.short}/` : `展开 ${child.short}/`;
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
        row.innerHTML = `<span class="ext ext-${ext}">${icon('file', 'tree-file-icon')}</span><span class="tname">${esc(f.name)}</span>`;
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
      row.title = '标准库 —— 只读，编译时会自动拼在程序前面';
      row.innerHTML = `<span class="ext ext-txt">${icon('book-open', 'tree-file-icon')}</span><span class="tname">prelude.tpk</span><span class="ro">标准库</span>`;
      row.addEventListener('click', () => viewFile('__prelude__'));
      frag.append(row);
      treeRows.push(row);
    }

    treeEl.innerHTML = '';
    treeEl.appendChild(frag);
    treeEl.scrollTop = scrollTop;

    if (packMetaEl) {
      const count = Object.keys(files).length;
      packMetaEl.textContent = count ? `${count} 个文件` : '';
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
      codeEl.innerHTML = '<div class="code-empty">选择一个文件</div>';
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
    pathEl.textContent = path === '__prelude__' ? 'stdlib/prelude.tpk' : path;
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
      execEl.removeAttribute('aria-label');
      delete execEl.dataset.tick;
      delete execEl.dataset.sourceLine;
      return;
    }
    execEl.hidden = false;
    execEl.innerHTML =
      `<span class="exec-dot"></span>` +
      `<b>${esc(exec.fn || exec.file)}</b>` +
      (exec.line ? `<span class="exec-line">:${exec.line}</span>` : '') +
      (exec.tick != null ? `<span class="exec-tick">t${exec.tick}</span>` : '') +
      (exec.sourceLine ? `<span class="exec-src">↳ main.tpk:${exec.sourceLine}</span>` : '');
    execEl.title = exec.sourceLine
      ? `${exec.file}:${exec.line} ← 来自源码第 ${exec.sourceLine} 行（点击定位）`
      : `${exec.file}:${exec.line}（点击定位）`;
    execEl.setAttribute('aria-label', exec.sourceLine
      ? `定位执行位置 ${exec.file}:${exec.line}，源码第 ${exec.sourceLine} 行`
      : `定位执行位置 ${exec.file}:${exec.line}`);
    if (exec.tick != null) execEl.dataset.tick = String(exec.tick);
    else delete execEl.dataset.tick;
    if (exec.sourceLine != null) execEl.dataset.sourceLine = String(exec.sourceLine);
    else delete execEl.dataset.sourceLine;
  }

  function emitSourceLine() {
    if (onSourceLine) onSourceLine(exec ? exec.sourceLine : null);
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

    /**
     * Show the session's current executing command. The core already chose it
     * and computed `sourceLine`; this module trusts that data and only renders.
     */
    setExecuting(nextExec, { follow = false } = {}) {
      if (nextExec && nextExec.file) {
        exec = { ...nextExec };
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

    getExecuting() {
      return exec ? { ...exec } : null;
    },

    setMeta(meta) {
      if (packMetaEl && meta) {
        const states = meta.stateCount != null ? `${meta.stateCount} 个状态` : '';
        const fns = meta.functionCount != null ? `${meta.functionCount} 个函数` : '';
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
      codeEl.innerHTML = '<div class="code-empty">按「运行」编译</div>';
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
      let delivered = false;
      try {
        delivered = copyText ? await copyText(text) : false;
      } catch {
        delivered = false;
      }
      flashButtonLabel(copyBtn, delivered ? '已复制 ✓' : '复制失败', { iconName: 'copy' });
    });
  }

  api.reset();
  return api;
}
