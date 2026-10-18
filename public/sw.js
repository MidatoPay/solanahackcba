// Cache only this public, static offline page. Never store app HTML, bundles,
// sessions, API responses, RPC requests or payment operations.
const CACHE = 'midatopay-offline-v1';
const OFFLINE = '/offline.html';
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.add(OFFLINE)));
  // Let the normal waiting lifecycle finish; never reload a payment in progress.
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('midatopay-offline-') && key !== CACHE)
      .map(key => caches.delete(key)),
  )));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || request.mode !== 'navigate' ||
      url.origin !== self.location.origin || !['/', '/index.html'].includes(url.pathname)) return;
  event.respondWith(fetch(request).catch(async () => {
    const page = await (await caches.open(CACHE)).match(OFFLINE);
    return page || Response.error();
  }));
});
