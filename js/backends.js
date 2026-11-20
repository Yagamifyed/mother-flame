// Where the Markdown files live. Every backend speaks the same four verbs:
// list() -> [{ path, sha }], read(path, sha), write(path, text, sha), remove(path, sha).
// `sha` is the git blob hash, used to detect that someone else changed the file.

export class Conflict extends Error {}

const TRACKED = /\.(md|png|jpe?g|gif|webp|svg|heic|avif|tiff|m4a|mp4|aac|mp3|wav|webm|ogg)$/i;
const IGNORED = /(^|\/)(\.git|\.obsidian|\.trash|node_modules)(\/|$)|(^|\/)\./;
export const isBinary = (p) => !/\.md$/i.test(p);
const tracked = (p) => TRACKED.test(p) && !IGNORED.test(p);

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function blobB64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64bytes(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', heic: "image/heic", avif: "image/avif", tiff: "image/tiff",
  m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac", mp3: "audio/mpeg", wav: "audio/wav", webm: "audio/webm", ogg: "audio/ogg" };
const mimeOf = (p) => MIME[p.split('.').pop().toLowerCase()] || 'application/octet-stream';

// ---------- GitHub (a private repository) ----------

export class GitHubBackend {
  constructor({ owner, repo, branch = 'main', token, root = '' }) {
    Object.assign(this, { owner, repo, branch, token });
    this.root = root.replace(/^\/+|\/+$/g, '');
    this.label = `github.com/${owner}/${repo}`;
  }
  full(p) { return this.root ? `${this.root}/${p}` : p; }
  url(path) { return `https://api.github.com/repos/${this.owner}/${this.repo}${path}`; }
  async req(method, path, body) {
    const res = await fetch(this.url(path), {
      method, cache: 'no-store',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 409 || (res.status === 422 && method !== 'GET')) throw new Conflict(`${res.status}`);
    if (!res.ok) {
      const msg = (await res.json().catch(() => ({}))).message || res.statusText;
      const err = new Error(`GitHub ${res.status}: ${msg}`); err.status = res.status; throw err;
    }
    return res.status === 204 ? null : res.json();
  }
  // the vault's history (for the Recent page)
  async history(n = 40) { return this.req('GET', `/commits?sha=${encodeURIComponent(this.branch)}&per_page=${n}`); }
  async commit(sha) { return this.req('GET', `/commits/${sha}`); }
  async check() {
    const r = await this.req('GET', '');
    if (!r.permissions?.push) throw new Error('This token cannot write to the repository.');
    if (!r.private) return 'Warning: this repository is public.';
    return null;
  }
  async list() {
    let tree;
    try { tree = await this.req('GET', `/git/trees/${encodeURIComponent(this.branch)}?recursive=1`); }
    catch (e) { if (e.status === 404 || e instanceof Conflict) return []; throw e; } // empty repo
    const pre = this.root ? this.root + '/' : '';
    return tree.tree
      .filter((t) => t.type === 'blob' && t.path.startsWith(pre))
      .map((t) => ({ path: t.path.slice(pre.length), sha: t.sha }))
      .filter((t) => tracked(t.path));
  }
  async read(path, sha) {
    const blob = await this.req('GET', `/git/blobs/${sha}`);
    const bytes = b64bytes(blob.content);
    return isBinary(path) ? new Blob([bytes], { type: mimeOf(path) }) : new TextDecoder().decode(bytes);
  }
  contentsPath(p) { return '/contents/' + this.full(p).split('/').map(encodeURIComponent).join('/'); }
  async write(path, text, sha) {
    const content = text instanceof Blob ? await blobB64(text) : b64encode(text);
    const r = await this.req('PUT', this.contentsPath(path), {
      message: `${sha ? 'Update' : 'Add'} ${path}`, content, branch: this.branch, ...(sha ? { sha } : {}),
    });
    return r.content.sha;
  }
  async remove(path, sha) {
    try { await this.req('DELETE', this.contentsPath(path), { message: `Delete ${path}`, sha, branch: this.branch }); }
    catch (e) { if (e.status !== 404) throw e; }
  }
}

// ---------- local folder, served by tools/serve.mjs (Mac preview) ----------

export class FolderBackend {
  constructor() { this.label = 'Local folder (preview)'; }
  async req(method, q, body) {
    const res = await fetch(`/api/file?${new URLSearchParams(q)}`, { method, body, cache: 'no-store' });
    if (res.status === 409) throw new Conflict('409');
    if (!res.ok) throw new Error(`Folder ${res.status}`);
    return res;
  }
  async check() { const r = await fetch('/api/list', { cache: 'no-store' }); if (!r.ok) throw new Error('No local server'); return null; }
  async list() { return (await (await fetch('/api/list', { cache: 'no-store' })).json()).filter((t) => tracked(t.path)); }
  async read(path) {
    const r = await this.req('GET', { path });
    return isBinary(path) ? r.blob() : r.text();
  }
  async write(path, text, sha) { return (await (await this.req('PUT', { path, sha: sha || '' }, text)).json()).sha; }
  async history(n = 40) { return (await fetch(`/api/commits?n=${n}`, { cache: 'no-store' })).json(); }
  async commit(sha) { return (await fetch(`/api/commit?sha=${sha}`, { cache: 'no-store' })).json(); }
  async remove(path, sha) { await this.req('DELETE', { path, sha: sha || '' }); }
}

// ---------- nothing remote: files stay on this device ----------

export class DeviceBackend {
  constructor() { this.label = 'This device only'; this.local = true; }
  async check() { return null; }
  async list() { return null; } // null = "no remote; keep what we have"
}
