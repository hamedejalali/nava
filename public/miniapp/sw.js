/* مویاگرام — service worker: static files (js/css/fonts) open instantly from the device cache and refresh in the background.
   API calls and signed media are never touched. Bumping VERSION replaces the cache. */
var VERSION = "ng-1.27.1";
self.addEventListener("install", function (e) { self.skipWaiting(); });
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  var r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== location.origin || u.pathname.indexOf("/miniapp/") !== 0 || /\/sw\.js$/.test(u.pathname)) return;
  if (!/\.(js|css|woff2|png|jpg|svg)$/.test(u.pathname)) return; // never the HTML page itself: a new version must show up at once
  e.respondWith(caches.open(VERSION).then(function (c) {
    return c.match(r).then(function (hit) {
      var net = fetch(r).then(function (res) { if (res && res.ok) c.put(r, res.clone()); return res; }).catch(function () { return hit; });
      return hit || net; // cache first (stale-while-revalidate)
    });
  }));
});
