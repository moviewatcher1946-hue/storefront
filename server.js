const express = require("express"), crypto = require("crypto"), path = require("path"), pg = require("pg");
let compression = null; try { compression = require("compression"); } catch {}
pg.types.setTypeParser(1700, parseFloat);

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL, max: 5,
  ssl: /\.render\.com/.test(process.env.DATABASE_URL || "") ? { rejectUnauthorized: false } : false
});
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const GID = process.env.GOOGLE_CLIENT_ID || "";
const ADMINS = (process.env.ADMIN_EMAILS || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
const PAY = { delivery: ["GCash QR", "Maya", "Cash on Delivery", "Credit/Debit Card"], pickup: ["GCash QR", "Maya", "Pay at Pickup", "Credit/Debit Card"] };
const ST = { delivery: ["Awaiting payment", "Pending", "Packed", "Out for delivery", "Delivered", "Cancelled"], pickup: ["Awaiting payment", "Pending", "Packed", "Ready for pickup", "Picked up", "Cancelled"] };

/* helpers */
const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });
const str = (s, n) => String(s ?? "").trim().slice(0, n);
const num = x => Math.max(0, Math.round((+x || 0) * 100) / 100);
const int = x => Math.max(0, Math.floor(+x || 0));
const arr = a => Array.isArray(a) ? a.map(x => str(x, 40)).filter(Boolean).slice(0, 20) : [];
const slug = x => str(x, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const sn = x => Math.round((+x || 0) * 100) / 100; /* signed money, used for price modifiers */
const IMG = (x, what) => {
  const t = String(x || ""); if (t.length > 1.5e6) throw bad(what + " is too large");
  /* these values end up inside src="..." on the storefront, so only accept real image sources */
  if (t && !/^(data:image\/(png|jpe?g|webp|gif|avif);base64,[A-Za-z0-9+\/=]+$|https?:\/\/[^\s"'<>]+$|\/(?!\/)[^\s"'<>]*$)/i.test(t)) throw bad(what + " must be an image");
  return t;
};
/* Images are stored as data URLs in the database but never sent inside JSON: lists and details carry short URLs
   (/api/img/p/:id/...?v=rev) that the browser and the service worker cache for a year. "@data" is what the light SQL below
   puts in place of the real bytes so they never leave the database for list requests. */
const isData = x => x === "@data" || /^data:/i.test(String(x || ""));
const IU = (id, rev, tail, x) => !x ? "" : isData(x) ? `/api/img/p/${id}/${tail}?v=${rev || 0}` : x;
const OWN = /^\/api\/img\/p\/(\d+)\/(?:main|v\/([^/?]+)|g\/(\d+)|s\/([^/?]+))(?:\?.*)?$/;
/* when the admin page sends our own image URL back, put the stored image back instead of saving the URL */
function keepOwn(x, row) {
  const t = String(x || ""), m = OWN.exec(t); if (!m) return t;
  if (!row || +m[1] !== row.id) return "";
  if (m[2] != null) { const v = VR(row).find(y => y.id === decodeURIComponent(m[2])); return v ? v.imageUrl || "" : ""; }
  if (m[3] != null) return (row.gallery || [])[+m[3]] || "";
  if (m[4] != null) return (row.size_images || {})[decodeURIComponent(m[4])] || "";
  return row.img || "";
}
const LIGHT = gal => `p.id,p.name,p.price,p.was,p.cat,p.stock,p.vars,p.sizes,p.descr,p.arch,p.rev,p.created,
  case when p.img like 'data:%' then '@data' else p.img end as img,
  (select coalesce(jsonb_agg(case when v->>'imageUrl' like 'data:%' then jsonb_set(v,'{imageUrl}','"@data"') else v end order by o),'[]'::jsonb) from jsonb_array_elements(p.variations) with ordinality as t(v,o)) as variations,
  (select coalesce(jsonb_object_agg(k, case when val like 'data:%' then '@data' else val end),'{}'::jsonb) from jsonb_each_text(p.size_images) as t3(k,val)) as size_images,
  ${gal ? `(select coalesce(jsonb_agg(case when g like 'data:%' then '@data' else g end order by o),'[]'::jsonb) from jsonb_array_elements_text(p.gallery) with ordinality as t2(g,o)) as gallery` : `'[]'::jsonb as gallery`}`;
/* an optional photo for each size, e.g. { "M": "data:image/..." } */
const cleanSizeImages = o => { const out = {}; for (const [k, x] of Object.entries(o || {}).slice(0, 20)) { const key = str(k, 40), img = IMG(x, "Size photo"); if (key && img) out[key] = img; } return out; };
const sizeImgsFrom = (raw, row, sizes) => Object.fromEntries(Object.entries(cleanSizeImages(Object.fromEntries(Object.entries(raw && typeof raw == "object" && !Array.isArray(raw) ? raw : {}).map(([k, x]) => [k, keepOwn(x, row)])))).filter(([k]) => sizes.includes(k)));
const sizeList = a => [...new Set(arr(a))]; /* no duplicate size buttons */
/* Variation = { id, name, colorHex, imageUrl, priceModifier, stockCount (null = not tracked per variation) } */
const cleanVars = a => {
  if (!Array.isArray(a)) throw bad("Bad variations");
  const seen = new Set();
  return a.slice(0, 30).map((v, i) => {
    const name = str(v && v.name, 40); if (!name) throw bad("Every variation needs a name");
    let id = slug(v.id) || slug(name) || "v" + i; while (seen.has(id)) id = slug(id + "-" + i) + i; seen.add(id);
    return { id, name, colorHex: /^#[0-9a-f]{6}$/i.test(v.colorHex) ? v.colorHex : "", imageUrl: IMG(v.imageUrl, "Variation image"), priceModifier: sn(v.priceModifier), stockCount: v.stockCount == null || v.stockCount === "" ? null : int(v.stockCount) };
  });
};
/* products saved before variations existed only have the plain-text `vars` list; expose those as variations too */
const VR = r => Array.isArray(r.variations) && r.variations.length ? r.variations : (r.vars || []).map(n => ({ id: slug(n) || n, name: n, colorHex: "", imageUrl: "", priceModifier: 0, stockCount: null }));
/* put cancelled quantities back, per product and (when tracked) per variation */
async function restock(c, items) {
  for (const it of [...items].sort((a, b) => a.id - b.id)) {
    const p = (await c.query("select variations from products where id=$1 for update", [it.id])).rows[0]; if (!p) continue;
    const vs = Array.isArray(p.variations) ? p.variations : [], hit = it.vid && vs.some(x => x.id === it.vid && x.stockCount != null);
    await c.query("update products set stock=stock+$2" + (hit ? ",variations=$3" : "") + " where id=$1",
      hit ? [it.id, it.n, JSON.stringify(vs.map(x => x.id === it.vid && x.stockCount != null ? { ...x, stockCount: x.stockCount + it.n } : x))] : [it.id, it.n]);
  }
}
const eq = (a, b) => crypto.timingSafeEqual(crypto.createHash("sha256").update(a).digest(), crypto.createHash("sha256").update(b).digest());
const wrap = f => (q, s, n) => f(q, s, n).catch(n);

/* tokens */
const b64 = b => Buffer.from(b).toString("base64url"), sig = s => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");
const mk = id => { const p = b64(JSON.stringify({ id, exp: Date.now() + 30 * 864e5 })); return p + "." + sig(p); };
function vf(t) {
  const [p, s] = (t || "").split("."); if (!p || !s) return 0;
  const a = Buffer.from(s), b = Buffer.from(sig(p));
  if (a.length != b.length || !crypto.timingSafeEqual(a, b)) return 0;
  try { const o = JSON.parse(Buffer.from(p, "base64url")); return o.exp > Date.now() ? o.id : 0; } catch { return 0; }
}
const who = async q => {
  const id = vf((q.headers.authorization || "").slice(7)); if (!id) return null;
  const u = (await db.query("select id,name,email from users where id=$1", [id])).rows[0];
  if (!u) return null;
  u.role = u.email && ADMINS.includes(u.email.toLowerCase()) ? "admin" : "customer";
  return u;
};
const need = admin => wrap(async (q, s, n) => {
  q.u = await who(q);
  if (!q.u) throw bad("Please sign in", 401);
  if (admin && q.u.role != "admin") throw bad("Admins only", 403);
  n();
});

/* tiny rate limit */
const hits = new Map(); setInterval(() => hits.clear(), 60e3).unref();
const lim = n => (q, s, x) => { const k = n + q.ip, c = (hits.get(k) || 0) + 1; hits.set(k, c); c > n ? s.status(429).json({ error: "Too many requests, slow down" }) : x(); };

/* mappers */
/* Catalog lists leave out the big variation/gallery images (full=false); GET /api/products/:id sends them (full=true). */
const P = (r, full) => {
  const vs = VR(r), sizes = Array.isArray(r.sizes) ? r.sizes : [];
  return {
    id: r.id, name: r.name, title: r.name, price: r.price, basePrice: r.price, was: r.was, cat: r.cat, stock: r.stock,
    vars: vs.map(v => v.name),
    variations: vs.map(({ imageUrl, ...v }) => ({ ...v, imageUrl: IU(r.id, r.rev, "v/" + encodeURIComponent(v.id), imageUrl), hasImage: !!imageUrl })),
    sizes, hasSizes: sizes.length > 0, availableSizes: sizes.length ? sizes : null,
    sizeImages: Object.fromEntries(Object.entries(r.size_images || {}).filter(([k, x]) => x && sizes.includes(k)).map(([k, x]) => [k, IU(r.id, r.rev, "s/" + encodeURIComponent(k), x)])),
    img: IU(r.id, r.rev, "main", r.img), gallery: full ? (r.gallery || []).map((x, i) => IU(r.id, r.rev, "g/" + i, x)) : undefined,
    desc: r.descr, description: r.descr, arch: r.arch, favs: r.favs, sold: r.sold
  };
};
const SA = a => a && { street: a.street || "", barangay: a.brgy || "", city: a.city || "", province: a.prov || a.region || "", region: a.region || "", postalCode: a.zip || "", country: a.country || "Philippines" };
const O = r => ({ id: r.id, name: r.name, phone: r.phone, method: r.method, addr: r.addr, shippingAddress: SA(r.addr), pickup: r.pickup_at, pay: r.pay, paymentMethod: r.pay, note: r.note, items: r.items, subtotal: r.subtotal, fee: r.fee, total: r.total, status: r.status, orderStatus: r.status, created: r.created });
const site = async () => (await db.query("select v from settings where k='site'")).rows[0]?.v || {};
/* Philippine locations from the official PSGC list, cached in memory */
const GEO = new Map();
function geo(p) {
  if (!GEO.has(p)) {
    if (GEO.size >= 500) GEO.clear(); /* bounded: random codes from visitors can not grow memory forever */
    const pr = fetch("https://psgc.gitlab.io/api" + p, { signal: AbortSignal.timeout(8000) })
      .then(r => { if (!r.ok) throw new Error("PSGC " + r.status); return r.json(); })
      .catch(() => { GEO.delete(p); throw bad("Location list unavailable, try again shortly", 502); });
    GEO.set(p, pr);
  }
  return GEO.get(p);
}
const pick = list => (list || []).map(x => ({ code: x.code, name: x.regionName || x.name }));
/* Delivery area: Oriental Mindoro (MIMAROPA). The delivery fee is set per municipality in the admin (settings.townFees).
   Nothing here needs the PSGC website, so checkout keeps working when it is slow or down.
   lat/lng are approximate town centres, only used for the map's "nearest town" hint. */
const AREA = {
  region: "MIMAROPA Region", province: "Oriental Mindoro", bounds: [[12.2, 120.8], [13.7, 121.7]],
  towns: [["Baco", 13.3583, 121.0969], ["Bansud", 12.8683, 121.4500], ["Bongabong", 12.7456, 121.4881], ["Bulalacao", 12.3306, 121.3414], ["Calapan City", 13.4117, 121.1803],
    ["Gloria", 12.9769, 121.4778], ["Mansalay", 12.5222, 121.4381], ["Naujan", 13.3217, 121.3044], ["Pinamalayan", 13.0319, 121.4817], ["Pola", 13.1583, 121.4333],
    ["Puerto Galera", 13.5028, 120.9547], ["Roxas", 12.5953, 121.5272], ["San Teodoro", 13.4419, 121.0300], ["Socorro", 13.0583, 121.4167], ["Victoria", 13.1800, 121.2800]].map(([name, lat, lng]) => ({ name, lat, lng }))
};
/* "City of Calapan", "Calapan City" and "calapan" are the same town */
const normTown = x => String(x || "").toLowerCase().replace(/\(.*?\)|\bcity of\b|\bmunicipality of\b|\bcity\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
const townOf = x => AREA.towns.find(t => normTown(t.name) === normTown(x));
const coord = v => /^-?\d{1,3}(\.\d{1,7})?$/.test(String(v || "")) ? String(v) : "";

/* admin settings: whitelist the keys the storefront uses and check every value, so nothing unchecked reaches the shop page */
const HEXC = /^#[0-9a-f]{6}$/i;
const TEXT = { name: 80, tagline: 120, headline: 160, footer: 300, terms: 20000, privacy: 20000, supportPhone: 40, supportEmail: 120, supportHours: 120 };
const plainObj = (o, n) => { const out = {}; if (!o || typeof o != "object" || Array.isArray(o)) return out;
  for (const [k, v] of Object.entries(o).slice(0, 20)) { const key = str(k, 40); if (!key) continue; if (typeof v == "number") out[key] = num(v); else if (typeof v == "string") out[key] = str(v, n); } return out; };
function cleanSettings(b) {
  const out = {};
  for (const [k, n] of Object.entries(TEXT)) if (b[k] != null) out[k] = str(b[k], n);
  for (const k of ["logo", "logoWide", "logoClear", "banner"]) if (b[k]) out[k] = IMG(b[k], "Image");
  if (Array.isArray(b.promos)) out.promos = b.promos.slice(0, 3).map(p => { const x = p && typeof p == "object" ? p : {}; return { t: str(x.t, 80), s: str(x.s, 160), img: x.img ? IMG(x.img, "Tile image") : "" }; });
  if (b.pickup && typeof b.pickup == "object") out.pickup = plainObj(b.pickup, 300);
  if (b.col && typeof b.col == "object" && !Array.isArray(b.col)) { out.col = {}; for (const [k, v] of Object.entries(b.col).slice(0, 10)) if (/^--[a-z-]{1,30}$/.test(k) && HEXC.test(String(v))) out.col[k] = v; }
  if (b.townFees && typeof b.townFees == "object" && !Array.isArray(b.townFees)) { out.townFees = {}; for (const [t, f] of Object.entries(b.townFees).slice(0, 40)) { const tw = townOf(t); if (tw) out.townFees[tw.name] = num(f); } }
  if (b.defaultFee != null) out.defaultFee = num(b.defaultFee);
  out.mapFull = !!b.mapFull; /* false = map limited to Oriental Mindoro */
  return out;
}

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((q, s, n) => { s.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "strict-origin-when-cross-origin" }); n(); });
if (compression) app.use(compression());
app.use(express.json({ limit: "12mb" }));
/* product images: far-future caching (the ?v= revision changes whenever the product is edited). Before the rate limiter on purpose:
   one page can show dozens of images. */
function sendImg(s, v) {
  v = String(v || ""); if (!v) throw bad("No image", 404);
  const i = v.indexOf(";base64,");
  if (/^data:image\//i.test(v) && i > 0) return s.set({ "Content-Type": v.slice(5, i), "Cache-Control": "public, max-age=31536000, immutable", "Content-Security-Policy": "default-src 'none'; sandbox" }).send(Buffer.from(v.slice(i + 8), "base64"));
  if (/^(https?:\/\/|\/(?!\/))/.test(v)) return s.set("Cache-Control", "public, max-age=3600").redirect(302, v);
  throw bad("No image", 404);
}
const imgRow = (cols, id) => db.query(`select ${cols} from products where id=$1`, [id | 0]).then(r => r.rows[0] || (() => { throw bad("No image", 404); })());
app.get("/api/img/p/:id/main", wrap(async (q, s) => sendImg(s, (await imgRow("img", q.params.id)).img)));
app.get("/api/img/p/:id/v/:vid", wrap(async (q, s) => { const r = await imgRow("variations,vars", q.params.id), v = VR(r).find(x => x.id === q.params.vid); sendImg(s, v && v.imageUrl); }));
app.get("/api/img/p/:id/s/:size", wrap(async (q, s) => sendImg(s, (await imgRow("size_images", q.params.id)).size_images[q.params.size])));
app.get("/api/img/p/:id/g/:i", wrap(async (q, s) => sendImg(s, ((await imgRow("gallery", q.params.id)).gallery || [])[q.params.i | 0])));
app.use("/api", lim(300));
app.get("/healthz", (q, s) => s.send("ok"));

/* public data */
app.get("/api/bootstrap", wrap(async (q, s) => {
  const u = await who(q), st = await site(), adm = u && u.role == "admin";
  await db.query("insert into settings(k,v) values('views','1') on conflict(k) do update set v=to_jsonb((settings.v#>>'{}')::int+1)");
  const pr = await db.query("select " + LIGHT(adm) + ", (select count(*) from favorites f where f.product_id=p.id)::int as favs, coalesce((select sum((i->>'n')::int) from orders o, jsonb_array_elements(o.items) i where o.status<>'Cancelled' and (i->>'id')::int=p.id),0)::int as sold from products p " + (adm ? "" : "where not p.arch ") + "order by p.id desc");
  const brand = { logo: "/brand/emblem.png", logoClear: "/brand/emblem.png", logoWide: "/brand/wide.png" };
  const out = { set: { ...brand, ...st }, fees: st.fees || {}, defaultFee: st.defaultFee ?? 100, area: AREA, gid: GID, user: u && { name: u.name, role: u.role }, prods: pr.rows.map(r => P(r, adm)) };
  if (u) out.favs = (await db.query("select product_id from favorites where user_id=$1", [u.id])).rows.map(r => r.product_id);
  if (adm) out.views = (await db.query("select v from settings where k='views'")).rows[0]?.v;
  s.set({ "Cache-Control": "private, no-cache", Vary: "Authorization" }).json(out); /* ETag + no-cache = the browser asks, the server answers 304 when nothing changed */
}));

app.get("/api/products/:id", wrap(async (q, s) => {
  const u = await who(q), adm = u && u.role == "admin";
  const r = (await db.query("select " + LIGHT(1) + ", (select count(*) from favorites f where f.product_id=p.id)::int as favs from products p where p.id=$1 " + (adm ? "" : "and not p.arch"), [q.params.id | 0])).rows[0];
  if (!r) throw bad("Product not found", 404);
  s.set({ "Cache-Control": "private, no-cache", Vary: "Authorization" }).json(P(r, true));
}));

/* auth */
const done = (s, u) => s.json({ token: mk(u.id), user: { name: u.name, role: u.role } });
app.post("/api/auth/google", lim(20), wrap(async (q, s) => {
  if (!GID) throw bad("Google sign-in is not set up");
  const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(q.body.credential || ""), { signal: AbortSignal.timeout(8000) }), t = await r.json().catch(() => ({}));
  if (!r.ok || t.aud !== GID || !t.email || (t.email_verified !== "true" && t.email_verified !== true)) throw bad("Google sign-in failed", 401);
  const em = String(t.email).toLowerCase(), role = ADMINS.includes(em) ? "admin" : "customer";
  const u = (await db.query(
    "insert into users(name,email,role) values($1,$2,$3) on conflict(email) do update set name=excluded.name, role=excluded.role returning id,name,role",
    [str(t.name || em, 60), em, role])).rows[0];
  done(s, u);
}));

/* admin: settings + products */
app.put("/api/admin/settings", need(1), wrap(async (q, s) => {
  const b = q.body; if (!b || typeof b != "object" || Array.isArray(b)) throw bad("Bad settings");
  await db.query("insert into settings(k,v) values('site',$1) on conflict(k) do update set v=excluded.v", [JSON.stringify(cleanSettings(b))]);
  s.json({ ok: 1 });
}));
app.post("/api/admin/products", need(1), wrap(async (q, s) => {
  const b = q.body; if (!str(b.name, 120) || !num(b.price)) throw bad("Name and price required");
  const vars = cleanVars(Array.isArray(b.variations) ? b.variations.map(v => v && typeof v == "object" ? { ...v, imageUrl: keepOwn(v.imageUrl, null) } : v) : arr(b.vars).map(name => ({ name }))), names = vars.map(v => v.name);
  const gal = (Array.isArray(b.gallery) ? b.gallery : []).slice(0, 8).map(x => IMG(keepOwn(x, null), "Gallery image")).filter(Boolean), szs = sizeList(b.sizes);
  const r = await db.query("insert into products(name,price,was,cat,stock,vars,img,sizes,variations,descr,gallery,size_images) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *",
    [str(b.name, 120), num(b.price), num(b.was), str(b.cat, 60), int(b.stock), JSON.stringify(names), IMG(keepOwn(b.img, null), "Image"), JSON.stringify(sizeList(b.sizes)), JSON.stringify(vars), str(b.desc, 2000), JSON.stringify(gal), JSON.stringify(sizeImgsFrom(b.sizeImages, null, szs))]);
  s.json(P(r.rows[0], true));
}));
const F = { size_images: v => JSON.stringify(v && typeof v == "object" && !Array.isArray(v) ? cleanSizeImages(v) : {}), name: v => str(v, 120), price: num, was: num, cat: v => str(v, 60), stock: int, vars: v => JSON.stringify(arr(v)), img: v => IMG(v, "Image"), arch: v => !!v, descr: v => str(v, 2000), sizes: v => JSON.stringify(sizeList(v)), variations: v => JSON.stringify(cleanVars(v)), gallery: v => JSON.stringify((Array.isArray(v) ? v : []).slice(0, 8).map(x => IMG(x, "Gallery image")).filter(Boolean)) };
app.patch("/api/admin/products/:id", need(1), wrap(async (q, s) => {
  const b = { ...q.body }; if ("desc" in b) b.descr = b.desc;
  if (["img", "variations", "gallery", "sizeImages", "sizes"].some(k => k in b)) {
    const row = (await db.query("select id,img,variations,vars,gallery,sizes,size_images from products where id=$1", [q.params.id | 0])).rows[0]; if (!row) throw bad("Not found", 404);
    if ("img" in b) b.img = keepOwn(b.img, row);
    if ("variations" in b) b.variations = (Array.isArray(b.variations) ? b.variations : []).map(v => v && typeof v == "object" ? { ...v, imageUrl: keepOwn(v.imageUrl, row) } : v);
    if ("gallery" in b) b.gallery = (Array.isArray(b.gallery) ? b.gallery : []).map(x => keepOwn(x, row));
    if ("sizeImages" in b || "sizes" in b) /* a size that is removed loses its photo */
      b.size_images = sizeImgsFrom("sizeImages" in b ? b.sizeImages : row.size_images, row, "sizes" in b ? sizeList(b.sizes) : Array.isArray(row.sizes) ? row.sizes : []);
  }
  if ("variations" in b) b.vars = cleanVars(b.variations).map(v => v.name); /* keep the legacy name list in step */
  const ks = Object.keys(F).filter(k => k in b); if (!ks.length) throw bad("Nothing to change");
  const r = await db.query(`update products set ${ks.map((k, i) => k + "=$" + (i + 2)).join(",")}, rev=rev+1 where id=$1 returning *`, [q.params.id | 0, ...ks.map(k => F[k](b[k]))]);
  if (!r.rows[0]) throw bad("Not found", 404);
  s.json(P(r.rows[0], true));
}));
app.delete("/api/admin/products/:id", need(1), wrap(async (q, s) => {
  await db.query("delete from products where id=$1", [q.params.id | 0]); s.json({ ok: 1 });
}));

/* favorites */
app.post("/api/favorites/:id", need(), wrap(async (q, s) => {
  const id = q.params.id | 0;
  const p = await db.query("select 1 from products where id=$1", [id]);
  if (!p.rows[0]) throw bad("Not found", 404);
  await db.query("insert into favorites(user_id,product_id) values($1,$2) on conflict do nothing", [q.u.id, id]);
  s.json({ ok: 1 });
}));
app.delete("/api/favorites/:id", need(), wrap(async (q, s) => {
  await db.query("delete from favorites where user_id=$1 and product_id=$2", [q.u.id, q.params.id | 0]);
  s.json({ ok: 1 });
}));

/* orders */
app.post("/api/orders", lim(30), need(), wrap(async (q, s) => {
  const b = q.body || {}, m = b.method == "pickup" ? "pickup" : "delivery";
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 50) throw bad("Your cart is empty");
  const name = str(b.name, 80), phone = str(b.phone, 20);
  if (name.length < 2) throw bad("Enter your full name");
  if (!/^[0-9+\-\s()]{7,20}$/.test(phone)) throw bad("Enter a valid mobile number");
  if (!PAY[m].includes(b.pay)) throw bad("Choose a payment method");
  let addr = null, pickup = "", fee = 0;
  if (m == "delivery") {
    const a = b.addr || {};
    const town = townOf(str(a.city, 60));
    if (!town) throw bad("Choose your municipality in " + AREA.province);
    if (!str(a.brgy, 80) || !str(a.street, 120)) throw bad("Complete your delivery address");
    const st = await site();
    fee = num((st.townFees || {})[town.name] ?? st.defaultFee ?? 100);
    addr = { region: AREA.region, prov: AREA.province, city: town.name, brgy: str(a.brgy, 80), street: str(a.street, 120), zip: str(a.zip, 10), country: "Philippines", lat: coord(a.lat), lng: coord(a.lng) };
  } else {
    pickup = str(b.pickup, 60); if (!pickup) throw bad("Choose a pickup time");
  }
  const c = await db.connect();
  try {
    await c.query("begin");
    const items = [...b.items].sort((x, y) => ((x && x.id) | 0) - ((y && y.id) | 0)); let sub = 0; const lines = [];
    for (const it of items) {
      if (!it || typeof it != "object") throw bad("Bad item");
      const id = it.id | 0, n = Math.min(99, int(it.n)); if (!n) throw bad("Bad quantity");
      const p = (await c.query("select name,price,stock,arch,vars,variations,sizes from products where id=$1 for update", [id])).rows[0];
      if (!p || p.arch) throw bad("An item in your cart is no longer available");
      if (p.stock < n) throw bad(p.name + " is sold out or has too little stock");
      const vs = VR(p), sizes = Array.isArray(p.sizes) ? p.sizes : [];
      let v = null, size = "";
      if (vs.length) { /* accepts the variation id (new) or its name (carts saved before this change) */
        const key = str(it.vid ?? it.v, 40); v = vs.find(x => x.id === key || x.name === key);
        if (!v) throw bad("Pick a valid option for " + p.name);
        if (v.stockCount != null && v.stockCount < n) throw bad(p.name + " (" + v.name + ") is sold out or has too little stock");
      }
      if (sizes.length) { size = str(it.size, 40); if (!sizes.includes(size)) throw bad("Pick a size for " + p.name); }
      const upd = v && v.stockCount != null ? vs.map(x => x === v ? { ...x, stockCount: x.stockCount - n } : x) : null;
      await c.query("update products set stock=stock-$2" + (upd ? ",variations=$3" : "") + " where id=$1", upd ? [id, n, JSON.stringify(upd)] : [id, n]);
      const rawPrice = Number(p.price) + (v ? v.priceModifier : 0); /* price always comes from the database, never from the browser */
      if (rawPrice < 0) throw bad(p.name + " has an invalid option price");
      const price = num(rawPrice);
      lines.push({ id, name: p.name, v: v ? v.name : "", vid: v ? v.id : "", size, n, price }); sub += price * n;
    }
    sub = num(sub);
    const r = await c.query(
      "insert into orders(user_id,name,phone,method,addr,pickup_at,pay,note,items,subtotal,fee,total,status) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *",
      [q.u.id, name, phone, m, addr && JSON.stringify(addr), pickup, b.pay, str(b.note, 300), JSON.stringify(lines), sub, fee, sub + fee, /^(Cash on Delivery|Pay at Pickup)$/.test(b.pay) ? "Pending" : "Awaiting payment"]);
    await c.query("commit");
    s.json(O(r.rows[0]));
  } catch (e) { await c.query("rollback").catch(() => {}); throw e; }
  finally { c.release(); }
}));
app.get("/api/orders", need(), wrap(async (q, s) => {
  const r = q.u.role == "admin" && q.query.all == "1" /* the Admin panel asks for everything; "Your orders" is always just your own */
    ? await db.query("select * from orders order by id desc limit 500")
    : await db.query("select * from orders where user_id=$1 order by id desc limit 100", [q.u.id]);
  s.json(r.rows.map(O));
}));
app.patch("/api/admin/orders/:id", need(1), wrap(async (q, s) => {
  const c = await db.connect();
  try {
    await c.query("begin");
    const o = (await c.query("select * from orders where id=$1 for update", [q.params.id | 0])).rows[0];
    if (!o) throw bad("Not found", 404);
    const st = q.body.status; if (!ST[o.method].includes(st)) throw bad("Bad status");
    if (o.status == "Cancelled" && st != "Cancelled") throw bad("Cancelled orders can't be reopened");
    if (st == "Cancelled" && o.status != "Cancelled") await restock(c, o.items);
    const r = await c.query("update orders set status=$2 where id=$1 returning *", [o.id, st]);
    await c.query("commit");
    s.json(O(r.rows[0]));
  } catch (e) { await c.query("rollback").catch(() => {}); throw e; }
  finally { c.release(); }
}));

app.post("/api/orders/:id/cancel", need(), wrap(async (q, s) => {
  const c = await db.connect();
  try {
    await c.query("begin");
    const o = (await c.query("select * from orders where id=$1 and user_id=$2 for update", [q.params.id | 0, q.u.id])).rows[0];
    if (!o) throw bad("Not found", 404);
    if (!["Awaiting payment", "Pending"].includes(o.status)) throw bad("This order can no longer be cancelled. Please contact the shop.");
    await restock(c, o.items);
    const r = await c.query("update orders set status='Cancelled' where id=$1 returning *", [o.id]);
    await c.query("commit");
    s.json(O(r.rows[0]));
  } catch (e) { await c.query("rollback").catch(() => {}); throw e; }
  finally { c.release(); }
}));

/* customer support: anyone can send a message (signed in or not); only the admin reads them */
const TOPICS = ["Order or delivery", "Payment", "Product question", "Returns or cancellation", "Other"];
const SUP = r => ({ id: r.id, name: r.name, contact: r.contact, topic: r.topic, message: r.message, status: r.status, created: r.created });
app.post("/api/support", lim(10), wrap(async (q, s) => {
  const u = await who(q), b = q.body || {};
  const name = str(b.name, 80), contact = str(b.contact, 120), topic = str(b.topic, 60), message = str(b.message, 2000);
  if (name.length < 2) throw bad("Enter your name");
  if (contact.length < 5) throw bad("Enter a mobile number or email we can reach you on");
  if (!TOPICS.includes(topic)) throw bad("Choose a topic");
  if (message.length < 10) throw bad("Tell us a little more (at least 10 characters)");
  await db.query("insert into support(user_id,name,contact,topic,message) values($1,$2,$3,$4,$5)", [u ? u.id : null, name, contact, topic, message]);
  s.json({ ok: 1 });
}));
app.get("/api/admin/support", need(1), wrap(async (q, s) => {
  s.json((await db.query("select * from support order by id desc limit 300")).rows.map(SUP));
}));
app.patch("/api/admin/support/:id", need(1), wrap(async (q, s) => {
  const st = q.body && q.body.status; if (!["Open", "Resolved"].includes(st)) throw bad("Bad status");
  const r = await db.query("update support set status=$2 where id=$1 returning *", [q.params.id | 0, st]);
  if (!r.rows[0]) throw bad("Not found", 404);
  s.json(SUP(r.rows[0]));
}));

/* backup (free Render DB is not forever: download this often) */
app.get("/api/admin/export", need(1), wrap(async (q, s) => {
  const out = {
    site: await site(),
    products: (await db.query("select * from products order by id")).rows,
    orders: (await db.query("select * from orders order by id")).rows,
    users: (await db.query("select id,name,email,role,created from users order by id")).rows
  };
  s.set("Content-Disposition", 'attachment; filename="storefront-backup.json"').json(out);
}));

const geoRoute = mk => wrap(async (q, s) => {
  const c = q.params.code;
  if (c !== undefined && !/^\d{1,12}$/.test(c)) throw bad("Bad code");
  const list = pick(await geo(mk(c))); /* only a successful answer may be cached: an error must never be stored for a day */
  s.set("Cache-Control", "public, max-age=86400").json(list);
});
app.get("/api/geo/regions", geoRoute(() => "/regions/"));
app.get("/api/geo/regions/:code/provinces", geoRoute(c => `/regions/${c}/provinces/`));
app.get("/api/geo/regions/:code/cities", geoRoute(c => `/regions/${c}/cities-municipalities/`));
app.get("/api/geo/provinces/:code/cities", geoRoute(c => `/provinces/${c}/cities-municipalities/`));
app.get("/api/geo/cities/:code/barangays", geoRoute(c => `/cities-municipalities/${c}/barangays/`));

/* the page and the service worker always revalidate; logos and icons are cached for a day and refreshed in the background after that */
app.use(express.static(path.join(__dirname, "public"), { setHeaders: (r, p) => {
  const sw = /[\\/]sw\.js$/.test(p);
  r.setHeader("Cache-Control", sw || /\.html$/.test(p) ? "no-cache" : "public, max-age=86400, stale-while-revalidate=604800");
  if (/\.html$/.test(p)) r.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com https://www.gstatic.com https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https://nominatim.openstreetmap.org https://accounts.google.com; frame-src https://accounts.google.com; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  if (sw) r.setHeader("Service-Worker-Allowed", "/");
} }));
app.use((e, q, s, n) => { if (!e.status) console.error(e); s.status(e.status || 500).json({ error: e.status ? e.message : "Server error" }); });

async function init() {
  await db.query(`
    create table if not exists users(id serial primary key, name text not null, email text unique, role text not null default 'customer', created timestamptz default now());
    create table if not exists settings(k text primary key, v jsonb not null);
    create table if not exists products(id serial primary key, name text not null, price numeric(12,2) not null, was numeric(12,2) not null default 0, cat text not null default '', stock int not null default 0, vars jsonb not null default '[]', img text not null default '', descr text not null default '', arch boolean not null default false, created timestamptz default now());
    create table if not exists orders(id serial primary key, user_id int references users(id), name text not null, phone text not null, method text not null, addr jsonb, pickup_at text not null default '', pay text not null, note text not null default '', items jsonb not null, subtotal numeric(12,2) not null, fee numeric(12,2) not null default 0, total numeric(12,2) not null, status text not null default 'Pending', created timestamptz default now());
    create table if not exists favorites(user_id int references users(id) on delete cascade, product_id int references products(id) on delete cascade, created timestamptz default now(), primary key(user_id,product_id));
    alter table products add column if not exists sizes jsonb not null default '[]';
    alter table products add column if not exists variations jsonb not null default '[]';
    alter table products add column if not exists gallery jsonb not null default '[]';
    alter table products add column if not exists rev int not null default 0;
    alter table products add column if not exists size_images jsonb not null default '{}';
    create table if not exists support(id serial primary key, user_id int references users(id) on delete set null, name text not null, contact text not null, topic text not null, message text not null, status text not null default 'Open', created timestamptz default now());
  `);
}
init().then(() => app.listen(process.env.PORT || 3000, () => console.log("storefront up"))).catch(e => { console.error(e); process.exit(1); });
