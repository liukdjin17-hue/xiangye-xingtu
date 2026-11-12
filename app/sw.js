/* 乡野星图 · Service Worker
 * 策略：应用外壳预缓存 + 网络优先更新，断网时回退缓存。
 * 只有 https / localhost 下才会注册（file:// 打开时不启用）。
 */
const CACHE = 'xyxt-v8';
const ASSETS = [
  './',
  './index.html',
  './teacher.html',
  './assets/style.css',
  './assets/data.js',
  './assets/tour.js',
  './assets/star.js',
  './assets/app.js',
  './assets/teacher.js',
  './assets/icon-180.png',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-512-maskable.png',
  './manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(ASSETS.map(u => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
  );
});
