// Companions on the character sheet: animal companions, familiars and eidolons.
// Their statistics follow the companion rules (Player Core; summoner from Impossible Magic) and are worked
// out from the owner's level and computed sheet, so they level up with the character.
// Type data (companions.json) comes from the Foundry system (familiar abilities) and the PF2e Companion
// Compendia module (animal companion and eidolon types).
import { titleCase } from './util.js';

export const SIZE_ORDER = ['tiny', 'sm', 'med', 'lg', 'huge', 'grg'];
export const SIZE_NAME = { tiny: 'Tiny', sm: 'Small', med: 'Medium', lg: 'Large', huge: 'Huge', grg: 'Gargantuan' };
export const ATTRS6 = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const SKILL_ATTR = { acrobatics: 'dex', arcana: 'int', athletics: 'str', crafting: 'int', deception: 'cha', diplomacy: 'cha', intimidation: 'cha', medicine: 'wis',
  nature: 'wis', occultism: 'int', performance: 'cha', religion: 'wis', society: 'int', stealth: 'dex', survival: 'wis', thievery: 'dex' };
export const STAGES = [
  { id: 'young', label: 'Young' },
  { id: 'mature', label: 'Mature' },
  { id: 'nimble', label: 'Nimble' },
  { id: 'savage', label: 'Savage' },
  { id: 'indomitable', label: 'Indomitable' },
];
const INCREDIBLE = ['nimble', 'savage', 'indomitable'];
export const EIDOLON_PRIMARY = [
  { id: 'd8', label: '1d8 + one trait', die: 'd8', traits: [] },
  { id: 'fatal', label: '1d6 fatal d10', die: 'd6', traits: ['fatal-d10'] },
  { id: 'forceful', label: '1d6 forceful, sweep', die: 'd6', traits: ['forceful', 'sweep'] },
  { id: 'deadly', label: '1d6 deadly d8, finesse', die: 'd6', traits: ['deadly-d8', 'finesse'] },
];
export const EIDOLON_D8_TRAITS = ['disarm', 'nonlethal', 'shove', 'trip'];
export const DAMAGE_TYPES = ['bludgeoning', 'piercing', 'slashing'];
// Player Core specializations; others (from other books) use what their data says.
const SPEC = {
  ambusher: { attrs: { dex: 1 }, up: ['stealth'], unarmored: 2 },
  bully: { attrs: { str: 1, cha: 3 }, up: ['athletics', 'intimidation'] },
  daredevil: { attrs: { dex: 1 }, skills: { acrobatics: 3 }, unarmored: 2 },
  racer: { attrs: { con: 1 }, fort: 4, speed: 10 },
  tracker: { attrs: { wis: 1 }, up: ['survival'] },
  wrecker: { attrs: { str: 1 }, skills: { athletics: 3 } },
};
const RANK_NAME = ['untrained', 'trained', 'expert', 'master', 'legendary'];
const prof = (rank, L) => (rank ? L + 2 * rank : 0);
const grow = (size) => (SIZE_ORDER.indexOf(size) <= 2 ? SIZE_ORDER[Math.min(3, SIZE_ORDER.indexOf(size) + 1)] : size);
const speedText = (land, other) => [land != null ? `${land} feet` : null, ...other.map((s) => `${titleCase(s.type)} ${s.value} feet`)].filter(Boolean).join(', ');
// AC or a save without circumstance and status modifiers (a familiar uses yours that way).
const plain = (stat) => (stat ? stat.total - (stat.mods || []).filter((m) => m.type === 'circumstance' || m.type === 'status').reduce((a, m) => a + (m.value || 0), 0) : 0);

/** What the character's feats and class say about companions: {animal, stage, familiar, eidolon, abilities}. */
export function hints(ch) {
  const slugs = new Set([...(ch.feats || []).map((f) => f.rec.slug), ...(ch.features || []).map((f) => f.rec.slug)]);
  const has = (re) => [...slugs].some((s) => re.test(s));
  const stage = has(/^specialized-(companion|beastmaster|megafauna|mount|spirit)/) ? 'specialized'
    : has(/^incredible-(companion|beastmaster|mount|megafauna|dragon)/) ? 'incredible'
      : has(/^mature-(animal-companion|beastmaster|dragon|megafauna|trained)/) ? 'mature' : 'young';
  return {
    animal: has(/animal-companion|beastmaster|cavalier|mount|megafauna/),
    stage,
    familiar: (ch.familiarAbilities || 0) > 0 || has(/familiar/),
    eidolon: ch.class?.slug === 'summoner' || has(/^summoner-dedication/),
    abilities: Math.max(2, ch.familiarAbilities || 0),
  };
}

function base(cfg, kind, extra) {
  return Object.assign({ id: cfg.id, kind, name: cfg.name || '', notes: cfg.notes || '', abilities: [], strikes: [], skills: [], senses: [], traits: [], warnings: [] }, extra);
}

/** Animal companion statblock. cfg: {type, stage, specs[], racerSpeed, barding{item, dexCap}} */
export function animalStats(cfg, ch, data) {
  const t = (data.animal || []).find((x) => x.slug === cfg.type);
  const L = ch.level;
  if (!t) return base(cfg, 'animal', { missing: true, level: L, warnings: ['Pick a companion type.'] });
  const stage = STAGES.some((s) => s.id === cfg.stage) ? cfg.stage : 'young';
  const A = Object.assign({ str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 }, t.attrs);
  let size = t.size || 'sm';
  const R = { unarmed: 1, unarmored: 1, barding: 1, fortitude: 1, reflex: 1, will: 1, perception: 1 };
  const S = { acrobatics: 1, athletics: 1 };
  for (const s of t.skills || []) S[s] = Math.max(S[s] || 0, 1);
  let dice = 1, extra = 0, magical = false, maneuver = false, speedBonus = 0;
  const add = (o) => { for (const [k, v] of Object.entries(o || {})) A[k] += v; };
  const isType = (s) => (t.skills || []).includes(s);
  if (stage !== 'young') {
    size = grow(size);
    add({ str: 1, dex: 1, con: 1, wis: 1 });
    R.perception = R.fortitude = R.reflex = R.will = 2;
    for (const s of ['intimidation', 'stealth', 'survival']) S[s] = isType(s) ? 2 : Math.max(S[s] || 0, 1);
    dice = 2;
  }
  if (stage === 'nimble') { add({ dex: 2, str: 1, con: 1, wis: 1 }); S.acrobatics = Math.max(S.acrobatics, 2); extra = 2; }
  if (stage === 'savage') { size = grow(size); add({ str: 2, dex: 1, con: 1, wis: 1 }); S.athletics = Math.max(S.athletics, 2); extra = 3; }
  if (stage === 'indomitable') { size = grow(size); add({ con: 2, str: 1, dex: 1, wis: 1 }); S.athletics = Math.max(S.athletics, 2); R.barding = 2; extra = 3; }
  if (INCREDIBLE.includes(stage)) { magical = true; maneuver = true; }
  const specs = INCREDIBLE.includes(stage) ? (cfg.specs || []).map((s) => (data.specializations || []).find((x) => x.slug === s)).filter(Boolean) : [];
  if (specs.length) {
    R.unarmed = 2; R.perception = R.fortitude = R.reflex = R.will = 3;
    add({ dex: 1, int: 2 });
    dice = 3; extra *= 2;
  }
  for (const sp of specs) {
    const h = SPEC[sp.slug];
    if (h) {
      add(h.attrs);
      for (const s of h.up || []) S[s] = isType(s) && (S[s] || 0) >= 2 ? Math.max(S[s], 3) : Math.max(S[s] || 0, 2);
      for (const [s, r] of Object.entries(h.skills || {})) S[s] = Math.max(S[s] || 0, r);
      if (h.unarmored) R.unarmored = Math.max(R.unarmored, h.unarmored);
      if (h.fort) R.fortitude = Math.max(R.fortitude, h.fort);
      if (h.speed) speedBonus = h.speed;
    } else {
      add(sp.attrs);
      for (const [s, r] of Object.entries(sp.skills || {})) S[s] = Math.max(S[s] || 0, r);
      for (const [d, r] of Object.entries(sp.defs || {})) if (d in R) R[d] = Math.max(R[d], r);
    }
  }
  const barding = cfg.barding || {};
  const item = Math.max(0, Math.min(3, Number(barding.item) || 0));
  const dexCap = barding.dexCap === '' || barding.dexCap == null ? null : Number(barding.dexCap);
  const acRank = item ? R.barding : R.unarmored;
  const ac = 10 + (dexCap == null ? A.dex : Math.min(A.dex, dexCap)) + prof(acRank, L) + item;
  const hp = Math.max(1, (t.hp || 6) + (6 + A.con) * L);
  // Speeds: Racer adds +10 (status) to the one picked.
  let land = t.speed ?? 25;
  const other = (t.speeds || []).map((s) => ({ ...s }));
  if (speedBonus) {
    const pick = cfg.racerSpeed || 'land';
    if (pick === 'land') land += speedBonus; else { const s = other.find((x) => x.type === pick); if (s) s.value += speedBonus; else land += speedBonus; }
  }
  const strikes = (t.strikes || []).map((s) => {
    const traits = [...(s.traits || []), ...(magical ? ['magical'] : [])];
    const ranged = !!s.range;
    const atkAttr = ranged ? 'dex' : traits.includes('finesse') && A.dex > A.str ? 'dex' : 'str';
    const bonus = A.str + extra;
    return { name: s.name, attack: A[atkAttr] + prof(R.unarmed, L), damage: `${dice}${s.die}${bonus ? (bonus > 0 ? '+' : '') + bonus : ''} ${s.type || ''}`.trim(), traits, range: s.range || null };
  });
  const skills = Object.entries(S).filter(([, r]) => r > 0).map(([s, r]) => ({ name: titleCase(s), rank: r, mod: A[SKILL_ATTR[s] || 'int'] + prof(r, L) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const abilities = [];
  if (t.support) abilities.push({ ...t.support, name: 'Support benefit', act: t.support.act || '1' });
  if (maneuver && t.maneuver) abilities.push({ ...t.maneuver, tag: 'Advanced maneuver' });
  for (const sp of specs) abilities.push({ name: sp.name, desc: sp.desc, tag: 'Specialization' });
  return base(cfg, 'animal', {
    type: t, typeName: t.name, level: L, stage, stageLabel: (STAGES.find((s) => s.id === stage) || {}).label + (specs.length ? ', specialized' : ''),
    size, traits: [...(t.traits || []), 'minion'], rarity: t.rarity, attrs: A,
    hp: { max: hp }, ac, saves: { fortitude: A.con + prof(R.fortitude, L), reflex: A.dex + prof(R.reflex, L), will: A.wis + prof(R.will, L) },
    perception: A.wis + prof(R.perception, L), ranks: R, senses: t.senses || [], speed: speedText(land, other), skills, strikes, abilities,
    notesAuto: [magical ? 'Its unarmed attacks are magical (they ignore resistances that magic bypasses).' : null,
      'Only item bonuses to AC (up to +3, from barding) and Speed apply to it.'].filter(Boolean),
  });
}

/** Familiar statblock. cfg: {abilities[], extra} */
export function familiarStats(cfg, ch, data) {
  const L = ch.level;
  const byslug = new Map((data.familiar || []).map((x) => [x.slug, x]));
  const picked = (cfg.abilities || []).map((s) => byslug.get(s)).filter(Boolean);
  const entry = (ch.spellcasting?.entries || [])[0];
  const castAttr = entry?.attr || 'cha';
  const castMod = ch.attrs?.[castAttr] ?? 0;
  const keyMod = Math.max(3, castMod);
  const has = (s) => picked.some((p) => p.slug === s);
  const other = [];
  for (const p of picked) for (const s of p.speeds || []) if (!other.some((x) => x.type === s.type)) other.push({ ...s });
  if (has('amphibious') && !other.some((x) => x.type === 'swim')) other.push({ type: 'swim', value: 25 });
  let land = 25;
  const senses = ['Low-light vision'];
  for (const p of picked) for (const s of p.senses || []) if (!senses.includes(s)) senses.push(s);
  const traits = ['minion', has('construct') ? 'construct' : has('dragon') ? 'dragon' : has('plant') ? 'plant' : has('fungus') ? 'fungus' : has('elemental') ? 'elemental' : 'animal'];
  const max = Math.max(0, hints(ch).abilities + (Number(cfg.extra) || 0));
  const skills = [{ name: 'Acrobatics', mod: L + keyMod }, { name: 'Stealth', mod: L + keyMod }];
  const warnings = picked.length > max ? [`${picked.length} abilities picked, but it gets ${max} a day.`] : [];
  return base(cfg, 'familiar', {
    level: L, size: 'tiny', traits, hp: { max: 5 * L + (has('tough') ? 2 * L : 0) },
    ac: plain(ch.ac), saves: { fortitude: plain(ch.saves.fortitude), reflex: plain(ch.saves.reflex), will: plain(ch.saves.will) },
    perception: L + keyMod, senses, speed: speedText(land, other), skills, strikes: [],
    abilities: picked.map((p) => ({ name: p.name, act: p.act, traits: p.traits, desc: p.desc })),
    abilityCount: { picked: picked.length, max }, warnings,
    notesAuto: [`Other skill checks and attack rolls: +${L} (your level).`, `Perception, Acrobatics and Stealth use your level + ${castMod > 3 ? titleCase(castAttr) : '3'}.`],
  });
}

/** Eidolon statblock. cfg: {type, kas, size, boosts{5:[],10:[],15:[],20:[]}, primary{name,option,trait,dmg}, secondary{name,dmg}} */
export function eidolonStats(cfg, ch, data) {
  const t = (data.eidolons || []).find((x) => x.slug === cfg.type);
  const L = ch.level;
  if (!t) return base(cfg, 'eidolon', { missing: true, level: L, warnings: ['Pick an eidolon type.'] });
  const kas = cfg.kas === 'dex' ? { str: 2, dex: 4, item: 1, cap: 4 } : { str: 4, dex: 2, item: 2, cap: 3 };
  const A0 = { str: kas.str, dex: kas.dex, con: 0, int: 0, wis: 0, cha: 0 };
  for (const [k, v] of Object.entries(t.up || {})) A0[k] = Math.max(A0[k], v);
  for (const [k, v] of Object.entries(t.down || {})) A0[k] = Math.min(A0[k], v);
  // Attribute boosts at 5th, 10th, 15th and 20th: +1, or half a point once it's +4 or more.
  const A = { ...A0 };
  for (const lvl of [5, 10, 15, 20]) {
    if (L < lvl) continue;
    for (const a of (cfg.boosts || {})[lvl] || []) if (a in A) A[a] += A[a] >= 4 ? 0.5 : 1;
  }
  for (const a of ATTRS6) A[a] = Math.floor(A[a]);
  const R = ch.ranks || {};
  const unarmed = L >= 13 ? 3 : L >= 5 ? 2 : 1;
  const unarmored = L >= 19 ? 3 : L >= 11 ? 2 : 1;
  const potency = ch.armor ? (ch.armor.potency || ch.armor.rec?.runes?.potency || 0) : 0;
  const resilient = ch.armor ? (ch.armor.resilient || ch.armor.rec?.runes?.resilient || 0) : 0;
  const hw = (ch.inventory || []).find((x) => x.rec?.slug === 'handwraps-of-mighty-blows' && (x.invested || x.equipped || x.worn));
  const hwPot = hw ? (hw.potency ?? hw.rec?.runes?.potency ?? 0) : 0;
  const hwStr = hw ? (hw.striking ?? hw.rec?.runes?.striking ?? 0) : 0;
  const ac = 10 + Math.min(A.dex, kas.cap) + prof(unarmored, L) + kas.item + potency;
  const spec = L >= 7 ? [0, 0, 2, 3, 4][unarmed] * (L >= 15 ? 2 : 1) : 0;
  const strike = (name, die, traits, dmg) => {
    const fin = traits.includes('finesse');
    const atk = (fin ? Math.max(A.str, A.dex) : A.str) + prof(unarmed, L) + hwPot;
    const bonus = A.str + spec;
    return { name: name || 'attack', attack: atk, damage: `${1 + hwStr}${die}${bonus ? (bonus > 0 ? '+' : '') + bonus : ''} ${dmg || ''}`.trim(), traits };
  };
  const p = cfg.primary || {};
  const opt = EIDOLON_PRIMARY.find((o) => o.id === p.option) || EIDOLON_PRIMARY[0];
  const pTraits = [...opt.traits, ...(opt.id === 'd8' && p.trait ? [p.trait] : [])];
  const s2 = cfg.secondary || {};
  const strikes = [strike(p.name || 'primary attack', opt.die, pTraits, p.dmg || 'slashing'), strike(s2.name || 'secondary attack', 'd6', ['agile', 'finesse'], s2.dmg || 'bludgeoning')];
  const skills = (t.skills || []).map((s) => ({ name: titleCase(s), rank: 1, mod: A[SKILL_ATTR[s] || 'int'] + prof(1, L) }));
  const ab = t.abilities || {};
  const abilities = [];
  if (ab.initial) abilities.push({ ...ab.initial, tag: 'Initial ability' });
  if (ab.symbiosis) abilities.push({ ...ab.symbiosis, tag: 'Symbiosis (7th)', locked: L < 7 });
  if (ab.transcendence) abilities.push({ ...ab.transcendence, tag: 'Transcendence (17th)', locked: L < 17 });
  const evolutions = (ch.feats || []).filter((f) => (f.rec.traits || []).includes('evolution')).map((f) => f.rec);
  const size = (t.sizes || []).includes(cfg.size) ? cfg.size : t.size || 'med';
  return base(cfg, 'eidolon', {
    type: t, typeName: t.name, level: L, size, traits: t.traits || ['eidolon'], attrs: A, sharedHp: true,
    hp: { max: ch.hp?.max || 0 }, ac,
    saves: { fortitude: A.con + prof(R.saves?.fortitude || 1, L) + resilient, reflex: A.dex + prof(R.saves?.reflex || 1, L) + resilient, will: A.wis + prof(R.saves?.will || 1, L) + resilient },
    perception: A.wis + prof(R.perception || 1, L), senses: t.senses ? [t.senses] : [], speed: t.speedText || `${t.speed} feet`, skills, strikes,
    abilities: abilities.filter((a) => !a.locked), lockedAbilities: abilities.filter((a) => a.locked), evolutions,
    language: t.language, tradition: t.tradition,
    notesAuto: ['Shares your Hit Points and your actions.',
      `Unarmed attacks ${RANK_NAME[unarmed]}, unarmored defense ${RANK_NAME[unarmored]}; Perception and saves use your proficiency.`,
      hw ? 'Uses the runes on your handwraps of mighty blows.' : 'Invest handwraps of mighty blows to give its attacks runes.'],
  });
}

export function companionStats(cfg, ch, data) {
  if (cfg.kind === 'familiar') return familiarStats(cfg, ch, data);
  if (cfg.kind === 'eidolon') return eidolonStats(cfg, ch, data);
  return animalStats(cfg, ch, data);
}
export const KIND_LABEL = { animal: 'Animal companion', familiar: 'Familiar', eidolon: 'Eidolon' };
