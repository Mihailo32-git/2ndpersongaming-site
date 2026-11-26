// Limited-use things on a character: feats and features with a frequency ("once per hour"), innate spells,
// daily resources (alchemist vials and the like) and consumables. Used by the sheet (to tick uses off)
// and the GM screen (to see what each player has left).

// Foundry frequencies: "1/day", "2/day", "1/round", "1/turn", "1/PT1H", "1/PT10M", "1/PT1M", "1/P1W"…
// tier: what resets it. 0 round/turn, 1 minute, 2 ten minutes, 3 hour, 4 day (Rest), 5 longer.
export function parseFreq(f) {
  const m = String(f || '').match(/^(\d+)\/(.+)$/);
  if (!m) return null;
  const max = Number(m[1]); const p = m[2];
  if (p === 'day') return { max, per: 'day', tier: 4 };
  if (p === 'round' || p === 'turn') return { max, per: p, tier: 0 };
  const d = p.match(/^P(?:(\d+)([DWMY]))?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/);
  if (!d) return { max, per: p, tier: 4 };
  if (d[1]) {
    const n = Number(d[1]); const u = { D: 'day', W: 'week', M: 'month', Y: 'year' }[d[2]];
    return { max, per: n === 1 ? u : `${n} ${u}s`, tier: u === 'day' && n === 1 ? 4 : 5 };
  }
  const h = Number(d[3] || 0), mi = Number(d[4] || 0);
  if (h) return { max, per: h === 1 ? 'hour' : `${h} hours`, tier: h <= 1 ? 3 : 4 };
  if (mi) return { max, per: mi === 1 ? 'minute' : `${mi} minutes`, tier: mi <= 1 ? 1 : mi <= 10 ? 2 : 3 };
  return { max, per: p, tier: 4 };
}
export function freqText(f) {
  const fr = typeof f === 'string' ? parseFreq(f) : f;
  if (!fr) return '';
  const times = fr.max === 1 ? 'once' : fr.max === 2 ? 'twice' : `${fr.max} times`;
  return `${times} per ${fr.per}`;
}
export const RESET_TIERS = [{ tier: 2, label: '10 minutes passed' }, { tier: 3, label: 'An hour passed' }];

/** The character's feats, features and actions that have a frequency: [{slug, name, ref, max, per, tier, used}] */
export function limitedList(ch, state) {
  const seen = new Set(); const out = [];
  const add = (rec) => {
    if (!rec || !rec.freq || seen.has(rec.slug)) return;
    const fr = parseFreq(rec.freq); if (!fr) return;
    seen.add(rec.slug);
    out.push({ slug: rec.slug, name: rec.name, ref: rec._pack ? `@${rec._pack}/${rec.slug}` : null, ...fr, used: Math.min(fr.max, (state.freqUsed || {})[rec.slug] || 0) });
  };
  for (const f of ch.feats || []) add(f.rec);
  for (const f of ch.features || []) add(f.rec);
  for (const a of ch.actions || []) add(a.rec);
  return out.sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
}
/** Innate spells cast once a day: [{name, ref, rank, used}] (cantrips left out). */
export function innateList(ch, state) {
  return (ch.spellcasting?.innate || []).filter((s) => s.rec && !(s.rec.traits || []).includes('cantrip') && !s.rec.cantrip)
    .map((s) => ({ name: s.rec.name, ref: s.ref, rank: s.rank, used: !!(state.innateUsed || {})[s.ref] }));
}
/** Daily resources (versatile vials, infused reagents…): [{label, max, left}] */
export function dailyList(ch, state) {
  return (ch.crafting || []).filter((c) => c.max != null).map((c) => ({ label: c.label, max: c.max, left: Math.max(0, c.max - ((state.dailyUsed || {})[c.slug] || 0)) }));
}
const POTION_CATS = ['potion', 'elixir', 'mutagen', 'poison', 'oil', 'drug'];
const MAGIC_CATS = ['scroll', 'talisman', 'wand', 'fulu', 'catalyst'];
const GROUPS = [['potion', 'Potions & elixirs'], ['magic', 'Scrolls, wands & talismans'], ['bomb', 'Bombs & snares'], ['ammo', 'Ammunition'], ['other', 'Other']];
function consKind(rec) {
  const tr = rec.traits || [];
  if (rec.type === 'ammo') return 'ammo';
  if (rec.type === 'weapon') return tr.includes('bomb') ? 'bomb' : null;
  if (rec.type !== 'consumable') return null;
  const c = rec.cat || 'other';
  if (POTION_CATS.includes(c) || tr.includes('elixir') || tr.includes('potion') || tr.includes('poison') || tr.includes('oil')) return 'potion';
  if (MAGIC_CATS.includes(c) || tr.includes('talisman') || tr.includes('scroll') || tr.includes('wand')) return 'magic';
  if (tr.includes('bomb') || tr.includes('snare') || c === 'snare' || c === 'gadget') return 'bomb';
  return 'other';
}
/** Consumables carried, grouped: {total, groups: [{label, items: [{name, qty}]}]} */
export function consumables(ch) {
  const by = {};
  let total = 0;
  for (const it of ch.inventory || []) {
    const k = it.rec && consKind(it.rec); if (!k) continue;
    const qty = Number(it.qty) || 1;
    const name = it.rec.name + (it.spell ? ` (${it.spellName || it.spell})` : '');
    const g = (by[k] = by[k] || {});
    g[name] = (g[name] || 0) + qty;
    if (k !== 'ammo') total += qty;
  }
  return { total, groups: GROUPS.filter(([k]) => by[k]).map(([k, label]) => ({ kind: k, label, items: Object.entries(by[k]).map(([name, qty]) => ({ name, qty })).sort((a, b) => a.name.localeCompare(b.name)) })) };
}
