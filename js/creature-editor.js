// Creature editor for the GM screen: make a creature from scratch, or copy one from the bestiary and change it.
// Works on the same statblock format the bestiary uses (text/creatures/*.json), so homebrew creatures
// show up, add to encounters and print exactly like the official ones.
import { modal, toast, confirmBox, esc } from './ui.js';
import { titleCase, signed } from './util.js';

const SIZES = [['tiny', 'Tiny'], ['sm', 'Small'], ['med', 'Medium'], ['lg', 'Large'], ['huge', 'Huge'], ['grg', 'Gargantuan']];
const RARITIES = ['common', 'uncommon', 'rare', 'unique'];
const ATTRS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const CATS = [['interaction', 'Top'], ['defensive', 'Defensive'], ['offensive', 'Offensive']];
const ACTS = [['passive', 'Passive'], ['1', '◆ 1'], ['2', '◆◆ 2'], ['3', '◆◆◆ 3'], ['reaction', '⟲ Reaction'], ['free', '◇ Free']];

// ------------------------------------------------------------------ text <-> statblock fields
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const num = (v, d = 0) => { const n = Number(String(v).replace('−', '-').replace('–', '-')); return Number.isFinite(n) ? Math.round(n) : d; };
export function htmlToText(html) {
  const div = document.createElement('div');
  div.innerHTML = String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|h\d|div)>/gi, '\n\n').replace(/<hr\s*\/?>/gi, '\n\n');
  return div.textContent.replace(/\n{3,}/g, '\n\n').trim();
}
export function textToHtml(text) {
  return String(text || '').trim().split(/\n\s*\n/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');
}
// "cold 10, physical 5 (except silver)" <-> [{type, value, except}]
function parseDefs(s) {
  const out = [];
  for (const part of String(s || '').split(/,(?![^()]*\))/)) {
    const t = part.trim(); if (!t) continue;
    const m = t.match(/^(.*?)(?:\s+(\d+))?(?:\s*\((?:except\s+)?([^)]*)\))?$/i);
    const x = { type: (m ? m[1] : t).trim().toLowerCase() };
    if (m && m[2]) x.value = Number(m[2]);
    if (m && m[3]) x.except = list(m[3].replace(/\bor\b/g, ','));
    out.push(x);
  }
  return out;
}
const defsText = (l) => (l || []).map((x) => x.type + (x.value ? ' ' + x.value : '') + (x.except?.length ? ` (except ${x.except.join(', ')})` : '')).join(', ');
// "Athletics +12, Lore (Underworld) +8" <-> {Athletics: 12, ...}
function parseSkills(s) {
  const out = {};
  for (const part of String(s || '').split(/,(?![^()]*\))/)) {
    const m = part.trim().match(/^(.+?)\s*([+\-−–]?\s*\d+)$/);
    if (m) out[titleCase(m[1].trim())] = num(m[2].replace(/\s/g, ''));
  }
  return out;
}
const skillsText = (o) => Object.entries(o || {}).map(([k, v]) => `${k} ${signed(v)}`).join(', ');
// Spells: one line per rank, "3: fireball, haste" or "cantrips: shield"
function spellsText(e) {
  return Object.entries(e.ranks || {}).sort((a, b) => Number(b[0]) - Number(a[0]))
    .map(([r, l]) => `${r === '0' ? 'cantrips' : r}: ${l.map((x) => x.n).join(', ')}`).join('\n');
}
function parseSpells(text, known, spellIndex) {
  const ranks = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(cantrips?|\d+)(?:st|nd|rd|th)?\s*[:\-–]\s*(.+)$/i);
    if (!m) continue;
    const r = /^cantrip/i.test(m[1]) ? '0' : String(Number(m[1]));
    ranks[r] = list(m[2]).map((n) => {
      const ref = known[n.toLowerCase()] || spellIndex(n.replace(/\s*\(.*\)$/, ''));
      return ref ? { n, r: ref } : { n };
    });
  }
  return ranks;
}

export function blankCreature(level = 1) {
  return {
    name: '', level, traits: [], rarity: 'common', size: 'med', blurb: '',
    perception: level + 5, senses: [], languages: ['Common'], skills: {}, attrs: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
    ac: 15 + level, saves: { fortitude: level + 5, reflex: level + 5, will: level + 5 }, hp: 20 + level * 15,
    immunities: [], weaknesses: [], resistances: [], speed: 25, speeds: [],
    strikes: [{ name: 'fist', bonus: level + 7, traits: ['agile'], damage: `1d6+${Math.max(1, Math.floor(level / 2) + 2)} bludgeoning` }],
    abilities: [], spellcasting: [], gear: [],
  };
}

// ------------------------------------------------------------------ the editor
// spellIndex(name) -> "spells/slug" or null (loads the spell list on first use)
export function openCreatureEditor({ sb, title = 'New creature', saveLabel = 'Save creature', onSave, onDelete, spellIndex = async () => () => null }) {
  const c = JSON.parse(JSON.stringify(sb || blankCreature()));
  c.strikes = c.strikes || []; c.abilities = c.abilities || []; c.spellcasting = c.spellcasting || [];
  c.attrs = Object.assign({ str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 }, c.attrs || {});
  c.saves = Object.assign({ fortitude: 0, reflex: 0, will: 0 }, c.saves || {});
  // descriptions are edited as plain text; untouched ones keep their links
  for (const a of c.abilities) a._text = htmlToText(a.desc);
  for (const e of c.spellcasting) e._text = spellsText(e);
  const m = modal(title, { wide: true, cls: 'cr-edit' });
  const val = (sel) => { const el = m.body.querySelector(sel); return el ? el.value : ''; };
  const collect = () => {
    c.name = val('[name=name]').trim();
    c.level = num(val('[name=level]'), 1);
    c.rarity = val('[name=rarity]'); c.size = val('[name=size]');
    c.traits = list(val('[name=traits]').toLowerCase()).map((t) => t.replace(/\s+/g, '-'));
    c.perception = num(val('[name=perception]'));
    c.senses = list(val('[name=senses]'));
    c.languages = list(val('[name=languages]'));
    c.skills = parseSkills(val('[name=skills]'));
    for (const a of ATTRS) c.attrs[a] = num(val(`[name=attr-${a}]`));
    c.gear = list(val('[name=gear]'));
    c.ac = num(val('[name=ac]')); c.acNote = val('[name=acNote]').trim();
    for (const s of ['fortitude', 'reflex', 'will']) c.saves[s] = num(val(`[name=save-${s}]`));
    c.saveNote = val('[name=saveNote]').trim();
    c.hp = Math.max(1, num(val('[name=hp]'), 1)); c.hpNote = val('[name=hpNote]').trim();
    const hard = num(val('[name=hardness]'), 0); c.hardness = hard || null;
    c.immunities = parseDefs(val('[name=immunities]'));
    c.weaknesses = parseDefs(val('[name=weaknesses]'));
    c.resistances = parseDefs(val('[name=resistances]'));
    c.speed = num(val('[name=speed]'), 25);
    c.speeds = list(val('[name=speeds]'));
    c.blurb = val('[name=blurb]').trim();
    m.body.querySelectorAll('[data-strike]').forEach((row, i) => {
      const s = c.strikes[i]; const q = (n) => row.querySelector(`[name=${n}]`).value;
      s.name = q('s-name').trim(); s.ranged = q('s-kind') === 'ranged' ? 1 : null;
      s.range = s.ranged ? num(q('s-range'), 0) || null : null;
      s.bonus = num(q('s-bonus')); s.traits = list(q('s-traits').toLowerCase()).map((t) => t.replace(/\s+/g, '-'));
      s.damage = q('s-damage').trim(); s.effects = list(q('s-effects'));
    });
    m.body.querySelectorAll('[data-abil]').forEach((row, i) => {
      const a = c.abilities[i]; const q = (n) => row.querySelector(`[name=${n}]`).value;
      a.name = q('a-name').trim(); a.cat = q('a-cat');
      const t = q('a-type');
      if (/^[123]$/.test(t)) { a.type = 'action'; a.actions = Number(t); } else { a.type = t; a.actions = null; }
      a.traits = list(q('a-traits').toLowerCase());
      const text = q('a-desc');
      if (text.trim() !== (a._text || '').trim()) { a.desc = textToHtml(text); a._text = text; }
    });
    m.body.querySelectorAll('[data-cast]').forEach((row, i) => {
      const e = c.spellcasting[i]; const q = (n) => row.querySelector(`[name=${n}]`).value;
      e.name = q('c-name').trim() || 'Spells'; e.dc = num(q('c-dc'), 0) || null; e.atk = q('c-atk').trim() === '' ? null : num(q('c-atk'));
      e._text = q('c-spells');
    });
  };
  const opt = (pairs, cur) => pairs.map(([v, l]) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const field = (label, html, cls = '') => `<label class="field ${cls}"><span>${label}</span>${html}</label>`;
  const inp = (name, v, attrs = '') => `<input type="text" name="${name}" value="${esc(v ?? '')}" ${attrs}>`;
  const n = (name, v, attrs = '') => `<input type="number" name="${name}" value="${esc(v ?? '')}" ${attrs}>`;
  const draw = () => {
    m.body.innerHTML = `
      <div class="ce-grid ce-top">
        ${field('Name', inp('name', c.name, 'maxlength="100" placeholder="e.g. Bog Troll Chieftain" autocomplete="off"'), 'wide')}
        ${field('Level', n('level', c.level, 'min="-1" max="30"'))}
        ${field('Rarity', `<select name="rarity">${opt(RARITIES.map((r) => [r, titleCase(r)]), c.rarity)}</select>`)}
        ${field('Size', `<select name="size">${opt(SIZES, c.size)}</select>`)}
        ${field('Traits <small>(comma separated)</small>', inp('traits', (c.traits || []).join(', '), 'placeholder="giant, troll, humanoid"'), 'wide')}
      </div>
      <h3 class="inv-h">Senses, skills and attributes</h3>
      <div class="ce-grid">
        ${field('Perception', n('perception', c.perception))}
        ${field('Senses', inp('senses', (c.senses || []).join(', '), 'placeholder="darkvision, scent (imprecise) 30 feet"'), 'wide')}
        ${field('Languages', inp('languages', (c.languages || []).join(', '), 'placeholder="Common, Jotun"'), 'wide')}
        ${field('Skills', inp('skills', skillsText(c.skills), 'placeholder="Athletics +12, Intimidation +9"'), 'full')}
      </div>
      <div class="ce-attrs">${ATTRS.map((a) => field(titleCase(a), n('attr-' + a, c.attrs[a]))).join('')}</div>
      <div class="ce-grid">${field('Items', inp('gear', (c.gear || []).join(', '), 'placeholder="greataxe, hide armor"'), 'full')}</div>
      <h3 class="inv-h">Defenses</h3>
      <div class="ce-grid">
        ${field('AC', n('ac', c.ac))}
        ${field('Fortitude', n('save-fortitude', c.saves.fortitude))}
        ${field('Reflex', n('save-reflex', c.saves.reflex))}
        ${field('Will', n('save-will', c.saves.will))}
        ${field('HP', n('hp', c.hp, 'min="1"'))}
        ${field('Hardness', n('hardness', c.hardness || '', 'min="0"'))}
        ${field('AC note', inp('acNote', c.acNote, 'placeholder="optional"'), 'wide')}
        ${field('Save note', inp('saveNote', c.saveNote, 'placeholder="+1 status to all saves vs. magic"'), 'wide')}
        ${field('HP note', inp('hpNote', c.hpNote, 'placeholder="regeneration 10 (deactivated by fire)"'), 'full')}
        ${field('Immunities', inp('immunities', defsText(c.immunities), 'placeholder="fire, poison, paralyzed"'), 'full')}
        ${field('Weaknesses', inp('weaknesses', defsText(c.weaknesses), 'placeholder="cold 10, holy 5"'), 'full')}
        ${field('Resistances', inp('resistances', defsText(c.resistances), 'placeholder="physical 5 (except silver)"'), 'full')}
      </div>
      <h3 class="inv-h">Movement</h3>
      <div class="ce-grid">
        ${field('Speed (feet)', n('speed', c.speed, 'min="0"'))}
        ${field('Other speeds', inp('speeds', (c.speeds || []).join(', '), 'placeholder="Fly 40 feet, Swim 20 feet"'), 'wide')}
      </div>
      <h3 class="inv-h">Strikes</h3>
      ${c.strikes.map((s, i) => `<div class="ce-card" data-strike="${i}">
        <div class="ce-grid">
          ${field('Type', `<select name="s-kind">${opt([['melee', 'Melee'], ['ranged', 'Ranged']], s.ranged ? 'ranged' : 'melee')}</select>`)}
          ${field('Name', inp('s-name', s.name, 'placeholder="jaws"'), 'wide')}
          ${field('Attack bonus', n('s-bonus', s.bonus))}
          ${field('Damage', inp('s-damage', s.damage, 'placeholder="2d8+9 piercing"'), 'wide')}
          ${field('Traits', inp('s-traits', (s.traits || []).join(', '), 'placeholder="agile, reach 10"'), 'wide')}
          ${field('Range increment (ranged)', n('s-range', s.range || '', 'min="0"'))}
          ${field('Plus', inp('s-effects', (s.effects || []).join(', '), 'placeholder="grab, 1d6 persistent bleed"'), 'wide')}
        </div>
        <button type="button" class="btn small ghost ce-rm" data-rmstrike="${i}">✕ Remove strike</button>
      </div>`).join('')}
      <button type="button" class="btn small" data-addstrike>+ Strike</button>
      <h3 class="inv-h">Abilities</h3>
      ${c.abilities.map((a, i) => `<div class="ce-card" data-abil="${i}">
        <div class="ce-grid">
          ${field('Name', inp('a-name', a.name, 'placeholder="Ferocity"'), 'wide')}
          ${field('Actions', `<select name="a-type">${opt(ACTS, a.type === 'action' ? String(a.actions || 1) : a.type || 'passive')}</select>`)}
          ${field('Statblock part', `<select name="a-cat">${opt(CATS, a.cat || 'offensive')}</select>`)}
          ${field('Traits', inp('a-traits', (a.traits || []).join(', '), 'placeholder="arcane, fire"'), 'wide')}
          ${field('What it does', `<textarea name="a-desc" rows="4" placeholder="Trigger… Effect…">${esc(a._text || '')}</textarea>`, 'full')}
        </div>
        <button type="button" class="btn small ghost ce-rm" data-rmabil="${i}">✕ Remove ability</button>
      </div>`).join('')}
      <button type="button" class="btn small" data-addabil>+ Ability</button>
      <h3 class="inv-h">Spellcasting</h3>
      ${c.spellcasting.map((e, i) => `<div class="ce-card" data-cast="${i}">
        <div class="ce-grid">
          ${field('Name', inp('c-name', e.name, 'placeholder="Arcane Innate Spells"'), 'wide')}
          ${field('Spell DC', n('c-dc', e.dc ?? ''))}
          ${field('Spell attack', n('c-atk', e.atk ?? ''))}
          ${field('Spells <small>(one rank per line: “3: fireball, haste”, “cantrips: shield”)</small>', `<textarea name="c-spells" rows="4" placeholder="4: dimension door\n3: fireball, haste\ncantrips: detect magic, shield">${esc(e._text || '')}</textarea>`, 'full')}
        </div>
        <button type="button" class="btn small ghost ce-rm" data-rmcast="${i}">✕ Remove spellcasting</button>
      </div>`).join('')}
      <button type="button" class="btn small" data-addcast>+ Spellcasting</button>
      <h3 class="inv-h">Description</h3>
      ${field('Shown under “About” on the statblock', `<textarea name="blurb" rows="3">${esc(c.blurb || '')}</textarea>`)}
      <div class="ce-foot">
        ${onDelete ? '<button type="button" class="btn ghost danger" data-del>Delete</button>' : ''}
        <span class="spacer"></span>
        <button type="button" class="btn ghost" data-cancel>Cancel</button>
        <button type="button" class="btn primary" data-save>${esc(saveLabel)}</button>
      </div>`;
    const redraw = (fn) => () => { const top = m.body.scrollTop; collect(); fn(); draw(); m.body.scrollTop = top; };
    m.body.querySelector('[data-addstrike]').onclick = redraw(() => c.strikes.push({ name: '', bonus: c.level + 7, traits: [], damage: '' }));
    m.body.querySelector('[data-addabil]').onclick = redraw(() => c.abilities.push({ name: '', type: 'passive', cat: 'offensive', traits: [], desc: '', _text: '' }));
    m.body.querySelector('[data-addcast]').onclick = redraw(() => c.spellcasting.push({ name: 'Innate Spells', dc: null, atk: null, ranks: {}, _text: '' }));
    m.body.querySelectorAll('[data-rmstrike]').forEach((b) => (b.onclick = redraw(() => c.strikes.splice(Number(b.dataset.rmstrike), 1))));
    m.body.querySelectorAll('[data-rmabil]').forEach((b) => (b.onclick = redraw(() => c.abilities.splice(Number(b.dataset.rmabil), 1))));
    m.body.querySelectorAll('[data-rmcast]').forEach((b) => (b.onclick = redraw(() => c.spellcasting.splice(Number(b.dataset.rmcast), 1))));
    m.body.querySelector('[data-cancel]').onclick = m.close;
    const del = m.body.querySelector('[data-del]');
    if (del) del.onclick = async () => { if (await confirmBox(`Delete “${c.name || 'this creature'}”? Encounters that use it keep it, but without its statblock.`)) { m.close(); onDelete(); } };
    m.body.querySelector('[data-save]').onclick = async () => {
      collect();
      if (!c.name) { toast('Give the creature a name.', 'error'); m.body.querySelector('[name=name]').focus(); return; }
      for (const e of c.spellcasting) {
        const known = {};
        for (const l of Object.values(e.ranks || {})) for (const x of l) if (x.r) known[x.n.toLowerCase()] = x.r;
        e.ranks = parseSpells(e._text, known, await spellIndex());
        e.cantripRank = Math.max(1, Math.ceil(c.level / 2));
      }
      const out = JSON.parse(JSON.stringify(c));
      for (const a of out.abilities) delete a._text;
      for (const e of out.spellcasting) delete e._text;
      out.strikes = out.strikes.filter((s) => s.name);
      out.abilities = out.abilities.filter((a) => a.name);
      m.close();
      onSave(out);
    };
  };
  draw();
  return m;
}
