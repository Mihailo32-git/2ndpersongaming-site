// Light / dark mode, and the fantasy themes ("skins"). Both choices are kept on this device; with no light/dark
// choice saved, the device's own setting decides. Each page sets data-theme and data-skin in <head> before it
// paints (no flash); this adds the light/dark toggle to the top bar. A skin decides light or dark by itself, so
// the toggle is hidden while one is on. Themes are picked in the "App & offline" panel (setSkin).
const KEY = 'pf2e.theme';
const SKIN_KEY = 'pf2e.skin';
export const SKINS = [
  { id: '', name: 'Default', mode: null, color: null, note: 'The standard look, light or dark' },
  { id: 'tome', name: 'Tome', mode: 'light', color: '#f4ead2', note: 'Old manuscript, notes in the margins' },
  { id: 'grove', name: 'Grove', mode: 'dark', color: '#20160e', note: 'Wood, vines and leaves' },
  { id: 'cosmos', name: 'Cosmos', mode: 'dark', color: '#0d0b1c', note: 'Stars, a ringed world and the void' },
  { id: 'alchemy', name: 'Alchemy', mode: 'dark', color: '#0c181b', note: 'A laboratory: glassware, formulas and medicine' },
  { id: 'steel', name: 'Blood & Steel', mode: 'dark', color: '#111316', note: 'Blades, blood and sharp edges' },
  { id: 'frost', name: 'Frost', mode: 'light', color: '#f1f7fb', note: 'Ice, rime and snow' },
];
const saved = () => { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
const savedSkin = () => { try { return localStorage.getItem(SKIN_KEY) || ''; } catch (e) { return ''; } };
const system = () => (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
export const currentSkin = () => SKINS.find((s) => s.id && s.id === (document.documentElement.dataset.skin || savedSkin())) || SKINS[0];
const current = () => document.documentElement.dataset.theme || saved() || system();
function apply(t) {
  const skin = currentSkin();
  const root = document.documentElement;
  if (skin.id) { root.dataset.skin = skin.id; t = skin.mode; } else delete root.dataset.skin;
  root.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', skin.color || (t === 'light' ? '#ffffff' : '#12151b'));
  const b = document.getElementById('themeBtn');
  if (b) {
    b.hidden = !!skin.id;
    b.textContent = t === 'light' ? '☾' : '☀'; b.title = t === 'light' ? 'Switch to dark mode' : 'Switch to light mode'; b.setAttribute('aria-label', b.title);
  }
}
/** Switch theme: '' for the default look, or a skin id. */
export function setSkin(id) {
  try { if (id) localStorage.setItem(SKIN_KEY, id); else localStorage.removeItem(SKIN_KEY); } catch (e) { /* ignore */ }
  if (id) document.documentElement.dataset.skin = id; else delete document.documentElement.dataset.skin;
  apply(id ? null : saved() || system());
}
function mount() {
  const bar = document.querySelector('.topbar');
  if (!bar || document.getElementById('themeBtn')) return;
  const b = document.createElement('button');
  b.type = 'button'; b.id = 'themeBtn'; b.className = 'theme-btn';
  b.onclick = () => { const t = current() === 'light' ? 'dark' : 'light'; try { localStorage.setItem(KEY, t); } catch (e) { /* ignore */ } apply(t); };
  const acc = document.getElementById('account');
  if (acc) bar.insertBefore(b, acc); else bar.appendChild(b);
  apply(current());
}
// Follow the device when nothing is saved (e.g. it switches to dark in the evening).
if (window.matchMedia) {
  const mq = matchMedia('(prefers-color-scheme: light)');
  const on = () => { if (!saved() && !currentSkin().id) apply(system()); };
  if (mq.addEventListener) mq.addEventListener('change', on); else if (mq.addListener) mq.addListener(on);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
