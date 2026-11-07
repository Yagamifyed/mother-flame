// Keeps the app itself available offline. Your files are cached separately (IndexedDB);
// requests to GitHub are never touched here. Bump VERSION on every release.
const VERSION = 'v58';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/main.js', 'js/config.js', 'js/vault.js', 'js/backends.js', 'js/md.js', 'js/merge.js', 'js/render.js', 'js/dates.js', 'js/answers.js',
  'vendor/marked.esm.js', 'vendor/purify.es.mjs',
  'fonts/inter-latin-wght-normal.woff2', 'fonts/inter-latin-ext-wght-normal.woff2',
  'fonts/hedvig-letters-serif-latin-400-normal.woff2', 'fonts/hedvig-letters-serif-latin-ext-400-normal.woff2',
  'fonts/bebas-neue-latin-400-normal.woff2',
  'manifest-dark.webmanifest',
  'sprites/stella-idle.png', 'sprites/stella-think.png', 'sprites/stella-type.png', 'sprites/stella-write.png',
  'sprites/stella-walk-left.png', 'sprites/stella-walk-right.png', 'sprites/station-ohara.png',
  'sprites/station-punk-records.png', 'sprites/station-paper-architect.png', 'sprites/station-egghead.png',
  'sprites/station-museum.png', 'sprites/station-codex.png', 'sprites/station-zotero.png', 'sprites/station-mother-flame.png',
  'icons/icon-192.png', 'icons/apple-touch-icon.png', 'icons/icon-192-dark.png', 'icons/apple-touch-icon-dark.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// network first, always revalidated (so an update shows on the next open); the cached copy when offline, or when
// the network takes longer than 3 seconds (a weak signal shouldn't keep the app from opening)
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith((async () => {
    const cached = () => caches.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request, { cache: 'no-cache' }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return res;
    });
    net.catch(() => {});
    try { const r = await Promise.race([net, new Promise((ok) => setTimeout(ok, 3000, 'slow'))]); if (r !== 'slow') return r; } catch {}
    const c = await cached();
    if (c) return c;
    try { return await net; } catch { return (await caches.match('index.html')) || Response.error(); }
  })());
});
