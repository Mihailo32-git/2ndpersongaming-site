// Character sheet (Obsidian layout): header card with HP and points, defence tiles, three columns —
// attributes/conditions on the left, tabbed actions/spells/feats/inventory in the middle, skills on the right.
import { DB, refOf } from './data.js';
import { Engine, normalizeBuild, asObj } from './engine.js';
import { Store, api } from './store.js';
import { SKILL_ACTIONS, CORE_BASIC, NEEDS_SPEED, BASIC_ROLLS, modeOf, costOf, originOf, ORIGIN_ORDER } from './actions.js';
import { mountAccount, syncLabel, saveWithConflictCheck, askConflict } from './account.js';
import { modal, toast, confirmBox, showRef, wireRefs, traitChips, actionGlyph, rankBadge, esc } from './ui.js';
import { ATTRS, ATTR_NAMES, SKILLS, SAVES, RANKS, signed, titleCase, formatPrice, formatBulk } from './util.js';
import { test, itemOptions } from './predicate.js';
import { slotRows, ordinal, spellList, isCantrip, attrLabel } from './casting.js';
import { openSpellPicker, rarityBadge } from './pickers.js';
import { openDrawer } from './drawer.js';
import { renderCompanions } from './companion-ui.js';
import { parseFreq, freqText, effectiveFreq, isActionDup, limitedActionRefs, limitedList, RESET_TIERS, hasAlchemy, alchemyInfo, isAlchemyCraft, formulaFamily, innateUsedCount } from './uses.js';
import { portraitSrc, pickImage, makePortrait } from './portrait.js';
import { loadRunes, runeKind, itemRunes, materialLabel, runeRef } from './runes.js';
import { openRuneManager } from './runes-ui.js';

// Wrapped in an async function instead of top-level await so older tablet browsers (Chrome 80+) can run it.
(async () => {

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const main = $('#main');

const db = await new DB({ base: 'data/' }).init();
await db.load(['equipment']);
const engine = new Engine(db);
const store = await new Store().init();

const params = new URLSearchParams(location.search);
const shareToken = params.get('share');
const gmView = params.get('party') && params.get('member') ? { party: params.get('party'), member: params.get('member') } : null;
let charRec;
try {
  if (shareToken) charRec = await store.getShared(shareToken);
  else if (gmView) {
    // The GM opening a player's sheet from the GM screen: read-only, from the party.
    const r = await api('party', null, { id: gmView.party });
    charRec = r.members.find((m) => m.id === gmView.member);
    if (!charRec) throw new Error('This character isn’t in your party any more.');
  }
  else if (params.get('id')) charRec = await store.get(params.get('id'));
  else throw new Error('No character selected.');
} catch (e) {
  main.innerHTML = `<div class="card"><p class="bad">${esc(e.message)}</p><a class="btn" href="index.html">Back to characters</a></div>`;
  throw e;
}
const readOnly = !!shareToken || !!gmView;
if (!readOnly && charRec.id && store.conflictFor(charRec.id)) {
  const pick = await askConflict(store.conflictFor(charRec.id));
  if (pick === 'theirs') { store.discardLocal(charRec.id); location.reload(); return; }
  if (pick === 'mine') await store.save(charRec, { force: true }).catch((e) => toast(e.message, 'error'));
}
const build = normalizeBuild(charRec.build);
const state = Object.assign({ hp: null, temp: 0, hero: 1, focus: null, dying: 0, wounded: 0, conditions: [], effects: [], raging: false, unleashed: false, shieldRaised: false,
  used: {}, prep: {}, innateUsed: {}, dailyUsed: {}, notes: '', companions: {}, freqUsed: {}, situational: {}, favEffects: [], favActions: [], alchemy: {}, toggles: {}, staff: null }, charRec.state || {});
// Maps saved by older versions of the server can come back as lists ({} became []): turn them back into maps.
for (const k of ['used', 'prep', 'innateUsed', 'dailyUsed', 'companions', 'freqUsed', 'situational', 'alchemy', 'toggles']) state[k] = asObj(state[k]);
for (const k of Object.keys(state.prep)) state.prep[k] = asObj(state.prep[k]);
for (const k of Object.keys(state.used)) state.used[k] = asObj(state.used[k]);
for (const k of Object.keys(state.companions)) state.companions[k] = asObj(state.companions[k]);
state.alchemy.prep = asObj(state.alchemy.prep);
if (!Array.isArray(state.favEffects)) state.favEffects = [];
if (!Array.isArray(state.favActions)) state.favActions = [];
if (state.effects.length || state.favEffects.length) await db.load(['spell-effects', 'feat-effects', 'equipment-effects']);
await loadRunes(db);
let ch = null;
let tab = sessionStorage.getItem('pf2e.sheetTab') || 'actions';
document.title = (build.name || 'Character') + ' — PF2e sheet';

if (!readOnly) {
  const edit = 'builder.html?id=' + encodeURIComponent(charRec.id);
  $('#editLink').hidden = false; $('#editLink').href = edit;
  $('#navBuilder').hidden = false; $('#navBuilder').href = edit;
  if (build.level < 20) { $('#levelUpLink').hidden = false; $('#levelUpLink').href = 'levelup.html?id=' + encodeURIComponent(charRec.id); }
  if (store.mode === 'api') { $('#shareBtn').hidden = false; $('#shareBtn').onclick = share; $('#partyBtn').hidden = false; $('#partyBtn').onclick = openParty; }
} else $('#saveState').textContent = gmView ? 'Read-only (GM view)' : 'Read-only (shared sheet)';

let saveTimer = null;
const isLocal = () => store.mode !== 'api' || String(charRec.id || '').startsWith('local-');
function showSaved() {
  if (readOnly) return;
  const el = $('#saveState');
  const st = isLocal() ? { kind: 'local' } : store.syncState();
  el.textContent = syncLabel(st);
  el.className = 'save-state ' + (st.kind === 'saved' || st.kind === 'local' ? 'saved' : st.kind === 'conflict' || st.kind === 'login' ? 'bad' : 'warn');
}
function saveState() {
  if (readOnly) return;
  const el = $('#saveState');
  el.textContent = 'Saving…'; el.className = 'save-state';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { await store.saveState(charRec.id, state); showSaved(); }
    catch (e) { el.textContent = 'Not saved: ' + e.message; el.className = 'save-state bad'; }
  }, 700);
}
function saveBuild() {
  if (readOnly) return;
  charRec.build = build;
  saveWithConflictCheck(store, charRec).then(showSaved).catch((e) => toast(e.message, 'error'));
}
if (!readOnly) {
  store.onChange(showSaved);
  showSaved();
  mountAccount(store);
  window.addEventListener('beforeunload', () => { if (saveTimer) { clearTimeout(saveTimer); store.saveState(charRec.id, state); } });
}
// Join a GM's party with the code they give you; the GM then sees this sheet live (read-only).
async function openParty() {
  const id = String(charRec.id || '');
  const m = modal('Party', {});
  if (id.startsWith('tmp-') || id.startsWith('local-')) { m.body.innerHTML = '<p>This character isn’t saved to your account yet. Go online and wait for it to sync, then try again.</p>'; return; }
  const draw = async () => {
    let list = [];
    try { list = (await api('character_parties', null, { id })).parties || []; } catch (e) { m.body.innerHTML = `<p class="bad">${esc(e.message)}</p>`; return; }
    m.body.innerHTML = `
      ${list.length ? `<h3 class="inv-h" style="margin-top:0">${esc(build.name || 'This character')} is in</h3>${list.map((p) => `<div class="gm-mem"><span><b>${esc(p.name)}</b> <span class="muted small">GM: ${esc(p.gm || '—')}</span></span><button type="button" class="btn small ghost" data-leave="${esc(p.id)}">Leave</button></div>`).join('')}` : `<p class="muted" style="margin-top:0">Not in a party yet.</p>`}
      <h3 class="inv-h">Join a party</h3>
      <p class="muted small">Ask your GM for the party’s join code. They’ll see this sheet (HP, conditions, spell slots…) but can’t change it.</p>
      <div class="row" style="gap:8px"><input type="text" id="joinCode" class="mono" placeholder="ABC-123" maxlength="8" autocapitalize="characters" autocomplete="off" style="flex:1;text-transform:uppercase;letter-spacing:2px"><button type="button" class="btn primary" id="joinGo">Join</button></div>`;
    const inp = $('#joinCode', m.body);
    const go = async () => {
      try { const r = await api('party_join', { code: inp.value, character_id: id }); toast(`Joined ${r.party.name}`, 'ok'); draw(); }
      catch (e) { toast(e.message, 'error'); }
    };
    $('#joinGo', m.body).onclick = go;
    inp.onkeydown = (e) => { if (e.key === 'Enter') go(); };
    $$('[data-leave]', m.body).forEach((b) => (b.onclick = async () => {
      if (!(await confirmBox('Leave this party? The GM won’t see this sheet any more.'))) return;
      try { await api('party_leave', { party_id: b.dataset.leave, character_id: id }); draw(); } catch (e) { toast(e.message, 'error'); }
    }));
  };
  draw();
}

async function share() {
  try {
    const r = await store.share(charRec.id, true);
    const url = location.origin + location.pathname + '?share=' + r.share_token;
    const m = modal('Share this sheet');
    m.body.innerHTML = `<p>Anyone with this link can view (not edit) the sheet — handy for your GM.</p><input type="text" readonly value="${esc(url)}" style="width:100%" aria-label="Share link"><div class="row end" style="margin-top:10px"><button type="button" class="btn danger stop">Stop sharing</button><button type="button" class="btn primary copy">Copy link</button></div>`;
    $('.copy', m.body).onclick = () => { navigator.clipboard?.writeText(url); toast('Link copied', 'ok'); };
    $('.stop', m.body).onclick = async () => { await store.share(charRec.id, false); m.close(); toast('Sharing stopped'); };
  } catch (e) { toast(e.message, 'error'); }
}

function compute() {
  ch = engine.compute(build, state);
  const fmax = ch.spellcasting.focus.max || ch.focusMax;
  if (state.focus === null || state.focus > fmax) state.focus = fmax;
  if (state.hp === null || state.hp > ch.hp.max) state.hp = ch.hp.max;
}
// Portrait: picked from the device, shrunk to a small picture and kept in the build.
async function choosePortrait(after) {
  const f = await pickImage();
  if (!f) return;
  try { build.portrait = await makePortrait(f); } catch (e) { toast(e.message, 'error'); return; }
  saveBuild(); render(); after && after();
}
function portraitModal() {
  const m = modal(build.name || 'Portrait');
  m.body.innerHTML = `<div class="portrait-big"><img src="${portraitSrc(build.portrait)}" alt="Portrait of ${esc(build.name || 'this character')}"></div>
    ${readOnly ? '' : `<div class="row end" style="margin-top:12px;gap:8px"><button type="button" class="btn danger" data-prm>Remove</button><button type="button" class="btn primary" data-pchg>Change picture</button></div>`}`;
  if (readOnly) return;
  $('[data-pchg]', m.body).onclick = () => choosePortrait(() => m.close());
  $('[data-prm]', m.body).onclick = async () => { if (!(await confirmBox('Remove this portrait?'))) return; delete build.portrait; saveBuild(); render(); m.close(); };
}
function change(rerender = true) { compute(); saveState(); if (rerender) render(); }

// ------------------------------------------------------------------ rendering helpers
// AC, Perception, a save or a skill up close. Situational modifiers can be ticked on: they then count
// (on the sheet, the Actions tab, the GM screen) until they're ticked off.
function statInfo(key) {
  const base = (st) => st.total - (st.mods || []).reduce((a, m) => a + m.value, 0);
  if (key === 'ac') return { title: 'Armor Class', stat: ch.ac, isDC: true, label: `10 + Dex ${signed(ch.ac.dex)}${ch.ac.dexCap != null ? ' (cap ' + ch.ac.dexCap + ')' : ''} + ${RANKS[ch.ac.rank].toLowerCase()} in ${ch.ac.category}`, value: base(ch.ac) };
  if (key === 'perception') return { title: 'Perception', stat: ch.perception, label: `Wis + ${RANKS[ch.perception.rank].toLowerCase()}`, value: base(ch.perception) };
  if (ch.saves[key]) { const s = ch.saves[key]; return { title: titleCase(key), stat: s, label: `${ATTR_NAMES[s.attr]} + ${RANKS[s.rank].toLowerCase()}`, value: base(s) }; }
  const st = ch.skills[key];
  if (st.via) return { title: titleCase(key), stat: st, label: `${ATTR_NAMES[st.attr]} + ${RANKS[st.rank].toLowerCase()} in ${st.via}`, value: base(st) };
  return { title: titleCase(key), stat: st, skill: true, label: `${ATTR_NAMES[st.attr]}${st.attr !== st.defaultAttr ? ' (house rule)' : ''} + ${RANKS[st.rank].toLowerCase()} proficiency`, value: base(st) };
}
function statModal(key) {
  const m = modal(statInfo(key).title);
  let showPick = false; // the alternate ability score picker stays hidden until asked for
  const draw = () => {
    const { stat, isDC, label, value, skill } = statInfo(key);
    const notes = stat.notes || [];
    const alt = skill && stat.attr !== stat.defaultAttr;
    // House rule: another attribute for this skill, when the GM allows it.
    const attrPick = !skill ? '' : readOnly ? (alt ? `<p class="small attr-note">Uses <b>${esc(ATTR_NAMES[stat.attr])}</b> instead of ${esc(ATTR_NAMES[stat.defaultAttr])} (house rule).</p>` : '')
      : !showPick ? `<button type="button" class="linkish small alt-attr-btn" data-altopen aria-expanded="false">Alternate ability score${alt ? `: ${esc(ATTR_NAMES[stat.attr])}` : ''}</button>`
      : `<div class="attr-pick-wrap"><div class="small"><b>Alternate ability score</b> <span class="muted">normally ${esc(ATTR_NAMES[stat.defaultAttr])}; pick another only if your GM allows it</span></div>
        <div class="attr-pick" role="radiogroup" aria-label="Ability score for ${esc(titleCase(key))}">${ATTRS.map((a) => `<button type="button" role="radio" aria-checked="${stat.attr === a}" class="chip-btn ${stat.attr === a ? 'on' : ''}" data-attr="${a}" title="${esc(ATTR_NAMES[a])}${a === stat.defaultAttr ? ' (normal)' : ''}">${a.toUpperCase()}${a === stat.defaultAttr ? '<span class="attr-dflt" aria-hidden="true">•</span>' : ''} <span class="muted">${signed(ch.attrs[a])}</span></button>`).join('')}</div></div>`;
    m.body.innerHTML = `<table class="stat-table"><tr><td>${esc(label)}</td><td class="mod">${isDC ? value : signed(value)}</td></tr>
      ${(stat.mods || []).map((x) => `<tr class="${x.situational ? 'sit-mod' : ''}"><td>${esc(x.label)} <span class="muted small">${esc(x.type)}${x.situational ? ' · situational, on' : ''}</span></td><td class="mod">${signed(x.value)}</td></tr>`).join('')}
      <tr><th>Total</th><th class="mod">${isDC ? stat.total : signed(stat.total)}</th></tr></table>
      ${(stat.degree || []).length ? `<div class="degree-notes">${stat.degree.map((d) => `<p class="small"><b>${esc(d.label)}.</b> ${esc(d.text)}${d.conditional ? ' <span class="muted">(only in some cases)</span>' : ''}</p>`).join('')}</div>` : ''}
      ${notes.length ? `<h4 style="margin-top:14px">Situational</h4>
        <p class="muted small" style="margin-top:0">${readOnly ? 'Ticked ones are on.' : 'Tick one while it applies: it counts until you untick it.'}</p>
        <div class="sit-list">${notes.map((n) => `<label class="sit-row ${n.on ? 'on' : ''}"><input type="checkbox" data-sit="${esc(n.id)}" ${n.on ? 'checked' : ''} ${readOnly ? 'disabled' : ''}>
          <span><b class="mono">${signed(n.value)}</b> ${esc(n.type)} <span class="muted">from</span> ${esc(n.label)}${n.source && n.source !== n.label ? ` <span class="muted small">(${esc(n.source)})</span>` : ''}</span></label>`).join('')}</div>` : ''}
      ${attrPick}`;
    const ao = $('[data-altopen]', m.body); if (ao) ao.onclick = () => { showPick = true; draw(); };
    $$('[data-attr]', m.body).forEach((b) => (b.onclick = () => {
      const a = b.dataset.attr;
      build.skillAttrs = Object.assign({}, build.skillAttrs);
      if (a === stat.defaultAttr) delete build.skillAttrs[key]; else build.skillAttrs[key] = a;
      saveBuild(); change(); draw();
    }));
    $$('[data-sit]', m.body).forEach((c) => (c.onchange = () => {
      const on = new Set(state.situational[key] || []);
      if (c.checked) on.add(c.dataset.sit); else on.delete(c.dataset.sit);
      if (on.size) state.situational[key] = [...on]; else delete state.situational[key];
      change(); draw();
    }));
  };
  draw();
}
const sitOn = (st) => (st?.notes || []).some((n) => n.on);
function breakdown(title, base, stat) {
  const m = modal(title);
  const mods = stat.mods || [];
  const isDC = /AC|DC/.test(title);
  m.body.innerHTML = `<table class="stat-table"><tr><td>${esc(base.label)}</td><td class="mod">${isDC ? base.value : signed(base.value)}</td></tr>
    ${mods.map((x) => `<tr><td>${esc(x.label)} <span class="muted small">${esc(x.type)}</span></td><td class="mod">${signed(x.value)}</td></tr>`).join('')}
    <tr><th>Total</th><th class="mod">${isDC ? stat.total : signed(stat.total)}</th></tr></table>
    ${stat.notes?.length ? `<h4 style="margin-top:12px">Situational</h4><ul>${stat.notes.map((n) => `<li>${signed(n.value)} ${esc(n.type)} from ${esc(n.label)}</li>`).join('')}</ul>` : ''}`;
  return m;
}
// Small line icons for the stat tiles (drawn here, no icon font).
const ICON_PATHS = {
  ac: '<path d="M12 3l7 3v5c0 4.6-3 8.3-7 10-4-1.7-7-5.4-7-10V6z"/>',
  fortitude: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  reflex: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  will: '<path d="M12 3l2.4 5.6L20 9.3l-4.3 3.9 1.3 5.8L12 16l-5 3 1.3-5.8L4 9.3l5.6-.7z"/>',
  perception: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  classdc: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".6" fill="currentColor"/>',
  spelldc: '<path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z"/><path d="M12 8v8M8.5 10l7 4M15.5 10l-7 4"/>',
  spellatk: '<path d="M4 20L15 9"/><path d="M17 3v4M15 5h4M19.5 10.5v3M18 12h3M10 3.5v2M9 4.5h2"/>',
};
const icon = (k) => ICON_PATHS[k] ? `<svg class="tile-ic" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[k]}</svg>` : '';
const tileStat = (key) => (key === 'ac' ? ch.ac : key === 'perception' ? ch.perception : ch.saves?.[key]);
const tile = (key, label, value, rank, cls = '') => `<button type="button" class="tile ${cls} ${sitOn(tileStat(key)) ? 'sit-on' : ''}" ${key ? `data-bd="${key}"` : ''}><div class="tile-head">${icon(key)}<span class="label">${esc(label)}</span>${sitOn(tileStat(key)) ? '<span class="sit-mark" title="A situational bonus is on">✓</span>' : ''}${rank != null ? rankBadge(rank) : ''}</div><div class="tile-value">${value}</div></button>`;
const initials = (n) => String(n || '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter((w) => /^[\p{L}\p{N}]/u.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
const mainEntry = () => ch.spellcasting.entries.find((e) => e.id === 'class') || ch.spellcasting.entries[0] || null;
const effName = (rec, ref) => (rec?.name || ref).replace(/^(Spell )?Effect: /, '');

function render() {
  if (!TABS().some((t) => t.id === tab)) tab = 'actions';
  const A = ch.attrs, L = ch.level;
  const hpPct = Math.max(0, Math.min(100, (state.hp / ch.hp.max) * 100));
  const tempPct = Math.min(100 - hpPct, (state.temp / ch.hp.max) * 100);
  const e0 = mainEntry();
  const focusMax = ch.spellcasting.focus.max || ch.focusMax;
  const isBarb = ch.class?.slug === 'barbarian' || ch.ownedSlugs.has('rage');
  const sub = ch.items.filter((i) => i.pack === 'classfeatures' && i.key.split('>').length === 2 && i.key.startsWith('cf:')).map((i) => i.rec.name).slice(0, 2);
  const identity = [`${ch.ancestry?.name || ''}${ch.heritage ? ' (' + ch.heritage.name.replace(new RegExp('\\s*' + (ch.ancestry?.name || '###') + '$'), '') + ')' : ''}`, `${ch.class?.name || 'No class'} ${L}`, ch.background?.name, sub.join(' / '), ch.deity?.name].filter(Boolean).join(' · ');
  const pic = portraitSrc(build.portrait);
  const heroBtns = `<div class="row no-print hero-btns">
        <button type="button" class="btn small" id="restBtn" title="Daily preparations: restore HP, slots and focus">☾ Rest</button>
        ${isBarb ? `<button type="button" class="btn small ${state.raging ? 'primary' : ''}" id="rageBtn" aria-pressed="${state.raging}">${state.raging ? 'Raging' : 'Rage'}</button>` : ''}
        ${ch.ownedSlugs.has('unleash-psyche') ? `<button type="button" class="btn small ${state.unleashed ? 'primary' : ''}" id="unleashBtn" aria-pressed="${state.unleashed}" title="Unleash Psyche: 2 rounds; afterwards Stupefied 1 for 2 rounds">${state.unleashed ? 'Psyche unleashed' : 'Unleash Psyche'}</button>` : ''}
        ${ch.shield ? `<button type="button" class="btn small ${state.shieldRaised ? 'primary' : ''}" id="shieldBtn" aria-pressed="${state.shieldRaised}">${state.shieldRaised ? 'Shield raised' : 'Raise shield'}</button>` : ''}
      </div>`;
  main.innerHTML = `
  <section class="hero-card">
    <div class="hero-left">
    <div class="hero-top ${pic ? 'has-pic' : ''}">${pic
      ? `<button type="button" class="portrait" id="portraitBtn" aria-label="${readOnly ? 'Show portrait' : 'Portrait: change or remove'}"><img src="${pic}" alt=""></button>`
      : readOnly ? `<div class="avatar" aria-hidden="true">${esc(initials(build.name))}</div>`
        : `<button type="button" class="avatar add-pic" id="portraitBtn" title="Add a portrait" aria-label="Add a portrait">${esc(initials(build.name))}<span class="pic-plus" aria-hidden="true">+</span></button>`}
    <div class="hero-id"><h1>${esc(build.name || 'Unnamed')}</h1><div class="identity">${esc(identity)}</div>${pic ? heroBtns : ''}</div></div>
      ${pic ? '' : heroBtns}
      <div class="tiles checks" aria-label="Perception and DCs">
        ${tile('perception', 'Perception', signed(ch.perception.total), ch.perception.rank)}
        ${ch.classDC ? tile('classdc', 'Class DC', ch.classDC.total, ch.classDC.rank) : ''}
        ${e0 ? tile('spelldc', 'Spell DC', e0.dc, e0.rank) + tile('spellatk', 'Spell atk', signed(e0.attack), e0.rank) : ''}
      </div>
      <div class="attr-row" role="group" aria-label="Attributes">${ATTRS.map((a) => `<div class="pill" title="${ATTR_NAMES[a]}"><span class="pill-label">${a.toUpperCase()}</span><span class="pill-value">${signed(A[a])}</span></div>`).join('')}</div>
    </div>
    <div class="hp-block">
      <div class="hp-head"><span class="label">Hit points</span><span class="hp-num">${state.hp} <span class="max">/ ${ch.hp.max}</span>${state.temp ? ` <span class="temp">+${state.temp} temp</span>` : ''}</span></div>
      <div class="hpbar" role="progressbar" aria-label="Hit points" aria-valuemin="0" aria-valuemax="${ch.hp.max}" aria-valuenow="${state.hp}"><div class="${hpPct <= 25 ? 'crit' : hpPct <= 50 ? 'low' : ''}" style="width:${hpPct}%"></div><div class="temp" style="left:${hpPct}%;width:${tempPct}%"></div></div>
      <div class="row no-print hp-controls" style="margin-top:4px">
        <label><span class="sr-only">Amount</span><input type="number" id="hpAmt" class="num" min="0" placeholder="0" inputmode="numeric" pattern="[0-9]*"></label>
        <span class="hp-quick" aria-label="Add to amount">${[1, 5, 10].map((n) => `<button type="button" class="btn small" data-amt="${n}">+${n}</button>`).join('')}</span>
        <button type="button" class="btn danger" id="dmgBtn">Damage</button><button type="button" class="btn" id="healBtn">Heal</button><button type="button" class="btn" id="tempBtn">Temp</button>
      </div>
      <div class="tiles defs" aria-label="Defenses">
        ${tile('ac', 'AC', ch.ac.total, ch.ac.rank, 'ac')}
        ${Object.keys(SAVES).map((s) => tile(s, { fortitude: 'Fort', reflex: 'Ref', will: 'Will' }[s] || titleCase(s), signed(ch.saves[s].total), ch.saves[s].rank)).join('')}
      </div>
      <div class="hero-conds">
        <div class="hc-col"><div class="row between"><h2 class="label" style="margin:0">Conditions</h2>${readOnly ? '' : '<button type="button" class="btn small" id="addCond">+ Add</button>'}</div>
        <div class="cond-list">${state.conditions.map((c, i) => { const rec = db.get('@conditions/' + c.slug); const nm = esc(rec?.name || c.slug); return `<div class="cond-row ${rec?.valued && !readOnly ? 'valued' : ''}"><button type="button" class="cond-name" data-cond="${i}">${nm}${rec?.valued ? ` <b class="mono">${c.value}</b>` : ''}</button>${readOnly ? '' : `${rec?.valued ? `<button type="button" class="step" data-cdown="${i}" aria-label="Lower ${nm}">−</button><span class="cond-val mono" aria-hidden="true">${c.value}</span><button type="button" class="step" data-cup="${i}" aria-label="Raise ${nm}">+</button><span class="grow"></span>` : ''}<button type="button" class="step x" data-crm="${i}" aria-label="Remove ${nm}">×</button>`}</div>`; }).join('') || '<span class="muted small">None</span>'}</div>
        </div><div class="hc-col"><div class="row between"><h2 class="label" style="margin:0">Effects</h2>${readOnly ? '' : '<button type="button" class="btn small" id="addEff">+ Add</button>'}</div>
        <div class="cond-list">${state.effects.map((e, i) => { const rec = db.get(e.ref); const nm = esc(effName(rec, e.ref)); const fav = state.favEffects.includes(e.ref); return `<div class="cond-row eff"><button type="button" class="cond-name" data-show="${esc(e.ref)}">${nm}</button>${readOnly ? '' : `<button type="button" class="step fav ${fav ? 'on' : ''}" data-efav="${esc(e.ref)}" aria-pressed="${fav}" aria-label="${fav ? 'Remove from favorites' : 'Add to favorites'}" title="${fav ? 'Favorite: one tap to add it again' : 'Favorite it, to add it again with one tap'}">${fav ? '★' : '☆'}</button><button type="button" class="step x" data-erm="${i}" aria-label="Remove ${nm}">×</button>`}</div>`; }).join('') || '<span class="muted small">None</span>'}</div>
        ${!readOnly && state.favEffects.some((r) => !state.effects.some((e) => e.ref === r)) ? `<div class="fav-effs">${state.favEffects.filter((r) => !state.effects.some((e) => e.ref === r)).map((r) => `<button type="button" class="chip-btn small" data-efq="${esc(r)}" title="Add ${esc(effName(db.get(r), r))}">★ ${esc(effName(db.get(r), r))}</button>`).join('')}</div>` : ''}
      </div>
      </div>
    </div>
    <div class="hero-right">
    <div class="pip-col">
      <div class="pip-row"><span class="pip-label">Hero</span>${[1, 2, 3].map((i) => `<button type="button" class="pip ${state.hero >= i ? 'on' : ''}" data-hero="${i}" aria-label="Hero point ${i}" aria-pressed="${state.hero >= i}"></button>`).join('')}</div>
      ${focusMax ? `<div class="pip-row"><span class="pip-label">Focus</span>${Array.from({ length: focusMax }, (_, i) => `<button type="button" class="pip sq ${state.focus > i ? 'on' : ''}" data-focus="${i + 1}" aria-label="Focus point ${i + 1}" aria-pressed="${state.focus > i}"></button>`).join('')}</div>` : ''}
      <div class="pip-row"><span class="pip-label">Dying</span>${[1, 2, 3, 4].map((i) => `<button type="button" class="pip dy ${state.dying >= i ? 'on' : ''}" data-dying="${i}" aria-label="Dying ${i}" aria-pressed="${state.dying >= i}"></button>`).join('')}</div>
      <div class="pip-row"><span class="pip-label">Wounded</span>${[1, 2, 3].map((i) => `<button type="button" class="pip dy ${state.wounded >= i ? 'on' : ''}" data-wounded="${i}" aria-label="Wounded ${i}" aria-pressed="${state.wounded >= i}"></button>`).join('')}</div>
    </div>
      <div class="hero-info">
        <div class="info-line"><span>Size</span> ${esc(ch.sizeLabel || 'Medium')}${ch.reach && ch.reach !== 5 ? ` · reach ${ch.reach} ft` : ''}</div>
        <div class="info-line"><span>Speed</span> ${ch.speed.total} ft${ch.speed.other.length ? ' · ' + esc(ch.speed.other.map((o) => titleCase(o.type) + ' ' + o.value + ' ft').join(', ')) : ''}</div>
        <div class="info-line"><span>Initiative</span> Perception ${signed(ch.initiative.total)}</div>
        <div class="info-line"><span>Languages</span> ${esc(ch.languages.map(titleCase).join(', ') || '—')}</div>
        ${ch.senses.length ? `<div class="info-line"><span>Senses</span> ${esc(ch.senses.map((s) => titleCase(s.type) + (s.range ? ' ' + s.range + ' ft' : '')).join(', '))}</div>` : ''}
        ${ch.defensesList.length ? `<div class="info-line"><span>Defenses</span> ${esc(ch.defensesList.map((d) => `${d.kind} ${d.type}${d.value != null ? ' ' + d.value : ''}`).join(', '))}</div>` : ''}
        <div class="info-line"><span>Bulk</span> ${ch.bulk.total} / ${ch.bulk.encumbered}${ch.bulk.total > ch.bulk.encumbered ? ' <span class="bad">encumbered</span>' : ''}</div>
      </div>
    </div>
  </section>


  <div class="sheet-cols">
    <section class="col-main" aria-label="Sheet sections">
      <div class="tabs" role="tablist">${TABS().map((t) => `<button type="button" role="tab" data-tab="${t.id}" aria-selected="${tab === t.id}">${t.label}</button>`).join('')}</div>
      <div class="tab-body" id="tabPanel" role="tabpanel"></div>
    </section>

    <aside class="col-right card tight" style="margin:0">
      <h2 class="label" style="margin-bottom:6px">Skills</h2>
      ${Object.keys(SKILLS).map((s) => { const k = ch.skills[s]; return `<div class="skill-row ${k.rank ? '' : 'untrained'}" data-skill="${s}" role="button" tabindex="0">${rankBadge(k.rank)}<span class="sk-name">${esc(titleCase(s))}${k.via ? ` <span class="attr-tag" title="Uses ${esc(k.via)}">CRA</span>` : k.attr !== k.defaultAttr ? ` <span class="attr-tag" title="Uses ${esc(ATTR_NAMES[k.attr])} (house rule)">${k.attr.toUpperCase()}</span>` : ''}${sitOn(k) ? ' <span class="sit-mark" title="A situational bonus is on">✓</span>' : k.notes.length ? ' <span class="warn" title="Has situational modifiers: tap to tick one on">*</span>' : ''}</span><span class="sk-mod ${sitOn(k) ? 'sit-on' : ''}">${signed(k.total)}</span></div>`; }).join('')}
      ${Object.entries(ch.lores).map(([n, l]) => `<div class="skill-row">${rankBadge(l.rank)}<span class="sk-name">${esc(/lore$/i.test(n) ? n : n + ' Lore')}</span><span class="sk-mod">${signed(l.total)}</span></div>`).join('')}
      <h2 class="label" style="margin:14px 0 6px">Proficiencies</h2>
      <table class="stat-table small">
        ${Object.entries(ch.ranks.defenses).filter(([, r]) => r).map(([k, r]) => `<tr><td style="width:26px">${rankBadge(r)}</td><td>${titleCase(k)} ${k === 'unarmored' ? 'defense' : 'armor'}</td></tr>`).join('')}
        ${Object.entries(ch.ranks.attacks).filter(([, r]) => r).map(([k, r]) => `<tr><td>${rankBadge(r)}</td><td>${esc(titleCase(k.replace(/^weapon-(base|group)-/, '')))} ${k.startsWith('weapon-') ? '' : k === 'unarmed' ? 'attacks' : 'weapons'}</td></tr>`).join('')}
        ${ch.ranks.spellcasting ? `<tr><td>${rankBadge(ch.ranks.spellcasting)}</td><td>Spell attacks &amp; DCs</td></tr>` : ''}
        <tr><td>${rankBadge(ch.ranks.classDC)}</td><td>Class DC</td></tr>
      </table>
    </aside>
  </div>`;
  (TAB_RENDER[tab] || TAB_RENDER.actions)($('#tabPanel'));
  wire();
}

function TABS() {
  return [
    { id: 'actions', label: 'Actions' },
    ...(hasAlchemy(ch) ? [{ id: 'alchemy', label: 'Alchemy' }] : []),
    ...(ch.spellcasting.any ? [{ id: 'spells', label: 'Spells' }] : []),
    { id: 'feats', label: 'Feats' },
    { id: 'equipment', label: 'Equipment' },
    { id: 'inventory', label: 'Inventory' },
    { id: 'companions', label: 'Companions' },
    { id: 'crafting', label: 'Crafting' },
    { id: 'notes', label: 'Notes' },
  ];
}

const TAB_RENDER = {};
const ACT_TABS = [{ id: 'fav', label: '★ Favorites' }, { id: 'basic', label: 'Basic' }, { id: 'skill', label: 'Skill' }, { id: 'special', label: 'Special' }];
const COSTS = [{ id: '1', label: '◆', title: 'One action' }, { id: '2', label: '◆◆', title: 'Two actions' }, { id: '3', label: '◆◆◆', title: 'Three actions' },
  { id: 'reaction', label: '⟲', title: 'Reaction' }, { id: 'free', label: '◇', title: 'Free action' }, { id: 'activity', label: 'Longer', title: 'Activities that take longer' }];
const MODES = [{ id: 'encounter', label: 'Combat' }, { id: 'exploration', label: 'Exploration' }, { id: 'downtime', label: 'Downtime' }];
const actF = Object.assign({ tab: 'basic', cost: '', mode: '', q: '', usable: false }, (() => { try { return JSON.parse(sessionStorage.getItem('pf2e.actFilters') || '{}'); } catch (e) { return {}; } })());
const saveActF = () => { try { sessionStorage.setItem('pf2e.actFilters', JSON.stringify({ ...actF, q: '' })); } catch (e) { /* ignore */ } };

/** Everything the Actions tab lists, sorted into basic / skill / special. */
function actionGroups() {
  const all = db.list('actions');
  const bySlug = (slug) => all.find((a) => a.slug === slug);
  const speeds = new Set((ch.speed.other || []).map((x) => x.type));
  const roll = (k) => (k === 'perception' ? { label: 'Perception', total: ch.perception.total, rank: ch.perception.rank } : { label: titleCase(k), total: ch.skills[k].total, rank: ch.skills[k].rank });
  // Basic
  const basic = all.filter((a) => ['basic', 'exploration', 'downtime'].includes(a.grp) && !(NEEDS_SPEED[a.slug] && !speeds.has(NEEDS_SPEED[a.slug])) && !SKILL_ACTIONS[a.slug])
    .map((rec) => ({ rec, head: rec.grp === 'exploration' ? 'Exploration activities' : rec.grp === 'downtime' ? 'Downtime activities' : CORE_BASIC.includes(rec.slug) ? 'Basic actions' : 'Specialty basic actions',
      rolls: (BASIC_ROLLS[rec.slug] || []).map(roll) }));
  // Skill: one group per skill (lores included), each listing what it can do
  const skill = [];
  const groups = [...Object.keys(ch.skills).map((k) => ({ key: k, ...roll(k) })),
    ...Object.entries(ch.lores || {}).map(([n, l]) => ({ key: 'lore', label: /lore$/i.test(n) ? n : n + ' Lore', total: l.total, rank: l.rank }))];
  for (const g of groups) {
    for (const [slug, info] of Object.entries(SKILL_ACTIONS)) {
      if (!info.skills.includes(g.key)) continue;
      const rec = bySlug(slug);
      if (!rec) continue;
      const cant = !!info.trained && !g.rank;
      skill.push({ rec, head: g.label, headRank: g.rank, headTotal: g.total, trainedOnly: !!info.trained, cant, total: g.total, attack: (rec.traits || []).includes('attack') });
    }
  }
  // Special: from class features, feats, archetypes, ancestry and items
  const seen = new Set();
  const aRefs = limitedActionRefs(ch);
  const limited = (rec) => !!effectiveFreq(rec, ch) && !isActionDup(rec, aRefs);
  const special = [...ch.actions.map((a) => ({ rec: a.rec, src: a.source || '' })),
    ...ch.feats.filter((f) => (f.rec.action && f.rec.action !== 'passive') || limited(f.rec)).map((f) => ({ rec: f.rec, slot: f.slot, src: f.slot ? `${f.slot.label.replace(/ feat$/, '')} ${f.slot.level}` : f.source || 'Feat' })),
    ...ch.features.filter((f) => (f.rec.action && f.rec.action !== 'passive') || limited(f.rec)).map((f) => ({ rec: f.rec, src: f.source && f.source !== f.rec.name ? f.source : 'Class feature' }))]
    .filter((x) => !SKILL_ACTIONS[x.rec.slug] && !['basic', 'exploration', 'downtime'].includes(x.rec.grp) && !seen.has(x.rec.slug) && seen.add(x.rec.slug))
    .map((x) => ({ ...x, head: originOf(x) }));
  return { basic, skill, special };
}

// Under an action's rules text: the Medicine DC table for Treat Wounds and Battle Medicine, and this character's feats,
// features and items whose rules change the action (their text links to it: Mortal Healing → Treat Wounds).
const HEAL_DCS = [[15, 1, 0], [20, 2, 10], [30, 3, 30], [40, 4, 50]];
const MEDIC_BONUS = { 20: 5, 30: 10, 40: 15 }; // Medic Dedication's circumstance bonus to the Hit Points regained
// Psychics: a psi cantrip's window also shows what the conscious mind changes about it and its Amp, plus the
// amps from feats that can be used instead (Warp Space, Mental Balm…).
function psiExtras(ref) {
  const e = ch.spellcasting.entries.find((x) => x.mind && x.psiCantrips);
  const p = e && e.psiCantrips.find((x) => x.ref === ref);
  if (!p) return '';
  // Parallel Breakthrough's cantrip keeps the amp of the mind it comes from.
  const text = ((e.mind.psychic || {}).amps || {})[ref] || p.amp;
  const alts = ch.items.filter((i) => i.rec && i.rec.altAmp);
  let html = `<h4 class="act-x-h">Psi cantrip <span class="muted small">${esc(p.fromMind ? p.fromMind + ' (Parallel Breakthrough)' : e.mind.name)} · amp it by spending 1 Focus Point</span></h4>${text ? `<div class="rules-text psi-amp">${text}</div>` : ''}`;
  if (alts.length) html += `<h4 class="act-x-h">Other amps you know <span class="muted small">use one in place of the normal amp</span></h4>`
    + alts.map((i) => `<div class="rules-text psi-amp"><p><a class="ref" data-ref="${esc(refOf(i.rec).slice(1))}"><b>${esc(i.rec.name)}</b></a></p>${i.rec.altAmp}</div>`).join('');
  return html;
}
function actionExtras(ref) {
  let html = psiExtras(ref);
  if (ref === '@actions/treat-wounds' || ref === '@feats/battle-medicine') {
    // Chirurgeon: Crafting proficiency counts for the higher DCs.
    const rank = Math.max(ch.ranks.skills.medicine || 0, ch.skills.medicine.reqRank || 0);
    const medic = ch.ownedSlugs.has('medic-dedication');
    html += `<h4 class="act-x-h">Medicine DCs <span class="muted small">your Medicine ${signed(ch.skills.medicine.total)} (${esc(RANKS[rank].toLowerCase())}${ch.skills.medicine.reqRank > (ch.ranks.skills.medicine || 0) ? ', from Crafting' : ''})</span></h4>
      <table class="stat-table heal-dcs"><tr><th>DC</th><th>Needs</th><th>Success</th><th>Critical success</th></tr>
      ${HEAL_DCS.map(([dc, need, add]) => { const a = add + (medic ? MEDIC_BONUS[dc] || 0 : 0); return `<tr class="${rank >= need ? '' : 'out'}"><td class="mono">${dc}</td><td>${esc(RANKS[need].toLowerCase())}</td><td class="mono">2d8${a ? '+' + a : ''}</td><td class="mono">4d8${a ? '+' + a : ''}</td></tr>`; }).join('')}</table>
      ${medic ? '<p class="small muted">Includes Medic Dedication: +5 HP at DC 20, +10 at DC 30, +15 at DC 40.</p>' : ''}
      <p class="small muted">${ref === '@actions/treat-wounds' ? 'Hit Points regained. Keep treating for a full hour to double them. ' : 'Hit Points restored. '}Critical failure: the target takes 1d8 damage.</p>`;
  }
  const own = new Map();
  for (const i of ch.items || []) if (i.rec && (i.rec.acts || []).includes(ref)) own.set(refOf(i.rec), i.rec);
  for (const it of ch.inventory || []) if ((it.equipped || it.invested) && it.rec && (it.rec.acts || []).includes(ref)) own.set(it.ref, it.rec);
  own.delete(ref);
  if (own.size) html += `<h4 class="act-x-h">Your feats and items that mention it</h4>
    <div class="act-mods">${[...own].map(([r, rec]) => `<a class="ref chip-btn" data-ref="${esc(r.slice(1))}">${esc(rec.name)}</a>`).join('')}</div>`;
  return html ? `<div class="act-extras">${html}</div>` : '';
}

TAB_RENDER.actions = (el) => {
  el.innerHTML = `<h3 class="sub-head">Strikes</h3>${(ch.toggles || []).length ? `<div class="strike-toggles" role="group" aria-label="Strike options">${ch.toggles.map((t) => (t.subs.length
    ? `<label class="st-tog ${t.on ? 'on' : ''}" title="${esc(t.source)}"><span>${t.option === 'bomber-field-vials' ? 'Vial damage' : esc(t.label)}</span><select data-tog="${esc(t.option)}" ${readOnly ? 'disabled' : ''}><option value="">${t.option === 'bomber-field-vials' ? 'Acid (normal)' : 'Off'}</option>${t.subs.map((x) => `<option value="${esc(x.value)}" ${t.on === x.value ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></label>`
    : `<label class="st-tog ${t.on ? 'on' : ''}" title="${esc(t.source)}"><input type="checkbox" data-tog="${esc(t.option)}" ${t.on ? 'checked' : ''} ${readOnly ? 'disabled' : ''}><span>${esc(t.label)}</span></label>`)).join('')}</div>` : ''}${ch.strikes.map((s) => `
    <div class="strike"><div class="s-name" ${s.rec._pack ? `data-show="${esc(refOf(s.rec))}" role="button"` : ''}><b>${esc(s.name)}${s.item && s.item.qty > 1 ? ` <span class="muted small">×${s.item.qty}</span>` : ''}</b>${s.item && s.item.left != null ? ` <span class="badge ${s.item.left ? '' : 'warn'}">${s.item.left} left${s.item.infused ? ' · infused' : ''}</span>` : ''}
      <div class="s-traits">${esc([s.ranged ? 'Ranged' + (s.range ? ' ' + s.range + ' ft' : '') : 'Melee', ...s.traits.filter((t) => t !== 'consumable').map(titleCase)].join(' · '))}</div>
      ${(s.runes || []).length || s.material ? `<div class="s-runes">${(s.runes || []).map((r) => { const ref = runeRef(db, db.runeData?.weapon?.[r.slug]); return `<span class="badge rune-badge" ${ref ? `data-show="${esc(ref)}" role="button"` : ''}>${esc(r.name)}</span>`; }).join(' ')}${s.material ? ` <span class="badge mat-badge">${esc(materialLabel(db, s.material))}</span>` : ''}</div>` : ''}</div>
      <div class="atk" aria-label="Attack bonuses"><span>${signed(s.attack)}</span><span>${signed(s.map[0])}</span><span>${signed(s.map[1])}</span></div>
      <div class="dmg">${esc(s.damage)}${s.persistent ? `<div class="tiny muted">${esc(s.persistent)}</div>` : ''}${s.splash ? `<div class="tiny muted">${s.splash} splash</div>` : ''}</div>
      ${s.notes.length || s.dmgNotes.length ? `<div class="s-notes">${[...s.notes, ...s.dmgNotes].map((n) => `${signed(n.value)} ${esc(n.label)} (situational)`).join(' · ')}</div>` : ''}
      ${(s.runeNotes || []).length ? `<div class="s-notes s-rune-notes">${s.runeNotes.map((n) => `<div><b>${esc(n.label)}.</b> ${esc(n.text)}</div>`).join('')}</div>` : ''}</div>`).join('')}
    <div class="act-tools">
      <div class="act-seg" role="tablist" aria-label="Kinds of actions">${ACT_TABS.map((t) => `<button type="button" role="tab" data-acttab="${t.id}" aria-selected="${actF.tab === t.id}">${t.label} <span class="n"></span></button>`).join('')}</div>
      <label class="act-search"><span class="sr-only">Search actions</span><input type="search" placeholder="Search actions…" value="${esc(actF.q)}" autocomplete="off" enterkeyhint="search"></label>
    </div>
    <div class="act-chips" role="group" aria-label="Filters">
      ${COSTS.map((c) => `<button type="button" class="chipbtn ${actF.cost === c.id ? 'on' : ''}" data-cost="${c.id}" title="${c.title}" aria-pressed="${actF.cost === c.id}">${c.label}</button>`).join('')}
      <span class="sep"></span>
      ${MODES.map((m) => `<button type="button" class="chipbtn ${actF.mode === m.id ? 'on' : ''}" data-mode="${m.id}" aria-pressed="${actF.mode === m.id}">${m.label}</button>`).join('')}
      <button type="button" class="chipbtn usable ${actF.usable ? 'on' : ''}" data-usable aria-pressed="${actF.usable}" ${actF.tab === 'skill' ? '' : 'hidden'}>Hide untrained</button>
    </div>
    <div class="act-list" aria-live="polite"></div>`;
  const groups = actionGroups();
  const list = $('.act-list', el);
  const q = () => actF.q.trim().toLowerCase();
  const pass = (x) => (!actF.cost || costOf(x.rec) === actF.cost) && (!actF.mode || modeOf(x.rec) === actF.mode)
    && (!q() || x.rec.name.toLowerCase().includes(q()) || (x.head || '').toLowerCase().includes(q()))
    && !(actF.tab === 'skill' && actF.usable && x.cant);
  const right = (x) => {
    if (x.total != null) {
      if (x.cant) return '<span class="act-roll muted">Needs trained</span>';
      return x.attack ? `<span class="act-roll mono" title="Multiple attack penalty">${signed(x.total)} <i>${signed(x.total - 5)}</i> <i>${signed(x.total - 10)}</i></span>` : `<span class="act-roll mono">${signed(x.total)}</span>`;
    }
    if (x.rolls && x.rolls.length) return `<span class="act-roll">${x.rolls.map((r) => `${esc(r.label)} <b class="mono">${signed(r.total)}</b>`).join(' · ')}</span>`;
    if (x.src) return `<span class="src">${esc(x.src)}${effectiveFreq(x.rec, ch) && !isActionDup(x.rec, limitedActionRefs(ch)) ? ' · ' + esc(freqText(effectiveFreq(x.rec, ch))) : ''}</span>`;
    return '';
  };
  const favBtn = (x) => { const r = refOf(x.rec), on = state.favActions.includes(r); return readOnly && !on ? '' : `<button type="button" class="act-fav ${on ? 'on' : ''}" data-afav="${esc(r)}" aria-pressed="${on}" aria-label="${on ? 'Remove ' + esc(x.rec.name) + ' from favorites' : 'Add ' + esc(x.rec.name) + ' to favorites'}" ${readOnly ? 'disabled' : ''}>${on ? '★' : '☆'}</button>`; };
  const row = (x) => `<div class="act-row ${x.cant ? 'cant' : ''}" data-row-show="${esc(refOf(x.rec))}" role="button" tabindex="0">${favBtn(x)}
    <span class="glyph" title="${esc(COSTS.find((c) => c.id === costOf(x.rec))?.title || '')}">${actionGlyph(x.rec) || '<span class="muted">—</span>'}</span>
    <span class="name">${esc(x.rec.name)}${x.trainedOnly ? ' <span class="badge">Trained</span>' : ''}${modeOf(x.rec) !== 'encounter' && !/^(Exploration|Downtime) activities$/.test(x.head || '') ? ` <span class="badge mode">${esc(titleCase(modeOf(x.rec)))}</span>` : ''}</span>${right(x)}${usesPips(x.rec)}</div>`;
  // Limited uses: one pip per use; tap to mark one used (tap again when all are used to clear them).
  function usesPips(rec) {
    const fr = !isActionDup(rec, limitedActionRefs(ch)) && parseFreq(effectiveFreq(rec, ch));
    if (!fr) return '';
    const used = Math.min(fr.max, state.freqUsed[rec.slug] || 0);
    return `<button type="button" class="uses ${used >= fr.max ? 'spent' : ''}" data-uses="${esc(rec.slug)}" data-max="${fr.max}" ${readOnly ? 'disabled' : ''} aria-label="${esc(rec.name)}: ${used} of ${fr.max} used (${esc(freqText(fr))})" title="${esc(freqText(fr))}">${Array.from({ length: fr.max }, (_, i) => `<i class="${i < used ? 'on' : ''}"></i>`).join('')}<span>${used >= fr.max ? 'used' : fr.max - used + ' left'}</span></button>`;
  }
  const draw = () => {
    // Favorites: starred actions from every tab, once each, under their usual headings.
    const seen = new Set();
    groups.fav = [];
    for (const k of ['basic', 'skill', 'special']) for (const x of groups[k]) { const r = refOf(x.rec); if (state.favActions.includes(r) && !seen.has(r)) { seen.add(r); groups.fav.push(x); } }
    const counts = {};
    for (const t of ACT_TABS) counts[t.id] = groups[t.id].filter(pass).length;
    $$('[data-tog]', el).forEach((i) => (i.onchange = () => { state.toggles[i.dataset.tog] = i.type === 'checkbox' ? i.checked : (i.value || null); change(); }));
    $$('[data-acttab]', el).forEach((b) => { b.querySelector('.n').textContent = counts[b.dataset.acttab]; b.setAttribute('aria-selected', String(actF.tab === b.dataset.acttab)); });
    $('[data-usable]', el).hidden = actF.tab !== 'skill';
    const items = groups[actF.tab].filter(pass);
    if (!items.length) {
      list.innerHTML = `<p class="muted small act-empty">${actF.tab === 'fav' && !groups.fav.length ? 'No favorites yet. Tap ☆ in the corner of an action to keep it here.' : actF.tab === 'special' && !groups.special.length ? 'No special actions yet — they come from your class, feats, archetypes and ancestry.' : 'Nothing matches these filters.'}</p>`;
      return;
    }
    const heads = [];
    const byHead = {};
    for (const x of items) { if (!byHead[x.head]) { byHead[x.head] = []; heads.push(x); } byHead[x.head].push(x); }
    if (actF.tab === 'special') heads.sort((a, b) => ORIGIN_ORDER.indexOf(a.head) - ORIGIN_ORDER.indexOf(b.head));
    const BASIC_HEADS = ['Basic actions', 'Specialty basic actions', 'Exploration activities', 'Downtime activities'];
    if (actF.tab === 'basic') heads.sort((a, b) => BASIC_HEADS.indexOf(a.head) - BASIC_HEADS.indexOf(b.head));
    const order = { reaction: 3, free: 2, action: 1 };
    list.innerHTML = heads.map((h) => {
      const rows = byHead[h.head].slice();
      if (actF.tab !== 'skill') rows.sort((a, b) => (order[a.rec.action] || 0) - (order[b.rec.action] || 0) || a.rec.name.localeCompare(b.rec.name));
      else rows.sort((a, b) => Number(a.cant) - Number(b.cant) || a.rec.name.localeCompare(b.rec.name));
      const sub = actF.tab === 'skill' ? `<span class="act-head-roll">${rankBadge(h.headRank)}<b class="mono">${signed(h.headTotal)}</b></span>` : '';
      return `<div class="act-group"><h4 class="act-head"><span>${esc(h.head)}</span>${sub}</h4>${rows.map(row).join('')}</div>`;
    }).join('');
    // Special actions: how many limited uses are spent, and resets for the short ones.
    const lim = actF.tab === 'special' ? limitedList(ch, state) : [];
    if (lim.length) {
      const spent = lim.reduce((a, x) => a + x.used, 0), total = lim.reduce((a, x) => a + x.max, 0);
      list.insertAdjacentHTML('afterbegin', `<div class="uses-bar"><span><b>Limited uses</b> <span class="muted">${spent} of ${total} spent · daily ones come back when you Rest</span></span>
        ${readOnly ? '' : RESET_TIERS.filter((r) => lim.some((x) => x.tier <= r.tier && x.used)).map((r) => `<button type="button" class="chipbtn" data-ureset="${r.tier}">↺ ${esc(r.label)}</button>`).join('')}</div>`);
    }
    $$('[data-uses]', list).forEach((u) => (u.onclick = (e) => {
      e.stopPropagation();
      if (readOnly) return;
      const slug = u.dataset.uses, max = Number(u.dataset.max);
      state.freqUsed[slug] = ((state.freqUsed[slug] || 0) + 1) % (max + 1);
      if (!state.freqUsed[slug]) delete state.freqUsed[slug];
      saveState(); draw();
    }));
    $$('[data-ureset]', list).forEach((b) => (b.onclick = () => {
      const t = Number(b.dataset.ureset);
      for (const x of limitedList(ch, state)) if (x.tier <= t) delete state.freqUsed[x.slug];
      saveState(); draw();
    }));
    $$('[data-afav]', list).forEach((b) => (b.onclick = (e) => {
      e.stopPropagation();
      if (readOnly) return;
      const r = b.dataset.afav;
      state.favActions = state.favActions.includes(r) ? state.favActions.filter((x) => x !== r) : [...state.favActions, r];
      saveState(); draw();
    }));
    $$('[data-row-show]', list).forEach((r) => {
      const open = () => showRef(db, r.dataset.rowShow, { extras: actionExtras });
      r.onclick = open;
      r.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
    });
  };
  $$('[data-acttab]', el).forEach((b) => (b.onclick = () => { actF.tab = b.dataset.acttab; saveActF(); draw(); }));
  $$('[data-cost]', el).forEach((b) => (b.onclick = () => { actF.cost = actF.cost === b.dataset.cost ? '' : b.dataset.cost; saveActF(); $$('[data-cost]', el).forEach((x) => { x.classList.toggle('on', x.dataset.cost === actF.cost); x.setAttribute('aria-pressed', String(x.dataset.cost === actF.cost)); }); draw(); }));
  $$('[data-mode]', el).forEach((b) => (b.onclick = () => { actF.mode = actF.mode === b.dataset.mode ? '' : b.dataset.mode; saveActF(); $$('[data-mode]', el).forEach((x) => { x.classList.toggle('on', x.dataset.mode === actF.mode); x.setAttribute('aria-pressed', String(x.dataset.mode === actF.mode)); }); draw(); }));
  $('[data-usable]', el).onclick = (e) => { actF.usable = !actF.usable; saveActF(); e.currentTarget.classList.toggle('on', actF.usable); e.currentTarget.setAttribute('aria-pressed', String(actF.usable)); draw(); };
  const inp = $('.act-search input', el);
  inp.oninput = () => { actF.q = inp.value; draw(); };
  draw();
};

TAB_RENDER.feats = (el) => {
  const group = (f) => (!f.slot ? 'Other feats' : { ancestry: 'Ancestry feats', class: 'Class feats', archetype: 'Archetype feats', skill: 'Skill feats', general: 'General feats' }[f.slot.type]);
  const groups = {};
  for (const f of ch.feats) (groups[group(f)] = groups[group(f)] || []).push(f);
  const order = ['Ancestry feats', 'Class feats', 'Archetype feats', 'Skill feats', 'General feats', 'Other feats'];
  const selText = (key) => {
    const inst = ch.items.find((i) => i.key === key);
    const vals = inst ? Object.values(inst.selLabel || {}) : [];
    return vals.length ? `<div class="sub">${esc(vals.join(', '))}</div>` : '';
  };
  const feats = order.filter((g) => groups[g]).map((g) => `<h3 class="sub-head">${g}</h3>${groups[g].sort((a, b) => (a.slot?.level || 0) - (b.slot?.level || 0)).map((f) => `<div class="entry"><span class="lvl">${f.slot ? f.slot.level : ''}</span><div class="grow"><span class="name" data-show="${esc(refOf(f.rec))}">${esc(f.rec.name)}</span> <span class="muted small">${actionGlyph(f.rec)}</span>${f.source ? `<div class="sub">from ${esc(f.source)}</div>` : ''}${selText(f.key)}</div></div>`).join('')}`).join('');
  const feats2 = ch.items.filter((i) => ['classfeatures', 'ancestryfeatures', 'heritages', 'ancestries', 'backgrounds', 'deities'].includes(i.pack));
  el.innerHTML = `<div class="grid2"><div>${feats || '<p class="muted">No feats yet.</p>'}</div>
    <div><h3 class="sub-head">Ancestry, background &amp; class features</h3>${feats2.map((i) => `<div class="entry"><span class="lvl">${i.rec.level || ''}</span><div class="grow"><span class="name" data-show="${esc(i.ref)}">${esc(i.rec.name)}</span> <span class="muted tiny">${esc({ classfeatures: 'Class feature', ancestryfeatures: 'Ancestry feature', heritages: 'Heritage', ancestries: 'Ancestry', backgrounds: 'Background', deities: 'Deity' }[i.pack])}</span>${selText(i.key)}</div></div>`).join('')}</div></div>`;
};

// ------------------------------------------------------------------ spells
function spellRow(s, { extra = '', cast = false, actions = '' } = {}) {
  const r = s.rec;
  const sub = [r?.range && 'Range ' + r.range, r?.area, r?.target && 'Targets ' + r.target, r?.save ? titleCase(r.save) : r?.vs ? 'vs ' + titleCase(r.vs) : '', r?.duration].filter(Boolean);
  return `<div class="spell-line ${cast ? 'cast' : ''}"><span class="glyph">${actionGlyph(r)}</span><span class="name" data-show="${esc(s.ref)}">${esc(r?.name || s.ref)}</span>${extra}<span class="grow"></span>${actions}
    ${sub.length ? `<div class="sub">${esc(sub.join(' · '))}</div>` : ''}</div>`;
}
// Staves: spells cast by spending charges. Preparing one at daily preparations gives it charges equal to the
// highest rank of spell you can cast (one staff a day); a spell costs charges equal to its rank, cantrips are free.
// state.staff = { id (inventory item), left, max }.
function staffMaxCharges() {
  const sc = ch.spellcasting;
  const slotRanks = sc.entries.map((e) => e.maxRank || 0);
  return Math.max(0, ...(slotRanks.length ? slotRanks : sc.innate.map((s) => s.rank || 0)));
}
const carriedStaves = () => ch.inventory.filter((it) => it.rec.staffSpells);
const wieldedStaves = () => carriedStaves().filter((it) => it.equipped && invKind(it.rec).slot === 'hands');
function prepareStaff(it) { const n = staffMaxCharges(); state.staff = it && n ? { id: it.id, left: n, max: n } : null; }
function staffHtml(it) {
  const sc = ch.spellcasting;
  const n0 = staffMaxCharges();
  const prepared = !!(state.staff && state.staff.id === it.id);
  const left = prepared ? Math.max(0, Number(state.staff.left) || 0) : 0;
  const max = prepared ? Math.max(left, Number(state.staff.max) || 0) : 0;
  const trads = new Set(sc.entries.map((e) => e.trad).filter(Boolean));
  const onList = (rec) => !trads.size || (rec.trad || []).some((t) => trads.has(t));
  const spont = sc.entries.find((e) => e.type === 'spontaneous' && Object.keys(e.slots || {}).length);
  let h = `<section class="card staff-card" style="background:transparent"><div class="sc-head"><h3><span class="name" data-show="${esc(refOf(it.rec))}">${esc(it.rec.name)}</span></h3><div class="sc-stats"><span class="sc-stat">Staff</span>${prepared ? `<span class="sc-stat">Charges<b>${left}/${max}</b></span>` : ''}</div></div>`;
  if (!prepared) {
    h += `<p class="notice small">${n0 ? `Not prepared today. One staff a day gets charges equal to the highest rank of spell you can cast: <b>${n0}</b>.` : 'You need to be able to cast spells to prepare a staff.'}
      ${n0 && !readOnly ? `<br><button type="button" class="btn small primary" data-staffprep="${esc(it.id)}" style="margin-top:6px">Prepare (${n0} charge${n0 === 1 ? '' : 's'})</button>` : ''}</p>`;
  } else {
    h += `<div class="rank-block"><div class="rank-head"><span class="rk">Charges</span><span class="slot-pips" aria-label="${left} of ${max} charges left">${Array.from({ length: max }, (_, i) => `<button type="button" class="${i < max - left ? 'used' : ''}" data-staffpip="${i}" aria-label="Charge ${i + 1}" ${readOnly ? 'disabled' : ''}></button>`).join('')}</span><span class="small muted">${left}/${max}</span>
      ${readOnly ? '' : `<button type="button" class="btn small" data-staffadd title="${sc.entries.some((e) => e.type === 'prepared') ? 'Prepared casters: expend a spell slot when you prepare the staff to add charges equal to its rank' : 'Add a charge'}">+1</button>`}</div></div>`;
  }
  for (const [rank, refs] of it.rec.staffSpells) {
    const list = refs.map((r) => ({ ref: r, rec: db.get(r) })).filter((x) => x.rec);
    if (!list.length) continue;
    const slotsLeft = spont && rank ? (spont.slots[rank] || 0) - ((state.used[spont.id] || {})[rank] || 0) : 0;
    h += `<div class="rank-block"><div class="rank-head"><span class="rk">${rank ? ordinal(rank) : 'Cantrips'}</span><span class="small muted">${rank ? `${rank} charge${rank > 1 ? 's' : ''}` : `free · heightened to ${sc.cantripRank}`}</span></div>`;
    h += list.map((x) => spellRow(x, {
      extra: onList(x.rec) ? '' : ' <span class="badge" title="You can cast a spell from a staff only if it’s on your spell list">not on your list</span>',
      actions: !rank || readOnly ? '' : `<button type="button" class="btn small" data-staffcast="${rank}" ${prepared && left >= rank ? '' : 'disabled'}>Cast</button>`
        + (spont && spont.slots[rank] ? ` <button type="button" class="btn small" data-staffslot="${rank}" title="Spend 1 charge and one of your ${ordinal(rank)}-rank spell slots" ${prepared && left >= 1 && slotsLeft > 0 ? '' : 'disabled'}>1 + slot</button>` : ''),
    })).join('');
    h += `</div>`;
  }
  if (spont) h += `<p class="small muted">${esc(spont.label)}: you can also cast a staff spell by spending 1 charge and one of your spell slots of the spell’s rank (<b>1 + slot</b>).</p>`;
  return h + `</section>`;
}
let spellTab = (() => { try { return sessionStorage.getItem('pf2e.spellTab') || ''; } catch (e) { return ''; } })();
TAB_RENDER.spells = (el) => {
  const sc = ch.spellcasting;
  // One sub-tab per source of spells (class, each archetype, focus, innate, each staff in hand), like the action tabs.
  const entryHtml = (e) => {
    let html = '';
      const used = state.used[e.id] || {};
      html += `<section class="card" style="background:transparent"><div class="sc-head"><h3>${esc(e.label)}</h3><div class="sc-stats"><span class="sc-stat">${esc(titleCase(e.trad || '—'))} ${esc(e.type)}</span><span class="sc-stat">Attack<b>${signed(e.attack)}</b></span><span class="sc-stat">DC<b>${e.dc}</b></span>${e.psiCantrips?.length ? `<span class="sc-stat">Focus points<b>${state.focus}/${sc.focus.max || ch.focusMax}</b></span>` : ''}</div></div>`;
      if (e.note) html += `<p class="small muted">${esc(e.note)}</p>`;
      if (e.psiCantrips && state.unleashed) html += `<p class="notice small"><b>Psyche unleashed.</b> Damaging spells you cast with your psychic spellcasting get a status bonus to their initial damage of double the spell’s rank (your cantrips: <b>+${2 * sc.cantripRank}</b>). Each creature takes it only once per spell.</p>`;
      if (e.type === 'prepared') {
        const prep = state.prep[e.id] || {};
        const rows = slotRows(e);
        const byRank = {};
        for (const r of rows) (byRank[r.rank] = byRank[r.rank] || []).push(r);
        for (const [rank, list] of Object.entries(byRank)) {
          html += `<div class="rank-block"><div class="rank-head"><span class="rk">${rank === '0' ? 'Cantrips' : ordinal(rank)}</span>${rank === '0' ? `<span class="small muted">heightened to ${sc.cantripRank}</span>` : `<span class="small muted">${list.filter((x) => prep[x.id]?.cast).length} of ${list.length} cast</span>`}</div>`;
          for (const row of list) {
            const p = prep[row.id];
            const rec = p?.ref ? db.get(p.ref) : null;
            const kind = row.kind !== 'normal' ? `<span class="slot-kind">${esc(row.label)}</span>` : '';
            if (rec) {
              html += spellRow({ ref: p.ref, rec }, {
                cast: rank !== '0' && p.cast, extra: kind + (rec.rank < Number(rank) && !isCantrip(rec) ? ` <span class="badge">heightened ${ordinal(rank)}</span>` : ''),
                actions: readOnly ? '' : `${rank !== '0' ? `<button type="button" class="btn small ${p.cast ? '' : 'primary'}" data-cast='${esc(JSON.stringify({ e: e.id, s: row.id }))}'>${p.cast ? 'Undo' : 'Cast'}</button>` : ''}<button type="button" class="icon-btn" data-prep='${esc(JSON.stringify({ e: e.id, s: row.id, rank: row.rank, kind: row.kind }))}' aria-label="Change prepared spell">✎</button>`,
              });
            } else {
              html += `<div class="prep-slot">${kind}<span class="empty">Empty slot</span><span class="grow"></span>${readOnly ? '' : `<button type="button" class="btn small" data-prep='${esc(JSON.stringify({ e: e.id, s: row.id, rank: row.rank, kind: row.kind }))}'>Prepare</button>`}</div>`;
            }
          }
          html += `</div>`;
        }
        if (e.granted?.length) html += `<div class="rank-block"><div class="rank-head"><span class="rk">Granted</span></div>${e.granted.map((g) => spellRow(g, { extra: ` <span class="badge">${g.rank ? ordinal(g.rank) : 'cantrip'} · ${esc(g.source)}</span>` })).join('')}</div>`;
      } else {
        const ranks = new Set([0, ...Object.keys(e.slots).map(Number), ...Object.keys(e.repertoire || {}).map(Number)]);
        if (e.psiCantrips?.length) html += `<div class="rank-block"><div class="rank-head"><span class="rk">Psi</span><span class="small muted">spend 1 Focus Point to amp · tap a cantrip to read its amp</span></div>${e.psiCantrips.map((p) => spellRow(p, { extra: p.unique ? ' <span class="badge accent">unique</span>' : p.parallel ? ' <span class="badge">parallel</span>' : '' })).join('')}</div>`;
        for (const rank of [...ranks].sort((a, b) => a - b)) {
          const n = e.slots[rank] || 0;
          const list = (e.repertoire || {})[rank] || [];
          if (!n && !list.length && rank !== 0) continue;
          const u = used[rank] || 0;
          html += `<div class="rank-block"><div class="rank-head"><span class="rk">${rank === 0 ? 'Cantrips' : ordinal(rank)}</span>
            ${rank === 0 ? `<span class="small muted">heightened to ${sc.cantripRank}</span>` : `<span class="slot-pips" aria-label="${n - u} of ${n} slots left">${Array.from({ length: n }, (_, i) => `<button type="button" class="${i < u ? 'used' : ''}" data-slot='${esc(JSON.stringify({ e: e.id, r: rank, i }))}' aria-label="Slot ${i + 1}${i < u ? ' (used)' : ''}" ${readOnly ? 'disabled' : ''}></button>`).join('')}</span><span class="small muted">${n - u}/${n}</span>${(e.bonusSlots || []).filter((x) => x.rank === rank).map((x) => { const bu = used[x.key] || 0; return `<span class="slot-pips bonus-pips" title="${esc(x.label)}">${Array.from({ length: x.count }, (_, i) => `<button type="button" class="${i < bu ? 'used' : ''}" data-slot='${esc(JSON.stringify({ e: e.id, r: x.key, i }))}' aria-label="${esc(x.label)}${i < bu ? ' (used)' : ''}" ${readOnly ? 'disabled' : ''}></button>`).join('')}</span><span class="small muted" title="${esc(x.label)}">+1 mind</span>`; }).join('')}`}</div>
            ${list.map((s) => spellRow(s, { extra: (s.granted ? ' <span class="badge">granted</span>' : '') + ((e.signature || []).includes(s.ref) ? ' <span class="badge accent">signature</span>' : '') })).join('') || (rank > 0 ? '<p class="small muted" style="padding-left:74px;margin:2px 0">No spells of this rank in your repertoire — signature spells and heightening still use these slots.</p>' : '<p class="small muted" style="padding-left:74px;margin:2px 0">None.</p>')}</div>`;
        }
        if (e.bonusSlots?.length) html += `<p class="small muted">The pips marked “+1 mind” are Conscious Spell Specialization’s slots: use them only for spells your conscious mind grants.</p>`;
        const sigs = (e.signature || []).map((r) => db.get(r)).filter(Boolean);
        if (sigs.length) html += `<p class="small muted">Signature spells: ${sigs.map((s) => esc(s.name)).join(', ')} — cast them with any slot of their rank or higher.</p>`;
      }
      html += `</section>`;
    return html;
  };
  const f = sc.focus;
  const focusHtml = () => {
    let html = '';
    if (f.spells.length || f.cantrips.length) {
      html += `<section class="card" style="background:transparent"><div class="sc-head"><h3>Focus spells</h3><div class="sc-stats"><span class="sc-stat">Focus points<b>${state.focus}/${f.max || ch.focusMax}</b></span></div></div>
        ${f.cantrips.map((s) => spellRow(s, { extra: ` <span class="badge">cantrip</span> <span class="small muted">${esc(s.source)} · DC ${s.dc} · ${signed(s.attack)}</span>` })).join('')}
        ${f.spells.map((s) => spellRow(s, { extra: ` <span class="small muted">${esc(s.source)} · DC ${s.dc} · ${signed(s.attack)}</span>`, actions: readOnly ? '' : `<button type="button" class="btn small" data-focuscast ${state.focus > 0 ? '' : 'disabled'}>Cast (1 FP)</button>` })).join('')}</section>`;
    }
    return html;
  };
  const innateHtml = (innate, title) => {
    let html = '';
    const unpickedInnate = innate.filter((s) => s.pickFor && !s.rec);
    if (innate.some((s) => s.rec) || unpickedInnate.length) {
      html += `<section class="card" style="background:transparent"><div class="sc-head"><h3>${esc(title)}</h3></div>
        ${unpickedInnate.length ? `<p class="notice small">${esc([...new Set(unpickedInnate.map((s) => s.source))].join(', '))}: ${unpickedInnate.map((s) => ordinal(s.rank)).join(', ')}-rank spell${unpickedInnate.length > 1 ? 's' : ''} not chosen yet. ${readOnly ? '' : `<a href="builder.html?id=${encodeURIComponent(charRec.id)}">Pick ${unpickedInnate.length > 1 ? 'them' : 'it'} in the builder</a> (Spells step).`}</p>` : ''}
        ${innate.filter((s) => s.rec).map((s) => {
          const c = isCantrip(s.rec);
          const max = s.perDay || 1;
          const u = Math.min(max, innateUsedCount(state, s.ref));
          const usedToday = u >= max;
          // More than once a day (Captivating Intensity): one pip per cast, like spell slots.
          const acts = c || readOnly ? '' : max > 1
            ? `<span class="slot-pips" aria-label="${max - u} of ${max} left today">${Array.from({ length: max }, (_, i) => `<button type="button" class="${i < u ? 'used' : ''}" data-innatepip='${esc(JSON.stringify({ r: s.ref, i }))}' aria-label="Cast ${i + 1}${i < u ? ' (used)' : ''}"></button>`).join('')}</span><span class="small muted">${max - u}/${max}</span>`
            : `<button type="button" class="btn small" data-innate="${esc(s.ref)}">${usedToday ? 'Undo' : 'Cast'}</button>`;
          return spellRow(s, { cast: !c && usedToday, extra: ` <span class="badge">${c ? 'cantrip' : ordinal(s.rank) + ' · ' + max + '/day'}</span> <span class="small muted">${esc(s.source)} · DC ${s.dc}</span>`, actions: acts });
        }).join('')}</section>`;
    }
    return html;
  };
  const tabs = [];
  const entryTab = (e) => {
    const n = e.type === 'prepared'
      ? Object.values(state.prep[e.id] || {}).filter((p) => p && p.ref).length + (e.granted || []).length
      : Object.values(e.repertoire || {}).reduce((a, l) => a + l.length, 0) + (e.psiCantrips || []).length;
    const label = e.source === 'archetype' ? e.label.replace(/ archetype$/i, '') : e.label.replace(/ spells$/i, '');
    tabs.push({ id: 'e:' + e.id, label, n, arch: e.arch || null, html: () => entryHtml(e) });
  };
  // Class first, then focus spells (mostly from the class), then archetypes.
  sc.entries.filter((e) => e.source !== 'archetype').forEach(entryTab);
  if (f.spells.length || f.cantrips.length) tabs.push({ id: 'focus', label: 'Focus', n: f.spells.length + f.cantrips.length, html: focusHtml });
  sc.entries.filter((e) => e.source === 'archetype').forEach(entryTab);
  // Innate spells go with the archetype that grants them (Captivator); the rest share an Innate tab.
  const groups = new Map();
  for (const s of sc.innate) {
    const feat = s.pickFor?.feat ? db.get('@feats/' + s.pickFor.feat) : null;
    const key = feat?.arch || s.srcArch || 'innate'; // Captivator Dedication's cantrips go on the Captivator tab too
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  for (const [key, list] of groups) {
    if (!list.some((s) => s.rec || s.pickFor)) continue;
    const name = titleCase(key.replace(/-/g, ' '));
    const n = list.filter((s) => s.rec).length;
    const title = key === 'innate' ? 'Innate spells' : `${name} innate spells`;
    const host = key !== 'innate' && tabs.find((t) => t.arch === key);
    if (host) { const prev = host.html; host.html = () => prev() + innateHtml(list, title); host.n += n; }
    else tabs.push({ id: 'innate:' + key, label: key === 'innate' ? 'Innate' : name, n, html: () => innateHtml(list, title) });
  }
  const staves = wieldedStaves();
  staves.forEach((it, i) => tabs.push({ id: 'staff:' + it.id, label: 'Staff' + (staves.length > 1 ? ' ' + (i + 1) : ''), title: it.rec.name,
    n: it.rec.staffSpells.reduce((a, [, refs]) => a + refs.length, 0), html: () => staffHtml(it) }));
  if (!tabs.length) { el.innerHTML = '<p class="muted">No spells yet. Pick them in the builder.</p>'; return; }
  const cur = tabs.find((t) => t.id === spellTab) || tabs[0];
  el.innerHTML = (tabs.length > 1 ? `<div class="act-seg spell-seg" role="tablist" aria-label="Sources of spells">${tabs.map((t) => `<button type="button" role="tab" data-spelltab="${esc(t.id)}" aria-selected="${t === cur}"${t.title ? ` title="${esc(t.title)}"` : ''}>${esc(t.label)} <span class="n">${t.n}</span></button>`).join('')}</div>` : '') + cur.html();
  $$('[data-spelltab]', el).forEach((b) => (b.onclick = () => { spellTab = b.dataset.spelltab; try { sessionStorage.setItem('pf2e.spellTab', spellTab); } catch (err) { /* ignore */ } TAB_RENDER.spells(el); }));
  if (readOnly) return;
  $$('[data-slot]', el).forEach((b) => (b.onclick = () => {
    const o = JSON.parse(b.dataset.slot);
    const u = (state.used[o.e] = state.used[o.e] || {});
    const cur = u[o.r] || 0;
    u[o.r] = o.i < cur ? o.i : o.i + 1;
    change();
  }));
  $$('[data-cast]', el).forEach((b) => (b.onclick = () => {
    const o = JSON.parse(b.dataset.cast);
    const p = state.prep[o.e][o.s];
    p.cast = !p.cast;
    change();
  }));
  $$('[data-prep]', el).forEach((b) => (b.onclick = () => openPrepPicker(JSON.parse(b.dataset.prep))));
  $$('[data-focuscast]', el).forEach((b) => (b.onclick = () => { if (state.focus > 0) { state.focus--; change(); } }));
  $$('[data-innate]', el).forEach((b) => (b.onclick = () => { const r = b.dataset.innate; if (state.innateUsed[r]) delete state.innateUsed[r]; else state.innateUsed[r] = 1; change(); }));
  const st = state.staff;
  $$('[data-staffprep]', el).forEach((b) => (b.onclick = () => { prepareStaff(ch.inventory.find((it) => it.id === b.dataset.staffprep)); change(); }));
  $$('[data-staffpip]', el).forEach((b) => (b.onclick = () => {
    const i = Number(b.dataset.staffpip); const u = st.max - st.left;
    st.left = st.max - (i < u ? i : i + 1); change();
  }));
  $$('[data-staffadd]', el).forEach((b) => (b.onclick = () => { st.max++; st.left++; change(); }));
  $$('[data-staffcast]', el).forEach((b) => (b.onclick = () => { const r = Number(b.dataset.staffcast); if (st.left >= r) { st.left -= r; change(); } }));
  $$('[data-staffslot]', el).forEach((b) => (b.onclick = () => {
    const r = Number(b.dataset.staffslot);
    const e = ch.spellcasting.entries.find((x) => x.type === 'spontaneous' && Object.keys(x.slots || {}).length);
    const u = (state.used[e.id] = state.used[e.id] || {});
    if (st.left < 1 || (u[r] || 0) >= (e.slots[r] || 0)) return;
    st.left -= 1; u[r] = (u[r] || 0) + 1; change();
  }));
  $$('[data-innatepip]', el).forEach((b) => (b.onclick = () => {
    const o = JSON.parse(b.dataset.innatepip);
    const cur = innateUsedCount(state, o.r);
    const n = o.i < cur ? o.i : o.i + 1;
    if (n) state.innateUsed[o.r] = n; else delete state.innateUsed[o.r];
    change();
  }));
};

/** Daily preparation: choose the spell for one prepared slot. */
function openPrepPicker(o) {
  const e = ch.spellcasting.entries.find((x) => x.id === o.e);
  if (!e) return;
  const row = slotRows(e).find((r) => r.id === o.s);
  let only = null;
  if (row && row.only) only = row.only.filter((r) => { const s = db.get(r); return s && (o.rank === 0 ? isCantrip(s) : !isCantrip(s) && s.rank <= o.rank); });
  else if (e.book) {
    only = [];
    for (const [r, list] of Object.entries(e.book.spells)) for (const s of list) if (o.rank === 0 ? isCantrip(s.rec) : !isCantrip(s.rec) && s.rec.rank <= o.rank && Number(r) > 0) only.push(s.ref);
    for (const g of e.granted || []) if (o.rank === 0 ? g.rank === 0 : g.rank > 0 && g.rank <= o.rank) only.push(g.ref);
    if (!only.length) { toast(`Add spells to your ${e.book.label.toLowerCase()} in the builder first`, 'error'); return; }
  }
  const title = `Prepare a ${o.rank === 0 ? 'cantrip' : ordinal(o.rank) + '-rank slot'}${row?.label ? ' (' + row.label + ')' : ''}`;
  const prep = (state.prep[o.e] = state.prep[o.e] || {});
  const m = openSpellPicker(db, { title, trad: e.trad, rank: o.rank || null, cantrips: o.rank === 0, only, exactRank: false, showRare: build.options.showRare, verb: 'Prepare' }, (s) => {
    prep[o.s] = { ref: refOf(s), cast: false };
    change();
  });
  if (prep[o.s]) {
    const clear = document.createElement('div');
    clear.className = 'row end';
    clear.innerHTML = '<button type="button" class="btn small ghost">Empty this slot</button>';
    clear.querySelector('button').onclick = () => { delete prep[o.s]; m.close(); change(); };
    m.body.prepend(clear);
  }
}

// ------------------------------------------------------------------ inventory & crafting
// Where an item lives: armor slot, hands, worn, or one of the pack tabs.
const INV_ICONS = {
  armor: '<path d="M8 3l4 2 4-2 4 3-2 5v8l-6 3-6-3v-8L4 6z"/>',
  weapon: '<path d="M14.5 3H21v6.5L10 20.5 3.5 14z"/><path d="M6 15l3 3M4 20l2-2"/>',
  shield: '<path d="M12 3l7 3v5c0 4.6-3 8.3-7 10-4-1.7-7-5.4-7-10V6z"/>',
  held: '<path d="M6 21L17 4"/><circle cx="18" cy="4" r="2"/>',
  worn: '<circle cx="12" cy="14" r="6"/><path d="M9 4h6l-3 4z"/>',
  potion: '<path d="M10 3h4M10 3v5l-5 9a3 3 0 0 0 2.6 4.5h8.8A3 3 0 0 0 19 17l-5-9V3"/><path d="M7.5 15h9"/>',
  magic: '<path d="M7 4h11v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2h11"/><path d="M7 4a2 2 0 0 0-2 2v10M10 8h5M10 11h5"/>',
  bomb: '<circle cx="11" cy="14" r="6.5"/><path d="M15.5 9.5L18 7M18 7l2-2M18 7l-1-2M18 7l2 1"/>',
  ammo: '<path d="M4 20L18 6M14 4h6v6M4 16v4h4"/>',
  treasure: '<path d="M6 4h12l3 5-9 11L3 9z"/><path d="M3 9h18M9 4l3 5 3-5M12 9v11"/>',
  gear: '<path d="M7 7V5a5 5 0 0 1 10 0v2"/><rect x="4" y="7" width="16" height="14" rx="3"/><path d="M9 13h6"/>',
};
const invIcon = (k) => `<svg class="inv-ic" viewBox="0 0 24 24" aria-hidden="true">${INV_ICONS[k] || INV_ICONS.gear}</svg>`;
const POTION_CATS = ['potion', 'elixir', 'mutagen', 'poison', 'oil', 'drug'];
const MAGIC_CATS = ['scroll', 'talisman', 'wand', 'fulu', 'catalyst'];
const BOMB_CATS = ['snare', 'gadget', 'toolkit'];
const CONS_TABS = [
  { id: 'all', label: 'All' },
  { id: 'potion', label: 'Potions & elixirs' },
  { id: 'magic', label: 'Scrolls, wands & talismans' },
  { id: 'bomb', label: 'Bombs & snares' },
  { id: 'ammo', label: 'Ammo' },
  { id: 'other', label: 'Other' },
];
function invKind(rec) {
  const tr = rec.traits || [];
  if (rec.type === 'ammo') return { group: 'cons', cons: 'ammo', icon: 'ammo' };
  if (rec.type === 'weapon' && tr.includes('bomb')) return { group: 'cons', cons: 'bomb', icon: 'bomb' };
  if (rec.type === 'consumable') {
    const c = rec.cat || 'other';
    if (POTION_CATS.includes(c)) return { group: 'cons', cons: 'potion', icon: 'potion' };
    if (MAGIC_CATS.includes(c) || tr.includes('talisman') || tr.includes('catalyst') || tr.includes('scroll')) return { group: 'cons', cons: 'magic', icon: 'magic' };
    if (BOMB_CATS.includes(c) || tr.includes('bomb') || tr.includes('snare')) return { group: 'cons', cons: 'bomb', icon: 'bomb' };
    if (tr.includes('elixir') || tr.includes('potion') || tr.includes('poison') || tr.includes('oil')) return { group: 'cons', cons: 'potion', icon: 'potion' };
    return { group: 'cons', cons: 'other', icon: 'potion' };
  }
  if (rec.type === 'treasure') return { group: 'treasure', icon: 'treasure' };
  if (rec.type === 'armor') return { group: 'gear', slot: 'armor', icon: 'armor' };
  const u = rec.usage || '';
  if (rec.type === 'weapon') return { group: 'gear', slot: 'hands', hands: u === 'held-in-two-hands' ? 2 : 1, icon: 'weapon' };
  if (rec.type === 'shield') return { group: 'gear', slot: 'hands', hands: 1, icon: 'shield' };
  if (/^held-in-two/.test(u)) return { group: 'gear', slot: 'hands', hands: 2, icon: 'held' };
  if (/^held-in-one|^affixed-or-held/.test(u)) return { group: 'gear', slot: 'hands', hands: 1, icon: 'held' };
  if (/^worn|^tattooed|^implanted|^bonded/.test(u)) return { group: 'gear', slot: 'worn', icon: 'worn' };
  return { group: 'gear', icon: 'gear' };
}
// "wornnecklace" → "Necklace", "tattooed-on-the-body" → "Tattoo"
function wornLabel(u) {
  if (!u) return '';
  if (/^tattoo/.test(u)) return 'Tattoo';
  if (/^implant/.test(u)) return 'Implant';
  if (/^bonded/.test(u)) return 'Bonded';
  const m = u.match(/^worn(.*)$/);
  return m ? (m[1] ? titleCase(m[1].replace(/-/g, ' ')) : 'Worn') : '';
}
const invF = Object.assign({ tab: 'cons', cons: 'all' }, (() => { try { return JSON.parse(sessionStorage.getItem('pf2e.invTab') || '{}'); } catch (e) { return {}; } })());
const saveInvF = () => { try { sessionStorage.setItem('pf2e.invTab', JSON.stringify(invF)); } catch (e) { /* ignore */ } };

// Fundamental runes, property runes (only the ones that fit the potency) and special material, as small badges.
function runeBadges(it) {
  const b = (t, cls = '') => `<span class="badge ${cls}">${esc(t)}</span>`;
  return [it.potency ? b('+' + it.potency) : '', it.striking ? b(['', 'striking', 'greater striking', 'major striking'][it.striking]) : '',
    it.resilient ? b(['', 'resilient', 'greater resilient', 'major resilient'][it.resilient]) : '',
    ...itemRunes(db, it).filter((r) => r.fits).map((r) => b(r.name, 'rune-badge')),
    it.material && it.material.type ? b(materialLabel(db, it.material), 'mat-badge') : ''].filter(Boolean).join(' ');
}
function wireRunesShop(el) {
  $$('[data-runes]', el).forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const it = build.inventory.find((x) => x.id === b.dataset.runes); if (!it) return;
    openRuneManager({ db, it, level: ch.level, readOnly, giant: ch.ownedSlugs.has('giant-instinct'), onChange: () => { saveBuild(); change(); } });
  }));
  $$('[data-shop]', el).forEach((b) => (b.onclick = openShop));
}
// The shop, in a panel over the sheet: search, filter by kind, read an item, then buy it (or add it without paying).
const SHOP_KINDS = [['weapon', 'Weapons', (r) => r.type === 'weapon' && !(r.traits || []).includes('consumable')], ['armor', 'Armor & shields', (r) => r.type === 'armor' || r.type === 'shield'],
  ['consumable', 'Consumables', (r) => r.type === 'consumable' || (r.traits || []).includes('consumable') || r.type === 'ammo'], ['worn', 'Worn & held items', (r) => r.type === 'equipment' && /worn|held/.test(r.usage || '')],
  ['gear', 'Other gear', (r) => ['equipment', 'backpack', 'kit', 'book'].includes(r.type) && !/worn|held/.test(r.usage || '')]];
function openShop() {
  let free = false;
  const items = db.list('equipment').filter((r) => r.type !== 'treasure' && r.price != null && (build.options.showRare !== false || r.rarity === 'common'))
    .map((r) => ({ key: refOf(r), name: r.name, level: r.level, rarity: r.rarity, rec: r, disabled: r.level > ch.level,
      meta: [formatPrice(r.price) + (r.per > 1 ? ' for ' + r.per : ''), r.bulk ? formatBulk(r.bulk) + ' bulk' : ''].filter(Boolean).join(' · ') }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const sub = () => `Money <b>${build.money ? esc(formatPrice(build.money)) : "0 gp"}</b> · <label class="check small" style="display:inline-flex"><input type="checkbox" data-free ${free ? 'checked' : ''}> Add without paying</label>`;
  const refreshSub = () => { const d = [...document.querySelectorAll('.drawer')].pop(); const s = d && d.querySelector('.dr-sub'); if (s) { s.innerHTML = sub(); const f = s.querySelector('[data-free]'); if (f) f.onchange = () => { free = f.checked; }; } };
  openDrawer({
    title: 'Shop', subtitle: sub(), items, db, hideDisabled: true, allowDisabled: true, placeholder: 'Search items…',
    chips: [{ id: 'all', label: 'All' }, ...SHOP_KINDS.map(([id, label, t]) => ({ id, label, test: (x) => t(x.rec) }))],
    detail: (x) => `<h3>${esc(x.name)}</h3><p class="muted small">Level ${x.level} · ${esc(titleCase(x.rec.type))} · ${esc(formatPrice(x.rec.price))}${x.rec.per > 1 ? ' for ' + x.rec.per : ''} · ${x.rec.bulk ? esc(formatBulk(x.rec.bulk)) + ' bulk' : 'negligible bulk'}</p>${traitChips(x.rec.traits, x.rec.rarity)}`,
    textRef: (x) => x.key, canPick: () => true,
    pickLabel: (x) => (free ? 'Add ' : 'Buy for ' + formatPrice(x.rec.price) + ' · ') + x.name,
    onPick: (x) => {
      const r = x.rec;
      if (!free && (build.money ?? 0) < r.price) { toast('Not enough money. Tick “Add without paying” to add it anyway.', 'error'); return false; }
      if (!free) build.money = (build.money ?? 0) - r.price;
      const stack = !['weapon', 'armor', 'shield'].includes(r.type) || (r.traits || []).includes('consumable');
      const existing = stack && build.inventory.find((y) => y.ref === x.key);
      if (existing) existing.qty = (existing.qty || 1) + (r.per > 1 ? r.per : 1);
      else build.inventory.push({ id: Math.random().toString(36).slice(2, 10), ref: x.key, qty: r.per > 1 ? r.per : 1, equipped: false, invested: false });
      saveBuild(); change(); refreshSub();
      toast(`${free ? 'Added' : 'Bought'} ${r.name}${existing ? ` (now ${existing.qty})` : ''}`, 'ok');
      return false;
    },
  });
  refreshSub();
}

TAB_RENDER.equipment = (el) => {
  const items = ch.inventory.map((it) => ({ it, k: invKind(it.rec) }));
  const armor = items.filter((x) => x.k.slot === 'armor' && x.it.equipped);
  const held = items.filter((x) => x.k.slot === 'hands' && x.it.equipped);
  const worn = items.filter((x) => x.k.slot === 'worn' && x.it.equipped);
  const cons = items.filter((x) => x.k.group === 'cons');
  const gear = items.filter((x) => x.k.group === 'gear' && !x.it.equipped);
  const treasure = items.filter((x) => x.k.group === 'treasure');
  const hands = held.reduce((a, x) => a + (x.k.hands || 1), 0);
  const invested = ch.inventory.filter((x) => x.invested).length;
  const runes = runeBadges;
  const runeBtn = (it) => (runeKind(it.rec) ? `<button type="button" class="btn small" data-runes="${esc(it.id)}">Runes</button>` : '');
  const qty = (it) => (it.qty > 1 ? ` <span class="inv-qty">×${it.qty}</span>` : '');
  const row = ({ it, k }, sub, actions) => `<div class="inv-item" data-row-show="${esc(it.ref)}">${invIcon(k.icon)}
    <div class="inv-main"><div class="inv-name">${esc(it.rec.name)}${qty(it)} ${runes(it)}</div><div class="inv-sub">${sub}</div></div>
    <div class="inv-acts no-print">${actions}</div></div>`;
  const bulk = (r) => (r.bulk ? formatBulk(r.bulk) + ' bulk' : 'negligible');
  const btn = (attr, id, label, cls = '') => `<button type="button" class="btn small ${cls}" ${attr}="${esc(id)}">${label}</button>`;
  const investBtn = (it) => ((it.rec.traits || []).includes('invested') ? `<button type="button" class="inv-toggle ${it.invested ? 'on' : ''}" data-invest="${esc(it.id)}" aria-pressed="${!!it.invested}">${it.invested ? 'Invested' : 'Invest'}</button>` : '');
  const consSub = ({ it, k }) => [it.rec.level ? 'Level ' + it.rec.level : '', it.rec.cat && it.rec.cat !== 'other' ? titleCase(it.rec.cat) : '', bulk(it.rec)].filter(Boolean).join(' · ');
  const consShown = cons.filter((x) => invF.cons === 'all' || x.k.cons === invF.cons);
  const consCount = (id) => (id === 'all' ? cons.length : cons.filter((x) => x.k.cons === id).length);

  const armorSlot = armor.length
    ? armor.map((x) => row(x, `AC +${x.it.rec.ac || 0}${x.it.potency ? ` (+${x.it.potency} rune)` : ''} · Dex cap ${x.it.rec.dexCap ?? '—'}${x.it.rec.checkPen ? ` · check ${x.it.rec.checkPen}` : ''}${x.it.rec.speedPen ? ` · speed ${x.it.rec.speedPen} ft` : ''}`, runeBtn(x.it) + (readOnly ? '' : btn('data-stow', x.it.id, 'Take off')))).join('')
    : `<div class="inv-empty">${invIcon('armor')}<span>No armor. ${gear.some((x) => x.k.slot === 'armor') ? 'Wear one from your gear.' : 'Unarmored.'}</span></div>`;
  const heldRows = held.length
    ? held.map((x) => row(x, [x.k.hands === 2 ? '2 hands' : '1 hand', x.it.rec.type === 'weapon' && x.it.rec.damage ? esc(x.it.rec.damage.dice + x.it.rec.damage.die + ' ' + (x.it.rec.damage.type || '')) : x.it.rec.type === 'shield' ? `+${x.it.rec.shieldAc || 2} AC raised · Hardness ${x.it.rec.hardness}` : '', bulk(x.it.rec)].filter(Boolean).join(' · '), runeBtn(x.it) + (readOnly ? '' : btn('data-stow', x.it.id, 'Stow')))).join('')
    : `<div class="inv-empty">${invIcon('weapon')}<span>Empty hands. Wield a weapon, shield or staff from your gear.</span></div>`;
  const wornRows = worn.length
    ? worn.map((x) => row(x, [wornLabel(x.it.rec.usage), bulk(x.it.rec)].filter(Boolean).join(' · '), investBtn(x.it) + btn('data-stow', x.it.id, 'Remove'))).join('')
    : `<div class="inv-empty">${invIcon('worn')}<span>Nothing worn. Rings, cloaks, boots, tattoos… go here.</span></div>`;

  let pack = '';
  if (invF.tab === 'cons') {
    pack = `<div class="inv-chips" role="group" aria-label="Kind of consumable">${CONS_TABS.filter((t) => t.id === 'all' || consCount(t.id)).map((t) => `<button type="button" class="chip-btn ${invF.cons === t.id ? 'on' : ''}" data-cons="${t.id}">${t.label} <span class="n">${consCount(t.id)}</span></button>`).join('')}</div>
      ${consShown.map((x) => row(x, consSub(x), readOnly ? '' : btn('data-use', x.it.id, x.k.cons === 'ammo' ? 'Shoot' : 'Use', 'primary'))).join('') || '<p class="muted small">No consumables here.</p>'}`;
  } else if (invF.tab === 'gear') {
    pack = gear.map((x) => {
      const act = x.k.slot === 'armor' ? btn('data-equip', x.it.id, 'Wear') : x.k.slot === 'hands' ? btn('data-equip', x.it.id, 'Wield') : x.k.slot === 'worn' ? btn('data-equip', x.it.id, 'Wear') : '';
      const sub = [x.k.slot === 'hands' ? (x.k.hands === 2 ? '2 hands' : '1 hand') : x.k.slot === 'worn' ? wornLabel(x.it.rec.usage) : x.k.slot === 'armor' ? 'Armor' : titleCase(x.it.rec.type === 'equipment' ? 'gear' : x.it.rec.type), bulk(x.it.rec)].filter(Boolean).join(' · ');
      return row(x, sub, runeBtn(x.it) + act);
    }).join('') || '<p class="muted small">Everything you own is equipped.</p>';
  } else {
    const cp = build.money || 0;
    const coins = [['gp', Math.floor(cp / 100)], ['sp', Math.floor((cp % 100) / 10)], ['cp', cp % 10]];
    pack = `<div class="inv-coins">${coins.map(([c, n]) => `<div class="coin coin-${c}"><span class="coin-n">${n}</span><span class="coin-l">${c}</span></div>`).join('')}</div>
      <div class="muted small" style="margin:6px 0 10px">Total ${esc(formatPrice(cp))}</div>
      ${treasure.map((x) => row(x, [titleCase(x.it.rec.cat || 'treasure'), formatPrice(x.it.rec.price * (x.it.qty || 1))].join(' · '), '')).join('') || '<p class="muted small">No gems or art objects.</p>'}`;
  }

  el.innerHTML = `
    <div class="inv-top">
      <div class="inv-stat"><span class="label">Bulk</span><b>${ch.bulk.total}</b><span class="muted">/ ${ch.bulk.encumbered}</span>
        <div class="inv-bar ${ch.bulk.total > ch.bulk.encumbered ? 'over' : ''}"><div style="width:${Math.min(100, (ch.bulk.total / Math.max(1, ch.bulk.encumbered + 5)) * 100)}%"></div><i style="left:${(ch.bulk.encumbered / (ch.bulk.encumbered + 5)) * 100}%"></i></div></div>
      <div class="inv-stat"><span class="label">Hands</span><b class="${hands > 2 ? 'bad' : ''}">${hands}</b><span class="muted">/ 2</span></div>
      <div class="inv-stat"><span class="label">Invested</span><b class="${invested > 10 ? 'bad' : ''}">${invested}</b><span class="muted">/ 10</span></div>
      <div class="inv-stat"><span class="label">Money</span><b>${esc(formatPrice(build.money))}</b></div>
      ${readOnly ? '' : '<button type="button" class="btn small no-print" data-shop>Shop &amp; add items</button>'}
    </div>
    ${ch.bulk.total > ch.bulk.encumbered ? (state.conditions.some((c) => c.slug === 'encumbered')
      ? '<div class="notice warn-note">Over your Bulk limit: Encumbered is applied (clumsy 1, −10 ft Speed).</div>'
      : `<div class="notice warn-note row between"><span>Over your Bulk limit (${ch.bulk.encumbered}): you're Encumbered.</span>${readOnly ? '' : '<button type="button" class="btn small no-print" id="addEncumbered">Apply Encumbered</button>'}</div>`) : ''}
    <div class="inv-grid">
      <section class="inv-eq" aria-label="Equipped">
        <h3 class="inv-h">Armor</h3>${armorSlot}
        <h3 class="inv-h">Wielded <span class="inv-hands" aria-label="${hands} of 2 hands used">${[1, 2].map((i) => `<i class="${hands >= i ? 'on' : ''} ${hands > 2 ? 'over' : ''}"></i>`).join('')}</span></h3>${heldRows}
        ${hands > 2 ? '<p class="bad small">You only have two hands: stow something.</p>' : ''}
        <h3 class="inv-h">Worn</h3>${wornRows}
      </section>
      <section class="inv-pack" aria-label="Pack">
        <div class="inv-tabs" role="tablist">
          ${[['cons', 'Consumables', cons.length], ['gear', 'Gear', gear.length], ['treasure', 'Treasure', treasure.length]].map(([id, l, n]) => `<button type="button" role="tab" data-invtab="${id}" aria-selected="${invF.tab === id}">${l} <span class="n">${n}</span></button>`).join('')}
        </div>
        <div class="inv-pack-body">${pack}</div>
      </section>
    </div>`;

  const find = (id) => build.inventory.find((x) => x.id === id);
  const commit = () => { saveBuild(); change(); };
  wireRunesShop(el);
  $$('[data-invtab]', el).forEach((b) => (b.onclick = () => { invF.tab = b.dataset.invtab; saveInvF(); TAB_RENDER.equipment(el); wireInv(el); }));
  $$('[data-cons]', el).forEach((b) => (b.onclick = () => { invF.cons = b.dataset.cons; saveInvF(); TAB_RENDER.equipment(el); wireInv(el); }));
  if (readOnly) return;
  $$('[data-equip]', el).forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const it = find(b.dataset.equip); if (!it) return;
    const rec = db.get(it.ref), k = invKind(rec);
    if (k.slot === 'armor') for (const x of build.inventory) if (x !== it && db.get(x.ref)?.type === 'armor') x.equipped = false;
    if (rec.type === 'shield') for (const x of build.inventory) if (x !== it && db.get(x.ref)?.type === 'shield') x.equipped = false;
    it.equipped = true;
    // Worn magic items are invested when you put them on (up to 10).
    if (k.slot === 'worn' && (rec.traits || []).includes('invested') && build.inventory.filter((x) => x.invested).length < 10) it.invested = true;
    if (k.slot === 'hands' && held.reduce((a, x) => a + (x.k.hands || 1), 0) + (k.hands || 1) > 2) toast('Your hands are full: stow something to free them.');
    commit();
  }));
  const enc = $('#addEncumbered', el);
  if (enc) enc.onclick = () => { state.conditions.push({ slug: 'encumbered', value: 1 }); change(); toast('Added Encumbered'); };
  $$('[data-stow]', el).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); const it = find(b.dataset.stow); if (!it) return; it.equipped = false; it.invested = false; commit(); }));
  $$('[data-invest]', el).forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const it = find(b.dataset.invest); if (!it) return;
    if (!it.invested && build.inventory.filter((x) => x.invested).length >= 10) { toast('You can invest at most 10 items.'); return; }
    it.invested = !it.invested; commit();
  }));
  $$('[data-use]', el).forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const it = find(b.dataset.use); if (!it) return;
    it.qty = (it.qty || 1) - 1;
    toast(`${db.get(it.ref)?.name || 'Item'}: ${it.qty > 0 ? it.qty + ' left' : 'used up'}`);
    if (it.qty <= 0) build.inventory = build.inventory.filter((x) => x !== it);
    commit();
  }));
};
// ------------------------------------------------------------------ inventory: everything the character owns, in one list
const LIST_KINDS = [
  { id: 'all', label: 'All' },
  { id: 'weapons', label: 'Weapons & shields' },
  { id: 'armor', label: 'Armor' },
  { id: 'worn', label: 'Worn items' },
  { id: 'cons', label: 'Consumables' },
  { id: 'gear', label: 'Gear' },
  { id: 'treasure', label: 'Treasure' },
];
const invL = Object.assign({ q: '', kind: 'all', sort: 'name' }, (() => { try { return JSON.parse(sessionStorage.getItem('pf2e.invList') || '{}'); } catch (e) { return {}; } })());
const saveInvL = () => { try { sessionStorage.setItem('pf2e.invList', JSON.stringify({ ...invL, q: '' })); } catch (e) { /* ignore */ } };
function listKind(rec, k) {
  if (k.group === 'cons') return 'cons';
  if (k.group === 'treasure') return 'treasure';
  if (k.slot === 'armor') return 'armor';
  if (rec.type === 'weapon' || rec.type === 'shield') return 'weapons';
  if (k.slot === 'worn') return 'worn';
  return 'gear';
}
TAB_RENDER.inventory = (el) => {
  const per = (r) => (r.per > 1 ? r.per : 1);
  const rows = ch.inventory.map((it) => {
    const k = invKind(it.rec);
    const where = it.equipped ? (k.slot === 'armor' ? 'Armor' : k.slot === 'hands' ? 'Wielded' : it.invested ? 'Invested' : 'Worn') : 'Pack';
    return { it, k, kind: listKind(it.rec, k), where, bulk: (Number(it.rec.bulk) || 0) * (it.qty || 1) / per(it.rec), value: (it.rec.price || 0) * (it.qty || 1) / per(it.rec) };
  });
  const count = (id) => (id === 'all' ? rows.length : rows.filter((r) => r.kind === id).length);
  const draw = () => {
    const q = invL.q.trim().toLowerCase();
    let shown = rows.filter((r) => (invL.kind === 'all' || r.kind === invL.kind) && (!q || r.it.rec.name.toLowerCase().includes(q)));
    const by = { name: (a, b) => a.it.rec.name.localeCompare(b.it.rec.name), bulk: (a, b) => b.bulk - a.bulk, value: (a, b) => b.value - a.value, where: (a, b) => a.where.localeCompare(b.where) || a.it.rec.name.localeCompare(b.it.rec.name) }[invL.sort];
    shown = shown.slice().sort(by);
    const tb = shown.reduce((a, r) => a + r.bulk, 0), tv = shown.reduce((a, r) => a + r.value, 0);
    $('.il-body', el).innerHTML = shown.map((r) => `<div class="il-row" data-row-show="${esc(r.it.ref)}">
        <div class="il-name">${invIcon(r.k.icon)}<span><b>${esc(r.it.rec.name)}</b> ${runeBadges(r.it)}${runeKind(r.it.rec) ? ` <button type="button" class="linkish small no-print" data-runes="${esc(r.it.id)}">Runes</button>` : ''}<span class="il-lvl">${r.it.rec.level ? 'Level ' + r.it.rec.level : ''}</span></span></div>
        <div class="il-qty">${readOnly ? `<span class="mono">${r.it.qty || 1}</span>` : `<button type="button" class="step" data-qdown="${esc(r.it.id)}" aria-label="One less ${esc(r.it.rec.name)}">${(r.it.qty || 1) > 1 ? '−' : '×'}</button><span class="mono">${r.it.qty || 1}</span><button type="button" class="step" data-qup="${esc(r.it.id)}" aria-label="One more ${esc(r.it.rec.name)}">+</button>`}</div>
        <div class="il-where"><span class="where-tag w-${r.where.toLowerCase()}">${r.where}</span></div>
        <div class="il-num">${r.bulk ? esc(formatBulk(Math.round(r.bulk * 10) / 10)) : '—'}</div>
        <div class="il-num">${r.value ? esc(formatPrice(r.value)) : '—'}</div>
      </div>`).join('') || '<p class="muted small" style="padding:10px">Nothing here.</p>';
    $('.il-foot', el).innerHTML = `<span>${shown.length} item${shown.length === 1 ? '' : 's'}</span><span>Bulk <b>${esc(formatBulk(Math.round(tb * 10) / 10))}</b></span><span>Value <b>${esc(formatPrice(tv))}</b></span><span>Money <b>${esc(formatPrice(build.money))}</b></span>`;
    wireInv(el);
    wireRunesShop(el);
    const find = (id) => build.inventory.find((x) => x.id === id);
    $$('[data-qup]', el).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); const it = find(b.dataset.qup); if (!it) return; it.qty = (it.qty || 1) + 1; saveBuild(); change(); }));
    $$('[data-qdown]', el).forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation();
      const it = find(b.dataset.qdown); if (!it) return;
      if ((it.qty || 1) <= 1) {
        if (!(await confirmBox(`Remove ${db.get(it.ref)?.name || 'this item'} from the inventory?`))) return;
        build.inventory = build.inventory.filter((x) => x !== it);
      } else it.qty -= 1;
      saveBuild(); change();
    }));
  };
  el.innerHTML = `
    <div class="il-tools">
      <input type="search" class="il-q" placeholder="Search items…" aria-label="Search items" value="${esc(invL.q)}">
      <label class="il-sort"><span class="sr-only">Sort by</span><select aria-label="Sort by">
        ${[['name', 'Name'], ['where', 'Where it is'], ['bulk', 'Bulk'], ['value', 'Value']].map(([v, l]) => `<option value="${v}" ${invL.sort === v ? 'selected' : ''}>Sort: ${l}</option>`).join('')}
      </select></label>
      ${readOnly ? '' : '<button type="button" class="btn small no-print" data-shop>Shop &amp; add items</button>'}
    </div>
    <div class="inv-chips" role="group" aria-label="Kind of item">${LIST_KINDS.filter((t) => t.id === 'all' || count(t.id)).map((t) => `<button type="button" class="chip-btn ${invL.kind === t.id ? 'on' : ''}" data-lkind="${t.id}">${t.label} <span class="n">${count(t.id)}</span></button>`).join('')}</div>
    <div class="il-table">
      <div class="il-row il-head" aria-hidden="true"><div>Item</div><div class="il-qty">Qty</div><div>Where</div><div class="il-num">Bulk</div><div class="il-num">Value</div></div>
      <div class="il-body"></div>
      <div class="il-foot"></div>
    </div>`;
  const qi = $('.il-q', el);
  qi.oninput = () => { invL.q = qi.value; draw(); };
  $('.il-sort select', el).onchange = (e) => { invL.sort = e.target.value; saveInvL(); draw(); };
  $$('[data-lkind]', el).forEach((b) => (b.onclick = () => { invL.kind = b.dataset.lkind; saveInvL(); $$('[data-lkind]', el).forEach((x) => x.classList.toggle('on', x === b)); draw(); }));
  draw();
};

// Re-wires the shared bits (details on tap) after the inventory redraws itself.
function wireInv(el) {
  $$('.inv-item[data-row-show], .il-row[data-row-show]', el).forEach((r) => (r.onclick = (e) => { if (!e.target.closest('button, a')) showRef(db, r.dataset.rowShow); }));
  if (readOnly) $$('.no-print', el).forEach((b) => b.remove());
}

// Level-based DCs (GM Core table) and rarity adjustments
const DC_BY_LEVEL = [14, 15, 16, 18, 19, 20, 22, 23, 24, 26, 27, 28, 30, 31, 32, 34, 35, 36, 38, 39, 40, 42, 44, 46, 48, 50];
const RARITY_DC = { common: 0, uncommon: 2, rare: 5, unique: 10 };
function craftSources() {
  const owned = ch.ownedSlugs;
  const src = [];
  if ((ch.ranks.skills.crafting || 0) < 1) return src;
  src.push({ label: 'Crafting (trained)', test: (r) => !(r.traits || []).some((t) => ['magical', 'alchemical', 'snare'].includes(t)) });
  if (owned.has('alchemical-crafting')) src.push({ label: 'Alchemical Crafting', test: (r) => (r.traits || []).includes('alchemical') });
  if (owned.has('magical-crafting')) src.push({ label: 'Magical Crafting', test: (r) => (r.traits || []).includes('magical') });
  if (owned.has('snare-crafting')) src.push({ label: 'Snare Crafting', test: (r) => (r.traits || []).includes('snare') });
  if (owned.has('junk-tinker')) src.push({ label: 'Junk Tinker (¼ price, shoddy)', test: (r) => r.level === 0 && ['weapon', 'armor', 'shield', 'equipment'].includes(r.type) });
  for (const c of ch.crafting) src.push({ label: c.label + (c.daily ? ' (daily)' : ''), test: (r) => test(c.filter, itemOptions(r, 'equipment')) });
  return src;
}
TAB_RENDER.crafting = (el) => {
  const formulas = (build.formulas || []).map((r) => db.get(r)).filter(Boolean);
  el.innerHTML = `<div class="grid2"><div><div class="row between"><h3 class="sub-head" style="margin:0">Crafting</h3><span>Crafting <b class="mono">${signed(ch.skills.crafting.total)}</b> ${rankBadge(ch.ranks.skills.crafting)}</span></div>
      ${hasAlchemy(ch) ? `<p class="small">Versatile vials, Advanced Alchemy and Quick Alchemy are on the <button type="button" class="linkish" data-goto="alchemy">Alchemy tab</button>.</p>` : ''}
      ${ch.crafting.filter((c) => !isAlchemyCraft(c)).map((c) => { const used = state.dailyUsed[c.slug] || 0; return `<div class="entry"><div class="grow"><b>${esc(c.label)}</b> <span class="muted small">${esc(c.source)}</span>${c.max != null ? `<div class="sub">${c.daily ? 'Daily items' : 'Uses'}: ${c.max - used} of ${c.max} left</div>` : ''}</div>
        ${c.max != null && !readOnly ? `<button type="button" class="btn small" data-daily="${esc(c.slug)}" data-max="${c.max}">Use one</button>` : ''}</div>`; }).join('')}
      <p class="small muted">${ch.ranks.skills.crafting ? '' : 'You need to be trained in Crafting to Craft items.'}</p>
      <button type="button" class="btn primary" id="craftList" ${ch.ranks.skills.crafting ? '' : 'disabled'}>What can I craft?</button></div>
    <div><h3 class="sub-head">Formula book</h3>${formulas.map((r) => `<div class="entry"><div class="grow"><span class="name" data-show="${esc(refOf(r))}">${esc(r.name)}</span><div class="sub">Level ${r.level} · ${esc(formatPrice(r.price))} · DC ${DC_BY_LEVEL[r.level] + (RARITY_DC[r.rarity] || 0)}</div></div></div>`).join('') || '<p class="muted small">No formulas. Add them in the builder (Equipment step).</p>'}</div></div>`;
  $$('[data-daily]', el).forEach((b) => (b.onclick = () => {
    const s = b.dataset.daily;
    state.dailyUsed[s] = Math.min(Number(b.dataset.max), (state.dailyUsed[s] || 0) + 1);
    change();
  }));
  const cl = $('#craftList', el);
  if (cl) cl.onclick = openCraftList;
  $$('[data-goto]', el).forEach((b) => (b.onclick = () => { tab = b.dataset.goto; sessionStorage.setItem('pf2e.sheetTab', tab); render(); }));
};
// ------------------------------------------------------------------ alchemy
// Left: versatile vials and formulas (Quick Alchemy spends a vial). Right: Advanced Alchemy slots, picked at daily preparations.
const ALCH_FILTER = ['item:trait:alchemical', 'item:trait:consumable'];
const alchPool = (filter) => db.list('equipment').filter((r) => r.level <= ch.level && r.type !== 'treasure' && test(filter || ALCH_FILTER, itemOptions(r, 'equipment')));
const knownFamilies = () => new Set((build.formulas || []).map((r) => db.get(r)).filter(Boolean).map((r) => formulaFamily(r.name)));
const ALCH_KINDS = [['bomb', 'Bombs'], ['elixir', 'Elixirs'], ['mutagen', 'Mutagens'], ['poison', 'Poisons']];
const alchKind = (r) => (ALCH_KINDS.find(([t]) => (r.traits || []).includes(t)) || [null, 'Other'])[1];
const alchChips = () => [{ id: 'all', label: 'All' }, ...ALCH_KINDS.map(([t, label]) => ({ id: t, label, test: (it) => (it.rec.traits || []).includes(t) })), { id: 'other', label: 'Other', test: (it) => alchKind(it.rec) === 'Other' }];

/** Mutagenist: using a mutagen gives Int + half your level temporary HP. Returns true when it did. */
function mutagenTemp(ref) {
  const rec = db.get(ref);
  if (!rec || !/mutagen/.test(rec.slug) || !ch.ownedSlugs.has('mutagenist')) return false;
  const t = Math.max(0, ch.attrs.int) + Math.floor(ch.level / 2);
  if (t <= state.temp) return false;
  state.temp = t;
  toast(`Mutagenist: ${t} temporary HP for 1 minute`, 'ok');
  return true;
}
/** Rules from the research field and alchemist feats that change how vials and items work, as short lines. */
function alchemyLines(vialStrike) {
  const has = (s) => ch.ownedSlugs.has(s);
  const L = ch.level, int = Math.max(0, ch.attrs.int);
  const il = ch.resources?.versatileVials?.itemLevel || 1;
  const dice = `${il >= 18 ? 4 : il >= 12 ? 3 : il >= 4 ? 2 : 1}d6`;
  const vials = [], other = [];
  if (has('bomber')) {
    vials.push('<b>Field vials:</b> a vial Strike can deal cold, electricity or fire instead of acid (switch above Strikes).');
    if (has('advanced-vials-bomber')) vials.push('<b>Advanced vials:</b> each vial can count as adamantine, cold iron or dawnsilver (or a precious material you wear or wield).');
    other.push('<b>Bomber:</b> splash can hit only your primary target.' + (has('greater-field-discovery-bomber') ? ` Splash can reach ${has('expanded-splash') ? 15 : 10} feet (Greater Field Discovery).` : ''));
  }
  if (has('chirurgeon')) {
    vials.push(`<b>Field vials:</b> a vial heals ${dice} HP (its damage): drink it, or throw it at a willing creature within 20 feet as an Interact action. It has the coagulant and healing traits.${has('advanced-vials-chirurgeon') ? ' Coagulant doesn’t apply to a creature at half its HP or less (Advanced Vials).' : ''}`);
    if (has('soothing-vials')) vials.push('<b>Soothing Vials:</b> a creature under a mental effect healed by a vial can attempt a new Will save (+1 item) to end one.');
    other.push(`<b>Chirurgeon:</b> your Crafting counts as Medicine for prerequisites and checks (Medicine ${signed(ch.skills.medicine.total)}).`);
    if (has('field-discovery-chirurgeon')) other.push(`<b>Field Discovery:</b> healing elixirs you made also give ${int} temporary HP for 1 minute.`);
    if (has('greater-field-discovery-chirurgeon')) other.push('<b>Greater Field Discovery:</b> elixirs of life you make with Quick Alchemy heal the maximum.');
  }
  if (has('mutagenist')) {
    vials.push(`<b>Field vials:</b> drink one to suppress one mutagen drawback for 1 minute.${has('advanced-vials-mutagenist') ? ` You also gain resistance ${Math.floor(L / 2)} to physical damage for that minute (Advanced Vials).` : ''}`);
    other.push(`<b>Mutagenist:</b> using a mutagen gives you ${int + Math.floor(L / 2)} temporary HP for 1 minute (added when you add a mutagen effect here); not again for 1 minute.`);
    if (has('field-discovery-mutagenist')) other.push('<b>Field Discovery:</b> while under a mutagen, you can end it to reroll a Fortitude save (fortune).');
    if (has('greater-field-discovery-mutagenist')) other.push('<b>Greater Field Discovery:</b> two mutagens at once, with both drawbacks.');
  }
  if (has('toxicologist')) {
    vials.push(`<b>Field vials:</b> your vials deal poison. Apply one to a weapon or ammunition as an injury poison: the first hit this turn deals +${dice} poison${has('advanced-vials-toxicologist') && vialStrike ? ` and ${vialStrike.splash} persistent poison (Advanced Vials)` : ''}.`);
    other.push('<b>Toxicologist:</b> Activate an injury poison as one action when applying it to a weapon you hold. Your infused poisons hit creatures immune to poison, as acid.');
    if (has('greater-field-discovery-toxicologist')) other.push('<b>Greater Field Discovery:</b> a failed initial save against your infused injury poison sprays it onto an adjacent creature.');
  }
  // Powerful Alchemy (alchemists) or Alchemical Power (Alchemist Dedication): infused items can use the alchemist class DC.
  const alchDC = has('powerful-alchemy') && ch.class?.slug === 'alchemist' ? ch.classDC
    : has('alchemical-power') ? (ch.otherClassDCs || []).find((o) => o.slug === 'alchemist') : null;
  if (alchDC) other.push(`<b>${has('powerful-alchemy') ? 'Powerful Alchemy' : 'Alchemical Power'}:</b> infused items you make that allow a saving throw can use your class DC <b>${alchDC.total}</b>.`);
  if (has('abundant-vials')) other.push('<b>Abundant Vials:</b> you’re quickened; the extra action can only be Quick Alchemy to make one quick vial.');
  if (has('extend-elixir')) other.push(`<b>Extend Elixir:</b> your infused elixirs of 1 minute or more last twice as long on you${has('eternal-elixir') ? `; Eternal Elixir makes one of level ${Math.floor(L / 2)} or lower last indefinitely` : ''}.`);
  const quickN = has('alchemical-alacrity') ? 3 : has('double-brew') ? 2 : 1;
  const additives = ch.items.filter((i) => i.pack === 'feats' && (i.rec.traits || []).some((t) => /^additive/.test(t))).map((i) => i.rec)
    .filter((r, i, a) => a.findIndex((x) => x.slug === r.slug) === i).sort((a, b) => a.name.localeCompare(b.name));
  return { vials, other, quickN, additives };
}
TAB_RENDER.alchemy = (el) => {
  const info = alchemyInfo(ch, state);
  const v = info.vials;
  const fams = knownFamilies();
  const best = new Map();
  for (const r of alchPool(info.quick?.filter)) { const f = formulaFamily(r.name); if (!fams.has(f)) continue; const b = best.get(f); if (!b || r.level > b.level) best.set(f, r); }
  const rows = [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
  const canQuick = !!(info.quick && v && !readOnly);
  const vialStrike = ch.strikes.find((x) => x.rec.slug === 'versatile-vial');
  const gather = ch.ownedSlugs.has('alchemical-expertise') ? 3 : 2; // Alchemical Expertise: three vials per 10 minutes
  const lines = alchemyLines(vialStrike);
  el.innerHTML = `<div class="alch-grid">
    <section class="alch-col">
      ${v ? `<div class="alch-card">
        <div class="row between"><h3 class="sub-head">${esc(v.label)}</h3><span class="vial-num"><b>${v.left}</b> / ${v.max}</span></div>
        <div class="vial-pips" role="group" aria-label="${esc(v.label)}">${Array.from({ length: v.max }, (_, i) => `<button type="button" class="vial ${i < v.left ? 'on' : ''}" data-vial="${i}" aria-label="Vial ${i + 1}: ${i < v.left ? 'ready' : 'used'}" ${readOnly ? 'disabled' : ''}></button>`).join('')}</div>
        ${readOnly ? '' : `<div class="row alch-btns"><button type="button" class="btn small" data-vuse ${v.left ? '' : 'disabled'}>Use a vial</button><button type="button" class="btn small" data-vgain ${v.left < v.max ? '' : 'disabled'} title="Every 10 minutes in exploration mode you get ${gather} vials back">+${gather} · 10 min exploring</button></div>`}
        ${vialStrike ? `<p class="small muted alch-note">As a bomb: <b class="mono">${signed(vialStrike.attack)}</b> to hit · ${esc(vialStrike.damage)} · ${vialStrike.splash} splash${vialStrike.range ? ` · ${vialStrike.range} ft` : ''} (also in Strikes). They refill at Rest.</p>` : ''}
        ${lines.vials.length ? `<ul class="alch-rules">${lines.vials.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}
      </div>` : ''}
      ${lines.other.length || lines.additives.length ? `<div class="alch-card"><h3 class="sub-head">Your field and feats</h3>
        ${lines.other.length ? `<ul class="alch-rules">${lines.other.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}
        ${lines.additives.length ? `<p class="small muted alch-note">Additives: add one to a consumable you make with Quick Alchemy (one per item, once a round; not quick vials).</p><div class="act-mods">${lines.additives.map((r) => `<a class="ref chip-btn" data-show="${esc(refOf(r))}">${esc(r.name)}</a>`).join('')}</div>` : ''}
      </div>` : ''}
      <div class="alch-card">
        <div class="row between"><h3 class="sub-head">Formulas <span class="muted">${rows.length}</span></h3>${readOnly ? '' : '<button type="button" class="btn small" data-addformula>+ Add formula</button>'}</div>
        ${canQuick ? `<p class="small muted alch-note">Quick Alchemy: spend a vial to make one now; it lasts until the start of your next turn${ch.ownedSlugs.has('enduring-alchemy') ? ' (tools and elixirs: the end of your next turn, Enduring Alchemy)' : ''}.${lines.quickN > 1 ? ` You can make up to ${lines.quickN} at once (one vial each).` : ''}</p>` : ''}
        ${rows.length > 6 ? '<input type="search" class="alch-search" placeholder="Search formulas…" aria-label="Search formulas">' : ''}
        <div class="alch-list">${rows.map((r) => `<div class="alch-row" data-n="${esc(r.name.toLowerCase())}"><button type="button" class="alch-name" data-show="${esc(refOf(r))}">${esc(r.name)}</button><span class="muted small">Lv ${r.level}</span>${canQuick ? `<button type="button" class="btn small" data-quick="${esc(refOf(r))}" ${v.left ? '' : 'disabled'}>Quick</button>` : ''}</div>`).join('')
          || `<p class="muted small">No alchemical formulas yet.${readOnly ? '' : ' Add the ones in your formula book; one formula covers every level of an item.'}</p>`}</div>
      </div>
    </section>
    <section class="alch-col">
      ${info.preps.map((p) => `<div class="alch-card">
        <div class="row between"><h3 class="sub-head">${esc(p.label)}</h3><span class="small"><b>${p.left}</b> of ${p.max} left</span></div>
        <p class="small muted alch-note">Up to ${p.max} items from your formulas, made each morning. Rest makes the same picks ready again.</p>
        <div class="pslots">${p.slots.map((x, i) => { const r = x && db.get(x.ref); return r
          ? `<div class="pslot ${x.used ? 'used' : ''}"><button type="button" class="alch-name" data-show="${esc(x.ref)}">${esc(r.name)}</button><span class="muted small">Lv ${r.level}</span>${readOnly ? '' : `<button type="button" class="btn small ${x.used ? '' : 'primary'}" data-puse="${i}" data-ps="${esc(p.slug)}">${x.used ? 'Undo' : 'Use'}</button><button type="button" class="icon-btn" data-pedit="${i}" data-ps="${esc(p.slug)}" aria-label="Change ${esc(r.name)}">✎</button>`}</div>`
          : `<button type="button" class="pslot empty" data-pfill="${i}" data-ps="${esc(p.slug)}" ${readOnly ? 'disabled' : ''}>+ Choose an item</button>`; }).join('')}</div>
        ${readOnly ? '' : `<div class="row alch-btns">${p.filled < p.max ? `<button type="button" class="btn primary" data-pfill="-1" data-ps="${esc(p.slug)}">Fill ${p.max - p.filled} empty slot${p.max - p.filled > 1 ? 's' : ''}</button>` : ''}${p.filled ? `<button type="button" class="btn ghost small" data-pclear="${esc(p.slug)}">Clear all</button>` : ''}</div>`}
      </div>`).join('') || `<div class="alch-card"><h3 class="sub-head">Daily preparations</h3><p class="muted small">Advanced Alchemy comes with the alchemist class, or the Advanced Alchemy archetype feat. Until then, make items with Quick Alchemy.</p></div>`}
    </section></div>`;
  if (readOnly) return;
  const al = state.alchemy;
  const setLeft = (n) => { al.vialsUsed = v.max - Math.max(0, Math.min(v.max, n)); change(); };
  $$('[data-vial]', el).forEach((b) => (b.onclick = () => { const i = Number(b.dataset.vial); setLeft(i < v.left ? i : i + 1); }));
  const vu = $('[data-vuse]', el); if (vu) vu.onclick = () => setLeft(v.left - 1);
  const vg = $('[data-vgain]', el); if (vg) vg.onclick = () => setLeft(v.left + gather);
  $$('[data-quick]', el).forEach((b) => (b.onclick = () => { const r = db.get(b.dataset.quick); setLeft(v.left - 1); toast(`Quick Alchemy: ${r ? r.name : 'item'} made (1 vial). It lasts until the start of your next turn.`, 'ok'); }));
  const search = $('.alch-search', el);
  if (search) search.oninput = () => { const q = search.value.trim().toLowerCase(); $$('.alch-row', el).forEach((r) => (r.hidden = !!q && !r.dataset.n.includes(q))); };
  const slotsOf = (slug) => { const p = info.preps.find((x) => x.slug === slug); const arr = (al.prep[slug] = Array.isArray(al.prep[slug]) ? al.prep[slug] : []); arr.length = Math.max(arr.length, p.max); return { p, arr }; };
  $$('[data-puse]', el).forEach((b) => (b.onclick = () => { const { arr } = slotsOf(b.dataset.ps); const x = arr[Number(b.dataset.puse)]; if (x) { x.used = !x.used; change(); } }));
  $$('[data-pedit]', el).forEach((b) => (b.onclick = () => pickAlchemy(b.dataset.ps, Number(b.dataset.pedit), false)));
  $$('[data-pfill]', el).forEach((b) => (b.onclick = () => pickAlchemy(b.dataset.ps, Number(b.dataset.pfill), true)));
  $$('[data-pclear]', el).forEach((b) => (b.onclick = async () => { if (!(await confirmBox('Empty every slot?'))) return; al.prep[b.dataset.ps] = []; change(); }));
  const af = $('[data-addformula]', el); if (af) af.onclick = addFormula;
};

/** Pick items for Advanced Alchemy slots. fill: keep going into the next empty slot until they are all full. */
function pickAlchemy(slug, start, fill) {
  const info = alchemyInfo(ch, state);
  const p = info.preps.find((x) => x.slug === slug); if (!p) return;
  const al = state.alchemy;
  const arr = (al.prep[slug] = Array.isArray(al.prep[slug]) ? al.prep[slug] : []);
  const empties = () => { const out = []; for (let i = 0; i < p.max; i++) if (!(arr[i] && arr[i].ref)) out.push(i); return out; };
  let at = start >= 0 ? start : empties()[0];
  if (at == null) return;
  const fams = knownFamilies();
  const items = alchPool(p.filter).filter((r) => fams.has(formulaFamily(r.name)) || r.rarity === 'common')
    .map((r) => ({ key: refOf(r), name: r.name, level: r.level, rarity: r.rarity, rec: r, group: fams.has(formulaFamily(r.name)) ? 'Your formulas' : 'Not in your formula book (picking one adds it)', meta: alchKind(r) }))
    .sort((a, b) => (a.group === b.group ? formulaFamily(a.name).localeCompare(formulaFamily(b.name)) || a.level - b.level : a.group === 'Your formulas' ? -1 : 1));
  const sub = () => (fill ? `${empties().length} empty slot${empties().length === 1 ? '' : 's'} left` : `Slot ${at + 1} of ${p.max}`);
  openDrawer({
    title: p.label, subtitle: sub(), items, chips: alchChips(), instant: true, db, placeholder: 'Search items…', selected: fill ? null : arr[at]?.ref,
    onPick: (it) => {
      arr[at] = { ref: it.key, used: false };
      if (!fams.has(formulaFamily(it.name))) { build.formulas = [...(build.formulas || []), it.key]; fams.add(formulaFamily(it.name)); saveBuild(); }
      change();
      if (!fill) return true;
      const next = empties();
      if (!next.length) { toast(`${p.label}: all ${p.max} slots filled.`, 'ok'); return true; }
      at = next[0];
      const d = [...document.querySelectorAll('.drawer')].pop(); const sl = d && d.querySelector('.dr-sub'); if (sl) sl.textContent = sub();
      return false;
    },
  });
}

function addFormula() {
  const fams = knownFamilies();
  const seen = new Map();
  for (const r of alchPool(alchemyInfo(ch, state).quick?.filter)) {
    const f = formulaFamily(r.name); if (fams.has(f)) continue;
    const b = seen.get(f); if (!b || r.level < b.level) seen.set(f, r);
  }
  const items = [...seen.values()].map((r) => ({ key: refOf(r), name: formulaFamily(r.name), level: r.level, rarity: r.rarity, rec: r, group: r.rarity === 'common' ? 'Common' : 'Uncommon and rare', meta: alchKind(r) }))
    .sort((a, b) => (a.group === b.group ? a.name.localeCompare(b.name) : a.group === 'Common' ? -1 : 1));
  let added = 0;
  openDrawer({
    title: 'Add formulas', subtitle: 'One formula covers every level of an item. Tap to add; the list stays open.', items, chips: alchChips(), instant: true, db, placeholder: 'Search formulas…',
    onPick: (it) => {
      build.formulas = [...(build.formulas || []), it.key]; added++;
      saveBuild(); render();
      it.disabled = true; it.badge = ' <span class="badge ok-badge">added</span>';
      const d = [...document.querySelectorAll('.drawer')].pop();
      const sl = d && d.querySelector('.dr-sub'); if (sl) sl.textContent = `${added} added. Tap more, or close the list when you're done.`;
      const row = d && [...d.querySelectorAll('.dr-item')].find((x) => x.dataset.key === it.key);
      if (row) { row.classList.add('disabled'); const t = row.querySelector('.t'); if (t) t.insertAdjacentHTML('afterend', it.badge); }
      return false;
    },
  });
}

function openCraftList() {
  const m = modal('What can I craft?', { wide: true });
  const srcs = craftSources();
  const known = new Set(build.formulas || []);
  const rows = [];
  for (const r of db.list('equipment')) {
    if (r.level > ch.level || !r.price || r.type === 'treasure' || (r.traits || []).includes('precious')) continue;
    const by = srcs.filter((s) => s.test(r)).map((s) => s.label);
    if (!by.length) continue;
    rows.push({ r, by, dc: DC_BY_LEVEL[Math.min(25, r.level)] + (RARITY_DC[r.rarity] || 0), formula: known.has(refOf(r)) });
  }
  const crafting = ch.ranks.skills.crafting;
  m.body.innerHTML = `<p class="small muted">Items up to your level that your Crafting training and feats let you make. You need the formula and half the price in materials; level 9+ items need master Crafting and level 16+ need legendary.</p>
    <div class="filters"><input type="search" placeholder="Search…" aria-label="Search items"><label class="check small"><input type="checkbox" class="onlyF"> Only formulas I know</label></div>
    <div style="overflow-x:auto"><table class="stat-table"><thead><tr><th>Item</th><th>Lvl</th><th>DC</th><th>Price</th><th>Materials</th><th>Allowed by</th></tr></thead><tbody></tbody></table></div>`;
  const tb = $('tbody', m.body), q = $('input[type=search]', m.body), only = $('.onlyF', m.body);
  const draw = () => {
    const s = q.value.trim().toLowerCase();
    const list = rows.filter((x) => (!s || x.r.name.toLowerCase().includes(s)) && (!only.checked || x.formula)).sort((a, b) => b.formula - a.formula || a.r.level - b.r.level || a.r.name.localeCompare(b.r.name)).slice(0, 400);
    tb.innerHTML = list.map((x) => {
      const needRank = x.r.level >= 16 ? 4 : x.r.level >= 9 ? 3 : 1;
      return `<tr><td><a class="ref" data-ref="equipment/${esc(x.r.slug)}">${esc(x.r.name)}</a>${x.formula ? ' <span class="badge accent">formula</span>' : ''}${crafting < needRank ? ` <span class="bad tiny">needs ${RANKS[needRank].toLowerCase()}</span>` : ''}</td><td class="mono">${x.r.level}</td><td class="mono">${x.dc}</td><td>${esc(formatPrice(x.r.price))}</td><td>${esc(formatPrice(Math.ceil(x.r.price / 2)))}</td><td class="small">${esc(x.by.join(', '))}</td></tr>`;
    }).join('') || '<tr><td colspan="6" class="muted">Nothing matches.</td></tr>';
    wireRefs(db, tb);
  };
  q.oninput = draw; only.onchange = draw; draw();
}

TAB_RENDER.companions = (el) => {
  renderCompanions(el, { db, build, state, ch, readOnly, saveBuild, saveState, rerender: () => render() });
};

TAB_RENDER.notes = (el) => {
  el.innerHTML = `<h3 class="sub-head">Session notes</h3><textarea id="notesArea" ${readOnly ? 'readonly' : ''} placeholder="Loot, NPCs, quests…" aria-label="Session notes">${esc(state.notes || '')}</textarea>
    ${build.details?.notes ? `<h3 class="sub-head">Character notes</h3><p style="white-space:pre-wrap;color:var(--ink2)">${esc(build.details.notes)}</p>` : ''}`;
  const t = $('#notesArea', el);
  t.oninput = () => { state.notes = t.value; saveState(); };
};

// ------------------------------------------------------------------ events
function wire() {
  $$('[data-show]', main).forEach((e) => (e.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); showRef(db, e.dataset.show, { extras: actionExtras }); }));
  wireRefs(db, main);
  $$('[role=tab][data-tab]', main).forEach((b) => (b.onclick = () => { tab = b.dataset.tab; sessionStorage.setItem('pf2e.sheetTab', tab); render(); }));
  $$('[data-bd]', main).forEach((p) => (p.onclick = () => {
    const k = p.dataset.bd;
    const base = (st) => st.total - (st.mods || []).reduce((a, m) => a + m.value, 0);
    if (k === 'ac' || k === 'perception') statModal(k);
    else if (k === 'classdc') {
      const bm = breakdown('Class DC', { label: `10 + ${ATTR_NAMES[ch.classDC.attr]} + ${RANKS[ch.classDC.rank].toLowerCase()}`, value: ch.classDC.total }, { total: ch.classDC.total, mods: [] });
      // Archetypes' class DCs (Fighter Dedication, Rogue Dedication…).
      const others = ch.otherClassDCs || [];
      const mb = bm && bm.body;
      if (others.length && mb) mb.insertAdjacentHTML('beforeend', `<h4 style="margin-top:14px">From archetypes</h4><table class="stat-table">${others.map((o) => `<tr><td>${esc(o.name)} class DC <span class="muted small">${esc(ATTR_NAMES[o.attr])} + ${esc(RANKS[o.rank].toLowerCase())}</span></td><td class="mod">${o.total}</td></tr>`).join('')}</table>`);
    }
    else if (k === 'spelldc' || k === 'spellatk') {
      const e = mainEntry();
      const m = modal(e.label);
      m.body.innerHTML = `<p>${esc(titleCase(e.trad || ''))} ${esc(e.type)} spellcasting with ${esc(attrLabel(e.attr))}, ${RANKS[e.rank].toLowerCase()} proficiency.</p>
        <table class="stat-table"><tr><td>Spell attack</td><td class="mod">${signed(e.attack)}</td></tr><tr><td>Spell DC</td><td class="mod">${e.dc}</td></tr></table>
        ${ch.spellcasting.entries.length > 1 ? `<h4 style="margin-top:12px">Other spellcasting</h4><table class="stat-table">${ch.spellcasting.entries.filter((x) => x !== e).map((x) => `<tr><td>${esc(x.label)}</td><td class="mod">${signed(x.attack)}</td><td class="mod">${x.dc}</td></tr>`).join('')}</table>` : ''}`;
    } else statModal(k);
  }));
  $$('[data-skill]', main).forEach((row) => {
    const open = () => {
      const s = row.dataset.skill, st = ch.skills[s];
      statModal(s);
    };
    row.onclick = open;
    row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  });
  $$('[data-cond]', main).forEach((b) => (b.onclick = () => openCondition(Number(b.dataset.cond))));
  $$('.act-row[data-row-show]', main).forEach((r) => (r.onclick = (e) => { if (!e.target.closest('[data-show]')) showRef(db, r.dataset.rowShow, { extras: actionExtras }); }));
  const invPanel = $('#tabPanel'); if (invPanel && (tab === 'equipment' || tab === 'inventory')) wireInv(invPanel);
  if (readOnly) { $$('.no-print', main).forEach((b) => b.remove()); $$('.pip', main).forEach((b) => (b.disabled = true)); return; }
  const amt = () => Math.max(0, Number($('#hpAmt').value) || 0);
  $('#dmgBtn').onclick = () => {
    let d = amt(); if (!d) return;
    const fromTemp = Math.min(state.temp, d); state.temp -= fromTemp; d -= fromTemp;
    state.hp = Math.max(0, state.hp - d);
    if (state.hp === 0 && !state.dying) { state.dying = 1 + state.wounded; toast('Down! Dying ' + state.dying, 'error'); }
    change();
  };
  $('#healBtn').onclick = () => {
    const h = amt(); if (!h) return;
    const wasDown = state.hp === 0;
    state.hp = Math.min(ch.hp.max, state.hp + h);
    if (wasDown && state.dying) { state.dying = 0; state.wounded = Math.min(3, state.wounded + 1); toast('Back up — wounded ' + state.wounded); }
    change();
  };
  $('#tempBtn').onclick = () => { const t = amt(); state.temp = Math.max(state.temp, t); change(); };
  $$('[data-hero]', main).forEach((b) => (b.onclick = () => { const i = Number(b.dataset.hero); state.hero = state.hero >= i ? i - 1 : i; change(); }));
  $$('[data-focus]', main).forEach((b) => (b.onclick = () => { const i = Number(b.dataset.focus); state.focus = state.focus >= i ? i - 1 : i; change(); }));
  $$('[data-dying]', main).forEach((b) => (b.onclick = () => { const i = Number(b.dataset.dying); state.dying = state.dying >= i ? i - 1 : i; change(); }));
  $$('[data-wounded]', main).forEach((b) => (b.onclick = () => { const i = Number(b.dataset.wounded); state.wounded = state.wounded >= i ? i - 1 : i; change(); }));
  $$('[data-amt]', main).forEach((b) => (b.onclick = () => { const inp = $('#hpAmt'); inp.value = (Number(inp.value) || 0) + Number(b.dataset.amt); }));
  const rage = $('#rageBtn');
  if (rage) rage.onclick = () => {
    state.raging = !state.raging;
    if (state.raging) { const t = ch.level + ch.attrs.con; state.temp = Math.max(state.temp, t); toast(`Raging: +${t} temporary HP`); }
    change();
  };
  // Unleash Psyche: on for 2 rounds; when it subsides, Stupefied 1 for 2 rounds and no unleashing for 2 rounds.
  const unl = $('#unleashBtn');
  if (unl) unl.onclick = () => {
    if (!state.unleashed) {
      if (state.conditions.some((c) => c.slug === 'stupefied')) { toast("You can't Unleash your Psyche while Stupefied"); return; }
      state.unleashed = true;
      toast('Psyche unleashed for 2 rounds: +2 × rank status damage on your damaging psychic spells');
    } else {
      state.unleashed = false;
      const st = state.conditions.find((c) => c.slug === 'stupefied');
      if (st) st.value = Math.max(st.value, 1); else state.conditions.push({ slug: 'stupefied', value: 1 });
      toast("Psyche subsided: Stupefied 1 for 2 rounds, and you can't Unleash again for 2 rounds");
    }
    change();
  };
  const sh = $('#shieldBtn');
  if (sh) sh.onclick = () => { state.shieldRaised = !state.shieldRaised; change(); };
  const pBtn = $('#portraitBtn');
  if (pBtn) pBtn.onclick = () => (portraitSrc(build.portrait) ? portraitModal() : choosePortrait());
  $('#restBtn').onclick = () => {
    state.hp = ch.hp.max; state.temp = 0; state.focus = ch.spellcasting.focus.max || ch.focusMax; state.used = {}; state.innateUsed = {}; state.dailyUsed = {}; state.raging = false; state.unleashed = false; state.shieldRaised = false;
    // Daily preparations: the staff in hand (or the one carried) is prepared with fresh charges.
    prepareStaff(wieldedStaves()[0] || carriedStaves()[0]);
    // Limited uses come back too, except weekly (and longer) ones.
    const keep = {}; for (const x of limitedList(ch, state)) if (x.tier > 4 && x.used) keep[x.slug] = x.used; state.freqUsed = keep;
    for (const e of Object.values(state.prep)) for (const p of Object.values(e)) if (p) p.cast = false;
    // Alchemy: vials refill; Advanced Alchemy keeps yesterday's picks, ready to use again.
    state.alchemy.vialsUsed = 0;
    for (const arr of Object.values(state.alchemy.prep)) for (const x of Array.isArray(arr) ? arr : []) if (x) x.used = false;
    state.dying = 0; state.wounded = 0;
    state.conditions = state.conditions.filter((c) => !['frightened', 'off-guard', 'sickened', 'stunned', 'slowed', 'quickened', 'fatigued'].includes(c.slug));
    const d = state.conditions.find((c) => c.slug === 'drained'); if (d) { d.value -= 1; if (d.value <= 0) state.conditions = state.conditions.filter((c) => c !== d); }
    toast(hasAlchemy(ch) ? 'Rested: HP, vials and focus restored. Your alchemy picks are ready again; change them on the Alchemy tab.' : 'Rested: HP, slots and focus restored. Prepared spells stay — change them on the Spells tab.', 'ok');
    change();
  };
  $$('[data-cup]', main).forEach((b) => (b.onclick = () => { state.conditions[Number(b.dataset.cup)].value++; change(); }));
  $$('[data-cdown]', main).forEach((b) => (b.onclick = () => { const c = state.conditions[Number(b.dataset.cdown)]; c.value--; if (c.value <= 0) state.conditions.splice(Number(b.dataset.cdown), 1); change(); }));
  $$('[data-crm]', main).forEach((b) => (b.onclick = () => { state.conditions.splice(Number(b.dataset.crm), 1); change(); }));
  $$('[data-erm]', main).forEach((b) => (b.onclick = () => { state.effects.splice(Number(b.dataset.erm), 1); change(); }));
  // Favorite effects: star one, then add it again with one tap whenever it comes up (Rage, Heroism…).
  $$('[data-efav]', main).forEach((b) => (b.onclick = () => {
    const r = b.dataset.efav;
    state.favEffects = state.favEffects.includes(r) ? state.favEffects.filter((x) => x !== r) : [...state.favEffects, r];
    saveState(); render();
  }));
  $$('[data-efq]', main).forEach((b) => (b.onclick = () => { state.effects.push({ ref: b.dataset.efq }); mutagenTemp(b.dataset.efq); change(); }));
  $('#addCond').onclick = () => {
    const common = ['frightened', 'off-guard', 'prone', 'grabbed', 'sickened', 'clumsy', 'enfeebled', 'stupefied', 'drained', 'slowed', 'stunned', 'quickened', 'concealed', 'hidden', 'fatigued', 'persistent-damage'];
    const items = db.list('conditions').map((c) => ({ key: c.slug, name: c.name, rec: c, group: common.includes(c.slug) ? 'Common in combat' : 'All conditions', meta: c.valued ? 'Has a value' : '' }))
      .sort((a, b) => (a.group === b.group ? (a.group === 'All conditions' ? a.name.localeCompare(b.name) : common.indexOf(a.key) - common.indexOf(b.key)) : a.group === 'Common in combat' ? -1 : 1));
    openDrawer({
      title: 'Add a condition', db, items, placeholder: 'Search conditions…',
      detail: (it) => `<h3>${esc(it.name)}</h3>`, textRef: (it) => '@conditions/' + it.key, pickLabel: (it) => 'Add ' + it.name,
      onPick: (it) => {
        const ex = state.conditions.find((c) => c.slug === it.key);
        if (ex) { if (it.rec.valued) ex.value++; } else state.conditions.push({ slug: it.key, value: 1 });
        change(); toast('Added ' + it.name);
      },
    });
  };
  $('#addEff').onclick = async () => {
    await db.load(['spell-effects', 'feat-effects', 'equipment-effects']);
    const items = [...db.list('spell-effects'), ...db.list('feat-effects'), ...db.list('equipment-effects')].map((e) => ({ key: refOf(e), name: e.name.replace(/^(Spell )?Effect: /, ''), rec: e, meta: esc(titleCase(e._pack.replace('-effects', ''))) }))
      .map((it) => (state.favEffects.length ? { ...it, group: state.favEffects.includes(it.key) ? '★ Favorites' : 'All effects' } : it))
      .sort((a, b) => (a.group === b.group ? 0 : a.group === '★ Favorites' ? -1 : b.group === '★ Favorites' ? 1 : 0) || a.name.localeCompare(b.name));
    openDrawer({
      title: 'Add an effect', db, items, placeholder: 'Search effects (heroism, inspire, mutagen…)', limit: 300,
      chips: [{ id: 'all', label: 'All' }, { id: 'spell', label: 'Spells', test: (i) => i.rec._pack === 'spell-effects' }, { id: 'feat', label: 'Feats', test: (i) => i.rec._pack === 'feat-effects' }, { id: 'eq', label: 'Items', test: (i) => i.rec._pack === 'equipment-effects' }],
      detail: (it) => `<h3>${esc(it.name)}</h3>`, textRef: (it) => it.key, pickLabel: (it) => 'Add ' + it.name,
      onPick: (it) => { state.effects.push({ ref: it.key }); if (!mutagenTemp(it.key)) toast('Effect added'); change(); },
    });
  };
}

/** A condition up close: its rules, and a big stepper for its value. */
function openCondition(i) {
  const c = state.conditions[i];
  if (!c) return;
  const rec = db.get('@conditions/' + c.slug);
  openDrawer({
    title: rec?.name || c.slug, narrow: true,
    custom: async (body, api) => {
      const draw = () => {
        const cur = state.conditions[i];
        body.innerHTML = `${rec?.valued && !readOnly ? `<div class="big-stepper"><button type="button" class="step" data-d="-1" aria-label="Lower">−</button><span class="mono" aria-live="polite">${cur ? cur.value : 0}</span><button type="button" class="step" data-d="1" aria-label="Raise">+</button></div>` : ''}
          <div class="rules-text small">Loading…</div>
          ${readOnly ? '' : `<button type="button" class="btn danger block" id="condRemove" style="margin-top:14px">Remove ${esc(rec?.name || c.slug)}</button>`}`;
        $$('[data-d]', body).forEach((b) => (b.onclick = () => {
          const x = state.conditions[i];
          if (!x) return;
          x.value += Number(b.dataset.d);
          if (x.value <= 0) { state.conditions.splice(i, 1); change(); api.close(); return; }
          change(); draw();
        }));
        const rm = $('#condRemove', body);
        if (rm) rm.onclick = () => { state.conditions.splice(i, 1); change(); api.close(); };
        db.text('@conditions/' + c.slug).then((html) => { const rt = $('.rules-text', body); if (rt) { rt.innerHTML = html || ''; wireRefs(db, body); } });
      };
      draw();
    },
  });
}

compute();
render();
})().catch((e) => { console.error(e); const m = document.getElementById('main') || document.getElementById('list'); if (m && !m.querySelector('.bad')) m.insertAdjacentHTML('afterbegin', '<p class="bad">Something went wrong: ' + String(e.message || e).replace(/</g, '&lt;') + '</p>'); });
