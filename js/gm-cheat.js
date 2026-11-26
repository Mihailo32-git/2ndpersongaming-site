// GM cheat sheet: the numbers a GM looks up mid-session, in a side panel on the GM screen.
// The DC row for the current party level is highlighted; conditions open their full rules when tapped.
import { openDrawer } from './drawer.js';
import { esc, showRef } from './ui.js';

const DC_BY_LEVEL = [14, 15, 16, 18, 19, 20, 22, 23, 24, 26, 27, 28, 30, 31, 32, 34, 35, 36, 38, 39, 40, 42, 44, 46, 48, 50];
const DC_BY_RANK = [null, 15, 18, 20, 23, 26, 28, 31, 34, 36, 39];
const ADJUST = [['Incredibly easy', -10], ['Very easy', -5], ['Easy', -2], ['Hard', 2], ['Very hard', 5], ['Incredibly hard', 10]];
const SIMPLE = [['Untrained', 10], ['Trained', 15], ['Expert', 20], ['Master', 30], ['Legendary', 40]];
const CONDITIONS = [
  ['off-guard', 'Off-guard (flat-footed)', '−2 circumstance penalty to AC.'],
  ['frightened', 'Frightened X', '−X status penalty to all checks and DCs; drops by 1 at the end of each of its turns.'],
  ['sickened', 'Sickened X', '−X status penalty to all checks and DCs; can\'t willingly eat or drink. Spend an action to retch (Fortitude save) to reduce it.'],
  ['clumsy', 'Clumsy X', '−X status penalty to Dex-based checks and DCs: AC, Reflex, ranged attacks, Acrobatics, Stealth, Thievery.'],
  ['enfeebled', 'Enfeebled X', '−X status penalty to Str-based rolls and DCs: melee attacks and damage, Athletics.'],
  ['stupefied', 'Stupefied X', '−X status penalty to Int, Wis and Cha checks and DCs (spells, Will, Perception…). Casting a spell needs a DC 5 + X flat check.'],
  ['drained', 'Drained X', '−X status penalty to Con-based checks (Fortitude); loses X × level Hit Points and max HP. Drops by 1 after a full night\'s rest.'],
  ['slowed', 'Slowed X', 'Regains X fewer actions at the start of its turn.'],
  ['stunned', 'Stunned X', 'Loses X actions in total (or can\'t act for a duration). Overrides slowed.'],
  ['quickened', 'Quickened', 'One extra action each turn, only for what the effect allows.'],
  ['prone', 'Prone', 'Off-guard, −2 circumstance penalty to attack rolls. Stand to get up.'],
  ['grabbed', 'Grabbed', 'Off-guard and immobilized. Manipulate actions need a DC 5 flat check.'],
  ['restrained', 'Restrained', 'Off-guard and immobilized; can\'t attack or act except to Escape or Force Open.'],
  ['concealed', 'Concealed', 'Anyone targeting it rolls a DC 5 flat check first.'],
  ['hidden', 'Hidden', 'Its square is known, but targeting it needs a DC 11 flat check. You\'re off-guard to a creature hidden from you.'],
  ['undetected', 'Undetected', 'Its square isn\'t known; the attacker must guess the square and roll a DC 11 flat check.'],
  ['blinded', 'Blinded', 'Can\'t see: everything is hidden to it unless another sense works; −4 to Perception, immune to visual effects.'],
  ['dazzled', 'Dazzled', 'Everything it sees is concealed to it.'],
  ['fatigued', 'Fatigued', '−1 status penalty to AC and saves; no exploration activity while travelling.'],
  ['wounded', 'Wounded X', 'When knocked out, dying increases by X more.'],
  ['doomed', 'Doomed X', 'Dies at dying 4 − X.'],
  ['persistent-damage', 'Persistent damage', 'Takes the damage at the end of its turn, then a DC 15 flat check to end it (DC 10 with help).'],
];

/** opts: { db, partyLevel, threats: [[name, budget, perExtraPc]], xpByDiff: {'-4': 10, …} } */
export function openCheatSheet({ db, partyLevel = 1, threats = [], xpByDiff = {} }) {
  const pl = Math.max(0, Math.min(25, partyLevel));
  const sec = (id, title, body) => `<section class="cs-sec" id="cs-${id}"><h3>${esc(title)}</h3>${body}</section>`;
  const t = (rows) => `<table class="cs-table">${rows.map((r) => `<tr>${r.map((c, i) => (i ? `<td>${c}</td>` : `<th>${c}</th>`)).join('')}</tr>`).join('')}</table>`;
  const jumps = [['dc', 'DCs'], ['checks', 'Checks'], ['dying', 'Dying'], ['cond', 'Conditions'], ['combat', 'Combat'], ['knowledge', 'Recall Knowledge'], ['enc', 'Encounters'], ['rest', 'Rest & healing'], ['xp', 'XP'], ['counter', 'Counteract']];
  const html = `
    <div class="cs-jumps">${jumps.map(([id, l]) => `<button type="button" class="chip-btn" data-jump="${id}">${esc(l)}</button>`).join('')}</div>
    <div class="cs-grid">
    ${sec('dc', `DCs · party level ${pl}: DC ${DC_BY_LEVEL[pl]}`, `
      <div class="cs-dcs">${DC_BY_LEVEL.map((dc, l) => `<div class="cs-dc ${l === pl ? 'on' : ''}"><span>${l}</span><b>${dc}</b></div>`).join('')}</div>
      <p class="cs-sub">Level → DC. Adjust: ${ADJUST.map(([n, v]) => `${esc(n)} <b>${v > 0 ? '+' : '−'}${Math.abs(v)}</b>`).join(' · ')}.</p>
      <p class="cs-sub">Simple DCs: ${SIMPLE.map(([n, v]) => `${n} <b>${v}</b>`).join(' · ')}.</p>
      <p class="cs-sub">Spell rank DCs: ${DC_BY_RANK.slice(1).map((dc, i) => `${i + 1}: <b>${dc}</b>`).join(' · ')}.</p>`)}
    ${sec('checks', 'Checks', `
      <ul class="cs-list">
        <li><b>Critical success</b> beat the DC by 10. <b>Critical failure</b> miss it by 10.</li>
        <li><b>Natural 20</b> one step better, <b>natural 1</b> one step worse.</li>
        <li><b>Flat checks</b> concealed DC 5 · hidden DC 11 · persistent damage DC 15 (10 with help).</li>
        <li><b>Aid</b> DC 15 (pre-remaster DC 20): crit +2 (+3 master, +4 legendary), success +1, crit failure −1.</li>
        <li><b>Hero points</b> spend 1 to reroll a check (keep the new roll), or all of them to avoid dying.</li>
      </ul>`)}
    ${sec('dying', 'Dying & recovery', `
      <ul class="cs-list">
        <li>At 0 HP: <b>dying 1</b> (dying 2 from a critical hit or critical failure), <b>plus wounded</b>.</li>
        <li><b>Recovery check</b> at the start of each turn: flat DC 10 + dying. Crit success −2, success −1, failure +1, crit failure +2.</li>
        <li><b>Dead at dying 4</b> (4 − doomed). Taking damage while dying: +1 (+2 on a crit).</li>
        <li>Back above 0 HP: lose dying, gain <b>wounded 1</b> (or +1). Wounded goes away with 10 minutes of rest and full HP, or Treat Wounds.</li>
        <li><b>Hero points</b> spend all (at least 1) to lose dying, stay at 0 HP, wounded doesn't go up.</li>
      </ul>`)}
    ${sec('cond', 'Conditions', `<div class="cs-conds">${CONDITIONS.map(([slug, n, d]) => `<div class="cs-cond"><button type="button" class="linkish" data-cond="${esc(slug)}">${esc(n)}</button><span>${esc(d)}</span></div>`).join('')}</div>
      <p class="cs-sub">Tap a name for the full rules.</p>`)}
    ${sec('combat', 'Combat', `
      <ul class="cs-list">
        <li><b>Multiple attack penalty</b> −5 / −10, agile −4 / −8.</li>
        <li><b>Cover</b> lesser +1 AC · standard +2 to AC, Reflex vs areas and Stealth · greater +4.</li>
        <li><b>Flanking</b> ally on the opposite side: the target is off-guard (−2 AC) to you both.</li>
        <li><b>Reactions</b> one per round, refreshed at the start of your turn.</li>
        <li><b>Falling</b> bludgeoning damage equal to half the distance in feet; land prone.</li>
        <li><b>Initiative</b> Perception usually; Stealth when sneaking up, a skill when it fits.</li>
      </ul>`)}
    ${sec('knowledge', 'Recall Knowledge', `
      <p class="cs-sub" style="margin-top:0">DC = the creature's level DC (table above), then uncommon <b>+2</b> · rare <b>+5</b> · unique <b>+10</b>.</p>
      <ul class="cs-list"><li><b>Critical success</b> the most useful fact plus another detail. <b>Success</b> one useful fact. <b>Critical failure</b> false information.</li>
        <li>The GM screen statblock shows the DC and the skills for each creature.</li></ul>`)}
    ${sec('enc', `Encounter budget · ${threats.length ? 'for 4 PCs' : ''}`, `
      ${t([['Threat', 'XP', 'Each PC more or fewer'], ...threats.map(([n, b, a]) => [esc(n), `<b>${b}</b>`, `±${a}`])])}
      <p class="cs-sub">Creature XP by level vs the party: ${Object.entries(xpByDiff).sort((a, b) => Number(a[0]) - Number(b[0])).map(([d, x]) => `${Number(d) > 0 ? '+' : ''}${Number(d) === 0 ? '±0' : d}: <b>${x}</b>`).join(' · ')}.</p>
      <p class="cs-sub">Simple hazards: a fifth of that (party level: 8 XP). Complex hazards: like a creature.</p>`)}
    ${sec('rest', 'Rest & healing', `
      <ul class="cs-list">
        <li><b>8 hours of rest</b> regain HP = Con modifier (min 1) × level; drained and doomed drop by 1. Daily preparations take an hour.</li>
        <li><b>Treat Wounds</b> (10 min, 1 hour immunity) DC 15: 2d8 · expert DC 20: 2d8+10 · master DC 30: 2d8+30 · legendary DC 40: 2d8+50. Critical success doubles the dice (4d8); a full hour of treatment doubles the healing.</li>
        <li><b>Refocus</b> 10 minutes to regain a Focus Point.</li>
      </ul>`)}
    ${sec('xp', 'XP rewards', `
      <ul class="cs-list"><li>Accomplishments: <b>minor 10</b> · <b>moderate 30</b> · <b>major 80</b>.</li>
        <li><b>1,000 XP</b> to level up; XP rolls over.</li></ul>`)}
    ${sec('counter', 'Counteract', `
      <ul class="cs-list"><li><b>Counteract rank</b> spell rank, or half the level rounded up for creatures and items.</li>
        <li><b>Critical success</b> counteract up to 3 ranks higher · <b>success</b> up to 1 higher · <b>failure</b> only lower ranks · <b>critical failure</b> nothing.</li></ul>`)}
    </div>`;
  openDrawer({
    title: 'GM cheat sheet', subtitle: `Party level ${pl}`,
    custom: (body) => {
      body.innerHTML = html;
      body.querySelectorAll('[data-jump]').forEach((b) => (b.onclick = () => { const s = body.querySelector('#cs-' + b.dataset.jump); if (s) s.scrollIntoView({ behavior: 'smooth', block: 'start' }); }));
      body.querySelectorAll('[data-cond]').forEach((b) => (b.onclick = () => showRef(db, '@conditions/' + b.dataset.cond)));
    },
  });
}
