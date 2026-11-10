// Tickpack browser shell.
//
// This module is SHELL LAYER: it owns rendering, playback timing (rAF/speed),
// DOM events, workspace layout, query params and toasts. The run itself —
// compile, simulator, snapshots, cursor/seek, completion rules, trace→source
// mapping, export bytes — lives in the host-agnostic core session
// (src/session.js), reached here through src/api.js only. Platform side effects
// (download / import / clipboard / persistence) go through the web host adapter
// (./host-web.js), never directly from here.

import { createEditor } from './editor.js';
import { createWorld } from './world.js';
import { createDatapack } from './datapack.js';
import { createTimeline } from './timeline.js';
import { createLayout, PANEL_DEFS } from './layout.js';
import { createWebHost } from './host-web.js';
import { resolveInitialTheme, applyTheme, persistTheme } from './theme.js';
import { blockColor } from './blocks.js';
import { clamp, esc, fmtInt, icon, prefersReducedMotion, showToast } from './util.js';

const DEFAULT_SPEED = 10;
const ZIP_FILENAME = 'tickpack-datapack.zip';
const SHARE_VERSION = '1';
const SHARE_MAX_CHARS = 10000;
const DRAFT_KEY = 'tickpack.draft.v1';
const DRAFT_DEBOUNCE_MS = 500;
const PHASE_LABEL = {
  idle: '空闲',
  running: '运行中',
  paused: '已暂停',
  finished: '已完成',
  error: '错误',
};

function parseQueryInt(q, key) {
  if (!q.has(key)) return null;
  const raw = q.get(key);
  if (raw === '' || raw == null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

export function startApp(api) {
  const TickpackSession = api.TickpackSession;
  const SAMPLES = Array.isArray(api.SAMPLES) ? api.SAMPLES : [];
  const PRELUDE = typeof api.PRELUDE === 'string' ? api.PRELUDE : '';
  const MAX_SNAPSHOTS = Number.isFinite(api.MAX_SNAPSHOTS) ? api.MAX_SNAPSHOTS : 2000;
  // Core owns the onboarding-chatter rule; the shell only asks it.
  const isOnboardingSay = typeof api.isOnboardingSay === 'function' ? api.isOnboardingSay : () => false;

  // ------------------------------------------------------------------ DOM
  const byId = (id) => document.getElementById(id);
  const dom = {
    sampleSelect: byId('sample-select'),
    run: byId('btn-run'),
    pause: byId('btn-pause'),
    step: byId('btn-step'),
    reset: byId('btn-reset'),
    speed: byId('speed'),
    speedOut: byId('speed-out'),
    statTick: byId('stat-tick'),
    statBlocks: byId('stat-blocks'),
    stateLed: byId('state-led'),
    statPhase: byId('stat-phase'),
    source: byId('source'),
    highlight: byId('highlight'),
    gutter: byId('gutter'),
    diagnostics: byId('diagnostics'),
    editorMeta: byId('editor-meta'),
    dirtyBadge: byId('dirty-badge'),
    canvas: byId('world'),
    worldChip: byId('world-chip'),
    penReadout: byId('pen-readout'),
    viewReadout: byId('view-readout'),
    fit: byId('btn-fit'),
    zoomIn: byId('btn-zoom-in'),
    zoomOut: byId('btn-zoom-out'),
    scoresGrid: byId('scores-grid'),
    scoresFoot: byId('scores-foot'),
    press: byId('btn-press'),
    tree: byId('file-tree'),
    filePath: byId('file-path'),
    codeView: byId('code-view'),
    execBadge: byId('exec-badge'),
    packMeta: byId('pack-meta'),
    copy: byId('btn-copy'),
    zip: byId('btn-zip'),
    consoleLines: byId('console-lines'),
    consoleMeta: byId('console-meta'),
    sampleDesc: byId('sample-desc'),
    sampleDescText: byId('sample-desc-text'),
    timelineCanvas: byId('timeline-canvas'),
    tickLabel: byId('tick-label'),
    back: byId('btn-back'),
    fwd: byId('btn-fwd'),
    theme: byId('btn-theme'),
    sound: byId('btn-sound'),
    importBtn: byId('btn-import'),
    exportBtn: byId('btn-export'),
    workspace: byId('workspace'),
    tabs: byId('tabs'),
    newTab: byId('btn-new-tab'),
    resetLayout: byId('btn-reset-layout'),
    panelBank: byId('panel-bank'),
    share: byId('btn-share'),
    theaterEdit: byId('btn-theater-edit'),
    theaterHandle: byId('theater-handle'),
    theaterBackdrop: byId('theater-backdrop'),
    sourceCollapse: byId('btn-source-collapse'),
    shareNotice: byId('share-notice'),
    shareNoticeText: byId('share-notice-text'),
    shareNoticeClose: byId('share-notice-close'),
    editorFile: byId('editor-file'),
    actionToast: byId('action-toast'),
    actionToastText: byId('action-toast-text'),
    actionToastActions: byId('action-toast-actions'),
  };

  // ---------------------------------------------------------------- state
  // Shell-only state. Anything about "the run" lives in `session`.
  const state = {
    source: '',
    compiledSource: '',
    playing: false,
    phase: 'idle',
    speed: DEFAULT_SPEED,
    acc: 0,
    lastTs: 0,
    dirty: false,
    lastSay: '',
    scoreRows: [],
    sampleId: null,
    logCount: 0,
    theme: 'dark',
    sound: true,
    lastSoundTick: -1,
  };

  const q = new URLSearchParams(location.search);
  const isTheater = q.get('view') === 'theater';
  const SHARE_V = q.get('v');
  document.documentElement.dataset.view = isTheater ? 'theater' : 'app';
  document.body.dataset.sourceOpen = 'false';
  const session = new TickpackSession();
  const host = createWebHost();
  try { state.sound = host.storageGet('tickpack.sound') !== '0'; } catch { state.sound = true; }
  if (host.sound !== true) state.sound = false;

  // Theme first (before any panel paints): URL override wins, then persisted
  // preference, then prefers-color-scheme. Only user toggles persist.
  const initialTheme = resolveInitialTheme(host, q.get('theme'));
  state.theme = applyTheme(initialTheme.theme);

  // --------------------------------------------------------------- modules
  const world = createWorld(dom.canvas, { onCamera: updateViewReadout });
  world.setTheme(state.theme);
  const editor = createEditor({
    textarea: dom.source,
    highlight: dom.highlight,
    gutter: dom.gutter,
    diagEl: dom.diagnostics,
    onChange: onSourceChange,
    onRun: () => startRun({ autoPlay: true }),
  });
  const datapack = createDatapack({
    treeEl: dom.tree,
    pathEl: dom.filePath,
    codeEl: dom.codeView,
    execEl: dom.execBadge,
    packMetaEl: dom.packMeta,
    copyBtn: dom.copy,
    copyText: (text) => host.copyText(text),
    // keep the editor cursor still, but let the author's eye follow the tick
    onSourceLine: (line) => editor.setSourceLine(line, { scroll: state.playing }),
  });
  const timeline = createTimeline({
    canvas: dom.timelineCanvas,
    labelEl: dom.tickLabel,
    onSeek: seekTo,
  });
  timeline.setTheme(state.theme);

  // ------------------------------------------------------------- workspace
  const panelNodes = {};
  for (const def of PANEL_DEFS) {
    const node = dom.panelBank.querySelector(`.panel[data-panel-id="${def.id}"]`);
    if (node) panelNodes[def.id] = node;
  }
  const layout = createLayout({
    host,
    workspaceEl: dom.workspace,
    tabsEl: dom.tabs,
    newTabBtn: dom.newTab,
    resetBtn: dom.resetLayout,
    panelNodes,
    onLayoutChange: handleLayoutChange,
    onNotify: (message) => showToast(message, 'ok'),
    onReset: (previous) => {
      showActionToast('layout', '已重置为默认布局', [
        {
          label: '撤销',
          action: () => {
            layout.restoreLayout(previous);
            // The toast button disappears with the toast; keep keyboard focus
            // on a stable, visible control instead of dropping it to <body>.
            if (dom.resetLayout && typeof dom.resetLayout.focus === 'function') dom.resetLayout.focus();
          },
        },
      ], 5000);
    },
  });
  layout.init(q.get('tab'));
  if (isTheater) {
    ensureTheaterTab();
    syncTheaterClasses();
  }

  // ------------------------------------------------------------ sample list
  function fillSamples() {
    dom.sampleSelect.innerHTML = '';
    if (!SAMPLES.length) {
      const o = document.createElement('option');
      o.textContent = '没有样例';
      o.disabled = true;
      dom.sampleSelect.appendChild(o);
      return;
    }
    for (const s of SAMPLES) {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.title || s.id;
      dom.sampleSelect.appendChild(o);
    }
  }

  function pickSample(id) {
    if (!SAMPLES.length) return null;
    return SAMPLES.find((s) => s.id === id)
      || SAMPLES.find((s) => s.id === 'square')
      || SAMPLES[0];
  }

  // ------------------------------------------------- kind toast (non-blocking)
  let actionToastTimer = 0;
  let actionToastKind = '';
  function hideActionToast() {
    actionToastKind = '';
    clearTimeout(actionToastTimer);
    actionToastTimer = 0;
    if (dom.actionToast) dom.actionToast.hidden = true;
  }

  function showActionToast(kind, message, actions = [], timeout = 0) {
    if (!dom.actionToast || !dom.actionToastText || !dom.actionToastActions) return;
    clearTimeout(actionToastTimer);
    actionToastKind = kind;
    dom.actionToastText.textContent = message;
    dom.actionToastActions.innerHTML = '';
    for (const item of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-soft btn-sm';
      button.textContent = item.label;
      button.addEventListener('click', (ev) => {
        ev.stopPropagation();
        hideActionToast();
        if (typeof item.action === 'function') item.action();
      });
      dom.actionToastActions.appendChild(button);
    }
    dom.actionToast.hidden = false;
    if (timeout > 0) actionToastTimer = setTimeout(hideActionToast, timeout);
  }

  // -------------------------------------------------------- source drafts
  let draftTimer = 0;
  let draftPending = false;
  let lastSampleValue = '';

  function draftPayload() {
    return {
      version: 1,
      source: editor.getValue(),
      sampleId: state.sampleId,
      cursor: session.ok ? session.cursor : 0,
      savedAt: Date.now(),
    };
  }

  function saveDraftNow() {
    clearTimeout(draftTimer);
    draftTimer = 0;
    draftPending = false;
    if (!host || typeof host.storageSet !== 'function') return;
    try { host.storageSet(DRAFT_KEY, JSON.stringify(draftPayload())); } catch { /* best effort */ }
  }

  function scheduleDraftSave() {
    draftPending = true;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraftNow, DRAFT_DEBOUNCE_MS);
  }

  function clearDraft() {
    clearTimeout(draftTimer);
    draftTimer = 0;
    draftPending = false;
    if (!host || typeof host.storageRemove !== 'function') return;
    try { host.storageRemove(DRAFT_KEY); } catch { /* best effort */ }
  }

  function readDraft() {
    if (!host || typeof host.storageGet !== 'function') return null;
    try {
      const raw = host.storageGet(DRAFT_KEY);
      if (!raw) return null;
      const draft = JSON.parse(raw);
      if (!draft || typeof draft.source !== 'string' || draft.source.length > 500000) return null;
      return draft;
    } catch {
      return null;
    }
  }

  function restoreDraft(draft) {
    if (!draft || typeof draft.source !== 'string') return;
    hideActionToast();
    clearDraft();
    const sample = draft.sampleId ? SAMPLES.find((s) => s.id === draft.sampleId) : null;
    state.sampleId = sample ? sample.id : null;
    if (sample) {
      lastSampleValue = sample.id;
      dom.sampleSelect.value = sample.id;
      applySampleDescription(sample);
    } else {
      applySampleDescription(null);
    }
    editor.setValue(draft.source, { silent: true });
    scheduleDraftSave();
    const ok = startRun({ autoPlay: false });
    if (ok && Number.isFinite(draft.cursor) && draft.cursor > 0) {
      const index = clamp(Math.round(draft.cursor), 0, session.snapshotsCount - 1);
      if (index > 0) seekTo(index);
    }
    saveDraftNow();
    showToast('已恢复上次编辑', 'ok');
  }

  function offerDraftRestore(draft) {
    showActionToast('draft', '发现上次未保存的编辑', [
      { label: '恢复上次编辑', action: () => restoreDraft(draft) },
      { label: '丢弃', action: () => { clearDraft(); showToast('已丢弃草稿'); } },
    ], 12000);
  }

  // ------------------------------------------------------------------ run
  /** Compile failed: make every run-related panel unmistakably empty. */
  function clearRunForCompileError(source, errorHtml) {
    state.source = source;
    state.playing = false;
    state.lastSay = '';
    state.scoreRows = [];
    state.dirty = true;
    dom.dirtyBadge.hidden = false;
    dom.editorMeta.textContent = '';
    dom.scoresGrid.innerHTML = '<div class="scores-empty">编译失败 — 没有可显示的结果</div>';
    dom.scoresFoot.innerHTML = '<span class="muted">修复源码后重新运行</span>';
    world.reset();
    world.setTick(0);
    updatePen();
    updateStatus(0);
    datapack.reset();
    timeline.reset();
    timeline.setData(0, 0);
    resetConsole();
    if (dom.consoleMeta) dom.consoleMeta.textContent = '错误';
    editor.setSourceLine(null);
    updatePressHint({});
    setPhase('error');
    updateWorldChip();
    if (errorHtml) consoleLine(errorHtml, 'log-error');
    world.render(performance.now());
    timeline.render();
    if (draftPending) saveDraftNow();
  }

  function startRun({ autoPlay = true, syncTicks = 0, seekTick = null } = {}) {
    const source = editor.getValue();
    let loaded;
    try {
      loaded = session.load(source);
    } catch (err) {
      console.error('[tickpack] session.load crashed', err);
      editor.setDiagnostics([{ severity: 'error', line: 1, message: String((err && err.message) || err) }]);
      clearRunForCompileError(source, `<span class="log-t">!</span> <span class="log-err">编译崩溃：${esc(err && err.message ? err.message : err)}</span>`);
      showToast(`编译崩溃：${err && err.message ? err.message : err}`, 'error');
      return false;
    }

    state.source = source;
    editor.setDiagnostics(loaded.diagnostics || []);

    if (!loaded.ok) {
      const first = (loaded.diagnostics || [])[0];
      clearRunForCompileError(
        source,
        `<span class="log-t">!</span> <span class="log-err">编译失败${first ? ` · 第 ${first.line} 行：${esc(first.message)}` : ''}</span>`,
      );
      updateWorldChip();
      showToast('编译失败 — 请查看诊断', 'error');
      return false;
    }

    state.compiledSource = source;
    state.dirty = false;
    dom.dirtyBadge.hidden = true;

    datapack.setFiles(loaded.files || {}, loaded.meta);
    if (PRELUDE) datapack.setPrelude(PRELUDE);
    updatePressHint(loaded.files || {});
    buildScorePanel(loaded.meta);
    if (dom.editorMeta && loaded.meta) {
      const fns = loaded.meta.functionCount != null ? `${loaded.meta.functionCount} 个函数` : '';
      const states = loaded.meta.stateCount != null ? `${loaded.meta.stateCount} 个状态` : '';
      dom.editorMeta.textContent = [fns, states].filter(Boolean).join(' · ');
    }

    beginSessionView();
    // a fresh compile always lands in a clean, paused-at-zero state
    state.playing = false;
    setPhase('paused');

    if (syncTicks > 0) {
      for (let i = 0; i < syncTicks && !session.finished; i++) {
        if (!stepCore({ instant: true })) break;
      }
    }
    if (seekTick != null) seekTo(seekTick);

    if (autoPlay) {
      play();
    } else if (state.phase !== 'error') {
      setPhase(session.finished ? 'finished' : 'paused');
    }

    world.render(performance.now());
    timeline.render();
    if (draftPending) saveDraftNow();
    return true;
  }

  /** Reset every panel to the session's current (tick 0) view. */
  function beginSessionView() {
    state.acc = 0;
    state.lastSoundTick = -1;
    timeline.reset();
    world.reset();
    datapack.clearExecuting();
    resetConsole();
    const view = session.view();
    if (view) applyView(view, { instant: true });
    timeline.setData(session.total, session.cursor);
    updateWorldChip();
  }

  /**
   * Paint a non-advancing session view (tick 0, seek/restore, replay frame).
   * `instant` skips pop/particle animation and snaps the fit; `follow` lets the
   * datapack panel switch files (used while replaying).
   */
  function applyView(result, { instant = false, follow = false } = {}) {
    if (!result) return;
    world.setWorld(result.world, { instant });
    world.setTick(result.tick);
    state.lastSay = result.lastSay || '';
    updateScores(result.scores, result.tick);
    updatePen();
    if (result.exec) datapack.setExecuting(result.exec, { follow });
    else datapack.clearExecuting();
    if (session.finished && result.index >= session.snapshotsCount - 1) editor.setSourceLine(null);
    updateStatus(result.tick);
    timeline.setData(session.total, result.index);
    world.requestFit(0, !state.playing);
    updateWorldChip();
  }

  // ------------------------------------------------------------ one tick
  function stepCore({ instant = false, playSounds = false } = {}) {
    if (!session.ok) return false;

    let result;
    try {
      result = session.step();
    } catch (err) {
      console.error('[tickpack] session.step crashed', err);
      state.playing = false;
      setPhase('error');
      updateWorldChip();
      showToast(`模拟器崩溃：${err && err.message ? err.message : err}`, 'error');
      return false;
    }
    if (!result) {
      // session.step() returns null when the snapshot cap is reached (or there
      // is no live run): stop driving playback and keep the existing cap toast.
      state.playing = false;
      if (session.capped) showToast(`已达到快照上限（${MAX_SNAPSHOTS} 个 tick）`, 'error');
      setPhase(session.finished ? 'finished' : 'paused');
      return false;
    }

    world.applyEvents(result.events);
    world.setWorld(result.world, { instant });
    const cmdCount = result.events.reduce((n, e) => n + (e && e.type === 'command' ? 1 : 0), 0);
    if (result.changes.length) {
      timeline.addMark(
        result.tick,
        result.changes.slice(0, 4).map((c) => blockColor(c.block)),
        result.changes.length,
        cmdCount,
      );
    }

    state.lastSay = result.lastSay || '';
    updateScores(result.scores, result.tick);
    world.setTick(result.tick);
    updatePen();

    if (result.exec) {
      datapack.setExecuting(result.exec, { follow: state.playing || instant });
    } else {
      datapack.clearExecuting();
    }

    if (result.errors.length) {
      for (const ev of result.errors) showToast(`运行时错误：${ev.message}`, 'error');
      state.playing = false;
      setPhase('error');
    }
    if (session.finished) editor.setSourceLine(null);

    logTick(result.events, result.changes, result.tick);
    if (playSounds) playSoundEvents(result.events, result.tick);

    updateStatus(result.tick);
    timeline.setData(session.total, session.cursor);
    updateWorldChip();

    if (result.capped) {
      state.playing = false;
      showToast(`已达到快照上限（${MAX_SNAPSHOTS} 个 tick）`, 'error');
      setPhase('paused');
    } else if (result.finished && state.playing) {
      state.playing = false;
      setPhase('finished');
    }
    return true;
  }

  // ------------------------------------------------------------- playback
  function play() {
    if (!session.ok || state.phase === 'error') return;
    if (session.finished && session.cursor >= session.snapshotsCount - 1) {
      // Replay recorded time from the beginning: the world rewinds, then redraws.
      restoreIndex(0, { follow: false });
    }
    state.playing = true;
    state.acc = 0;
    setPhase('running');
  }

  function pause() {
    const wasRunning = state.playing;
    state.playing = false;
    state.acc = 0;
    if (state.phase === 'running') {
      setPhase(session.finished ? 'finished' : 'paused');
    }
    if (wasRunning) pulseScoreValues();
  }

  function togglePlay() {
    if (state.playing) pause();
    else play();
  }

  function advancePlayback() {
    if (!session.ok) return;
    if (session.cursor < session.snapshotsCount - 1) {
      // replaying existing history
      restoreIndex(session.cursor + 1, { follow: true });
      if (session.finished && session.cursor >= session.snapshotsCount - 1) {
        state.playing = false;
        editor.setSourceLine(null);
        setPhase('finished');
      }
      return;
    }
    if (session.finished) {
      state.playing = false;
      editor.setSourceLine(null);
      setPhase('finished');
      return;
    }
    stepCore({ instant: false, playSounds: true });
  }

  /** Restore snapshot `index` through the session and repaint. */
  function restoreIndex(index, { follow = false } = {}) {
    const result = session.seek(index);
    if (!result) return false;
    applyView(result, { instant: true, follow });
    return true;
  }

  function seekTo(index) {
    if (state.phase === 'error' || !session.ok || !session.snapshotsCount) return;
    pause();
    const t = clamp(Math.round(index), 0, session.snapshotsCount - 1);
    if (!restoreIndex(t, { follow: false })) return;
    if (state.phase !== 'error') setPhase(session.finished ? 'finished' : 'paused');
  }

  function stepBack() {
    if (state.phase === 'error' || !session.ok) return;
    pause();
    if (session.cursor > 0) seekTo(session.cursor - 1);
    pulseScoreValues();
  }

  function stepForward() {
    if (state.phase === 'error' || !session.ok) return;
    pause();
    if (session.cursor < session.snapshotsCount - 1) {
      seekTo(session.cursor + 1);
    } else if (!session.finished) {
      stepCore({ instant: false, playSounds: true });
      if (state.phase === 'running') setPhase('paused');
    }
    pulseScoreValues();
  }

  function doReset() {
    if (state.phase === 'error' || !session.ok) return;
    pause();
    const view = session.reset();
    state.lastSoundTick = -1;
    timeline.reset();
    world.reset();
    datapack.clearExecuting();
    resetConsole();
    if (view) applyView(view, { instant: true });
    timeline.setData(session.total, session.cursor);
    updateWorldChip();
    setPhase('paused');
  }

  // ---------------------------------------------------------------- frame
  function frame(ts) {
    const dt = state.lastTs ? Math.min(0.25, (ts - state.lastTs) / 1000) : 0;
    state.lastTs = ts;

    if (state.playing && session.ok) {
      state.acc += dt * state.speed;
      let guard = 0;
      while (state.acc >= 1 && state.playing && guard < 240) {
        state.acc -= 1;
        guard += 1;
        advancePlayback();
      }
    }

    world.render(ts);
    timeline.render();
    requestAnimationFrame(frame);
  }

  // --------------------------------------------------------------- panels
  function buildScorePanel(meta) {
    const vars = Array.isArray(meta && meta.variables) ? meta.variables : [];
    const loopNames = [];
    const re = /\bover\b[^\n{]*?\bas\s+([A-Za-z_]\w*)/g;
    let m;
    while ((m = re.exec(state.compiledSource))) loopNames.push(m[1]);

    state.scoreRows = [];
    dom.scoresGrid.innerHTML = '';
    if (!vars.length && !loopNames.length) {
      dom.scoresGrid.innerHTML = '<div class="scores-empty">暂无状态变量 — 试试 <code>state x = 0</code></div>';
      return;
    }

    const addChip = (label, key, kind) => {
      const chip = document.createElement('div');
      chip.className = 'score-chip';
      chip.dataset.key = key;
      chip.innerHTML = `
        <div class="chip-head"><span class="chip-name">${esc(label)}</span><span class="chip-kind">${kind}</span></div>
        <div class="chip-val">—</div>
        <div class="chip-when"></div>`;
      dom.scoresGrid.appendChild(chip);
      state.scoreRows.push({
        key,
        chip,
        val: chip.querySelector('.chip-val'),
        when: chip.querySelector('.chip-when'),
      });
    };

    for (const v of vars) addChip(`#${v.name}`, `#${v.name}`, '状态');
    loopNames.forEach((name, i) => addChip(name, `#__i${i}`, '循环'));
  }

  function updateScores(scores, tick) {
    const tp = (scores && scores.tp) || {};
    for (const row of state.scoreRows) {
      const raw = tp[row.key];
      const text = raw == null ? '—' : fmtInt(raw);
      if (row.val.textContent !== text) {
        row.val.textContent = text;
        row.when.textContent = `t ${tick}`;
      }
    }
    const parts = [];
    if (tp['#__pc'] !== undefined) parts.push(`pc <b>${tp['#__pc']}</b>`);
    if (tp['#__sleep'] !== undefined) parts.push(`sleep <b>${tp['#__sleep']}</b>`);
    if (tp['#__press'] !== undefined) parts.push(`press <b>${tp['#__press']}</b>`);
    let html = parts.join(' <span class="dot">·</span> ');
    if (state.lastSay) html += ` <span class="say">say “${esc(state.lastSay)}”</span>`;
    dom.scoresFoot.innerHTML = html || '<span class="muted">计分板空闲</span>';
  }

  /** Pause / single-step only: <=140ms text-color feedback, >=150ms per chip. */
  function pulseScoreValues() {
    if (prefersReducedMotion()) return;
    const now = performance.now();
    for (const row of state.scoreRows) {
      if (!row.chip || !row.val) continue;
      if (now - (row._pulseAt || 0) < 150) continue;
      row._pulseAt = now;
      row.chip.classList.add('score-pulse');
      clearTimeout(row._pulseTimer);
      row._pulseTimer = setTimeout(() => row.chip.classList.remove('score-pulse'), 140);
    }
  }

  function updatePen() {
    const pen = world.getPen();
    if (!pen.visible) {
      dom.penReadout.innerHTML = '<span class="pen-dot off"></span>没有笔';
      return;
    }
    dom.penReadout.innerHTML =
      `<span class="pen-dot"></span>` +
      `<b>x ${pen.x.toFixed(1)}</b> <b>z ${pen.z.toFixed(1)}</b> ` +
      `<b>${Math.round(pen.yaw)}°</b>`;
  }

  /** Viewport readout: y=0 · ×1.5 · (12, -4) — zoom relative to the 33-board. */
  function updateViewReadout(cam) {
    if (!dom.viewReadout || !cam) return;
    const zoom = cam.zoom >= 10 ? cam.zoom.toFixed(0) : (Math.round(cam.zoom * 10) / 10).toFixed(1);
    const cx = Math.round(cam.cx - 0.5);
    const cz = Math.round(cam.cz - 0.5);
    dom.viewReadout.textContent = `y=0 · ×${zoom} · (${cx}, ${cz})`;
    dom.viewReadout.dataset.auto = cam.autoFit ? '1' : '0';
    dom.viewReadout.title = cam.autoFit
      ? '视口：自动适配 · 滚轮缩放 · 拖动平移 · 双击 / F 重新适配'
      : '视口：手动控制 · 滚轮缩放 · 拖动平移 · 双击 / F 重新适配';
    if (dom.fit) dom.fit.classList.toggle('is-auto', !!cam.autoFit);
  }

  function updateStatus(tick) {
    dom.statTick.textContent = String(tick);
    dom.statBlocks.textContent = String(world.blockCount());
  }

  function updateWorldChip() {
    const chip = dom.worldChip;
    if (!session.ok) {
      chip.hidden = false;
      chip.dataset.kind = state.phase === 'error' ? 'error' : 'idle';
      chip.textContent = state.phase === 'error'
        ? '出错 — 请查看诊断'
        : '按「运行」开始观察时间';
      return;
    }
    if (state.phase === 'error') {
      chip.hidden = false;
      chip.dataset.kind = 'error';
      chip.textContent = '出错 — 请查看诊断';
      return;
    }
    if (state.phase === 'finished') {
      chip.hidden = false;
      chip.dataset.kind = 'done';
      const secs = (session.total / 20).toFixed(2);
      chip.textContent = `完成 · ${world.blockCount()} 个方块 · ${session.total} tick · ${secs} 秒 @20tps`;
      return;
    }
    if (state.phase === 'paused' && session.cursor === 0) {
      chip.hidden = false;
      chip.dataset.kind = 'idle';
      chip.textContent = '就绪 — 按「运行」或「单步」';
      return;
    }
    if (state.phase === 'paused') {
      chip.hidden = false;
      chip.dataset.kind = 'paused';
      chip.textContent = `已暂停 · 已运行 ${session.cursor}`;
      return;
    }
    chip.hidden = true;
  }

  // --------------------------------------------------------------- run log
  function resetConsole(hint = '按「运行」开始 —— 每个 tick 输出一行') {
    if (!dom.consoleLines) return;
    dom.consoleLines.innerHTML = `<div class="log-empty">${esc(hint)}</div>`;
    if (dom.consoleMeta) dom.consoleMeta.textContent = '空闲';
    state.logCount = 0;
  }

  function consoleLine(html, cls = '') {
    if (!dom.consoleLines) return;
    if (state.logCount === 0) dom.consoleLines.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'log-line' + (cls ? ` ${cls}` : '');
    row.innerHTML = html;
    dom.consoleLines.appendChild(row);
    state.logCount += 1;
    while (state.logCount > 180 && dom.consoleLines.firstChild && dom.consoleLines.removeChild) {
      dom.consoleLines.removeChild(dom.consoleLines.firstChild);
      state.logCount -= 1;
    }
    dom.consoleLines.scrollTop = dom.consoleLines.scrollHeight;
  }

  function logTick(events, changes, elapsedTick) {
    if (!dom.consoleLines) return;
    // Trace events carry the 0-based tick they executed on; the timeline and
    // top bar count elapsed ticks. The log follows the trace so it agrees with
    // the datapack badge and the source-line mapping.
    const tickEv = events.find((e) => e && typeof e.tick === 'number');
    const tNo = tickEv ? tickEv.tick : Math.max(0, elapsedTick - 1);
    const cmds = events.filter((e) => e && e.type === 'command');
    const fns = new Set(cmds.map((e) => e.fn || ''));
    const has = (test) => [...fns].some(test);
    const tags = [];
    if (has((f) => f === 'tp:tick' || f.startsWith('tp:tick/'))) tags.push('tick');
    if (has((f) => f.startsWith('tp:event'))) tags.push('输入');
    if (has((f) => /^tp:main\/s\d+/.test(f) || f.startsWith('tp:snippet'))) tags.push('时间轴');
    if (has((f) => f.startsWith('tp:fn'))) tags.push('函数');
    const particles = events.filter((e) => e && e.type === 'particle').length;
    const sounds = events.filter((e) => e && e.type === 'sound').length;
    const adds = changes ? changes.length : 0;
    const bits = [
      `<span class="log-t">t${tNo}</span>`,
      `<span class="log-cmd">${cmds.length} 条指令</span>`,
      `<span class="log-tags">${tags.join(' + ') || '空闲'}</span>`,
    ];
    if (adds) bits.push(`<span class="log-add">+${adds} 方块</span>`);
    if (particles) bits.push(`<span class="log-fx">${icon('sparkle', 'log-fx-icon')}${particles}</span>`);
    if (sounds) bits.push(`<span class="log-fx" title="声音 ${sounds}">${icon('volume-2', 'log-fx-icon')}${sounds}</span>`);
    consoleLine(bits.join(' '), 'log-summary');

    for (const ev of events) {
      if (!ev) continue;
      if (ev.type === 'say') {
        // core knows which chat lines are Minecraft-only onboarding
        if (isOnboardingSay(ev.file)) continue;
        consoleLine(`<span class="log-t">t${tNo}</span> <span class="log-say">say “${esc(ev.text)}”</span>`, 'log-say-line');
      } else if (ev.type === 'error') {
        consoleLine(`<span class="log-t">t${tNo}</span> <span class="log-err">错误 · ${esc(ev.message)}</span>`, 'log-error');
      }
    }
    if (dom.consoleMeta) dom.consoleMeta.textContent = `t ${tNo}`;
  }

  function setPhase(phase) {
    if (!phase) return;
    state.phase = phase;
    dom.statPhase.textContent = PHASE_LABEL[phase] || phase;
    dom.stateLed.dataset.phase = phase;
    const pauseIcon = phase === 'running' ? 'pause' : (phase === 'finished' ? 'replay' : 'play');
    const pauseLabel = phase === 'running' ? '暂停' : (phase === 'finished' ? '重播' : '继续');
    dom.pause.innerHTML = `${icon(pauseIcon)}<span class="btn-label">${pauseLabel}</span>`;
    dom.pause.setAttribute('aria-label', pauseLabel);
    const canRun = session.ok && phase !== 'error';
    dom.pause.disabled = !canRun;
    dom.step.disabled = !canRun;
    dom.reset.disabled = !canRun;
    // settling frames / scrubbing should end with the whole drawing visible
    if ((phase === 'paused' || phase === 'finished') && session.ok) world.requestFit(0, true);
    updateWorldChip();
  }

  function onSourceChange() {
    state.dirty = true;
    dom.dirtyBadge.hidden = false;
    scheduleDraftSave();
    if (actionToastKind === 'draft') hideActionToast();
  }

  function applySampleDescription(sample) {
    if (!dom.sampleDesc || !dom.sampleDescText) return;
    const text = (sample && sample.description) || '';
    dom.sampleDesc.hidden = !text;
    dom.sampleDescText.textContent = text;
    dom.sampleDesc.title = text;
  }

  let pressHintTimer = 0;
  let pressFlashTimer = 0;
  function pulsePress() {
    if (prefersReducedMotion() || !dom.press) return;
    dom.press.classList.remove('press-flash');
    void dom.press.offsetWidth;
    dom.press.classList.add('press-flash');
    clearTimeout(pressFlashTimer);
    pressFlashTimer = setTimeout(() => dom.press.classList.remove('press-flash'), 600);
  }

  function updatePressHint(files) {
    const hasPress = !!(files && files['data/tp/function/event/press.mcfunction']);
    if (!dom.press) return;
    clearTimeout(pressHintTimer);
    clearTimeout(pressFlashTimer);
    dom.press.classList.remove('press-hint');
    dom.press.classList.remove('press-flash');
    dom.press.classList.toggle('has-press', hasPress);
    dom.press.disabled = !hasPress;
    dom.press.setAttribute('aria-disabled', hasPress ? 'false' : 'true');
    dom.press.title = hasPress
      ? '宿主输入：press — 该程序包含 when press 代码块'
      : '触发不可用：当前程序没有 when press 事件';
    dom.press.setAttribute('aria-label', hasPress ? '触发（press）' : '触发（不可用：当前程序没有 when press 事件）');
    if (hasPress && !prefersReducedMotion()) {
      void dom.press.offsetWidth;
      dom.press.classList.add('press-hint');
      pressHintTimer = setTimeout(() => dom.press.classList.remove('press-hint'), 600);
    }
  }

  // ------------------------------------------------------- theme + layout
  function updateThemeButton() {
    if (!dom.theme) return;
    const light = document.documentElement.dataset.theme === 'light';
    // the sun/moon SVGs are toggled by CSS on :root[data-theme]
    dom.theme.title = light ? '切换到深色模式' : '切换到明亮模式';
    dom.theme.setAttribute('aria-label', dom.theme.title);
  }

  function updateSoundButton() {
    if (!dom.sound) return;
    const supported = host.sound === true;
    const enabled = supported && state.sound;
    const use = dom.sound.querySelector('use');
    if (use) use.setAttribute('href', enabled ? '#i-volume-2' : '#i-volume-x');
    dom.sound.disabled = !supported;
    dom.sound.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    const label = !supported ? '当前浏览器不支持声音' : (enabled ? '静音' : '开启声音');
    dom.sound.title = label;
    dom.sound.setAttribute('aria-label', label);
  }

  /** Live forward ticks and manual single-step only; seeks/scrubs never call this. */
  function playSoundEvents(events, tick) {
    if (!state.sound || host.sound !== true || typeof host.playSound !== 'function') return;
    const sounds = (events || []).filter((ev) => ev && ev.type === 'sound');
    if (!sounds.length) return;
    if (state.lastSoundTick === tick) return;
    state.lastSoundTick = tick;
    for (const ev of sounds) {
      try {
        host.playSound({
          name: ev.sound || ev.name || '',
          pitch: ev.pitch,
          volume: ev.volume,
        });
      } catch { /* sound is best effort */ }
    }
  }

  function setTheme(theme, { persist = false } = {}) {
    state.theme = applyTheme(theme);
    if (persist) persistTheme(host, state.theme);
    world.setTheme(state.theme);
    timeline.setTheme(state.theme);
    timeline.markDirty();
    world.render(performance.now());
    updateThemeButton();
  }

  /** Called by layout.js after every tab/panel change. */
  function handleLayoutChange(info) {
    if (!info) return;
    if (isTheater) syncTheaterClasses();
    if (info.visiblePanels.has('world')) {
      // a hidden canvas has zero size; when it reappears, refit + repaint
      world.requestFit(0, true);
      world.render(performance.now());
    }
    if (info.visiblePanels.has('timeline')) timeline.markDirty();
    timeline.render();
  }

  // ---------------------------------------------------- .tpk import / export
  async function importProgram() {
    if (typeof host.importTextFile !== 'function') {
      showToast('当前宿主不支持导入文件', 'error');
      return;
    }
    let picked = null;
    try {
      picked = await host.importTextFile({ accept: '.tpk,.tp,.txt,text/plain' });
    } catch {
      showToast('导入失败', 'error');
      return;
    }
    if (!picked || typeof picked.text !== 'string') return;
    if (state.dirty) {
      const ok = typeof window.confirm === 'function'
        ? window.confirm('当前源码还有未编译的修改，导入会覆盖它。继续吗？')
        : true;
      if (!ok) return;
    }
    state.sampleId = null;
    state.dirty = false;
    dom.dirtyBadge.hidden = true;
    applySampleDescription(null);
    editor.setValue(picked.text, { silent: true });
    scheduleDraftSave();
    startRun({ autoPlay: false });
    showToast(`已导入 ${picked.name || '程序'}`, 'ok');
  }

  async function exportProgram() {
    const text = editor.getValue();
    const base = state.sampleId || 'program';
    const filename = `tickpack-${base}.tpk`;
    if (typeof host.exportTextFile !== 'function') {
      showToast('当前宿主不支持导出文件', 'error');
      return;
    }
    try {
      const delivered = await host.exportTextFile({ filename, text, mime: 'text/plain;charset=utf-8' });
      showToast(`已导出 ${delivered}`, 'ok');
    } catch (err) {
      showToast(`导出失败：${err && err.message ? err.message : err}`, 'error');
    }
  }

  // ------------------------------------------------------- share / theater
  function showShareNotice(message) {
    if (!dom.shareNotice || !dom.shareNoticeText) return;
    dom.shareNoticeText.textContent = message;
    dom.shareNotice.hidden = false;
  }

  function hideShareNotice() {
    if (dom.shareNotice) dom.shareNotice.hidden = true;
  }

  function maybeWarnShareVersion() {
    if (SHARE_V == null) {
      // A share link without v= predates the version field (old links).
      if (isTheater && q.has('src')) {
        const msg = '这是旧版本分享链接（没有版本号），行为可能不同';
        showToast(msg, 'error');
        showShareNotice(msg);
      }
      return;
    }
    if (SHARE_V !== SHARE_VERSION) {
      const msg = `此链接来自旧版本，行为可能不同（v${SHARE_V}）`;
      showToast(msg, 'error');
      showShareNotice(msg);
    }
  }

  /** Build a theatre share URL from the current editor text (relative base). */
  function buildShareUrl(text) {
    const base = (location.origin && location.origin !== 'null')
      ? `${location.origin}${location.pathname}`
      : location.pathname;
    return `${base}?v=${SHARE_VERSION}&view=theater&src=${encodeURIComponent(text)}`;
  }

  async function shareProgram() {
    const text = editor.getValue();
    if (text.length > SHARE_MAX_CHARS) {
      showToast('程序太长，请用「导出 .tpk」发文件', 'error');
      return;
    }
    if (typeof host.copyText !== 'function') {
      showToast('当前宿主不支持复制', 'error');
      return;
    }
    let copied = false;
    try {
      copied = await host.copyText(buildShareUrl(text));
    } catch {
      copied = false;
    }
    if (copied) showToast('分享链接已复制：打开会自动播放，可点编辑修改', 'ok');
    else showToast('复制失败 — 请用「导出 .tpk」发文件', 'error');
  }

  function tabHas(tab, panelId) {
    return !!tab && tab.main.some((col) => col.stack.some((item) => item.panel === panelId));
  }

  /** Theatre needs one tab that has both 世界 and 源码 (defaults: 工作台). */
  function ensureTheaterTab() {
    if (!isTheater || !layout || !layout.document) return;
    const tabs = layout.document.tabs;
    const active = tabs.find((t) => t.id === layout.activeTabId);
    if (tabHas(active, 'source') && tabHas(active, 'world')) return;
    const best = tabs.find((t) => tabHas(t, 'source') && tabHas(t, 'world'))
      || tabs.find((t) => tabHas(t, 'source'))
      || tabs.find((t) => tabHas(t, 'world'));
    if (best && best.id !== layout.activeTabId) layout.selectTab(best.id);
  }

  /** Give the column that holds 世界 the full theater width (presentation only). */
  function syncTheaterClasses() {
    if (!isTheater) return;
    let found = false;
    const cols = dom.workspace.querySelectorAll('.pane-col');
    for (const col of cols) {
      const hasWorld = !!col.querySelector('.panel-world');
      col.classList.toggle('theater-main', hasWorld);
      if (hasWorld) found = true;
    }
    document.documentElement.classList.toggle('theater-no-world', !found);
  }

  let theaterOpen = false;
  function setTheaterDrawer(open, { focus = true } = {}) {
    if (!isTheater) return;
    theaterOpen = !!open;
    document.body.dataset.sourceOpen = theaterOpen ? 'true' : 'false';
    if (dom.theaterHandle) dom.theaterHandle.setAttribute('aria-expanded', String(theaterOpen));
    if (dom.theaterBackdrop) dom.theaterBackdrop.hidden = !theaterOpen;
    if (dom.theaterEdit) dom.theaterEdit.textContent = theaterOpen ? '收起源码' : '编辑 / 改编';
    if (theaterOpen) {
      // pause for comfortable editing, but keep the session/cursor untouched
      pause();
      if (focus) requestAnimationFrame(() => { try { editor.focus(); } catch { /* noop */ } });
    } else if (dom.source && typeof dom.source.blur === 'function') {
      dom.source.blur();
    }
  }

  function toggleTheaterDrawer() {
    setTheaterDrawer(!theaterOpen);
  }

  if (dom.share) dom.share.addEventListener('click', () => shareProgram());
  if (dom.theaterEdit) dom.theaterEdit.addEventListener('click', () => toggleTheaterDrawer());
  if (dom.theaterHandle) dom.theaterHandle.addEventListener('click', () => setTheaterDrawer(true));
  if (dom.theaterBackdrop) dom.theaterBackdrop.addEventListener('click', () => setTheaterDrawer(false));
  if (dom.sourceCollapse) dom.sourceCollapse.addEventListener('click', () => setTheaterDrawer(false));
  if (dom.shareNoticeClose) dom.shareNoticeClose.addEventListener('click', () => hideShareNotice());

  // ------------------------------------------------------------------ init
  function initSpeed(value) {
    const speed = clamp(Math.round(value), 1, 60);
    state.speed = speed;
    dom.speed.value = String(speed);
    dom.speedOut.textContent = `${speed} tick/秒`;
    const pct = ((speed - 1) / 59) * 100;
    dom.speed.style.setProperty('--fill', `${pct}%`);
  }

  dom.speed.addEventListener('input', () => initSpeed(Number(dom.speed.value)));

  dom.run.addEventListener('click', () => startRun({ autoPlay: true }));
  dom.pause.addEventListener('click', () => togglePlay());
  dom.step.addEventListener('click', () => stepForward());
  dom.reset.addEventListener('click', () => doReset());
  dom.back.addEventListener('click', () => stepBack());
  dom.fwd.addEventListener('click', () => stepForward());
  dom.press.addEventListener('click', () => {
    if (!session.ok) return;
    // Host input belongs to the session; the web shell never touches the simulator.
    if (session.press() === false) return;
    pulsePress();
    showToast('已发送触发 → #__press + 1', 'ok');
  });

  // world viewport controls (auto-fit / manual zoom / pan)
  dom.fit.addEventListener('click', () => {
    world.fit();
    showToast('已适配内容 · 自动适配开启', 'ok');
  });
  dom.zoomIn.addEventListener('click', () => world.zoomBy(1.25));
  dom.zoomOut.addEventListener('click', () => world.zoomBy(1 / 1.25));

  // theme toggle (persisted through the host adapter only)
  if (dom.theme) {
    updateThemeButton();
    dom.theme.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      setTheme(next, { persist: true });
    });
  }

  if (dom.sound) {
    updateSoundButton();
    dom.sound.addEventListener('click', () => {
      if (host.sound !== true) return;
      state.sound = !state.sound;
      try { host.storageSet('tickpack.sound', state.sound ? '1' : '0'); } catch { /* best effort */ }
      updateSoundButton();
      if (state.sound) {
        try { host.playSound({ name: 'block.note_block.pling', pitch: 1, volume: 0.3 }); } catch { /* best effort */ }
      }
      showToast(state.sound ? '声音已开启' : '已静音', 'ok');
    });
  }

  // .tpk import / export (platform file access only through the host adapter)
  if (dom.importBtn) {
    if (host.canImport === false) {
      dom.importBtn.disabled = true;
      dom.importBtn.title = '当前宿主不支持导入文件';
    }
    dom.importBtn.addEventListener('click', () => importProgram());
  }
  if (dom.exportBtn) {
    if (host.canExport === false) {
      dom.exportBtn.disabled = true;
      dom.exportBtn.title = '当前宿主不支持导出文件';
    }
    dom.exportBtn.addEventListener('click', () => exportProgram());
  }

  // "send it to a friend": the core builds files+zip, the web host delivers it.
  dom.zip.addEventListener('click', async () => {
    if (!session.ok) {
      showToast('先运行程序 —— 现在还没有可打包的数据包', 'error');
      return;
    }
    try {
      const bundle = session.exportBundle({ filename: ZIP_FILENAME });
      const delivered = await host.exportDatapack(bundle);
      showToast(`${delivered} ↓ — 放进存档的 datapacks/ 里，/reload 即可`, 'ok');
    } catch (err) {
      showToast(`打包失败：${err && err.message ? err.message : err}`, 'error');
    }
  });
  if (dom.zip && host.canExport === false) {
    dom.zip.disabled = true;
    dom.zip.title = '当前宿主不支持下载文件';
  }

  dom.sampleSelect.addEventListener('change', () => {
    const s = pickSample(dom.sampleSelect.value);
    if (!s) return;
    if (state.dirty) {
      const proceed = typeof window.confirm === 'function'
        ? window.confirm('当前源码有未运行的修改，切换样例会覆盖它。继续吗？')
        : true;
      if (!proceed) {
        dom.sampleSelect.value = state.sampleId || lastSampleValue;
        return;
      }
    }
    hideActionToast();
    clearDraft();
    state.sampleId = s.id;
    lastSampleValue = s.id;
    state.dirty = false;
    dom.dirtyBadge.hidden = true;
    editor.setValue(s.source || '', { silent: true });
    applySampleDescription(s);
    startRun({ autoPlay: true });
  });

  window.addEventListener('beforeunload', (e) => {
    if (!state.dirty) return undefined;
    saveDraftNow();
    e.preventDefault();
    e.returnValue = '';
    return '';
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isTheater && theaterOpen) {
      e.preventDefault();
      setTheaterDrawer(false);
      return;
    }
    if (e.key === 'Escape' && layout && layout.document) {
      const activeTab = layout.document.tabs.find((t) => t.id === layout.activeTabId);
      if (activeTab && activeTab.maximized) {
        e.preventDefault();
        layout.toggleMaximize(activeTab.maximized);
        return;
      }
    }
    const active = document.activeElement;
    const tag = active && active.tagName;
    const typing = tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || (active && active.isContentEditable);
    if (typing) return;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      stepBack();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      stepForward();
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      world.fit();
    } else if (e.key === 'r' || e.key === 'R') {
      doReset();
    }
  });

  window.addEventListener('error', (e) => {
    document.body.dataset.appError = String(e.message || 'unknown error');
    showToast(`页面脚本错误：${e.message}`, 'error');
  });

  // --------------------------------------------------------------- startup
  fillSamples();
  world.applyQuery(location.search);
  updateViewReadout(world.getCamera());
  initSpeed(parseQueryInt(q, 'speed') != null ? parseQueryInt(q, 'speed') : DEFAULT_SPEED);

  const wanted = q.get('sample');
  const autoTicks = parseQueryInt(q, 'auto');
  const seekTick = parseQueryInt(q, 't');

  if (!SAMPLES.length) {
    editor.setValue('# 没有样例。\n# src/api.js 应导出 SAMPLES = [{ id, title, description, source }]。\n');
    editor.setDiagnostics([{ severity: 'warning', line: 1, message: 'src/api.js 没有导出 SAMPLES' }]);
    setPhase('idle');
    updateWorldChip();
    requestAnimationFrame(frame);
    document.documentElement.dataset.ready = '1';
    return;
  }

  const initial = pickSample(wanted);
  state.sampleId = initial.id;
  lastSampleValue = initial.id;
  dom.sampleSelect.value = initial.id;
  // Debug aid for screenshots: ?src=<url-encoded Tickpack source> runs any program.
  const srcOverride = q.has('src') ? q.get('src') : null;
  if (srcOverride != null) {
    editor.setValue(srcOverride, { silent: true });
    state.sampleId = null;
    applySampleDescription(null);
  } else {
    editor.setValue(initial.source || '', { silent: true });
    applySampleDescription(initial);
  }

  // Drafts are offered, never forced; explicit ?src (share/debug) wins.
  const bootDraft = srcOverride == null ? readDraft() : null;

  if (autoTicks != null) {
    startRun({ autoPlay: false, syncTicks: Math.max(0, autoTicks), seekTick });
    setPhase(session.finished ? 'finished' : 'paused');
  } else if (seekTick != null) {
    startRun({ autoPlay: false, syncTicks: Math.max(0, seekTick) });
    seekTo(seekTick);
  } else {
    startRun({ autoPlay: true });
  }

  if (bootDraft) {
    if (bootDraft.source === editor.getValue()) clearDraft();
    else offerDraftRestore(bootDraft);
  }

  // QA/screenshot helper: `?snap=1` shows the *final* auto-fit framing in the
  // very first paint (headless Edge only renders ~1 rAF frame, so it would
  // otherwise photograph a half-eased camera). Explicit debug framing
  // (`?zoom/?cx/?cz/?fit=0`) still wins, so pinned-camera shots stay pinned.
  const cameraPinned = q.has('zoom') || q.has('cx') || q.has('cz') || q.get('fit') === '0';
  if (q.get('snap') === '1' && !cameraPinned) {
    world.fit();
    updateViewReadout(world.getCamera());
    world.render(performance.now());
  }

  if (isTheater) setTheaterDrawer(false, { focus: false });
  maybeWarnShareVersion();

  requestAnimationFrame(frame);
  document.documentElement.dataset.ready = '1';

  // Small QA/debug hook (used by scripts and by the Lead's screenshot workflow).
  window.__tickpack = {
    api,
    state,
    session,
    host,
    layout,
    startRun,
    play,
    pause,
    seekTo,
    stepForward,
    stepBack,
    doReset,
    setTheme,
    importProgram,
    exportProgram,
    shareProgram,
    buildShareUrl,
    setTheaterDrawer,
    isTheater,
    editor,
    readDraft,
    saveDraftNow,
    clearDraft,
    scheduleDraftSave,
    restoreDraft,
    offerDraftRestore,
    timeline,
    datapack,
    world,
    get snapshotsCount() { return session.snapshotsCount; },
  };
}
