# Tickpack v0.1 — Language & Runtime Spec

Status: **frozen for slice 1**. If an implementation detail is unclear, ask the Lead;
do not silently change semantics.

Tickpack is a tiny language that compiles to a real Minecraft datapack.
The point of the language: **control flow is temporal by default.**
A `over` loop spends one tick per iteration; state lives in scoreboards;
the compiled program is a state machine that is resumed once per tick.

## 1. Source language

Line-oriented, braces for blocks, `#` starts a comment (outside strings).
Indentation is irrelevant. Statements are terminated by newline.

### 1.1 Declarations (top level only)

```
state x = 0                     # integer state -> scoreboard #x on objective `tp`
fn walk() { ... }               # instant function, compiled to a mcfunction
fn turn(deg) { ... }            # constant-parameter macro function (see 1.6)
tick { ... }                    # runs at the start of every tick (instant code only)
when press { ... }              # runs once per host "press" input (instant code only)
```

- `state` initial value is an integer literal. States are global; `x` in an
  expression reads `#x` on objective `tp`.
- `now` is a built-in expression: the number of ticks elapsed so far (starts at 0).
- User state/loop/fn names must match `[A-Za-z_][A-Za-z0-9_]*`. Names starting
  with `__` are reserved for the compiler.
- Duplicate state names, duplicate fn names, unknown names => compile error.

### 1.2 Timeline statements (top level, and inside `if` / `over` bodies)

These run as the **main timeline**: the program starts at tick 0 and is resumed
once per tick.

```
over 8 as i { ... }             # temporal loop: body executes once per tick, i = 0..7
wait 5                          # suspend the timeline for 5 ticks
if cond { ... } else { ... }    # branch (branches may contain temporal statements)
say "text"                      # raw /say (strings only, no interpolation)
run <raw command>               # inject a vanilla command verbatim (rest of the line)
x = expr                        # assign to state
walk()                          # call a fn (instant)
name(arg1, arg2)                # call a macro fn
```

`over` semantics: iteration `k` (starting at 0) **starts on a new tick**; a body
made only of instant statements costs exactly one tick per iteration. The
statement after the loop starts on the tick after the last iteration finished.
Nesting is allowed.

`wait N` costs exactly N ticks; N may be 0 (equivalent to "resume next tick").

`if/else` branches may contain `over`/`wait`; the timeline state machine handles
both branches uniformly.

### 1.3 Instant statements (inside `fn`, `tick`, `when`, and also usable anywhere)

```
x = expr
say "text"
run <raw command>
fnCall(...)
if cond { ... } else { ... }    # branches must be instant-only
```

**Hard rule:** `fn`, `tick` and `when` bodies may not contain `over` or `wait`.
Those are timeline-only. Attempting it is a compile error
("… spans time; move it to the timeline"). This keeps functions plain
mcfunction files and makes the tick/time split explicit.

### 1.4 Expressions

```
expr   := or
or     := and ('or' and)*
and    := cmp ('and' cmp)*
cmp    := add (('=='|'!='|'<'|'<='|'>'|'>=') add)*
add    := mul (('+'|'-') mul)*
mul    := unary (('*'|'/'|'%') unary)*
unary  := ('-'|'not') unary | atom
atom   := INT | 'now' | IDENT | '$' PARAM | '(' expr ')'
```

- Integers only (scoreboards are 32-bit ints). Division/modulo by zero => 0.
- Comparison yields 0/1. `and`/`or`/`not` operate on the 0/1 values
  (`a and b` = 1 iff both nonzero).
- In `if`, a condition is true when the value is nonzero.
- Function calls are statements only, never expressions (v0.1).

### 1.5 `run` lines

The text after `run` is a vanilla command, passed through verbatim
(a trailing `# comment` is stripped). It is executed where it appears:
inside a timeline state, inside a fn, inside a tick block. No interpolation
except macro parameters (1.6).

### 1.6 Constant-parameter macro functions

`fn turn(deg) { run ... ~$deg ~ }` — parameters are **compile-time constants**.
Arguments must be integer literals or bare identifiers (e.g. `gold_block`).
At the call site the compiler substitutes each `$param` occurrence in `run`
lines with the argument's source text. Integer params may also be used in
expressions as literals (`x = $deg * 2`).

- Macro expansion is recursive (fn A may call fn B), cycles are compile errors.
- A parameter used in an expression that receives an identifier argument is an
  error.
- `$unknown` inside a fn body is an error.
- Calls are statements, not expressions.

## 2. Compilation model

### 2.1 Scoreboard layout

One objective: **`tp`** (dummy). Fake players:

| name | meaning |
| --- | --- |
| `#__tick` | ticks elapsed (`now`) |
| `#__pc` | main timeline program counter (state id); `-1` = finished |
| `#__sleep` | ticks left to sleep before dispatching again |
| `#__press` | host input: incremented by the simulator on each press |
| `#__pressSeen` | last press count consumed by the event handler |
| `#__a`, `#__b` | scratch |
| `#__t0`..`#__t9` | expression temporaries (compiler may use more) |
| `#<state>` | user state variable |
| `#__i<k>` | loop index of the k-th `over` loop (unique per loop) |

All values are signed 32-bit integers.

### 2.2 Tick order (`tp:tick`, registered in `minecraft/tags/function/tick.json`)

1. user `tick {}` blocks, in source order
2. `when press` handlers (guarded by press counter delta)
3. timeline dispatch, only if `#__sleep == 0`
4. if `#__sleep >= 1`: `#__sleep -= 1`
5. `#__tick += 1`

Order matters and is part of the observable behavior.

### 2.3 Timeline state machine

Each state is one function `tp:main/s<id>`. A state contains a straight-line
sequence of commands and ends in exactly one of:

- **chain**: set `#__pc` to the next state id and `function` it;
- **yield**: set `#__sleep` (>= 1) and `#__pc` to the state to resume, then return;
- **finish**: set `#__pc` to `-1`, return.

`tp:main/dispatch` contains one line per state:
`execute if score #__pc tp matches <id> run function tp:main/s<id>`.
`tp:tick` calls dispatch only when `#__sleep == 0`.

Canonical lowering of `over N as i { body }` (ids are illustrative):

```
init   : set #__i 0; pc=next; call next
head   : if #__i matches 0..N-1 -> body entry, else -> after   (via execute if/unless)
body...: ...
after body: #__i += 1; sleep=1; pc=head; return        # yields exactly one tick
after  : continue with the following statement
```

Canonical lowering of `wait N`:
`#__sleep = N; pc = resume-state; return`.

Canonical lowering of `if c { A } else { B }`:
evaluate c into a temp, then
`execute if score #__t0 tp matches 1.. run function <A entry>` and
`execute if score #__t0 tp matches ..0 run function <B entry>` (0 = false).
Both branch entries chain to the join state. A missing `else` gets an empty
branch that jumps to the join. This works for both instant and temporal branches.

### 2.4 Instant code lowering

Sequences of instant statements become straight-line functions.
`if` inside instant code lowers to `execute if score ... run function tp:snippet/<id>`
for each branch (snippets chain back by simply returning).
Expressions compile to temp scores:

- literal `n` -> `scoreboard players set #__t0 tp n`
- var `x` -> `scoreboard players operation #__t0 tp = #x tp`
- `a + b` -> eval a into t0, b into t1, `operation #__t0 tp += #__t1 tp`
- comparisons: subtract then `execute if score <tmp> tp matches <range> run
  scoreboard players set <dst> tp 1` (dst preset to 0)
- assignment to a var: eval into temp, then `operation #<var> tp = #__t<tmp>`

Optimization (`x = x + 1` -> `scoreboard players add #x tp 1`) is welcome but optional.
Correctness first, readability second: every emitted command should be real,
loadable Minecraft syntax.

## 3. Datapack output layout

Namespace `tp`, pack format 48 (Minecraft 1.21). All paths relative to the
datapack root:

```
pack.mcmeta
data/minecraft/tags/function/load.json     {"values":["tp:load"]}
data/minecraft/tags/function/tick.json     {"values":["tp:tick"]}
data/tp/function/load.mcfunction
data/tp/function/tick.mcfunction
data/tp/function/main/dispatch.mcfunction
data/tp/function/main/s<id>.mcfunction
data/tp/function/fn/<name>.mcfunction
data/tp/function/snippet/<id>.mcfunction
data/tp/function/event/press.mcfunction        (only if `when press` exists)
```

`load.mcfunction`:

```
# generated by Tickpack
scoreboard objectives add tp dummy
scoreboard players set #__tick tp 0
scoreboard players set #__pc tp <first state id or -1>
scoreboard players set #__sleep tp 0
scoreboard players set #__press tp 0
scoreboard players set #__pressSeen tp 0
scoreboard players set #x tp <init>      # one per declared state
scoreboard players set #__i0 tp 0        # loop indices if used
kill @e[tag=pen]
summon armor_stand 0.5 0 0.5 {Tags:["pen"],Invisible:1b,NoGravity:1b,Marker:1b}
```

The world: a flat plane, ground at y=0. The pen is the turtle entity
(armor stand, tag `pen`, yaw 0 = facing +Z). Blocks are placed at y=0.
Pen position starts at (0.5, 0, 0.5) so that `setblock ~ ~ ~` after
`execute at @e[tag=pen]` lands on block (0,0,0). (The simulator floors
positions for block commands; x/z in [-16,16].)

Every generated function starts with a `# Tickpack ...` header and may contain
`# source line N` comments for traceability. Comments must not affect execution.

## 4. Standard library (prelude)

The compiler always prepends `src/lang/prelude.js` (`PRELUDE`, a `.tp`-syntax
string) before user source. It defines the turtle API below. Users may not
redefine prelude function names (compile error), but may add their own fns.
`prelude.js` may also be extended by the compiler owner if samples need more.

Required prelude functions:

```
fn walk()                 # move pen 1 block forward (^ ^ ^1)
fn walk2()                # move 2 forward
fn turn(deg)              # rotate yaw by deg degrees (macro, e.g. turn(90), turn(-45))
fn plot(block)            # setblock at pen's block position to `block` (macro)
fn plot_under(block)      # same but one block below? (only if trivial -- optional)
fn stamp()                # particle at pen position (visual sparkle)
fn clear_ground()         # fill the visible 33x33 area with air (run fill ...)
fn home()                 # teleport pen to (0.5, 0, 0.5), yaw 0
```

Implementation notes:
- `walk`: `execute as @e[tag=pen] at @s run tp @s ^ ^ ^1`
- `turn(deg)`: `execute as @e[tag=pen] at @s run tp @s ~ ~ ~ ~$deg ~`
- `plot(block)`: `execute at @e[tag=pen] run setblock ~ ~ ~ $block`
  (same-block replacement is fine; the simulator ignores no-op setblocks in
  the trace so the timeline stays meaningful)
- `stamp`: `execute at @e[tag=pen] run particle happy_villager ~ ~ ~ 0 0 0 0 1`
- `clear_ground`: `run fill -16 0 -16 16 0 16 air`
- `home`: `run tp @e[tag=pen] 0.5 0 0.5 0 0`

## 5. Simulator contract

`src/sim/sim.js` exports `class Simulator`. It loads a virtual pack
(`{ [path]: text }`) and executes **the generated mcfunction** (not the AST).

```js
const sim = new Simulator(files);   // files = compile(...).files
sim.reset();                        // clear scores/world, run tp:load
const events = sim.step();          // run exactly one tick (tp:tick), then tick++
sim.press();                        // host input; increments #__press
sim.getTick();                      // number of ticks stepped
sim.getWorld();                     // { blocks: [{x,y,z,block}], entities: [{id,type,x,y,z,yaw,pitch,tags}] }
sim.getScores();                    // { [objective]: { [fakePlayer]: value } }
sim.snapshot();                     // structured-cloneable full state
sim.restore(snapshot);              // restore state (no tag reload)
```

Trace events returned by `step()` (must be stable; the UI depends on them):

```js
{ type:'command', tick, file:'data/tp/function/main/s0.mcfunction', line:3,
  fn:'tp:main/s0', text:'scoreboard players ...' }
{ type:'say', tick, text:'hello' }
{ type:'particle', tick, x,y,z, particle:'happy_villager' }
{ type:'error', tick, message, file?, line? }
```

`file` is the pack-relative path; `line` is 1-based in that file.
`getWorld()` blocks are only non-air blocks; coordinates are integers.
`snapshot()` must survive `structuredClone` (plain objects/arrays/strings/numbers).

Supported command subset in v0.1 (unknown commands produce an `error` event,
never a crash):

- `scoreboard objectives add|remove <obj> dummy ...`
- `scoreboard players set|add|remove <target> <obj> <int>`
- `scoreboard players reset <target> [<obj>]`
- `scoreboard players operation <t> <obj> (=|+=|-=|*=|/=|%=) <src> <obj>`
- `execute [as <sel>] [at <sel>] [positioned <x> <y> <z>]
   [if score <t> <obj> matches <range>] [unless score ...]
   [if block <x> <y> <z> <block>] [unless block ...] run <command>`
- selectors: `@s`, `@p`, `@a`, `@e[...]` with `tag=`, `limit=`, `type=`
- `tp <targets> <x> <y> <z> [<yaw> <pitch>]` (absolute, `~` offsets, `^` local,
  relative rotation `~N` = target yaw + N)
- `setblock <x> <y> <z> <block> [replace|destroy|keep]`
- `fill <x1> <y1> <z1> <x2> <y2> <z2> <block>`
- `summon <type> <x> <y> <z> [<nbt>]` (only `Tags:[...]` is read; other NBT ignored)
- `kill <targets>`, `tag <targets> add|remove <tag>`
- `say <text>`, `function <ns:path>`, `particle <name> <x> <y> <z> ...`
- comments (`#...`) and blank lines

Semantics notes:
- Unknown score = 0. Scores are 32-bit signed ints, `/` truncates toward zero.
- `matches` range syntax: `5`, `5..`, `..5`, `5..10`, `..` (always).
- Block coordinates for `setblock`/`fill`/`if block` are floored from floats.
- Yaw 0 faces +Z; direction = (-sin(yaw), 0, cos(yaw)); `~N` rotation on `tp`
  adds N to the target's own yaw. Pitch unused (flat world).
- Execution budget: hard cap ~100k commands per tick to catch infinite loops;
  emit an `error` event and stop the tick.
- `fill` volume cap 4096 blocks.
- Function recursion is allowed; depth cap 256 (error event beyond).

## 6. Browser app contract

`web/index.html` (served at `/`, static, no build step) imports
`../src/api.js` and is the only UI. `src/api.js` (Lead-owned) exposes:

```js
export { compile } from './lang/compile.js';
export { Simulator } from './sim/sim.js';
export { PRELUDE } from './lang/prelude.js';
export { SAMPLES } from './samples.js';   // [{ id, title, description, source }]
```

`compile(source) -> { ok, files, diagnostics, meta }`
- `files`: `{ 'pack.mcmeta': '...', 'data/tp/function/load.mcfunction': '...' }`
- `diagnostics`: `[{ severity:'error'|'warning', line, message }]`, `line` is
  1-based **user source** line (prelude offset already subtracted).
- `meta`: `{ preludeLines, variables:[{name,initial}], stateCount, functionCount }`

No UI component may depend on compiler internals or simulator internals beyond
these two contracts. UI must not be added to the repo outside `web/**`
(Lead integrates `src/api.js`).
