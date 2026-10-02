import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { boot, loginAs, makeUser, skipReason } from "./helpers.js";

/** Written against the real API + Postgres like the other integration files — NOT yet run (needs TEST_DATABASE_URL). */
describe("delivery API (real Postgres)", { skip: skipReason }, () => {
  let ctx, cust, warehouse, admin, riderUser, rider, addressId, orderId, deliveryId;
  const auth = (t) => ({ Authorization: `Bearer ${t}` });
  before(async () => {
    ctx = await boot();
    const login = async (u) => auth((await loginAs(ctx.request, u)).token);
    cust = await login(await makeUser(ctx.container));
    warehouse = await login(await makeUser(ctx.container, { roles: ["warehouse"] }));
    admin = await login(await makeUser(ctx.container, { roles: ["admin"] }));
    riderUser = await makeUser(ctx.container);
    const created = await ctx.request.post("/api/delivery/riders").set(admin).send({ userId: riderUser.id, phone: "+1 555 0231", vehicle: "Scooter" });
    assert.equal(created.status, 201);
    rider = await login(riderUser); // roles/permissions are read from the DB on each request, so the new role applies immediately
    addressId = (await ctx.request.post("/api/addresses").set(cust).send({ name: "Alex Morgan", phone: "+1 555 0190", line1: "24 Maple Court", city: "Metro City", zip: "10245" })).body.data.address.id;
    const o = await ctx.request.post("/api/orders").set(cust).send({ items: [{ productId: "paracetamol-500", qty: 1 }], addressId, paymentMethod: "cod", deliveryOptionId: "standard" });
    orderId = o.body.data.order.id;
    await ctx.request.post(`/api/orders/${orderId}/status`).set(warehouse).send({ status: "confirmed" });
    await ctx.request.post(`/api/orders/${orderId}/status`).set(warehouse).send({ status: "preparing" });
    await ctx.request.post(`/api/orders/${orderId}/status`).set(warehouse).send({ status: "packed" });
  });
  after(async () => { await ctx?.close(); });

  it("the plaintext code column is gone, and the owner (only) sees a 4-digit code", async () => {
    const { rows } = await ctx.container.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'otp'");
    assert.equal(rows.length, 0);
    // Packed but not yet with a rider: the code is not shown yet (it appears once the order is assigned / out for delivery).
    assert.equal((await ctx.request.get(`/api/orders/${orderId}`).set(cust)).body.data.order.otp, undefined);
    assert.equal((await ctx.request.get(`/api/orders/${orderId}`).set(warehouse)).body.data.order.otp, undefined);
  });

  it("staff can no longer jump an order to assigned/delivered through the generic status endpoint", async () => {
    for (const status of ["assigned", "out_for_delivery", "delivered"]) {
      assert.equal((await ctx.request.post(`/api/orders/${orderId}/status`).set(admin).send({ status })).status, 400, status);
    }
  });

  it("role gates: a customer can't use the rider API; a rider can't read someone else's order or dispatch", async () => {
    assert.equal((await ctx.request.get("/api/rider/deliveries").set(cust)).status, 403);
    assert.equal((await ctx.request.get(`/api/orders/${orderId}`).set(rider)).status, 404);
    assert.equal((await ctx.request.get("/api/delivery/riders").set(rider)).status, 403);
    assert.equal((await ctx.request.post(`/api/delivery/orders/${orderId}/assign`).set(rider).send({ riderId: "00000000-0000-4000-8000-000000000000" })).status, 403);
  });

  it("rider claims the packed order, picks it up, is refused on a wrong code, and completes with the right one + exact cash", async () => {
    await ctx.request.put("/api/rider/me/availability").set(rider).send({ available: true });
    const avail = await ctx.request.get("/api/rider/available-orders").set(rider);
    assert.ok(avail.body.data.orders.some((o) => o.orderId === orderId));
    assert.ok(!JSON.stringify(avail.body.data).includes("Maple"), "street is hidden until the order is claimed");

    const claimed = await ctx.request.post(`/api/rider/orders/${orderId}/claim`).set(rider);
    assert.equal(claimed.status, 201);
    deliveryId = claimed.body.data.delivery.id;
    assert.equal((await ctx.request.post(`/api/rider/orders/${orderId}/claim`).set(rider)).status, 409);
    assert.equal((await ctx.request.post(`/api/rider/deliveries/${deliveryId}/pickup`).set(rider)).status, 200);
    assert.equal((await ctx.request.post(`/api/rider/deliveries/${deliveryId}/location`).set(rider).send({ lat: 27.7, lng: 85.3 })).body.data.accepted, true);

    const order = (await ctx.request.get(`/api/orders/${orderId}`).set(cust)).body.data.order;
    assert.equal(order.status, "out_for_delivery");
    assert.match(order.otp, /^\d{4}$/, "the customer sees the code now that the order is out for delivery");
    assert.equal((await ctx.request.get(`/api/orders/${orderId}`).set(warehouse)).body.data.order.otp, undefined);
    const track = (await ctx.request.get(`/api/orders/${orderId}/tracking`).set(cust)).body.data.tracking;
    assert.equal(track.delivery.location.lat, 27.7);

    const wrong = order.otp === "0000" ? "1111" : "0000";
    const bad = await ctx.request.post(`/api/rider/deliveries/${deliveryId}/deliver`).set(rider).send({ otp: wrong, cashCollected: order.totals.total });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, "OTP_MISMATCH");
    const { rows } = await ctx.container.pool.query("SELECT otp_attempts FROM orders WHERE id = $1", [orderId]);
    assert.equal(rows[0].otp_attempts, 1, "the wrong attempt is committed even though the request failed");

    assert.equal((await ctx.request.post(`/api/rider/deliveries/${deliveryId}/deliver`).set(rider).send({ otp: order.otp, cashCollected: order.totals.total + 1 })).status, 400); // cash mismatch
    const done = await ctx.request.post(`/api/rider/deliveries/${deliveryId}/deliver`).set(rider).send({ otp: order.otp, cashCollected: order.totals.total });
    assert.equal(done.status, 200);
    const final = (await ctx.request.get(`/api/orders/${orderId}`).set(cust)).body.data.order;
    assert.equal(final.status, "delivered");
    assert.equal(final.paymentStatus, "paid");
    assert.equal(final.otp, undefined);
    const left = await ctx.container.pool.query("SELECT count(*) AS n FROM delivery_locations WHERE delivery_id = $1", [deliveryId]);
    assert.equal(Number(left.rows[0].n), 0, "location trail is purged when the run ends");
  });
});
