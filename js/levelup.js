// Level-up page: what you gain automatically, the choices for the new level, a before → after
// comparison, and a Finish button that stays locked until every choice is made.
import { DB } from './data.js';
import { Engine, normalizeBuild, BOOST_LEVELS } from './engine.js';
import { Store } from './store.js';
import { mountAccount, saveWithConflictCheck } from './account.js';
import { modal, toast, showRef, wireRefs, actionGlyph, esc } from './ui.js';
import { ATTRS, SKILLS, RANKS, signed, titleCase, deepClone, refParts } from './util.js';
import { choiceRows, wireChoiceRows, openFeatDrawer, rarityBadge } from './pickers.js';
import { renderSpellsEditor } from './spellsui.js';
import { ordinal } from './casting.js';

(async () => {
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const main = $('#main');

const db = await new DB({ base: 'data/' }).init();
await db.load(['equipment']);
const engine = new Engine(db);
const store = await new Store().init();
mountAccount(store);
const params = new URLSearchParams(location.search);
let charRec;
try {
  if (!params.get('id')) throw new Error('No character selected.');
  charRec = await store.get(params.get('id'));
} catch (e) { main.innerHTML = `<div class="card"><p class="bad">${esc(e.message)}</p><a class="btn" href="index.html">Back to characters</a></div>`; throw e; }

const sheetUrl = 'sheet.html?id=' + encodeURIComponent(charRec.id);
$('#backLink').href = sheetUrl;
const build = normalizeBuild(charRec.build);
const L0 = build.level, L1 = L0 + 1;
$('#ctx').textContent = build.name || 'Unnamed';
document.title = `Level up ${build.name || ''} — PF2e`;
if (L0 >= 20) { main.innerHTML = `<div class="card"><h1>Level 20</h1><p>${esc(build.name)} is already at the highest level.</p><a class="btn" href="${sheetUrl}">Back to sheet</a></div>`; return; }

const draft = deepClone(build);
draft.level = L1;
const before = engine.compute(build);
let after = engine.compute(draft);
// How many spells are still missing (repertoires, spellbooks, choose-one focus spells).
const spellWarn = (c) => {
  let n = c.spellcasting.picks.filter((p) => !p.value).length;
  for (const e of c.spellcasting.entries) {
    if (e.repLimits) for (const [r, lim] of Object.entries(e.repLimits)) n += Math.max(0, lim - ((e.repertoire || {})[r] || []).filter((x) => !x.extra).length);
    if (e.book && e.book.limit != null) n += Math.max(0, e.book.levelLimit - e.book.count) + Math.max(0, e.book.cantripLimit - e.book.cantripCount);
  }
  return n;
};
const baseSpellWarn = spellWarn(before);

function recompute() { after = engine.compute(draft); render(); }
function setChoice(key, flag, v) {
  draft.choices[key] = Object.assign({}, draft.choices[key] || {});
  if (v === undefined) delete draft.choices[key][flag]; else draft.choices[key][flag] = v;
  recompute();
}

// ------------------------------------------------------------------ what you gain
function gains() {
  const out = [];
  const hp = after.hp.max - before.hp.max;
  out.push({ big: `+${hp} HP`, text: `${after.class?.name || 'Class'} ${after.class?.hp || 0} + Constitution ${signed(after.attrs.con)}. Maximum HP ${before.hp.max} → ${after.hp.max}.` });
  out.push({ big: '+1', text: 'Level bonus on every proficiency you have: AC, saves, Perception, trained skills, class DC, spell attack and DC.' });
  for (const f of (after.class?.items || []).filter((i) => i.level === L1)) {
    out.push({ big: 'New', text: `<a class="ref" data-ref="${esc(f.ref.slice(1))}">${esc(f.name.replace(/^\(Choice\) /, ''))}</a> (class feature)`, html: true });
  }
  for (const e of after.spellcasting.entries) {
    const b = before.spellcasting.entries.find((x) => x.id === e.id);
    for (const [r, n] of Object.entries(e.slots)) {
      const was = b ? (b.slots[r] || 0) : 0;
      if (n > was) out.push({ big: `+${n - was}`, text: `${ordinal(r)}-rank spell slot${n - was > 1 ? 's' : ''} for ${esc(e.label)} (now ${n} per day).`, html: true });
    }
    if (e.repLimits && b?.repLimits) {
      const add = Object.keys(e.repLimits).reduce((s, r) => s + Math.max(0, (e.repLimits[r] || 0) - (b.repLimits[r] || 0)), 0);
      if (add) out.push({ big: `+${add}`, text: `Spell${add > 1 ? 's' : ''} added to your ${esc(e.label)} repertoire (choose below).`, html: true });
    }
    if (e.book && b?.book && e.book.limit > b.book.limit) out.push({ big: `+${e.book.limit - b.book.limit}`, text: `Spells for your ${esc(e.book.label.toLowerCase())} (choose below).`, html: true });
    if (!b) out.push({ big: 'New', text: `${esc(e.label)} spellcasting.`, html: true });
  }
  if (after.spellcasting.cantripRank > before.spellcasting.cantripRank && after.spellcasting.any) out.push({ big: 'Rank ' + after.spellcasting.cantripRank, text: 'Your cantrips and focus spells heighten.' });
  const fa = after.spellcasting.focus.max || after.focusMax, fb = before.spellcasting.focus.max || before.focusMax;
  if (fa > fb) out.push({ big: `+${fa - fb}`, text: `Focus point${fa - fb > 1 ? 's' : ''} (pool ${fa}).` });
  return out;
}
function upcoming() {
  const nb = BOOST_LEVELS.find((l) => l > L1);
  const ni = (after.class?.skillIncreaseLevels || []).find((l) => l > L1);
  const nf = (after.class?.items || []).map((i) => i.level).filter((l) => l > L1).sort((a, b) => a - b)[0];
  return [nb && `next attribute boosts at ${nb}`, ni && `next skill increase at ${ni}`, nf && `next class features at ${nf}`].filter(Boolean).join(', ');
}

// ------------------------------------------------------------------ choices for the new level
function choiceList() {
  const list = [];
  for (const s of after.slots.filter((x) => x.level === L1)) {
    const slug = draft.feats[s.id];
    const rec = slug ? db.get('@feats/' + slug) : null;
    const pend = rec ? after.choices.filter((c) => c.key.startsWith('feat:' + s.id) && c.value === null) : [];
    list.push({ id: 'slot:' + s.id, kind: `${s.label} · level ${L1}`, done: !!rec && !pend.length, value: rec ? rec.name : null, rec,
      hint: rec ? (rec.arch ? titleCase(rec.arch) + ' archetype' : (rec.traits || []).filter((t) => t !== 'general' && t !== 'skill').slice(0, 2).map(titleCase).join(' · ')) : (s.type === 'archetype' ? 'Free archetype slot' : ''),
      button: { slot: s.id, label: rec ? 'Change' : 'Choose' }, sub: rec ? choiceRows(after, ['feat:' + s.id]) : '' });
  }
  for (const f of (after.class?.items || []).filter((i) => i.level === L1)) {
    const key = 'cf:' + refParts(f.ref)[1];
    const cs = after.choices.filter((c) => c.key === key || c.key.startsWith(key + '>'));
    if (!cs.length) continue;
    list.push({ id: 'cf:' + key, kind: `${f.name.replace(/^\(Choice\) /, '')} · class feature`, done: cs.every((c) => c.value !== null), value: cs.filter((c) => c.value !== null).map((c) => c.options.find((o) => JSON.stringify(o.value) === JSON.stringify(c.value))?.label).filter(Boolean).join(', ') || null, sub: choiceRows(after, [key]) });
  }
  if (BOOST_LEVELS.includes(L1)) {
    const cur = (draft.boosts[L1] || []).filter(Boolean);
    list.push({ id: 'boosts', kind: `Attribute boosts · level ${L1}`, done: cur.length === 4, value: cur.length ? cur.map((a) => a.toUpperCase()).join(', ') : null, hint: 'Four different attributes. +4 or higher takes a partial boost.',
      sub: `<div class="boost-grid" style="max-width:420px">${ATTRS.map((a) => `<button type="button" data-boost="${a}" class="${cur.includes(a) ? 'on' : ''}" aria-pressed="${cur.includes(a)}" ${!cur.includes(a) && cur.length >= 4 ? 'disabled' : ''}>${a.toUpperCase()} ${signed(after.attrs[a])}</button>`).join('')}</div>` });
  }
  const n = after.intPicks[L1];
  if (n) {
    const cur = (draft.skills.int[L1] || []).filter(Boolean);
    const avail = Object.keys(SKILLS).filter((s) => !after.ranks.skills[s] || cur.includes(s));
    list.push({ id: 'int', kind: 'Intelligence increase · new trained skill' + (n > 1 ? 's' : ''), done: cur.length >= n, value: cur.length ? cur.map(titleCase).join(', ') : null, hint: `Your Intelligence went up: train ${n} more skill${n > 1 ? 's' : ''}.`,
      sub: `<div class="row">${avail.map((s) => `<label class="check small" style="padding:2px 6px 2px 0"><input type="checkbox" data-int="${s}" ${cur.includes(s) ? 'checked' : ''} ${!cur.includes(s) && cur.length >= n ? 'disabled' : ''}> ${esc(titleCase(s))}</label>`).join('')}</div>` });
  }
  if (after.increaseLevels.includes(L1)) {
    const cur = draft.skills.inc[L1] || '';
    const limit = L1 >= 15 ? 4 : L1 >= 7 ? 3 : 2;
    const rankOf = (s) => (s.startsWith('lore:') ? (after.ranks.lores[s.slice(5)] || 0) : after.ranks.skills[s]) - (cur === s ? 1 : 0);
    const opts = [...Object.keys(SKILLS), ...Object.keys(after.ranks.lores).map((l) => 'lore:' + l)].map((s) => {
      const b = rankOf(s);
      return `<option value="${esc(s)}" ${cur === s ? 'selected' : ''} ${b + 1 > limit && cur !== s ? 'disabled' : ''}>${esc(titleCase(s.replace(/^lore:/, '')))} — ${RANKS[b]} → ${RANKS[Math.min(4, b + 1)]}</option>`;
    }).join('');
    list.push({ id: 'inc', kind: `Skill increase · level ${L1}`, done: !!cur, value: cur ? titleCase(cur.replace(/^lore:/, '')) : null, hint: limit >= 3 ? `You can now raise a skill to ${RANKS[limit].toLowerCase()}.` : '',
      sub: `<select data-inc aria-label="Skill increase" class="${cur ? '' : 'needs'}"><option value="">— choose a skill —</option>${opts}</select>` });
  }
  const sw = spellWarn(after);
  if (sw > baseSpellWarn || (after.spellcasting.entries.length && gains().some((g) => /repertoire|spellbook|familiar|dirge|known/i.test(g.text)))) {
    const need = sw - baseSpellWarn;
    list.push({ id: 'spells', kind: 'New spells', done: need <= 0, value: need <= 0 ? 'Chosen' : null,
      hint: need > 0 ? `Choose ${need} new spell${need > 1 ? 's' : ''}${baseSpellWarn ? ` (and ${baseSpellWarn} you skipped earlier, if you like)` : ''}` : (baseSpellWarn ? `${baseSpellWarn} earlier spell${baseSpellWarn > 1 ? 's' : ''} still open — optional` : ''),
      button: { spells: true, label: need <= 0 ? 'Review' : 'Choose spells' } });
  }
  return list;
}

// ------------------------------------------------------------------ before → after
function diffRows() {
  const rows = [];
  const add = (label, a, b) => { if (a !== undefined && b !== undefined) rows.push({ label, from: a, to: b }); };
  add('Max HP', before.hp.max, after.hp.max);
  add('AC', before.ac.total, after.ac.total);
  for (const s of ['fortitude', 'reflex', 'will']) add(titleCase(s), signed(before.saves[s].total), signed(after.saves[s].total));
  add('Perception', signed(before.perception.total), signed(after.perception.total));
  if (after.classDC) add('Class DC', before.classDC.total, after.classDC.total);
  const eb = before.spellcasting.entries[0], ea = after.spellcasting.entries[0];
  if (ea) { add('Spell DC', eb ? eb.dc : '—', ea.dc); add('Spell attack', eb ? signed(eb.attack) : '—', signed(ea.attack)); }
  for (const s of Object.keys(SKILLS)) {
    const a = before.skills[s], b = after.skills[s];
    if (b.rank !== a.rank || (b.rank && b.total !== a.total && (b.rank !== a.rank || rows.length < 30))) if (b.rank) add(titleCase(s) + (b.rank !== a.rank ? ` (${RANKS[b.rank].toLowerCase()})` : ''), signed(a.total), signed(b.total));
  }
  for (const e of after.spellcasting.entries) {
    const b = before.spellcasting.entries.find((x) => x.id === e.id);
    for (const [r, n] of Object.entries(e.slots)) { const was = b ? b.slots[r] || 0 : 0; if (n !== was) add(`${e.id === 'class' ? '' : e.label + ' '}${ordinal(r)}-rank slots`, was, n); }
  }
  for (const a of ATTRS) if (before.attrs[a] !== after.attrs[a]) add(a.toUpperCase(), signed(before.attrs[a]), signed(after.attrs[a]));
  const fa = after.spellcasting.focus.max || after.focusMax, fb = before.spellcasting.focus.max || before.focusMax;
  if (fa !== fb) add('Focus points', fb, fa);
  if (after.speed.total !== before.speed.total) add('Speed', before.speed.total, after.speed.total);
  return rows;
}

// ------------------------------------------------------------------ render
function render() {
  const list = choiceList();
  const done = list.filter((c) => c.done).length;
  const left = list.length - done;
  const g = gains();
  const up = upcoming();
  main.innerHTML = `
    <div class="lu-head"><h1>Level up</h1><span class="lu-levels">${L0} <span class="arrow">→</span> <span class="to">${L1}</span></span><span class="spacer" style="flex:1"></span>
      <span class="small ${left ? 'warn' : 'ok'}">${list.length ? `${done} of ${list.length} choices made` : 'No choices to make'}</span>
      <div class="progress" aria-hidden="true"><div style="width:${list.length ? Math.round((done / list.length) * 100) : 100}%"></div></div></div>
    <div class="with-side">
      <div class="main-col stack">
        <section class="card" style="margin:0"><h2 class="label">You gain automatically</h2>
          ${g.map((x) => `<div class="gain"><span class="big">${esc(x.big)}</span><span class="grow">${x.html ? x.text : esc(x.text)}</span></div>`).join('')}
          ${up ? `<p class="tiny muted" style="margin:8px 0 0">Coming up: ${esc(up)}.</p>` : ''}</section>
        <section class="card" style="margin:0;padding-bottom:6px"><h2 class="label" style="margin-top:4px">Your choices</h2>
          ${list.map((c) => `<div class="lu-choice ${c.done ? 'done' : ''}" id="c-${esc(c.id.replace(/[^\w-]/g, '_'))}"><span class="dot" aria-hidden="true">${c.done ? '✓' : '!'}</span>
            <div class="body"><div class="kind">${esc(c.kind)}</div><div class="value">${c.value ? (c.rec ? `<span style="cursor:pointer" data-show="@feats/${esc(c.rec.slug)}">${esc(c.value)}</span>${rarityBadge(c.rec)} <span class="muted small">${actionGlyph(c.rec)}</span>` : esc(c.value)) : 'Not chosen'}</div>${c.hint ? `<div class="hint">${esc(c.hint)}</div>` : ''}</div>
            ${c.button ? `<button type="button" class="btn ${c.done ? '' : 'primary'}" ${c.button.slot ? `data-slot="${esc(c.button.slot)}"` : 'data-spells'}>${esc(c.button.label)}</button>` : ''}
            ${c.sub ? `<div class="inline">${c.sub}</div>` : ''}</div>`).join('') || '<p class="muted small">Nothing to choose at this level — just finish.</p>'}
        </section>
      </div>
      <div class="side-col" id="side"></div>
    </div>`;
  const side = $('#side');
  const rows = diffRows();
  side.innerHTML = `<aside class="sidepanel" aria-label="What changes"><header><h2>What changes</h2></header>
    <div style="padding:4px 16px 8px;overflow-y:auto">${rows.map((d) => `<div class="diff-row"><span class="dl">${esc(d.label)}</span><span class="from">${esc(d.from)}</span><span class="arrow">→</span><span class="to">${esc(d.to)}</span></div>`).join('')}</div>
    <div style="padding:12px 16px;border-top:1px solid var(--glass-line);display:flex;flex-direction:column;gap:8px">
      <button type="button" class="btn primary block" id="finish" ${left ? 'disabled' : ''}>${left ? `Finish level ${L1} · ${left} choice${left > 1 ? 's' : ''} left` : `Finish level ${L1}`}</button>
      <a class="btn ghost" href="${sheetUrl}">Cancel — stay at level ${L0}</a></div></aside>`;
  // On phones the side column would be an overlay; show the comparison inline instead.
  if (window.innerWidth < 900) { side.className = ''; side.style.marginTop = '12px'; side.style.width = '100%'; }
  wireRefs(db, main);
  $$('[data-show]', main).forEach((el) => { if (!el.onclick) el.onclick = (e) => { e.preventDefault(); showRef(db, el.dataset.show); }; });
  wireChoiceRows(main, after, db, setChoice);
  $$('[data-slot]', main).forEach((b) => (b.onclick = () => {
    const slot = after.slots.find((x) => x.id === b.dataset.slot);
    if (slot) openFeatDrawer({ engine, db, build: draft, slot, showRare: draft.options.showRare, onTake: (slug) => { draft.feats[slot.id] = slug; recompute(); } });
  }));
  $$('[data-spells]', main).forEach((b) => (b.onclick = openSpells));
  $$('[data-boost]', main).forEach((b) => (b.onclick = () => {
    const a = b.dataset.boost;
    const arr = (draft.boosts[L1] = (draft.boosts[L1] || []).filter(Boolean));
    const i = arr.indexOf(a);
    if (i >= 0) arr.splice(i, 1); else if (arr.length < 4) arr.push(a);
    recompute();
  }));
  $$('[data-int]', main).forEach((cb) => (cb.onchange = () => {
    let arr = (draft.skills.int[L1] || []).filter((x) => x && x !== cb.dataset.int);
    if (cb.checked) arr.push(cb.dataset.int);
    draft.skills.int[L1] = arr;
    recompute();
  }));
  $$('[data-inc]', main).forEach((s) => (s.onchange = () => { if (s.value) draft.skills.inc[L1] = s.value; else delete draft.skills.inc[L1]; recompute(); }));
  const fin = $('#finish');
  if (fin) fin.onclick = finish;
}

function openSpells() {
  const m = modal(`Spells for level ${L1}`, { wide: true, onClose: () => render() });
  const draw = () => renderSpellsEditor(m.body, { db, ch: after, build: draft, update: () => { after = engine.compute(draft); draw(); } });
  draw();
}

async function finish() {
  const gainHp = after.hp.max - before.hp.max;
  charRec.build = draft;
  charRec.name = draft.name || charRec.name;
  const st = charRec.state || {};
  if (st.hp != null) st.hp = Math.min(after.hp.max, st.hp + gainHp);
  try {
    if (!(await saveWithConflictCheck(store, charRec))) return;
    if (charRec.id) await store.saveState(charRec.id, st);
    if (charRec.pending) toast('Saved on this device — it uploads to your account when you\'re back online');
    toast(`${draft.name || 'Character'} is now level ${L1}`, 'ok');
    location.href = sheetUrl;
  } catch (e) { toast('Could not save: ' + e.message, 'error'); }
}

render();
})().catch((e) => { console.error(e); const m = document.getElementById('main'); if (m && !m.querySelector('.bad')) m.insertAdjacentHTML('afterbegin', '<p class="bad">Something went wrong: ' + String(e.message || e).replace(/</g, '&lt;') + '</p>'); });
