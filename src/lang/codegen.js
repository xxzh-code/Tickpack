// Tickpack code generator.
//
// Two kinds of code (docs/LANG.md §1.2/§1.3):
//
//  * instant code — fn bodies, tick blocks, when blocks, and the straight-line
//    parts of timeline states. It becomes ordinary commands in a mcfunction.
//  * timeline code — over / wait / if. It becomes an explicit state machine:
//    every state is one function `tp:main/s<id>` ending in a chain, a yield
//    (`#__sleep`) or a finish (`#__pc = -1`). `tp:main/dispatch` resumes the
//    state named by `#__pc` once per tick.
//
// `over N as i { body }` lowers to: init (i = 0) -> head (i < N ? body : after)
// -> body -> latch (i += 1, sleep 1 tick) -> head. That is the "loop is a clock"
// moment: one scoreboard counter, one program counter, one state per tick.
import { TpError } from './errors.js';

const COMPARISONS = {
  '==': { predicate: 'if', range: '0' },
  '!=': { predicate: 'unless', range: '0' },
  '<': { predicate: 'if', range: '..-1' },
  '<=': { predicate: 'if', range: '..0' },
  '>': { predicate: 'if', range: '1..' },
  '>=': { predicate: 'if', range: '0..' },
};

const OP_COMMAND = {
  '+': '+=',
  '-': '-=',
  '*': '*=',
  '/': '/=',
  '%': '%=',
};

/** The one chat line printed by tp:start: the pack is alive, and how to replay it. */
const START_MESSAGE =
  'Tickpack: 开始在你脚边绘制（/function tp:start 可重画，图案会画在脚下的地面上）';

/** pack.mcmeta description: install hint shown in the data-pack list. */
const PACK_DESCRIPTION = 'Tickpack · 放进存档 datapacks/ 后会在你脚边开始画；/function tp:start 重画';

/** Value of a constant expression (`5` or `-5`), or null when it is not one. */
function intLiteralValue(expr) {
  if (expr.kind === 'int') return expr.value;
  if (expr.kind === 'un' && expr.op === '-' && expr.operand.kind === 'int') return -expr.operand.value;
  return null;
}

/** `x <op> <literal>` as a single `matches` range. */
function compareLiteral(op, value) {
  switch (op) {
    case '==':
      return { predicate: 'if', range: `${value}` };
    case '!=':
      return { predicate: 'unless', range: `${value}` };
    case '<':
      return { predicate: 'if', range: `..${value - 1}` };
    case '<=':
      return { predicate: 'if', range: `..${value}` };
    case '>':
      return { predicate: 'if', range: `${value + 1}..` };
    case '>=':
      return { predicate: 'if', range: `${value}..` };
    default:
      return null;
  }
}

/** Reuses `#__t0..` within one command list; frees are explicit on purpose. */
class TempAllocator {
  constructor() {
    this.used = new Set();
  }

  alloc() {
    let index = 0;
    while (this.used.has(index)) index += 1;
    this.used.add(index);
    return `#__t${index}`;
  }

  free(temp) {
    this.used.delete(Number(temp.slice('#__t'.length)));
  }
}

export class CodeGen {
  constructor(program, semantics, preludeOffset) {
    this.program = program;
    this.sem = semantics;
    this.off = preludeOffset;

    // timeline state machine
    this.blocks = [];
    this.current = null;
    this.stateIds = null;
    this.loopVars = []; // lexical scope of `over ... as i` inside the timeline
    this.loopNames = []; // every allocated loop index, in allocation order
    this.loopCount = 0;

    // instant snippets + macro expansion
    this.snippets = [];
    this.snippetCount = 0;
  }

  userLine(fullLine) {
    return fullLine - this.off;
  }

  // ---------------------------------------------------------------- front end

  run() {
    const tickOut = this.genTick();
    const pressOut = this.genPress();
    const fnFiles = this.genFnFiles();
    const blocks = this.genTimeline(this.program.timeline);
    this.stateIds = new Map(blocks.map((block, id) => [block, id]));
    const files = this.assemble(tickOut, pressOut, fnFiles, blocks);
    const functionCount = Object.keys(files).filter((path) => path.endsWith('.mcfunction')).length;
    const meta = {
      preludeLines: this.off,
      variables: this.program.states.map((state) => ({ name: state.name, initial: state.initial })),
      stateCount: blocks.length,
      functionCount,
    };
    return { files, meta };
  }

  // ------------------------------------------------------------ instant code

  newEnv(bindings = new Map(), loopVars = []) {
    return { allocator: new TempAllocator(), bindings, loopVars };
  }

  /** `# source line N` before a user statement (prelude lines are not annotated). */
  markSrc(out, fullLine) {
    const line = this.userLine(fullLine);
    if (line < 1) return;
    if (out._srcLine === line) return;
    out._srcLine = line;
    out.push(`# source line ${line}`);
  }

  genInstantStatements(statements, out, env) {
    for (const statement of statements) {
      this.markSrc(out, statement.line);
      this.genInstantStatement(statement, out, env);
    }
  }

  genInstantStatement(statement, out, env) {
    switch (statement.kind) {
      case 'assign':
        this.genAssign(statement, out, env);
        return;
      case 'say':
        out.push(`say ${statement.text}`);
        return;
      case 'run':
        out.push(this.substitute(statement.text, env, statement.line));
        return;
      case 'call':
        this.genCall(statement, out, env);
        return;
      case 'if':
        this.genInstantIf(statement, out, env);
        return;
      case 'over':
      case 'wait':
        throw new TpError(
          `${statement.kind} spans time; move it to the timeline (fn/tick/when bodies are instant)`,
          statement.line,
        );
      default:
        throw new TpError(`internal: unknown instant statement '${statement.kind}'`, statement.line);
    }
  }

  genAssign(statement, out, env) {
    const target = `#${statement.target}`;
    const expr = statement.expr;

    // Optimization for the most common writes: keep the pack readable.
    const literal = intLiteralValue(expr);
    if (literal !== null) {
      out.push(`scoreboard players set ${target} tp ${literal}`);
      return;
    }
    if (expr.kind === 'var' && expr.name === statement.target) return; // `x = x` is a no-op
    if (
      expr.kind === 'bin' &&
      (expr.op === '+' || expr.op === '-') &&
      expr.left.kind === 'var' &&
      expr.left.name === statement.target
    ) {
      const delta = intLiteralValue(expr.right);
      if (delta !== null) {
        if (expr.op === '+') {
          out.push(`scoreboard players add ${target} tp ${delta}`);
        } else if (delta >= 0) {
          out.push(`scoreboard players remove ${target} tp ${delta}`);
        } else {
          out.push(`scoreboard players add ${target} tp ${-delta}`);
        }
        return;
      }
    }
    if (expr.kind === 'var') {
      out.push(`scoreboard players operation ${target} tp = ${this.varScore(expr.name, expr.line)} tp`);
      return;
    }

    const temp = this.genExpr(expr, out, env);
    out.push(`scoreboard players operation ${target} tp = ${temp} tp`);
    env.allocator.free(temp);
  }

  /** Follow a macro argument through pass-through bindings down to a literal/id. */
  resolveArgument(arg, env, line) {
    let current = arg;
    let depth = 0;
    while (current && current.kind === 'param') {
      const next = env.bindings.get(current.name);
      if (!next) throw new TpError(`unknown macro parameter '$${current.name}'`, line);
      current = next;
      depth += 1;
      if (depth > 256) throw new TpError('macro parameter cycle while expanding', line);
    }
    if (!current) throw new TpError('internal: unresolved macro argument', line);
    return current;
  }

  genCall(statement, out, env) {
    const fn = this.sem.fns.get(statement.name);
    if (!fn) throw new TpError(`unknown function '${statement.name}'`, statement.line);

    if (fn.params.length === 0) {
      out.push(`function tp:fn/${fn.name}`);
      return;
    }

    // Constant-parameter macro: bind the arguments to the source text and inline
    // the body right here (docs/LANG.md §1.6). Arguments are resolved through the
    // current bindings first, so macros can pass their own params on (fn A -> fn B).
    const resolvedArgs = statement.args.map((arg) => this.resolveArgument(arg, env, statement.line));
    const bindings = new Map(env.bindings);
    fn.params.forEach((param, index) => bindings.set(param.name, resolvedArgs[index]));
    out.push(`# inlined fn ${fn.name}(${resolvedArgs.map((arg) => arg.raw).join(', ')})`);
    this.genInstantStatements(fn.body, out, {
      allocator: env.allocator,
      bindings,
      // A macro body is written at the top level: it must not see the caller's
      // loop indices (semantic analysis resolved its names without them too).
      loopVars: [],
    });
  }

  genInstantIf(statement, out, env) {
    const hasThen = statement.then.length > 0;
    const hasElse = !!(statement.else && statement.else.length > 0);
    if (!hasThen && !hasElse) return;

    const temp = this.genExpr(statement.cond, out, env);
    let thenId = null;
    let elseId = null;
    if (hasThen) thenId = this.genSnippet(statement.then, statement.line, env, 'true');
    if (hasElse) elseId = this.genSnippet(statement.else, statement.line, env, 'false');

    if (elseId !== null) {
      out.push(`execute if score ${temp} tp matches 0 run function tp:snippet/${elseId}`);
    }
    if (thenId !== null) {
      out.push(`execute unless score ${temp} tp matches 0 run function tp:snippet/${thenId}`);
    }
    env.allocator.free(temp);
  }

  genSnippet(statements, sourceLine, parentEnv, branch) {
    const id = this.snippetCount;
    this.snippetCount += 1;
    const out = [];
    this.genInstantStatements(statements, out, {
      allocator: new TempAllocator(),
      bindings: parentEnv.bindings,
      loopVars: parentEnv.loopVars,
    });
    this.snippets.push({ id, branch, line: sourceLine, out });
    return id;
  }

  substitute(text, env, line) {
    return text.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_whole, name) => {
      const arg = this.resolveArgument({ kind: 'param', name }, env, line);
      return arg.raw;
    });
  }

  varScore(name, line) {
    for (let i = this.loopVars.length - 1; i >= 0; i -= 1) {
      if (this.loopVars[i].name === name) return this.loopVars[i].score;
    }
    if (this.sem.states.has(name)) return `#${name}`;
    throw new TpError(`internal: unknown variable '${name}'`, line);
  }

  // ---------------------------------------------------------- expressions

  /** Emit commands computing `expr` and return the temp score holding it. */
  genExpr(expr, out, env) {
    switch (expr.kind) {
      case 'int': {
        const temp = env.allocator.alloc();
        out.push(`scoreboard players set ${temp} tp ${expr.value}`);
        return temp;
      }
      case 'now': {
        const temp = env.allocator.alloc();
        out.push(`scoreboard players operation ${temp} tp = #__tick tp`);
        return temp;
      }
      case 'var': {
        const temp = env.allocator.alloc();
        out.push(`scoreboard players operation ${temp} tp = ${this.varScore(expr.name, expr.line)} tp`);
        return temp;
      }
      case 'param': {
        const arg = this.resolveArgument({ kind: 'param', name: expr.name }, env, expr.line);
        if (arg.kind !== 'int') {
          throw new TpError(`macro parameter '$${expr.name}' needs an integer argument`, expr.line);
        }
        const temp = env.allocator.alloc();
        out.push(`scoreboard players set ${temp} tp ${arg.value}`);
        return temp;
      }
      case 'un': {
        if (expr.op === '-') {
          if (expr.operand.kind === 'int') {
            const temp = env.allocator.alloc();
            out.push(`scoreboard players set ${temp} tp ${-expr.operand.value}`);
            return temp;
          }
          const operand = this.genExpr(expr.operand, out, env);
          const temp = env.allocator.alloc();
          out.push(`scoreboard players set ${temp} tp 0`);
          out.push(`scoreboard players operation ${temp} tp -= ${operand} tp`);
          env.allocator.free(operand);
          return temp;
        }
        // `not x`: 1 when x == 0, else 0.
        const operand = this.genExpr(expr.operand, out, env);
        const temp = env.allocator.alloc();
        out.push(`scoreboard players set ${temp} tp 1`);
        out.push(`execute unless score ${operand} tp matches 0 run scoreboard players set ${temp} tp 0`);
        env.allocator.free(operand);
        return temp;
      }
      case 'bin':
        return this.genBinary(expr, out, env);
      default:
        throw new TpError(`internal: unknown expression '${expr.kind}'`, expr.line);
    }
  }

  genBinary(expr, out, env) {
    // Compare against a constant directly (no need to spend a temp and a
    // subtraction on the constant): `x >= 3` is `execute if score ... matches 3..`.
    const literal = intLiteralValue(expr.right);
    if (COMPARISONS[expr.op] && literal !== null) {
      const comparison = compareLiteral(expr.op, literal);
      const left = this.genExpr(expr.left, out, env);
      const temp = env.allocator.alloc();
      out.push(`scoreboard players set ${temp} tp 0`);
      out.push(
        `execute ${comparison.predicate} score ${left} tp matches ${comparison.range} run scoreboard players set ${temp} tp 1`,
      );
      env.allocator.free(left);
      return temp;
    }

    const left = this.genExpr(expr.left, out, env);
    const right = this.genExpr(expr.right, out, env);

    if (OP_COMMAND[expr.op]) {
      out.push(`scoreboard players operation ${left} tp ${OP_COMMAND[expr.op]} ${right} tp`);
      env.allocator.free(right);
      return left;
    }

    if (COMPARISONS[expr.op]) {
      const comparison = COMPARISONS[expr.op];
      out.push(`scoreboard players operation ${left} tp -= ${right} tp`);
      // Allocate the result before releasing the operands: keeps the emitted
      // commands readable (the result never reuses an operand's slot).
      const temp = env.allocator.alloc();
      out.push(`scoreboard players set ${temp} tp 0`);
      out.push(
        `execute ${comparison.predicate} score ${left} tp matches ${comparison.range} run scoreboard players set ${temp} tp 1`,
      );
      env.allocator.free(right);
      env.allocator.free(left);
      return temp;
    }

    if (expr.op === 'and') {
      const temp = env.allocator.alloc();
      out.push(`scoreboard players set ${temp} tp 1`);
      out.push(`execute if score ${left} tp matches 0 run scoreboard players set ${temp} tp 0`);
      out.push(`execute if score ${right} tp matches 0 run scoreboard players set ${temp} tp 0`);
      env.allocator.free(left);
      env.allocator.free(right);
      return temp;
    }

    if (expr.op === 'or') {
      const temp = env.allocator.alloc();
      out.push(`scoreboard players set ${temp} tp 0`);
      out.push(`execute unless score ${left} tp matches 0 run scoreboard players set ${temp} tp 1`);
      out.push(`execute unless score ${right} tp matches 0 run scoreboard players set ${temp} tp 1`);
      env.allocator.free(left);
      env.allocator.free(right);
      return temp;
    }

    throw new TpError(`internal: unknown operator '${expr.op}'`, expr.line);
  }

  // -------------------------------------------------------- timeline lowering

  genTick() {
    const out = [];
    for (const block of this.program.ticks) {
      this.genInstantStatements(block.body, out, this.newEnv());
    }
    return out;
  }

  genPress() {
    if (this.program.whens.length === 0) return null;
    const out = [];
    for (const block of this.program.whens) {
      this.genInstantStatements(block.body, out, this.newEnv());
    }
    return out;
  }

  genFnFiles() {
    const files = [];
    for (const fn of this.program.fns) {
      if (fn.params.length > 0) continue; // macro functions have no standalone file
      const out = [];
      this.genInstantStatements(fn.body, out, this.newEnv());
      files.push({ name: fn.name, line: fn.line, isPrelude: fn.line <= this.off, out });
    }
    return files;
  }

  genTimeline(statements) {
    if (statements.length === 0) return [];
    this.current = null;
    this.loopVars = [];
    this.genTimelineStatements(statements);
    const end = this.ensureBlock('end of program');
    end.term = { kind: 'finish' };
    return this.blocks;
  }

  genTimelineStatements(statements) {
    for (const statement of statements) {
      if (statement.kind === 'over') this.genOver(statement);
      else if (statement.kind === 'wait') this.genWait(statement);
      else if (statement.kind === 'if') this.genTimelineIf(statement);
      else {
        const block = this.ensureBlock();
        this.markSrc(block.cmds, statement.line);
        this.genInstantStatement(statement, block.cmds, block.env);
      }
    }
  }

  newBlock(comment) {
    const block = {
      cmds: [],
      term: null,
      comment: comment || (this.blocks.length === 0 ? 'program entry' : ''),
      env: this.newEnv(new Map(), this.loopVars.slice()),
    };
    this.blocks.push(block);
    return block;
  }

  ensureBlock(comment) {
    if (!this.current) this.current = this.newBlock(comment);
    return this.current;
  }

  genWait(statement) {
    const line = this.userLine(statement.line);
    const at = line >= 1 ? ` (source line ${line})` : '';
    const block = this.ensureBlock(`wait ${statement.count}${at}`);
    const resume = this.newBlock(`resume after wait ${statement.count}${at}`);
    block.term = { kind: 'sleep', n: statement.count, target: resume };
    this.current = resume;
  }

  genOver(statement) {
    const score = `#__i${this.loopCount}`;
    this.loopCount += 1;
    this.loopNames.push({ name: statement.varName, score });
    const line = this.userLine(statement.line);
    const at = line >= 1 ? ` (source line ${line})` : '';

    const init = this.ensureBlock(`over ${statement.varName}: init${at}`);
    init.cmds.push(`scoreboard players set ${score} tp 0`);

    if (statement.count === 0) {
      // A zero-iteration loop costs no tick: init the index, then fall through.
      const after = this.newBlock(`over ${statement.varName}: after (0 iterations)${at}`);
      init.term = { kind: 'next', target: after };
      this.current = after;
      return;
    }

    const head = this.newBlock(`over ${statement.varName}: head while ${statement.varName} < ${statement.count}${at}`);
    init.term = { kind: 'next', target: head };

    this.loopVars.push({ name: statement.varName, score });
    const body = this.newBlock(`over ${statement.varName}: body${at}`);
    this.current = body;
    this.genTimelineStatements(statement.body);
    const latch = this.ensureBlock(`over ${statement.varName}: latch, then sleep 1 tick${at}`);
    latch.cmds.push(`scoreboard players add ${score} tp 1`);
    latch.term = { kind: 'sleep', n: 1, target: head };
    this.loopVars.pop();

    const after = this.newBlock(`over ${statement.varName}: after${at}`);
    head.term = {
      kind: 'loop',
      score,
      name: statement.varName,
      count: statement.count,
      body,
      after,
    };
    this.current = after;
  }

  genTimelineIf(statement) {
    const hasThen = statement.then.length > 0;
    const hasElse = !!(statement.else && statement.else.length > 0);
    if (!hasThen && !hasElse) return;
    const line = this.userLine(statement.line);
    const at = line >= 1 ? ` (source line ${line})` : '';

    const block = this.ensureBlock(`if: condition${at}`);
    const temp = this.genExpr(statement.cond, block.cmds, block.env);

    let thenEntry = null;
    let thenEnd = null;
    let elseEntry = null;
    let elseEnd = null;

    if (hasThen) {
      thenEntry = this.newBlock(`if: true branch${at}`);
      this.current = thenEntry;
      this.genTimelineStatements(statement.then);
      thenEnd = this.ensureBlock(`if: true branch end${at}`);
    }
    if (hasElse) {
      elseEntry = this.newBlock(`if: false branch${at}`);
      this.current = elseEntry;
      this.genTimelineStatements(statement.else);
      elseEnd = this.ensureBlock(`if: false branch end${at}`);
    }

    const join = this.newBlock(`if: join${at}`);
    if (thenEnd) thenEnd.term = { kind: 'next', target: join };
    if (elseEnd) elseEnd.term = { kind: 'next', target: join };

    block.term = {
      kind: 'cond',
      score: temp,
      trueBlock: thenEntry || join,
      falseBlock: elseEntry || join,
    };
    block.env.allocator.free(temp);
    this.current = join;
  }

  // ---------------------------------------------------------------- assembling

  idOf(block) {
    const id = this.stateIds.get(block);
    if (id === undefined) throw new TpError('internal: unbound timeline block', 1);
    return id;
  }

  renderTerm(term) {
    switch (term.kind) {
      case 'next': {
        const id = this.idOf(term.target);
        return [`# chain -> tp:main/s${id}`, `scoreboard players set #__pc tp ${id}`, `function tp:main/s${id}`];
      }
      case 'sleep': {
        const id = this.idOf(term.target);
        return [
          `# yield: sleep ${term.n} tick(s), then resume tp:main/s${id}`,
          `scoreboard players set #__sleep tp ${term.n}`,
          `scoreboard players set #__pc tp ${id}`,
        ];
      }
      case 'finish':
        return ['# done: the timeline has finished', 'scoreboard players set #__pc tp -1'];
      case 'loop': {
        const bodyId = this.idOf(term.body);
        const afterId = this.idOf(term.after);
        const range = `0..${term.count - 1}`;
        return [
          `# loop head: body tp:main/s${bodyId} while ${term.score} < ${term.count}, otherwise tp:main/s${afterId}`,
          '# arm the branch latch: whichever branch runs clears #__b, so the other',
          '# line below cannot run as well after the branch changed the index',
          'scoreboard players set #__b tp 1',
          `execute if score #__b tp matches 1 if score ${term.score} tp matches ${range} run function tp:main/s${bodyId}`,
          `execute if score #__b tp matches 1 unless score ${term.score} tp matches ${range} run function tp:main/s${afterId}`,
        ];
      }
      case 'cond': {
        const trueId = this.idOf(term.trueBlock);
        const falseId = this.idOf(term.falseBlock);
        return [
          `# if: true -> tp:main/s${trueId}, false -> tp:main/s${falseId}`,
          '# arm the branch latch: the taken branch clears #__b so only one runs',
          'scoreboard players set #__b tp 1',
          `execute if score #__b tp matches 1 if score ${term.score} tp matches 0 run function tp:main/s${falseId}`,
          `execute if score #__b tp matches 1 unless score ${term.score} tp matches 0 run function tp:main/s${trueId}`,
        ];
      }
      default:
        throw new TpError(`internal: unknown state terminator '${term.kind}'`, 1);
    }
  }

  renderState(block, id) {
    const title = block.comment ? ` — ${block.comment}` : '';
    const lines = [`# Tickpack main state s${id}${title}`, '# generated by Tickpack — do not edit'];
    // Exactly one state may run per tick. Dispatch sets the #__b latch to 1 and
    // every state clears it on entry, so once this state starts (and possibly
    // chains to other states in the same tick) the remaining dispatch lines stop
    // matching. Without this, a state that yields to `s<k>` would cause the
    // `#__pc matches <k>` line of the same dispatch to run `s<k>` too.
    lines.push('# claim the dispatch slot: exactly one state runs per tick');
    lines.push('scoreboard players set #__b tp 0');
    lines.push(...block.cmds);
    lines.push(...this.renderTerm(block.term));
    return lines;
  }

  renderLoad(blocks) {
    const lines = [
      '# Tickpack load — generated by Tickpack; do not edit',
      '# One-time init: scoreboard, user state and loop indices.',
      '# The pen is NOT spawned here: tp:tick waits for a player, then calls tp:start,',
      '# which anchors the pen on the ground under that player and rewinds the run.',
      'scoreboard objectives add tp dummy',
      'scoreboard players set #__tick tp 0',
      `scoreboard players set #__pc tp ${blocks.length > 0 ? 0 : -1}`,
      'scoreboard players set #__sleep tp 0',
      'scoreboard players set #__press tp 0',
      'scoreboard players set #__pressSeen tp 0',
      'scoreboard players set #__started tp 0',
    ];
    if (this.program.states.length > 0) {
      lines.push('# user state (each declared state lives on the tp scoreboard as #<name>)');
      for (const state of this.program.states) {
        lines.push(`scoreboard players set #${state.name} tp ${state.initial}`);
      }
    }
    if (this.loopNames.length > 0) {
      lines.push('# loop indices (#__i<k> is the k-th over loop in the program)');
      for (const loop of this.loopNames) {
        lines.push(`scoreboard players set ${loop.score} tp 0`);
      }
    }
    lines.push('# drop any pen left over from a previous session; tp:start spawns a fresh one');
    lines.push('kill @e[tag=pen]');
    return lines;
  }

  /**
   * tp:start — the "make it visible" entry point.
   *
   * In a real world y=0 is usually far below the player, and world load happens
   * before anyone is around, so the old absolute summon + load-time timeline was
   * invisible. The pen is anchored under the nearest player's feet instead, and
   * the whole scoreboard machine is rewound, so the program starts drawing on the
   * ground at the moment the player joins (or when they type /function tp:start).
   */
  renderStart(blocks) {
    const lines = [
      '# Tickpack start — generated by Tickpack; do not edit',
      '# Anchors the pen on the ground under the nearest player and rewinds the run.',
      '# Run it from chat at any time to redraw: /function tp:start',
      'kill @e[tag=pen]',
      'execute at @p run summon armor_stand ~ ~-1 ~ {Tags:["pen"],Invisible:1b,NoGravity:1b,Marker:1b}',
      '# reset the scoreboard state machine for a fresh run',
      'scoreboard players set #__tick tp 0',
      `scoreboard players set #__pc tp ${blocks.length > 0 ? 0 : -1}`,
      'scoreboard players set #__sleep tp 0',
      'scoreboard players set #__press tp 0',
      'scoreboard players set #__pressSeen tp 0',
      'scoreboard players set #__b tp 1',
    ];
    if (this.program.states.length > 0) {
      lines.push('# user state back to its declared initial value');
      for (const state of this.program.states) {
        lines.push(`scoreboard players set #${state.name} tp ${state.initial}`);
      }
    }
    if (this.loopNames.length > 0) {
      lines.push('# loop indices back to 0');
      for (const loop of this.loopNames) {
        lines.push(`scoreboard players set ${loop.score} tp 0`);
      }
    }
    lines.push('scoreboard players set #__started tp 1');
    lines.push(`say ${START_MESSAGE}`);
    return lines;
  }

  /** tp:status — a chat-based health check for real-world installs. */
  renderStatus() {
    return [
      '# Tickpack status — generated by Tickpack; do not edit',
      '# Debug helper: run /function tp:status to see what the generated runtime is doing.',
      'execute if score #__started tp matches 0 run say Tickpack: 等待玩家中（请到主世界，或手动 /function tp:start）',
      'execute if score #__started tp matches 1 run say Tickpack: 运行中（/function tp:start 可重画）',
      'execute if entity @e[tag=pen] run say Tickpack: 画笔已就位',
      'execute unless entity @e[tag=pen] run say Tickpack: 没有找到画笔（/function tp:start）',
    ];
  }

  renderTick() {
    return [
      '# Tickpack tick — generated by Tickpack; do not edit',
      '# Thin gate. The order is observable: the program only runs once a player is',
      '# present, and it starts on the very tick that player is detected.',
      '# 0) wait for a player, then anchor the pen at their feet and reset the run',
      'execute if score #__started tp matches 0 if entity @a run function tp:start',
      '# 1..5) the normal per-tick body, only while the program is running',
      'execute if score #__started tp matches 1 run function tp:tick/body',
    ];
  }

  /** The old tp:tick body, moved verbatim so the timeline runs as before. */
  renderTickBody(tickOut, pressOut) {
    const lines = [
      '# Tickpack tick/body — generated by Tickpack; do not edit',
      '# The program’s per-tick body; called from tp:tick only once the run has started.',
      '# Runs once per server tick. This order is observable behavior (docs/LANG.md §2.2).',
      '# 1) user tick blocks, in source order',
    ];
    lines.push(...tickOut);
    if (pressOut) {
      lines.push('# 2) press handler: run the event once per new host press');
      lines.push('scoreboard players operation #__a tp = #__press tp');
      lines.push('scoreboard players operation #__a tp -= #__pressSeen tp');
      lines.push('execute if score #__a tp matches 1.. run function tp:event/press');
      lines.push('scoreboard players operation #__pressSeen tp = #__press tp');
    } else {
      lines.push('# 2) press handler: no `when press` block declared');
    }
    lines.push('# 3) resume the timeline state machine, but only while it is awake');
    lines.push('execute if score #__sleep tp matches 0 run function tp:main/dispatch');
    lines.push('# 4) sleep countdown (a yield with sleep N resumes N ticks from now)');
    lines.push('execute if score #__sleep tp matches 1.. run scoreboard players remove #__sleep tp 1');
    lines.push('# 5) advance the clock: `now`');
    lines.push('scoreboard players add #__tick tp 1');
    return lines;
  }

  renderDispatch(blocks) {
    const lines = [
      '# Tickpack main dispatch — generated by Tickpack; do not edit',
      '# Resumes one state per tick: #__pc selects it, -1 means the timeline has finished.',
      '# #__b is a dispatch latch: a state clears it on entry, so a state that chains',
      '# (or yields) cannot make a later line of this function run a second state.',
      'scoreboard players set #__b tp 1',
    ];
    if (blocks.length === 0) {
      lines.push('# (this program has no timeline statements, so there is nothing to dispatch)');
    }
    blocks.forEach((_block, id) => {
      lines.push(
        `execute if score #__b tp matches 1 if score #__pc tp matches ${id} run function tp:main/s${id}`,
      );
    });
    return lines;
  }

  renderFn(file) {
    const source = file.isPrelude ? ' — standard library' : this.userLine(file.line) >= 1 ? ` — source line ${this.userLine(file.line)}` : '';
    const lines = [`# Tickpack fn ${file.name}()${source}`, '# generated by Tickpack — do not edit'];
    lines.push(...file.out);
    return lines;
  }

  renderSnippet(snippet) {
    const userLine = this.userLine(snippet.line);
    const source = userLine >= 1 ? ` — source line ${userLine}` : '';
    const lines = [
      `# Tickpack snippet ${snippet.id} — instant ${snippet.branch} branch of an if${source}`,
      '# generated by Tickpack — do not edit',
    ];
    lines.push(...snippet.out);
    return lines;
  }

  renderPress(pressOut) {
    const lines = [
      '# Tickpack event/press — generated by Tickpack; do not edit',
      '# Runs once for every new host press; called from tp:tick when #__press changes.',
    ];
    lines.push(...pressOut);
    return lines;
  }

  renderLines(lines) {
    return `${lines.join('\n')}\n`;
  }

  assemble(tickOut, pressOut, fnFiles, blocks) {
    const files = {};
    files['pack.mcmeta'] = `${JSON.stringify(
      {
        pack: {
          pack_format: 48,
          supported_formats: { min_inclusive: 48, max_inclusive: 9999 },
          description: PACK_DESCRIPTION,
        },
      },
      null,
      2,
    )}\n`;
    files['data/minecraft/tags/function/load.json'] = '{"values":["tp:load"]}';
    files['data/minecraft/tags/function/tick.json'] = '{"values":["tp:tick"]}';
    files['data/tp/function/load.mcfunction'] = this.renderLines(this.renderLoad(blocks));
    files['data/tp/function/start.mcfunction'] = this.renderLines(this.renderStart(blocks));
    files['data/tp/function/status.mcfunction'] = this.renderLines(this.renderStatus());
    files['data/tp/function/tick.mcfunction'] = this.renderLines(this.renderTick());
    files['data/tp/function/tick/body.mcfunction'] = this.renderLines(this.renderTickBody(tickOut, pressOut));
    files['data/tp/function/main/dispatch.mcfunction'] = this.renderLines(this.renderDispatch(blocks));
    blocks.forEach((block, id) => {
      files[`data/tp/function/main/s${id}.mcfunction`] = this.renderLines(this.renderState(block, id));
    });
    for (const fnFile of fnFiles) {
      files[`data/tp/function/fn/${fnFile.name}.mcfunction`] = this.renderLines(this.renderFn(fnFile));
    }
    const snippets = this.snippets.slice().sort((a, b) => a.id - b.id);
    for (const snippet of snippets) {
      files[`data/tp/function/snippet/${snippet.id}.mcfunction`] = this.renderLines(this.renderSnippet(snippet));
    }
    if (pressOut !== null) {
      files['data/tp/function/event/press.mcfunction'] = this.renderLines(this.renderPress(pressOut));
    }
    return files;
  }
}

export function generate(program, semantics, preludeOffset) {
  return new CodeGen(program, semantics, preludeOffset).run();
}

export default generate;
