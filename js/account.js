// Account button, log-in / sign-up / forgot-password dialogs, account settings and the "changed on another device" question.
// Used by every page: mountAccount(store) fills the #account slot in the top bar.

import { modal, toast, confirmBox, esc } from './ui.js';
import { ConflictError } from './store.js';

const $ = (s, r = document) => r.querySelector(s);

/** One short line for the save indicator in the top bar. */
export function syncLabel(st) {
  switch (st.kind) {
    case 'saved': return 'Saved to your account';
    case 'pending': return 'Saved on this device · uploading…';
    case 'offline': return st.pending ? `Offline · ${st.pending} change${st.pending > 1 ? 's' : ''} saved on this device` : 'Offline · changes save on this device';
    case 'conflict': return 'Changed on another device — choose a version';
    case 'login': return 'Log in again to upload your changes';
    default: return 'Saved in this browser';
  }
}
const dotClass = (k) => ({ saved: 'ok', local: 'off', pending: 'wait', offline: 'wait', conflict: 'bad', login: 'bad' })[k] || 'off';

/**
 * Puts the account button in the top bar.
 * onAuthChange runs after logging in or out (default: reload the page so it shows the right characters).
 */
export function mountAccount(store, { slot = '#account', onAuthChange = null } = {}) {
  const el = $(slot);
  if (!el) return;
  const after = onAuthChange || (() => location.reload());
  const draw = () => {
    if (!store.apiAvailable) { el.innerHTML = ''; return; }
    const st = store.syncState();
    if (store.needsLogin) {
      el.innerHTML = `<button type="button" class="btn small warn acct-login">Log in to upload</button>`;
    } else if (!store.user) {
      el.innerHTML = `<button type="button" class="btn small acct-login">Log in</button>`;
    } else {
      const nm = store.user.name || store.user.email;
      el.innerHTML = `<button type="button" class="acct-btn" aria-haspopup="menu" aria-expanded="false" title="${esc(syncLabel(st))}">
        <span class="acct-avatar">${esc(nm.trim().charAt(0).toUpperCase() || '?')}<i class="sync-dot ${dotClass(st.kind)}"></i></span><span class="acct-name">${esc(nm)}</span></button>`;
    }
    const lb = $('.acct-login', el);
    if (lb) lb.onclick = () => openAuth(store, { onDone: after, email: store.lastUser?.email });
    const ab = $('.acct-btn', el);
    if (ab) ab.onclick = (e) => { e.stopPropagation(); toggleMenu(store, el, after); };
  };
  store.onChange(draw);
  draw();
}

function toggleMenu(store, el, after) {
  const open = $('.acct-menu');
  if (open) { open.remove(); $('.acct-btn', el)?.setAttribute('aria-expanded', 'false'); return; }
  const st = store.syncState();
  const menu = document.createElement('div');
  menu.className = 'acct-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `<div class="acct-who"><b>${esc(store.user.name || '')}</b><span class="muted small">${esc(store.user.email)}</span></div>
    <div class="acct-sync"><i class="sync-dot ${dotClass(st.kind)}"></i><span>${esc(syncLabel(st))}</span></div>
    ${st.pending && st.kind !== 'conflict' ? '<button type="button" role="menuitem" data-a="sync">Upload now</button>' : ''}
    <button type="button" role="menuitem" data-a="settings">Account settings</button>
    <button type="button" role="menuitem" data-a="logout">Log out</button>`;
  document.body.appendChild(menu);
  const r = el.getBoundingClientRect();
  menu.style.top = Math.round(r.bottom + 8) + 'px';
  menu.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
  $('.acct-btn', el)?.setAttribute('aria-expanded', 'true');
  const close = () => { menu.remove(); document.removeEventListener('click', outside, true); $('.acct-btn', el)?.setAttribute('aria-expanded', 'false'); };
  const outside = (e) => { if (!menu.contains(e.target) && !el.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('click', outside, true), 0);
  menu.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    close();
    if (a === 'sync') { await store.sync(); toast(store.pendingCount() ? 'Still offline — will try again' : 'All changes uploaded', store.pendingCount() ? 'info' : 'ok'); }
    if (a === 'settings') openSettings(store, after);
    if (a === 'logout') {
      const n = store.pendingCount();
      if (n && !(await confirmBox(`${n} change${n > 1 ? 's haven\'t' : ' hasn\'t'} reached your account yet (you're offline). Log out anyway and lose ${n > 1 ? 'them' : 'it'}?`))) return;
      try { await store.logout(); toast('Logged out'); after(); } catch (err) { toast(err.message, 'error'); }
    }
  };
}

export const LOGO = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 2l8 5v10l-8 5-8-5V7z"/><path d="M12 7v10M7 9.5l10 5M17 9.5l-10 5"/></svg>';
const EYE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7c1.7 0 3.2-.5 4.5-1.2"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

/** A labelled input stacked full width; `extra` sits at the right end of the label line (e.g. "Forgot password?"). */
export function field({ name, label, type = 'text', auto = '', value = '', hint = '', extra = '', attrs = '' }) {
  const pw = type === 'password';
  return `<label class="af"><span class="af-l"><span>${esc(label)}</span>${extra}</span>
    <span class="af-box ${pw ? 'pw' : ''}"><input type="${type}" name="${name}" ${auto ? `autocomplete="${auto}"` : ''} value="${esc(value)}" ${attrs}>
    ${pw ? `<button type="button" class="af-eye" aria-label="Show password" aria-pressed="false">${EYE}</button>` : ''}</span>
    ${hint ? `<span class="af-hint">${esc(hint)}</span>` : ''}</label>`;
}
export function wireEyes(root) {
  root.querySelectorAll('.af-eye').forEach((b) => (b.onclick = () => {
    const i = b.parentElement.querySelector('input');
    const show = i.type === 'password';
    i.type = show ? 'text' : 'password';
    b.innerHTML = show ? EYE_OFF : EYE;
    b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    b.setAttribute('aria-pressed', String(show));
  }));
}

/** Log in / create account / forgot password. */
export function openAuth(store, { mode = 'login', onDone = null, email = '' } = {}) {
  const st = store.status || {};
  const m = modal(mode === 'register' ? 'Create account' : 'Log in', { cls: 'auth' });
  const TEXT = {
    login: ['Welcome back', 'Log in to open your characters on any device.'],
    register: ['Create your account', 'Keep your characters safe and open them on every device you log in on.'],
    forgot: ['Forgot your password?', 'Enter your account\'s email and we\'ll send you a link to set a new one.'],
  };
  const draw = () => {
    m.setTitle(TEXT[mode][0]);
    const reg = mode === 'register';
    const closed = reg && st.register === false;
    let form = '';
    if (mode === 'forgot') {
      form = `<form class="auth-form" novalidate>
        ${field({ name: 'email', label: 'Email', type: 'email', auto: 'email', value: email, attrs: 'inputmode="email" required' })}
        <p class="auth-err" role="alert" hidden></p>
        <button class="btn primary auth-submit" type="submit">Send reset link</button>
      </form>
      <p class="auth-foot"><button type="button" class="auth-link" data-mode="login">← Back to log in</button></p>`;
    } else if (closed) {
      form = `<div class="auth-note">Sign-ups are closed on this site for now. Ask your GM to make an account for you.</div>`;
    } else {
      form = `<form class="auth-form" novalidate>
        ${reg ? field({ name: 'name', label: 'Your name', auto: 'nickname', attrs: 'maxlength="100" placeholder="What your group calls you"' }) : ''}
        ${field({ name: 'email', label: 'Email', type: 'email', auto: 'email', value: email, attrs: 'inputmode="email" required' })}
        ${field({ name: 'password', label: 'Password', type: 'password', auto: reg ? 'new-password' : 'current-password', hint: reg ? 'At least 8 characters.' : '',
          extra: !reg && st.mail ? '<button type="button" class="auth-link" data-mode="forgot">Forgot password?</button>' : '', attrs: 'required minlength="8"' })}
        ${reg && st.invite ? field({ name: 'invite', label: 'Invite code', auto: 'off', hint: 'Your GM gave you this.', attrs: 'required' }) : ''}
        <p class="auth-err" role="alert" hidden></p>
        <button class="btn primary auth-submit" type="submit">${reg ? 'Create account' : 'Log in'}</button>
      </form>
      <p class="auth-foot">${reg ? 'Already have an account? <button type="button" class="auth-link" data-mode="login">Log in</button>'
        : 'New here? <button type="button" class="auth-link" data-mode="register">Create an account</button>'}</p>`;
    }
    m.body.innerHTML = `<div class="auth-hero"><div class="auth-logo">${LOGO}</div><h2>${esc(TEXT[mode][0])}</h2><p>${esc(TEXT[mode][1])}</p></div>
      ${mode === 'forgot' ? '' : `<div class="auth-switch" role="tablist" aria-label="Log in or create an account">
        <button type="button" role="tab" data-mode="login" aria-selected="${!reg}">Log in</button>
        <button type="button" role="tab" data-mode="register" aria-selected="${reg}">Create account</button></div>`}
      ${form}`;
    m.body.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => {
      email = $('input[name=email]', m.body)?.value || email;
      if (b.dataset.mode === mode) return;
      mode = b.dataset.mode; draw();
    }));
    wireEyes(m.body);
    const f = $('form', m.body);
    if (!f) return;
    // On a keyboard device, start in the first empty box (on tablets this would pop the keyboard up straight away).
    if (window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      const first = [...f.querySelectorAll('input')].find((i) => !i.value);
      if (first) setTimeout(() => first.focus(), 30);
    }
    f.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      const err = $('.auth-err', m.body);
      const btn = $('.auth-submit', f);
      const showErr = (msg) => { err.textContent = msg; err.hidden = false; };
      err.hidden = true;
      const em = String(fd.get('email') || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { showErr('Enter a valid email address.'); return; }
      const label = btn.textContent;
      btn.disabled = true; btn.classList.add('busy');
      try {
        if (mode === 'forgot') {
          await store.forgot(em);
          m.body.innerHTML = `<div class="auth-hero"><div class="auth-logo ok">✓</div><h2>Check your email</h2>
            <p>If <b>${esc(em)}</b> has an account, a link to set a new password is on its way. It works for one hour — check the spam folder if it doesn't show up in a few minutes.</p></div>
            <button type="button" class="btn primary auth-submit">Done</button>`;
          $('.auth-submit', m.body).onclick = () => m.close();
          return;
        }
        const pass = String(fd.get('password') || '');
        if (pass.length < 8) { showErr('Passwords are at least 8 characters.'); return; }
        if (mode === 'login') await store.login(em, pass);
        else await store.register(em, String(fd.get('name') || ''), pass, String(fd.get('invite') || ''));
        m.close();
        toast(mode === 'login' ? `Welcome back${store.user.name ? ', ' + store.user.name : ''}` : 'Account created', 'ok');
        if (onDone) onDone(store.user);
      } catch (ex) {
        showErr(ex.message === 'No connection to the server' ? 'Can\'t reach the server. Check the wifi and try again.' : ex.message);
      } finally {
        if (btn.isConnected) { btn.disabled = false; btn.classList.remove('busy'); btn.textContent = label; }
      }
    };
  };
  draw();
  return m;
}

/** Name, password and deleting the account. */
export function openSettings(store, after = () => location.reload()) {
  const m = modal('Account settings', { cls: 'auth' });
  m.body.innerHTML = `
    <div class="auth-hero small"><div class="auth-logo">${esc((store.user.name || store.user.email).charAt(0).toUpperCase())}</div><h2>Account settings</h2><p>${esc(store.user.email)}</p></div>
    <form class="auth-form auth-section" data-f="name"><h3>Your name</h3>
      ${field({ name: 'name', label: 'Shown in the top bar', auto: 'nickname', value: store.user.name || '', attrs: 'maxlength="100"' })}
      <button class="btn auth-submit" type="submit">Save name</button></form>
    <form class="auth-form auth-section" data-f="pw"><h3>Change password</h3>
      ${field({ name: 'current', label: 'Current password', type: 'password', auto: 'current-password', attrs: 'required' })}
      ${field({ name: 'password', label: 'New password', type: 'password', auto: 'new-password', hint: 'At least 8 characters.', attrs: 'required minlength="8"' })}
      <button class="btn auth-submit" type="submit">Change password</button></form>
    <form class="auth-form auth-section danger" data-f="del"><h3>Delete account</h3>
      <p class="af-hint">Deletes your account and every character in it, on all devices. This can't be undone — download the characters you want to keep first (the ⤓ button on your characters list).</p>
      ${field({ name: 'password', label: 'Password', type: 'password', auto: 'current-password', attrs: 'required' })}
      <button class="btn danger auth-submit" type="submit">Delete my account</button></form>
    <p class="auth-err" role="alert" hidden></p>`;
  wireEyes(m.body);
  const err = $('.auth-err', m.body);
  m.body.querySelectorAll('form').forEach((f) => (f.onsubmit = async (e) => {
    e.preventDefault();
    err.hidden = true;
    const fd = new FormData(f);
    try {
      if (f.dataset.f === 'name') { await store.updateAccount({ name: String(fd.get('name') || '') }); toast('Name saved', 'ok'); }
      if (f.dataset.f === 'pw') {
        if (String(fd.get('password')).length < 8) throw new Error('New password must be at least 8 characters');
        await store.updateAccount({ current: String(fd.get('current')), password: String(fd.get('password')) });
        f.reset(); toast('Password changed', 'ok');
      }
      if (f.dataset.f === 'del') {
        if (!(await confirmBox('Delete your account and all its characters? This can\'t be undone.'))) return;
        await store.deleteAccount(String(fd.get('password')));
        m.close(); toast('Account deleted'); after();
      }
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  }));
}

/**
 * Another device saved this character since this one loaded it, and this device has its own changes.
 * Resolves 'mine' (keep this device's version and upload it) or 'theirs' (load the other device's version).
 */
export function askConflict(info = {}) {
  return new Promise((resolve) => {
    const when = info.updated ? new Date(info.updated) : null;
    const m = modal('Changed on another device', { onClose: () => resolve(null) });
    m.body.innerHTML = `<p>This character was saved on another device${when && !isNaN(when) ? ` at <b>${when.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</b>` : ''}, after this one opened it. Which version do you want to keep?</p>
      <div class="conflict-choices">
        <button type="button" class="btn primary" data-v="mine">Keep this device's version<span class="small">and replace the other one</span></button>
        <button type="button" class="btn" data-v="theirs">Load the other version<span class="small">and drop the changes made here</span></button>
      </div>`;
    m.body.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => { const v = b.dataset.v; resolve(v); m.close(); }));
  });
}

/**
 * Saves a character's build, asking what to do if another device changed it in the meantime.
 * Returns true when saved (or saved on this device while offline), false if the page is reloading the other version.
 */
export async function saveWithConflictCheck(store, charRec) {
  try { await store.save(charRec); return true; } catch (e) {
    if (!(e instanceof ConflictError)) throw e;
    const pick = await askConflict(e.info);
    if (pick === 'mine') { await store.save(charRec, { force: true }); toast('Saved this device\'s version', 'ok'); return true; }
    if (pick === 'theirs') { store.discardLocal(charRec.id); location.reload(); return false; }
    throw new Error('Not saved — choose a version to keep');
  }
}
