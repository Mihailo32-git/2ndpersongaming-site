// GM screen: party on the left, the encounter and initiative order in the middle, the selected creature's statblock on the right.
import { DB, bucketOf } from './data.js';
import { Engine, normalizeBuild } from './engine.js';
import { Store, api, OfflineError } from './store.js';
import { mountAccount } from './account.js';
import { modal, toast, confirmBox, wireRefs, traitChips, esc } from './ui.js';
import { signed, titleCase, uid } from './util.js';
import { slotRows, ordinal } from './casting.js';

(async () => {
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const main = $('#main');

const db = await new DB({ base: 'data/' }).init();
await db.load(['equipment', 'creatures', 'creatureBooks', 'conditions']);
const engine = new Engine(db);
const store = await new Store().init();
mountAccount(store);

// ------------------------------------------------------------------ rules tables (GM Core)
const DC_BY_LEVEL = [14, 15, 16, 18, 19, 20, 22, 23, 24, 26, 27, 28, 30, 31, 32, 34, 35, 36, 38, 39, 40, 42, 44, 46, 48, 50];
const RARITY_DC = { common: 0, uncommon: 2, rare: 5, unique: 10 };
const XP_BY_DIFF = { '-4': 10, '-3': 15, '-2': 20, '-1': 30, 0: 40, 1: 60, 2: 80, 3: 120, 4: 160 };
const THREATS = [['Trivial', 40, 10], ['Low', 60, 20], ['Moderate', 80, 20], ['Severe', 120, 30], ['Extreme', 160, 40]];
// Recall Knowledge skills by creature trait
const RK_SKILLS = { aberration: 'Occultism', animal: 'Nature', astral: 'Occultism', beast: 'Arcana, Nature', celestial: 'Religion', construct: 'Arcana, Crafting',
  dragon: 'Arcana', dream: 'Occultism', hag: 'Occultism', genie: 'Arcana', troll: 'Nature', giant: 'Society', elemental: 'Arcana, Nature', ethereal: 'Occultism', fey: 'Nature', fiend: 'Religion', fungus: 'Nature',
  humanoid: 'Society', monitor: 'Religion', ooze: 'Occultism', plant: 'Nature', shade: 'Religion', spirit: 'Occultism', time: 'Occultism', undead: 'Religion' };
const adjLevel = (lvl, adj) => (adj === 'elite' ? lvl + (lvl <= 0 ? 2 : 1) : adj === 'weak' ? lvl - (lvl === 1 ? 2 : 1) : lvl);
const adjHp = (lvl, adj) => {
  if (adj === 'elite') return lvl <= 1 ? 10 : lvl <= 4 ? 15 : lvl <= 19 ? 20 : 30;
  if (adj === 'weak') return -(lvl <= 2 ? 10 : lvl <= 5 ? 15 : lvl <= 20 ? 20 : 30);
  return 0;
};
const adjMod = (adj) => (adj === 'elite' ? 2 : adj === 'weak' ? -2 : 0);
const SIZES = { tiny: 'Tiny', sm: 'Small', med: 'Medium', lg: 'Large', huge: 'Huge', grg: 'Gargantuan' };
const traitName = (t) => titleCase(String(t).replace(/-/g, ' '));
const ago = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return new Date(ms).toLocaleDateString();
};

// ------------------------------------------------------------------ saved encounters
// Always kept on this device (so the GM screen works offline). Logged in, they're also saved to the
// account and show up on every device; changes are sent a moment after they're made.
const readJson = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
const writeJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };
const cacheKey = (u) => 'pf2e.gm.encs.' + (u ? 'u' + u.id : 'anon');
const newId = () => 'e' + uid() + uid();
const blankEnc = (name) => ({ id: newId(), name: name || 'New encounter', partyLevel: null, partySize: null, list: [], sel: null, combat: null });
function normEnc(e) {
  const x = Object.assign(blankEnc(), e || {});
  x.list = (x.list || []).map((c) => Object.assign({ adj: 'normal', temp: 0, conditions: [] }, c));
  // Encounters saved before numbering used letters: A → 1, B → 2…
  for (const c of x.list) if (/^[A-Z]$/.test(String(c.tag))) c.tag = String(c.tag.charCodeAt(0) - 64);
  if (x.combat) x.combat = Object.assign({ round: 1, order: [], delayed: [], init: {}, turn: null }, x.combat);
  return x;
}
const cache = readJson(cacheKey(store.user)) || { active: null, items: {} };
const persist = () => writeJson(cacheKey(store.user), cache);
{
  // The first version kept a single encounter under another key.
  const old = readJson('pf2e.gm.v1');
  if (old && Array.isArray(old.list)) {
    if (old.list.length || !Object.keys(cache.items).length) {
      const e = normEnc(Object.assign({}, old, { id: newId() }));
      cache.items[e.id] = { data: e, version: 0, dirty: Date.now(), updated: Date.now() };
      cache.active = e.id;
    }
    try { localStorage.removeItem('pf2e.gm.v1'); } catch (e) { /* ignore */ }
  }
  // Logged in: encounters made on this device while logged out move into the account.
  if (store.user) {
    const anon = readJson(cacheKey(null));
    if (anon && Object.keys(anon.items || {}).length) {
      for (const [id, it] of Object.entries(anon.items)) if (!it.deleted && it.data) cache.items[id] = { data: it.data, version: 0, dirty: Date.now(), updated: it.updated || Date.now() };
      if (!cache.active) cache.active = anon.active;
      try { localStorage.removeItem(cacheKey(null)); } catch (e) { /* ignore */ }
    }
  }
  persist();
}
let enc = null;
let syncState = store.user ? 'saved' : 'local'; // saved | saving | offline | local | error
function useEnc(e) { enc = normEnc(e); cache.active = enc.id; if (!cache.items[enc.id]) cache.items[enc.id] = { data: enc, version: 0, dirty: Date.now(), updated: Date.now() }; else cache.items[enc.id].data = enc; persist(); }
function summaryOf(e) {
  const n = e.list.length;
  const t = threat(e);
  return `${n} creature${n === 1 ? '' : 's'}${n ? ' · ' + t.label + ' · ' + t.xp + ' XP' : ''}${e.combat ? ' · in combat, round ' + e.combat.round : ''}`;
}
let pushTimer = null;
function save() {
  const it = cache.items[enc.id] || (cache.items[enc.id] = { version: 0 });
  it.data = enc; it.dirty = Date.now() + Math.random(); it.updated = Date.now(); it.deleted = false;
  cache.active = enc.id;
  persist();
  if (store.user) { syncState = 'saving'; drawSync(); clearTimeout(pushTimer); pushTimer = setTimeout(push, 1200); }
}
let pushing = false;
async function push() {
  if (!store.user || pushing) return;
  pushing = true;
  let again = false;
  try {
    for (const [id, it] of Object.entries(cache.items)) {
      if (!it.dirty) continue;
      const stamp = it.dirty;
      if (it.deleted) {
        if (it.version) await api('encounter_delete', { id });
        if (it.dirty === stamp) delete cache.items[id];
      } else {
        const r = await api('encounter_save', { id, name: it.data.name, summary: summaryOf(normEnc(it.data)), data: it.data });
        it.version = r.version;
        if (it.dirty === stamp) it.dirty = 0; else again = true;
      }
      persist();
    }
    syncState = 'saved';
  } catch (e) {
    syncState = e instanceof OfflineError ? 'offline' : 'error';
    if (!(e instanceof OfflineError)) console.warn('encounter sync', e);
    clearTimeout(pushTimer); pushTimer = setTimeout(push, 30000);
  } finally { pushing = false; drawSync(); }
  if (again) { clearTimeout(pushTimer); pushTimer = setTimeout(push, 300); }
}
window.addEventListener('online', () => { if (store.user) push(); });
function drawSync() {
  const el = $('.gm-sync'); if (!el) return;
  const t = { saved: '✓ Saved to your account', saving: 'Saving…', offline: 'Offline: saved here, syncs later', error: 'Couldn’t save to your account', local: 'Saved on this device' }[syncState];
  el.textContent = t; el.className = 'gm-sync ' + syncState;
}
// The server's list; also forgets copies of encounters deleted on another device.
async function remoteList() {
  if (!store.user) return null;
  try {
    const list = (await api('encounters')).encounters || [];
    const ids = new Set(list.map((r) => r.id));
    for (const [id, it] of Object.entries(cache.items)) if (it.version && !it.dirty && !ids.has(id)) delete cache.items[id];
    persist();
    return list;
  } catch (e) { return null; }
}
async function fetchEnc(id) {
  const r = (await api('encounter', null, { id })).encounter;
  cache.items[id] = { data: normEnc(Object.assign({}, r.data, { id })), version: r.version, dirty: 0, updated: Date.parse(r.updated) || Date.now() };
  persist();
  return cache.items[id].data;
}
// Newer copy saved on another device (and nothing unsaved here): take it.
async function refreshActive(list) {
  const r = (list || []).find((x) => x.id === enc.id);
  const it = cache.items[enc.id];
  if (r && it && !it.dirty && r.version > (it.version || 0)) {
    try { useEnc(await fetchEnc(enc.id)); return true; } catch (e) { /* keep ours */ }
  }
  return false;
}
async function initEncounters() {
  const list = await remoteList();
  const local = cache.items[cache.active] && !cache.items[cache.active].deleted ? cache.items[cache.active].data : null;
  if (local) useEnc(local);
  else {
    const recent = Object.values(cache.items).filter((it) => !it.deleted && it.data).sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
    if (recent) useEnc(recent.data);
    else if (list && list.length) { try { useEnc(await fetchEnc(list[0].id)); } catch (e) { useEnc(blankEnc()); } }
    else useEnc(blankEnc());
  }
  if (list) await refreshActive(list);
  if (store.user && Object.values(cache.items).some((it) => it.dirty)) push();
}

const statblocks = {};
async function statblock(slug) {
  if (!statblocks[slug]) {
    const n = db.meta?.textBuckets?.creatures || 16;
    const m = await db.fetchJson('text/creatures/' + bucketOf(slug, n) + '.json').catch(() => ({}));
    Object.assign(statblocks, m);
  }
  return statblocks[slug] || null;
}

// ------------------------------------------------------------------ party
// Logged in: the GM's parties (players join with a code), refreshed every few seconds.
// Not logged in: the characters saved on this device.
const PKEY = 'pf2e.gm.party';
let party = [];
let parties = [];
let activeParty = (() => { try { return localStorage.getItem(PKEY) || null; } catch (e) { return null; } })();
let partyMeta = null;
let since = null;
let live = null; // true = updating, false = connection problem
const members = new Map();
const blankState = { hp: null, temp: 0, hero: 1, focus: null, dying: 0, wounded: 0, conditions: [], used: {}, prep: {} };
const toMember = (rec) => {
  const build = normalizeBuild(rec.build);
  const state = Object.assign({}, blankState, rec.state || {});
  return { rec, build, state, ch: engine.compute(build, state), player: rec.player || '' };
};
const setActive = (id) => { activeParty = id; since = null; members.clear(); party = []; partyMeta = null; try { id ? localStorage.setItem(PKEY, id) : localStorage.removeItem(PKEY); } catch (e) { /* ignore */ } };
async function loadParties() {
  if (!store.user) { parties = []; return; }
  try { parties = (await api('parties')).parties || []; } catch (e) { parties = []; }
  if (!parties.some((p) => p.id === activeParty)) setActive(parties[0]?.id || null);
}
async function loadDevice() {
  const list = await store.list().catch(() => []);
  party = [];
  for (const rec of list) {
    try { party.push(toMember(rec.build ? rec : await store.get(rec.id))); } catch (e) { console.warn('party', e); }
  }
}
// One poll: only sheets changed since the last one come back.
async function pollParty() {
  if (!store.user || !activeParty) return false;
  try {
    const r = await api('party', null, since ? { id: activeParty, since } : { id: activeParty }, 8000);
    partyMeta = r.party; since = r.now;
    let changed = false;
    for (const id of [...members.keys()]) if (!r.ids.includes(id)) { members.delete(id); changed = true; }
    for (const c of r.members) {
      const old = members.get(c.id);
      if (!old || old.rec.version !== c.version || JSON.stringify(old.rec.state) !== JSON.stringify(c.state)) { members.set(c.id, toMember(c)); changed = true; }
    }
    // Someone we don't have yet (e.g. their sheet changed before they joined): fetch everyone once more.
    if (r.ids.some((id) => !members.has(id)) && since !== null && !pollParty.again) { since = null; pollParty.again = true; try { return await pollParty(); } finally { pollParty.again = false; } }
    const next = r.ids.map((id) => members.get(id)).filter(Boolean);
    if (next.length !== party.length) changed = true;
    party = next;
    if (live !== true) { live = true; changed = true; }
    return changed;
  } catch (e) {
    if (live !== false) { live = false; return true; }
    return false;
  }
}
await loadParties();
if (store.user && activeParty) await pollParty(); else await loadDevice();
setInterval(async () => {
  if (document.hidden || !store.user || !activeParty) return;
  const before = party.length;
  if (await pollParty()) {
    if (party.length !== before) render();
    else { renderParty(); if (enc.combat) renderEnc(); }
  }
}, 3000);
const partyLevel = (e = enc) => e.partyLevel ?? (party.length ? Math.round(party.reduce((a, p) => a + p.build.level, 0) / party.length) : 1);
const partySize = (e = enc) => e.partySize ?? (party.length || 4);

function slotsLeft(p) {
  const out = [];
  for (const e of p.ch.spellcasting.entries || []) {
    const ranks = {};
    if (e.type === 'prepared') {
      const prep = p.state.prep[e.id] || {};
      for (const r of slotRows(e)) if (r.rank > 0) { const x = (ranks[r.rank] = ranks[r.rank] || [0, 0]); x[1]++; if (!prep[r.id]?.cast) x[0]++; }
    } else {
      const used = p.state.used[e.id] || {};
      for (const [r, n] of Object.entries(e.slots || {})) if (Number(r) > 0) ranks[r] = [Math.max(0, n - (used[r] || 0)), n];
    }
    if (Object.keys(ranks).length) out.push({ label: e.label, ranks });
  }
  return out;
}
const hpOf = (p) => { const max = p.ch.hp.max; const cur = p.state.hp == null ? max : p.state.hp; return { cur, max, temp: p.state.temp || 0 }; };
const bar = (cur, max, temp = 0) => {
  const pct = max ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0;
  const cls = pct <= 25 ? 'low' : pct <= 50 ? 'mid' : '';
  return `<div class="gm-bar ${cls}"><div style="width:${pct}%"></div>${temp ? '<i></i>' : ''}</div>`;
};
const condChips = (list) => (list || []).map((c) => `<span class="gm-cond">${esc(db.get('@conditions/' + c.slug)?.name || titleCase(c.slug))}${c.value ? ' ' + c.value : ''}</span>`).join('');

const fmtCode = (c) => (c ? c.slice(0, 3) + '-' + c.slice(3) : '');
function partyColumn() {
  if (!store.user) {
    return `<h2 class="label" style="margin:0">Party <span class="muted">(this device)</span></h2>
      <p class="muted small">Log in to run a party: players join with a code and their sheets show up here live.</p>${partyHtml()}`;
  }
  if (!parties.length) {
    return `<h2 class="label" style="margin:0">Party</h2>
      <p class="muted small">Make a party, then give its join code to your players. Their sheets appear here and update live.</p>
      <button type="button" class="btn primary" id="newParty" style="width:100%">+ New party</button>`;
  }
  return `<div class="gm-party-head">
      <select id="partySel" aria-label="Party">${parties.map((p) => `<option value="${esc(p.id)}" ${p.id === activeParty ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}<option value="__new">+ New party…</option></select>
      <button type="button" class="icon-btn" id="partyManage" aria-label="Manage party" title="Manage party">⚙</button>
    </div>
    ${partyMeta ? `<button type="button" class="gm-code" id="partyCode" title="Copy the join code">${partyMeta.locked ? '🔒 Locked' : `Join code <b>${esc(fmtCode(partyMeta.code))}</b>`}</button>` : ''}
    <div class="gm-live ${live === false ? 'off' : ''}">${live === false ? 'Can’t reach the server: retrying…' : '● Live'}</div>
    ${partyHtml()}`;
}
function partyHtml() {
  if (!party.length) return store.user && activeParty ? '<p class="muted small">Nobody has joined yet. Share the join code: players tap <b>Party</b> on their sheet and enter it.</p>' : '<p class="muted small">No characters yet.</p>';
  return party.map((p, i) => {
    const h = hpOf(p); const ch = p.ch;
    const cls = ch.class?.name || ''; const fmax = ch.spellcasting.focus?.max || ch.focusMax || 0;
    return `<button type="button" class="gm-pc" data-pc="${i}">
      <div class="gm-pc-top"><span class="gm-av">${esc((p.build.name || '?').replace(/[^\p{L}\s]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase())}</span>
        <span class="gm-pc-id"><b>${esc(p.build.name || 'Unnamed')}</b><span class="muted">${esc(cls)} ${p.build.level}${p.player ? ' · ' + esc(p.player) : ''}</span></span>
        <span class="gm-ac" title="Armor Class">${ch.ac.total}</span></div>
      <div class="gm-hp-line"><span class="mono"><b>${h.cur}</b>/${h.max}${h.temp ? ` <span class="gm-temp">+${h.temp}</span>` : ''}</span>${p.state.dying ? `<span class="gm-cond bad">Dying ${p.state.dying}</span>` : ''}</div>
      ${bar(h.cur, h.max, h.temp)}
      <div class="gm-mini">${['fortitude', 'reflex', 'will'].map((s) => `<span>${s[0].toUpperCase()}<b>${signed(ch.saves[s].total)}</b></span>`).join('')}<span>Per<b>${signed(ch.perception.total)}</b></span></div>
      <div class="gm-res">${p.state.hero ? `<span title="Hero points">★ ${p.state.hero}</span>` : ''}${fmax ? `<span title="Focus points">◆ ${p.state.focus ?? fmax}/${fmax}</span>` : ''}${slotsLeft(p).slice(0, 1).map((e) => Object.entries(e.ranks).slice(-3).map(([r, [l, t]]) => `<span title="${esc(e.label)}: ${ordinal(r)} rank">${ordinal(r)} ${l}/${t}</span>`).join('')).join('')}</div>
      ${p.state.conditions?.length ? `<div class="gm-conds">${condChips(p.state.conditions)}</div>` : ''}
    </button>`;
  }).join('');
}

function openPc(p) {
  const ch = p.ch; const h = hpOf(p);
  const m = modal(p.build.name || 'Character', { wide: true });
  const dc = (mod) => 10 + mod;
  const res = slotsLeft(p);
  const fmax = ch.spellcasting.focus?.max || ch.focusMax || 0;
  m.body.innerHTML = `
    <p class="muted" style="margin-top:0">${esc([p.ch.ancestry?.name, p.ch.class?.name, 'level ' + p.build.level].filter(Boolean).join(' · '))}</p>
    <div class="gm-card-grid">
      <div><h3 class="inv-h">Hit Points</h3><div class="gm-big"><b>${h.cur}</b><span>/ ${h.max}</span>${h.temp ? `<span class="gm-temp">+${h.temp} temp</span>` : ''}</div>${bar(h.cur, h.max, h.temp)}
        <p class="small">${p.state.dying ? `<span class="bad">Dying ${p.state.dying}</span> · ` : ''}Wounded ${p.state.wounded || 0}</p>
        ${p.state.conditions?.length ? `<div class="gm-conds">${condChips(p.state.conditions)}</div>` : '<p class="muted small">No conditions.</p>'}</div>
      <div><h3 class="inv-h">Defenses as DCs</h3>
        <div class="gm-dcs"><span><small>AC</small><b>${ch.ac.total}</b></span><span><small>Fortitude DC</small><b>${dc(ch.saves.fortitude.total)}</b></span><span><small>Reflex DC</small><b>${dc(ch.saves.reflex.total)}</b></span><span><small>Will DC</small><b>${dc(ch.saves.will.total)}</b></span><span><small>Perception DC</small><b>${dc(ch.perception.total)}</b></span>${ch.classDC ? `<span><small>Class DC</small><b>${ch.classDC.total}</b></span>` : ''}</div>
        <p class="small muted">Saves ${signed(ch.saves.fortitude.total)} / ${signed(ch.saves.reflex.total)} / ${signed(ch.saves.will.total)} · Perception ${signed(ch.perception.total)} · Speed ${ch.speed?.total ?? '—'} ft</p></div>
      <div><h3 class="inv-h">Resources</h3>
        <p class="small">Hero points <b>${p.state.hero || 0}</b>${fmax ? ` · Focus <b>${p.state.focus ?? fmax}/${fmax}</b>` : ''}</p>
        ${res.map((e) => `<p class="small"><span class="muted">${esc(e.label)}</span><br>${Object.entries(e.ranks).map(([r, [l, t]]) => `<span class="gm-slot ${l ? '' : 'out'}">${ordinal(r)} <b>${l}</b>/${t}</span>`).join(' ')}</p>`).join('') || '<p class="muted small">No spell slots.</p>'}</div>
    </div>
    <div class="row end" style="margin-top:12px"><a class="btn" href="${activeParty && store.user ? `sheet.html?party=${encodeURIComponent(activeParty)}&member=${encodeURIComponent(p.rec.id)}` : `sheet.html?id=${encodeURIComponent(p.rec.id)}`}">Open full sheet</a></div>`;
}

// ------------------------------------------------------------------ encounter
function xpOf(c, e = enc) { const pl = partyLevel(e); const lvl = adjLevel(c.level, c.adj); const d = Math.max(-4, Math.min(4, lvl - pl)); return lvl - pl < -4 ? 0 : XP_BY_DIFF[d]; }
function threat(e = enc) {
  const xp = e.list.reduce((a, c) => a + xpOf(c, e), 0);
  const extra = partySize(e) - 4;
  // Fewer than 4 PCs lowers every budget; keep them in order (Low never below Trivial).
  let floor = 0;
  const budgets = THREATS.map(([n, b, adj]) => { floor = Math.max(floor, b + adj * extra, 10); return [n, floor]; });
  let label = 'Trivial';
  for (const [n, b] of budgets) if (xp >= b) label = n;
  if (xp < budgets[0][1] * 0.5) label = 'Trivial';
  const max = budgets[4][1];
  return { xp, label, budgets, max };
}
// Copies of the same creature are numbered: Ogre Warrior 1, Ogre Warrior 2…
function nextLabel(slug) {
  const used = new Set(enc.list.filter((c) => c.slug === slug).map((c) => String(c.tag)));
  for (let i = 1; ; i++) if (!used.has(String(i))) return String(i);
}
function addCreature(rec) {
  const tag = nextLabel(rec.slug);
  const c = { id: uid(), slug: rec.slug, name: rec.name, level: rec.level, tag, adj: 'normal', max: rec.hp, hp: rec.hp, temp: 0, ac: rec.ac, per: rec.per ?? 0, conditions: [] };
  enc.list.push(c); enc.sel = c.id;
  // Mid-fight: roll its initiative and slot it into the order.
  if (enc.combat) {
    const r = d20(); const v = r + c.per;
    enc.combat.init[c.id] = v; placeInOrder(c.id);
    toast(`${c.name} ${c.tag} rolled ${v} for initiative (${r} ${signed(c.per)})`);
  }
  save(); render();
}
async function removeCreature(c) {
  if (!(await confirmBox(`Remove ${c.name} ${c.tag} from the encounter?`))) return;
  const cb = enc.combat;
  if (cb) {
    if (cb.turn === c.id) { const i = cb.order.indexOf(c.id); cb.turn = cb.order[(i + 1) % cb.order.length] || null; }
    cb.order = cb.order.filter((k) => k !== c.id); cb.delayed = cb.delayed.filter((k) => k !== c.id); delete cb.init[c.id];
    if (cb.turn === c.id) cb.turn = null;
  }
  enc.list = enc.list.filter((x) => x !== c);
  if (enc.sel === c.id) enc.sel = null;
  save(); render();
}
function setAdj(c, adj) {
  const base = db.get('@creatures/' + c.slug);
  const lost = c.max - c.hp;
  c.adj = adj;
  c.max = Math.max(1, (base?.hp || c.max) + adjHp(c.level, adj));
  c.hp = Math.max(0, c.max - lost);
  save(); render();
}

// ------------------------------------------------------------------ initiative
// The order is a list of keys: a creature's id, or "pc:" + the character's id.
const d20 = () => { const a = new Uint32Array(1); (window.crypto || window.msCrypto).getRandomValues(a); return 1 + (a[0] % 20); };
const pcKey = (p) => 'pc:' + p.rec.id;
const crPer = (c) => (c.per ?? db.get('@creatures/' + c.slug)?.per ?? 0) + adjMod(c.adj);
function who(key) {
  if (String(key).startsWith('pc:')) {
    const p = party.find((x) => pcKey(x) === key);
    return p ? { key, pc: p, name: p.build.name || 'Unnamed', mod: p.ch.perception.total } : null;
  }
  const c = enc.list.find((x) => x.id === key);
  return c ? { key, cr: c, name: `${c.name} ${c.tag}`, mod: crPer(c) } : null;
}
const everyone = () => [...party.map(pcKey), ...enc.list.map((c) => c.id)];
// Ties: the adversary goes first (Player Core), then the higher modifier.
function before(a, b) {
  const init = enc.combat.init;
  const ia = init[a] ?? -1e9; const ib = init[b] ?? -1e9;
  if (ia !== ib) return ia > ib;
  const pa = String(a).startsWith('pc:'); const pb = String(b).startsWith('pc:');
  if (pa !== pb) return pb;
  return (who(a)?.mod ?? 0) > (who(b)?.mod ?? 0);
}
function placeInOrder(key) {
  const cb = enc.combat;
  cb.order = cb.order.filter((k) => k !== key);
  let i = 0;
  while (i < cb.order.length && !before(key, cb.order[i])) i++;
  cb.order.splice(i, 0, key);
}
const canAct = (key) => { const x = who(key); return !!x && !(x.cr && x.cr.hp <= 0); };
function endOfTurn(key) {
  // Frightened goes down by 1 at the end of each of the creature's turns.
  const c = enc.list.find((x) => x.id === key);
  const fr = c && c.conditions.find((x) => x.slug === 'frightened');
  if (fr) { fr.value = (fr.value || 1) - 1; if (fr.value <= 0) c.conditions.splice(c.conditions.indexOf(fr), 1); }
}
function step(dir) {
  const cb = enc.combat;
  cb.order = cb.order.filter((k) => who(k));
  if (!cb.order.some(canAct)) return;
  if (dir > 0 && cb.turn) endOfTurn(cb.turn);
  let i = cb.order.indexOf(cb.turn);
  for (let n = 0; n < cb.order.length; n++) {
    i += dir;
    if (i >= cb.order.length) { i = 0; cb.round++; }
    if (i < 0) { i = cb.order.length - 1; cb.round = Math.max(1, cb.round - 1); }
    if (canAct(cb.order[i])) break;
  }
  cb.turn = cb.order[i];
  // A creature's turn: show its statblock.
  if (!String(cb.turn).startsWith('pc:')) enc.sel = cb.turn;
  save(); render();
}
function delayTurn() {
  const cb = enc.combat; const k = cb.turn;
  if (!k) return;
  step(1);
  cb.order = cb.order.filter((x) => x !== k);
  if (!cb.delayed.includes(k)) cb.delayed.push(k);
  if (cb.turn === k) cb.turn = cb.order.find(canAct) || null;
  save(); render();
}
// Coming back from a delay: act now, before whoever was up next.
function resume(k) {
  const cb = enc.combat;
  cb.delayed = cb.delayed.filter((x) => x !== k);
  const i = cb.turn ? Math.max(0, cb.order.indexOf(cb.turn)) : cb.order.length;
  cb.order.splice(i, 0, k);
  if (cb.turn && cb.init[cb.turn] != null) cb.init[k] = cb.init[cb.turn];
  cb.turn = k;
  if (!String(k).startsWith('pc:')) enc.sel = k;
  save(); render();
}
function setInit(key, v) {
  const cb = enc.combat;
  cb.init[key] = v;
  if (!cb.delayed.includes(key)) placeInOrder(key);
  if (!cb.turn) cb.turn = cb.order.find(canAct) || null;
  save(); render();
}
async function endCombat() {
  if (!(await confirmBox('End the fight? The initiative order is cleared; HP and conditions stay.'))) return;
  enc.combat = null; save(); render();
}
async function openInitiative() {
  const cb = enc.combat;
  const vals = Object.assign({}, cb ? cb.init : {});
  const how = {};
  const m = modal(cb ? 'Initiative' : 'Roll initiative', { wide: true, cls: 'init-modal' });
  m.body.innerHTML = '<p class="muted small">Loading…</p>';
  await Promise.all(enc.list.map((c) => statblock(c.slug)));
  const stealthOf = (c) => { const v = statblocks[c.slug]?.skills?.Stealth; return v == null ? null : v + adjMod(c.adj); };
  const modOf = (x) => (x.cr && how[x.key] === 'stealth' ? stealthOf(x.cr) : x.mod);
  const roll = (x) => { const r = d20(); vals[x.key] = r + modOf(x); return `🎲 ${r}`; };
  const draw = () => {
    const list = everyone().map(who).filter(Boolean);
    m.body.innerHTML = `
      <p class="muted small" style="margin-top:0">Players roll their own and tell you the result. Creatures roll here: Perception, or Stealth if they were sneaking.</p>
      <div class="row init-tools"><button type="button" class="btn" data-all="cr">🎲 Roll for creatures</button><button type="button" class="btn ghost" data-all="pc">🎲 Roll for the party too</button><button type="button" class="btn ghost" data-clear>Clear</button></div>
      <div class="init-list">${list.map((x) => `<div class="init-row ${x.pc ? 'pc' : ''}">
        <span class="init-who"><b>${esc(x.name)}</b><span class="muted small">${x.pc ? 'Player character' : 'Creature'}</span></span>
        ${x.cr && stealthOf(x.cr) != null ? `<select data-how="${esc(x.key)}" aria-label="Initiative skill"><option value="per">Perception ${signed(x.mod)}</option><option value="stealth" ${how[x.key] === 'stealth' ? 'selected' : ''}>Stealth ${signed(stealthOf(x.cr))}</option></select>` : `<span class="init-mod muted small">Perception ${signed(x.mod)}</span>`}
        <input type="number" inputmode="numeric" class="init-in" data-k="${esc(x.key)}" value="${vals[x.key] ?? ''}" placeholder="–" aria-label="Initiative for ${esc(x.name)}">
        <button type="button" class="btn small" data-roll="${esc(x.key)}" title="Roll d20 ${signed(modOf(x))}">🎲</button>
        <span class="init-res muted small" data-res="${esc(x.key)}"></span>
      </div>`).join('') || '<p class="muted small">Add creatures, or wait for players to join the party.</p>'}</div>
      ${list.length ? `<div class="init-foot"><button type="button" class="btn primary" id="initGo">${cb ? 'Update order' : '⚔ Start the fight'}</button></div>` : ''}`;
    $$('.init-in', m.body).forEach((inp) => (inp.oninput = () => { const v = inp.value.trim(); if (v === '' || isNaN(Number(v))) delete vals[inp.dataset.k]; else vals[inp.dataset.k] = Math.round(Number(v)); }));
    $$('[data-how]', m.body).forEach((s) => (s.onchange = () => { how[s.dataset.how] = s.value; draw(); }));
    $$('[data-roll]', m.body).forEach((b) => (b.onclick = () => {
      const x = who(b.dataset.roll); const detail = roll(x);
      $(`.init-in[data-k="${CSS.escape(x.key)}"]`, m.body).value = vals[x.key];
      $(`[data-res="${CSS.escape(x.key)}"]`, m.body).textContent = detail;
    }));
    $$('[data-all]', m.body).forEach((b) => (b.onclick = () => {
      const detail = {};
      for (const x of list) if ((b.dataset.all === 'pc' ? x.pc : x.cr) && vals[x.key] == null) detail[x.key] = roll(x);
      if (b.dataset.all === 'pc') for (const x of list) if (x.cr && vals[x.key] == null) detail[x.key] = roll(x);
      draw();
      for (const [k, d] of Object.entries(detail)) { const el = $(`[data-res="${CSS.escape(k)}"]`, m.body); if (el) el.textContent = d; }
    }));
    const clr = $('[data-clear]', m.body); if (clr) clr.onclick = () => { for (const k of Object.keys(vals)) delete vals[k]; draw(); };
    const go = $('#initGo', m.body);
    if (go) go.onclick = () => {
      const keys = list.map((x) => x.key);
      const delayed = cb ? cb.delayed.filter((k) => keys.includes(k)) : [];
      const prevTurn = cb ? cb.turn : null;
      enc.combat = { round: cb ? cb.round : 1, init: vals, order: [], delayed, turn: null };
      for (const k of keys) if (!delayed.includes(k)) placeInOrder(k);
      enc.combat.turn = prevTurn && enc.combat.order.includes(prevTurn) ? prevTurn : enc.combat.order.find(canAct) || null;
      if (enc.combat.turn && !String(enc.combat.turn).startsWith('pc:')) enc.sel = enc.combat.turn;
      m.close(); save(); render();
    };
  };
  draw();
}

// ------------------------------------------------------------------ encounters list
async function openEncounters() {
  const m = modal('Encounters', { wide: true, cls: 'enc-modal' });
  m.body.innerHTML = '<p class="muted small">Loading…</p>';
  let q = '';
  const remote = await remoteList();
  const draw = () => {
    const rows = new Map();
    for (const r of remote || []) rows.set(r.id, { id: r.id, name: r.name, summary: r.summary, updated: Date.parse(r.updated) || 0 });
    for (const [id, it] of Object.entries(cache.items)) {
      if (it.deleted) { rows.delete(id); continue; }
      if (!it.data) continue;
      const r = rows.get(id);
      if (!r || it.dirty || (it.updated || 0) >= r.updated) rows.set(id, { id, name: it.data.name, summary: summaryOf(normEnc(it.data)), updated: it.updated || 0, pending: !!(store.user && it.dirty) });
    }
    const list = [...rows.values()].sort((a, b) => (a.id === enc.id ? -1 : b.id === enc.id ? 1 : b.updated - a.updated))
      .filter((r) => !q || r.name.toLowerCase().includes(q));
    m.body.innerHTML = `
      <div class="row enc-tools"><button type="button" class="btn primary" id="encNew">+ New encounter</button>
        ${rows.size > 6 ? `<input type="search" id="encQ" placeholder="Find an encounter…" value="${esc(q)}" aria-label="Find an encounter">` : ''}</div>
      <p class="muted small">${store.user ? (remote ? 'Saved to your account: they’re on every device you log in on.' : 'Can’t reach the server: showing the encounters on this device.') : 'Saved on this device. Log in to keep them in your account and use them on other devices.'}</p>
      <div class="enc-list">${list.map((r) => `<div class="enc-row ${r.id === enc.id ? 'cur' : ''}">
        <div class="enc-main"><b>${esc(r.name || 'Encounter')}</b>${r.id === enc.id ? ' <span class="badge accent">Open</span>' : ''}${r.pending ? ' <span class="badge warn">Not synced yet</span>' : ''}
          <div class="muted small">${esc(r.summary || '')}${r.updated ? ' · ' + esc(ago(r.updated)) : ''}</div></div>
        <div class="enc-acts">${r.id === enc.id ? '' : `<button type="button" class="btn small primary" data-open="${esc(r.id)}">Open</button>`}
          <button type="button" class="btn small" data-dup="${esc(r.id)}">Copy</button>
          <button type="button" class="btn small danger ghost" data-del="${esc(r.id)}" aria-label="Delete">Delete</button></div>
      </div>`).join('') || '<p class="muted small">Nothing matches.</p>'}</div>`;
    const qi = $('#encQ', m.body);
    if (qi) qi.oninput = () => { q = qi.value.trim().toLowerCase(); const pos = qi.selectionStart; draw(); const n = $('#encQ', m.body); n.focus(); n.setSelectionRange(pos, pos); };
    $('#encNew', m.body).onclick = () => { useEnc(blankEnc()); save(); m.close(); render(); setTimeout(() => { const n = $('.gm-enc-name'); if (n) { n.focus(); n.select(); } }, 50); };
    const get = async (id) => {
      const it = cache.items[id]; const r = (remote || []).find((x) => x.id === id);
      if (it && it.data && (!r || it.dirty || (it.version || 0) >= r.version)) return it.data;
      return fetchEnc(id);
    };
    $$('[data-open]', m.body).forEach((b) => (b.onclick = async () => {
      // Saving marks it as the latest, so other devices open it too.
      try { useEnc(await get(b.dataset.open)); save(); m.close(); render(); } catch (e) { toast(e.message, 'error'); }
    }));
    $$('[data-dup]', m.body).forEach((b) => (b.onclick = async () => {
      try {
        const src = normEnc(JSON.parse(JSON.stringify(await get(b.dataset.dup))));
        useEnc(Object.assign(src, { id: newId(), name: src.name + ' (copy)', combat: null }));
        save(); m.close(); render();
      } catch (e) { toast(e.message, 'error'); }
    }));
    $$('[data-del]', m.body).forEach((b) => (b.onclick = async () => {
      const id = b.dataset.del; const r = rows.get(id);
      if (!(await confirmBox(`Delete the encounter “${r?.name || 'Encounter'}”?`))) return;
      const it = cache.items[id];
      const onServer = (remote || []).some((x) => x.id === id) || (it && it.version);
      if (store.user && onServer) cache.items[id] = { deleted: true, dirty: Date.now(), version: it?.version || 1 };
      else delete cache.items[id];
      if (remote) { const i = remote.findIndex((x) => x.id === id); if (i >= 0) remote.splice(i, 1); }
      if (id === enc.id) {
        const next = Object.values(cache.items).filter((x) => !x.deleted && x.data).sort((a, b2) => (b2.updated || 0) - (a.updated || 0))[0];
        useEnc(next ? next.data : blankEnc());
        if (!next) save();
      }
      persist();
      if (store.user) push();
      draw(); render();
    }));
  };
  draw();
}

function crRow(c) {
  const cb = enc.combat;
  const ac = c.ac + adjMod(c.adj);
  const turn = cb && cb.turn === c.id;
  return `<div class="gm-cr ${enc.sel === c.id ? 'sel' : ''} ${c.hp <= 0 ? 'down' : ''} ${turn ? 'turn' : ''}" data-cr="${c.id}">
    ${cb ? `<button type="button" class="gm-init" data-init="${esc(c.id)}" title="Initiative (tap to change)">${cb.init[c.id] ?? '–'}</button>` : ''}
    <span class="gm-lvl" title="Level">${adjLevel(c.level, c.adj)}</span>
    <div class="gm-cr-main"><div class="gm-cr-name">${turn ? '<span class="gm-now">▶</span> ' : ''}<b>${esc(c.name)}</b> <span class="gm-tag">${esc(c.tag)}</span>${c.adj !== 'normal' ? `<span class="badge ${c.adj === 'elite' ? 'elite' : 'weak'}">${c.adj}</span>` : ''}</div>
      ${bar(c.hp, c.max, c.temp)}
      <div class="gm-cr-sub"><span class="mono"><b>${c.hp}</b>/${c.max}${c.temp ? ` <span class="gm-temp">+${c.temp}</span>` : ''}</span><span>AC <b>${ac}</b></span>${condChips(c.conditions)}${c.hp <= 0 ? '<span class="gm-cond bad">Defeated</span>' : ''}</div></div>
    <div class="gm-cr-acts"><button type="button" class="btn small danger" data-hp="dmg" aria-label="Damage">−</button><button type="button" class="btn small" data-hp="heal" aria-label="Heal">+</button></div>
  </div>`;
}
function pcRow(p) {
  const cb = enc.combat; const k = pcKey(p);
  const h = hpOf(p); const turn = cb && cb.turn === k;
  return `<div class="gm-cr pc ${turn ? 'turn' : ''} ${h.cur <= 0 ? 'dying' : ''}" data-pcrow="${esc(k)}">
    <button type="button" class="gm-init" data-init="${esc(k)}" title="Initiative (tap to change)">${cb.init[k] ?? '–'}</button>
    <span class="gm-lvl pc" title="Player character">PC</span>
    <div class="gm-cr-main"><div class="gm-cr-name">${turn ? '<span class="gm-now">▶</span> ' : ''}<b>${esc(p.build.name || 'Unnamed')}</b> <span class="muted small">${esc(p.ch.class?.name || '')} ${p.build.level}</span></div>
      ${bar(h.cur, h.max, h.temp)}
      <div class="gm-cr-sub"><span class="mono"><b>${h.cur}</b>/${h.max}${h.temp ? ` <span class="gm-temp">+${h.temp}</span>` : ''}</span><span>AC <b>${p.ch.ac.total}</b></span>${p.state.dying ? `<span class="gm-cond bad">Dying ${p.state.dying}</span>` : ''}${condChips(p.state.conditions)}</div></div>
  </div>`;
}
function combatHtml() {
  const cb = enc.combat;
  cb.order = cb.order.filter((k) => who(k));
  cb.delayed = cb.delayed.filter((k) => who(k));
  const placed = new Set([...cb.order, ...cb.delayed]);
  const missing = everyone().filter((k) => !placed.has(k));
  const row = (k) => { const x = who(k); return x.pc ? pcRow(x.pc) : crRow(x.cr); };
  const cur = cb.turn && who(cb.turn);
  return `
    <div class="gm-combat">
      <div class="gm-round"><span class="label">Round</span><b>${cb.round}</b></div>
      <div class="gm-turn-who">${cur ? `<span class="muted small">Now acting</span><b>${esc(cur.name)}</b>` : '<span class="muted small">Nobody can act</span>'}</div>
      <div class="gm-turn-btns"><button type="button" class="btn" data-step="-1" aria-label="Previous turn">◀</button><button type="button" class="btn ghost" id="delayBtn" ${cur ? '' : 'disabled'}>Delay</button><button type="button" class="btn primary gm-next" data-step="1">Next turn ▶</button></div>
    </div>
    <div class="row gm-enc-actions"><button type="button" class="btn" id="addCr">+ Add creatures</button><button type="button" class="btn ghost" id="initBtn">Initiative…</button><button type="button" class="btn ghost danger" id="endCombat">End fight</button></div>
    <div class="gm-list">${cb.order.map(row).join('')}</div>
    ${cb.delayed.length ? `<h3 class="inv-h">Delaying</h3><div class="gm-list delayed">${cb.delayed.map((k) => `<div class="gm-delay"><span><b>${esc(who(k).name)}</b></span><button type="button" class="btn small primary" data-resume="${esc(k)}">Act now</button></div>`).join('')}</div>` : ''}
    ${missing.length ? `<h3 class="inv-h">Not in the order yet</h3><div class="gm-list">${missing.map((k) => `<div class="gm-delay"><span><b>${esc(who(k).name)}</b></span><button type="button" class="btn small" data-init="${esc(k)}">Set initiative</button></div>`).join('')}</div>` : ''}`;
}
function encounterHtml() {
  const t = threat();
  const seg = t.budgets.map(([n, b]) => `<i style="left:${(b / t.max) * 100}%" title="${n} ${b} XP"></i>`).join('');
  return `
    <div class="gm-enc-top">
      <input type="text" class="gm-enc-name" value="${esc(enc.name)}" aria-label="Encounter name" maxlength="120">
      <button type="button" class="btn small ghost" id="encList">Encounters ▾</button>
    </div>
    <div class="gm-enc-head">
      <span class="gm-sync ${syncState}"></span>
      <div class="gm-party-cfg">Party level <button type="button" class="step" data-pl="-1">−</button><b>${partyLevel()}</b><button type="button" class="step" data-pl="1">+</button>
        · <button type="button" class="step" data-ps="-1">−</button><b>${partySize()}</b><button type="button" class="step" data-ps="1">+</button> PCs</div>
    </div>
    <div class="gm-threat t-${t.label.toLowerCase()}">
      <div class="gm-threat-top"><b>${t.label}</b><span class="muted">${t.xp} XP · ${t.budgets.map(([n, b]) => `${n[0]}${b}`).join(' ')}</span></div>
      <div class="gm-threat-bar"><div style="width:${Math.min(100, (t.xp / t.max) * 100)}%"></div>${seg}</div>
    </div>
    ${enc.combat ? combatHtml() : `
    <div class="row gm-enc-actions"><button type="button" class="btn primary" id="addCr">+ Add creatures</button>${enc.list.length || party.length ? '<button type="button" class="btn" id="initBtn">⚔ Initiative</button>' : ''}${enc.list.length ? '<button type="button" class="btn ghost" id="clearEnc">Clear</button>' : ''}</div>
    <div class="gm-list">${enc.list.map(crRow).join('') || `<div class="inv-empty"><span>No creatures yet. Tap <b>+ Add creatures</b> to search the bestiary.</span></div>`}</div>`}`;
}

// ------------------------------------------------------------------ statblock
const glyph = (a) => (a.type === 'reaction' ? '⟲' : a.type === 'free' ? '◇' : a.type === 'action' ? '◆'.repeat(a.actions || 1) : '');
// preview: from the bestiary, before the creature is in the encounter (no HP tracking or adjustments).
function statblockHtml(sb, c, preview = false) {
  const k = adjMod(c.adj);
  const lvl = adjLevel(sb.level, c.adj);
  const traits = sb.traits || [];
  const rk = (DC_BY_LEVEL[Math.max(0, Math.min(25, lvl + 1))] || 14) + (RARITY_DC[sb.rarity] || 0);
  const rkSkills = [...new Set(traits.map((t) => RK_SKILLS[t]).filter(Boolean).join(', ').split(', '))].filter(Boolean).join(', ') || 'Lore';
  const dmg = (d) => (k ? d.replace(/^(\d+d\d+)([+-]\d+)?/, (m, dice, b) => { const v = Number(b || 0) + k; return dice + (v ? (v > 0 ? '+' : '') + v : ''); }) : d);
  const line = (label, v) => (v ? `<p><b>${label}</b> ${v}</p>` : '');
  const defs = (list) => list.map((x) => esc(titleCase(x.type)) + (x.value ? ' ' + x.value : '') + (x.except?.length ? ` (except ${esc(x.except.join(', '))})` : '')).join(', ');
  const abil = (a) => `<div class="sb-abil"><b>${esc(a.name)}</b> ${glyph(a) ? `<span class="glyph">${glyph(a)}</span>` : ''}${a.traits?.length ? ` <span class="muted small">(${esc(a.traits.join(', '))})</span>` : ''}<div class="sb-desc">${a.desc || ''}</div></div>`;
  const by = (cat) => (sb.abilities || []).filter((a) => a.cat === cat);
  const saves = sb.saves || { fortitude: 0, reflex: 0, will: 0 };
  return `
    <div class="sb-head"><h2>${esc(sb.name)}${c.tag ? ` <span class="gm-tag">${esc(c.tag)}</span>` : ''}</h2><span class="sb-type">Creature ${lvl}</span></div>
    ${preview ? '' : `<div class="sb-adj" role="group" aria-label="Adjustment">${['weak', 'normal', 'elite'].map((a) => `<button type="button" class="chip-btn ${c.adj === a ? 'on' : ''}" data-adj="${a}">${titleCase(a)}</button>`).join('')}<span class="spacer"></span><button type="button" class="btn small ghost sb-remove" data-remove>✕ Remove</button></div>`}
    <div class="sb-traits">${traitChips([SIZES[sb.size] ? sb.size : null, ...traits].filter(Boolean).map((t) => (SIZES[t] ? SIZES[t].toLowerCase() : t)), sb.rarity)}</div>
    <div class="sb-rk"><span>Recall Knowledge</span><b>DC ${rk}</b><span class="muted">${esc(rkSkills)}</span></div>
    ${preview ? '' : `<div class="sb-hp">
      <div class="gm-big"><b>${c.hp}</b><span>/ ${c.max} HP</span>${c.temp ? `<span class="gm-temp">+${c.temp} temp</span>` : ''}</div>${bar(c.hp, c.max, c.temp)}
      <div class="row sb-hp-btns"><button type="button" class="btn danger" data-hp="dmg">Damage</button><button type="button" class="btn" data-hp="heal">Heal</button><button type="button" class="btn" data-hp="temp">Temp</button><button type="button" class="btn ghost" data-addcond>+ Condition</button></div>
      ${c.conditions.length ? `<div class="gm-conds">${c.conditions.map((x, i) => `<button type="button" class="gm-cond" data-rmcond="${i}">${esc(db.get('@conditions/' + x.slug)?.name || x.slug)}${x.value ? ' ' + x.value : ''} ✕</button>`).join('')}</div>` : ''}
    </div>`}
    <div class="sb-body">
      ${line('Perception', `${signed(sb.perception + k)}${sb.senses?.length ? '; ' + esc(sb.senses.join(', ')) : ''}${sb.perceptionNote ? ' (' + esc(sb.perceptionNote) + ')' : ''}`)}
      ${line('Languages', esc((sb.languages || []).join(', ')) + (sb.languageNote ? '; ' + esc(sb.languageNote) : ''))}
      ${line('Skills', Object.entries(sb.skills || {}).map(([s, v]) => `${esc(s)} ${signed(v + k)}`).join(', '))}
      <p class="sb-attrs">${['str', 'dex', 'con', 'int', 'wis', 'cha'].map((a) => `<span><b>${titleCase(a)}</b> ${signed(sb.attrs?.[a] || 0)}</span>`).join('')}</p>
      ${line('Items', esc((sb.gear || []).join(', ')))}
      ${by('interaction').map(abil).join('')}
      <hr>
      <p><b>AC</b> ${sb.ac + k}${sb.acNote ? ' (' + esc(sb.acNote) + ')' : ''}; <b>Fort</b> ${signed(saves.fortitude + k)}, <b>Ref</b> ${signed(saves.reflex + k)}, <b>Will</b> ${signed(saves.will + k)}${sb.saveNote ? '; ' + esc(sb.saveNote) : ''}</p>
      <p><b>HP</b> ${preview ? sb.hp : c.max}${sb.hpNote ? ', ' + esc(sb.hpNote) : ''}${sb.hardness ? `; <b>Hardness</b> ${sb.hardness}` : ''}${sb.immunities?.length ? `; <b>Immunities</b> ${defs(sb.immunities)}` : ''}${sb.weaknesses?.length ? `; <b>Weaknesses</b> ${defs(sb.weaknesses)}` : ''}${sb.resistances?.length ? `; <b>Resistances</b> ${defs(sb.resistances)}` : ''}</p>
      ${by('defensive').map(abil).join('')}
      <hr>
      <p><b>Speed</b> ${sb.speed} feet${sb.speeds?.length ? ', ' + esc(sb.speeds.join(', ')) : ''}</p>
      ${(sb.strikes || []).map((s) => `<p class="sb-strike"><b>${s.ranged ? 'Ranged' : 'Melee'}</b> <span class="glyph">◆</span> ${esc(s.name)} ${signed(s.bonus + k)}${s.traits?.length ? ` <span class="muted">(${esc(s.traits.join(', ').replace(/-/g, ' '))}${s.range ? `, range ${s.range} ft` : ''})</span>` : ''}, <b>Damage</b> ${esc(dmg(s.damage || ''))}${s.effects?.length ? ' plus ' + esc(s.effects.join(', ')) : ''}</p>`).join('')}
      ${(sb.spellcasting || []).map((e) => `<p class="sb-spells"><b>${esc(e.name)}</b> ${e.dc ? `DC ${e.dc + k}` : ''}${e.atk ? `, attack ${signed(e.atk + k)}` : ''}; ${Object.entries(e.ranks || {}).sort((a, b) => Number(b[0]) - Number(a[0])).map(([r, list]) => `<b>${r === '0' ? `Cantrips (${ordinal(e.cantripRank)})` : ordinal(r)}</b> ${list.map((x) => (x.r ? `<a class="ref" data-ref="${esc(x.r)}">${esc(x.n)}</a>` : esc(x.n))).join(', ')}`).join('; ')}</p>`).join('')}
      ${by('offensive').map(abil).join('')}
      ${sb.blurb ? `<details class="sb-lore"><summary>About</summary><p>${esc(sb.blurb)}</p></details>` : ''}
      <p class="muted small">${esc(sb.src || '')}</p>
    </div>`;
}

// ------------------------------------------------------------------ number pad (big buttons for tablets)
function hpPad(target, mode, onApply) {
  const titles = { dmg: 'Damage', heal: 'Heal', temp: 'Temp HP', init: 'Initiative' };
  const go = { dmg: 'Apply damage', heal: 'Heal', temp: 'Set temp HP', init: 'Set initiative' };
  const m = modal(`${titles[mode]}: ${target}`, { cls: 'hp-pad' });
  let val = '';
  const draw = () => {
    m.body.innerHTML = `<div class="pad-val ${mode}">${val || '0'}</div>
      <div class="pad-keys">${[7, 8, 9, 4, 5, 6, 1, 2, 3, 'C', 0, '⌫'].map((k) => `<button type="button" class="pad-k" data-k="${k}">${k}</button>`).join('')}</div>
      ${mode === 'init' ? '<div class="pad-quick"></div>' : `<div class="pad-quick">${[1, 5, 10, 20].map((n) => `<button type="button" class="chip-btn" data-q="${n}">+${n}</button>`).join('')}</div>`}
      <button type="button" class="btn ${mode === 'dmg' ? 'danger' : 'primary'} pad-go">${go[mode]}</button>`;
    $$('.pad-k', m.body).forEach((b) => (b.onclick = () => { const k = b.dataset.k; val = k === 'C' ? '' : k === '⌫' ? val.slice(0, -1) : (val + k).replace(/^0+/, '').slice(0, 4); draw(); }));
    $$('[data-q]', m.body).forEach((b) => (b.onclick = () => { val = String((Number(val) || 0) + Number(b.dataset.q)); draw(); }));
    $('.pad-go', m.body).onclick = () => { const n = Number(val) || 0; m.close(); if (n || mode === 'init') onApply(n); };
  };
  draw();
}
function applyHp(c, mode, n) {
  if (mode === 'dmg') { const t = Math.min(c.temp, n); c.temp -= t; c.hp = Math.max(0, c.hp - (n - t)); }
  else if (mode === 'heal') c.hp = Math.min(c.max, c.hp + n);
  else c.temp = Math.max(c.temp, n);
  save(); render();
}

// ------------------------------------------------------------------ bestiary picker
// Filters stay set between searches (and visits).
const BF_KEY = 'pf2e.gm.bestiary';
const bf = Object.assign({ q: '', min: null, max: null, traits: [], rarity: [], size: [], book: '', reprints: false, sort: 'level' }, readJson(BF_KEY) || {});
const ALIGN = ['good', 'evil', 'lawful', 'chaotic'];
const BOOK_GROUPS = [['core', 'Remaster core books'], ['lo', 'Lost Omens & Paizo blog'], ['ap', 'Adventure Paths & adventures'], ['pfs', 'Pathfinder Society'], ['legacy', 'Legacy (pre-remaster)']];
function openBestiary() {
  const all = db.list('creatures');
  const books = db.list('creatureBooks');
  const bookName = Object.fromEntries(books.map((b) => [b.id, b.name]));
  const bookGroup = Object.fromEntries(books.map((b) => [b.id, b.group]));
  if (bf.min == null || bf.max == null) { bf.min = Math.max(-1, partyLevel() - 4); bf.max = Math.min(25, partyLevel() + 4); }
  let limit = 60; let peek = null; let tq = '';
  const m = modal('Bestiary', { wide: true, cls: 'bestiary' });
  const lvOpts = (v) => Array.from({ length: 27 }, (_, i) => i - 1).map((l) => `<option ${l === v ? 'selected' : ''}>${l}</option>`).join('');
  m.body.innerHTML = `
    <div class="filters best-f">
      <input type="search" class="best-q" placeholder="Search by name…" aria-label="Search creatures" value="${esc(bf.q)}">
      <label class="small best-lv">Level <select data-f="min">${lvOpts(bf.min)}</select> to <select data-f="max">${lvOpts(bf.max)}</select></label>
    </div>
    <div class="best-traits">
      <div class="best-tsel"><span class="label">Traits</span><span class="best-chips"></span><input type="text" class="best-tin" placeholder="Add a trait…" aria-label="Add a trait" autocomplete="off"></div>
      <div class="best-sugg"></div>
    </div>
    <details class="best-more"><summary>More filters <span class="best-more-n"></span></summary>
      <div class="best-grid">
        <div><span class="label">Rarity</span><div class="inv-chips">${['common', 'uncommon', 'rare', 'unique'].map((r) => `<button type="button" class="chip-btn" data-rar="${r}">${titleCase(r)}</button>`).join('')}</div></div>
        <div><span class="label">Size</span><div class="inv-chips">${Object.entries(SIZES).map(([k, v]) => `<button type="button" class="chip-btn" data-size="${k}">${v}</button>`).join('')}</div></div>
        <div><span class="label">Book</span><select data-f="book" aria-label="Book"><option value="">All books</option>
          ${BOOK_GROUPS.map(([g, label]) => `<optgroup label="${esc(label)}"><option value="g:${g}">All: ${esc(label)}</option>${books.filter((b) => b.group === g).map((b) => `<option value="${esc(b.id)}">${esc(b.name)} (${b.count})</option>`).join('')}</optgroup>`).join('')}</select></div>
        <div><span class="label">Sort</span><select data-f="sort" aria-label="Sort"><option value="level">Level, low to high</option><option value="level-desc">Level, high to low</option><option value="name">Name</option><option value="hp">HP, high to low</option></select>
          <label class="best-chk small" title="The same creature printed again in another book"><input type="checkbox" data-f="reprints"> Show reprints (same creature, other books)</label></div>
      </div>
      <button type="button" class="btn small ghost" data-reset>Reset all filters</button>
    </details>
    <div class="best-count muted small"></div>
    <div class="best-list"></div>`;
  $('[data-f="book"]', m.body).value = bf.book;
  $('[data-f="sort"]', m.body).value = bf.sort;
  $('[data-f="reprints"]', m.body).checked = bf.reprints;
  const keep = () => writeJson(BF_KEY, Object.assign({}, bf, { q: '' }));
  const pass = (c, withTraits) => {
    if (c.level < bf.min || c.level > bf.max) return false;
    if (bf.rarity.length && !bf.rarity.includes(c.rarity)) return false;
    if (bf.size.length && !bf.size.includes(c.size)) return false;
    if (bf.book) { if (bf.book.startsWith('g:') ? bookGroup[c.book] !== bf.book.slice(2) : c.book !== bf.book) return false; }
    // Reprints are hidden unless asked for, or unless one book is picked (then show all of it).
    if (c.dup && !bf.reprints && !(bf.book && !bf.book.startsWith('g:'))) return false;
    const q = bf.q.trim().toLowerCase();
    if (q && !c.name.toLowerCase().includes(q)) return false;
    if (withTraits) { const ts = c.traits || []; for (const t of bf.traits) if (ts.includes(t.t) === !!t.not) return false; }
    return true;
  };
  const sorters = {
    level: (a, b) => a.level - b.level || a.name.localeCompare(b.name),
    'level-desc': (a, b) => b.level - a.level || a.name.localeCompare(b.name),
    name: (a, b) => a.name.localeCompare(b.name) || a.level - b.level,
    hp: (a, b) => b.hp - a.hp || a.name.localeCompare(b.name),
  };
  const drawChips = () => {
    $('.best-chips', m.body).innerHTML = bf.traits.map((t, i) => `<span class="tchip ${t.not ? 'not' : ''}"><button type="button" data-flip="${i}" title="Tap to switch between “must have” and “must not have”">${t.not ? 'not ' : ''}${esc(traitName(t.t))}</button><button type="button" data-rmt="${i}" aria-label="Remove ${esc(traitName(t.t))}">×</button></span>`).join('');
    $$('[data-flip]', m.body).forEach((b) => (b.onclick = () => { const t = bf.traits[Number(b.dataset.flip)]; t.not = !t.not; changed(); }));
    $$('[data-rmt]', m.body).forEach((b) => (b.onclick = () => { bf.traits.splice(Number(b.dataset.rmt), 1); changed(); }));
    const n = bf.rarity.length + bf.size.length + (bf.book ? 1 : 0) + (bf.reprints ? 1 : 0);
    $('.best-more-n', m.body).textContent = n ? `(${n} on)` : '';
    $$('[data-rar]', m.body).forEach((b) => b.classList.toggle('on', bf.rarity.includes(b.dataset.rar)));
    $$('[data-size]', m.body).forEach((b) => b.classList.toggle('on', bf.size.includes(b.dataset.size)));
  };
  const addTrait = (t) => { if (!bf.traits.some((x) => x.t === t)) bf.traits.push({ t, not: false }); tq = ''; $('.best-tin', m.body).value = ''; changed(); };
  let sugg = [];
  const drawSugg = (shown) => {
    const have = new Set(bf.traits.map((t) => t.t));
    const count = {};
    for (const c of shown) for (const t of c.traits || []) if (!have.has(t)) count[t] = (count[t] || 0) + 1;
    const q = tq.trim().toLowerCase().replace(/\s+/g, '-');
    sugg = Object.entries(count).filter(([t]) => (q ? t.includes(q) : !ALIGN.includes(t)))
      .sort((a, b) => (q ? (b[0].startsWith(q) - a[0].startsWith(q)) : 0) || b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, q ? 24 : 14);
    $('.best-sugg', m.body).innerHTML = sugg.length
      ? `<span class="muted small">${q ? 'Matching traits' : bf.traits.length ? 'Narrow further' : 'Common traits'}:</span> ${sugg.map(([t, n]) => `<button type="button" class="chip-btn" data-addt="${esc(t)}">${esc(traitName(t))} <span class="n">${n}</span></button>`).join('')}`
      : `<span class="muted small">${q ? `No trait matching “${esc(tq)}” among these creatures.` : ''}</span>`;
    $$('[data-addt]', m.body).forEach((b) => (b.onclick = () => addTrait(b.dataset.addt)));
  };
  const drawList = () => {
    const shown = all.filter((c) => pass(c, true)).sort(sorters[bf.sort] || sorters.level);
    $('.best-count', m.body).textContent = `${shown.length} creature${shown.length === 1 ? '' : 's'}${bf.traits.length ? ' with ' + bf.traits.map((t) => (t.not ? 'not ' : '') + traitName(t.t)).join(' + ') : ''}`;
    $('.best-list', m.body).innerHTML = shown.slice(0, limit).map((c) => {
      const n = enc.list.filter((x) => x.slug === c.slug).length;
      const d = c.level - partyLevel();
      const xp = d < -4 ? 0 : XP_BY_DIFF[Math.max(-4, Math.min(4, d))];
      return `<div class="best-row ${peek === c.slug ? 'open' : ''}">
        <span class="gm-lvl">${c.level}</span>
        <button type="button" class="best-main" data-peek="${esc(c.slug)}" aria-expanded="${peek === c.slug}"><span><b>${esc(c.name)}</b>${c.rarity !== 'common' ? ` <span class="badge ${esc(c.rarity)}">${esc(c.rarity)}</span>` : ''}${c.dup ? ' <span class="badge">reprint</span>' : ''}</span>
          <span class="muted small">${esc((c.traits || []).filter((t) => !ALIGN.includes(t)).slice(0, 5).map(traitName).join(', '))} · HP ${c.hp} · AC ${c.ac} · ${xp} XP · ${esc(bookName[c.book] || '')}</span></button>
        ${n ? `<span class="best-n">×${n}</span>` : ''}<button type="button" class="btn small primary" data-add="${esc(c.slug)}">Add</button>
      </div>${peek === c.slug ? '<div class="best-peek"><p class="muted small">Loading…</p></div>' : ''}`;
    }).join('') + (shown.length > limit ? `<div class="best-more-row"><button type="button" class="btn" data-moreres>Show more (${shown.length - limit} left)</button></div>` : '') || '<p class="muted small">Nothing matches. Try removing a trait or widening the levels.</p>';
    $$('[data-add]', m.body).forEach((b) => (b.onclick = () => { addCreature(db.get('@creatures/' + b.dataset.add)); drawList(); }));
    $$('[data-peek]', m.body).forEach((b) => (b.onclick = () => { peek = peek === b.dataset.peek ? null : b.dataset.peek; drawList(); }));
    const more = $('[data-moreres]', m.body); if (more) more.onclick = () => { limit += 60; drawList(); };
    const pk = $('.best-peek', m.body);
    if (pk) statblock(peek).then((sb) => {
      if (!pk.isConnected) return;
      pk.innerHTML = sb ? statblockHtml(sb, { adj: 'normal', tag: '', conditions: [] }, true) : '<p class="muted small">Statblock not available.</p>';
      wireRefs(db, pk);
    });
    drawSugg(all.filter((c) => pass(c, true)));
  };
  const changed = () => { limit = 60; keep(); drawChips(); drawList(); };
  const qi = $('.best-q', m.body);
  qi.oninput = () => { bf.q = qi.value; limit = 60; drawList(); };
  const ti = $('.best-tin', m.body);
  ti.oninput = () => { tq = ti.value; drawSugg(all.filter((c) => pass(c, true))); };
  ti.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (sugg[0]) addTrait(sugg[0][0]); }
    else if (e.key === 'Backspace' && !ti.value && bf.traits.length) { bf.traits.pop(); changed(); }
  };
  $$('select[data-f]', m.body).forEach((s) => (s.onchange = () => {
    const f = s.dataset.f;
    if (f === 'min' || f === 'max') {
      bf[f] = Number(s.value);
      if (bf.min > bf.max) { if (f === 'min') bf.max = bf.min; else bf.min = bf.max; $('[data-f="min"]', m.body).value = bf.min; $('[data-f="max"]', m.body).value = bf.max; }
    } else bf[f] = s.value;
    changed();
  }));
  $('[data-f="reprints"]', m.body).onchange = (e) => { bf.reprints = e.target.checked; changed(); };
  $$('[data-rar]', m.body).forEach((b) => (b.onclick = () => { const r = b.dataset.rar; bf.rarity = bf.rarity.includes(r) ? bf.rarity.filter((x) => x !== r) : [...bf.rarity, r]; changed(); }));
  $$('[data-size]', m.body).forEach((b) => (b.onclick = () => { const r = b.dataset.size; bf.size = bf.size.includes(r) ? bf.size.filter((x) => x !== r) : [...bf.size, r]; changed(); }));
  $('[data-reset]', m.body).onclick = () => {
    Object.assign(bf, { q: '', traits: [], rarity: [], size: [], book: '', reprints: false, sort: 'level', min: Math.max(-1, partyLevel() - 4), max: Math.min(25, partyLevel() + 4) });
    qi.value = ''; $('[data-f="book"]', m.body).value = ''; $('[data-f="sort"]', m.body).value = 'level'; $('[data-f="reprints"]', m.body).checked = false;
    $('[data-f="min"]', m.body).value = bf.min; $('[data-f="max"]', m.body).value = bf.max;
    changed();
  };
  if (bf.rarity.length || bf.size.length || bf.book || bf.reprints) $('.best-more', m.body).open = true;
  drawChips(); drawList();
}

function pickCondition(c) {
  const m = modal('Add a condition', {});
  const list = db.list('conditions');
  m.body.innerHTML = `<div class="cond-pick">${list.map((x) => `<button type="button" class="chip-btn" data-c="${esc(x.slug)}">${esc(x.name)}</button>`).join('')}</div>`;
  $$('[data-c]', m.body).forEach((b) => (b.onclick = () => {
    const rec = db.get('@conditions/' + b.dataset.c);
    const valued = /\b(\d|value)\b/i.test(rec?.name || '') || ['frightened', 'sickened', 'clumsy', 'drained', 'enfeebled', 'stupefied', 'slowed', 'stunned', 'doomed', 'dying', 'wounded'].includes(b.dataset.c);
    const ex = c.conditions.find((x) => x.slug === b.dataset.c);
    if (ex) { if (valued) ex.value = (ex.value || 1) + 1; } else c.conditions.push({ slug: b.dataset.c, value: valued ? 1 : 0 });
    m.close(); save(); render();
  }));
}

// ------------------------------------------------------------------ party management
function renderParty() {
  const el = $('.gm-party'); if (!el) return;
  const scroll = el.scrollTop;
  el.innerHTML = partyColumn();
  el.scrollTop = scroll;
  wireParty();
}
async function createParty() {
  const m = modal('New party', {});
  m.body.innerHTML = `<label class="field"><span>Party name</span><input type="text" id="pName" maxlength="100" value="My party"></label>
    <p class="muted small">You’ll get a join code to give your players.</p>
    <div class="row end"><button type="button" class="btn primary" id="pMake">Create party</button></div>`;
  const inp = $('#pName', m.body); inp.select();
  $('#pMake', m.body).onclick = async () => {
    try {
      const r = await api('party_create', { name: inp.value });
      m.close(); await loadParties(); setActive(r.party.id); await loadParties(); await pollParty(); render(); openManage();
    } catch (e) { toast(e.message, 'error'); }
  };
}
async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); toast(what + ' copied', 'ok'); }
  catch (e) { toast(text); }
}
async function openManage() {
  if (!partyMeta) return;
  const m = modal('Manage party', { wide: true });
  const link = location.origin + location.pathname.replace(/gm\.html$/, '') + 'index.html?join=' + partyMeta.code;
  const mine = await store.list().catch(() => []);
  const draw = () => {
    const inParty = new Set(party.map((p) => p.rec.id));
    m.body.innerHTML = `
      <label class="field"><span>Party name</span><input type="text" id="mName" maxlength="100" value="${esc(partyMeta.name)}"></label>
      <div class="gm-join">
        <div><span class="label">Join code</span><div class="gm-join-code">${esc(fmtCode(partyMeta.code))}</div></div>
        <div class="row" style="gap:6px;flex-wrap:wrap"><button type="button" class="btn small" id="mCopy">Copy code</button><button type="button" class="btn small" id="mLink">Copy join link</button><button type="button" class="btn small ghost" id="mNew">New code</button></div>
      </div>
      <label class="gm-lock"><input type="checkbox" id="mLock" ${partyMeta.locked ? 'checked' : ''}> <span><b>Lock party</b><br><span class="muted small">Nobody new can join; current members stay.</span></span></label>
      <h3 class="inv-h">Members</h3>
      ${party.map((p) => `<div class="gm-mem"><span><b>${esc(p.build.name)}</b> <span class="muted small">${esc(p.ch.class?.name || '')} ${p.build.level}${p.player ? ' · ' + esc(p.player) : ''}</span></span><button type="button" class="btn small danger" data-rm="${esc(p.rec.id)}">Remove</button></div>`).join('') || '<p class="muted small">Nobody yet.</p>'}
      ${mine.filter((c) => !inParty.has(c.id) && !String(c.id).startsWith('tmp-') && !String(c.id).startsWith('local-')).length ? `<h3 class="inv-h">Add one of your characters</h3>
        ${mine.filter((c) => !inParty.has(c.id) && !String(c.id).startsWith('tmp-') && !String(c.id).startsWith('local-')).map((c) => `<div class="gm-mem"><span>${esc(c.name || 'Unnamed')} <span class="muted small">level ${c.level || ''}</span></span><button type="button" class="btn small" data-addmine="${esc(c.id)}">Add</button></div>`).join('')}` : ''}
      <div class="row between" style="margin-top:16px"><button type="button" class="btn danger ghost" id="mDel">Delete party</button><button type="button" class="btn primary" data-close>Done</button></div>`;
    const upd = async (data) => { try { partyMeta = (await api('party_update', { id: partyMeta.id, ...data })).party; await loadParties(); draw(); renderParty(); } catch (e) { toast(e.message, 'error'); } };
    $('#mName', m.body).onchange = (e) => upd({ name: e.target.value });
    $('#mCopy', m.body).onclick = () => copy(fmtCode(partyMeta.code), 'Join code');
    $('#mLink', m.body).onclick = () => copy(link.replace(/join=.*/, 'join=' + partyMeta.code), 'Join link');
    $('#mNew', m.body).onclick = async () => { if (await confirmBox('Make a new join code? The old one stops working; players who already joined stay.')) upd({ newCode: true }); };
    $('#mLock', m.body).onchange = (e) => upd({ locked: e.target.checked });
    $$('[data-rm]', m.body).forEach((b) => (b.onclick = async () => {
      const p = party.find((x) => x.rec.id === b.dataset.rm);
      if (!(await confirmBox(`Remove ${p?.build.name || 'this character'} from the party?`))) return;
      try { await api('party_remove', { id: partyMeta.id, character_id: b.dataset.rm }); since = null; await pollParty(); draw(); render(); } catch (e) { toast(e.message, 'error'); }
    }));
    $$('[data-addmine]', m.body).forEach((b) => (b.onclick = async () => {
      try { await api('party_join', { code: partyMeta.code, character_id: b.dataset.addmine }); since = null; await pollParty(); draw(); render(); } catch (e) { toast(e.message, 'error'); }
    }));
    $('#mDel', m.body).onclick = async () => {
      if (!(await confirmBox(`Delete the party “${partyMeta.name}”? Characters stay with their players.`))) return;
      try { await api('party_delete', { id: partyMeta.id }); m.close(); setActive(null); await loadParties(); if (activeParty) await pollParty(); render(); } catch (e) { toast(e.message, 'error'); }
    };
    $('[data-close]', m.body).onclick = m.close;
  };
  draw();
}
function wireParty() {
  $$('[data-pc]').forEach((b) => (b.onclick = () => openPc(party[Number(b.dataset.pc)])));
  const np = $('#newParty'); if (np) np.onclick = createParty;
  const sel = $('#partySel');
  if (sel) sel.onchange = async () => {
    if (sel.value === '__new') { sel.value = activeParty || ''; createParty(); return; }
    setActive(sel.value); await pollParty(); render();
  };
  const mg = $('#partyManage'); if (mg) mg.onclick = openManage;
  const pc = $('#partyCode'); if (pc) pc.onclick = () => (partyMeta.locked ? openManage() : copy(fmtCode(partyMeta.code), 'Join code'));
}

// ------------------------------------------------------------------ render
const colScroll = () => $$('.gm-col').map((el) => el.scrollTop);
async function render() {
  const c = enc.list.find((x) => x.id === enc.sel) || (enc.combat ? null : enc.list[0]) || enc.list[0] || null;
  if (c) enc.sel = c.id;
  const sb = c ? await statblock(c.slug) : null;
  const scroll = colScroll();
  main.innerHTML = `
    <div class="gm-grid">
      <aside class="gm-col gm-party card tight">${partyColumn()}</aside>
      <section class="gm-col gm-enc card tight">${encounterHtml()}</section>
      <aside class="gm-col gm-sb card tight">${sb ? statblockHtml(sb, c) : '<p class="muted">Select a creature to see its statblock.</p>'}</aside>
    </div>`;
  $$('.gm-col').forEach((el, i) => { el.scrollTop = scroll[i] || 0; });
  drawSync();
  wireParty();
  wireEnc();
  wireSb(c);
}
// Just the middle column (live party updates during a fight), unless the GM is typing in it.
function renderEnc() {
  const el = $('.gm-enc'); if (!el) return;
  if (el.contains(document.activeElement) && document.activeElement.matches('input, select, textarea')) return;
  const s = el.scrollTop;
  el.innerHTML = encounterHtml();
  el.scrollTop = s;
  drawSync();
  wireEnc();
}
function wireEnc() {
  const name = $('.gm-enc-name');
  name.onchange = () => { enc.name = name.value.trim() || 'Encounter'; save(); };
  name.onkeydown = (e) => { if (e.key === 'Enter') name.blur(); };
  $('#encList').onclick = openEncounters;
  $$('[data-pl]').forEach((b) => (b.onclick = () => { enc.partyLevel = Math.max(-1, Math.min(25, partyLevel() + Number(b.dataset.pl))); save(); render(); }));
  $$('[data-ps]').forEach((b) => (b.onclick = () => { enc.partySize = Math.max(1, Math.min(10, partySize() + Number(b.dataset.ps))); save(); render(); }));
  $('#addCr').onclick = openBestiary;
  const ib = $('#initBtn'); if (ib) ib.onclick = openInitiative;
  const clr = $('#clearEnc'); if (clr) clr.onclick = async () => { if (await confirmBox('Remove every creature from this encounter?')) { enc.list = []; enc.sel = null; save(); render(); } };
  const ec = $('#endCombat'); if (ec) ec.onclick = endCombat;
  $$('[data-step]').forEach((b) => (b.onclick = () => step(Number(b.dataset.step))));
  const dl = $('#delayBtn'); if (dl) dl.onclick = delayTurn;
  $$('[data-resume]').forEach((b) => (b.onclick = () => resume(b.dataset.resume)));
  $$('.gm-enc [data-init]').forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const x = who(b.dataset.init); if (!x) return;
    hpPad(x.name, 'init', (n) => setInit(x.key, n));
  }));
  $$('.gm-cr[data-cr]').forEach((row) => {
    const cr = enc.list.find((x) => x.id === row.dataset.cr);
    row.onclick = (e) => { if (e.target.closest('button')) return; enc.sel = cr.id; save(); render(); };
    $$('[data-hp]', row).forEach((b) => (b.onclick = () => hpPad(`${cr.name} ${cr.tag}`, b.dataset.hp, (n) => applyHp(cr, b.dataset.hp, n))));
  });
  $$('.gm-cr[data-pcrow]').forEach((row) => (row.onclick = (e) => {
    if (e.target.closest('button')) return;
    const p = party.find((x) => pcKey(x) === row.dataset.pcrow); if (p) openPc(p);
  }));
}
function wireSb(c) {
  const sbEl = $('.gm-sb');
  if (!c || !sbEl) return;
  $$('[data-adj]', sbEl).forEach((b) => (b.onclick = () => setAdj(c, b.dataset.adj)));
  $$('[data-hp]', sbEl).forEach((b) => (b.onclick = () => hpPad(`${c.name} ${c.tag}`, b.dataset.hp, (n) => applyHp(c, b.dataset.hp, n))));
  const ac = $('[data-addcond]', sbEl); if (ac) ac.onclick = () => pickCondition(c);
  const rm = $('[data-remove]', sbEl); if (rm) rm.onclick = () => removeCreature(c);
  $$('[data-rmcond]', sbEl).forEach((b) => (b.onclick = () => { c.conditions.splice(Number(b.dataset.rmcond), 1); save(); render(); }));
  wireRefs(db, sbEl);
}
await initEncounters();
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !store.user) return;
  const list = await remoteList();
  if (await refreshActive(list)) render();
});
render();
})();
