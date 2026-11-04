// main.tpk source editor: transparent textarea over a syntax-highlighted <pre>.
// Line numbers, error markers, smart Enter indentation, Tab = 2 spaces, Ctrl+Enter run.

import { clamp, esc } from './util.js';

const KEYWORDS = new Set([
  'state', 'fn', 'tick', 'when', 'press', 'over', 'wait', 'if', 'else',
  'as', 'say', 'run', 'now', 'and', 'or', 'not',
]);

const BUILTINS = new Set([
  'walk', 'walk2', 'turn', 'plot', 'plot_under', 'stamp', 'clear_ground', 'home',
]);

const BLOCKISH = /(_block|_wool|_planks|_glass|_terracotta|_concrete|_log|_ore|_stairs|_slab)$/;

const LINE_HEIGHT = 21; // must match --code-line-height in style.css

// One pass tokenizer per line. Groups: comment, string, $param, number,
// identifier, brace/paren, operator, whitespace.
const TOKEN_RE = /(#[^\n]*)|("(?:[^"\\]|\\.)*")|(\$[A-Za-z_]\w*)|(\b\d+\b)|([A-Za-z_]\w*)|([{}()[\],;:])|([+\-*/%<>=!]+)|([ \t]+)/g;

function scanDeclarations(source) {
  const fns = new Set();
  const states = new Set();
  const loops = new Set();
  let m;
  const fnRe = /\bfn\s+([A-Za-z_]\w*)/g;
  while ((m = fnRe.exec(source))) fns.add(m[1]);
  const stateRe = /\bstate\s+([A-Za-z_]\w*)/g;
  while ((m = stateRe.exec(source))) states.add(m[1]);
  const loopRe = /\bover\b[^\n{]*?\bas\s+([A-Za-z_]\w*)/g;
  while ((m = loopRe.exec(source))) loops.add(m[1]);
  return { fns, states, loops };
}

/** Returns the raw tokens for one line as [text, className] pairs. */
function tokenizeLine(line, decl) {
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  let lastIndex = 0;
  while ((m = TOKEN_RE.exec(line))) {
    if (m.index > lastIndex) out.push([line.slice(lastIndex, m.index), 't']);
    lastIndex = m.index + m[0].length;
    const [raw] = m;
    if (m[1]) {
      out.push([raw, 'c']);
    } else if (m[2]) {
      out.push([raw, 's']);
    } else if (m[3]) {
      out.push([raw, 'param']);
    } else if (m[4]) {
      out.push([raw, 'n']);
    } else if (m[5]) {
      const word = m[5];
      let cls = 't';
      if (KEYWORDS.has(word)) cls = 'k';
      else if (BUILTINS.has(word)) cls = 'b';
      else if (decl.states.has(word)) cls = 'v';
      else if (decl.loops.has(word)) cls = 'v';
      else if (decl.fns.has(word)) cls = 'f';
      else if (BLOCKISH.test(word)) cls = 'bn';
      out.push([word, cls]);
    } else if (m[6]) {
      out.push([raw, 'p']);
    } else if (m[7]) {
      out.push([raw, 'o']);
    } else {
      out.push([raw, 't']);
    }
  }
  if (lastIndex < line.length) out.push([line.slice(lastIndex), 't']);
  return out;
}

export function createEditor({ textarea, highlight, gutter, diagEl, onChange, onRun }) {
  let value = '';
  let diagnostics = [];
  let lineEls = [];
  let gutterEls = [];
  let activeLine = 1;
  let lockedLine = null;

  const diagByLine = new Map();

  function render() {
    const lines = value.split('\n');
    const decl = scanDeclarations(value);
    if (lockedLine != null && lockedLine > lines.length) lockedLine = null;

    diagByLine.clear();
    for (const d of diagnostics) {
      if (!diagByLine.has(d.line)) diagByLine.set(d.line, d.severity || 'error');
    }

    lineEls = [];
    gutterEls = [];
    const html = [];
    const gutterHtml = [];
    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const cls = ['hl-line'];
      if (diagByLine.has(lineNo)) cls.push(diagByLine.get(lineNo) === 'warning' ? 'has-warning' : 'has-error');
      if (lineNo === activeLine) cls.push('active');
      if (lineNo === lockedLine) cls.push('src-lock');
      let inner = '';
      for (const [text, kind] of tokenizeLine(lines[i], decl)) {
        inner += kind === 't' ? esc(text) : `<span class="tk-${kind}">${esc(text)}</span>`;
      }
      if (!inner) inner = ' ';
      html.push(`<span class="${cls.join(' ')}">${inner}</span>`);

      const gCls = ['gutter-line'];
      if (lineNo === activeLine) gCls.push('active');
      if (lineNo === lockedLine) gCls.push('lock');
      if (diagByLine.has(lineNo)) gCls.push(diagByLine.get(lineNo) === 'warning' ? 'warn' : 'err');
      gutterHtml.push(`<div class="${gCls.join(' ')}">${lineNo}</div>`);
    }

    highlight.innerHTML = html.join('');
    gutter.innerHTML = gutterHtml.join('');
    lineEls = [...highlight.children];
    gutterEls = [...gutter.children];
    renderDiagnostics();
    syncScroll();
  }

  function renderDiagnostics() {
    if (!diagEl) return;
    if (!diagnostics.length) {
      diagEl.hidden = true;
      diagEl.innerHTML = '';
      return;
    }
    diagEl.hidden = false;
    diagEl.innerHTML = diagnostics.map((d) => {
      const sev = d.severity === 'warning' ? 'warning' : 'error';
      return `<button class="diag diag-${sev}" data-line="${d.line || 1}" title="跳到第 ${d.line} 行">
        <span class="diag-line">${d.line != null ? d.line : '?'}</span>
        <span class="diag-sev">${sev === 'warning' ? '警告' : '错误'}</span>
        <span class="diag-msg">${esc(d.message)}</span>
      </button>`;
    }).join('');
    diagEl.querySelectorAll('.diag').forEach((btn) => {
      btn.addEventListener('click', () => revealLine(Number(btn.dataset.line)));
    });
  }

  function syncScroll() {
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
    gutter.scrollTop = textarea.scrollTop;
  }

  function setActiveLine(line) {
    if (line === activeLine) return;
    const prev = activeLine;
    activeLine = line;
    if (lineEls[prev - 1]) lineEls[prev - 1].classList.remove('active');
    if (gutterEls[prev - 1]) gutterEls[prev - 1].classList.remove('active');
    if (lineEls[line - 1]) lineEls[line - 1].classList.add('active');
    if (gutterEls[line - 1]) gutterEls[line - 1].classList.add('active');
  }

  function caretLine() {
    const pos = textarea.selectionStart || 0;
    return value.slice(0, pos).split('\n').length;
  }

  function revealLine(line) {
    const lines = value.split('\n');
    const idx = clamp(line - 1, 0, lines.length - 1);
    const start = lines.slice(0, idx).reduce((acc, l) => acc + l.length + 1, 0);
    const end = start + (lines[idx] || '').length;
    textarea.focus();
    textarea.setSelectionRange(start, end);
    const target = idx * LINE_HEIGHT - textarea.clientHeight / 2 + LINE_HEIGHT;
    textarea.scrollTop = Math.max(0, target);
    syncScroll();
    setActiveLine(idx + 1);
  }

  function insertText(text, cursorBack = 0) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    textarea.setRangeText(text, start, end, 'end');
    if (cursorBack) textarea.setSelectionRange(start + text.length - cursorBack, start + text.length - cursorBack);
    value = textarea.value;
    render();
    onChange && onChange(value);
  }

  textarea.addEventListener('input', () => {
    value = textarea.value;
    activeLine = caretLine();
    render();
    onChange && onChange(value);
  });

  textarea.addEventListener('scroll', syncScroll, { passive: true });

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) {
        // dedent current line by up to 2 spaces
        const pos = textarea.selectionStart;
        const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
        const head = value.slice(lineStart, lineStart + 2);
        const strip = head.match(/^ +/);
        if (strip) {
          textarea.setSelectionRange(lineStart, lineStart + strip[0].length);
          textarea.setRangeText('', lineStart, lineStart + strip[0].length, 'end');
          value = textarea.value;
          render();
          onChange && onChange(value);
        }
        return;
      }
      insertText('  ');
      return;
    }
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      const pos = textarea.selectionStart;
      const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
      const lineHead = value.slice(lineStart, pos);
      const indent = (lineHead.match(/^[ \t]*/) || [''])[0];
      const trimmed = lineHead.trimEnd();
      const opensBlock = /[{[]$/.test(trimmed);
      const extra = opensBlock ? '  ' : '';
      e.preventDefault();
      insertText('\n' + indent + extra);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      onRun && onRun();
    }
  });

  textarea.addEventListener('keyup', () => setActiveLine(caretLine()));
  textarea.addEventListener('click', () => setActiveLine(caretLine()));

  // Only paint the caret line while the editor actually has focus — otherwise a
  // first-paint "line 1 highlight" looks like a bug.
  const editorEl = typeof textarea.closest === 'function' ? textarea.closest('.editor') : null;
  if (editorEl) {
    textarea.addEventListener('focus', () => editorEl.classList.add('focused'));
    textarea.addEventListener('blur', () => editorEl.classList.remove('focused'));
  }

  const api = {
    getValue: () => value,
    setValue(next, { silent = false } = {}) {
      value = next;
      textarea.value = next;
      textarea.scrollTop = 0;
      activeLine = 1;
      lockedLine = null;
      render();
      if (!silent) onChange && onChange(value);
    },
    setDiagnostics(list) {
      diagnostics = Array.isArray(list) ? list : [];
      render();
    },
    /**
     * Highlight the user source line that produced the currently executing
     * command. Never moves the caret. `scroll` gently follows the line while a
     * run is playing; typing always wins.
     */
    setSourceLine(line, { scroll = false } = {}) {
      const total = value.split('\n').length;
      const next = line == null || !Number.isFinite(line) ? null : clamp(line | 0, 1, total);
      if (next === lockedLine) return;
      const prev = lockedLine;
      lockedLine = next;
      if (prev && lineEls[prev - 1]) lineEls[prev - 1].classList.remove('src-lock');
      if (prev && gutterEls[prev - 1]) gutterEls[prev - 1].classList.remove('lock');
      if (next) {
        if (lineEls[next - 1]) lineEls[next - 1].classList.add('src-lock');
        if (gutterEls[next - 1]) gutterEls[next - 1].classList.add('lock');
      }
      if (next && scroll && document.activeElement !== textarea) {
        const top = (next - 1) * LINE_HEIGHT;
        const viewTop = textarea.scrollTop;
        const viewH = textarea.clientHeight;
        if (top < viewTop + 4 || top > viewTop + viewH - LINE_HEIGHT * 2.5) {
          textarea.scrollTop = Math.max(0, top - viewH * 0.36);
          syncScroll();
        }
      }
    },
    revealLine,
    focus: () => textarea.focus(),
    lineCount: () => value.split('\n').length,
  };

  value = textarea.value || '';
  render();
  return api;
}
