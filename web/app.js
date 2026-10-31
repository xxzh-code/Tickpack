// Tickpack browser shell.
//
// This module is SHELL LAYER: it owns rendering, playback timing (rAF/speed),
// DOM events, query params and toasts. The run itself — compile, simulator,
// snapshots, cursor/seek, completion rules, trace→source mapping, export bytes —
// lives in the host-agnostic core session (src/session.js), reached here through
// src/api.js only. Platform side effects (download / clipboard) go through the
// web host adapter (./host-web.js), never directly from here.

import { createEditor } from './editor.js';
import { createWorld } from './world.js';
import { createDatapack } from './datapack.js';
import { createTimeline } from './timeline.js';
import { createWebHost } from './host-web.js';
import { blockColor } from './blocks.js';
import { clamp, esc, flash, fmtInt, prefersReducedMotion, showToast } from './util.js';

const DEFAULT_SPEED = 10;
const ZIP_FILENAME = 'tickpack-datapack.zip';
const PHASE_LABEL = {
  idle: 'idle',
  running: 'running',
  paused: 'paused',
  finished: 'finished',
  error: 'error',
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
  };

  const session = new TickpackSession();
  const host = createWebHost();

  // --------------------------------------------------------------- modules
  const world = createWorld(dom.canvas, { onCamera: updateViewReadout });
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

  // ------------------------------------------------------------ sample list
  function fillSamples() {
    dom.sampleSelect.innerHTML = '';
    if (!SAMPLES.length) {
      const o = document.createElement('option');
      o.textContent = 'no samples';
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

  // ------------------------------------------------------------------ run
  function startRun({ autoPlay = true, syncTicks = 0, seekTick = null } = {}) {
    const source = editor.getValue();
    let loaded;
    try {
      loaded = session.load(source);
    } catch (err) {
      console.error('[tickpack] session.load crashed', err);
      state.playing = false;
      setPhase('error');
      updateWorldChip();
      showToast(`compile crashed: ${err && err.message ? err.message : err}`, 'error');
      return false;
    }

    state.source = source;
    editor.setDiagnostics(loaded.diagnostics || []);

    if (!loaded.ok) {
      state.playing = false;
      setPhase('error');
      editor.setSourceLine(null);
      const first = (loaded.diagnostics || [])[0];
      consoleLine(
        `<span class="log-t">!</span> <span class="log-err">compile failed${first ? ` · line ${first.line}: ${esc(first.message)}` : ''}</span>`,
        'log-error',
      );
      updateWorldChip();
      showToast('compile failed — see diagnostics', 'error');
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
      const fns = loaded.meta.functionCount != null ? `${loaded.meta.functionCount} fns` : '';
      const states = loaded.meta.stateCount != null ? `${loaded.meta.stateCount} states` : '';
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
    return true;
  }

  /** Reset every panel to the session's current (tick 0) view. */
  function beginSessionView() {
    state.acc = 0;
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
  function stepCore({ instant = false } = {}) {
    if (!session.ok) return false;

    let result;
    try {
      result = session.step();
    } catch (err) {
      console.error('[tickpack] session.step crashed', err);
      state.playing = false;
      setPhase('error');
      updateWorldChip();
      showToast(`simulator crashed: ${err && err.message ? err.message : err}`, 'error');
      return false;
    }
    if (!result) {
      // session.step() returns null when the snapshot cap is reached (or there
      // is no live run): stop driving playback and keep the existing cap toast.
      state.playing = false;
      if (session.capped) showToast(`tick cap reached (${MAX_SNAPSHOTS} snapshots)`, 'error');
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
      for (const ev of result.errors) showToast(`runtime error: ${ev.message}`, 'error');
      state.playing = false;
      setPhase('error');
    }
    if (session.finished) editor.setSourceLine(null);

    logTick(result.events, result.changes, result.tick);

    if (!instant) pulseTickStat();
    updateStatus(result.tick);
    timeline.setData(session.total, session.cursor);
    updateWorldChip();

    if (result.capped) {
      state.playing = false;
      showToast(`tick cap reached (${MAX_SNAPSHOTS} snapshots)`, 'error');
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
    state.playing = false;
    state.acc = 0;
    if (state.phase === 'running') {
      setPhase(session.finished ? 'finished' : 'paused');
    }
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
    stepCore({ instant: false });
  }

  /** Restore snapshot `index` through the session and repaint. */
  function restoreIndex(index, { follow = false } = {}) {
    const result = session.seek(index);
    if (!result) return false;
    applyView(result, { instant: true, follow });
    return true;
  }

  function seekTo(index) {
    if (!session.ok || !session.snapshotsCount) return;
    pause();
    const t = clamp(Math.round(index), 0, session.snapshotsCount - 1);
    if (!restoreIndex(t, { follow: false })) return;
    if (state.phase !== 'error') setPhase(session.finished ? 'finished' : 'paused');
  }

  function stepBack() {
    if (!session.ok) return;
    pause();
    if (session.cursor > 0) seekTo(session.cursor - 1);
  }

  function stepForward() {
    if (!session.ok) return;
    pause();
    if (session.cursor < session.snapshotsCount - 1) {
      seekTo(session.cursor + 1);
    } else if (!session.finished) {
      stepCore({ instant: false });
      if (state.phase === 'running') setPhase('paused');
    }
  }

  function doReset() {
    if (!session.ok) return;
    pause();
    const view = session.reset();
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
      dom.scoresGrid.innerHTML = '<div class="scores-empty">no state variables — try <code>state x = 0</code></div>';
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

    for (const v of vars) addChip(`#${v.name}`, `#${v.name}`, 'state');
    loopNames.forEach((name, i) => addChip(name, `#__i${i}`, 'loop'));
  }

  function updateScores(scores, tick) {
    const tp = (scores && scores.tp) || {};
    for (const row of state.scoreRows) {
      const raw = tp[row.key];
      const text = raw == null ? '—' : fmtInt(raw);
      if (row.val.textContent !== text) {
        row.val.textContent = text;
        row.when.textContent = `t ${tick}`;
        flash(row.chip, 'chip-flash');
      }
    }
    const parts = [];
    if (tp['#__pc'] !== undefined) parts.push(`pc <b>${tp['#__pc']}</b>`);
    if (tp['#__sleep'] !== undefined) parts.push(`sleep <b>${tp['#__sleep']}</b>`);
    if (tp['#__press'] !== undefined) parts.push(`press <b>${tp['#__press']}</b>`);
    let html = parts.join(' <span class="dot">·</span> ');
    if (state.lastSay) html += ` <span class="say">say “${esc(state.lastSay)}”</span>`;
    dom.scoresFoot.innerHTML = html || '<span class="muted">scoreboard idle</span>';
  }

  function updatePen() {
    const pen = world.getPen();
    if (!pen.visible) {
      dom.penReadout.innerHTML = '<span class="pen-dot off"></span>no pen';
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
      ? 'viewport: auto-fit on · wheel zoom · drag pan · double-click/F to re-fit'
      : 'viewport: manual · wheel zoom · drag pan · double-click/F to re-fit';
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
        ? 'error — see diagnostics'
        : 'press ▶ Run to trace time';
      return;
    }
    if (state.phase === 'error') {
      chip.hidden = false;
      chip.dataset.kind = 'error';
      chip.textContent = 'error — see diagnostics';
      return;
    }
    if (state.phase === 'finished') {
      chip.hidden = false;
      chip.dataset.kind = 'done';
      const secs = (session.total / 20).toFixed(2);
      chip.textContent = `done · ${world.blockCount()} blocks · ${session.total} ticks · ${secs} s @20tps`;
      return;
    }
    if (state.phase === 'paused' && session.cursor === 0) {
      chip.hidden = false;
      chip.dataset.kind = 'idle';
      chip.textContent = 'ready — press ▶ Run or Step';
      return;
    }
    if (state.phase === 'paused') {
      chip.hidden = false;
      chip.dataset.kind = 'paused';
      chip.textContent = `❚❚ paused · elapsed ${session.cursor}`;
      return;
    }
    chip.hidden = true;
  }

  // --------------------------------------------------------------- run log
  function resetConsole(hint = 'press ▶ Run — one line per tick streams here') {
    if (!dom.consoleLines) return;
    dom.consoleLines.innerHTML = `<div class="log-empty">${esc(hint)}</div>`;
    if (dom.consoleMeta) dom.consoleMeta.textContent = 'idle';
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
    if (has((f) => f.startsWith('tp:event'))) tags.push('press');
    if (has((f) => /^tp:main\/s\d+/.test(f) || f.startsWith('tp:snippet'))) tags.push('timeline');
    if (has((f) => f.startsWith('tp:fn'))) tags.push('fn');
    const particles = events.filter((e) => e && e.type === 'particle').length;
    const adds = changes ? changes.length : 0;
    const bits = [
      `<span class="log-t">t${tNo}</span>`,
      `<span class="log-cmd">${cmds.length} cmd</span>`,
      `<span class="log-tags">${tags.join(' + ') || 'idle'}</span>`,
    ];
    if (adds) bits.push(`<span class="log-add">+${adds} block${adds === 1 ? '' : 's'}</span>`);
    if (particles) bits.push(`<span class="log-fx">✦${particles}</span>`);
    consoleLine(bits.join(' '), 'log-summary');

    for (const ev of events) {
      if (!ev) continue;
      if (ev.type === 'say') {
        // core knows which chat lines are Minecraft-only onboarding
        if (isOnboardingSay(ev.file)) continue;
        consoleLine(`<span class="log-t">t${tNo}</span> <span class="log-say">say “${esc(ev.text)}”</span>`, 'log-say-line');
      } else if (ev.type === 'error') {
        consoleLine(`<span class="log-t">t${tNo}</span> <span class="log-err">error · ${esc(ev.message)}</span>`, 'log-error');
      }
    }
    if (dom.consoleMeta) dom.consoleMeta.textContent = `t ${tNo}`;
  }

  let tickAnim = null;
  function pulseTickStat() {
    if (prefersReducedMotion()) return;
    if (tickAnim) tickAnim.cancel();
    tickAnim = dom.statTick.animate(
      [
        { transform: 'translateY(-1px) scale(1.16)', color: '#a8fbf5' },
        { transform: 'scale(1)', color: '#f6d33c' },
      ],
      { duration: 340, easing: 'cubic-bezier(.2,.9,.2,1)' },
    );
  }

  function setPhase(phase) {
    if (!phase) return;
    state.phase = phase;
    dom.statPhase.textContent = PHASE_LABEL[phase] || phase;
    dom.stateLed.dataset.phase = phase;
    dom.pause.textContent = phase === 'running' ? '❚❚ Pause' : (phase === 'finished' ? '↺ Replay' : '▶ Resume');
    const canRun = session.ok;
    dom.pause.disabled = !canRun;
    dom.step.disabled = !canRun;
    dom.reset.disabled = !canRun;
    // settling frames / scrubbing should end with the whole drawing visible
    if ((phase === 'paused' || phase === 'finished') && session.ok) world.requestFit(0, true);
    updateWorldChip();
  }

  function onSourceChange() {
    if (!session.ok) return;
    if (state.dirty) return;
    state.dirty = true;
    dom.dirtyBadge.hidden = false;
  }

  function applySampleDescription(sample) {
    if (!dom.sampleDesc || !dom.sampleDescText) return;
    const text = (sample && sample.description) || '';
    dom.sampleDesc.hidden = !text;
    dom.sampleDescText.textContent = text;
    dom.sampleDesc.title = text;
  }

  let pressHintTimer = 0;
  function updatePressHint(files) {
    const hasPress = !!(files && files['data/tp/function/event/press.mcfunction']);
    if (!dom.press) return;
    dom.press.classList.toggle('has-press', hasPress);
    dom.press.title = hasPress
      ? 'host input: press — this program has a `when press` block'
      : 'host input: press';
    clearTimeout(pressHintTimer);
    if (hasPress) {
      // pulse once so people discover the input
      dom.press.classList.remove('press-hint');
      void dom.press.offsetWidth;
      dom.press.classList.add('press-hint');
      pressHintTimer = setTimeout(() => dom.press.classList.remove('press-hint'), 3400);
    } else {
      dom.press.classList.remove('press-hint');
    }
  }

  // ------------------------------------------------------------------ init
  function initSpeed(value) {
    const speed = clamp(Math.round(value), 1, 60);
    state.speed = speed;
    dom.speed.value = String(speed);
    dom.speedOut.textContent = `${speed} t/s`;
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
    flash(dom.press, 'press-flash');
    showToast('press sent → #__press + 1', 'ok');
  });

  // world viewport controls (auto-fit / manual zoom / pan)
  dom.fit.addEventListener('click', () => {
    world.fit();
    showToast('fit to content · auto-fit on', 'ok');
  });
  dom.zoomIn.addEventListener('click', () => world.zoomBy(1.25));
  dom.zoomOut.addEventListener('click', () => world.zoomBy(1 / 1.25));

  // "send it to a friend": the core builds files+zip, the web host delivers it.
  dom.zip.addEventListener('click', async () => {
    if (!session.ok) {
      showToast('run the program first — nothing to zip yet', 'error');
      return;
    }
    try {
      const bundle = session.exportBundle({ filename: ZIP_FILENAME });
      const delivered = await host.exportDatapack(bundle);
      showToast(`${delivered} ↓ — 放进存档的 datapacks/ 里，/reload 即可`, 'ok');
    } catch (err) {
      showToast(`zip failed: ${err && err.message ? err.message : err}`, 'error');
    }
  });
  if (dom.zip && host.canExport === false) {
    dom.zip.disabled = true;
    dom.zip.title = 'this host cannot download files';
  }

  dom.sampleSelect.addEventListener('change', () => {
    const s = pickSample(dom.sampleSelect.value);
    if (!s) return;
    state.sampleId = s.id;
    state.dirty = false;
    dom.dirtyBadge.hidden = true;
    editor.setValue(s.source || '', { silent: true });
    applySampleDescription(s);
    startRun({ autoPlay: true });
  });

  window.addEventListener('keydown', (e) => {
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
    showToast(`JS error: ${e.message}`, 'error');
  });

  // --------------------------------------------------------------- startup
  fillSamples();
  const q = new URLSearchParams(location.search);
  world.applyQuery(location.search);
  updateViewReadout(world.getCamera());
  initSpeed(parseQueryInt(q, 'speed') != null ? parseQueryInt(q, 'speed') : DEFAULT_SPEED);

  const wanted = q.get('sample');
  const autoTicks = parseQueryInt(q, 'auto');
  const seekTick = parseQueryInt(q, 't');

  if (!SAMPLES.length) {
    editor.setValue('# No samples found.\n# src/api.js should export SAMPLES = [{ id, title, description, source }].\n');
    editor.setDiagnostics([{ severity: 'warning', line: 1, message: 'src/api.js exports no SAMPLES' }]);
    setPhase('idle');
    updateWorldChip();
    requestAnimationFrame(frame);
    document.documentElement.dataset.ready = '1';
    return;
  }

  const initial = pickSample(wanted);
  state.sampleId = initial.id;
  dom.sampleSelect.value = initial.id;
  // Debug aid for screenshots: ?src=<url-encoded Tickpack source> runs any program.
  const srcOverride = q.get('src');
  if (srcOverride) {
    editor.setValue(srcOverride, { silent: true });
    applySampleDescription(null);
  } else {
    editor.setValue(initial.source || '', { silent: true });
    applySampleDescription(initial);
  }

  if (autoTicks != null) {
    startRun({ autoPlay: false, syncTicks: Math.max(0, autoTicks), seekTick });
    setPhase(session.finished ? 'finished' : 'paused');
  } else if (seekTick != null) {
    startRun({ autoPlay: false, syncTicks: Math.max(0, seekTick) });
    seekTo(seekTick);
  } else {
    startRun({ autoPlay: true });
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

  requestAnimationFrame(frame);
  document.documentElement.dataset.ready = '1';

  // Small QA/debug hook (used by scripts and by the Lead's screenshot workflow).
  window.__tickpack = {
    api,
    state,
    session,
    host,
    startRun,
    play,
    pause,
    seekTo,
    stepForward,
    stepBack,
    doReset,
    timeline,
    datapack,
    world,
    get snapshotsCount() { return session.snapshotsCount; },
  };
}
