import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { boot, loginAs, makeUser, skipReason } from "./helpers.js";

/**
 * Live order tracking against the real API + real Postgres, with real Server-Sent-Event streams over real HTTP.
 * A second app instance is booted too: it proves a change made through ONE instance reaches a stream held by ANOTHER
 * (Postgres LISTEN/NOTIFY) — the thing an in-memory pub/sub silently gets wrong behind a load balancer.
 */
describe("live order tracking (real Postgres, real SSE)", { skip: skipReason }, () => {
  const GROCERY = "greek-yogurt";                       // seller: fresh-grocers
  const STORE = { lat: 27.7172, lng: 85.324 };
  const HOME = { lat: 27.7, lng: 85.3333 };
  let ctx, ctx2, server, base;
  let cust, other, warehouse, admin, riderT, shop, otherShop, riderUserId, custId, ownerIds, addressId;
  const auth = (t) => ({ Authorization: `Bearer ${t}` });
  const api = (who, method, path, body) => ctx.request[method](`/api${path}`).set(who).send(body);

  /** Opens an SSE stream and collects its events. */
  function openStream(token, orderId, root = base) {
    const ac = new AbortController();
    const events = []; let status = null; let closed = false; let body = null;
    const done = (async () => {
      try {
        const res = await fetch(`${root}/api/orders/${orderId}/tracking/stream`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal });
        status = res.status;
        if (!(res.headers.get("content-type") || "").includes("text/event-stream")) { body = await res.json(); return; }
        const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /^event: (.+)$/m.exec(block)?.[1]; const data = /^data: (.+)$/m.exec(block)?.[1];
            if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : null });
          }
        }
      } catch { /* aborted */ } finally { closed = true; }
    })();
    return {
      events, get status() { return status; }, get closed() { return closed; }, get body() { return body; }, done,
      last: () => events.filter((e) => e.event === "tracking").at(-1)?.data,
      stages: () => [...new Set(events.filter((e) => e.event === "tracking").map((e) => e.data.stage.id))],
      close: () => ac.abort(),
    };
  }
  const until = async (pred, label, ms = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (pred()) return; await new Promise((r) => setTimeout(r, 25)); }
    assert.fail(`timed out waiting for: ${label}`);
  };

  async function packedOrder() {
    const o = await api(cust, "post", "/orders", { items: [{ productId: GROCERY, qty: 1 }], addressId, paymentMethod: "cod", deliveryOptionId: "standard" });
    assert.equal(o.status, 201, JSON.stringify(o.body));
    const id = o.body.data.order.id;
    for (const s of ["confirmed", "preparing", "packed"]) assert.equal((await api(warehouse, "post", `/orders/${id}/status`, { status: s })).status, 200);
    return id;
  }

  before(async () => {
    ctx = await boot(); ctx2 = await boot();
    server = http.createServer(ctx.app); await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
    const login = async (u) => auth((await loginAs(ctx.request, u)).token);
    const c = await makeUser(ctx.container); custId = c.id;
    const o = await makeUser(ctx.container); const w = await makeUser(ctx.container, { roles: ["warehouse"] });
    const a = await makeUser(ctx.container, { roles: ["admin"] });
    const so = await makeUser(ctx.container, { roles: ["customer", "seller"] }); const so2 = await makeUser(ctx.container, { roles: ["customer", "seller"] });
    const ru = await makeUser(ctx.container); riderUserId = ru.id; ownerIds = [so.id, so2.id];
    await ctx.container.pool.query("UPDATE inventory SET on_hand = 5000, reserved = 0 WHERE product_id = $1 AND branch_id = 'store-01' AND variant_id IS NULL", [GROCERY]);
    await ctx.container.pool.query("UPDATE sellers SET owner_user_id = $1 WHERE id = 'fresh-grocers'", [so.id]);
    await ctx.container.pool.query("UPDATE sellers SET owner_user_id = $1 WHERE id = 'auralux-beauty'", [so2.id]);
    [cust, other, warehouse, admin, shop, otherShop] = [await login(c), await login(o), await login(w), await login(a), await login(so), await login(so2)];
    assert.equal((await api(admin, "post", "/delivery/riders", { userId: ru.id, phone: "+977 9800000001", vehicle: "Scooter · BA 1 PA 1" })).status, 201);
    riderT = await login(ru);
    assert.equal((await api(riderT, "put", "/rider/me/availability", { available: true })).status, 200);
    assert.equal((await api(admin, "put", "/delivery/branches/store-01/location", STORE)).status, 200);
    addressId = (await api(cust, "post", "/addresses", { name: "Alex Morgan", phone: "+977 9800000002", line1: "24 Maple Court", city: "Kathmandu", ...HOME })).body.data.address.id;
  });
  after(async () => {
    await ctx.container.pool.query("UPDATE sellers SET owner_user_id = NULL WHERE owner_user_id = ANY($1)", [ownerIds]);
    server?.closeAllConnections?.(); await new Promise((r) => server?.close(r));
    await ctx.container.services.realtime.stop(); await ctx2.container.services.realtime.stop();
    await ctx?.close(); await ctx2?.close();
  });

  // ------------------------------------------------------------------------------------------------------- schema
  it("migration 015 adds the coordinates, ETA and progress columns, and the delivery_tracking view with the spec's field names", async () => {
    const cols = async (t) => (await ctx.container.pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = $1", [t])).rows.map((r) => r.column_name);
    for (const c of ["pickup_lat", "pickup_lng", "customer_lat", "customer_lng", "estimated_arrival", "eta_source", "arrived_pickup_at", "started_at", "last_lat", "last_lng", "last_located_at"]) assert.ok((await cols("deliveries")).includes(c), c);
    assert.deepEqual((await cols("addresses")).filter((c) => ["lat", "lng"].includes(c)).sort(), ["lat", "lng"]);
    assert.deepEqual((await cols("branches")).filter((c) => ["lat", "lng"].includes(c)).sort(), ["lat", "lng"]);
    const view = await cols("delivery_tracking");
    for (const c of ["order_id", "seller_id", "customer_id", "delivery_partner_id", "pickup_latitude", "pickup_longitude", "customer_latitude", "customer_longitude",
      "current_latitude", "current_longitude", "delivery_status", "estimated_arrival", "last_location_update"]) assert.ok(view.includes(c), `view has ${c}`);
  });

  it("a map pin on an address is validated, saved, kept across edits that don't mention it, and clearable", async () => {
    const mk = (extra) => api(cust, "post", "/addresses", { name: "Pin Test", phone: "+977 9800000003", line1: "1 Test Rd", ...extra });
    assert.equal((await mk({ lat: 91, lng: 0 })).status, 400);
    assert.equal((await mk({ lat: 10 })).status, 400, "a pin needs both coordinates");
    const made = await mk({ lat: 27.7, lng: 85.3 });
    assert.equal(made.status, 201); assert.equal(made.body.data.address.lat, 27.7);
    const id = made.body.data.address.id;
    const text = { name: "Pin Test", phone: "+977 9800000003", line1: "2 Changed Rd" };
    assert.equal((await api(cust, "put", `/addresses/${id}`, text)).body.data.address.lat, 27.7, "an edit that omits the pin keeps it");
    const cleared = (await api(cust, "put", `/addresses/${id}`, { ...text, lat: null, lng: null })).body.data.address;
    assert.deepEqual([cleared.lat, cleared.lng], [null, null]);
    await api(cust, "delete", `/addresses/${id}`);
  });

  it("an order snapshots the pin, so later address edits cannot move its destination", async () => {
    const id = await packedOrder();
    assert.equal((await api(cust, "get", `/orders/${id}`)).body.data.order.shipTo.lat, HOME.lat);
    await api(cust, "put", `/addresses/${addressId}`, { name: "Alex Morgan", phone: "+977 9800000002", line1: "24 Maple Court", city: "Kathmandu", lat: 1, lng: 1 });
    assert.equal((await api(cust, "get", `/orders/${id}`)).body.data.order.shipTo.lat, HOME.lat);
    await api(cust, "put", `/addresses/${addressId}`, { name: "Alex Morgan", phone: "+977 9800000002", line1: "24 Maple Court", city: "Kathmandu", ...HOME });
  });

  // ------------------------------------------------------------------------------------------------------- the whole run
  it("the customer's stream receives every step, the rider's live position, the ETA and the end — without any refresh", async () => {
    const o = await api(cust, "post", "/orders", { items: [{ productId: GROCERY, qty: 1 }], addressId, paymentMethod: "cod", deliveryOptionId: "standard" });
    const id = o.body.data.order.id;
    const s = openStream(cust.Authorization.slice(7), id);
    await until(() => s.last(), "initial snapshot");
    assert.equal(s.status, 200);
    assert.equal(s.last().stage.id, "confirmed"); assert.equal(s.last().stage.label, "Order placed");

    await api(warehouse, "post", `/orders/${id}/status`, { status: "confirmed" });
    await until(() => s.last().stage.label === "Confirmed", "confirmed pushed");
    await api(warehouse, "post", `/orders/${id}/status`, { status: "preparing" });
    await until(() => s.last().stage.id === "preparing", "preparing pushed");
    await api(warehouse, "post", `/orders/${id}/status`, { status: "packed" });
    await until(() => /finding a delivery partner/i.test(s.last().stage.detail), "packed pushed");

    const claim = await api(riderT, "post", `/rider/orders/${id}/claim`);
    assert.equal(claim.status, 201);
    const did = claim.body.data.delivery.id;
    await until(() => s.last().stage.id === "partner_assigned", "partner assigned pushed");
    assert.equal(s.last().delivery.rider.name.startsWith("IT "), true);
    assert.equal(s.last().live, false, "no position yet");
    assert.deepEqual([s.last().pickup.lat, s.last().pickup.lng], [STORE.lat, STORE.lng]);
    assert.deepEqual(s.last().destination, HOME);
    assert.ok(s.last().eta.minutes >= 1 && s.last().eta.at, "an ETA exists as soon as a partner is assigned");

    // Rider heads to the store and shares position: the customer sees it right away.
    assert.equal((await api(riderT, "post", `/rider/deliveries/${did}/location`, { lat: 27.71, lng: 85.33, accuracy: 8 })).body.data.accepted, true);
    await until(() => s.last().live === true, "live position pushed while heading to the store");
    assert.deepEqual([s.last().delivery.location.lat, s.last().delivery.location.lng], [27.71, 85.33]);

    await api(riderT, "post", `/rider/deliveries/${did}/arrived`);
    await until(() => /arrived at the store/i.test(s.last().stage.detail), "arrived pushed");
    await api(riderT, "post", `/rider/deliveries/${did}/pickup`);
    await until(() => s.last().stage.id === "picked_up", "picked up pushed");
    await api(riderT, "post", `/rider/deliveries/${did}/start`);
    await until(() => s.last().stage.id === "on_the_way", "on the way pushed");

    await new Promise((r) => setTimeout(r, DELIVERY_PING_GAP));
    await api(riderT, "post", `/rider/deliveries/${did}/location`, { lat: 27.705, lng: 85.331 });
    await until(() => s.last().delivery?.location?.lat === 27.705, "moved position pushed");

    const order = (await api(cust, "get", `/orders/${id}`)).body.data.order;
    assert.equal(order.delivery.stage.id, "on_the_way", "the order DTO carries the same stage the stream does");
    const done = await api(riderT, "post", `/rider/deliveries/${did}/deliver`, { otp: order.otp, cashCollected: order.totals.total });
    assert.equal(done.status, 200);
    await until(() => s.closed, "stream closed after delivery");
    assert.equal(s.last().stage.id, "delivered"); assert.equal(s.last().final, true);
    assert.equal(s.last().delivery, null); assert.equal(s.last().live, false);
    assert.deepEqual(s.stages(), ["confirmed", "preparing", "partner_assigned", "picked_up", "on_the_way", "delivered"], "all six steps, in order");

    // after the run: nothing is shared or kept
    assert.equal((await api(riderT, "post", `/rider/deliveries/${did}/location`, { lat: 1, lng: 1 })).status, 409);
    const left = await ctx.container.pool.query("SELECT last_lat, customer_lat, (SELECT count(*) FROM delivery_locations WHERE delivery_id = $1)::int AS trail FROM deliveries WHERE id = $1", [did]);
    assert.deepEqual([left.rows[0].last_lat, left.rows[0].customer_lat, left.rows[0].trail], [null, null, 0]);
    // a new connection to a finished order gets one final snapshot and then ends
    const late = openStream(cust.Authorization.slice(7), id);
    await until(() => late.closed, "finished order stream ends at once");
    assert.equal(late.last().final, true);

    // the spec's tracking record, as a view over the same tables
    const v = (await ctx.container.pool.query("SELECT * FROM delivery_tracking WHERE order_id = $1", [id])).rows[0];
    assert.equal(v.customer_id, custId); assert.equal(v.seller_id, "fresh-grocers"); assert.equal(v.delivery_status, "delivered");
    assert.ok(v.delivery_partner_id);
  });

  // ------------------------------------------------------------------------------------------------------- who may listen
  it("access control on the stream: owner, dispatch and the order's own shop only — everyone else gets a plain 404 and no stream", async () => {
    const id = await packedOrder();
    const claim = await api(riderT, "post", `/rider/orders/${id}/claim`); const did = claim.body.data.delivery.id;
    await api(riderT, "post", `/rider/deliveries/${did}/location`, { lat: 27.71, lng: 85.33 });

    const open = (who) => openStream(who.Authorization.slice(7), id);
    const denied = [open(other), open(otherShop), open(riderT)];                // another customer, another shop, even the assigned rider
    await Promise.all(denied.map((d) => d.done));
    for (const d of denied) { assert.equal(d.status, 404); assert.equal(d.body.code, "ORDER_NOT_FOUND"); assert.equal(d.events.length, 0); }
    assert.equal((await fetch(`${base}/api/orders/${id}/tracking/stream`)).status, 401, "no token → 401");

    const mine = open(cust); const seller = open(shop); const disp = open(admin);
    await until(() => mine.last() && seller.last() && disp.last(), "three authorised snapshots");
    assert.equal(mine.last().live, true); assert.deepEqual(mine.last().destination, HOME); assert.ok(mine.last().delivery.rider.phone);
    assert.equal(disp.last().live, true);
    assert.equal(seller.last().live, false, "the shop never receives the rider's position");
    assert.equal(seller.last().delivery.location, null); assert.equal(seller.last().destination, null);
    assert.equal(seller.last().delivery.rider.phone, undefined);
    assert.ok(!JSON.stringify(seller.last()).includes("27.71"), "no coordinates leak into the shop's view, anywhere");
    for (const s of [mine, seller, disp]) s.close();

    // and the plain GET is gated identically
    assert.equal((await api(other, "get", `/orders/${id}/tracking`)).status, 404);
    assert.equal((await api(otherShop, "get", `/orders/${id}/tracking`)).status, 404);
    assert.equal((await api(shop, "get", `/orders/${id}/tracking`)).status, 200);
  });

  it("only the assigned rider can ping, only while the run is active; a stranger rider cannot share on someone else's delivery", async () => {
    const id = await packedOrder();
    const did = (await api(riderT, "post", `/rider/orders/${id}/claim`)).body.data.delivery.id;
    const intruder = await makeUser(ctx.container); await api(admin, "post", "/delivery/riders", { userId: intruder.id, phone: "+977 9800000009", vehicle: "Bike" });
    const intruderT = auth((await loginAs(ctx.request, intruder)).token);
    for (const path of ["location", "arrived", "start"]) assert.equal((await api(intruderT, "post", `/rider/deliveries/${did}/${path}`, { lat: 1, lng: 1 })).status, 404, path);
    assert.equal((await api(cust, "post", `/rider/deliveries/${did}/location`, { lat: 1, lng: 1 })).status, 403);
    assert.equal((await api(riderT, "post", `/rider/deliveries/${did}/location`, { lat: 200, lng: 1 })).status, 400, "out-of-range coordinates are refused");
    await api(riderT, "post", `/rider/deliveries/${did}/decline`, {});           // hand it back so later tests find a clean queue
  });

  // ------------------------------------------------------------------------------------------------------- the shop
  it("a shop can request delivery for its own packed order: on-duty riders are notified, and it cannot be spammed", async () => {
    const id = await packedOrder();
    assert.equal((await api(otherShop, "post", `/orders/${id}/request-delivery`)).status, 404);
    assert.equal((await api(cust, "post", `/orders/${id}/request-delivery`)).status, 404);
    const ok = await api(shop, "post", `/orders/${id}/request-delivery`);
    assert.equal(ok.status, 200); assert.ok(ok.body.data.notified >= 1);
    const inbox = (await api(riderT, "get", "/notifications")).body.data.notifications;
    assert.ok(inbox.some((n) => n.type === "rider.delivery_requested" && n.data?.orderId === id), "the rider got it");
    assert.ok(!JSON.stringify(inbox.filter((n) => n.type === "rider.delivery_requested")).includes("Maple"), "no address in the notification");
    const again = await api(shop, "post", `/orders/${id}/request-delivery`);
    assert.equal(again.status, 409); assert.equal(again.body.code, "ALREADY_REQUESTED");
  });

  it("the order list tells a shop each order's delivery progress without a request per order", async () => {
    const id = await packedOrder();
    const list = (await api(shop, "get", "/orders")).body.data.orders;
    assert.equal(list.find((o) => o.id === id).delivery.stage.id, "preparing");
  });

  it("dispatch roles (delivery:manage) can set a branch's pickup location; customers and shop owners cannot; bad coordinates are refused", async () => {
    assert.equal((await api(warehouse, "put", "/delivery/branches/store-01/location", STORE)).status, 200, "warehouse is dispatch");
    for (const who of [cust, shop, riderT]) assert.equal((await api(who, "put", "/delivery/branches/store-01/location", { lat: 1, lng: 1 })).status, 403);
    assert.equal((await api(admin, "put", "/delivery/branches/store-01/location", { lat: 100, lng: 1 })).status, 400);
    assert.equal((await api(admin, "put", "/delivery/branches/nope/location", { lat: 1, lng: 1 })).status, 404);
    const { rows } = await ctx.container.pool.query("SELECT lat, lng FROM branches WHERE id = 'store-01'");
    assert.deepEqual([rows[0].lat, rows[0].lng], [STORE.lat, STORE.lng], "refused requests changed nothing");
  });

  // ------------------------------------------------------------------------------------------------------- scale-out + limits
  it("a change made through ANOTHER app instance reaches this instance's stream (Postgres LISTEN/NOTIFY)", async () => {
    const id = await packedOrder();
    const s = openStream(cust.Authorization.slice(7), id);          // held by instance #1
    await until(() => s.last(), "snapshot");
    assert.equal(s.last().stage.id, "preparing");
    const did = (await ctx2.request.post(`/api/rider/orders/${id}/claim`).set(riderT)).body.data.delivery.id;   // mutation through instance #2
    await until(() => s.last().stage.id === "partner_assigned", "cross-instance push");
    await ctx2.request.post(`/api/rider/deliveries/${did}/decline`).set(riderT).send({});
    await until(() => s.last().stage.id === "preparing", "cross-instance push back to preparing");
    s.close();
  });

  it("a rolled-back change is never announced (NOTIFY is delivered on commit only)", async () => {
    const id = await packedOrder();
    const s = openStream(cust.Authorization.slice(7), id);
    await until(() => s.last(), "snapshot");
    const before = s.events.length;
    const client = await ctx.container.pool.connect();
    try {
      await client.query("BEGIN");
      await ctx.container.services.realtime.publish(client, id);
      await client.query("ROLLBACK");
    } finally { client.release(); }
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(s.events.length, before, "nothing was pushed for the rolled-back change");
    s.close();
  });

  it("a user is limited to a handful of open streams, so one client cannot exhaust the server", async () => {
    const id = await packedOrder();
    const streams = Array.from({ length: 7 }, () => openStream(cust.Authorization.slice(7), id));
    await until(() => streams.some((x) => x.events.some((e) => e.event === "error")), "limit reached");
    const refused = streams.filter((x) => x.events.some((e) => e.event === "error"));
    assert.equal(refused.length, 1);
    assert.equal(refused[0].events.find((e) => e.event === "error").data.code, "TOO_MANY_STREAMS");
    for (const x of streams) x.close();
  });
});

const DELIVERY_PING_GAP = 5200; // DELIVERY_RULES.locationMinIntervalMs (5s) — pings closer together are dropped on purpose
