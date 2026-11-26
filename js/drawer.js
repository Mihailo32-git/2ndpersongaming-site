// The drawer: one picker for everything (ancestries, feats, spells, choices, skills…).
// A glass panel slides in from the right with search, filter chips, a list and a detail pane.
// On phones it fills the screen and the detail opens over the list with a back button.
import { esc, wireRefs } from './ui.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/**
 * opts:
 *  title, subtitle, narrow
 *  items: [{ key, name, level, rarity, group, meta, metaClass, disabled, rec }]
 *  selected: key of the current value
 *  chips: [{ id, label, test(item) }] — single-select filters, the first is active
 *  hideDisabled: hide disabled items behind a "Show unavailable" chip
 *  search (default true), placeholder
 *  detail(item) → HTML for the detail pane; textRef(item) → rules-text ref loaded below it
 *  instant: pick on click (no detail pane)
 *  pickLabel(item), canPick(item), onPick(item) — return false from onPick to keep the drawer open
 *  custom(body, api) — render custom content instead of a list
 *  db (for rules text), onClose
 */
export function openDrawer(opts) {
  const o = Object.assign({ search: true, placeholder: 'Search…', chips: [], items: [], hideDisabled: false, limit: 600 }, opts);
  // Drawers stack: a spell picker opened from inside the spell editor sits on top and returns to it.
  const depth = document.querySelectorAll('.drawer').length;
  const back = document.createElement('div');
  back.className = 'drawer-back';
  // Above whatever is open already (a drawer opened from a window, such as the rune picker from the Runes window).
  const top = Math.max(94, ...[...document.querySelectorAll('.modal-back, .drawer, .drawer-back')].map((x) => Number(getComputedStyle(x).zIndex) || 0));
  back.style.zIndex = String(Math.max(95 + depth * 2, top + 1));
  const el = document.createElement('aside');
  el.className = 'drawer' + (o.narrow || o.instant ? ' narrow' : '');
  el.style.zIndex = String(Math.max(96 + depth * 2, top + 2));
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', o.title || 'Choose');
  el.innerHTML = `<header><button type="button" class="dr-back" aria-label="Back to list">‹</button>
      <div class="dr-titles"><h2>${esc(o.title || '')}</h2>${o.subtitle ? `<div class="dr-sub">${o.subtitle}</div>` : ''}</div>
      <button type="button" class="dr-close" aria-label="Close">×</button></header>
    ${o.custom ? '<div class="dr-custom"></div>' : `
    <div class="dr-filters">${o.search ? `<input type="search" placeholder="${esc(o.placeholder)}" aria-label="Search">` : ''}
      ${o.chips.length || o.hideDisabled ? `<div class="dr-chips">${o.chips.map((c, i) => `<button type="button" class="chipbtn" data-chip="${esc(c.id)}" aria-pressed="${i === 0}">${esc(c.label)}</button>`).join('')}
        ${o.hideDisabled ? '<button type="button" class="chipbtn" data-unavail aria-pressed="false">Show unavailable</button>' : ''}</div>` : ''}</div>
    <div class="dr-body"><div class="dr-list" role="listbox" aria-label="${esc(o.title || 'Options')}"></div><div class="dr-detail" aria-live="polite"></div></div>`}`;
  document.body.appendChild(back);
  document.body.appendChild(el);
  document.body.classList.add('noscroll');
  requestAnimationFrame(() => { back.classList.add('open'); el.classList.add('open'); });

  let closed = false;
  const onKey = (e) => {
    if (document.querySelector('.modal-back')) return;
    const all = document.querySelectorAll('.drawer');
    if (all[all.length - 1] !== el) return; // only the top drawer reacts
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  };
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    el.remove(); back.remove();
    if (!document.querySelector('.modal-back, .drawer')) document.body.classList.remove('noscroll');
    o.onClose && o.onClose();
  }
  el._close = close;
  back.onclick = close;
  $('.dr-close', el).onclick = close;
  $('.dr-back', el).onclick = () => el.classList.remove('show-detail');
  document.addEventListener('keydown', onKey);
  const api = { close, el };

  if (o.custom) { o.custom($('.dr-custom', el), api); return api; }

  const listEl = $('.dr-list', el), detailEl = $('.dr-detail', el), search = $('input[type=search]', el);
  const st = { q: '', chip: o.chips[0]?.id || null, unavail: false, focus: o.selected ?? null };
  const visible = () => {
    const q = st.q.trim().toLowerCase();
    const chip = o.chips.find((c) => c.id === st.chip);
    const out = o.items.filter((it) => (!q || it.name.toLowerCase().includes(q)) && (!chip || !chip.test || chip.test(it))
      && (!o.hideDisabled || st.unavail || !it.disabled || it.key === o.selected));
    if (!q) return out;
    // Best matches first within each group: "rage" puts Rage before Armored Courage.
    const groupAt = new Map();
    out.forEach((it) => { if (!groupAt.has(it.group)) groupAt.set(it.group, groupAt.size); });
    const rank = (n) => { n = n.toLowerCase(); return n === q ? 0 : n.startsWith(q) ? 1 : n.split(/[\s(:,-]+/).some((w) => w.startsWith(q)) ? 2 : 3; };
    return out.map((it, i) => ({ it, i, g: groupAt.get(it.group), r: rank(it.name) }))
      .sort((a, b) => a.g - b.g || a.r - b.r || a.i - b.i).map((x) => x.it);
  };
  const draw = () => {
    const items = visible();
    let html = '', last = null;
    for (const it of items.slice(0, o.limit)) {
      if (it.group && it.group !== last) { html += `<div class="dr-group">${esc(it.group)}</div>`; last = it.group; }
      const sel = it.key === o.selected;
      html += `<button type="button" role="option" aria-selected="${sel}" class="dr-item ${sel ? 'selected' : ''} ${it.key === st.focus && !sel ? 'focused' : ''} ${it.disabled ? 'disabled' : ''}" data-key="${esc(String(it.key))}">
        ${it.level != null ? `<span class="lvl">${esc(it.level)}</span>` : ''}<span class="nm"><span class="t">${esc(it.name)}</span>${it.badge || ''}${it.meta ? `<br><span class="m ${it.metaClass || ''}">${it.meta}</span>` : ''}</span>${sel ? '<span class="ok">✓</span>' : ''}</button>`;
    }
    if (items.length > o.limit) html += `<p class="empty-note">Showing the first ${o.limit} — search to narrow it down.</p>`;
    listEl.innerHTML = html || `<p class="empty-note">Nothing matches.${o.hideDisabled && !st.unavail ? ' Try “Show unavailable”.' : ''}</p>`;
    $$('.dr-item', listEl).forEach((b) => (b.onclick = () => {
      const it = o.items.find((x) => String(x.key) === b.dataset.key);
      if (!it) return;
      if (o.instant) { if (!it.disabled || o.allowDisabled) pick(it); return; }
      st.focus = it.key;
      $$('.dr-item.focused', listEl).forEach((x) => x.classList.remove('focused'));
      if (!b.classList.contains('selected')) b.classList.add('focused');
      showDetail(it);
      el.classList.add('show-detail');
    }));
  };
  const pick = (it) => {
    const r = o.onPick(it);
    if (r !== false) close();
  };
  const showDetail = async (it) => {
    if (!it) { detailEl.innerHTML = `<p class="muted small">Pick something from the list to read it.</p>`; return; }
    const can = o.canPick ? o.canPick(it) : !it.disabled;
    const sel = it.key === o.selected;
    detailEl.innerHTML = `${o.detail ? o.detail(it) : `<h3>${esc(it.name)}</h3>`}
      ${o.textRef ? '<div class="rules-text small" style="margin-top:8px">Loading…</div>' : ''}
      <div class="dr-take">${sel ? '<p class="ok small" style="margin:0 0 8px">✓ Current choice</p>' : ''}
        ${sel && !o.repickSelected ? '' : `<button type="button" class="btn primary block take" ${can ? '' : 'disabled'}>${esc(o.pickLabel ? o.pickLabel(it) : 'Choose ' + it.name)}</button>`}</div>`;
    const take = $('.take', detailEl);
    if (take) take.onclick = () => pick(it);
    if (o.textRef && o.db) {
      const ref = o.textRef(it);
      const html = ref ? await o.db.text(ref) : '';
      if (st.focus !== it.key && !(st.focus === null && it.key === o.selected)) return;
      const rt = $('.rules-text', detailEl);
      if (rt) { rt.innerHTML = html || '<p class="muted">No description.</p>'; wireRefs(o.db, detailEl); }
    }
    detailEl.scrollTop = 0;
  };
  if (search) search.oninput = () => { st.q = search.value; draw(); };
  $$('[data-chip]', el).forEach((b) => (b.onclick = () => {
    st.chip = b.dataset.chip;
    $$('[data-chip]', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    draw();
  }));
  const un = $('[data-unavail]', el);
  if (un) un.onclick = () => { st.unavail = !st.unavail; un.setAttribute('aria-pressed', String(st.unavail)); draw(); };
  draw();
  if (!o.instant) {
    const first = o.items.find((x) => x.key === o.selected);
    showDetail(first || null);
  }
  // Focus the search box only with a mouse and keyboard: on a tablet it would pop the on-screen keyboard over the list.
  const finePointer = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (search && finePointer && window.innerWidth >= 900) setTimeout(() => search.focus(), 60);
  else { const s = listEl.querySelector('.selected'); if (s) s.scrollIntoView({ block: 'center' }); }
  api.redraw = draw;
  api.setItems = (items) => { o.items = items; draw(); };
  return api;
}

export function closeAll() {
  $$('.drawer').forEach((d) => (d._close ? d._close() : d.remove()));
  $$('.drawer-back').forEach((d) => d.remove());
}
