const CACHE_NAME = "lightning-nearby-shell-v1";
const APP_SHELL = "/";
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(APP_SHELL, { cache: "reload" });
      if (response.ok) {
        await cache.put(APP_SHELL, response.clone());
        // Prime the initial route's JS and CSS so a cached shell can still
        // hydrate offline. Runtime caching below handles any later chunks.
        const html = await response.text();
        const assets = [...html.matchAll(/(?:src|href)="([^"]*\/_next\/static\/[^"]+)"/g)].map((match) => new URL(match[1], self.location.origin).href);
        await Promise.all(assets.map(async (asset) => {
          try { const file = await fetch(asset); if (file.ok) await cache.put(asset, file); } catch { /* Best-effort asset caching. */ }
        }));
      }
    } catch { /* Best-effort shell caching. */ }
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("lightning-nearby-") && key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Cache only Next's fingerprinted app assets. Weather is fetched from another
  // origin and is never cached, so an offline forecast cannot look current.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })());
    return;
  }

  if (request.mode !== "navigate") return;
  event.respondWith(fetch(request).catch(async () => {
    const shell = await caches.match(APP_SHELL);
    if (shell) return shell;
    return new Response("Lightning Nearby is offline. Connect to the internet to load the app and request a current forecast.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }));
});
