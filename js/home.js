// Home page: character list, login, import.
import { Store, api } from './store.js';
import { mountAccount, openAuth, syncLabel } from './account.js';
import { modal, toast, confirmBox, esc } from './ui.js';
import { titleCase } from './util.js';
// "Unbreakable Goblin" + "Goblin" → "Unbreakable Goblin"; "Dromaar" + "Minotaur" → "Dromaar Minotaur".
const lineage = (c) => { const h = titleCase(c.heritage || ''), a = titleCase(c.ancestry || ''); return h && a && (' ' + h + ' ').includes(' ' + a + ' ') ? h : [h, a].filter(Boolean).join(' '); };

// Wrapped in an async function instead of top-level await so older tablet browsers (Chrome 80+) can run it.
(async () => {

const store = await new Store().init();
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// Secret: press and hold the "Your characters" title for 2 seconds to show or hide the GM screen on this device.
{
  const h = $('.page-title h1');
  if (h) {
    Object.assign(h.style, { userSelect: 'none', webkitUserSelect: 'none', webkitTouchCallout: 'none', touchAction: 'manipulation' });
    let timer = null;
    const stop = () => { clearTimeout(timer); timer = null; };
    h.addEventListener('pointerdown', () => {
      stop();
      timer = setTimeout(() => {
        timer = null;
        let on = false;
        try { on = localStorage.getItem('pf2e.gmOn') !== '1'; if (on) localStorage.setItem('pf2e.gmOn', '1'); else localStorage.removeItem('pf2e.gmOn'); } catch (e) { /* ignore */ }
        if (on) document.documentElement.dataset.gm = '1'; else delete document.documentElement.dataset.gm;
        toast(on ? 'GM screen unlocked on this device.' : 'GM screen hidden on this device.', 'ok');
      }, 2000);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((e) => h.addEventListener(e, stop));
    h.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}

function header() {
  const st = store.syncState();
  $('#saveState').textContent = store.apiAvailable ? syncLabel(st) : 'Saved in this browser';
  $('#saveState').className = 'save-state ' + (st.kind === 'saved' ? 'saved' : st.kind === 'offline' || st.kind === 'pending' ? 'warn' : st.kind === 'conflict' || st.kind === 'login' ? 'bad' : '');
  const notes = [];
  if (store.needsLogin) {
    notes.push(`<div class="notice row between"><span>Changes to ${esc(store.lastUser?.name || 'your')} characters made on this device haven't reached the account yet.</span><button type="button" class="btn small primary" data-relog>Log in to upload them</button></div>`);
  } else if (store.apiAvailable && !store.user) {
    notes.push(`<div class="notice row between"><span>Characters you make now stay in this browser. Log in to keep them in your account and open them on any device.</span><span class="row"><button type="button" class="btn small" data-auth="register">Create account</button><button type="button" class="btn small primary" data-auth="login">Log in</button></span></div>`);
  }
  const n = store.user && !store.needsLogin ? store.localCount() : 0;
  if (n) notes.push(`<div class="notice row between"><span>${n} character${n > 1 ? 's are' : ' is'} saved only in this browser.</span><button type="button" class="btn small primary" id="upload">Move to my account</button></div>`);
  if (store.mode === 'api' && !store.online) notes.push('<div class="notice">You\'re offline. Characters opened on this device before still work; changes upload when the connection is back.</div>');
  $('#notice').innerHTML = notes.join('');
  $$('[data-auth]').forEach((b) => (b.onclick = () => openAuth(store, { mode: b.dataset.auth, onDone: render })));
  $$('[data-relog]').forEach((b) => (b.onclick = () => openAuth(store, { email: store.lastUser?.email, onDone: render })));
  if (n) $('#upload').onclick = async (e) => {
    e.target.disabled = true;
    try { const c = await store.uploadLocal(); toast(`Moved ${c} character${c > 1 ? 's' : ''} to your account`, 'ok'); } catch (err) { toast(err.message, 'error'); }
    render();
  };
}

async function render() {
  header();
  let list = [];
  try { list = await store.list(); } catch (e) { $('#list').innerHTML = `<p class="bad">${esc(e.message)}</p>`; return; }
  if (!list.length) {
    $('#list').innerHTML = `<div class="card empty-state"><h2>No characters yet</h2><p class="muted">Create one with the builder, or import a JSON file exported from this site or from Pathbuilder 2e.</p><a class="btn primary" href="builder.html">Create a character</a></div>`;
    return;
  }
  const initials = (n) => (n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
  $('#list').innerHTML = list.map((c) => `
    <div class="card char-card">
      <div class="avatar small" aria-hidden="true">${esc(initials(c.name))}</div>
      <div class="grow"><h3>${esc(c.name || 'Unnamed')}${c.pending ? ' <span class="badge warn" title="Saved on this device; uploads when online">Not uploaded yet</span>' : ''}${c.offlineCopy ? ' <span class="badge" title="The copy on this device">Offline copy</span>' : ''}</h3>
        <div class="muted small">Level ${esc(c.level || 1)} ${esc(lineage(c))} ${esc(titleCase(c.class || ''))}</div></div>
      <div class="row">
        <a class="btn primary small" href="sheet.html?id=${encodeURIComponent(c.id)}">Sheet</a>
        <a class="btn small" href="builder.html?id=${encodeURIComponent(c.id)}">Edit</a>
        ${(c.level || 1) < 20 ? `<a class="btn small outline" href="levelup.html?id=${encodeURIComponent(c.id)}">Level up</a>` : ''}
        <button type="button" class="icon-btn" data-export="${esc(c.id)}" title="Download JSON" aria-label="Download ${esc(c.name || 'character')} as JSON">⤓</button>
        <button type="button" class="icon-btn" data-del="${esc(c.id)}" title="Delete" aria-label="Delete ${esc(c.name || 'character')}">🗑</button>
      </div>
    </div>`).join('');
  document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox('Delete this character? This cannot be undone.'))) return;
    try { await store.remove(b.dataset.del); toast('Deleted'); } catch (err) { toast(err.message, 'error'); }
    render();
  }));
  document.querySelectorAll('[data-export]').forEach((b) => (b.onclick = async () => {
    const c = await store.get(b.dataset.export);
    const blob = new Blob([JSON.stringify({ format: 'pf2e-builder', version: 1, name: c.name, build: c.build, state: c.state || {} }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = (c.name || 'character').replace(/[^\w-]+/g, '_') + '.json'; a.click();
  }));
}

// "Install app" / offline panel. The label says Install when this browser can install the site.
import('./pwa.js').then(({ openAppPanel, canInstall, onPwaChange }) => {
  const b = $('#appBtn'); if (!b) return;
  const label = () => { b.hidden = false; b.textContent = canInstall() ? 'Install app' : 'App & offline'; b.classList.toggle('primary-soft', canInstall()); };
  b.onclick = openAppPanel;
  onPwaChange(label); label();
}).catch(() => {});

// A file exported from this site: its build has our own shape (boosts, feats by slot, choices).
const isOwnExport = (d) => !!(d && d.build && (d.format === 'pf2e-builder' || (d.build.boosts && d.build.feats && !Array.isArray(d.build.feats) && typeof d.build.abilities !== 'object')));

let pbTools = null;
async function pathbuilderTools() {
  // Loaded only when needed: the game data is large and the home page doesn't use it otherwise.
  if (!pbTools) {
    const [{ DB }, { Engine }, pb, { loadRunes }] = await Promise.all([import('./data.js'), import('./engine.js'), import('./pathbuilder.js'), import('./runes.js')]);
    const db = await new DB({ base: 'data/' }).init();
    await Promise.all([db.load(['equipment']), loadRunes(db)]);
    pbTools = { db, engine: new Engine(db), pb };
  }
  return pbTools;
}

function importReport(saved, r, pbName) {
  const m = modal('Imported from Pathbuilder', { wide: true });
  const issues = [...r.check.attrs, ...r.check.skills, ...(r.check.hp ? [r.check.hp] : []), ...(r.check.other || [])];
  const still = r.notes.filter((n) => n.startsWith('Still to choose'));
  const other = r.notes.filter((n) => !n.startsWith('Still to choose'));
  const list = (items) => `<ul class="imp-list">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  m.body.innerHTML = `
    <p><strong>${esc(saved.name || pbName)}</strong> is saved. Ancestry, class, attributes, feats, skills, spells and gear came across;
      the site worked out the choices behind Pathbuilder's numbers, so look it over in the builder.</p>
    ${issues.length
      ? `<div class="notice"><strong>Numbers that differ from Pathbuilder</strong>${list(issues)}<p class="muted small">Usually a choice Pathbuilder doesn't save in its export. Fix it in the builder.</p></div>`
      : '<div class="notice ok">Attributes, skills, saves, Perception, AC and Hit Points match Pathbuilder.</div>'}
    ${still.length ? `<details class="imp-more"><summary>Choices to make in the builder (${still.length})</summary>${list(still.map((n) => n.replace(/^Still to choose:\s*/, '')))}</details>` : ''}
    ${other.length ? `<details class="imp-more"><summary>Other notes (${other.length})</summary>${list(other)}</details>` : ''}
    <div class="row end imp-actions">
      <button type="button" class="btn" data-close>Close</button>
      <a class="btn" href="builder.html?id=${encodeURIComponent(saved.id)}">Open in builder</a>
      <a class="btn primary" href="sheet.html?id=${encodeURIComponent(saved.id)}">Open sheet</a>
    </div>`;
  m.body.querySelector('[data-close]').onclick = m.close;
}

$('#importFile').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  let data;
  try { data = JSON.parse(await f.text()); } catch { toast("That file isn't valid JSON.", 'error'); return; }
  try {
    if (isOwnExport(data)) {
      await store.save({ id: null, name: data.name, build: data.build, state: data.state || {} });
      toast('Imported ' + (data.name || 'character'), 'ok');
      render();
      return;
    }
    const tools0 = await import('./pathbuilder.js');
    if (!tools0.isPathbuilder(data)) {
      toast("This file isn't a character from this site or a Pathbuilder 2e export (Menu → Export JSON in Pathbuilder).", 'error');
      return;
    }
    if (data.success === false) { toast('Pathbuilder says this export failed. Export it again from Pathbuilder.', 'error'); return; }
    toast('Reading the Pathbuilder character…');
    const { db, engine, pb } = await pathbuilderTools();
    const r = pb.convertPathbuilder(data, db, engine);
    const saved = await store.save({ id: null, name: r.build.name, build: r.build, state: r.state || {} });
    render();
    importReport(saved, r, (data.build || data).name);
  } catch (err) { console.error(err); toast('Import failed: ' + (err.message || err), 'error'); }
};

mountAccount(store, { onAuthChange: () => render() });
store.onChange(() => header());


render();

// A join link from a GM (index.html?join=CODE): pick which character joins the party.
const joinCode = new URLSearchParams(location.search).get('join');
if (joinCode) joinParty(joinCode);
async function joinParty(code) {
  const clear = () => history.replaceState(null, '', location.pathname);
  if (!store.user) {
    const m = modal('Join a party', {});
    m.body.innerHTML = `<p>Log in to join this party. Your GM will see your character’s sheet live, but can’t change it.</p><div class="row end"><button type="button" class="btn primary" id="jLogin">Log in</button></div>`;
    $('#jLogin').onclick = () => { m.close(); openAuth(store, { onDone: () => location.reload() }); };
    return;
  }
  let info;
  try { info = (await api('party_peek', null, { code })).party; } catch (e) { toast(e.message, 'error'); clear(); return; }
  const list = (await store.list().catch(() => [])).filter((c) => !String(c.id).startsWith('tmp-') && !String(c.id).startsWith('local-'));
  const m = modal(`Join “${info.name}”`, {});
  m.body.innerHTML = info.locked ? '<p>This party is locked. Ask your GM to unlock it.</p>'
    : `<p class="muted" style="margin-top:0">GM: ${esc(info.gm || '—')}. Choose the character that joins:</p>
      ${list.map((c) => `<div class="gm-mem"><span><b>${esc(c.name || 'Unnamed')}</b> <span class="muted small">level ${c.level || ''}</span></span><button type="button" class="btn small primary" data-j="${esc(c.id)}">Join</button></div>`).join('') || '<p>You have no characters saved to your account yet.</p>'}`;
  $$('[data-j]').forEach((b) => (b.onclick = async () => {
    try { await api('party_join', { code, character_id: b.dataset.j }); toast(`Joined ${info.name}`, 'ok'); m.close(); clear(); }
    catch (e) { toast(e.message, 'error'); }
  }));
}
})().catch((e) => { console.error(e); const m = document.getElementById('main') || document.getElementById('list'); if (m && !m.querySelector('.bad')) m.insertAdjacentHTML('afterbegin', '<p class="bad">Something went wrong: ' + String(e.message || e).replace(/</g, '&lt;') + '</p>'); });
