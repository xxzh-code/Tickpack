// Tickpack app: wires source -> compiled mcfunction -> live world -> timeline.
// Everything here is driven by the two contracts in docs/LANG.md:
//   compile(source) -> { ok, files, diagnostics, meta }
//   new Simulator(files) + step()/reset()/snapshot()/restore()

import { createEditor } from './editor.js';
import { createWorld } from './world.js';
import { createDatapack } from './datapack.js';
import { createTimeline } from './timeline.js';
import { blockColor } from './blocks.js';
import { clamp, esc, flash, fmtInt, prefersReducedMotion, showToast } from './util.js';

const MAX_SNAPSHOTS = 2000;
const DEFAULT_SPEED = 10;
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

/**
 * Minecraft-only onboarding chatter emitted by `tp:start` (help/chat lines).
 * The browser has no `/function` chat, so keep it out of the run log and the
 * scoreboard footer. Covers both the old start.mcfunction and the current
 * start/rewind.mcfunction (anything under .../start/).
 */
function isOnboardingSay(file) {
  const f = String(file || '');
  return f.endsWith('start.mcfunction') || /\/start\//.test(f) || /\/start$/.test(f);
}

export function startApp(api) {
  const compile = api.compile;
  const Simulator = api.Simulator;
  const SAMPLES = Array.isArray(api.SAMPLES) ? api.SAMPLES : [];
  const PRELUDE = typeof api.PRELUDE === 'string' ? api.PRELUDE : '';

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
  const state = {
    source: '',
    compiledSource: '',
    compiled: null,
    files: {},
    sim: null,
    playing: false,
    phase: 'idle',
    speed: DEFAULT_SPEED,
    acc: 0,
    lastTs: 0,
    snapshots: [],
    cursor: 0,
    total: 0,
    finished: false,
    dirty: false,
    lastCmd: null,
    lastSay: '',
    runtimeError: null,
    scoreRows: [],
    sampleId: null,
    logCount: 0,
    hasTickBlocks: false,
  };

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
    // keep the editor cursor still, but let the author's eye follow the tick
    onSourceLine: (line) => editor.setSourceLine(line, { scroll: state.playing }),
  });
  const timeline = createTimeline({
    canvas: dom.timelineCanvas,
    labelEl: dom.tickLabel,
    onSeek: seekTo,
  });

  // ---------------------------------------------------------------- state
  // (declared above the modules so callbacks wired during construction can
  // safely read it)

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
    let result;
    try {
      result = compile(source);
    } catch (err) {
      console.error('[tickpack] compile crashed', err);
      setPhase('error');
      updateWorldChip();
      showToast(`compile crashed: ${err && err.message ? err.message : err}`, 'error');
      return false;
    }

    state.source = source;
    state.compiled = result;
    editor.setDiagnostics(result.diagnostics || []);

    if (!result.ok) {
      setPhase('error');
      editor.setSourceLine(null);
      const first = (result.diagnostics || [])[0];
      consoleLine(
        `<span class="log-t">!</span> <span class="log-err">compile failed${first ? ` · line ${first.line}: ${esc(first.message)}` : ''}</span>`,
        'log-error',
      );
      updateWorldChip();
      showToast('compile failed — see diagnostics', 'error');
      return false;
    }

    state.compiledSource = source;
    state.files = result.files || {};
    state.dirty = false;
    dom.dirtyBadge.hidden = true;
    // an ambient program (any `tick { ... }` block) never "finishes" in-game:
    // the datapack keeps ticking, so the browser must keep running too.
    state.hasTickBlocks = result.meta && typeof result.meta.hasTickBlocks === 'boolean'
      ? result.meta.hasTickBlocks
      : /\btick\s*\{/.test(source);

    datapack.setFiles(result.files || {}, result.meta);
    if (PRELUDE) datapack.setPrelude(PRELUDE);
    updatePressHint(result.files || {});
    buildScorePanel(result.meta);
    if (dom.editorMeta && result.meta) {
      const fns = result.meta.functionCount != null ? `${result.meta.functionCount} fns` : '';
      const states = result.meta.stateCount != null ? `${result.meta.stateCount} states` : '';
      dom.editorMeta.textContent = [fns, states].filter(Boolean).join(' · ');
    }

    startSim(result.files || {});
    // a fresh compile always lands in a clean, paused-at-zero state
    state.playing = false;
    setPhase('paused');

    if (syncTicks > 0) {
      for (let i = 0; i < syncTicks && !state.finished; i++) stepCore({ instant: true });
    }
    if (seekTick != null) seekTo(seekTick);

    if (autoPlay) {
      play();
    } else if (state.phase !== 'error') {
      setPhase(state.finished ? 'finished' : 'paused');
    }

    world.render(performance.now());
    timeline.render();
    return true;
  }

  function startSim(files) {
    state.sim = new Simulator(files);
    state.sim.reset();
    state.snapshots = [];
    state.cursor = 0;
    state.total = 0;
    state.finished = false;
    state.lastCmd = null;
    state.lastSay = '';
    state.runtimeError = null;
    state.playing = false;
    state.acc = 0;
    timeline.reset();
    world.reset();
    datapack.clearExecuting();
    resetConsole();
    world.setWorld(state.sim.getWorld(), { instant: true });
    const scores = state.sim.getScores();
    updateScores(scores, state.sim.getTick());
    updatePen();
    updateStatus(state.sim.getTick());
    captureSnapshot();
    timeline.setData(0, 0);
    updateWorldChip();
  }

  function captureSnapshot() {
    if (!state.sim) return false;
    if (state.snapshots.length >= MAX_SNAPSHOTS) return false;
    state.snapshots.push({
      snap: state.sim.snapshot(),
      cmd: state.lastCmd,
      say: state.lastSay,
      tick: state.sim.getTick(),
    });
    return true;
  }

  // ------------------------------------------------------------ one tick
  function stepCore({ instant = false } = {}) {
    if (!state.sim) return false;

    let events;
    try {
      events = state.sim.step() || [];
    } catch (err) {
      console.error('[tickpack] simulator crashed', err);
      state.playing = false;
      setPhase('error');
      updateWorldChip();
      showToast(`simulator crashed: ${err && err.message ? err.message : err}`, 'error');
      return false;
    }

    const tick = state.sim.getTick();
    for (const ev of events) {
      if (!ev) continue;
      // tp:start's chat line is Minecraft-only onboarding (/function tp:start);
      // the browser has no such command, so keep it out of the UI log/ticker.
      if (ev.type === 'say' && !isOnboardingSay(ev.file)) state.lastSay = ev.text;
      else if (ev.type === 'error') {
        showToast(`runtime error: ${ev.message}`, 'error');
        state.runtimeError = ev.message;
      }
    }
    if (state.runtimeError) {
      state.playing = false;
      setPhase('error');
      updateWorldChip();
    }

    world.applyEvents(events);

    const changes = world.setWorld(state.sim.getWorld(), { instant });
    state.total = Math.max(state.total, tick);
    const cmdCount = events.reduce((n, e) => n + (e && e.type === 'command' ? 1 : 0), 0);
    if (changes.length) {
      timeline.addMark(
        tick,
        changes.slice(0, 4).map((c) => blockColor(c.block)),
        changes.length,
        cmdCount,
      );
    }

    const scores = state.sim.getScores();
    updateScores(scores, tick);
    world.setTick(tick);
    updatePen();

    const pc = scores && scores.tp ? scores.tp['#__pc'] : undefined;
    if (pc === -1 && tick > 0 && !state.hasTickBlocks) state.finished = true;

    // The trace's last command is always `#__tick += 1` bookkeeping; ask the
    // datapack panel for the command that actually represents this tick.
    const execInfo = datapack.pickExecuting(events);
    if (execInfo) state.lastCmd = execInfo;

    const stored = captureSnapshot();
    state.cursor = state.snapshots.length - 1;

    if (execInfo) datapack.setExecuting(execInfo, { follow: state.playing || instant });
    if (state.finished) editor.setSourceLine(null);

    logTick(events, changes, tick);

    if (!instant) pulseTickStat();
    updateStatus(tick);
    timeline.setData(state.total, state.cursor);
    updateWorldChip();

    if (!stored) {
      state.playing = false;
      showToast(`tick cap reached (${MAX_SNAPSHOTS} snapshots)`, 'error');
      setPhase('paused');
    } else if (state.finished && state.playing) {
      state.playing = false;
      setPhase('finished');
    }
    return true;
  }

  // ------------------------------------------------------------- playback
  function play() {
    if (!state.sim || state.phase === 'error') return;
    state.runtimeError = null;
    if (state.finished && state.cursor >= state.snapshots.length - 1) {
      // Replay recorded time from the beginning: the world rewinds, then redraws.
      restoreAt(0, { follow: false });
    }
    if (state.finished && state.snapshots.length > 1) {
      // stays finished while replaying; the loop stops again at the end
    } else {
      state.finished = false;
    }
    state.playing = true;
    state.acc = 0;
    setPhase('running');
  }

  function pause() {
    state.playing = false;
    state.acc = 0;
    if (state.phase === 'running') {
      setPhase(state.finished ? 'finished' : 'paused');
    }
  }

  function togglePlay() {
    if (state.playing) pause();
    else play();
  }

  function advancePlayback() {
    if (!state.sim) return;
    if (state.cursor < state.snapshots.length - 1) {
      // replaying existing history
      restoreAt(state.cursor + 1, { follow: true });
      if (state.finished && state.cursor >= state.snapshots.length - 1) {
        state.playing = false;
        editor.setSourceLine(null);
        setPhase('finished');
      }
      return;
    }
    if (state.finished) {
      state.playing = false;
      editor.setSourceLine(null);
      setPhase('finished');
      return;
    }
    stepCore({ instant: false });
  }

  function restoreAt(index, { follow = false } = {}) {
    const rec = state.snapshots[index];
    if (!rec) return;
    state.cursor = index;
    state.sim.restore(rec.snap);
    const tick = state.sim.getTick();
    world.setWorld(state.sim.getWorld(), { instant: true });
    world.setTick(tick);
    const scores = state.sim.getScores();
    updateScores(scores, tick);
    updatePen();
    if (rec.cmd) {
      datapack.setExecuting(rec.cmd, { follow });
    } else {
      datapack.clearExecuting();
    }
    if (state.finished && index >= state.snapshots.length - 1) editor.setSourceLine(null);
    updateStatus(tick);
    timeline.setData(state.total, index);
    world.requestFit(0, !state.playing);
    updateWorldChip();
  }

  function seekTo(tick) {
    if (!state.sim || !state.snapshots.length) return;
    pause();
    const t = clamp(Math.round(tick), 0, state.snapshots.length - 1);
    restoreAt(t, { follow: false });
    if (state.phase !== 'error') setPhase(state.finished ? 'finished' : 'paused');
  }

  function stepBack() {
    if (!state.sim) return;
    pause();
    if (state.cursor > 0) seekTo(state.cursor - 1);
  }

  function stepForward() {
    if (!state.sim) return;
    pause();
    if (state.cursor < state.snapshots.length - 1) {
      seekTo(state.cursor + 1);
    } else if (!state.finished) {
      stepCore({ instant: false });
      if (state.phase === 'running') setPhase('paused');
    }
  }

  function doReset() {
    if (!state.sim) return;
    pause();
    state.sim.reset();
    state.snapshots = [];
    state.cursor = 0;
    state.total = 0;
    state.finished = false;
    state.lastCmd = null;
    state.lastSay = '';
    state.runtimeError = null;
    timeline.reset();
    world.reset();
    datapack.clearExecuting();
    resetConsole();
    world.setWorld(state.sim.getWorld(), { instant: true });
    updateScores(state.sim.getScores(), state.sim.getTick());
    updatePen();
    updateStatus(state.sim.getTick());
    captureSnapshot();
    timeline.setData(0, 0);
    updateWorldChip();
    setPhase('paused');
  }

  // ---------------------------------------------------------------- frame
  function frame(ts) {
    const dt = state.lastTs ? Math.min(0.25, (ts - state.lastTs) / 1000) : 0;
    state.lastTs = ts;

    if (state.playing && state.sim) {
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
    if (!state.sim) {
      chip.hidden = false;
      chip.dataset.kind = 'idle';
      chip.textContent = 'press ▶ Run to trace time';
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
      const secs = (state.total / 20).toFixed(2);
      chip.textContent = `done · ${world.blockCount()} blocks · ${state.total} ticks · ${secs} s @20tps`;
      return;
    }
    if (state.phase === 'paused' && state.cursor === 0) {
      chip.hidden = false;
      chip.dataset.kind = 'idle';
      chip.textContent = 'ready — press ▶ Run or Step';
      return;
    }
    if (state.phase === 'paused') {
      chip.hidden = false;
      chip.dataset.kind = 'paused';
      chip.textContent = `❚❚ paused · elapsed ${state.cursor}`;
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
        // see isOnboardingSay(): skip the Minecraft-only tp:start onboarding line
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
    const hasSim = !!state.sim;
    dom.pause.disabled = !hasSim;
    dom.step.disabled = !hasSim;
    dom.reset.disabled = !hasSim;
    // settling frames / scrubbing should end with the whole drawing visible
    if ((phase === 'paused' || phase === 'finished') && state.sim) world.requestFit(0, true);
    updateWorldChip();
  }

  function onSourceChange() {
    if (!state.sim) return;
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
      ? 'host input: sim.press() — this program has a `when press` block'
      : 'host input: sim.press()';
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
    if (!state.sim) return;
    state.sim.press();
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

  // "send it to a friend": real .zip of the generated datapack (api-owned helper)
  dom.zip.addEventListener('click', () => {
    if (typeof api.packToZip !== 'function') {
      showToast('packToZip() is not in src/api.js yet — the .zip lands soon', 'error');
      return;
    }
    if (!state.files || !Object.keys(state.files).length) {
      showToast('run the program first — nothing to zip yet', 'error');
      return;
    }
    try {
      const bytes = api.packToZip(state.files);
      const blob = new Blob([bytes], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'tickpack-datapack.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      showToast('tickpack-datapack.zip ↓ — 放进存档的 datapacks/ 里，/reload 即可', 'ok');
    } catch (err) {
      showToast(`zip failed: ${err && err.message ? err.message : err}`, 'error');
    }
  });
  if (typeof api.packToZip !== 'function' && dom.zip) {
    dom.zip.title = '下载整包 (packToZip 即将上线) · 放进存档的 datapacks/ 里，/reload 即可';
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
    setPhase(state.finished ? 'finished' : 'paused');
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
    get snapshots() { return state.snapshots; },
  };
}
