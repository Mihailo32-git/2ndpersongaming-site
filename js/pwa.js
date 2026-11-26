// Installable app + offline: registers the service worker, shows "new version" and install prompts,
// and the "App & offline" panel (download all rules text for use without internet).
import { modal, toast, esc } from './ui.js';

const sw = 'serviceWorker' in navigator ? navigator.serviceWorker : null;
let reg = null;
let installEvent = null;
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const listeners = new Set();
const notify = () => listeners.forEach((f) => { try { f(); } catch (e) { /* ignore */ } });
export const onPwaChange = (f) => { listeners.add(f); return () => listeners.delete(f); };
export const canInstall = () => !standalone() && (!!installEvent || isIOS());

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; notify(); });
window.addEventListener('appinstalled', () => { installEvent = null; notify(); toast('Installed. Open it from your home screen.', 'ok'); });

function updateBanner(worker) {
  if (document.getElementById('swUpdate')) return;
  const bar = document.createElement('div');
  bar.id = 'swUpdate';
  bar.className = 'sw-update';
  bar.setAttribute('role', 'status');
  bar.innerHTML = '<span>A new version of the site is ready.</span><button type="button" class="btn small primary">Update now</button><button type="button" class="btn small ghost" aria-label="Later">Later</button>';
  const [upd, later] = bar.querySelectorAll('button');
  upd.onclick = () => { upd.disabled = true; upd.textContent = 'Updating…'; worker.postMessage({ type: 'skip-waiting' }); };
  later.onclick = () => bar.remove();
  document.body.appendChild(bar);
}

if (sw && location.protocol !== 'file:') {
  let reloading = false;
  const hadController = !!sw.controller; // the very first install takes over quietly; only updates reload the page
  sw.addEventListener('controllerchange', () => { if (reloading || !hadController) return; reloading = true; location.reload(); });
  window.addEventListener('load', async () => {
    try {
      reg = await sw.register('sw.js');
      const watch = (w) => w && w.addEventListener('statechange', () => { if (w.state === 'installed' && sw.controller) updateBanner(w); });
      if (reg.waiting && sw.controller) updateBanner(reg.waiting);
      reg.addEventListener('updatefound', () => watch(reg.installing));
      // Look for a new version now and then (tablets can stay open for a whole session).
      setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
      notify();
    } catch (e) { /* the site still works online without it */ }
  });
}

function ask(type, onMsg, extra) {
  return new Promise((resolve) => {
    if (!sw || !sw.controller) { resolve(null); return; }
    const handler = (e) => { if (onMsg) onMsg(e.data); if (e.data && (e.data.type === type || e.data.type === 'downloaded')) { sw.removeEventListener('message', handler); resolve(e.data); } };
    sw.addEventListener('message', handler);
    sw.controller.postMessage(Object.assign({ type: type === 'downloaded' ? 'download-text' : type }, extra || {}));
  });
}
// The server compresses the JSON to about a third and a half; that's roughly what goes over the network.
const mb = (bytes) => { const v = (bytes || 0) / 3.5e6; return v < 10 ? v.toFixed(1) : String(Math.round(v)); };

export async function openAppPanel() {
  const m = modal('App & offline', {});
  const draw = async () => {
    const st = await ask('status');
    const ready = !!st;
    const allText = st && st.text >= st.textTotal;
    const allCr = st && st.creaturesTotal && st.creatures >= st.creaturesTotal;
    m.body.innerHTML = `
      <div class="app-row"><div><b>Install on this device</b><p class="muted small">${standalone() ? 'You’re using the installed app.' : 'Opens full screen from your home screen, without the browser bar.'}</p></div>
        ${standalone() ? '<span class="badge ok-badge">Installed</span>' : installEvent ? '<button type="button" class="btn primary" id="appInstall">Install</button>' : ''}</div>
      ${!standalone() && !installEvent ? `<div class="notice small">${isIOS()
        ? 'On iPad or iPhone: tap the <b>Share</b> button in Safari, then <b>Add to Home Screen</b>.'
        : 'Use your browser’s menu: <b>Install app</b> or <b>Add to Home screen</b> (Chrome, Edge, Samsung Internet).'}</div>` : ''}
      <div class="app-row"><div><b>Works without internet</b><p class="muted small">${ready
        ? 'The builder, sheets and your characters open offline. Changes sync when you’re back online.'
        : 'Getting the offline copy ready… open this again in a moment.'}</p></div>${ready ? '<span class="badge ok-badge">Ready</span>' : ''}</div>
      ${ready ? `<div class="app-row"><div><b>Rules text offline</b><p class="muted small">Descriptions of feats, spells, items and so on. ${allText ? 'All of it is saved on this device.' : `${st.text} of ${st.textTotal} parts saved; the rest load when you open them online.`}</p>
        <div class="app-progress" hidden><div></div></div></div>
        ${allText ? '<span class="badge ok-badge">Saved</span>' : `<button type="button" class="btn" data-dl="rules" ${navigator.onLine ? '' : 'disabled'}>Download all (~${mb(st.sizes?.rules)} MB)</button>`}</div>` : ''}
      ${ready && st.creaturesTotal ? `<div class="app-row"><div><b>Bestiary offline</b> <span class="muted small">(for GMs)</span><p class="muted small">Every creature statblock for the GM screen. ${allCr ? 'All of it is saved on this device.' : `${st.creatures} of ${st.creaturesTotal} parts saved; creatures you open online are kept too.`}</p>
        <div class="app-progress" hidden><div></div></div></div>
        ${allCr ? '<span class="badge ok-badge">Saved</span>' : `<button type="button" class="btn" data-dl="creatures" ${navigator.onLine ? '' : 'disabled'}>Download (~${mb(st.sizes?.creatures)} MB)</button>`}</div>` : ''}
      <p class="muted small" style="margin-top:12px">Version ${esc(st?.version || '–')}</p>`;
    const inst = m.body.querySelector('#appInstall');
    if (inst) inst.onclick = async () => { const e = installEvent; installEvent = null; e.prompt(); await e.userChoice.catch(() => null); draw(); notify(); };
    m.body.querySelectorAll('[data-dl]').forEach((dl) => (dl.onclick = async () => {
      const group = dl.dataset.dl;
      m.body.querySelectorAll('[data-dl]').forEach((b) => (b.disabled = true));
      dl.textContent = 'Downloading…';
      const bar = dl.closest('.app-row').querySelector('.app-progress'); bar.hidden = false;
      const res = await ask('downloaded', (d) => { if (d && d.type === 'progress') bar.firstElementChild.style.width = Math.round((d.done / d.total) * 100) + '%'; }, { group });
      const what = group === 'creatures' ? 'Bestiary' : 'Rules text';
      toast(res && !res.failed ? what + ' saved for offline use.' : 'Some parts didn’t download; try again online.', res && !res.failed ? 'ok' : 'error');
      draw();
    }));
  };
  draw();
}
