const express = require("express"), crypto = require("crypto"), path = require("path"), pg = require("pg");
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
const IMG = (x, what) => { const t = String(x || ""); if (t.length > 1.5e6) throw bad(what + " is too large"); return t; };
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
    variations: vs.map(({ imageUrl, ...v }) => full ? { ...v, imageUrl, hasImage: !!imageUrl } : { ...v, hasImage: !!imageUrl }),
    sizes, hasSizes: sizes.length > 0, availableSizes: sizes.length ? sizes : null,
    img: r.img, gallery: full ? r.gallery || [] : undefined,
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
    const pr = fetch("https://psgc.gitlab.io/api" + p)
      .then(r => { if (!r.ok) throw new Error("PSGC " + r.status); return r.json(); })
      .catch(() => { GEO.delete(p); throw bad("Location list unavailable, try again shortly", 502); });
    GEO.set(p, pr);
  }
  return GEO.get(p);
}
const pick = list => (list || []).map(x => ({ code: x.code, name: x.regionName || x.name }));
async function regionFee(code) {
  if (!/^\d{1,12}$/.test(code)) throw bad("Choose a delivery region");
  const r = (await geo("/regions/")).find(x => x.code == code);
  if (!r) throw bad("Choose a delivery region");
  const st = await site();
  return { name: r.regionName || r.name, fee: num((st.fees || {})[code] ?? st.defaultFee ?? 100) };
}

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((q, s, n) => { s.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "strict-origin-when-cross-origin" }); n(); });
app.use(express.json({ limit: "12mb" }));
app.use("/api", lim(300));
app.get("/healthz", (q, s) => s.send("ok"));

/* public data */
app.get("/api/bootstrap", wrap(async (q, s) => {
  const u = await who(q), st = await site(), adm = u && u.role == "admin";
  await db.query("insert into settings(k,v) values('views','1') on conflict(k) do update set v=to_jsonb((settings.v#>>'{}')::int+1)");
  const pr = await db.query("select p.*, (select count(*) from favorites f where f.product_id=p.id)::int as favs, coalesce((select sum((i->>'n')::int) from orders o, jsonb_array_elements(o.items) i where o.status<>'Cancelled' and (i->>'id')::int=p.id),0)::int as sold from products p " + (adm ? "" : "where not p.arch ") + "order by p.id desc");
  const brand = { logo: "/brand/emblem.png", logoClear: "/brand/emblem.png", logoWide: "/brand/wide.png" };
  const out = { set: { ...brand, ...st }, fees: st.fees || {}, defaultFee: st.defaultFee ?? 100, gid: GID, user: u && { name: u.name, role: u.role }, prods: pr.rows.map(r => P(r, adm)) };
  if (u) out.favs = (await db.query("select product_id from favorites where user_id=$1", [u.id])).rows.map(r => r.product_id);
  if (adm) out.views = (await db.query("select v from settings where k='views'")).rows[0]?.v;
  s.json(out);
}));

app.get("/api/products/:id", wrap(async (q, s) => {
  const u = await who(q), adm = u && u.role == "admin";
  const r = (await db.query("select p.*, (select count(*) from favorites f where f.product_id=p.id)::int as favs from products p where p.id=$1 " + (adm ? "" : "and not p.arch"), [q.params.id | 0])).rows[0];
  if (!r) throw bad("Product not found", 404);
  s.set("Cache-Control", "no-store").json(P(r, true));
}));

/* auth */
const done = (s, u) => s.json({ token: mk(u.id), user: { name: u.name, role: u.role } });
app.post("/api/auth/google", lim(20), wrap(async (q, s) => {
  if (!GID) throw bad("Google sign-in is not set up");
  const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(q.body.credential || "")), t = await r.json();
  if (!r.ok || t.aud !== GID || (t.email_verified !== "true" && t.email_verified !== true)) throw bad("Google sign-in failed", 401);
  const em = String(t.email).toLowerCase(), role = ADMINS.includes(em) ? "admin" : "customer";
  const u = (await db.query(
    "insert into users(name,email,role) values($1,$2,$3) on conflict(email) do update set name=excluded.name, role=excluded.role returning id,name,role",
    [str(t.name || em, 60), em, role])).rows[0];
  done(s, u);
}));

/* admin: settings + products */
app.put("/api/admin/settings", need(1), wrap(async (q, s) => {
  const b = q.body; if (!b || typeof b != "object" || Array.isArray(b)) throw bad("Bad settings");
  await db.query("insert into settings(k,v) values('site',$1) on conflict(k) do update set v=excluded.v", [JSON.stringify(b)]);
  s.json({ ok: 1 });
}));
app.post("/api/admin/products", need(1), wrap(async (q, s) => {
  const b = q.body; if (!str(b.name, 120) || !num(b.price)) throw bad("Name and price required");
  const names = arr(b.vars), vars = cleanVars(names.map(name => ({ name })));
  const r = await db.query("insert into products(name,price,was,cat,stock,vars,img,sizes,variations,descr) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *",
    [str(b.name, 120), num(b.price), num(b.was), str(b.cat, 60), int(b.stock), JSON.stringify(names), String(b.img || ""), JSON.stringify(arr(b.sizes)), JSON.stringify(vars), str(b.desc, 2000)]);
  s.json(P(r.rows[0], true));
}));
const F = { name: v => str(v, 120), price: num, was: num, cat: v => str(v, 60), stock: int, vars: v => JSON.stringify(arr(v)), img: v => String(v || ""), arch: v => !!v, descr: v => str(v, 2000), sizes: v => JSON.stringify(arr(v)), variations: v => JSON.stringify(cleanVars(v)), gallery: v => JSON.stringify((Array.isArray(v) ? v : []).slice(0, 8).map(x => IMG(x, "Gallery image")).filter(Boolean)) };
app.patch("/api/admin/products/:id", need(1), wrap(async (q, s) => {
  const b = { ...q.body }; if ("desc" in b) b.descr = b.desc;
  if ("variations" in b) b.vars = cleanVars(b.variations).map(v => v.name); /* keep the legacy name list in step */
  const ks = Object.keys(F).filter(k => k in b); if (!ks.length) throw bad("Nothing to change");
  const r = await db.query(`update products set ${ks.map((k, i) => k + "=$" + (i + 2)).join(",")} where id=$1 returning *`, [q.params.id | 0, ...ks.map(k => F[k](b[k]))]);
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
    const rg = await regionFee(str(a.rc, 12));
    fee = rg.fee;
    if (!str(a.city, 60) || !str(a.brgy, 80) || !str(a.street, 120)) throw bad("Complete your delivery address");
    addr = { region: rg.name, prov: str(a.prov, 60), city: str(a.city, 60), brgy: str(a.brgy, 80), street: str(a.street, 120), zip: str(a.zip, 10), country: "Philippines", lat: str(a.lat, 12), lng: str(a.lng, 12) };
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
      const price = num(p.price + (v ? v.priceModifier : 0)); /* price always comes from the database, never from the browser */
      lines.push({ id, name: p.name, v: v ? v.name : "", vid: v ? v.id : "", size, n, price }); sub += price * n;
    }
    sub = num(sub);
    const r = await c.query(
      "insert into orders(user_id,name,phone,method,addr,pickup_at,pay,note,items,subtotal,fee,total,status) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *",
      [q.u.id, name, phone, m, addr && JSON.stringify(addr), pickup, b.pay, str(b.note, 300), JSON.stringify(lines), sub, fee, sub + fee, /^GCash/.test(b.pay) ? "Awaiting payment" : "Pending"]);
    await c.query("commit");
    s.json(O(r.rows[0]));
  } catch (e) { await c.query("rollback").catch(() => {}); throw e; }
  finally { c.release(); }
}));
app.get("/api/orders", need(), wrap(async (q, s) => {
  const r = q.u.role == "admin"
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
  s.set("Cache-Control", "public, max-age=86400").json(pick(await geo(mk(c))));
});
app.get("/api/geo/regions", geoRoute(() => "/regions/"));
app.get("/api/geo/regions/:code/provinces", geoRoute(c => `/regions/${c}/provinces/`));
app.get("/api/geo/regions/:code/cities", geoRoute(c => `/regions/${c}/cities-municipalities/`));
app.get("/api/geo/provinces/:code/cities", geoRoute(c => `/provinces/${c}/cities-municipalities/`));
app.get("/api/geo/cities/:code/barangays", geoRoute(c => `/cities-municipalities/${c}/barangays/`));

app.use(express.static(path.join(__dirname, "public"), { setHeaders: (r, p) => p.endsWith(".html") && r.setHeader("Cache-Control", "no-cache") }));
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
  `);
}
init().then(() => app.listen(process.env.PORT || 3000, () => console.log("storefront up"))).catch(e => { console.error(e); process.exit(1); });
