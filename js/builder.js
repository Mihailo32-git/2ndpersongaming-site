// Character builder as a level planner (in the spirit of Pathbuilder 2e):
// Level 1 is character creation; every later level has its own tab with just that level's choices.
// Every pick opens in the drawer. Spells, Equipment and Details have their own sections.
import { DB, refOf } from './data.js';
import { Engine, newBuild, normalizeBuild, BOOST_LEVELS } from './engine.js';
import { Store } from './store.js';
import { mountAccount, syncLabel, saveWithConflictCheck, askConflict } from './account.js';
import { toast, showRef, wireRefs, actionGlyph, rankBadge, esc } from './ui.js';
import { ATTRS, ATTR_NAMES, SKILLS, RANKS, signed, titleCase, formatPrice, formatBulk, uid, refParts } from './util.js';
import { choiceRows, wireChoiceRows, openFeatDrawer, openSpellPicker, rarityBadge, recDetail, wireShow } from './pickers.js';
import { openDrawer } from './drawer.js';
import { loadRunes, runeKind, itemRunes, materialLabel } from './runes.js';
import { openRuneManager } from './runes-ui.js';
import { renderSpellsEditor, storeFor } from './spellsui.js';
import { CASTERS, ARCH_SLOTS, ordinal, innatePickOptions } from './casting.js';

// Wrapped in an async function instead of top-level await so older tablet browsers (Chrome 80+) can run it.
(async () => {

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const main = $('#main');

const db = await new DB({ base: 'data/' }).init();
const engine = new Engine(db);
const store = await new Store().init();

// ------------------------------------------------------------------ load character
const params = new URLSearchParams(location.search);
let charRec = { id: null, build: newBuild(), state: {} };
if (params.get('id')) {
  try { charRec = await store.get(params.get('id')); }
  catch (e) { main.innerHTML = `<div class="card"><p class="bad">${esc(e.message)}</p><a class="btn" href="index.html">Back</a></div>`; throw e; }
}
const build = normalizeBuild(charRec.build);
if (!charRec.id) build.options.showRare = false;
// Another device saved this character while this one still held unsent changes: settle it first.
if (charRec.id && store.conflictFor(charRec.id)) {
  const pick = await askConflict(store.conflictFor(charRec.id));
  if (pick === 'theirs') { store.discardLocal(charRec.id); location.reload(); return; }
  if (pick === 'mine') { await store.save(charRec, { force: true }).catch((e) => toast(e.message, 'error')); }
}
if ((build.inventory || []).length || (build.formulas || []).length) await db.load(['equipment']);
await loadRunes(db);
let ch = engine.compute(build);

// ------------------------------------------------------------------ saving
let saveTimer = null, dirty = false;
const saveEl = $('#saveState');
function markDirty() {
  dirty = true;
  saveEl.textContent = 'Unsaved changes…'; saveEl.className = 'save-state';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 1000);
}
let saving = null;
async function save() {
  if (!dirty) return;
  if (saving) return saving.then(() => save());
  saving = (async () => {
    try {
      charRec.build = build;
      charRec.name = build.name || 'Unnamed';
      dirty = false;
      if (!(await saveWithConflictCheck(store, charRec))) return;
      showSaved();
      if (params.get('id') !== charRec.id) { params.set('id', charRec.id); history.replaceState(null, '', '?' + params.toString() + location.hash); }
      sheetLink();
    } catch (e) { dirty = true; saveEl.textContent = 'Not saved: ' + e.message; saveEl.className = 'save-state bad'; }
  })().finally(() => { saving = null; });
  return saving;
}
function showSaved() {
  if (dirty) return;
  const st = isLocal() ? { kind: 'local' } : store.syncState();
  saveEl.textContent = syncLabel(st);
  saveEl.className = 'save-state ' + (st.kind === 'saved' || st.kind === 'local' ? 'saved' : st.kind === 'conflict' || st.kind === 'login' ? 'bad' : 'warn');
}
const isLocal = () => store.mode !== 'api' || String(charRec.id || '').startsWith('local-');
store.onChange(showSaved);
mountAccount(store, { onAuthChange: async () => { if (dirty) await save(); location.reload(); } });
window.addEventListener('beforeunload', (e) => { if (dirty) { save(); e.preventDefault(); e.returnValue = ''; } });
function sheetLink() {
  const a = $('#sheetLink');
  a.hidden = !charRec.id;
  if (charRec.id) a.href = 'sheet.html?id=' + encodeURIComponent(charRec.id);
  a.onclick = async (e) => { if (dirty) { e.preventDefault(); await save(); location.href = a.href; } };
}
sheetLink();

function update(rerender = true) {
  ch = engine.compute(build);
  markDirty();
  if (rerender) render(); else { renderChrome(); }
}
function setChoice(key, flag, v) {
  build.choices[key] = Object.assign({}, build.choices[key] || {});
  if (v === undefined) delete build.choices[key][flag]; else build.choices[key][flag] = v;
  update();
}
const showRare = (rec, selected) => build.options.showRare || !rec.rarity || rec.rarity === 'common' || selected;

// ------------------------------------------------------------------ routing
// '#level-N' shows the planner (all levels one under another) scrolled to level N.
// '#spells', '#gear' and '#details' are their own pages.
let currentLevel = 1;
function view() {
  const h = location.hash.slice(1);
  const m = h.match(/^level-(\d+)$/);
  if (m) return { kind: 'build', n: Math.min(Math.max(1, Number(m[1])), ch.level) };
  if (['spells', 'gear', 'details'].includes(h)) return { kind: h };
  if (h === 'basics' || h === 'review') return { kind: 'details' };
  return { kind: 'build', n: null };
}
let scrollTarget = view().n;
window.addEventListener('hashchange', () => {
  const v = view();
  if (v.kind === 'build' && main.querySelector('.pl-page')) { renderChrome(); scrollToLevel(v.n || 1); return; }
  scrollTarget = v.kind === 'build' ? v.n : null;
  render();
  if (v.kind !== 'build') window.scrollTo(0, 0);
});
function stickyOffset() {
  const t = $('.topbar'), s = $('.subbar');
  return (t ? t.offsetHeight : 0) + (s ? s.offsetHeight : 0) + 10;
}
function scrollToLevel(n, smooth = true) {
  const el = document.getElementById('lvl-' + n);
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY - stickyOffset();
  window.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  setRailCurrent(n);
}
function setRailCurrent(n) {
  currentLevel = n;
  $$('#rail .lv-chip[data-level]').forEach((c) => { if (Number(c.dataset.level) === n) c.setAttribute('aria-current', 'true'); else c.removeAttribute('aria-current'); });
  const cur = $('#rail [aria-current]');
  const rail = $('#rail');
  if (cur && rail) { const r = cur.offsetLeft - rail.clientWidth / 2 + cur.offsetWidth / 2; rail.scrollLeft = r; }
  const b = $('#seg a[data-build]');
  if (b) b.href = '#level-' + n;
}
// Highlight the level you're looking at while scrolling.
let spyRaf = 0;
window.addEventListener('scroll', () => {
  if (spyRaf) return;
  spyRaf = requestAnimationFrame(() => {
    spyRaf = 0;
    if (view().kind !== 'build') return;
    const off = stickyOffset() + 60;
    let cur = 1;
    for (const sec of $$('.lvl-sec', main)) if (sec.getBoundingClientRect().top <= off) cur = Number(sec.dataset.level);
    if (cur !== currentLevel) setRailCurrent(cur);
  });
}, { passive: true });

// ------------------------------------------------------------------ what's left at each level
const featureLevel = (slug) => (ch.class?.items || []).find((i) => refParts(i.ref)[1] === slug)?.level || 1;
function keyLevel(key) {
  const root = key.split('>')[0].split('#')[0];
  if (root.startsWith('cf:')) return featureLevel(root.slice(3));
  if (root.startsWith('feat:')) return ch.slots.find((s) => s.id === root.slice(5))?.level || 1;
  return 1;
}
function boostDone(slot) {
  const b = build.boosts;
  if (slot.id === 'ancestry') return slot.options.every((_, i) => b.ancestry[i]);
  if (slot.id === 'ancestryAlt') return (b.ancestryAlt || []).filter(Boolean).length >= 2;
  if (slot.id === 'background') return slot.options.every((o, i) => o.length <= 1 || b.background[i]);
  if (slot.id === 'class') return (slot.options[0] || []).length <= 1 || !!b.class;
  return (b[slot.id] || []).filter(Boolean).length >= 4;
}
const boostSlotsAt = (lv) => ch.boostSlots.filter((x) => (lv === 1 ? (!/^\d+$/.test(x.id) || x.id === '1') : x.id === String(lv)));
function classSkillsLeft() { return Math.max(0, ch.classSkillPicks - (build.skills.class || []).filter(Boolean).length); }
function intLeft(lv) { return Math.max(0, (ch.intPicks[lv] || 0) - (build.skills.int[lv] || []).filter(Boolean).length); }
function langsLeft() { return Math.max(0, ch.languageSlots - (build.languages || []).filter(Boolean).length); }
function levelTodos(n) {
  const t = [];
  if (n === 1) {
    if (!build.ancestry) t.push('Ancestry');
    if (build.ancestry && !build.heritage) t.push('Heritage');
    if (!build.background) t.push('Background');
    if (!build.class) t.push('Class');
    if (ch.class && classSkillsLeft()) t.push('Class skills');
    if (langsLeft()) t.push('Languages');
  }
  for (const s of boostSlotsAt(n)) if (!boostDone(s)) t.push(s.label);
  if (intLeft(n)) t.push('Intelligence skills');
  if (ch.increaseLevels.includes(n) && !build.skills.inc[n]) t.push('Skill increase');
  for (const s of ch.slots.filter((x) => x.level === n)) if (!build.feats[s.id]) t.push(s.label);
  for (const c of ch.pending) if (keyLevel(c.key) === n) t.push(c.prompt);
  return t;
}
function spellTodo() {
  const s = ch.spellcasting;
  return s.entries.reduce((n, e) => n + e.warnings.length, 0) + s.picks.filter((p) => !p.value).length;
}

// ------------------------------------------------------------------ chrome: context, section switcher, stats, level rail
function renderChrome() {
  $('#ctx').textContent = [build.name || 'New character', `Level ${ch.level}${ch.class ? ' ' + ch.class.name : ''}`].join(' · ');
  const v = view();
  const st = spellTodo();
  const buildLeft = Array.from({ length: ch.level }, (_, i) => levelTodos(i + 1).length).reduce((a, b) => a + b, 0);
  $('#seg').innerHTML = [
    ['level-' + currentLevel, 'Build', v.kind === 'build', buildLeft, 'data-build'],
    ...(ch.spellcasting.any ? [['spells', 'Spells', v.kind === 'spells', st, '']] : []),
    ['gear', 'Equipment', v.kind === 'gear', 0, ''],
    ['details', 'Details', v.kind === 'details', 0, ''],
  ].map(([h, l, cur, n, attr]) => `<a href="#${h}" ${attr} ${cur ? 'aria-current="page"' : ''}>${l}${n ? `<span class="count" aria-label="${n} to do">${n}</span>` : ''}</a>`).join('');
  const e0 = ch.spellcasting.entries[0];
  const ss = (k, v2, cls = '') => `<span class="ss ${cls}"><span class="k">${k}</span><span class="v">${v2}</span></span>`;
  $('#stats').innerHTML = [ss('HP', ch.hp.max), ss('AC', ch.ac.total), ss('Fort', signed(ch.saves.fortitude.total)), ss('Ref', signed(ch.saves.reflex.total)), ss('Will', signed(ch.saves.will.total)),
    ss('Perc', signed(ch.perception.total)), ch.classDC ? ss('Class DC', ch.classDC.total) : '', e0 ? ss('Spell DC', e0.dc) : '', ss('Speed', ch.speed.total),
    ...ATTRS.map((a) => ss(a.toUpperCase(), signed(ch.attrs[a]), 'attr'))].join('');
  const rail = $('#rail');
  rail.hidden = v.kind !== 'build';
  const sub = $('.subbar');
  if (sub) sub.classList.toggle('build', v.kind === 'build');
  if (v.kind === 'build') {
    let html = '';
    for (let n = 1; n <= ch.level; n++) {
      const todo = levelTodos(n).length;
      html += `<a class="lv-chip" href="#level-${n}" data-level="${n}" ${currentLevel === n ? 'aria-current="true"' : ''} aria-label="Level ${n}${todo ? `, ${todo} to choose` : ', done'}">${n}<span class="dot ${todo ? 'todo' : ''}"></span></a>`;
    }
    if (ch.level < 20) html += `<button type="button" class="lv-chip add" id="addLevel" title="Add level ${ch.level + 1}">+ ${ch.level + 1}</button>`;
    rail.innerHTML = html;
    $$('#rail a.lv-chip', rail.parentNode).forEach((a) => (a.onclick = (e) => {
      e.preventDefault();
      const n = Number(a.dataset.level);
      history.replaceState(null, '', '?' + params.toString() + '#level-' + n);
      scrollToLevel(n);
    }));
    const add = $('#addLevel');
    if (add) add.onclick = addLevel;
  }
}
function addLevel() {
  if (build.level >= 20) return;
  build.level++;
  ch = engine.compute(build);
  markDirty();
  scrollTarget = build.level;
  history.replaceState(null, '', '?' + params.toString() + '#level-' + build.level);
  render();
  toast(`Level ${build.level} added`, 'ok');
}

function render() {
  renderChrome();
  const v = view();
  main.innerHTML = '';
  if (v.kind === 'build') renderPlanner(main);
  else RENDER[v.kind](main);
  wireRefs(db, main);
  wireShow(main, db);
  wireChoiceRows(main, ch, db, setChoice);
  if (v.kind === 'build' && scrollTarget) { const n = scrollTarget; scrollTarget = null; requestAnimationFrame(() => scrollToLevel(n, false)); }
}

// ------------------------------------------------------------------ small building blocks
/** A choice row: label, value (or "Choose…"), note, and what happens on click. */
function crow({ label, value, note = '', noteBad = false, todo = false, info = false, icon, act, clear, show, sub = false }) {
  const ic = icon != null ? String(icon) : (info ? 'i' : todo ? '!' : '✓');
  return `<div class="crow-wrap"><button type="button" class="crow ${sub ? 'sub' : ''} ${todo ? 'todo' : ''} ${info ? 'info' : ''}" ${act ? `data-act='${esc(JSON.stringify(act))}'` : ''} ${show && !act ? `data-show="${esc(show)}"` : ''}>
    <span class="c-icon">${esc(ic)}</span><span class="c-main"><span class="c-label">${esc(label)}</span><div class="c-value">${value}</div>${note ? `<div class="c-note ${noteBad ? 'bad' : ''}">${note}</div>` : ''}</span>
    ${act ? '<span class="c-chev">›</span>' : show ? '<span class="c-chev" style="font-size:14px">ⓘ</span>' : ''}</button>
    ${clear ? `<button type="button" class="c-x" data-clear='${esc(JSON.stringify(clear))}' aria-label="Remove">✕</button>` : ''}</div>`;
}
function group(title, body, { span2 = false, right = '' } = {}) {
  return `<section class="group ${span2 ? 'span2' : ''}"><div class="group-title"><h2>${esc(title)}</h2>${right}</div><div class="group-body">${body}</div></section>`;
}
const subhead = (t) => `<div class="lvl-subhead">${esc(t)}</div>`;
function featRow(s) {
  const slug = build.feats[s.id];
  const rec = slug ? db.get('@feats/' + slug) : null;
  const problem = ch.prereqProblems.find((p) => p.slot.id === s.id);
  const granted = rec ? ch.items.filter((i) => i.key.startsWith('feat:' + s.id + '>') && !['actions', 'deities'].includes(i.pack) && i.key.split('>').length === 2) : [];
  const note = rec ? [actionGlyph(rec) ? `<span style="color:var(--accent)">${actionGlyph(rec)}</span>` : '', rec.arch && s.type !== 'archetype' ? esc(titleCase(rec.arch) + ' archetype') : '',
    granted.length ? 'grants ' + granted.map((g) => esc(g.rec.name)).join(', ') : '', problem ? 'Prerequisites not met' : ''].filter(Boolean).join(' · ') : '';
  return crow({ label: s.label, value: rec ? esc(rec.name) + rarityBadge(rec) : 'Choose…', note, noteBad: !!problem, todo: !rec, icon: rec ? (s.type[0] || 'F').toUpperCase() : '!', act: { t: 'feat', slot: s.id }, clear: rec ? { t: 'feat', slot: s.id } : null })
    + (rec ? choiceRows(ch, ['feat:' + s.id]) : '');
}
function featureRows(levelN) {
  let html = '';
  for (const f of (ch.class?.items || []).filter((i) => i.level === levelN)) {
    const key = 'cf:' + refParts(f.ref)[1];
    const granted = ch.items.filter((i) => i.key.startsWith(key + '>') && !['actions', 'deities'].includes(i.pack) && i.key.split('>').length === 2);
    html += crow({ label: 'Class feature', value: esc(f.name.replace(/^\(Choice\) /, '')), info: true, show: f.ref, note: granted.length ? '→ ' + granted.map((g) => esc(g.rec.name)).join(', ') : '' })
      + choiceRows(ch, [key]);
  }
  return html;
}
const attrBar = () => `<div class="attr-bar">${ATTRS.map((a) => `<div class="pill"><span class="pill-label">${a.toUpperCase()}</span><span class="pill-value">${signed(ch.attrs[a])}</span>${ch.partialBoosts[a] ? '<span class="tiny muted">+ partial</span>' : ''}</div>`).join('')}</div>`;
const fact = (k, v) => (v ? `<div class="fact"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>` : '');

// ------------------------------------------------------------------ actions (open drawers)
function act(a) {
  if (a.t === 'feat') {
    const slot = ch.slots.find((s) => s.id === a.slot);
    if (slot) openFeatDrawer({ engine, db, build, slot, showRare: build.options.showRare, onTake: (slug) => { build.feats[slot.id] = slug; update(); } });
  } else if (a.t === 'ancestry') pickAncestry();
  else if (a.t === 'heritage') pickHeritage();
  else if (a.t === 'background') pickBackground();
  else if (a.t === 'class') pickClass();
  else if (a.t === 'skills') pickTraining('class', 1);
  else if (a.t === 'int') pickTraining('int', a.lv);
  else if (a.t === 'langs') pickLanguages();
  else if (a.t === 'inc') pickIncrease(a.lv);
  else if (a.t === 'boosts') openBoosts(a.lv);
  else if (a.t === 'repspell') pickRepertoireSpell(a);
  else if (a.t === 'spelleditor') openSpellEditor(a);
  else if (a.t === 'spellpick') pickChooseOne(a.key);
}
function pickAncestry() {
  const items = db.list('ancestries').filter((r) => showRare(r, r.slug === build.ancestry)).map((r) => ({ key: r.slug, name: r.name, rarity: r.rarity, rec: r, badge: rarityBadge(r), meta: esc(`${r.hp} HP · ${titleCase(r.size)} · ${r.speed} ft`) }));
  openDrawer({
    title: 'Ancestry', subtitle: `${items.length} ancestries`, db, items, selected: build.ancestry,
    detail: (it) => { const r = it.rec; return recDetail(r, `<div class="facts">${fact('Hit points', r.hp)}${fact('Size', esc(titleCase(r.size)))}${fact('Speed', r.speed + ' ft')}${fact('Vision', esc(titleCase(r.vision)))}
      ${fact('Boosts', esc(r.boosts.filter((b) => b.length).map((b) => (b.length === 1 ? ATTR_NAMES[b[0]] : 'Free')).join(', ')))}${r.flaws.some((f) => f.length === 1) ? fact('Flaw', esc(r.flaws.filter((f) => f.length === 1).map((f) => ATTR_NAMES[f[0]]).join(', '))) : ''}
      ${fact('Languages', esc(r.languages.map(titleCase).join(', ')) + (r.addLanguageCount ? ` +${r.addLanguageCount}` : ''))}</div>`); },
    textRef: (it) => refOf(it.rec), pickLabel: (it) => 'Choose ' + it.name,
    onPick: (it) => {
      build.ancestry = it.key;
      const h = db.get('@heritages/' + build.heritage);
      if (h && h.ancestry && h.ancestry !== it.key) build.heritage = null;
      build.boosts.ancestry = [];
      update();
      if (!build.heritage) setTimeout(pickHeritage, 250);
    },
  });
}
function pickHeritage() {
  if (!build.ancestry) { pickAncestry(); return; }
  const anc = db.get('@ancestries/' + build.ancestry);
  const items = db.list('heritages').filter((h) => (h.ancestry === build.ancestry || !h.ancestry) && showRare(h, h.slug === build.heritage))
    .sort((a, b) => (!!a.ancestry === !!b.ancestry ? a.name.localeCompare(b.name) : a.ancestry ? -1 : 1))
    .map((h) => ({ key: h.slug, name: h.name, rarity: h.rarity, rec: h, badge: rarityBadge(h), group: h.ancestry ? anc.name + ' heritages' : 'Versatile heritages' }));
  openDrawer({ title: 'Heritage', subtitle: esc(anc.name), db, items, selected: build.heritage, detail: (it) => recDetail(it.rec), textRef: (it) => refOf(it.rec),
    onPick: (it) => { build.heritage = it.key; update(); } });
}
function pickBackground() {
  const items = db.list('backgrounds').filter((r) => showRare(r, r.slug === build.background)).map((r) => ({ key: r.slug, name: r.name, rarity: r.rarity, rec: r, badge: rarityBadge(r),
    meta: esc([...r.skills.map(titleCase), ...r.lore].join(', ')) }));
  openDrawer({
    title: 'Background', subtitle: `${items.length} backgrounds`, db, items, selected: build.background,
    detail: (it) => { const r = it.rec; return recDetail(r, `<div class="facts">${fact('Boosts', esc(r.boosts.filter((b) => b.length).map((b) => (b.length >= 6 ? 'Free' : b.map((x) => ATTR_NAMES[x]).join(' or '))).join(' · ')))}
      ${fact('Trained in', esc([...r.skills.map(titleCase), ...r.lore].join(', ') || '—'))}${r.items.length ? fact('Feat', r.items.map((i) => `<a class="ref" data-ref="${esc(i.ref.slice(1))}">${esc(i.name)}</a>`).join(', ')) : ''}</div>`); },
    textRef: (it) => refOf(it.rec), onPick: (it) => { build.background = it.key; build.boosts.background = []; update(); },
  });
}
function pickClass() {
  const items = db.list('classes').filter((r) => showRare(r, r.slug === build.class)).map((r) => ({ key: r.slug, name: r.name, rarity: r.rarity, rec: r, badge: rarityBadge(r),
    meta: esc(`${r.hp} HP · ${r.keyAbility.map((a) => a.toUpperCase()).join('/') || 'key from subclass'}${CASTERS[r.slug] ? ' · ' + (CASTERS[r.slug].type) + ' caster' : ''}`) }));
  openDrawer({
    title: 'Class', subtitle: `${items.length} classes`, db, items, selected: build.class,
    detail: (it) => { const r = it.rec; return recDetail(r, `<div class="facts">${fact('Hit points', r.hp + ' + Con')}${fact('Key attribute', esc(r.keyAbility.map((a) => ATTR_NAMES[a]).join(' or ') || 'From subclass'))}
      ${fact('Perception', RANKS[r.perception])}${fact('Fortitude', RANKS[r.saves.fortitude])}${fact('Reflex', RANKS[r.saves.reflex])}${fact('Will', RANKS[r.saves.will])}
      ${fact('Skills', esc(r.trainedSkills.map(titleCase).join(', ') || '—') + ` + ${r.additionalSkills} + Int`)}${r.spellcasting ? fact('Spellcasting', RANKS[r.spellcasting] + (CASTERS[r.slug] ? ' · ' + CASTERS[r.slug].type : '')) : ''}</div>`); },
    textRef: (it) => refOf(it.rec),
    onPick: (it) => {
      if (build.class && build.class !== it.key) {
        build.feats = Object.fromEntries(Object.entries(build.feats).filter(([k]) => !k.startsWith('class-')));
        build.spells = Object.assign(newBuild().spells, { arch: build.spells.arch || {}, innate: build.spells.innate || {}, innateExtra: build.spells.innateExtra || [] });
        for (const k of Object.keys(build.choices)) if (k.startsWith('cf:') || k === 'class') delete build.choices[k];
      }
      build.class = it.key; build.boosts.class = null; build.skills.class = []; update();
    },
  });
}

// ------------------------------------------------------------------ skill pickers (Pathbuilder style)
/**
 * Every skill in a list with its proficiency. Tapping one marks it and shows the rank it becomes.
 * opts: { title, intro, max, single, get() → selected skills, set(arr), base(s) → rank before, cap(s) → reason it can't be picked or '' , lores }
 */
function openSkillList(opts) {
  openDrawer({
    title: opts.title, narrow: true,
    custom: (body, api) => {
      const draw = () => {
        const sel = opts.get();
        const list = [...Object.keys(SKILLS), ...(opts.lores ? Object.keys(ch.ranks.lores).map((l) => 'lore:' + l) : [])];
        const left = opts.max - sel.length;
        body.innerHTML = `<p class="small" style="margin-top:0">${opts.intro} <span class="${left > 0 ? 'warn' : 'ok'}">${sel.length} of ${opts.max} chosen.</span></p>
          <div class="sk-list" role="listbox" aria-multiselectable="${!opts.single}">${list.map((s) => {
            const on = sel.includes(s);
            const b = opts.base(s);
            const why = on ? '' : opts.cap(s, b);
            const full = !on && !opts.single && left <= 0;
            const name = titleCase(s.replace(/^lore:/, '')) + (s.startsWith('lore:') && !/lore$/i.test(s) ? ' Lore' : '');
            const attr = s.startsWith('lore:') ? 'INT' : SKILLS[s].toUpperCase();
            const mod = s.startsWith('lore:') ? ch.lores[s.slice(5)]?.total : ch.skills[s]?.total;
            return `<button type="button" role="option" aria-selected="${on}" class="sk-row ${on ? 'on' : ''} ${why || full ? 'dis' : ''}" data-s="${esc(s)}" ${why ? 'disabled' : ''}>
              <span class="sk-ranks">${rankBadge(b)}${on ? `<span class="sk-arrow">→</span>${rankBadge(Math.min(4, b + 1))}` : ''}</span>
              <span class="sk-nm"><span class="t">${esc(name)}</span> <span class="tiny muted">${attr}</span>${on ? `<br><span class="tiny ok">Becomes ${RANKS[Math.min(4, b + 1)]}</span>` : why ? `<br><span class="tiny muted">${esc(why)}</span>` : ''}</span>
              <span class="sk-mod">${mod != null ? signed(mod) : ''}</span><span class="sk-check" aria-hidden="true">${on ? '✓' : ''}</span></button>`;
          }).join('')}</div>`;
        $$('.sk-row', body).forEach((b) => (b.onclick = () => {
          const s = b.dataset.s;
          let cur = opts.get().filter((x) => x !== s);
          if (!opts.get().includes(s)) {
            if (opts.single) cur = [s];
            else if (cur.length < opts.max) cur.push(s);
            else return;
          }
          opts.set(cur);
          ch = engine.compute(build); markDirty(); draw();
        }));
      };
      draw();
      const foot = document.createElement('div');
      foot.className = 'dr-foot';
      foot.innerHTML = '<button type="button" class="btn primary">Done</button>';
      foot.querySelector('button').onclick = api.close;
      body.parentNode.appendChild(foot);
    },
    onClose: () => render(),
  });
}
function pickTraining(field, lv) {
  const n = field === 'class' ? ch.classSkillPicks : (ch.intPicks[lv] || 0);
  const get = () => (field === 'class' ? (build.skills.class || []) : (build.skills.int[lv] || [])).filter(Boolean);
  openSkillList({
    title: field === 'class' ? 'Skill training' : `Intelligence — level ${lv}`, max: n,
    intro: field === 'class' ? `Your class lets you become trained in <b>${n}</b> skill${n > 1 ? 's' : ''} of your choice.` : `Your Intelligence went up: become trained in <b>${n}</b> more skill${n > 1 ? 's' : ''}.`,
    get, set: (arr) => { if (field === 'class') build.skills.class = arr; else build.skills.int[lv] = arr; },
    base: (s) => (get().includes(s) ? 0 : (ch.ranks.skills[s] || 0)),
    cap: (s) => {
      const picked = [...(build.skills.class || []), ...Object.entries(build.skills.int || {}).filter(([k]) => !(field === 'int' && k === String(lv))).flatMap(([, v]) => v)];
      if (field === 'int' && (build.skills.class || []).includes(s)) return 'Trained (class choice)';
      if (picked.includes(s) && !get().includes(s)) return 'Trained (your other choice)';
      const src = ch.skillSources[s];
      if (src && !['Class choice', 'Intelligence'].includes(src)) return `Already trained (${src})`;
      return '';
    },
  });
}
function pickIncrease(lv) {
  const limit = lv >= 15 ? 4 : lv >= 7 ? 3 : 2;
  const R = ch.ranks;
  const get = () => (build.skills.inc[lv] ? [build.skills.inc[lv]] : []);
  const base = (s) => {
    const later = ch.increaseLevels.filter((l) => l >= lv && build.skills.inc[l] === s).length;
    return Math.max(0, (s.startsWith('lore:') ? (R.lores[s.slice(5)] || 0) : R.skills[s]) - later);
  };
  openSkillList({
    title: `Skill increase — level ${lv}`, max: 1, single: true, lores: true,
    intro: limit >= 4 ? 'Raise one skill a step — up to legendary.' : limit >= 3 ? 'Raise one skill a step — up to master.' : 'Train a new skill or raise one to expert.',
    get, set: (arr) => { if (arr[0]) build.skills.inc[lv] = arr[0]; else delete build.skills.inc[lv]; },
    base: (s) => base(s),
    cap: (s, b) => (b >= 4 ? 'Already legendary' : b + 1 > limit ? `${RANKS[b + 1]} needs level ${b + 1 >= 4 ? 15 : 7}` : ''),
  });
}
function pickLanguages() {
  const all = [...new Set(db.list('ancestries').flatMap((a) => [...a.languages, ...a.addLanguages]))].sort();
  openDrawer({
    title: 'Languages', narrow: true,
    custom: (body, api) => {
      const draw = () => {
        const anc = ch.ancestry;
        const base = anc ? anc.languages : [];
        const cur = (build.languages || []).filter(Boolean);
        const n = ch.languageSlots;
        body.innerHTML = `<p class="small" style="margin-top:0">You know ${esc(base.map(titleCase).join(', ') || '—')}. Choose <b>${n}</b> more. <span class="${cur.length < n ? 'warn' : 'ok'}">${cur.length} of ${n} chosen.</span>${anc?.addLanguages?.length ? `<br><span class="muted">★ usual choices for ${esc(anc.name)}</span>` : ''}</p>
          <div class="sk-list">${all.filter((l) => !base.includes(l)).map((l) => {
            const on = cur.includes(l), dis = !on && cur.length >= n;
            return `<button type="button" class="sk-row ${on ? 'on' : ''} ${dis ? 'dis' : ''}" data-l="${esc(l)}"><span class="sk-nm"><span class="t">${esc(titleCase(l))}</span>${anc?.addLanguages?.includes(l) ? ' <span class="tiny warn">★</span>' : ''}</span><span class="sk-check">${on ? '✓' : ''}</span></button>`;
          }).join('')}</div>`;
        $$('.sk-row', body).forEach((b) => (b.onclick = () => {
          const l = b.dataset.l;
          let arr = cur.filter((x) => x !== l);
          if (!cur.includes(l)) { if (arr.length >= n) return; arr.push(l); }
          build.languages = arr; ch = engine.compute(build); markDirty(); draw();
        }));
      };
      draw();
      const foot = document.createElement('div');
      foot.className = 'dr-foot';
      foot.innerHTML = '<button type="button" class="btn primary">Done</button>';
      foot.querySelector('button').onclick = api.close;
      body.parentNode.appendChild(foot);
    },
    onClose: () => render(),
  });
}

// ------------------------------------------------------------------ attribute boosts drawer
function boostBlocks(lv) {
  let out = '';
  for (const slot of boostSlotsAt(lv)) {
    let inner = '';
    if (slot.id === 'ancestry') {
      if (slot.fixed.length || slot.flaws.length) inner += `<div class="small muted" style="margin-bottom:6px">Fixed: ${slot.fixed.map((x) => ATTR_NAMES[x] + ' +1').join(', ')}${slot.flaws.length ? ' · Flaw: ' + slot.flaws.map((x) => ATTR_NAMES[x] + ' −1').join(', ') : ''}</div>`;
      slot.options.forEach((opts, i) => {
        const cur = build.boosts.ancestry[i];
        inner += `<div class="boost-grid" style="margin-bottom:6px">${ATTRS.map((x) => {
          const taken = build.boosts.ancestry.some((y, j) => j !== i && y === x);
          return `<button type="button" data-boost="ancestry" data-i="${i}" data-a="${x}" class="${cur === x ? 'on' : ''}" aria-pressed="${cur === x}" ${!opts.includes(x) || slot.fixed.includes(x) || taken ? 'disabled' : ''}>${x.toUpperCase()}</button>`;
        }).join('')}</div>`;
      });
    } else if (slot.id === 'background') {
      slot.options.forEach((opts, i) => {
        if (opts.length === 1) { inner += `<div class="small">Fixed: ${ATTR_NAMES[opts[0]]} +1</div>`; return; }
        const cur = build.boosts.background[i];
        inner += `<div class="tiny muted" style="margin-bottom:4px">${opts.length >= 6 ? 'Free boost' : 'Choose ' + opts.map((x) => ATTR_NAMES[x]).join(' or ')}</div><div class="boost-grid" style="margin-bottom:6px">${ATTRS.map((x) => {
          const other = build.boosts.background.some((y, j) => j !== i && y === x);
          return `<button type="button" data-boost="background" data-i="${i}" data-a="${x}" class="${cur === x ? 'on' : ''}" aria-pressed="${cur === x}" ${!opts.includes(x) || other ? 'disabled' : ''}>${x.toUpperCase()}</button>`;
        }).join('')}</div>`;
      });
    } else if (slot.id === 'class') {
      const opts = slot.options[0] || [];
      if (!opts.length) inner += `<div class="small warn">Make your subclass choice first — it decides your key attribute.</div>`;
      else if (opts.length === 1) inner += `<div class="small">Key attribute: <b>${ATTR_NAMES[opts[0]]}</b> +1</div>`;
      else inner += `<div class="boost-grid">${ATTRS.map((x) => `<button type="button" data-boost="class" data-a="${x}" class="${build.boosts.class === x ? 'on' : ''}" aria-pressed="${build.boosts.class === x}" ${!opts.includes(x) ? 'disabled' : ''}>${x.toUpperCase()}</button>`).join('')}</div>`;
    } else {
      const n = slot.id === 'ancestryAlt' ? 2 : 4;
      const cur = (build.boosts[slot.id] || []).filter(Boolean);
      inner += `<div class="boost-grid">${ATTRS.map((x) => `<button type="button" data-multi="${slot.id}" data-n="${n}" data-a="${x}" class="${cur.includes(x) ? 'on' : ''}" aria-pressed="${cur.includes(x)}" ${!cur.includes(x) && cur.length >= n ? 'disabled' : ''}>${x.toUpperCase()}</button>`).join('')}</div>`;
    }
    const done = boostDone(slot);
    out += `<div class="boost-block"><div class="bb-head"><span class="label">${esc(slot.label)}</span><span class="tiny ${done ? 'ok' : 'warn'}">${done ? '✓' : 'to choose'}</span></div>${inner}</div>`;
  }
  return out;
}
function openBoosts(lv) {
  openDrawer({
    title: `Attribute boosts — level ${lv}`, narrow: true,
    custom: (body, api) => {
      const draw = () => {
        body.innerHTML = `${attrBar()}${lv === 1 ? `<label class="check small" style="margin:8px 0 0"><input type="checkbox" id="optAlt" ${build.options.altAncestryBoosts ? 'checked' : ''}> Alternate ancestry boosts (two free boosts, no flaw)</label>` : '<p class="tiny muted" style="margin:8px 0 0">Four different attributes. One that is already +4 or higher takes a partial boost — two partial boosts make +1.</p>'}
          <div style="margin-top:6px">${boostBlocks(lv)}</div>`;
        const again = () => { ch = engine.compute(build); markDirty(); draw(); };
        $$('[data-boost]', body).forEach((b) => (b.onclick = () => {
          const kind = b.dataset.boost, a = b.dataset.a;
          if (kind === 'class') build.boosts.class = build.boosts.class === a ? null : a;
          else { const arr = (build.boosts[kind] = build.boosts[kind] || []); const i = Number(b.dataset.i); arr[i] = arr[i] === a ? null : a; }
          again();
        }));
        $$('[data-multi]', body).forEach((b) => (b.onclick = () => {
          const id = b.dataset.multi, a = b.dataset.a;
          const arr = (build.boosts[id] = (build.boosts[id] || []).filter(Boolean));
          const i = arr.indexOf(a);
          if (i >= 0) arr.splice(i, 1); else if (arr.length < Number(b.dataset.n)) arr.push(a);
          again();
        }));
        const alt = $('#optAlt', body);
        if (alt) alt.onchange = () => { build.options.altAncestryBoosts = alt.checked; again(); };
      };
      draw();
      const foot = document.createElement('div');
      foot.className = 'dr-foot';
      foot.innerHTML = '<button type="button" class="btn primary">Done</button>';
      foot.querySelector('button').onclick = api.close;
      body.parentNode.appendChild(foot);
    },
    onClose: () => render(),
  });
}
function boostsRow(lv) {
  const slots = boostSlotsAt(lv);
  if (!slots.length) return '';
  const done = slots.filter(boostDone).length;
  const chosen = lv === 1 ? ATTRS.map((a) => `${a.toUpperCase()} ${signed(ch.attrs[a])}`).join(' · ') : (build.boosts[lv] || []).filter(Boolean).map((a) => a.toUpperCase()).join(', ');
  return crow({ label: lv === 1 ? 'Attribute boosts' : 'Attribute boosts — four free', value: done === slots.length || (lv !== 1 && chosen) ? esc(chosen) : 'Choose…', todo: done < slots.length, icon: done < slots.length ? '!' : '+',
    note: done < slots.length ? `${slots.length - done} of ${slots.length} groups to choose` : '', act: { t: 'boosts', lv } });
}

// ------------------------------------------------------------------ spells per level
/** Which spell ranks are new at level n, per entry (with how many repertoire spells that level adds). */
function spellPlanAt(n) {
  const sc = ch.spellcasting;
  const plan = [];
  const lim = (slots, r) => (Number(r) === 0 ? null : slots[r] || 0);
  for (const e of sc.entries) {
    if (e.id === 'class' && CASTERS[ch.class?.slug]) {
      const cfg = CASTERS[ch.class.slug];
      const now = cfg.slots(n), before = n > 1 ? cfg.slots(n - 1) : {};
      if (e.repLimits) {
        if (n === 1) plan.push({ e, r: 0, from: 0, to: e.repLimits[0] });
        for (const r of Object.keys(now).map(Number).filter((x) => x <= 9)) {
          const a = lim(before, r) || 0, b = lim(now, r);
          if (b > a) plan.push({ e, r, from: a, to: b });
        }
      } else if (e.book) {
        if (n === 1 || Object.keys(now).some((r) => (now[r] || 0) !== (before[r] || 0))) plan.push({ e, book: true, n });
      } else if (n === 1) plan.push({ e, info: true });
    } else if (e.id === 'apparition') {
      if (n === 1) plan.push({ e, editor: true });
    } else if (e.arch) {
      const ded = ch.feats.find((f) => f.rec.slug === e.feat?.slug);
      if (e.repLimits) {
        if (ded?.slot?.level === n) plan.push({ e, r: 0, from: 0, to: e.repLimits[0] });
        for (const f of ch.feats.filter((x) => x.rec.archCasting?.role === 'slots' && x.rec.arch === e.arch)) {
          for (const [lvl, r] of ARCH_SLOTS[f.rec.archCasting.tier] || []) if (lvl === n) plan.push({ e, r, from: 0, to: 1 });
        }
      } else if (ded?.slot?.level === n) plan.push({ e, book: !!e.book, info: !e.book, n });
    }
  }
  const picks = sc.picks.filter((p) => keyLevel(p.key) === n);
  return { plan, picks };
}
function spellRows(n) {
  const { plan, picks } = spellPlanAt(n);
  let html = '';
  for (const p of plan) {
    const e = p.e;
    if (p.info) { html += crow({ label: `${e.label} spells`, value: `Prepared each day from the ${esc(titleCase(e.trad || ''))} list`, info: true, note: 'Pick them on the character sheet' }); continue; }
    if (p.editor || p.book) {
      const b = e.book;
      html += crow({ label: p.book ? `${e.label} — ${b.label}` : e.label, value: p.book ? `${b.cantripCount} cantrips · ${b.count} spells` : 'Add the spells you’re attuned to',
        note: p.book && b.limit != null ? `${n === 1 ? `Start with ${b.cantripLimit} cantrips and ${b.levelLimit - (ch.level - 1) * 2} spells` : 'Add 2 spells this level'} · ${b.count}/${b.levelLimit} spells, ${b.cantripCount}/${b.cantripLimit} cantrips` : '',
        todo: p.book && b.limit != null && (b.count < b.levelLimit || b.cantripCount < b.cantripLimit), icon: '✦', act: { t: 'spelleditor', e: e.id } });
      continue;
    }
    const list = ((e.repertoire || {})[p.r] || []).filter((x) => !x.extra);
    for (let i = p.from; i < p.to; i++) {
      const s = list[i];
      const label = `${e.label} · ${p.r === 0 ? 'cantrip' : ordinal(p.r) + '-rank spell'}`;
      if (s && s.granted) { html += crow({ label, value: esc(s.rec.name), info: true, show: s.ref, note: 'granted by ' + esc(s.source || '') }); continue; }
      html += crow({ label, value: s ? esc(s.rec.name) + rarityBadge(s.rec) : 'Choose…', todo: !s, icon: s ? (p.r === 0 ? 'C' : p.r) : '!',
        note: s ? `<span style="color:var(--accent)">${actionGlyph(s.rec)}</span>` : '', act: { t: 'repspell', e: e.id, r: p.r, i }, clear: s ? { t: 'rep', e: e.id, r: p.r, ref: s.ref } : null });
    }
  }
  for (const p of picks) {
    const v = p.value ? db.get(p.value) : null;
    html += crow({ label: `${p.source} — ${pickKind(p)}`, value: v ? esc(v.name) + rarityBadge(v) : 'Choose…', todo: !v, icon: v ? '✦' : '!', act: { t: 'spellpick', key: p.key },
      note: !v && p.list ? esc(pickHint(p.list)) : '', clear: v ? { t: 'pick', key: p.key } : null });
  }
  return html;
}
function pickRepertoireSpell(a) {
  const e = ch.spellcasting.entries.find((x) => x.id === a.e);
  if (!e) return;
  const st = storeFor(build, e);
  const list = ((e.repertoire || {})[a.r] || []).filter((x) => !x.extra);
  const granted = list.filter((x) => x.granted).length;
  const have = new Set(Object.values(e.repertoire || {}).flat().map((x) => x.ref));
  const cur = list[a.i];
  openSpellPicker(db, { title: `${a.r === 0 ? 'Cantrip' : ordinal(a.r) + '-rank spell'} — ${e.label}`, trad: e.trad, rank: a.r || null, cantrips: a.r === 0, exclude: [...have].filter((r) => !cur || r !== cur.ref), showRare: build.options.showRare !== false }, (s) => {
    const arr = (st.rep[a.r] = (st.rep[a.r] || []).slice());
    const idx = a.i - granted;
    if (cur && !cur.granted && idx >= 0 && idx < arr.length) arr[idx] = refOf(s); else arr.push(refOf(s));
    update();
    toast('Added ' + s.name, 'ok');
  });
}
function openSpellEditor(a) {
  const e = ch.spellcasting.entries.find((x) => x.id === a.e);
  openDrawer({
    title: e ? e.label + ' spells' : 'Spells', narrow: false,
    custom: (body) => {
      const draw = () => renderSpellsEditor(body, { db, ch, build, only: [a.e], update: () => { ch = engine.compute(build); markDirty(); draw(); } });
      draw();
    },
    onClose: () => render(),
  });
}
function pickKind(p) {
  if (!p.list) return p.innate ? 'innate spell' : 'spell';
  return p.list.rank === 0 ? 'innate cantrip' : `${ordinal(p.list.rank)}-rank${p.list.orLower ? ' or lower' : ''} innate spell`;
}
function pickHint(l) {
  const trads = (Array.isArray(l.trad) ? l.trad : [l.trad]).filter(Boolean).map(titleCase).join(' or ');
  return `${l.common ? 'Common, ' : ''}${trads ? 'from the ' + trads + ' list' : 'any tradition'}`;
}
function pickChooseOne(key) {
  const p = ch.spellcasting.picks.find((x) => x.key === key);
  if (!p) return;
  if (p.list) {
    // "Choose one cantrip from the arcane spell list": the whole list, filtered.
    const taken = new Set(ch.spellcasting.innate.map((x) => x.ref).filter((r) => r && r !== p.value));
    openSpellPicker(db, { title: `${p.source} — ${pickKind(p)}`, only: innatePickOptions(db, p.list, build.options.showRare !== false).map(refOf), exclude: [...taken], verb: 'Choose' }, (s) => {
      build.spells.pick = Object.assign({}, build.spells.pick || {}, { [key]: refOf(s) });
      update(); toast('Chose ' + s.name, 'ok');
    });
    return;
  }
  openDrawer({
    title: p.source, subtitle: 'Choose a spell', db, items: p.options.map((o) => ({ key: o.ref, name: o.rec.name, rec: o.rec, level: o.rec.rank })), selected: p.value,
    detail: (it) => recDetail(it.rec), textRef: (it) => it.key, pickLabel: (it) => 'Choose ' + it.name,
    onPick: (it) => { build.spells.pick = Object.assign({}, build.spells.pick || {}, { [key]: it.key }); update(); },
  });
}

// ------------------------------------------------------------------ the planner: every level, one under another
function levelSection(n) {
  const todos = levelTodos(n);
  const cls = ch.class;
  let rows = '';
  if (n === 1) {
    const anc = ch.ancestry, her = ch.heritage, bg = ch.background;
    rows += subhead('Ancestry');
    rows += crow({ label: 'Ancestry', value: anc ? esc(anc.name) + rarityBadge(anc) : 'Choose…', todo: !anc, icon: anc ? 'A' : '!', act: { t: 'ancestry' }, note: anc ? esc(`${anc.hp} HP · ${ch.sizeLabel || titleCase(anc.size)} · ${anc.speed} ft · ${titleCase(anc.vision).replace(/-/g, ' ')}`) : '' });
    if (anc) rows += crow({ label: 'Heritage', value: her ? esc(her.name) + rarityBadge(her) : 'Choose…', todo: !her, icon: her ? 'H' : '!', act: { t: 'heritage' } });
    rows += choiceRows(ch, ['ancestry', 'heritage']);
    rows += subhead('Background');
    rows += crow({ label: 'Background', value: bg ? esc(bg.name) + rarityBadge(bg) : 'Choose…', todo: !bg, icon: bg ? 'B' : '!', act: { t: 'background' }, note: bg ? esc([...bg.skills.map(titleCase), ...bg.lore].join(', ')) : '' });
    const bgFeats = ch.items.filter((i) => i.key.startsWith('background>') && i.pack === 'feats' && i.key.split('>').length === 2);
    rows += choiceRows(ch, ['background'], { exclude: bgFeats.map((g) => g.key) });
    for (const g of bgFeats) rows += crow({ label: 'Skill feat from background', value: esc(g.rec.name), info: true, show: g.ref, sub: true }) + choiceRows(ch, [g.key]);
    rows += subhead('Class');
    rows += crow({ label: 'Class', value: cls ? esc(cls.name) + rarityBadge(cls) : 'Choose…', todo: !cls, icon: cls ? 'C' : '!', act: { t: 'class' }, note: cls ? esc(`${cls.hp} HP + Con · key ${cls.keyAbility.map((x) => x.toUpperCase()).join('/') || 'from subclass'}`) : '' });
    if (cls) rows += choiceRows(ch, ['class']) + featureRows(1);
    rows += subhead('Attributes & skills');
    rows += boostsRow(1);
    if (cls) {
      const cur = (build.skills.class || []).filter(Boolean);
      const left = classSkillsLeft();
      rows += crow({ label: `Skill training — ${ch.classSkillPicks} of your choice`, value: cur.length ? esc(cur.map(titleCase).join(', ')) : 'Choose…', todo: left > 0, icon: left ? '!' : 'T', act: { t: 'skills' }, note: left ? `${left} left` : '' });
    }
    if (ch.intPicks[1]) {
      const cur = (build.skills.int[1] || []).filter(Boolean);
      rows += crow({ label: `Intelligence — ${ch.intPicks[1]} more skill${ch.intPicks[1] > 1 ? 's' : ''}`, value: cur.length ? esc(cur.map(titleCase).join(', ')) : 'Choose…', todo: intLeft(1) > 0, icon: intLeft(1) ? '!' : 'T', act: { t: 'int', lv: 1 } });
    }
    if (ch.languageSlots > 0) {
      const cur = (build.languages || []).filter(Boolean);
      rows += crow({ label: `Languages — ${ch.languageSlots} more`, value: cur.length ? esc(cur.map(titleCase).join(', ')) : 'Choose…', todo: langsLeft() > 0, icon: langsLeft() ? '!' : 'L', act: { t: 'langs' } });
    }
    const feats = ch.slots.filter((s) => s.level === 1);
    if (feats.length) rows += subhead('Feats') + feats.map(featRow).join('');
    const sp = spellRows(1);
    if (sp) rows += subhead('Spells') + sp;
  } else {
    const features = (cls?.items || []).filter((i) => i.level === n);
    if (features.length) rows += featureRows(n);
    const slots = ch.slots.filter((s) => s.level === n);
    const order = { class: 0, archetype: 1, ancestry: 2, skill: 3, general: 4 };
    slots.sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));
    rows += slots.map(featRow).join('');
    rows += boostsRow(n);
    if (ch.increaseLevels.includes(n)) {
      const cur = build.skills.inc[n];
      let note = '';
      if (cur) {
        const later = ch.increaseLevels.filter((l) => l > n && build.skills.inc[l] === cur).length;
        const r = (cur.startsWith('lore:') ? ch.ranks.lores[cur.slice(5)] : ch.ranks.skills[cur]) - later;
        note = `${RANKS[Math.max(0, r - 1)]} → <b>${RANKS[r]}</b>`;
      }
      rows += crow({ label: 'Skill increase', value: cur ? esc(titleCase(cur.replace(/^lore:/, ''))) : 'Choose…', todo: !cur, icon: cur ? '↑' : '!', act: { t: 'inc', lv: n }, note });
    }
    if (ch.intPicks[n]) {
      const cur = (build.skills.int[n] || []).filter(Boolean);
      rows += crow({ label: `Intelligence went up — ${ch.intPicks[n]} more skill${ch.intPicks[n] > 1 ? 's' : ''}`, value: cur.length ? esc(cur.map(titleCase).join(', ')) : 'Choose…', todo: intLeft(n) > 0, icon: intLeft(n) ? '!' : 'T', act: { t: 'int', lv: n } });
    }
    rows += spellRows(n);
    if (!rows) rows = `<p class="empty-note">Nothing to choose — just the level bonus and hit points.</p>`;
  }
  const hp = n === 1 ? ch.hp.max - (ch.level - 1) * ((cls?.hp || 0) + ch.attrs.con) : (cls?.hp || 0) + ch.attrs.con;
  const features = n > 1 ? (cls?.items || []).filter((i) => i.level === n) : [];
  return `<section class="lvl-sec" id="lvl-${n}" data-level="${n}" aria-labelledby="lvlh-${n}">
    <header class="lvl-bar ${todos.length ? '' : 'done'}"><span class="lvl-badge">${n}</span>
      <div class="lvl-titles"><h2 id="lvlh-${n}">Level ${n}${n === 1 ? ' <span class="muted" style="font-weight:500;font-size:14px">· character creation</span>' : ''}</h2>
        <div class="gain-chips">${cls ? `<span class="gain-chip">+${Math.max(0, hp)} HP</span>` : ''}${features.map((f) => `<span class="gain-chip feature" data-show="${esc(f.ref)}" role="button" tabindex="0">${esc(f.name.replace(/^\(Choice\) /, ''))}</span>`).join('')}</div></div>
      <span class="lvl-status ${todos.length ? 'warn' : 'ok'}" title="${esc(todos.join(', '))}">${todos.length ? `${todos.length} to choose` : '✓ Done'}</span></header>
    <div class="lvl-list">${rows}</div></section>`;
}
function summaryHtml() {
  const e0 = ch.spellcasting.entries[0];
  const row = (k, v, r) => `<div class="sum-row">${r != null ? rankBadge(r) : '<span style="width:18px"></span>'}<span class="grow">${esc(k)}</span><span class="mono">${v}</span></div>`;
  return `<div class="card tight" style="margin:0">
    <h2 class="label">${esc(build.name || 'New character')}</h2>
    <div class="small muted" style="margin:-4px 0 8px">${esc([ch.heritage?.name, ch.ancestry?.name, ch.background?.name, ch.class ? ch.class.name + ' ' + ch.level : null].filter(Boolean).join(' · ') || 'Nothing chosen yet')}</div>
    <div class="attr-grid" style="margin-bottom:10px">${ATTRS.map((a) => `<div class="pill"><span class="pill-label">${a.toUpperCase()}</span><span class="pill-value">${signed(ch.attrs[a])}</span></div>`).join('')}</div>
    ${row('Hit points', ch.hp.max)}${row('Armor Class', ch.ac.total, ch.ac.rank)}${row('Fortitude', signed(ch.saves.fortitude.total), ch.saves.fortitude.rank)}${row('Reflex', signed(ch.saves.reflex.total), ch.saves.reflex.rank)}${row('Will', signed(ch.saves.will.total), ch.saves.will.rank)}
    ${row('Perception', signed(ch.perception.total), ch.perception.rank)}${ch.classDC ? row('Class DC', ch.classDC.total, ch.classDC.rank) : ''}${e0 ? row('Spell DC', e0.dc, e0.rank) : ''}
    <h2 class="label" style="margin:12px 0 4px">Skills</h2>
    ${Object.keys(SKILLS).map((s) => row(titleCase(s), signed(ch.skills[s].total), ch.ranks.skills[s])).join('')}
    ${Object.entries(ch.lores).map(([n2, l]) => row(/lore$/i.test(n2) ? n2 : n2 + ' Lore', signed(l.total), l.rank)).join('')}
    <h2 class="label" style="margin:12px 0 4px">Languages</h2><div class="small">${esc(ch.languages.map(titleCase).join(', ') || '—')}</div></div>`;
}
function renderPlanner(root) {
  let html = '<div class="pl-page"><div class="pl-main">';
  for (let n = 1; n <= ch.level; n++) html += levelSection(n);
  html += `<div class="lvl-foot">${ch.level > 1 ? `<button type="button" class="btn ghost small" id="removeLevel">Remove level ${ch.level}</button>` : '<span></span>'}
    <span class="row">${ch.level < 20 ? `<button type="button" class="btn primary" id="footAdd">+ Add level ${ch.level + 1}</button>` : ''}${charRec.id ? `<a class="btn" href="sheet.html?id=${encodeURIComponent(charRec.id)}" id="footSheet">Open sheet</a>` : ''}</span></div>`;
  html += `</div><aside class="pl-side" aria-label="Character summary">${summaryHtml()}</aside></div>`;
  root.innerHTML = html;
  $$('[data-act]', root).forEach((b) => (b.onclick = () => act(JSON.parse(b.dataset.act))));
  $$('[data-clear]', root).forEach((b) => (b.onclick = () => {
    const c = JSON.parse(b.dataset.clear);
    if (c.t === 'feat') delete build.feats[c.slot];
    else if (c.t === 'rep') {
      const e = ch.spellcasting.entries.find((x) => x.id === c.e);
      const st = storeFor(build, e);
      st.rep[c.r] = (st.rep[c.r] || []).filter((x) => x !== c.ref);
      if (st.sig && st.sig[c.r] === c.ref) delete st.sig[c.r];
    } else if (c.t === 'pick' && build.spells.pick) delete build.spells.pick[c.key];
    update();
  }));
  $$('.gain-chip.feature', root).forEach((el) => (el.onkeydown = (e) => { if (e.key === 'Enter') showRef(db, el.dataset.show); }));
  const fa = $('#footAdd', root); if (fa) fa.onclick = addLevel;
  const rl = $('#removeLevel', root);
  if (rl) rl.onclick = () => {
    if (!confirm(`Remove level ${build.level}? The choices you made there are kept and come back if you add the level again.`)) return;
    build.level--; currentLevel = Math.min(currentLevel, build.level); update();
  };
  const fs = $('#footSheet', root);
  if (fs) fs.onclick = async (e) => { if (dirty) { e.preventDefault(); await save(); location.href = fs.href; } };
}

// ------------------------------------------------------------------ spells, equipment, details
const RENDER = {};
RENDER.spells = (root) => {
  root.insertAdjacentHTML('beforeend', `<div class="lvl-head"><div><h1>Spells</h1><div class="lvl-sub">Everything your character casts, at level ${ch.level}</div></div><span class="spacer"></span><span class="small">${spellTodo() ? `<span class="warn">${spellTodo()} to do</span>` : '<span class="ok">✓ All chosen</span>'}</span></div><div id="spellsBox"></div>`);
  renderSpellsEditor($('#spellsBox', root), { db, ch, build, update: () => update() });
};

// ------------------------------------------------------------------ equipment
const GEAR_TYPES = ['weapon', 'armor', 'shield', 'consumable', 'equipment', 'backpack', 'treasure'];
RENDER.gear = (root) => {
  const box = document.createElement('div');
  box.innerHTML = '<p class="muted">Loading equipment…</p>';
  root.appendChild(box);
  (async () => {
    if (!db.has('equipment')) { await db.load(['equipment']); ch = engine.compute(build); }
    if (view().kind !== 'gear') return;
    box.innerHTML = `<div class="lvl-head"><div><h1>Equipment</h1><div class="lvl-sub">Gear, money and formulas</div></div></div><div class="grid2"><div id="invCol"></div>
      <div class="card"><h3>Shop</h3>
        <div class="filters"><input type="search" id="shopQ" placeholder="Search items…" aria-label="Search items">
          <select id="shopType" aria-label="Item type"><option value="">All types</option>${GEAR_TYPES.map((t) => `<option value="${t}">${titleCase(t)}</option>`).join('')}</select>
          <label class="check small"><input type="checkbox" id="shopLvl" checked> Up to level ${ch.level}</label>
          <label class="check small"><input type="checkbox" id="shopFree"> Add without paying</label></div>
        <div class="list" id="shopList"></div></div></div>`;
    const invCol = $('#invCol', box), shopList = $('#shopList', box);
    const drawShop = () => {
      const q = $('#shopQ', box).value.trim().toLowerCase(), t = $('#shopType', box).value, lvl = $('#shopLvl', box).checked;
      const items = db.list('equipment').filter((r) => (!q || r.name.toLowerCase().includes(q)) && (!t || r.type === t) && (!lvl || r.level <= ch.level) && showRare(r, false)).slice(0, 250);
      shopList.innerHTML = items.map((r) => `<div class="item" style="cursor:default"><span class="lvl">${r.level}</span><span class="name" data-show="@equipment/${esc(r.slug)}" role="button" style="cursor:pointer"><span style="text-decoration:underline dotted">${esc(r.name)}</span>${rarityBadge(r)}<br><span class="tiny muted">${esc(titleCase(r.type))} · ${esc(formatPrice(r.price))}${r.per > 1 ? ' for ' + r.per : ''} · ${esc(formatBulk(r.bulk))}</span></span><button type="button" class="btn small" data-buy="${esc(r.slug)}">Add</button></div>`).join('')
        || '<p class="muted" style="padding:12px 14px">No items match.</p>';
      $$('[data-show]', shopList).forEach((el) => (el.onclick = () => showRef(db, el.dataset.show)));
      $$('[data-buy]', shopList).forEach((b) => (b.onclick = () => {
        const r = db.get('@equipment/' + b.dataset.buy);
        const free = $('#shopFree', box).checked;
        if (!free && (build.money ?? 0) < r.price) { toast('Not enough money (tick “Add without paying” to add anyway)', 'error'); return; }
        if (!free) build.money = (build.money ?? 0) - r.price;
        const stack = !['weapon', 'armor', 'shield'].includes(r.type) || (r.traits || []).includes('consumable');
        const existing = stack && build.inventory.find((x) => x.ref === refOf(r));
        if (existing) existing.qty = (existing.qty || 1) + (r.per > 1 ? r.per : 1);
        else build.inventory.push({ id: uid(), ref: refOf(r), qty: r.per > 1 ? r.per : 1, equipped: ['armor', 'shield'].includes(r.type) ? !build.inventory.some((x) => db.get(x.ref)?.type === r.type && x.equipped) : r.type === 'weapon', invested: false });
        update(false); drawInv(); toast('Added ' + r.name, 'ok');
      }));
    };
    ['#shopQ', '#shopType', '#shopLvl'].forEach((sel) => ($(sel, box).oninput = drawShop));
    drawShop();
    function drawInv() {
      const money = build.money ?? 1500;
      invCol.innerHTML = `<div class="card"><h3>Money</h3><div class="row">
          <label class="field"><span>Gold</span><input type="number" class="num" id="gp" min="0" value="${Math.floor(money / 100)}"></label>
          <label class="field"><span>Silver</span><input type="number" class="num" id="sp" min="0" value="${Math.floor((money % 100) / 10)}"></label>
          <label class="field"><span>Copper</span><input type="number" class="num" id="cp" min="0" value="${money % 10}"></label></div>
          <p class="muted small" style="margin:0">1st-level characters usually start with 15 gp. Ask your GM at higher levels.</p></div>
        <div class="card"><div class="section-title"><h3>Inventory</h3><span class="small muted">Bulk ${ch.bulk.total} / ${ch.bulk.encumbered} (max ${ch.bulk.max})</span></div>
        ${ch.inventory.length ? ch.inventory.map((it) => invRow(it)).join('') : '<p class="muted small">Nothing yet. Add items from the shop.</p>'}</div>
        ${formulaCard()}`;
      const setMoney = () => { build.money = (Number($('#gp', invCol).value) || 0) * 100 + (Number($('#sp', invCol).value) || 0) * 10 + (Number($('#cp', invCol).value) || 0); markDirty(); };
      ['#gp', '#sp', '#cp'].forEach((sel) => ($(sel, invCol).onchange = setMoney));
      const find = (id) => build.inventory.find((x) => x.id === id);
      const redraw = () => { update(false); drawInv(); };
      $$('[data-qty]', invCol).forEach((i) => (i.onchange = () => { const it = find(i.dataset.qty); it.qty = Math.max(0, Number(i.value) || 0); if (!it.qty) build.inventory = build.inventory.filter((x) => x !== it); redraw(); }));
      $$('[data-equip]', invCol).forEach((i) => (i.onchange = () => {
        const it = find(i.dataset.equip), type = db.get(it.ref).type;
        if (i.checked && type !== 'weapon') for (const x of build.inventory) if (x !== it && db.get(x.ref)?.type === type) x.equipped = false;
        it.equipped = i.checked; redraw();
      }));
      $$('[data-invest]', invCol).forEach((i) => (i.onchange = () => { find(i.dataset.invest).invested = i.checked; update(false); }));
      $$('[data-runeman]', invCol).forEach((btn) => (btn.onclick = () => { const it = find(btn.dataset.runeman); if (it) openRuneManager({ db, it, level: ch.level, onChange: () => { update(false); drawInv(); } }); }));
      $$('[data-sell]', invCol).forEach((b) => (b.onclick = () => { build.inventory = build.inventory.filter((x) => x.id !== b.dataset.sell); redraw(); }));
      $$('[data-show]', invCol).forEach((el) => (el.onclick = () => showRef(db, el.dataset.show)));
      const af = $('#addFormula', invCol);
      if (af) af.onclick = () => openFormulaPicker(drawInv);
      $$('[data-rmformula]', invCol).forEach((b) => (b.onclick = () => { build.formulas = (build.formulas || []).filter((x) => x !== b.dataset.rmformula); redraw(); }));
    }
    drawInv();
  })();
  function invRow(it) {
    const r = it.rec;
    const canEquip = ['weapon', 'armor', 'shield'].includes(r.type) && !(r.traits || []).includes('consumable');
    // Runes and special material: badges, and a Runes button that opens the same window as on the sheet.
    const b = (t, cls = '') => `<span class="badge ${cls}">${esc(t)}</span>`;
    const runes = runeKind(r) ? `<span class="rune-sum">${[it.potency ? b('+' + it.potency) : '', it.striking ? b(['', 'striking', 'greater striking', 'major striking'][it.striking]) : '',
      it.resilient ? b(['', 'resilient', 'greater resilient', 'major resilient'][it.resilient]) : '', ...itemRunes(db, it).filter((x) => x.fits).map((x) => b(x.name, 'rune-badge')),
      it.material && it.material.type ? b(materialLabel(db, it.material), 'mat-badge') : ''].filter(Boolean).join(' ')}</span>
        <button type="button" class="btn small" data-runeman="${esc(it.id)}">Runes</button>` : '';
    return `<div class="entry"><div class="grow"><span class="name" data-show="${esc(it.ref)}">${esc(r.name)}</span> <span class="muted small">${esc(formatPrice(r.price))} · ${esc(formatBulk(r.bulk))}</span>
      <div class="row small" style="margin-top:4px">
        <input type="number" class="num" min="0" value="${it.qty || 1}" data-qty="${esc(it.id)}" aria-label="Quantity">
        ${canEquip ? `<label class="check"><input type="checkbox" data-equip="${esc(it.id)}" ${it.equipped ? 'checked' : ''}> ${r.type === 'weapon' ? 'held' : 'worn'}</label>` : ''}
        ${(r.traits || []).includes('invested') ? `<label class="check"><input type="checkbox" data-invest="${esc(it.id)}" ${it.invested ? 'checked' : ''}> invested</label>` : ''}
        ${runes}</div></div>
      <button type="button" class="icon-btn" data-sell="${esc(it.id)}" title="Remove" aria-label="Remove ${esc(r.name)}">✕</button></div>`;
  }
  function formulaCard() {
    if (!ch.crafting.length && !(ch.feats || []).some((f) => /crafting/.test(f.rec.slug)) && !(build.formulas || []).length) return '';
    const list = (build.formulas || []).map((r) => db.get(r)).filter(Boolean);
    return `<div class="card"><div class="section-title"><h3>Formula book</h3><button type="button" class="btn small" id="addFormula">+ Add formula</button></div>
      ${ch.crafting.map((c) => `<p class="small"><b>${esc(c.label)}</b>${c.max != null ? ': ' + c.max + (c.daily ? ' items per day' : '') : ''} <span class="muted">(${esc(c.source)})</span></p>`).join('')}
      ${list.map((r) => `<div class="entry"><span class="grow"><span class="name" data-show="${esc(refOf(r))}">${esc(r.name)}</span> <span class="muted small">level ${r.level}</span></span><button type="button" class="icon-btn" data-rmformula="${esc(refOf(r))}" aria-label="Remove formula">✕</button></div>`).join('') || '<p class="muted small">No formulas yet.</p>'}</div>`;
  }
};

function openFormulaPicker(after) {
  const have = new Set(build.formulas || []);
  const items = db.list('equipment').filter((r) => r.level <= ch.level && !have.has(refOf(r)) && r.price > 0 && showRare(r, false))
    .map((r) => ({ key: refOf(r), name: r.name, level: r.level, rarity: r.rarity, rec: r, badge: rarityBadge(r), meta: esc(`${titleCase(r.type)} · ${formatPrice(r.price)}`) }));
  openDrawer({
    title: 'Add a formula', subtitle: 'Items up to your level', db, items, placeholder: 'Search items (alchemical items, potions…)',
    chips: [{ id: 'all', label: 'All' }, { id: 'alch', label: 'Alchemical', test: (i) => (i.rec.traits || []).includes('alchemical') }, { id: 'mag', label: 'Magical', test: (i) => (i.rec.traits || []).includes('magical') }, { id: 'cons', label: 'Consumables', test: (i) => i.rec.type === 'consumable' }],
    detail: (it) => recDetail(it.rec, `<div class="facts">${fact('Price', esc(formatPrice(it.rec.price)))}${fact('Bulk', esc(formatBulk(it.rec.bulk)))}</div>`),
    textRef: (it) => it.key, pickLabel: (it) => 'Add formula: ' + it.name,
    onPick: (it) => { build.formulas = [...(build.formulas || []), it.key]; update(false); after(); toast('Added formula: ' + it.name, 'ok'); },
  });
}

RENDER.details = (root) => {
  const w = [];
  for (let n = 1; n <= ch.level; n++) for (const t of levelTodos(n)) w.push(`Level ${n}: ${t}`);
  for (const p of ch.prereqProblems) w.push(`${p.feat}: prerequisites not met`);
  const st = spellTodo();
  if (st) w.push(`Spells: ${st} to choose`);
  root.insertAdjacentHTML('beforeend', `
  <div class="lvl-head"><div><h1>Details</h1><div class="lvl-sub">Name, table options, notes and export</div></div></div>
  <div class="planner">
    ${group('Character', `<div class="pad"><div class="grid2">
      <label class="field"><span>Character name</span><input type="text" id="name" value="${esc(build.name)}" placeholder="e.g. Valentine Vetrani"></label>
      <label class="field"><span>Player</span><input type="text" id="player" value="${esc(build.player || '')}"></label>
      <label class="field"><span>Level</span><select id="level">${Array.from({ length: 20 }, (_, i) => `<option ${build.level === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select></label>
      <label class="field"><span>Age, pronouns, look</span><input type="text" id="appearance" value="${esc(build.details?.appearance || '')}"></label></div>
      <label class="field"><span>Notes</span><textarea id="notes" placeholder="Backstory, personality, anything else">${esc(build.details?.notes || '')}</textarea></label></div>`)}
    ${group('Table options', `<div class="pad">
      <label class="check"><input type="checkbox" id="optFA" ${build.options.freeArchetype ? 'checked' : ''}><span><b>Free archetype</b><br><span class="muted small">An extra archetype feat at every even level.</span></span></label>
      <label class="check"><input type="checkbox" id="optAP" ${build.options.ancestryParagon ? 'checked' : ''}><span><b>Ancestry paragon</b><br><span class="muted small">Two ancestry feats at 1st level, then one at every odd level (11 in total).</span></span></label>
      <label class="check"><input type="checkbox" id="optAlt2" ${build.options.altAncestryBoosts ? 'checked' : ''}><span><b>Alternate ancestry boosts</b><br><span class="muted small">Two free boosts instead of your ancestry's usual boosts and flaw.</span></span></label>
      <label class="check"><input type="checkbox" id="optRare" ${build.options.showRare ? 'checked' : ''}><span><b>Show uncommon and rare options</b><br><span class="muted small">Ask your GM before taking them.</span></span></label>
      <label class="check"><input type="checkbox" id="optPre" ${build.options.ignorePrereqs ? 'checked' : ''}><span><b>Allow feats without meeting prerequisites</b><br><span class="muted small">For GM-approved exceptions.</span></span></label>
      ${ch.ownedSlugs?.has('sticky-bomb') ? `<label class="check"><input type="checkbox" id="optSticky" ${build.options.legacyStickyBomb !== false ? 'checked' : ''}><span><b>Pre-remaster Sticky Bomb</b><br><span class="muted small">On by default. Persistent damage equals the splash the bomb actually deals (with Field Discovery and Expanded Splash). Untick for the remaster rule: the splash in the bomb's stat block.</span></span></label>` : ''}</div>`)}
    ${group('Still to do', w.length ? `<ul class="small" style="margin:4px 12px 10px;padding-left:16px">${[...new Set(w)].map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="empty-note ok">✓ Everything is filled in.</p>')}
    ${group('Export', `<div class="pad"><p class="small muted" style="margin-top:0">Download this character as a file you can import again later or send to your GM.</p><button type="button" class="btn" id="exportBtn">Download JSON</button></div>`)}
  </div>`);
  const bind = (id, fn) => { $(id).onchange = (e) => { fn(e.target); update(); }; };
  $('#name').oninput = (e) => { build.name = e.target.value; markDirty(); renderChrome(); };
  $('#player').oninput = (e) => { build.player = e.target.value; markDirty(); };
  $('#appearance').oninput = (e) => { build.details.appearance = e.target.value; markDirty(); };
  $('#notes').oninput = (e) => { build.details.notes = e.target.value; markDirty(); };
  bind('#level', (t) => (build.level = Number(t.value)));
  bind('#optFA', (t) => (build.options.freeArchetype = t.checked));
  bind('#optAP', (t) => (build.options.ancestryParagon = t.checked));
  bind('#optAlt2', (t) => (build.options.altAncestryBoosts = t.checked));
  bind('#optRare', (t) => (build.options.showRare = t.checked));
  bind('#optPre', (t) => (build.options.ignorePrereqs = t.checked));
  if ($('#optSticky')) bind('#optSticky', (t) => (build.options.legacyStickyBomb = t.checked));
  $('#exportBtn').onclick = () => {
    const blob = new Blob([JSON.stringify({ format: 'pf2e-builder', version: 1, name: build.name, build, state: charRec.state || {} }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = (build.name || 'character').replace(/[^\w-]+/g, '_') + '.json'; a.click();
  };
};

render();
if (!charRec.id) {
  saveEl.textContent = store.mode === 'api' ? 'New character · saved to your account as you go' : 'New character (saved in this browser)';
}
})().catch((e) => { console.error(e); const m = document.getElementById('main'); if (m && !m.querySelector('.bad')) m.insertAdjacentHTML('afterbegin', '<p class="bad">Something went wrong: ' + String(e.message || e).replace(/</g, '&lt;') + '</p>'); });
