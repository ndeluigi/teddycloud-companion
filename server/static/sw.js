// Storie service worker — caches the app shell so the UI opens instantly and
// works offline; audio streams and API calls always go to the network.
const CACHE = "storie-shell-v6";
const SHELL = [
  "/static/i18n.js?v=4",
  "/static/app.js?v=4",
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
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // Never cache audio streams, resolves, library, covers or admin calls — always live.
  if (
    url.pathname.startsWith("/stream/") ||
    url.pathname.startsWith("/resolve/") ||
    url.pathname.startsWith("/cover/") ||
    url.pathname === "/library" ||
    url.pathname === "/unknown" ||
    url.pathname === "/login" ||
    url.pathname.startsWith("/storie.apk") ||
    url.pathname === "/version" ||
    url.pathname === "/backup" ||
    url.pathname.startsWith("/box/") ||
    url.pathname.startsWith("/coin") ||
    url.pathname.startsWith("/story/") ||
    url.pathname === "/logout" ||
    url.pathname === "/enroll" ||
    url.pathname === "/rename" ||
    url.pathname === "/status" ||
    url.pathname === "/health"
  ) {
    return; // default browser network handling
  }
  // App shell: network-first (so a redeploy shows up immediately), cache fallback offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // Only cache clean shell responses (never a redirect to /login or an error page).
        if (res.ok && !res.redirected) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
