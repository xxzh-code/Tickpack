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
pack.mcmeta                                  pack_format 48
data/minecraft/tags/function/load.json       {"values":["tp:load"]}
data/minecraft/tags/function/tick.json       {"values":["tp:tick"]}
data/tp/function/load.mcfunction             scoreboards, user state, loop indices, pen entity
data/tp/function/tick.mcfunction             tick blocks -> press -> dispatch -> sleep-- -> now++
data/tp/function/main/dispatch.mcfunction    one line per timeline state
data/tp/function/main/s<id>.mcfunction       timeline state machine (one state per over/if/wait)
data/tp/function/fn/<name>.mcfunction        zero-parameter functions
data/tp/function/snippet/<id>.mcfunction     instant `if` branches (fn/tick/when code)
data/tp/function/event/press.mcfunction      `when press` bodies, only if declared
```

Every generated function starts with a `# Tickpack ...` header and carries
`# source line N` comments for user statements, so the pack can be read side by
side with the source (`over` = init/head/body/latch states, `wait` = sleep, `if` =
condition/branch/join states).

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
  of generated `.mcfunction` files (same definition as the UI dev fixture).

## Errors

`compile()` never throws. Diagnostics are `{ severity, line, message }` where
`line` is a 1-based **user** source line (the prelude offset is already removed).
On any error `ok` is false and `files` is empty. All §1.2/§1.6 rules are enforced:
unknown names, duplicate declarations, `over`/`wait` inside fn/tick/when
("… spans time; move it to the timeline"), unknown `$params`, macro call cycles,
identifier arguments to parameters used in expressions, reserved words and
`__`-prefixed names.

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
