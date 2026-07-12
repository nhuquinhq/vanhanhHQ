// Service Worker — chỉ cache "vỏ app" (trang index) để mở app nhanh/khi rớt mạng.
// Dữ liệu (Google Sheet CSV, /api/*) LUÔN đi thẳng mạng — không bao giờ cache để số liệu luôn tươi.
const SHELL = "pvh-shell-v1";
self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const ks = await caches.keys();
    await Promise.all(ks.filter(k => k !== SHELL).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.mode === "navigate" && u.origin === location.origin) {
    e.respondWith((async () => {
      try {
        const r = await fetch(e.request);
        const c = await caches.open(SHELL);
        c.put("/", r.clone());
        return r;
      } catch (err) {
        const c = await caches.open(SHELL);
        const m = await c.match("/");
        if (m) return m;
        throw err;
      }
    })());
  }
  // các request khác: không can thiệp (đi thẳng mạng)
});
