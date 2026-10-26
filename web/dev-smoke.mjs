// TEMPORARY Node smoke harness (delete before finishing).
// Builds the smallest DOM stubs the app touches, boots app.js against the dev
// fixture, drives synthetic animation frames and exercises the controls.
// Run: node web/dev-smoke.mjs

/* eslint-disable no-console */

function makeClassList() {
  const set = new Set();
  return {
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    contains: (n) => set.has(n),
    toggle: (n, force) => {
      const want = force == null ? !set.has(n) : !!force;
      if (want) set.add(n);
      else set.delete(n);
      return want;
    },
    _set: set,
  };
}

function makeEl(tag = 'div', id = '') {
  const el = {
    tagName: String(tag).toUpperCase(),
    id,
    className: '',
    hidden: false,
    disabled: false,
    title: '',
    value: '',
    textContent: '',
    _html: '',
    dataset: {},
    style: {
      setProperty(k, v) { this[k] = v; },
      removeProperty(k) { delete this[k]; },
    },
    classList: makeClassList(),
    children: [],
    selectionStart: 0,
    selectionEnd: 0,
    scrollTop: 0,
    scrollLeft: 0,
    clientHeight: 320,
    offsetWidth: 100,
    offsetHeight: 18,
    offsetTop: 0,
    _listeners: {},
    _q: new Map(),
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    removeEventListener() {},
    appendChild(child) {
      if (child && child._isFragment) {
        for (const c of child.children) this.children.push(c);
      } else if (child) {
        this.children.push(child);
      }
      return child;
    },
    append(...kids) { kids.forEach((k) => this.appendChild(k)); },
    querySelector(sel) {
      if (!this._q.has(sel)) this._q.set(sel, makeEl('div'));
      return this._q.get(sel);
    },
    querySelectorAll() { return []; },
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    focus() {},
    blur() {},
    click() {
      for (const fn of this._listeners.click || []) fn({ target: this, preventDefault() {} });
    },
    scrollIntoView() {},
    animate() { return { cancel() {} }; },
    getBoundingClientRect() {
      return { width: 440, height: 430, top: 0, left: 0, right: 440, bottom: 430 };
    },
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
    setRangeText(text, start, end, mode) {
      const v = this.value || '';
      this.value = v.slice(0, start) + text + v.slice(end);
      if (mode === 'end') {
        this.selectionStart = this.selectionEnd = start + text.length;
      }
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) {
      this._html = String(v);
      this.children = [];
      if (!v) this.textContent = '';
    },
  });
  Object.defineProperty(el, 'offsetWidth', {
    get() { return 100; },
  });
  return el;
}

const ids = [
  'sample-select', 'btn-run', 'btn-pause', 'btn-step', 'btn-reset', 'speed', 'speed-out',
  'stat-tick', 'stat-blocks', 'state-led', 'stat-phase', 'mode-chip',
  'source', 'highlight', 'gutter', 'diagnostics', 'editor-meta', 'dirty-badge',
  'world', 'world-chip', 'pen-readout', 'scores-grid', 'scores-foot', 'btn-press',
  'file-tree', 'file-path', 'code-view', 'exec-badge', 'pack-meta', 'btn-copy',
  'timeline-canvas', 'tick-label', 'btn-back', 'btn-fwd', 'toast',
];

const ctxStub = new Proxy({}, {
  get(target, prop) {
    if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
      return () => ({ addColorStop() {} });
    }
    if (prop === 'measureText') return () => ({ width: 12 });
    if (prop === 'canvas') return {};
    if (typeof prop === 'string') {
      target[prop] = target[prop] || (() => {});
      return target[prop];
    }
    return undefined;
  },
  set(target, prop, value) { target[prop] = value; return true; },
});

const elements = new Map();
for (const id of ids) {
  const isCanvas = id === 'world' || id.includes('canvas');
  const el = makeEl(isCanvas ? 'canvas' : id === 'source' ? 'textarea' : 'div', id);
  if (isCanvas) {
    el.getContext = () => ctxStub;
    el.parentElement = id === 'world' ? { getBoundingClientRect: () => ({ width: 440, height: 430 }) } : null;
    if (id === 'timeline-canvas') {
      el.getBoundingClientRect = () => ({ width: 1200, height: 62, top: 0, left: 0 });
    }
  }
  elements.set(id, el);
}

const documentStub = {
  activeElement: null,
  getElementById: (id) => elements.get(id) || null,
  createElement: (tag) => makeEl(tag),
  createDocumentFragment() {
    const frag = makeEl('fragment');
    frag._isFragment = true;
    return frag;
  },
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  body: makeEl('body'),
  documentElement: makeEl('html'),
};

globalThis.document = documentStub;
try { globalThis.navigator.clipboard = { writeText: async () => {} }; } catch { /* node 24 navigator is read-only */ }
globalThis.location = { search: '' };
globalThis.window = {
  addEventListener() {},
  matchMedia: () => ({ matches: false }),
  setTimeout,
  clearTimeout,
  devicePixelRatio: 1,
  location: { search: '' },
  requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
  cancelAnimationFrame() {},
  __tickpack: null,
};
globalThis.requestAnimationFrame = window.requestAnimationFrame;
globalThis.ResizeObserver = class {
  constructor(cb) { this.cb = cb; }
  observe() { this.cb(); }
  unobserve() {}
  disconnect() {}
};

const frames = [];

// ---- boot the app with the dev fixture
const fixture = await import('./dev-fixture.js');
const { startApp } = await import('./app.js');
startApp(fixture, { mode: 'fixture' });

const debug = window.__tickpack;
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1; };
const ok = (msg) => console.log('ok  -', msg);

function frame(ts) {
  const cb = frames.shift();
  if (!cb) throw new Error('no frame scheduled');
  // keep timestamps monotonic: window.requestAnimationFrame captured into frames
  cb(ts);
}

let t = 0;
for (let i = 0; i < 240; i++) {
  t += 16.7;
  frame(t);
}

console.log('phase:', debug.state.phase, 'tick:', elements.get('stat-tick').textContent,
  'blocks:', elements.get('stat-blocks').textContent,
  'snapshots:', debug.snapshots.length,
  'exec:', elements.get('exec-badge')._html.slice(0, 80));

if (debug.state.phase !== 'finished') fail(`expected finished, got ${debug.state.phase}`);
else ok('square sample ran to completion');
if (Number(elements.get('stat-blocks').textContent) !== 16) fail(`expected 16 blocks, got ${elements.get('stat-blocks').textContent}`);
else ok('16 blocks drawn');
if (debug.snapshots.length < 16) fail(`expected >=16 snapshots, got ${debug.snapshots.length}`);
else ok('per-tick snapshots recorded');
const firstSnap = debug.snapshots[0];
if (!firstSnap || !firstSnap.snap) fail('snapshot 0 missing');
else ok('snapshot 0 present');

// ---- rewind via the debug hook
debug.seekTo(4);
const tickEl = elements.get('stat-tick');
if (elements.get('stat-tick').textContent !== '4') fail(`seekTo(4) -> tick ${elements.get('stat-tick').textContent}`);
else ok('seek restores tick 4');
if (Number(elements.get('stat-blocks').textContent) !== 4) fail(`seek(4) blocks ${elements.get('stat-blocks').textContent}`);
else ok('world restored on seek');

// ---- scrub to zero
debug.seekTo(0);
if (Number(elements.get('stat-blocks').textContent) !== 0) fail('seek(0) should clear world');
else ok('rewind to tick 0 clears the world');

// ---- replay from 0
debug.play();
for (let i = 0; i < 60; i++) { t += 16.7; frame(t); }
if (elements.get('stat-tick').textContent === '0') fail('replay did not advance');
else ok(`replay advanced to tick ${elements.get('stat-tick').textContent}`);

// ---- reset
debug.doReset();
if (debug.state.phase !== 'paused') fail(`reset phase ${debug.state.phase}`);
else ok('reset pauses at tick 0');
if (Number(elements.get('stat-blocks').textContent) !== 0) fail('reset should clear blocks');
else ok('reset clears blocks');

// ---- run button recompiles
elements.get('btn-run').click();
for (let i = 0; i < 40; i++) { t += 16.7; frame(t); }
if (Number(elements.get('stat-tick').textContent) === 0) fail('run button did not play');
else ok(`run button plays (tick ${elements.get('stat-tick').textContent})`);

// ---- pause + step
elements.get('btn-pause').click();
const pausedTick = Number(elements.get('stat-tick').textContent);
elements.get('btn-step').click();
if (Number(elements.get('stat-tick').textContent) <= pausedTick) fail('step did not advance');
else ok('step advances one tick');

// ---- sample switch (spiral)
const select = elements.get('sample-select');
select.value = 'spiral';
for (const fn of select._listeners.change || []) fn({ target: select });
for (let i = 0; i < 120; i++) { t += 16.7; frame(t); }
if (Number(elements.get('stat-tick').textContent) < 5) fail('spiral sample did not run');
else ok(`spiral sample plays (tick ${elements.get('stat-tick').textContent})`);

// ---- source-line lockstep callback
const code = elements.get('code-view');
const srcLine = debug.state.lastCmd;
console.log('lastCmd:', srcLine && `${srcLine.file}:${srcLine.line}`, 'sourceLine map should show in exec badge:',
  elements.get('exec-badge')._html.includes('main.tp:'));
if (!elements.get('exec-badge')._html) fail('no executing badge');
else ok('executing badge renders');

// ---- speed + press
elements.get('speed').value = '60';
for (const fn of elements.get('speed')._listeners.input || []) fn({});
elements.get('btn-press').click();
ok('speed slider + press do not throw');

// ---- compile error path
const source = elements.get('source');
source.value = 'over 4 as i {\n  bogus()\n}';
source._listeners.input.forEach((fn) => fn({}));
const origCompile = fixture.compile;
// fine: fixture always compiles; just make sure editing shows the dirty badge
if (elements.get('dirty-badge').hidden === false) ok('dirty badge appears after edit');
else fail('dirty badge did not appear');

console.log(process.exitCode ? '\nSMOKE: FAILED' : '\nSMOKE: PASSED');
