// خدمة العمل بدون إنترنت: تحفظ ملفات التطبيق عند أول فتح، وبعدها يشتغل التطبيق كاملاً بلا نت.
// BUILD يكتبه build.mjs في كل بناء، فيتغيّر هذا الملف مع كل إصدار ويتحدّث التطبيق على الجوال.
const BUILD = '2aed100c0d';
const CACHE = `daftar-${BUILD}`;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const res = await fetch('precache.json', { cache: 'reload' });
    const { files } = await res.json();
    const cache = await caches.open(CACHE);
    // cache: 'reload' حتى لا تأتي ملفات قديمة من ذاكرة المتصفح المؤقتة
    await Promise.all(files.map((f) => cache.add(new Request(f, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('daftar-') && k !== CACHE) await caches.delete(k);
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
