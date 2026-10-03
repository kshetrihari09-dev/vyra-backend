import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DELIVERY_RULES } from "../../src/config/delivery.js";
import { boot, loginAs, makeUser, skipReason } from "./helpers.js";

/**
 * These only mean something against a real database: the in-memory fakes can't lock rows. They prove the lock order
 * (order → rider → delivery), the one-active-delivery index, capacity under a race, and immediate revocation.
 */
describe("delivery concurrency & rider authorization (real Postgres)", { skip: skipReason }, () => {
  let ctx, cust, warehouse, admin, addressId, stockBefore;
  const auth = (t) => ({ Authorization: `Bearer ${t}` });
  const login = async (u) => auth((await loginAs(ctx.request, u)).token);
  const q = (sql, params) => ctx.container.pool.query(sql, params);

  async function makeRider({ available = true } = {}) {
    const user = await makeUser(ctx.container);
    const created = await ctx.request.post("/api/delivery/riders").set(admin).send({ userId: user.id, phone: "+1 555 0231", vehicle: "Bike · BA 12 PA 1234" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const token = await login(user);
    if (available) await ctx.request.put("/api/rider/me/availability").set(token).send({ available: true });
    return { user, token, id: created.body.data.rider.id };
  }
  async function packedOrder() {
    const o = await ctx.request.post("/api/orders").set(cust).send({ items: [{ productId: "paracetamol-500", qty: 1 }], addressId, paymentMethod: "cod", deliveryOptionId: "standard" });
    assert.equal(o.status, 201, JSON.stringify(o.body));
    const id = o.body.data.order.id;
    for (const status of ["confirmed", "preparing", "packed"]) await ctx.request.post(`/api/orders/${id}/status`).set(warehouse).send({ status });
    return id;
  }
  const activeCount = async (orderId) => Number((await q("SELECT count(*) n FROM deliveries WHERE order_id = $1 AND status IN ('assigned','accepted','picked_up')", [orderId])).rows[0].n);

  before(async () => {
    ctx = await boot();
    // This file places ~100 orders and every order reserves stock; the seed never resets it, so give it headroom and put it back
    // afterwards — otherwise it would starve every integration file that runs after it.
    stockBefore = (await q("SELECT id, on_hand, reserved FROM inventory WHERE product_id = 'paracetamol-500'")).rows;
    await q("UPDATE inventory SET on_hand = on_hand + 5000 WHERE product_id = 'paracetamol-500'");
    cust = await login(await makeUser(ctx.container));
    warehouse = await login(await makeUser(ctx.container, { roles: ["warehouse"] }));
    admin = await login(await makeUser(ctx.container, { roles: ["admin"] }));
    addressId = (await ctx.request.post("/api/addresses").set(cust).send({ name: "Alex Morgan", phone: "+1 555 0190", line1: "24 Maple Court", city: "Metro City", zip: "10245" })).body.data.address.id;
  });
  after(async () => {
    for (const r of stockBefore ?? []) await q("UPDATE inventory SET on_hand = $2, reserved = $3 WHERE id = $1", [r.id, r.on_hand, r.reserved]);
    await ctx?.close();
  });

  it("several riders racing for ONE order: exactly one wins, the rest get a safe 409, one active delivery exists", async () => {
    const riders = []; for (let i = 0; i < 6; i++) riders.push(await makeRider());
    const orderId = await packedOrder();
    const res = await Promise.all(riders.map((r) => ctx.request.post(`/api/rider/orders/${orderId}/claim`).set(r.token)));
    const statuses = res.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409], JSON.stringify(res.map((r) => r.body)));
    for (const r of res.filter((x) => x.status === 409)) {
      assert.match(r.body.message, /already assigned|no longer available|already have/i);
      assert.ok(!/constraint|violates|deadlock|relation|pg_/i.test(JSON.stringify(r.body)), "no database internals in the response");
    }
    assert.equal(await activeCount(orderId), 1);
  });

  it("dispatcher assign racing rider claim on the same orders (opposite lock directions) never deadlocks", async () => {
    const results = [];
    for (let round = 0; round < 12; round++) {
      const a = await makeRider(); const b = await makeRider(); // fresh riders each round so capacity never masks a lock problem
      const orderId = await packedOrder();
      const [x, y, z] = await Promise.all([ // eslint-disable-line
        ctx.request.post(`/api/delivery/orders/${orderId}/assign`).set(admin).send({ riderId: a.id }),
        ctx.request.post(`/api/rider/orders/${orderId}/claim`).set(b.token),
        ctx.request.post(`/api/delivery/orders/${orderId}/assign`).set(admin).send({ riderId: b.id }),
      ]);
      results.push(x, y, z);
      assert.equal(await activeCount(orderId), 1, `round ${round}: ${JSON.stringify([x, y, z].map((r) => [r.status, r.body.code, r.body.message]))}`);
    }
    for (const r of results) {
      assert.ok([200, 201, 409].includes(r.status), `unexpected ${r.status}: ${JSON.stringify(r.body)}`);
      assert.notEqual(r.body.code, "DELIVERY_BUSY", "a deadlock / lock timeout surfaced — lock order is inconsistent");
      assert.notEqual(r.body.code, "TRANSACTION_CONFLICT");
    }
  });

  it("reassign racing claim and decline never deadlocks and never leaves two active deliveries", async () => {
    for (let round = 0; round < 8; round++) {
      const a = await makeRider(); const b = await makeRider(); const c = await makeRider();
      const orderId = await packedOrder();
      const first = await ctx.request.post(`/api/delivery/orders/${orderId}/assign`).set(admin).send({ riderId: a.id });
      const deliveryId = first.body.data.delivery.id;
      const res = await Promise.all([
        ctx.request.post(`/api/delivery/deliveries/${deliveryId}/reassign`).set(admin).send({ riderId: b.id }),
        ctx.request.post(`/api/rider/orders/${orderId}/claim`).set(c.token),
        ctx.request.post(`/api/rider/deliveries/${deliveryId}/decline`).set(a.token).send({}),
        ctx.request.post(`/api/delivery/deliveries/${deliveryId}/unassign`).set(admin).send({}),
      ]);
      for (const r of res) {
        assert.ok(r.status < 500, `5xx: ${JSON.stringify(r.body)}`);
        assert.notEqual(r.body.code, "DELIVERY_BUSY");
      }
      assert.ok(await activeCount(orderId) <= 1, `round ${round}`);
    }
  });

  it("capacity holds under a race: a rider can't exceed the limit by claiming many orders at once", async () => {
    const r = await makeRider();
    const orders = [];
    // Sequential on purpose: placing orders concurrently contends on inventory rows (an order-placement concern, not delivery's).
    for (let i = 0; i < DELIVERY_RULES.maxActivePerRider + 3; i++) orders.push(await packedOrder());
    const res = await Promise.all(orders.map((id) => ctx.request.post(`/api/rider/orders/${id}/claim`).set(r.token)));
    assert.equal(res.filter((x) => x.status === 201).length, DELIVERY_RULES.maxActivePerRider);
    assert.ok(res.filter((x) => x.status !== 201).every((x) => x.status === 409 && x.body.code === "RIDER_BUSY"));
    const mine = await ctx.request.get("/api/rider/me").set(r.token);
    assert.equal(mine.body.data.rider.activeCount, DELIVERY_RULES.maxActivePerRider);
    assert.equal(mine.body.data.rider.state, "at_capacity");
  });

  it("the database itself refuses a second active delivery for an order", async () => {
    const r = await makeRider(); const orderId = await packedOrder();
    await ctx.request.post(`/api/rider/orders/${orderId}/claim`).set(r.token);
    await assert.rejects(q("INSERT INTO deliveries (order_id, rider_id, status) VALUES ($1,$2,'assigned')", [orderId, r.id]), { code: "23505" });
  });

  describe("revocation is immediate", () => {
    it("removing the delivery role: 403 on every rider route at once, off duty, can't be assigned, can be unassigned", async () => {
      const r = await makeRider(); const orderId = await packedOrder();
      const first = await ctx.request.post(`/api/delivery/orders/${orderId}/assign`).set(admin).send({ riderId: r.id });
      const deliveryId = first.body.data.delivery.id;
      assert.equal((await ctx.request.get("/api/rider/me").set(r.token)).status, 200);

      const res = await ctx.request.put(`/api/admin/users/${r.user.id}/roles`).set(admin).send({ roles: ["customer"] });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      for (const [method, url] of [["get", "/api/rider/me"], ["get", "/api/rider/deliveries"], ["get", "/api/rider/available-orders"], ["put", "/api/rider/me/availability"], ["post", `/api/rider/deliveries/${deliveryId}/accept`], ["post", `/api/rider/deliveries/${deliveryId}/location`], ["post", `/api/rider/orders/${orderId}/claim`]]) {
        const got = await ctx.request[method](url).set(r.token).send({ available: true, lat: 1, lng: 1 });
        assert.equal(got.status, 403, `${method} ${url}`);
        assert.equal(got.body.code, "RIDER_NOT_AUTHORIZED");
      }
      assert.equal((await q("SELECT is_available FROM riders WHERE id = $1", [r.id])).rows[0].is_available, false, "taken off duty");

      const other = await packedOrder();
      const refused = await ctx.request.post(`/api/delivery/orders/${other}/assign`).set(admin).send({ riderId: r.id });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.message, "Rider is inactive or no longer authorized for delivery.");
      assert.equal((await ctx.request.post(`/api/delivery/deliveries/${deliveryId}/unassign`).set(admin).send({})).status, 200);

      const list = (await ctx.request.get("/api/delivery/riders").set(admin)).body.data.riders.find((x) => x.id === r.id);
      assert.equal(list.state, "not_authorized"); assert.equal(list.canTakeDelivery, false);
    });

    it("suspending the user: signed out at once, off duty, shown as suspended, can't be assigned", async () => {
      const r = await makeRider();
      const res = await ctx.request.patch(`/api/admin/users/${r.user.id}/status`).set(admin).send({ status: "suspended" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal((await ctx.request.get("/api/rider/me").set(r.token)).status, 401);
      assert.equal((await q("SELECT is_available FROM riders WHERE id = $1", [r.id])).rows[0].is_available, false);
      const list = (await ctx.request.get("/api/delivery/riders").set(admin)).body.data.riders.find((x) => x.id === r.id);
      assert.equal(list.state, "suspended");
      const orderId = await packedOrder();
      assert.equal((await ctx.request.post(`/api/delivery/orders/${orderId}/assign`).set(admin).send({ riderId: r.id })).status, 409);
    });

    it("an inactive rider profile is refused for the rider and for assignment", async () => {
      const r = await makeRider();
      const patched = await ctx.request.put(`/api/delivery/riders/${r.id}`).set(admin).send({ status: "suspended" });
      assert.equal(patched.status, 200, JSON.stringify(patched.body));
      assert.equal((await ctx.request.get("/api/rider/me").set(r.token)).status, 403);
      const orderId = await packedOrder();
      assert.equal((await ctx.request.post(`/api/delivery/orders/${orderId}/assign`).set(admin).send({ riderId: r.id })).status, 409);
    });

    it("a user with the delivery role but no profile is told to ask for setup, not given a broken app", async () => {
      const u = await makeUser(ctx.container, { roles: ["delivery"] });
      const token = await login(u); // log in BEFORE building the request: supertest closes its ephemeral server after each call
      const got = await ctx.request.get("/api/rider/me").set(token);
      assert.equal(got.status, 403); assert.equal(got.body.code, "NOT_A_RIDER");
    });

    it("a parcel stranded with a suspended rider can be recovered by dispatch", async () => {
      const r = await makeRider(); const orderId = await packedOrder();
      const claimed = await ctx.request.post(`/api/rider/orders/${orderId}/claim`).set(r.token);
      const deliveryId = claimed.body.data.delivery.id;
      await ctx.request.post(`/api/rider/deliveries/${deliveryId}/pickup`).set(r.token);
      assert.equal((await ctx.request.post(`/api/delivery/deliveries/${deliveryId}/unassign`).set(admin).send({})).status, 409, "a valid rider keeps their parcel");
      await ctx.request.patch(`/api/admin/users/${r.user.id}/status`).set(admin).send({ status: "suspended" });
      assert.equal((await ctx.request.post(`/api/delivery/deliveries/${deliveryId}/unassign`).set(admin).send({})).status, 200);
      assert.equal((await q("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0].status, "packed");
    });
  });

  it("closed deliveries no longer expose the customer's street or phone in the rider's history", async () => {
    const r = await makeRider(); const orderId = await packedOrder();
    const claimed = await ctx.request.post(`/api/rider/orders/${orderId}/claim`).set(r.token);
    const id = claimed.body.data.delivery.id;
    assert.match(JSON.stringify((await ctx.request.get("/api/rider/deliveries").set(r.token)).body), /Maple/, "open: visible");
    await ctx.request.post(`/api/rider/deliveries/${id}/decline`).set(r.token).send({});
    const hist = JSON.stringify((await ctx.request.get("/api/rider/deliveries?scope=history").set(r.token)).body);
    assert.ok(hist.includes(id), "still in history");
    assert.ok(!hist.includes("Maple") && !hist.includes("555 0190"), "closed: contact details gone");
  });
});
