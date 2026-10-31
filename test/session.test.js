// Core acceptance tests for the host-agnostic run session.
// These are the "spec by example" the architecture protects: a shell (browser,
// CLI, worker, desktop) may only rely on compile() + TickpackSession + the zip
// bundle. No DOM, no platform APIs here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TickpackSession,
  MAX_SNAPSHOTS,
  pickExecuting,
  isOnboardingSay,
  directSourceLine,
  looseSourceLine,
  SAMPLES,
} from '../src/api.js';

const square = SAMPLES.find((s) => s.id === 'square');

function started(source) {
  const session = new TickpackSession();
  const loaded = session.load(source);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.diagnostics));
  return session;
}

test('load compiles the pack and starts paused at tick 0 with a snapshot', () => {
  const session = new TickpackSession();
  const loaded = session.load(square.source);
  assert.equal(loaded.ok, true);
  assert.equal(session.tick, 0);
  assert.equal(session.snapshotsCount, 1);
  assert.equal(session.finished, false);
  assert.ok(session.files['data/tp/function/load.mcfunction']);
  const view = session.view();
  assert.equal(view.tick, 0);
  assert.equal(view.changes.length, 0);
  assert.ok(Array.isArray(view.world.blocks));
});

test('one step = one tick; the pen appears and the first block is placed', () => {
  const session = started(square.source);
  const r = session.step();
  assert.ok(r);
  assert.equal(r.tick, 1);
  assert.equal(r.changes.length, 1, 'square places exactly one block per tick');
  assert.match(r.exec.file, /data\/tp\/function\/main\/s\d+\.mcfunction/);
  assert.ok(r.exec.sourceLine >= 1, 'the executed command maps back to a user line');
  assert.equal(r.lastSay, '', 'the Minecraft-only tp:start chat line is filtered');
  assert.equal(session.snapshotsCount, 2);
});

test('a timeline program finishes; finished is part of the session, not the UI', () => {
  const session = started(square.source);
  let last = null;
  for (let i = 0; i < 60 && !session.finished; i++) last = session.step();
  assert.equal(session.finished, true);
  assert.equal(session.tick, 37, 'square takes 37 ticks');
  assert.equal(last.finished, true);
  assert.ok(session.cursor >= 37);
});

test('ambient (tick-block) programs never finish', () => {
  const session = started(`tick {\n  say "t"\n}\n`);
  assert.equal(session.hasTickBlocks, true);
  for (let i = 0; i < 120; i++) session.step();
  assert.equal(session.finished, false);
  assert.equal(session.lastSay, 't');
  assert.equal(session.tick, 120);
});

test('seek restores world/scores/command; view does not advance', () => {
  const session = started(square.source);
  for (let i = 0; i < 20; i++) session.step();
  const at20 = session.view();
  const blocks20 = at20.world.blocks.length;
  assert.equal(at20.tick, 20);

  const mid = session.seek(5);
  assert.equal(mid.tick, 5);
  assert.equal(mid.index, 5);
  assert.ok(mid.world.blocks.length < blocks20);
  assert.ok(mid.exec && mid.exec.file, 'the snapshot remembers its executing command');
  assert.equal(session.tick, 5);
  assert.equal(session.view().tick, 5);

  const back = session.seek(20);
  assert.equal(back.tick, 20);
  assert.equal(back.world.blocks.length, blocks20);
  assert.deepEqual(session.view().scores, at20.scores);
});

test('compile errors are reported with user line numbers and leave no run', () => {
  const session = new TickpackSession();
  const loaded = session.load('state x = 0\ntick {\n  wait 2\n}\n');
  assert.equal(loaded.ok, false);
  assert.ok(loaded.diagnostics.length >= 1);
  assert.equal(loaded.diagnostics[0].line, 3);
  assert.equal(session.step(), null);
  assert.equal(session.view(), null);
  assert.throws(() => session.exportBundle(), /nothing to export/);
});

test('snapshot cap stops a runaway ambient program instead of growing forever', () => {
  const session = new TickpackSession({ maxSnapshots: 5 });
  session.load('tick {\n  say "t"\n}\n');
  assert.equal(session.snapshotsCount, 1);
  let last = null;
  for (let i = 0; i < 4; i++) last = session.step();
  assert.equal(session.snapshotsCount, 5);
  const cappedStep = session.step();
  assert.equal(cappedStep.capped, true);
  assert.equal(cappedStep.finished, true);
  assert.equal(session.step(), null, 'no further ticks once capped');
  assert.equal(session.snapshotsCount, 5);
});

test('exportBundle is a real zip built by the core (host-agnostic)', () => {
  const session = started(square.source);
  const bundle = session.exportBundle();
  assert.equal(bundle.filename, 'tickpack-datapack.zip');
  assert.ok(bundle.files['pack.mcmeta']);
  assert.ok(bundle.zip instanceof Uint8Array);
  assert.ok(bundle.zip.length > 1000);
  assert.deepEqual([...bundle.zip.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
});

test('pickExecuting prefers a directly-mapped timeline command over bookkeeping', () => {
  const files = {
    'data/tp/function/main/s4.mcfunction': [
      '# Tickpack main state s4 — body (source line 5)',
      'scoreboard players set #__b tp 0',
      '# source line 4',
      'function tp:fn/walk',
      '# source line 5',
      'execute at @e[tag=pen] run setblock ~ ~ ~ stone',
    ].join('\n'),
    'data/tp/function/tick.mcfunction': '# source line 1\nscoreboard players add #__tick tp 1',
  };
  const events = [
    { type: 'command', file: 'data/tp/function/main/s4.mcfunction', line: 2, fn: 'tp:main/s4', tick: 3, text: 'x' },
    { type: 'command', file: 'data/tp/function/main/s4.mcfunction', line: 6, fn: 'tp:main/s4', tick: 3, text: 'y' },
    { type: 'command', file: 'data/tp/function/tick.mcfunction', line: 2, fn: 'tp:tick', tick: 3, text: 'z' },
  ];
  const exec = pickExecuting(events, files);
  assert.equal(exec.file, 'data/tp/function/main/s4.mcfunction');
  assert.equal(exec.line, 6);
  assert.equal(exec.sourceLine, 5);
  assert.equal(exec.fn, 'tp:main/s4');
});

test('source-line helpers: direct beats loose, both are bounded', () => {
  const files = {
    'a.mcfunction': [
      '# source line 2',
      'function f',
      '# bookkeeping',
      '# source line 9',
      'command',
    ].join('\n'),
  };
  assert.equal(directSourceLine(files, 'a.mcfunction', 5), 9);
  assert.equal(directSourceLine(files, 'a.mcfunction', 1), null);
  assert.equal(looseSourceLine(files, 'a.mcfunction', 5), 9);
  assert.equal(looseSourceLine(files, 'a.mcfunction', 2), 2);
});

test('onboarding say detection covers both start files', () => {
  assert.equal(isOnboardingSay('data/tp/function/start.mcfunction'), true);
  assert.equal(isOnboardingSay('data/tp/function/start/rewind.mcfunction'), true);
  assert.equal(isOnboardingSay('data/tp/function/main/s1.mcfunction'), false);
  assert.equal(isOnboardingSay('data/tp/function/tick/body.mcfunction'), false);
});

test('press() forwards the host input into the run', () => {
  const session = started(
    `state n = 0\nwhen press {\n  n = n + 1\n}\n`,
  );
  // The first tick runs tp:start, which rewinds the press counters; host input
  // made before the run has started is deliberately discarded.
  session.step();
  assert.equal(session.press(), true);
  session.step();
  assert.equal(session.view().scores.tp['#n'], 1);
  session.press();
  session.step();
  assert.equal(session.view().scores.tp['#n'], 2);
});

test('all samples can be driven by the session without runtime errors', () => {
  for (const sample of SAMPLES) {
    const session = new TickpackSession();
    const loaded = session.load(sample.source);
    assert.equal(loaded.ok, true, `${sample.id}: ${JSON.stringify(loaded.diagnostics)}`);
    let errors = 0;
    for (let i = 0; i < 120; i++) {
      const r = session.step();
      if (!r) break;
      errors += r.errors.length;
      if (r.finished) break;
    }
    assert.equal(errors, 0, `${sample.id} produced runtime errors`);
  }
});
