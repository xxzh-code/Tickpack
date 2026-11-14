// Tickpack mini-simulator.
//
// Executes the *generated mcfunction text* (a virtual datapack, `{path: text}`),
// not an AST, so the browser preview is exactly what Minecraft would do.
// Contract: docs/LANG.md §5.
//
// Design notes:
//  - The pack is indexed once; function lines are parsed lazily and cached, so a
//    function line is parsed exactly once and then executed for 10k ticks.
//  - State is deliberately plain (Maps + arrays) and snapshot() serializes it into
//    plain structured-cloneable data. No deep clones on the command path.
//  - Everything is deterministic: no Math.random, no time, stable sort ties.
//  - step() never throws: unsupported/failing commands become `error` trace events
//    and execution continues (a hard command budget stops the tick).

import {
  canonicalBlock,
  canonicalEntity,
  matchesRange,
  parseCommand,
  parseSelector,
  resolvePosition,
  resolveRotationToken,
  wrap32,
} from './syntax.js';

export const MAX_COMMANDS_PER_TICK = 100000;
export const MAX_FILL_VOLUME = 4096;
export const MAX_FUNCTION_DEPTH = 256;

// The virtual host player. Real Minecraft needs a player before the datapack can
// start (`execute at @p run summon ...` anchors the pen under the player's feet),
// so the simulator models one: feet at (0.5, 1.0, 0.5), i.e. standing on the block
// (0,0,0) of the drawing plane, exactly where the pen used to be summoned.
export const PLAYER_TYPE = 'player';
export const PLAYER_SPAWN = Object.freeze({ x: 0.5, y: 1.0, z: 0.5 });

function isPlayerEntity(entity) {
  return canonicalEntity(entity && entity.type) === PLAYER_TYPE;
}

function createPlayerEntity(id) {
  return {
    id,
    type: PLAYER_TYPE,
    x: PLAYER_SPAWN.x,
    y: PLAYER_SPAWN.y,
    z: PLAYER_SPAWN.z,
    yaw: 0,
    pitch: 0,
    tags: [],
  };
}

const FUNCTION_PATH_RE = /^data\/([^/]+)\/function\/(.+)\.mcfunction$/;

class SimError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SimError';
  }
}

class BudgetError extends Error {
  constructor(loc) {
    super(`command budget exceeded (${MAX_COMMANDS_PER_TICK} commands in one tick)`);
    this.name = 'BudgetError';
    this.loc = loc || null;
  }
}

/** Internal control-flow signal: `/return` stops the current function. */
class ReturnSignal {
  constructor() {
    this.returnSignal = true;
  }
}

function normalizePath(path) {
  return String(path).replace(/\\/g, '/');
}

function createState() {
  return {
    tick: 0, // number of completed ticks (trace events use the tick being run)
    objectives: new Set(),
    scores: new Map(), // objective -> Map(scoreHolder -> int32)
    blocks: new Map(), // "x,y,z" -> canonical block id (never 'air')
    entities: [], // { id, type, x, y, z, yaw, pitch, tags: [] }
    nextEntityId: 1,
    presses: 0, // host input count (also mirrored to #__press when `tp` exists)
  };
}

function rootContext() {
  return { pos: { x: 0, y: 0, z: 0 }, rot: { yaw: 0, pitch: 0 }, executor: null };
}

function locFields(loc) {
  const out = {};
  if (!loc) return out;
  if (loc.file) out.file = loc.file;
  if (loc.line) out.line = loc.line;
  if (loc.fn) out.fn = loc.fn;
  return out;
}

function blockKey(x, y, z) {
  return `${x},${y},${z}`;
}

function floorPos(p) {
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

function distanceSq(entity, pos) {
  const dx = entity.x - pos.x;
  const dy = entity.y - pos.y;
  const dz = entity.z - pos.z;
  return dx * dx + dy * dy + dz * dz;
}

function resolveFunctionName(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) return null;
  if (!n.includes(':')) return `tp:${n}`;
  return n;
}

export class Simulator {
  /**
   * @param {{[path: string]: string}|Map<string,string>} files virtual datapack files
   */
  constructor(files) {
    this.files = files || {};
    this._functions = new Map(); // 'ns:path' -> { name, path, lines, cache }
    this._indexFunctions();

    this.loadFunctions = this._readFunctionTag('load', 'tp:load');
    this.tickFunctions = this._readFunctionTag('tick', 'tp:tick');

    this.state = createState();
    this._events = [];
    this._collect = true;
    this._budget = 0;
    this._depth = 0;
  }

  // ---------------------------------------------------------------- pack setup

  _indexFunctions() {
    const add = (path, text) => {
      const m = FUNCTION_PATH_RE.exec(path);
      if (!m) return;
      const name = `${m[1]}:${m[2]}`;
      const lines = String(text == null ? '' : text).split(/\r?\n/);
      this._functions.set(name, {
        name,
        path,
        lines,
        cache: new Array(lines.length),
      });
    };

    if (this.files instanceof Map) {
      for (const [path, text] of this.files) add(normalizePath(path), text);
    } else {
      for (const path of Object.keys(this.files)) add(normalizePath(path), this.files[path]);
    }
  }

  _readFile(path) {
    const key = normalizePath(path);
    if (this.files instanceof Map) return this.files.get(key);
    if (this.files && Object.prototype.hasOwnProperty.call(this.files, key)) {
      return this.files[key];
    }
    return undefined;
  }

  /**
   * Read a function tag (`data/minecraft/tags/function/<kind>.json`).
   * Missing/malformed file falls back to the canonical tickpack entry point.
   */
  _readFunctionTag(kind, fallback) {
    const text = this._readFile(`data/minecraft/tags/function/${kind}.json`);
    if (text === undefined || text === null) return [fallback];
    try {
      const data = JSON.parse(String(text));
      const values = data && Array.isArray(data.values) ? data.values : [];
      const names = [];
      for (const value of values) {
        let id = null;
        if (typeof value === 'string') id = value;
        else if (value && typeof value.id === 'string') id = value.id;
        if (!id || id.startsWith('#')) continue;
        names.push(id.includes(':') ? id : `tp:${id}`);
      }
      return names;
    } catch {
      return [fallback];
    }
  }

  // --------------------------------------------------------------- public API

  /** Clear scores/world/press state, create the host player, then run the load tag. */
  reset() {
    this.state = createState();
    // The host player always exists when a world/reset happens; commands can still
    // kill it (`kill @a`), and snapshots record whether it is alive.
    this.state.entities.push(createPlayerEntity(this.state.nextEntityId++));
    this._events = [];
    this._budget = 0;
    this._depth = 0;
    this._collect = false;
    try {
      for (const name of this.loadFunctions) {
        try {
          this._callFunction(name, rootContext(), null);
        } catch {
          // Load failures are not surfaced by the §5 contract; they only happen
          // for malformed packs, and the tick run will report them if relevant.
        }
      }
    } finally {
      this._collect = true;
      this._events = [];
    }
  }

  /** Execute the tick tag (`tp:tick`) once, then increment the internal tick count. */
  step() {
    this._events = [];
    this._collect = true;
    this._budget = 0;
    this._depth = 0;

    const tick = this.state.tick;
    const ctx = rootContext();

    try {
      for (const name of this.tickFunctions) {
        try {
          this._callFunction(name, ctx, null);
        } catch (e) {
          if (e instanceof BudgetError) throw e;
          this._emitError(e, null);
        }
      }
    } catch (e) {
      if (e instanceof BudgetError) {
        this._emit({
          type: 'error',
          tick,
          message: e.message,
          ...locFields(e.loc),
        });
      } else {
        this._emit({
          type: 'error',
          tick,
          message: e && e.message ? e.message : String(e),
        });
      }
    } finally {
      this.state.tick = tick + 1;
    }

    return this._events;
  }

  /** Host input: mirrors "the player pressed a key" into #__press. */
  press() {
    this.state.presses += 1;
    const tp = this.state.scores.get('tp');
    if (tp) {
      const next = wrap32((tp.get('#__press') || 0) + 1);
      tp.set('#__press', next);
    }
  }

  getTick() {
    return this.state.tick;
  }

  /** Only non-air blocks; integer coordinates. */
  getWorld() {
    const blocks = [];
    for (const [key, block] of this.state.blocks) {
      const parts = key.split(',');
      blocks.push({
        x: Number(parts[0]),
        y: Number(parts[1]),
        z: Number(parts[2]),
        block,
      });
    }
    blocks.sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);

    const entities = this.state.entities.map((entity) => ({
      id: entity.id,
      type: entity.type,
      x: entity.x,
      y: entity.y,
      z: entity.z,
      yaw: entity.yaw,
      pitch: entity.pitch,
      tags: entity.tags.slice(),
    }));

    return { blocks, entities };
  }

  /** `{ objective: { scoreHolder: int } }` — a fresh plain object each call. */
  getScores() {
    const out = {};
    for (const [objective, entries] of this.state.scores) {
      const scores = {};
      for (const [holder, value] of entries) scores[holder] = value;
      out[objective] = scores;
    }
    return out;
  }

  /** Plain structured-cloneable full state. */
  snapshot() {
    const blocks = [];
    for (const [key, block] of this.state.blocks) {
      const parts = key.split(',');
      blocks.push([Number(parts[0]), Number(parts[1]), Number(parts[2]), block]);
    }
    blocks.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);

    return {
      version: 1,
      tick: this.state.tick,
      presses: this.state.presses,
      nextEntityId: this.state.nextEntityId,
      scores: this.getScores(),
      blocks,
      entities: this.state.entities.map((entity) => ({
        id: entity.id,
        type: entity.type,
        x: entity.x,
        y: entity.y,
        z: entity.z,
        yaw: entity.yaw,
        pitch: entity.pitch,
        tags: entity.tags.slice(),
      })),
    };
  }

  /** Restore a snapshot (no tag reload, no load run). */
  restore(snapshot) {
    const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const state = createState();

    if (Number.isFinite(snap.tick)) state.tick = snap.tick | 0;
    if (Number.isFinite(snap.presses)) state.presses = snap.presses;
    if (Number.isFinite(snap.nextEntityId)) state.nextEntityId = snap.nextEntityId | 0;

    const scores = snap.scores && typeof snap.scores === 'object' ? snap.scores : {};
    for (const objective of Object.keys(scores)) {
      const entries = new Map();
      const values = scores[objective] && typeof scores[objective] === 'object' ? scores[objective] : {};
      for (const holder of Object.keys(values)) entries.set(holder, wrap32(values[holder] | 0));
      state.objectives.add(objective);
      state.scores.set(objective, entries);
    }

    if (Array.isArray(snap.blocks)) {
      for (const entry of snap.blocks) {
        // Accepted block shapes:
        //   [x, y, z, block]    current 3D snapshot
        //   [x, z, block]       old 2D snapshot (y defaults to 0)
        //   { x, y?, z, block } defensive/object form (y defaults to 0)
        let x;
        let y;
        let z;
        let block;
        if (Array.isArray(entry)) {
          if (entry.length >= 4) {
            x = Number(entry[0]);
            y = Number(entry[1]);
            z = Number(entry[2]);
            block = entry[3];
          } else if (entry.length === 3) {
            x = Number(entry[0]);
            y = 0;
            z = Number(entry[1]);
            block = entry[2];
          } else {
            continue;
          }
        } else if (entry && typeof entry === 'object' && entry.block !== undefined) {
          x = Number(entry.x);
          y = entry.y === undefined ? 0 : Number(entry.y);
          z = Number(entry.z);
          block = entry.block;
        } else {
          continue;
        }
        x = Math.floor(x);
        y = Math.floor(y);
        z = Math.floor(z);
        block = canonicalBlock(block);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        if (block === 'air') continue;
        state.blocks.set(blockKey(x, y, z), block);
      }
    }

    if (Array.isArray(snap.entities)) {
      for (const raw of snap.entities) {
        if (!raw || typeof raw !== 'object') continue;
        state.entities.push({
          id: Number.isFinite(raw.id) ? raw.id : state.nextEntityId++,
          type: canonicalEntity(raw.type),
          x: Number(raw.x) || 0,
          y: Number(raw.y) || 0,
          z: Number(raw.z) || 0,
          yaw: Number(raw.yaw) || 0,
          pitch: Number(raw.pitch) || 0,
          tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
        });
      }
    }

    this.state = state;
    this._events = [];
  }

  // ------------------------------------------------------------- trace emitter

  _emit(event) {
    if (this._collect) this._events.push(event);
  }

  _emitError(error, loc) {
    const message = error && error.message ? error.message : String(error);
    this._emit({
      type: 'error',
      tick: this.state.tick,
      message,
      ...locFields(loc),
    });
  }

  _chargeBudget(loc) {
    if (this._budget >= MAX_COMMANDS_PER_TICK) throw new BudgetError(loc);
    this._budget += 1;
  }

  // ------------------------------------------------------------- function run

  _callFunction(name, ctx, loc) {
    const resolved = resolveFunctionName(name);
    const entry = resolved ? this._functions.get(resolved) : null;
    if (!entry) throw new SimError(`unknown function '${resolved || name}'`);

    if (this._depth >= MAX_FUNCTION_DEPTH) {
      this._emitError(
        new SimError(
          `function recursion depth exceeded (${MAX_FUNCTION_DEPTH}) calling '${resolved}'`,
        ),
        loc,
      );
      return;
    }

    this._depth += 1;
    try {
      for (let i = 0; i < entry.lines.length; i++) this._execLine(entry, i, ctx);
    } catch (e) {
      if (!(e instanceof ReturnSignal)) throw e;
      // `/return`: stop this function, keep the caller going.
    } finally {
      this._depth -= 1;
    }
  }

  _execLine(entry, index, ctx) {
    let parsed = entry.cache[index];
    if (parsed === undefined) {
      parsed = parseCommand(entry.lines[index]);
      entry.cache[index] = parsed;
    }
    if (!parsed || parsed.kind === 'empty') return;

    const loc = { file: entry.path, line: index + 1, fn: entry.name };
    this._chargeBudget(loc);

    try {
      const shouldEmit = this._execCommand(parsed, ctx, loc);
      if (shouldEmit) {
        let text = entry.lines[index].trim();
        if (text.startsWith('/')) text = text.slice(1).trim();
        this._emit({
          type: 'command',
          tick: this.state.tick,
          file: loc.file,
          line: loc.line,
          fn: loc.fn,
          text,
        });
      }
    } catch (e) {
      if (e instanceof BudgetError || e instanceof ReturnSignal) throw e;
      this._emitError(e, loc);
    }
  }

  // ----------------------------------------------------------- command dispatcher

  /**
   * Execute one parsed command in a context.
   * Returns true when this command line should emit a `command` trace event.
   * Throws SimError for unsupported/failing commands (the caller turns that into
   * an `error` event and keeps going). BudgetError is the only exception that
   * aborts the whole tick.
   */
  _execCommand(cmd, ctx, loc) {
    switch (cmd.kind) {
      case 'empty':
        return false;
      case 'error':
        throw new SimError(cmd.message);
      case 'unknown':
        throw new SimError(`unsupported command '${cmd.name}'`);

      case 'say': {
        this._emit({
          type: 'say',
          tick: this.state.tick,
          text: cmd.text,
          ...locFields(loc),
        });
        return false;
      }

      case 'particle': {
        const p = resolvePosition(cmd.coords, ctx);
        this._emit({
          type: 'particle',
          tick: this.state.tick,
          x: p.x,
          y: p.y,
          z: p.z,
          particle: cmd.particle,
          ...locFields(loc),
        });
        return false;
      }

      case 'playsound': {
        // Recipients are selected with vanilla selector rules; no players (or no
        // matching @e) means the command is a no-op, so no sound event.
        if (!this._select(cmd.targets, ctx).length) return false;
        const p = cmd.coords
          ? resolvePosition(cmd.coords, ctx)
          : { x: ctx.pos.x, y: ctx.pos.y, z: ctx.pos.z };
        this._emit({
          type: 'sound',
          tick: this.state.tick,
          sound: cmd.sound,
          volume: cmd.volume,
          pitch: cmd.pitch,
          x: p.x,
          y: p.y,
          z: p.z,
          ...locFields(loc),
        });
        return false;
      }

      case 'execute':
        return this._execExecute(cmd, ctx, loc);

      case 'function':
        this._callFunction(cmd.name, ctx, loc);
        return false; // inner lines emit their own trace events

      case 'return': {
        if (cmd.command) this._execCommand(cmd.command, ctx, loc);
        throw new ReturnSignal();
      }

      case 'scoreboard.objectives.add': {
        if (!this.state.objectives.has(cmd.objective)) {
          this.state.objectives.add(cmd.objective);
          this.state.scores.set(cmd.objective, new Map());
        }
        return true;
      }

      case 'scoreboard.objectives.remove': {
        this.state.objectives.delete(cmd.objective);
        this.state.scores.delete(cmd.objective);
        return true;
      }

      case 'scoreboard.players.set': {
        const objective = this._requireObjective(cmd.objective);
        objective.set(cmd.target, wrap32(cmd.value));
        return true;
      }

      case 'scoreboard.players.add': {
        const objective = this._requireObjective(cmd.objective);
        objective.set(cmd.target, wrap32((objective.get(cmd.target) || 0) + cmd.value));
        return true;
      }

      case 'scoreboard.players.remove': {
        const objective = this._requireObjective(cmd.objective);
        objective.set(cmd.target, wrap32((objective.get(cmd.target) || 0) - cmd.value));
        return true;
      }

      case 'scoreboard.players.reset': {
        if (cmd.objective) {
          const objective = this._requireObjective(cmd.objective);
          objective.delete(cmd.target);
        } else {
          for (const objective of this.state.scores.values()) objective.delete(cmd.target);
        }
        return true;
      }

      case 'scoreboard.players.operation':
        this._execOperation(cmd);
        return true;

      case 'tp':
        this._execTp(cmd, ctx);
        return true;

      case 'setblock':
        return this._execSetblock(cmd, ctx);

      case 'fill':
        this._execFill(cmd, ctx);
        return true;

      case 'summon':
        this._execSummon(cmd, ctx);
        return true;

      case 'kill':
        this._execKill(cmd, ctx);
        return true;

      case 'tag':
        this._execTag(cmd, ctx);
        return true;

      default:
        throw new SimError(`unsupported command kind '${cmd.kind}'`);
    }
  }

  _execExecute(cmd, ctx, loc) {
    let contexts = [ctx];

    for (const mod of cmd.mods) {
      if (!contexts.length) return false;

      if (mod.type === 'as') {
        const next = [];
        for (const current of contexts) {
          for (const entity of this._select(mod.selector, current)) {
            next.push({ pos: current.pos, rot: current.rot, executor: entity });
          }
        }
        contexts = next;
      } else if (mod.type === 'at') {
        const next = [];
        for (const current of contexts) {
          for (const entity of this._select(mod.selector, current)) {
            next.push({
              pos: { x: entity.x, y: entity.y, z: entity.z },
              rot: { yaw: entity.yaw, pitch: entity.pitch },
              executor: current.executor,
            });
          }
        }
        contexts = next;
      } else if (mod.type === 'positioned') {
        contexts = contexts.map((current) => ({
          pos: resolvePosition(mod.coords, current),
          rot: current.rot,
          executor: current.executor,
        }));
      } else if (mod.type === 'rotated') {
        contexts = contexts.map((current) => ({
          pos: current.pos,
          rot: {
            yaw: resolveRotationToken(mod.yaw, current.rot.yaw),
            pitch: resolveRotationToken(mod.pitch, current.rot.pitch),
          },
          executor: current.executor,
        }));
      } else if (mod.type === 'condition') {
        contexts = contexts.filter(
          (current) => this._checkCondition(mod.cond, current) !== mod.negate,
        );
      }
    }

    if (!contexts.length) return false;

    let emitted = false;
    for (const current of contexts) {
      try {
        if (this._execCommand(cmd.command, current, loc)) emitted = true;
      } catch (e) {
        if (e instanceof BudgetError || e instanceof ReturnSignal) throw e;
        this._emitError(e, loc);
      }
    }
    return emitted;
  }

  _checkCondition(cond, ctx) {
    if (cond.type === 'score') {
      const a = this._getScore(cond.objective, cond.target);
      if (cond.op === 'matches') return matchesRange(a, cond.range);
      const b = this._getScore(cond.objective2, cond.target2);
      switch (cond.op) {
        case '=':
        case '==':
          return a === b;
        case '!=':
        case '<>':
          return a !== b;
        case '<':
          return a < b;
        case '<=':
          return a <= b;
        case '>':
          return a > b;
        case '>=':
          return a >= b;
        default:
          throw new SimError(`unsupported score comparison '${cond.op}'`);
      }
    }

    if (cond.type === 'block') {
      const p = floorPos(resolvePosition(cond.coords, ctx));
      const actual = this.state.blocks.get(blockKey(p.x, p.y, p.z)) || 'air';
      return actual === cond.block;
    }

    if (cond.type === 'entity') {
      return this._select(cond.selector, ctx).length > 0;
    }

    throw new SimError(`unsupported condition '${cond.type}'`);
  }

  // ------------------------------------------------------------- scoreboards

  _requireObjective(name) {
    const entries = this.state.scores.get(name);
    if (!entries) throw new SimError(`unknown scoreboard objective '${name}'`);
    return entries;
  }

  _getScore(objective, holder) {
    const entries = this.state.scores.get(objective);
    if (!entries) return 0; // unknown score == 0
    const value = entries.get(holder);
    return value === undefined ? 0 : value;
  }

  _execOperation(cmd) {
    const target = this._requireObjective(cmd.objective);
    const source = this._requireObjective(cmd.sourceObjective);
    const current = target.get(cmd.target) || 0;
    const value = source.get(cmd.source) || 0;

    let next;
    switch (cmd.op) {
      case '=':
        next = value;
        break;
      case '+=':
        next = (current + value) | 0;
        break;
      case '-=':
        next = (current - value) | 0;
        break;
      case '*=':
        next = Math.imul(current, value);
        break;
      case '/=':
        // Spec §5: `/` truncates toward zero; division by zero yields 0.
        next = value === 0 ? 0 : wrap32(Math.trunc(current / value));
        break;
      case '%=':
        next = value === 0 ? 0 : wrap32(current % value);
        break;
      case '<':
        next = Math.min(current, value);
        break;
      case '>':
        next = Math.max(current, value);
        break;
      case '><':
        target.set(cmd.target, value);
        source.set(cmd.source, current);
        return;
      default:
        throw new SimError(`unsupported scoreboard operation '${cmd.op}'`);
    }
    target.set(cmd.target, wrap32(next));
  }

  // --------------------------------------------------------------- movement

  _execTp(cmd, ctx) {
    const targets = this._select(cmd.selector, ctx);
    const p = resolvePosition(cmd.coords, ctx);

    for (const entity of targets) {
      entity.x = p.x;
      entity.y = p.y;
      entity.z = p.z;
      // Spec §5: `~N` rotation on tp adds N to the target's own yaw.
      if (cmd.yaw) entity.yaw = resolveRotationToken(cmd.yaw, entity.yaw);
      if (cmd.pitch) entity.pitch = resolveRotationToken(cmd.pitch, entity.pitch);
    }
  }

  // ------------------------------------------------------------------ blocks

  _execSetblock(cmd, ctx) {
    const p = floorPos(resolvePosition(cmd.coords, ctx));
    const key = blockKey(p.x, p.y, p.z);
    const existing = this.state.blocks.get(key);

    if (cmd.mode === 'keep' && existing !== undefined) return false;
    if (cmd.block === (existing === undefined ? 'air' : existing)) return false;

    if (cmd.block === 'air') this.state.blocks.delete(key);
    else this.state.blocks.set(key, cmd.block);
    return true;
  }

  _execFill(cmd, ctx) {
    const a = floorPos(resolvePosition(cmd.from, ctx));
    const b = floorPos(resolvePosition(cmd.to, ctx));

    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    const minZ = Math.min(a.z, b.z);
    const maxZ = Math.max(a.z, b.z);

    const volume = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
    if (volume > MAX_FILL_VOLUME) {
      throw new SimError(`fill volume ${volume} exceeds the ${MAX_FILL_VOLUME}-block limit`);
    }

    if (cmd.mode === 'keep') {
      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          for (let z = minZ; z <= maxZ; z++) {
            const key = blockKey(x, y, z);
            if (!this.state.blocks.has(key) && cmd.block !== 'air') {
              this.state.blocks.set(key, cmd.block);
            }
          }
        }
      }
      return;
    }

    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          const key = blockKey(x, y, z);
          if (cmd.block === 'air') this.state.blocks.delete(key);
          else this.state.blocks.set(key, cmd.block);
        }
      }
    }
  }

  // --------------------------------------------------------------- entities

  _execSummon(cmd, ctx) {
    const p = resolvePosition(cmd.coords, ctx);
    this.state.entities.push({
      id: this.state.nextEntityId++,
      type: cmd.entityType,
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: 0,
      pitch: 0,
      tags: cmd.tags.slice(),
    });
  }

  _execKill(cmd, ctx) {
    const targets = this._select(cmd.selector, ctx);
    if (!targets.length) return;
    const kill = new Set(targets);
    this.state.entities = this.state.entities.filter((entity) => !kill.has(entity));
  }

  _execTag(cmd, ctx) {
    for (const entity of this._select(cmd.selector, ctx)) {
      if (cmd.action === 'add') {
        if (!entity.tags.includes(cmd.tag)) entity.tags.push(cmd.tag);
      } else {
        entity.tags = entity.tags.filter((tag) => tag !== cmd.tag);
      }
    }
  }

  // -------------------------------------------------------------- selectors

  _select(selector, ctx) {
    const pos = (ctx && ctx.pos) || { x: 0, y: 0, z: 0 };

    let list;
    if (selector.base === 's') {
      if (!ctx || !ctx.executor) return [];
      list = [ctx.executor];
    } else if (selector.base === 'a' || selector.base === 'p') {
      // Vanilla: @a / @p only ever select players. The mini world's only player is
      // the virtual host player; pen armor stands are deliberately not players.
      list = this.state.entities.filter(isPlayerEntity);
    } else {
      // @e selects every entity (player included).
      list = this.state.entities.slice();
    }

    list = list.filter((entity) => this._selectorMatches(entity, selector, pos));

    const sort = selector.sort || (selector.base === 'p' ? 'nearest' : null);
    if (sort === 'nearest') {
      list.sort((a, b) => distanceSq(a, pos) - distanceSq(b, pos) || a.id - b.id);
    } else if (sort === 'farthest') {
      list.sort((a, b) => distanceSq(b, pos) - distanceSq(a, pos) || a.id - b.id);
    } else if (sort === 'random') {
      // Deterministic stand-in for random: stable id order (v0.1 forbids randomness).
      list.sort((a, b) => a.id - b.id);
    }

    const limit =
      selector.limit !== null
        ? selector.limit
        : selector.base === 'p'
          ? 1
          : null;
    if (limit !== null && limit >= 0 && list.length > limit) list = list.slice(0, limit);
    return list;
  }

  _selectorMatches(entity, selector, pos) {
    for (const tag of selector.tags) {
      if (!entity.tags.includes(tag)) return false;
    }
    if (selector.types.length) {
      const type = canonicalEntity(entity.type);
      if (!selector.types.includes(type)) return false;
    }
    if (selector.name !== null) {
      if (!entity.name || entity.name !== selector.name) return false;
    }
    if (selector.distance) {
      const distance = Math.sqrt(distanceSq(entity, pos));
      if (!matchesRange(distance, selector.distance)) return false;
    }
    return true;
  }
}

export default Simulator;
