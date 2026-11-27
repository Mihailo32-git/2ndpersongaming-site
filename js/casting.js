// Spellcasting: class casting tables, archetype casting, focus and innate spells.
// Called by Engine._derive(); returns ch.spellcasting = { entries, focus, innate, deity, ... }.
//
// Tables come from the class pages (Player Core 1/2, Secrets of Magic remaster, War of Immortals,
// Dark Archive remaster, Impossible Lands). Repertoire and spellbook sizes are advisory: the builder
// warns when you have too many or too few, it never deletes picks.

import { rankBonus, stackMods, titleCase } from './util.js';

const TRADS = ['arcane', 'divine', 'occult', 'primal'];
const CLASS_TRAITS = new Set(['alchemist', 'animist', 'barbarian', 'bard', 'champion', 'cleric', 'commander', 'druid', 'exemplar', 'fighter', 'guardian', 'gunslinger', 'inventor', 'investigator', 'kineticist', 'magus', 'monk', 'necromancer', 'oracle', 'psychic', 'ranger', 'rogue', 'runesmith', 'sorcerer', 'summoner', 'swashbuckler', 'thaumaturge', 'witch', 'wizard']);

/** Full casters: a new rank arrives with `first` slots at odd levels and grows to `rest` at the next level. */
const full = (first, rest, tenth = true) => (L) => {
  const s = {};
  const max = Math.min(9, Math.ceil(L / 2));
  for (let r = 1; r <= max; r++) s[r] = (r < max || L % 2 === 0 || L >= 18) ? rest : first;
  if (tenth && L >= 19) s[10] = 1;
  return s;
};
/** Animist apparition slots: 1 per rank, 2 for lower ranks later on, a 10th-rank slot at 19. */
export const apparitionSlots = (L) => {
  const s = {};
  const max = Math.min(9, Math.ceil(L / 2));
  for (let r = 1; r <= max; r++) s[r] = L >= Math.max(10, 2 * r + 3) ? 2 : 1;
  if (L >= 19) s[10] = 1;
  return s;
};

export const CASTERS = {
  bard: { trad: 'occult', type: 'spontaneous', cantrips: 5, slots: full(2, 3) },
  cleric: { trad: 'divine', type: 'prepared', cantrips: 5, slots: full(2, 3), font: true },
  druid: { trad: 'primal', type: 'prepared', cantrips: 5, slots: full(2, 3) },
  oracle: { trad: 'divine', type: 'spontaneous', cantrips: 5, slots: full(3, 4), grantedInRep: true },
  sorcerer: { trad: 'bloodline', type: 'spontaneous', cantrips: 5, slots: full(3, 4), grantedInRep: true },
  witch: { trad: 'patron', type: 'prepared', cantrips: 5, slots: full(2, 3), book: { label: 'Familiar’s spells', cantrips: 10, first: 5, perLevel: 2 } },
  wizard: { trad: 'arcane', type: 'prepared', cantrips: 5, slots: full(2, 3), book: { label: 'Spellbook', cantrips: 10, first: 5, perLevel: 2 }, curriculum: true },
  magus: { trad: 'arcane', type: 'prepared', cantrips: 5, slots: full(1, 2, false), attr: 'int', book: { label: 'Spellbook', cantrips: 8, first: 5, perLevel: 2 } },
  summoner: { trad: 'eidolon', type: 'spontaneous', cantrips: 5, slots: full(1, 2, false), attr: 'cha' },
  necromancer: { trad: 'occult', type: 'prepared', cantrips: 5, slots: full(1, 2), attr: 'int', book: { label: 'Dirge', cantrips: 8, first: 4, perLevel: 2 } },
  animist: { trad: 'divine', type: 'prepared', cantrips: 2, slots: full(1, 2, false), attr: 'wis', apparition: true },
  psychic: { trad: 'occult', type: 'spontaneous', cantrips: 3, slots: full(1, 2), psychic: true },
};

// Basic / Expert / Master archetype spellcasting: [character level, spell rank].
export const ARCH_SLOTS = { basic: [[4, 1], [6, 2], [8, 3]], expert: [[12, 4], [14, 5], [16, 6]], master: [[18, 7], [20, 8]] };
// Feats that unlock the advanced / greater tier of a class feature's focus spells.
const TIER_FEATS = {
  bloodline: { advanced: ['advanced-bloodline'], greater: ['greater-bloodline'] },
  revelation: { advanced: ['advanced-revelation'], greater: ['greater-revelation'] },
  school: { advanced: ['advanced-school-spell'] },
  order: { advanced: ['advanced-order-training'] },
};

// Focus spells of classes without slot spellcasting: [tradition, attribute].
const FOCUS_DEFAULTS = { champion: ['divine', 'cha'], monk: [null, 'wis'], ranger: ['primal', 'wis'], kineticist: [null, 'con'], thaumaturge: [null, 'cha'], investigator: [null, 'int'] };

const rankNum = (k) => Number(String(k).replace(/^r/, ''));
export const isCantrip = (rec) => (rec?.traits || []).includes('cantrip');
/** Focus spells, composition/hex cantrips and other class-traited spells. */
export const isFocusLike = (rec) => !!rec && ((rec.traits || []).includes('focus') || (rec.traits || []).some((t) => CLASS_TRAITS.has(t)));

export function attrLabel(a) { return { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' }[a] || a; }
export function ordinal(n) { n = Number(n); return n === 0 ? 'Cantrip' : n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'); }

/** Spells a caster of this tradition could put in a slot of `rank` (or cantrips when rank = 0). */
/** Feats that add casts a day to an archetype's innate spells (the feat text has no rules to read this from). */
const INNATE_EXTRA = [{ feat: 'captivating-intensity', arch: 'captivator', extra: 1, exceptTop: 2 }];

/** Does a spell fit an innate pick like "one common cantrip from the arcane list" or "one 2nd-rank or lower occult spell"? */
export function fitsInnatePick(rec, p) {
  if (!rec || rec.ritual || isFocusLike(rec)) return false;
  const trads = Array.isArray(p.trad) ? p.trad : p.trad ? [p.trad] : [];
  if (trads.length && !trads.some((t) => (rec.trad || []).includes(t))) return false;
  if (p.common && rec.rarity && rec.rarity !== 'common') return false;
  if (p.traits && p.traits.length && !p.traits.some((t) => (rec.traits || []).includes(t))) return false;
  if (p.rank === 0) return isCantrip(rec);
  if (isCantrip(rec)) return false;
  return p.orLower ? rec.rank <= p.rank : rec.rank === p.rank;
}
export function innatePickOptions(db, p, includeUncommon = true) {
  return db.list('spells').filter((s) => fitsInnatePick(s, p) && (includeUncommon || !s.rarity || s.rarity === 'common'));
}
export function spellList(db, { trad, rank, maxRank, cantrips = false, includeUncommon = false, focus = false, q = '' }) {
  const out = [];
  const query = q.trim().toLowerCase();
  for (const s of db.list('spells')) {
    if (s.ritual) continue;
    const c = isCantrip(s);
    if (focus) { if (!isFocusLike(s)) continue; }
    else {
      if (cantrips !== c) continue;
      if ((s.traits || []).includes('focus')) continue;
      if (trad && !(s.trad || []).includes(trad)) continue;
    }
    if (!c && rank != null && s.rank > rank) continue;
    if (!c && maxRank != null && s.rank > maxRank) continue;
    if (!includeUncommon && s.rarity && s.rarity !== 'common') continue;
    if (query && !s.name.toLowerCase().includes(query)) continue;
    out.push(s);
  }
  out.sort((a, b) => (b.rank - a.rank) || a.name.localeCompare(b.name));
  return out;
}

export function buildSpellcasting(engine, ch, statMods) {
  const db = engine.db, L = ch.level, A = ch.attrs, R = ch.ranks;
  const sp = ch.build.spells || {};
  const owned = ch.ownedSlugs || new Set(ch.items.map((i) => i.rec.slug));
  const out = { entries: [], focus: { max: 0, spells: [], cantrips: [] }, innate: [], picks: [], cantripRank: Math.max(1, Math.ceil(L / 2)) };

  const stats = (attr) => {
    const atk = stackMods(statMods('spell-attack', attr, ['spell-attack-roll']).mods);
    const dc = stackMods(statMods('spell-dc', attr).mods);
    const prof = Math.max(R.spellcasting, 1);
    return { attack: A[attr] + rankBonus(prof, L) + atk.total, dc: 10 + A[attr] + rankBonus(prof, L) + dc.total, rank: prof };
  };
  const ref = (r) => ({ ref: r, rec: db.get(r) });
  const valid = (x) => !!x.rec;
  const itemsUnder = (prefix) => ch.items.filter((i) => i.key === prefix || i.key.startsWith(prefix + '>'));
  const tradFrom = (items) => {
    for (const i of items) {
      if (i.rec.trad) return i.rec.trad;
      for (const v of Object.values(i.sel || {})) {
        if (v && typeof v === 'object' && TRADS.includes(v.tradition)) return v.tradition;
        if (TRADS.includes(v)) return v;
      }
    }
    return null;
  };

  // ------------------------------------------------------------------ class spellcasting
  const cls = ch.class;
  const cfg = cls && CASTERS[cls.slug];
  if (cfg) {
    let trad = cfg.trad;
    if (trad === 'bloodline') {
      const opt = [...ch.options].map((o) => o.match(/^feature:bloodline:tradition:(\w+)$/)).find(Boolean);
      trad = opt ? opt[1] : tradFrom(ch.items.filter((i) => i.pack === 'classfeatures' && /^bloodline-/.test(i.rec.slug)));
    } else if (trad === 'patron') {
      trad = tradFrom(itemsUnder('cf:patron').filter((i) => i.key !== 'cf:patron'));
    } else if (trad === 'eidolon') {
      trad = TRADS.includes(ch.flags['eidolon.tradition']) ? ch.flags['eidolon.tradition'] : tradFrom(itemsUnder('cf:eidolon').filter((i) => i.key !== 'cf:eidolon'));
    }
    if (!trad && cfg.trad !== 'bloodline' && cfg.trad !== 'patron' && cfg.trad !== 'eidolon') trad = cfg.trad;
    const attr = cfg.attr || ch.keyAttr || 'cha';
    const slots = cfg.slots(L);
    const maxRank = Math.max(0, ...Object.keys(slots).map(Number).filter((r) => r <= 9));
    // Mind Over Matter (psychic 20th): a second 10th-rank slot.
    if (slots[10] && owned.has('mind-over-matter')) slots[10] += 1;
    const e = {
      id: 'class', label: cls.name, source: 'class', classSlug: cls.slug, trad, type: cfg.type, attr, ...stats(attr),
      // Cantrip Expansion: two more cantrips (prepared each day, or in the repertoire).
      slots, maxRank, cantrips: cfg.cantrips + (owned.has('cantrip-expansion') ? 2 : 0), extraSlots: [], bonusSlots: [], granted: [], warnings: [],
    };
    // Conscious Spell Specialization (psychic 14th): one more slot of 1st–4th rank (5th at 18th) for spells your
    // conscious mind grants.
    if (cfg.psychic && owned.has('conscious-spell-specialization')) {
      for (let r = 1; r <= (L >= 18 ? 5 : 4); r++) if (r <= maxRank) e.bonusSlots.push({ rank: r, key: 'c' + r, count: 1, label: 'Conscious Spell Specialization: only spells your conscious mind grants' });
    }
    if (!trad) e.warnings.push(cfg.trad === 'bloodline' ? 'Choose a bloodline to set your tradition' : cfg.trad === 'patron' ? 'Choose a patron to set your tradition' : 'Choose an eidolon to set your tradition');

    // Spells granted by the subclass (bloodline/mystery granted spells, psychic conscious mind)
    for (const it of ch.items) {
      const g = it.rec.spellGrants?.granted;
      if (!g || it.pack !== 'classfeatures') continue;
      for (const [k, r] of Object.entries(g)) {
        const rank = rankNum(k);
        if (rank <= maxRank) { const x = ref(r); if (valid(x)) e.granted.push({ ...x, rank, source: it.rec.name }); }
      }
    }
    // Non-focus spells a class feature teaches you ("your patron gives your familiar runic weapon")
    for (const it of ch.items) {
      if (it.pack !== 'classfeatures') continue;
      for (const r of it.rec.spellGrants?.learn || []) {
        const x = ref(r);
        if (!valid(x) || isFocusLike(x.rec) || e.granted.some((g) => g.ref === r)) continue;
        const rank = isCantrip(x.rec) ? 0 : x.rec.rank;
        if (rank <= maxRank) e.granted.push({ ...x, rank, source: it.rec.name });
      }
    }

    if (cfg.psychic) {
      const mind = ch.items.find((i) => i.rec.psychic);
      e.psiCantrips = [];
      if (mind) {
        e.mind = mind.rec;
        for (const r of mind.rec.psychic.psiCantrips || []) { const x = ref(r); if (valid(x)) e.psiCantrips.push(x); }
        for (const [lvl, r] of Object.entries(mind.rec.psychic.unique || {})) if (Number(lvl) <= L) { const x = ref(r); if (valid(x)) e.psiCantrips.push({ ...x, unique: true, level: Number(lvl) }); }
        // Parallel Breakthrough: a psi cantrip from another conscious mind.
        for (const it of ch.items) {
          if (it.rec.slug !== 'parallel-breakthrough' || !it.sel?.spell) continue;
          const x = ref('@spells/' + it.sel.spell);
          if (!valid(x) || e.psiCantrips.some((p) => p.ref === x.ref)) continue;
          const from = db.list('classfeatures').find((m) => m.psychic && [...(m.psychic.psiCantrips || []), ...Object.values(m.psychic.unique || {})].includes(x.ref));
          e.psiCantrips.push({ ...x, parallel: true, fromMind: from?.name, amp: from?.psychic?.amps?.[x.ref] });
        }
      }
    }

    if (cfg.type === 'spontaneous') {
      e.repLimits = { 0: e.cantrips };
      for (const [r, n] of Object.entries(slots)) if (Number(r) <= 9) e.repLimits[r] = n;
      e.repertoire = {};
      const rep = sp.rep || {};
      for (const r of Object.keys(e.repLimits)) {
        const picks = (rep[r] || []).map(ref).filter(valid);
        const gr = cfg.grantedInRep ? e.granted.filter((g) => String(g.rank) === String(r)) : [];
        e.repertoire[r] = [...gr.map((g) => ({ ...g, granted: true })), ...picks.filter((p) => !gr.some((g) => g.ref === p.ref))];
        const need = e.repLimits[r] - e.repertoire[r].length;
        const what = Number(r) === 0 ? 'cantrip' : `${ordinal(r)}-rank spell`;
        if (need > 0) e.warnings.push(`Repertoire: choose ${need} more ${what}${need > 1 ? 's' : ''}`);
        else if (need < 0) e.warnings.push(`Repertoire: ${-need} ${what}${need < -1 ? 's' : ''} more than you normally know`);
      }
      if (!cfg.grantedInRep) for (const g of e.granted) { if (!e.repertoire[g.rank]) e.repertoire[g.rank] = []; e.repertoire[g.rank].push({ ...g, granted: true, extra: true }); }
      // Signature spells (bard, oracle, psychic, sorcerer, summoner at 3rd level)
      e.signatureCount = owned.has('signature-spells') ? Object.keys(e.repLimits).filter((r) => r > 0).length : 0;
      const sig = sp.sig || {};
      e.signature = (Array.isArray(sig) ? sig : Object.values(sig)).filter(Boolean).slice(0, e.signatureCount);
      // Signature Spell Expansion (psychic 10th): two more signature spells of 3rd rank or lower.
      e.sigExtra = e.signatureCount && owned.has('signature-spell-expansion-psychic') ? 2 : 0;
      if (e.sigExtra) for (const r of (sp.sigX || []).slice(0, e.sigExtra)) if (r && !e.signature.includes(r)) e.signature.push(r);
    } else {
      // Prepared casters
      if (cfg.book) {
        const limit = cfg.book.cantrips + cfg.book.first + cfg.book.perLevel * (L - 1);
        const book = sp.book || {};
        const spells = {};
        let count = 0, cantripCount = 0;
        for (const [r, list] of Object.entries(book)) {
          spells[r] = (list || []).map(ref).filter(valid);
          if (Number(r) === 0) cantripCount += spells[r].length; else count += spells[r].length;
        }
        e.book = { label: cfg.book.label, spells, limit, cantripLimit: cfg.book.cantrips, count, cantripCount, levelLimit: limit - cfg.book.cantrips };
        if (cantripCount < cfg.book.cantrips) e.warnings.push(`${cfg.book.label}: ${cfg.book.cantrips - cantripCount} more cantrip${cfg.book.cantrips - cantripCount > 1 ? 's' : ''} to choose`);
        if (count < e.book.levelLimit) e.warnings.push(`${cfg.book.label}: ${e.book.levelLimit - count} more spell${e.book.levelLimit - count > 1 ? 's' : ''} to choose`);
      }
      // Wizard curriculum slots (except the School of Unified Magical Theory)
      if (cfg.curriculum) {
        const school = ch.items.find((i) => i.pack === 'classfeatures' && i.rec.spellGrants?.tiers?.kind === 'school');
        if (school) {
          e.school = school.rec;
          const cur = school.rec.spellGrants.curriculum;
          if (cur) {
            e.curriculum = {};
            for (const [k, list] of Object.entries(cur)) { const r = rankNum(k); if (r <= maxRank) e.curriculum[r] = list.map(ref).filter(valid); }
            for (let r = 1; r <= maxRank; r++) e.extraSlots.push({ rank: r, count: 1, kind: 'curriculum', label: 'Curriculum', only: (e.curriculum[r] || []).map((x) => x.ref) });
            e.extraSlots.push({ rank: 0, count: 1, kind: 'curriculum', label: 'Curriculum cantrip', only: (e.curriculum[0] || []).map((x) => x.ref) });
          }
        }
      }
      // Cleric divine font
      if (cfg.font) {
        const fontItem = ch.items.find((i) => i.rec.slug === 'divine-font');
        const choice = fontItem?.sel?.divineFont;
        const spell = choice === 'harm' ? '@spells/harm' : choice === 'heal' ? '@spells/heal' : null;
        const count = L >= 15 ? 6 : L >= 5 ? 5 : 4;
        e.font = { rank: maxRank, count, spell, rec: spell ? db.get(spell) : null };
        e.extraSlots.push({ rank: maxRank, count, kind: 'font', label: spell ? `Divine font (${db.get(spell)?.name})` : 'Divine font', only: spell ? [spell] : ['@spells/heal', '@spells/harm'] });
        if (!spell) e.warnings.push('Choose your divine font (heal or harm)');
      }
    }
    out.entries.push(e);

    // Animist: a second, spontaneous apparition entry
    if (cfg.apparition) {
      const aSlots = apparitionSlots(L);
      const aMax = Math.max(0, ...Object.keys(aSlots).map(Number).filter((r) => r <= 9));
      const ap = {
        id: 'apparition', label: 'Apparition spells', source: 'class', trad, type: 'spontaneous', attr, ...stats(attr),
        slots: aSlots, maxRank: aMax, cantrips: L >= 15 ? 4 : L >= 7 ? 3 : 2, extraSlots: [], granted: [], warnings: [],
        note: 'Your apparition repertoire is the spells of the apparitions you attune to each day. Add the ones you are attuned to.',
        repLimits: null, repertoire: {}, signatureCount: 0, signature: [], daily: true,
      };
      const aRep = ((sp.arch || {}).apparition || {}).rep || {};
      for (let r = 0; r <= aMax; r++) ap.repertoire[r] = (aRep[r] || []).map(ref).filter(valid);
      out.entries.push(ap);
    }
  }

  // ------------------------------------------------------------------ archetype spellcasting
  const archFeats = ch.feats.filter((f) => f.rec.archCasting);
  const dedications = archFeats.filter((f) => f.rec.archCasting.role === 'dedication');
  // Spellcasting dedications that are not written in the "key spellcasting attribute" form (e.g. summoner).
  const slotArchs = new Set(archFeats.filter((f) => f.rec.archCasting.role === 'slots' && f.rec.arch).map((f) => f.rec.arch));
  for (const a of slotArchs) {
    if (dedications.some((d) => d.rec.arch === a)) continue;
    const d = ch.feats.find((f) => f.rec.arch === a && (f.rec.traits || []).includes('dedication'));
    if (d) dedications.push({ ...d, synthetic: true });
  }
  for (const d of dedications) {
    const arch = d.rec.arch;
    if (cls && arch === cls.slug) continue;
    const info = d.rec.archCasting || {};
    const base = CASTERS[arch] || {};
    const under = itemsUnder(d.key);
    let trad = info.trad || tradFrom(under) || (TRADS.includes(base.trad) ? base.trad : null);
    if (!trad && arch === 'summoner' && TRADS.includes(ch.flags['eidolon.tradition'])) trad = ch.flags['eidolon.tradition'];
    let attr = info.attr || base.attr;
    if (!attr) {
      // "the attribute you used to qualify" (psychic) or the class's key attribute options
      const keys = arch === 'psychic' ? ['int', 'cha'] : (db.get('@classes/' + arch)?.keyAbility || ['cha']);
      attr = keys.reduce((best, k) => (A[k] > A[best] ? k : best), keys[0]);
    }
    const type = info.type || base.type || 'spontaneous';
    const slots = {};
    for (const f of archFeats.filter((x) => x.rec.archCasting.role === 'slots' && x.rec.arch === arch)) {
      for (const [lvl, rank] of ARCH_SLOTS[f.rec.archCasting.tier] || []) if (L >= lvl) slots[rank] = Math.max(slots[rank] || 0, 1);
    }
    const maxRank = Math.max(0, ...Object.keys(slots).map(Number));
    // Breadth feats (Occult Breadth, Arcane Breadth…): one more slot, and repertoire spell, for each rank but the two highest.
    const breadth = archFeats.concat(ch.items).some((x) => x.rec.arch === arch && /-breadth$/.test(x.rec.slug));
    if (breadth) for (const r of Object.keys(slots).map(Number)) if (r <= maxRank - 2) slots[r] += 1;
    const store = (sp.arch || {})[arch] || {};
    const e = {
      id: 'arch:' + arch, arch, label: titleCase(arch.replace(/-/g, ' ')) + ' archetype', source: 'archetype', feat: d.rec,
      trad, type, attr, ...stats(attr), slots, maxRank, cantrips: arch === 'psychic' ? 1 : 2, extraSlots: [], granted: [], warnings: [],
    };
    if (!trad) e.warnings.push('Tradition depends on a choice in ' + d.rec.name);
    if (type === 'spontaneous') {
      e.repLimits = { 0: e.cantrips };
      for (const r of Object.keys(slots)) e.repLimits[r] = slots[r];
      e.repertoire = {};
      for (const r of Object.keys(e.repLimits)) {
        e.repertoire[r] = ((store.rep || {})[r] || []).map(ref).filter(valid);
        const need = e.repLimits[r] - e.repertoire[r].length;
        if (need > 0) e.warnings.push(`${e.label}: choose ${need} ${Number(r) === 0 ? 'cantrip' : ordinal(r) + '-rank spell'}${need > 1 ? 's' : ''}`);
      }
      e.signatureCount = 0; e.signature = [];
    } else {
      // Prepared archetype casters keep a small book of known spells (wizard: spellbook, witch: familiar).
      const book = store.book || {};
      e.book = { label: 'Known spells', spells: {}, limit: null, count: 0, cantripCount: 0 };
      for (const [r, list] of Object.entries(book)) {
        e.book.spells[r] = (list || []).map(ref).filter(valid);
        if (Number(r) === 0) e.book.cantripCount += e.book.spells[r].length; else e.book.count += e.book.spells[r].length;
      }
    }
    if (arch === 'psychic') {
      const mind = under.find((i) => i.rec.psychic);
      if (mind) { e.mind = mind.rec; e.note = 'Psi cantrip from your conscious mind: pick it among your cantrips.'; }
    }
    out.entries.push(e);
  }

  // ------------------------------------------------------------------ focus spells
  const focus = out.focus;
  const seen = new Set();
  const classEntry = out.entries.find((e) => e.id === 'class');
  const addFocus = (r, source, it, extra = {}) => {
    if (!r || seen.has(r)) return;
    const x = ref(r);
    if (!valid(x)) return;
    seen.add(r);
    const g = it?.rec?.spellGrants || {};
    // Tradition and attribute: the feature's own text, the class's casting, or the class key attribute.
    const traitClass = (x.rec.traits || []).find((t) => CLASS_TRAITS.has(t));
    const sameClass = classEntry && (!traitClass || traitClass === cls.slug);
    const archEntry = out.entries.find((e) => e.arch && e.arch === traitClass);
    const def = FOCUS_DEFAULTS[traitClass] || [];
    const attr = g.focusAttr || (sameClass ? classEntry.attr : null) || archEntry?.attr || def[1] || (traitClass && CASTERS[traitClass]?.attr) || ch.keyAttr || 'cha';
    const trad = g.focusTrad || (sameClass ? classEntry.trad : null) || archEntry?.trad || def[0] || (traitClass && TRADS.includes(CASTERS[traitClass]?.trad) ? CASTERS[traitClass].trad : null);
    const item = { ...x, source, trad, attr, ...stats(attr), ...extra };
    (isCantrip(x.rec) ? focus.cantrips : focus.spells).push(item);
  };
  const innateFromItems = [];
  for (const it of ch.items) {
    const g = it.rec.spellGrants;
    if (!g) continue;
    if (g.tiers) {
      const t = g.tiers, k = TIER_FEATS[t.kind] || {};
      if (t.initial) addFocus(t.initial, it.rec.name, it, { tier: 'initial' });
      if (t.advanced && (k.advanced || []).some((s) => owned.has(s))) addFocus(t.advanced, it.rec.name, it, { tier: 'advanced' });
      if (t.greater && (k.greater || []).some((s) => owned.has(s))) addFocus(t.greater, it.rec.name, it, { tier: 'greater' });
    }
    for (const r of g.learn || []) { const rec = db.get(r); if (isFocusLike(rec)) addFocus(r, it.rec.name, it); }
    (g.choose || []).forEach((group, gi) => {
      // A ChoiceSet on the same item already makes this choice (e.g. Divine Font: heal or harm).
      const inGroup = (v) => (typeof v === 'string' ? group.find((r) => r === v || r.endsWith('/' + v)) : null);
      const cs = ch.choices.find((c) => c.key === it.key && c.options.some((o) => inGroup(o.value)));
      const n = (g.chooseN || [])[gi] || 1;
      const taken = [];
      if (cs) {
        // The item's own ChoiceSet asks for the first spell (it shows with the item's other choices).
        // Innate spells chosen that way still have to reach the spell list; "choose two" asks for the rest here.
        if (!g.innate) return;
        const v = inGroup(cs.value);
        if (v) { taken.push(v); const x = ref(v); if (valid(x) && !isFocusLike(x.rec)) innateFromItems.push({ ...x, it, g }); }
      }
      for (let k = cs ? 1 : 0; k < n; k++) {
        const key = it.key + '#' + gi + (k ? '.' + k : '');
        const picked = (sp.pick || {})[key];
        const ok = group.includes(picked) && !taken.includes(picked);
        out.picks.push({ key, source: it.rec.name + (n > 1 ? ` (${k + 1} of ${n})` : ''), options: group.map(ref).filter(valid), value: ok ? picked : null, innate: !!g.innate });
        if (!ok) continue;
        taken.push(picked);
        const x = ref(picked);
        if (g.innate && !isFocusLike(x.rec)) innateFromItems.push({ ...x, it, g });
        else addFocus(picked, it.rec.name, it);
      }
    });
  }
  // Cleric domains (Domain Initiate, Deity's Domain and similar choices) and Advanced Domain
  const domainChoices = ch.choices.filter((c) => c.domainChoice && c.value);
  const domains = [...new Set(domainChoices.map((c) => c.value))].map((s) => db.get('@domains/' + s)).filter(Boolean);
  out.domains = domains;
  for (const c of domainChoices) {
    const d = db.get('@domains/' + c.value);
    if (d?.spell) addFocus(d.spell, `${d.name} domain`, c.item);
  }
  if (domains.length && (owned.has('advanced-domain') || owned.has('advanced-deitys-domain'))) {
    const d = domains.length === 1 ? domains[0] : domains.find((x) => x.slug === sp.advDomain);
    out.advancedDomain = { options: domains, value: d?.slug || null };
    if (d?.advanced) addFocus(d.advanced, `${d.name} domain (advanced)`, null);
  }
  for (const r of sp.focusExtra || []) addFocus(r, 'Added by you', null, { manual: true });
  // Focus pool: from rules, otherwise one point per focus spell (max 3)
  focus.max = Math.max(0, Math.min(3, ch.focusMax || Math.min(3, focus.spells.length)));
  if (focus.spells.length && !ch.focusMax) focus.estimated = true;

  // ------------------------------------------------------------------ innate spells
  const extraUsed = new Set(); // spells added by hand that fill an innate pick
  const innStats = () => { const o = stats('cha'); return { attack: o.attack, dc: o.dc, prof: o.rank }; };
  const innateRank = (rec, g, p) => (isCantrip(rec) ? out.cantripRank : (p && p.orLower ? rec.rank : (g.innateRank || rec.rank)));
  // Ancestral Mind (psychic): innate spells from ancestry feats and heritages can use the psychic attribute and
  // become occult.
  const psyAttr = owned.has('ancestral-mind') ? out.entries.find((e) => e.psiCantrips || e.mind)?.attr : null;
  const ancestral = (it) => psyAttr && (it.pack === 'heritages' || it.pack === 'ancestryfeatures' || (it.pack === 'feats' && it.rec.cat === 'ancestry'));
  const pushInnate = (x, it, g, p) => {
    const anc = ancestral(it);
    const st = anc ? (() => { const o = stats(psyAttr); return { attack: o.attack, dc: o.dc, prof: o.rank }; })() : innStats();
    out.innate.push({ ...x, rank: innateRank(x.rec, g, p), srcArch: it.rec.arch || null, source: it.rec.name + (anc ? ' · Ancestral Mind' : ''), trad: anc ? 'occult' : g.innateTrad || (p && !Array.isArray(p.trad) ? p.trad : null), attr: anc ? psyAttr : 'cha', ...st });
  };
  for (const it of ch.items) {
    const g = it.rec.spellGrants;
    if (!g?.innate) continue;
    for (const r of g.learn || []) {
      const x = ref(r);
      if (!valid(x) || isFocusLike(x.rec)) continue;
      pushInnate(x, it, g);
    }
    // "Choose one cantrip from the arcane spell list": archetype innate casting is handled just below.
    if (it.rec.archCasting) continue;
    (g.innatePick || []).forEach((p, i) => {
      const key = it.key + '#i' + i;
      let picked = (sp.pick || {})[key];
      // Not picked yet, but a spell added by hand fits it (Pathbuilder imports, and characters made before this pick
      // existed, have Captivator's cantrips as added spells): it counts as the pick.
      if (!picked) {
        const ex = (sp.innateExtra || []).find((e) => e && e.ref && !extraUsed.has(e.ref) && !Object.values(sp.pick || {}).includes(e.ref) && fitsInnatePick(db.get(e.ref), p));
        if (ex) { picked = ex.ref; extraUsed.add(ex.ref); }
      }
      const x = picked ? ref(picked) : null;
      const ok = !!(x && valid(x) && fitsInnatePick(x.rec, p));
      out.picks.push({ key, source: it.rec.name, list: p, value: ok ? picked : null, innate: true });
      if (ok) pushInnate(x, it, g, p);
    });
  }
  for (const x of innateFromItems) pushInnate({ ref: x.ref, rec: x.rec }, x.it, x.g);
  // Feats that let archetype innate spells be cast more often. Captivating Intensity: each captivator spell
  // once more a day, except the two highest-ranked ones.
  const innFeats = archFeats.filter((x) => x.rec.archCasting.role === 'innate');
  const perDayFor = (arch, rank) => {
    let n = 1;
    for (const e of INNATE_EXTRA) {
      if (e.arch !== arch || !owned.has(e.feat)) continue;
      const ranks = [...new Set(innFeats.filter((x) => x.rec.arch === arch).flatMap((x) => (x.rec.archCasting.ranks || []).filter(([lvl]) => L >= lvl).map(([, r]) => r)))].sort((a, b) => b - a);
      if (!ranks.slice(0, e.exceptTop).includes(rank)) n += e.extra;
    }
    return n;
  };
  for (const f of innFeats) {
    const picks = ((sp.innate || {})[f.rec.slug]) || {};
    for (const [lvl, rank] of f.rec.archCasting.ranks || []) {
      if (L < lvl) continue;
      const r = picks[rank];
      const x = r ? ref(r) : null;
      out.innate.push({ ...(x && valid(x) ? x : { ref: null, rec: null }), rank, pickFor: { feat: f.rec.slug, rank, trad: f.rec.archCasting.trad, traits: f.rec.archCasting.traits || null }, perDay: perDayFor(f.rec.arch, rank), source: f.rec.name, trad: f.rec.archCasting.trad, attr: 'cha', ...innStats() });
    }
  }
  for (const x of sp.innateExtra || []) {
    if (extraUsed.has(x.ref)) continue; // counted as a pick above
    const s = ref(x.ref);
    if (valid(s)) out.innate.push({ ...s, rank: x.rank || (isCantrip(s.rec) ? out.cantripRank : s.rec.rank), source: 'Added by you', manual: true, attr: 'cha', ...innStats() });
  }

  // Warnings go to the character's list as well
  for (const e of out.entries) for (const w of e.warnings) ch.warnings.push(e.id === 'class' ? 'Spells: ' + w.replace(/^Repertoire: /, 'repertoire — ') : w);
  for (const p of out.picks || []) if (!p.value) ch.warnings.push(`${p.source}: choose a spell`);
  out.any = out.entries.length > 0 || focus.spells.length > 0 || focus.cantrips.length > 0 || out.innate.length > 0 || (out.picks || []).length > 0;
  return out;
}

/** Slot list for daily preparation / casting: one row per slot. */
export function slotRows(e) {
  const rows = [];
  if (e.type === 'prepared') for (let i = 0; i < (e.cantrips || 0); i++) rows.push({ rank: 0, i, kind: 'normal', id: `0:${i}` });
  for (const [r, n] of Object.entries(e.slots || {})) for (let i = 0; i < n; i++) rows.push({ rank: Number(r), i, kind: 'normal', id: `${r}:${i}` });
  for (const x of e.extraSlots || []) for (let i = 0; i < x.count; i++) rows.push({ rank: x.rank, i, kind: x.kind, label: x.label, only: x.only, id: `${x.kind}:${x.rank}:${i}` });
  return rows.sort((a, b) => a.rank - b.rank || (a.kind === 'normal' ? 0 : 1) - (b.kind === 'normal' ? 0 : 1) || a.i - b.i);
}
