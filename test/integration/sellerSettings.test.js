import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { boot, loginAs, makeUser, skipReason, uniq } from "./helpers.js";

/** Shop settings are stored on the server, readable/writable only by the shop's own owner, and the switches that checkout and
 *  notifications read really change what those read. Real Postgres + the real Express app. */
const payload = () => ({
  name: "Settings Shop", description: "Fresh and local", logo: null, banner: null, phone: "9812345678", email: "shop@example.com",
  address: "Main St", city: "Butwal", landmark: "Near the bridge",
  hours: Object.fromEntries(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => [d, { open: "08:00", close: "20:00", closed: d === "Sun" }])),
  delivery: { available: true, pickup: false, radiusKm: 7, fee: 60, freeAbove: 1500, minOrder: 400, prepMinutes: 25 },
  payments: { cod: false, card: true, upi: true, netbanking: false },
  tax: { registration: "PAN-99", inclusive: false, defaultRate: 13 },
  notifications: { newOrder: false, lowStock: true, payout: true, reviews: false, email: false, sms: true },
});

describe("shop settings (real Postgres)", { skip: skipReason }, () => {
  let ctx; let request; let pool; let owner; let other; let cust; let shop; let shopB; let tOwner; let tOther; let tCust;
  const as = (t) => ({ Authorization: `Bearer ${t}` });
  before(async () => {
    ctx = await boot(); request = ctx.request; pool = ctx.container.pool;
    [owner, other, cust] = await Promise.all([makeUser(ctx.container, { roles: ["customer", "seller"] }), makeUser(ctx.container, { roles: ["customer", "seller"] }), makeUser(ctx.container)]);
    const tag = uniq(); shop = `it-set-a-${tag}`; shopB = `it-set-b-${tag}`;
    await pool.query("INSERT INTO sellers (id, name, status, owner_user_id, is_demo) VALUES ($1,'Old Name','active',$2,true), ($3,'Other Shop','active',$4,true)", [shop, owner.id, shopB, other.id]);
    [tOwner, tOther, tCust] = (await Promise.all([owner, other, cust].map((u) => loginAs(request, u)))).map((l) => l.token);
  });
  after(async () => {
    await pool.query("DELETE FROM sellers WHERE id = ANY($1)", [[shop, shopB]]);
    // Users stay: the audit log is append-only and now references them (the other integration suites leave theirs too).
    await Promise.all(["callsRealtime", "realtime", "supportRealtime"].map((k) => ctx.container.services[k]?.stop?.().catch(() => {})));
    await ctx.close();
  });
  const put = (id, t, body) => request.put(`/api/sellers/${id}/settings`).set(as(t)).send(body);
  const get = (id, t) => request.get(`/api/sellers/${id}/settings`).set(as(t));

  it("a new shop reads sensible defaults", async () => {
    const r = await get(shop, tOwner);
    assert.equal(r.status, 200); assert.equal(r.body.data.settings.name, "Old Name");
    assert.equal(r.body.data.settings.payments.cod, true); assert.equal(r.body.data.settings.delivery.minOrder, 0);
  });

  it("saving persists everything, survives a fresh read, and /sellers/mine carries it", async () => {
    const r = await put(shop, tOwner, payload());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const read = (await get(shop, tOwner)).body.data.settings;
    assert.equal(read.name, "Settings Shop"); assert.equal(read.delivery.minOrder, 400); assert.equal(read.payments.cod, false);
    assert.equal(read.tax.defaultRate, 13); assert.equal(read.hours.Mon.open, "08:00"); assert.equal(read.landmark, "Near the bridge");
    const mine = (await request.get("/api/sellers/mine").set(as(tOwner))).body.data.seller;
    assert.equal(mine.name, "Settings Shop"); assert.equal(mine.settings.tax.defaultRate, 13);
    const row = (await pool.query("SELECT name, description, contact_email, settings FROM sellers WHERE id = $1", [shop])).rows[0];
    assert.equal(row.name, "Settings Shop"); assert.equal(row.description, "Fresh and local"); assert.equal(row.contact_email, "shop@example.com");
    assert.equal(row.settings.delivery.fee, 60);
  });

  it("the shop's email/SMS switches become the owner account's real notification preferences", async () => {
    const u = (await pool.query("SELECT notify_email, notify_sms FROM users WHERE id = $1", [owner.id])).rows[0];
    assert.equal(u.notify_email, false); assert.equal(u.notify_sms, true);
  });

  it("only the shop's own owner can read or change its settings", async () => {
    assert.equal((await get(shop, tOther)).status, 404);
    assert.equal((await put(shop, tOther, payload())).status, 404, "another shop's owner can't change it");
    assert.equal((await put(shopB, tOwner, payload())).status, 404, "…and the same in reverse");
    assert.equal((await put(shop, tCust, payload())).status, 403, "a customer has no shop");
    assert.equal((await request.put(`/api/sellers/${shop}/settings`).send(payload())).status, 401);
    assert.equal((await pool.query("SELECT name FROM sellers WHERE id = $1", [shopB])).rows[0].name, "Other Shop");
  });

  it("rejects invalid settings and changes nothing", async () => {
    const before_ = (await get(shop, tOwner)).body.data.settings;
    const bad = async (mutate) => { const p = payload(); mutate(p); return put(shop, tOwner, p); };
    assert.equal((await bad((p) => { p.payments = { cod: false, card: false, upi: false, netbanking: false }; })).status, 400);
    assert.equal((await bad((p) => { p.hours.Mon = { open: "20:00", close: "08:00", closed: false }; })).status, 400);
    assert.equal((await bad((p) => { p.tax.defaultRate = 500; })).status, 400);
    assert.equal((await bad((p) => { p.logo = "https://evil.example/x.png"; })).status, 400);
    assert.equal((await bad((p) => { p.status = "active"; })).status, 400, "unknown fields are refused");
    assert.deepEqual((await get(shop, tOwner)).body.data.settings, before_);
  });

  it("accepts a small logo image and stores it", async () => {
    const p = payload(); p.logo = "data:image/png;base64,iVBORw0KGgo=";
    assert.equal((await put(shop, tOwner, p)).status, 200);
    assert.equal((await get(shop, tOwner)).body.data.settings.logo, "data:image/png;base64,iVBORw0KGgo=");
  });

  it("a suspended shop can't change its settings", async () => {
    await pool.query("UPDATE sellers SET status = 'suspended' WHERE id = $1", [shop]);
    const r = await put(shop, tOwner, payload());
    assert.ok([403, 409].includes(r.status), `got ${r.status}`);
    await pool.query("UPDATE sellers SET status = 'active' WHERE id = $1", [shop]);
  });

  it("checkout reads the saved rules: settingsByIds returns exactly what the cart rules need", async () => {
    const rows = await ctx.container.repos.sellers.settingsByIds(pool, [shop, shopB, "nope"]);
    assert.deepEqual(rows.map((r) => r.id).sort(), [shop, shopB].sort());
    const { minOrderIssues, paymentRejection } = await import("../../src/domain/sellerSettings.js");
    assert.equal(minOrderIssues([{ sellerId: shop, lineTotal: 100 }], rows).length, 1);
    assert.equal(minOrderIssues([{ sellerId: shop, lineTotal: 450 }], rows).length, 0);
    assert.equal(paymentRejection(rows.filter((r) => r.id === shop), "cod")?.sellerId, shop);
    assert.equal(paymentRejection(rows.filter((r) => r.id === shop), "card"), null);
  });
});

describe("GET /api/geo/locate (public)", { skip: skipReason }, () => {
  let ctx; let request;
  before(async () => { ctx = await boot(); request = ctx.request; });
  after(async () => { await Promise.all(["callsRealtime", "realtime", "supportRealtime"].map((k) => ctx.container.services[k]?.stop?.().catch(() => {}))); await ctx.close(); });
  it("answers without signing in, with the municipality and its ward count", async () => {
    const r = await request.get("/api/geo/locate?lat=27.7006&lng=83.4483");
    assert.equal(r.status, 200); assert.equal(r.body.data.municipality.id, "butwal-sub"); assert.equal(r.body.data.municipality.wards, 19);
  });
  it("reports a pin outside Nepal, and rejects nonsense input", async () => {
    assert.equal((await request.get("/api/geo/locate?lat=28.6&lng=77.2")).body.data.inNepal, false);
    assert.equal((await request.get("/api/geo/locate?lat=abc&lng=1")).status, 400);
    assert.equal((await request.get("/api/geo/locate")).status, 400);
  });
});
