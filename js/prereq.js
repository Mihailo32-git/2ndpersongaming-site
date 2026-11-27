// Checks feat prerequisites, which are stored as plain English text ("trained in Crafting",
// "Bard Dedication", "Strength +2", "bomber research field").
// Returns true (met), false (not met) or null (couldn't check — shown as a warning, still allowed).

import { SKILLS, SAVES, sluggify } from './util.js';

const RANK_WORD = { untrained: 0, trained: 1, expert: 2, master: 3, legendary: 4 };
const ATTR_WORD = { strength: 'str', str: 'str', dexterity: 'dex', dex: 'dex', constitution: 'con', con: 'con',
  intelligence: 'int', int: 'int', wisdom: 'wis', wis: 'wis', charisma: 'cha', cha: 'cha' };
const SUFFIXES = [' research field', ' subconscious mind', ' conscious mind', ' methodology', ' instinct', ' muse',
  ' patron', ' order', ' bloodline', ' doctrine', ' mystery', ' cause', ' racket', ' style', ' innovation', ' implement'];
const KNOWN_PACKS = ['feats', 'classfeatures', 'ancestryfeatures', 'heritages', 'ancestries', 'backgrounds', 'actions'];

// Feats that let one skill's rank stand in for others when meeting skill feat prerequisites.
// Versatile Performance: "use your proficiency rank in Performance to meet the prerequisites of skill feats that
// require a particular proficiency rank in Deception, Diplomacy, or Intimidation".
// any: true counts for every prerequisite, not only skill feats' (Chirurgeon: Crafting for Medicine).
const SKILL_STANDINS = [
  { feat: 'versatile-performance', from: 'performance', skills: ['deception', 'diplomacy', 'intimidation'] },
  { feat: 'chirurgeon', from: 'crafting', skills: ['medicine'], any: true },
];
let standinsOff = false; // while checking whether a prerequisite is met without them

function rankOfTarget(target, ch, rec = null) {
  target = target.trim().replace(/\.$/, '');
  if (SKILLS[target] !== undefined) {
    let r = ch.ranks.skills[target] || 0;
    const owned = ch.ownedSlugs || new Set((ch.items || []).map((i) => i.rec.slug));
    const skillFeat = !!(rec && (rec.traits || []).includes('skill'));
    if (!standinsOff) for (const x of SKILL_STANDINS) if ((x.any || skillFeat) && x.skills.includes(target) && owned.has(x.feat)) r = Math.max(r, ch.ranks.skills[x.from] || 0);
    return r;
  }
  if (target === 'perception') return ch.ranks.perception;
  for (const s of Object.keys(SAVES)) if (target === s || target === s + ' saves' || target === s + ' save') return ch.ranks.saves[s];
  if (/^(light|medium|heavy) armor$/.test(target)) return ch.ranks.defenses[target.split(' ')[0]] || 0;
  if (target === 'unarmored defense') return ch.ranks.defenses.unarmored || 0;
  if (/^(simple|martial|advanced) weapons?$/.test(target)) return ch.ranks.attacks[target.split(' ')[0]] || 0;
  if (target === 'unarmed attacks') return ch.ranks.attacks.unarmed || 0;
  if (target === 'spell attack modifier' || target === 'spell attack rolls' || target === 'spell dcs' || target === 'spell dc') return ch.ranks.spellcasting || 0;
  if (target === 'class dc' || target.endsWith(' class dc')) return ch.ranks.classDC || 0;
  if (target === 'at least one skill') return Math.max(0, ...Object.values(ch.ranks.skills));
  if (target === 'lore' || target === 'a lore skill' || target === 'at least one lore skill') return Math.max(0, ...Object.values(ch.ranks.lores || {}));
  if (target.endsWith(' lore')) {
    const lores = ch.ranks.lores || {};
    for (const [k, v] of Object.entries(lores)) if (k.toLowerCase() === target) return v;
    return 0;
  }
  return null;
}

function checkOne(text, ch, db, rec = null) {
  let t = text.toLowerCase().trim().replace(/\.$/, '').replace(/\s+/g, ' ');
  if (!t) return true;

  // "trained in X", "expert in X"
  let m = t.match(/^(untrained|trained|expert|master|legendary) (?:in|with) (.+)$/);
  if (m) {
    const need = RANK_WORD[m[1]];
    // "trained in Acrobatics and medium armor"
    if (m[2].includes(' and ')) {
      const parts = m[2].split(/,? and |, /);
      const res = parts.map((p) => rankOfTarget(p, ch, rec));
      if (res.some((r) => r === null)) return null;
      return res.every((r) => r >= need);
    }
    const r = rankOfTarget(m[2], ch, rec);
    return r === null ? null : r >= need;
  }

  // "Strength +2", "Charisma modifier of +3"
  m = t.match(/^(strength|dexterity|constitution|intelligence|wisdom|charisma|str|dex|con|int|wis|cha)(?: modifier)?(?: of)? \+?(\d+)$/);
  if (m) return ch.attrs[ATTR_WORD[m[1]]] >= Number(m[2]);

  m = t.match(/^(?:level|character level) (\d+)$/);
  if (m) return ch.level >= Number(m[1]);

  if (/^(?:spellcasting class feature|ability to cast spells|the ability to cast spells)/.test(t)) return (ch.spellcasting?.entries?.length || 0) > 0;
  if (/^(?:focus pool|a focus pool|ability to cast focus spells|the ability to cast focus spells)/.test(t)) return ch.focusMax > 0;
  if (/^(darkvision|low-light vision|scent|imprecise scent)$/.test(t)) return ch.senses.some((s) => s.type === sluggify(t.replace('imprecise ', '')));

  // Named item: feat, class feature, heritage...
  const candidates = [t.replace(/^the /, '')];
  for (const s of SUFFIXES) if (t.endsWith(s)) candidates.push(t.slice(0, -s.length).replace(/^the /, ''));
  for (const c of candidates) {
    const slug = sluggify(c);
    if (ch.ownedSlugs.has(slug)) return true;
    if (ch.ownedNames.has(c)) return true;
  }
  for (const c of candidates) {
    const slug = sluggify(c);
    for (const p of KNOWN_PACKS) if (db.maps[p]?.has(slug)) return false;
    if (db.findName(c, ['feats', 'classfeatures'])) return false;
  }
  return null;
}

/** text may contain alternatives: "trained in Medicine or Tian Xia Lore", "Acute Scent or scent". rec: the feat being checked. */
export function checkPrereq(text, ch, db, rec = null) {
  const t = String(text).trim();
  // Carry a rank prefix across alternatives: "trained in Crafting or Thievery"
  const rankM = t.toLowerCase().match(/^(trained|expert|master|legendary) in /);
  const alts = t.split(/,? or /i).map((a, i) => (i > 0 && rankM && !/^(trained|expert|master|legendary) in /i.test(a) ? rankM[0] + a : a));
  // Lists like "trained in Arcana, Nature, Occultism, or Religion"
  const expanded = [];
  for (const a of alts) {
    const mm = a.match(/^(trained|expert|master|legendary) in (.+)$/i);
    if (mm && mm[2].includes(', ') && !mm[2].includes(' and ')) for (const x of mm[2].split(', ')) expanded.push(mm[1] + ' in ' + x);
    else expanded.push(a);
  }
  let unknown = false;
  for (const a of expanded) {
    const r = checkOne(a, ch, db, rec);
    if (r === true) return true;
    if (r === null) unknown = true;
  }
  return unknown ? null : false;
}

export function checkAll(prereqs, ch, db, rec = null) {
  const results = (prereqs || []).map((p) => ({ text: p, ok: checkPrereq(p, ch, db, rec) }));
  // Say when a stand-in skill is what met it ("master in Intimidation" met by Performance via Versatile Performance).
  const skillFeat = !!(rec && (rec.traits || []).includes('skill'));
  for (const r of results) {
    if (r.ok !== true) continue;
    const x = SKILL_STANDINS.find((s) => (s.any || skillFeat) && s.skills.some((k) => r.text.toLowerCase().includes(k)) && (ch.ownedSlugs || new Set()).has(s.feat));
    if (!x) continue;
    standinsOff = true;
    let without;
    try { without = checkPrereq(r.text, ch, db, rec); } finally { standinsOff = false; }
    const src = db.list('feats').find((f) => f.slug === x.feat) || db.list('classfeatures').find((f) => f.slug === x.feat);
    if (without !== true) r.via = `${x.from[0].toUpperCase() + x.from.slice(1)}, via ${(src || {}).name || x.feat}`;
  }
  const ok = results.every((r) => r.ok !== false);
  return { ok, unknown: results.some((r) => r.ok === null), results };
}
