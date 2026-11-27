// Rules engine: turns a saved "build" (the player's choices) into a full character with
// attributes, proficiencies, feats, HP, AC, saves, skills, strikes, spells and so on.
//
// It reads the Foundry PF2e data model: class/feature "subfeatures.proficiencies", and the rule
// elements ChoiceSet, GrantItem, ActiveEffectLike, FlatModifier, Sense, Strike, CraftingAbility...

import { ATTRS, SKILLS, SAVES, rankBonus, stackMods, camelCase, sluggify, titleCase, refParts } from './util.js';
import { test, itemOptions } from './predicate.js';
import { evaluate } from './expr.js';
import { checkAll } from './prereq.js';
import { refOf } from './data.js';
import { CASTERS, buildSpellcasting } from './casting.js';
import { runeSlots } from './runes.js';

export const BOOST_LEVELS = [5, 10, 15, 20];
const FEAT_PACKS = ['feats', 'classfeatures', 'ancestryfeatures'];
const AEL_PRIORITY = { multiply: 10, add: 20, subtract: 20, remove: 20, downgrade: 30, upgrade: 40, override: 50 };
const WEAPON_GROUPS = ['axe', 'bomb', 'bow', 'brawling', 'club', 'crossbow', 'dart', 'firearm', 'flail', 'hammer', 'knife', 'pick', 'polearm', 'shield', 'sling', 'spear', 'sword'];

// Spellcasting tables live in casting.js. SPELLCASTING is kept as an alias for older code.
export const SPELLCASTING = CASTERS;

export function newBuild() {
  return {
    v: 1, name: '', player: '', level: 1,
    ancestry: null, heritage: null, background: null, class: null,
    options: { freeArchetype: false, ancestryParagon: false, ignorePrereqs: false, altAncestryBoosts: false, gradualBoosts: false, showRare: true, legacyStickyBomb: true },
    boosts: { ancestry: [], ancestryAlt: [], background: [], class: null, 1: [], 5: [], 10: [], 15: [], 20: [] },
    skills: { class: [], int: {}, inc: {} },
    languages: [],
    feats: {},
    choices: {},
    // rep/sig: class repertoire + signature spells; book: spellbook/familiar; arch: per-archetype {rep, book};
    // pick: choose-one focus spells; focusExtra/innateExtra: spells added by hand; innate: archetype innate picks.
    spells: { rep: {}, sig: {}, book: {}, arch: {}, pick: {}, focusExtra: [], innate: {}, innateExtra: [], advDomain: null },
    formulas: [],
    skillAttrs: {}, // house rules: {medicine: 'int'}
    inventory: [],
    money: 1500,
    details: { deity: '', age: '', notes: '', appearance: '' },
  };
}

/** Fills in fields added in newer versions, so old saved characters keep working. */
/** A map that may have come back from the server as a list ({} saved as [], {"0":…} as […]). */
export const asObj = (v) => (v && typeof v === 'object' ? (Array.isArray(v) ? Object.assign({}, v) : v) : {});

export function normalizeBuild(b0) {
  const d = newBuild();
  const b = Object.assign(newBuild(), b0 || {});
  b.options = Object.assign(d.options, asObj(b.options));
  b.boosts = Object.assign(d.boosts, asObj(b.boosts));
  b.skills = Object.assign(d.skills, asObj(b.skills));
  b.skills.int = asObj(b.skills.int); b.skills.inc = asObj(b.skills.inc);
  b.spells = Object.assign(d.spells, asObj(b.spells));
  for (const k of ['rep', 'sig', 'book', 'arch', 'pick', 'innate']) b.spells[k] = asObj(b.spells[k]);
  for (const a of Object.values(b.spells.arch)) if (a && typeof a === 'object') { if ('rep' in a) a.rep = asObj(a.rep); if ('book' in a) a.book = asObj(a.book); }
  b.details = Object.assign(d.details, asObj(b.details));
  b.feats = asObj(b.feats); b.choices = asObj(b.choices); b.skillAttrs = asObj(b.skillAttrs);
  for (const [k, v] of Object.entries(b.choices)) if (Array.isArray(v) && !v.length) b.choices[k] = {}; b.inventory = b.inventory || []; b.formulas = b.formulas || []; b.languages = b.languages || [];
  b.companions = Array.isArray(b.companions) ? b.companions : [];
  return b;
}

/** A situational modifier's id, the same from level to level: "label|type|source". */
export const noteId = (n) => `${n.label}|${n.type}|${n.source || ''}`;

/** Option set that checks two sets (actor + item options) without copying. */
class UnionSet {
  constructor(a, b) { this.a = a; this.b = b; }
  has(x) { return this.a.has(x) || this.b.has(x); }
  *[Symbol.iterator]() { yield* this.a; yield* this.b; }
}

// Rules a worn item may add to the character (no choices, nothing that changes proficiency).
const WORN_RULES = ['FlatModifier', 'BaseSpeed', 'Sense', 'Resistance', 'Immunity', 'Weakness'];

/** Reads "cleric.firstDoctrine" from flags stored either flat ("cleric.firstDoctrine") or nested ({cleric:{…}}). */
function flagValue(flags, path) {
  if (!flags) return undefined;
  if (path in flags) return flags[path];
  const parts = path.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const k = parts.slice(0, i).join('.');
    if (!(k in flags)) continue;
    let v = flags[k];
    for (const p of parts.slice(i)) { if (typeof v === 'string' && v.startsWith('{')) { try { v = JSON.parse(v); } catch { return undefined; } } v = v && typeof v === 'object' ? v[p] : undefined; }
    return v;
  }
  return undefined;
}

function sameValue(a, b) {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

// Skill feats tied only to Strength- or Dexterity-based skills (from their prerequisites) don't fit Skillful Lessons.
// Feats with no skill prerequisite (Assurance, Additional Lore…) are allowed.
const PHYSICAL_SKILLS = ['acrobatics', 'athletics', 'stealth', 'thievery'];
function mentalSkillFeat(rec) {
  const skills = [];
  for (const p of rec.prereq || []) {
    const re = /\b(?:trained|expert|master|legendary) in ([a-z]+(?: lore)?)/gi;
    let m;
    while ((m = re.exec(p))) skills.push(m[1].toLowerCase());
  }
  return !skills.length || skills.some((k) => !PHYSICAL_SKILLS.includes(k));
}

export class Engine {
  constructor(db) { this.db = db; }

  // -------------------------------------------------------------------------------- public
  compute(build, state = null) {
    this._choiceCache = new Map();
    let ch = this._pass(build, state, new Set());
    // Second pass: predicates in early items can now see options added by later ones (and flags they set).
    ch = this._pass(build, state, ch.options, ch.flags);
    this._derive(ch, state);
    return ch;
  }

  /** Feat slots available up to the build's level. */
  featSlots(build, cls) {
    const L = build.level, slots = [];
    if (!cls) return slots;
    for (let l = 1; l <= L; l++) {
      if (cls.ancestryFeatLevels.includes(l)) slots.push({ id: 'ancestry-' + l, type: 'ancestry', level: l, label: 'Ancestry feat' });
      // Ancestry Paragon (optional rule): a second ancestry feat at 1st, then one at every odd level the class doesn't already give one.
      if (build.options?.ancestryParagon && [1, 3, 7, 11, 15, 19].includes(l)) slots.push({ id: 'paragon-' + l, type: 'ancestry', level: l, label: 'Ancestry feat (paragon)' });
      if (cls.classFeatLevels.includes(l)) slots.push({ id: 'class-' + l, type: 'class', level: l, label: 'Class feat' });
      if (build.options?.freeArchetype && l % 2 === 0) slots.push({ id: 'archetype-' + l, type: 'archetype', level: l, label: 'Archetype feat' });
      if (cls.skillFeatLevels.includes(l)) {
        // Investigator's Skillful Lessons (odd levels from 3rd): a feat for an Intelligence-, Wisdom- or Charisma-based skill.
        const lessons = cls.slug === 'investigator' && l >= 3 && l % 2 === 1;
        slots.push({ id: 'skill-' + l, type: 'skill', level: l, label: lessons ? 'Skill feat (Skillful Lessons)' : 'Skill feat', ...(lessons ? { mentalSkill: true } : {}) });
      }
      if (cls.generalFeatLevels.includes(l)) slots.push({ id: 'general-' + l, type: 'general', level: l, label: 'General feat' });
    }
    return slots;
  }

  /** Candidate feats for a slot, with availability info. Uses the character as it is at the slot's level. */
  featOptions(build, slot, { search = '' } = {}) {
    const db = this.db;
    const b2 = JSON.parse(JSON.stringify(build));
    b2.level = slot.level;
    delete b2.feats[slot.id];
    // Remove later feats so prerequisites are judged at this point in the build.
    for (const id of Object.keys(b2.feats)) if (Number(id.split('-').pop()) > slot.level) delete b2.feats[id];
    const ch = this.compute(b2);
    const q = search.trim().toLowerCase();
    const taken = new Map();
    for (const f of this.compute(build).feats) taken.set(f.rec.slug, (taken.get(f.rec.slug) || 0) + 1);
    const out = [];
    const dedicationBlock = this._dedicationBlock(build, slot);
    for (const rec of db.list('feats')) {
      if (!this._fitsSlot(rec, slot, ch)) continue;
      if (q && !rec.name.toLowerCase().includes(q)) continue;
      const pre = checkAll(rec.prereq, ch, db, rec);
      const max = rec.max ?? 1;
      const already = (taken.get(rec.slug) || 0) - (build.feats[slot.id] === rec.slug ? 1 : 0);
      const reasons = [];
      if (!pre.ok) reasons.push('Prerequisites not met');
      if (already >= max) reasons.push('Already taken');
      if (rec.onlyL1 && slot.level > 1) reasons.push('Only at 1st level');
      if ((rec.traits || []).includes('dedication') && dedicationBlock) reasons.push(dedicationBlock);
      if (slot.mentalSkill && !mentalSkillFeat(rec)) reasons.push('Skillful Lessons: needs an Int, Wis or Cha skill');
      out.push({ rec, pre, ok: reasons.length === 0, reasons });
    }
    // Class slots: your class feats first, then archetype feats. Archetype slots: grouped by archetype, dedication first.
    const isArch = (r) => (r.traits || []).includes('archetype') ? 1 : 0;
    const isDed = (r) => (r.traits || []).includes('dedication') ? 0 : 1;
    out.sort((a, b) => (b.ok - a.ok)
      || (slot.type === 'class' ? isArch(a.rec) - isArch(b.rec) : 0)
      || (slot.type === 'archetype' || (slot.type === 'class' && isArch(a.rec)) ? (a.rec.arch || '').localeCompare(b.rec.arch || '') || isDed(a.rec) - isDed(b.rec) : 0)
      || (b.rec.level - a.rec.level) || a.rec.name.localeCompare(b.rec.name));
    return out;
  }

  // -------------------------------------------------------------------------------- internals
  _fitsSlot(rec, slot, ch) {
    const t = rec.traits || [];
    if (rec.level > slot.level) return false;
    switch (slot.type) {
      case 'ancestry':
        return rec.cat === 'ancestry' && t.some((x) => ch.ancestryTraits.has(x));
      case 'class':
        return rec.cat === 'class' && (t.includes(ch.class?.slug) || t.includes('archetype'));
      case 'archetype':
        return t.includes('archetype');
      case 'skill':
        return rec.cat === 'skill';
      case 'general':
        return rec.cat === 'general' || rec.cat === 'skill';
      default:
        return false;
    }
  }

  /** "You can't select another dedication feat until you have gained two other feats from your current archetype." */
  _dedicationBlock(build, slot) {
    const db = this.db;
    const byLevel = Object.entries(build.feats)
      .map(([id, slug]) => ({ id, level: Number(id.split('-').pop()), rec: db.get('@feats/' + slug) }))
      .filter((f) => f.rec && f.level <= slot.level && f.id !== slot.id)
      .sort((a, b) => a.level - b.level);
    for (const d of byLevel) {
      if (!(d.rec.traits || []).includes('dedication') || !d.rec.arch) continue;
      const others = byLevel.filter((f) => f.rec.arch === d.rec.arch && f !== d && f.level >= d.level && !(f.rec.traits || []).includes('dedication')).length;
      if (others < 2) return `Take two more ${d.rec.name.replace(/ Dedication$/, '')} feats before another dedication`;
    }
    return null;
  }

  _pass(build, state, seedOptions, prevFlags = null) {
    const db = this.db;
    const L = Math.max(1, Math.min(20, Number(build.level) || 1));
    const ch = {
      level: L, build,
      ancestry: db.get('@ancestries/' + build.ancestry),
      heritage: db.get('@heritages/' + build.heritage),
      background: db.get('@backgrounds/' + build.background),
      class: db.get('@classes/' + build.class),
      items: [], rules: [], choices: [], profUps: [], senses: [], grantedLanguages: [], keyOptions: null,
      options: new Set(seedOptions), seen: new Set(), warnings: [], feats: [], flags: {}, prevFlags: prevFlags || {},
      ancestryTraits: new Set(), traits: new Set(),
    };
    const o = ch.options;
    o.add('self:level:' + L);
    if (ch.class) o.add('class:' + ch.class.slug);
    if (ch.ancestry) { o.add('ancestry:' + ch.ancestry.slug); ch.ancestryTraits.add(ch.ancestry.slug); for (const t of ch.ancestry.traits) { ch.traits.add(t); o.add('self:trait:' + t); } }
    if (ch.ancestry?.vision === 'low-light-vision') o.add('self:low-light-vision:from-ancestry');
    if (ch.ancestry) o.add('self:ancestry:' + ch.ancestry.slug);
    if (ch.heritage) { o.add('heritage:' + ch.heritage.slug); o.add('self:heritage:' + ch.heritage.slug); for (const t of ch.heritage.traits) { ch.ancestryTraits.add(t); ch.traits.add(t); o.add('self:trait:' + t); } }
    if (ch.background) o.add('background:' + ch.background.slug);

    if (ch.ancestry) {
      this._item(ch, ch.ancestry, 'ancestry', null, 0);
      for (const it of ch.ancestry.items || []) if (it.level <= L) this._grant(ch, it.ref, 'ancestry', ch.ancestry.name, 1);
    }
    if (ch.heritage) this._item(ch, ch.heritage, 'heritage', null, 0);
    if (ch.background) {
      this._item(ch, ch.background, 'background', null, 0);
      for (const it of ch.background.items || []) this._grant(ch, it.ref, 'background', ch.background.name, 1);
    }
    if (ch.class) {
      this._item(ch, ch.class, 'class', null, 0);
      for (const it of ch.class.items || []) if (it.level <= L) this._grant(ch, it.ref, 'class', ch.class.name, 1, 'cf:' + refParts(it.ref)[1]);
    }
    // Feats in slots
    ch.slots = this.featSlots(build, ch.class);
    const slotIds = new Set(ch.slots.map((s) => s.id));
    for (const s of ch.slots) {
      const slug = build.feats?.[s.id];
      if (!slug) continue;
      const rec = db.get('@feats/' + slug);
      if (!rec) { ch.warnings.push(`Unknown feat "${slug}" in ${s.label} (${s.level})`); continue; }
      const inst = this._item(ch, rec, 'feat:' + s.id, null, 0, s);
      if (inst) ch.feats.push({ rec, slot: s, key: inst.key, granted: false });
    }
    for (const id of Object.keys(build.feats || {})) if (!slotIds.has(id) && build.feats[id] && Number(id.split('-').pop()) <= L) ch.warnings.push(`Feat in slot ${id} no longer has a slot (check the free archetype and ancestry paragon settings)`);

    // Worn items (rings, cloaks, boots, tattoos…) give their bonuses while worn — and invested, if they need it.
    for (const it of build.inventory || []) {
      if (!it.equipped) continue;
      const rec = db.get(it.ref);
      if (!rec || !['equipment', 'backpack'].includes(rec.type) || !/^(worn|tattooed|implanted|bonded)/.test(rec.usage || '')) continue;
      if ((rec.traits || []).includes('invested') && !it.invested) continue;
      const rules = (rec.rules || []).filter((r) => WORN_RULES.includes(r.key) && !/\{item\|flags/.test(JSON.stringify(r)));
      if (rules.length) this._item(ch, { ...rec, rules }, 'inv:' + it.id, rec.name, 1);
    }
    // Worn armor's property runes with plain effects: Shadow (Stealth), Slick (Escape and Squeeze), energy-resistant runes.
    for (const it of build.inventory || []) {
      if (!it.equipped || !Array.isArray(it.runes) || !it.runes.length) continue;
      const rec = db.get(it.ref);
      if (!rec || rec.type !== 'armor') continue;
      const rules = [];
      for (const slug of it.runes.slice(0, runeSlots(it))) {
        const tier = /^major/.test(slug) ? 3 : /^greater/.test(slug) ? 2 : 1;
        const base = slug.replace(/^(major|greater)/, '').replace(/^\w/, (c) => c.toLowerCase());
        const label = db.runeData?.armor?.[slug]?.name || slug;
        let m;
        if (base === 'shadow') rules.push({ key: 'FlatModifier', selector: 'stealth', type: 'item', value: tier, label });
        else if (base === 'slick') rules.push({ key: 'FlatModifier', selector: 'acrobatics', type: 'item', value: tier, label: label + ' (Escape, Squeeze)', predicate: [{ or: ['action:escape', 'action:squeeze'] }] });
        else if ((m = base.match(/^(acid|cold|electricity|fire|sonic)Resistant$/))) rules.push({ key: 'Resistance', type: m[1], value: tier >= 2 ? 10 : 5 });
      }
      if (rules.length) this._item(ch, { ...rec, name: rec.name + ' runes', slug: rec.slug + '-runes', rules }, 'runes:' + it.id, rec.name, 1);
    }

    this._attributes(ch);
    this._proficiencies(ch);
    return ch;
  }

  _grant(ch, ref, parentKey, sourceName, depth, keyOverride) {
    const rec = this._resolve(ref);
    if (!rec) return null;
    const key = keyOverride || parentKey + '>' + rec.slug;
    return this._item(ch, rec, key, sourceName, depth);
  }

  _resolve(ref) {
    if (!ref || typeof ref !== 'string') return null;
    if (ref.startsWith('@')) return this.db.get(ref);
    if (ref.includes('{')) return null;
    return this.db.findSlug(ref, [...FEAT_PACKS, 'spells', 'actions', 'equipment', 'conditions']);
  }

  _item(ch, rec, key, sourceName, depth, slot = null) {
    if (depth > 6 || ch.seen.has(key)) return null;
    ch.seen.add(key);
    const pack = rec._pack;
    const inst = { key, rec, pack, ref: refOf(rec), source: sourceName, sel: {}, selLabel: {}, slot };
    ch.items.push(inst);
    if (pack === 'feats' || pack === 'classfeatures' || pack === 'ancestryfeatures') ch.options.add('feat:' + rec.slug);
    if (pack === 'classfeatures') ch.options.add('feature:' + rec.slug);
    if (pack === 'deities' && !ch.deity) {
      ch.deity = rec; ch.deityInst = inst;
      const o = ch.options;
      o.add('deity:primary:' + rec.slug);
      for (const f of rec.font || []) o.add('deity:primary:font:' + f);
      for (const x of rec.sanct || []) o.add(`deity:primary:sanctification:${rec.sanctModal || 'can'}:${x}`);
      for (const d of rec.domains || []) o.add('deity:primary:domain:' + d);
      for (const w of rec.weapons || []) o.add('deity:primary:favored-weapon:' + w);
    }
    if (pack === 'feats' && sourceName && !slot) ch.feats.push({ rec, slot: null, key, granted: true, source: sourceName });

    const sub = rec.sub || rec.subfeatures;
    if (sub) {
      for (const [k, v] of Object.entries(sub.proficiencies || {})) if (v && v.rank) ch.profUps.push({ target: k, rank: v.rank, inst });
      for (const [type, v] of Object.entries(sub.senses || {})) ch.senses.push({ type, acuity: v.acuity, range: v.range, source: rec.name });
      for (const l of sub.languages?.granted || []) ch.grantedLanguages.push(l);
      if (sub.keyOptions?.length) ch.keyOptions = sub.keyOptions;
    }
    for (const r of rec.rules || []) this._rule(ch, r, inst, depth);
    return inst;
  }

  _subst(v, ch, inst, extra = {}) {
    if (typeof v === 'string') {
      if (!v.includes('{')) return v;
      return v.replace(/\{(item|actor|choice)\|([^}]+)\}/g, (m, scope, path) => {
        if (scope === 'item') {
          const sm = path.match(/^flags\.(?:system|pf2e)\.rulesSelections\.(\w+)((?:\.\w+)*)$/);
          if (sm) {
            let s = inst.sel[sm[1]];
            // Object choices ("spriteSpark.damageType"): walk into the chosen value.
            for (const k of (sm[2] || '').split('.').filter(Boolean)) {
              if (typeof s === 'string' && s.startsWith('{')) { try { s = JSON.parse(s); } catch { s = undefined; } }
              s = s && typeof s === 'object' ? s[k] : undefined;
            }
            return s === undefined || s === null ? m : (typeof s === 'object' ? JSON.stringify(s) : String(s));
          }
          if (path === 'id' || path === 'slug') return inst.rec.slug;
          if (path === 'name') return inst.rec.name;
          if (path === 'level') return String(inst.rec.level ?? 0);
          return m;
        }
        if (scope === 'actor') {
          if (/^(system\.details\.class\.trait|class\.slug)$/.test(path)) return ch.class?.slug || '';
          if (/^(system\.details\.ancestry\.trait|ancestry\.slug)$/.test(path)) return ch.ancestry?.slug || '';
          if (path === 'level' || path === 'system.details.level.value') return String(ch.level);
          if (path === 'halfLevel') return String(Math.floor(ch.level / 2));
          // Adopted Ancestry / versatile heritages (Aiuvarin counts as elf): known from this pass or the one before.
          const dm = path.match(/^system\.details\.ancestry\.(adopted|versatile)$/);
          if (dm) {
            if (dm[1] === 'adopted') {
              const ad = ch.items.find((x) => x.rec.slug === 'adopted-ancestry' && typeof x.sel?.ancestry === 'string');
              if (ad) return ad.sel.ancestry;
            }
            const o = [...ch.options].find((x) => x.startsWith(`actor-detail:${dm[1]}:`));
            return o ? o.split(':')[2] : m;
          }
          if (path === 'system.details.heritage.trait') return ch.heritage?.slug || m;
          // Flags set by other features (a cleric's doctrine, a kineticist's gates): this pass first, else the one before.
          const fm = path.match(/^flags\.(?:system|pf2e)\.(.+)$/);
          if (fm) {
            const fv = flagValue(ch.flags, fm[1]) ?? flagValue(ch.prevFlags, fm[1]);
            return fv === undefined || fv === null ? m : (typeof fv === 'object' ? JSON.stringify(fv) : String(fv));
          }
          return m;
        }
        if (scope === 'choice') return extra.choice ?? m;
        return m;
      });
    }
    if (Array.isArray(v)) return v.map((x) => this._subst(x, ch, inst, extra));
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = this._subst(x, ch, inst, extra);
      return o;
    }
    return v;
  }

  _rule(ch, r, inst, depth) {
    const build = ch.build;
    if (r.key === 'ChoiceSet') {
      if (r.predicate && !test(this._subst(r.predicate, ch, inst), ch.options)) return;
      const flag = r.flag || camelCase(inst.rec.slug);
      const opts = this._choiceOptions(ch, r, inst);
      if (!opts) return;
      let saved = build.choices?.[inst.key]?.[flag];
      // Only one option fits this character (Sprite's Spark follows your heritage): it's chosen for you.
      const avail = opts.filter((x) => x.available !== false);
      if (saved === undefined && Array.isArray(r.choices) && avail.length === 1 && opts.length > 1) saved = avail[0].value;
      const match = saved !== undefined ? opts.find((x) => sameValue(x.value, saved)) : null;
      const choice = { key: inst.key, flag, prompt: r.prompt || 'Make a choice', options: opts, value: match ? saved : null, item: inst, domainChoice: r.choices === 'system.details.deities.domains', deityChoice: r.choices?.itemType === 'deity' };
      ch.choices.push(choice);
      if (match) {
        inst.sel[flag] = saved;
        inst.selLabel[flag] = match.label;
        if (r.rollOption) ch.options.add(r.rollOption + ':' + (typeof saved === 'string' ? refParts(saved)[1] : 'x'));
      }
      return;
    }
    if (r.key === 'GrantItem') {
      if (r.predicate && !test(this._subst(r.predicate, ch, inst), ch.options)) return;
      const uuid = this._subst(r.uuid, ch, inst);
      if (!uuid || uuid.includes('{')) return;
      const child = this._resolve(uuid);
      if (child) this._item(ch, child, inst.key + '>' + child.slug, inst.rec.name, depth + 1);
      return;
    }
    if (r.key === 'ActorTraits') {
      for (const t of r.add || []) { ch.traits.add(t); ch.options.add('self:trait:' + t); }
      return;
    }
    if (r.key === 'ActiveEffectLike' && typeof r.path === 'string' && /^flags\.system\./.test(r.path) && (r.mode === 'override' || r.mode === 'upgrade')
      && r.value && (typeof r.value === 'object' || (typeof r.value === 'string' && r.value.startsWith('@')))
      && (!r.predicate || test(this._subst(r.predicate, ch, inst), ch.options))) {
      // Set now so GrantItems later in this pass can follow it ({actor|flags.system.cleric.firstDoctrine}).
      const v = this._subst(r.value, ch, inst);
      if (!JSON.stringify(v).includes('{item|')) ch.flags[r.path.slice('flags.system.'.length)] = v;
    }
    if (r.key === 'RollOption') {
      if (r.option && !r.toggleable && test(this._subst(r.predicate || [], ch, inst), ch.options)) ch.options.add(this._subst(r.option, ch, inst));
      if (!r.strikeToggle) return; // strike switches are kept: the sheet shows them above Strikes
    }
    ch.rules.push({ r, inst });
  }

  _choiceOptions(ch, r, inst) {
    const db = this.db;
    const c = r.choices;
    const annotate = (list) => list;
    if (Array.isArray(c)) {
      return annotate(c.map((x) => {
        if (x && typeof x === 'object' && 'value' in x) {
          const rec = typeof x.value === 'string' && x.value.startsWith('@') ? db.get(x.value) : null;
          const objLabel = x.value && typeof x.value === 'object' ? Object.values(x.value).filter((v) => typeof v === 'string' && !/^PF2E\./.test(v)).map(titleCase).join(' · ') : '';
          return { value: x.value, label: x.label && !/^PF2E\./.test(x.label) ? x.label : rec?.name || objLabel || titleCase(String(x.value)), available: !x.predicate || test(this._subst(x.predicate, ch, inst), ch.options) };
        }
        return { value: x, label: String(x), available: true };
      }));
    }
    if (typeof c === 'string') {
      if (c === 'weaponGroups') return WEAPON_GROUPS.map((g) => ({ value: g, label: titleCase(g), available: true }));
      if (c === 'system.details.deities.domains') {
        if (!ch.deity) return [];
        const list = [...(ch.deity.domains || []), ...((r.flag || '').match(/alternate|apocryphal/i) ? ch.deity.altDomains || [] : [])];
        return list.map((d) => ({ value: d, label: db.get('@domains/' + d)?.name || titleCase(d), available: true }));
      }
      return null;
    }
    if (c && typeof c === 'object') {
      if (c.config === 'skills') {
        return Object.keys(SKILLS).map((s) => ({ value: s, label: titleCase(s), available: true }));
      }
      if (c.config === 'weaponGroups') return WEAPON_GROUPS.map((g) => ({ value: g, label: titleCase(g), available: true }));
      if (c.ownedItems) return null;
      if (c.filter || c.itemType) {
        const type = c.itemType || 'feat';
        const packs = type === 'feat' ? FEAT_PACKS : type === 'spell' ? ['spells'] : type === 'ancestry' ? ['ancestries']
          : type === 'heritage' ? ['heritages'] : type === 'background' ? ['backgrounds'] : type === 'action' ? ['actions'] : type === 'deity' ? ['deities']
          : ['weapon', 'armor', 'shield', 'equipment', 'consumable'].includes(type) ? ['equipment'] : [];
        const filter = this._subst(c.filter || [], ch, inst);
        const cacheKey = type + '|' + (c.slugsAsValues ? 's' : 'r') + '|' + JSON.stringify(filter);
        if (this._choiceCache && this._choiceCache.has(cacheKey)) return this._choiceCache.get(cacheKey);
        const out = [];
        for (const p of packs) {
          if (!db.has(p)) continue;
          for (const rec of db.list(p)) {
            if (p === 'equipment' && rec.type !== type) continue;
            if (!test(filter, new UnionSet(itemOptions(rec, p), ch.options))) continue;
            out.push({ value: c.slugsAsValues ? rec.slug : refOf(rec), label: rec.name, level: rec.level ?? rec.rank, rarity: rec.rarity, ref: refOf(rec), available: true });
          }
        }
        out.sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || a.label.localeCompare(b.label));
        if (this._choiceCache) this._choiceCache.set(cacheKey, out);
        return out;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------------- attributes
  _attributes(ch) {
    const b = ch.build.boosts || {};
    const mods = { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 };
    const partial = { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 };
    const sources = [];
    const timeline = {};
    ch.boostSlots = [];
    const apply = (attr, label) => {
      if (!ATTRS.includes(attr)) return;
      if (mods[attr] >= 4) {
        partial[attr]++;
        if (partial[attr] >= 2) { partial[attr] = 0; mods[attr]++; }
      } else mods[attr]++;
      sources.push({ attr, label, v: 1 });
    };
    const flaw = (attr, label) => { if (ATTRS.includes(attr)) { mods[attr]--; sources.push({ attr, label, v: -1 }); } };
    const pending = (n, label) => { if (n > 0) ch.warnings.push(`${label}: ${n} attribute boost${n > 1 ? 's' : ''} not chosen`); };
    const checkDupes = (list, label) => { if (new Set(list.filter(Boolean)).size !== list.filter(Boolean).length) ch.warnings.push(`${label}: each boost must go to a different attribute`); };

    // Ancestry
    const a = ch.ancestry;
    if (a) {
      if (ch.build.options?.altAncestryBoosts) {
        const chosen = (b.ancestryAlt || []).slice(0, 2);
        checkDupes(chosen, 'Ancestry');
        chosen.forEach((x) => apply(x, 'Ancestry'));
        pending(2 - chosen.filter(Boolean).length, 'Ancestry');
        ch.boostSlots.push({ id: 'ancestryAlt', label: 'Ancestry (2 free boosts)', options: [ATTRS, ATTRS] });
      } else {
        const entries = a.boosts.filter((e) => e.length);
        const chosenList = [];
        let choiceIdx = 0;
        const slotOpts = [];
        for (const e of entries) {
          if (e.length === 1) { apply(e[0], 'Ancestry'); chosenList.push(e[0]); }
          else {
            slotOpts.push(e);
            const v = (b.ancestry || [])[choiceIdx++];
            if (v && e.includes(v)) { apply(v, 'Ancestry'); chosenList.push(v); } else pending(1, 'Ancestry');
          }
        }
        checkDupes(chosenList, 'Ancestry');
        for (const e of a.flaws.filter((e) => e.length === 1)) flaw(e[0], 'Ancestry flaw');
        if (slotOpts.length) ch.boostSlots.push({ id: 'ancestry', label: 'Ancestry', options: slotOpts, fixed: entries.filter((e) => e.length === 1).map((e) => e[0]), flaws: a.flaws.filter((e) => e.length === 1).map((e) => e[0]) });
      }
    }
    // Background
    const bg = ch.background;
    if (bg) {
      const entries = bg.boosts.filter((e) => e.length);
      const chosen = [];
      entries.forEach((e, i) => {
        const v = e.length === 1 ? e[0] : (b.background || [])[i];
        if (v && e.includes(v)) { apply(v, 'Background'); chosen.push(v); } else pending(1, 'Background');
      });
      checkDupes(chosen, 'Background');
      ch.boostSlots.push({ id: 'background', label: 'Background', options: entries });
    }
    // Class key attribute
    const cls = ch.class;
    if (cls) {
      let keyOpts = cls.keyAbility.length ? cls.keyAbility : (ch.keyOptions || []);
      let key = keyOpts.length === 1 ? keyOpts[0] : (keyOpts.includes(b.class) ? b.class : null);
      if (!keyOpts.length) ch.warnings.push('Key attribute: make your class choice first (e.g. subconscious mind)');
      else if (!key) pending(1, 'Class key attribute');
      if (key) apply(key, 'Class');
      ch.keyAttr = key;
      ch.boostSlots.push({ id: 'class', label: 'Class key attribute', options: [keyOpts] });
    }
    // Level 1 free boosts
    const free1 = (b[1] || []).slice(0, 4);
    checkDupes(free1, '1st-level boosts');
    free1.forEach((x) => apply(x, 'Level 1'));
    pending(4 - free1.filter(Boolean).length, '1st-level boosts');
    ch.boostSlots.push({ id: '1', label: '1st level (4 free boosts)', options: [ATTRS, ATTRS, ATTRS, ATTRS] });
    timeline[1] = { ...mods };
    // Gradual attribute boosts (GM Core variant): the four boosts of each set come one per level (2–5, 7–10, …).
    const gradual = !!ch.build.options?.gradualBoosts;
    for (const lv of BOOST_LEVELS) {
      if (ch.level < (gradual ? lv - 3 : lv)) break;
      const n = gradual ? Math.min(4, ch.level - (lv - 4)) : 4;
      const list = (b[lv] || []).slice(0, n);
      checkDupes(list, `Level ${lv} boosts`);
      list.forEach((x) => apply(x, 'Level ' + lv));
      pending(n - list.filter(Boolean).length, `Level ${lv} boosts`);
      ch.boostSlots.push({ id: String(lv), label: `Level ${lv} (4 free boosts)`, options: [ATTRS, ATTRS, ATTRS, ATTRS] });
      timeline[lv] = { ...mods };
    }
    ch.attrs = mods;
    ch.partialBoosts = partial;
    ch.attrTimeline = timeline;
    ch.attrSources = sources;
  }

  // -------------------------------------------------------------------------------- proficiencies
  _resolver(ch, inst) {
    return (path) => {
      if (path === 'actor.level' || path === 'actor.system.details.level.value') return ch.level;
      let m = path.match(/^actor\.(?:system\.)?abilities\.(\w+)\.mod$/);
      if (m) return ch.attrs?.[m[1]] ?? 0;
      m = path.match(/^actor\.(?:system\.)?attributes\.(\w+)\.mod$/);
      if (m) return ch.attrs?.[m[1]] ?? 0;
      if (path === 'item.level') return inst?.rec?.level ?? 0;
      // Proficiency ranks and feat flags (Alchemical Discoveries: "@actor.system.skills.crafting.rank - 1").
      const R = ch.ranks;
      if (R) {
        m = path.match(/^actor\.(?:system\.)?skills\.([\w-]+)\.rank$/);
        if (m) return R.skills?.[m[1]] ?? R.lores?.[m[1]] ?? 0;
        m = path.match(/^actor\.system\.proficiencies\.(attacks|defenses)\.([\w-]+?)(?:\.rank)?$/);
        if (m) return R[m[1]]?.[m[2]] ?? 0;
        if (path === 'actor.system.proficiencies.spellcasting.rank') return R.spellcasting || 0;
        if (path === 'actor.system.perception.rank') return R.perception || 0;
        m = path.match(/^actor\.system\.saves\.(\w+)\.rank$/);
        if (m) return R.saves?.[m[1]] ?? 0;
      }
      m = path.match(/^actor\.flags\.system\.(.+)$/);
      if (m && ch.flags && typeof ch.flags[m[1]] === 'number') return ch.flags[m[1]];
      if (ch.speed && path === 'actor.system.movement.speeds.land.value') return ch.speed.total;
      const w = this._weaponCtx;
      if (w) {
        if (path === 'weapon.level' || path === 'weapon.system.level.value') return w.level;
        if (path === 'weapon.system.damage.dice') return w.dice;
        if (path === 'weapon.system.runes.potency') return w.potency;
        if (path === 'weapon.system.splashDamage.value') return w.splash;
      }
      if (path === 'item.badge.value') return 1;
      return 0;
    };
  }

  _value(ch, inst, v) {
    const f = this._subst(v, ch, inst);
    try { return evaluate(f, this._resolver(ch, inst)); }
    catch (e) {
      // A formula that still has an unresolved placeholder ({item|flags…}) counts as 0 instead of breaking the sheet.
      if (!this._badFormula) this._badFormula = new Set();
      const k = (inst?.rec?.name || '?') + ': ' + String(f);
      if (!this._badFormula.has(k)) { this._badFormula.add(k); if (typeof console !== 'undefined') console.warn('Formula skipped', k); }
      return 0;
    }
  }

  _proficiencies(ch) {
    const cls = ch.class, L = ch.level, build = ch.build;
    const R = {
      perception: cls?.perception || 0,
      saves: { fortitude: cls?.saves.fortitude || 0, reflex: cls?.saves.reflex || 0, will: cls?.saves.will || 0 },
      skills: Object.fromEntries(Object.keys(SKILLS).map((s) => [s, 0])),
      lores: {},
      attacks: { simple: cls?.attacks.simple || 0, martial: cls?.attacks.martial || 0, advanced: cls?.attacks.advanced || 0, unarmed: cls?.attacks.unarmed || 0 },
      defenses: { unarmored: cls?.defenses.unarmored || 0, light: cls?.defenses.light || 0, medium: cls?.defenses.medium || 0, heavy: cls?.defenses.heavy || 0 },
      spellcasting: cls?.spellcasting || 0,
      classDC: cls ? 1 : 0,
    };
    ch.ranks = R;
    ch.skillSources = {};
    const train = (skill, src) => {
      if (skill.startsWith('lore:')) { const n = skill.slice(5); R.lores[n] = Math.max(R.lores[n] || 0, 1); return; }
      if (R.skills[skill] === undefined) return false;
      if (R.skills[skill] >= 1) return false;
      R.skills[skill] = 1; ch.skillSources[skill] = src; return true;
    };

    // Fixed training
    let extraPicks = 0;
    for (const s of ch.background?.skills || []) train(s, 'Background');
    for (const l of ch.background?.lore || []) R.lores[l] = Math.max(R.lores[l] || 0, 1);
    for (const s of cls?.trainedSkills || []) if (train(s, 'Class') === false && R.skills[s] !== undefined) extraPicks++;
    // Clerics and champions are trained in their deity's divine skill.
    if (ch.deity && ch.deityInst?.key.startsWith('cf:')) for (const s of ch.deity.skill || []) train(s, ch.deity.name);

    // Training from rules (upgrade to trained) before choices, so overlaps can be spotted.
    const aels = ch.rules.filter((x) => x.r.key === 'ActiveEffectLike')
      .filter((x) => test(this._subst(x.r.predicate || [], ch, x.inst), ch.options))
      .sort((a, b) => (a.r.priority ?? AEL_PRIORITY[a.r.mode] ?? 50) - (b.r.priority ?? AEL_PRIORITY[b.r.mode] ?? 50));
    const skillUps = [];
    const dupSeen = new Set();
    for (const { r, inst } of aels) {
      const path = this._subst(r.path || '', ch, inst);
      // A Lore skill added whole (Dwarven Lore, Athamaru Lore…): {label, rank} where rank may grow with level.
      const lm = path.match(/^system\.skills\.([\w-]+)$/);
      if (lm && r.value && typeof r.value === 'object' && !Array.isArray(r.value) && r.value.rank !== undefined) {
        let label = this._subst(r.value.label || '', ch, inst);
        if (!label || label.includes('{')) label = titleCase(lm[1].replace(/-/g, ' '));
        if (!/lore$/i.test(label)) label += ' Lore';
        const rank = Math.max(1, Math.min(4, Number(this._value(ch, inst, r.value.rank)) || 1));
        R.lores[label] = Math.max(R.lores[label] || 0, rank);
        continue;
      }
      const m = path.match(/^system\.skills\.([\w-]+)\.rank$/);
      if (m) {
        const val = this._value(ch, inst, r.value);
        if (r.mode === 'upgrade' || r.mode === 'override') {
          if (val <= 1) {
            const t = train(m[1], inst.rec.name);
            if (t === false && R.skills[m[1]] === undefined) R.lores[titleCase(m[1])] = 1;
            // Already trained (e.g. Dwarven Lore's Crafting for an alchemist): you become trained in another skill instead.
            else if (t === false && !dupSeen.has(m[1] + '|' + inst.key)) { dupSeen.add(m[1] + '|' + inst.key); extraPicks++; }
          }
          else skillUps.push({ skill: m[1], rank: val, src: inst.rec.name });
        }
      }
    }

    // Class skill picks + Intelligence picks
    const classPicks = (cls?.additionalSkills || 0) + extraPicks;
    ch.classSkillPicks = classPicks;
    const picks = (build.skills?.class || []).slice(0, classPicks);
    for (const s of picks) if (s && train(s, 'Class choice') === false) ch.warnings.push(`Class skill choice "${titleCase(s)}" is already trained — pick another`);
    if (picks.filter(Boolean).length < classPicks) ch.warnings.push(`Choose ${classPicks - picks.filter(Boolean).length} more class skill${classPicks - picks.filter(Boolean).length > 1 ? 's' : ''}`);
    ch.intPicks = {};
    let prevInt = 0;
    for (const lv of [1, ...BOOST_LEVELS]) {
      if (lv > L || !ch.attrTimeline[lv]) continue;
      const cur = Math.max(0, ch.attrTimeline[lv].int);
      const n = lv === 1 ? cur : Math.max(0, cur - prevInt);
      prevInt = Math.max(prevInt, cur);
      if (n > 0) ch.intPicks[lv] = n;
    }
    for (const [lv, n] of Object.entries(ch.intPicks)) {
      const list = (build.skills?.int?.[lv] || []).slice(0, n);
      for (const s of list) if (s && train(s, 'Intelligence') === false) ch.warnings.push(`Intelligence skill "${titleCase(s)}" is already trained`);
      if (list.filter(Boolean).length < n) ch.warnings.push(`Level ${lv}: choose ${n - list.filter(Boolean).length} skill(s) from Intelligence`);
    }

    // Automatic upgrades from features (Skilled Human's expert at 5th…) count first, so increases build on them.
    for (const u of skillUps) {
      if (R.skills[u.skill] !== undefined) R.skills[u.skill] = Math.max(R.skills[u.skill], u.rank);
    }
    // Skill increases, in level order, with level limits (master at 7, legendary at 15).
    ch.increaseLevels = (cls?.skillIncreaseLevels || []).filter((l) => l <= L);
    for (const lv of ch.increaseLevels) {
      const s = build.skills?.inc?.[lv];
      if (!s) { ch.warnings.push(`Level ${lv}: skill increase not chosen`); continue; }
      const isLore = s.startsWith('lore:');
      const cur = isLore ? (R.lores[s.slice(5)] || 0) : (R.skills[s] ?? 0);
      const next = cur + 1;
      const limit = lv >= 15 ? 4 : lv >= 7 ? 3 : 2;
      if (next > limit) { ch.warnings.push(`Level ${lv}: ${titleCase(isLore ? s.slice(5) : s)} can't go above ${['', 'trained', 'expert', 'master', 'legendary'][limit]} yet`); continue; }
      if (isLore) R.lores[s.slice(5)] = next; else R.skills[s] = next;
    }
    for (const u of skillUps) {
      if (R.skills[u.skill] !== undefined) R.skills[u.skill] = Math.max(R.skills[u.skill], u.rank);
    }

    // Class features / feats: subfeatures.proficiencies
    const classSlug = cls?.slug;
    for (const u of ch.profUps) {
      const k = u.target, rank = u.rank;
      if (k in R.saves) R.saves[k] = Math.max(R.saves[k], rank);
      else if (k === 'perception') R.perception = Math.max(R.perception, rank);
      else if (k in R.defenses) R.defenses[k] = Math.max(R.defenses[k], rank);
      else if (k in R.attacks) R.attacks[k] = Math.max(R.attacks[k], rank);
      else if (k === 'spellcasting') R.spellcasting = Math.max(R.spellcasting, rank);
      else if (k === classSlug) R.classDC = Math.max(R.classDC, rank);
    }
    // Remaining ActiveEffectLike rules
    ch.focusMax = 0;
    ch.ancestryHp = null;
    ch.familiarAbilities = 0; // abilities a familiar gets each day (Enhanced Familiar, witch's familiar…)
    const resMods = [];
    for (const { r, inst } of aels) {
      const path = this._subst(r.path || '', ch, inst);
      if (/^system\.skills\./.test(path)) continue;
      const val = r.value;
      const num = () => this._value(ch, inst, val);
      const up = (cur) => {
        const v = num();
        switch (r.mode) {
          case 'upgrade': return Math.max(cur, v);
          case 'downgrade': return Math.min(cur, v);
          case 'override': return v;
          case 'add': return cur + v;
          case 'subtract': return cur - v;
          default: return cur;
        }
      };
      let m;
      if ((m = path.match(/^system\.saves\.(\w+)\.rank$/)) && m[1] in R.saves) R.saves[m[1]] = up(R.saves[m[1]]);
      else if (path === 'system.perception.rank' || path === 'system.attributes.perception.rank') R.perception = up(R.perception);
      else if ((m = path.match(/^system\.proficiencies\.defenses\.([\w-]+)\.rank$/))) R.defenses[m[1]] = up(R.defenses[m[1]] || 0);
      else if ((m = path.match(/^system\.proficiencies\.attacks\.([\w-]+)\.rank$/))) R.attacks[m[1]] = up(R.attacks[m[1]] || 0);
      else if (path === 'system.proficiencies.spellcasting.rank') R.spellcasting = up(R.spellcasting);
      else if ((m = path.match(/^system\.proficiencies\.classDCs\.([\w-]+)\.rank$/)) && m[1] === classSlug) R.classDC = up(R.classDC);
      else if (path === 'system.resources.focus.max') ch.focusMax = up(ch.focusMax);
      else if (path === 'system.attributes.familiarAbilities.value') ch.familiarAbilities = up(ch.familiarAbilities);
      else if ((m = path.match(/^system\.resources\.(\w+)\.max$/))) resMods.push({ key: m[1], up });
      // Heritages that change the ancestry's Hit Points (Sturdy Skeleton, Great Kholo: 10 instead of 6/8).
      else if (path === 'system.attributes.ancestryhp') ch.ancestryHp = up(ch.ancestryHp ?? ch.ancestry?.hp ?? 0);
      else if ((m = path.match(/^system\.details\.ancestry\.(adopted|versatile)$/))) { const v = this._subst(val, ch, inst); if (typeof v === 'string' && !v.includes('{')) ch.options.add(`actor-detail:${m[1]}:${v}`); }
      else if (path === 'system.details.ancestry.countsAs' && r.mode === 'add') { const v = this._subst(val, ch, inst); if (typeof v === 'string' && !v.includes('{')) ch.ancestryTraits.add(v); }
      else if ((m = path.match(/^flags\.system\.(.+)$/))) {
        const v = typeof val === 'string' && /[@(]|^\d/.test(val) ? num() : this._subst(val, ch, inst);
        ch.flags[m[1]] = r.mode === 'upgrade' && typeof v === 'number' ? Math.max(ch.flags[m[1]] ?? -Infinity, v) : v;
      }
    }
    ch.focusMax = Math.max(0, Math.min(3, ch.focusMax));
    // Special resources: pools with a maximum such as versatile vials (alchemist, Alchemist Dedication, investigators).
    ch.resources = {};
    for (const { r, inst } of ch.rules.filter((x) => x.r.key === 'SpecialResource')) {
      if (!r.slug || (r.predicate && !test(this._subst(r.predicate, ch, inst), ch.options))) continue;
      const ev = (v) => (typeof v === 'number' ? v : this._value(ch, inst, String(v).replace(/@actor\.system\.abilities/g, '@actor.abilities')));
      const max = Math.max(0, Number(ev(r.max ?? 0)) || 0);
      const key = camelCase(r.slug);
      const label = r.label && !/^PF2E\./.test(r.label) ? r.label : titleCase(r.slug.replace(/-/g, ' '));
      const prev = ch.resources[key];
      if (!prev || max > prev.max) ch.resources[key] = { slug: r.slug, key, label, max, itemLevel: r.level != null ? Number(ev(r.level)) || 1 : null, source: inst.rec.name };
    }
    for (const { key, up } of resMods) if (ch.resources[key]) ch.resources[key].max = Math.max(0, up(ch.resources[key].max));
    // Roll options for ranks (used by predicates on the second pass).
    for (const [s, r] of Object.entries(R.skills)) ch.options.add(`skill:${s}:rank:${r}`);
    for (const [d, r] of Object.entries(R.defenses)) ch.options.add(`defense:${d}:rank:${r}`);
    for (const [s, r] of Object.entries(R.saves)) ch.options.add(`${s}:rank:${r}`);
    const cc = ch.class && CASTERS[ch.class.slug];
    if (cc && ['arcane', 'divine', 'occult', 'primal'].includes(cc.trad)) ch.options.add('spellcasting:tradition:' + cc.trad);
  }

  // -------------------------------------------------------------------------------- derived numbers
  _mods(ch, selectors, state, extraOptions = null, skipSlugs = null) {
    // Collect FlatModifiers whose selector matches any of `selectors`.
    const out = [], notes = [];
    const opts = new Set(ch.options);
    for (const o of ch.stateOptions || []) opts.add(o);
    if (extraOptions) for (const o of extraOptions) opts.add(o);
    for (const { r, inst } of [...ch.rules, ...(ch.effectRules || [])]) {
      if (r.key !== 'FlatModifier') continue;
      if (r.type === 'ability') continue; // "use Intelligence instead" (Devise a Stratagem): strikes swap the attribute
      if (skipSlugs && r.slug && skipSlugs.includes(r.slug)) continue;
      let sel = this._subst(r.selector, ch, inst);
      sel = Array.isArray(sel) ? sel : [sel];
      if (!sel.some((s) => selectors.includes(s))) continue;
      let value = this._value(ch, inst, r.value);
      let adjType = null;
      // AdjustModifier rules can raise/override a modifier with the same slug (Furious Footfalls while raging; an
      // instinct raising Rage damage). They match the roll's selectors; "{item|_id}-damage" ones only the Strikes that
      // item grants (Animal instinct's jaws). Applied by priority, so Rage's "half with agile" comes last.
      if (r.slug) {
        const adj = ch.rules.filter(({ r: a }) => a.key === 'AdjustModifier' && a.slug === r.slug)
          .sort((x, y) => (x.r.priority ?? 50) - (y.r.priority ?? 50));
        for (const { r: a, inst: ai } of adj) {
          const asel = [].concat(this._subst(a.selector, ch, ai) || [], this._subst(a.selectors, ch, ai) || []);
          if (!asel.some((x) => sel.includes(x) || selectors.includes(x))) continue;
          if (asel.some((x) => /\{item\|/.test(x)) && !opts.has('strike-source:' + ai.rec.slug)) continue;
          if (a.predicate && a.predicate.length && !test(this._subst(a.predicate, ch, ai), opts)) continue;
          const av = this._value(ch, ai, a.value);
          const before = value;
          if (a.mode === 'upgrade') value = Math.max(value, av);
          else if (a.mode === 'downgrade') value = Math.min(value, av);
          else if (a.mode === 'override') value = av;
          else if (a.mode === 'add') value += av;
          else if (a.mode === 'multiply') value = Math.trunc(value * av);
          const dt = a.damageType ? this._subst(a.damageType, ch, ai) : null;
          if (dt && typeof dt === 'string' && !dt.includes('{') && (value !== before || a.mode !== 'multiply')) adjType = dt;
        }
      }
      if (!value) continue;
      const mod = { label: r.label || inst.rec.name, value, type: r.type || 'untyped', source: inst.rec.name };
      if (r.damageType && typeof r.damageType === 'string' && !r.damageType.includes('{')) mod.damageType = r.damageType;
      if (adjType) mod.damageType = adjType;
      if (r.damageCategory) mod.category = r.damageCategory;
      if (r.slug) mod.slug = r.slug;
      if (r.predicate && r.predicate.length) {
        if (test(this._subst(r.predicate, ch, inst), opts)) out.push(mod);
        else notes.push({ ...mod, conditional: true, pred: r.predicate });
      } else out.push(mod);
    }
    return { mods: out, notes };
  }

  _derive(ch, state) {
    const L = ch.level, A = ch.attrs, R = ch.ranks, db = this.db;
    state = state || {};
    ch.state = state;
    // Options from live state (conditions, toggles) so situational modifiers can apply on the sheet.
    ch.stateOptions = [];
    for (const c of state.conditions || []) ch.stateOptions.push('self:condition:' + c.slug);
    if (state.raging) ch.stateOptions.push('self:effect:rage');
    if (state.unleashed) ch.stateOptions.push('self:effect:unleash-psyche');
    // Strike switches the player flips (Expanded Splash, Sticky Bomb, Bomber field vials: cold/electricity/fire).
    ch.toggles = [];
    for (const { r, inst } of ch.rules) {
      if (r.key !== 'RollOption' || !r.strikeToggle || !r.option || ch.toggles.some((t) => t.option === r.option)) continue;
      const tOpts = new Set([...ch.options, ...ch.stateOptions]);
      if (r.predicate && !test(this._subst(r.predicate, ch, inst), tOpts)) continue;
      if (r.disabledIf && test(this._subst(r.disabledIf, ch, inst), tOpts)) continue; // e.g. not raging
      const label = r.label && !/^PF2E\./.test(r.label) ? r.label : inst.rec.name;
      const subs = Array.isArray(r.suboptions) ? r.suboptions.filter((x) => x && x.value).map((x) => ({ value: x.value, label: x.label && !/^PF2E\./.test(x.label) ? x.label : titleCase(x.value) })) : [];
      const v = (state.toggles || {})[r.option];
      const on = subs.length ? (subs.some((x) => x.value === v) ? v : null) : (v == null ? !!r.value : !!v);
      ch.toggles.push({ option: r.option, label, source: inst.rec.name, subs, on });
      if (on) { ch.stateOptions.push(r.option); if (typeof on === 'string') ch.stateOptions.push(`${r.option}:${on}`); }
      if (on && r.option === 'target:mark:devise-a-stratagem') ch.stateOptions.push('devise-a-stratagem:attack');
    }
    ch.effectRules = [];
    for (const e of state.effects || []) {
      const rec = db.get(e.ref);
      if (!rec) continue;
      ch.stateOptions.push('self:effect:' + rec.slug.replace(/^(spell-|feat-|equipment-)?effect-/, ''));
      for (const r of rec.rules || []) if (r.key === 'FlatModifier') ch.effectRules.push({ r, inst: { rec, sel: {}, key: 'effect:' + rec.slug } });
    }
    const cond = this._conditionMods(state.conditions || []);
    // Situational modifiers the player ticked on the sheet (state.situational[stat] = [note ids]) count as applied.
    const ticked = state.situational || {};
    const statMods = (stat, attr, extraSel = []) => {
      const sel = [stat, ...extraSel, 'all', attr ? attr + '-based' : null].filter(Boolean);
      const { mods, notes } = this._mods(ch, sel, state);
      const out = stat === 'land-speed' ? mods : [...mods, ...cond(stat, attr)];
      const on = ticked[stat] || [];
      for (const n of notes) {
        n.id = noteId(n);
        if (on.includes(n.id)) { n.on = true; out.push({ label: n.label, value: n.value, type: n.type, source: n.source, situational: true }); }
      }
      return { mods: out, notes };
    };

    // Inventory
    const inv = (ch.build.inventory || []).map((it) => ({ ...it, rec: db.get(it.ref) })).filter((x) => x.rec);
    ch.inventory = inv;
    const armor = inv.find((x) => x.rec.type === 'armor' && x.equipped) || null;
    const shield = inv.find((x) => x.rec.type === 'shield' && x.equipped) || null;
    ch.armor = armor; ch.shield = shield;
    const armorStrOk = !armor || A.str >= (armor.rec.str || 0);

    // HP
    const hpMods = this._mods(ch, ['hp'], state).mods;
    const hpPer = this._mods(ch, ['hp-per-level'], state).mods;
    const drained = (state.conditions || []).find((c) => c.slug === 'drained')?.value || 0;
    const hpBase = (ch.ancestryHp ?? ch.ancestry?.hp ?? 0) + ((ch.class?.hp || 0) + A.con) * L;
    ch.hp = { max: Math.max(1, hpBase + stackMods(hpMods).total + stackMods(hpPer).total * L - drained * L), base: hpBase, mods: hpMods };

    // AC
    {
      const cat = armor ? armor.rec.cat : 'unarmored';
      const rank = R.defenses[cat] || 0;
      let dexCap = armor?.rec.dexCap ?? 99;
      for (const { r, inst } of ch.rules) {
        if (r.key !== 'DexterityModifierCap' || (r.predicate && !test(this._subst(r.predicate, ch, inst), new Set([...ch.options, ...(ch.stateOptions || [])])))) continue;
        const v = Number(this._value(ch, inst, r.value));
        if (Number.isFinite(v)) dexCap = Math.min(dexCap, v);
      }
      const dex = Math.min(A.dex, dexCap);
      const item = armor ? (armor.rec.ac || 0) + (armor.potency || armor.rec.runes?.potency || 0) : 0;
      const { mods, notes } = statMods('ac', 'dex');
      if (item) mods.push({ label: armor.rec.name, value: item, type: 'item' });
      if (state.raging && ch.class?.slug === 'barbarian') mods.push({ label: 'Rage', value: -1, type: 'untyped' });
      if (shield && state.shieldRaised) mods.push({ label: shield.rec.name + ' (raised)', value: shield.rec.shieldAc || 2, type: 'circumstance' });
      const s = stackMods(mods);
      ch.ac = { total: 10 + dex + rankBonus(rank, L) + s.total, rank, dex, dexCap: armor ? dexCap : null, mods: s.used, notes, category: cat };
    }
    // Better (or worse) results on a save: Juggernaut, Evasion, Dogged Will ("a success becomes a critical success").
    const DEG = { criticalSuccess: 'critical success', success: 'success', failure: 'failure', criticalFailure: 'critical failure' };
    const ORDER = ['criticalFailure', 'failure', 'success', 'criticalSuccess'];
    const degreeNotes = (selectors) => {
      const out = [];
      const o = new Set([...ch.options, ...(ch.stateOptions || [])]);
      for (const { r, inst } of ch.rules) {
        if (r.key !== 'AdjustDegreeOfSuccess' || !selectors.includes(r.selector)) continue;
        const pred = this._subst(r.predicate || [], ch, inst);
        const known = !pred.length || test(pred, o);
        const parts = Object.entries(r.adjustment || {}).map(([from, how]) => {
          const i = ORDER.indexOf(from);
          const to = how === 'one-degree-better' ? ORDER[Math.min(3, i + 1)] : how === 'one-degree-worse' ? ORDER[Math.max(0, i - 1)]
            : how === 'two-degrees-better' ? ORDER[Math.min(3, i + 2)] : ({ 'to-critical-success': 'criticalSuccess', 'to-success': 'success', 'to-failure': 'failure', 'to-critical-failure': 'criticalFailure' })[how];
          return DEG[from] && DEG[to] ? `${DEG[from][0].toUpperCase() + DEG[from].slice(1)} → ${DEG[to]}` : null;
        }).filter(Boolean);
        if (parts.length) out.push({ label: inst.rec.name, text: parts.join('; '), conditional: !known });
      }
      return out;
    };
    ch.saves = {};
    for (const [save, attr] of Object.entries(SAVES)) {
      const { mods, notes } = statMods(save, attr, ['saving-throw']);
      const res = armor ? (armor.resilient || armor.rec.runes?.resilient || 0) : 0;
      if (res) mods.push({ label: 'Resilient rune', value: res, type: 'item' });
      const s = stackMods(mods);
      ch.saves[save] = { total: A[attr] + rankBonus(R.saves[save], L) + s.total, rank: R.saves[save], attr, mods: s.used, notes, degree: degreeNotes([save, 'saving-throw']) };
    }
    // Perception & initiative
    {
      const { mods, notes } = statMods('perception', 'wis');
      const s = stackMods(mods);
      ch.perception = { total: A.wis + rankBonus(R.perception, L) + s.total, rank: R.perception, mods: s.used, notes, degree: degreeNotes(['perception']) };
      const ini = this._mods(ch, ['initiative'], state);
      const si = stackMods([...mods, ...ini.mods]);
      ch.initiative = { total: A.wis + rankBonus(R.perception, L) + si.total, notes: ini.notes };
    }
    // Skills
    const checkPen = armor && !armorStrOk ? (armor.rec.checkPen || 0) : 0;
    ch.skills = {};
    // House rules: a skill can use another attribute when the GM allows it (build.skillAttrs, e.g. {medicine: 'int'}).
    const altAttr = (ch.build && ch.build.skillAttrs) || {};
    for (const [skill, defaultAttr] of Object.entries(SKILLS)) {
      const attr = ATTRS.includes(altAttr[skill]) ? altAttr[skill] : defaultAttr;
      const { mods, notes } = statMods(skill, attr, ['skill-check']);
      if (checkPen && (attr === 'str' || attr === 'dex') && !((armor.rec.traits || []).includes('flexible') && (skill === 'acrobatics' || skill === 'athletics'))) mods.push({ label: 'Armor check penalty', value: checkPen, type: 'untyped' });
      const s = stackMods(mods);
      ch.skills[skill] = { total: A[attr] + rankBonus(R.skills[skill], L) + s.total, rank: R.skills[skill], attr, defaultAttr, mods: s.used, notes, source: ch.skillSources[skill] };
    }
    ch.lores = {};
    for (const [name, rank] of Object.entries(R.lores)) {
      const { mods } = statMods('lore', 'int', ['skill-check', sluggify(name)]);
      const s = stackMods(mods);
      ch.lores[name] = { total: A.int + rankBonus(rank, L) + s.total, rank };
    }
    // Class DC
    if (ch.class) {
      const ka = ch.keyAttr || 'str';
      const { mods } = statMods('class', ka, [ch.class.slug, 'class-dc']);
      const s = stackMods(mods);
      ch.classDC = { total: 10 + A[ka] + rankBonus(R.classDC, L) + s.total, rank: R.classDC, attr: ka };
    }
    // Speed
    {
      const { mods, notes } = statMods('land-speed', null, ['speed', 'all-speeds']);
      let pen = armor ? (armor.rec.speedPen || 0) : 0;
      if (armor && armorStrOk && pen) pen = Math.min(0, pen + 5);
      if (pen) mods.push({ label: 'Armor', value: pen, type: 'untyped' });
      const s = stackMods(mods);
      ch.speed = { total: Math.max(5, (ch.ancestry?.speed || 25) + s.total), mods: s.used, notes, other: [] };
      for (const { r, inst } of ch.rules.filter((x) => x.r.key === 'BaseSpeed')) {
        if (r.predicate && !test(this._subst(r.predicate, ch, inst), ch.options)) continue;
        const v = typeof r.value === 'number' ? r.value : this._value(ch, inst, r.value);
        if (r.selector && v) ch.speed.other.push({ type: String(r.selector).replace(/-speed$/, ''), value: v });
      }
      // Other Speeds: keep the best of each type, then add their own modifiers (Constant Levitation: +10 status
      // to the fly Speed while the psyche is unleashed) and the armor penalty, which reduces all Speeds.
      const best = new Map();
      for (const o of ch.speed.other) if (!best.has(o.type) || best.get(o.type).value < o.value) best.set(o.type, o);
      ch.speed.other = [...best.values()].map((o) => {
        const m = this._mods(ch, [o.type + '-speed', 'all-speeds'], state).mods;
        if (pen) m.push({ label: 'Armor', value: pen, type: 'untyped' });
        const st = stackMods(m);
        return st.total ? { ...o, base: o.value, value: Math.max(5, o.value + st.total), mods: st.used } : o;
      });
    }
    // Senses
    const senses = [];
    if (ch.ancestry?.vision && ch.ancestry.vision !== 'normal') senses.push({ type: ch.ancestry.vision, source: ch.ancestry.name });
    // Live state (raging, switches) counts too: Acute Vision's darkvision, raging resistance, Animal instinct attacks.
    const live = new Set([...ch.options, ...(ch.stateOptions || [])]);
    ch.liveOptions = live;
    for (const { r, inst } of ch.rules.filter((x) => x.r.key === 'Sense')) {
      if (r.predicate && !test(this._subst(r.predicate, ch, inst), live)) continue;
      senses.push({ type: r.selector, acuity: r.acuity, range: r.range, source: inst.rec.name });
    }
    senses.push(...ch.senses);
    // darkvision replaces low-light vision
    const types = new Set(senses.map((s) => s.type));
    ch.senses = senses.filter((s, i) => !(s.type === 'low-light-vision' && types.has('darkvision')) && senses.findIndex((x) => x.type === s.type) === i);
    // Size and reach: the ancestry's, then heritages and feats that change it (Automaton: pick Medium or Small).
    {
      const norm = (v) => ({ tiny: 'tiny', sm: 'sm', small: 'sm', med: 'med', medium: 'med', lg: 'lg', large: 'lg', huge: 'huge', grg: 'grg', gargantuan: 'grg' })[String(v || '').toLowerCase()] || null;
      let size = norm(ch.ancestry?.size) || 'med', reach = ch.ancestry?.reach || 5, from = ch.ancestry?.name || null;
      for (const { r, inst } of ch.rules.filter((x) => x.r.key === 'CreatureSize')) {
        if (r.predicate && !test(this._subst(r.predicate, ch, inst), ch.options)) continue;
        const v = norm(this._subst(r.value, ch, inst));
        if (!v) continue;
        size = v; from = inst.rec.name;
        const rr = r.reach || {};
        if (rr.override != null) reach = Number(rr.override) || reach;
        if (rr.upgrade != null) reach = Math.max(reach, Number(rr.upgrade) || 0);
      }
      ch.size = size; ch.sizeFrom = from; ch.reach = reach;
      ch.sizeLabel = { tiny: 'Tiny', sm: 'Small', med: 'Medium', lg: 'Large', huge: 'Huge', grg: 'Gargantuan' }[size];
      ch.options.add('self:size:' + ({ sm: 'small', med: 'medium', lg: 'large', grg: 'gargantuan' }[size] || size));
    }
    // Resistances etc.
    ch.defensesList = ch.rules.filter((x) => ['Resistance', 'Weakness', 'Immunity'].includes(x.r.key))
      .filter((x) => !x.r.predicate || test(this._subst(x.r.predicate, ch, x.inst), live))
      .map((x) => {
        // Types still waiting on a choice ("{item|…dragon.damageType}") are left out until it's made.
        let types = [].concat(this._subst(x.r.type || [], ch, x.inst)).filter((t) => typeof t === 'string' && !t.includes('{'));
        if (types.includes('custom')) {
          let label = this._subst(x.r.label || '', ch, x.inst);
          if (!label || /^PF2E\.|\{/.test(label)) {
            // Superstition: "divine and primal spells", from the choice the label stands for.
            const tr = (JSON.stringify(this._subst(x.r.definition || [], ch, x.inst)).match(/item:trait:([a-z-]+)/g) || []).map((t) => t.slice(11));
            label = tr.length ? `${tr.join(' and ')} ${JSON.stringify(x.r.definition || []).includes('item:type:spell') ? 'spells' : ''}`.trim() : '';
          }
          types = types.map((t) => (t === 'custom' ? label : t)).filter(Boolean);
        }
        return types.length ? { kind: x.r.key, type: types.join(', '), value: x.r.value != null ? this._value(ch, x.inst, x.r.value) : null, source: x.inst.rec.name } : null;
      }).filter(Boolean)
      // The same resistance (or weakness) twice doesn't stack: only the highest counts (Mental Buffer: half your
      // level, or your level while your psyche is unleashed).
      .filter((d, i, all) => !all.some((o, j) => j !== i && o.kind === d.kind && o.type === d.type && ((Number(o.value) || 0) > (Number(d.value) || 0) || ((Number(o.value) || 0) === (Number(d.value) || 0) && j < i))));
    // Languages
    const langs = new Set([...(ch.ancestry?.languages || []), ...ch.grantedLanguages]);
    ch.languageSlots = (ch.ancestry?.addLanguageCount || 0) + Math.max(0, A.int);
    ch.languages = [...langs, ...(ch.build.languages || []).slice(0, ch.languageSlots).filter((l) => l && !langs.has(l))];
    // Strikes
    ch.strikes = this._strikes(ch, inv, state, statMods);
    // Spellcasting
    ch.spellcasting = this._spellcasting(ch, statMods);
    // Crafting
    const seenCraft = new Set();
    ch.crafting = ch.rules.filter((x) => x.r.key === 'CraftingAbility' && Array.isArray(x.r.craftableItems) && x.r.craftableItems.length)
      .filter((x) => { const k = x.r.slug || x.inst.rec.slug; if (seenCraft.has(k)) return false; seenCraft.add(k); return true; })
      .map(({ r, inst }) => ({
      label: r.label || inst.rec.name, slug: r.slug, daily: !!r.isDailyPrep,
      max: r.maxSlots != null ? this._value(ch, inst, String(r.maxSlots).replace('@actor.system.abilities', '@actor.abilities')) : null,
      filter: r.craftableItems, source: inst.rec.name,
    }));
    // Bulk
    let bulk = 0;
    for (const it of inv) bulk += (Number(it.rec.bulk) || 0) * (it.qty || 1) / (it.rec.per > 1 ? it.rec.per : 1);
    ch.bulk = { total: Math.round(bulk * 10) / 10, encumbered: 5 + A.str, max: 10 + A.str };
    // Items for display
    ch.features = ch.items.filter((i) => i.pack === 'classfeatures' || i.pack === 'ancestryfeatures');
    ch.actions = ch.items.filter((i) => i.pack === 'actions');
    ch.pending = ch.choices.filter((c) => c.value === null);
    ch.ownedSlugs = new Set(ch.items.map((i) => i.rec.slug));
    ch.ownedNames = new Set(ch.items.map((i) => i.rec.name.toLowerCase()));
    // Duplicate feats and untrained armor
    const featCount = new Map();
    for (const f of ch.feats) featCount.set(f.rec.slug, (featCount.get(f.rec.slug) || 0) + 1);
    for (const [slug, n] of featCount) {
      const rec = db.get('@feats/' + slug);
      if (rec && n > (rec.max ?? 1)) ch.warnings.push(`${rec.name} is taken ${n} times (allowed ${rec.max ?? 1})`);
    }
    if (armor && !(R.defenses[armor.rec.cat] > 0)) ch.warnings.push(`Not trained in ${armor.rec.cat} armor — no proficiency bonus to AC while wearing ${armor.rec.name}`);
    ch.prereqProblems = [];
    if (!ch.build.options?.ignorePrereqs) {
      for (const f of ch.feats.filter((f) => f.slot)) {
        const res = checkAll(f.rec.prereq, ch, db, f.rec);
        if (!res.ok) ch.prereqProblems.push({ feat: f.rec.name, slot: f.slot, results: res.results });
      }
    }
  }

  _conditionMods(conditions) {
    const v = (slug) => conditions.find((c) => c.slug === slug)?.value || (conditions.some((c) => c.slug === slug) ? 1 : 0);
    const frightened = v('frightened'), sickened = v('sickened'), clumsy = v('clumsy'), enfeebled = v('enfeebled'),
      drained = v('drained'), stupefied = v('stupefied'), offGuard = v('off-guard'), fatigued = v('fatigued'), prone = v('prone');
    return (stat, attr) => {
      const m = [];
      const status = Math.max(frightened, sickened);
      if (status) m.push({ label: frightened >= sickened ? 'Frightened' : 'Sickened', value: -status, type: 'status' });
      if (clumsy && attr === 'dex') m.push({ label: 'Clumsy', value: -clumsy, type: 'status' });
      if (enfeebled && attr === 'str') m.push({ label: 'Enfeebled', value: -enfeebled, type: 'status' });
      if (drained && attr === 'con') m.push({ label: 'Drained', value: -drained, type: 'status' });
      if (stupefied && ['int', 'wis', 'cha'].includes(attr)) m.push({ label: 'Stupefied', value: -stupefied, type: 'status' });
      if ((offGuard || prone) && stat === 'ac') m.push({ label: 'Off-guard', value: -2, type: 'circumstance' });
      if (fatigued && (stat === 'ac' || stat in SAVES)) m.push({ label: 'Fatigued', value: -1, type: 'status' });
      if (prone && stat === 'attack') m.push({ label: 'Prone', value: -2, type: 'circumstance' });
      return m;
    };
  }

  _strikes(ch, inv, state, statMods) {
    const L = ch.level, A = ch.attrs, R = ch.ranks;
    const feats = ch.ownedSlugs || new Set(ch.items.map((i) => i.rec.slug));
    const spec = feats.has('greater-weapon-specialization') || feats.has('greater-weapon-specialization-barbarian') ? [0, 0, 4, 6, 8]
      : (feats.has('weapon-specialization') || feats.has('psychic-weapon-specialization')) ? [0, 0, 2, 3, 4] : [0, 0, 0, 0, 0];
    const weapons = [];
    for (const it of inv) if (it.rec.type === 'weapon' && (it.equipped || (it.rec.traits || []).includes('bomb'))) weapons.push({ rec: it.rec, item: it });
    // Versatile vials thrown as bombs, and bombs made with Advanced Alchemy this morning.
    const al = state.alchemy || {};
    const vials = ch.resources?.versatileVials;
    const vialRec = vials && this.db.get('@equipment/versatile-vial');
    if (vialRec) {
      const il = vials.itemLevel || 1, n = il >= 18 ? 4 : il >= 12 ? 3 : il >= 4 ? 2 : 1;
      const fv = (ch.toggles || []).find((t) => t.option === 'bomber-field-vials' && typeof t.on === 'string');
      const vType = fv ? fv.on : vialRec.damage.type;
      const vTraits = fv ? [...(vialRec.traits || []).filter((t) => t !== vialRec.damage.type), fv.on] : vialRec.traits;
      weapons.push({ rec: { ...vialRec, level: il, damage: { ...vialRec.damage, dice: n, type: vType }, traits: vTraits, splash: n, rules: [] }, source: vials.source,
        item: { potency: n - 1, potencyLabel: 'Vial item bonus', left: Math.max(0, vials.max - (Number(al.vialsUsed) || 0)) } });
    }
    const infusedLeft = new Map();
    for (const arr of Object.values(al.prep || {})) for (const x of Array.isArray(arr) ? arr : []) if (x && x.ref && !x.used) infusedLeft.set(x.ref, (infusedLeft.get(x.ref) || 0) + 1);
    for (const [ref, n] of infusedLeft) {
      const rec = this.db.get(ref);
      if (rec && rec.type === 'weapon' && (rec.traits || []).includes('bomb')) weapons.push({ rec, item: { left: n, infused: true }, source: 'Advanced Alchemy' });
    }
    weapons.push({ rec: { name: 'Fist', slug: 'fist', cat: 'unarmed', group: 'brawling', damage: { dice: 1, die: 'd4', type: 'bludgeoning' }, traits: ['agile', 'finesse', 'nonlethal', 'unarmed'] } });
    for (const { r, inst } of ch.rules.filter((x) => x.r.key === 'Strike')) {
      if (r.predicate && !test(this._subst(r.predicate, ch, inst), ch.liveOptions || ch.options)) continue;
      const base = r.damage?.base || {};
      const open = (v) => typeof v === 'string' && /\{(item|actor)\|/.test(v);
      let label = this._subst(r.label || '', ch, inst);
      // Localisation keys like "PF2E.SpecificRule.Sprite.SpritesSpark.Firefly": keep the last part.
      if (/^PF2E\./.test(label)) label = open(label) ? '' : `${inst.rec.name} (${label.split('.').pop()})`;
      if (open(label)) label = '';
      const dtype = this._subst(base.damageType || 'bludgeoning', ch, inst);
      const name = label || inst.rec.name;
      weapons.push({ rec: { name, srcSlug: inst.rec.slug, slug: r.slug || sluggify(name), cat: r.category || 'unarmed', group: r.group || 'brawling',
        damage: { dice: base.dice || 1, die: base.die || 'd4', type: open(dtype) ? 'untyped (choose it)' : dtype }, traits: this._subst(r.traits || [], ch, inst), range: typeof r.range === 'number' ? r.range : (r.range?.increment ?? r.range?.max ?? null) }, source: inst.rec.name });
    }
    // Weapon familiarity and similar: "for proficiency, these weapons count as simple/martial" (MartialProficiency rules).
    const familiar = [];
    for (const { r, inst } of ch.rules.filter((x) => x.r.key === 'MartialProficiency')) {
      if (r.predicate && !test(this._subst(r.predicate, ch, inst), ch.options)) continue;
      const def = this._subst(r.definition || [], ch, inst);
      if (/\{(item|actor)\|/.test(JSON.stringify(def))) continue;
      familiar.push({ def, sameAs: r.sameAs, value: typeof r.value === 'number' ? r.value : null, slug: r.slug });
    }
    const familiarRank = (rec) => {
      if (!familiar.length) return 0;
      const o = new Set([`item:category:${rec.cat}`, `item:slug:${rec.slug}`, ...(rec.traits || []).map((t) => 'item:trait:' + t)]);
      if (rec.base) o.add('item:base:' + rec.base);
      if (rec.group) o.add('item:group:' + rec.group);
      if (!rec.base && rec.slug) o.add('item:base:' + rec.slug);
      let best = 0;
      for (const f of familiar) {
        if (!test(f.def, o)) continue;
        best = Math.max(best, f.sameAs ? (R.attacks[f.sameAs] || 0) : (f.value || 0), f.slug ? (R.attacks[f.slug] || 0) : 0);
      }
      return best;
    };
    return weapons.map(({ rec: rec0, item, source }) => {
      const rec = rec0;
      const traits = rec.traits || [];
      // Thrown weapons of the dart group (javelin, dart, shuriken) are ranged attacks; a dagger is a melee weapon you can throw.
      const ranged = !!rec.range && !traits.some((t) => t.startsWith('thrown')) || traits.includes('bomb') || (!!rec.range && rec.group === 'dart');
      const thrown = traits.some((t) => t.startsWith('thrown')) || traits.includes('bomb');
      const finesse = traits.includes('finesse');
      let attr = ranged ? 'dex' : (finesse && A.dex > A.str ? 'dex' : 'str');
      const rank = Math.max(R.attacks[rec.cat] || 0, rec.base ? (R.attacks['weapon-base-' + rec.base] || 0) : 0, rec.group ? (R.attacks['weapon-group-' + rec.group] || 0) : 0, familiarRank(rec));
      const potency = item ? (item.potency ?? rec.runes?.potency ?? 0) : 0;
      const striking = item ? (item.striking ?? rec.runes?.striking ?? 0) : 0;
      const wOpts = new Set(itemOptions({ ...rec, cat: rec.cat }, 'equipment'));
      wOpts.add(ranged ? 'item:ranged' : 'item:melee');
      if (thrown) wOpts.add('item:thrown');
      if (rec.usage) wOpts.add('item:hands-held:' + (/two-hands/.test(rec.usage) ? 2 : 1));
      if (rec.damage?.type) wOpts.add('item:damage:type:' + rec.damage.type);
      if (rec.srcSlug) wOpts.add('strike-source:' + rec.srcSlug);
      if (item && item.oversized) wOpts.add('item:oversized');
      // "Use your Intelligence modifier instead" (Devise a Stratagem with an agile, finesse or ranged weapon; Takedown
      // Expert with a club): the higher attribute is used. A Strike that adds Int this way counts as a stratagem Strike
      // (strategic strike damage, Scalpel's Point, Certain Stratagem…).
      {
        const aOpts = new Set([...ch.options, ...(ch.stateOptions || []), ...wOpts]);
        const aSel = ['strike-attack-roll', 'attack', 'attack-roll', rec.slug + '-attack', rec.group ? rec.group + '-group-attack-roll' : null];
        for (const { r, inst } of ch.rules) {
          if (r.key !== 'FlatModifier' || r.type !== 'ability' || !ATTRS.includes(r.ability)) continue;
          if (![].concat(this._subst(r.selector, ch, inst) || []).some((x) => aSel.includes(x))) continue;
          if (r.predicate && !test(this._subst(r.predicate, ch, inst), aOpts)) continue;
          if (A[r.ability] > A[attr]) attr = r.ability;
          if (attr === r.ability && JSON.stringify(r.predicate || []).includes('devise-a-stratagem')) wOpts.add('check:substitution:devise-a-stratagem');
        }
      }
      this._weaponCtx = { level: rec.level || 0, dice: rec.damage?.dice || 1, potency, splash: rec.splash || 0 };
      const am = this._mods(ch, ['attack', 'attack-roll', 'strike-attack-roll', rec.slug + '-attack', attr + '-based'], state, wOpts);
      const mods = [...am.mods, ...this._conditionMods(state.conditions || [])('attack', attr)];
      // A bonus that depends only on the weapon itself (Burn It!: alchemical items that deal fire) either applies or doesn't;
      // only ones that depend on the situation (the target, a stance…) are shown as situational.
      const onlyItem = (n) => { const t = (JSON.stringify(n.pred || []).match(/"([^"]+)"/g) || []).map((x) => x.slice(1, -1)).filter((x) => !['or', 'and', 'not', 'nor', 'gte', 'lte', 'gt', 'lt', 'eq'].includes(x)); return t.length > 0 && t.every((x) => /^item:/.test(x)); };
      const notes = am.notes.filter((n) => !onlyItem(n));
      if (potency) mods.push({ label: item?.potencyLabel || 'Potency rune', value: potency, type: 'item' });
      if (rec.bonusAtk) mods.push({ label: 'Item bonus', value: rec.bonusAtk, type: 'item' }); // alchemical bombs (+1 moderate, +2 greater…)
      const s = stackMods(mods);
      const attack = A[attr] + rankBonus(rank, L) + s.total;
      const agile = traits.includes('agile');
      const dice = (rec.damage?.dice || 1) * (1 + striking);
      let dmgMod = 0;
      const dmgParts = [];
      if (!ranged || (thrown && !traits.includes('bomb'))) { if (A.str) { dmgMod += A.str; dmgParts.push('Str'); } }
      else if (traits.includes('propulsive') && A.str > 0) { dmgMod += Math.floor(A.str / 2); dmgParts.push('½ Str'); }
      if (spec[rank] && !traits.includes('bomb')) { dmgMod += spec[rank]; dmgParts.push('Weapon spec.'); }
      const isAlchBomb = traits.includes('bomb') && traits.includes('alchemical');
      const dSel = ['strike-damage', 'damage', rec.slug + '-damage'];
      if (rec.base) dSel.push(rec.base + '-base-type-damage');
      if (isAlchBomb) dSel.push('alchemical-bomb-damage');
      if (rec.srcSlug) dSel.push('{item|_id}-damage');
      const dm = this._mods(ch, dSel, state, wOpts);
      // Extra damage dice (Strategic Strike: +3d6 precision while Devising a Stratagem). Only ones whose conditions
      // are all known here; ones that depend on the target (sneak attack) stay out, as before.
      const extraDice = [], diceNotes = [];
      let dieUp = 0, dieSet = null;
      {
        const dOpts = new Set([...ch.options, ...(ch.stateOptions || []), ...wOpts]);
        for (const { r: r0, inst } of ch.rules) {
          let r = r0;
          if (r.key !== 'DamageDice' || r.brackets) continue;
          const dsel = [].concat(this._subst(r.selector, ch, inst) || [], r.selectors || []);
          if (!dsel.some((x) => dSel.includes(x))) continue;
          const own = dsel.some((x) => /\{item\|/.test(x));
          if (own && rec.srcSlug !== inst.rec.slug) continue;
          const pred = this._subst(r.predicate || [], ch, inst);
          if (/\{(item|actor)\|/.test(JSON.stringify(pred)) || (pred.length && !test(pred, dOpts))) continue;
          // A bigger die for an item's own Strikes (Animal instinct at 7th: d10 → d12). Other overrides are left out.
          if (r.override) {
            if (own && r.override.upgrade) dieUp++;
            else if (own && /^d\d+$/.test(r.override.dieSize || '')) dieSet = r.override.dieSize;
            continue;
          }
          const n = Number(this._value(ch, inst, r.diceNumber ?? 1)) || 0;
          const dieSize = r.dieSize || (r.critical === true ? (rec.damage?.die || '') : '');
          if (n <= 0 || !/^d\d+$/.test(dieSize)) continue;
          r = { ...r, dieSize };
          const what = `${n}${r.dieSize} ${r.damageType || (r.category === 'precision' ? 'precision' : rec.damage?.type || '')}`.trim();
          if (r.critical === true) diceNotes.push({ label: inst.rec.name, text: `Critical hit: also ${what}.`, crit: true });
          else extraDice.push({ text: ` + ${what}`, source: inst.rec.name });
        }
        // Notes for stratagem Strikes (Certain Stratagem: on a miss, half your strategic strike damage).
        const OUT = { success: 'Hit', criticalSuccess: 'Critical hit', failure: 'Miss', criticalFailure: 'Critical miss' };
        for (const { r, inst } of ch.rules) {
          if (r.key !== 'Note' || !['strike-attack-roll', 'strike-damage'].includes(r.selector)) continue;
          // Certain Stratagem is for Strikes that add your Intelligence modifier; the others for any substituted Strike.
          if (inst.rec.slug === 'certain-stratagem' && !wOpts.has('check:substitution:devise-a-stratagem')) continue;
          if (r.predicate && r.predicate.length && !test(this._subst(r.predicate, ch, inst), dOpts)) continue;
          const o = (r.outcome || []).map((x) => OUT[x]).filter(Boolean);
          const head = o.includes('Hit') ? 'Hit' : o.includes('Miss') ? 'Miss' : o.join(' or ');
          diceNotes.push({ label: inst.rec.name, text: (head ? head + ': ' : '') + r.text, crit: o.length === 1 && o[0] === 'Critical hit' });
        }
      }
      this._weaponCtx = null;
      const dmgType = rec.damage?.type || '';
      // Persistent and splash bonuses (Burn It!: +1 persistent fire) don't add to the hit itself.
      const ds = stackMods(dm.mods.filter((m) => !m.category || m.category === 'precision'));
      const extras = {};
      for (const m of ds.used) {
        if (m.damageType && dmgType && m.damageType !== dmgType) extras[m.damageType] = (extras[m.damageType] || 0) + m.value;
        else { dmgMod += m.value; if (m.label && !dmgParts.includes(m.label)) dmgParts.push(m.label); }
      }
      const splashBonus = stackMods(dm.mods.filter((m) => m.category === 'splash')).total;
      let splashBase = rec.splash || 0;
      if (splashBase && isAlchBomb) {
        const sOpts = new Set([...ch.options, ...(ch.stateOptions || []), ...wOpts]);
        for (const { r: a, inst: ai } of ch.rules) {
          if (a.key !== 'AdjustModifier' || a.slug !== 'splash' || ![].concat(a.selector || [], a.selectors || []).some((x) => dSel.includes(x))) continue;
          if (a.predicate && a.predicate.length && !test(this._subst(a.predicate, ch, ai), sOpts)) continue;
          const v = this._value(ch, ai, a.value);
          if (a.mode === 'upgrade') splashBase = Math.max(splashBase, v); else if (a.mode === 'override') splashBase = v;
        }
      }
      const per = rec.damage?.persist;
      let persistent = '';
      const pType = (per && per.n && per.type) || dmgType;
      // Typed bonuses (Burn It!: +1 persistent fire) only add to persistent damage the bomb already deals;
      // untyped ones (Sticky Bomb: persistent equal to the splash) take the bomb's damage type.
      // Pre-remaster Sticky Bomb (table option, on by default): persistent damage equal to the splash actually dealt, not the listed splash.
      const finalSplash = splashBase ? splashBase + splashBonus : 0;
      const legacySticky = ch.build?.options?.legacyStickyBomb !== false; // on unless turned off
      const pMods = dm.mods.filter((m) => m.category === 'persistent' && (m.damageType ? m.damageType === pType : true))
        .map((m) => (legacySticky && m.slug === 'sticky-bomb' ? { ...m, value: finalSplash } : m));
      const pb = stackMods(pMods).total;
      if (per && per.n) {
        const base = per.faces ? `${per.n}d${per.faces}${pb ? (pb > 0 ? '+' : '') + pb : ''}` : String(per.n + pb);
        persistent = `${base} persistent ${pType}`.trim();
      } else {
        const own = stackMods(pMods.filter((m) => !m.damageType)).total;
        if (own > 0) persistent = `${pb} persistent ${pType}`.trim();
      }
      // Property runes (Flaming: +1d6 fire, and 1d10 persistent fire on a critical hit…), one per point of potency.
      const runeDice = [], runeNotes = [], runeTags = [], persistExtra = [];
      const RD = this.db.runeData;
      if (item && RD && Array.isArray(item.runes) && item.runes.length && rec.type === 'weapon') {
        const rOpts = new Set([...ch.options, ...(ch.stateOptions || []), ...wOpts, 'item:damage:type:' + dmgType]);
        // null: the rune's extra damage depends on the target (Holy: 2d4 instead of 1d4 against unholy creatures).
        const okPred = (p) => (!p || !p.length ? true : JSON.stringify(p).includes('target:') ? null : test(p, rOpts));
        const against = (p) => { const m = JSON.stringify(p).match(/target:trait:([\w-]+)/); return m ? `${m[1]} creatures` : 'some targets'; };
        for (const slug of item.runes.slice(0, runeSlots({ potency, material: item.material }))) {
          const r = RD.weapon[slug];
          if (!r) continue;
          runeTags.push({ slug, name: r.name });
          for (const x of r.extra || []) {
            const ok = okPred(x.pred);
            const dice = `${x.n ? x.n + (x.die || '') : ''}${x.mod ? (x.n && x.mod > 0 ? '+' : '') + x.mod : ''}` || '1';
            const pers = x.cat === 'persistent' || x.type === 'bleed';
            const what = `${dice} ${pers ? 'persistent ' : ''}${x.type}`;
            if (ok === null) {
              if (JSON.stringify(x.pred).includes('"not"')) runeDice.push(` + ${dice} ${x.type}`);
              else runeNotes.push({ label: r.name, text: `${what} instead against ${against(x.pred)}.` });
            } else if (!ok) continue;
            else if (x.crit) runeNotes.push({ label: r.name, text: `Critical hit: also ${what}.`, crit: true });
            else if (pers) persistExtra.push(what);
            else runeDice.push(` + ${dice} ${x.type}`);
          }
          for (const n of [...(r.notes || []), ...(r.attackNotes || [])]) {
            if (okPred(n.pred) === false) continue;
            runeNotes.push({ label: r.name, text: n.text, crit: (n.outcome || []).includes('criticalSuccess') });
          }
        }
      }
      if (persistExtra.length) persistent = [persistent, ...persistExtra].filter(Boolean).join(', ');
      if (item && item.oversized) runeNotes.push({ label: 'Large weapon', text: 'You\u2019re clumsy 1 while wielding it (Titan Mauler).' });
      // Flat damage (die "") such as Acid Flask's 1 acid.
      const DIES = ['d4', 'd6', 'd8', 'd10', 'd12'];
      let die = rec.damage ? (rec.damage.die || '') : 'd4';
      if (die && dieSet) die = dieSet;
      if (die && dieUp && DIES.includes(die)) die = DIES[Math.min(DIES.length - 1, DIES.indexOf(die) + dieUp)];
      return {
        name: rec.name, rec, item, source, attack, rank, attr, traits, ranged,
        map: agile ? [attack - 4, attack - 8] : [attack - 5, attack - 10],
        damage: `${die ? `${dice}${die}${dmgMod ? (dmgMod > 0 ? '+' : '') + dmgMod : ''}` : Math.max(1, dice + dmgMod)} ${dmgType}`.trim()
          + Object.entries(extras).map(([t, v]) => ` + ${v} ${t}`).join('') + runeDice.join('') + extraDice.map((x) => x.text).join(''),
        stratagem: wOpts.has('check:substitution:devise-a-stratagem'), extraDice,
        runes: runeTags, runeNotes: [...diceNotes, ...runeNotes], material: item && item.material && item.material.type ? item.material : null,
        persistent, splash: splashBase ? splashBase + splashBonus : 0, range: rec.range || null, mods: s.used, notes, dmgNotes: dm.notes.filter((n) => !n.category && !onlyItem(n)), dmgParts,
      };
    });
  }

  _spellcasting(ch, statMods) {
    return buildSpellcasting(this, ch, statMods);
  }
}
