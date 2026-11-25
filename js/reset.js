// "Set a new password" page, opened from the password-reset email (reset.html#token=…).
import { Store } from './store.js';
import { esc, toast } from './ui.js';
import { field, wireEyes, LOGO } from './account.js';

(async () => {
const main = document.getElementById('main');
const token = (new URLSearchParams(location.hash.slice(1)).get('token') || '').trim();
// Keep the token out of the address bar (and the browser history) once read.
if (location.hash) history.replaceState(null, '', location.pathname);
const store = await new Store().init();
if (!/^[a-f0-9]{64}$/.test(token)) {
  main.innerHTML = `<div class="card auth-card"><div class="auth-hero"><div class="auth-logo">${LOGO}</div><h2>This link isn't complete</h2><p>Open the password email again and tap the link, or ask for a new one from the log-in window.</p></div><a class="btn primary auth-submit" href="index.html">Go to characters</a></div>`;
  return;
}
main.innerHTML = `<div class="card auth-card"><div class="auth-hero"><div class="auth-logo">${LOGO}</div><h2>Set a new password</h2><p>Choose a new password for your account. You'll be logged in straight after.</p></div>
  <form class="auth-form" novalidate>
    ${field({ name: 'p1', label: 'New password', type: 'password', auto: 'new-password', hint: 'At least 8 characters.', attrs: 'minlength="8" required' })}
    ${field({ name: 'p2', label: 'Same password again', type: 'password', auto: 'new-password', attrs: 'minlength="8" required' })}
    <p class="auth-err" role="alert" hidden></p>
    <button class="btn primary auth-submit" type="submit">Save and log in</button>
  </form></div>`;
wireEyes(main);
const form = main.querySelector('form');
form.onsubmit = async (e) => {
  e.preventDefault();
  const err = main.querySelector('.auth-err');
  const p1 = form.p1.value, p2 = form.p2.value;
  const show = (t) => { err.textContent = t; err.hidden = false; };
  err.hidden = true;
  if (p1.length < 8) { show('Passwords are at least 8 characters.'); return; }
  if (p1 !== p2) { show('The two passwords don\'t match.'); return; }
  form.querySelector('button[type=submit]').disabled = true;
  try {
    const u = await store.resetPassword(token, p1);
    main.innerHTML = `<div class="card auth-card"><div class="auth-hero"><div class="auth-logo ok">✓</div><h2>Password changed</h2><p>You're logged in as <b>${esc(u.email)}</b>.</p></div><a class="btn primary auth-submit" href="index.html">Go to your characters</a></div>`;
    toast('Password changed', 'ok');
  } catch (ex) { show(ex.message); form.querySelector('button[type=submit]').disabled = false; }
};
})().catch((e) => { console.error(e); document.getElementById('main').innerHTML = '<p class="bad">Something went wrong: ' + String(e.message || e).replace(/</g, '&lt;') + '</p>'; });
