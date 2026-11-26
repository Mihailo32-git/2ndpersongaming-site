// The Companions tab on the character sheet: cards for animal companions, familiars and eidolons,
// with their Hit Points tracked like the character's, and the dialog to set one up.
import { modal, toast, confirmBox, wireRefs, traitChips, esc } from './ui.js';
import { signed, titleCase, uid } from './util.js';
import { companionStats, hints, STAGES, SIZE_NAME, ATTRS6, EIDOLON_PRIMARY, EIDOLON_D8_TRAITS, DAMAGE_TYPES, KIND_LABEL } from './companions.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const GLYPH = { 1: '◆', 2: '◆◆', 3: '◆◆◆', reaction: '⟲', free: '◇' };
const RANK_LETTER = ['U', 'T', 'E', 'M', 'L'];

let dataPromise = null;
export function loadCompanionData(db) {
  if (!dataPromise) dataPromise = db.fetchJson('companions.json').catch(() => ({ familiar: [], animal: [], specializations: [], eidolons: [] }));
  return dataPromise;
}
export const companionList = (build) => (Array.isArray(build.companions) ? build.companions : []);
export function companionHp(state, c, stats) {
  const s = (state.companions || {})[c.id] || {};
  const max = stats.hp.max;
  return { cur: s.hp == null ? max : Math.min(s.hp, max), max, temp: s.temp || 0 };
}

function abilityHtml(a) {
  const g = a.act ? GLYPH[a.act] || '' : '';
  return `<details class="comp-abil"><summary><b>${esc(a.name)}</b>${g ? ` <span class="glyph">${g}</span>` : ''}${a.tag ? ` <span class="badge">${esc(a.tag)}</span>` : ''}${a.traits?.length ? ` <span class="muted small">(${esc(a.traits.join(', '))})</span>` : ''}</summary><div class="comp-desc">${a.desc || ''}</div></details>`;
}
function cardHtml(c, st, hp, readOnly) {
  const bar = st.sharedHp ? '' : (() => {
    const pct = hp.max ? Math.max(0, Math.min(100, (hp.cur / hp.max) * 100)) : 0;
    return `<div class="comp-hp">
      <div class="comp-hp-num"><b>${hp.cur}</b><span>/ ${hp.max} HP</span>${hp.temp ? `<span class="gm-temp">+${hp.temp} temp</span>` : ''}</div>
      <div class="gm-bar ${pct <= 25 ? 'low' : pct <= 50 ? 'mid' : ''}"><div style="width:${pct}%"></div>${hp.temp ? '<i></i>' : ''}</div>
      ${readOnly ? '' : `<div class="row comp-hp-btns"><button type="button" class="btn small danger" data-chp="dmg">Damage</button><button type="button" class="btn small" data-chp="heal">Heal</button><button type="button" class="btn small" data-chp="temp">Temp</button></div>`}
    </div>`;
  })();
  const sub = [st.typeName, KIND_LABEL[c.kind], st.stageLabel, st.level != null ? 'level ' + st.level : ''].filter(Boolean).join(' · ');
  return `<article class="comp-card" data-comp="${esc(c.id)}">
    <header class="comp-head"><div><h3>${esc(c.name || st.typeName || KIND_LABEL[c.kind])}</h3><span class="muted small">${esc(sub)}</span></div>
      ${readOnly ? '' : `<button type="button" class="btn small ghost" data-cedit="${esc(c.id)}">⚙ Set up</button>`}</header>
    ${st.warnings.map((w) => `<p class="notice small">${esc(w)}</p>`).join('')}
    ${st.missing ? '' : `
    ${bar}
    ${st.sharedHp ? `<p class="small muted comp-shared">Shares your Hit Points (${hp.max} max).</p>` : ''}
    <div class="comp-defs">
      <span><small>AC</small><b>${st.ac}</b></span><span><small>Fort</small><b>${signed(st.saves.fortitude)}</b></span><span><small>Ref</small><b>${signed(st.saves.reflex)}</b></span><span><small>Will</small><b>${signed(st.saves.will)}</b></span><span><small>Perception</small><b>${signed(st.perception)}</b></span>
    </div>
    ${traitChips([st.size ? SIZE_NAME[st.size].toLowerCase() : null, ...(st.traits || [])].filter(Boolean), st.rarity)}
    <p class="small comp-line"><b>Speed</b> ${esc(st.speed || '—')}${st.senses?.length ? ` · <b>Senses</b> ${esc(st.senses.join(', '))}` : ''}${st.language ? ` · <b>Language</b> ${esc(st.language)}` : ''}</p>
    ${st.attrs ? `<p class="small comp-attrs">${ATTRS6.map((a) => `<span><b>${titleCase(a)}</b> ${signed(st.attrs[a])}</span>`).join('')}</p>` : ''}
    ${st.skills.length ? `<p class="small"><b>Skills</b> ${st.skills.map((s) => `${esc(s.name)} ${signed(s.mod)}${s.rank > 1 ? ` <span class="muted">(${RANK_LETTER[s.rank]})</span>` : ''}`).join(', ')}</p>` : ''}
    ${st.strikes.map((s) => `<div class="comp-strike"><span class="glyph">◆</span> <b>${esc(titleCase(s.name))}</b> <span class="mono">${signed(s.attack)}</span>${s.traits?.length ? ` <span class="muted small">(${esc(s.traits.join(', ').replace(/-/g, ' '))}${s.range ? `, range ${s.range} ft` : ''})</span>` : ''} · <span class="mono">${esc(s.damage)}</span></div>`).join('')}
    ${st.abilityCount ? `<h4 class="comp-sub">Abilities today <span class="muted small">${st.abilityCount.picked} of ${st.abilityCount.max}</span></h4>` : st.abilities.length ? '<h4 class="comp-sub">Abilities</h4>' : ''}
    ${st.abilities.map(abilityHtml).join('')}
    ${st.lockedAbilities?.length ? `<p class="muted small">Later: ${st.lockedAbilities.map((a) => `${esc(a.name)} (${esc(a.tag)})`).join(', ')}</p>` : ''}
    ${st.evolutions?.length ? `<p class="small"><b>Evolution feats</b> ${st.evolutions.map((f) => `<a class="ref" data-ref="feats/${esc(f.slug)}">${esc(f.name)}</a>`).join(', ')}</p>` : ''}
    ${st.notesAuto?.length ? `<ul class="comp-notes muted small">${st.notesAuto.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    ${c.notes ? `<p class="small comp-own-notes">${esc(c.notes)}</p>` : ''}`}
  </article>`;
}

/**
 * ctx: { db, build, state, ch, readOnly, saveBuild(), saveState(), rerender() }
 */
export async function renderCompanions(el, ctx) {
  const { build, state, ch, readOnly } = ctx;
  const list = companionList(build);
  el.innerHTML = '<p class="muted small">Loading…</p>';
  const data = await loadCompanionData(ctx.db);
  if (!el.isConnected) return;
  const h = hints(ch);
  const suggest = [h.animal ? 'an animal companion' : null, h.familiar ? 'a familiar' : null, h.eidolon ? 'an eidolon' : null].filter(Boolean);
  el.innerHTML = `
    ${list.length ? '' : `<div class="inv-empty"><span>${suggest.length ? `Your feats give you ${suggest.join(' and ')}. ` : ''}Add a companion to track its statistics and Hit Points here.</span></div>`}
    <div class="comp-list">${list.map((c) => { const st = companionStats(c, ch, data); return cardHtml(c, st, companionHp(state, c, st), readOnly); }).join('')}</div>
    ${readOnly ? '' : `<div class="row comp-add">${['animal', 'familiar', 'eidolon'].map((k) => `<button type="button" class="btn ${(k === 'animal' && h.animal) || (k === 'familiar' && h.familiar) || (k === 'eidolon' && h.eidolon) ? 'primary' : ''}" data-cadd="${k}">+ ${KIND_LABEL[k]}</button>`).join('')}</div>`}`;
  wireRefs(ctx.db, el);
  if (readOnly) return;
  $$('[data-cadd]', el).forEach((b) => (b.onclick = () => {
    const kind = b.dataset.cadd;
    const c = { id: 'c' + uid(), kind, name: '' };
    if (kind === 'animal') { c.stage = h.stage === 'specialized' || h.stage === 'incredible' ? 'nimble' : h.stage; c.specs = []; }
    if (kind === 'familiar') c.abilities = [];
    if (kind === 'eidolon') { c.kas = 'str'; c.boosts = {}; c.primary = { option: 'd8', trait: 'trip', dmg: 'slashing', name: 'claws' }; c.secondary = { name: 'tail', dmg: 'bludgeoning' }; }
    openSetup(c, ctx, data, true);
  }));
  $$('[data-cedit]', el).forEach((b) => (b.onclick = () => { const c = list.find((x) => x.id === b.dataset.cedit); if (c) openSetup(JSON.parse(JSON.stringify(c)), ctx, data, false); }));
  $$('[data-comp]', el).forEach((card) => {
    const c = list.find((x) => x.id === card.dataset.comp); if (!c) return;
    $$('[data-chp]', card).forEach((b) => (b.onclick = () => hpDialog(c, b.dataset.chp, ctx, data)));
  });
}

function hpDialog(c, mode, ctx, data) {
  const st = companionStats(c, ctx.ch, data);
  const m = modal(`${mode === 'dmg' ? 'Damage' : mode === 'heal' ? 'Heal' : 'Temp HP'}: ${c.name || st.typeName}`, { cls: 'hp-pad' });
  let val = '';
  const draw = () => {
    m.body.innerHTML = `<div class="pad-val ${mode}">${val || '0'}</div>
      <div class="pad-keys">${[7, 8, 9, 4, 5, 6, 1, 2, 3, 'C', 0, '⌫'].map((k) => `<button type="button" class="pad-k" data-k="${k}">${k}</button>`).join('')}</div>
      <div class="pad-quick">${[1, 5, 10].map((n) => `<button type="button" class="chip-btn" data-q="${n}">+${n}</button>`).join('')}${mode === 'heal' ? '<button type="button" class="chip-btn" data-full>Full</button>' : ''}</div>
      <button type="button" class="btn ${mode === 'dmg' ? 'danger' : 'primary'} pad-go">${mode === 'dmg' ? 'Apply damage' : mode === 'heal' ? 'Heal' : 'Set temp HP'}</button>`;
    $$('.pad-k', m.body).forEach((b) => (b.onclick = () => { const k = b.dataset.k; val = k === 'C' ? '' : k === '⌫' ? val.slice(0, -1) : (val + k).replace(/^0+/, '').slice(0, 4); draw(); }));
    $$('[data-q]', m.body).forEach((b) => (b.onclick = () => { val = String((Number(val) || 0) + Number(b.dataset.q)); draw(); }));
    const full = $('[data-full]', m.body); if (full) full.onclick = () => { val = String(st.hp.max); draw(); };
    $('.pad-go', m.body).onclick = () => {
      const n = Number(val) || 0; m.close(); if (!n) return;
      const all = (ctx.state.companions = ctx.state.companions || {});
      const s = (all[c.id] = all[c.id] || {});
      const hp = companionHp(ctx.state, c, st);
      if (mode === 'dmg') { const t = Math.min(hp.temp, n); s.temp = hp.temp - t; s.hp = Math.max(0, hp.cur - (n - t)); }
      else if (mode === 'heal') s.hp = Math.min(hp.max, hp.cur + n);
      else s.temp = Math.max(hp.temp, n);
      ctx.saveState(); ctx.rerender();
    };
  };
  draw();
}

// ------------------------------------------------------------------ set-up dialog
function openSetup(c, ctx, data, isNew) {
  const { ch } = ctx;
  const m = modal(isNew ? 'New ' + KIND_LABEL[c.kind].toLowerCase() : 'Set up ' + (c.name || KIND_LABEL[c.kind].toLowerCase()), { wide: true, cls: 'comp-setup' });
  const h = hints(ch);
  let famQ = '';
  const opt = (pairs, cur) => pairs.map(([v, l]) => `<option value="${esc(v)}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const bySrc = (list) => {
    const groups = {};
    for (const x of list) (groups[x.src || 'Other'] = groups[x.src || 'Other'] || []).push(x);
    const order = Object.keys(groups).sort((a, b) => (/Player Core/.test(b) - /Player Core/.test(a)) || a.localeCompare(b));
    return order.map((g) => `<optgroup label="${esc(g.replace(/^Pathfinder /, ''))}">${groups[g].map((x) => `<option value="${esc(x.slug)}" ${c.type === x.slug ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>`).join('');
  };
  const preview = () => { const st = companionStats(c, ch, data); return st.missing ? '' : `<div class="comp-preview">${cardHtml(c, st, { cur: st.hp.max, max: st.hp.max, temp: 0 }, true)}</div>`; };
  const draw = () => {
    let body = `<label class="field"><span>Name</span><input type="text" name="name" value="${esc(c.name || '')}" maxlength="60" placeholder="${c.kind === 'animal' ? 'e.g. Fang' : c.kind === 'familiar' ? 'e.g. Mister Whiskers' : 'e.g. Seraphine'}"></label>`;
    if (c.kind === 'animal') {
      const t = data.animal.find((x) => x.slug === c.type);
      body += `
        <div class="ce-grid">
          <label class="field wide"><span>Type</span><select name="type"><option value="">Choose…</option>${bySrc(data.animal)}</select></label>
          <label class="field wide"><span>Advancement</span><select name="stage">${opt(STAGES.map((s) => [s.id, s.label]), c.stage)}</select></label>
        </div>
        <p class="muted small">${h.stage !== 'young' ? `Your feats point to <b>${h.stage === 'incredible' ? 'nimble or savage' : h.stage}</b>. ` : ''}Mature at level 4–6 with a feat, nimble or savage at 8–10, specialized at 14–16, depending on your class.</p>
        ${t?.blurb ? `<p class="small">${esc(t.blurb)}</p>` : ''}
        ${['nimble', 'savage', 'indomitable'].includes(c.stage) ? `<h4 class="comp-sub">Specializations <span class="muted small">(most companions get one)</span></h4>
          <div class="comp-specs">${data.specializations.map((s) => `<label class="comp-check"><input type="checkbox" data-spec="${esc(s.slug)}" ${(c.specs || []).includes(s.slug) ? 'checked' : ''}> <span><b>${esc(s.name)}</b> <span class="muted small">${esc((s.src || '').replace(/^Pathfinder /, ''))}</span></span></label>`).join('')}</div>
          ${(c.specs || []).includes('racer') ? `<label class="field"><span>Racer: +10 feet to</span><select name="racerSpeed">${opt([['land', 'Speed'], ['fly', 'Fly Speed'], ['swim', 'Swim Speed']], c.racerSpeed || 'land')}</select></label>` : ''}` : ''}
        <div class="ce-grid">
          <label class="field"><span>Barding item bonus</span><input type="number" name="bitem" min="0" max="3" value="${esc(c.barding?.item ?? 0)}"></label>
          <label class="field"><span>Barding Dex cap</span><input type="number" name="bcap" min="0" max="6" value="${esc(c.barding?.dexCap ?? '')}" placeholder="none"></label>
        </div>`;
    } else if (c.kind === 'familiar') {
      const st = companionStats(c, ch, data);
      const q = famQ.trim().toLowerCase();
      const list = data.familiar.filter((f) => !q || f.name.toLowerCase().includes(q) || (c.abilities || []).includes(f.slug));
      body += `
        <div class="ce-grid"><label class="field"><span>Extra abilities</span><input type="number" name="extra" value="${esc(c.extra || 0)}" min="-4" max="10"></label></div>
        <p class="muted small">Your familiar gets <b>${st.abilityCount.max}</b> abilities a day${h.abilities > 2 ? ' (from your class and feats)' : ''}. Pick the ones it has today; you can change them during daily preparations.</p>
        <input type="search" name="famq" placeholder="Find an ability…" value="${esc(famQ)}" aria-label="Find a familiar ability">
        <div class="comp-fam">${list.map((f) => `<label class="comp-check ${(c.abilities || []).includes(f.slug) ? 'on' : ''}"><input type="checkbox" data-fam="${esc(f.slug)}" ${(c.abilities || []).includes(f.slug) ? 'checked' : ''}>
          <span><b>${esc(f.name)}</b> <span class="muted small">${esc((f.src || '').replace(/^Pathfinder /, ''))}</span><span class="comp-fam-desc small">${esc(String(f.desc || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140))}…</span></span></label>`).join('')}</div>`;
    } else {
      const t = data.eidolons.find((x) => x.slug === c.type);
      const boostLv = [5, 10, 15, 20].filter((l) => l <= ch.level);
      const p = c.primary || {}; const s2 = c.secondary || {};
      body += `
        <div class="ce-grid">
          <label class="field wide"><span>Eidolon type</span><select name="type"><option value="">Choose…</option>${bySrc(data.eidolons)}</select></label>
          <label class="field"><span>Attributes</span><select name="kas" title="Strength: Str +4, Dex +2, AC +2 (Dex cap +3). Dexterity: Str +2, Dex +4, AC +1 (Dex cap +4).">${opt([['str', 'Str +4, Dex +2'], ['dex', 'Dex +4, Str +2']], c.kas)}</select></label>
          ${t && (t.sizes || []).length > 1 ? `<label class="field"><span>Size</span><select name="size">${opt(t.sizes.map((s) => [s, SIZE_NAME[s]]), c.size || t.size)}</select></label>` : ''}
        </div>
        ${t ? `<p class="small">${esc(t.blurb || '')}</p><p class="muted small"><b>Tradition</b> ${esc(t.tradition)} · <b>Attributes</b> ${esc(t.attrText)} · <b>Suggested attacks</b> ${esc(t.attacks)}</p>` : ''}
        <h4 class="comp-sub">Primary attack</h4>
        <div class="ce-grid">
          <label class="field"><span>Name</span><input type="text" name="pname" value="${esc(p.name || '')}" placeholder="claws"></label>
          <label class="field wide"><span>Kind</span><select name="popt">${opt(EIDOLON_PRIMARY.map((o) => [o.id, o.label]), p.option || 'd8')}</select></label>
          ${(p.option || 'd8') === 'd8' ? `<label class="field"><span>Trait</span><select name="ptrait">${opt(EIDOLON_D8_TRAITS.map((x) => [x, titleCase(x)]), p.trait || 'trip')}</select></label>` : ''}
          <label class="field"><span>Damage</span><select name="pdmg">${opt(DAMAGE_TYPES.map((x) => [x, titleCase(x)]), p.dmg || 'slashing')}</select></label>
        </div>
        <h4 class="comp-sub">Secondary attack <span class="muted small">1d6, agile, finesse</span></h4>
        <div class="ce-grid">
          <label class="field"><span>Name</span><input type="text" name="sname" value="${esc(s2.name || '')}" placeholder="tail"></label>
          <label class="field"><span>Damage</span><select name="sdmg">${opt(DAMAGE_TYPES.map((x) => [x, titleCase(x)]), s2.dmg || 'bludgeoning')}</select></label>
        </div>
        ${boostLv.length ? `<h4 class="comp-sub">Attribute boosts <span class="muted small">4 each at 5th, 10th, 15th and 20th level</span></h4>
          ${boostLv.map((l) => `<div class="comp-boosts"><span class="label">${l}th</span>${ATTRS6.map((a) => `<label class="chip-btn ${((c.boosts || {})[l] || []).includes(a) ? 'on' : ''}"><input type="checkbox" class="sr-only" data-boost="${l}:${a}" ${((c.boosts || {})[l] || []).includes(a) ? 'checked' : ''}>${titleCase(a)}</label>`).join('')}<span class="muted small">${((c.boosts || {})[l] || []).length}/4</span></div>`).join('')}` : ''}`;
    }
    body += `<label class="field"><span>Notes</span><textarea name="notes" rows="2" placeholder="Gear, tricks, anything to remember">${esc(c.notes || '')}</textarea></label>
      ${preview()}
      <div class="ce-foot">${isNew ? '' : '<button type="button" class="btn ghost danger" data-crm>Remove</button>'}<span class="spacer"></span><button type="button" class="btn ghost" data-cancel>Cancel</button><button type="button" class="btn primary" data-csave>${isNew ? 'Add' : 'Save'}</button></div>`;
    const top = m.body.scrollTop;
    m.body.innerHTML = body;
    m.body.scrollTop = top;
    wire();
  };
  const val = (n) => { const e = $(`[name=${n}]`, m.body); return e ? e.value : undefined; };
  const collect = () => {
    c.name = (val('name') || '').trim(); c.notes = (val('notes') || '').trim();
    if (c.kind === 'animal') {
      c.type = val('type') || ''; c.stage = val('stage') || 'young';
      if (val('racerSpeed') !== undefined) c.racerSpeed = val('racerSpeed');
      c.barding = { item: Number(val('bitem')) || 0, dexCap: val('bcap') === '' ? null : Number(val('bcap')) };
    } else if (c.kind === 'familiar') {
      c.extra = Number(val('extra')) || 0;
    } else {
      c.type = val('type') || ''; c.kas = val('kas') || 'str';
      if (val('size') !== undefined) c.size = val('size');
      c.primary = { name: (val('pname') || '').trim(), option: val('popt') || 'd8', trait: val('ptrait') || (c.primary || {}).trait || 'trip', dmg: val('pdmg') || 'slashing' };
      c.secondary = { name: (val('sname') || '').trim(), dmg: val('sdmg') || 'bludgeoning' };
    }
  };
  const wire = () => {
    $$('select, input[type=number]', m.body).forEach((e) => (e.onchange = () => { collect(); draw(); }));
    $$('[data-spec]', m.body).forEach((b) => (b.onchange = () => { collect(); c.specs = $$('[data-spec]', m.body).filter((x) => x.checked).map((x) => x.dataset.spec); draw(); }));
    $$('[data-fam]', m.body).forEach((b) => (b.onchange = () => {
      collect();
      const set = new Set(c.abilities || []);
      if (b.checked) set.add(b.dataset.fam); else set.delete(b.dataset.fam);
      c.abilities = [...set]; draw();
    }));
    const fq = $('[name=famq]', m.body);
    if (fq) fq.oninput = () => { collect(); famQ = fq.value; const pos = fq.selectionStart; draw(); const n = $('[name=famq]', m.body); n.focus(); n.setSelectionRange(pos, pos); };
    $$('[data-boost]', m.body).forEach((b) => (b.onchange = () => {
      collect();
      const [l, a] = b.dataset.boost.split(':');
      c.boosts = c.boosts || {};
      const cur = new Set(c.boosts[l] || []);
      if (b.checked) { if (cur.size >= 4) { toast('Four boosts at each of these levels.', 'error'); draw(); return; } cur.add(a); } else cur.delete(a);
      c.boosts[l] = [...cur]; draw();
    }));
    $('[data-cancel]', m.body).onclick = m.close;
    const rm = $('[data-crm]', m.body);
    if (rm) rm.onclick = async () => {
      if (!(await confirmBox(`Remove ${c.name || 'this companion'} from the sheet?`))) return;
      ctx.build.companions = companionList(ctx.build).filter((x) => x.id !== c.id);
      if (ctx.state.companions) delete ctx.state.companions[c.id];
      m.close(); ctx.saveBuild(); ctx.saveState(); ctx.rerender();
    };
    $('[data-csave]', m.body).onclick = () => {
      collect();
      if ((c.kind === 'animal' || c.kind === 'eidolon') && !c.type) { toast('Pick a type first.', 'error'); return; }
      const list = companionList(ctx.build).slice();
      const i = list.findIndex((x) => x.id === c.id);
      if (i >= 0) list[i] = c; else list.push(c);
      ctx.build.companions = list;
      m.close(); ctx.saveBuild(); ctx.rerender();
    };
  };
  draw();
}

/** One line per companion for the GM's party view: [{name, kind, cur, max, temp, shared}] */
export function companionSummary(build, state, ch, data) {
  return companionList(build).map((c) => {
    const st = companionStats(c, ch, data);
    if (st.missing) return null;
    const hp = companionHp(state, c, st);
    return { id: c.id, name: c.name || st.typeName || KIND_LABEL[c.kind], kind: c.kind, cur: hp.cur, max: hp.max, temp: hp.temp, shared: !!st.sharedHp, ac: st.ac };
  }).filter(Boolean);
}
