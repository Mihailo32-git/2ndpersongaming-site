// Spell choices editor (builder Spells step and level-up page): repertoires, spellbooks,
// archetype casting, focus spells and innate spells for every kind of caster.
import { refOf } from './data.js';
import { actionGlyph, esc, showRef, toast } from './ui.js';
import { titleCase, signed } from './util.js';
import { ordinal, attrLabel, innatePickOptions } from './casting.js';

let ctxDb = null; // set by renderSpellsEditor for small row helpers
import { openSpellPicker, rarityBadge, deityFacts } from './pickers.js';

const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/** Where an entry's picks are stored in the build. */
export function storeFor(build, entry, create = true) {
  const sp = build.spells;
  if (entry.id === 'class') {
    if (create) { sp.rep = sp.rep || {}; sp.book = sp.book || {}; sp.sig = sp.sig || {}; }
    return sp;
  }
  const key = entry.id === 'apparition' ? 'apparition' : entry.arch;
  sp.arch = sp.arch || {};
  if (!sp.arch[key] && create) sp.arch[key] = { rep: {}, book: {}, sig: {} };
  const s = sp.arch[key] || { rep: {}, book: {}, sig: {} };
  s.rep = s.rep || {}; s.book = s.book || {}; s.sig = s.sig || {};
  return s;
}

export function entryStats(e) {
  return `<div class="sc-stats"><span class="sc-stat">${esc(titleCase(e.trad || '—'))} · ${esc(e.type)}</span><span class="sc-stat">Attack<b>${signed(e.attack)}</b></span><span class="sc-stat">DC<b>${e.dc}</b></span><span class="sc-stat">${esc(attrLabel(e.attr))}</span></div>`;
}

function spellLine(s, { remove = null, extra = '' } = {}) {
  const rec = s.rec;
  return `<div class="spell-line" style="padding-left:0"><span class="glyph">${actionGlyph(rec)}</span><span class="name" data-show="${esc(s.ref)}">${esc(rec?.name || s.ref)}</span>${rarityBadge(rec)}${extra}
    <span class="grow"></span>${remove ? `<button type="button" class="icon-btn" data-rm='${esc(JSON.stringify(remove))}' aria-label="Remove ${esc(rec?.name || '')}">✕</button>` : ''}</div>`;
}

/**
 * Renders the editor. ctx: { db, ch, build, update(), only: entry ids / 'focus' / 'innate' to show,
 *   ranks: { entryId: [ranks] } to show only those ranks (level tabs), pickKeys: choose-one focus picks to show,
 *   compact: drop the long explanations, card: CSS class for each section (default 'card') }
 */
export function renderSpellsEditor(root, ctx) {
  ctxDb = ctx.db;
  const { db, ch, build } = ctx;
  const sc = ch.spellcasting;
  const show = (k) => !ctx.only || ctx.only.includes(k);
  const card = ctx.card || 'card';
  const compact = !!ctx.compact;
  let html = '';
  if (!sc.any && !compact) {
    root.innerHTML = '<div class="card"><p>This character doesn’t cast spells yet. Spellcasting archetypes (like Bard Dedication) and focus spells show up here once you take them.</p></div>';
    return;
  }
  for (const e of sc.entries) {
    if (!show(e.id)) continue;
    const rk = ctx.ranks ? ctx.ranks[e.id] : null;
    if (ctx.ranks && !rk) continue;
    const want = (r) => !rk || rk.includes(Number(r));
    html += `<section class="${card}"><div class="sc-head"><h3>${esc(e.label)}${e.feat ? ` <span class="muted small">from ${esc(e.feat.name)}</span>` : ''}</h3>${entryStats(e)}</div>`;
    if (!compact) html += `<p class="small muted" style="margin-top:0">Spell slots per day: ${Object.entries(e.slots).map(([r, n]) => `${ordinal(r)} ×${n}`).join(' · ') || 'none yet'}${(e.extraSlots || []).filter((x) => x.rank > 0).length ? ` · plus ${esc(e.extraSlots.filter((x) => x.rank > 0).map((x) => x.label + ' ' + ordinal(x.rank) + (x.count > 1 ? ' ×' + x.count : '')).join(', '))}` : ''} · Cantrips heighten to rank ${sc.cantripRank}.</p>`;
    if (e.note && !compact) html += `<div class="notice small">${esc(e.note)}</div>`;
    if (e.warnings.length && !compact) html += `<div class="warnings small"><ul>${e.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`;
    if (e.psiCantrips?.length && want(0)) html += `<div class="rank-block"><div class="rank-head"><span class="rk">Psi</span><span class="small muted">From ${esc(e.mind?.name || 'your conscious mind')}</span></div>${e.psiCantrips.map((p) => spellLine(p, { extra: p.unique ? ' <span class="badge accent">unique psi cantrip</span>' : ' <span class="badge">psi cantrip</span>' })).join('')}</div>`;

    if (e.type === 'spontaneous') {
      const store = storeFor(build, e, false);
      const ranks = e.repLimits ? Object.keys(e.repLimits).map(Number) : Array.from({ length: e.maxRank + 1 }, (_, i) => i);
      for (const r of ranks) {
        if (!want(r)) continue;
        const list = e.repertoire[r] || [];
        const limit = e.repLimits ? e.repLimits[r] : null;
        const counted = list.filter((x) => !x.extra).length; // psychic mind spells are extra, not part of the count
        const sigOn = e.signatureCount && r > 0;
        html += `<div class="rank-block"><div class="rank-head"><span class="rk">${r === 0 ? 'Cantrips' : ordinal(r)}</span>
          <span class="small ${limit != null && counted < limit ? 'warn' : 'muted'}">${limit != null ? `${counted} of ${limit}` : `${counted}`}</span><span class="grow"></span>
          <button type="button" class="btn small ${limit != null && counted < limit ? 'primary' : ''}" data-add='${esc(JSON.stringify({ e: e.id, r, kind: 'rep' }))}'>+ Add</button></div>
          ${list.map((s) => spellLine(s, {
            remove: s.granted ? null : { e: e.id, r, kind: 'rep', ref: s.ref },
            extra: (s.granted ? ` <span class="badge">${s.extra ? 'extra · ' : 'granted · '}${esc(s.source || '')}</span>` : '')
              + (sigOn ? ` <label class="small muted" style="margin-left:6px"><input type="radio" name="sig-${esc(e.id)}-${r}" data-sig='${esc(JSON.stringify({ e: e.id, r }))}' value="${esc(s.ref)}" ${(store.sig || {})[r] === s.ref ? 'checked' : ''}> signature</label>` : '')
              // Signature Spell Expansion: up to two more, of 3rd rank or lower.
              + (e.sigExtra && r > 0 && r <= 3 && (store.sig || {})[r] !== s.ref ? (() => { const x = store.sigX || []; const on = x.includes(s.ref); return ` <label class="small muted" style="margin-left:6px"><input type="checkbox" data-sigx='${esc(JSON.stringify({ e: e.id, ref: s.ref }))}' ${on ? 'checked' : ''} ${!on && x.length >= e.sigExtra ? 'disabled' : ''}> extra signature</label>`; })() : ''),
          })).join('') || `<p class="muted small" style="margin:2px 0 0">None chosen.</p>`}</div>`;
      }
      if (e.signatureCount && !compact) html += `<p class="small muted">Signature spells (one per rank) can be cast at any rank you have slots for. ${Object.values(storeFor(build, e, false).sig || {}).filter(Boolean).length} of ${e.signatureCount} picked.${e.sigExtra ? ` Signature Spell Expansion: ${(storeFor(build, e, false).sigX || []).length} of ${e.sigExtra} extra (3rd rank or lower).` : ''}</p>`;
    } else if (e.book) {
      const b = e.book;
      html += `<div class="row between" style="margin-bottom:4px"><b>${esc(b.label)}</b><span class="small ${b.limit != null && (b.count < b.levelLimit || b.cantripCount < b.cantripLimit) ? 'warn' : 'muted'}">${b.limit != null ? `${b.cantripCount}/${b.cantripLimit} cantrips · ${b.count}/${b.levelLimit} spells` : `${b.cantripCount} cantrips · ${b.count} spells`}</span></div>`;
      for (let r = 0; r <= e.maxRank; r++) {
        if (!want(r)) continue;
        const list = b.spells[r] || [];
        html += `<div class="rank-block"><div class="rank-head"><span class="rk">${r === 0 ? 'Cantrips' : ordinal(r)}</span><span class="small muted">${list.length}</span><span class="grow"></span>
          <button type="button" class="btn small" data-add='${esc(JSON.stringify({ e: e.id, r, kind: 'book' }))}'>+ Add</button></div>
          ${list.map((s) => spellLine(s, { remove: { e: e.id, r, kind: 'book', ref: s.ref } })).join('') || '<p class="muted small" style="margin:2px 0 0">None yet.</p>'}</div>`;
      }
      if (!compact) html += `<p class="small muted">You prepare spells from this list each day on the character sheet.</p>`;
    } else {
      html += `<div class="notice small">You prepare from the whole common ${esc(titleCase(e.trad || ''))} spell list each day — pick them on the character sheet. ${e.source === 'archetype' ? 'Uncommon spells need your GM’s say-so.' : ''}</div>`;
    }
    if (e.granted?.length && e.type !== 'spontaneous' && !compact) html += `<div class="rank-block"><div class="rank-head"><span class="rk">Granted</span></div>${e.granted.map((g) => spellLine(g, { extra: ` <span class="badge">${g.rank === 0 ? 'cantrip' : ordinal(g.rank)} · ${esc(g.source)}</span>` })).join('')}</div>`;
    if (e.curriculum && !compact) {
      html += `<div class="rank-block"><div class="rank-head"><span class="rk">School</span><span class="small muted">${esc(e.school?.name || '')} curriculum — one extra slot per rank for these spells</span></div>
        ${Object.entries(e.curriculum).map(([r, list]) => `<div class="small" style="margin:2px 0"><span class="muted mono">${r === '0' ? 'C' : r}</span> ${list.map((x) => `<a class="ref" data-ref="${esc(x.ref.slice(1))}">${esc(x.rec.name)}</a>`).join(', ')}</div>`).join('')}</div>`;
    }
    if (e.font && !compact) html += `<div class="rank-block"><div class="rank-head"><span class="rk">Font</span><span class="small">${e.font.count} extra ${ordinal(e.font.rank)}-rank slots for ${e.font.rec ? `<a class="ref" data-ref="${esc(e.font.spell.slice(1))}">${esc(e.font.rec.name)}</a>` : '<span class="warn">heal or harm — choose your divine font in the Class step</span>'}</span></div></div>`;
    if (e.id === 'class' && ch.deity && ch.class?.slug === 'cleric' && !compact) html += `<div class="rank-block"><div class="rank-head"><span class="rk">Deity</span><b>${esc(ch.deity.name)}</b></div>${deityFacts(db, ch.deity)}</div>`;
    html += `</section>`;
  }

  // Focus spells
  const f = sc.focus;
  if (ctx.pickKeys) {
    const picks = sc.picks.filter((p) => ctx.pickKeys.includes(p.key));
    if (picks.length) html += `<section class="${card}"><div class="sc-head"><h3>Spell choices</h3></div>${picks.map(pickHtml).join('')}</section>`;
  }
  if (show('focus') && (f.spells.length || f.cantrips.length || sc.picks.length || ch.focusMax || sc.advancedDomain)) {
    html += `<section class="${card}"><div class="sc-head"><h3>Focus spells</h3><div class="sc-stats"><span class="sc-stat">Focus points<b>${f.max}</b></span></div></div>`;
    if (f.estimated) html += `<p class="tiny muted">Focus pool counted from your focus spells (1 each, up to 3).</p>`;
    for (const p of sc.picks) html += pickHtml(p);
    if (sc.advancedDomain && sc.advancedDomain.options.length > 1) {
      html += `<div class="choice"><span class="choice-label">Advanced Domain — which domain</span><select data-advdomain class="${sc.advancedDomain.value ? '' : 'needs'}"><option value="">— choose —</option>${sc.advancedDomain.options.map((d) => `<option value="${esc(d.slug)}" ${sc.advancedDomain.value === d.slug ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></div>`;
    }
    const all = [...f.cantrips.map((x) => ({ ...x, c: true })), ...f.spells];
    html += all.map((s) => spellLine(s, {
      remove: s.manual ? { kind: 'focus', ref: s.ref } : null,
      extra: ` <span class="badge">${s.c ? 'cantrip' : 'focus'}${s.tier && s.tier !== 'initial' ? ' · ' + s.tier : ''}</span> <span class="small muted">${esc(s.source)} · ${esc(titleCase(s.trad || '—'))} · DC ${s.dc}</span>`,
    })).join('') || '<p class="muted small">No focus spells yet.</p>';
    html += `<div class="row" style="margin-top:8px"><button type="button" class="btn small" data-addfocus>+ Add a focus spell</button><span class="tiny muted">For focus spells a feat grants that weren’t picked up automatically.</span></div></section>`;
  }

  // Innate spells
  if (show('innate')) {
    html += `<section class="${card}"><div class="sc-head"><h3>Innate spells</h3></div>`;
    html += sc.innate.map((s) => {
      if (s.pickFor) {
        return `<div class="spell-line" style="padding-left:0"><span class="badge">${ordinal(s.rank)}</span> ${s.rec ? `<span class="name" data-show="${esc(s.ref)}">${esc(s.rec.name)}</span>` : '<span class="muted">Not chosen</span>'}<span class="small muted">${esc(s.source)}</span><span class="grow"></span>
          <button type="button" class="btn small ${s.rec ? '' : 'primary'}" data-innatepick='${esc(JSON.stringify(s.pickFor))}'>${s.rec ? 'Change' : 'Choose'}</button></div>`;
      }
      return spellLine(s, { remove: s.manual ? { kind: 'innate', ref: s.ref } : null, extra: ` <span class="badge">${s.rank ? ordinal(s.rank) : 'cantrip'}</span> <span class="small muted">${esc(s.source)}</span>` });
    }).join('') || '<p class="muted small">None yet. Spells from your heritage and feats show up here on their own; use the buttons for anything else.</p>';
    html += `<div class="row" style="margin-top:8px"><button type="button" class="btn small" data-addinnate="c">+ Innate cantrip</button><button type="button" class="btn small" data-addinnate="s">+ Innate spell</button></div></section>`;
  }
  root.innerHTML = html;
  wire(root, ctx);
}

function pickHtml(p) {
  if (p.list) {
    const l = p.list;
    const what = l.rank === 0 ? 'innate cantrip' : `${ordinal(l.rank)}-rank${l.orLower ? ' or lower' : ''} innate spell`;
    const trads = (Array.isArray(l.trad) ? l.trad : [l.trad]).filter(Boolean).map(titleCase).join(' or ');
    return `<div class="choice"><span class="choice-label">${esc(p.source)} — ${what}${trads ? ` <span class="muted small">(${esc(trads)}${l.common ? ', common' : ''})</span>` : ''}</span>
      ${p.value ? `<span class="name" data-show="${esc(p.value)}">${esc(ctxDb.get(p.value)?.name || p.value)}</span>` : ''}
      <button type="button" class="btn small ${p.value ? '' : 'primary'}" data-listpick="${esc(p.key)}">${p.value ? 'Change' : 'Choose'}</button></div>`;
  }
  return `<div class="choice"><span class="choice-label">${esc(p.source)} — choose a spell</span><select data-pick="${esc(p.key)}" class="${p.value ? '' : 'needs'}" aria-label="${esc(p.source)}: choose a spell"><option value="">— choose —</option>${p.options.map((o) => `<option value="${esc(o.ref)}" ${p.value === o.ref ? 'selected' : ''}>${esc(o.rec.name)}</option>`).join('')}</select>${p.value ? `<button type="button" class="icon-btn" data-show="${esc(p.value)}" aria-label="Read">ⓘ</button>` : ''}</div>`;
}

function wire(root, ctx) {
  const { db, build } = ctx;
  const sc = ctx.ch.spellcasting;
  const entry = (id) => sc.entries.find((e) => e.id === id);
  $$('[data-show]', root).forEach((el) => (el.onclick = (ev) => { ev.preventDefault(); showRef(db, el.dataset.show); }));
  $$('a.ref[data-ref]', root).forEach((a) => { a.href = '#'; a.onclick = (ev) => { ev.preventDefault(); showRef(db, '@' + a.dataset.ref); }; });
  $$('[data-add]', root).forEach((b) => (b.onclick = () => {
    const o = JSON.parse(b.dataset.add);
    const e = entry(o.e);
    const store = storeFor(build, e);
    const have = new Set([...Object.values(store.rep || {}).flat(), ...Object.values(store.book || {}).flat()].filter(Boolean));
    if (e.type === 'spontaneous') for (const list of Object.values(e.repertoire || {})) for (const s of list) have.add(s.ref);
    const isBook = o.kind === 'book';
    openSpellPicker(db, {
      title: `${o.r === 0 ? 'Cantrip' : ordinal(o.r) + '-rank spell'} — ${e.label}${isBook ? ' (' + (e.book?.label || 'book') + ')' : ''}`,
      trad: e.trad, rank: o.r || null, cantrips: o.r === 0, exclude: [...have], showRare: build.options?.showRare !== false,
    }, (s) => {
      const st = storeFor(build, e);
      const bucket = isBook ? st.book : st.rep;
      bucket[o.r] = [...(bucket[o.r] || []), refOf(s)];
      ctx.update();
      toast('Added ' + s.name, 'ok');
    });
  }));
  $$('[data-rm]', root).forEach((b) => (b.onclick = () => {
    const o = JSON.parse(b.dataset.rm);
    if (o.kind === 'focus') build.spells.focusExtra = (build.spells.focusExtra || []).filter((x) => x !== o.ref);
    else if (o.kind === 'innate') build.spells.innateExtra = (build.spells.innateExtra || []).filter((x) => x.ref !== o.ref);
    else {
      const st = storeFor(build, entry(o.e));
      const bucket = o.kind === 'book' ? st.book : st.rep;
      bucket[o.r] = (bucket[o.r] || []).filter((x) => x !== o.ref);
      if (st.sig && st.sig[o.r] === o.ref) delete st.sig[o.r];
    }
    ctx.update();
  }));
  $$('[data-sigx]', root).forEach((c) => (c.onchange = () => {
    const o = JSON.parse(c.dataset.sigx);
    const st = storeFor(build, entry(o.e));
    const x = new Set(st.sigX || []);
    if (c.checked) x.add(o.ref); else x.delete(o.ref);
    st.sigX = [...x];
    ctx.update();
  }));
  $$('[data-sig]', root).forEach((r) => (r.onchange = () => {
    const o = JSON.parse(r.dataset.sig);
    storeFor(build, entry(o.e)).sig[o.r] = r.value;
    ctx.update();
  }));
  $$('[data-listpick]', root).forEach((b) => (b.onclick = () => {
    const p = sc.picks.find((x) => x.key === b.dataset.listpick);
    if (!p) return;
    const taken = new Set(sc.innate.map((x) => x.ref).filter((r) => r && r !== p.value));
    openSpellPicker(db, { title: `${p.source} — ${p.list.rank === 0 ? 'innate cantrip' : 'innate spell'}`, only: innatePickOptions(db, p.list, build.options?.showRare !== false).map(refOf), exclude: [...taken], verb: 'Choose' }, (s) => {
      build.spells.pick = Object.assign({}, build.spells.pick || {}, { [p.key]: refOf(s) });
      ctx.update(); toast('Chose ' + s.name, 'ok');
    });
  }));
  $$('[data-pick]', root).forEach((s) => (s.onchange = () => {
    build.spells.pick = build.spells.pick || {};
    if (s.value) build.spells.pick[s.dataset.pick] = s.value; else delete build.spells.pick[s.dataset.pick];
    ctx.update();
  }));
  $$('[data-advdomain]', root).forEach((s) => (s.onchange = () => { build.spells.advDomain = s.value || null; ctx.update(); }));
  $$('[data-addfocus]', root).forEach((b) => (b.onclick = () => openSpellPicker(db, { title: 'Add a focus spell', focus: true, exclude: [...sc.focus.spells, ...sc.focus.cantrips].map((x) => x.ref) }, (s) => {
    build.spells.focusExtra = [...(build.spells.focusExtra || []), refOf(s)];
    ctx.update(); toast('Added ' + s.name, 'ok');
  })));
  $$('[data-addinnate]', root).forEach((b) => (b.onclick = () => openSpellPicker(db, { title: b.dataset.addinnate === 'c' ? 'Add an innate cantrip' : 'Add an innate spell', rank: null, cantrips: b.dataset.addinnate === 'c', exactRank: false }, (s) => {
    build.spells.innateExtra = [...(build.spells.innateExtra || []), { ref: refOf(s), rank: b.dataset.addinnate === 'c' ? 0 : s.rank }];
    ctx.update(); toast('Added ' + s.name, 'ok');
  })));
  $$('[data-innatepick]', root).forEach((b) => (b.onclick = () => {
    const o = JSON.parse(b.dataset.innatepick);
    // Archetypes that limit the choice ("must have the illusion or mental trait") get only those spells.
    const only = o.traits ? innatePickOptions(db, { trad: o.trad, rank: o.rank }, build.options?.showRare !== false).filter((s) => (s.traits || []).some((t) => o.traits.includes(t))).map(refOf) : null;
    openSpellPicker(db, { title: `${ordinal(o.rank)}-rank innate spell${o.traits ? ' (' + o.traits.join(' or ') + ')' : ''}`, trad: o.trad, rank: o.rank, cantrips: false, ...(only ? { only } : {}) }, (s) => {
      build.spells.innate = build.spells.innate || {};
      build.spells.innate[o.feat] = Object.assign({}, build.spells.innate[o.feat] || {}, { [o.rank]: refOf(s) });
      ctx.update();
    });
  }));
}
