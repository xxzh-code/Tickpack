// ============================================================================
// TEMPORARY DEV FIXTURE — DELETE BEFORE FINISHING.
//
// src/api.js is being written in parallel by the Lead/compiler/simulator.
// This module fakes the two contracts from docs/LANG.md so the UI can be built
// and screenshotted against a live, moving world immediately:
//
//   compile(source) -> { ok, files, diagnostics, meta }
//   new Simulator(files) + reset/step/press/getTick/getWorld/getScores/
//                          snapshot/restore
//
// It does NOT execute mcfunction. It replays a hand-written turtle path and
// emits plausible trace events against a hand-written pack. It is swapped out
// by web/boot.js as soon as the real ../src/api.js is importable.
// ============================================================================

export const __fixture = true;

const PALETTE = [
  'lapis_block',
  'diamond_block',
  'emerald_block',
  'gold_block',
  'redstone_block',
  'purple_wool',
  'glowstone',
];

export const PRELUDE = `# Tickpack prelude — the turtle standard library
# every call below expands to raw commands at the call site

fn walk() {
  run execute as @e[tag=pen] at @s run tp @s ^ ^ ^1
}

fn walk2() {
  run execute as @e[tag=pen] at @s run tp @s ^ ^ ^2
}

fn turn(deg) {
  run execute as @e[tag=pen] at @s run tp @s ~ ~ ~ ~$deg ~
}

fn plot(block) {
  run execute at @e[tag=pen] run setblock ~ ~ ~ $block
}

fn plot_under(block) {
  run execute at @e[tag=pen] run setblock ~ ~-1 ~ $block
}

fn stamp() {
  run execute at @e[tag=pen] run particle happy_villager ~ ~ ~ 0 0 0 0 1
}

fn clear_ground() {
  run fill -16 0 -16 16 0 16 air
}

fn home() {
  run tp @e[tag=pen] 0.5 0 0.5 0 0
}
`;

const SQUARE_SRC = `# square.tp — four sides, one tick per block
# the loop IS the clock: every "over" iteration costs exactly one tick

clear_ground()
state drawn = 0
state sides = 0

over 4 as side {
  over 4 as step {
    plot(gold_block)
    walk()
    drawn = drawn + 1
  }
  turn(90)
  sides = sides + 1
}

home()
stamp()
`;

const SPIRAL_SRC = `# spiral.tp — the world grows outward one tick at a time
# each arm is a nested temporal loop; the pen never teleports

clear_ground()
state drawn = 0

over 7 as arm {
  over 2 as hop {
    over 5 as step {
      plot(diamond_block)
      walk()
      drawn = drawn + 1
    }
    turn(90)
  }
}

stamp()
`;

const DIAMOND_SRC = `# diamond.tp — diagonal lines are just a turn away
clear_ground()
state painted = 0

turn(45)
over 4 as corner {
  over 6 as edge {
    plot(diamond_block)
    walk()
    painted = painted + 1
  }
  turn(90)
}

home()
stamp()
`;

export const SAMPLES = [
  { id: 'square', title: 'square', description: 'draw a 5x5 square, one block per tick', source: SQUARE_SRC },
  { id: 'spiral', title: 'spiral', description: 'an outward square spiral in seven colors', source: SPIRAL_SRC },
  { id: 'diamond', title: 'diamond', description: 'a diamond using diagonal turtle turns', source: DIAMOND_SRC },
];

// ---------------------------------------------------------------------------
// Fake datapack
// ---------------------------------------------------------------------------

function mcLines(lines) {
  return lines.join('\n') + '\n';
}

function buildPack(fixtureId, vars, src) {
  const blockId = src.block || 'gold_block';
  const varInit = vars.map((v) => `scoreboard players set #${v.name} tp ${v.initial}`);
  const loopCount = fixtureId === 'square' ? 2 : 1;
  const loopInit = [];
  for (let i = 0; i < loopCount; i++) loopInit.push(`scoreboard players set #__i${i} tp 0`);

  const states = [
    [
      '# Tickpack main/s0 — init',
      'scoreboard players set #__i0 tp 0',
      'scoreboard players set #__i1 tp 0',
      'scoreboard players set #__pc tp 1',
      'function tp:main/s1',
    ],
    [
      '# Tickpack main/s1 — over head (outer loop)',
      `# source line ${src.loop}`,
      'execute if score #__i0 tp matches 0..3 run function tp:main/s2',
      'execute unless score #__i0 tp matches 0..3 run function tp:main/s6',
      'scoreboard players set #__pc tp 2',
    ],
    [
      '# Tickpack main/s2 — over head (inner loop)',
      `# source line ${src.loop}`,
      'execute if score #__i1 tp matches 0..3 run function tp:main/s3',
      'execute unless score #__i1 tp matches 0..3 run function tp:main/s5',
      'scoreboard players set #__pc tp 3',
    ],
    [
      '# Tickpack main/s3 — loop body (one tick per iteration)',
      `# source line ${src.plot}`,
      `execute at @e[tag=pen] run setblock ~ ~ ~ ${blockId}`,
      `# source line ${src.walk}`,
      'execute as @e[tag=pen] at @s run tp @s ^ ^ ^1',
      'scoreboard players add #__i1 tp 1',
      'scoreboard players add #drawn tp 1',
      'scoreboard players set #__sleep tp 1',
      'scoreboard players set #__pc tp 2',
    ],
    [
      '# Tickpack main/s4 — wait 1 (yield)',
      'scoreboard players set #__sleep tp 1',
      'scoreboard players set #__pc tp 2',
      'return',
    ],
    [
      '# Tickpack main/s5 — end of body, next outer iteration',
      'execute as @e[tag=pen] at @s run tp @s ~ ~ ~ ~90 ~',
      'scoreboard players add #__i0 tp 1',
      'scoreboard players set #__sleep tp 1',
      'scoreboard players set #__pc tp 1',
    ],
    [
      '# Tickpack main/s6 — main timeline finished',
      'scoreboard players set #__pc tp -1',
    ],
  ];

  const files = {
    'pack.mcmeta': JSON.stringify({ pack: { pack_format: 48, description: 'Tickpack — loops become time' } }, null, 2) + '\n',
    'data/minecraft/tags/function/load.json': JSON.stringify({ values: ['tp:load'] }) + '\n',
    'data/minecraft/tags/function/tick.json': JSON.stringify({ values: ['tp:tick'] }) + '\n',
    'data/tp/function/load.mcfunction': mcLines([
      '# Tickpack — load: reset the world, the scores and the pen',
      `# @fixture ${fixtureId}`,
      'scoreboard objectives add tp dummy',
      'scoreboard players set #__tick tp 0',
      'scoreboard players set #__pc tp 0',
      'scoreboard players set #__sleep tp 0',
      'scoreboard players set #__press tp 0',
      'scoreboard players set #__pressSeen tp 0',
      ...loopInit,
      ...varInit,
      'kill @e[tag=pen]',
      'summon armor_stand 0.5 0 0.5 {Tags:["pen"],Invisible:1b,NoGravity:1b,Marker:1b}',
    ]),
    'data/tp/function/tick.mcfunction': mcLines([
      '# Tickpack tick — runs every game tick',
      'function tp:event/press',
      'execute if score #__sleep tp matches 0 run function tp:main/dispatch',
      'execute if score #__sleep tp matches 1.. run scoreboard players remove #__sleep tp 1',
      'scoreboard players add #__tick tp 1',
    ]),
    'data/tp/function/main/dispatch.mcfunction': mcLines([
      '# Tickpack main/dispatch — program counter dispatch',
      ...states.map((_, i) => `execute if score #__pc tp matches ${i} run function tp:main/s${i}`),
    ]),
    'data/tp/function/event/press.mcfunction': mcLines([
      '# Tickpack event/press — host "press" input',
      'execute if score #__press tp > #__pressSeen tp run function tp:main/s3',
      'scoreboard players operation #__pressSeen tp = #__press tp',
    ]),
    'data/tp/function/fn/walk.mcfunction': mcLines([
      '# Tickpack fn/walk — move the pen one block forward',
      `# source line ${src.walk}`,
      'execute as @e[tag=pen] at @s run tp @s ^ ^ ^1',
    ]),
    'data/tp/function/fn/turn.mcfunction': mcLines([
      '# Tickpack fn/turn — rotate the pen by $deg degrees',
      'execute as @e[tag=pen] at @s run tp @s ~ ~ ~ ~$deg ~',
    ]),
    'data/tp/function/fn/plot.mcfunction': mcLines([
      '# Tickpack fn/plot — place a block at the pen',
      `# source line ${src.plot}`,
      'execute at @e[tag=pen] run setblock ~ ~ ~ $block',
    ]),
    'data/tp/function/fn/stamp.mcfunction': mcLines([
      '# Tickpack fn/stamp — sparkle at the pen',
      'execute at @e[tag=pen] run particle happy_villager ~ ~ ~ 0 0 0 0 1',
    ]),
    'data/tp/function/fn/clear_ground.mcfunction': mcLines([
      '# Tickpack fn/clear_ground — wipe the drawing plane',
      'fill -16 0 -16 16 0 16 air',
    ]),
    'data/tp/function/fn/home.mcfunction': mcLines([
      '# Tickpack fn/home — teleport the pen back to the origin',
      'tp @e[tag=pen] 0.5 0 0.5 0 0',
    ]),
  };

  for (let i = 0; i < states.length; i++) {
    files[`data/tp/function/main/s${i}.mcfunction`] = mcLines(states[i]);
    files[`data/tp/function/snippet/${i}.mcfunction`] = mcLines([
      `# Tickpack snippet/${i} — instant branch body`,
      `execute if score #__t0 tp matches 1.. run function tp:main/s${i}`,
    ]);
  }

  return files;
}

function parseVars(source) {
  const vars = [];
  const re = /^\s*state\s+([A-Za-z_]\w*)\s*=\s*(-?\d+)\s*$/gm;
  let m;
  while ((m = re.exec(source))) vars.push({ name: m[1], initial: Number(m[2]) });
  return vars;
}

export function compile(source) {
  const text = String(source);
  const fixtureId = (text.match(/#\s*@fixture\s+(\w+)/) || [])[1]
    || (text.includes('spiral') ? 'spiral' : text.includes('diamond') ? 'diamond' : 'square');
  const vars = parseVars(source);
  const lines = text.split('\n');
  const findLine = (re) => {
    const i = lines.findIndex((l) => re.test(l));
    return i >= 0 ? i + 1 : null;
  };
  const srcInfo = {
    plot: findLine(/\bplot\s*\(/) || 10,
    walk: findLine(/\bwalk\s*\(/) || 11,
    loop: findLine(/\bover\b/) || 8,
    block: (text.match(/\bplot\s*\(\s*([A-Za-z_]\w*)\s*\)/) || [])[1] || 'gold_block',
  };
  const files = buildPack(fixtureId, vars, srcInfo);
  return {
    ok: true,
    files,
    diagnostics: [],
    meta: {
      preludeLines: PRELUDE.split('\n').length,
      variables: vars,
      stateCount: 7,
      functionCount: Object.keys(files).filter((p) => p.endsWith('.mcfunction')).length,
    },
  };
}

// ---------------------------------------------------------------------------
// Fake simulator: replays a turtle path and emits trace events.
// ---------------------------------------------------------------------------

function turtle(segments) {
  let x = 0;
  let z = 0;
  let yaw = 0;
  const out = [];
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    for (let i = 0; i < seg.len; i++) {
      out.push({
        plot: { x, z },
        pen: { x, z },
        yaw,
        block: seg.block,
        i0: seg.i0 != null ? seg.i0 : s,
        i1: i,
      });
      const rad = (yaw * Math.PI) / 180;
      x += Math.round(-Math.sin(rad));
      z += Math.round(Math.cos(rad));
    }
    yaw += seg.turn || 0;
  }
  return out;
}

function buildPath(id) {
  if (id === 'spiral') {
    const segs = [];
    for (let k = 0; k < 15; k++) {
      segs.push({ len: 1 + (k >> 1), block: PALETTE[Math.min(PALETTE.length - 1, k >> 1)], turn: 90, i0: k });
    }
    return turtle(segs);
  }
  if (id === 'diamond') {
    const segs = [];
    for (let k = 0; k < 4; k++) segs.push({ len: 6, block: 'diamond_block', turn: 90, i0: k });
    return turtle([{ len: 0, block: 'diamond_block', turn: 45 }, ...segs]);
  }
  const segs = [];
  for (let k = 0; k < 4; k++) segs.push({ len: 4, block: 'gold_block', turn: 90, i0: k });
  return turtle(segs);
}

function clone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

export class Simulator {
  constructor(files) {
    this.files = files || {};
    const load = this.files['data/tp/function/load.mcfunction'] || '';
    this.fixtureId = (load.match(/#\s*@fixture\s+(\w+)/) || [])[1] || 'square';
    // user state names are declared in load.mcfunction as regular fake players
    this.userVars = [];
    const re = /scoreboard players set #([A-Za-z_]\w*) tp (-?\d+)/g;
    let m;
    while ((m = re.exec(load))) {
      if (!m[1].startsWith('__')) this.userVars.push({ name: m[1], initial: Number(m[2]) });
    }
    this.reset();
  }

  reset() {
    this.tick = 0;
    this.idx = -1;
    this.plots = 0;
    this.done = false;
    this.blocks = new Map();
    this.pen = { id: 'pen-1', type: 'armor_stand', x: 0.5, y: 0, z: 0.5, yaw: 0, pitch: 0, tags: ['pen'] };
    const tp = {
      '#__tick': 0,
      '#__pc': 0,
      '#__sleep': 0,
      '#__press': 0,
      '#__pressSeen': 0,
      '#__i0': 0,
      '#__i1': 0,
    };
    for (const v of this.userVars) tp[`#${v.name}`] = v.initial;
    this.scores = { tp };
    this.path = buildPath(this.fixtureId);
  }

  fileLines(path) {
    const text = this.files[path] || '';
    return text.split('\n');
  }

  cmd(file, line, fn) {
    const lines = this.fileLines(file);
    return { type: 'command', tick: this.tick, file, line, fn, text: lines[line - 1] || '' };
  }

  step() {
    this.tick += 1;
    const t = this.tick;
    const events = [];
    const tp = this.scores.tp;

    if (this.done) {
      tp['#__tick'] = t;
      return events;
    }

    const nextIdx = this.idx + 1;
    if (nextIdx >= this.path.length) {
      this.done = true;
      tp['#__pc'] = -1;
      tp['#__tick'] = t;
      tp['#__sleep'] = 0;
      events.push(this.cmd('data/tp/function/main/s6.mcfunction', 2, 'tp:main/s6'));
      events.push({ type: 'say', tick: t, text: `${this.fixtureId} complete — ${this.plots} blocks in ${t} ticks` });
      return events;
    }

    this.idx = nextIdx;
    const step = this.path[this.idx];
    const key = `${step.plot.x},0,${step.plot.z}`;
    const changed = !this.blocks.has(key) ? 1 : 0;
    this.blocks.set(key, { x: step.plot.x, y: 0, z: step.plot.z, block: step.block });
    if (changed) this.plots += 1;

    // move the pen to the next block, facing the way it will walk
    const rad = (step.yaw * Math.PI) / 180;
    const nx = step.pen.x + Math.round(-Math.sin(rad));
    const nz = step.pen.z + Math.round(Math.cos(rad));
    this.pen.x = nx + 0.5;
    this.pen.z = nz + 0.5;
    this.pen.yaw = step.yaw;

    for (const v of this.userVars) {
      let value;
      if (/drawn|painted|count|plot/.test(v.name)) value = this.plots;
      else if (/side/.test(v.name)) value = Math.floor(this.idx / 4);
      else if (/arm|corner|hop/.test(v.name)) value = step.i0;
      else value = t;
      this.scores.tp[`#${v.name}`] = value;
    }
    tp['#__tick'] = t;
    tp['#__pc'] = 3;
    tp['#__sleep'] = 1;
    tp['#__i0'] = step.i0;
    tp['#__i1'] = step.i1;

    // plausible trace: tick -> dispatch -> loop body (macros expanded inline),
    // so the last command stays in the timeline state and its `# source line`
    // comment drives the editor lockstep.
    events.push(this.cmd('data/tp/function/tick.mcfunction', 3, 'tp:tick'));
    events.push(this.cmd('data/tp/function/main/dispatch.mcfunction', 2 + (step.i0 % 7), 'tp:main/dispatch'));
    const bodyLine = this.idx % 2 === 0 ? 3 : 5;
    events.push(this.cmd('data/tp/function/main/s3.mcfunction', bodyLine, 'tp:main/s3'));

    if (t % 4 === 0) {
      events.push({ type: 'particle', tick: t, x: this.pen.x, y: 0, z: this.pen.z, particle: 'happy_villager' });
    }
    return events;
  }

  press() {
    if (this.scores && this.scores.tp) this.scores.tp['#__press'] = (this.scores.tp['#__press'] || 0) + 1;
  }

  getTick() {
    return this.tick;
  }

  getWorld() {
    return {
      blocks: [...this.blocks.values()].map((b) => ({ ...b })),
      entities: [clone(this.pen)],
    };
  }

  getScores() {
    return clone(this.scores);
  }

  snapshot() {
    return {
      tick: this.tick,
      idx: this.idx,
      plots: this.plots,
      done: this.done,
      blocks: [...this.blocks.values()].map((b) => ({ ...b })),
      scores: clone(this.scores),
      pen: clone(this.pen),
    };
  }

  restore(snap) {
    if (!snap) return;
    this.tick = snap.tick;
    this.idx = snap.idx;
    this.plots = snap.plots;
    this.done = snap.done;
    this.blocks = new Map(snap.blocks.map((b) => [`${b.x},${b.y},${b.z}`, { ...b }]));
    this.scores = clone(snap.scores);
    this.pen = clone(snap.pen);
  }
}
