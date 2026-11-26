// GM screen: party on the left, the encounter in the middle, the selected creature's statblock on the right.
import { DB } from './data.js';
import { Engine, normalizeBuild } from './engine.js';
import { Store } from './store.js';
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
let party = [];
async function loadParty() {
  const list = await store.list().catch(() => []);
  party = [];
  for (const rec of list) {
    try {
      const full = rec.build ? rec : await store.get(rec.id);
      const build = normalizeBuild(full.build);
      const state = Object.assign({ hp: null, temp: 0, hero: 1, focus: null, dying: 0, wounded: 0, conditions: [], used: {}, prep: {} }, full.state || {});
      const ch = engine.compute(build, state);
      party.push({ rec: full, build, state, ch });
    } catch (e) { console.warn('party', e); }
  }
}
await loadParty();
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

function partyHtml() {
  if (!party.length) return '<p class="muted small">No characters yet. Players’ sheets show up here.</p>';
  return party.map((p, i) => {
    const h = hpOf(p); const ch = p.ch;
    const cls = ch.class?.name || ''; const fmax = ch.spellcasting.focus?.max || ch.focusMax || 0;
    return `<button type="button" class="gm-pc" data-pc="${i}">
      <div class="gm-pc-top"><span class="gm-av">${esc((p.build.name || '?').replace(/[^\p{L}\s]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase())}</span>
        <span class="gm-pc-id"><b>${esc(p.build.name || 'Unnamed')}</b><span class="muted">${esc(cls)} ${p.build.level}</span></span>
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
    <div class="row end" style="margin-top:12px"><a class="btn" href="sheet.html?id=${encodeURIComponent(p.rec.id)}">Open full sheet</a></div>`;
}

// ------------------------------------------------------------------ encounter
function xpOf(c) { const lvl = adjLevel(c.level, c.adj); const d = Math.max(-4, Math.min(4, lvl - partyLevel())); return lvl - partyLevel() < -4 ? 0 : XP_BY_DIFF[d]; }
function threat() {
  const xp = enc.list.reduce((a, c) => a + xpOf(c), 0);
  const extra = partySize() - 4;
  const budgets = THREATS.map(([n, b, adj]) => [n, b + adj * extra]);
  let label = 'Trivial';
  for (const [n, b] of budgets) if (xp >= b) label = n;
  if (xp < budgets[0][1] * 0.5) label = 'Trivial';
  const max = budgets[4][1];
  return { xp, label, budgets, max };
}
function nextLabel(slug, name) {
  const used = new Set(enc.list.filter((c) => c.slug === slug).map((c) => c.tag));
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') if (!used.has(ch)) return ch;
  return String(used.size + 1);
}
function addCreature(rec) {
  const tag = nextLabel(rec.slug, rec.name);
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
      <input class="gm-enc-name" value="${esc(enc.name)}" aria-label="Encounter name">
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

// ------------------------------------------------------------------ render
async function render() {
  const c = enc.list.find((x) => x.id === enc.sel) || enc.list[0] || null;
  if (c) enc.sel = c.id;
  const sb = c ? await statblock(c.slug) : null;
  main.innerHTML = `
    <div class="gm-grid">
      <aside class="gm-col gm-party card tight"><div class="row between"><h2 class="label" style="margin:0">Party</h2><button type="button" class="icon-btn" id="partyRefresh" aria-label="Refresh party" title="Refresh">⟳</button></div>${partyHtml()}</aside>
      <section class="gm-col gm-enc card tight">${encounterHtml()}</section>
      <aside class="gm-col gm-sb card tight">${sb ? statblockHtml(sb, c) : '<p class="muted">Select a creature to see its statblock.</p>'}</aside>
    </div>`;
  wire(c);
}
function wire(c) {
  $$('[data-pc]').forEach((b) => (b.onclick = () => openPc(party[Number(b.dataset.pc)])));
  $('#partyRefresh').onclick = async () => { await loadParty(); render(); toast('Party updated'); };
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
