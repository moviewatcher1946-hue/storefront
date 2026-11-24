/* Service worker: makes the shop open and browse offline and stops re-downloading things that have not changed.
   Bump VERSION when you change this file so old caches are cleaned up.

   What is cached, and how
   - the page (/)              network first (so updates arrive), saved copy when offline
   - logos / icons / fonts     show the saved copy instantly, refresh it in the background
   - product photos            saved for good: their URL changes (?v=) whenever a product is edited
   - catalogue (/api/bootstrap, /api/products/:id)
                               network first (3 s), saved copy when offline or slow; kept separately per signed-in person
   - everything else (orders, checkout, admin writes, sign-in)  never cached */
const VERSION = "v2";
const SHELL = "shell-" + VERSION, ASSETS = "assets-" + VERSION, API = "api-" + VERSION;
const KEEP = [SHELL, ASSETS, API];
const SHELL_URLS = ["/", "/brand/emblem.png", "/brand/wide.png", "/gcash-qr.svg", "/cod.svg"];
const LIMITS = { [ASSETS]: 160, [API]: 40 };
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => Promise.all(SHELL_URLS.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => !KEEP.includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

/* the page tells us when someone signs in or out, so a saved catalogue never outlives its owner */
self.addEventListener("message", e => {
  if (e.data && e.data.type === "clear-private") e.waitUntil(caches.delete(API));
});

const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
const trim = async name => {
  const max = LIMITS[name]; if (!max) return;
  const c = await caches.open(name), ks = await c.keys();
  await Promise.all(ks.slice(0, Math.max(0, ks.length - max)).map(k => c.delete(k)));
};
const put = async (name, req, res) => {
  if (!res || !res.ok) return res;
  const c = await caches.open(name);
  await c.put(req, res.clone());
  trim(name);
  return res;
};
const timeout = (p, ms) => new Promise((ok, no) => { const t = setTimeout(() => no(new Error("timeout")), ms); p.then(v => { clearTimeout(t); ok(v); }, e => { clearTimeout(t); no(e); }); });

/* network first; fall back to the saved copy when offline or slower than `ms` */
async function networkFirst(e, key, name, ms) {
  const c = await caches.open(name), saved = await c.match(key);
  const net = fetch(e.request).then(res => put(name, key, res));
  try { return await timeout(net, saved ? ms : 20000); }
  catch (err) {
    if (saved) { e.waitUntil(net.catch(() => {})); return saved; }
    return net; /* nothing saved: let the real error through */
  }
}

/* show the saved copy now, refresh it in the background */
async function staleWhileRevalidate(e, name) {
  const c = await caches.open(name), saved = await c.match(e.request);
  const net = fetch(e.request).then(async res => { if (res.ok || res.type === "opaque") { await c.put(e.request, res.clone()); trim(name); } return res; });
  if (saved) { e.waitUntil(net.catch(() => {})); return saved; }
  return net;
}

/* saved for good */
async function cacheFirst(e, name) {
  const c = await caches.open(name), saved = await c.match(e.request);
  if (saved) return saved;
  const res = await fetch(e.request);
  if (res.ok) { await c.put(e.request, res.clone()); trim(name); }
  return res;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin !== location.origin) {
    if (FONT_HOSTS.includes(url.hostname)) e.respondWith(staleWhileRevalidate(e, ASSETS));
    return;
  }

  /* the page itself */
  if (req.mode === "navigate") {
    e.respondWith((async () => {
      const c = await caches.open(SHELL);
      try { const res = await timeout(fetch(req), 4000); if (res.ok) c.put("/", res.clone()); return res; }
      catch { return (await c.match("/")) || new Response("You are offline.", { status: 503, headers: { "Content-Type": "text/plain" } }); }
    })());
    return;
  }

  if (url.pathname === "/sw.js") return;

  if (url.pathname.startsWith("/api/")) {
    if (url.pathname.startsWith("/api/img/")) return e.respondWith(cacheFirst(e, ASSETS));
    if (url.pathname.startsWith("/api/geo/")) return e.respondWith(staleWhileRevalidate(e, API));
    if (url.pathname === "/api/bootstrap" || /^\/api\/products\/\d+$/.test(url.pathname)) {
      /* one saved copy per signed-in person (or per anonymous visitor) so nobody sees someone else's data */
      const key = new Request(url.origin + url.pathname + "?__u=" + hash(req.headers.get("authorization") || "anon"));
      return e.respondWith(networkFirst(e, key, API, 3000));
    }
    return; /* orders, auth, admin: always live */
  }

  e.respondWith(staleWhileRevalidate(e, ASSETS));
});
