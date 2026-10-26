// Tickpack mini-simulator — parsing helpers for the generated mcfunction subset.
//
// Pure ESM, no Node/DOM APIs, so this module also loads in the browser.
// Everything here is *syntax only*: tokenizing one command, parsing coordinate
// forms, selectors, ranges, block ids and the command itself. Execution lives in
// sim.js. Keeping parsing separate means the simulator can cache parsed commands
// per function line (parsing is context-free) and execute them 10k+ times cheaply.

export const INT32_MIN = -2147483648;
export const INT32_MAX = 2147483647;

/** Exact signed-32-bit wraparound for values that are already integers. */
export function wrap32(n) {
  return n | 0;
}

/** Exact signed-32-bit multiplication (avoids float precision loss). */
export function mul32(a, b) {
  return Math.imul(a | 0, b | 0);
}

// ---------------------------------------------------------------------------
// Tokenizing
// ---------------------------------------------------------------------------

/**
 * Split a command line into arguments. Whitespace at the top level separates
 * tokens; quoted runs and balanced `{...}` / `[...]` / `(...)` groups stay
 * inside a single token (so `{Tags:["a", "b"]}` and `@e[tag=pen,limit=1]` are
 * each one token). Backslashes escape inside quotes.
 */
export function tokenize(text) {
  const tokens = [];
  let cur = '';
  let depth = 0;
  let quote = '';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quote) {
      cur += ch;
      if (ch === '\\' && i + 1 < text.length) {
        cur += text[++i];
        continue;
      }
      if (ch === quote) quote = '';
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }

    if (ch === '{' || ch === '[' || ch === '(') {
      depth += 1;
      cur += ch;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      if (depth > 0) depth -= 1;
      cur += ch;
      continue;
    }

    if (depth === 0 && /\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
      continue;
    }

    cur += ch;
  }

  if (cur) tokens.push(cur);
  return tokens;
}

/** Split on `sep` (a single character) only at the top level. */
export function splitTopLevel(text, sep) {
  const out = [];
  let cur = '';
  let depth = 0;
  let quote = '';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quote) {
      cur += ch;
      if (ch === '\\' && i + 1 < text.length) {
        cur += text[++i];
        continue;
      }
      if (ch === quote) quote = '';
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }

    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') {
      if (depth > 0) depth -= 1;
    }

    if (depth === 0 && ch === sep) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }

  out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// Small value parsers
// ---------------------------------------------------------------------------

export function parseIntStrict(text) {
  if (typeof text === 'number') return Number.isInteger(text) ? text | 0 : null;
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!/^[+-]?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function parseNumber(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const n = Number(text.trim());
  return Number.isFinite(n) ? n : null;
}

export function stripQuotes(text) {
  const t = String(text).trim();
  if (t.length >= 2) {
    const q = t[0];
    if ((q === '"' || q === "'") && t[t.length - 1] === q) return t.slice(1, -1);
  }
  return t;
}

/** `say "hello world"` -> `hello world` (handles simple escapes). */
export function unquoteText(text) {
  const t = String(text).trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    const inner = t.slice(1, -1);
    let out = '';
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === '\\' && i + 1 < inner.length) {
        const next = inner[++i];
        if (next === 'n') out += '\n';
        else if (next === 't') out += '\t';
        else out += next;
      } else {
        out += ch;
      }
    }
    return out;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Ranges (scoreboard `matches`)
// ---------------------------------------------------------------------------

/**
 * Range forms: `5`, `5..`, `..5`, `5..10`, `..`.
 * Returns {min: number|null, max: number|null} or null when malformed.
 */
export function parseRange(token) {
  if (typeof token !== 'string') return null;
  const t = token.trim();
  if (t === '..') return { min: null, max: null };
  const dots = t.indexOf('..');
  if (dots >= 0) {
    const left = t.slice(0, dots);
    const right = t.slice(dots + 2);
    const min = left === '' ? null : parseIntStrict(left);
    const max = right === '' ? null : parseIntStrict(right);
    if ((left !== '' && min === null) || (right !== '' && max === null)) return null;
    return { min, max };
  }
  const v = parseIntStrict(t);
  if (v === null) return null;
  return { min: v, max: v };
}

export function matchesRange(value, range) {
  if (!range) return false;
  if (range.min !== null && value < range.min) return false;
  if (range.max !== null && value > range.max) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

/** Token -> { mode: 'abs'|'rel'|'local', value: number } or null. */
export function parseCoord(token) {
  if (typeof token !== 'string' || token === '') return null;
  if (token === '~') return { mode: 'rel', value: 0 };
  if (token === '^') return { mode: 'local', value: 0 };
  const first = token[0];
  if (first === '~' || first === '^') {
    const v = parseNumber(token.slice(1));
    if (v === null) return null;
    return { mode: first === '~' ? 'rel' : 'local', value: v };
  }
  const v = parseNumber(token);
  if (v === null) return null;
  return { mode: 'abs', value: v };
}

export function localBasis(rot) {
  const yaw = ((rot && rot.yaw) || 0) * (Math.PI / 180);
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  // Forward matches spec §5: yaw 0 -> +Z, direction = (-sin, 0, cos).
  // "Left" (local +X) completes the basis: (cos, 0, sin) — at yaw 0, +X.
  return {
    forward: { x: -sin, z: cos },
    left: { x: cos, z: sin },
  };
}

/**
 * Resolve `~` / `^` / absolute coordinates against an execution context.
 * Returns floored-free floats; callers floor for block commands.
 */
export function resolvePosition(coords, ctx) {
  const [cx, cy, cz] = coords;
  const base = (ctx && ctx.pos) || { x: 0, y: 0, z: 0 };
  const basis = localBasis((ctx && ctx.rot) || { yaw: 0, pitch: 0 });

  let x = base.x;
  let y = base.y;
  let z = base.z;

  if (cx.mode === 'abs') x = cx.value;
  else if (cx.mode === 'rel') x = base.x + cx.value;

  if (cy.mode === 'abs') y = cy.value;
  else y = base.y + cy.value; // 'rel' or 'local' both add on the Y axis

  if (cz.mode === 'abs') z = cz.value;
  else if (cz.mode === 'rel') z = base.z + cz.value;

  if (cx.mode === 'local' || cz.mode === 'local') {
    const lx = cx.mode === 'local' ? cx.value : 0;
    const lz = cz.mode === 'local' ? cz.value : 0;
    if (cx.mode === 'local') {
      x = base.x + basis.left.x * lx + basis.forward.x * lz;
    } else {
      x += basis.forward.x * lz;
    }
    if (cz.mode === 'local') {
      z = base.z + basis.left.z * lx + basis.forward.z * lz;
    } else {
      z += basis.left.z * lx;
    }
  }

  return { x, y, z };
}

/** `~N` / absolute rotation token -> number, relative to `base`. */
export function resolveRotationToken(token, base) {
  if (!token) return base;
  if (token.mode === 'rel') return base + token.value;
  return token.value;
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function canonicalEntity(id) {
  const t = String(id).trim();
  return t.startsWith('minecraft:') ? t.slice('minecraft:'.length) : t;
}

export function canonicalBlock(id) {
  const t = String(id).trim();
  return t.startsWith('minecraft:') ? t.slice('minecraft:'.length) : t;
}

/**
 * `@s`, `@p`, `@a`, `@e[...]`.
 * Supported arguments: tag=, type=, limit=, sort=, distance=, name=.
 * Unknown arguments are ignored (forward compatibility), matching the spirit of
 * "be robust: never crash on generated-ish input". A malformed selector returns null.
 */
export function parseSelector(token) {
  if (typeof token !== 'string') return null;
  const t = token.trim();
  if (t[0] !== '@') return null;
  const open = t.indexOf('[');
  const base = (open === -1 ? t.slice(1) : t.slice(1, open)).toLowerCase();
  if (base.length !== 1 || !'sape'.includes(base)) return null;

  const sel = {
    base,
    tags: [],
    types: [],
    limit: null,
    sort: null,
    distance: null,
    name: null,
  };
  if (open === -1) return sel;
  if (!t.endsWith(']')) return null;

  const inside = t.slice(open + 1, -1);
  for (const rawPart of splitTopLevel(inside, ',')) {
    const part = rawPart.trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq < 0) return null;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = stripQuotes(part.slice(eq + 1).trim());
    if (key === 'tag') sel.tags.push(value);
    else if (key === 'type') {
      if (value) sel.types.push(canonicalEntity(value));
    } else if (key === 'limit') {
      const n = parseIntStrict(value);
      if (n === null) return null;
      sel.limit = n;
    } else if (key === 'sort') {
      sel.sort = value.toLowerCase();
    } else if (key === 'distance') {
      const r = parseRange(value);
      if (!r) return null;
      sel.distance = r;
    } else if (key === 'name') {
      sel.name = value;
    }
    // Unknown selector keys: ignored (see doc comment).
  }
  return sel;
}

// ---------------------------------------------------------------------------
// NBT (only Tags matters for v0.1)
// ---------------------------------------------------------------------------

/** Extract `Tags:["a","b"]` from a summon NBT string. Other NBT is ignored. */
export function parseTagList(nbt) {
  if (typeof nbt !== 'string' || nbt === '') return [];
  const m = /(?:^|[,\s{])Tags\s*:\s*\[([^\]]*)\]/.exec(nbt);
  if (!m) return [];
  return splitTopLevel(m[1], ',')
    .map((part) => stripQuotes(part.trim()))
    .filter((part) => part !== '');
}

// ---------------------------------------------------------------------------
// Command parser
// ---------------------------------------------------------------------------

function err(message) {
  return { kind: 'error', message };
}

const EMPTY = { kind: 'empty' };

function lower(token) {
  return typeof token === 'string' ? token.toLowerCase() : '';
}

/** Parse one raw mcfunction line into a context-free command object. */
export function parseCommand(text) {
  const trimmed = String(text == null ? '' : text).trim();
  if (trimmed === '' || trimmed.startsWith('#')) return EMPTY;

  let body = trimmed;
  if (body.startsWith('/')) body = body.slice(1).trim(); // defensive: functions omit the slash
  if (body === '') return EMPTY;

  const tokens = tokenize(body);
  if (!tokens.length) return EMPTY;
  return parseTokens(tokens, body);
}

function parseTokens(tokens, rawText) {
  const name = lower(tokens[0]);

  switch (name) {
    case 'scoreboard':
      return parseScoreboard(tokens);
    case 'execute':
      return parseExecute(tokens);
    case 'tp':
    case 'teleport':
      return parseTp(tokens);
    case 'setblock':
      return parseSetblock(tokens);
    case 'fill':
      return parseFill(tokens);
    case 'summon':
      return parseSummon(tokens);
    case 'kill':
      return parseKill(tokens);
    case 'tag':
      return parseTag(tokens);
    case 'say':
      return parseSay(tokens, rawText);
    case 'function':
      return parseFunction(tokens);
    case 'particle':
      return parseParticle(tokens);
    case 'return':
      return parseReturn(tokens);
    default:
      return { kind: 'unknown', name: tokens[0] };
  }
}

// --- scoreboard ------------------------------------------------------------

function parseScoreboard(tokens) {
  const sub = lower(tokens[1]);
  if (sub === 'objectives') {
    const action = lower(tokens[2]);
    if (action === 'add') {
      if (!tokens[3]) return err('malformed scoreboard objectives add');
      return { kind: 'scoreboard.objectives.add', objective: tokens[3] };
    }
    if (action === 'remove') {
      if (!tokens[3]) return err('malformed scoreboard objectives remove');
      return { kind: 'scoreboard.objectives.remove', objective: tokens[3] };
    }
    return err(`unsupported scoreboard objectives action '${tokens[2]}'`);
  }

  if (sub === 'players') {
    const action = lower(tokens[2]);
    if (action === 'set' || action === 'add' || action === 'remove') {
      if (!tokens[3] || !tokens[4] || tokens[5] === undefined) {
        return err(`malformed scoreboard players ${action}`);
      }
      const value = parseIntStrict(tokens[5]);
      if (value === null) return err(`invalid score value '${tokens[5]}'`);
      return {
        kind: `scoreboard.players.${action}`,
        target: tokens[3],
        objective: tokens[4],
        value,
      };
    }
    if (action === 'reset') {
      if (!tokens[3]) return err('malformed scoreboard players reset');
      return {
        kind: 'scoreboard.players.reset',
        target: tokens[3],
        objective: tokens[4] || null,
      };
    }
    if (action === 'operation') {
      const allowed = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<', '>', '><']);
      if (!tokens[3] || !tokens[4] || !tokens[5] || !tokens[6] || !tokens[7]) {
        return err('malformed scoreboard players operation');
      }
      if (!allowed.has(tokens[5])) {
        return err(`unsupported scoreboard operation '${tokens[5]}'`);
      }
      return {
        kind: 'scoreboard.players.operation',
        target: tokens[3],
        objective: tokens[4],
        op: tokens[5],
        source: tokens[6],
        sourceObjective: tokens[7],
      };
    }
    return err(`unsupported scoreboard players action '${tokens[2]}'`);
  }

  return err(`unsupported scoreboard subcommand '${tokens[1]}'`);
}

// --- execute ---------------------------------------------------------------

function parseExecute(tokens) {
  const mods = [];
  let command = null;
  let i = 1;

  while (i < tokens.length) {
    const word = lower(tokens[i]);

    if (word === 'as' || word === 'at') {
      const selector = parseSelector(tokens[i + 1]);
      if (!selector) return err(`invalid selector '${tokens[i + 1]}' in execute ${word}`);
      mods.push({ type: word, selector });
      i += 2;
      continue;
    }

    if (word === 'positioned') {
      const coords = parseCoordList(tokens, i + 1, 3);
      if (!coords) return err('invalid coordinates in execute positioned');
      mods.push({ type: 'positioned', coords });
      i += 4;
      continue;
    }

    if (word === 'rotated') {
      const yaw = parseCoord(tokens[i + 1]);
      const pitch = parseCoord(tokens[i + 2]);
      if (!yaw || !pitch) return err('invalid rotation in execute rotated');
      mods.push({ type: 'rotated', yaw, pitch });
      i += 3;
      continue;
    }

    if (word === 'if' || word === 'unless') {
      const parsed = parseCondition(tokens, i);
      if (parsed.error) return err(parsed.error);
      mods.push({ type: 'condition', negate: word === 'unless', cond: parsed.cond });
      i = parsed.next;
      continue;
    }

    if (word === 'run') {
      const rest = tokens.slice(i + 1);
      if (!rest.length) return err('execute is missing a command after run');
      command = parseTokens(rest, null);
      i = tokens.length;
      continue;
    }

    return err(`unsupported execute subcommand '${tokens[i]}'`);
  }

  if (!command) return err('execute is missing a command after run');
  return { kind: 'execute', mods, command };
}

function parseCoordList(tokens, start, count) {
  const coords = [];
  for (let k = 0; k < count; k++) {
    const c = parseCoord(tokens[start + k]);
    if (!c) return null;
    coords.push(c);
  }
  return coords;
}

function parseCondition(tokens, i) {
  const kind = lower(tokens[i + 1]);

  if (kind === 'score') {
    const target = tokens[i + 2];
    const objective = tokens[i + 3];
    if (!target || !objective) return { error: 'malformed execute if score' };
    const op = tokens[i + 4];
    if (op === undefined) return { error: 'malformed execute if score' };

    if (lower(op) === 'matches') {
      const range = parseRange(tokens[i + 5]);
      if (!range) return { error: `invalid matches range '${tokens[i + 5]}'` };
      return {
        cond: { type: 'score', target, objective, op: 'matches', range },
        next: i + 6,
      };
    }

    // Extension beyond LANG.md §5: vanilla comparison form
    // `if score <t> <obj> (=|<|<=|>|>=|<>) <t2> <obj2>`.
    if (['=', '==', '<', '<=', '>', '>=', '!='].includes(op)) {
      const target2 = tokens[i + 5];
      const objective2 = tokens[i + 6];
      if (!target2 || !objective2) return { error: 'malformed execute if score comparison' };
      return {
        cond: { type: 'score', target, objective, op, target2, objective2 },
        next: i + 7,
      };
    }

    return { error: `unsupported execute score condition '${op}'` };
  }

  if (kind === 'block') {
    const coords = parseCoordList(tokens, i + 2, 3);
    if (!coords) return { error: 'invalid coordinates in execute if block' };
    const block = tokens[i + 5];
    if (!block) return { error: 'execute if block is missing a block id' };
    return {
      cond: { type: 'block', coords, block: canonicalBlock(block) },
      next: i + 6,
    };
  }

  if (kind === 'entity') {
    const selector = parseSelector(tokens[i + 2]);
    if (!selector) return { error: `invalid selector '${tokens[i + 2]}' in execute if entity` };
    return { cond: { type: 'entity', selector }, next: i + 3 };
  }

  return { error: `unsupported execute condition '${tokens[i + 1]}'` };
}

// --- tp --------------------------------------------------------------------

function parseTp(tokens) {
  const selector = parseSelector(tokens[1]);
  if (!selector) return err(`invalid target selector '${tokens[1]}' in tp`);
  const coords = parseCoordList(tokens, 2, 3);
  if (!coords) return err('invalid coordinates in tp');
  // `tp <targets> <x> <y> <z>` = 5 tokens, plus optional `<yaw> <pitch>` = 7.
  if (tokens.length !== 5 && tokens.length !== 7) {
    return err('malformed tp (expected <targets> <x> <y> <z> [<yaw> <pitch>])');
  }
  let yaw = null;
  let pitch = null;
  if (tokens.length === 7) {
    yaw = parseCoord(tokens[5]);
    pitch = parseCoord(tokens[6]);
    if (!yaw || !pitch) return err('invalid rotation in tp');
  }
  return { kind: 'tp', selector, coords, yaw, pitch };
}

// --- setblock / fill -------------------------------------------------------

function parseSetblock(tokens) {
  const coords = parseCoordList(tokens, 1, 3);
  if (!coords) return err('invalid coordinates in setblock');
  const block = tokens[4];
  if (!block) return err('setblock is missing a block id');
  const mode = tokens[5] ? lower(tokens[5]) : 'replace';
  if (!['replace', 'destroy', 'keep'].includes(mode)) {
    return err(`unsupported setblock mode '${tokens[5]}'`);
  }
  return { kind: 'setblock', coords, block: canonicalBlock(block), mode };
}

function parseFill(tokens) {
  const coords = parseCoordList(tokens, 1, 3);
  const coords2 = parseCoordList(tokens, 4, 3);
  if (!coords || !coords2) return err('invalid coordinates in fill');
  const block = tokens[7];
  if (!block) return err('fill is missing a block id');
  const mode = tokens[8] ? lower(tokens[8]) : 'replace';
  if (!['replace', 'destroy', 'keep'].includes(mode)) {
    return err(`unsupported fill mode '${tokens[8]}'`);
  }
  return { kind: 'fill', from: coords, to: coords2, block: canonicalBlock(block), mode };
}

// --- summon / kill / tag ---------------------------------------------------

function parseSummon(tokens) {
  const entityType = tokens[1];
  if (!entityType) return err('summon is missing an entity type');
  const coords = parseCoordList(tokens, 2, 3);
  if (!coords) return err('invalid coordinates in summon');
  const nbt = tokens.slice(5).join(' ');
  return {
    kind: 'summon',
    entityType: canonicalEntity(entityType),
    coords,
    tags: parseTagList(nbt),
  };
}

function parseKill(tokens) {
  const selector = parseSelector(tokens[1]);
  if (!selector) return err(`invalid target selector '${tokens[1]}' in kill`);
  return { kind: 'kill', selector };
}

function parseTag(tokens) {
  const selector = parseSelector(tokens[1]);
  if (!selector) return err(`invalid target selector '${tokens[1]}' in tag`);
  const action = lower(tokens[2]);
  if (action !== 'add' && action !== 'remove') {
    return err(`unsupported tag action '${tokens[2]}'`);
  }
  const tag = tokens[3];
  if (!tag) return err('tag is missing a tag name');
  return { kind: 'tag', selector, action, tag };
}

// --- say / function / particle --------------------------------------------

function parseSay(tokens, rawText) {
  let text;
  if (typeof rawText === 'string') {
    const rest = rawText.replace(/^\/?\s*say\b/i, '');
    text = unquoteText(rest);
  } else {
    text = unquoteText(tokens.slice(1).join(' '));
  }
  return { kind: 'say', text };
}

function parseFunction(tokens) {
  const name = tokens[1];
  if (!name) return err('function is missing a name');
  if (name.startsWith('#')) {
    return err(`function tags are not supported ('${name}')`);
  }
  return { kind: 'function', name };
}

function parseParticle(tokens) {
  const particle = tokens[1];
  if (!particle) return err('particle is missing a name');
  const coords = parseCoordList(tokens, 2, 3);
  if (!coords) return err('invalid coordinates in particle');
  return { kind: 'particle', particle, coords };
}

// Real 1.21 `/return` (not in the §5 list, but generated packs may emit it to end
// a state function early; supporting it keeps such packs runnable).
function parseReturn(tokens) {
  if (tokens.length > 1 && lower(tokens[1]) === 'run') {
    const rest = tokens.slice(2);
    if (!rest.length) return err('return run is missing a command');
    return { kind: 'return', command: parseTokens(rest, null) };
  }
  // `return` (and `return <value>`, whose value we don't track) simply stops the function.
  return { kind: 'return', command: null };
}
