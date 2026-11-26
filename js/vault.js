// The vault: a local copy of every file (IndexedDB), kept in step with a backend.
// Edits land locally at once and are pushed shortly after; pulls happen on open,
// on focus and every couple of minutes. Works offline and catches up later.

import { Conflict, isBinary } from './backends.js?v=1795714160';
import { merge3 } from './merge.js?v=1795714160';
import { KEYS } from './config.js?v=1795714160';

const DB = KEYS.db, STORE = 'files', META = 'meta';
// a second record of every edit not yet sent, apart from the database (Levin, 26 Nov 2026: "make a failsafe such that
// those edits which have not yet sent ... do not actually get lost"; "the system has to fix itself")
const UNSENT = KEYS.db + '.unsent';

// `lost` is called when the browser closes the connection by itself (iOS does, for an app left in the background)
function idb(lost = () => {}) {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE, { keyPath: 'path' }); r.result.createObjectStore(META); };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => { db.close(); lost(db); };
      db.onclose = () => lost(db);
      res(db);
    };
    r.onerror = () => rej(r.error);
  });
}
const tx = (db, store, mode, fn) => new Promise((res, rej) => {
  const t = db.transaction(store, mode); const out = fn(t.objectStore(store));
  t.oncomplete = () => res(out?.result ?? out); t.onerror = () => rej(t.error);
  t.onabort = () => rej(t.error || new DOMException('The step was stopped', 'AbortError'));
});
// a connection that iOS closed: "The database connection is closing", "… is closed"
const CLOSED = (e) => e?.name === 'InvalidStateError' || /connection is clos|database.*clos/i.test(e?.message || '');

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
    // the second record: path -> { content, base, sha, deleted, at }, written at once with every edit (text files);
    // pictures can't go there, so a picture the database has not taken yet holds back a reload for an update
    this.unsent = { backend: null, files: {} };
    this.heldPictures = new Set();
    this.restored = 0;        // edits the database had lost and the second record brought back, at the last opening
    this.fails = 0;           // syncs failed in a row: the next try waits longer
  }
  retry(path) { this.refused.delete(path); this.stuck.delete(path); }

  // the local database, opened again whenever the browser has closed it (Levin, 26 Nov 2026: "Sync problem: Failed to
  // execute 'transaction' on 'IDBDatabase': The database connection is closing", on the phone after a while away)
  conn() {
    return this.dbp ||= idb((db) => { if (this.db === db) { this.db = null; this.dbp = null; } })
      .then((db) => (this.db = db))
      .catch((e) => { this.dbp = null; throw e; });
  }
  // one step in the database; if the connection was closed under it, open it again and repeat the step once
  async tx(store, mode, fn) {
    for (let again = false; ; again = true) {
      const db = await this.conn();
      try { return await tx(db, store, mode, fn); }
      catch (e) {
        if (again || !CLOSED(e)) throw e;
        if (this.db === db) { try { db.close(); } catch {} this.db = null; this.dbp = null; }
      }
    }
  }

  async open(backend, backendKey) {
    this.backend = backend;
    await this.conn();
    const key = await this.tx(META, 'readonly', (s) => s.get('backend'));
    if (key !== backendKey) { // switched repositories: start from a clean copy
      await this.tx(STORE, 'readwrite', (s) => s.clear());
      await this.tx(META, 'readwrite', (s) => s.put(backendKey, 'backend'));
    }
    const all = await this.tx(STORE, 'readonly', (s) => s.getAll());
    for (const f of all) this.files.set(f.path, f);
    this.status.at = await this.tx(META, 'readonly', (s) => s.get('lastSync')) || null;
    await this.recover(backendKey);
    this.updatePending();
    this.emit();
  }

  // ---- the second record of unsent edits ----
  writeUnsent() {
    try { localStorage.setItem(UNSENT, JSON.stringify(this.unsent)); return true; }
    catch (e) { console.warn('The second record of unsent edits could not be written', e); return false; }
  }
  note(f) {
    if (f.binary) {
      if (f.dirty) this.heldPictures.add(f.path); else this.heldPictures.delete(f.path);
      return;
    }
    const had = f.path in this.unsent.files;
    if (f.dirty) this.unsent.files[f.path] = { content: f.content, base: f.base ?? null, sha: f.sha ?? null, deleted: !!f.deleted, at: f.at };
    else if (had) delete this.unsent.files[f.path];
    else return;
    this.writeUnsent();
  }
  // on opening: every edit in the second record that the database does not hold (it lost it, or never took it) comes
  // back as an unsent edit and goes out with the next sync; one that changed on GitHub meanwhile is merged with it
  async recover(backendKey) {
    let rec = null;
    try { rec = JSON.parse(localStorage.getItem(UNSENT) || 'null'); } catch {}
    this.unsent = { backend: backendKey, files: rec?.backend === backendKey ? rec.files || {} : {} };
    this.restored = 0;
    for (const [path, e] of Object.entries(this.unsent.files)) {
      const f = this.files.get(path);
      if (f && (f.at || 0) >= (e.at || 0)) {
        // the database has this edit or a later one; once it is sent, the record goes
        if (!f.dirty) delete this.unsent.files[path];
        continue;
      }
      const changed = f && f.sha && f.sha !== e.sha && typeof f.content === 'string';
      const content = changed && !e.deleted ? merge3(e.base ?? '', e.content, f.content) : e.content;
      await this.save({ path, content, sha: f?.sha ?? e.sha, base: changed ? f.content : e.base, dirty: true, deleted: e.deleted, binary: false });
      this.restored++;
    }
    this.writeUnsent();
    if (this.restored) console.info(`Brought back ${this.restored} unsent edit(s) from the second record`);
  }
  // a reload for an update waits while a picture is in memory only
  safeToReload() { return !this.heldPictures.size; }

  // start over: forget every local copy (unsent edits included) and download again
  async reset() {
    await this.tx(STORE, 'readwrite', (s) => s.clear());
    await this.tx(META, 'readwrite', (s) => s.clear());
    this.files.clear();
    this.unsent.files = {}; this.heldPictures.clear(); this.writeUnsent();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(paths) { for (const fn of this.listeners) fn(paths); }
  setStatus(patch) { Object.assign(this.status, patch); this.updatePending(); this.emit(); }
  updatePending() { this.status.pending = [...this.files.values()].filter((f) => f.dirty).length; }
  // the copy in memory and the second record first, at once; then the database. If the database still refuses after
  // being opened again, nothing is lost: the edit is sent from memory, kept in the second record, and the database
  // catches up at the next save or opening
  async save(f) {
    // (each unsent version gets its time, so the newer of the two records can be told)
    if (f.dirty) f = { ...f, at: Date.now() };
    this.files.set(f.path, f);
    this.note(f);
    try {
      await this.tx(STORE, 'readwrite', (s) => s.put(f));
      if (f.binary && this.files.get(f.path) === f) this.heldPictures.delete(f.path);
    } catch (e) { console.warn('The database did not take', f.path, e); }
  }
  async drop(path) {
    this.files.delete(path);
    if (path in this.unsent.files) { delete this.unsent.files[path]; this.writeUnsent(); }
    this.heldPictures.delete(path);
    try { await this.tx(STORE, 'readwrite', (s) => s.delete(path)); } catch (e) { console.warn('The database did not drop', path, e); }
  }

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
      await this.tx(META, 'readwrite', (s) => s.put(at, 'lastSync'));
      const stuck = [...this.stuck].map((p) => `"${p}"`);
      this.fails = 0;
      if (stuck.length) this.setStatus({ state: 'error', at, progress: null, error: `GitHub refused ${stuck.join(', ')} three times. ${stuck.length > 1 ? 'They are' : 'It is'} kept on this device. Rename or change ${stuck.length > 1 ? 'them' : 'it'} to try again.` });
      else this.setStatus({ state: 'synced', at, progress: null });
      this.prefetch();
    } catch (e) {
      // no connection (the phone may still think it's online): offline, and try again shortly; edits stay queued here
      if (e instanceof TypeError || /fetch|load failed|network/i.test(e.message)) {
        this.setStatus({ state: 'offline', progress: null });
        // (its own name: this.retry is the method that gives a refused file another try; the timer once replaced it)
        clearTimeout(this.retryTimer); this.retryTimer = setTimeout(() => this.sync(), 20000);
        return;
      }
      console.error(e);
      // the reason in plain words; where waiting helps (GitHub busy or down, too many requests), it tries again by itself
      const s = e.status, limited = s === 429 || (s === 403 && /rate limit/i.test(e.message));
      const error = s === 401 ? 'GitHub no longer accepts the token (it may have expired). Make a new one and paste it in Settings.'
        : limited ? 'GitHub is limiting requests for a while. Mother Flame tries again by itself.'
        : s >= 500 ? 'GitHub is not answering properly just now. Mother Flame tries again by itself.'
        : s === 403 ? 'GitHub refused access (403). The token may lack write access to the vault: check it in Settings.'
        : `${e.message} Mother Flame tries again by itself.`;
      this.setStatus({ state: 'error', error, progress: null });
      // whatever went wrong, it tries again by itself: after 30 seconds, then 1, 2, 4 minutes, then every 5 minutes
      // (2 minutes at the least when GitHub limits requests); edits wait safely meanwhile
      this.fails++;
      const wait = Math.max(limited ? 120000 : 0, Math.min(300000, 30000 * 2 ** (this.fails - 1)));
      clearTimeout(this.retryTimer); this.retryTimer = setTimeout(() => this.sync(), wait);
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
