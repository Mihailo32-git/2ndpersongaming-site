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

function rankOfTarget(target, ch) {
  target = target.trim().replace(/\.$/, '');
  if (SKILLS[target] !== undefined) return ch.ranks.skills[target] || 0;
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

function checkOne(text, ch, db) {
  let t = text.toLowerCase().trim().replace(/\.$/, '').replace(/\s+/g, ' ');
  if (!t) return true;

  // "trained in X", "expert in X"
  let m = t.match(/^(untrained|trained|expert|master|legendary) (?:in|with) (.+)$/);
  if (m) {
    const need = RANK_WORD[m[1]];
    // "trained in Acrobatics and medium armor"
    if (m[2].includes(' and ')) {
      const parts = m[2].split(/,? and |, /);
      const res = parts.map((p) => rankOfTarget(p, ch));
      if (res.some((r) => r === null)) return null;
      return res.every((r) => r >= need);
    }
    const r = rankOfTarget(m[2], ch);
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

/** text may contain alternatives: "trained in Medicine or Tian Xia Lore", "Acute Scent or scent". */
export function checkPrereq(text, ch, db) {
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
    const r = checkOne(a, ch, db);
    if (r === true) return true;
    if (r === null) unknown = true;
  }
  return unknown ? null : false;
}

export function checkAll(prereqs, ch, db) {
  const results = (prereqs || []).map((p) => ({ text: p, ok: checkPrereq(p, ch, db) }));
  const ok = results.every((r) => r.ok !== false);
  return { ok, unknown: results.some((r) => r.ok === null), results };
}
