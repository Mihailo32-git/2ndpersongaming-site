// Pathbuilder 2e import: turns a Pathbuilder "Export JSON" file into a character for this site.
// Pathbuilder stores names and final numbers; this site stores the choices behind them, so the import
// rebuilds those choices (boosts, feats in their slots, the options of each feat, skill training and
// increases, spells, gear) and then checks the result against Pathbuilder's own numbers.

import { newBuild, BOOST_LEVELS } from './engine.js';
import { refOf } from './data.js';
import { PB_NAMES } from './pbnames.js';
import { ATTRS, SKILLS, sluggify, uid } from './util.js';

/** Is this object a Pathbuilder export? ({success, build:{…}} or the bare build) */
export function isPathbuilder(data) {
  const b = data && (data.build || data);
  return !!(b && typeof b === 'object' && typeof b.class === 'string' && b.abilities && b.proficiencies && Array.isArray(b.feats));
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[’'`]/g, '').replace(/\s*\((legacy|remastered|premaster|pre-master)\)\s*$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const attrOf = (s) => { const a = String(s || '').toLowerCase().slice(0, 3); return ATTRS.includes(a) ? a : null; };
const rankOf = (p) => Math.max(0, Math.min(4, Math.round((Number(p) || 0) / 2)));

/** Name lookups, forgiving about punctuation, "(Legacy)" and "Prefix: Name" forms. */
function makeFinder(db) {
  const idx = {};
  const index = (pack) => {
    if (!idx[pack]) {
      idx[pack] = new Map();
      for (const r of db.list(pack)) {
        const k = norm(r.name);
        const prev = idx[pack].get(k);
        // Prefer remastered and common entries when two share a name.
        if (!prev || (prev.rem === false && r.rem !== false) || (prev.rarity !== 'common' && r.rarity === 'common' && prev.rem === r.rem)) idx[pack].set(k, r);
      }
    }
    return idx[pack];
  };
  return (packs, name) => {
    if (name == null || name === '') return null;
    const list = Array.isArray(packs) ? packs : [packs];
    const raw = String(name).replace(/\s*\[(?:placeholder|reaction|free action|one action|two actions)\]\s*$/i, '');
    const base = [raw, raw.replace(/\s*\([^)]*\)\s*$/, ''), raw.replace(/^[^:]+:\s*/, ''), raw.replace(/^[^:]+:\s*/, '').replace(/\s*\([^)]*\)\s*$/, ''),
      raw.replace(/ (?:I|II|III)$/, ''), raw.replace(/judgement/gi, 'judgment')];
    // A combination weapon's two halves: "Piercing Wind - Ranged" / "- Melee" are the one weapon.
    if (/ - (?:melee|ranged)$/i.test(raw)) base.push(raw.replace(/ - (?:melee|ranged)$/i, ''));
    // "Elemental Ammunition - Fire (Moderate)" is "Elemental Ammunition (Moderate, Fire)" here; "X - Fire" is "X (Fire)".
    const dash = raw.match(/^(.+?) - (.+?)(?: \((.+)\))?$/);
    if (dash) base.push(...(dash[3] ? [`${dash[1]} (${dash[3]}, ${dash[2]})`, `${dash[1]} (${dash[2]}, ${dash[3]})`, `${dash[1]} (${dash[3]})`] : [`${dash[1]} (${dash[2]})`]));
    const tries = [];
    for (const t of base) { tries.push(t); if (PB_NAMES[t]) tries.push(PB_NAMES[t]); }
    for (const t of tries) {
      for (const p of list) {
        const r = index(p).get(norm(t)) || db.get('@' + p + '/' + sluggify(t));
        if (r) return r;
      }
    }
    // "Counterspell" is "Counterspell (Prepared)" / "(Spontaneous)" in pf2e: take a variant when the name only lacks the brackets.
    const want = norm(raw) + ' ';
    for (const p of list) for (const [k, r] of index(p)) if (k.startsWith(want) && /\)$/.test(r.name)) return r;
    return null;
  };
}

/**
 * Converts a Pathbuilder export. db must have the core packs (and 'equipment') loaded.
 * Returns { build, state, notes: [strings], check: { attrs, skills, hp } } — check lists any numbers that still differ.
 */
export function convertPathbuilder(data, db, engine) {
  const pb = data.build || data;
  const find = makeFinder(db);
  const notes = [];
  const missing = (what, name) => notes.push(`${what} not found: ${name}`);
  const b = newBuild();
  const state = { prep: {} };

  // ---------------------------------------------------------------- identity
  b.name = pb.name || 'Imported character';
  b.level = Math.max(1, Math.min(20, Number(pb.level) || 1));
  const anc = find('ancestries', pb.ancestry);
  const cls = find('classes', pb.class);
  const bg = find('backgrounds', pb.background);
  if (anc) b.ancestry = anc.slug; else missing('Ancestry', pb.ancestry);
  if (cls) b.class = cls.slug; else missing('Class', pb.class);
  if (bg) b.background = bg.slug; else if (pb.background) missing('Background', pb.background);
  if (pb.heritage) {
    const her = find('heritages', pb.heritage) || find('heritages', `${pb.heritage} ${pb.ancestry}`) || find('heritages', `${pb.ancestry} ${pb.heritage}`);
    if (her) b.heritage = her.slug; else missing('Heritage', pb.heritage);
  }
  if (pb.dualClass) notes.push(`Dual class (${pb.dualClass}) isn't supported; imported as ${pb.class}.`);
  b.details.deity = pb.deity && pb.deity !== 'Not set' ? pb.deity : '';
  b.details.age = pb.age ? String(pb.age) : '';
  b.details.appearance = [pb.gender, pb.alignment && pb.alignment !== 'N' ? pb.alignment : ''].filter(Boolean).join(' · ');
  b.details.notes = 'Imported from Pathbuilder.';

  // ---------------------------------------------------------------- feats: which slots they go in
  const feats = (pb.feats || []).filter((f) => Array.isArray(f) && f.length >= 4);
  const usesFA = feats.some((f) => /free archetype/i.test(f[4] || ''));
  b.options.freeArchetype = usesFA;
  const ancFeats = feats.filter((f) => f[2] === 'Ancestry Feat' && !(f[5] === 'childChoice'));
  const normalAnc = (cls?.ancestryFeatLevels || [1, 5, 9, 13, 17]).filter((l) => l <= b.level).length;
  if (ancFeats.length > normalAnc) b.options.ancestryParagon = true;
  b.options.showRare = true;

  // ---------------------------------------------------------------- attribute boosts
  const bd = pb.abilities?.breakdown || {};
  const lc = (list) => (list || []).map(attrOf).filter(Boolean);
  if (anc) {
    const fixed = (anc.boosts || []).filter((e) => e.length === 1).map((e) => e[0]);
    const pbFixed = lc(bd.ancestryBoosts);
    const free = lc(bd.ancestryFree);
    if (fixed.length && !pbFixed.length && free.length >= 2) { b.options.altAncestryBoosts = true; b.boosts.ancestryAlt = free.slice(0, 2); } else b.boosts.ancestry = free;
    const extraFlaws = lc(bd.ancestryFlaws).filter((f) => !(anc.flaws || []).some((e) => e.length === 1 && e[0] === f));
    if (extraFlaws.length) notes.push(`Voluntary flaws (${extraFlaws.join(', ')}) aren't supported; your scores may differ there.`);
  }
  if (bg) {
    // Background: each entry takes one of Pathbuilder's picks that fits it.
    const pbBg = lc(bd.backgroundBoosts);
    const entries = (bg.boosts || []).filter((e) => e.length);
    const out = [];
    const used = new Set();
    const order = entries.map((e, i) => i).sort((x, y) => entries[x].length - entries[y].length);
    for (const i of order) { const v = pbBg.find((a) => entries[i].includes(a) && !used.has(a)); if (v) { out[i] = v; used.add(v); } }
    b.boosts.background = entries.map((e, i) => out[i] || null);
  }
  b.boosts.class = attrOf(pb.keyability) || lc(bd.classBoosts)[0] || null;
  const lvBoosts = bd.mapLevelledBoosts || {};
  const gradual = Object.keys(lvBoosts).some((k) => Number(k) > 1 && Number(k) % 5 !== 0);
  if (gradual) b.options.gradualBoosts = true;
  for (const [k, list] of Object.entries(lvBoosts).sort((x, y) => Number(x[0]) - Number(y[0]))) {
    const lv = Number(k);
    const target = lv <= 1 ? 1 : BOOST_LEVELS.find((x) => lv <= x) || 20;
    b.boosts[target] = [...(b.boosts[target] || []), ...lc(list)].slice(0, 4);
  }
  // Older exports have no breakdown, and some have gaps: then work the boosts out from the final scores.
  {
    const chA = engine.compute(b);
    const want = Object.fromEntries(ATTRS.map((a) => [a, Math.floor(((Number(pb.abilities?.[a]) || 10) - 10) / 2)]));
    if (ATTRS.some((a) => chA.attrs[a] !== want[a])) solveBoosts(b, chA, want);
  }

  // ---------------------------------------------------------------- feats into slots
  let ch = engine.compute(b);
  const slots = engine.featSlots(b, ch.class);
  const used = new Set();
  const locKey = {};          // Pathbuilder location ("Elf Feat 5") → our item key ("feat:ancestry-5")
  const featHints = {};       // item key → Pathbuilder text for its own choices (Assurance → "Athletics")
  const classWord = norm(pb.class);
  const typeFromLoc = (loc, type) => {
    const l = norm(loc);
    if (/free archetype/.test(l)) return 'archetype';
    if (/^skill feat/.test(l) || /^skill lessons/.test(l)) return 'skill';
    if (/^general feat/.test(l)) return 'general';
    // Feats a class feature hands out (kineticist impulses, a wizard's thesis, a summoner's evolution…): no slot of their own.
    if (/impulse feat|element choice|arcane thesis|voice of nature|evolution feat|stylist tricks/.test(l)) return 'grant';
    // "Barbarian FeatFury Instinct", "Wizard FeatWizard Universalist": a class feat handed out by that feature (Fury
    // Instinct's extra 1st-level feat, a universalist's bonus feat). It answers the feature's own choice, not a slot.
    if (l.startsWith(classWord + ' feat') && !/ feat \d+$/.test(l) && l !== classWord + ' feat') return 'grant';
    if (l.startsWith(classWord + ' feat')) return 'class';
    if (/ feat \d+$/.test(l)) return 'ancestry';
    return { 'Ancestry Feat': 'ancestry', 'Class Feat': 'class', 'Skill Feat': 'skill', 'General Feat': 'general', 'Archetype Feat': usesFA ? 'archetype' : 'class' }[type] || null;
  };
  const children = [];
  const grantFeats = [];
  const awarded = [];
  for (const f of feats) {
    const [name, extra, type, level, loc, kind] = f;
    if (type === 'Heritage') continue;
    if (kind === 'childChoice') { children.push(f); continue; }
    let rec = find('feats', name);
    // Class feats that share a name with another class's feat: "Signature Spell Expansion" for a psychic is
    // "Signature Spell Expansion (Psychic)" here (the plain one is the sorcerer's).
    if (type === 'Class Feat' && pb.class && rec && !(rec.traits || []).includes(sluggify(pb.class))) {
      const alt = find('feats', `${name} (${pb.class})`);
      if (alt && alt !== rec && (alt.traits || []).includes(sluggify(pb.class))) rec = alt;
    }
    if (type === 'Awarded Feat') {
      // Given by a background or feature: already part of the character if the source is.
      // Checked after the choices are made (a cleric's doctrine gives Shield Block only once it's picked).
      if (rec) awarded.push({ name, extra, rec });
      continue;
    }
    if (/mythic/i.test(type)) { notes.push(`Mythic feat skipped: ${name}`); continue; }
    if (!rec) { missing('Feat', name); continue; }
    const t = typeFromLoc(loc || '', type);
    const lv = Number(level) || 1;
    if (t === 'grant') { grantFeats.push({ name, rec }); continue; }
    let slot = slots.find((s) => !used.has(s.id) && s.type === t && s.level === lv)
      || slots.find((s) => !used.has(s.id) && s.type === t && s.level <= lv && s.level >= lv - 1)
      || (t === 'class' ? slots.find((s) => !used.has(s.id) && s.type === 'archetype' && s.level === lv) : null)
      || (t === 'archetype' ? slots.find((s) => !used.has(s.id) && s.type === 'class' && s.level === lv) : null);
    if (!slot) {
      // Often a feat another feat or feature gives you (General Training, Natural Ambition…): fine if it's already there.
      if (!engine.compute(b).feats.some((x) => x.rec.slug === rec.slug)) notes.push(`No free ${t || 'feat'} slot at level ${lv} for ${name}`);
      continue;
    }
    used.add(slot.id);
    b.feats[slot.id] = rec.slug;
    if (loc) locKey[norm(loc)] = 'feat:' + slot.id;
    if (extra) featHints['feat:' + slot.id] = [extra];
  }
  locKey[norm('Heritage Feat')] = 'heritage';
  // "Scholar (Arcana)", "Martial Disciple (Acrobatics)": the part in brackets answers the background's own choice.
  const paren = (x) => (String(x || '').match(/\(([^)]+)\)\s*$/) || [])[1];
  if (paren(pb.background)) featHints.background = [paren(pb.background)];
  if (paren(pb.heritage)) featHints.heritage = [...(featHints.heritage || []), paren(pb.heritage)];
  for (const f of children) {
    // A feat chosen inside another feat (Basic Thoughtform → Warp Space; Ancient Elf → a dedication).
    const parent = locKey[norm(f[6] || '')];
    if (parent) (featHints[parent] = featHints[parent] || []).push(f[0]);
    if (f[1]) {
      const r = find('feats', f[0]);
      if (r) (featHints['child:' + r.slug] = featHints['child:' + r.slug] || []).push(f[1]);
    }
  }

  // ---------------------------------------------------------------- choices inside items
  const allText = new Set();
  const textOrder = [];
  // Older names Pathbuilder still uses for things the remaster renamed.
  const OLD_NAMES = { 'superstitious instinct': 'superstition instinct' };
  const addText0 = (s) => { const n = norm(s); if (OLD_NAMES[n]) { textOrder.push(OLD_NAMES[n]); allText.add(OLD_NAMES[n]); } };
  const addText = (s) => { addText0(s); if (!s) return; const inner = String(s).match(/\(([^)]+)\)\s*$/); if (inner) { textOrder.push(norm(inner[1])); allText.add(norm(inner[1])); } textOrder.push(norm(String(s).replace(/^[^:]+:\s*/, ''))); allText.add(norm(s)); const after = String(s).replace(/^[^:]+:\s*/, ''); allText.add(norm(after)); allText.add(norm(after.replace(/\s*\([^)]*\)\s*$/, ''))); };
  for (const f of feats) { addText(f[0]); addText(f[1]); }
  for (const s of pb.specials || []) addText(s);
  addText(pb.deity); addText(pb.heritage); addText(paren(pb.background));
  for (const l of pb.lores || []) addText(Array.isArray(l) ? l[0] : l);
  // A cleric's font spells name the Divine Font (Heal or Harm).
  for (const c of pb.spellCasters || []) if (/ font$/i.test(c.name || '')) for (const g of c.spells || []) for (const x of g.list || []) addText(x);
  if (pb.keyability) addText({ str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' }[pb.keyability]);
  const optNames = (o) => {
    const out = [norm(o.label)];
    if (typeof o.value === 'string') {
      out.push(norm(o.value.replace(/^@?[\w-]+\//, '').replace(/-/g, ' ')));
      const r = db.get(o.value.startsWith('@') ? o.value : null);
      if (r) out.push(norm(r.name));
    }
    return out.filter(Boolean);
  };
  const hintsFor = (c) => {
    const h = [...(featHints[c.key] || [])];
    const slug = c.item?.rec?.slug;
    if (slug && featHints['child:' + slug]) h.push(...featHints['child:' + slug]);
    return h.map(norm);
  };
  const awardHints = () => {
    for (const a of awarded) if (a.extra) { const inst = ch.feats.find((x) => x.rec.slug === a.rec.slug); if (inst && !featHints[inst.key]) featHints[inst.key] = [a.extra]; }
  };
  const sibUsed = {};
  const kindUsed = {};
  const grantUsed = new Set();
  for (let pass = 0; pass < 25; pass++) {
    ch = engine.compute(b);
    awardHints();
    let changed = false;
    for (const c of ch.choices) {
      if (c.value != null) continue;
      const opts = c.options.filter((o) => o.available !== false);
      if (!opts.length) continue;
      const hints = hintsFor(c);
      let pick = hints.length ? opts.find((o) => optNames(o).some((n) => hints.includes(n))) : null;
      if (!pick) {
        // "Battle Mystery", "Fire Element": the option's name followed by what the choice is about.
        const nouns = new Set([String(c.prompt || '').trim().split(/\s+/).pop(), String(c.item?.rec?.name || '').trim().split(/\s+/).pop()]
          .map((w) => norm(String(w || '').replace(/s$/, ''))).filter((w) => w && w.length > 2));
        // "Fire Gate" is written "Fire Element": also try the label without the item's own last word.
        const itemWord = norm(String(c.item?.rec?.name || '').trim().split(/\s+/).pop() || '');
        const names = (o) => { const n = optNames(o); const short = n[0].replace(new RegExp('\\s*' + itemWord + '$'), ''); return short && short !== n[0] ? [...n, short] : n; };
        const named = (o) => names(o).some((n) => allText.has(n) || [...nouns].some((w) => allText.has(n + ' ' + w)));
        const hits = opts.filter(named);
        // Several options named somewhere in the export (e.g. two skills): only take it when it's clear.
        if (hits.length === 1 || (hits.length > 1 && c.deityChoice)) pick = hits[0];
        // Feats Pathbuilder lists as handed out by a feature: they answer these choices, in order.
        else if (hits.length > 1 && grantFeats.some((g) => !grantUsed.has(g.rec?.slug))) {
          const gi = (o) => grantFeats.findIndex((g) => g.rec && !grantUsed.has(g.rec.slug) && (o.value === refOf(g.rec) || names(o).includes(norm(g.name))));
          pick = hits.filter((o) => gi(o) >= 0).sort((x, y) => gi(x) - gi(y))[0] || null;
          if (pick) grantUsed.add(grantFeats[gi(pick)].rec.slug);
        }
        // The same choice made several times (a gate junction at 5th, 9th, 13th…): take them in the export's order.
        if (!pick && hits.length > 1) {
          const sib = (c.item?.rec?.slug || '') + '|' + c.flag;
          const siblings = ch.choices.filter((x) => (x.item?.rec?.slug || '') + '|' + x.flag === sib).length;
          if (siblings > 1) {
            const used = sibUsed[sib] = sibUsed[sib] || new Set();
            const first = (o) => { let best = Infinity; for (const n of names(o)) { const i = textOrder.findIndex((t) => t === n || t === n + ' ' + itemWord || [...nouns].some((w) => t === n + ' ' + w)); if (i >= 0 && i < best) best = i; } return best; };
            pick = hits.filter((o) => !used.has(o.value)).sort((x, y) => first(x) - first(y))[0] || null;
            if (pick) used.add(pick.value);
          }
        }
        // The same kind of choice on different features: a bard's muse (or Bard Dedication's) and Multifarious Muse's
        // second muse. Pathbuilder lists features in the order they were gained, so the feature gained first takes the
        // first of the named options, the next one the next.
        if (!pick && hits.length > 1) {
          const kind = norm(c.prompt || '');
          const lvOf = (x) => x.item?.slot?.level ?? (String(x.key).startsWith('cf:') ? (x.item?.rec?.level ?? 1) : 99);
          const peers = ch.choices.filter((x) => x !== c && x.value == null && norm(x.prompt || '') === kind && x.options.some((o) => named(o)));
          const earliest = [c, ...peers].sort((a, b) => lvOf(a) - lvOf(b))[0];
          // Compared by name: one feature stores "maestro", another "@classfeatures/maestro".
          const taken = kindUsed[kind];
          const free = taken ? hits.filter((o) => !taken.has(norm(o.label))) : hits;
          // A later one of the kind, once the earlier ones are made: the named option nobody has taken yet.
          if (!peers.length && taken && free.length === 1) { pick = free[0]; taken.add(norm(pick.label)); }
          else if (peers.length && earliest === c) {
            const used = kindUsed[kind] = kindUsed[kind] || new Set();
            const pos = (o) => { let best = Infinity; for (const n of names(o)) { const i = textOrder.findIndex((t) => t === n || [...nouns].some((w) => t === n + ' ' + w)); if (i >= 0 && i < best) best = i; } return best; };
            pick = hits.filter((o) => !used.has(norm(o.label))).sort((x, y) => pos(x) - pos(y))[0] || null;
            if (pick) used.add(norm(pick.label));
          }
        }
      }
      if (!pick) continue;
      (b.choices[c.key] = b.choices[c.key] || {})[c.flag] = pick.value;
      changed = true;
    }
    if (!changed) break;
  }
  ch = engine.compute(b);
  for (const a of awarded) {
    if (!ch.feats.some((x) => x.rec.slug === a.rec.slug)) notes.push(`${a.name}: given by something this site can't track; add it as a note if it matters.`);
  }
  for (const g of grantFeats) {
    if (g.rec && !ch.feats.some((x) => x.rec.slug === g.rec.slug)) notes.push(`${g.name}: couldn't place it; pick it on the feature that grants it.`);
  }

  // ---------------------------------------------------------------- languages
  const autoLangs = new Set(ch.languages.slice(0, ch.languages.length - (b.languages || []).length));
  b.languages = (pb.languages || []).map((l) => sluggify(l)).filter((l) => l && l !== 'none-selected' && !autoLangs.has(l));

  // ---------------------------------------------------------------- skills: training picks and increases
  const target = {};
  for (const s of Object.keys(SKILLS)) target[s] = rankOf(pb.proficiencies?.[s]);
  const loreTarget = {};
  for (const l of pb.lores || []) if (Array.isArray(l) && rankOf(l[1]) > 0) loreTarget[String(l[0]).replace(/\s+lore$/i, '')] = rankOf(l[1]);
  b.skills = { class: [], int: {}, inc: {} };
  ch = engine.compute(b);
  // Choices of "a skill" that the export doesn't name (Skilled Human, Skill Training…): give them to skills that
  // Pathbuilder has trained and this character doesn't have yet.
  const skillOf = (o) => { const v = typeof o.value === 'string' ? o.value.toLowerCase() : ''; return SKILLS[v] ? v : Object.keys(SKILLS).find((k) => norm(k) === norm(o.label)) || null; };
  for (let guard = 0; guard < 12; guard++) {
    const c = ch.choices.find((x) => x.value == null && x.options.length && x.options.every((o) => skillOf(o)) && !(b.choices[x.key] || {})[x.flag]);
    if (!c) break;
    const best = c.options.filter((o) => o.available !== false).map((o) => ({ o, s: skillOf(o) }))
      .filter((x) => (ch.ranks.skills[x.s] || 0) < target[x.s]).sort((x, y) => (target[y.s] - (ch.ranks.skills[y.s] || 0)) - (target[x.s] - (ch.ranks.skills[x.s] || 0)))[0];
    (b.choices[c.key] = b.choices[c.key] || {})[c.flag] = best ? best.o.value : c.options[0].value;
    if (!best) notes.push(`${c.item?.rec?.name || 'A feat'}: picked ${c.options[0].label} for its skill (check it)`);
    ch = engine.compute(b);
  }
  // Choices of a saving throw (a monk's Path to Perfection): the save Pathbuilder has higher than this character.
  const SAVES = ['fortitude', 'reflex', 'will'];
  for (let guard = 0; guard < 6; guard++) {
    const c = ch.choices.find((x) => x.value == null && x.options.length && x.options.every((o) => SAVES.includes(String(o.value).toLowerCase())) && x.options.some((o) => o.available !== false));
    if (!c) break;
    const gap = (o) => rankOf(pb.proficiencies?.[String(o.value).toLowerCase()]) - (ch.saves?.[String(o.value).toLowerCase()]?.rank ?? ch.ranks.saves?.[String(o.value).toLowerCase()] ?? 0);
    const best = c.options.filter((o) => o.available !== false).sort((x, y) => gap(y) - gap(x))[0];
    (b.choices[c.key] = b.choices[c.key] || {})[c.flag] = best.value;
    ch = engine.compute(b);
  }
  // Skill choices with a version per rank (Captivator Dedication: "trained in Deception or Diplomacy, or expert if you
  // already were"): keep which skill, but set the choice aside until the class and Intelligence skills are handed out,
  // then take the version that applies. Otherwise it trains a skill a regular pick would have, and its expert is lost.
  const tierOf = (c) => c.options.some((o, i) => c.options.some((p, j) => j !== i && norm(p.label) === norm(o.label)));
  const tiered = [];
  for (const c of ch.choices) {
    if (c.value == null || !tierOf(c)) continue;
    const now = c.options.find((o) => o.value === c.value);
    if (!now || !skillOf(now)) continue;
    tiered.push({ key: c.key, flag: c.flag, label: norm(now.label) });
    delete b.choices[c.key][c.flag];
  }
  if (tiered.length) ch = engine.compute(b);
  const cur = { ...ch.ranks.skills };
  const curLore = {};
  const loreKey = (n) => Object.keys(ch.ranks.lores).find((k) => norm(k).replace(/ lore$/, '') === norm(n)) || n;
  for (const [n, r] of Object.entries(loreTarget)) curLore[loreKey(n)] = ch.ranks.lores[loreKey(n)] || 0;
  const loreT = Object.fromEntries(Object.entries(loreTarget).map(([n, r]) => [loreKey(n), r]));
  const untrained = () => [...Object.keys(target).filter((s) => cur[s] === 0 && target[s] >= 1).sort((a, x) => target[x] - target[a]),
    ...Object.keys(loreT).filter((n) => !curLore[n]).map((n) => 'lore:' + n)];
  const trainOne = (s) => { if (s.startsWith('lore:')) curLore[s.slice(5)] = 1; else cur[s] = 1; };
  for (let i = 0; i < (ch.classSkillPicks || 0); i++) { const s = untrained()[0]; if (!s) break; b.skills.class.push(s); trainOne(s); }
  for (const [lv, n] of Object.entries(ch.intPicks || {})) {
    for (let i = 0; i < n; i++) { const s = untrained()[0]; if (!s) break; (b.skills.int[lv] = b.skills.int[lv] || []).push(s); trainOne(s); }
  }
  if (tiered.length) {
    const chT = engine.compute(b);
    for (const t of tiered) {
      const c = chT.choices.find((x) => x.key === t.key && x.flag === t.flag);
      const opt = c && (c.options.find((o) => o.available !== false && norm(o.label) === t.label) || c.options.find((o) => norm(o.label) === t.label));
      if (opt) (b.choices[t.key] = b.choices[t.key] || {})[t.flag] = opt.value;
    }
    const chU = engine.compute(b);
    for (const k of Object.keys(cur)) cur[k] = Math.max(cur[k] || 0, chU.ranks.skills[k] || 0);
  }
  for (const lv of ch.increaseLevels || []) {
    const limit = lv >= 15 ? 4 : lv >= 7 ? 3 : 2;
    const cands = [...Object.keys(target).map((s) => ({ k: s, need: target[s] - cur[s], next: cur[s] + 1 })),
      ...Object.keys(loreT).map((n) => ({ k: 'lore:' + n, need: loreT[n] - (curLore[n] || 0), next: (curLore[n] || 0) + 1 }))]
      .filter((x) => x.need > 0 && x.next <= limit)
      // Regular skills first: Lore ranks often come from the Lore feat's own increases.
      .sort((a, x) => Number(a.k.startsWith('lore:')) - Number(x.k.startsWith('lore:')) || x.need - a.need);
    const c = cands[0];
    if (!c) continue;
    b.skills.inc[lv] = c.k;
    if (c.k.startsWith('lore:')) curLore[c.k.slice(5)] = c.next; else cur[c.k] = c.next;
  }

  // ---------------------------------------------------------------- spells
  ch = engine.compute(b);
  const spellRef = (name) => { const r = find('spells', name); if (!r) missing('Spell', name); return r ? refOf(r) : null; };
  const sc = ch.spellcasting;
  const takenInnate = new Set(sc.innate.map((s) => s.ref));
  const pbCasters = pb.spellCasters || [];
  const classCaster = pbCasters.find((c) => !c.innate && norm(c.name) === classWord) || pbCasters.find((c) => !c.innate && norm(c.name).startsWith(classWord));
  const fill = (entry, caster) => {
    if (!entry || !caster) return;
    const st = entry.id === 'class' ? b.spells : ((b.spells.arch = b.spells.arch || {})[entry.id === 'apparition' ? 'apparition' : entry.arch] = { rep: {}, book: {}, sig: {} });
    const granted = new Set((entry.granted || []).map((g) => g.ref));
    for (const grp of caster.spells || []) {
      const rank = Number(grp.spellLevel) || 0;
      const refs = [...new Set((grp.list || []).map(spellRef).filter(Boolean))].filter((r) => !granted.has(r));
      if (!refs.length) continue;
      if (entry.type === 'spontaneous') st.rep[rank] = refs;
      else if (entry.book) st.book[rank] = refs;
    }
    if (entry.type === 'prepared' && caster.prepared?.length) {
      const prep = (state.prep[entry.id] = {});
      for (const grp of caster.prepared) {
        const rank = Number(grp.spellLevel) || 0;
        (grp.list || []).map(spellRef).filter(Boolean).forEach((r, i) => { prep[`${rank}:${i}`] = { ref: r, cast: false }; });
      }
    }
  };
  fill(sc.entries.find((e) => e.id === 'class'), classCaster);
  // Archetypes whose spells are innate, one per rank (Captivator): Pathbuilder lists them as a caster of
  // their own; they go into that archetype's rank-by-rank picks.
  const innArch = ch.feats.filter((f) => f.rec.archCasting?.role === 'innate');
  const archFor = (c) => {
    const w = norm(c.name).replace(/^archetype /, '').replace(/ (dedication|spellcasting)$/, '');
    return innArch.filter((f) => norm(f.rec.arch || '') === w || norm(f.rec.name).includes(w));
  };
  const archDone = new Set();
  for (const c of pbCasters) {
    const feats = c === classCaster ? [] : archFor(c);
    if (!feats.length) continue;
    archDone.add(c);
    b.spells.innate = b.spells.innate || {};
    for (const grp of c.spells || []) {
      const rank = Number(grp.spellLevel) || 0;
      for (const name of grp.list || []) {
        const ref = spellRef(name); if (!ref) continue;
        const f = feats.find((x) => (x.rec.archCasting.ranks || []).some(([lvl, r]) => r === rank && b.level >= lvl) && !(b.spells.innate[x.rec.slug] || {})[rank]);
        if (f) (b.spells.innate[f.rec.slug] = b.spells.innate[f.rec.slug] || {})[rank] = ref;
        else if (rank > 0 || !takenInnate.has(ref)) { b.spells.innateExtra.push({ ref, rank }); }
        takenInnate.add(ref);
      }
    }
  }
  for (const c of pbCasters) {
    if (c === classCaster || c.innate || archDone.has(c)) continue;
    const word = norm(c.name).replace(/^archetype /, '').replace(/ dedication$/, '');
    const e = sc.entries.find((x) => x.id !== 'class' && (norm(x.arch || '') === word || norm(x.label).startsWith(word)));
    if (e) fill(e, c);
    else if (/eidolon/i.test(c.name)) notes.push('Eidolon spells are kept with the eidolon, which this site shows as text only.');
    else if (/ font$/i.test(c.name)) continue; // a cleric's font: comes from the Divine Font choice
    else notes.push(`Spellcasting "${c.name}" didn't match anything on this character`);
  }
  // Innate spells: fill this character's own picks first, then add the rest by hand.
  const picks = sc.picks || [];
  for (const c of pbCasters.filter((x) => x.innate && !archDone.has(x))) {
    for (const grp of c.spells || []) {
      for (const name of grp.list || []) {
        const r = find('spells', name);
        if (!r) { missing('Spell', name); continue; }
        const ref = refOf(r);
        if (takenInnate.has(ref)) continue;
        const pick = picks.find((p) => !b.spells.pick[p.key] && (p.list ? fitsList(r, p.list) : (p.options || []).some((o) => o.ref === ref)));
        if (pick) b.spells.pick[pick.key] = ref;
        else b.spells.innateExtra.push({ ref, rank: Number(grp.spellLevel) || 0 });
        takenInnate.add(ref);
      }
    }
  }
  // Focus spells the rules data didn't give automatically
  ch = engine.compute(b);
  const haveFocus = new Set([...(ch.spellcasting.focus?.spells || []), ...(ch.spellcasting.focus?.cantrips || [])].map((s) => s.ref));
  for (const byAttr of Object.values(pb.focus || {})) {
    for (const f of Object.values(byAttr || {})) {
      for (const name of [...(f.focusCantrips || []), ...(f.focusSpells || [])]) {
        const r = find('spells', name);
        if (!r) { missing('Focus spell', name); continue; }
        const ref = refOf(r);
        if (haveFocus.has(ref)) continue;
        const pick = (ch.spellcasting.picks || []).find((p) => !b.spells.pick[p.key] && (p.options || []).some((o) => o.ref === ref));
        if (pick) b.spells.pick[pick.key] = ref; else b.spells.focusExtra.push(ref);
        haveFocus.add(ref);
      }
    }
  }

  // ---------------------------------------------------------------- gear, money, formulas
  const STRIKING = { striking: 1, greaterstriking: 2, majorstriking: 3 };
  const RESILIENT = { resilient: 1, greaterresilient: 2, majorresilient: 3 };
  const item = (rec, extra) => ({ id: uid(), ref: refOf(rec), qty: 1, equipped: false, invested: false, ...extra });
  // Property runes and materials, named the way Pathbuilder names them (mapping after Pathmuncher, MIT).
  const camel = (name) => String(name).replace(/['’]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w[0].toLowerCase() + w.slice(1))).join('');
  const pbRune = (p) => {
    const res = p.match(/Energy Resistant - (.*)/i), vit = p.match(/Vitalizing(.*)/i), big = p.match(/(.*)\((Greater|Major|True|Lesser|Moderate)\)/i);
    const name = res ? `${res[1]} Resistant` : vit ? `Disrupting${vit[1]}` : big ? `${big[2]} ${big[1].trim()}` : p === 'Quickstrike' ? 'speed' : p === 'Animated' ? 'dancing' : p;
    return camel(name);
  };
  const applyRunes = (it, kind, runes, mat) => {
    const table = db.runeData ? db.runeData[kind] : null;
    const skipped = [];
    for (const p of runes || []) {
      const slug = pbRune(p);
      if (!table || table[slug]) (it.runes = it.runes || []).push(slug); else skipped.push(p);
    }
    if (mat) {
      const type = String(mat).split(' (')[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const grade = /high-grade/i.test(mat) ? 'high' : /standard-grade/i.test(mat) ? 'standard' : 'low';
      const known = !db.runeData || (db.runeData.materials[kind] || []).some((x) => x.slug === type);
      if (known) it.material = { type, grade }; else skipped.push(mat);
    }
    return skipped;
  };
  const comboSeen = new Set();
  for (const w of pb.weapons || []) {
    // Fists are on every sheet already. Runes on them come from handwraps, which arrive with the other items.
    if (norm(w.name) === 'fist') {
      const runed = Number(w.pot) || w.str || (w.runes || []).length;
      const wraps = [...(pb.weapons || []), ...(pb.equipment || [])].some((x) => /handwraps/i.test(Array.isArray(x) ? x[0] : x?.name || ''));
      if (runed && !wraps) notes.push('Fist: has runes in Pathbuilder. Add Handwraps of Mighty Blows to the inventory and put the runes on them.');
      continue;
    }
    // Pathbuilder's generic bomb attack (and the vial attack): the sheet makes these Strikes itself, from the
    // alchemist's versatile vials and the bombs actually carried or made with Advanced Alchemy.
    if (/^(alchemical bombs?|versatile vials?)$/.test(norm(w.name))) continue;
    const rec = find('equipment', w.name);
    if (!rec) { missing('Weapon', w.display || w.name); continue; }
    // A combination weapon comes as two entries (melee and ranged): it's one weapon.
    if (/ - (?:melee|ranged)$/i.test(w.name || '')) { if (comboSeen.has(rec.slug)) continue; comboSeen.add(rec.slug); }
    const wi = item(rec, { qty: Number(w.qty) || 1, equipped: true, potency: Number(w.pot) || 0, striking: STRIKING[norm(w.str).replace(/ /g, '')] || 0 });
    b.inventory.push(wi);
    const extras = applyRunes(wi, 'weapon', w.runes, w.mat);
    if (extras.length) notes.push(`${w.display || w.name}: rune or material not recognised (${extras.join(', ')}); add it with the Runes button`);
  }
  for (const a of pb.armor || []) {
    const rec = find('equipment', a.name);
    if (!rec) { missing('Armor', a.display || a.name); continue; }
    const ai = item(rec, { qty: Number(a.qty) || 1, equipped: !!a.worn, potency: Number(a.pot) || 0, resilient: RESILIENT[norm(a.res).replace(/ /g, '')] || 0 });
    b.inventory.push(ai);
    const extras = applyRunes(ai, 'armor', a.runes, a.mat);
    if (extras.length) notes.push(`${a.display || a.name}: rune or material not recognised (${extras.join(', ')}); add it with the Runes button`);
  }
  for (const e of pb.equipment || []) {
    const [name, qty, tag] = Array.isArray(e) ? e : [e.name, e.qty, e.invested ? 'Invested' : ''];
    const rec = find('equipment', name);
    if (!rec) { missing('Item', name); continue; }
    // Invested items, and things you wear (rings, cloaks, tattoos, a backpack), start out worn.
    const inv = /invested/i.test(tag || '');
    b.inventory.push(item(rec, { qty: Number(qty) || 1, invested: inv, equipped: ['armor', 'shield'].includes(rec.type) ? false : inv || /^worn|^tattooed|^implanted/.test(rec.usage || '') }));
  }
  const m = pb.money || {};
  b.money = (Number(m.pp) || 0) * 1000 + (Number(m.gp) || 0) * 100 + (Number(m.sp) || 0) * 10 + (Number(m.cp) || 0);
  for (const grp of pb.formula || []) for (const name of grp.known || []) {
    const rec = find('equipment', name);
    if (rec) b.formulas.push(refOf(rec)); else missing('Formula', name);
  }
  // Companions: animal companions and familiars from Pathbuilder's pets, the eidolon from the summoner's specials.
  // Types are matched by name when the Companions tab opens; anything unknown asks for a type there.
  b.companions = [];
  const slugOf = (x) => String(x || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const petName = (p, fallback) => { const n = String(p.name || '').split(' - ')[0].trim(); return n || fallback; };
  for (const p of pb.pets || []) {
    if (!p || !/animal companion/i.test(p.type || '')) continue;
    const stage = p.incredible && p.incredibleType ? slugOf(p.incredibleType) : p.mature ? 'mature' : 'young';
    b.companions.push({ id: 'c' + Math.random().toString(36).slice(2, 10), kind: 'animal', name: petName(p, p.animal), type: slugOf(p.animal), stage,
      specs: (p.specializations || []).map(slugOf), barding: {} });
  }
  const fams = (pb.familiars || []).length ? pb.familiars : (pb.pets || []).filter((p) => /familiar/i.test(p?.type || ''));
  for (const f of fams) {
    b.companions.push({ id: 'c' + Math.random().toString(36).slice(2, 10), kind: 'familiar', name: petName(f, 'Familiar'),
      abilities: (f.abilities || []).map((a) => slugOf(String(a).replace(/\s*\([^)]*\)$/, ''))) });
  }
  // "Angel Eidolon", "Elemental Eidolon (Air)"; not features like "Manifest Eidolon" or "Eidolon Symbiosis"
  const eid = (pb.specials || []).map((x) => String(x).trim().match(/^([A-Z][\w' -]*?) Eidolon(?:\s*\([^)]*\))?$/)).find((m) => m && !/^(Manifest|Reinforce|Unfetter|Share|Twin|Meld Into|Expert Combat)$/i.test(m[1]));
  if (eid) b.companions.push({ id: 'c' + Math.random().toString(36).slice(2, 10), kind: 'eidolon', name: 'Eidolon', type: slugOf(eid[1]), kas: 'str', boosts: {},
    primary: { option: 'd8', trait: 'trip', dmg: 'slashing', name: 'primary attack' }, secondary: { name: 'secondary attack', dmg: 'bludgeoning' } });
  if (b.companions.length) notes.push(`Companions added on the Companions tab: ${b.companions.map((c) => c.name).join(', ')}. Check their set-up there${b.companions.some((c) => c.kind === 'eidolon') ? ' (eidolon attacks and attribute boosts aren\'t in Pathbuilder\'s file)' : ''}.`);

  // ---------------------------------------------------------------- check against Pathbuilder's numbers
  ch = engine.compute(b);
  for (const c of ch.choices) if (c.value == null && c.options.some((o) => o.available !== false)) notes.push(`Still to choose: ${/^PF2E\./.test(c.prompt || '') ? 'an option' : (c.prompt || 'an option').replace(/\.$/, '')} (${c.item?.rec?.name || c.key})`);
  const check = { attrs: [], skills: [], hp: null, other: [] };
  for (const a of ATTRS) {
    const want = Math.floor(((Number(pb.abilities?.[a]) || 10) - 10) / 2);
    if (ch.attrs[a] !== want) check.attrs.push(`${a.toUpperCase()} ${want >= 0 ? '+' : ''}${want} in Pathbuilder, ${ch.attrs[a] >= 0 ? '+' : ''}${ch.attrs[a]} here`);
  }
  for (const s of Object.keys(SKILLS)) if ((ch.ranks.skills[s] || 0) !== target[s]) check.skills.push(`${s[0].toUpperCase() + s.slice(1)}: ${['untrained', 'trained', 'expert', 'master', 'legendary'][target[s]]} in Pathbuilder, ${['untrained', 'trained', 'expert', 'master', 'legendary'][ch.ranks.skills[s] || 0]} here`);
  const at = pb.attributes || {};
  if (at.classhp) {
    const con = Math.floor(((Number(pb.abilities?.con) || 10) - 10) / 2);
    const want = (Number(at.ancestryhp) || 0) + (Number(at.bonushp) || 0) + b.level * ((Number(at.classhp) || 0) + con + (Number(at.bonushpPerLevel) || 0));
    if (Math.abs(want - ch.hp.max) > 0) check.hp = `HP ${want} in Pathbuilder, ${ch.hp.max} here`;
  }
  // Perception, saves and AC: these depend on class features and gear more than on choices, so a miss here
  // usually means a piece of gear or a rune didn't come across.
  const RK = ['untrained', 'trained', 'expert', 'master', 'legendary'];
  const pr = pb.proficiencies || {};
  if (pr.perception && rankOf(pr.perception) !== (ch.perception?.rank ?? -1)) check.other.push(`Perception: ${RK[rankOf(pr.perception)]} in Pathbuilder, ${RK[ch.perception?.rank || 0]} here`);
  for (const sv of ['fortitude', 'reflex', 'will']) {
    if (pr[sv] && rankOf(pr[sv]) !== (ch.saves?.[sv]?.rank ?? -1)) check.other.push(`${sv[0].toUpperCase() + sv.slice(1)}: ${RK[rankOf(pr[sv])]} in Pathbuilder, ${RK[ch.saves?.[sv]?.rank || 0]} here`);
  }
  const ac = Number(pb.acTotal?.acTotal);
  if (ac && ch.ac && ac !== ch.ac.total) check.other.push(`AC ${ac} in Pathbuilder, ${ch.ac.total} here`);
  return { build: b, state, notes: [...new Set(notes)], check };
}

/**
 * Works out the boosts that are choices (ancestry free boosts, background, class key, 1st level and later sets)
 * from the final modifiers, when the export doesn't say. Greedy: each set goes to the attributes furthest below target.
 */
function solveBoosts(b, ch, want) {
  const anc = ch.ancestry, bg = ch.background, cls = ch.class;
  const mods = Object.fromEntries(ATTRS.map((a) => [a, 0]));
  const half = Object.fromEntries(ATTRS.map((a) => [a, 0]));
  const apply = (a) => { if (!a) return; if (mods[a] >= 4) { half[a]++; if (half[a] >= 2) { half[a] = 0; mods[a]++; } } else mods[a]++; };
  // Boosts still needed to reach the target, counting the half-steps above +4.
  const need = (a) => { let m = mods[a], h = half[a], n = 0; while (m < want[a] && n < 20) { n++; if (m >= 4) { h++; if (h >= 2) { h = 0; m++; } } else m++; } return n; };
  const best = (opts, taken = []) => opts.filter((a) => !taken.includes(a)).sort((x, y) => need(y) - need(x))[0] || null;
  // Fixed parts
  const ancFree = [];
  if (anc) {
    if (b.options.altAncestryBoosts) ancFree.push(ATTRS, ATTRS);
    else for (const e of anc.boosts.filter((x) => x.length)) { if (e.length === 1) apply(e[0]); else ancFree.push(e); }
    if (!b.options.altAncestryBoosts) for (const e of anc.flaws.filter((x) => x.length === 1)) mods[e[0]]--;
  }
  const bgEntries = bg ? bg.boosts.filter((e) => e.length) : [];
  for (const e of bgEntries) if (e.length === 1) apply(e[0]);
  const keyOpts = cls ? (cls.keyAbility.length ? cls.keyAbility : (ch.keyOptions || [])) : [];
  if (keyOpts.length === 1) apply(keyOpts[0]);
  // Choices, in the order the rules apply them
  const anPick = [];
  for (const opts of ancFree) { const a = best(opts, anPick); anPick.push(a); apply(a); }
  if (b.options.altAncestryBoosts) b.boosts.ancestryAlt = anPick; else b.boosts.ancestry = anPick;
  const bgPick = [];
  bgEntries.forEach((e, i) => { if (e.length === 1) { bgPick[i] = e[0]; return; } const a = best(e, bgPick); bgPick[i] = a; apply(a); });
  b.boosts.background = bgPick;
  if (keyOpts.length > 1) { const a = keyOpts.includes(b.boosts.class) ? b.boosts.class : best(keyOpts); b.boosts.class = a; apply(a); }
  // A set only takes attributes that still need it: Pathbuilder may have left later boosts unchosen.
  const set = (n) => { const out = []; for (let i = 0; i < n; i++) { const a = ATTRS.filter((x) => !out.includes(x) && need(x) > 0).sort((x, y) => need(y) - need(x))[0]; if (a) out.push(a); } out.forEach(apply); return out; };
  b.boosts[1] = set(4);
  for (const lv of BOOST_LEVELS) {
    const gradual = b.options.gradualBoosts;
    if (b.level < (gradual ? lv - 3 : lv)) { b.boosts[lv] = []; continue; }
    b.boosts[lv] = set(gradual ? Math.min(4, b.level - (lv - 4)) : 4);
  }
}

function fitsList(rec, l) {
  const trads = Array.isArray(l.trad) ? l.trad : l.trad ? [l.trad] : [];
  if (trads.length && !trads.some((t) => (rec.trad || []).includes(t))) return false;
  const cantrip = (rec.traits || []).includes('cantrip');
  return l.rank === 0 ? cantrip : !cantrip && (l.orLower ? rec.rank <= l.rank : rec.rank === l.rank);
}
