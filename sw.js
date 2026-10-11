// خدمة العمل بدون إنترنت: تحفظ ملفات التطبيق عند أول فتح، وبعدها يشتغل التطبيق كاملاً بلا نت.
// قائمة الملفات والإصدار يكتبهما build.mjs في precache.json.
let cacheName = 'daftar-dev';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const res = await fetch('precache.json', { cache: 'no-store' });
    const { version, files } = await res.json();
    cacheName = `daftar-${version}`;
    const cache = await caches.open(cacheName);
    await cache.addAll(files);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const res = await fetch('precache.json', { cache: 'no-store' }).catch(() => null);
    if (res && res.ok) cacheName = `daftar-${(await res.json()).version}`;
    for (const k of await caches.keys()) if (k.startsWith('daftar-') && k !== cacheName) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try { return await fetch(req); } catch {
      if (req.mode === 'navigate') { const idx = await caches.match('index.html'); if (idx) return idx; }
      return new Response('', { status: 504 });
    }
  })());
});
