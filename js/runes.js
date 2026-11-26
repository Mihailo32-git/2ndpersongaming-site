// Property runes and precious materials (data/runes.json, built by tools/runes-data.mjs from the Foundry PF2e system).
// Items keep them as it.runes = ['flaming', …] (property rune slugs) and it.material = {type: 'cold-iron', grade: 'standard'}.

/** Loads the rune table once and keeps it on the DB (db.runeData) so the engine can read it synchronously. */
export function loadRunes(db) {
  if (!db._runesPromise) {
    db._runesPromise = db.fetchJson('runes.json').then((d) => {
      const by = (list) => Object.fromEntries((list || []).map((r) => [r.slug, r]));
      db.runeData = { weapon: by(d.weapon), armor: by(d.armor), materials: d.materials || { weapon: [], armor: [] } };
      return db.runeData;
    }).catch(() => (db.runeData = { weapon: {}, armor: {}, materials: { weapon: [], armor: [] } }));
  }
  return db._runesPromise;
}

/** Which kind of runes an item takes: 'weapon', 'armor' or null. */
export function runeKind(rec) {
  if (!rec) return null;
  if (rec.type === 'weapon' && !(rec.traits || []).includes('consumable') && rec.group !== 'bomb') return 'weapon';
  if (rec.type === 'armor') return 'armor';
  return null;
}

/** How many property runes fit: one per point of potency; an orichalcum item always takes 4 (table rule). */
export const runeSlots = (it) => (it && it.material && it.material.type === 'orichalcum' ? 4 : Math.max(0, Math.min(3, Number(it && it.potency) || 0)));

/** The rune's own item page, for its rules text ("Greater Flaming" is the item "Flaming (Greater)"). */
export function runeRef(db, rune) {
  if (!rune) return null;
  let n = rune.name || '';
  const er = n.match(/^(Greater )?(Acid|Cold|Electricity|Fire|Sonic)-Resistant$/); // one item, "Energy-Resistant"
  if (er) n = er[1] ? 'Energy-Resistant (Greater)' : 'Energy-Resistant';
  const m = n.match(/^(Lesser|Moderate|Greater|Major|True) (.+)$/);
  const names = [n.toLowerCase(), m ? `${m[2]} (${m[1]})`.toLowerCase() : null].filter(Boolean);
  const r = db.list('equipment').find((x) => names.includes(x.name.toLowerCase()));
  return r ? '@equipment/' + r.slug : null;
}

export const GRADE_NAMES = { low: 'low-grade', standard: 'standard-grade', high: 'high-grade' };
export function materialLabel(db, mat) {
  if (!mat || !mat.type) return '';
  const kinds = db.runeData?.materials || {};
  const m = [...(kinds.weapon || []), ...(kinds.armor || [])].find((x) => x.slug === mat.type);
  const name = m ? m.name : mat.type.replace(/-/g, ' ');
  return `${name}${mat.grade ? ` (${GRADE_NAMES[mat.grade] || mat.grade})` : ''}`;
}
/** Names of the property runes on an item, and whether each one fits its potency. */
export function itemRunes(db, it) {
  const kind = runeKind(db.get(it.ref));
  const table = kind && db.runeData ? db.runeData[kind] : {};
  return (Array.isArray(it.runes) ? it.runes : []).map((slug, i) => ({ slug, rune: table[slug] || null, name: table[slug]?.name || slug, fits: i < runeSlots(it) }));
}
