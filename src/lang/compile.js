// Tickpack compiler — public entry point.
//
//   import { compile } from './lang/compile.js';
//   const { ok, files, diagnostics, meta } = compile(source);
//
// Pipeline: tokenize(prelude + user source) -> parse -> semantic analysis ->
// code generation -> pack assembly (see docs/LANG.md §2/§3). compile() never
// throws: every problem becomes a diagnostic whose `line` is a user-source line
// (the prepended prelude offset is already subtracted).
import { PRELUDE } from './prelude.js';
import { tokenize } from './tokenize.js';
import { parse } from './parser.js';
import { TpError } from './errors.js';
import { generate, BRUSH_PALETTE } from './codegen.js';

/** Number of physical lines in the prelude; user line 1 is this + 1. */
export const PRELUDE_LINES = (PRELUDE.match(/\n/g) || []).length;

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/** The runtime brush palette (defined with the code generator; see codegen.js). */
const BRUSH_SET = new Set(BRUSH_PALETTE);
const BRUSH_LIST = BRUSH_PALETTE.join(', ');

const RESERVED = new Set([
  'state',
  'fn',
  'tick',
  'when',
  'over',
  'wait',
  'if',
  'else',
  'say',
  'run',
  'as',
  'and',
  'or',
  'not',
  'now',
  'press',
  'brush',
  'paint',
  'ahead',
  'below',
]);

const EMPTY_PARAMS = new Set();

function isReservedWord(name) {
  return RESERVED.has(name);
}

// ---------------------------------------------------------------------------
// Semantic analysis
// ---------------------------------------------------------------------------

class Semantics {
  constructor(program, preludeOffset) {
    this.program = program;
    this.off = preludeOffset;
    this.diagnostics = [];
    this.seen = new Set();

    /** @type {Map<string, {name:string, initial:number, line:number}>} */
    this.states = new Map();
    /** @type {Map<string, {name:string, params:Array<{name:string,line:number,usedInExpr:boolean}>, body:any[], line:number, isPrelude:boolean}>} */
    this.fns = new Map();
    /** call graph edges inside fn bodies, for macro recursion + param-kind flow */
    this.edges = [];
  }

  userLine(fullLine) {
    return fullLine - this.off;
  }

  report(fullLine, message) {
    const key = `${fullLine}\u0000${message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const userLine = this.userLine(fullLine);
    if (userLine >= 1) {
      this.diagnostics.push({ severity: 'error', line: userLine, message });
    } else {
      // A bug in the prelude itself: still report it, pointing at line 1.
      this.diagnostics.push({
        severity: 'error',
        line: 1,
        message: `[prelude line ${fullLine}] ${message}`,
      });
    }
  }

  run() {
    this.declare();
    this.scanParamUses();
    this.collectEdges();
    this.propagateParamKinds();
    this.validateAll();
    this.checkCycles();
  }

  // ------------------------------------------------------------ declarations

  declare() {
    for (const state of this.program.states) {
      this.validateName(state.name, state.line, 'a state');
      if (this.states.has(state.name)) {
        this.report(state.line, `duplicate state '${state.name}' (first declared on line ${this.userLine(this.states.get(state.name).line)})`);
        continue;
      }
      this.checkIntRange(state.initial, state.line);
      this.states.set(state.name, state);
    }

    for (const fn of this.program.fns) {
      const isPrelude = fn.line <= this.off;
      this.validateName(fn.name, fn.line, 'a function');
      if (this.fns.has(fn.name)) {
        const previous = this.fns.get(fn.name);
        if (isPrelude) {
          this.report(fn.line, `duplicate standard-library function '${fn.name}' in the prelude`);
        } else if (previous.isPrelude) {
          this.report(fn.line, `cannot redefine standard-library function '${fn.name}' (docs/LANG.md §4)`);
        } else {
          this.report(fn.line, `duplicate function '${fn.name}' (first declared on line ${this.userLine(previous.line)})`);
        }
        continue;
      }
      const seenParams = new Set();
      const params = [];
      for (const param of fn.params) {
        this.validateName(param.name, param.line, 'a parameter');
        if (seenParams.has(param.name)) {
          this.report(param.line, `duplicate parameter '${param.name}' in fn '${fn.name}'`);
          continue;
        }
        seenParams.add(param.name);
        params.push({ name: param.name, line: param.line, usedInExpr: false });
      }
      this.fns.set(fn.name, {
        name: fn.name,
        params,
        body: fn.body,
        line: fn.line,
        isPrelude,
      });
    }
  }

  validateName(name, line, what) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      this.report(line, `invalid name '${name}' (use [A-Za-z_][A-Za-z0-9_]*)`);
      return;
    }
    if (name.startsWith('__')) {
      this.report(line, `name '${name}' starts with '__', which is reserved for the compiler`);
      return;
    }
    if (isReservedWord(name)) {
      this.report(line, `'${name}' is a reserved word and cannot be used as ${what}`);
    }
  }

  checkIntRange(value, line) {
    if (!Number.isInteger(value) || value < INT32_MIN || value > INT32_MAX) {
      this.report(line, `integer literal ${value} does not fit in a 32-bit scoreboard value`);
    }
  }

  // ------------------------------------------------------ macro param usage

  /** Mark params that appear in expression position (they need integer args). */
  scanParamUses() {
    for (const fn of this.fns.values()) {
      if (fn.params.length === 0) continue;
      const byName = new Map(fn.params.map((p) => [p.name, p]));
      forEachExprInStatements(fn.body, (expr) => {
        walkExpr(expr, (node) => {
          if (node.kind === 'param') {
            const param = byName.get(node.name);
            if (param) param.usedInExpr = true;
          }
        });
      });
    }
  }

  collectEdges() {
    for (const fn of this.fns.values()) {
      forEachCallInStatements(fn.body, (call) => {
        this.edges.push({ from: fn.name, to: call.name, args: call.args, line: call.line });
      });
    }
  }

  /** If fn A(p) calls fn B(q) and B uses q in an expression, then p needs an int too. */
  propagateParamKinds() {
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of this.edges) {
        const from = this.fns.get(edge.from);
        const to = this.fns.get(edge.to);
        if (!from || !to) continue;
        for (let i = 0; i < edge.args.length; i += 1) {
          const arg = edge.args[i];
          const calleeParam = to.params[i];
          if (!calleeParam || !calleeParam.usedInExpr) continue;
          if (!arg || arg.kind !== 'param') continue;
          const callerParam = from.params.find((p) => p.name === arg.name);
          if (callerParam && !callerParam.usedInExpr) {
            callerParam.usedInExpr = true;
            changed = true;
          }
        }
      }
    }
  }

  // --------------------------------------------------------------- validation

  validateAll() {
    for (const fn of this.fns.values()) {
      const ctx = {
        mode: 'instant',
        loopVars: [],
        params: new Set(fn.params.map((p) => p.name)),
        fn,
      };
      this.validateStatements(fn.body, ctx);
    }
    for (const block of this.program.ticks) {
      this.validateStatements(block.body, { mode: 'instant', loopVars: [], params: EMPTY_PARAMS, fn: null });
    }
    for (const block of this.program.whens) {
      this.validateStatements(block.body, { mode: 'instant', loopVars: [], params: EMPTY_PARAMS, fn: null });
    }
    this.validateStatements(this.program.timeline, {
      mode: 'timeline',
      loopVars: [],
      params: EMPTY_PARAMS,
      fn: null,
    });
  }

  validateStatements(statements, ctx) {
    for (const statement of statements) this.validateStatement(statement, ctx);
  }

  validateStatement(statement, ctx) {
    switch (statement.kind) {
      case 'assign': {
        const name = statement.target;
        if (ctx.loopVars.some((loopVar) => loopVar.name === name)) {
          this.report(statement.line, `cannot assign to loop variable '${name}' (loop indices are read-only)`);
        } else if (name === 'now') {
          this.report(statement.line, "cannot assign to 'now' (it is the tick counter)");
        } else if (!this.states.has(name)) {
          this.report(statement.line, `unknown variable '${name}' (declare it with 'state ${name} = 0')`);
        }
        this.validateExpr(statement.expr, ctx);
        return;
      }
      case 'say':
        return;
      case 'run':
        this.validateRunLine(statement.text, statement.line, ctx);
        return;
      case 'brush': {
        if (!BRUSH_SET.has(statement.block)) {
          this.report(statement.line, `unknown brush block '${statement.block}'; palette: ${BRUSH_LIST}`);
        }
        return;
      }
      case 'paint':
        return;
      case 'call':
        this.validateCall(statement, ctx);
        return;
      case 'if': {
        this.validateExpr(statement.cond, ctx);
        this.validateStatements(statement.then, ctx);
        if (statement.else) this.validateStatements(statement.else, ctx);
        return;
      }
      case 'over': {
        if (ctx.mode === 'instant') {
          this.report(statement.line, 'over spans time; move it to the timeline (fn/tick/when bodies are instant)');
        }
        this.validateName(statement.varName, statement.varLine, 'a loop index');
        this.checkIntRange(statement.count, statement.line);
        if (statement.count < 0) this.report(statement.line, 'over count must be >= 0');
        const child = {
          ...ctx,
          loopVars: ctx.loopVars.concat([{ name: statement.varName }]),
        };
        this.validateStatements(statement.body, child);
        return;
      }
      case 'wait': {
        if (ctx.mode === 'instant') {
          this.report(statement.line, 'wait spans time; move it to the timeline (fn/tick/when bodies are instant)');
        }
        this.checkIntRange(statement.count, statement.line);
        if (statement.count < 0) this.report(statement.line, 'wait count must be >= 0');
        return;
      }
      default:
        this.report(statement.line, `internal: unknown statement kind '${statement.kind}'`);
    }
  }

  validateRunLine(text, line, ctx) {
    const pattern = /\$([A-Za-z_][A-Za-z0-9_]*)/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1];
      if (!ctx.params.has(name)) this.report(line, `unknown macro parameter '$${name}'`);
    }
  }

  validateCall(statement, ctx) {
    const fn = this.fns.get(statement.name);
    if (!fn) {
      this.report(statement.line, `unknown function '${statement.name}'`);
      return;
    }
    if (fn.params.length !== statement.args.length) {
      if (statement.bare) {
        this.report(
          statement.line,
          `fn '${statement.name}' needs ${fn.params.length} argument(s); write ${statement.name}(...)`,
        );
      } else {
        this.report(
          statement.line,
          `fn '${statement.name}' expects ${fn.params.length} argument(s), got ${statement.args.length}`,
        );
      }
    }
    for (let i = 0; i < statement.args.length; i += 1) {
      const arg = statement.args[i];
      if (arg.kind === 'param') {
        if (!ctx.params.has(arg.name)) {
          this.report(arg.line, `unknown macro parameter '$${arg.name}'`);
        }
      } else if (arg.kind === 'int') {
        this.checkIntRange(arg.value, arg.line);
      } else if (arg.kind === 'number') {
        // Decimal macro text (e.g. a sound pitch). Only valid as macro text:
        // a parameter used in an expression still requires an integer.
      }
      const param = fn.params[i];
      if (param && param.usedInExpr && (arg.kind === 'ident' || arg.kind === 'number')) {
        this.report(
          arg.line,
          `parameter '${param.name}' of fn '${fn.name}' is used in an expression, so it needs an integer argument (got '${arg.raw}')`,
        );
      }
    }
  }

  validateExpr(expr, ctx) {
    switch (expr.kind) {
      case 'int':
        this.checkIntRange(expr.value, expr.line);
        return;
      case 'now':
        return;
      case 'sense':
        return;
      case 'var': {
        const name = expr.name;
        if (ctx.loopVars.some((loopVar) => loopVar.name === name)) return;
        if (this.states.has(name)) return;
        this.report(expr.line, `unknown variable '${name}'`);
        return;
      }
      case 'param': {
        if (!ctx.params.has(expr.name)) {
          this.report(expr.line, `unknown macro parameter '$${expr.name}'`);
        }
        return;
      }
      case 'un':
        this.validateExpr(expr.operand, ctx);
        return;
      case 'bin':
        this.validateExpr(expr.left, ctx);
        this.validateExpr(expr.right, ctx);
        return;
      default:
        this.report(expr.line, `internal: unknown expression kind '${expr.kind}'`);
    }
  }

  // ------------------------------------------------------------- call cycles

  checkCycles() {
    const byFrom = new Map();
    for (const edge of this.edges) {
      if (!byFrom.has(edge.from)) byFrom.set(edge.from, []);
      byFrom.get(edge.from).push(edge);
    }
    const color = new Map();
    let reported = false;
    const visit = (name, stack) => {
      if (reported) return;
      color.set(name, 1);
      stack.push(name);
      for (const edge of byFrom.get(name) || []) {
        if (!this.fns.has(edge.to)) continue;
        const state = color.get(edge.to) || 0;
        if (state === 1) {
          const start = stack.indexOf(edge.to);
          const cycle = stack.slice(start).concat([edge.to]).join(' -> ');
          this.report(edge.line, `function call cycle: ${cycle} (macros must expand a finite amount)`);
          reported = true;
          return;
        }
        if (state === 0) visit(edge.to, stack);
        if (reported) return;
      }
      stack.pop();
      color.set(name, 2);
    };
    for (const name of this.fns.keys()) {
      if ((color.get(name) || 0) === 0) visit(name, []);
      if (reported) break;
    }
  }
}

// ---------------------------------------------------------------------------
// AST walk helpers used by the analysis
// ---------------------------------------------------------------------------

function walkExpr(expr, visit) {
  visit(expr);
  if (expr.kind === 'un') walkExpr(expr.operand, visit);
  else if (expr.kind === 'bin') {
    walkExpr(expr.left, visit);
    walkExpr(expr.right, visit);
  }
}

function forEachExprInStatements(statements, visit) {
  for (const statement of statements) {
    switch (statement.kind) {
      case 'assign':
        visit(statement.expr);
        break;
      case 'if':
        visit(statement.cond);
        forEachExprInStatements(statement.then, visit);
        if (statement.else) forEachExprInStatements(statement.else, visit);
        break;
      case 'over':
        forEachExprInStatements(statement.body, visit);
        break;
      default:
        break;
    }
  }
}

function forEachCallInStatements(statements, visit) {
  for (const statement of statements) {
    if (statement.kind === 'call') visit(statement);
    if (statement.kind === 'if') {
      forEachCallInStatements(statement.then, visit);
      if (statement.else) forEachCallInStatements(statement.else, visit);
    }
    if (statement.kind === 'over') forEachCallInStatements(statement.body, visit);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function emptyMeta(preludeLines, program) {
  return {
    preludeLines,
    variables: program
      ? program.states.map((state) => ({ name: state.name, initial: state.initial }))
      : [],
    stateCount: 0,
    functionCount: 0,
    hasTickBlocks: program ? program.ticks.length > 0 : false,
  };
}

function diagnosticFromError(error, preludeLines) {
  if (error instanceof TpError) {
    const line = error.line - preludeLines;
    if (line >= 1) return { severity: 'error', line, message: error.message };
    return {
      severity: 'error',
      line: 1,
      message: `[prelude line ${error.line}] ${error.message}`,
    };
  }
  return {
    severity: 'error',
    line: 0,
    message: `internal compiler error: ${error && error.message ? error.message : String(error)}`,
  };
}

/**
 * Compile Tickpack source into a Minecraft datapack (as a virtual file map).
 *
 * @param {string} source user program source (the prelude is implicit)
 * @returns {{ok:boolean, files:{[path:string]:string}, diagnostics:Array<{severity:string,line:number,message:string}>, meta:{preludeLines:number, variables:Array<{name:string,initial:number}>, stateCount:number, functionCount:number, hasTickBlocks:boolean}}}
 */
export function compile(source) {
  // Strip a UTF-8 BOM: it is common when a source file is pasted from Windows.
  const userSource = (source === undefined || source === null ? '' : String(source)).replace(/^\uFEFF/, '');
  const preludeLines = PRELUDE_LINES;
  const text = PRELUDE + userSource;

  let program = null;
  try {
    program = parse(tokenize(text));
  } catch (error) {
    return {
      ok: false,
      files: {},
      diagnostics: [diagnosticFromError(error, preludeLines)],
      meta: emptyMeta(preludeLines, program),
    };
  }

  const semantics = new Semantics(program, preludeLines);
  try {
    semantics.run();
  } catch (error) {
    return {
      ok: false,
      files: {},
      diagnostics: [diagnosticFromError(error, preludeLines)],
      meta: emptyMeta(preludeLines, program),
    };
  }

  if (semantics.diagnostics.length > 0) {
    return {
      ok: false,
      files: {},
      diagnostics: semantics.diagnostics,
      meta: emptyMeta(preludeLines, program),
    };
  }

  try {
    const result = generate(program, semantics, preludeLines);
    return {
      ok: true,
      files: result.files,
      diagnostics: semantics.diagnostics,
      meta: result.meta,
    };
  } catch (error) {
    return {
      ok: false,
      files: {},
      diagnostics: [diagnosticFromError(error, preludeLines)],
      meta: emptyMeta(preludeLines, program),
    };
  }
}

export default compile;
