// Small shared helpers.

export const ATTRS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
export const ATTR_NAMES = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };
export const SKILLS = {
  acrobatics: 'dex', arcana: 'int', athletics: 'str', crafting: 'int', deception: 'cha', diplomacy: 'cha',
  intimidation: 'cha', medicine: 'wis', nature: 'wis', occultism: 'int', performance: 'cha', religion: 'wis',
  society: 'int', stealth: 'dex', survival: 'wis', thievery: 'dex',
};
export const SAVES = { fortitude: 'con', reflex: 'dex', will: 'wis' };
export const RANKS = ['Untrained', 'Trained', 'Expert', 'Master', 'Legendary'];
export const RANK_LETTER = ['U', 'T', 'E', 'M', 'L'];

export function sluggify(s) {
  return String(s).toLowerCase().replace(/['’‘`]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}
export function camelCase(slug) {
  return String(slug).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}
export function titleCase(s) {
  return String(s).replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function signed(n) {
  n = Number(n) || 0;
  return (n >= 0 ? '+' : '') + n;
}
export function rankBonus(rank, level) {
  return rank > 0 ? rank * 2 + level : 0;
}
export function formatPrice(cp) {
  cp = Math.round(cp || 0);
  if (cp === 0) return '—';
  const gp = Math.floor(cp / 100), sp = Math.floor((cp % 100) / 10), c = cp % 10;
  const parts = [];
  if (gp) parts.push(gp.toLocaleString() + ' gp');
  if (sp) parts.push(sp + ' sp');
  if (c) parts.push(c + ' cp');
  return parts.join(' ');
}
export function formatBulk(b) {
  if (!b) return '—';
  const whole = Math.floor(b + 1e-9), light = Math.round((b - whole) * 10);
  if (!whole) return light + 'L';
  return whole + (light ? ` ${light}L` : '');
}
export function uid() {
  return Math.random().toString(36).slice(2, 10);
}
export function deepClone(o) {
  return JSON.parse(JSON.stringify(o));
}
export function refParts(ref) {
  const r = String(ref || '').replace(/^@/, '');
  const i = r.indexOf('/');
  return i < 0 ? [null, r] : [r.slice(0, i), r.slice(i + 1)];
}

/**
 * Combine modifiers the PF2e way: bonuses of the same type don't stack (highest wins),
 * penalties of the same type don't stack (worst wins), untyped always stack.
 * mods: [{label, value, type}] -> {total, used:[...]}
 */
export function stackMods(mods) {
  const best = {}, worst = {};
  const used = [];
  for (const m of mods) {
    if (!m || !m.value) continue;
    const t = m.type || 'untyped';
    if (t === 'untyped') { used.push(m); continue; }
    if (m.value > 0) { if (!best[t] || m.value > best[t].value) best[t] = m; }
    else if (!worst[t] || m.value < worst[t].value) worst[t] = m;
  }
  used.push(...Object.values(best), ...Object.values(worst));
  return { total: used.reduce((s, m) => s + m.value, 0), used };
}
