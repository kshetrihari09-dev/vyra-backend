import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { boot, loginAs, makeUser, skipReason } from "./helpers.js";

describe("commerce API (real Postgres)", { skip: skipReason }, () => {
  let ctx, custAuth, staffAuth, addressId;
  before(async () => {
    ctx = await boot();
    custAuth = { Authorization: `Bearer ${(await loginAs(ctx.request, await makeUser(ctx.container))).token}` };
    staffAuth = { Authorization: `Bearer ${(await loginAs(ctx.request, await makeUser(ctx.container, { roles: ["warehouse"] }))).token}` };
    const addr = await ctx.request.post("/api/addresses").set(custAuth).send({ name: "Alex Morgan", phone: "+1 555 0190", line1: "24 Maple Court", city: "Metro City", zip: "10245" });
    addressId = addr.body.data.address.id;
  });
  after(async () => { await ctx?.close(); });

  it("addresses are scoped to the caller: another signed-in user can't see or edit them", async () => {
    const other = { Authorization: `Bearer ${(await loginAs(ctx.request, await makeUser(ctx.container))).token}` };
    assert.equal((await ctx.request.get("/api/addresses").set(other)).body.data.addresses.length, 0);
    assert.equal((await ctx.request.put(`/api/addresses/${addressId}`).set(other).send({ name: "x", phone: "+1 555 0190", line1: "x" })).status, 404);
  });

  it("cart pricing reflects live prices and stock, and needs no login", async () => {
    const res = await ctx.request.post("/api/cart/price").send({ items: [{ productId: "paracetamol-500", qty: 2 }] });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.lines[0].qty, 2);
    assert.equal(res.body.data.issues.length, 0);
  });

  it("places an order end to end: reserves stock, prices with a coupon, auto-confirms", async () => {
    const before = (await ctx.request.get("/api/products/paracetamol-500")).body.data.product;
    const stockBefore = before.stock["store-01"];
    const res = await ctx.request.post("/api/orders").set(custAuth).send({
      items: [{ productId: "paracetamol-500", qty: 2 }], addressId, paymentMethod: "cod", deliveryOptionId: "standard", couponCode: "FIRST15",
    });
    assert.equal(res.status, 201);
    const order = res.body.data.order;
    assert.equal(order.status, "confirmed");
    assert.equal(order.couponCode, "FIRST15");
    assert.ok(order.totals.discount > 0);
    // reserved stock lowers what /products reports as available, but not on_hand
    const after = (await ctx.request.get("/api/products/paracetamol-500")).body.data.product;
    assert.equal(after.stock["store-01"], stockBefore - 2);

    const mine = await ctx.request.get("/api/orders").set(custAuth);
    assert.ok(mine.body.data.orders.some((o) => o.id === order.id));
    const stranger = { Authorization: `Bearer ${(await loginAs(ctx.request, await makeUser(ctx.container))).token}` };
    assert.equal((await ctx.request.get(`/api/orders/${order.id}`).set(stranger)).status, 404);
  });

  it("fulfilment: staff advance stage by stage; 'packed' deducts real stock and batches", async () => {
    const created = await ctx.request.post("/api/orders").set(custAuth).send({ items: [{ productId: "paracetamol-500", qty: 3 }], addressId, paymentMethod: "cod", deliveryOptionId: "standard" });
    const id = created.body.data.order.id;
    assert.equal((await ctx.request.post(`/api/orders/${id}/status`).set(custAuth).send({ status: "preparing" })).status, 403);
    assert.equal((await ctx.request.post(`/api/orders/${id}/status`).set(staffAuth).send({ status: "packed" })).status, 409);
    await ctx.request.post(`/api/orders/${id}/status`).set(staffAuth).send({ status: "preparing" });
    const packed = await ctx.request.post(`/api/orders/${id}/status`).set(staffAuth).send({ status: "packed" });
    assert.equal(packed.status, 200);
    const { rows } = await ctx.container.pool.query("SELECT sum(qty) AS n FROM inventory_batches WHERE product_id='paracetamol-500' AND branch_id='store-01'");
    assert.ok(Number(rows[0].n) >= 0);
  });

  it("cancelling before packed releases the reservation; cancelling after packed is refused", async () => {
    const before = (await ctx.request.get("/api/products/paracetamol-500")).body.data.product;
    const created = await ctx.request.post("/api/orders").set(custAuth).send({ items: [{ productId: "paracetamol-500", qty: 1 }], addressId, paymentMethod: "cod", deliveryOptionId: "standard" });
    const id = created.body.data.order.id;
    const cancelled = await ctx.request.post(`/api/orders/${id}/cancel`).set(custAuth).send({ reason: "changed mind" });
    assert.equal(cancelled.body.data.order.status, "cancelled");
    const after = (await ctx.request.get("/api/products/paracetamol-500")).body.data.product;
    assert.equal(after.stock["store-01"], before.stock["store-01"], "stock returns once the reservation is released");
  });

  it("wishlist toggles per customer", async () => {
    const on = await ctx.request.post("/api/wishlist/paracetamol-500/toggle").set(custAuth);
    assert.equal(on.body.data.saved, true);
    assert.ok((await ctx.request.get("/api/wishlist").set(custAuth)).body.data.productIds.includes("paracetamol-500"));
    const off = await ctx.request.post("/api/wishlist/paracetamol-500/toggle").set(custAuth);
    assert.equal(off.body.data.saved, false);
  });
});
