// Tickpack compiler tests.
//
// The spec is docs/LANG.md; these tests pin the generated datapack down so that
// regressions in the temporal lowering (loop = clock, wait = sleep, if = branch
// states) are caught immediately. Two kinds of tests:
//
//  1. golden tests: exact generated mcfunction for small programs, including the
//     load/tick/dispatch ordering from §2.2/§2.3;
//  2. semantic tests: a tiny *test-only* stepper (`MiniSim`, ~100 lines) executes
//     the generated commands tick by tick and asserts observable behavior. The
//     real simulator lives in src/sim and is integration-tested by the Lead; this
//     one exists so the compiler's timing can be verified without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compile } from '../src/lang/compile.js';
import { PRELUDE } from '../src/lang/prelude.js';
import { SAMPLES } from '../src/samples.js';

const PRELUDE_LINE_COUNT = (PRELUDE.match(/\n/g) || []).length;

/** The compiler-owned runtime brush palette; the array index is the #__brush value. */
const PALETTE = [
  'stone',
  'gold_block',
  'redstone_block',
  'emerald_block',
  'lapis_block',
  'diamond_block',
  'coal_block',
  'glowstone',
  'white_wool',
  'purple_wool',
  'oak_planks',
  'glass',
];

const MAIN_STATE_PATH = /^data\/tp\/function\/main\/s(\d+)\.mcfunction$/;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function compileOk(source) {
  const out = compile(source);
  assert.equal(out.ok, true, `expected success, got ${JSON.stringify(out.diagnostics)}`);
  assert.deepEqual(out.diagnostics, []);
  return out;
}

function compileError(source) {
  const out = compile(source);
  assert.equal(out.ok, false, `expected a compile error for:\n${source}`);
  assert.deepEqual(out.files, {}, 'a failed compile must not produce pack files');
  assert.ok(out.diagnostics.length > 0, 'expected at least one diagnostic');
  const first = out.diagnostics[0];
  assert.equal(first.severity, 'error');
  assert.equal(typeof first.line, 'number');
  return first;
}

function lines(out, path) {
  assert.ok(out.files[path], `missing pack file ${path}`);
  return out.files[path].split('\n');
}

function commands(out, path) {
  return lines(out, path)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** Non-empty lines including comments (useful for pack readability assertions). */
function contentLines(out, path) {
  return lines(out, path)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function mainStatePaths(out) {
  return Object.keys(out.files)
    .filter((path) => MAIN_STATE_PATH.test(path))
    .sort((a, b) => Number(a.match(MAIN_STATE_PATH)[1]) - Number(b.match(MAIN_STATE_PATH)[1]));
}

function mcfunctionPaths(out) {
  return Object.keys(out.files).filter((path) => path.endsWith('.mcfunction'));
}

function stateContaining(out, needle) {
  const path = mainStatePaths(out).find((candidate) => out.files[candidate].includes(needle));
  assert.ok(path, `no main state contains ${JSON.stringify(needle)}`);
  return path;
}

function lineIndex(list, needle) {
  const index = list.findIndex((line) => line.includes(needle));
  assert.ok(index >= 0, `expected a line containing ${JSON.stringify(needle)}`);
  return index;
}

/** The pen must never be spawned by world load: tp:start anchors it to a player. */
function assertNoPenSummonInLoad(out) {
  assert.ok(
    !commands(out, 'data/tp/function/load.mcfunction').some((line) => line.startsWith('summon ')),
    'load.mcfunction must not summon the pen; tp:start anchors it to the player',
  );
}

function assertOrder(list, needles) {
  let previous = -1;
  for (const needle of needles) {
    const index = lineIndex(list, needle);
    assert.ok(index > previous, `expected ${JSON.stringify(needle)} after the previous line (order: ${needles.join(' -> ')})`);
    previous = index;
  }
}

// ---------------------------------------------------------------------------
// MiniSim: a deliberately tiny reference stepper for the *emitted* command subset
// used by these tests. Not the product simulator —just enough to run the packs
// the tests generate (scoreboard + execute score conditions + function + say).
// ---------------------------------------------------------------------------

function matchesRange(value, range) {
  if (range === '..') return true;
  const dots = range.indexOf('..');
  if (dots >= 0) {
    const low = range.slice(0, dots);
    const high = range.slice(dots + 2);
    if (low !== '' && value < Number(low)) return false;
    if (high !== '' && value > Number(high)) return false;
    return true;
  }
  return value === Number(range);
}

const WORLD_COMMAND = /^(tp|setblock|fill|summon|kill|tag|particle)\b/;

const PLAYER_TYPE = 'player';

function distanceSq(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
}

/**
 * The stepper models just enough of vanilla to test the generated startup:
 * a virtual player entity at (0.5, 1, 0.5), vanilla-ish @a/@p/@e selectors,
 * `execute if entity`, `execute at @p`, summon with `~` offsets, kill and tp.
 * The product simulator (src/sim) is the real thing; this is for compiler tests.
 */
class MiniSim {
  constructor(files) {
    this.files = files;
    this.functions = new Map();
    for (const path of Object.keys(files)) {
      const match = /^data\/([^/]+)\/function\/(.+)\.mcfunction$/.exec(path);
      if (match) {
        this.functions.set(`${match[1]}:${match[2]}`, { path, lines: files[path].split('\n') });
      }
    }
    this.tick = 0;
    this.scores = new Map();
    this.events = [];
    this.entities = [];
    this.blocks = new Map();
    this.nextEntityId = 1;
  }

  objective() {
    let map = this.scores.get('tp');
    if (!map) {
      map = new Map();
      this.scores.set('tp', map);
    }
    return map;
  }

  getScore(name) {
    const value = this.objective().get(name);
    return value === undefined ? 0 : value;
  }

  setScore(name, value) {
    this.objective().set(name, value | 0);
  }

  reset() {
    this.scores.clear();
    this.tick = 0;
    this.events = [];
    this.entities = [];
    this.blocks = new Map();
    this.nextEntityId = 1;
    this.objective();
    this.addPlayer(); // the host player is already in the world when the sim starts
    this.runFunction('tp:load');
    this.events = [];
  }

  // -- virtual entities (test hooks) ---------------------------------------

  addPlayer(x = 0.5, y = 1.0, z = 0.5) {
    const player = { id: this.nextEntityId, type: PLAYER_TYPE, x, y, z, yaw: 0, pitch: 0, tags: [] };
    this.nextEntityId += 1;
    this.entities.push(player);
    return player;
  }

  players() {
    return this.entities.filter((entity) => entity.type === PLAYER_TYPE);
  }

  /** Models "nobody has joined the world yet". */
  removePlayers() {
    this.entities = this.entities.filter((entity) => entity.type !== PLAYER_TYPE);
  }

  movePlayer(x, y, z) {
    const player = this.players()[0];
    if (player) {
      player.x = x;
      player.y = y;
      player.z = z;
    }
  }

  getEntities() {
    return this.entities.map((entity) => ({ ...entity, tags: entity.tags.slice() }));
  }

  findPen() {
    return this.entities.find((entity) => entity.tags.includes('pen')) || null;
  }

  getBlocks() {
    return [...this.blocks.values()];
  }

  rootContext() {
    return { pos: { x: 0, y: 0, z: 0 }, rot: { yaw: 0, pitch: 0 }, executor: null };
  }

  press() {
    this.setScore('#__press', this.getScore('#__press') + 1);
  }

  getTick() {
    return this.tick;
  }

  step() {
    this.events = [];
    this.runFunction('tp:tick');
    this.tick += 1;
    const events = this.events;
    return events;
  }

  /** Runs a command as if a player typed it in chat (e.g. `execute positioned ... run function ...`). */
  runCommand(text) {
    this.events = [];
    this.exec(String(text).trim(), '<chat>', 1, this.rootContext());
    return this.events;
  }

  runFunction(name, ctx = this.rootContext()) {
    const fn = this.functions.get(name);
    assert.ok(fn, `MiniSim: unknown function '${name}'`);
    fn.lines.forEach((line, index) => {
      const text = line.trim();
      if (text === '' || text.startsWith('#')) return;
      this.exec(text, fn.path, index + 1, ctx);
    });
  }

  // -- selectors -----------------------------------------------------------

  select(selector, ctx) {
    const text = String(selector).trim();
    if (text === '@a') return this.players();
    if (text === '@p') {
      const nearest = this.players().slice();
      nearest.sort((a, b) => distanceSq(a, ctx.pos) - distanceSq(b, ctx.pos) || a.id - b.id);
      return nearest.slice(0, 1);
    }
    if (text === '@s') return ctx.executor ? [ctx.executor] : [];
    if (text.startsWith('@e')) {
      let list = this.entities.slice();
      const match = /@e\[(.*)\]$/.exec(text);
      if (match) {
        for (const rawPart of match[1].split(',')) {
          const [key, value] = rawPart.split('=').map((part) => part.trim());
          if (key === 'tag') list = list.filter((entity) => entity.tags.includes(value));
          else if (key === 'type') {
            list = list.filter((entity) => entity.type === value.replace(/^minecraft:/, ''));
          } else if (key === 'limit') {
            list = list.slice(0, Number(value));
          }
        }
      }
      return list;
    }
    assert.fail(`MiniSim: unsupported selector '${selector}'`);
  }

  resolvePosition(tokens, ctx) {
    const [tx, ty, tz] = tokens;
    const parseOffset = (token) => (token.length === 1 ? 0 : Number(token.slice(1)));
    const base = ctx.pos;
    let x = tx.startsWith('~') ? base.x + parseOffset(tx) : Number(tx);
    // `^` on the y axis is "up", i.e. still relative to the execution position.
    let y = ty.startsWith('~') || ty.startsWith('^') ? base.y + parseOffset(ty) : Number(ty);
    let z = tz.startsWith('~') ? base.z + parseOffset(tz) : Number(tz);
    const localX = tx.startsWith('^') ? parseOffset(tx) : 0;
    const localZ = tz.startsWith('^') ? parseOffset(tz) : 0;
    if (tx.startsWith('^') || tz.startsWith('^')) {
      const yaw = ((ctx.rot && ctx.rot.yaw) || 0) * (Math.PI / 180);
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      x = base.x + localX * cos - localZ * sin;
      z = base.z + localX * sin + localZ * cos;
    }
    return { x, y, z };
  }

  // -- command execution ---------------------------------------------------

  exec(text, file, line, ctx) {
    if (text.startsWith('execute ')) {
      this.execExecute(text.slice('execute '.length), file, line, ctx);
      return;
    }
    this.events.push({ type: 'command', tick: this.tick, file, line, text });

    if (/^say\b/.test(text)) {
      this.events.push({ type: 'say', tick: this.tick, file, line, text: text.replace(/^say\s?/, '') });
      return;
    }

    let match;
    if ((match = /^function\s+(\S+)$/.exec(text))) {
      this.runFunction(match[1], ctx);
      return;
    }
    if (/^scoreboard objectives add \S+ dummy$/.test(text)) return;
    if ((match = /^scoreboard players (set|add|remove) (\S+) tp (-?\d+)$/.exec(text))) {
      const current = this.getScore(match[2]);
      const value = Number(match[3]);
      const next = match[1] === 'set' ? value : match[1] === 'add' ? current + value : current - value;
      this.setScore(match[2], next);
      return;
    }
    if ((match = /^scoreboard players operation (\S+) tp (=|\+=|-=|\*=|\/=|%=) (\S+) tp$/.exec(text))) {
      const current = this.getScore(match[1]);
      const value = this.getScore(match[3]);
      let next;
      switch (match[2]) {
        case '=':
          next = value;
          break;
        case '+=':
          next = current + value;
          break;
        case '-=':
          next = current - value;
          break;
        case '*=':
          next = Math.imul(current, value);
          break;
        case '/=':
          next = value === 0 ? 0 : Math.trunc(current / value);
          break;
        case '%=':
          next = value === 0 ? 0 : current % value;
          break;
        default:
          assert.fail(`MiniSim: unknown operation ${match[2]}`);
      }
      this.setScore(match[1], next);
      return;
    }
    if ((match = /^summon\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(text))) {
      const pos = this.resolvePosition([match[2], match[3], match[4]], ctx);
      const tags = [];
      if (match[5]) {
        const tagMatch = /Tags\s*:\s*\[([^\]]*)\]/.exec(match[5]);
        if (tagMatch) {
          for (const part of tagMatch[1].split(',')) {
            const tag = part.trim().replace(/^"|"$/g, '');
            if (tag) tags.push(tag);
          }
        }
      }
      this.entities.push({
        id: this.nextEntityId,
        type: match[1].replace(/^minecraft:/, ''),
        x: pos.x,
        y: pos.y,
        z: pos.z,
        yaw: 0,
        pitch: 0,
        tags,
      });
      this.nextEntityId += 1;
      return;
    }
    if ((match = /^tp\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(\S+)\s+(\S+))?$/.exec(text))) {
      const targets = this.select(match[1], ctx);
      const pos = this.resolvePosition([match[2], match[3], match[4]], ctx);
      for (const entity of targets) {
        entity.x = pos.x;
        entity.y = pos.y;
        entity.z = pos.z;
        if (match[5] !== undefined) {
          entity.yaw = match[5].startsWith('~')
            ? entity.yaw + (match[5].length === 1 ? 0 : Number(match[5].slice(1)))
            : Number(match[5]);
        }
        if (match[6] !== undefined) {
          entity.pitch = match[6].startsWith('~')
            ? entity.pitch + (match[6].length === 1 ? 0 : Number(match[6].slice(1)))
            : Number(match[6]);
        }
      }
      return;
    }
    if ((match = /^kill\s+(\S+)$/.exec(text))) {
      const doomed = new Set(this.select(match[1], ctx));
      this.entities = this.entities.filter((entity) => !doomed.has(entity));
      return;
    }
    if ((match = /^tag\s+(\S+)\s+(add|remove)\s+(\S+)$/.exec(text))) {
      for (const entity of this.select(match[1], ctx)) {
        if (match[2] === 'add') {
          if (!entity.tags.includes(match[3])) entity.tags.push(match[3]);
        } else {
          entity.tags = entity.tags.filter((tag) => tag !== match[3]);
        }
      }
      return;
    }
    if ((match = /^setblock\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/.exec(text))) {
      const pos = this.resolvePosition([match[1], match[2], match[3]], ctx);
      const x = Math.floor(pos.x);
      const y = Math.floor(pos.y);
      const z = Math.floor(pos.z);
      if (match[4] === 'air') this.blocks.delete(`${x},${y},${z}`);
      else this.blocks.set(`${x},${y},${z}`, { x, y, z, block: match[4].replace(/^minecraft:/, '') });
      return;
    }
    if (WORLD_COMMAND.test(text)) return; // fill/particle: recorded only, not simulated
    assert.fail(`MiniSim: unsupported command '${text}'`);
  }

  execExecute(rest, file, line, ctx) {
    const runIndex = rest.indexOf(' run ');
    assert.ok(runIndex >= 0, `MiniSim: 'execute' without ' run ': ${rest}`);
    const head = rest.slice(0, runIndex).trim();
    const command = rest.slice(runIndex + ' run '.length);
    const tokens = head.split(/\s+/).filter(Boolean);

    let passes = true;
    const local = { pos: { ...ctx.pos }, rot: { ...ctx.rot }, executor: ctx.executor };
    let index = 0;
    while (index < tokens.length) {
      const word = tokens[index];
      if (word === 'as') {
        const targets = this.select(tokens[index + 1], local);
        if (targets.length === 0) passes = false;
        else local.executor = targets[0];
        index += 2;
        continue;
      }
      if (word === 'at') {
        const targets = this.select(tokens[index + 1], local);
        if (targets.length === 0) passes = false;
        else {
          local.pos = { x: targets[0].x, y: targets[0].y, z: targets[0].z };
          local.rot = { yaw: targets[0].yaw, pitch: targets[0].pitch };
        }
        index += 2;
        continue;
      }
      if (word === 'positioned') {
        local.pos = this.resolvePosition(tokens.slice(index + 1, index + 4), local);
        index += 4;
        continue;
      }
      if (word === 'rotated') {
        index += 3;
        continue;
      }
      if (word === 'if' || word === 'unless') {
        const kind = tokens[index + 1];
        if (kind === 'score') {
          assert.equal(tokens[index + 3], 'tp', `MiniSim: only objective tp (${head})`);
          assert.equal(tokens[index + 4], 'matches', `MiniSim: only matches ranges (${head})`);
          const ok = matchesRange(this.getScore(tokens[index + 2]), tokens[index + 5]);
          passes = passes && (word === 'if' ? ok : !ok);
          index += 6;
          continue;
        }
        if (kind === 'entity') {
          const ok = this.select(tokens[index + 2], local).length > 0;
          passes = passes && (word === 'if' ? ok : !ok);
          index += 3;
          continue;
        }
        assert.fail(`MiniSim: unsupported condition '${kind}' in: ${head}`);
      }
      assert.fail(`MiniSim: unsupported execute clause '${word}' in: ${head}`);
    }
    if (passes) this.exec(command, file, line, local);
  }
}

// Runs a program and steps it, returning all events and the final MiniSim.
function runProgram(source, ticks, between) {
  const out = compileOk(source);
  const sim = new MiniSim(out.files);
  sim.reset();
  const events = [];
  for (let tick = 0; tick < ticks; tick += 1) {
    if (between) between(sim, tick);
    events.push(...sim.step());
  }
  return { out, sim, events };
}

function eventTicks(events, predicate) {
  return events.filter(predicate).map((event) => event.tick);
}

// The auto-start chat line is not part of the user program: timeline tests look
// at everything else so their tick assertions stay about the language semantics.
const START_FILE = 'data/tp/function/start.mcfunction';
const REWIND_FILE = 'data/tp/function/start/rewind.mcfunction';
const STARTUP_FILES = new Set([START_FILE, REWIND_FILE]);

function isStartupSay(event) {
  return event.type === 'say' && STARTUP_FILES.has(event.file);
}

function startSays(events) {
  return events.filter(isStartupSay);
}

/** `[[tick, text], ...]` for the user program's own say statements. */
function programSays(events) {
  return events
    .filter((event) => event.type === 'say' && !STARTUP_FILES.has(event.file))
    .map((event) => [event.tick, event.text]);
}

// ---------------------------------------------------------------------------
// 1. pack skeleton / metadata / prelude
// ---------------------------------------------------------------------------

test('an empty program compiles to a valid, runnable pack skeleton', () => {
  const out = compileOk('');

  for (const path of [
    'pack.mcmeta',
    'data/minecraft/tags/function/load.json',
    'data/minecraft/tags/function/tick.json',
    'data/tp/function/load.mcfunction',
    'data/tp/function/start.mcfunction',
    'data/tp/function/status.mcfunction',
    'data/tp/function/tick.mcfunction',
    'data/tp/function/tick/body.mcfunction',
    'data/tp/function/main/dispatch.mcfunction',
  ]) {
    assert.ok(out.files[path], `missing ${path}`);
    assert.ok(out.files[path].length > 0, `empty ${path}`);
  }
  assert.deepEqual(mainStatePaths(out), [], 'no timeline statements means no states');
  assert.equal(out.meta.stateCount, 0);
  assert.deepEqual(out.meta.variables, []);
  assert.equal(out.meta.preludeLines, PRELUDE_LINE_COUNT);

  const mcmeta = JSON.parse(out.files['pack.mcmeta']);
  assert.equal(mcmeta.pack.pack_format, 48);
  assert.deepEqual(mcmeta.pack.supported_formats, { min_inclusive: 48, max_inclusive: 9999 });

  assert.deepEqual(JSON.parse(out.files['data/minecraft/tags/function/load.json']), { values: ['tp:load'] });
  assert.deepEqual(JSON.parse(out.files['data/minecraft/tags/function/tick.json']), { values: ['tp:tick'] });

  // #__pc points at "no state" so dispatch does nothing.
  assert.ok(commands(out, 'data/tp/function/load.mcfunction').includes('scoreboard players set #__pc tp -1'));
  assert.ok(commands(out, 'data/tp/function/load.mcfunction').includes('scoreboard players set #__started tp 0'));
  assertNoPenSummonInLoad(out);
  assert.deepEqual(
    commands(out, 'data/tp/function/main/dispatch.mcfunction').filter((line) => line.startsWith('execute ')),
    [],
  );

  // Every generated function starts with a `# Tickpack ...` header.
  for (const path of mcfunctionPaths(out)) {
    assert.match(lines(out, path)[0], /^# Tickpack /, `${path} needs a Tickpack header`);
  }
});

test('the prelude is prepended and provides the turtle stdlib', () => {
  const out = compileOk('walk\n');
  assert.equal(out.meta.preludeLines, PRELUDE_LINE_COUNT);

  assert.ok(out.files['data/tp/function/fn/walk.mcfunction']);
  assert.deepEqual(commands(out, 'data/tp/function/fn/walk.mcfunction'), [
    'execute as @e[tag=pen] at @s run tp @s ^ ^ ^1',
  ]);
  assert.deepEqual(commands(out, 'data/tp/function/fn/walk2.mcfunction'), [
    'execute as @e[tag=pen] at @s run tp @s ^ ^ ^2',
  ]);
  assert.deepEqual(commands(out, 'data/tp/function/fn/home.mcfunction'), [
    'execute at @p run tp @e[tag=pen] ~ ~-1 ~ 0 0',
  ]);
  assert.deepEqual(commands(out, 'data/tp/function/fn/clear_ground.mcfunction'), ['execute at @p run fill ~-16 ~-1 ~-16 ~16 ~-1 ~16 air']);
  assert.deepEqual(commands(out, 'data/tp/function/fn/stamp.mcfunction'), [
    'execute at @e[tag=pen] run particle happy_villager ~ ~ ~ 0 0 0 0 1',
  ]);

  // Parameterised stdlib functions are macros: they have no standalone file.
  assert.equal(out.files['data/tp/function/fn/turn.mcfunction'], undefined);
  assert.equal(out.files['data/tp/function/fn/plot.mcfunction'], undefined);

  // A bare zero-parameter call is the same as walk().
  const bare = stateContaining(out, 'function tp:fn/walk');
  assert.ok(mainStatePaths(out).includes(bare));

  // ... and the user cannot redefine the stdlib.
  const diagnostic = compileError('fn plot(b) {\n  run setblock ~ ~ ~ $b\n}\n');
  assert.match(diagnostic.message, /cannot redefine standard-library function/);
});

test('meta reports user state, state count and generated function count', () => {
  const out = compileOk('state arm = 1\nstate count = 0\nover 2 as i {\n  count = count + 1\n}\n');
  assert.deepEqual(out.meta.variables, [
    { name: 'arm', initial: 1 },
    { name: 'count', initial: 0 },
  ]);
  assert.equal(out.meta.stateCount, mainStatePaths(out).length);
  assert.equal(out.meta.functionCount, mcfunctionPaths(out).length);
  assert.equal(out.meta.preludeLines, PRELUDE_LINE_COUNT);
  assert.equal(out.meta.hasTickBlocks, false);
});

test('meta.hasTickBlocks tells the UI when a program keeps running forever', () => {
  // No tick block: the timeline determines when the program is finished.
  assert.equal(compileOk('state x = 0\nover 3 as i {\n  x = x + 1\n}\n').meta.hasTickBlocks, false);
  assert.equal(compileOk('').meta.hasTickBlocks, false);
  // `when press` and prelude fns are not tick blocks.
  assert.equal(compileOk('when press {\n  say "p"\n}\n').meta.hasTickBlocks, false);
  assert.equal(compileOk('fn helper() {\n  say "h"\n}\nhelper\n').meta.hasTickBlocks, false);
  // One or more tick blocks: the program keeps ticking even if #__pc is -1.
  assert.equal(compileOk('tick {\n  say "t"\n}\n').meta.hasTickBlocks, true);
  assert.equal(compileOk('tick {\n  say "a"\n}\ntick {\n  say "b"\n}\n').meta.hasTickBlocks, true);

  // Real samples: square/hello are finite; metronome/endless keep ticking.
  for (const id of ['square', 'hello']) {
    const sample = SAMPLES.find((candidate) => candidate.id === id);
    assert.ok(sample, `missing sample ${id}`);
    assert.equal(compileOk(sample.source).meta.hasTickBlocks, false, id);
  }
  for (const id of ['metronome', 'endless']) {
    const sample = SAMPLES.find((candidate) => candidate.id === id);
    assert.ok(sample, `missing sample ${id}`);
    assert.equal(compileOk(sample.source).meta.hasTickBlocks, true, id);
  }

  // meta stays plain structured-cloneable JSON.
  const meta = compileOk(SAMPLES.find((candidate) => candidate.id === 'endless').source).meta;
  assert.equal(typeof meta.hasTickBlocks, 'boolean');
  assert.deepEqual(JSON.parse(JSON.stringify(meta)), meta);

  // Failed compiles still return the same meta shape (files are empty).
  const failed = compile('tick {\n  wait 1\n}\n');
  assert.equal(failed.ok, false);
  assert.equal(failed.meta.hasTickBlocks, true);
  assert.equal(typeof failed.meta.hasTickBlocks, 'boolean');
});

// ---------------------------------------------------------------------------
// 2. golden pack for `over 3 as i { x = x + 1 }`
// ---------------------------------------------------------------------------

const LOOP_SOURCE = 'state x = 0\nover 3 as i {\n  x = x + 1\n}\n';

test('golden: load initializes the scoreboard machine but does not spawn the pen', () => {
  const out = compileOk(LOOP_SOURCE);
  assert.deepEqual(
    commands(out, 'data/tp/function/load.mcfunction'),
    [
      'scoreboard objectives add tp dummy',
      'scoreboard players set #__tick tp 0',
      'scoreboard players set #__pc tp 0',
      'scoreboard players set #__sleep tp 0',
      'scoreboard players set #__press tp 0',
      'scoreboard players set #__pressSeen tp 0',
      'scoreboard players set #__brush tp 0',
      'scoreboard players set #__started tp 0',
      'scoreboard players set #__paused tp 0',
      'scoreboard players set #x tp 0',
      'scoreboard players set #__i0 tp 0',
      'kill @e[tag=pen]',
    ],
  );
  assert.ok(
    !commands(out, 'data/tp/function/load.mcfunction').some((line) => line.startsWith('summon ')),
    'load must not spawn the pen at an absolute position; tp:start anchors it to the player',
  );
  // #__pc = 0 = first timeline state.
  const load = lines(out, 'data/tp/function/load.mcfunction');
  assertOrder(load, ['scoreboard objectives add tp dummy', '#__pc', '#__sleep', '#__brush', '#__started', 'scoreboard players set #x tp 0', 'kill @e[tag=pen]']);
});

test('golden: over lowers to init -> head -> body -> latch state machine', () => {
  const out = compileOk(LOOP_SOURCE);
  assert.deepEqual(mainStatePaths(out), [
    'data/tp/function/main/s0.mcfunction',
    'data/tp/function/main/s1.mcfunction',
    'data/tp/function/main/s2.mcfunction',
    'data/tp/function/main/s3.mcfunction',
  ]);

  assert.deepEqual(commands(out, 'data/tp/function/main/s0.mcfunction'), [
    'scoreboard players set #__b tp 0',
    'scoreboard players set #__i0 tp 0',
    'scoreboard players set #__pc tp 1',
    'function tp:main/s1',
  ]);
  assert.deepEqual(commands(out, 'data/tp/function/main/s1.mcfunction'), [
    'scoreboard players set #__b tp 0',
    'scoreboard players set #__b tp 1',
    'execute if score #__b tp matches 1 if score #__i0 tp matches 0..2 run function tp:main/s2',
    'execute if score #__b tp matches 1 unless score #__i0 tp matches 0..2 run function tp:main/s3',
  ]);
  assert.deepEqual(commands(out, 'data/tp/function/main/s2.mcfunction'), [
    'scoreboard players set #__b tp 0',
    'scoreboard players add #x tp 1',
    'scoreboard players add #__i0 tp 1',
    'scoreboard players set #__sleep tp 1',
    'scoreboard players set #__pc tp 1',
  ]);
  assert.deepEqual(commands(out, 'data/tp/function/main/s3.mcfunction'), [
    'scoreboard players set #__b tp 0',
    'scoreboard players set #__pc tp -1',
  ]);

  // Traceability comments: every state carries its source line, and the body
  // state points back at the `x = x + 1` line.
  assert.match(lines(out, 'data/tp/function/main/s2.mcfunction')[0], /over i: body \(source line 2\)/);
  assert.ok(out.files['data/tp/function/main/s2.mcfunction'].includes('# source line 3'));
});

test('golden: dispatch has exactly one line per state behind the #__b latch', () => {
  const out = compileOk(LOOP_SOURCE);
  const dispatch = commands(out, 'data/tp/function/main/dispatch.mcfunction');
  assert.deepEqual(dispatch, [
    'scoreboard players set #__b tp 1',
    'execute if score #__b tp matches 1 if score #__pc tp matches 0 run function tp:main/s0',
    'execute if score #__b tp matches 1 if score #__pc tp matches 1 run function tp:main/s1',
    'execute if score #__b tp matches 1 if score #__pc tp matches 2 run function tp:main/s2',
    'execute if score #__b tp matches 1 if score #__pc tp matches 3 run function tp:main/s3',
  ]);
});

test('golden: tick is a thin gate, the old tick body lives in tp:tick/body', () => {
  const out = compileOk(LOOP_SOURCE);
  assert.deepEqual(commands(out, 'data/tp/function/tick.mcfunction'), [
    'execute if score #__started tp matches 0 if score #__paused tp matches 0 if entity @a run function tp:start',
    'execute if score #__started tp matches 1 run function tp:tick/body',
  ]);
  assert.deepEqual(commands(out, 'data/tp/function/tick/body.mcfunction'), [
    'execute if score #__sleep tp matches 0 run function tp:main/dispatch',
    'execute if score #__sleep tp matches 1.. run scoreboard players remove #__sleep tp 1',
    'scoreboard players add #__tick tp 1',
  ]);
});

test('golden: tp:start anchors the pen at the player feet and calls the shared rewind', () => {
  const out = compileOk(LOOP_SOURCE);
  assert.deepEqual(commands(out, START_FILE), [
    'kill @e[tag=pen]',
    'execute at @p run summon armor_stand ~ ~-1 ~ {Tags:["pen"],Invisible:1b,NoGravity:1b,Marker:1b}',
    'function tp:start/rewind',
  ]);
});

test('golden: tp:start_at anchors the pen at the execution position and calls the shared rewind', () => {
  const out = compileOk(LOOP_SOURCE);
  assert.deepEqual(commands(out, 'data/tp/function/start_at.mcfunction'), [
    'kill @e[tag=pen]',
    'summon armor_stand ~ ~ ~ {Tags:["pen"],Invisible:1b,NoGravity:1b,Marker:1b}',
    'function tp:start/rewind',
  ]);
});

test('golden: tp:start/rewind is the one shared reset (scores, states, loops, brush)', () => {
  const out = compileOk(LOOP_SOURCE);
  assert.deepEqual(commands(out, REWIND_FILE), [
    'scoreboard players set #__tick tp 0',
    'scoreboard players set #__pc tp 0',
    'scoreboard players set #__sleep tp 0',
    'scoreboard players set #__press tp 0',
    'scoreboard players set #__pressSeen tp 0',
    'scoreboard players set #__b tp 1',
    'scoreboard players set #__brush tp 0',
    'scoreboard players set #x tp 0',
    'scoreboard players set #__i0 tp 0',
    'scoreboard players set #__paused tp 0',
    'scoreboard players set #__started tp 1',
    'say Tickpack: 开始绘制（/function tp:start 回到脚下；/execute positioned X Y Z run function tp:start_at 指定坐标）',
  ]);
  // Exactly one say line: the in-game feedback that the pack is alive.
  const rewind = lines(out, REWIND_FILE);
  assert.equal(rewind.filter((line) => line.trim().startsWith('say ')).length, 1);
});

test('golden: status reports runtime state, current brush and the pen', () => {
  const out = compileOk(LOOP_SOURCE);
  assert.deepEqual(commands(out, 'data/tp/function/status.mcfunction'), [
    'execute if score #__started tp matches 0 if score #__paused tp matches 0 run say Tickpack: 未运行（等玩家，或 /function tp:start 开始）',
    'execute if score #__paused tp matches 1 run say Tickpack: 已暂停（/function tp:start 继续）',
    'execute if score #__started tp matches 1 run say Tickpack: 运行中（/function tp:start 可重画）',
    ...PALETTE.map(
      (block, index) => `execute if score #__brush tp matches ${index} run say Tickpack: 画笔 = ${block}`,
    ),
    'execute if entity @e[tag=pen] run say Tickpack: 画笔已就位',
    'execute unless entity @e[tag=pen] run say Tickpack: 没有找到画笔（/function tp:start）',
  ]);
});

test('golden: tp:stop pauses in place (started 0, paused 1, sleep 0, one say)', () => {
  const out = compileOk(LOOP_SOURCE);
  assert.deepEqual(commands(out, 'data/tp/function/stop.mcfunction'), [
    'scoreboard players set #__started tp 0',
    'scoreboard players set #__paused tp 1',
    'scoreboard players set #__sleep tp 0',
    'say Tickpack: 已暂停（/function tp:start 重新开始；/function tp:status 查看状态）',
  ]);
  const stop = lines(out, 'data/tp/function/stop.mcfunction');
  assert.equal(stop.filter((line) => line.trim().startsWith('say ')).length, 1);
});

test('golden: every palette block has an in-game brush helper, and brush/next cycles', () => {
  const out = compileOk(LOOP_SOURCE);
  PALETTE.forEach((block, index) => {
    const path = `data/tp/function/brush/${block}.mcfunction`;
    assert.ok(out.files[path], `missing ${path}`);
    assert.deepEqual(commands(out, path), [`scoreboard players set #__brush tp ${index}`]);
  });
  assert.deepEqual(commands(out, 'data/tp/function/brush/next.mcfunction'), [
    'scoreboard players add #__brush tp 1',
    `execute if score #__brush tp matches ${PALETTE.length}.. run scoreboard players set #__brush tp 0`,
  ]);
});

test('golden: paint dispatches on #__brush with one line per palette entry', () => {
  const out = compileOk(LOOP_SOURCE);
  const paint = commands(out, 'data/tp/function/fn/paint.mcfunction');
  assert.equal(paint.length, PALETTE.length);
  PALETTE.forEach((block, index) => {
    assert.equal(
      paint[index],
      `execute if score #__brush tp matches ${index} at @e[tag=pen] run setblock ~ ~ ~ ${block}`,
    );
  });

  // `brush(...)` is a score write; `paint` is a call to the generated function.
  const program = compileOk('brush(redstone_block)\npaint\n');
  const entry = mainStatePaths(program)[0];
  assert.ok(program.files[entry].includes('scoreboard players set #__brush tp 2'));
  assert.ok(program.files[entry].includes('function tp:fn/paint'));
});

test('golden: pack.mcmeta advertises 1.21 compatibility and the /function hint', () => {
  const out = compileOk(LOOP_SOURCE);
  const mcmeta = JSON.parse(out.files['pack.mcmeta']);
  assert.equal(mcmeta.pack.pack_format, 48);
  assert.deepEqual(mcmeta.pack.supported_formats, { min_inclusive: 48, max_inclusive: 9999 });
  assert.match(mcmeta.pack.description, /datapacks\//);
  assert.match(mcmeta.pack.description, /\/function tp:start/);
});

test('golden: wait + if lower to a sleep/branch/join state machine', () => {
  const out = compileOk(
    'state flag = 0\nsay "before"\nwait 2\nif flag {\n  say "true"\n} else {\n  say "false"\n}\n',
  );
  assert.deepEqual(commands(out, 'data/tp/function/main/s0.mcfunction'), [
    'scoreboard players set #__b tp 0',
    'say before',
    'scoreboard players set #__sleep tp 2',
    'scoreboard players set #__pc tp 1',
  ]);
  assert.deepEqual(commands(out, 'data/tp/function/main/s1.mcfunction'), [
    'scoreboard players set #__b tp 0',
    'scoreboard players operation #__t0 tp = #flag tp',
    'scoreboard players set #__b tp 1',
    'execute if score #__b tp matches 1 if score #__t0 tp matches 0 run function tp:main/s3',
    'execute if score #__b tp matches 1 unless score #__t0 tp matches 0 run function tp:main/s2',
  ]);
  assert.deepEqual(commands(out, 'data/tp/function/main/s2.mcfunction'), [
    'scoreboard players set #__b tp 0',
    'say true',
    'scoreboard players set #__pc tp 4',
    'function tp:main/s4',
  ]);
  assert.deepEqual(commands(out, 'data/tp/function/main/s3.mcfunction'), [
    'scoreboard players set #__b tp 0',
    'say false',
    'scoreboard players set #__pc tp 4',
    'function tp:main/s4',
  ]);
  assert.deepEqual(commands(out, 'data/tp/function/main/s4.mcfunction'), [
    'scoreboard players set #__b tp 0',
    'scoreboard players set #__pc tp -1',
  ]);
});

// ---------------------------------------------------------------------------
// 3. temporal semantics, tick by tick
// ---------------------------------------------------------------------------

test('semantics: an over loop runs exactly one iteration per tick', () => {
  const { sim, events } = runProgram(LOOP_SOURCE, 5);
  const adds = events.filter((event) => event.type === 'command' && event.text === 'scoreboard players add #x tp 1');
  assert.deepEqual(adds.map((event) => event.tick), [0, 1, 2], 'iteration k starts on tick k');

  assert.equal(sim.getScore('#x'), 3);
  assert.equal(sim.getScore('#__i0'), 3, 'the loop index is a visible scoreboard value');
  assert.equal(sim.getScore('#__pc'), -1, 'the timeline finished and #__pc is -1');
});

test('semantics: the loop iteration order is observable on the scoreboard', () => {
  const snapshots = [];
  runProgram(LOOP_SOURCE, 5, (sim) => snapshots.push({ x: sim.getScore('#x'), i: sim.getScore('#__i0'), pc: sim.getScore('#__pc') }));
  assert.deepEqual(snapshots, [
    { x: 0, i: 0, pc: 0 },
    { x: 1, i: 1, pc: 1 },
    { x: 2, i: 2, pc: 1 },
    { x: 3, i: 3, pc: 1 },
    { x: 3, i: 3, pc: -1 },
  ]);
});

test('semantics: wait N resumes the timeline N ticks later', () => {
  const source = 'say "a"\nwait 2\nsay "b"\n';
  const { events } = runProgram(source, 6);
  const says = programSays(events);
  assert.deepEqual(says, [
    [0, 'a'],
    [2, 'b'],
  ]);
});

test('semantics: wait 0 is equivalent to "resume next tick"', () => {
  const { events } = runProgram('say "a"\nwait 0\nsay "b"\n', 3);
  assert.deepEqual(
    programSays(events),
    [
      [0, 'a'],
      [1, 'b'],
    ],
  );
});

test('semantics: if with an instant branch is decided and joined in one tick', () => {
  const source = 'state flag = 0\nif flag == 0 {\n  say "yes"\n} else {\n  say "no"\n}\n';
  const { sim, events } = runProgram(source, 1);
  assert.deepEqual(
    programSays(events),
    [[0, 'yes']],
  );
  assert.equal(sim.getScore('#__pc'), -1);
});

test('semantics: if with a temporal branch suspends and resumes correctly', () => {
  const source =
    'state flag = 1\nif flag == 1 {\n  say "yes"\n  wait 2\n  say "later"\n} else {\n  say "no"\n}\n';
  const { events } = runProgram(source, 4);
  assert.deepEqual(
    programSays(events),
    [
      [0, 'yes'],
      [2, 'later'],
    ],
  );
});

test('semantics: the else branch runs when the condition is false', () => {
  const source = 'state flag = 0\nif flag {\n  say "yes"\n} else {\n  say "no"\n}\n';
  const { events } = runProgram(source, 2);
  assert.deepEqual(
    programSays(events),
    [[0, 'no']],
  );
});

test('semantics: nested over loops start their next iteration on a later tick', () => {
  const source = 'state x = 0\nover 2 as a {\n  over 2 as b {\n    x = x + 1\n  }\n}\n';
  const { sim, events } = runProgram(source, 8);
  const adds = events.filter((event) => event.type === 'command' && event.text === 'scoreboard players add #x tp 1');
  assert.deepEqual(adds.map((event) => event.tick), [0, 1, 3, 4]);
  assert.equal(sim.getScore('#x'), 4);
  assert.equal(sim.getScore('#__pc'), -1);
});

test('semantics: over inside an if branch still yields one iteration per tick', () => {
  const source =
    'state flag = 1\nstate x = 0\nif flag == 1 {\n  over 2 as i {\n    x = x + 1\n  }\n}\n';
  const { sim, events } = runProgram(source, 4);
  const adds = events.filter((event) => event.type === 'command' && event.text === 'scoreboard players add #x tp 1');
  assert.deepEqual(adds.map((event) => event.tick), [0, 1]);
  assert.equal(sim.getScore('#x'), 2);
  assert.equal(sim.getScore('#__pc'), -1);
});

test('semantics: over 0 costs no tick', () => {
  const source = 'say "before"\nover 0 as i {\n  say "never"\n}\nsay "after"\n';
  const { sim, events } = runProgram(source, 2);
  assert.deepEqual(
    programSays(events),
    [
      [0, 'before'],
      [0, 'after'],
    ],
  );
  assert.equal(sim.getScore('#__pc'), -1);
});

// ---------------------------------------------------------------------------
// 4. tick blocks / press events / now
// ---------------------------------------------------------------------------

test('tick blocks run every tick, before the timeline, and see now', () => {
  const source = 'tick {\n  say "tick"\n}\n';
  const { events } = runProgram(source, 3);
  assert.deepEqual(eventTicks(events, (event) => event.type === 'say' && event.text === 'tick'), [0, 1, 2]);
});

test('tick blocks are unaffected by a sleeping timeline', () => {
  const source = 'tick {\n  say "tick"\n}\nsay "start"\nwait 10\nsay "never"\n';
  const { events } = runProgram(source, 4);
  assert.equal(events.filter((event) => event.type === 'say' && event.text === 'tick').length, 4);
});

test('tick ordering is: gate (start) first, then the §2.2 body', () => {
  const source =
    'state n = 0\ntick {\n  n = n + 1\n}\nwhen press {\n  say "press"\n}\nover 2 as i {\n  n = n + 10\n}\n';
  const out = compileOk(source);

  // tp:tick is only the gate: wait for a player/start, then run the body.
  const gate = lines(out, 'data/tp/function/tick.mcfunction');
  assertOrder(gate, [
    'execute if score #__started tp matches 0 if score #__paused tp matches 0 if entity @a run function tp:start',
    'execute if score #__started tp matches 1 run function tp:tick/body',
  ]);

  // The old body is unchanged, in its old order (docs/LANG.md §2.2).
  const tick = lines(out, 'data/tp/function/tick/body.mcfunction');
  assertOrder(tick, [
    'scoreboard players add #n tp 1', // 1) user tick blocks
    'scoreboard players operation #__a tp = #__press tp', // 2) press delta
    'execute if score #__a tp matches 1.. run function tp:event/press',
    'execute if score #__sleep tp matches 0 run function tp:main/dispatch', // 3) timeline
    'execute if score #__sleep tp matches 1.. run scoreboard players remove #__sleep tp 1', // 4) sleep
    'scoreboard players add #__tick tp 1', // 5) now
  ]);
});

test('semantics: tick blocks run before the timeline dispatch on the same tick', () => {
  const source = 'state n = 0\ntick {\n  n = n + 1\n}\nover 10 as i {\n  n = n + 100\n}\n';
  const { sim } = runProgram(source, 3);
  // Each tick: +1 from the tick block, then +100 from the loop body.
  assert.equal(sim.getScore('#n'), 303);
});

test('semantics: when press runs exactly once per new host press', () => {
  const source = 'state n = 0\ntick {\n  n = n + 1\n}\nwhen press {\n  say "pressed"\n}\n';
  const out = compileOk(source);
  assert.ok(out.files['data/tp/function/event/press.mcfunction']);
  const sim = new MiniSim(out.files);
  sim.reset();
  const says = [];
  for (let tick = 0; tick < 4; tick += 1) {
    if (tick === 2) {
      sim.press();
      sim.press(); // two presses between ticks still run the handler once
    }
    says.push(...sim.step().filter((event) => event.type === 'say' && !STARTUP_FILES.has(event.file)));
  }
  assert.deepEqual(
    says.map((event) => [event.tick, event.text]),
    [[2, 'pressed']],
  );
  assert.equal(sim.getScore('#n'), 4);
});

test('semantics: press is a delta, not a level (no re-fire without a new press)', () => {
  const out = compileOk('when press {\n  say "hi"\n}\n');
  const sim = new MiniSim(out.files);
  sim.reset();
  const fired = [];
  for (let tick = 0; tick < 3; tick += 1) {
    // Tick 0 starts the run (tp:start rewinds #__press), so press afterwards.
    if (tick === 1) sim.press();
    for (const event of sim.step()) if (event.type === 'say' && !STARTUP_FILES.has(event.file)) fired.push([tick, event.text]);
  }
  assert.deepEqual(fired, [[1, 'hi']]);
});

test('semantics: instant if inside a tick block becomes a snippet function', () => {
  const source = 'state n = 0\ntick {\n  n = n + 1\n  if n == 2 {\n    say "two"\n  }\n}\n';
  const out = compileOk(source);
  assert.ok(out.files['data/tp/function/snippet/0.mcfunction']);
  assert.match(out.files['data/tp/function/tick/body.mcfunction'], /run function tp:snippet\/0/);
  assert.deepEqual(commands(out, 'data/tp/function/snippet/0.mcfunction'), ['say two']);

  const { events } = runProgram(source, 4);
  assert.deepEqual(
    programSays(events),
    [[1, 'two']],
  );
});

test('semantics: now is #__tick and advances once per tick', () => {
  const source = 'tick {\n  if now == 2 {\n    say "two"\n  }\n}\n';
  const { events } = runProgram(source, 4);
  assert.deepEqual(
    programSays(events),
    [[2, 'two']],
  );
});

// ---------------------------------------------------------------------------
// 4b. player-anchored auto-start (the real-world visibility fix)
// ---------------------------------------------------------------------------

test('startup: with no player the runtime waits — no pen, no blocks, no timeline', () => {
  const out = compileOk(LOOP_SOURCE);
  const sim = new MiniSim(out.files);
  sim.reset();
  sim.removePlayers(); // world loaded, nobody has joined yet
  const events = [];
  for (let tick = 0; tick < 3; tick += 1) events.push(...sim.step());

  assert.equal(sim.getScore('#__started'), 0, 'the gate stays closed');
  assert.equal(sim.getScore('#__pc'), 0, 'load leaves #__pc at the first state, but nothing runs it');
  assert.equal(sim.getScore('#__tick'), 0, 'no ticks elapse');
  assert.equal(sim.getScore('#x'), 0);
  assert.equal(sim.findPen(), null, 'no pen is spawned before a player exists');
  assert.deepEqual(sim.getBlocks(), [], 'nothing is drawn');
  assert.equal(startSays(events).length, 0, 'no start message yet');
  assert.equal(
    events.filter((event) => event.type === 'command' && event.text === 'scoreboard players add #x tp 1').length,
    0,
    'the timeline body must not run while waiting',
  );
});

test('startup: when a player appears the pen is anchored at their feet and tick 0 runs that same tick', () => {
  const out = compileOk(LOOP_SOURCE);
  const sim = new MiniSim(out.files);
  sim.reset();
  sim.removePlayers();
  sim.step(); // gate closed
  assert.equal(sim.getScore('#__started'), 0);

  sim.addPlayer(); // the host player joins at (0.5, 1, 0.5)
  const events = sim.step();

  const pen = sim.findPen();
  assert.ok(pen, 'the detection tick spawns the pen');
  assert.equal(pen.type, 'armor_stand');
  assert.ok(pen.tags.includes('pen'));
  assert.deepEqual([pen.x, pen.y, pen.z], [0.5, 0, 0.5], 'summon ~ ~-1 ~ from a player at y=1 lands on y=0');
  assert.equal(sim.getScore('#__started'), 1, 'the run is started');
  assert.equal(sim.getScore('#x'), 1, 'state 0 ran on the very tick the player was detected');
  assert.equal(sim.getScore('#__tick'), 1, 'now advanced exactly once on that tick');
  assert.equal(sim.getScore('#__pc'), 1, 'the loop advanced to its head state');

  assert.equal(startSays(events).length, 1, 'exactly one chat line announces the start');
  assert.match(startSays(events)[0].text, /^Tickpack: .*\/function tp:start/);
});

test('startup: /function tp:start rewinds the run and re-anchors the pen under the player', () => {
  const out = compileOk('state x = 0\nover 5 as i {\n  x = x + 1\n}\n');
  const sim = new MiniSim(out.files);
  sim.reset();
  for (let tick = 0; tick < 3; tick += 1) sim.step();
  assert.equal(sim.getScore('#x'), 3);
  assert.equal(sim.getScore('#__tick'), 3);
  assert.equal(sim.getScore('#__i0'), 3);
  assert.equal(sim.findPen().y, 0);

  // Change the brush in-game, then walk somewhere else and run /function tp:start.
  sim.runFunction('tp:brush/gold_block');
  assert.equal(sim.getScore('#__brush'), 1);
  sim.movePlayer(3.5, 4, -2.5);
  sim.runFunction('tp:start');

  assert.equal(sim.getScore('#__started'), 1);
  assert.equal(sim.getScore('#__tick'), 0, 'time restarts at 0');
  assert.equal(sim.getScore('#__pc'), 0, 'the timeline goes back to state 0');
  assert.equal(sim.getScore('#__sleep'), 0);
  assert.equal(sim.getScore('#__press'), 0);
  assert.equal(sim.getScore('#x'), 0, 'user state is back to its initial value');
  assert.equal(sim.getScore('#__i0'), 0, 'loop indices are back to 0');
  assert.equal(sim.getScore('#__brush'), 0, 'the shared rewind resets the brush to stone');

  const pens = sim.getEntities().filter((entity) => entity.tags.includes('pen'));
  assert.equal(pens.length, 1, 'the old pen was killed, exactly one anchored');
  assert.deepEqual([pens[0].x, pens[0].y, pens[0].z], [3.5, 3, -2.5], 'the new pen is on the ground under the player');

  sim.step();
  assert.equal(sim.getScore('#x'), 1, 'the rewound timeline draws again');
  assert.equal(sim.getScore('#__tick'), 1);
});

test('semantics: /execute positioned X Y Z run function tp:start_at anchors the run there', () => {
  const out = compileOk('state x = 0\nover 5 as i {\n  x = x + 1\n}\n');
  const sim = new MiniSim(out.files);
  sim.reset();
  // Run some of the program, change the brush, then restart at explicit coordinates.
  for (let tick = 0; tick < 2; tick += 1) sim.step();
  sim.runFunction('tp:brush/emerald_block');
  assert.equal(sim.getScore('#x'), 2);

  const events = sim.runCommand('execute positioned 10 0 10 run function tp:start_at');
  const pen = sim.findPen();
  assert.ok(pen, 'tp:start_at spawns the pen');
  assert.deepEqual([pen.x, pen.y, pen.z], [10, 0, 10], 'summon ~ ~ ~ uses the command execution position');
  assert.equal(sim.getScore('#__started'), 1);
  assert.equal(sim.getScore('#__tick'), 0);
  assert.equal(sim.getScore('#__pc'), 0);
  assert.equal(sim.getScore('#x'), 0);
  assert.equal(sim.getScore('#__brush'), 0, 'start_at goes through the same shared rewind');
  assert.equal(startSays(events).length, 1, 'one say line comes from tp:start/rewind');

  // Timeline semantics are unchanged: the next tick runs state 0 from a clean slate.
  sim.step();
  assert.equal(sim.getScore('#x'), 1);
  assert.equal(sim.getScore('#__tick'), 1);

  // And the y coordinate is respected (superflat worlds are at y=-60).
  const deep = sim.runCommand('execute positioned 100 -60 100 run function tp:start_at');
  const deepPen = sim.findPen();
  assert.deepEqual([deepPen.x, deepPen.y, deepPen.z], [100, -60, 100]);
  assert.equal(startSays(deep).length, 1);
});

test('semantics: /function tp:stop pauses in place and tp:start resumes the run', () => {
  const out = compileOk('state n = 0\ntick {\n  say "tick"\n  n = n + 1\n}\n');
  const sim = new MiniSim(out.files);
  sim.reset();
  let events = sim.step(); // starts and runs the body on tick 0
  assert.equal(sim.getScore('#__started'), 1);
  assert.equal(sim.getScore('#__paused'), 0);
  assert.equal(sim.getScore('#n'), 1);
  assert.equal(sim.getScore('#__tick'), 1);
  assert.deepEqual(programSays(events), [[0, 'tick']]);

  // In game: /function tp:stop
  const stopEvents = sim.runCommand('function tp:stop');
  assert.equal(sim.getScore('#__started'), 0);
  assert.equal(sim.getScore('#__paused'), 1);
  assert.equal(sim.getScore('#__sleep'), 0);
  assert.deepEqual(
    stopEvents.filter((event) => event.type === 'say').map((event) => [event.file, event.text]),
    [
      [
        'data/tp/function/stop.mcfunction',
        'Tickpack: 已暂停（/function tp:start 重新开始；/function tp:status 查看状态）',
      ],
    ],
  );

  // The gate must not auto-start while paused, and the body must not run.
  for (let tick = 0; tick < 3; tick += 1) {
    events = sim.step();
    assert.equal(events.filter((event) => event.type === 'say' && event.text === 'tick').length, 0, 'tick body is paused');
  }
  assert.equal(sim.getScore('#n'), 1, 'no tick-block code ran while paused');
  assert.equal(sim.getScore('#__tick'), 1, 'the clock is paused too');
  assert.equal(sim.getScore('#__started'), 0);
  assert.equal(sim.getScore('#__paused'), 1);

  // status distinguishes paused from "waiting for a player".
  const statusSays = sim
    .runCommand('function tp:status')
    .filter((event) => event.type === 'say')
    .map((event) => event.text);
  assert.ok(statusSays.includes('Tickpack: 已暂停（/function tp:start 继续）'), JSON.stringify(statusSays));
  assert.ok(!statusSays.some((text) => text.includes('未运行')), 'a paused run must not say "not running / waiting"');

  // /function tp:start resumes from a fresh run.
  sim.runCommand('function tp:start');
  assert.equal(sim.getScore('#__started'), 1);
  assert.equal(sim.getScore('#__paused'), 0);
  assert.equal(sim.getScore('#__tick'), 0);
  assert.equal(sim.getScore('#n'), 0, 'tp:start rewound the user state');
  events = sim.step();
  assert.deepEqual(programSays(events), [[sim.getTick() - 1, 'tick']]);
  assert.equal(sim.getScore('#n'), 1);
  assert.equal(sim.getScore('#__tick'), 1);
});

test('semantics: a paused run stays paused even when a player is present', () => {
  const out = compileOk('state n = 0\ntick {\n  n = n + 1\n}\n');
  const sim = new MiniSim(out.files);
  sim.reset();
  sim.removePlayers(); // pause before anyone has joined
  sim.runCommand('function tp:stop');
  assert.equal(sim.getScore('#__started'), 0);
  assert.equal(sim.getScore('#__paused'), 1);

  sim.addPlayer();
  sim.step();
  assert.equal(sim.getScore('#__started'), 0, 'the gate respects the explicit pause');
  assert.equal(sim.getScore('#n'), 0);
  assert.equal(sim.findPen(), null, 'no pen is summoned while paused');

  sim.runCommand('function tp:start');
  sim.step();
  assert.equal(sim.getScore('#__started'), 1);
  assert.equal(sim.getScore('#n'), 1);
  assert.ok(sim.findPen(), 'tp:start anchors the pen and runs again');
});

test('startup: every generated runtime file exists, even with no timeline', () => {
  const out = compileOk(LOOP_SOURCE);
  for (const path of [
    'data/tp/function/load.mcfunction',
    'data/tp/function/start.mcfunction',
    'data/tp/function/start_at.mcfunction',
    'data/tp/function/stop.mcfunction',
    'data/tp/function/start/rewind.mcfunction',
    'data/tp/function/status.mcfunction',
    'data/tp/function/tick.mcfunction',
    'data/tp/function/tick/body.mcfunction',
    'data/tp/function/fn/paint.mcfunction',
    'data/tp/function/brush/stone.mcfunction',
    'data/tp/function/brush/glass.mcfunction',
    'data/tp/function/brush/next.mcfunction',
  ]) {
    assert.ok(out.files[path], `missing ${path}`);
  }
  // The one say line lives in the shared rewind, so start and start_at both get it.
  assert.match(out.files[REWIND_FILE], /\/function tp:start/);
  assert.match(out.files[REWIND_FILE], /tp:start_at/);
  assert.match(out.files['data/tp/function/status.mcfunction'], /#__started tp matches 0/);
  assert.match(out.files['data/tp/function/status.mcfunction'], /#__started tp matches 1/);
  assert.match(out.files['data/tp/function/status.mcfunction'], /#__paused tp matches 1/);
  assert.match(out.files['data/tp/function/stop.mcfunction'], /#__paused tp 1/);

  const empty = compileOk('');
  assert.ok(empty.files['data/tp/function/start.mcfunction']);
  assert.ok(empty.files['data/tp/function/start_at.mcfunction']);
  assert.ok(empty.files['data/tp/function/stop.mcfunction']);
  assert.ok(empty.files['data/tp/function/start/rewind.mcfunction']);
  assert.ok(empty.files['data/tp/function/status.mcfunction']);
  assert.ok(empty.files['data/tp/function/tick/body.mcfunction']);
  assert.ok(empty.files['data/tp/function/fn/paint.mcfunction']);
  assert.ok(empty.files['data/tp/function/brush/next.mcfunction']);
});

// ---------------------------------------------------------------------------
// 4c. runtime brush: brush(...) / paint / in-game helpers
// ---------------------------------------------------------------------------

test('semantics: paint draws the current brush block; in-game brush helpers change it mid-run', () => {
  const out = compileOk('over 3 as i {\n  walk\n  paint\n}\n');
  const sim = new MiniSim(out.files); // reset starts the run (player present), brush defaults to stone
  sim.reset();
  sim.step(); // tick 0 starts the run and paints stone at (0,0,1)

  // In game: /function tp:brush/redstone_block for the next tick.
  sim.runFunction('tp:brush/redstone_block');
  sim.step(); // tick 1: redstone at (0,0,2)

  // In game: /function tp:brush/next selects emerald_block (index 3).
  sim.runFunction('tp:brush/next');
  sim.step(); // tick 2: emerald at (0,0,3)

  const blocks = sim.getBlocks();
  assert.deepEqual(
    blocks.map((entry) => `${entry.x},${entry.y},${entry.z}:${entry.block}`).sort(),
    ['0,0,1:stone', '0,0,2:redstone_block', '0,0,3:emerald_block'],
  );
});

test('semantics: brush/next cycles through the whole palette and wraps to stone', () => {
  const out = compileOk('');
  const sim = new MiniSim(out.files);
  sim.reset();
  assert.equal(sim.getScore('#__brush'), 0);
  for (let index = 1; index < PALETTE.length; index += 1) {
    sim.runFunction('tp:brush/next');
    assert.equal(sim.getScore('#__brush'), index);
  }
  sim.runFunction('tp:brush/next');
  assert.equal(sim.getScore('#__brush'), 0, 'wraps back to stone after the last palette entry');
});

test('semantics: the status function reports the current brush', () => {
  const out = compileOk(LOOP_SOURCE);
  const sim = new MiniSim(out.files);
  sim.reset();
  sim.step(); // start the run so a pen exists
  sim.runFunction('tp:brush/purple_wool');
  const says = sim
    .runCommand('function tp:status')
    .filter((event) => event.type === 'say')
    .map((event) => event.text);
  assert.ok(says.includes('Tickpack: 画笔 = purple_wool'), JSON.stringify(says));
  const brushSays = says.filter((text) => text.startsWith('Tickpack: 画笔 = '));
  assert.equal(brushSays.length, 1, 'only the current palette entry prints');
});

test('semantics: brush(...) and paint work in the timeline, in fn bodies and in tick blocks', () => {
  const out = compileOk(
    [
      'state x = 0',
      'fn gold() {',
      '  brush(gold_block)',
      '}',
      'tick {',
      '  if now == 1 {',
      '    paint',
      '  }',
      '}',
      'over 2 as i {',
      '  gold()',
      '  paint()',
      '}',
      '',
    ].join('\n'),
  );
  assert.ok(out.ok, JSON.stringify(out.diagnostics));
  const sim = new MiniSim(out.files);
  sim.reset();
  sim.step();
  sim.step();
  const blocks = sim.getBlocks();
  assert.ok(blocks.some((entry) => entry.block === 'gold_block'), 'fn body + paint() drew gold');
  assert.equal(sim.getScore('#__brush'), 1, 'gold() ran in the timeline');
});

// ---------------------------------------------------------------------------
// 5. macros (constant parameters), say/run, expressions
// ---------------------------------------------------------------------------

test('semantics: macro functions inline with $params substituted into run lines', () => {
  const source = 'over 2 as i {\n  walk\n  plot(gold_block)\n  turn(-45)\n}\n';
  const out = compileOk(source);
  const bodyPath = stateContaining(out, '# inlined fn plot(gold_block)');
  const body = contentLines(out, bodyPath);

  assertOrder(body, [
    'function tp:fn/walk',
    '# inlined fn plot(gold_block)',
    'execute at @e[tag=pen] run setblock ~ ~ ~ gold_block',
    '# inlined fn turn(-45)',
    'execute as @e[tag=pen] at @s run tp @s ~ ~ ~ ~-45 ~',
  ]);

  const { events } = runProgram(source, 2);
  assert.deepEqual(eventTicks(events, (event) => event.type === 'command' && event.text === 'setblock ~ ~ ~ gold_block'), [0, 1]);
});

test('semantics: macros can pass their own parameters on (fn A -> fn B)', () => {
  const source = 'fn quad(block) {\n  plot($block)\n}\nover 1 as i {\n  quad(emerald_block)\n}\n';
  const out = compileOk(source);
  const bodyPath = stateContaining(out, '# inlined fn quad(emerald_block)');
  const body = contentLines(out, bodyPath);
  assertOrder(body, [
    '# inlined fn quad(emerald_block)',
    '# inlined fn plot(emerald_block)',
    'execute at @e[tag=pen] run setblock ~ ~ ~ emerald_block',
  ]);
});

test('semantics: integer macro parameters are usable in expressions', () => {
  const source = 'state x = 0\nfn scale(n) {\n  x = $n * 2\n}\nscale(21)\n';
  const out = compileOk(source);
  const bodyPath = stateContaining(out, '# inlined fn scale(21)');
  assert.match(out.files[bodyPath], /scoreboard players set #__t0 tp 21/);

  const { sim } = runProgram(source, 1);
  assert.equal(sim.getScore('#x'), 42);
});

test('expressions: arithmetic, comparisons and logic evaluate on the scoreboard', () => {
  const source =
    'state a = 2\nstate b = 3\na = (a + b) * 2\nb = a > b and a >= 10\na = a / 0\n';
  const { sim } = runProgram(source, 1);
  assert.equal(sim.getScore('#a'), 0, '7/0 is defined as 0 by the language');
  assert.equal(sim.getScore('#b'), 1);

  const source2 = 'state x = 0\nx = 1 + 2 * 3 - 4 / 2\n';
  const second = runProgram(source2, 1);
  assert.equal(second.sim.getScore('#x'), 5);
});

test('expressions: comparing against a literal needs no subtraction', () => {
  const out = compileOk('state x = 0\nif x >= 3 {\n  x = 1\n}\n');
  const condition = stateContaining(out, 'if: condition');
  assert.ok(
    out.files[condition].includes('execute if score #__t0 tp matches 3.. run scoreboard players set #__t1 tp 1'),
    `unexpected comparison lowering:\n${out.files[condition]}`,
  );
});

test('expressions: modulo and not/or/and', () => {
  const source =
    'state x = 7\nx = x % 3\nx = not x\nx = 0 or 9\nx = x and 0\n';
  const { sim } = runProgram(source, 1);
  // 7 % 3 = 1 -> not 1 = 0 -> 0 or 9 = 1 -> 1 and 0 = 0.
  assert.equal(sim.getScore('#x'), 0);
});

test('say emits the string contents and run emits the raw command verbatim', () => {
  const out = compileOk('say "hello world"\nrun setblock 2 0 3 stone # trailing comment\n');
  const entry = stateContaining(out, 'say hello world');
  const body = commands(out, entry);
  assert.ok(body.includes('say hello world'));
  assert.ok(body.includes('setblock 2 0 3 stone'));
  assert.ok(!out.files[entry].includes('trailing comment'), 'a trailing # comment on a run line is stripped');

  const { sim, events } = runProgram('say "hello world"\n', 1);
  assert.equal(sim.getScore('#__pc'), -1);
  assert.deepEqual(
    programSays(events).map(([, text]) => text),
    ['hello world'],
  );
});

// ---------------------------------------------------------------------------
// 6. required compile errors
// ---------------------------------------------------------------------------

test('compile errors: unknown names, time-spanning statements in instant bodies, duplicates', () => {
  const cases = [
    {
      name: 'unknown variable',
      source: 'state x = 0\nover 3 as i {\n  x = z\n}\n',
      line: 3,
      message: /unknown variable 'z'/,
    },
    {
      name: 'unknown function',
      source: 'nope()\n',
      line: 1,
      message: /unknown function 'nope'/,
    },
    {
      name: 'over inside fn',
      source: 'fn f() {\n  over 2 as i {\n  }\n}\n',
      line: 2,
      message: /over spans time; move it to the timeline/,
    },
    {
      name: 'wait inside fn',
      source: 'fn f() {\n  wait 2\n}\n',
      line: 2,
      message: /wait spans time; move it to the timeline/,
    },
    {
      name: 'wait inside tick',
      source: 'tick {\n  wait 1\n}\n',
      line: 2,
      message: /wait spans time/,
    },
    {
      name: 'over inside when press',
      source: 'when press {\n  over 1 as i {\n  }\n}\n',
      line: 2,
      message: /over spans time/,
    },
    {
      name: 'duplicate state',
      source: 'state x = 0\nstate x = 1\n',
      line: 2,
      message: /duplicate state 'x'/,
    },
    {
      name: 'duplicate function',
      source: 'fn f() {\n}\nfn f() {\n}\n',
      line: 3,
      message: /duplicate function 'f'/,
    },
  ];

  for (const testCase of cases) {
    const diagnostic = compileError(testCase.source);
    assert.equal(diagnostic.line, testCase.line, `${testCase.name}: wrong line (message: ${diagnostic.message})`);
    assert.match(diagnostic.message, testCase.message, `${testCase.name}: wrong message`);
  }
});

test('compile errors: macro problems (unknown params, recursion, identifier to int param)', () => {
  const cases = [
    {
      name: 'unknown macro parameter in run',
      source: 'fn f(a) {\n  run say $b\n}\n',
      line: 2,
      message: /unknown macro parameter '\$b'/,
    },
    {
      name: 'unknown macro parameter in expression',
      source: 'state x = 0\nfn f(a) {\n  x = $b\n}\n',
      line: 3,
      message: /unknown macro parameter '\$b'/,
    },
    {
      name: 'macro recursion',
      source: 'fn a() {\n  b()\n}\nfn b() {\n  a()\n}\n',
      line: 5,
      message: /function call cycle: a -> b -> a/,
    },
    {
      name: 'identifier passed to an int parameter',
      source: 'state x = 0\nfn f(n) {\n  x = $n + 1\n}\nf(stone)\n',
      line: 5,
      message: /parameter 'n' of fn 'f' is used in an expression/,
    },
    {
      name: 'bare call to a function with parameters',
      source: 'fn f(a) {\n  say "x"\n}\nf\n',
      line: 4,
      message: /needs 1 argument/,
    },
  ];

  for (const testCase of cases) {
    const diagnostic = compileError(testCase.source);
    assert.equal(diagnostic.line, testCase.line, `${testCase.name}: wrong line (message: ${diagnostic.message})`);
    assert.match(diagnostic.message, testCase.message, `${testCase.name}: wrong message`);
  }
});

test('compile errors: reserved names and illegal writes', () => {
  const cases = [
    {
      name: 'reserved state name',
      source: 'state now = 0\n',
      line: 1,
      message: /'now' is a reserved word/,
    },
    {
      name: 'double-underscore name',
      source: 'state __x = 0\n',
      line: 1,
      message: /starts with '__'/,
    },
    {
      name: 'reserved loop index name',
      source: 'over 2 as now {\n}\n',
      line: 1,
      message: /reserved word and cannot be used as a loop index/,
    },
    {
      name: 'assign to now',
      source: 'now = 1\n',
      line: 1,
      message: /cannot assign to 'now'/,
    },
    {
      name: 'assign to a loop index',
      source: 'over 2 as i {\n  i = 1\n}\n',
      line: 2,
      message: /cannot assign to loop variable 'i'/,
    },
    {
      name: 'assign to an undeclared state',
      source: 'over 1 as i {\n  missing = 1\n}\n',
      line: 2,
      message: /unknown variable 'missing'/,
    },
    {
      name: 'redefine a stdlib function',
      source: 'fn home() {\n  run say "x"\n}\n',
      line: 1,
      message: /cannot redefine standard-library function 'home'/,
    },
    {
      name: 'reserved name: state brush',
      source: 'state brush = 0\n',
      line: 1,
      message: /'brush' is a reserved word/,
    },
    {
      name: 'reserved name: fn paint',
      source: 'fn paint() {\n}\n',
      line: 1,
      message: /'paint' is a reserved word/,
    },
    {
      name: 'reserved name: parameter brush',
      source: 'fn f(brush) {\n}\n',
      line: 1,
      message: /'brush' is a reserved word and cannot be used as a parameter/,
    },
    {
      name: 'reserved name: loop index paint',
      source: 'over 2 as paint {\n}\n',
      line: 1,
      message: /'paint' is a reserved word and cannot be used as a loop index/,
    },
  ];

  for (const testCase of cases) {
    const diagnostic = compileError(testCase.source);
    assert.equal(diagnostic.line, testCase.line, `${testCase.name}: wrong line (message: ${diagnostic.message})`);
    assert.match(diagnostic.message, testCase.message, `${testCase.name}: wrong message`);
  }
});

test('compile errors: brush validates against the compiler palette', () => {
  const diagnostic = compileError('brush(nope)\n');
  assert.equal(diagnostic.line, 1);
  assert.match(diagnostic.message, /unknown brush block 'nope'; palette:/);
  for (const block of PALETTE) {
    assert.ok(diagnostic.message.includes(block), `palette error message is missing ${block}`);
  }

  // In an instant body the error still points at the user line.
  const nested = compileError('fn f() {\n  brush(nope)\n}\n');
  assert.equal(nested.line, 2);
  assert.match(nested.message, /unknown brush block 'nope'/);

  // Bad arguments are syntax errors (brush takes a bare block id, paint takes none).
  for (const source of ['brush(5)\n', 'brush("stone")\n', 'brush()\n']) {
    const bad = compileError(source);
    assert.match(bad.message, /brush\(\.\.\.\) takes a bare palette block id/);
  }
  const paintArgument = compileError('paint(foo)\n');
  assert.match(paintArgument.message, /paint takes no arguments/);
});

test('compile errors: bad syntax is reported with a user-source line', () => {
  const cases = [
    { name: 'unclosed block', source: 'over 3 as i {\n', line: 2, message: /unclosed/ },
    { name: 'missing expression', source: 'state x = 0\nx =\n', line: 2, message: /expected an expression/ },
    { name: 'bad macro argument', source: 'plot(stone + 1)\n', line: 1, message: /macro arguments must be/ },
    { name: 'string macro argument', source: 'plot("stone")\n', line: 1, message: /macro arguments must be/ },
    { name: 'unterminated string', source: 'say "hello\n', line: 1, message: /unterminated string/ },
    { name: 'stray character', source: 'state x = 5 ?\n', line: 1, message: /unexpected character/ },
    { name: 'if without a block', source: 'state x = 0\nif x\n}\n', line: 2, message: /expected '\{'/ },
  ];

  for (const testCase of cases) {
    const diagnostic = compileError(testCase.source);
    assert.equal(diagnostic.line, testCase.line, `${testCase.name}: wrong line (message: ${diagnostic.message})`);
    assert.match(diagnostic.message, testCase.message, `${testCase.name}: wrong message`);
  }
});

test('compile errors: diagnostics point at user lines, not prelude+user lines', () => {
  const diagnostic = compileError('state x = 0\n\n\nx = nope\n');
  assert.equal(diagnostic.line, 4);
  // A valid program has no diagnostics even though the prelude has 40+ lines.
  const ok = compileOk('state x = 0\n');
  assert.deepEqual(ok.diagnostics, []);
});

// ---------------------------------------------------------------------------
// 7. the sample programs and the simulator command subset
// ---------------------------------------------------------------------------

const COMMAND_HEADS = new Set([
  'scoreboard',
  'execute',
  'tp',
  'setblock',
  'fill',
  'summon',
  'kill',
  'tag',
  'say',
  'function',
  'particle',
]);

test('every sample program compiles to a pack inside the §5 command subset', () => {
  assert.ok(SAMPLES.length >= 5);
  for (const sample of SAMPLES) {
    const out = compileOk(sample.source);
    for (const path of mcfunctionPaths(out)) {
      for (const line of lines(out, path)) {
        const text = line.trim();
        if (text === '' || text.startsWith('#')) continue;
        const head = text.split(/\s+/)[0];
        assert.ok(COMMAND_HEADS.has(head), `${sample.id}: unsupported command '${head}' in ${path}: ${text}`);
        if (head === 'execute') {
          assert.ok(/\brun\b/.test(text), `${sample.id}: execute without run in ${path}: ${text}`);
        }
        assert.ok(!text.startsWith('/'), `${sample.id}: command must not start with '/' in ${path}`);
      }
    }
  }
});

test('the square sample generates a loop-as-clock state machine with the runtime brush', () => {
  const sample = SAMPLES.find((candidate) => candidate.id === 'square');
  assert.ok(sample, 'the square sample exists');
  const out = compileOk(sample.source);
  // 4 outer x 8 inner iterations, turn after each side: the timeline is a set of
  // explicit states, one tick per inner iteration.
  assert.ok(out.meta.stateCount >= 6, `expected a state machine, got ${out.meta.stateCount} states`);
  const allStates = mainStatePaths(out).map((path) => out.files[path]).join('\n');
  assert.match(allStates, /if score #__i0 tp matches 0\.\.3 run function tp:main\/s/);
  assert.match(allStates, /if score #__i1 tp matches 0\.\.7 run function tp:main\/s/);
  // The sample selected the stone brush once, then paints through tp:fn/paint.
  assert.match(allStates, /scoreboard players set #__brush tp 0/);
  assert.match(allStates, /function tp:fn\/paint/);
  assert.match(allStates, /execute as @e\[tag=pen\] at @s run tp @s ~ ~ ~ ~90 ~/);
  assert.match(out.files['data/tp/function/fn/paint.mcfunction'], /setblock ~ ~ ~ stone/);
});

test('the samples execute 40 ticks with no MiniSim error', () => {
  for (const sample of SAMPLES) {
    const out = compileOk(sample.source);
    const sim = new MiniSim(out.files);
    sim.reset();
    for (let tick = 0; tick < 40; tick += 1) sim.step();
    assert.equal(sim.getTick(), 40, sample.id);
  }
});

// ---------------------------------------------------------------------------
// 8. extra lowering coverage (nested control flow, loop indices, literals)
// ---------------------------------------------------------------------------

test('semantics: if inside an over body branches and joins within the iteration tick', () => {
  const source =
    'state x = 0\nover 3 as i {\n  if i % 2 == 0 {\n    x = x + 10\n  } else {\n    x = x + 1\n  }\n}\n';
  const { sim, events } = runProgram(source, 4);
  // tick 0: i=0 -> +10, tick 1: i=1 -> +1, tick 2: i=2 -> +10
  const tickOf = (needle) =>
    events
      .filter((event) => event.type === 'command' && event.text === needle)
      .map((event) => event.tick);
  assert.deepEqual(tickOf('scoreboard players add #x tp 10'), [0, 2]);
  assert.deepEqual(tickOf('scoreboard players add #x tp 1'), [1]);
  assert.equal(sim.getScore('#x'), 21);
  assert.equal(sim.getScore('#__pc'), -1);
});

test('semantics: nested loop indices are readable in expressions', () => {
  const source =
    'state x = 0\nover 2 as a {\n  over 2 as b {\n    x = x + a * 10 + b\n  }\n}\n';
  const { sim } = runProgram(source, 8);
  // (a,b) = (0,0), (0,1), (1,0), (1,1) -> 0 + 1 + 10 + 11 = 22
  assert.equal(sim.getScore('#x'), 22);
  assert.equal(sim.getScore('#__pc'), -1);
});

test('states may be declared after the timeline code that uses them', () => {
  const source = 'over 1 as i {\n  x = x + 1\n}\nstate x = 10\n';
  const { sim } = runProgram(source, 2);
  assert.equal(sim.getScore('#x'), 11);
});

test('semantics: negative literals and subtraction', () => {
  const source = 'state x = -5\nx = x - -3\nx = -x\n';
  const { sim } = runProgram(source, 1);
  assert.equal(sim.getScore('#x'), 2);
});

test('semantics: an empty over body still costs one tick per iteration', () => {
  const source = 'state x = 0\nover 3 as i {\n}\nx = x + 1\n';
  const out = compileOk(source);
  const sim = new MiniSim(out.files);
  sim.reset();
  for (let tick = 0; tick < 3; tick += 1) sim.step();
  assert.equal(sim.getScore('#x'), 0, 'the body is empty, so nothing happens yet');
  assert.equal(sim.getScore('#__pc'), 1, 'still inside the loop after 3 ticks');
  sim.step();
  assert.equal(sim.getScore('#x'), 1, 'the statement after the loop runs on the next tick');
  assert.equal(sim.getScore('#__pc'), -1);
});

test('semantics: empty if branches are compiled away', () => {
  const source = 'state flag = 1\nif flag {\n}\nsay "after"\n';
  const out = compileOk(source);
  assert.equal(out.meta.stateCount, 1, 'the empty if produces no branch states');
  const { events } = runProgram(source, 1);
  assert.deepEqual(
    programSays(events),
    [[0, 'after']],
  );
});

test('semantics: an if with only an else branch joins the true path directly', () => {
  const source = 'state flag = 0\nif flag {\n} else {\n  say "else"\n}\n';
  const out = compileOk(source);
  assert.equal(out.meta.stateCount, 3); // condition, false branch, join
  const { events } = runProgram(source, 1);
  assert.deepEqual(
    programSays(events),
    [[0, 'else']],
  );
});

test('declarations are rejected inside function/timeline blocks', () => {
  const diagnostic = compileError('fn f() {\n  state x = 0\n}\n');
  assert.equal(diagnostic.line, 2);
  assert.match(diagnostic.message, /only allowed at the top level/);
});

test('a kitchen-sink program stays inside the §5 command subset', () => {
  const source =
    [
      'state a = 1',
      'state b = 0',
      'fn twice(n) {',
      '  a = $n * 2',
      '}',
      'tick {',
      '  if now % 7 == 0 {',
      '    stamp',
      '  }',
      '}',
      'when press {',
      '  home',
      '}',
      'over 4 as i {',
      '  walk',
      '  plot(stone)',
      '  if i >= 2 {',
      '    turn(90)',
      '    wait 1',
      '  } else {',
      '    turn(-45)',
      '  }',
      '  twice(3)',
      '  b = not b and a > i',
      '  say "tick"',
      '  run setblock 3 0 4 sand',
      '}',
      '',
    ].join('\n');
  const out = compileOk(source);
  for (const path of mcfunctionPaths(out)) {
    for (const line of lines(out, path)) {
      const text = line.trim();
      if (text === '' || text.startsWith('#')) continue;
      const head = text.split(/\s+/)[0];
      assert.ok(COMMAND_HEADS.has(head), `unsupported command '${head}' in ${path}: ${text}`);
      if (head === 'execute') assert.ok(/\brun\b/.test(text), `execute without run: ${text}`);
    }
  }
  const sim = new MiniSim(out.files);
  sim.reset();
  for (let tick = 0; tick < 12; tick += 1) sim.step();
  assert.equal(sim.getScore('#__pc'), -1, 'the kitchen sink must finish');
});


