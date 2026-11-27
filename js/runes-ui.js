// The Runes window for one weapon or armor: fundamental runes, property runes (one per point of potency) and special material.
import { modal, esc, showRef } from './ui.js';
import { openDrawer } from './drawer.js';
import { runeKind, runeSlots, runeRef, GRADE_NAMES } from './runes.js';
import { formatPrice } from './util.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const STRIKING = ['None', 'Striking', 'Greater striking', 'Major striking'];
const RESILIENT = ['None', 'Resilient', 'Greater resilient', 'Major resilient'];

/** opts: { db, it (inventory entry, changed in place), level (character level), readOnly, onChange() } */
export function openRuneManager({ db, it, level = 20, readOnly = false, giant = false, onChange = () => {} }) {
  const rec = db.get(it.ref);
  const kind = runeKind(rec);
  if (!kind) return;
  const RD = db.runeData || { weapon: {}, armor: {}, materials: { weapon: [], armor: [] } };
  const m = modal(`Runes: ${rec.name}`, { cls: 'rune-modal' });
  const changed = () => { onChange(); draw(); };
  const seg = (name, labels, value) => `<div class="rune-seg" role="radiogroup" aria-label="${esc(name)}">${labels.map((l, i) => `<button type="button" role="radio" class="chip-btn ${value === i ? 'on' : ''}" aria-checked="${value === i}" data-${esc(name)}="${i}" ${readOnly ? 'disabled' : ''}>${esc(l)}</button>`).join('')}</div>`;
  const draw = () => {
    const runes = Array.isArray(it.runes) ? it.runes : [];
    const slots = runeSlots(it);
    const table = RD[kind] || {};
    const mats = (RD.materials && RD.materials[kind]) || [];
    const mat = it.material || {};
    const matRec = mats.find((x) => x.slug === mat.type);
    m.body.innerHTML = `
      <div class="rune-sec"><h3 class="inv-h">Fundamental runes</h3>
        <div class="rune-line"><span class="rune-lbl">Potency</span>${seg('potency', ['None', '+1', '+2', '+3'], Number(it.potency) || 0)}</div>
        ${kind === 'weapon' ? `<div class="rune-line"><span class="rune-lbl">Striking</span>${seg('striking', STRIKING, Number(it.striking) || 0)}</div>`
          : `<div class="rune-line"><span class="rune-lbl">Resilient</span>${seg('resilient', RESILIENT, Number(it.resilient) || 0)}</div>`}
      </div>
      <div class="rune-sec"><h3 class="inv-h">Property runes <span class="muted">${Math.min(runes.length, slots)} of ${slots}</span></h3>
        <p class="small muted" style="margin:0 0 8px">${mat.type === 'orichalcum' ? 'Orichalcum: always 4 property runes, whatever the potency' : `One property rune per point of potency${slots ? '' : ': add a potency rune first'}`}.</p>
        <div class="rune-list">${runes.map((slug, i) => { const r = table[slug]; const ref = r && runeRef(db, r); return `<div class="rune-row ${i < slots ? '' : 'off'}">
            <button type="button" class="alch-name" ${ref ? `data-rref="${esc(ref)}"` : 'disabled'}>${esc(r ? r.name : slug)}</button>
            <span class="muted small">${r ? 'Lv ' + r.level : ''}${i < slots ? '' : ` · doesn't fit (needs +${i + 1} potency)`}</span>
            ${readOnly ? '' : `<button type="button" class="icon-btn" data-rrm="${i}" aria-label="Remove ${esc(r ? r.name : slug)}">✕</button>`}</div>`; }).join('')}
          ${!readOnly && runes.length < slots ? `<button type="button" class="pslot empty" data-radd>+ Add a property rune</button>` : ''}
          ${!runes.length && !slots ? '<p class="muted small" style="margin:0">None.</p>' : ''}</div>
      </div>
      <div class="rune-sec"><h3 class="inv-h">Special material</h3>
        <div class="rune-line rune-mat">
          <select data-mat ${readOnly ? 'disabled' : ''} aria-label="Material"><option value="">None</option>${mats.map((x) => `<option value="${esc(x.slug)}" ${x.slug === mat.type ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
          ${matRec ? `<select data-grade ${readOnly ? 'disabled' : ''} aria-label="Grade">${matRec.grades.map((g) => `<option value="${esc(g.grade)}" ${g.grade === mat.grade ? 'selected' : ''}>${esc(GRADE_NAMES[g.grade] || g.grade)} · level ${g.level}</option>`).join('')}</select>` : ''}
        </div>
      </div>
      ${kind === 'weapon' && giant ? `<div class="rune-sec"><h3 class="inv-h">Titan Mauler</h3>
        <label class="row" style="gap:8px;align-items:center"><input type="checkbox" data-oversized ${it.oversized ? 'checked' : ''} ${readOnly ? 'disabled' : ''}> Built for a Large creature</label>
        <p class="small muted" style="margin:6px 0 0">Raises your Rage damage with it (to 6, then 10 at 7th and 18 with greater weapon specialization). You're clumsy 1 while wielding it.</p></div>` : ''}
      <div class="row end" style="margin-top:14px"><button type="button" class="btn primary" data-rdone>Done</button></div>`;
    $('[data-rdone]', m.body).onclick = () => m.close();
    $$('[data-rref]', m.body).forEach((b) => (b.onclick = () => showRef(db, b.dataset.rref)));
    if (readOnly) return;
    for (const k of ['potency', 'striking', 'resilient']) $$(`[data-${k}]`, m.body).forEach((b) => (b.onclick = () => { it[k] = Number(b.dataset[k]); changed(); }));
    $$('[data-rrm]', m.body).forEach((b) => (b.onclick = () => { it.runes = runes.filter((_, i) => i !== Number(b.dataset.rrm)); changed(); }));
    const add = $('[data-radd]', m.body);
    if (add) add.onclick = () => pickRune();
    const ms = $('[data-mat]', m.body);
    ms.onchange = () => {
      if (!ms.value) delete it.material;
      else { const x = mats.find((y) => y.slug === ms.value); it.material = { type: ms.value, grade: (x && x.grades.find((g) => g.grade === 'standard') ? 'standard' : x?.grades[0]?.grade) || 'standard' }; }
      changed();
    };
    const ov = $('[data-oversized]', m.body);
    if (ov) ov.onchange = () => { if (ov.checked) it.oversized = true; else delete it.oversized; changed(); };
    const gs = $('[data-grade]', m.body);
    if (gs) gs.onchange = () => { it.material = { ...it.material, grade: gs.value }; changed(); };
  };
  const pickRune = () => {
    const have = new Set(it.runes || []);
    const items = Object.values(RD[kind] || {}).filter((r) => !have.has(r.slug)).map((r) => ({
      key: r.slug, name: r.name, level: r.level, rarity: r.rarity, rec: r, disabled: r.level > level,
      group: r.level <= level ? 'Your level or lower' : 'Higher level',
      meta: [r.rarity !== 'common' ? r.rarity : '', formatPrice((r.price || 0) * 100), (r.extra || []).filter((x) => !x.crit && !x.pred).map((x) => `+${x.n}${x.die} ${x.type}`).join(', ')].filter(Boolean).join(' · '),
    })).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
    openDrawer({
      title: kind === 'weapon' ? 'Weapon property runes' : 'Armor property runes', subtitle: esc(rec.name), items, db, hideDisabled: true, allowDisabled: true,
      detail: (x) => `<h3>${esc(x.name)}</h3><p class="muted small">Level ${x.level} · ${esc(formatPrice((x.rec.price || 0) * 100))}${x.rec.traits?.length ? ' · ' + esc(x.rec.traits.join(', ')) : ''}</p>`,
      textRef: (x) => runeRef(db, x.rec), canPick: () => true, pickLabel: (x) => 'Etch ' + x.name,
      onPick: (x) => { it.runes = [...(it.runes || []), x.key]; changed(); },
    });
  };
  draw();
  return m;
}
