// Shared UI pieces: modal dialogs, the rules-text viewer (tap a feat/spell/item to read it), toasts.

import { esc, titleCase, formatPrice, formatBulk, signed, refParts } from './util.js';

export const ACTION_GLYPH = { 1: '◆', 2: '◆◆', 3: '◆◆◆', reaction: '⟲', free: '◇' };

export function actionGlyph(rec) {
  if (!rec) return '';
  if (rec.action === 'reaction') return ACTION_GLYPH.reaction;
  if (rec.action === 'free') return ACTION_GLYPH.free;
  if (rec.action === 'action' && rec.actions) return ACTION_GLYPH[rec.actions] || '';
  if (rec.time) {
    const t = String(rec.time);
    if (/^[123]$/.test(t)) return ACTION_GLYPH[t];
    if (t === 'reaction') return ACTION_GLYPH.reaction;
    if (t === 'free') return ACTION_GLYPH.free;
    if (/^1 to 3$|^1 - 3$/.test(t)) return '◆–◆◆◆';
    if (/^1 or 2$/.test(t)) return '◆/◆◆';
    if (/^2 or 3$/.test(t)) return '◆◆/◆◆◆';
  }
  return '';
}

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function toast(msg, kind = 'info') {
  let box = document.getElementById('toasts');
  if (!box) { box = h('<div id="toasts"></div>'); document.body.appendChild(box); }
  const el = h(`<div class="toast ${kind}">${esc(msg)}</div>`);
  box.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2800);
}

/** Opens a modal. Returns {el, body, close}. */
export function modal(title, { wide = false, onClose, cls = '' } = {}) {
  const el = h(`<div class="modal-back"><div class="modal ${wide ? 'wide' : ''} ${esc(cls)}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <header><button class="back" hidden aria-label="Back">‹</button><h2>${esc(title)}</h2><button class="close" aria-label="Close">×</button></header>
    <div class="modal-body"></div></div></div>`);
  document.body.appendChild(el);
  document.body.classList.add('noscroll');
  let closed = false;
  const onKey = (e) => {
    // Only the top-most modal reacts to Escape.
    const all = document.querySelectorAll('.modal-back');
    if (e.key === 'Escape' && all[all.length - 1] === el) { e.stopPropagation(); close(); }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    el.remove();
    document.removeEventListener('keydown', onKey, true);
    if (!document.querySelector('.modal-back, .drawer')) document.body.classList.remove('noscroll');
    onClose && onClose();
  };
  el.querySelector('.close').onclick = close;
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  document.addEventListener('keydown', onKey, true);
  return { el, body: el.querySelector('.modal-body'), close, setTitle: (t) => (el.querySelector('h2').textContent = t) };
}

export function traitChips(traits, rarity) {
  const list = [];
  if (rarity && rarity !== 'common') list.push(`<span class="trait rarity-${esc(rarity)}" data-trait="${esc(rarity)}">${esc(titleCase(rarity))}</span>`);
  for (const t of traits || []) list.push(`<span class="trait" data-trait="${esc(t)}">${esc(titleCase(t))}</span>`);
  return list.length ? `<div class="traits">${list.join('')}</div>` : '';
}

function metaLines(rec) {
  const p = rec._pack, rows = [];
  const row = (k, v) => { if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) rows.push(`<div><b>${esc(k)}</b> ${v}</div>`); };
  if (p === 'feats' || p === 'classfeatures' || p === 'ancestryfeatures') {
    if (rec.prereq?.length) row('Prerequisites', esc(rec.prereq.join('; ')));
    if (rec.freq) row('Frequency', esc(rec.freq.replace('/', ' per ').replace(/PT(\d+)M/, '$1 min').replace('day', 'day')));
    if (rec.arch) row('Archetype', esc(titleCase(rec.arch)));
  }
  if (p === 'spells') {
    row('Traditions', esc((rec.trad || []).map(titleCase).join(', ')));
    row('Cast', esc(/^[123]$/.test(rec.time) ? '' : rec.time) + ' ' + actionGlyph(rec));
    row('Range', esc(rec.range)); row('Area', esc(rec.area)); row('Targets', esc(rec.target));
    if (rec.save) row('Defense', esc(titleCase(rec.save)));
    else if (rec.vs) row('Defense', esc(titleCase(rec.vs)));
    row('Duration', esc(rec.duration) + (rec.sustained ? ' (sustained)' : ''));
    if (rec.cost) row('Cost', esc(rec.cost));
  }
  if (p === 'equipment') {
    row('Price', esc(formatPrice(rec.price)) + (rec.per > 1 ? ` for ${rec.per}` : ''));
    row('Bulk', esc(formatBulk(rec.bulk)));
    if (rec.usage) row('Usage', esc(titleCase(rec.usage.replace(/^worn/, 'worn ').replace(/-/g, ' '))));
    if (rec.damage) row('Damage', esc(`${rec.damage.dice}${rec.damage.die} ${rec.damage.type}`));
    if (rec.cat && rec.type === 'weapon') row('Category', esc(titleCase(rec.cat)) + (rec.group ? ' · ' + esc(titleCase(rec.group)) : ''));
    if (rec.range) row('Range', esc(rec.range + ' ft.'));
    if (rec.type === 'armor') row('Armor', `AC +${rec.ac || 0}, Dex cap ${rec.dexCap ?? '—'}, Str ${rec.str ? '+' + rec.str : '—'}, check ${rec.checkPen || 0}, speed ${rec.speedPen || 0} ft.`);
    if (rec.type === 'shield') row('Shield', `AC +${rec.shieldAc}, Hardness ${rec.hardness}, HP ${rec.hp}`);
  }
  if (p === 'ancestries') row('Stats', `HP ${rec.hp} · Size ${esc(titleCase(rec.size))} · Speed ${rec.speed} ft.`);
  if (p === 'classes') row('Stats', `HP ${rec.hp} + Con per level · Key ${esc((rec.keyAbility || []).map((a) => a.toUpperCase()).join(' or ') || 'see subclass')}`);
  return rows.join('');
}

export function headerLine(rec) {
  const lvl = rec.level ?? rec.rank;
  const kind = { feats: 'Feat', classfeatures: 'Feature', ancestryfeatures: 'Feature', spells: (rec.traits || []).includes('cantrip') ? 'Cantrip' : (rec.traits || []).includes('focus') ? 'Focus' : 'Spell',
    equipment: 'Item', actions: 'Action', conditions: 'Condition', heritages: 'Heritage', backgrounds: 'Background', ancestries: 'Ancestry', classes: 'Class' }[rec._pack] || 'Effect';
  return `${kind}${lvl != null && lvl !== '' && rec._pack !== 'conditions' ? ' ' + lvl : ''}`;
}

/** Shows the rules text of a reference, with clickable links to other entries. */
export async function showRef(db, ref, { stack = null, extraHtml = '' } = {}) {
  const rec = db.get(ref);
  if (!rec) {
    const [pack] = refParts(ref);
    if (pack && !db.has(pack)) { await db.load([pack]); return showRef(db, ref, { stack, extraHtml }); }
    toast('Not found: ' + ref, 'error');
    return;
  }
  const m = stack || modal(rec.name, { wide: false });
  m.history = m.history || [];
  m.setTitle(rec.name);
  m.body.innerHTML = `<div class="ref-view"><div class="ref-head"><span class="glyph">${actionGlyph(rec)}</span><span class="kind">${esc(headerLine(rec))}</span></div>
    ${traitChips(rec.traits, rec.rarity)}<div class="meta">${metaLines(rec)}</div>${extraHtml}<div class="rules-text"><p class="muted">Loading…</p></div>
    <div class="source">${esc(rec.src || '')}${rec.lic ? ' · ' + esc(rec.lic) : ''}</div></div>`;
  const html = await db.text(ref);
  m.body.querySelector('.rules-text').innerHTML = html || '<p class="muted">No description.</p>';
  wireRefs(db, m.body, m, ref);
  const back = m.el.querySelector('.back');
  back.hidden = !m.history.length;
  back.onclick = () => { const prev = m.history.pop(); if (prev) showRef(db, prev, { stack: m }); };
  return m;
}

export function wireRefs(db, root, m = null, currentRef = null) {
  root.querySelectorAll('a.ref[data-ref]').forEach((a) => {
    a.href = '#';
    a.onclick = (e) => {
      e.preventDefault();
      const r = '@' + a.dataset.ref;
      if (m) { if (currentRef) m.history.push(currentRef); showRef(db, r, { stack: m }); }
      else showRef(db, r);
    };
  });
  root.querySelectorAll('.trait[data-trait]').forEach((t) => {
    t.onclick = async () => {
      await db.loadTraits();
      const d = db.traits[t.dataset.trait];
      if (d) toast(titleCase(t.dataset.trait) + ': ' + d.slice(0, 220));
    };
  });
}

export function confirmBox(text) {
  return new Promise((resolve) => {
    const m = modal('Please confirm', { onClose: () => resolve(false) });
    m.body.innerHTML = `<p>${esc(text)}</p><div class="row end"><button class="btn ghost no">Cancel</button><button class="btn danger yes">Yes</button></div>`;
    m.body.querySelector('.no').onclick = () => { m.close(); };
    m.body.querySelector('.yes').onclick = () => { resolve(true); m.close(); };
  });
}

export function promptBox(title, label, value = '') {
  return new Promise((resolve) => {
    const m = modal(title, { onClose: () => resolve(null) });
    m.body.innerHTML = `<label class="field"><span>${esc(label)}</span><input type="text" value="${esc(value)}"></label><div class="row end"><button class="btn ghost no">Cancel</button><button class="btn ok">OK</button></div>`;
    const inp = m.body.querySelector('input');
    inp.focus();
    const done = () => { const v = inp.value; resolve(v); m.close(); };
    m.body.querySelector('.ok').onclick = done;
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(); };
    m.body.querySelector('.no').onclick = () => m.close();
  });
}

export function rankBadge(rank) {
  const L = ['U', 'T', 'E', 'M', 'L'][rank || 0];
  return `<span class="rank r${rank || 0}" title="${['Untrained', 'Trained', 'Expert', 'Master', 'Legendary'][rank || 0]}">${L}</span>`;
}

export function statPill(label, value, extra = '') {
  return `<div class="pill"><span class="pill-label">${esc(label)}</span><span class="pill-value">${value}</span>${extra}</div>`;
}

export { signed, esc };
