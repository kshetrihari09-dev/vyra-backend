import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { DELIVERY_RULES } from "../../src/config/delivery.js";
import { createDeliveryService } from "../../src/services/delivery.service.js";
import { createOrdersService } from "../../src/services/orders.service.js";
import { createPricingService } from "../../src/services/pricing.service.js";
import { createCouponsService } from "../../src/services/coupons.service.js";
import { createDeliveryCodes } from "../../src/utils/deliveryCode.js";
import { customer, staffOrders } from "../helpers/commerceFakes.js";
import { createFakeDelivery, dispatcher, dispatcherNoRoles, riderActor } from "../helpers/deliveryFakes.js";
import { fakeAudit } from "../helpers/fakes.js";
import { recordingNotifications } from "../helpers/notificationFakes.js";
import { TEMPLATES } from "../../src/notifications/templates.js";

const ctx = { ip: "203.0.113.5", requestId: "r" };
const codes = createDeliveryCodes(Buffer.alloc(32, 7).toString("base64"));

/** A clock the tests can move, so the location throttle is deterministic. */
function makeClock(start = "2026-09-28T10:00:00Z") {
  let t = new Date(start).getTime();
  const clock = () => new Date(t);
  clock.advance = (ms) => { t += ms; };
  return clock;
}

function setup() {
  const fake = createFakeDelivery();
  const { db, key } = fake;
  for (const p of ["soap", "cough-syrup"]) db.inventory.set(key("store-01", p, ""), { id: key("store-01", p, ""), on_hand: 20, reserved: 0 });
  db.addresses.push({ id: "addr-1", user_id: customer.id, label: "Home", name: "Alex", phone: "+1 555 0190", line1: "24 Maple Ct", city: "Metro", zip: "10245", is_default: true });
  // two riders (users + profiles)
  for (const [uid, name] of [["u-r1", "Daniel R."], ["u-r2", "Priya S."]]) db.users.set(uid, { name, status: "active" });
  const audit = fakeAudit();
  const clock = makeClock();
  const notifications = recordingNotifications();
  const withTx = (fn) => fn({});
  const coupons = createCouponsService({ repos: fake.repos });
  const pricing = createPricingService({ repos: fake.repos, coupons });
  const prescriptions = { assertCoverage: async () => [], linkToOrder: async () => {} };
  const orders = createOrdersService({ pool: {}, withTx, repos: fake.repos, pricing, audit, prescriptions, payments: fake.payments, codes, notifications });
  const delivery = createDeliveryService({ pool: {}, withTx, repos: fake.repos, audit, payments: fake.payments, codes, notifications, clock });
  return { ...fake, audit, clock, orders, delivery, withTx, notifications };
}

/** Places an order (branch store-01 → OTP required) and walks it to "packed". */
async function packedOrder(e, { paymentMethod = "cod", qty = 1 } = {}) {
  const o = await e.orders.create(customer, { items: [{ productId: "soap", qty }], addressId: "addr-1", paymentMethod, deliveryOptionId: "standard" }, ctx);
  await e.orders.advance(staffOrders, o.id, { status: "preparing" }, ctx);
  await e.orders.advance(staffOrders, o.id, { status: "packed" }, ctx);
  return o;
}
const makeRider = async (e, userId, { available = true } = {}) => {
  const rider = await e.delivery.createRider(dispatcher, { userId, phone: "+1 555 0231", vehicle: "Scooter · MC-4418" }, ctx);
  if (available) await e.delivery.setAvailability(riderActor(userId), true);
  return rider;
};
const statusOf = (e, id) => e.db.orders.find((o) => o.id === id).status;
const otpOf = (e, id) => { const r = e.db.orders.find((o) => o.id === id); return codes.codeFor(r.id, r.otp_nonce); };
const wrongCode = (e, id) => (otpOf(e, id) === "0000" ? "1111" : "0000");

/** assign → accept → pickup, returning the delivery id. */
async function toOutForDelivery(e, order, riderId, userId) {
  const d = await e.delivery.assign(dispatcher, order.id, { riderId }, ctx);
  await e.delivery.accept(riderActor(userId), d.id, ctx);
  await e.delivery.pickup(riderActor(userId), d.id, ctx);
  return d.id;
}

describe("delivery code", () => {
  it("is deterministic per (order, nonce), four digits, and changes with the nonce", () => {
    const n = codes.newNonce();
    assert.match(codes.codeFor("o1", n), /^\d{4}$/);
    assert.equal(codes.codeFor("o1", n), codes.codeFor("o1", n));
    const seen = new Set(Array.from({ length: 40 }, () => codes.codeFor("o1", codes.newNonce())));
    assert.ok(seen.size > 20, "different nonces should give different codes");
  });
  it("depends on the server key — the same order and nonce under another key gives another code", () => {
    const other = createDeliveryCodes(Buffer.alloc(32, 9).toString("base64"));
    const diff = Array.from({ length: 20 }, () => codes.newNonce()).filter((n) => codes.codeFor("o1", n) !== other.codeFor("o1", n));
    assert.ok(diff.length >= 15);
  });
  it("matches() accepts only the exact four-digit code", () => {
    const n = codes.newNonce(); const c = codes.codeFor("o1", n);
    assert.equal(codes.matches("o1", n, c), true);
    assert.equal(codes.matches("o1", n, c === "0000" ? "0001" : "0000"), false);
    for (const bad of [undefined, null, "", "123", "12345", "12a4", ` ${c}`, 1234]) assert.equal(codes.matches("o1", n, bad), false, String(bad));
    assert.equal(codes.matches("o1", null, c), false);
  });
  it("rejects a key that isn't 32 bytes", () => assert.throws(() => createDeliveryCodes(Buffer.alloc(8).toString("base64"))));
});

describe("riders", () => {
  it("creating a rider needs delivery:manage AND roles:assign, grants the delivery role, and refuses duplicates", async () => {
    const e = setup();
    await assert.rejects(e.delivery.createRider(dispatcherNoRoles, { userId: "u-r1", phone: "+1 555 0231", vehicle: "Bike" }, ctx), { status: 403 });
    await assert.rejects(e.delivery.createRider(staffOrders, { userId: "u-r1", phone: "+1 555 0231", vehicle: "Bike" }, ctx), { status: 403 });
    const rider = await e.delivery.createRider(dispatcher, { userId: "u-r1", phone: "+1 555 0231", vehicle: "Bike" }, ctx);
    assert.equal(rider.name, "Daniel R.");
    assert.equal(rider.isAvailable, false);
    assert.deepEqual(e.db.userRoles, [{ userId: "u-r1", role: "delivery" }]);
    await assert.rejects(e.delivery.createRider(dispatcher, { userId: "u-r1", phone: "+1 555 0231", vehicle: "Bike" }, ctx), { code: "RIDER_EXISTS" });
    await assert.rejects(e.delivery.createRider(dispatcher, { userId: "ghost", phone: "+1 555 0231", vehicle: "Bike" }, ctx), { code: "USER_NOT_FOUND" });
    assert.ok(e.audit.entries.some((a) => a.action === "rider.created"));
  });

  it("a user without a rider profile is refused everywhere in the rider API", async () => {
    const e = setup();
    for (const call of [() => e.delivery.me(riderActor("u-x")), () => e.delivery.listMine(riderActor("u-x")), () => e.delivery.claim(riderActor("u-x"), "o", ctx)]) {
      await assert.rejects(call(), { code: "NOT_A_RIDER" });
    }
  });

  it("a suspended rider can do nothing, and a rider with live deliveries can't be suspended", async () => {
    const e = setup();
    const rider = await makeRider(e, "u-r1");
    const o = await packedOrder(e);
    const d = await e.delivery.assign(dispatcher, o.id, { riderId: rider.id }, ctx);
    await assert.rejects(e.delivery.updateRider(dispatcher, rider.id, { status: "suspended" }, ctx), { code: "RIDER_HAS_ACTIVE" });
    await e.delivery.unassign(dispatcher, d.id, {}, ctx);
    const suspended = await e.delivery.updateRider(dispatcher, rider.id, { status: "suspended" }, ctx);
    assert.equal(suspended.isAvailable, false);
    await assert.rejects(e.delivery.me(riderActor("u-r1")), { code: "RIDER_SUSPENDED" });
    await assert.rejects(e.delivery.assign(dispatcher, o.id, { riderId: rider.id }, ctx), { code: "RIDER_INACTIVE" });
  });

  it("dispatch reads are gated by delivery:manage", async () => {
    const e = setup();
    await makeRider(e, "u-r1");
    assert.equal((await e.delivery.listRiders(dispatcher)).length, 1);
    await assert.rejects(e.delivery.listRiders(riderActor("u-r1")), { status: 403 });
    await assert.rejects(e.delivery.listActive(customer), { status: 403 });
  });
});

describe("assignment", () => {
  let e, r1, r2, order;
  beforeEach(async () => { e = setup(); r1 = await makeRider(e, "u-r1"); r2 = await makeRider(e, "u-r2"); order = await packedOrder(e); });

  it("only a packed order can be assigned; assigning sets the order to 'assigned' with a partner snapshot", async () => {
    const early = await e.orders.create(customer, { items: [{ productId: "soap", qty: 1 }], addressId: "addr-1", paymentMethod: "cod", deliveryOptionId: "standard" }, ctx);
    await assert.rejects(e.delivery.assign(dispatcher, early.id, { riderId: r1.id }, ctx), { code: "NOT_DISPATCHABLE" });
    const d = await e.delivery.assign(dispatcher, order.id, { riderId: r1.id }, ctx);
    assert.equal(d.status, "assigned");
    assert.equal(statusOf(e, order.id), "assigned");
    const row = e.db.orders.find((o) => o.id === order.id);
    assert.deepEqual(row.partner, { name: "Daniel R.", phone: "+1 555 0231", vehicle: "Scooter · MC-4418" });
    assert.ok(e.db.orderHistory.get(order.id).some((h) => h.status === "assigned"));
  });

  it("an order has at most one active delivery", async () => {
    await e.delivery.assign(dispatcher, order.id, { riderId: r1.id }, ctx);
    await assert.rejects(e.delivery.assign(dispatcher, order.id, { riderId: r2.id }, ctx), { code: "NOT_DISPATCHABLE" }); // already 'assigned'
    // …and the DB-level backstop maps to a friendly conflict if two requests race past the status check:
    await assert.rejects(e.repos.delivery.insertDelivery({}, { orderId: order.id, riderId: r2.id, status: "assigned" }), { code: "23505" });
  });

  it("only delivery:manage can assign, reassign or unassign", async () => {
    const d = await e.delivery.assign(dispatcher, order.id, { riderId: r1.id }, ctx);
    for (const actor of [customer, staffOrders, riderActor("u-r1")]) {
      await assert.rejects(e.delivery.assign(actor, order.id, { riderId: r1.id }, ctx), { status: 403 });
      await assert.rejects(e.delivery.reassign(actor, d.id, { riderId: r2.id }, ctx), { status: 403 });
      await assert.rejects(e.delivery.unassign(actor, d.id, {}, ctx), { status: 403 });
    }
  });

  it("reassign cancels the old delivery, opens a new one for the other rider and updates the partner", async () => {
    const d = await e.delivery.assign(dispatcher, order.id, { riderId: r1.id }, ctx);
    await e.delivery.accept(riderActor("u-r1"), d.id, ctx);
    const d2 = await e.delivery.reassign(dispatcher, d.id, { riderId: r2.id }, ctx);
    assert.equal(d2.status, "assigned");
    assert.equal(d2.riderId, r2.id);
    assert.equal(e.db.deliveries.find((x) => x.id === d.id).status, "cancelled");
    assert.equal(e.db.orders.find((o) => o.id === order.id).partner.name, "Priya S.");
    assert.equal(statusOf(e, order.id), "assigned");
    await assert.rejects(e.delivery.reassign(dispatcher, d2.id, { riderId: r2.id }, ctx), { code: "SAME_RIDER" });
    // the first rider can no longer see or act on it
    await assert.rejects(e.delivery.pickup(riderActor("u-r1"), d.id, ctx), { code: "NOT_ACCEPTED" });
  });

  it("unassign puts the order back in the packed queue and clears the partner", async () => {
    const d = await e.delivery.assign(dispatcher, order.id, { riderId: r1.id }, ctx);
    await e.delivery.unassign(dispatcher, d.id, { reason: "rider sick" }, ctx);
    assert.equal(statusOf(e, order.id), "packed");
    assert.equal(e.db.orders.find((o) => o.id === order.id).partner, null);
    assert.equal((await e.delivery.listClaimable(riderActor("u-r2"))).length, 1);
  });

  it("can't reassign or unassign once the rider has the parcel", async () => {
    const id = await toOutForDelivery(e, order, r1.id, "u-r1");
    await assert.rejects(e.delivery.unassign(dispatcher, id, {}, ctx), { code: "CANNOT_UNASSIGN" });
    await assert.rejects(e.delivery.reassign(dispatcher, id, { riderId: r2.id }, ctx), { code: "CANNOT_REASSIGN" });
  });

  it("a rider's capacity is enforced", async () => {
    for (let i = 0; i < DELIVERY_RULES.maxActivePerRider; i++) {
      const o = await packedOrder(e);
      await e.delivery.assign(dispatcher, o.id, { riderId: r1.id }, ctx);
    }
    await assert.rejects(e.delivery.assign(dispatcher, order.id, { riderId: r1.id }, ctx), { code: "RIDER_BUSY" });
    assert.ok(await e.delivery.assign(dispatcher, order.id, { riderId: r2.id }, ctx));
  });
});

describe("rider self-service", () => {
  let e, r1, r2;
  beforeEach(async () => { e = setup(); r1 = await makeRider(e, "u-r1"); r2 = await makeRider(e, "u-r2"); });

  it("the claimable list shows the area only — no street, name or phone — and only to an available rider", async () => {
    const o = await packedOrder(e);
    const [item] = await e.delivery.listClaimable(riderActor("u-r1"));
    assert.equal(item.orderId, o.id);
    assert.equal(item.area, "Metro");
    assert.ok(!JSON.stringify(item).includes("Maple"));
    assert.ok(!JSON.stringify(item).includes("555 0190"));
    await e.delivery.setAvailability(riderActor("u-r1"), false);
    assert.deepEqual(await e.delivery.listClaimable(riderActor("u-r1")), []);
  });

  it("claiming assigns the order to the rider already accepted, and only one rider can win", async () => {
    const o = await packedOrder(e);
    const d = await e.delivery.claim(riderActor("u-r1"), o.id, ctx);
    assert.equal(d.status, "accepted");
    assert.equal(d.selfClaimed, true);
    assert.equal(statusOf(e, o.id), "assigned");
    await assert.rejects(e.delivery.claim(riderActor("u-r2"), o.id, ctx), { code: "NOT_DISPATCHABLE" });
  });

  it("an unavailable rider can't claim, and an unpacked order can't be claimed", async () => {
    const o = await packedOrder(e);
    await e.delivery.setAvailability(riderActor("u-r2"), false);
    await assert.rejects(e.delivery.claim(riderActor("u-r2"), o.id, ctx), { code: "RIDER_UNAVAILABLE" });
    const early = await e.orders.create(customer, { items: [{ productId: "soap", qty: 1 }], addressId: "addr-1", paymentMethod: "cod", deliveryOptionId: "standard" }, ctx);
    await assert.rejects(e.delivery.claim(riderActor("u-r1"), early.id, ctx), { code: "NOT_DISPATCHABLE" });
  });

  it("a rider sees only their own deliveries; someone else's is 'not found'", async () => {
    const o = await packedOrder(e);
    const d = await e.delivery.assign(dispatcher, o.id, { riderId: r1.id }, ctx);
    assert.equal((await e.delivery.listMine(riderActor("u-r1"))).length, 1);
    assert.equal((await e.delivery.listMine(riderActor("u-r2"))).length, 0);
    for (const act of ["accept", "pickup"]) await assert.rejects(e.delivery[act](riderActor("u-r2"), d.id, ctx), { code: "DELIVERY_NOT_FOUND" });
    await assert.rejects(e.delivery.decline(riderActor("u-r2"), d.id, {}, ctx), { code: "DELIVERY_NOT_FOUND" });
    await assert.rejects(e.delivery.deliver(riderActor("u-r2"), d.id, { otp: "1234" }, ctx), { code: "DELIVERY_NOT_FOUND" });
  });

  it("the rider's view carries the full address and phone but NEVER the code", async () => {
    const o = await packedOrder(e);
    await e.delivery.assign(dispatcher, o.id, { riderId: r1.id }, ctx);
    const [d] = await e.delivery.listMine(riderActor("u-r1"));
    assert.equal(d.order.shipTo.line1, "24 Maple Ct");
    assert.equal(d.order.shipTo.phone, "+1 555 0190");
    assert.equal(d.order.otpRequired, true);
    assert.equal("otp" in d.order, false, "the rider's DTO has no code field");
    assert.equal("otp" in d, false);
  });

  it("decline returns the order to packed with no partner", async () => {
    const o = await packedOrder(e);
    const d = await e.delivery.assign(dispatcher, o.id, { riderId: r1.id }, ctx);
    await e.delivery.decline(riderActor("u-r1"), d.id, { reason: "too far" }, ctx);
    assert.equal(statusOf(e, o.id), "packed");
    assert.equal(e.db.orders.find((x) => x.id === o.id).partner, null);
    assert.ok(e.db.events.some((ev) => ev.type === "declined" && ev.note === "too far"));
  });

  it("the state machine can't be skipped: pick-up needs accept, decline stops after pick-up", async () => {
    const o = await packedOrder(e);
    const d = await e.delivery.assign(dispatcher, o.id, { riderId: r1.id }, ctx);
    await assert.rejects(e.delivery.pickup(riderActor("u-r1"), d.id, ctx), { code: "NOT_ACCEPTED" });
    await assert.rejects(e.delivery.deliver(riderActor("u-r1"), d.id, { otp: otpOf(e, o.id), cashCollected: 5.25 }, ctx), { code: "NOT_OUT_FOR_DELIVERY" });
    await e.delivery.accept(riderActor("u-r1"), d.id, ctx);
    await assert.rejects(e.delivery.accept(riderActor("u-r1"), d.id, ctx), { code: "NOT_OFFERED" });
    await e.delivery.pickup(riderActor("u-r1"), d.id, ctx);
    assert.equal(statusOf(e, o.id), "out_for_delivery");
    await assert.rejects(e.delivery.decline(riderActor("u-r1"), d.id, {}, ctx), { code: "CANNOT_DECLINE" });
  });
});

describe("completing a delivery (the handover code)", () => {
  let e, order, deliveryId, rider;
  const me = riderActor("u-r1");
  beforeEach(async () => {
    e = setup(); rider = await makeRider(e, "u-r1");
    order = await packedOrder(e, { paymentMethod: "cod" });
    deliveryId = await toOutForDelivery(e, order, rider.id, "u-r1");
  });
  const total = () => Number(e.db.orders.find((o) => o.id === order.id).total);

  it("the right code (and exact cash for COD) delivers, captures the COD payment and closes the run", async () => {
    const d = await e.delivery.deliver(me, deliveryId, { otp: otpOf(e, order.id), cashCollected: total() }, ctx);
    assert.equal(d.status, "delivered");
    const row = e.db.orders.find((o) => o.id === order.id);
    assert.equal(row.status, "delivered");
    assert.equal(row.payment_status, "paid");
    assert.ok(row.delivered_at);
    assert.deepEqual(e.db.payments, [{ orderId: order.id, action: "cod_collected" }]);
    assert.equal(e.db.deliveries.find((x) => x.id === deliveryId).cash_collected, row.total);
    assert.ok(e.audit.entries.some((a) => a.action === "delivery.completed"));
    assert.equal((await e.orders.get(customer, order.id)).otp, undefined, "no code shown once delivered");
    await assert.rejects(e.delivery.deliver(me, deliveryId, { otp: otpOf(e, order.id), cashCollected: total() }, ctx), { code: "NOT_OUT_FOR_DELIVERY" });
  });

  it("a wrong code is refused AND counted (the counter survives the failed request)", async () => {
    const bad = wrongCode(e, order.id);
    await assert.rejects(e.delivery.deliver(me, deliveryId, { otp: bad, cashCollected: total() }, ctx), { code: "OTP_MISMATCH" });
    assert.equal(e.db.orders.find((o) => o.id === order.id).otp_attempts, 1);
    assert.equal(statusOf(e, order.id), "out_for_delivery");
    assert.deepEqual(e.db.payments, []);
    assert.ok(e.db.events.some((ev) => ev.type === "otp_failed"));
  });

  it("after 5 wrong codes the order locks — even the RIGHT code is refused until dispatch resets it", async () => {
    const bad = wrongCode(e, order.id);
    for (let i = 1; i <= DELIVERY_RULES.otpMaxAttempts; i++) {
      await assert.rejects(e.delivery.deliver(me, deliveryId, { otp: bad, cashCollected: total() }, ctx), (err) => err.code === "OTP_MISMATCH" && (i < DELIVERY_RULES.otpMaxAttempts || /locked/i.test(err.message)));
    }
    assert.ok(e.audit.entries.some((a) => a.action === "delivery.otp_locked"));
    await assert.rejects(e.delivery.deliver(me, deliveryId, { otp: otpOf(e, order.id), cashCollected: total() }, ctx), { code: "OTP_LOCKED" });
    assert.equal(statusOf(e, order.id), "out_for_delivery");

    const before = otpOf(e, order.id);
    await assert.rejects(e.delivery.resetOtp(me, order.id, ctx), { status: 403 });          // a rider can't unlock themselves
    await assert.rejects(e.delivery.resetOtp(customer, order.id, ctx), { status: 403 });
    await e.delivery.resetOtp(dispatcher, order.id, ctx);
    assert.equal(e.db.orders.find((o) => o.id === order.id).otp_attempts, 0);
    assert.notEqual(otpOf(e, order.id), before, "the reset issues a NEW code");
    assert.equal((await e.orders.get(customer, order.id)).otp, otpOf(e, order.id), "the customer sees the new code");
    const d = await e.delivery.deliver(me, deliveryId, { otp: otpOf(e, order.id), cashCollected: total() }, ctx);
    assert.equal(d.status, "delivered");
  });

  it("a missing code is refused without burning an attempt", async () => {
    await assert.rejects(e.delivery.deliver(me, deliveryId, { cashCollected: total() }, ctx), { code: "OTP_REQUIRED" });
    assert.equal(e.db.orders.find((o) => o.id === order.id).otp_attempts, 0);
  });

  it("COD needs the exact amount — nothing changes if it's wrong", async () => {
    for (const cash of [undefined, total() - 0.01, total() + 1]) {
      await assert.rejects(e.delivery.deliver(me, deliveryId, { otp: otpOf(e, order.id), cashCollected: cash }, ctx), { code: "CASH_MISMATCH" });
    }
    assert.equal(statusOf(e, order.id), "out_for_delivery");
    assert.equal(e.db.deliveries.find((x) => x.id === deliveryId).status, "picked_up");
  });

  it("a prepaid order needs no cash, and the payment status is left alone", async () => {
    const o = await packedOrder(e, { paymentMethod: "card" });
    const r2 = await makeRider(e, "u-r2");
    const id = await toOutForDelivery(e, o, r2.id, "u-r2");
    e.db.orders.find((x) => x.id === o.id).payment_status = "paid";
    const d = await e.delivery.deliver(riderActor("u-r2"), id, { otp: otpOf(e, o.id) }, ctx);
    assert.equal(d.status, "delivered");
    assert.equal(d.cashCollected, null);
    assert.equal(e.db.orders.find((x) => x.id === o.id).payment_status, "paid");
    assert.ok(!e.db.payments.some((p) => p.orderId === o.id));
  });

  it("a branch that doesn't use codes completes without one", async () => {
    e.db.inventory.set(e.key("store-02", "soap", ""), { id: e.key("store-02", "soap", ""), on_hand: 10, reserved: 0 });
    const o = await e.orders.create(customer, { items: [{ productId: "soap", qty: 1 }], addressId: "addr-1", paymentMethod: "card", deliveryOptionId: "standard", branch: "store-02" }, ctx);
    await e.orders.advance(staffOrders, o.id, { status: "preparing" }, ctx);
    await e.orders.advance(staffOrders, o.id, { status: "packed" }, ctx);
    const r2 = await makeRider(e, "u-r2");
    const id = await toOutForDelivery(e, o, r2.id, "u-r2");
    assert.equal((await e.delivery.deliver(riderActor("u-r2"), id, {}, ctx)).status, "delivered");
  });
});

describe("failed deliveries", () => {
  let e, r1;
  beforeEach(async () => { e = setup(); r1 = await makeRider(e, "u-r1"); });

  it("the first failure sends the order back to packed for re-dispatch, with the reason on its history", async () => {
    const o = await packedOrder(e);
    const id = await toOutForDelivery(e, o, r1.id, "u-r1");
    const res = await e.delivery.fail(riderActor("u-r1"), id, { reason: "customer_unreachable", note: "phone off" }, ctx);
    assert.equal(res.orderOutcome, "redispatch");
    assert.equal(statusOf(e, o.id), "packed");
    assert.equal(e.db.orders.find((x) => x.id === o.id).partner, null);
    assert.match(e.db.orderHistory.get(o.id).at(-1).note, /attempt 1 failed: Customer unreachable/);
    assert.equal((await e.delivery.listClaimable(riderActor("u-r1"))).length, 1);
    assert.deepEqual(e.db.payments, [], "COD payment stays pending while a retry is possible");
  });

  it("after the second failure the order is closed as 'returned'; COD is marked not collected", async () => {
    const o = await packedOrder(e, { paymentMethod: "cod" });
    let id = await toOutForDelivery(e, o, r1.id, "u-r1");
    await e.delivery.fail(riderActor("u-r1"), id, { reason: "customer_unreachable" }, ctx);
    id = await toOutForDelivery(e, o, r1.id, "u-r1");
    const res = await e.delivery.fail(riderActor("u-r1"), id, { reason: "customer_refused" }, ctx);
    assert.equal(res.orderOutcome, "returned");
    const row = e.db.orders.find((x) => x.id === o.id);
    assert.equal(row.status, "returned");
    assert.equal(row.payment_status, "not_collected");
    assert.ok(row.returned_at);
    assert.deepEqual(e.db.payments, [{ orderId: o.id, action: "cod_not_collected" }]);
    assert.ok(e.audit.entries.some((a) => a.action === "delivery.failed" && a.newValue.orderOutcome === "returned"));
    assert.equal(e.db.reserved ?? 0, 0);
  });

  it("a prepaid order that ends 'returned' keeps its payment status (a refund goes through the payments flow)", async () => {
    const o = await packedOrder(e, { paymentMethod: "card" });
    e.db.orders.find((x) => x.id === o.id).payment_status = "paid";
    let id = await toOutForDelivery(e, o, r1.id, "u-r1");
    await e.delivery.fail(riderActor("u-r1"), id, { reason: "wrong_address" }, ctx);
    id = await toOutForDelivery(e, o, r1.id, "u-r1");
    await e.delivery.fail(riderActor("u-r1"), id, { reason: "wrong_address" }, ctx);
    const row = e.db.orders.find((x) => x.id === o.id);
    assert.equal(row.status, "returned");
    assert.equal(row.payment_status, "paid");
    assert.deepEqual(e.db.payments, []);
  });

  it("can only be reported while out for delivery", async () => {
    const o = await packedOrder(e);
    const d = await e.delivery.assign(dispatcher, o.id, { riderId: r1.id }, ctx);
    await assert.rejects(e.delivery.fail(riderActor("u-r1"), d.id, { reason: "other" }, ctx), { code: "NOT_OUT_FOR_DELIVERY" });
  });
});

describe("location sharing and tracking", () => {
  let e, o, id;
  beforeEach(async () => {
    e = setup(); const r1 = await makeRider(e, "u-r1"); const r2 = await makeRider(e, "u-r2");
    o = await packedOrder(e);
    const d = await e.delivery.assign(dispatcher, o.id, { riderId: r1.id }, ctx);
    await e.delivery.accept(riderActor("u-r1"), d.id, ctx);
    id = d.id; e.r2 = r2;
  });

  it("locations are refused until the rider is out for delivery (no tracking while merely assigned)", async () => {
    await assert.rejects(e.delivery.updateLocation(riderActor("u-r1"), id, { lat: 27.7, lng: 85.3 }), { code: "NOT_TRACKING" });
    assert.equal((await e.delivery.tracking(customer, o.id)).delivery.location, null);
  });

  it("pings faster than the interval are dropped; later ones are stored", async () => {
    await e.delivery.pickup(riderActor("u-r1"), id, ctx);
    assert.deepEqual(await e.delivery.updateLocation(riderActor("u-r1"), id, { lat: 27.7, lng: 85.3, accuracy: 12 }), { accepted: true });
    e.clock.advance(1000);
    assert.deepEqual(await e.delivery.updateLocation(riderActor("u-r1"), id, { lat: 27.71, lng: 85.31 }), { accepted: false });
    e.clock.advance(DELIVERY_RULES.locationMinIntervalMs);
    assert.deepEqual(await e.delivery.updateLocation(riderActor("u-r1"), id, { lat: 27.72, lng: 85.32 }), { accepted: true });
    assert.equal(e.db.locations.length, 2);
  });

  it("only the order's owner (and staff) can track it; a stranger gets 'not found'", async () => {
    await e.delivery.pickup(riderActor("u-r1"), id, ctx);
    await e.delivery.updateLocation(riderActor("u-r1"), id, { lat: 27.7, lng: 85.3, accuracy: 12 });
    const mine = await e.delivery.tracking(customer, o.id);
    assert.equal(mine.delivery.status, "picked_up");
    assert.deepEqual(mine.delivery.location, { lat: 27.7, lng: 85.3, accuracy: 12, updatedAt: mine.delivery.location.updatedAt });
    assert.equal(mine.delivery.rider.name, "Daniel R.");
    await assert.rejects(e.delivery.tracking({ id: "stranger", permissions: [] }, o.id), { code: "ORDER_NOT_FOUND" });
    await assert.rejects(e.delivery.tracking(riderActor("u-r2"), o.id), { code: "ORDER_NOT_FOUND" }); // a different rider has no business here
    assert.ok(await e.delivery.tracking(dispatcher, o.id));
  });

  it("customers see event types only; staff also see notes — and OTP housekeeping stays hidden from customers", async () => {
    await e.delivery.pickup(riderActor("u-r1"), id, ctx);
    await assert.rejects(e.delivery.deliver(riderActor("u-r1"), id, { otp: wrongCode(e, o.id), cashCollected: 1 }, ctx), { code: "OTP_MISMATCH" });
    const cust = await e.delivery.tracking(customer, o.id);
    assert.ok(cust.events.every((ev) => ["assigned", "claimed", "picked_up", "delivered", "failed"].includes(ev.type)));
    assert.ok(cust.events.every((ev) => ev.note === undefined && ev.actorId === undefined));
    const staff = await e.delivery.tracking(dispatcher, o.id);
    assert.ok(staff.events.some((ev) => ev.type === "otp_failed" && ev.note === "attempt 1/5"));
  });

  it("the location trail and last-seen position are deleted when the run ends", async () => {
    await e.delivery.pickup(riderActor("u-r1"), id, ctx);
    await e.delivery.updateLocation(riderActor("u-r1"), id, { lat: 27.7, lng: 85.3 });
    const total = Number(e.db.orders.find((x) => x.id === o.id).total);
    await e.delivery.deliver(riderActor("u-r1"), id, { otp: otpOf(e, o.id), cashCollected: total }, ctx);
    assert.equal(e.db.locations.length, 0);
    const d = e.db.deliveries.find((x) => x.id === id);
    assert.deepEqual([d.last_lat, d.last_lng, d.last_located_at], [null, null, null]);
    await assert.rejects(e.delivery.updateLocation(riderActor("u-r1"), id, { lat: 1, lng: 1 }), { code: "NOT_TRACKING" });
  });

  it("a failed run purges the trail too", async () => {
    await e.delivery.pickup(riderActor("u-r1"), id, ctx);
    await e.delivery.updateLocation(riderActor("u-r1"), id, { lat: 27.7, lng: 85.3 });
    await e.delivery.fail(riderActor("u-r1"), id, { reason: "other" }, ctx);
    assert.equal(e.db.locations.length, 0);
  });
});

describe("notifications raised by delivery", () => {
  const typesFor = (e, orderId) => e.notifications.emitted.filter((x) => x.data.orderId === orderId).map((x) => `${x.type}>${x.userId}`);
  it("the whole happy path notifies the customer at each step, and the rider on assignment", async () => {
    const e = setup(); const r1 = await makeRider(e, "u-r1");
    const o = await packedOrder(e);
    const id = await toOutForDelivery(e, o, r1.id, "u-r1");
    await e.delivery.deliver(riderActor("u-r1"), id, { otp: otpOf(e, o.id), cashCollected: Number(e.db.orders.find((x) => x.id === o.id).total) }, ctx);
    assert.deepEqual(typesFor(e, o.id), [
      `order.placed>${customer.id}`, `order.packed>${customer.id}`,
      `delivery.assigned>${customer.id}`, "rider.assigned>u-r1",
      `delivery.out_for_delivery>${customer.id}`, `delivery.delivered>${customer.id}`,
    ]);
  });
  it("a failed attempt says 'retry' first and 'returned' the second time", async () => {
    const e = setup(); const r1 = await makeRider(e, "u-r1");
    const o = await packedOrder(e);
    let id = await toOutForDelivery(e, o, r1.id, "u-r1");
    await e.delivery.fail(riderActor("u-r1"), id, { reason: "customer_unreachable" }, ctx);
    id = await toOutForDelivery(e, o, r1.id, "u-r1");
    await e.delivery.fail(riderActor("u-r1"), id, { reason: "customer_refused" }, ctx);
    const failures = e.notifications.emitted.filter((x) => x.type.startsWith("delivery.") && ["delivery.retry", "delivery.returned"].includes(x.type));
    assert.deepEqual(failures.map((x) => x.type), ["delivery.retry", "delivery.returned"]);
    assert.match(TEMPLATES["delivery.retry"].message(failures[0].data), /customer unreachable/);
  });
  it("NO notification payload ever contains the handover code", async () => {
    const e = setup(); const r1 = await makeRider(e, "u-r1");
    const o = await packedOrder(e);
    await toOutForDelivery(e, o, r1.id, "u-r1");
    const code = otpOf(e, o.id);
    for (const n of e.notifications.emitted) {
      assert.ok(!JSON.stringify(n).includes(code), n.type);
      assert.ok(!TEMPLATES[n.type].message(n.data).includes(code), n.type);
    }
  });
  it("cancelling notifies the owner; a rider decline doesn't notify the customer", async () => {
    const e = setup(); const r1 = await makeRider(e, "u-r1");
    const early = await e.orders.create(customer, { items: [{ productId: "soap", qty: 1 }], addressId: "addr-1", paymentMethod: "cod", deliveryOptionId: "standard" }, ctx);
    await e.orders.cancel(customer, early.id, { reason: "changed my mind" }, ctx);
    const c = e.notifications.emitted.find((x) => x.type === "order.cancelled");
    assert.equal(c.userId, customer.id);
    assert.equal(c.data.reason, null, "the customer's own reason isn't echoed back");
    const o = await packedOrder(e);
    const d = await e.delivery.assign(dispatcher, o.id, { riderId: r1.id }, ctx);
    const before = e.notifications.emitted.length;
    await e.delivery.decline(riderActor("u-r1"), d.id, { reason: "too far" }, ctx);
    assert.equal(e.notifications.emitted.length, before);
  });
  it("a rolled-back action emits nothing (a wrong code must not tell the customer 'delivered')", async () => {
    const e = setup(); const r1 = await makeRider(e, "u-r1");
    const o = await packedOrder(e);
    const id = await toOutForDelivery(e, o, r1.id, "u-r1");
    const before = e.notifications.emitted.length;
    await assert.rejects(e.delivery.deliver(riderActor("u-r1"), id, { otp: wrongCode(e, o.id), cashCollected: 1 }, ctx), { code: "OTP_MISMATCH" });
    assert.equal(e.notifications.emitted.length, before);
  });
});
