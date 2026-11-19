// End-to-end tests: real source -> compiler -> datapack files -> simulator.
// This is the contract that matters: the same six lines the user edits must
// actually produce a pack whose mcfunction, executed tick by tick, moves the pen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, Simulator, SAMPLES } from '../src/api.js';

// The generated runtime starts the timeline when a player is present and emits
// one chat line from the shared start rewind; tests that count user `say`s must
// ignore it.
const START_FILES = new Set([
  'data/tp/function/start.mcfunction',
  'data/tp/function/start/rewind.mcfunction',
]);
const isProgramSay = (e) => e.type === 'say' && !START_FILES.has(e.file);

function run(source, ticks, between) {
  const out = compile(source);
  assert.equal(out.ok, true, `compile failed: ${JSON.stringify(out.diagnostics)}`);
  const sim = new Simulator(out.files);
  sim.reset();
  const events = [];
  for (let i = 0; i < ticks; i++) {
    if (between) between(sim, i);
    events.push(...sim.step());
  }
  return { sim, out, events };
}

test('the square sample compiles to a real datapack that waits for a player', () => {
  const sample = SAMPLES.find((s) => s.id === 'square');
  const out = compile(sample.source);
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  for (const path of [
    'pack.mcmeta',
    'data/minecraft/tags/function/load.json',
    'data/minecraft/tags/function/tick.json',
    'data/tp/function/load.mcfunction',
    'data/tp/function/tick.mcfunction',
    'data/tp/function/tick/body.mcfunction',
    'data/tp/function/start.mcfunction',
    'data/tp/function/start/rewind.mcfunction',
    'data/tp/function/start_at.mcfunction',
    'data/tp/function/status.mcfunction',
    'data/tp/function/fn/paint.mcfunction',
    'data/tp/function/brush/stone.mcfunction',
    'data/tp/function/brush/next.mcfunction',
    'data/tp/function/main/dispatch.mcfunction',
  ]) {
    assert.ok(out.files[path], `missing ${path}`);
    assert.ok(out.files[path].length > 0, `empty ${path}`);
  }
  // the tick function is a gate: it anchors+starts when a player appears
  assert.match(out.files['data/tp/function/tick.mcfunction'], /#__started/);
  assert.match(out.files['data/tp/function/tick.mcfunction'], /run function tp:start/);
  // the clock lives in the body, which only runs once started
  assert.match(out.files['data/tp/function/tick/body.mcfunction'], /#__tick/);
  // the datapack must load in 1.21.x without an "incompatible" warning
  const meta = JSON.parse(out.files['pack.mcmeta']);
  assert.equal(meta.pack.pack_format, 48);
  assert.equal(meta.pack.supported_formats.min_inclusive, 48);
  assert.ok(meta.pack.supported_formats.max_inclusive >= 48);
  assert.match(meta.pack.description, /tp:start/);
  // the loaded pack does not place a pen at a fixed absolute spot
  assert.doesNotMatch(out.files['data/tp/function/load.mcfunction'], /summon armor_stand 0\.5 0 0\.5/);
});

test('the runtime waits for a player, then anchors the pen at their feet', () => {
  const out = compile(`over 2 as i {\n  plot(gold_block)\n}\n`);
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  const sim = new Simulator(out.files);
  sim.reset();
  // before any tick: no pen yet, the simulator has a host player
  assert.equal(sim.getWorld().entities.filter((e) => (e.tags || []).includes('pen')).length, 0);
  const events = sim.step();
  assert.equal(sim.getScores().tp['#__started'], 1);
  const pens = sim.getWorld().entities.filter((e) => (e.tags || []).includes('pen'));
  assert.equal(pens.length, 1, 'pen should be summoned on the first tick');
  assert.equal(pens[0].y, 0, 'pen should sit on the block under the player feet (y=1-1)');
  assert.ok(events.some((e) => e.type === 'say' && START_FILES.has(e.file)), 'tp:start should say something');
  // state 0 runs on the same tick the pen appears, so blocks are already placed
  assert.ok(sim.getWorld().blocks.length > 0);
});

test('nested over loops: one iteration per tick', () => {
  const { sim } = run(
    `state x = 0
over 3 as i {
  x = x + 1
}
`,
    6,
  );
  assert.equal(sim.getTick(), 6);
  assert.equal(sim.getScores().tp['#x'], 3, 'loop body must have run exactly 3 times');
  assert.equal(sim.getScores().tp['#__pc'], -1, 'timeline should be finished');
});

test('loop index advances one per tick and state is visible in scoreboard', () => {
  const out = compile(
    `state seen = 0
over 4 as i {
  seen = seen + 10
}
`,
  );
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  const sim = new Simulator(out.files);
  sim.reset();
  const values = [];
  for (let i = 0; i < 6; i++) {
    sim.step();
    values.push(sim.getScores().tp['#seen']);
  }
  // exactly one iteration per tick, then the timeline is done
  assert.deepEqual(values, [10, 20, 30, 40, 40, 40]);
});

test('wait N holds the timeline for N ticks', () => {
  const { events } = run(
    `say "a"
wait 2
say "b"
`,
    6,
  );
  const says = events.filter(isProgramSay).map((e) => [e.tick, e.text]);
  assert.deepEqual(says, [
    [0, 'a'],
    [2, 'b'],
  ]);
});

test('tick blocks run every tick and read now', () => {
  const { events } = run(
    `tick {
  say "tick"
}
`,
    3,
  );
  const says = events.filter(isProgramSay);
  assert.equal(says.length, 3);
  assert.deepEqual(
    says.map((e) => e.tick),
    [0, 1, 2],
  );
});

test('tick blocks are unaffected by a sleeping timeline', () => {
  const { events } = run(
    `tick {
  say "tick"
}
say "start"
wait 10
say "never"
`,
    4,
  );
  assert.equal(events.filter((e) => e.type === 'say' && e.text === 'tick').length, 4);
});

test('if/else with a temporal branch in the timeline', () => {
  const { events, sim } = run(
    `state flag = 1
if flag == 1 {
  say "yes"
  wait 2
  say "later"
} else {
  say "no"
}
`,
    6,
  );
  const says = events.filter(isProgramSay).map((e) => [e.tick, e.text]);
  assert.deepEqual(says, [
    [0, 'yes'],
    [2, 'later'],
  ]);
  assert.equal(sim.getScores().tp['#flag'], 1);
});

test('functions are macros: plot(block) really places that block', () => {
  const { sim } = run(
    `over 3 as i {
  walk
  plot(gold_block)
}
`,
    5,
  );
  const blocks = sim.getWorld().blocks;
  assert.equal(blocks.length, 3);
  for (const b of blocks) assert.equal(b.block, 'gold_block');
  // pen starts at (0.5, 0, 0.5) facing +z; body is walk-then-plot,
  // so the three blocks are (0,0,1), (0,0,2), (0,0,3)
  const coords = blocks.map((b) => `${b.x},${b.y},${b.z}`).sort();
  assert.deepEqual(coords, ['0,0,1', '0,0,2', '0,0,3']);
});

test('turning changes the walking direction', () => {
  const { sim } = run(
    `over 4 as side {
  over 2 as step {
    walk
    plot(stone)
  }
  turn(90)
}
`,
    14,
  );
  const blocks = sim.getWorld().blocks;
  assert.equal(blocks.length, 8);
  // path 2 forward, right, 2 forward, right, ... -> a square-ish loop
  const coords = blocks.map((b) => `${b.x},${b.z}`).sort();
  assert.ok(coords.includes('0,0'), `expected 0,0 in ${coords}`);
  assert.ok(coords.includes('0,1'), `expected 0,1 in ${coords}`);
});

test('when press reacts to exactly one host press per press()', () => {
  const out = compile(
    `state n = 0
tick {
  n = n + 1
}
when press {
  say "pressed"
}
`,
  );
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  const sim = new Simulator(out.files);
  sim.reset();
  const says = [];
  for (let i = 0; i < 4; i++) {
    if (i === 2) sim.press();
    says.push(...sim.step().filter(isProgramSay));
  }
  assert.equal(says.length, 1);
  assert.equal(says[0].text, 'pressed');
  assert.equal(sim.getScores().tp['#n'], 4);
});

test('snapshot / restore rewinds the world and the scoreboard', () => {
  const { sim } = run(
    `state x = 0
over 20 as i {
  walk
  plot(stone)
  x = x + 1
}
`,
    10,
  );
  const mid = sim.snapshot();
  const midBlocks = sim.getWorld().blocks.length;
  for (let i = 0; i < 5; i++) sim.step();
  assert.notEqual(sim.getWorld().blocks.length, midBlocks);
  sim.restore(mid);
  assert.equal(sim.getWorld().blocks.length, midBlocks);
  assert.equal(sim.getTick(), 10);
  assert.equal(sim.getScores().tp['#x'], 10);
});

test('trace points at a real generated line in a real file', () => {
  const { out, events } = run(`over 2 as i {\n  plot(gold_block)\n}\n`, 3);
  const cmds = events.filter((e) => e.type === 'command');
  assert.ok(cmds.length > 0);
  const ev = cmds.find((e) => e.file.includes('main/s'));
  assert.ok(ev, 'expected a command event from a timeline state');
  assert.ok(out.files[ev.file], `trace file ${ev.file} missing from pack`);
  const line = out.files[ev.file].split('\n')[ev.line - 1];
  assert.equal(line.trim(), ev.text.trim());
  assert.match(ev.fn, /^tp:main\//);
});

test('every sample compiles and runs 40 ticks without a simulator error', () => {
  for (const sample of SAMPLES) {
    const out = compile(sample.source);
    assert.equal(out.ok, true, `${sample.id} failed to compile: ${JSON.stringify(out.diagnostics)}`);
    const sim = new Simulator(out.files);
    sim.reset();
    const errors = [];
    for (let i = 0; i < 40; i++) {
      for (const ev of sim.step()) if (ev.type === 'error') errors.push(ev);
    }
    assert.deepEqual(errors, [], `${sample.id} produced simulator errors`);
  }
});

test('compile errors carry user-source line numbers', () => {
  // top-level `wait` is legal (timeline), but wait inside a tick block spans time
  const out = compile('state x = 0\ntick {\n  wait 2\n}\n');
  assert.equal(out.ok, false);
  assert.ok(out.diagnostics.length > 0);
  assert.equal(out.diagnostics[0].line, 3);
  assert.match(out.diagnostics[0].message, /tick|time|spans/i);
});

test('unknown names and duplicate declarations are compile errors', () => {
  assert.equal(compile('state x = 0\nx = y + 1\n').ok, false);
  assert.equal(compile('state x = 0\nstate x = 1\n').ok, false);
  assert.equal(compile('nope()\n').ok, false);
});


test('ahead/below read the real generated world through execute if block', () => {
  const source = `run setblock 0 0 1 gold_block
run setblock 0 -1 0 stone
if ahead(gold_block) {
  say "ahead-ok"
}
if below(stone) {
  say "below-ok"
}
`;
  const out = compile(source);
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  const all = Object.values(out.files).join('\n');
  assert.match(all, /positioned \^ \^ \^1 if block ~ ~ ~ gold_block/);
  assert.match(all, /if block ~ ~-1 ~ stone/);
  const { events } = run(source, 1);
  const says = events.filter(isProgramSay).map((e) => e.text);
  assert.deepEqual(says, ['ahead-ok', 'below-ok']);
});

test('ahead/below reject blocks outside the sensor palette at their source line', () => {
  const out = compile('if ahead(grass_block) {\n  say "nope"\n}\n');
  assert.equal(out.ok, false);
  assert.equal(out.diagnostics[0].line, 1);
  assert.match(out.diagnostics[0].message, /unknown sensed block 'grass_block'/);
  assert.match(out.diagnostics[0].message, /stone, gold_block/);
});

test('animate(@p, "wave", N ticks) lowers to one readable animation slot', () => {
  const source = `animate(@p, "wave", 3 ticks)
wait 3
say "done"
`;
  const out = compile(source);
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.ok(out.files['data/tp/function/anim/tick.mcfunction']);
  assert.match(out.files['data/tp/function/anim/tick.mcfunction'], /particle happy_villager/);
  assert.match(out.files['data/tp/function/tick/body.mcfunction'], /function tp:anim\/tick/);
  const { sim, events } = run(source, 4);
  const particles = events.filter((e) => e.type === 'particle');
  assert.ok(particles.length >= 3, 'animation emits particles while active');
  assert.equal(sim.getScores().tp['#__animActive'], 0);
  assert.equal(sim.getScores().tp['#__animLeft'], 0);
});

test('a later animate overrides the remaining ticks of the active one', () => {
  const source = `animate(@p, "wave", 4 ticks)
wait 2
animate(@p, "wave", 6 ticks)
wait 2
`;
  const out = compile(source);
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  const sim = new Simulator(out.files);
  sim.reset();
  sim.step(); // tick 0 starts 4 ticks, animation decrements to 3
  assert.equal(sim.getScores().tp['#__animLeft'], 3);
  sim.step(); // tick 1 decrements to 2
  assert.equal(sim.getScores().tp['#__animLeft'], 2);
  sim.step(); // tick 2 re-arms 6, then decrements to 5
  assert.equal(sim.getScores().tp['#__animLeft'], 5);
  assert.equal(sim.getScores().tp['#__animActive'], 1);
});

test('animate syntax only accepts the @p / wave probe form', () => {
  const out = compile('animate(@a, "wave", 4 ticks)\n');
  assert.equal(out.ok, false);
  assert.equal(out.diagnostics[0].line, 1);
  assert.match(out.diagnostics[0].message, /animate syntax/);
});
