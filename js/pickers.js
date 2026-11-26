// Pickers built on the drawer: feats, spells, ChoiceSet choices, deities — plus the choice rows
// that open them. Used by the builder, the level-up page and the sheet.
import { refOf } from './data.js';
import { toast, traitChips, actionGlyph, esc, showRef } from './ui.js';
import { titleCase } from './util.js';
import { spellList, isCantrip, ordinal } from './casting.js';
import { openDrawer } from './drawer.js';

const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function rarityBadge(rec) {
  return rec && rec.rarity && rec.rarity !== 'common' ? ` <span class="badge ${esc(rec.rarity)}">${esc(titleCase(rec.rarity))}</span>` : '';
}
const rarityChips = (items) => (items.some((i) => i.rarity && i.rarity !== 'common')
  ? [{ id: 'all', label: 'All' }, { id: 'common', label: 'Common', test: (i) => !i.rarity || i.rarity === 'common' }, { id: 'rare', label: 'Uncommon & rare', test: (i) => i.rarity && i.rarity !== 'common' }]
  : []);
export function recDetail(rec, extra = '') {
  return `<div class="row between" style="align-items:baseline"><h3>${esc(rec.name)} <span class="muted small">${actionGlyph(rec)}</span></h3>${rec.level != null ? `<span class="mono muted">${rec._pack === 'spells' ? (isCantrip(rec) ? 'Cantrip' : 'Rank ' + rec.rank) : 'Level ' + rec.level}</span>` : ''}</div>
    ${traitChips(rec.traits, rec.rarity)}${extra}${rec.src ? `<p class="tiny muted" style="margin:4px 0 0">${esc(rec.src)}</p>` : ''}`;
}

// ------------------------------------------------------------------ choices (ChoiceSet)
function valueKey(v) { return typeof v === 'string' ? v : JSON.stringify(v); }
function sameVal(a, b) { return a === b || JSON.stringify(a) === JSON.stringify(b); }
export function optionLabel(c) {
  if (c.value === null) return null;
  const o = c.options.find((x) => sameVal(x.value, c.value));
  return o ? o.label : String(c.value);
}

/** Choice rows (one per ChoiceSet) for the items under the given keys. */
export function choiceRows(ch, prefixes, { exclude = [] } = {}) {
  const list = ch.choices.filter((c) => prefixes.some((p) => c.key === p || c.key.startsWith(p + '>')) && !exclude.some((x) => c.key.startsWith(x)));
  return list.map((c) => {
    const label = optionLabel(c);
    return `<button type="button" class="crow sub ${label ? '' : 'todo'}" data-choice-key="${esc(c.key)}" data-choice-flag="${esc(c.flag)}">
      <span class="c-icon">${label ? '✓' : '!'}</span><span class="c-main"><span class="c-label">${esc(c.prompt.replace(/\.$/, ''))}</span><div class="c-value">${label ? esc(label) : 'Choose…'}</div>${c.key.split('>').length > 1 || !label ? `<div class="c-note">${esc(c.item.rec.name)}</div>` : ''}</span><span class="c-chev">›</span></button>`;
  }).join('');
}
export function wireChoiceRows(root, ch, db, setChoice) {
  $$('[data-choice-key]', root).forEach((b) => (b.onclick = () => {
    const c = ch.choices.find((x) => x.key === b.dataset.choiceKey && x.flag === b.dataset.choiceFlag);
    if (c) openChoiceDrawer(db, c, (v) => setChoice(c.key, c.flag, v));
  }));
}

/** Drawer for one ChoiceSet: rules text when the options are items, a quick list otherwise. */
export function openChoiceDrawer(db, c, onPick) {
  const items = c.options.map((o) => {
    const rec = typeof o.value === 'string' && o.value.startsWith('@') ? db.get(o.value) : null;
    return { key: valueKey(o.value), value: o.value, name: o.label, rec, level: o.level ?? (rec && rec._pack === 'feats' ? rec.level : null), rarity: o.rarity || rec?.rarity,
      group: rec?._pack === 'deities' ? titleCase(rec.cat || 'deity') : null, disabled: o.available === false,
      meta: o.available === false ? 'Not available' : rec?._pack === 'deities' ? esc([(rec.font || []).map(titleCase).join('/'), (rec.domains || []).slice(0, 4).map(titleCase).join(', ')].filter(Boolean).join(' · ')) : '', metaClass: o.available === false ? 'bad' : '' };
  });
  if (items.some((i) => i.group)) items.sort((a, b) => (a.group || '').localeCompare(b.group || '') || a.name.localeCompare(b.name));
  const hasRecs = items.some((i) => i.rec);
  const selected = c.value !== null ? valueKey(c.value) : null;
  openDrawer({
    title: c.prompt.replace(/\.$/, ''), subtitle: esc(c.item.rec.name), db, items, selected,
    instant: !hasRecs, search: items.length > 8, chips: hasRecs ? rarityChips(items) : [], hideDisabled: items.some((i) => i.disabled) && items.length > 12,
    detail: (it) => (it.rec ? recDetail(it.rec, it.rec._pack === 'deities' ? deityFacts(db, it.rec) : '') : `<h3>${esc(it.name)}</h3>`),
    textRef: (it) => (it.rec ? refOf(it.rec) : null),
    pickLabel: (it) => 'Choose ' + it.name,
    canPick: (it) => !it.disabled,
    onPick: (it) => onPick(it.value),
  });
}
export const openChoicePicker = openChoiceDrawer;

export function deityFacts(db, d) {
  const dom = (list) => (list || []).map((x) => esc(db.get('@domains/' + x)?.name || titleCase(x))).join(', ');
  const spells = Object.entries(d.spells || {}).map(([r, ref]) => `${ordinal(r)}: <a class="ref" data-ref="${esc(ref.slice(1))}">${esc(db.get(ref)?.name || ref)}</a>`).join(' · ');
  const fact = (k, v) => (v ? `<div class="fact"><div class="k">${k}</div><div class="v">${v}</div></div>` : '');
  return `<div class="facts">
      ${fact('Divine font', esc((d.font || []).map(titleCase).join(' or ')))}
      ${fact('Sanctification', d.sanct?.length ? esc((d.sanctModal === 'must' ? 'must be ' : 'can be ') + d.sanct.join(' or ')) : 'none')}
      ${fact('Divine attribute', esc((d.attribute || []).map((a) => a.toUpperCase()).join(' or ')))}
      ${fact('Divine skill', esc((d.skill || []).map(titleCase).join(', ')))}
      ${fact('Favored weapon', esc((d.weapons || []).map(titleCase).join(', ')))}</div>
    ${d.domains?.length ? `<p class="small"><b>Domains</b> ${dom(d.domains)}${d.altDomains?.length ? ` · <span class="muted">alternate: ${dom(d.altDomains)}</span>` : ''}</p>` : ''}
    ${spells ? `<p class="small"><b>Cleric spells</b> ${spells}</p>` : ''}`;
}

// ------------------------------------------------------------------ feats
const SLOT_TITLE = { ancestry: 'Ancestry feat', class: 'Class feat', archetype: 'Archetype feat', skill: 'Skill feat', general: 'General feat' };

/** Feat drawer for one slot. opts: { engine, db, build, slot, onTake(slug), showRare } */
export function openFeatDrawer({ engine, db, build, slot, onTake, showRare = true, onClose }) {
  const cls = db.get('@classes/' + build.class);
  const current = build.feats[slot.id] || null;
  const canTake = (x) => x.ok || (build.options?.ignorePrereqs && x.reasons.every((r) => r === 'Prerequisites not met'));
  const all = engine.featOptions(build, slot).filter((x) => showRare || x.rec.rarity === 'common' || x.rec.slug === current);
  const items = all.map((x) => {
    const ok = canTake(x);
    return {
      key: x.rec.slug, name: x.rec.name, level: x.rec.level, rarity: x.rec.rarity, rec: x.rec, x, disabled: !ok,
      badge: rarityBadge(x.rec) + (x.rec.action && x.rec.action !== 'passive' ? ` <span style="color:var(--accent);font-size:12px">${actionGlyph(x.rec)}</span>` : ''),
      group: !ok ? 'Not available' : (x.rec.arch && (slot.type === 'archetype' || slot.type === 'class')) ? titleCase(x.rec.arch) + ' archetype' : 'Level ' + x.rec.level,
      meta: ok ? (x.pre.unknown ? 'Check prerequisites with your GM' : (x.rec.arch && slot.type !== 'archetype' ? 'Available · archetype' : 'Available')) : esc(x.reasons.join(' · ')),
      metaClass: ok ? (x.pre.unknown ? 'warn' : 'ok') : 'bad',
    };
  });
  // Available first, keeping the engine's order inside each group.
  items.sort((a, b) => (a.disabled - b.disabled));
  const chips = slot.type === 'class' ? [{ id: 'all', label: 'All' }, { id: 'class', label: cls?.name || 'Class', test: (i) => !(i.rec.traits || []).includes('archetype') }, { id: 'arch', label: 'Archetype', test: (i) => (i.rec.traits || []).includes('archetype') }]
    : slot.type === 'general' ? [{ id: 'all', label: 'All' }, { id: 'general', label: 'General', test: (i) => i.rec.cat === 'general' }, { id: 'skill', label: 'Skill', test: (i) => i.rec.cat === 'skill' }]
    : slot.type === 'archetype' ? [{ id: 'all', label: 'All' }, { id: 'ded', label: 'Dedications', test: (i) => (i.rec.traits || []).includes('dedication') }] : [];
  return openDrawer({
    title: `${SLOT_TITLE[slot.type] || slot.label} · level ${slot.level}`, subtitle: `${items.filter((i) => !i.disabled).length} available`,
    db, items, selected: current, chips, hideDisabled: true, placeholder: 'Search feats…', onClose,
    detail: (it) => {
      const x = it.x;
      return recDetail(it.rec, `${it.rec.prereq?.length ? `<p class="small"><b>Prerequisites</b> ${x.pre.results.map((r) => `<span class="${r.ok === false ? 'bad' : r.ok === null ? 'warn' : 'ok'}">${esc(r.text)}${r.via ? ` <span class="muted">(${esc(r.via)})</span>` : ''}${r.ok === false ? ' ✗' : r.ok === null ? ' ?' : ' ✓'}</span>`).join('; ')}</p>` : ''}
        ${x.reasons.length ? `<p class="bad small">${esc(x.reasons.join(' · '))}</p>` : ''}`);
    },
    textRef: (it) => refOf(it.rec),
    canPick: (it) => !it.disabled,
    pickLabel: (it) => 'Take ' + it.name,
    onPick: (it) => { onTake(it.key); toast('Took ' + it.name, 'ok'); },
  });
}

// ------------------------------------------------------------------ spells
/**
 * Spell drawer. opts: { title, trad, rank, maxRank, cantrips, focus, only (refs), exclude (refs), showRare, exactRank, verb }
 */
export function openSpellPicker(db, opts, onPick) {
  const exclude = new Set(opts.exclude || []);
  let recs;
  if (opts.only) recs = opts.only.map((r) => db.get(r)).filter(Boolean);
  else recs = spellList(db, { trad: opts.trad, rank: opts.rank, maxRank: opts.maxRank, cantrips: !!opts.cantrips, includeUncommon: opts.showRare !== false, focus: !!opts.focus });
  recs = recs.filter((s) => !exclude.has(refOf(s)));
  const items = recs.map((s) => ({
    key: refOf(s), name: s.name, level: isCantrip(s) ? 'C' : s.rank, rarity: s.rarity, rec: s,
    badge: rarityBadge(s) + ` <span style="color:var(--accent);font-size:12px">${actionGlyph(s)}</span>`,
    group: opts.cantrips || opts.only ? null : (isCantrip(s) ? 'Cantrips' : ordinal(s.rank) + ' rank'),
    meta: esc([(s.trad || []).map(titleCase).join(', '), s.save ? titleCase(s.save) : s.vs ? 'vs ' + titleCase(s.vs) : '', s.range].filter(Boolean).join(' · ')),
  }));
  const chips = [];
  if (!opts.cantrips && !opts.only && opts.rank > 1) {
    const exact = { id: 'exact', label: `${ordinal(opts.rank)} rank`, test: (i) => i.rec.rank === opts.rank };
    const any = { id: 'any', label: `Rank ${opts.rank} or lower` };
    if (opts.exactRank === false) chips.push(any, exact); else chips.push(exact, any);
  }
  for (const c of rarityChips(items).slice(1)) chips.push(c);
  return openDrawer({
    title: opts.title || 'Choose a spell', db, items, selected: null, chips, placeholder: 'Search spells…',
    detail: (it) => {
      const s = it.rec;
      const fact = (k, v) => (v ? `<div class="fact"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>` : '');
      return recDetail(s, `<div class="facts">${fact('Cast', s.time && !/^[123]$|reaction|free/.test(s.time) ? s.time : '')}${fact('Range', s.range)}${fact('Area', s.area)}${fact('Targets', s.target)}${fact('Defense', s.save ? titleCase(s.save) : s.vs ? titleCase(s.vs) : '')}${fact('Duration', s.duration)}${fact('Traditions', (s.trad || []).map(titleCase).join(', '))}</div>`);
    },
    textRef: (it) => it.key,
    pickLabel: (it) => (opts.verb || 'Add') + ' ' + it.name,
    onPick: (it) => onPick(it.rec),
  });
}

/** Shows a record's rules text in the modal (for ⓘ buttons inside rows). */
export function wireShow(root, db) {
  $$('[data-show]', root).forEach((el) => { if (!el.onclick) el.onclick = (e) => { e.preventDefault(); e.stopPropagation(); showRef(db, el.dataset.show); }; });
}
