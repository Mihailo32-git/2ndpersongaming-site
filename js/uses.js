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

// Feats that make something usable more often (the feat text says so; there's no rule to read it from).
const FREQ_UPGRADES = [
  { slug: 'accidental-shot', by: 'unbelievable-luck', freq: '1/PT1H' },
  { slug: 'unexpected-sharpshooter-dedication', by: 'unbelievable-luck', freq: '1/PT1H' },
  { slug: 'lucky-escape', by: 'unbelievable-escape', freq: '1/PT1H' },
];
/** Refs of the character's actions that have a frequency. */
export const limitedActionRefs = (ch) => new Set((ch.actions || []).filter((a) => a.rec && a.rec.freq).map((a) => `@actions/${a.rec.slug}`));
/** A feat whose limited use is an action it grants (Unexpected Sharpshooter Dedication → Accidental Shot): counted once, as the action. */
export const isActionDup = (rec, actionRefs) => rec._pack !== 'actions' && !!rec.freq && (rec.acts || []).some((r) => actionRefs.has(r));
/** A feat's or action's frequency for this character, after feats that raise it (Unbelievable Luck: once an hour). */
export function effectiveFreq(rec, ch) {
  if (!rec) return null;
  // Medic Dedication: Battle Medicine on a creature that's already immune, once a day (once an hour at master in Medicine).
  if (rec.slug === 'medic-dedication') return Math.max(ch.ranks?.skills?.medicine || 0, ch.skills?.medicine?.reqRank || 0) >= 3 ? '1/PT1H' : '1/day';
  if (!rec.freq) return null;
  const owned = ch.ownedSlugs || new Set((ch.items || []).map((i) => i.rec.slug));
  const up = FREQ_UPGRADES.find((u) => u.slug === rec.slug && owned.has(u.by));
  return up ? up.freq : rec.freq;
}
/** The character's feats, features and actions that have a frequency: [{slug, name, ref, max, per, tier, used}] */
export function limitedList(ch, state) {
  const seen = new Set(); const out = [];
  const actionRefs = limitedActionRefs(ch);
  const add = (rec) => {
    if (!rec || seen.has(rec.slug) || isActionDup(rec, actionRefs)) return;
    const fr = parseFreq(effectiveFreq(rec, ch)); if (!fr) return;
    seen.add(rec.slug);
    out.push({ slug: rec.slug, name: rec.slug === 'medic-dedication' ? 'Battle Medicine on an immune creature (Medic)' : rec.name, ref: rec._pack ? `@${rec._pack}/${rec.slug}` : null, ...fr, used: Math.min(fr.max, (state.freqUsed || {})[rec.slug] || 0) });
  };
  for (const f of ch.feats || []) add(f.rec);
  for (const f of ch.features || []) add(f.rec);
  for (const a of ch.actions || []) add(a.rec);
  return out.sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
}
/** Innate spells cast once a day: [{name, ref, rank, used}] (cantrips left out). */
// Where an innate spell comes from, said short: "Basic Captivator Spellcasting" → "Captivator".
const sourceLabel = (src) => String(src || 'Innate').replace(/^(Basic|Expert|Master|Legendary)\s+/, '').replace(/\s+(Spellcasting|Dedication)$/, '') || 'Innate';
/** Times an innate spell has been cast today (state.innateUsed[ref]: a count; older saves have true for once). */
export function innateUsedCount(state, ref) {
  const v = ((state && state.innateUsed) || {})[ref];
  return v === true ? 1 : Math.max(0, Number(v) || 0);
}
export function innateList(ch, state) {
  return (ch.spellcasting?.innate || []).filter((s) => s.rec && !(s.rec.traits || []).includes('cantrip') && !s.rec.cantrip)
    .map((s) => {
      const max = s.perDay || 1;
      const n = Math.min(max, innateUsedCount(state, s.ref));
      return { name: s.rec.name, ref: s.ref, rank: s.rank, source: sourceLabel(s.source), max, left: max - n, used: n >= max };
    });
}
/** innateList grouped by where the spells come from: [{source, spells, unpicked}] (unpicked: ranks of an
 * archetype like Captivator whose spell hasn't been chosen in the builder yet) */
export function innateGroups(ch, state) {
  const out = [];
  const group = (src) => { let g = out.find((y) => y.source === src); if (!g) out.push((g = { source: src, spells: [], unpicked: [] })); return g; };
  for (const x of innateList(ch, state)) group(x.source).spells.push(x);
  for (const s of ch.spellcasting?.innate || []) if (s.pickFor && !s.rec) group(sourceLabel(s.source)).unpicked.push(s.rank);
  return out;
}
/** Daily crafting resources other than alchemy (snares and the like): [{label, max, left}] */
export function dailyList(ch, state) {
  return (ch.crafting || []).filter((c) => c.max != null && !isAlchemyCraft(c)).map((c) => ({ label: c.label, max: c.max, left: Math.max(0, c.max - ((state.dailyUsed || {})[c.slug] || 0)) }));
}

// ------------------------------------------------------------------ alchemy
// Versatile vials (a pool that refills at daily preparations), Advanced Alchemy slots (items made each morning,
// kept in state.alchemy.prep[slug] = [{ref, used}]) and Quick Alchemy (spend a vial for a formula item).
const ALCH_SLUGS = ['advanced-alchemy', 'quick-alchemy'];
export const isAlchemyCraft = (c) => ALCH_SLUGS.includes(c.slug) || (!!c.daily && JSON.stringify(c.filter || []).includes('item:trait:alchemical'));
export const hasAlchemy = (ch) => !!ch.resources?.versatileVials || (ch.crafting || []).some(isAlchemyCraft);
export function alchemyInfo(ch, state) {
  const al = (state && state.alchemy) || {};
  const v = ch.resources?.versatileVials;
  const vials = v ? { label: v.label, max: v.max, left: Math.max(0, v.max - (Number(al.vialsUsed) || 0)) } : null;
  const preps = (ch.crafting || []).filter((c) => c.daily && c.max != null && isAlchemyCraft(c)).map((c) => {
    const arr = Array.isArray((al.prep || {})[c.slug]) ? al.prep[c.slug] : [];
    const slots = Array.from({ length: Math.max(0, c.max) }, (_, i) => (arr[i] && arr[i].ref ? arr[i] : null));
    return { slug: c.slug, label: c.label, max: c.max, filter: c.filter, slots, filled: slots.filter(Boolean).length, left: slots.filter((x) => x && !x.used).length };
  });
  const quick = (ch.crafting || []).find((c) => c.slug === 'quick-alchemy') || null;
  return { vials, preps, quick };
}
/** Infused items still unused today, by ref: [{ref, n}] */
export function infusedLeft(info) {
  const m = new Map();
  for (const p of info.preps) for (const x of p.slots) if (x && !x.used) m.set(x.ref, (m.get(x.ref) || 0) + 1);
  return [...m].map(([ref, n]) => ({ ref, n }));
}
/** "Alchemist's Fire (Greater)" → "Alchemist's Fire": one formula makes every level of an item. */
export const formulaFamily = (name) => String(name || '').replace(/\s*\((lesser|minor|moderate|greater|major|true)\)\s*$/i, '').trim();
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
