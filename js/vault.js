// The vault: a local copy of every file (IndexedDB), kept in step with a backend.
// Edits land locally at once and are pushed shortly after; pulls happen on open,
// on focus and every couple of minutes. Works offline and catches up later.

import { Conflict, isBinary } from './backends.js?v=1794684588';
import { merge3 } from './merge.js?v=1794684588';
import { KEYS } from './config.js?v=1794684588';

const DB = KEYS.db, STORE = 'files', META = 'meta';

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE, { keyPath: 'path' }); r.result.createObjectStore(META); };
    r.onsuccess = () => { r.result.onversionchange = () => r.result.close(); res(r.result); };
    r.onerror = () => rej(r.error);
  });
}
const tx = (db, store, mode, fn) => new Promise((res, rej) => {
  const t = db.transaction(store, mode); const out = fn(t.objectStore(store));
  t.oncomplete = () => res(out?.result ?? out); t.onerror = () => rej(t.error);
});

export class Vault {
  constructor() {
    this.files = new Map(); // path -> { path, content, sha, base, dirty, deleted, binary }
    this.listeners = new Set();
    this.status = { state: 'idle', pending: 0, at: null, error: null };
    this.syncing = null;
    this.pushTimer = null;
    this.urls = new Map();
    // a write GitHub refuses again and again (a name it does not accept, a protected branch) is tried three times,
    // then left alone and named in the status, instead of being sent without pause for ever
    this.refused = new Map(); // path -> refusals in a row
    this.stuck = new Set();   // paths given up on, until they are edited here or change on GitHub
  }
  retry(path) { this.refused.delete(path); this.stuck.delete(path); }

  async open(backend, backendKey) {
    this.backend = backend;
    this.db = await idb();
    const key = await tx(this.db, META, 'readonly', (s) => s.get('backend'));
    if (key !== backendKey) { // switched repositories: start from a clean copy
      await tx(this.db, STORE, 'readwrite', (s) => s.clear());
      await tx(this.db, META, 'readwrite', (s) => s.put(backendKey, 'backend'));
    }
    const all = await tx(this.db, STORE, 'readonly', (s) => s.getAll());
    for (const f of all) this.files.set(f.path, f);
    this.status.at = await tx(this.db, META, 'readonly', (s) => s.get('lastSync')) || null;
    this.updatePending();
    this.emit();
  }

  // start over: forget every local copy (unsent edits included) and download again
  async reset() {
    await tx(this.db, STORE, 'readwrite', (s) => s.clear());
    await tx(this.db, META, 'readwrite', (s) => s.clear());
    this.files.clear();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(paths) { for (const fn of this.listeners) fn(paths); }
  setStatus(patch) { Object.assign(this.status, patch); this.updatePending(); this.emit(); }
  updatePending() { this.status.pending = [...this.files.values()].filter((f) => f.dirty).length; }
  async save(f) { this.files.set(f.path, f); await tx(this.db, STORE, 'readwrite', (s) => s.put(f)); }
  async drop(path) { this.files.delete(path); await tx(this.db, STORE, 'readwrite', (s) => s.delete(path)); }

  // ---- reading ----
  list() { return [...this.files.values()].filter((f) => !f.deleted); }
  get(path) { const f = this.files.get(path); return f && !f.deleted ? f : null; }
  read(path) { return this.get(path)?.content ?? null; }
  exists(path) { return !!this.get(path); }

  async assetURL(path) {
    if (this.urls.has(path)) return this.urls.get(path);
    const f = this.get(path);
    if (!f) return null;
    let blob = f.content;
    if (!(blob instanceof Blob)) {
      if (!this.backend.read) return null;
      try { blob = await this.backend.read(path, f.sha); } catch { return null; }  // offline and not downloaded yet
      await this.save({ ...f, content: blob });
    }
    const url = URL.createObjectURL(blob);
    this.urls.set(path, url);
    return url;
  }

  // ---- writing ----
  async write(path, content) {
    const f = this.files.get(path);
    if (f && !f.deleted && f.content === content) return;
    const binary = content instanceof Blob; // drawings: uploaded as they are, never merged
    this.retry(path);
    await this.save({
      path, content, sha: f?.sha ?? null, base: binary ? null : f?.base ?? (f?.sha ? f.content : null),
      dirty: true, deleted: false, binary,
    });
    this.updatePending();
    this.emit([path]);
    this.schedulePush();
  }
  async create(path, content) {
    if (this.exists(path)) throw new Error('A file with that name already exists.');
    await this.write(path, content);
  }
  async remove(path) {
    const f = this.files.get(path); if (!f) return;
    this.retry(path);
    if (!f.sha) await this.drop(path);
    else await this.save({ ...f, deleted: true, dirty: true });
    this.updatePending(); this.emit([path]); this.schedulePush();
  }
  async rename(from, to) {
    if (from === to) return;
    const f = this.get(from); if (!f) return;
    if (this.exists(to)) throw new Error('A file with that name already exists.');
    await this.write(to, f.content);
    await this.remove(from);
  }

  // pictures and drawings in attachments/ are downloaded in the background, so they show offline too
  async prefetch() {
    if (this.prefetching || !this.backend.read) return;
    this.prefetching = true;
    try {
      const todo = [...this.files.values()].filter((f) => f.binary && !f.deleted && !(f.content instanceof Blob) && f.path.startsWith('attachments/'));
      for (let i = 0; i < todo.length && navigator.onLine; i += 4) {
        await Promise.all(todo.slice(i, i + 4).map(async (f) => {
          try { const blob = await this.backend.read(f.path, f.sha); const now = this.files.get(f.path); if (now && now.sha === f.sha) await this.save({ ...now, content: blob }); } catch {}
        }));
      }
    } finally { this.prefetching = false; }
  }

  schedulePush() {
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => this.sync({ pull: false }), 1200);
  }

  // ---- syncing ----
  sync(opts = {}) {
    if (this.syncing) { this.again = true; return this.syncing; }
    this.syncing = this._sync(opts).finally(() => {
      this.syncing = null;
      if (this.again) { this.again = false; this.sync({ pull: false }); }
    });
    return this.syncing;
  }

  async _sync({ pull = true } = {}) {
    if (this.backend.local) { this.setStatus({ state: 'local' }); return; }
    if (!navigator.onLine) { this.setStatus({ state: 'offline' }); return; }
    this.setStatus({ state: 'syncing', error: null });
    try {
      if (pull) await this.pull();
      await this.push();
      const at = Date.now();
      await tx(this.db, META, 'readwrite', (s) => s.put(at, 'lastSync'));
      const stuck = [...this.stuck].map((p) => `"${p}"`);
      if (stuck.length) this.setStatus({ state: 'error', at, progress: null, error: `GitHub refused ${stuck.join(', ')} three times. ${stuck.length > 1 ? 'They are' : 'It is'} kept on this device. Rename or change ${stuck.length > 1 ? 'them' : 'it'} to try again.` });
      else this.setStatus({ state: 'synced', at, progress: null });
      this.prefetch();
    } catch (e) {
      // no connection (the phone may still think it's online): offline, and try again shortly; edits stay queued here
      if (e instanceof TypeError || /fetch|load failed|network/i.test(e.message)) {
        this.setStatus({ state: 'offline', progress: null });
        clearTimeout(this.retry); this.retry = setTimeout(() => this.sync(), 20000);
        return;
      }
      console.error(e);
      this.setStatus({ state: 'error', error: e.message, progress: null });
    }
  }

  async pull() {
    const remote = await this.backend.list();
    if (!remote) return;
    const seen = new Set();
    const changed = [];
    const toFetch = [];
    for (const { path, sha } of remote) {
      seen.add(path);
      const f = this.files.get(path);
      if (f && f.sha === sha) continue;
      const binary = isBinary(path);
      if (binary) { // fetched lazily when shown
        await this.save({ path, content: null, sha, base: null, dirty: false, deleted: false, binary });
        this.urls.delete(path); changed.push(path); continue;
      }
      toFetch.push({ path, sha, binary });
    }
    // fetch changed files eight at a time (a new device downloads everything once)
    const texts = new Map();
    for (let i = 0; i < toFetch.length; i += 8) {
      const batch = toFetch.slice(i, i + 8);
      const got = await Promise.all(batch.map((x) => this.backend.read(x.path, x.sha)));
      batch.forEach((x, k) => texts.set(x.path, got[k]));
      if (toFetch.length > 40) this.setStatus({ state: 'syncing', progress: `${Math.min(i + 8, toFetch.length)}/${toFetch.length}` });
    }
    for (const { path, sha, binary } of toFetch) {
      const text = texts.get(path);
      this.retry(path); // a new version on GitHub: worth another try
      const f = this.files.get(path); // the latest local state: edits may have landed meanwhile
      if (f && f.dirty && !f.deleted) {
        const merged = merge3(f.base ?? '', f.content, text);
        await this.save({ ...f, content: merged, base: text, sha, dirty: merged !== text });
      } else if (f && f.deleted && f.dirty) {
        // deleted here but edited there: keep their version
        await this.save({ path, content: text, base: text, sha, dirty: false, deleted: false, binary });
      } else {
        await this.save({ path, content: text, base: text, sha, dirty: false, deleted: false, binary });
      }
      changed.push(path);
    }
    for (const f of [...this.files.values()]) {
      if (seen.has(f.path) || !f.sha) continue; // never-pushed new files stay
      if (f.dirty && !f.deleted) await this.save({ ...f, sha: null, base: null }); // deleted there, edited here: re-add
      else { await this.drop(f.path); changed.push(f.path); }
    }
    if (changed.length) this.emit(changed);
  }

  async push() {
    for (const f of [...this.files.values()]) {
      if (!f.dirty || this.stuck.has(f.path)) continue;
      const cur = this.files.get(f.path);
      try {
        if (cur.deleted) { await this.backend.remove(cur.path, cur.sha); await this.drop(cur.path); }
        else {
          const sha = await this.backend.write(cur.path, cur.content, cur.sha);
          const now = this.files.get(cur.path);
          // only clear dirty if nothing changed while we were uploading
          await this.save({ ...now, sha, base: cur.content, dirty: now.content !== cur.content });
        }
        this.refused.delete(cur.path);
      } catch (e) {
        if (!(e instanceof Conflict)) throw e;
        const n = (this.refused.get(cur.path) || 0) + 1;
        this.refused.set(cur.path, n);
        if (n >= 3) { this.stuck.add(cur.path); continue; } // refused three times: stop, go on with the other files
        await this.pull(); // merges the remote version in; the next pass pushes the result
        this.again = true;
        return;
      }
    }
  }
}
