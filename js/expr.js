// Safe evaluator for the small formula language used in rule values,
// e.g. "3 + @actor.abilities.con.mod", "ternary(gte(@actor.level,17),3,2)", "floor(@actor.level / 2)".

const FN = {
  floor: Math.floor, ceil: Math.ceil, round: Math.round, abs: Math.abs,
  max: (...a) => Math.max(...a), min: (...a) => Math.min(...a),
  ternary: (c, a, b) => (c ? a : b),
  gte: (a, b) => (a >= b ? 1 : 0), gt: (a, b) => (a > b ? 1 : 0),
  lte: (a, b) => (a <= b ? 1 : 0), lt: (a, b) => (a < b ? 1 : 0),
  eq: (a, b) => (a === b ? 1 : 0), ne: (a, b) => (a !== b ? 1 : 0),
  clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
  btwn: (v, lo, hi) => (v >= lo && v <= hi ? 1 : 0),
  // match(when(cond, value), …, default): the first "when" whose condition holds, else the plain default.
  when: (c, v) => (c ? v : NaN),
  match: (...a) => { for (const x of a) if (!Number.isNaN(x)) return x; return 0; },
};

function tokenize(s) {
  const t = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) { let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++; t.push({ n: Number(s.slice(i, j)) }); i = j; continue; }
    if (c === '@') { let j = i + 1; while (j < s.length && /[\w.\-]/.test(s[j])) j++; t.push({ ref: s.slice(i + 1, j) }); i = j; continue; }
    if (/[a-zA-Z_]/.test(c)) { let j = i; while (j < s.length && /\w/.test(s[j])) j++; t.push({ id: s.slice(i, j) }); i = j; continue; }
    if ('+-*/%(),'.includes(c)) { t.push({ op: c }); i++; continue; }
    throw new Error('Bad character in formula: ' + c);
  }
  return t;
}

export function evaluate(formula, resolve) {
  if (typeof formula === 'number') return formula;
  if (typeof formula === 'boolean') return formula ? 1 : 0;
  if (formula == null || formula === '') return 0;
  const toks = tokenize(String(formula));
  let p = 0;
  const peek = () => toks[p];
  const take = () => toks[p++];
  function primary() {
    const t = take();
    if (!t) throw new Error('Unexpected end');
    if ('n' in t) return t.n;
    if ('ref' in t) return Number(resolve(t.ref)) || 0;
    if (t.op === '(') { const v = expr(); take(); return v; }
    if (t.op === '-') return -primary();
    if (t.op === '+') return primary();
    if (t.id) {
      const f = FN[t.id];
      if (!f) throw new Error('Unknown function ' + t.id);
      take(); // (
      const args = [];
      if (peek() && peek().op !== ')') {
        args.push(expr());
        while (peek() && peek().op === ',') { take(); args.push(expr()); }
      }
      take(); // )
      return f(...args);
    }
    throw new Error('Unexpected token');
  }
  function term() {
    let v = primary();
    while (peek() && '*/%'.includes(peek().op)) {
      const op = take().op, r = primary();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  function expr() {
    let v = term();
    while (peek() && (peek().op === '+' || peek().op === '-')) {
      const op = take().op, r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  try {
    const v = expr();
    return Number.isFinite(v) ? v : 0;
  } catch (e) {
    return 0;
  }
}
