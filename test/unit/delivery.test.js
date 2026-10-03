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
import { REASON, RIDER_STATE, evaluateRider, riderState } from "../../src/domain/riderEligibility.js";
import { toDeliveryDto } from "../../src/models/delivery.model.js";

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
async function packedOrder(e, { paymentMethod = "cod", qty = 1, paid = true } = {}) {
  const o = await e.orders.create(customer, { items: [{ productId: "soap", qty }], addressId: "addr-1", paymentMethod, deliveryOptionId: "standard" }, ctx);
  if (paymentMethod !== "cod" && paid) markPaid(e, o.id); // what payments.service does when the provider confirms the capture
  await e.orders.advance(staffOrders, o.id, { status: "confirmed" }, ctx);
  await e.orders.advance(staffOrders, o.id, { status: "preparing" }, ctx);
  await e.orders.advance(staffOrders, o.id, { status: "packed" }, ctx);
  return o;
}
const markPaid = (e, id) => { e.db.orders.find((o) => o.id === id).payment_status = "paid"; };
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

  it("a user who is allowed to be a rider but has no profile yet is told it isn't set up (NOT_A_RIDER), everywhere in the rider API", async () => {
    const e = setup();
    e.db.users.set("u-x", { name: "No Profile", status: "active" });
    e.db.userRoles.push({ userId: "u-x", role: "delivery" }); // delivery role ⇒ delivery:rider permission, but no riders row
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
    markPaid(e, o.id);
    await e.orders.advance(staffOrders, o.id, { status: "confirmed" }, ctx);
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
      `order.placed>${customer.id}`, `order.confirmed>${customer.id}`, `order.packed>${customer.id}`,
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


// ===================================================================================================================
// Central rider validation — one rule, applied everywhere
// ===================================================================================================================
describe("rider validity (domain rule)", () => {
  const user = { id: "u", status: "active", roles: ["delivery"], permissions: ["delivery:rider"] };
  const profile = { user_id: "u", status: "active" };
  const reason = (over) => evaluateRider({ user: { ...user, ...over.user }, rider: "rider" in over ? over.rider : profile }).reason;
  it("accepts only when every condition holds", () => assert.deepEqual(evaluateRider({ user, rider: profile }), { ok: true }));
  it("names the first failing condition", () => {
    assert.equal(evaluateRider({ user: null, rider: profile }).reason, REASON.USER_MISSING);
    assert.equal(reason({ user: { status: "suspended" } }), REASON.USER_SUSPENDED);
    assert.equal(reason({ user: { status: "inactive" } }), REASON.USER_DEACTIVATED);
    assert.equal(reason({ user: { roles: ["warehouse"] } }), REASON.ROLE_MISSING);
    assert.equal(reason({ user: { permissions: [] } }), REASON.PERMISSION_MISSING); // role still there, permission gone
    assert.equal(reason({ user: {}, rider: null }), REASON.PROFILE_MISSING);
    assert.equal(reason({ user: {}, rider: { user_id: "someone-else", status: "active" } }), REASON.PROFILE_MISMATCH);
    assert.equal(reason({ user: {}, rider: { user_id: "u", status: "suspended" } }), REASON.PROFILE_INACTIVE);
  });
  it("derives the display state the dispatcher UI shows", () => {
    const row = (over = {}) => ({ user_id: "u", status: "active", is_available: true, active_count: 0, user_status: "active", roles: ["delivery"], permissions: ["delivery:rider"], ...over });
    assert.equal(riderState(row()), RIDER_STATE.AVAILABLE);
    assert.equal(riderState(row({ active_count: DELIVERY_RULES.maxActivePerRider })), RIDER_STATE.AT_CAPACITY);
    assert.equal(riderState(row({ is_available: false })), RIDER_STATE.OFF_DUTY);
    assert.equal(riderState(row({ status: "suspended" })), RIDER_STATE.INACTIVE);
    assert.equal(riderState(row({ user_status: "suspended" })), RIDER_STATE.SUSPENDED);
    assert.equal(riderState(row({ roles: [] })), RIDER_STATE.NOT_AUTHORIZED);
    assert.equal(riderState(row({ permissions: [] })), RIDER_STATE.NOT_AUTHORIZED);
    // an unauthorised rider is never "available", whatever their profile flags say
    assert.equal(riderState(row({ roles: [], is_available: true })), RIDER_STATE.NOT_AUTHORIZED);
  });
});

describe("rider authorization is re-checked from the user's CURRENT role/permission/status on every rider action", () => {
  /** A rider with one live delivery in each state we need, so every action has something real to act on. */
  async function ready() {
    const e = setup(); const rider = await makeRider(e, "u-r1");
    const o1 = await packedOrder(e); const o2 = await packedOrder(e); const o3 = await packedOrder(e);
    const assigned = await e.delivery.assign(dispatcher, o1.id, { riderId: rider.id }, ctx);
    const out = await toOutForDelivery(e, o2, rider.id, "u-r1");
    return { e, rider, assigned, out, claimable: o3 };
  }
  const actions = (e, { assigned, out, claimable }) => ({
    me: () => e.delivery.me(riderActor("u-r1")),
    availability: () => e.delivery.setAvailability(riderActor("u-r1"), true),
    list: () => e.delivery.listMine(riderActor("u-r1"), {}),
    available: () => e.delivery.listClaimable(riderActor("u-r1")),
    claim: () => e.delivery.claim(riderActor("u-r1"), claimable.id, ctx),
    accept: () => e.delivery.accept(riderActor("u-r1"), assigned.id, ctx),
    decline: () => e.delivery.decline(riderActor("u-r1"), assigned.id, {}, ctx),
    pickup: () => e.delivery.pickup(riderActor("u-r1"), assigned.id, ctx),
    location: () => e.delivery.updateLocation(riderActor("u-r1"), out, { lat: 27.7, lng: 85.3 }),
    deliver: () => e.delivery.deliver(riderActor("u-r1"), out, { otp: "0000" }, ctx),
    fail: () => e.delivery.fail(riderActor("u-r1"), out, { reason: "customer_unreachable" }, ctx),
  });
  const deny = async (e, ctxIds, code) => {
    for (const [name, call] of Object.entries(actions(e, ctxIds))) await assert.rejects(call(), { code }, name);
  };
  const ids = (x) => ({ assigned: x.assigned, out: x.out, claimable: x.claimable });

  it("an active rider is allowed", async () => {
    const x = await ready();
    assert.equal((await x.e.delivery.me(riderActor("u-r1"))).state, "available");
    assert.equal((await x.e.delivery.listMine(riderActor("u-r1"), {})).length, 2);
  });
  it("a suspended / deactivated user is denied everywhere", async () => {
    const x = await ready();
    x.e.db.users.get("u-r1").status = "suspended";
    await deny(x.e, ids(x), "RIDER_SUSPENDED");
  });
  it("removing the delivery role denies everywhere — the riders row is not authority", async () => {
    const x = await ready();
    x.e.db.userRoles = x.e.db.userRoles.filter((r) => !(r.userId === "u-r1" && r.role === "delivery"));
    assert.equal(x.e.db.riders.length, 1, "profile still exists");
    await deny(x.e, ids(x), "RIDER_NOT_AUTHORIZED");
  });
  it("a role that doesn't carry delivery:rider denies everywhere", async () => {
    const x = await ready();
    x.e.db.userRoles = x.e.db.userRoles.filter((r) => r.userId !== "u-r1");
    x.e.db.userRoles.push({ userId: "u-r1", role: "customer" });
    await deny(x.e, ids(x), "RIDER_NOT_AUTHORIZED");
  });
  it("a missing rider profile is NOT_A_RIDER (the setup message); a suspended profile is denied", async () => {
    const x = await ready();
    x.e.db.riders[0].status = "suspended";
    await deny(x.e, ids(x), "RIDER_SUSPENDED");
    x.e.db.riders.length = 0;
    await deny(x.e, ids(x), "NOT_A_RIDER");
  });
  it("a customer with no delivery role is simply not authorised (and learns nothing about profiles)", async () => {
    const x = await ready(); x.e.db.users.set("u-c", { name: "C", status: "active" });
    await assert.rejects(x.e.delivery.me(riderActor("u-c")), { code: "RIDER_NOT_AUTHORIZED" });
  });
  it("an invalid rider is refused BEFORE the order is even looked up (no order-id probing)", async () => {
    const x = await ready(); x.e.db.users.get("u-r1").status = "suspended";
    await assert.rejects(x.e.delivery.claim(riderActor("u-r1"), "no-such-order", ctx), { code: "RIDER_SUSPENDED" });
  });
});

describe("dispatcher assignment validates the target rider", () => {
  it("assigns to a valid rider", async () => {
    const e = setup(); const r = await makeRider(e, "u-r1"); const o = await packedOrder(e);
    const d = await e.delivery.assign(dispatcher, o.id, { riderId: r.id }, ctx);
    assert.equal(d.status, "assigned");
  });
  const MSG = "Rider is inactive or no longer authorized for delivery.";
  const breakers = {
    "suspended user": (e) => { e.db.users.get("u-r1").status = "suspended"; },
    "deactivated user": (e) => { e.db.users.get("u-r1").status = "inactive"; },
    "removed delivery role": (e) => { e.db.userRoles = e.db.userRoles.filter((r) => r.userId !== "u-r1"); },
    "inactive rider profile": (e) => { e.db.riders[0].status = "suspended"; },
  };
  for (const [name, breakIt] of Object.entries(breakers)) {
    it(`rejects ${name} on assign AND reassign, leaving the order untouched`, async () => {
      const e = setup(); const r1 = await makeRider(e, "u-r1"); const r2 = await makeRider(e, "u-r2");
      const o = await packedOrder(e); const o2 = await packedOrder(e);
      const d = await e.delivery.assign(dispatcher, o2.id, { riderId: r2.id }, ctx);
      breakIt(e);
      await assert.rejects(e.delivery.assign(dispatcher, o.id, { riderId: r1.id }, ctx), (err) => err.status === 409 && err.message === MSG);
      assert.equal(statusOf(e, o.id), "packed");
      await assert.rejects(e.delivery.reassign(dispatcher, d.id, { riderId: r1.id }, ctx), (err) => err.message === MSG);
      assert.equal(e.db.deliveries.find((x) => x.id === d.id).status, "assigned");
    });
  }
  it("rejects a rider at capacity, with a clear message", async () => {
    const e = setup(); const r = await makeRider(e, "u-r1");
    for (let i = 0; i < DELIVERY_RULES.maxActivePerRider; i++) await e.delivery.assign(dispatcher, (await packedOrder(e)).id, { riderId: r.id }, ctx);
    const extra = await packedOrder(e);
    await assert.rejects(e.delivery.assign(dispatcher, extra.id, { riderId: r.id }, ctx), { code: "RIDER_BUSY", message: /reached the delivery limit/ });
  });
  it("the rider list reports a derived state and capacity for the dispatcher UI", async () => {
    const e = setup(); const r = await makeRider(e, "u-r1"); await makeRider(e, "u-r2", { available: false });
    for (let i = 0; i < DELIVERY_RULES.maxActivePerRider; i++) await e.delivery.assign(dispatcher, (await packedOrder(e)).id, { riderId: r.id }, ctx);
    e.db.userRoles = e.db.userRoles.filter((x) => x.userId !== "u-r2");
    const list = await e.delivery.listRiders(dispatcher);
    const byUser = Object.fromEntries(list.map((x) => [x.userId, x]));
    assert.equal(byUser["u-r1"].state, "at_capacity");
    assert.equal(byUser["u-r1"].activeCount, DELIVERY_RULES.maxActivePerRider);
    assert.equal(byUser["u-r1"].capacity, DELIVERY_RULES.maxActivePerRider);
    assert.equal(byUser["u-r1"].canTakeDelivery, false);
    assert.equal(byUser["u-r2"].state, "not_authorized");
    assert.equal(byUser["u-r1"].vehicleType, "Scooter"); assert.equal(byUser["u-r1"].vehicleNumber, "MC-4418");
  });
  it("unassign still works on a rider who is no longer authorised (so their work can be moved)", async () => {
    const e = setup(); const r = await makeRider(e, "u-r1"); const o = await packedOrder(e);
    const d = await e.delivery.assign(dispatcher, o.id, { riderId: r.id }, ctx);
    e.db.userRoles = e.db.userRoles.filter((x) => x.userId !== "u-r1");
    await e.delivery.unassign(dispatcher, d.id, {}, ctx);
    assert.equal(statusOf(e, o.id), "packed");
  });
  it("a parcel stranded with a de-authorised rider can be recovered by dispatch — but never taken from a valid rider", async () => {
    const e = setup(); const r = await makeRider(e, "u-r1"); const o = await packedOrder(e);
    const id = await toOutForDelivery(e, o, r.id, "u-r1");
    await assert.rejects(e.delivery.unassign(dispatcher, id, {}, ctx), { code: "CANNOT_UNASSIGN" }); // valid rider: still theirs
    e.db.users.get("u-r1").status = "suspended";
    await e.delivery.unassign(dispatcher, id, {}, ctx);
    assert.equal(statusOf(e, o.id), "packed");
    assert.equal(e.db.deliveries.find((d) => d.id === id).status, "cancelled");
    assert.equal(e.db.locations.filter((l) => l.delivery_id === id).length, 0, "location trail purged");
  });
});

describe("claiming", () => {
  it("a second rider claiming a claimed order gets a safe conflict and no duplicate delivery exists", async () => {
    const e = setup(); await makeRider(e, "u-r1"); await makeRider(e, "u-r2"); const o = await packedOrder(e);
    await e.delivery.claim(riderActor("u-r1"), o.id, ctx);
    await assert.rejects(e.delivery.claim(riderActor("u-r2"), o.id, ctx), (err) => err.status === 409 && err.message === "Order is already assigned to another rider.");
    assert.equal(e.db.deliveries.filter((d) => d.order_id === o.id && ["assigned", "accepted", "picked_up"].includes(d.status)).length, 1);
  });
  it("the same rider double-submitting is told they already have it", async () => {
    const e = setup(); await makeRider(e, "u-r1"); const o = await packedOrder(e);
    await e.delivery.claim(riderActor("u-r1"), o.id, ctx);
    await assert.rejects(e.delivery.claim(riderActor("u-r1"), o.id, ctx), { message: "You already have this delivery." });
  });
  it("an order that isn't packed is 'no longer available'", async () => {
    const e = setup(); await makeRider(e, "u-r1"); const o = await packedOrder(e);
    e.db.orders.find((x) => x.id === o.id).status = "cancelled";
    await assert.rejects(e.delivery.claim(riderActor("u-r1"), o.id, ctx), { code: "NOT_DISPATCHABLE", message: "Delivery is no longer available." });
  });
  it("capacity is enforced on claim too", async () => {
    const e = setup(); await makeRider(e, "u-r1");
    for (let i = 0; i < DELIVERY_RULES.maxActivePerRider; i++) await e.delivery.claim(riderActor("u-r1"), (await packedOrder(e)).id, ctx);
    await assert.rejects(e.delivery.claim(riderActor("u-r1"), (await packedOrder(e)).id, ctx), { code: "RIDER_BUSY" });
  });
});

describe("state machine — every illegal move is refused", () => {
  it("walks the happy path in order and each skipped step is refused", async () => {
    const e = setup(); const r = await makeRider(e, "u-r1"); const o = await packedOrder(e);
    const a = riderActor("u-r1");
    const d = await e.delivery.assign(dispatcher, o.id, { riderId: r.id }, ctx);
    await assert.rejects(e.delivery.pickup(a, d.id, ctx), { code: "NOT_ACCEPTED" });            // assigned → picked_up skips accept
    await assert.rejects(e.delivery.deliver(a, d.id, { otp: "0000" }, ctx), { code: "NOT_OUT_FOR_DELIVERY" });
    await assert.rejects(e.delivery.fail(a, d.id, { reason: "other" }, ctx), { code: "NOT_OUT_FOR_DELIVERY" });
    await e.delivery.accept(a, d.id, ctx);
    await assert.rejects(e.delivery.accept(a, d.id, ctx), { code: "NOT_OFFERED" });             // no re-accept
    await assert.rejects(e.delivery.deliver(a, d.id, { otp: "0000" }, ctx), { code: "NOT_OUT_FOR_DELIVERY" }); // accepted → delivered skips pickup
    await e.delivery.pickup(a, d.id, ctx);
    await assert.rejects(e.delivery.pickup(a, d.id, ctx), { code: "NOT_ACCEPTED" });            // no double pickup
    await assert.rejects(e.delivery.accept(a, d.id, ctx), { code: "NOT_OFFERED" });             // no backward move
    await assert.rejects(e.delivery.decline(a, d.id, {}, ctx), { code: "CANNOT_DECLINE" });
    await e.delivery.deliver(a, d.id, { otp: otpOf(e, o.id), cashCollected: Number(e.db.orders.find((x) => x.id === o.id).total) }, ctx);
    for (const [name, call] of Object.entries({
      deliver: () => e.delivery.deliver(a, d.id, { otp: otpOf(e, o.id), cashCollected: 1 }, ctx),
      fail: () => e.delivery.fail(a, d.id, { reason: "other" }, ctx),
      pickup: () => e.delivery.pickup(a, d.id, ctx),
      accept: () => e.delivery.accept(a, d.id, ctx),
      decline: () => e.delivery.decline(a, d.id, {}, ctx),
      location: () => e.delivery.updateLocation(a, d.id, { lat: 1, lng: 1 }),
    })) await assert.rejects(call(), (err) => err.status === 409, `${name} after delivered`);
    assert.equal(statusOf(e, o.id), "delivered");
  });
  it("a delivered order cannot be assigned, claimed, reassigned or unassigned", async () => {
    const e = setup(); const r = await makeRider(e, "u-r1"); await makeRider(e, "u-r2"); const o = await packedOrder(e);
    const id = await toOutForDelivery(e, o, r.id, "u-r1");
    await e.delivery.fail(riderActor("u-r1"), id, { reason: "customer_unreachable" }, ctx); // back to packed
    assert.equal(statusOf(e, o.id), "packed");
    const again = await e.delivery.assign(dispatcher, o.id, { riderId: r.id }, ctx);          // redispatch works
    assert.equal(again.status, "assigned");
    await assert.rejects(e.delivery.assign(dispatcher, o.id, { riderId: r.id }, ctx), { code: "NOT_DISPATCHABLE" }); // already active
    await assert.rejects(e.delivery.claim(riderActor("u-r2"), o.id, ctx), { code: "NOT_DISPATCHABLE", message: "Order is already assigned to another rider." });
    await assert.rejects(e.delivery.reassign(dispatcher, id, { riderId: r.id }, ctx), { code: "CANNOT_REASSIGN" }); // the failed delivery is closed
  });
  it("another rider cannot pick up, complete, fail, accept, decline or ping someone else's delivery", async () => {
    const e = setup(); const r1 = await makeRider(e, "u-r1"); await makeRider(e, "u-r2");
    const o = await packedOrder(e); const id = await toOutForDelivery(e, o, r1.id, "u-r1");
    const other = riderActor("u-r2");
    for (const [name, call] of Object.entries({
      pickup: () => e.delivery.pickup(other, id, ctx), accept: () => e.delivery.accept(other, id, ctx),
      decline: () => e.delivery.decline(other, id, {}, ctx), deliver: () => e.delivery.deliver(other, id, { otp: otpOf(e, o.id) }, ctx),
      fail: () => e.delivery.fail(other, id, { reason: "other" }, ctx), location: () => e.delivery.updateLocation(other, id, { lat: 1, lng: 1 }),
    })) await assert.rejects(call(), { code: "DELIVERY_NOT_FOUND" }, name);
    assert.equal(statusOf(e, o.id), "out_for_delivery");
  });
});

describe("handover code (OTP) hardening", () => {
  async function run() {
    const e = setup(); const r1 = await makeRider(e, "u-r1"); await makeRider(e, "u-r2");
    const o = await packedOrder(e); const id = await toOutForDelivery(e, o, r1.id, "u-r1");
    return { e, o, id, a: riderActor("u-r1"), total: Number(e.db.orders.find((x) => x.id === o.id).total) };
  }
  it("is never stored as plaintext, never in an API response, and never in an event, audit entry or notification", async () => {
    const { e, o, id, a, total } = await run();
    const code = otpOf(e, o.id);
    assert.ok(!("otp" in e.db.orders.find((x) => x.id === o.id)), "no plaintext column");
    await assert.rejects(e.delivery.deliver(a, id, { otp: wrongCode(e, o.id) }, ctx));
    const done = await e.delivery.deliver(a, id, { otp: code, cashCollected: total }, ctx);
    const everything = JSON.stringify([done, e.db.events, e.audit.entries ?? e.audit, e.notifications.sent ?? e.notifications]);
    assert.ok(!everything.includes(`"${code}"`) && !everything.includes(`:${code}`) && !everything.includes(`otp":"${code}`), "code leaked");
  });
  it("a second rider can't use the code, and the failed attempt doesn't burn the owner's attempts", async () => {
    const { e, o, id, total, a } = await run();
    await assert.rejects(e.delivery.deliver(riderActor("u-r2"), id, { otp: otpOf(e, o.id), cashCollected: total }, ctx), { code: "DELIVERY_NOT_FOUND" });
    assert.equal(e.db.orders.find((x) => x.id === o.id).otp_attempts, 0);
    assert.equal((await e.delivery.deliver(a, id, { otp: otpOf(e, o.id), cashCollected: total }, ctx)).status, "delivered");
  });
  it("the code can't be replayed once the delivery is complete", async () => {
    const { e, o, id, a, total } = await run();
    const code = otpOf(e, o.id);
    await e.delivery.deliver(a, id, { otp: code, cashCollected: total }, ctx);
    await assert.rejects(e.delivery.deliver(a, id, { otp: code, cashCollected: total }, ctx), { code: "NOT_OUT_FOR_DELIVERY", message: /already complete/ });
  });
  it("5 wrong codes lock it, the right code is then refused, and a reset issues a NEW code", async () => {
    const { e, o, id, a, total } = await run();
    const before = otpOf(e, o.id);
    for (let i = 0; i < DELIVERY_RULES.otpMaxAttempts; i++) await assert.rejects(e.delivery.deliver(a, id, { otp: wrongCode(e, o.id) }, ctx), { code: "OTP_MISMATCH" });
    await assert.rejects(e.delivery.deliver(a, id, { otp: before, cashCollected: total }, ctx), { code: "OTP_LOCKED" });
    await e.delivery.resetOtp(dispatcher, o.id, ctx);
    assert.equal(e.db.orders.find((x) => x.id === o.id).otp_attempts, 0);
    assert.notEqual(otpOf(e, o.id), before);
    await assert.rejects(e.delivery.deliver(a, id, { otp: before === otpOf(e, o.id) ? "x" : before, cashCollected: total }, ctx), { code: "OTP_MISMATCH" }); // the old code is dead
    assert.equal((await e.delivery.deliver(a, id, { otp: otpOf(e, o.id), cashCollected: total }, ctx)).status, "delivered");
  });
  it("a de-authorised rider can't complete a delivery even with the right code", async () => {
    const { e, o, id, a, total } = await run();
    e.db.userRoles = e.db.userRoles.filter((x) => x.userId !== "u-r1");
    await assert.rejects(e.delivery.deliver(a, id, { otp: otpOf(e, o.id), cashCollected: total }, ctx), { code: "RIDER_NOT_AUTHORIZED" });
    assert.equal(statusOf(e, o.id), "out_for_delivery");
  });
});

describe("rider location", () => {
  it("accepts a ping from the owner while out for delivery, and purges the trail on completion", async () => {
    const e = setup(); const r = await makeRider(e, "u-r1"); const o = await packedOrder(e);
    const id = await toOutForDelivery(e, o, r.id, "u-r1");
    assert.deepEqual(await e.delivery.updateLocation(riderActor("u-r1"), id, { lat: 27.7, lng: 85.3 }), { accepted: true });
    assert.equal(e.db.locations.length, 1);
    const total = Number(e.db.orders.find((x) => x.id === o.id).total);
    await e.delivery.deliver(riderActor("u-r1"), id, { otp: otpOf(e, o.id), cashCollected: total }, ctx);
    assert.equal(e.db.locations.length, 0);
    assert.equal(e.db.deliveries.find((d) => d.id === id).last_lat ?? null, null, "live position cleared too");
  });
  it("is purged when the delivery fails", async () => {
    const e = setup(); const r = await makeRider(e, "u-r1"); const o = await packedOrder(e);
    const id = await toOutForDelivery(e, o, r.id, "u-r1");
    await e.delivery.updateLocation(riderActor("u-r1"), id, { lat: 27.7, lng: 85.3 });
    await e.delivery.fail(riderActor("u-r1"), id, { reason: "customer_unreachable" }, ctx);
    assert.equal(e.db.locations.length, 0);
  });
  it("refuses another rider, a de-authorised rider, and a delivery that's only assigned", async () => {
    const e = setup(); const r = await makeRider(e, "u-r1"); await makeRider(e, "u-r2");
    const o = await packedOrder(e); const o2 = await packedOrder(e);
    const id = await toOutForDelivery(e, o, r.id, "u-r1");
    const waiting = await e.delivery.assign(dispatcher, o2.id, { riderId: r.id }, ctx);
    await assert.rejects(e.delivery.updateLocation(riderActor("u-r2"), id, { lat: 1, lng: 1 }), { code: "DELIVERY_NOT_FOUND" });
    await assert.rejects(e.delivery.updateLocation(riderActor("u-r1"), waiting.id, { lat: 1, lng: 1 }), { code: "NOT_TRACKING" });
    e.db.userRoles = e.db.userRoles.filter((x) => x.userId !== "u-r1");
    await assert.rejects(e.delivery.updateLocation(riderActor("u-r1"), id, { lat: 1, lng: 1 }), { code: "RIDER_NOT_AUTHORIZED" });
  });
  it("shows precise coordinates only to the order's owner and to dispatch — not to other order readers or strangers", async () => {
    const e = setup(); const r = await makeRider(e, "u-r1"); const o = await packedOrder(e);
    const id = await toOutForDelivery(e, o, r.id, "u-r1");
    await e.delivery.updateLocation(riderActor("u-r1"), id, { lat: 27.7, lng: 85.3 });
    assert.deepEqual((await e.delivery.tracking(customer, o.id)).delivery.location.lat, 27.7);
    assert.equal((await e.delivery.tracking(dispatcher, o.id)).delivery.location.lat, 27.7);
    assert.equal((await e.delivery.tracking(staffOrders, o.id)).delivery.location, null, "orders:read_all alone sees status, not coordinates");
    await assert.rejects(e.delivery.tracking({ id: "u-stranger", permissions: [] }, o.id), { code: "ORDER_NOT_FOUND" });
    await assert.rejects(e.delivery.tracking(riderActor("u-r1"), o.id), { code: "ORDER_NOT_FOUND" }, "even the rider reads tracking only through the rider API");
  });
});

describe("rider data privacy", () => {
  it("customer contact details are visible while the delivery is the rider's, and dropped once it is closed", async () => {
    const e = setup(); const r = await makeRider(e, "u-r1"); const o = await packedOrder(e);
    const d = await e.delivery.assign(dispatcher, o.id, { riderId: r.id }, ctx);
    const open = (await e.delivery.listMine(riderActor("u-r1"), {}))[0];
    assert.equal(open.order.shipTo.phone, "+1 555 0190");
    await e.delivery.decline(riderActor("u-r1"), d.id, { reason: "too far" }, ctx);
    const row = e.db.deliveries.find((x) => x.id === d.id);
    const closed = toDeliveryDto({ ...(await e.repos.delivery.getDelivery({}, d.id)), ...row });
    assert.deepEqual(Object.keys(closed.order.shipTo).sort(), ["city", "ward"]);
    assert.ok(!JSON.stringify(closed).includes("Maple"), "no street");
    assert.ok(!JSON.stringify(closed).includes("555 0190"), "no phone");
  });
  it("the claimable list never carries street, name or phone", async () => {
    const e = setup(); await makeRider(e, "u-r1"); await packedOrder(e);
    const text = JSON.stringify(await e.delivery.listClaimable(riderActor("u-r1")));
    for (const secret of ["Maple", "555 0190", "Alex"]) assert.ok(!text.includes(secret), secret);
  });
});

describe("admin changes revoke rider access at once", () => {
  it("takes the rider off duty when the user is deactivated or loses the delivery role (repository hook)", async () => {
    const e = setup(); await makeRider(e, "u-r1");
    assert.equal(e.db.riders[0].is_available, true);
    assert.equal(await e.repos.delivery.setUnavailableForUser({}, "u-r1"), 1);
    assert.equal(e.db.riders[0].is_available, false);
    assert.equal(await e.repos.delivery.setUnavailableForUser({}, "u-r1"), 0, "idempotent");
  });
});
