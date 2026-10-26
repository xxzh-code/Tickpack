// Tickpack parser.
//
// Produces a small plain-object AST. `parse()` is given the tokens of the
// concatenated prelude + user source; all line numbers are 1-based in that
// concatenated text (compile() subtracts the prelude length for diagnostics).
//
// Grammar (docs/LANG.md §1) is line-oriented with braces for blocks; newlines
// are statement separators but are otherwise insignificant, so braces may be
// placed on the same line as their statement and `}` / `else` are tolerated on
// either side of a newline.
import { TpError } from './errors.js';

export function parse(tokens) {
  return new Parser(tokens).parseProgram();
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  // ------------------------------------------------------------------ helpers

  peek(offset = 0) {
    const index = Math.min(this.pos + offset, this.tokens.length - 1);
    return this.tokens[index];
  }

  next() {
    const token = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  at(type, value) {
    const token = this.peek();
    if (token.type !== type) return false;
    return value === undefined || token.value === value;
  }

  eat(type, value) {
    if (this.at(type, value)) return this.next();
    return null;
  }

  expect(type, value, message) {
    if (this.at(type, value)) return this.next();
    throw new TpError(message || `expected ${value === undefined ? type : `'${value}'`}`, this.peek().line);
  }

  fail(message, token = this.peek()) {
    throw new TpError(message, token.line);
  }

  skipNewlines() {
    while (this.at('newline')) this.next();
  }

  describe(token) {
    if (token.type === 'eof') return 'end of file';
    if (token.type === 'newline') return 'end of line';
    if (token.type === 'string') return `string "${token.value}"`;
    if (token.type === 'raw') return 'raw command text';
    if (token.raw !== undefined && (token.type === 'int' || token.type === 'op')) {
      return `'${token.raw}'`;
    }
    return `'${token.value}'`;
  }

  /** A statement must be followed by a newline, a closing brace, or EOF. */
  endStatement() {
    const token = this.peek();
    if (token.type === 'newline') {
      this.next();
      return;
    }
    if (token.type === 'eof') return;
    if (token.type === 'punct' && token.value === '}') return;
    this.fail(`unexpected ${this.describe(token)} after statement`);
  }

  // ----------------------------------------------------------------- program

  parseProgram() {
    const program = { states: [], fns: [], ticks: [], whens: [], timeline: [] };
    this.skipNewlines();
    while (!this.at('eof')) {
      const token = this.peek();
      const keyword = token.type === 'ident' ? token.value : null;
      if (keyword === 'state') {
        this.parseState(program);
      } else if (keyword === 'fn') {
        this.parseFn(program);
      } else if (keyword === 'tick') {
        this.next();
        program.ticks.push({ body: this.parseBlock('tick block'), line: token.line });
      } else if (keyword === 'when') {
        this.next();
        this.expect('ident', 'press', "expected 'press' after 'when' (only `when press` exists in v0.1)");
        program.whens.push({ body: this.parseBlock('when block'), line: token.line });
      } else {
        program.timeline.push(this.parseStatement());
      }
      this.endStatement();
      this.skipNewlines();
    }
    return program;
  }

  parseState(program) {
    const line = this.next().line; // 'state'
    const name = this.expect('ident', undefined, "expected a name after 'state'");
    this.expect('op', '=', "expected '=' after state name");
    let sign = 1;
    if (this.eat('op', '-')) sign = -1;
    const value = this.expect('int', undefined, 'state initial value must be an integer literal');
    program.states.push({ name: name.value, initial: sign * value.value, line });
  }

  parseFn(program) {
    const line = this.next().line; // 'fn'
    const name = this.expect('ident', undefined, "expected a function name after 'fn'");
    this.expect('punct', '(', "expected '(' after function name");
    const params = [];
    if (!this.at('punct', ')')) {
      do {
        const param = this.expect('ident', undefined, 'expected a parameter name');
        params.push({ name: param.value, line: param.line });
      } while (this.eat('punct', ','));
    }
    this.expect('punct', ')', "expected ')' after function parameters");
    const body = this.parseBlock('function body');
    program.fns.push({ name: name.value, params, body, line });
  }

  /** `{ statement* }` */
  parseBlock(what) {
    this.expect('punct', '{', `expected '{' to start the ${what}`);
    const statements = [];
    this.skipNewlines();
    while (!this.at('punct', '}')) {
      if (this.at('eof')) this.fail(`unclosed ${what}: expected '}'`);
      statements.push(this.parseStatement());
      this.endStatement();
      this.skipNewlines();
    }
    this.next(); // '}'
    return statements;
  }

  // -------------------------------------------------------------- statements

  parseStatement() {
    const token = this.peek();

    if (token.type === 'ident') {
      switch (token.value) {
        case 'if':
          return this.parseIf();
        case 'over':
          return this.parseOver();
        case 'state':
        case 'fn':
        case 'tick':
        case 'when':
          this.fail(`a '${token.value}' declaration is only allowed at the top level`, token);
          break;
        case 'wait': {
          this.next();
          const value = this.expect('int', undefined, "expected a tick count after 'wait'");
          return { kind: 'wait', count: value.value, line: token.line };
        }
        case 'say': {
          this.next();
          const text = this.expect('string', undefined, "expected a string literal after 'say'");
          return { kind: 'say', text: text.value, line: token.line };
        }
        case 'run': {
          this.next();
          const raw = this.expect('raw', undefined, "expected a command after 'run'");
          if (raw.value === '') this.fail("'run' needs a vanilla command after it", token);
          return { kind: 'run', text: raw.value, line: token.line };
        }
        default:
          break;
      }

      const after = this.peek(1);
      if (after.type === 'op' && after.value === '=') {
        this.next(); // name
        this.next(); // '='
        const expr = this.parseExpr();
        return { kind: 'assign', target: token.value, expr, line: token.line };
      }
      if (after.type === 'punct' && after.value === '(') {
        return this.parseCall();
      }
      // `walk`, `stamp`, `home`: a zero-argument function call without parens
      // (the stdlib is used this way throughout docs/ and the samples).
      if (after.type === 'newline' || after.type === 'eof' || (after.type === 'punct' && after.value === '}')) {
        this.next();
        return { kind: 'call', name: token.value, args: [], bare: true, line: token.line };
      }
      this.fail(`expected a statement, found ${this.describe(token)} followed by ${this.describe(after)}`);
    }

    this.fail(`expected a statement, found ${this.describe(token)}`);
  }

  parseCall() {
    const name = this.expect('ident');
    this.expect('punct', '(');
    const args = [];
    if (!this.at('punct', ')')) {
      for (;;) {
        args.push(this.parseArg());
        if (this.eat('punct', ',')) continue;
        if (this.at('punct', ')')) break;
        this.fail(
          'macro arguments must be an integer literal, a bare identifier, or a macro parameter',
          this.peek(),
        );
      }
    }
    this.expect('punct', ')', "expected ')' after macro arguments");
    return { kind: 'call', name: name.value, args, bare: false, line: name.line };
  }

  /** Macro arguments are compile-time constants: integer literal, bare id, or `$param`. */
  parseArg() {
    const token = this.peek();
    if (token.type === 'param') {
      this.next();
      return { kind: 'param', name: token.value, raw: `$${token.value}`, line: token.line };
    }
    let sign = 1;
    if (this.eat('op', '-')) sign = -1;
    if (this.at('int')) {
      const value = this.next();
      return {
        kind: 'int',
        value: sign * value.value,
        raw: `${sign < 0 ? '-' : ''}${value.raw}`,
        line: token.line,
      };
    }
    if (sign < 0) this.fail("expected an integer literal after '-' in a macro argument", token);
    if (token.type === 'ident') {
      this.next();
      return { kind: 'ident', name: token.value, raw: token.value, line: token.line };
    }
    this.fail('macro arguments must be an integer literal, a bare identifier, or a macro parameter', token);
  }

  parseIf() {
    const line = this.next().line; // 'if'
    const cond = this.parseExpr();
    const thenBody = this.parseBlock('if branch');
    // `else` may be on the next line; only commit to consuming newlines if it
    // really is an else (otherwise endStatement still wants to see them).
    let elseBody = null;
    const save = this.pos;
    this.skipNewlines();
    if (this.at('ident', 'else')) {
      this.next();
      elseBody = this.parseBlock('else branch');
    } else {
      this.pos = save;
    }
    return { kind: 'if', cond, then: thenBody, else: elseBody, line };
  }

  parseOver() {
    const line = this.next().line; // 'over'
    const count = this.expect('int', undefined, "expected an iteration count after 'over' (integer literal)");
    this.expect('ident', 'as', "expected 'as' after the over count");
    const name = this.expect('ident', undefined, "expected a loop index name after 'as'");
    const body = this.parseBlock('over body');
    return { kind: 'over', count: count.value, varName: name.value, varLine: name.line, body, line };
  }

  // ------------------------------------------------------------- expressions

  parseExpr() {
    return this.parseOr();
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.at('ident', 'or')) {
      this.next();
      left = { kind: 'bin', op: 'or', left, right: this.parseAnd(), line: left.line };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseCmp();
    while (this.at('ident', 'and')) {
      this.next();
      left = { kind: 'bin', op: 'and', left, right: this.parseCmp(), line: left.line };
    }
    return left;
  }

  parseCmp() {
    let left = this.parseAdd();
    while (this.at('op') && ['==', '!=', '<', '<=', '>', '>='].includes(this.peek().value)) {
      const op = this.next().value;
      left = { kind: 'bin', op, left, right: this.parseAdd(), line: left.line };
    }
    return left;
  }

  parseAdd() {
    let left = this.parseMul();
    while (this.at('op') && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.next().value;
      left = { kind: 'bin', op, left, right: this.parseMul(), line: left.line };
    }
    return left;
  }

  parseMul() {
    let left = this.parseUnary();
    while (this.at('op') && ['*', '/', '%'].includes(this.peek().value)) {
      const op = this.next().value;
      left = { kind: 'bin', op, left, right: this.parseUnary(), line: left.line };
    }
    return left;
  }

  parseUnary() {
    const token = this.peek();
    if (token.type === 'op' && token.value === '-') {
      this.next();
      return { kind: 'un', op: '-', operand: this.parseUnary(), line: token.line };
    }
    if (token.type === 'ident' && token.value === 'not') {
      this.next();
      return { kind: 'un', op: 'not', operand: this.parseUnary(), line: token.line };
    }
    return this.parseAtom();
  }

  parseAtom() {
    const token = this.peek();
    if (token.type === 'int') {
      this.next();
      return { kind: 'int', value: token.value, line: token.line };
    }
    if (token.type === 'param') {
      this.next();
      return { kind: 'param', name: token.value, line: token.line };
    }
    if (token.type === 'ident') {
      this.next();
      if (token.value === 'now') return { kind: 'now', line: token.line };
      return { kind: 'var', name: token.value, line: token.line };
    }
    if (token.type === 'punct' && token.value === '(') {
      this.next();
      const expr = this.parseExpr();
      this.expect('punct', ')', "expected ')' to close the expression");
      return expr;
    }
    if (token.type === 'punct' && token.value === '{') {
      this.fail('expected an expression, found a block (function calls are statements in v0.1)');
    }
    this.fail(`expected an expression, found ${this.describe(token)}`);
  }
}

export default parse;
