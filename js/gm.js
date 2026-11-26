// GM screen: party on the left, the encounter in the middle, the selected creature's statblock on the right.
import { DB } from './data.js';
import { Engine, normalizeBuild } from './engine.js';
import { Store, api } from './store.js';
import { mountAccount } from './account.js';
import { modal, toast, confirmBox, wireRefs, traitChips, esc } from './ui.js';
import { signed, titleCase, uid } from './util.js';
import { slotRows, ordinal } from './casting.js';

(async () => {
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const main = $('#main');

const db = await new DB({ base: 'data/' }).init();
await db.load(['equipment', 'creatures', 'conditions']);
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

// ------------------------------------------------------------------ encounter state (on this device for now)
const KEY = 'pf2e.gm.v1';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } };
const enc = Object.assign({ name: 'New encounter', partyLevel: null, partySize: null, list: [], sel: null }, load() || {});
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(enc)); } catch (e) { /* ignore */ } };

const statblocks = {};
async function statblock(slug) {
  if (!statblocks[slug]) {
    const n = db.meta?.textBuckets?.creatures || 16;
    let h = 0; for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) & 0x7fffffff;
    const m = await db.fetchJson('text/creatures/' + (h % n) + '.json').catch(() => ({}));
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
let pollTimer = setInterval(async () => {
  if (document.hidden || !store.user || !activeParty) return;
  const before = party.length;
  if (await pollParty()) { if (party.length !== before) render(); else renderParty(); }
}, 3000);
const partyLevel = () => enc.partyLevel ?? (party.length ? Math.round(party.reduce((a, p) => a + p.build.level, 0) / party.length) : 1);
const partySize = () => enc.partySize ?? (party.length || 4);

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
function xpOf(c) { const lvl = adjLevel(c.level, c.adj); const d = Math.max(-4, Math.min(4, lvl - partyLevel())); return lvl - partyLevel() < -4 ? 0 : XP_BY_DIFF[d]; }
function threat() {
  const xp = enc.list.reduce((a, c) => a + xpOf(c), 0);
  const extra = partySize() - 4;
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
// Encounters saved before numbering used letters: A → 1, B → 2…
for (const c of enc.list) if (/^[A-Z]$/.test(String(c.tag))) c.tag = String(c.tag.charCodeAt(0) - 64);
function addCreature(rec) {
  const tag = nextLabel(rec.slug);
  const c = { id: uid(), slug: rec.slug, name: rec.name, level: rec.level, tag, adj: 'normal', max: rec.hp, hp: rec.hp, temp: 0, ac: rec.ac, conditions: [] };
  enc.list.push(c); enc.sel = c.id; save(); render();
}
function setAdj(c, adj) {
  const base = db.get('@creatures/' + c.slug);
  const lost = c.max - c.hp;
  c.adj = adj;
  c.max = Math.max(1, (base?.hp || c.max) + adjHp(c.level, adj));
  c.hp = Math.max(0, c.max - lost);
  save(); render();
}

function encounterHtml() {
  const t = threat();
  const seg = t.budgets.map(([n, b], i) => `<i style="left:${(b / t.max) * 100}%" title="${n} ${b} XP"></i>`).join('');
  return `
    <div class="gm-enc-head">
      <input type="text" class="gm-enc-name" value="${esc(enc.name)}" aria-label="Encounter name">
      <div class="gm-party-cfg">Party level <button type="button" class="step" data-pl="-1">−</button><b>${partyLevel()}</b><button type="button" class="step" data-pl="1">+</button>
        · <button type="button" class="step" data-ps="-1">−</button><b>${partySize()}</b><button type="button" class="step" data-ps="1">+</button> PCs</div>
    </div>
    <div class="gm-threat t-${t.label.toLowerCase()}">
      <div class="gm-threat-top"><b>${t.label}</b><span class="muted">${t.xp} XP · ${t.budgets.map(([n, b]) => `${n[0]}${b}`).join(' ')}</span></div>
      <div class="gm-threat-bar"><div style="width:${Math.min(100, (t.xp / t.max) * 100)}%"></div>${seg}</div>
    </div>
    <div class="row gm-enc-actions"><button type="button" class="btn primary" id="addCr">+ Add creatures</button>${enc.list.length ? '<button type="button" class="btn ghost" id="clearEnc">Clear</button>' : ''}</div>
    <div class="gm-list">${enc.list.map((c) => {
      const pct = c.max ? (c.hp / c.max) * 100 : 0;
      const ac = c.ac + adjMod(c.adj);
      return `<div class="gm-cr ${enc.sel === c.id ? 'sel' : ''} ${c.hp <= 0 ? 'down' : ''}" data-cr="${c.id}">
        <span class="gm-lvl">${adjLevel(c.level, c.adj)}</span>
        <div class="gm-cr-main"><div class="gm-cr-name"><b>${esc(c.name)}</b> <span class="gm-tag">${esc(c.tag)}</span>${c.adj !== 'normal' ? `<span class="badge ${c.adj === 'elite' ? 'elite' : 'weak'}">${c.adj}</span>` : ''}</div>
          ${bar(c.hp, c.max, c.temp)}
          <div class="gm-cr-sub"><span class="mono"><b>${c.hp}</b>/${c.max}${c.temp ? ` <span class="gm-temp">+${c.temp}</span>` : ''}</span><span>AC <b>${ac}</b></span>${condChips(c.conditions)}${c.hp <= 0 ? '<span class="gm-cond bad">Defeated</span>' : ''}</div></div>
        <div class="gm-cr-acts"><button type="button" class="btn small danger" data-hp="dmg">−</button><button type="button" class="btn small" data-hp="heal">+</button></div>
      </div>`;
    }).join('') || `<div class="inv-empty"><span>No creatures yet. Tap <b>+ Add creatures</b> to search the bestiary.</span></div>`}</div>`;
}

// ------------------------------------------------------------------ statblock
const glyph = (a) => (a.type === 'reaction' ? '⟲' : a.type === 'free' ? '◇' : a.type === 'action' ? '◆'.repeat(a.actions || 1) : '');
function statblockHtml(sb, c) {
  const k = adjMod(c.adj);
  const lvl = adjLevel(sb.level, c.adj);
  const rk = (DC_BY_LEVEL[Math.max(0, Math.min(25, lvl + 1))] || 14) + (RARITY_DC[sb.rarity] || 0);
  const rkSkills = [...new Set(sb.traits.map((t) => RK_SKILLS[t]).filter(Boolean).join(', ').split(', '))].join(', ') || 'Lore';
  const dmg = (d) => (k ? d.replace(/^(\d+d\d+)([+-]\d+)?/, (m, dice, b) => { const v = Number(b || 0) + k; return dice + (v ? (v > 0 ? '+' : '') + v : ''); }) : d);
  const line = (label, v) => (v ? `<p><b>${label}</b> ${v}</p>` : '');
  const defs = (list) => list.map((x) => esc(titleCase(x.type)) + (x.value ? ' ' + x.value : '') + (x.except?.length ? ` (except ${esc(x.except.join(', '))})` : '')).join(', ');
  const abil = (a) => `<div class="sb-abil"><b>${esc(a.name)}</b> ${glyph(a) ? `<span class="glyph">${glyph(a)}</span>` : ''}${a.traits?.length ? ` <span class="muted small">(${esc(a.traits.join(', '))})</span>` : ''}<div class="sb-desc">${a.desc || ''}</div></div>`;
  const by = (cat) => (sb.abilities || []).filter((a) => a.cat === cat);
  return `
    <div class="sb-head"><h2>${esc(sb.name)} <span class="gm-tag">${esc(c.tag)}</span></h2><span class="sb-type">Creature ${lvl}</span></div>
    <div class="sb-adj" role="group" aria-label="Adjustment">${['weak', 'normal', 'elite'].map((a) => `<button type="button" class="chip-btn ${c.adj === a ? 'on' : ''}" data-adj="${a}">${titleCase(a)}</button>`).join('')}</div>
    <div class="sb-traits">${traitChips([SIZES[sb.size] ? sb.size : null, ...sb.traits].filter(Boolean).map((t) => (SIZES[t] ? SIZES[t].toLowerCase() : t)), sb.rarity)}</div>
    <div class="sb-rk"><span>Recall Knowledge</span><b>DC ${rk}</b><span class="muted">${esc(rkSkills)}</span></div>
    <div class="sb-hp">
      <div class="gm-big"><b>${c.hp}</b><span>/ ${c.max} HP</span>${c.temp ? `<span class="gm-temp">+${c.temp} temp</span>` : ''}</div>${bar(c.hp, c.max, c.temp)}
      <div class="row sb-hp-btns"><button type="button" class="btn danger" data-hp="dmg">Damage</button><button type="button" class="btn" data-hp="heal">Heal</button><button type="button" class="btn" data-hp="temp">Temp</button><button type="button" class="btn ghost" data-addcond>+ Condition</button></div>
      ${c.conditions.length ? `<div class="gm-conds">${c.conditions.map((x, i) => `<button type="button" class="gm-cond" data-rmcond="${i}">${esc(db.get('@conditions/' + x.slug)?.name || x.slug)}${x.value ? ' ' + x.value : ''} ✕</button>`).join('')}</div>` : ''}
    </div>
    <div class="sb-body">
      ${line('Perception', `${signed(sb.perception + k)}${sb.senses?.length ? '; ' + esc(sb.senses.join(', ')) : ''}`)}
      ${line('Languages', esc((sb.languages || []).join(', ')) + (sb.languageNote ? '; ' + esc(sb.languageNote) : ''))}
      ${line('Skills', Object.entries(sb.skills || {}).map(([s, v]) => `${esc(s)} ${signed(v + k)}`).join(', '))}
      <p class="sb-attrs">${['str', 'dex', 'con', 'int', 'wis', 'cha'].map((a) => `<span><b>${titleCase(a)}</b> ${signed(sb.attrs?.[a] || 0)}</span>`).join('')}</p>
      ${line('Items', esc((sb.gear || []).join(', ')))}
      ${by('interaction').map(abil).join('')}
      <hr>
      <p><b>AC</b> ${sb.ac + k}${sb.acNote ? ' (' + esc(sb.acNote) + ')' : ''}; <b>Fort</b> ${signed(sb.saves.fortitude + k)}, <b>Ref</b> ${signed(sb.saves.reflex + k)}, <b>Will</b> ${signed(sb.saves.will + k)}${sb.saveNote ? '; ' + esc(sb.saveNote) : ''}</p>
      <p><b>HP</b> ${c.max}${sb.hpNote ? ', ' + esc(sb.hpNote) : ''}${sb.hardness ? `; <b>Hardness</b> ${sb.hardness}` : ''}${sb.immunities?.length ? `; <b>Immunities</b> ${defs(sb.immunities)}` : ''}${sb.weaknesses?.length ? `; <b>Weaknesses</b> ${defs(sb.weaknesses)}` : ''}${sb.resistances?.length ? `; <b>Resistances</b> ${defs(sb.resistances)}` : ''}</p>
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

// ------------------------------------------------------------------ HP pad (big buttons for tablets)
function hpPad(target, mode, onApply) {
  const m = modal(`${mode === 'dmg' ? 'Damage' : mode === 'heal' ? 'Heal' : 'Temp HP'}: ${target}`, { cls: 'hp-pad' });
  let val = '';
  const draw = () => {
    m.body.innerHTML = `<div class="pad-val ${mode}">${val || '0'}</div>
      <div class="pad-keys">${[7, 8, 9, 4, 5, 6, 1, 2, 3, 'C', 0, '⌫'].map((k) => `<button type="button" class="pad-k" data-k="${k}">${k}</button>`).join('')}</div>
      <div class="pad-quick">${[1, 5, 10, 20].map((n) => `<button type="button" class="chip-btn" data-q="${n}">+${n}</button>`).join('')}</div>
      <button type="button" class="btn ${mode === 'dmg' ? 'danger' : 'primary'} pad-go">${mode === 'dmg' ? 'Apply damage' : mode === 'heal' ? 'Heal' : 'Set temp HP'}</button>`;
    $$('.pad-k', m.body).forEach((b) => (b.onclick = () => { const k = b.dataset.k; val = k === 'C' ? '' : k === '⌫' ? val.slice(0, -1) : (val + k).replace(/^0+/, '').slice(0, 4); draw(); }));
    $$('[data-q]', m.body).forEach((b) => (b.onclick = () => { val = String((Number(val) || 0) + Number(b.dataset.q)); draw(); }));
    $('.pad-go', m.body).onclick = () => { const n = Number(val) || 0; m.close(); if (n) onApply(n); };
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
function openBestiary() {
  const all = db.list('creatures');
  const m = modal('Bestiary', { wide: true, cls: 'bestiary' });
  const f = { q: '', min: Math.max(-1, partyLevel() - 4), max: partyLevel() + 4, trait: '' };
  const TRAITS = ['humanoid', 'animal', 'beast', 'undead', 'dragon', 'fiend', 'celestial', 'construct', 'elemental', 'fey', 'aberration', 'ooze', 'plant'];
  m.body.innerHTML = `
    <div class="filters best-f"><input type="search" placeholder="Search creatures…" aria-label="Search creatures">
      <label class="small">Level <select data-f="min">${Array.from({ length: 27 }, (_, i) => i - 1).map((l) => `<option ${l === f.min ? 'selected' : ''}>${l}</option>`).join('')}</select> to
      <select data-f="max">${Array.from({ length: 27 }, (_, i) => i - 1).map((l) => `<option ${l === f.max ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
    <div class="inv-chips">${['', ...TRAITS].map((t) => `<button type="button" class="chip-btn ${t === f.trait ? 'on' : ''}" data-tr="${t}">${t ? titleCase(t) : 'All'}</button>`).join('')}</div>
    <div class="best-list"></div>`;
  const draw = () => {
    const q = f.q.trim().toLowerCase();
    const shown = all.filter((c) => c.level >= f.min && c.level <= f.max && (!f.trait || c.traits.includes(f.trait)) && (!q || c.name.toLowerCase().includes(q)));
    $('.best-list', m.body).innerHTML = shown.slice(0, 150).map((c) => {
      const n = enc.list.filter((x) => x.slug === c.slug).length;
      const d = c.level - partyLevel();
      return `<div class="best-row"><span class="gm-lvl">${c.level}</span><div class="gm-cr-main"><b>${esc(c.name)}</b>${c.rarity !== 'common' ? ` <span class="badge r-${c.rarity}">${c.rarity}</span>` : ''}<div class="muted small">${esc(c.traits.slice(0, 4).map(titleCase).join(', '))} · HP ${c.hp} · AC ${c.ac} · ${XP_BY_DIFF[Math.max(-4, Math.min(4, d))] ?? 0} XP</div></div>
        ${n ? `<span class="best-n">×${n}</span>` : ''}<button type="button" class="btn small primary" data-add="${esc(c.slug)}">Add</button></div>`;
    }).join('') + (shown.length > 150 ? `<p class="muted small">${shown.length - 150} more: narrow the search.</p>` : '') || '<p class="muted small">Nothing matches.</p>';
    $$('[data-add]', m.body).forEach((b) => (b.onclick = () => { addCreature(db.get('@creatures/' + b.dataset.add)); draw(); }));
  };
  const qi = $('input[type=search]', m.body);
  qi.oninput = () => { f.q = qi.value; draw(); };
  $$('select[data-f]', m.body).forEach((s) => (s.onchange = () => { f[s.dataset.f] = Number(s.value); draw(); }));
  $$('[data-tr]', m.body).forEach((b) => (b.onclick = () => { f.trait = b.dataset.tr; $$('[data-tr]', m.body).forEach((x) => x.classList.toggle('on', x === b)); draw(); }));
  draw();
}

function pickCondition(c) {
  const m = modal('Add a condition', {});
  const list = db.list('conditions').filter((x) => !['dying', 'wounded', 'doomed'].includes(x.slug) || true);
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
async function render() {
  const c = enc.list.find((x) => x.id === enc.sel) || enc.list[0] || null;
  if (c) enc.sel = c.id;
  const sb = c ? await statblock(c.slug) : null;
  main.innerHTML = `
    <div class="gm-grid">
      <aside class="gm-col gm-party card tight">${partyColumn()}</aside>
      <section class="gm-col gm-enc card tight">${encounterHtml()}</section>
      <aside class="gm-col gm-sb card tight">${sb ? statblockHtml(sb, c) : '<p class="muted">Select a creature to see its statblock.</p>'}</aside>
    </div>`;
  wire(c);
}
function wire(c) {
  wireParty();
  $('.gm-enc-name').onchange = (e) => { enc.name = e.target.value; save(); };
  $$('[data-pl]').forEach((b) => (b.onclick = () => { enc.partyLevel = Math.max(-1, Math.min(25, partyLevel() + Number(b.dataset.pl))); save(); render(); }));
  $$('[data-ps]').forEach((b) => (b.onclick = () => { enc.partySize = Math.max(1, Math.min(10, partySize() + Number(b.dataset.ps))); save(); render(); }));
  $('#addCr').onclick = openBestiary;
  const clr = $('#clearEnc'); if (clr) clr.onclick = async () => { if (await confirmBox('Remove every creature from this encounter?')) { enc.list = []; enc.sel = null; save(); render(); } };
  $$('.gm-cr').forEach((row) => {
    const cr = enc.list.find((x) => x.id === row.dataset.cr);
    row.onclick = (e) => { if (e.target.closest('button')) return; enc.sel = cr.id; save(); render(); };
    $$('[data-hp]', row).forEach((b) => (b.onclick = () => hpPad(`${cr.name} ${cr.tag}`, b.dataset.hp, (n) => applyHp(cr, b.dataset.hp, n))));
  });
  const sbEl = $('.gm-sb');
  if (c && sbEl) {
    $$('[data-adj]', sbEl).forEach((b) => (b.onclick = () => setAdj(c, b.dataset.adj)));
    $$('[data-hp]', sbEl).forEach((b) => (b.onclick = () => hpPad(`${c.name} ${c.tag}`, b.dataset.hp, (n) => applyHp(c, b.dataset.hp, n))));
    const ac = $('[data-addcond]', sbEl); if (ac) ac.onclick = () => pickCondition(c);
    $$('[data-rmcond]', sbEl).forEach((b) => (b.onclick = () => { c.conditions.splice(Number(b.dataset.rmcond), 1); save(); render(); }));
    wireRefs(db, sbEl);
  }
}
render();
})();
