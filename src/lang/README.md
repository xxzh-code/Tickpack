# src/lang — the Tickpack compiler

`compile(source)` turns Tickpack source (docs/LANG.md §1) into a real Minecraft
1.21 datapack (docs/LANG.md §2/§3) as a virtual file map. It is plain ESM, has no
dependencies, and is imported by both Node and the browser through `src/api.js`.

```js
import { compile, PRELUDE } from '../src/api.js';

const { ok, files, diagnostics, meta } = compile('over 3 as i {\n  walk\n}\n');
// files: { 'pack.mcmeta': '...', 'data/tp/function/tick.mcfunction': '...' }
```

## Module map

| file | role |
| --- | --- |
| `prelude.js` | `PRELUDE`, the turtle stdlib source prepended to every program (LANG.md §4) |
| `tokenize.js` | line-oriented lexer; `run` switches to raw-command mode for the rest of the line |
| `parser.js` | tokens -> AST (declarations, statements, expressions) |
| `compile.js` | public API + semantic analysis (names, scopes, macro params, temporal rules, call cycles, diagnostics) |
| `codegen.js` | instant-code lowering, timeline state-machine lowering, pack assembly |
| `errors.js` | `TpError` (message + line in prelude+user text) |

## Generated pack

```
pack.mcmeta                                  pack_format 48, supported_formats 48..9999, install hint
data/minecraft/tags/function/load.json       {"values":["tp:load"]}
data/minecraft/tags/function/tick.json       {"values":["tp:tick"]}
data/tp/function/load.mcfunction             scoreboards, user state, loop indices, #__started=0
data/tp/function/start.mcfunction            pen under the player, then tp:start/rewind
data/tp/function/start_at.mcfunction         pen at the command's position, then tp:start/rewind
data/tp/function/stop.mcfunction             pause in place (#__started 0, #__paused 1, sleep 0) + say
data/tp/function/start/rewind.mcfunction     the one shared reset (scores, state, loops, brush, paused) + say
data/tp/function/status.mcfunction           chat diagnostics (paused? running? brush? pen?), /function tp:status
data/tp/function/tick.mcfunction             thin gate: wait for a player, then call tp:tick/body
data/tp/function/tick/body.mcfunction        tick blocks -> press -> dispatch -> sleep-- -> now++
data/tp/function/main/dispatch.mcfunction    one line per timeline state
data/tp/function/main/s<id>.mcfunction       timeline state machine (one state per over/if/wait)
data/tp/function/fn/<name>.mcfunction        zero-parameter functions
data/tp/function/fn/paint.mcfunction         runtime brush: dispatch on #__brush, setblock at the pen
data/tp/function/brush/<block>.mcfunction    in-game brush selector, one per palette entry
data/tp/function/brush/next.mcfunction       cycle the brush (wraps at the end of the palette)
data/tp/function/snippet/<id>.mcfunction     instant `if` branches (fn/tick/when code)
data/tp/function/event/press.mcfunction      `when press` bodies, only if declared
```

Every generated function starts with a `# Tickpack ...` header and carries
`# source line N` comments for user statements, so the pack can be read side by
side with the source (`over` = init/head/body/latch states, `wait` = sleep, `if` =
condition/branch/join states).

## Runtime brush (change the drawing block, in game too)

The compiler owns a fixed palette; `brush(<block>)` writes its index to the
reserved score `#__brush` and `paint` calls `tp:fn/paint`, which places the
selected block at the pen:

```
stone(0), gold_block(1), redstone_block(2), emerald_block(3), lapis_block(4),
diamond_block(5), coal_block(6), glowstone(7), white_wool(8), purple_wool(9),
oak_planks(10), glass(11)
```

```tp
brush(gold_block)
over 90 as i {
  walk
  paint
  turn(8)
}
```

`brush(...)` validates at compile time (unknown block = error listing the palette)
and works anywhere a statement works (timeline, `fn`, `tick`, `when press`);
`paint` and `paint()` are both accepted. In game the player can switch the brush
of a running program without editing code:

```
/function tp:brush/redstone_block   # select a palette entry
/function tp:brush/next             # cycle, wrapping to stone
/function tp:status                 # shows the current brush too
```

The shared rewind resets the brush to stone, so every `/function tp:start` /
`start_at` starts from the same state. `brush` and `paint` are reserved names.

## Real-world startup (player-anchored pen)

`load.mcfunction` runs during world load, when no player exists yet — and in a
normal world y=0 is nowhere near the surface. So the runtime never draws during
load: it waits.

* `#__started` (reserved, compiler-internal score) is 0 after load; `#__paused`
  (also reserved) distinguishes "not started / waiting" (0) from an explicit
  `/function tp:stop` (1).
* Every tick, `tp:tick` first runs
  `execute if score #__started tp matches 0 if score #__paused tp matches 0 if entity @a run function tp:start`,
  then `execute if score #__started tp matches 1 run function tp:tick/body`.
* `tp:start` kills any old pen, anchors a new one on the ground under the nearest
  player (`execute at @p run summon armor_stand ~ ~-1 ~ ...`), then calls
  `tp:start/rewind`.
* `tp:start/rewind` is the one shared reset: it rewinds the whole scoreboard
  machine (`#__tick/#__pc/#__sleep/#__press/#__pressSeen/#__b/#__brush`, user
  state, loop indices), clears `#__paused`, sets `#__started = 1` and prints one
  chat line. Because start and the body run on the same tick, state 0 executes on
  the tick the player is detected and `now`/one-iteration-per-tick are unchanged.
* `tp:start_at` kills the old pen, spawns the new one at the *command's execution
  position* (`summon armor_stand ~ ~ ~ ...`), then calls the same rewind. So
  `/execute positioned 100 -60 100 run function tp:start_at` anchors the drawing
  at explicit coordinates (handy in superflat worlds at y=-60).
* `tp:stop` pauses in place: `#__started = 0`, `#__paused = 1`, `#__sleep = 0`
  and one chat line. The pen and existing blocks stay, no tick-block/timeline
  code runs, and the gate does not auto-restart because `#__paused` is set. A
  later `tp:start` / `tp:start_at` clears `#__paused` and resumes from a rewound
  run (handy for never-ending `tick { ... }` programs such as the *endless*
  sample).
* Any player can type `/function tp:start` to re-anchor under their feet and
  redraw, `tp:start_at` to choose coordinates, `tp:stop` to pause, and
  `/function tp:status` to see whether the runtime is paused/waiting/running, the
  current brush, and whether the pen exists.

## How the temporal lowering works

* `over N as i { body }` -> `init` (`#__i<k> = 0`) -> `head` (if `#__i<k> < N`
  call body, else after) -> `body` -> `latch` (`#__i<k> += 1`, `#__sleep = 1`,
  `#__pc = head`). Each iteration therefore costs exactly one tick; the state
  functions chain to each other within a tick, and only the latch yields.
* `wait N` -> `#__sleep = N; #__pc = resume-state; return`. `tp:tick` resumes
  when `#__sleep == 0`; the countdown runs after dispatch, so `wait 2` resumes
  two ticks later and `wait 0` resumes on the next tick.
* `if c { A } else { B }` on the timeline becomes condition / true / false / join
  states. A missing or empty branch jumps straight to the join. Instant `if` in
  fn/tick/when code becomes `tp:snippet/<id>` branch functions instead.
* `when press` is guarded by the `#__press - #__pressSeen` delta in `tp:tick`.

### Implementation notes / deliberate details

* **Dispatch latch (`#__b`).** Minecraft executes the lines of a function
  sequentially, and a state that chains or yields *changes* `#__pc` before
  dispatch returns. Without protection the later `#__pc matches <id>` lines of the
  same dispatch would run a second state on the same tick. So dispatch sets the
  `#__b` latch to 1 and every state clears it on entry; the first state entered
  wins and the rest of the dispatch is skipped. The same latch protects the
  `head`/branch decision states, whose two `execute` lines would otherwise both
  fire after the taken branch changed the loop index. This is the one place where
  the literal §2.3 dispatch shape needed an extra guard; semantics otherwise match
  the spec exactly.
* **`#__b` is initialized by dispatch, not by `load`.** The `#__a/#__b` scratch
  players are reserved by §2.1; `#__a` holds the press delta.
* **Assignment optimizations** (optional per §2.4, used for readability):
  `x = <int>` -> `scoreboard players set`, `x = x +- <int>` -> `add`/`remove`,
  `x = y` -> `operation =`. Everything else evaluates into a `#__t<n>` temp.
* **Comparisons against a literal** (`if count >= arm` vs `if i % 4 == 0`) skip the
  temporary + subtraction and use a shifted `matches` range. Comparisons between
  two dynamic values use the canonical subtract-then-test lowering.
* **Division/modulo by zero** is emitted as a plain `scoreboard players
  operation /=`/`%=`: vanilla Minecraft and the simulator both define a zero
  divisor result as 0, which is the language rule (§1.4).
* **Macro functions**: a zero-parameter `fn` becomes a real function file and
  calls are `function tp:fn/<name>`. A `fn` with parameters has no file: its body
  is inlined with `$param` substituted at every call site (recursively). As a small
  extension, a macro parameter may be passed on to another macro function
  (`fn quad(b) { plot($b) }`), which keeps composition readable; plain arguments
  are still only integer literals or bare identifiers (§1.6).
* **Loop indices** are `#__i0`, `#__i1`, ... in compilation order and are
  initialized in `load.mcfunction`. Loop index names are lexically scoped; an
  index is read-only (assigning to it is a compile error).
* **`meta`**: `preludeLines` is the number of newline characters in `PRELUDE`
  (user source line 1 = `preludeLines + 1`); `variables` lists declared states;
  `stateCount` is the number of `tp:main/s*` states; `functionCount` is the number
  of generated `.mcfunction` files (same definition as the UI dev fixture);
  `hasTickBlocks` is true iff the program declares at least one `tick { ... }`
  block, so the UI knows a tick-only program keeps running even when its timeline
  is finished (`#__pc == -1`) from the start.

## Errors

`compile()` never throws. Diagnostics are `{ severity, line, message }` where
`line` is a 1-based **user** source line (the prelude offset is already removed).
On any error `ok` is false and `files` is empty. All §1.2/§1.6 rules are enforced:
unknown names, duplicate declarations, `over`/`wait` inside fn/tick/when
("… spans time; move it to the timeline"), unknown `$params`, macro call cycles,
identifier arguments to parameters used in expressions, reserved words,
`__`-prefixed names, and a `brush(...)` block outside the palette (the message
lists every valid block).

## Tests

`test/lang.test.js` contains golden pack tests (exact generated state machine and
load/tick/dispatch ordering) plus a small test-only stepper that runs generated
packs tick by tick. Run it with:

```
node test/lang.test.js
# or, when the Node test runner can spawn child processes:
node --test test/lang.test.js
```

Under the DSH file sandbox `node --test <file>` cannot spawn its isolated child
process (`spawn EPERM`); `node --test --test-isolation=none test/lang.test.js`
runs the same tests in-process.
