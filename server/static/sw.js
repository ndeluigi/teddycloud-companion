// Storie service worker.
//  - app shell: network-first, cache fallback (works offline once loaded)
//  - /library and /resolve/*: network-first, cache fallback (so the tiles and the story lookup
//    still work without a connection)
//  - /stream/* and /cover/*: served from the OFFLINE cache when the story was downloaded for
//    offline use (Range requests are honoured by slicing the cached body), else network
//  - everything else (admin calls, login, APK) is never cached
const CACHE = "storie-shell-v11";
const OFFLINE = "storie-offline-v1";
const SHELL = [
  "/static/i18n.js?v=9",
  "/static/app.js?v=9",
  "/manifest.webmanifest?v=3",
  "/static/icon-192.png?v=3",
  "/static/icon-512.png?v=3",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE && k !== OFFLINE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Range support for cached audio: slice the full cached body into a 206 response.
async function rangeResponse(cached, request) {
  const range = request.headers.get("range");
  const buf = await cached.arrayBuffer();
  const total = buf.byteLength;
  const type = cached.headers.get("content-type") || "audio/ogg";
  if (!range) {
    return new Response(buf, { status: 200, headers: { "Content-Type": type, "Content-Length": String(total), "Accept-Ranges": "bytes" } });
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
  if (m && !m[1] && m[2]) { start = Math.max(0, total - parseInt(m[2], 10)); end = total - 1; }
  end = Math.min(end, total - 1);
  if (start > end || start >= total) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
  }
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": type,
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Accept-Ranges": "bytes",
    },
  });
}

async function networkFirst(request, cacheName, cacheKey) {
  try {
    const res = await fetch(request);
    if (res.ok && !res.redirected) {
      const copy = res.clone();
      caches.open(cacheName).then((c) => c.put(cacheKey || request, copy)).catch(() => {});
    }
    return res;
  } catch (err) {
    const hit = await caches.match(cacheKey || request);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  const p = url.pathname;

  if (p.startsWith("/stream/") || p.startsWith("/cover/")) {
    e.respondWith((async () => {
      const cache = await caches.open(OFFLINE);
      const hit = await cache.match(p);
      if (hit) return p.startsWith("/stream/") ? rangeResponse(hit, e.request) : hit;
      return fetch(e.request);
    })());
    return;
  }
  if (p === "/library" || p.startsWith("/resolve/")) {
    e.respondWith(networkFirst(e.request, CACHE, p));
    return;
  }
  // never cached: admin calls, login, APK, anything with side effects
  if (
    p === "/unknown" || p === "/login" || p === "/logout" || p === "/enroll" || p === "/rename" ||
    p === "/status" || p === "/health" || p === "/version" || p === "/backup" ||
    p.startsWith("/storie.apk") || p.startsWith("/box/") || p.startsWith("/coin") ||
    p.startsWith("/story/") || p.startsWith("/settings/")
  ) {
    return;
  }
  // App shell: network-first, cache fallback offline.
  e.respondWith(networkFirst(e.request, CACHE));
});

// Messages from the page: download / remove a story for offline use, list what is cached.
self.addEventListener("message", (e) => {
  const { type, uid } = e.data || {};
  const reply = (msg) => { if (e.ports && e.ports[0]) e.ports[0].postMessage(msg); };
  (async () => {
    const cache = await caches.open(OFFLINE);
    if (type === "offline-list") {
      const keys = await cache.keys();
      const uids = keys.map((r) => new URL(r.url).pathname).filter((x) => x.startsWith("/stream/")).map((x) => x.slice(8));
      reply({ uids });
    } else if (type === "offline-add") {
      try {
        const res = await fetch(`/stream/${uid}`, { credentials: "same-origin" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        await cache.put(`/stream/${uid}`, res);
        try {
          const cov = await fetch(`/cover/${uid}`, { credentials: "same-origin" });
          if (cov.ok) await cache.put(`/cover/${uid}`, cov);
        } catch (_) { /* cover optional */ }
        reply({ ok: true, uid });
      } catch (err) {
        reply({ ok: false, uid, error: String(err) });
      }
    } else if (type === "offline-remove") {
      await cache.delete(`/stream/${uid}`);
      await cache.delete(`/cover/${uid}`);
      reply({ ok: true, uid });
    }
  })();
});
