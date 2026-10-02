import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { boot, loginAs, makeUser, skipReason } from "./helpers.js";

/** The order-flow rules against the real API + real Postgres: row locks, the order-number sequence and the payment gate. */
describe("order flow (real Postgres)", { skip: skipReason }, () => {
  let ctx, cust, other, staff, admin, shopOwner, otherShopOwner, addressId, ownerIds;
  const auth = (t) => ({ Authorization: `Bearer ${t}` });
  const GROCERY = "greek-yogurt";       // seller: fresh-grocers (no variants, not batch-tracked)
  const BEAUTY = "toothpaste-gel";       // seller: auralux-beauty
  const place = (who, body = {}) => ctx.request.post("/api/orders").set(who).send({
    items: [{ productId: GROCERY, qty: 1 }], addressId, paymentMethod: "cod", deliveryOptionId: "standard", ...body,
  });
  const status = (who, id, s) => ctx.request.post(`/api/orders/${id}/status`).set(who).send({ status: s });
  const get = (who, id) => ctx.request.get(`/api/orders/${id}`).set(who);
  const stock = async (productId) => (await ctx.container.pool.query("SELECT on_hand, reserved FROM inventory WHERE product_id = $1 AND branch_id = 'store-01' AND variant_id IS NULL", [productId])).rows[0];
  const paymentOf = async (orderId) => (await ctx.request.get(`/api/orders/${orderId}/payment`).set(cust)).body.data.payments;

  before(async () => {
    ctx = await boot();
    const login = async (u) => auth((await loginAs(ctx.request, u)).token);
    const [c, o, s, a, so, so2] = [await makeUser(ctx.container), await makeUser(ctx.container), await makeUser(ctx.container, { roles: ["warehouse"] }),
      await makeUser(ctx.container, { roles: ["admin"] }), await makeUser(ctx.container, { roles: ["customer", "seller"] }), await makeUser(ctx.container, { roles: ["customer", "seller"] })];
    ownerIds = [so.id, so2.id];
    // Plenty of shelf stock so repeated runs against a shared database never trip "out of stock".
    await ctx.container.pool.query("UPDATE inventory SET on_hand = 5000, reserved = 0 WHERE product_id = ANY($1) AND branch_id = 'store-01' AND variant_id IS NULL", [[GROCERY, BEAUTY]]);
    await ctx.container.pool.query("UPDATE sellers SET owner_user_id = $1 WHERE id = 'fresh-grocers'", [so.id]);
    await ctx.container.pool.query("UPDATE sellers SET owner_user_id = $1 WHERE id = 'auralux-beauty'", [so2.id]);
    [cust, other, staff, admin, shopOwner, otherShopOwner] = [await login(c), await login(o), await login(s), await login(a), await login(so), await login(so2)];
    addressId = (await ctx.request.post("/api/addresses").set(cust).send({ name: "Alex Morgan", phone: "+1 555 0190", line1: "24 Maple Court", city: "Metro City", zip: "10245" })).body.data.address.id;
  });
  after(async () => {
    await ctx.container.pool.query("UPDATE sellers SET owner_user_id = NULL WHERE owner_user_id = ANY($1)", [ownerIds]);
    await ctx?.close();
  });

  it("order numbers: 30 concurrent checkouts all succeed with distinct PN-YYYYMMDD-NNNNNN numbers", async () => {
    const results = await Promise.all(Array.from({ length: 30 }, () => place(cust)));
    assert.deepEqual([...new Set(results.map((r) => r.status))], [201]);
    const numbers = results.map((r) => r.body.data.order.orderNumber);
    assert.equal(new Set(numbers).size, 30);
    for (const n of numbers) assert.match(n, /^PN-\d{8}-\d{6}$/);
  });

  it("order numbers: the sequence itself never repeats under 200 concurrent draws, and the UNIQUE constraint backs it up", async () => {
    const draws = await Promise.all(Array.from({ length: 200 }, () => ctx.container.repos.orders.nextNumber(ctx.container.pool)));
    assert.equal(new Set(draws).size, 200);
    const { rows } = await ctx.container.pool.query("SELECT 1 FROM pg_indexes WHERE tablename = 'orders' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%(number)%'");
    assert.ok(rows.length >= 1);
    await assert.rejects(ctx.container.pool.query("INSERT INTO orders (number) SELECT number FROM orders LIMIT 1"));
  });

  it("COD: stays 'placed' until the seller confirms; payment pending; no OTP anywhere before dispatch", async () => {
    const res = await place(cust);
    const o = res.body.data.order;
    assert.equal(o.status, "placed");
    assert.equal(o.paymentMethod, "cod");
    assert.equal(o.paymentStatus, "pending");
    assert.deepEqual(o.actions, { next: "confirmed", blocked: null, canCancel: true });
    assert.ok(!JSON.stringify(res.body).includes("otp\":\""), "no OTP value in the create response");
    assert.equal((await get(cust, o.id)).body.data.order.status, "placed", "the customer sees the new order immediately");
    assert.equal((await status(shopOwner, o.id, "confirmed")).body.data.order.status, "confirmed");
  });

  it("prepaid: pending payment blocks packing (409 PAYMENT_PENDING) with stock untouched; confirming the payment unblocks the SAME order", async () => {
    const before = await stock(GROCERY);
    const o = (await place(cust, { paymentMethod: "card" })).body.data.order;
    assert.equal(o.paymentStatus, "pending");
    await status(staff, o.id, "confirmed"); await status(staff, o.id, "preparing");
    const blocked = await status(staff, o.id, "packed");
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, "PAYMENT_PENDING");
    assert.equal((await get(cust, o.id)).body.data.order.actions.blocked, "PAYMENT_PENDING");
    const mid = await stock(GROCERY);
    assert.equal(mid.on_hand, before.on_hand, "nothing left the shelf");

    const [payment] = await paymentOf(o.id);
    assert.equal(payment.status, "pending");
    assert.equal((await ctx.request.post(`/api/payments/${payment.id}/confirm-manual`).set(cust)).status, 403, "a customer can't mark their own payment as paid");
    assert.equal((await ctx.request.post(`/api/payments/${payment.id}/confirm-manual`).set(admin)).status, 200);
    assert.equal((await ctx.request.post(`/api/payments/${payment.id}/confirm-manual`).set(admin)).status, 409, "second confirmation is refused, not applied twice");
    const paid = (await get(cust, o.id)).body.data.order;
    assert.equal(paid.paymentStatus, "paid");
    assert.equal((await status(staff, o.id, "packed")).status, 200);
    assert.equal((await paymentOf(o.id)).length, 1);
  });

  it("payment retry: a pending payment is reused (no duplicate), and it never creates another order", async () => {
    const o = (await place(cust, { paymentMethod: "card" })).body.data.order;
    const count = async () => Number((await ctx.container.pool.query("SELECT count(*) FROM orders WHERE user_id = (SELECT user_id FROM orders WHERE id = $1)", [o.id])).rows[0].count);
    const before = await count();
    const r1 = await ctx.request.post(`/api/orders/${o.id}/payment/retry`).set(cust);
    const r2 = await ctx.request.post(`/api/orders/${o.id}/payment/retry`).set(cust);
    assert.equal(r1.status, 200);
    assert.equal(r1.body.data.created, false);
    assert.equal(r2.body.data.payment.id, r1.body.data.payment.id);
    assert.equal(await count(), before);
    assert.equal((await ctx.request.post(`/api/orders/${o.id}/payment/retry`).set(other)).status, 404, "not someone else's order");
    // a failed attempt → retry starts a fresh payment on the same order
    await ctx.container.pool.query("UPDATE payments SET status = 'failed' WHERE order_id = $1", [o.id]);
    const r3 = await ctx.request.post(`/api/orders/${o.id}/payment/retry`).set(cust);
    assert.equal(r3.body.data.created, true);
    assert.equal(r3.body.data.payment.status, "pending");
    assert.equal(await count(), before);
  });

  it("cancellation: allowed before packed (stock released once, payment closed); refused from packed on", async () => {
    const base = await stock(GROCERY);
    const o = (await place(cust, { paymentMethod: "card", items: [{ productId: GROCERY, qty: 3 }] })).body.data.order;
    assert.equal((await stock(GROCERY)).reserved, base.reserved + 3);
    const c = await ctx.request.post(`/api/orders/${o.id}/cancel`).set(cust).send({ reason: "changed my mind" });
    assert.equal(c.status, 200);
    assert.equal(c.body.data.order.status, "cancelled");
    assert.equal((await stock(GROCERY)).reserved, base.reserved);
    assert.equal((await paymentOf(o.id))[0].status, "cancelled");
    const again = await ctx.request.post(`/api/orders/${o.id}/cancel`).set(cust).send({});
    assert.equal(again.status, 409);
    assert.equal((await stock(GROCERY)).reserved, base.reserved, "second cancel releases nothing");

    const p = (await place(cust)).body.data.order;
    for (const s of ["confirmed", "preparing", "packed"]) await status(staff, p.id, s);
    const late = await ctx.request.post(`/api/orders/${p.id}/cancel`).set(cust).send({});
    assert.equal(late.status, 409);
    assert.equal(late.body.code, "TOO_LATE_TO_CANCEL");
    assert.equal((await get(cust, p.id)).body.data.order.actions.canCancel, false);
    assert.equal((await ctx.request.post(`/api/orders/${p.id}/cancel`).set(shopOwner).send({})).body.code, "TOO_LATE_TO_CANCEL");
  });

  it("concurrent cancels on one order: exactly one succeeds and the reservation is released exactly once", async () => {
    const base = await stock(GROCERY);
    const o = (await place(cust, { items: [{ productId: GROCERY, qty: 4 }] })).body.data.order;
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => ctx.request.post(`/api/orders/${o.id}/cancel`).set(cust).send({})));
    assert.equal(rs.filter((r) => r.status === 200).length, 1);
    assert.equal(rs.filter((r) => r.status === 409).length, 4);
    assert.equal((await stock(GROCERY)).reserved, base.reserved);
  });

  it("concurrent cancel vs. packing: whichever wins, stock ends up consistent (never both released and deducted)", async () => {
    const base = await stock(GROCERY);
    const o = (await place(cust, { items: [{ productId: GROCERY, qty: 2 }] })).body.data.order;
    await status(staff, o.id, "confirmed"); await status(staff, o.id, "preparing");
    const [cancel, pack] = await Promise.all([ctx.request.post(`/api/orders/${o.id}/cancel`).set(cust).send({}), status(staff, o.id, "packed")]);
    const after = await stock(GROCERY);
    const final = (await get(cust, o.id)).body.data.order.status;
    if (final === "cancelled") { assert.equal(after.on_hand, base.on_hand); assert.equal(after.reserved, base.reserved); assert.equal(pack.status, 409); }
    else { assert.equal(final, "packed"); assert.equal(after.on_hand, base.on_hand - 2); assert.equal(after.reserved, base.reserved); assert.equal(cancel.status, 409); }
  });

  it("seller scoping: a shop sees and acts on its own orders only; others get 404; a customer can't drive fulfilment", async () => {
    const mine = (await place(cust)).body.data.order;                                     // fresh-grocers only
    const beauty = (await place(cust, { items: [{ productId: BEAUTY, qty: 1 }] })).body.data.order;
    const list = (await ctx.request.get("/api/orders").set(shopOwner)).body.data.orders;
    assert.ok(list.some((o) => o.id === mine.id));
    assert.ok(!list.some((o) => o.id === beauty.id), "another shop's order isn't listed");
    assert.equal((await get(shopOwner, beauty.id)).status, 404);
    assert.equal((await status(shopOwner, beauty.id, "confirmed")).status, 404);
    assert.equal((await ctx.request.post(`/api/orders/${beauty.id}/cancel`).set(shopOwner).send({})).status, 404);
    assert.equal((await get(otherShopOwner, beauty.id)).status, 200);
    assert.equal((await status(otherShopOwner, beauty.id, "confirmed")).status, 200);
    assert.equal((await status(cust, mine.id, "confirmed")).status, 403);
    assert.equal((await get(other, mine.id)).status, 404);
    const shared = (await place(cust, { items: [{ productId: GROCERY, qty: 1 }, { productId: BEAUTY, qty: 1 }] })).body.data.order;
    const seen = (await get(shopOwner, shared.id)).body.data.order;
    assert.deepEqual(seen.items.map((i) => i.productId), [GROCERY], "no other shop's lines leak");
    assert.equal(seen.sellerView.soleSeller, false);
    assert.equal((await status(shopOwner, shared.id, "confirmed")).status, 404);
  });

  it("invalid transitions are refused over HTTP, and the delivery stages can't be set through the generic endpoint", async () => {
    const o = (await place(cust)).body.data.order;
    assert.equal((await status(staff, o.id, "preparing")).status, 409);
    assert.equal((await status(staff, o.id, "packed")).status, 409);
    await status(staff, o.id, "confirmed");
    assert.equal((await status(staff, o.id, "confirmed")).status, 409);
    for (const s of ["assigned", "out_for_delivery", "delivered", "returned"]) assert.equal((await status(staff, o.id, s)).status, 400, s);
    assert.equal((await status(staff, o.id, "preparing")).status, 200);
  });

  // ---------------------------------------------------------------- end to end, with a real rider and the handover code
  describe("end to end through delivery", () => {
    let rider;
    before(async () => {
      const riderUser = await makeUser(ctx.container);
      assert.equal((await ctx.request.post("/api/delivery/riders").set(admin).send({ userId: riderUser.id, phone: "+1 555 0231", vehicle: "Scooter" })).status, 201);
      rider = auth((await loginAs(ctx.request, riderUser)).token);
      await ctx.request.put("/api/rider/me/availability").set(rider).send({ available: true });
    });
    const available = async (orderId) => (await ctx.request.get("/api/rider/available-orders").set(rider)).body.data.orders.some((o) => o.orderId === orderId);
    const deliverWithCode = async (o, cash) => {
      assert.equal((await get(other, o.id)).status, 404);
      const claimed = await ctx.request.post(`/api/rider/orders/${o.id}/claim`).set(rider);
      assert.equal(claimed.status, 201);
      const did = claimed.body.data.delivery.id;
      const assigned = (await get(cust, o.id)).body.data.order;
      assert.equal(assigned.status, "assigned");
      assert.match(assigned.otp, /^\d{4}$/, "the code appears once the order is with a rider");
      assert.equal((await get(shopOwner, o.id)).body.data.order.otp, undefined, "never to the seller");
      assert.equal((await get(staff, o.id)).body.data.order.otp, undefined, "never to staff");
      assert.equal((await ctx.request.post(`/api/rider/deliveries/${did}/pickup`).set(rider)).status, 200);
      const wrong = assigned.otp === "0000" ? "1111" : "0000";
      assert.equal((await ctx.request.post(`/api/rider/deliveries/${did}/deliver`).set(rider).send({ otp: wrong, cashCollected: cash })).status, 400, "a wrong code is refused");
      assert.equal((await ctx.request.post(`/api/rider/deliveries/${did}/deliver`).set(rider).send({ otp: assigned.otp, cashCollected: cash })).status, 200);
      const done = (await get(cust, o.id)).body.data.order;
      assert.equal(done.status, "delivered");
      assert.equal(done.otp, undefined, "hidden again once delivered");
      return done;
    };

    it("Test A — COD: place → seller confirms → preparing → packed → rider → OTP → delivered; cash payment completes", async () => {
      const o = (await place(cust)).body.data.order;
      assert.equal(o.status, "placed");
      for (const st of ["confirmed", "preparing", "packed"]) assert.equal((await status(shopOwner, o.id, st)).status, 200, st);
      assert.equal(await available(o.id), true);
      const done = await deliverWithCode(o, o.total);
      assert.equal(done.paymentStatus, "paid");
      assert.equal((await paymentOf(o.id))[0].status, "captured");
      assert.equal((await ctx.request.post(`/api/orders/${o.id}/cancel`).set(cust).send({})).status, 409, "delivered orders can't be cancelled");
      assert.equal((await status(staff, o.id, "preparing")).status, 409, "delivered → preparing is rejected");
    });

    it("Test B — prepaid: pending blocks dispatch everywhere; once paid, the same order is processed and delivered", async () => {
      const o = (await place(cust, { paymentMethod: "card" })).body.data.order;
      for (const st of ["confirmed", "preparing"]) await status(shopOwner, o.id, st);
      assert.equal((await status(shopOwner, o.id, "packed")).body.code, "PAYMENT_PENDING");
      // even if an unpaid prepaid order were forced to "packed" (corrupt data), the rider side still refuses it
      await ctx.container.pool.query("UPDATE orders SET status = 'packed' WHERE id = $1", [o.id]);
      assert.equal(await available(o.id), false, "not offered to riders");
      const claim = await ctx.request.post(`/api/rider/orders/${o.id}/claim`).set(rider);
      assert.equal(claim.status, 409);
      assert.equal(claim.body.code, "PAYMENT_PENDING");
      await ctx.container.pool.query("UPDATE orders SET status = 'preparing' WHERE id = $1", [o.id]);

      const [payment] = await paymentOf(o.id);
      assert.equal((await ctx.request.post(`/api/payments/${payment.id}/confirm-manual`).set(admin)).status, 200);
      assert.equal((await status(shopOwner, o.id, "packed")).status, 200);
      const done = await deliverWithCode(o);
      assert.equal(done.paymentStatus, "paid");
      assert.equal((await paymentOf(o.id)).length, 1, "one payment for the whole order");
    });

    it("Test C — payment failure: stays pending and undispatchable, retry reuses the order, capture lets it continue", async () => {
      const o = (await place(cust, { paymentMethod: "upi" })).body.data.order;
      await ctx.container.pool.query("UPDATE payments SET status = 'failed', failed_at = now(), failure_reason = 'declined' WHERE order_id = $1", [o.id]);
      const after = (await get(cust, o.id)).body.data.order;
      assert.equal(after.paymentStatus, "pending");
      assert.equal(after.status, "placed");
      for (const st of ["confirmed", "preparing"]) await status(shopOwner, o.id, st);
      assert.equal((await status(shopOwner, o.id, "packed")).body.code, "PAYMENT_PENDING");

      const retry = await ctx.request.post(`/api/orders/${o.id}/payment/retry`).set(cust);
      assert.equal(retry.body.data.created, true);
      assert.equal((await ctx.request.post(`/api/payments/${retry.body.data.payment.id}/confirm-manual`).set(admin)).status, 200);
      assert.equal((await ctx.request.post(`/api/payments/${retry.body.data.payment.id}/confirm-manual`).set(admin)).status, 409);
      assert.equal((await status(shopOwner, o.id, "packed")).status, 200);
      const done = await deliverWithCode(o);
      assert.equal(done.paymentStatus, "paid");
    });

    it("Test D — cancelling a paid order before packed queues exactly one refund and releases stock; an unpaid one just closes its payment", async () => {
      const base = await stock(GROCERY);
      const o = (await place(cust, { paymentMethod: "card", items: [{ productId: GROCERY, qty: 2 }] })).body.data.order;
      const [payment] = await paymentOf(o.id);
      await ctx.request.post(`/api/payments/${payment.id}/confirm-manual`).set(admin);
      assert.equal((await ctx.request.post(`/api/orders/${o.id}/cancel`).set(cust).send({ reason: "late" })).status, 200);
      assert.equal((await stock(GROCERY)).reserved, base.reserved);
      const { rows } = await ctx.container.pool.query("SELECT status, amount FROM refunds WHERE order_id = $1", [o.id]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "pending");
      assert.equal(Number(rows[0].amount), o.total);
      assert.equal((await get(cust, o.id)).body.data.order.paymentStatus, "paid", "stays paid until finance completes the refund");
      const dup = await ctx.request.post(`/api/orders/${o.id}/refund-request`).set(cust).send({ reason: "again" });
      assert.equal(dup.status, 409);
    });
  });
});
