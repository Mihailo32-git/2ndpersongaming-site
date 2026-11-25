// Loads the generated JSON data (public/data) and gives lookups by reference.
// A reference looks like "@feats/toughness" or "feats/toughness".

import { refParts } from './util.js';

export const CORE_KEYS = ['ancestries', 'heritages', 'backgrounds', 'classes', 'classfeatures', 'ancestryfeatures', 'feats', 'spells', 'actions', 'conditions', 'deities', 'domains'];
export const EXTRA_KEYS = ['equipment', 'feat-effects', 'spell-effects', 'equipment-effects'];

export function bucketOf(slug, n) {
  // Must match bucketOf() in tools/build-data.php (hash over UTF-8 bytes).
  const bytes = new TextEncoder().encode(slug);
  let h = 0;
  for (const b of bytes) h = (h * 31 + b) & 0x7fffffff;
  return h % n;
}

export class DB {
  constructor({ base = 'data/', fetchJson } = {}) {
    this.base = base;
    this.fetchJson = fetchJson || (async (path) => {
      const r = await fetch(this.base + path, { cache: 'default' });
      if (!r.ok) throw new Error('Could not load ' + path + ' (' + r.status + ')');
      return r.json();
    });
    this.lists = {};
    this.maps = {};
    this.textCache = {};
    this.loading = {};
    this.meta = null;
    this.traits = {};
  }

  async init() {
    this.meta = await this.fetchJson('meta.json');
    await this.load(CORE_KEYS);
    return this;
  }

  async load(keys) {
    await Promise.all(keys.map((k) => {
      if (this.lists[k]) return null;
      if (!this.loading[k]) {
        this.loading[k] = this.fetchJson(k + '.json').then((list) => {
          const map = new Map();
          for (const r of list) { r._pack = k; map.set(r.slug, r); }
          this.lists[k] = list;
          this.maps[k] = map;
        });
      }
      return this.loading[k];
    }));
  }

  async loadTraits() {
    if (!this._traits) this._traits = this.fetchJson('traits.json').then((t) => (this.traits = t));
    return this._traits;
  }

  has(key) { return !!this.lists[key]; }
  list(key) { return this.lists[key] || []; }

  get(ref) {
    if (!ref) return null;
    const [pack, slug] = refParts(ref);
    if (!pack) return null;
    return this.maps[pack]?.get(slug) || null;
  }

  /** Find by slug in several packs (used for "slugsAsValues" choices). */
  findSlug(slug, packs) {
    for (const p of packs) {
      const r = this.maps[p]?.get(slug);
      if (r) return r;
    }
    return null;
  }

  /** Find by display name (case-insensitive) in several packs. */
  findName(name, packs) {
    const n = String(name).toLowerCase();
    this.nameIndex = this.nameIndex || {};
    for (const p of packs) {
      if (!this.lists[p]) continue;
      if (!this.nameIndex[p]) { const m = new Map(); for (const r of this.lists[p]) if (!m.has(r.name.toLowerCase())) m.set(r.name.toLowerCase(), r); this.nameIndex[p] = m; }
      const r = this.nameIndex[p].get(n);
      if (r) return r;
    }
    return null;
  }

  async text(ref) {
    const [pack, slug] = refParts(ref);
    if (!pack) return '';
    const n = this.meta?.textBuckets?.[pack] || 4;
    const b = bucketOf(slug, n);
    const key = pack + '/' + b;
    if (!this.textCache[key]) {
      this.textCache[key] = this.fetchJson('text/' + key + '.json').catch(() => ({}));
    }
    const m = await this.textCache[key];
    return m[slug] || '';
  }
}

export function refOf(rec) {
  return rec ? '@' + rec._pack + '/' + rec.slug : null;
}
