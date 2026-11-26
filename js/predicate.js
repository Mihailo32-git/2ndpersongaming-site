// Evaluates Foundry-style predicates against a set of "roll options" (strings like "class:psychic",
// "feat:toughness", "item:trait:alchemical", "self:level:5").

function operandValues(x, options) {
  if (typeof x === 'number') return [x];
  if (typeof x === 'string') {
    if (/^-?\d+(\.\d+)?$/.test(x)) return [Number(x)];
    const pre = x + ':';
    const vals = [];
    for (const o of options) {
      if (o.startsWith(pre)) {
        const rest = o.slice(pre.length);
        if (/^-?\d+(\.\d+)?$/.test(rest)) vals.push(Number(rest));
      }
    }
    return vals;
  }
  return [];
}

function compare(op, args, options) {
  if (!Array.isArray(args) || args.length !== 2) return false;
  const a = operandValues(args[0], options), b = operandValues(args[1], options);
  for (const x of a) for (const y of b) {
    if (op === 'eq' && x === y) return true;
    if (op === 'gt' && x > y) return true;
    if (op === 'gte' && x >= y) return true;
    if (op === 'lt' && x < y) return true;
    if (op === 'lte' && x <= y) return true;
  }
  return false;
}

export function testStatement(st, options) {
  if (typeof st === 'string') return options.has(st);
  if (st == null) return true;
  if (typeof st !== 'object') return false;
  if ('and' in st) return st.and.every((s) => testStatement(s, options));
  if ('or' in st) return st.or.some((s) => testStatement(s, options));
  if ('nand' in st) return !st.nand.every((s) => testStatement(s, options));
  if ('nor' in st) return !st.nor.some((s) => testStatement(s, options));
  if ('xor' in st) return st.xor.filter((s) => testStatement(s, options)).length === 1;
  if ('not' in st) return !testStatement(st.not, options);
  if ('if' in st && 'then' in st) return !testStatement(st.if, options) || testStatement(st.then, options);
  for (const op of ['eq', 'gt', 'gte', 'lt', 'lte']) if (op in st) return compare(op, st[op], options);
  return false;
}

export function test(predicate, options) {
  if (!predicate || (Array.isArray(predicate) && predicate.length === 0)) return true;
  if (!Array.isArray(predicate)) return testStatement(predicate, options);
  return predicate.every((s) => testStatement(s, options));
}

/** Roll options describing an item, used when filtering ChoiceSet candidates. */
// Records from the data files never change, so each one's options are worked out once (the engine asks for
// them thousands of times per recalculation when it lists the choices a feat offers). Callers only read the set.
const OPT_CACHE = new WeakMap();
export function itemOptions(rec, pack) {
  let byPack = OPT_CACHE.get(rec);
  if (byPack && byPack[pack]) return byPack[pack];
  if (!byPack) { byPack = {}; OPT_CACHE.set(rec, byPack); }
  return (byPack[pack] = buildItemOptions(rec, pack));
}
function buildItemOptions(rec, pack) {
  const o = new Set();
  const typeOf = { feats: 'feat', classfeatures: 'feat', ancestryfeatures: 'feat', spells: 'spell', ancestries: 'ancestry',
    heritages: 'heritage', backgrounds: 'background', classes: 'class', actions: 'action', conditions: 'condition' };
  const type = pack === 'equipment' ? rec.type : (typeOf[pack] || pack);
  o.add('item:type:' + type);
  o.add('item:slug:' + rec.slug);
  o.add('item:' + rec.slug);
  for (const t of rec.traits || []) o.add('item:trait:' + t);
  for (const t of rec.tags || []) o.add('item:tag:' + t);
  for (const t of rec.trad || []) o.add('item:trait:' + t);
  if (rec.cat) o.add('item:category:' + rec.cat);
  if (rec.rarity) o.add('item:rarity:' + rec.rarity);
  const lvl = rec.level ?? rec.rank;
  if (lvl != null) { o.add('item:level:' + lvl); if (pack === 'spells') o.add('item:rank:' + lvl); }
  if (rec.group) o.add('item:group:' + rec.group);
  if (rec.base) o.add('item:base:' + rec.base);
  if (pack === 'heritages') o.add('item:ancestry:' + (rec.ancestry || 'versatile'));
  if (pack === 'spells' && (rec.traits || []).includes('cantrip')) o.add('item:cantrip');
  return o;
}
