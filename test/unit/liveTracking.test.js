import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { DELIVERY_RULES } from "../../src/config/delivery.js";
import { stageOf, stepsFor, canShareLocation, TRACKING_STEPS } from "../../src/domain/tracking.js";
import { createCouponsService } from "../../src/services/coupons.service.js";
import { createDeliveryService } from "../../src/services/delivery.service.js";
import { createOrdersService } from "../../src/services/orders.service.js";
import { createPricingService } from "../../src/services/pricing.service.js";
import { createRealtime } from "../../src/services/realtime.service.js";
import { createRoutingService, estimateLocal, haversineKm } from "../../src/services/routing.service.js";
import { createDeliveryCodes } from "../../src/utils/deliveryCode.js";
import { customer, sellerMedico, sellerNova, staffOrders } from "../helpers/commerceFakes.js";
import { createFakeDelivery, dispatcher, riderActor } from "../helpers/deliveryFakes.js";
import { fakeAudit } from "../helpers/fakes.js";
import { recordingNotifications } from "../helpers/notificationFakes.js";

const ctx = { ip: "203.0.113.5", requestId: "r" };
const codes = createDeliveryCodes(Buffer.alloc(32, 7).toString("base64"));
const STORE = { lat: 27.7172, lng: 85.324 };       // seeded branch (commerceFakes)
const HOME = { lat: 27.7, lng: 85.3333 };          // the customer's pin

// ------------------------------------------------------------------------------------------------ pure stage logic
describe("customer-facing stages", () => {
  const stage = (status, d) => stageOf(status, d).id;

  it("maps every order status (and the active delivery) onto the six customer steps", () => {
    assert.deepEqual(TRACKING_STEPS.map((s) => s.label), ["Confirmed", "Preparing", "Delivery partner assigned", "Picked up", "On the way", "Delivered"]);
    assert.equal(stage("placed"), "confirmed");
    assert.equal(stage("confirmed"), "confirmed");
    assert.equal(stage("preparing"), "preparing");
    assert.equal(stage("packed"), "preparing");
    assert.equal(stage("assigned", { status: "assigned" }), "partner_assigned");
    assert.equal(stage("assigned", { status: "accepted" }), "partner_assigned");
    assert.equal(stage("out_for_delivery", { status: "picked_up", started_at: null }), "picked_up");
    assert.equal(stage("out_for_delivery", { status: "picked_up", started_at: new Date() }), "on_the_way");
    assert.equal(stage("delivered"), "delivered");
  });

  it("a placed order is not shown as 'Confirmed' — it says it is waiting", () => {
    assert.equal(stageOf("placed").label, "Order placed");
    assert.match(stageOf("placed").detail, /waiting/i);
  });

  it("cancelled / returned are terminal and sit outside the six steps", () => {
    for (const s of ["cancelled", "returned"]) {
      const st = stageOf(s);
      assert.equal(st.terminal, true); assert.equal(st.index, -1);
      assert.ok(stepsFor(st).every((x) => x.state === "upcoming"));
    }
  });

  it("steps are done / current / upcoming around the current stage; delivered completes everything", () => {
    assert.deepEqual(stepsFor(stageOf("preparing")).map((s) => s.state), ["done", "current", "upcoming", "upcoming", "upcoming", "upcoming"]);
    assert.ok(stepsFor(stageOf("delivered")).every((s) => s.state === "done"));
  });

  it("the partner may share location only while accepted or picked up", () => {
    assert.deepEqual(["assigned", "accepted", "picked_up", "delivered", "failed", "cancelled"].map(canShareLocation), [false, true, true, false, false, false]);
  });
});

// ------------------------------------------------------------------------------------------------ ETA / routing
describe("ETA estimation", () => {
  it("haversine distance is right to within a few metres and the local estimate scales with distance", () => {
    assert.ok(Math.abs(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) - 111.19) < 0.1);
    const near = estimateLocal([STORE, HOME]); const far = estimateLocal([STORE, { lat: STORE.lat + 0.2, lng: STORE.lng }]);
    assert.equal(near.source, "estimate");
    assert.ok(far.minutes > near.minutes && near.minutes >= 1);
  });

  it("uses the routing API when it answers, labelled 'route'", async () => {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(url); return { ok: true, json: async () => ({ routes: [{ duration: 725 }] }) }; };
    const eta = await createRoutingService({ accessToken: "sk.test", fetchImpl }).eta([STORE, HOME]);
    assert.deepEqual(eta, { minutes: 12, source: "route" });
    assert.match(calls[0], /directions\/v5\/mapbox\/driving\/85\.324000,27\.717200;85\.333300,27\.700000/);
  });

  it("falls back to the labelled estimate on an API error, a timeout, or when there is no token — never throws", async () => {
    const bad = [async () => ({ ok: false }), async () => { throw new Error("boom"); }, async () => ({ ok: true, json: async () => ({ routes: [] }) })];
    for (const fetchImpl of bad) assert.equal((await createRoutingService({ accessToken: "sk.test", fetchImpl }).eta([STORE, HOME])).source, "estimate");
    assert.equal((await createRoutingService({ accessToken: "" }).eta([STORE, HOME])).source, "estimate");
    assert.equal(await createRoutingService().eta([STORE]), null);
  });
});

// ------------------------------------------------------------------------------------------------ service-level behaviour
function makeClock(start = new Date()) { // starts at the real "now": the in-memory event log stamps real time, so the two must agree
  let t = new Date(start).getTime();
  const clock = () => new Date(t); clock.advance = (ms) => { t += ms; };
  return clock;
}

function setup({ routing } = {}) {
  const fake = createFakeDelivery();
  const { db, key } = fake;
  for (const p of ["soap", "cough-syrup", "bandage"]) db.inventory.set(key("store-01", p, ""), { id: key("store-01", p, ""), on_hand: 20, reserved: 0 });
  db.addresses.push({ id: "addr-1", user_id: customer.id, label: "Home", name: "Alex", phone: "+1 555 0190", line1: "24 Maple Ct", city: "Metro", zip: "10245", is_default: true, ...HOME });
  for (const [uid, name] of [["u-r1", "Daniel R."], ["u-r2", "Priya S."]]) db.users.set(uid, { name, status: "active" });
  const published = [];
  const realtime = { publish: async (_db, orderId) => { published.push(orderId); }, subscribe: async () => () => {}, stop: async () => {} };
  const clock = makeClock(); const audit = fakeAudit(); const notifications = recordingNotifications();
  const withTx = (fn) => fn({});
  const pricing = createPricingService({ repos: fake.repos, coupons: createCouponsService({ repos: fake.repos }) });
  const prescriptions = { assertCoverage: async () => [], linkToOrder: async () => {} };
  const orders = createOrdersService({ pool: {}, withTx, repos: fake.repos, pricing, audit, prescriptions, payments: fake.payments, codes, notifications, realtime });
  const delivery = createDeliveryService({ pool: {}, withTx, repos: fake.repos, audit, payments: fake.payments, codes, notifications, clock, realtime, routing });
  return { ...fake, audit, clock, orders, delivery, notifications, published };
}

async function packedOrder(e, items = [{ productId: "soap", qty: 1 }]) {
  const o = await e.orders.create(customer, { items, addressId: "addr-1", paymentMethod: "cod", deliveryOptionId: "standard" }, ctx);
  for (const status of ["confirmed", "preparing", "packed"]) await e.orders.advance(staffOrders, o.id, { status }, ctx);
  return o;
}
const makeRider = async (e, userId) => {
  const rider = await e.delivery.createRider(dispatcher, { userId, phone: "+1 555 0231", vehicle: "Scooter · MC-4418" }, ctx);
  await e.delivery.setAvailability(riderActor(userId), true);
  return rider;
};
const R1 = riderActor("u-r1");

describe("the delivery run, as the customer sees it", () => {
  let e, o, r1, d;
  beforeEach(async () => {
    e = setup(); r1 = await makeRider(e, "u-r1"); await makeRider(e, "u-r2");
    o = await packedOrder(e);
    d = await e.delivery.assign(dispatcher, o.id, { riderId: r1.id }, ctx);
  });
  const track = () => e.delivery.tracking(customer, o.id);

  it("walks Confirmed → … → Delivered, with each rider action moving the customer's stage", async () => {
    assert.equal((await track()).stage.id, "partner_assigned");
    assert.match((await track()).stage.detail, /accept/i);

    await e.delivery.accept(R1, d.id, ctx);
    assert.match((await track()).stage.detail, /heading to the store/i);

    await e.delivery.arrived(R1, d.id);
    assert.match((await track()).stage.detail, /arrived at the store/i);
    assert.equal((await track()).stage.id, "partner_assigned");

    await e.delivery.pickup(R1, d.id, ctx);
    assert.equal((await track()).stage.id, "picked_up");

    await e.delivery.start(R1, d.id);
    assert.equal((await track()).stage.id, "on_the_way");

    const code = codes.codeFor(o.id, e.db.orders.find((x) => x.id === o.id).otp_nonce);
    await e.delivery.deliver(R1, d.id, { otp: code, cashCollected: Number(e.db.orders.find((x) => x.id === o.id).total) }, ctx);
    const done = await track();
    assert.equal(done.stage.id, "delivered");
    assert.equal(done.final, true);
  });

  it("actions are ordered and idempotent: arrive needs accept, start needs pickup, repeating is harmless", async () => {
    await assert.rejects(e.delivery.arrived(R1, d.id), { code: "NOT_ACCEPTED" });
    await e.delivery.accept(R1, d.id, ctx);
    await assert.rejects(e.delivery.start(R1, d.id), { code: "NOT_PICKED_UP" });
    await e.delivery.arrived(R1, d.id); await e.delivery.arrived(R1, d.id);
    assert.equal(e.db.events.filter((x) => x.type === "arrived_pickup").length, 1);
    await e.delivery.pickup(R1, d.id, ctx);
    await assert.rejects(e.delivery.arrived(R1, d.id), { code: "NOT_ACCEPTED" });
    await e.delivery.start(R1, d.id); await e.delivery.start(R1, d.id);
    assert.equal(e.db.events.filter((x) => x.type === "started").length, 1);
  });

  it("another rider cannot touch someone else's run", async () => {
    await e.delivery.accept(R1, d.id, ctx);
    const other = riderActor("u-r2");
    for (const act of [() => e.delivery.arrived(other, d.id), () => e.delivery.start(other, d.id), () => e.delivery.updateLocation(other, d.id, { lat: 1, lng: 1 })]) {
      await assert.rejects(act(), { code: "DELIVERY_NOT_FOUND" });
    }
  });

  it("shows the live position while the run is active — including on the way to the store — and clears it when the run ends", async () => {
    await e.delivery.accept(R1, d.id, ctx);
    await e.delivery.updateLocation(R1, d.id, { lat: 27.71, lng: 85.33, accuracy: 9 });
    const t = await track();
    assert.equal(t.live, true);
    assert.equal(t.delivery.location.lat, 27.71);
    assert.deepEqual(t.pickup, { ...STORE, name: "Vyra Central" });
    assert.deepEqual(t.destination, HOME);
    assert.equal(t.delivery.rider.name, "Daniel R.");
    assert.equal(t.delivery.rider.phone, "+1 555 0231");

    await e.delivery.pickup(R1, d.id, ctx); await e.delivery.start(R1, d.id);
    const code = codes.codeFor(o.id, e.db.orders.find((x) => x.id === o.id).otp_nonce);
    await e.delivery.deliver(R1, d.id, { otp: code, cashCollected: Number(e.db.orders.find((x) => x.id === o.id).total) }, ctx);
    const after = await track();
    assert.equal(after.live, false);
    assert.equal(after.delivery, null);          // no rider, no position, no phone once it's over
    assert.equal(after.destination, null);
    assert.equal(after.eta, null);
    assert.equal(e.db.deliveries.find((x) => x.id === d.id).customer_lat, null); // the doorstep pin is not kept
    assert.equal(e.db.locations.length, 0);
    await assert.rejects(e.delivery.updateLocation(R1, d.id, { lat: 1, lng: 1 }), { code: "NOT_TRACKING" });
  });

  it("a cancelled order is final and exposes no rider or position", async () => {
    const o2 = await e.orders.create(customer, { items: [{ productId: "soap", qty: 1 }], addressId: "addr-1", paymentMethod: "cod", deliveryOptionId: "standard" }, ctx);
    await e.orders.cancel(customer, o2.id, {}, ctx);
    const t = await e.delivery.tracking(customer, o2.id);
    assert.equal(t.stage.id, "cancelled"); assert.equal(t.final, true); assert.equal(t.delivery, null); assert.equal(t.live, false);
  });

  it("the destination is snapshotted at assignment: editing the address afterwards does not move a run in progress", async () => {
    await e.delivery.accept(R1, d.id, ctx);
    const row = e.db.orders.find((x) => x.id === o.id);
    row.address = { ...row.address, lat: 10, lng: 10 };
    assert.deepEqual((await track()).destination, HOME);
  });

  it("the first ETA comes from the stored coordinates and is mirrored onto orders.eta (one number, two readers)", async () => {
    const t = await track();
    assert.equal(t.eta.source, "estimate");
    assert.ok(t.eta.minutes >= 1);
    assert.equal(new Date(e.db.orders.find((x) => x.id === o.id).eta).getTime(), new Date(t.eta.at).getTime());
  });
});

describe("who may see what", () => {
  let e, o, r1, d;
  beforeEach(async () => {
    e = setup(); r1 = await makeRider(e, "u-r1");
    o = await packedOrder(e); // soap → novatech only
    d = await e.delivery.assign(dispatcher, o.id, { riderId: r1.id }, ctx);
    await e.delivery.accept(R1, d.id, ctx);
    await e.delivery.updateLocation(R1, d.id, { lat: 27.71, lng: 85.33 });
  });

  it("the order's own shop sees progress and the rider's name — never the rider's position, the rider's phone or the customer's pin", async () => {
    const t = await e.delivery.tracking(sellerNova, o.id);
    assert.equal(t.stage.id, "partner_assigned");
    assert.equal(t.delivery.rider.name, "Daniel R.");
    assert.equal(t.delivery.rider.phone, undefined);
    assert.equal(t.live, false); assert.equal(t.delivery.location, null);
    assert.equal(t.destination, null); assert.equal(t.pickup, null);
    assert.ok(!t.events.some((ev) => ev.note));
  });

  it("another shop, a stranger and an unauthenticated caller get 'not found' — never 'forbidden'", async () => {
    for (const who of [sellerMedico, { id: "stranger", permissions: [] }, null]) {
      await assert.rejects(e.delivery.tracking(who, o.id), { code: "ORDER_NOT_FOUND" });
    }
  });

  it("read-only staff see status but no coordinates; dispatch sees everything", async () => {
    const support = { id: "u-support", permissions: ["orders:read_all"] };
    const s = await e.delivery.tracking(support, o.id);
    assert.equal(s.live, false); assert.equal(s.delivery.location, null); assert.equal(s.destination, null);
    const disp = await e.delivery.tracking(dispatcher, o.id);
    assert.equal(disp.live, true); assert.deepEqual(disp.destination, HOME);
  });
});

describe("ETA refresh from live pings", () => {
  it("recalculates at most every etaRefreshMs, labels the source, and never lets a routing failure break the ping", async () => {
    let calls = 0; let mode = "ok";
    const routing = { eta: async (pts) => { calls++; if (mode === "throw") throw new Error("down"); return { minutes: 9, source: "route", pts }; } };
    const e = setup({ routing });
    const r1 = await makeRider(e, "u-r1"); const o = await packedOrder(e);
    const d = await e.delivery.assign(dispatcher, o.id, { riderId: r1.id }, ctx);
    await e.delivery.accept(R1, d.id, ctx);

    e.clock.advance(DELIVERY_RULES.etaRefreshMs + 1);
    await e.delivery.updateLocation(R1, d.id, { lat: 27.71, lng: 85.33 });
    assert.equal(calls, 1);
    let t = await e.delivery.tracking(customer, o.id);
    assert.equal(t.eta.source, "route"); assert.equal(t.eta.minutes, 9);

    e.clock.advance(DELIVERY_RULES.locationMinIntervalMs + 1);        // a later ping, but inside the refresh window → no second call
    await e.delivery.updateLocation(R1, d.id, { lat: 27.711, lng: 85.331 });
    assert.equal(calls, 1);

    mode = "throw"; e.clock.advance(DELIVERY_RULES.etaRefreshMs + 1);
    assert.deepEqual(await e.delivery.updateLocation(R1, d.id, { lat: 27.712, lng: 85.332 }), { accepted: true }); // still accepted
    assert.equal(calls, 2);
    t = await e.delivery.tracking(customer, o.id);
    assert.equal(t.live, true);
  });

  it("before pickup the route is here → store → customer; after pickup it is here → customer", async () => {
    const seen = [];
    const e = setup({ routing: { eta: async (pts) => { seen.push(pts.length); return { minutes: 5, source: "route" }; } } });
    const r1 = await makeRider(e, "u-r1"); const o = await packedOrder(e);
    const d = await e.delivery.assign(dispatcher, o.id, { riderId: r1.id }, ctx);
    await e.delivery.accept(R1, d.id, ctx);
    e.clock.advance(DELIVERY_RULES.etaRefreshMs + 1); await e.delivery.updateLocation(R1, d.id, { lat: 27.71, lng: 85.33 });
    await e.delivery.pickup(R1, d.id, ctx);
    e.clock.advance(DELIVERY_RULES.etaRefreshMs + 1); await e.delivery.updateLocation(R1, d.id, { lat: 27.705, lng: 85.331 });
    assert.deepEqual(seen, [3, 2]);
  });
});

describe("realtime publishing", () => {
  it("every state change announces the order id so open screens refresh — and nothing else does", async () => {
    const e = setup();
    const r1 = await makeRider(e, "u-r1");
    const o = await e.orders.create(customer, { items: [{ productId: "soap", qty: 1 }], addressId: "addr-1", paymentMethod: "cod", deliveryOptionId: "standard" }, ctx);
    assert.equal(e.published.length, 0);                                  // placing an order has no watcher yet
    for (const status of ["confirmed", "preparing", "packed"]) await e.orders.advance(staffOrders, o.id, { status }, ctx);
    assert.equal(e.published.length, 3);
    const d = await e.delivery.assign(dispatcher, o.id, { riderId: r1.id }, ctx);
    await e.delivery.accept(R1, d.id, ctx);
    await e.delivery.arrived(R1, d.id);
    await e.delivery.pickup(R1, d.id, ctx);
    await e.delivery.start(R1, d.id);
    await e.delivery.updateLocation(R1, d.id, { lat: 27.71, lng: 85.33 });
    // assign, accept, arrived, pickup, start, location = 6 (the first ping also refreshes the ETA, which announces once more)
    assert.ok(e.published.length >= 3 + 6 && e.published.length <= 3 + 7, `published ${e.published.length}`);
    assert.ok(e.published.every((id) => id === o.id));
    const before = e.published.length;
    await e.delivery.tracking(customer, o.id);                            // reads never publish
    assert.equal(e.published.length, before);
  });

  it("cancelling publishes too", async () => {
    const e = setup();
    const o = await e.orders.create(customer, { items: [{ productId: "soap", qty: 1 }], addressId: "addr-1", paymentMethod: "cod", deliveryOptionId: "standard" }, ctx);
    await e.orders.cancel(customer, o.id, {}, ctx);
    assert.equal(e.published.length, 1);
  });
});

describe("a shop requesting delivery", () => {
  it("notifies on-duty riders, once per cooldown, only for its own packed, unassigned order", async () => {
    const e = setup(); const r1 = await makeRider(e, "u-r1"); await makeRider(e, "u-r2");
    const o = await packedOrder(e);

    const res = await e.delivery.requestDelivery(sellerNova, o.id, ctx);
    assert.deepEqual(res, { requested: true, notified: 2 });
    assert.equal(e.notifications.emitted.filter((n) => n.type === "rider.delivery_requested").length, 2);
    await assert.rejects(e.delivery.requestDelivery(sellerNova, o.id, ctx), { code: "ALREADY_REQUESTED" });
    e.clock.advance(DELIVERY_RULES.requestCooldownMs + 1);
    await e.delivery.requestDelivery(sellerNova, o.id, ctx);

    await assert.rejects(e.delivery.requestDelivery(sellerMedico, o.id, ctx), { code: "ORDER_NOT_FOUND" });          // someone else's order
    await assert.rejects(e.delivery.requestDelivery(customer, o.id, ctx), { code: "ORDER_NOT_FOUND" });             // the buyer isn't the shop

    await e.delivery.assign(dispatcher, o.id, { riderId: r1.id }, ctx);
    e.clock.advance(DELIVERY_RULES.requestCooldownMs + 1);
    await assert.rejects(e.delivery.requestDelivery(sellerNova, o.id, ctx), { code: "NOT_DISPATCHABLE" });          // no longer packed
  });

  it("refuses an order that isn't packed yet and a shared basket (status is Vyra's, not one shop's)", async () => {
    const e = setup(); await makeRider(e, "u-r1");
    const early = await e.orders.create(customer, { items: [{ productId: "soap", qty: 1 }], addressId: "addr-1", paymentMethod: "cod", deliveryOptionId: "standard" }, ctx);
    await assert.rejects(e.delivery.requestDelivery(sellerNova, early.id, ctx), { code: "NOT_DISPATCHABLE" });
    const shared = await packedOrder(e, [{ productId: "soap", qty: 1 }, { productId: "bandage", qty: 1 }]); // two different shops
    await assert.rejects(e.delivery.requestDelivery(sellerNova, shared.id, ctx), { code: "ORDER_NOT_FOUND" });
  });
});

describe("branch pickup location", () => {
  it("only dispatch can set it", async () => {
    const e = setup();
    assert.deepEqual(await e.delivery.setBranchLocation(dispatcher, "store-02", { lat: 27.6, lng: 85.3 }, ctx), { id: "store-02", name: "store-02", lat: 27.6, lng: 85.3 });
    await assert.rejects(e.delivery.setBranchLocation(sellerNova, "store-02", { lat: 1, lng: 1 }, ctx), { status: 403 });
    await assert.rejects(e.delivery.setBranchLocation(dispatcher, "nope", { lat: 1, lng: 1 }, ctx), { code: "BRANCH_NOT_FOUND" });
  });
});

// ------------------------------------------------------------------------------------------------ the realtime hub
class FakeClient {
  static last = null;
  constructor() { this.h = {}; this.queries = []; FakeClient.last = this; }
  on(ev, fn) { this.h[ev] = fn; return this; }
  removeAllListeners() { this.h = {}; }
  async connect() {}
  async query(q) { this.queries.push(q); }
  async end() {}
  notify(payload, channel = "vyra_tracking") { this.h.notification?.({ channel, payload: JSON.stringify(payload) }); }
}
const tick = () => new Promise((r) => setImmediate(r));

describe("realtime hub", () => {
  const config = { db: { url: "postgres://x", ssl: false } };
  const mk = (opts = {}) => createRealtime({ config, ClientImpl: FakeClient, refreshMs: 60_000, ...opts });
  const sub = (hub, o = {}) => {
    const sent = []; let ended = 0;
    const s = { orderId: "o1", userId: "u1", snapshot: async () => ({ n: sent.length }), send: (ev, data) => sent.push([ev, data]), end: () => { ended++; }, ...o };
    return { sent, ended: () => ended, promise: hub.subscribe(s) };
  };

  it("LISTENs on first subscribe, sends an initial snapshot, then another on each NOTIFY for that order only", async () => {
    const hub = mk(); const a = sub(hub); const unsub = await a.promise; await tick();
    assert.ok(FakeClient.last.queries.includes("LISTEN vyra_tracking"));
    assert.equal(a.sent.length, 1);
    FakeClient.last.notify({ orderId: "o1" }); await tick();
    assert.equal(a.sent.length, 2);
    FakeClient.last.notify({ orderId: "someone-elses" }); await tick();
    assert.equal(a.sent.length, 2);
    unsub(); FakeClient.last.notify({ orderId: "o1" }); await tick();
    assert.equal(a.sent.length, 2);
    await hub.stop();
  });

  it("publish() issues pg_notify with the order id (delivered on commit)", async () => {
    const hub = mk(); const calls = [];
    await hub.publish({ query: async (...a) => { calls.push(a); } }, "o9");
    assert.equal(calls[0][0], "SELECT pg_notify($1, $2)");
    assert.deepEqual(calls[0][1], ["vyra_tracking", JSON.stringify({ orderId: "o9" })]);
  });

  it("a burst of notifications coalesces instead of rebuilding once per message", async () => {
    const hub = mk(); let builds = 0; let release;
    const gate = new Promise((r) => { release = r; });
    const a = sub(hub, { snapshot: async () => { builds++; if (builds === 1) await gate; return { builds }; } });
    await a.promise; await tick();
    for (let i = 0; i < 20; i++) FakeClient.last.notify({ orderId: "o1" });
    release(); await tick(); await tick();
    assert.equal(builds, 2);   // the in-flight one + exactly one follow-up
    await hub.stop();
  });

  it("closes the stream after a final snapshot, and on 'not found' (access lost)", async () => {
    const hub = mk();
    const fin = sub(hub, { snapshot: async () => ({ final: true }) }); await fin.promise; await tick();
    assert.equal(fin.ended(), 1);
    const gone = sub(hub, { orderId: "o2", snapshot: async () => { throw Object.assign(new Error("nf"), { status: 404, code: "ORDER_NOT_FOUND" }); } });
    await gone.promise; await tick();
    assert.deepEqual(gone.sent, [["gone", {}]]); assert.equal(gone.ended(), 1);
    await hub.stop();
  });

  it("caps concurrent streams per user and frees the slot on unsubscribe", async () => {
    const hub = mk({ maxPerUser: 2 });
    const u1 = await sub(hub).promise; await sub(hub, { orderId: "o2" }).promise;
    await assert.rejects(sub(hub, { orderId: "o3" }).promise, { code: "TOO_MANY_STREAMS" });
    await sub(hub, { userId: "someone-else" }).promise;       // other users are unaffected
    u1(); await sub(hub, { orderId: "o3" }).promise;          // slot freed
    await hub.stop();
  });

  it("a snapshot failure other than 'not found' is survived — the next notification still works", async () => {
    const hub = mk(); let n = 0;
    const a = sub(hub, { snapshot: async () => { if (++n === 2) throw new Error("db blip"); return { n }; } });
    await a.promise; await tick();
    FakeClient.last.notify({ orderId: "o1" }); await tick();
    FakeClient.last.notify({ orderId: "o1" }); await tick();
    assert.equal(a.sent.length, 2); assert.equal(a.ended(), 0);
    await hub.stop();
  });
});
