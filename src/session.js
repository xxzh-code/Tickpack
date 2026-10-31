// Tickpack session: the host-agnostic "run state" behind any UI.
//
// This module is CORE LAYER. It must not touch window/document/localStorage/
// navigator/fetch/fs/process — the whole point is that the same session drives
// the browser app, a Node CLI, a worker or a desktop shell unchanged.
//
// It owns what a run *is*: compile → simulator → per-tick snapshots → seek /
// replay → completion rules → trace→source mapping → export bundle. It does NOT
// own playback timing (rAF, speed), rendering, input, or writing files; those
// belong to the shell, which talks to the platform through its own host adapter.
import { compile } from './lang/compile.js';
import { Simulator } from './sim/sim.js';
import { packToZip } from './zip.js';

/** Snapshot cap per run (also the ambient run limit). */
export const MAX_SNAPSHOTS = 2000;

const DEFAULT_EXPORT_NAME = 'tickpack-datapack.zip';

/**
 * Minecraft-only onboarding chatter emitted by tp:start / the shared rewind.
 * Hosts that are not Minecraft should not show it in their run log.
 */
export function isOnboardingSay(file) {
  const f = String(file || '');
  return f.endsWith('start.mcfunction') || /\/start\//.test(f) || /\/start$/.test(f);
}

/** Nearest `# source line N` at or above 1-based `line`. */
export function looseSourceLine(files, file, line) {
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

/** `# source line N` directly above the command (its user statement). */
export function directSourceLine(files, file, line) {
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

const isTimelineFn = (fn) => /^tp:main\/s\d+/.test(fn || '')
  || /^tp:snippet\//.test(fn || '')
  || /^tp:fn\//.test(fn || '');

/**
 * Choose the command that best represents "the line currently executing".
 *
 * The real trace ends every tick in tp:tick bookkeeping and may pass through
 * tp:main/dispatch; prefer the last real state-machine / stdlib command, and
 * among those prefer one that maps back to a user source line.
 *
 * @returns {{file: string, line: number, fn: string, tick: number, sourceLine: number|null}|null}
 */
export function pickExecuting(events, files) {
  let lastAny = null;
  let lastTimeline = null;
  let lastDirect = null;
  let lastDirectTimeline = null;

  for (const ev of events || []) {
    if (!ev || ev.type !== 'command' || !ev.file) continue;
    lastAny = ev;
    const direct = directSourceLine(files, ev.file, ev.line);
    if (direct != null) lastDirect = { ev, direct };
    if (!isTimelineFn(ev.fn)) continue;
    lastTimeline = ev;
    if (direct != null) lastDirectTimeline = { ev, direct };
  }

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

function blockKey(b) {
  return `${b.x},${b.y},${b.z}`;
}

function blocksToMap(blocks) {
  const map = new Map();
  for (const b of blocks || []) {
    if (!b || b.block === 'air' || b.block === 'minecraft:air') continue;
    map.set(blockKey(b), b);
  }
  return map;
}

/** Blocks added or changed compared to the previous world (for timeline marks). */
function diffBlocks(prev, nextBlocks) {
  const changes = [];
  for (const b of nextBlocks || []) {
    if (!b || b.block === 'air' || b.block === 'minecraft:air') continue;
    const old = prev.get(blockKey(b));
    if (!old || old.block !== b.block) changes.push(b);
  }
  return changes;
}

/**
 * A run of one compiled program.
 *
 * Typical shell flow:
 *   const session = new TickpackSession();
 *   const loaded = session.load(source);        // compile + reset + snapshot 0
 *   const view = session.view();                // render tick 0
 *   const r = session.step();                   // one tick, returns render data
 *   session.seek(n);                            // scrub through snapshots
 *   const { zip, filename } = session.exportBundle();
 *
 * The shell owns "playing" (timers/speed) and all rendering; the session owns
 * the tick/seek state machine, snapshots and completion rules.
 */
export class TickpackSession {
  constructor({ maxSnapshots = MAX_SNAPSHOTS } = {}) {
    this.maxSnapshots = Math.max(1, Math.floor(Number(maxSnapshots) || MAX_SNAPSHOTS));
    this._sim = null;
    this._files = {};
    this._meta = null;
    this._diagnostics = [];
    this._ok = false;
    this._snapshots = [];
    this._cursor = 0;
    this._total = 0;
    this._finished = false;
    this._capped = false;
    this._lastCmd = null;
    this._lastSay = '';
    this._runtimeError = null;
    this._blocks = new Map();
  }

  get ok() { return this._ok; }
  get files() { return this._files; }
  get meta() { return this._meta; }
  get diagnostics() { return this._diagnostics; }
  get tick() { return this._sim ? this._sim.getTick() : 0; }
  get cursor() { return this._cursor; }
  get total() { return this._total; }
  get finished() { return this._finished; }
  get capped() { return this._capped; }
  get snapshotsCount() { return this._snapshots.length; }
  get hasTickBlocks() { return !!(this._meta && this._meta.hasTickBlocks); }
  /** Last program `say` (Minecraft-only onboarding lines are filtered out). */
  get lastSay() { return this._lastSay; }

  /**
   * Compile source and start a fresh run. On compile errors the previous run is
   * kept? No: load always resets to a clean, dead state.
   * @returns {{ok: boolean, diagnostics: Array, meta: object|null, files: object}}
   */
  load(source) {
    let result;
    try {
      result = compile(source);
    } catch (err) {
      result = {
        ok: false,
        files: {},
        meta: null,
        diagnostics: [{ severity: 'error', line: 1, message: `compiler crashed: ${err && err.message ? err.message : err}` }],
      };
    }

    this._files = result.files || {};
    this._meta = result.meta || null;
    this._diagnostics = result.diagnostics || [];
    this._ok = !!result.ok && typeof Simulator === 'function';

    if (!this._ok) {
      this._sim = null;
      this._snapshots = [];
      this._cursor = 0;
      this._total = 0;
      this._finished = false;
      this._capped = false;
      this._lastCmd = null;
      this._lastSay = '';
      this._runtimeError = null;
      this._blocks = new Map();
      return { ok: false, diagnostics: this._diagnostics, meta: this._meta, files: this._files };
    }

    this._sim = new Simulator(this._files);
    this._sim.reset();
    this._restartHistory();
    return { ok: true, diagnostics: this._diagnostics, meta: this._meta, files: this._files };
  }

  /** Reset the simulator and replay history from tick 0 (same compiled pack). */
  reset() {
    if (!this._sim) return null;
    this._sim.reset();
    this._restartHistory();
    return this.view();
  }

  _restartHistory() {
    this._snapshots = [];
    this._cursor = 0;
    this._total = 0;
    this._finished = false;
    this._capped = false;
    this._lastCmd = null;
    this._lastSay = '';
    this._runtimeError = null;
    this._blocks = new Map();
    const world = this._sim.getWorld();
    this._blocks = blocksToMap(world.blocks);
    this._capture();
    this._cursor = this._snapshots.length - 1;
  }

  _capture() {
    if (this._snapshots.length >= this.maxSnapshots) return false;
    this._snapshots.push({
      snap: this._sim.snapshot(),
      cmd: this._lastCmd,
      say: this._lastSay,
      tick: this._sim.getTick(),
    });
    return true;
  }

  /**
   * Advance exactly one tick.
   * @returns {TickResult|null} null when there is no run, or after the snapshot cap.
   */
  step() {
    if (!this._sim || this._capped) return null;

    const events = this._sim.step() || [];
    const tick = this._sim.getTick();
    let errors = [];

    for (const ev of events) {
      if (!ev) continue;
      if (ev.type === 'say') {
        if (!isOnboardingSay(ev.file)) this._lastSay = ev.text;
      } else if (ev.type === 'error') {
        errors.push(ev);
        this._runtimeError = ev.message;
      }
    }

    const world = this._sim.getWorld();
    const changes = diffBlocks(this._blocks, world.blocks);
    this._blocks = blocksToMap(world.blocks);
    this._total = Math.max(this._total, tick);

    const exec = pickExecuting(events, this._files);
    if (exec) this._lastCmd = exec;

    const scores = this._sim.getScores();
    const pc = scores && scores.tp ? scores.tp['#__pc'] : undefined;
    if (pc === -1 && tick > 0 && !this.hasTickBlocks) this._finished = true;

    const stored = this._capture();
    this._cursor = this._snapshots.length - 1;
    if (!stored) {
      this._capped = true;
      this._finished = true;
    }

    return {
      tick,
      index: this._cursor,
      total: this._total,
      events,
      world,
      scores,
      changes,
      exec,
      lastSay: this._lastSay,
      finished: this._finished,
      runtimeError: this._runtimeError,
      errors,
      capped: this._capped,
    };
  }

  /**
   * Restore snapshot `index` (0..snapshotsCount-1) and return its render data.
   * Does not change the "finished" flag.
   */
  seek(index) {
    if (!this._sim || !this._snapshots.length) return null;
    const clamped = Math.max(0, Math.min(this._snapshots.length - 1, Math.round(Number(index) || 0)));
    const rec = this._snapshots[clamped];
    this._cursor = clamped;
    this._sim.restore(rec.snap);
    const tick = this._sim.getTick();
    const world = this._sim.getWorld();
    this._blocks = blocksToMap(world.blocks);
    return {
      tick,
      index: clamped,
      total: this._total,
      events: [],
      world,
      scores: this._sim.getScores(),
      changes: [],
      exec: rec.cmd || null,
      lastSay: rec.say || '',
      finished: this._finished,
      runtimeError: this._runtimeError,
      errors: [],
      capped: this._capped,
    };
  }

  /** Render data for the current tick without advancing/restoring. */
  view() {
    if (!this._sim) return null;
    const rec = this._snapshots[this._cursor];
    return {
      tick: this._sim.getTick(),
      index: this._cursor,
      total: this._total,
      events: [],
      world: this._sim.getWorld(),
      scores: this._sim.getScores(),
      changes: [],
      exec: rec ? rec.cmd : null,
      lastSay: rec ? rec.say : '',
      finished: this._finished,
      runtimeError: this._runtimeError,
      errors: [],
      capped: this._capped,
    };
  }

  /**
   * Forward a host input event to the run ("press" button / key).
   * The session is the shell's only handle on the simulator, so host inputs
   * belong here too. Returns false when there is no live run.
   */
  press() {
    if (!this._sim) return false;
    this._sim.press();
    return true;
  }

  /**
   * The export payload for the shell's host adapter.
   * Core builds the files and the zip bytes; the host decides how to deliver
   * them (browser Blob download, desktop write-directory, CLI fs.writeFile).
   */
  exportBundle({ filename = DEFAULT_EXPORT_NAME } = {}) {
    if (!this._ok || !this._files || !Object.keys(this._files).length) {
      throw new Error('nothing to export: no successfully compiled pack');
    }
    return {
      filename,
      files: this._files,
      zip: packToZip(this._files),
    };
  }
}
