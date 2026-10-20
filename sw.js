// Service worker: the app shell, font and analyzer are saved on install;
// dictionary shards are saved the first time they're used (or all at once from Settings).
const VERSION = 'v1';
const SHELL = `shell-${VERSION}`;
const DICT = 'dict-jm-1';
const PRECACHE = [
  "./",
  "index.html",
  "css/app.css",
  "js/app.js",
  "js/books.js",
  "js/dict.js",
  "js/nlp.js",
  "js/store.js",
  "lib/kuromoji.js",
  "fonts/FurifontSansVF.woff2",
  "fonts/FurifontSansVF.ivs.json",
  "dict/manifest.json",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-512.png",
  "icons/apple-touch-icon.png",
  "dict/kuromoji/base.dat.gz",
  "dict/kuromoji/cc.dat.gz",
  "dict/kuromoji/check.dat.gz",
  "dict/kuromoji/tid.dat.gz",
  "dict/kuromoji/tid_map.dat.gz",
  "dict/kuromoji/tid_pos.dat.gz",
  "dict/kuromoji/unk.dat.gz",
  "dict/kuromoji/unk_char.dat.gz",
  "dict/kuromoji/unk_compat.dat.gz",
  "dict/kuromoji/unk_invoke.dat.gz",
  "dict/kuromoji/unk_map.dat.gz",
  "dict/kuromoji/unk_pos.dat.gz"
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== DICT) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const isShard = url.pathname.includes('/dict/jm/');
  const cacheName = isShard ? DICT : SHELL;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (e) {
      if (req.mode === 'navigate') {
        const shell = await cache.match('index.html');
        if (shell) return shell;
      }
      throw e;
    }
  })());
});
