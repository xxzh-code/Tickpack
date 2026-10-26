// Tickpack lexer.
//
// Line-oriented language: `#` starts a comment outside strings, statements end
// at a newline, and everything after a `run` keyword is a raw vanilla command
// that is passed through verbatim (docs/LANG.md §1.5). The lexer therefore
// switches to "raw mode" as soon as it sees the identifier `run`: it swallows
// the rest of the physical line (minus a trailing `#` comment) into one RAW
// token. That way arbitrary command syntax (@e[tag=pen], ^ ^ ^1, {Tags:[...]})
// never has to be understood by the Tickpack grammar.
//
// Output tokens: { type, value, line }
//   int      integer literal          value = Number, raw = source digits
//   ident    identifier / keyword     value = name
//   string   "..." literal            value = decoded text
//   param    $name                    value = name
//   op       = == != <= >= < > + - * / %
//   punct    { } ( ) ,
//   raw      rest of a `run` line     value = command text
//   newline  end of a physical line
//   eof
import { TpError } from './errors.js';

const TWO_CHAR_OPS = new Set(['==', '!=', '<=', '>=']);
const PUNCT = new Set(['{', '}', '(', ')', ',']);
const ONE_CHAR_OPS = new Set(['=', '<', '>', '+', '-', '*', '/', '%']);

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function isIdentStart(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentPart(ch) {
  return isIdentStart(ch) || isDigit(ch);
}

export function tokenize(source) {
  const text = String(source);
  const tokens = [];
  const n = text.length;
  let i = 0;
  let line = 1;

  const push = (type, value, extra) => {
    const token = { type, value, line };
    if (extra) Object.assign(token, extra);
    tokens.push(token);
  };

  while (i < n) {
    const ch = text[i];

    if (ch === '\n') {
      push('newline', null);
      line += 1;
      i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '"') {
      const startLine = line;
      let value = '';
      let closed = false;
      i += 1;
      while (i < n) {
        const d = text[i];
        if (d === '\n') break;
        if (d === '\\') {
          const next = text[i + 1];
          if (next === '"' || next === '\\') {
            value += next;
            i += 2;
            continue;
          }
          value += d;
          i += 1;
          continue;
        }
        if (d === '"') {
          i += 1;
          closed = true;
          break;
        }
        value += d;
        i += 1;
      }
      if (!closed) throw new TpError('unterminated string literal', startLine);
      push('string', value);
      continue;
    }

    if (isDigit(ch)) {
      const start = i;
      while (i < n && isDigit(text[i])) i += 1;
      const raw = text.slice(start, i);
      push('int', Number(raw), { raw });
      continue;
    }

    if (isIdentStart(ch)) {
      const start = i;
      while (i < n && isIdentPart(text[i])) i += 1;
      const value = text.slice(start, i);
      push('ident', value);
      if (value === 'run') {
        // Raw command: everything up to the end of the physical line, with a
        // trailing `# comment` removed (LANG.md §1.5).
        const restStart = i;
        while (i < n && text[i] !== '\n') i += 1;
        let rest = text.slice(restStart, i);
        const hash = rest.indexOf('#');
        if (hash >= 0) rest = rest.slice(0, hash);
        push('raw', rest.trim());
      }
      continue;
    }

    if (ch === '$') {
      i += 1;
      if (i >= n || !isIdentStart(text[i])) {
        throw new TpError("expected a macro parameter name after '$'", line);
      }
      const start = i;
      while (i < n && isIdentPart(text[i])) i += 1;
      push('param', text.slice(start, i));
      continue;
    }

    const two = text.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      push('op', two);
      i += 2;
      continue;
    }
    if (PUNCT.has(ch)) {
      push('punct', ch);
      i += 1;
      continue;
    }
    if (ONE_CHAR_OPS.has(ch)) {
      push('op', ch);
      i += 1;
      continue;
    }

    throw new TpError(`unexpected character '${ch}'`, line);
  }

  tokens.push({ type: 'eof', value: null, line });
  return tokens;
}

export default tokenize;
