// Light / dark mode. The choice is kept on this device; with none saved, the device's own setting decides.
// Each page sets data-theme in <head> before it paints (no flash); this adds the toggle to the top bar.
const KEY = 'pf2e.theme';
const saved = () => { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
const system = () => (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
const current = () => document.documentElement.dataset.theme || saved() || system();
function apply(t) {
  document.documentElement.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'light' ? '#ffffff' : '#12151b');
  const b = document.getElementById('themeBtn');
  if (b) { b.textContent = t === 'light' ? '☾' : '☀'; b.title = t === 'light' ? 'Switch to dark mode' : 'Switch to light mode'; b.setAttribute('aria-label', b.title); }
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
  const on = () => { if (!saved()) apply(system()); };
  if (mq.addEventListener) mq.addEventListener('change', on); else if (mq.addListener) mq.addListener(on);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
