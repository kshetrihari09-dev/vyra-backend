import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { boot, loginAs, makeUser, skipReason } from "./helpers.js";

/** Distance-based delivery charge through the real API and real Postgres (migration 016 included). */
describe("distance-based delivery charge (real Postgres)", { skip: skipReason }, () => {
  const GROCERY = "greek-yogurt";
  const STORE = { lat: 27.7172, lng: 85.324 };
  let ctx, cust, other, custId;
  const addr = {};
  const auth = (t) => ({ Authorization: `Bearer ${t}` });
  const api = (who, method, path, body) => ctx.request[method](`/api${path}`).set(who || {}).send(body);
  const reserved = async () => Number((await ctx.container.pool.query("SELECT reserved FROM inventory WHERE product_id = $1 AND branch_id = 'store-01' AND variant_id IS NULL", [GROCERY])).rows[0].reserved);
  const items = [{ productId: GROCERY, qty: 1 }];

  before(async () => {
    ctx = await boot();
    const c = await makeUser(ctx.container); const o = await makeUser(ctx.container); custId = c.id;
    cust = auth((await loginAs(ctx.request, c)).token); other = auth((await loginAs(ctx.request, o)).token);
    await ctx.container.pool.query("UPDATE inventory SET on_hand = 5000, reserved = 0 WHERE product_id = $1 AND branch_id = 'store-01' AND variant_id IS NULL", [GROCERY]);
    await ctx.container.pool.query("UPDATE branches SET lat = $1, lng = $2 WHERE id = 'store-01'", [STORE.lat, STORE.lng]);
    const mk = async (who, name, extra) => (await api(who, "post", "/addresses", { name: "Alex Morgan", phone: "+977 9800000002", line1: name, ...extra })).body.data.address.id;
    addr.near = await mk(cust, "near", { lat: STORE.lat + 0.005, lng: STORE.lng });   // ≈ 0.7 km
    addr.mid = await mk(cust, "mid", { lat: 27.7, lng: 85.3333 });                      // ≈ 2.8 km
    addr.far = await mk(cust, "far", { lat: 27.75, lng: 85.4 });                        // ≈ 10.9 km
    addr.away = await mk(cust, "away", { lat: 27.9, lng: 85.5 });                       // ≈ 35 km
    addr.nopin = await mk(cust, "nopin", {});
    addr.theirs = await mk(other, "theirs", { lat: STORE.lat + 0.005, lng: STORE.lng });
  });
  after(async () => { await ctx?.close(); });

  const quote = (who, addressId, extra = {}) => api(who, "post", "/cart/price", { items, deliveryOptionId: "standard", branch: "store-01", addressId, ...extra });

  it("migration 016 adds orders.delivery_distance_km", async () => {
    const r = await ctx.container.pool.query("SELECT data_type FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'delivery_distance_km'");
    assert.equal(r.rows[0]?.data_type, "numeric");
  });

  it("publishes the fee schedule without authentication", async () => {
    const res = await ctx.request.get("/api/delivery/pricing");
    assert.equal(res.status, 200);
    const { options, distance } = res.body.data;
    assert.deepEqual(options.map((o) => o.id).sort(), ["express", "slot", "standard"]);
    assert.deepEqual(distance.tiers[0], { fromKm: 0, toKm: 2, fee: 0 });
    assert.equal(distance.tiers.at(-1).toKm, distance.maxKm);
    assert.match(res.headers["cache-control"], /max-age/);
  });

  it("the cart preview charges by distance for the caller's own address", async () => {
    const near = (await quote(cust, addr.near)).body.data.totals;
    const mid = (await quote(cust, addr.mid)).body.data.totals;
    const far = (await quote(cust, addr.far)).body.data.totals;
    assert.deepEqual([near.delivery.distanceFee, mid.delivery.distanceFee, far.delivery.distanceFee], [0, 1, 3.5]);
    assert.ok(near.delivery.distanceKm < mid.delivery.distanceKm && mid.delivery.distanceKm < far.delivery.distanceKm);
    assert.equal(mid.delivery.basis, "address_pin");
    assert.ok(far.total > mid.total && mid.total > near.total);
  });

  it("another customer's address, an anonymous caller, and a missing address all fall back (no probing of other people's addresses)", async () => {
    assert.equal((await quote(cust, addr.theirs)).body.data.totals.delivery.basis, "no_pin");
    assert.equal((await quote(null, addr.near)).body.data.totals.delivery.basis, "no_pin");
    const none = (await quote(cust, addr.nopin)).body.data.totals.delivery;
    assert.equal(none.basis, "no_pin"); assert.equal(none.distanceFee, 2);
  });

  it("an out-of-range address is a blocking issue in the preview", async () => {
    const res = (await quote(cust, addr.away)).body.data;
    assert.equal(res.totals.delivery.deliverable, false);
    assert.ok(res.issues.some((i) => i.type === "out_of_range" && /within 15 km/.test(i.message)));
  });

  it("an order is charged exactly what was quoted and stores the distance it was based on", async () => {
    const q = (await quote(cust, addr.mid)).body.data.totals;
    const res = await api(cust, "post", "/orders", { items, addressId: addr.mid, paymentMethod: "cod", deliveryOptionId: "standard" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const o = res.body.data.order;
    assert.equal(o.deliveryFee, q.deliveryFee); assert.equal(o.total, q.total); assert.equal(o.delivery.distanceKm, q.delivery.distanceKm);
    const row = (await ctx.container.pool.query("SELECT delivery_fee, delivery_distance_km, total FROM orders WHERE id = $1", [o.id])).rows[0];
    assert.deepEqual([Number(row.delivery_fee), Number(row.delivery_distance_km), Number(row.total)], [q.deliveryFee, q.delivery.distanceKm, q.total]);
    const again = (await api(cust, "get", `/orders/${o.id}`)).body.data.order;
    assert.equal(again.delivery.distanceKm, q.delivery.distanceKm, "readable later from the order alone");
  });

  it("an order to an address with no pin pays the fallback fee and records no distance", async () => {
    const res = await api(cust, "post", "/orders", { items, addressId: addr.nopin, paymentMethod: "cod", deliveryOptionId: "standard" });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.order.deliveryFee, 2); assert.equal(res.body.data.order.delivery.distanceKm, null);
  });

  it("an out-of-range order is refused with a clear reason, creates nothing and reserves no stock", async () => {
    const before = { reserved: await reserved(), orders: Number((await ctx.container.pool.query("SELECT count(*) FROM orders WHERE user_id = $1", [custId])).rows[0].count) };
    const res = await api(cust, "post", "/orders", { items, addressId: addr.away, paymentMethod: "cod", deliveryOptionId: "standard" });
    assert.equal(res.status, 400); assert.equal(res.body.code, "OUT_OF_DELIVERY_RANGE");
    assert.match(res.body.message, /within 15 km/);
    assert.equal(await reserved(), before.reserved, "stock was not held");
    assert.equal(Number((await ctx.container.pool.query("SELECT count(*) FROM orders WHERE user_id = $1", [custId])).rows[0].count), before.orders);
  });

  it("the address pin is validated, so a bad coordinate can't be used to game the fee", async () => {
    for (const bad of [{ lat: 91, lng: 0 }, { lat: 0, lng: 181 }, { lat: 10 }, { lat: "near", lng: "far" }]) {
      assert.equal((await api(cust, "post", "/addresses", { name: "X Y", phone: "+977 9800000002", line1: "bad", ...bad })).status, 400, JSON.stringify(bad));
    }
  });
});
