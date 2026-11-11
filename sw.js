/* Offline support. Updates arrive on the launch after a deploy.
   Bump VERSION only if you add or rename files in SHELL. */
const VERSION = 'mahfuzat-v7';
const SHELL = [
  './',
  'index.html',
  'css/styles.css',
  'js/content.js',
  'js/logic.js',
  'js/lookup.js',
  'js/sync.js',
  'js/app.js',
  'manifest.json',
  'icons/icon.svg',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Google Fonts: serve from cache, refresh in the background.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(
      caches.open(VERSION + '-fonts').then((c) =>
        c.match(req).then((hit) => {
          const net = fetch(req).then((res) => { c.put(req, res.clone()); return res; }).catch(() => hit);
          return hit || net;
        })
      )
    );
    return;
  }

  if (url.origin !== location.origin) return;

  // App files: answer instantly from cache, fetch a fresh copy in the background
  // (so a new deploy shows up on the next launch). Offline pages fall back to the shell.
  e.respondWith(
    caches.open(VERSION).then((c) =>
      c.match(req, { ignoreSearch: true }).then((hit) => {
        const net = fetch(req, { cache: 'no-cache' })
          .then((res) => { if (res.ok) c.put(req, res.clone()); return res; })
          .catch(() => hit || (req.mode === 'navigate' ? c.match('index.html') : undefined));
        return hit || net;
      })
    )
  );
});
