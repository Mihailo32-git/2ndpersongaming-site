// Character storage.
// Logged in: characters live in the account (api/index.php) and a copy is kept on this device, so a tablet that
// loses wifi mid-session keeps working: changes are saved here and uploaded when the connection is back.
// Logged out (or no server): characters are kept in this browser only.

import { uid } from './util.js';

const API = (window.PF2E_API_URL || 'api/index.php');
const LS_KEY = 'pf2e.characters.v1';     // browser-only characters
const USER_KEY = 'pf2e.user.v1';         // last account seen on this device
const CACHE_PREFIX = 'pf2e.cache.v1.';   // + user id: on-device copy of account characters
const IDMAP_KEY = 'pf2e.idmap.v1';       // characters made offline: temporary id → id in the account

/** The server could not be reached (no wifi, timeout, server down). */
export class OfflineError extends Error {}
/** Another device saved a newer version of the character. */
export class ConflictError extends Error {
  constructor(msg, info) { super(msg); this.info = info; }
}
/** The session ended (logged out elsewhere or expired). */
export class LoggedOutError extends Error {}

export async function api(route, body = null, params = {}, timeoutMs = 10000) {
  const q = new URLSearchParams({ r: route, ...params }).toString();
  const opt = { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: { 'X-PF2E': '1' }, cache: 'no-store' };
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  if (ctl) { opt.signal = ctl.signal; timer = setTimeout(() => ctl.abort(), timeoutMs); }
  let r;
  try { r = await fetch(API + '?' + q, opt); } catch (e) { throw new OfflineError('No connection to the server'); } finally { clearTimeout(timer); }
  let data = null;
  try { data = await r.json(); } catch (e) { /* not JSON */ }
  if (r.status === 409 && data && data.conflict) throw new ConflictError(data.error, data);
  if (r.status === 401 && data && data.loggedOut) throw new LoggedOutError(data.error);
  if (r.status >= 500 && r.status !== 503) throw new OfflineError((data && data.error) || 'The server is having trouble');
  if (!r.ok || !data) { const e = new Error((data && data.error) || ('Server error ' + r.status)); e.status = r.status; throw e; }
  return data;
}

function readJson(key, dflt) { try { return JSON.parse(localStorage.getItem(key) || '') || dflt; } catch (e) { return dflt; } }
function writeJson(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { throw new Error('Could not save on this device (storage full or blocked).'); }
}
const readLocal = () => readJson(LS_KEY, {});
const writeLocal = (all) => writeJson(LS_KEY, all);
const isLocalId = (id) => typeof id === 'string' && id.startsWith('local-');
const isTempId = (id) => typeof id === 'string' && id.startsWith('tmp-');

export class Store {
  constructor() {
    this.mode = 'local';          // 'local' = this browser only, 'api' = account
    this.user = null;
    this.apiAvailable = false;    // the server has accounts set up
    this.status = null;           // { register, invite, mail }
    this.online = true;           // last server call worked
    this.needsLogin = false;      // the session ended while there were changes to upload
    this._listeners = new Set();
    this._syncing = null;
  }

  async init() {
    try {
      const st = await api('status', null, {}, 6000);
      this.apiAvailable = !!st.configured;
      this.status = st;
      if (this.apiAvailable) {
        const me = await api('me', null, {}, 6000);
        this.user = me.user || null;
        if (this.user) writeJson(USER_KEY, this.user);
        else {
          // Logged out: if this device still holds changes for the last account, say so instead of losing them.
          const last = readJson(USER_KEY, null);
          if (last && this._pending(last.id).length) { this.needsLogin = true; this.lastUser = last; }
        }
      }
    } catch (e) {
      // Can't reach the server: carry on with the account copy on this device, if there is one.
      const last = readJson(USER_KEY, null);
      this.online = false;
      if (last) { this.apiAvailable = true; this.user = last; }
    }
    this.mode = this.user && !this.needsLogin ? 'api' : 'local';
    if (this.mode === 'api') {
      window.addEventListener('online', () => this.sync());
      setInterval(() => { if (this.pendingCount()) this.sync(); }, 30000);
      if (this.online) this.sync();
    }
    return this;
  }

  // ---------------------------------------------------------------- status for the UI
  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit() { for (const fn of this._listeners) { try { fn(this.syncState()); } catch (e) { console.error(e); } } }
  /** 'local' | 'saved' | 'pending' | 'offline' | 'conflict' | 'login' */
  syncState() {
    if (this.needsLogin) return { kind: 'login', pending: this._pending(this.lastUser?.id).length };
    if (this.mode !== 'api') return { kind: 'local', pending: 0 };
    const p = this._pending(this.user.id);
    if (p.some((c) => c.conflict)) return { kind: 'conflict', pending: p.length };
    if (p.length) return { kind: this.online ? 'pending' : 'offline', pending: p.length };
    return { kind: this.online ? 'saved' : 'offline', pending: 0 };
  }
  pendingCount() { return this.user ? this._pending(this.user.id).length : 0; }

  // ---------------------------------------------------------------- on-device copy of account characters
  _cacheKey(id) { return CACHE_PREFIX + (id ?? this.user?.id); }
  _cache(userId) { return readJson(this._cacheKey(userId), {}); }
  _writeCache(c, userId) { writeJson(this._cacheKey(userId), c); }
  _pending(userId) {
    if (userId == null) return [];
    return Object.values(this._cache(userId)).filter((c) => c.dirty || c.stateDirty);
  }
  _put(rec, flags = {}) {
    const all = this._cache();
    const prev = all[rec.id] || {};
    all[rec.id] = { ...prev, id: rec.id, name: rec.build?.name || rec.name || prev.name || 'Unnamed', build: rec.build ?? prev.build, state: rec.state ?? prev.state ?? {},
      version: rec.version ?? prev.version ?? 0, updated: rec.updated || prev.updated || new Date().toISOString(), ...flags };
    this._writeCache(all);
    return all[rec.id];
  }
  /** Throw away this device's unsent changes for one character (used after choosing the other device's version). */
  discardLocal(id) {
    const all = this._cache();
    delete all[id];
    this._writeCache(all);
    this._emit();
  }

  // ---------------------------------------------------------------- accounts
  async login(email, password) { const r = await api('login', { email, password }); return this._loggedIn(r.user); }
  async register(email, name, password, invite = '') { const r = await api('register', { email, name, password, invite }); return this._loggedIn(r.user); }
  async resetPassword(token, password) { const r = await api('reset', { token, password }); return this._loggedIn(r.user); }
  async forgot(email) { return api('forgot', { email }); }
  async updateAccount(fields) { const r = await api('account', fields); this.user = r.user; writeJson(USER_KEY, r.user); this._emit(); return r.user; }
  async deleteAccount(password) {
    await api('delete_account', { password });
    try { localStorage.removeItem(this._cacheKey()); localStorage.removeItem(USER_KEY); } catch (e) { /* ignore */ }
    this.user = null; this.mode = 'local'; this._emit();
  }
  _loggedIn(user) {
    const last = readJson(USER_KEY, null);
    // A different person logs in on a shared tablet: the previous account's copy goes.
    if (last && last.id !== user.id && !this._pending(last.id).length) { try { localStorage.removeItem(CACHE_PREFIX + last.id); } catch (e) { /* ignore */ } }
    this.user = user; this.mode = 'api'; this.online = true; this.needsLogin = false; this.lastUser = null;
    writeJson(USER_KEY, user);
    this.sync();
    this._emit();
    return user;
  }
  async logout() {
    await api('logout', {});
    try { localStorage.removeItem(this._cacheKey()); localStorage.removeItem(USER_KEY); } catch (e) { /* ignore */ }
    this.user = null; this.mode = 'local'; this._emit();
  }

  // ---------------------------------------------------------------- characters
  /** A character made offline gets its real id when it's first uploaded; pages may still hold the temporary one. */
  _resolve(id) { return isTempId(id) ? (readJson(IDMAP_KEY, {})[id] || id) : id; }

  async list() {
    if (this.mode !== 'api') return Object.values(readLocal()).map((c) => summary(c)).sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
    const cache = this._cache();
    let server = null;
    try { server = (await api('characters')).characters; this._ok(); } catch (e) { if (!this._soft(e)) throw e; }
    const byId = {};
    if (server) {
      for (const s of server) byId[s.id] = { ...s, ...(cache[s.id] && (cache[s.id].dirty || cache[s.id].stateDirty) ? { pending: true } : {}) };
      // Characters deleted on another device leave this device's copy too (unless it holds unsent changes).
      const all = this._cache();
      let changed = false;
      for (const id of Object.keys(all)) if (!byId[id] && !isTempId(id) && !all[id].dirty) { delete all[id]; changed = true; }
      if (changed) this._writeCache(all);
    }
    for (const c of Object.values(this._cache())) {
      if (!byId[c.id] && (!server || isTempId(c.id) || c.dirty)) byId[c.id] = { ...summary(c), pending: !!(c.dirty || c.stateDirty), offlineCopy: !server };
    }
    return Object.values(byId).sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  }

  async get(id) {
    if (isLocalId(id) || this.mode !== 'api') {
      const c = readLocal()[id];
      if (!c) throw new Error(this.needsLogin ? 'Log in to open this character.' : 'Character not found in this browser');
      return c;
    }
    id = this._resolve(id);
    const mine = this._cache()[id];
    if (isTempId(id)) { if (mine) return { ...mine }; throw new Error('Character not found on this device'); }
    try {
      const c = (await api('character', null, { id })).character;
      this._ok();
      if (mine && (mine.dirty || mine.stateDirty)) {
        // This device has changes that haven't been uploaded yet: keep them (the next save uploads or asks).
        return { ...c, build: mine.dirty ? mine.build : c.build, state: mine.stateDirty ? mine.state : c.state, version: mine.dirty ? mine.version : c.version };
      }
      this._put(c, { dirty: false, stateDirty: false, conflict: false });
      return c;
    } catch (e) {
      if (!this._soft(e)) throw e;
      if (mine) return { ...mine };
      throw new Error('You\'re offline and this character isn\'t saved on this device yet. Open it once while online.');
    }
  }

  async getShared(token) {
    return (await api('shared', null, { token })).character;
  }

  /**
   * Saves the build. Resolves with the record (its id/version updated) even when offline — check `rec.pending`.
   * Rejects with ConflictError when another device saved a newer version; call again with {force:true} to keep this one.
   */
  async save(c, { force = false } = {}) {
    c.updated = new Date().toISOString();
    c.name = c.build?.name || c.name || 'Unnamed';
    if (isLocalId(c.id) || this.mode !== 'api') {
      const all = readLocal();
      if (!c.id) c.id = 'local-' + uid();
      all[c.id] = c;
      writeLocal(all);
      return c;
    }
    c.id = c.id ? this._resolve(c.id) : 'tmp-' + uid();
    this._put(c, { dirty: true, ...(isTempId(c.id) ? { stateDirty: true } : {}) });
    try {
      c.id = await this._upload(c.id, force);
      c.version = this._cache()[c.id]?.version ?? c.version;
      c.pending = false;
    } catch (e) {
      if (e instanceof ConflictError) { this._put(c, { conflict: true }); this._emit(); throw e; }
      if (!this._soft(e)) throw e;
      c.pending = true;
    }
    this._emit();
    return c;
  }

  async saveState(id, state) {
    if (isLocalId(id) || this.mode !== 'api') {
      const all = readLocal();
      if (all[id]) { all[id].state = state; all[id].updated = new Date().toISOString(); writeLocal(all); }
      return { pending: false };
    }
    id = this._resolve(id);
    this._put({ id, state }, { stateDirty: true });
    if (isTempId(id)) { this._emit(); return { pending: true }; }
    try {
      await api('character_state', { id, state });
      this._ok();
      this._put({ id }, { stateDirty: false });
      this._emit();
      return { pending: false };
    } catch (e) {
      if (!this._soft(e)) throw e;
      this._emit();
      return { pending: true };
    }
  }

  async remove(id) {
    id = this._resolve(id);
    if (isLocalId(id) || this.mode !== 'api') {
      const all = readLocal();
      delete all[id];
      writeLocal(all);
      return;
    }
    if (!isTempId(id)) {
      try { await api('delete', { id }); this._ok(); } catch (e) { if (e instanceof OfflineError) throw new Error('You\'re offline. Delete it when you\'re back online.'); throw e; }
    }
    this.discardLocal(id);
  }

  async share(id, on = true) { return api('share', { id, on }); }

  localCount() { return Object.keys(readLocal()).length; }

  /** Copy characters saved in this browser into the logged-in account, then remove them from the browser. */
  async uploadLocal() {
    const all = readLocal();
    let n = 0;
    for (const [id, c] of Object.entries(all)) {
      await api('character', { id: null, name: c.name, build: c.build, state: c.state || {} });
      delete all[id];
      writeLocal(all);
      n++;
    }
    return n;
  }

  // ---------------------------------------------------------------- uploading
  /** Upload everything this device still holds. Safe to call often. */
  sync() {
    if (this.mode !== 'api' || !this.user) return Promise.resolve();
    if (this._syncing) return this._syncing;
    this._syncing = (async () => {
      for (const c of this._pending(this.user.id)) {
        if (c.conflict) continue;
        try { await this._upload(c.id, false); } catch (e) {
          if (e instanceof ConflictError) { this._put({ id: c.id }, { conflict: true }); continue; }
          if (this._soft(e)) break;
          console.error(e);
        }
      }
    })().finally(() => { this._syncing = null; this._emit(); });
    return this._syncing;
  }

  async _upload(id, force) {
    const c = this._cache()[id];
    if (!c) return id;
    if (c.dirty) {
      const isNew = isTempId(id);
      const body = { id: isNew ? null : id, name: c.name, build: c.build, version: c.version, force };
      if (isNew) body.state = c.state || {};
      const r = await api('character', body);
      this._ok();
      const all = this._cache();
      const cur = all[id] || c;
      // Changes made while this upload was on its way stay marked for the next one.
      const stillDirty = JSON.stringify(cur.build) !== JSON.stringify(c.build);
      const rec = { ...cur, id: r.id, version: r.version, updated: r.updated, dirty: stillDirty, conflict: false, stateDirty: isNew ? false : cur.stateDirty };
      if (r.id !== id) {
        delete all[id];
        const map = readJson(IDMAP_KEY, {});
        map[id] = r.id;
        writeJson(IDMAP_KEY, map);
      }
      all[r.id] = rec;
      this._writeCache(all);
      id = r.id;
    }
    const now = this._cache()[id];
    if (now && now.stateDirty && !isTempId(id)) {
      await api('character_state', { id, state: now.state || {} });
      this._ok();
      this._put({ id }, { stateDirty: false });
    }
    return id;
  }

  /** Set when another device saved a newer version and this device still holds its own changes. */
  conflictFor(id) { const c = this.mode === 'api' ? this._cache()[id] : null; return c && c.conflict ? c : null; }

  _ok() { if (!this.online) { this.online = true; this._emit(); } }
  /** Network trouble or an ended session: keep the change on this device instead of failing. */
  _soft(e) {
    if (e instanceof OfflineError) { if (this.online) { this.online = false; this._emit(); } return true; }
    if (e instanceof LoggedOutError) { this.needsLogin = true; this.lastUser = this.user; this._emit(); return true; }
    return false;
  }
}

function summary(c) {
  return { id: c.id, name: c.build?.name || c.name || 'Unnamed', level: c.build?.level, class: c.build?.class, ancestry: c.build?.ancestry, heritage: c.build?.heritage, updated: c.updated };
}
