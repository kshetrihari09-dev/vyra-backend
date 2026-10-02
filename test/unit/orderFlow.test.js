import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { STAGES, TRANSITIONS, actionsFor, assertTransition, canCancelFrom, canTransition } from "../../src/domain/orderRules.js";
import { createCouponsService } from "../../src/services/coupons.service.js";
import { createDeliveryService } from "../../src/services/delivery.service.js";
import { createOrdersService } from "../../src/services/orders.service.js";
import { createPaymentsService } from "../../src/services/payments.service.js";
import { createCodProvider } from "../../src/services/payments/cod.provider.js";
import { createManualProvider } from "../../src/services/payments/manual.provider.js";
import { createPricingService } from "../../src/services/pricing.service.js";
import { createDeliveryCodes } from "../../src/utils/deliveryCode.js";
import { customer, sellerMedico, sellerNova, staffOrders } from "../helpers/commerceFakes.js";
import { createFakeDelivery, dispatcher, riderActor } from "../helpers/deliveryFakes.js";
import { accountant, createFakePayments, otherCustomer } from "../helpers/paymentsFakes.js";
import { fakeAudit } from "../helpers/fakes.js";
import { recordingNotifications } from "../helpers/notificationFakes.js";

const ctx = { ip: "203.0.113.5", requestId: "r" };
const SECRET = "test-secret";
const codes = createDeliveryCodes(Buffer.alloc(32, 7).toString("base64"));

/** REAL orders + payments + delivery services over in-memory repositories — so these tests exercise the rules as they interact. */
function setup() {
  const fake = createFakeDelivery();
  const { db, key } = fake;
  for (const p of ["soap", "cough-syrup", "bandage"]) db.inventory.set(key("store-01", p, ""), { id: key("store-01", p, ""), on_hand: 200, reserved: 0 });
  db.addresses.push({ id: "addr-1", user_id: customer.id, label: "Home", name: "Alex", phone: "+1 555 0190", line1: "24 Maple Ct", city: "Metro", zip: "10245", is_default: true });
  db.users.set("u-r1", { name: "Daniel R.", status: "active" });

  const pay = createFakePayments({ orders: db.orders });
  const repos = { ...fake.repos, payments: pay.repos.payments };
  const audit = fakeAudit();
  const notifications = recordingNotifications();
  const withTx = (fn) => fn({});
  const providers = { cod: createCodProvider(), manual: createManualProvider({ webhookSecret: SECRET }) };
  const payments = createPaymentsService({ pool: {}, withTx, repos, providers, audit, notifications });
  const coupons = createCouponsService({ repos });
  const pricing = createPricingService({ repos, coupons });
  const prescriptions = { assertCoverage: async () => [], linkToOrder: async () => {} };
  const orders = createOrdersService({ pool: {}, withTx, repos, pricing, audit, prescriptions, payments, codes, notifications });
  const delivery = createDeliveryService({ pool: {}, withTx, repos, audit, payments, codes, notifications });
  return { db, key, pay, audit, notifications, payments, orders, delivery, repos };
}

const place = (e, { items = [{ productId: "soap", qty: 2 }], paymentMethod = "cod", actor = customer } = {}) =>
  e.orders.create(actor, { items, addressId: "addr-1", paymentMethod, deliveryOptionId: "standard" }, ctx);
const row = (e, id) => e.db.orders.find((o) => o.id === id);
const reserved = (e, product = "soap") => e.db.inventory.get(e.key("store-01", product, "")).reserved;
const onHand = (e, product = "soap") => e.db.inventory.get(e.key("store-01", product, "")).on_hand;
const paymentsOf = (e, orderId) => e.pay.db.payments.filter((p) => p.order_id === orderId);
const step = (e, id, status, actor = staffOrders) => e.orders.advance(actor, id, { status }, ctx);
const signed = (payload) => { const body = Buffer.from(JSON.stringify(payload)); return { body, headers: { "x-vyra-signature": createHmac("sha256", SECRET).update(body).digest("hex") } }; };
const webhook = (e, payload) => { const { body, headers } = signed(payload); return e.payments.handleWebhook("manual", body, headers, ctx); };
const capture = (e, ref, eventId = `evt-${ref}-cap`) => webhook(e, { eventId, providerRef: ref, status: "captured" });

// ------------------------------------------------------------------------------------------ pure rules
describe("order state machine (one authoritative table)", () => {
  it("allows exactly the documented forward flow", () => {
    const flow = ["placed", "confirmed", "preparing", "packed", "assigned", "out_for_delivery", "delivered"];
    assert.deepEqual(STAGES, flow);
    for (let i = 0; i < flow.length - 1; i++) assert.equal(canTransition(flow[i], flow[i + 1]), true, `${flow[i]} → ${flow[i + 1]}`);
  });

  it("rejects the invalid moves called out in the spec, and every skip / backwards move", () => {
    for (const [from, to] of [["delivered", "preparing"], ["delivered", "packed"], ["cancelled", "preparing"], ["returned", "delivered"],
      ["placed", "preparing"], ["placed", "packed"], ["confirmed", "packed"], ["preparing", "assigned"], ["packed", "delivered"],
      ["packed", "out_for_delivery"], ["delivered", "cancelled"], ["delivered", "returned"], ["cancelled", "placed"], ["packed", "cancelled"]]) {
      assert.equal(canTransition(from, to), false, `${from} → ${to}`);
      assert.throws(() => assertTransition(from, to), { code: "INVALID_TRANSITION" });
    }
    for (const final of ["delivered", "cancelled", "returned"]) assert.deepEqual(TRANSITIONS[final], []);
  });

  it("keeps the delivery side-exits: decline/unassign/failed attempt → packed, exhausted attempts → returned", () => {
    assert.equal(canTransition("assigned", "packed"), true);
    assert.equal(canTransition("out_for_delivery", "packed"), true);
    assert.equal(canTransition("out_for_delivery", "returned"), true);
  });

  it("cancellation is only possible before 'packed'", () => {
    for (const s of ["placed", "confirmed", "preparing"]) assert.equal(canCancelFrom(s), true, s);
    for (const s of ["packed", "assigned", "out_for_delivery", "delivered", "cancelled", "returned"]) assert.equal(canCancelFrom(s), false, s);
  });

  it("actionsFor: COD is never blocked; a prepaid order is blocked exactly at the packing step until paid", () => {
    const o = (status, payment_method, payment_status) => ({ status, payment_method, payment_status });
    assert.deepEqual(actionsFor(o("placed", "cod", "pending")), { next: "confirmed", blocked: null, canCancel: true });
    assert.deepEqual(actionsFor(o("preparing", "cod", "pending")), { next: "packed", blocked: null, canCancel: true });
    assert.deepEqual(actionsFor(o("preparing", "card", "pending")), { next: "packed", blocked: "PAYMENT_PENDING", canCancel: true });
    assert.deepEqual(actionsFor(o("confirmed", "card", "pending")), { next: "preparing", blocked: null, canCancel: true });
    assert.deepEqual(actionsFor(o("preparing", "card", "paid")), { next: "packed", blocked: null, canCancel: true });
    assert.deepEqual(actionsFor(o("packed", "card", "paid")), { next: null, blocked: null, canCancel: false });
    assert.deepEqual(actionsFor(o("delivered", "cod", "paid")), { next: null, blocked: null, canCancel: false });
  });
});

// ------------------------------------------------------------------------------------------ order numbers
describe("order numbers", () => {
  it("use the collision-safe PN-YYYYMMDD-NNNNNN format", async () => {
    const e = setup();
    const o = await place(e);
    assert.match(o.number, /^PN-\d{8}-\d{6}$/);
    assert.equal(o.orderNumber, o.number);
  });

  it("are unique across many concurrent order creations", async () => {
    const e = setup();
    const made = await Promise.all(Array.from({ length: 40 }, () => place(e, { items: [{ productId: "soap", qty: 1 }] })));
    assert.equal(new Set(made.map((o) => o.number)).size, 40);
    assert.equal(reserved(e), 40, "each concurrent order reserved its own stock — nothing lost, nothing doubled");
  });
});

// ------------------------------------------------------------------------------------------ happy paths
describe("end to end: COD", () => {
  it("placed → confirmed → preparing → packed → assigned → out_for_delivery → (OTP + cash) → delivered", async () => {
    const e = setup();
    const o = await place(e);
    assert.equal(o.status, "placed");
    assert.equal(o.paymentStatus, "pending");
    assert.equal(o.otp, undefined, "no OTP on the confirmation response");
    assert.equal(paymentsOf(e, o.id)[0].provider, "cod");

    await step(e, o.id, "confirmed"); await step(e, o.id, "preparing");
    assert.equal(reserved(e), 2, "still only reserved while preparing");
    await step(e, o.id, "packed");
    assert.equal(onHand(e), 198, "stock leaves exactly once, at packed");
    assert.equal(reserved(e), 0);

    await e.delivery.createRider(dispatcher, { userId: "u-r1", phone: "+1 555 0231", vehicle: "Scooter" }, ctx);
    const rider = riderActor("u-r1");
    await e.delivery.setAvailability(rider, true);
    const d = await e.delivery.assign(dispatcher, o.id, { riderId: e.db.riders[0].id }, ctx);
    assert.equal((await e.orders.get(customer, o.id)).otp?.length, 4, "the OTP appears once the order is assigned");
    await e.delivery.accept(rider, d.id, ctx);
    await e.delivery.pickup(rider, d.id, ctx);
    const otp = codes.codeFor(o.id, row(e, o.id).otp_nonce);
    await e.delivery.deliver(rider, d.id, { otp, cashCollected: Number(row(e, o.id).total) }, ctx);

    assert.equal(row(e, o.id).status, "delivered");
    assert.equal(row(e, o.id).payment_status, "paid");
    assert.equal(paymentsOf(e, o.id)[0].status, "captured");
    assert.equal(onHand(e), 198, "no second decrement on delivery");
  });
});

describe("end to end: prepaid", () => {
  it("payment pending blocks packing/dispatch; once the provider confirms, the same order carries on to delivery", async () => {
    const e = setup();
    const o = await place(e, { paymentMethod: "card" });
    assert.equal(o.paymentStatus, "pending", "choosing a prepaid method does not make an order paid");
    assert.equal(paymentsOf(e, o.id)[0].provider, "manual");
    assert.equal(o.actions.blocked, null, "confirming/preparing is still fine while payment is pending");

    await step(e, o.id, "confirmed"); await step(e, o.id, "preparing");
    assert.equal((await e.orders.get(customer, o.id)).actions.blocked, "PAYMENT_PENDING");
    await assert.rejects(step(e, o.id, "packed"), { code: "PAYMENT_PENDING", status: 409 });
    assert.equal(row(e, o.id).status, "preparing");
    assert.equal(onHand(e), 200, "nothing left the shelf");
    assert.equal(reserved(e), 2, "the reservation is untouched");

    await capture(e, paymentsOf(e, o.id)[0].provider_ref);
    assert.equal(row(e, o.id).payment_status, "paid");
    await step(e, o.id, "packed");

    await e.delivery.createRider(dispatcher, { userId: "u-r1", phone: "+1 555 0231", vehicle: "Scooter" }, ctx);
    const rider = riderActor("u-r1");
    await e.delivery.setAvailability(rider, true);
    const d = await e.delivery.assign(dispatcher, o.id, { riderId: e.db.riders[0].id }, ctx);
    await e.delivery.accept(rider, d.id, ctx); await e.delivery.pickup(rider, d.id, ctx);
    await e.delivery.deliver(rider, d.id, { otp: codes.codeFor(o.id, row(e, o.id).otp_nonce) }, ctx);
    assert.equal(row(e, o.id).status, "delivered");
    assert.equal(paymentsOf(e, o.id).length, 1, "one payment for the whole life of the order");
  });

  it("the gate also holds inside the delivery module (assign, claim, queue) even if an unpaid order somehow reaches 'packed'", async () => {
    const e = setup();
    const o = await place(e, { paymentMethod: "card" });
    Object.assign(row(e, o.id), { status: "packed" }); // simulate legacy / corrupted data
    await e.delivery.createRider(dispatcher, { userId: "u-r1", phone: "+1 555 0231", vehicle: "Scooter" }, ctx);
    const rider = riderActor("u-r1");
    await e.delivery.setAvailability(rider, true);
    await assert.rejects(e.delivery.assign(dispatcher, o.id, { riderId: e.db.riders[0].id }, ctx), { code: "PAYMENT_PENDING" });
    await assert.rejects(e.delivery.claim(rider, o.id, ctx), { code: "PAYMENT_PENDING" });
    assert.equal((await e.delivery.listClaimable(rider)).length, 0, "not offered to riders either");
    row(e, o.id).payment_status = "paid";
    assert.equal((await e.delivery.listClaimable(rider)).length, 1);
  });
});

// ------------------------------------------------------------------------------------------ payments
describe("payments: failure, retry and duplicate callbacks", () => {
  it("a failed payment leaves the order unpaid and undispatchable; retry reuses the SAME order and creates no second order", async () => {
    const e = setup();
    const o = await place(e, { paymentMethod: "card" });
    const first = paymentsOf(e, o.id)[0];
    await webhook(e, { eventId: "f1", providerRef: first.provider_ref, status: "failed", reason: "Card declined" });
    assert.equal(first.status, "failed");
    assert.equal(row(e, o.id).payment_status, "pending");
    await step(e, o.id, "confirmed"); await step(e, o.id, "preparing");
    await assert.rejects(step(e, o.id, "packed"), { code: "PAYMENT_PENDING" });

    const ordersBefore = e.db.orders.length;
    const retry = await e.payments.retry(customer, o.id, ctx);
    assert.equal(retry.created, true);
    assert.equal(retry.payment.status, "pending");
    assert.notEqual(retry.payment.providerRef, first.provider_ref);
    assert.equal(e.db.orders.length, ordersBefore, "no second order");

    const again = await e.payments.retry(customer, o.id, ctx); // double-click
    assert.equal(again.created, false);
    assert.equal(again.payment.id, retry.payment.id);
    assert.equal(paymentsOf(e, o.id).filter((p) => p.status === "pending").length, 1, "never two live payments");

    await capture(e, retry.payment.providerRef);
    assert.equal(row(e, o.id).payment_status, "paid");
    await step(e, o.id, "packed");
    assert.equal(row(e, o.id).status, "packed");
  });

  it("a duplicate callback (same OR new event id) never creates a second capture or rewrites the captured payment", async () => {
    const e = setup();
    const o = await place(e, { paymentMethod: "card" });
    const p = paymentsOf(e, o.id)[0];
    await capture(e, p.provider_ref, "evt-A");
    const capturedAt = p.captured_at;
    assert.equal((await capture(e, p.provider_ref, "evt-A")).duplicate, true);
    const second = await capture(e, p.provider_ref, "evt-B");
    assert.equal(second.ignored, true);
    assert.equal(p.captured_at, capturedAt);
    assert.equal(paymentsOf(e, o.id).length, 1);
    // a "failed" event arriving after the money was captured must not flip it back
    await webhook(e, { eventId: "evt-late-fail", providerRef: p.provider_ref, status: "failed", reason: "late" });
    assert.equal(p.status, "captured");
    assert.equal(row(e, o.id).payment_status, "paid");
  });

  it("a capture that arrives for an already-failed attempt is parked for reconciliation, not applied", async () => {
    const e = setup();
    const o = await place(e, { paymentMethod: "card" });
    const first = paymentsOf(e, o.id)[0];
    await webhook(e, { eventId: "f1", providerRef: first.provider_ref, status: "failed" });
    const retry = await e.payments.retry(customer, o.id, ctx);
    const late = await capture(e, first.provider_ref, "evt-late");
    assert.equal(late.ignored, true);
    assert.equal(first.status, "failed");
    assert.equal(row(e, o.id).payment_status, "pending");
    assert.ok(e.audit.entries.some((a) => a.action === "payment.late_capture"));
    assert.equal(paymentsOf(e, o.id).find((p) => p.id === retry.payment.id).status, "pending");
  });

  it("retry is owner-only, prepaid-only, and refused once paid or closed", async () => {
    const e = setup();
    const cod = await place(e);
    await assert.rejects(e.payments.retry(customer, cod.id, ctx), { code: "NOT_PREPAID" });
    const o = await place(e, { paymentMethod: "card" });
    await assert.rejects(e.payments.retry(otherCustomer, o.id, ctx), { code: "ORDER_NOT_FOUND" });
    await capture(e, paymentsOf(e, o.id)[0].provider_ref);
    await assert.rejects(e.payments.retry(customer, o.id, ctx), { code: "ALREADY_PAID" });
    const closed = await place(e, { paymentMethod: "card" });
    await e.orders.cancel(customer, closed.id, {}, ctx);
    await assert.rejects(e.payments.retry(customer, closed.id, ctx), { code: "ORDER_CLOSED" });
  });

  it("manual confirmation is idempotent-by-refusal and can't pay a cancelled order", async () => {
    const e = setup();
    const o = await place(e, { paymentMethod: "card" });
    const p = paymentsOf(e, o.id)[0];
    await e.payments.confirmManual(accountant, p.id, ctx);
    await assert.rejects(e.payments.confirmManual(accountant, p.id, ctx), { code: "NOT_PENDING" });
    assert.equal(paymentsOf(e, o.id).length, 1);
    const c = await place(e, { paymentMethod: "card" });
    const cp = paymentsOf(e, c.id)[0];
    await e.orders.cancel(customer, c.id, {}, ctx);
    await assert.rejects(e.payments.confirmManual(accountant, cp.id, ctx), { code: "NOT_PENDING" });
  });
});

// ------------------------------------------------------------------------------------------ cancellation
describe("cancellation", () => {
  it("before 'packed' it releases the reservation exactly once and closes an unpaid payment", async () => {
    const e = setup();
    const o = await place(e, { paymentMethod: "card" });
    assert.equal(reserved(e), 2);
    const cancelled = await e.orders.cancel(customer, o.id, { reason: "changed my mind" }, ctx);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(reserved(e), 0);
    assert.equal(onHand(e), 200);
    assert.equal(paymentsOf(e, o.id)[0].status, "cancelled");
    assert.equal(cancelled.paymentStatus, "not_collected");
    await assert.rejects(e.orders.cancel(customer, o.id, {}, ctx), { code: "ALREADY_FINAL" });
    assert.equal(reserved(e), 0, "a second cancel doesn't release again");
    // a late capture must not resurrect the payment of a dead order
    const late = await capture(e, paymentsOf(e, o.id)[0].provider_ref);
    assert.equal(late.ignored, true);
    assert.equal(row(e, o.id).payment_status, "not_collected");
  });

  it("a paid order that is cancelled queues exactly one refund for finance; the order stays 'paid' until it completes", async () => {
    const e = setup();
    const o = await place(e, { paymentMethod: "card" });
    await capture(e, paymentsOf(e, o.id)[0].provider_ref);
    await e.orders.cancel(customer, o.id, {}, ctx);
    assert.equal(e.pay.db.refunds.length, 1);
    assert.equal(e.pay.db.refunds[0].status, "pending");
    assert.equal(Number(e.pay.db.refunds[0].amount), Number(row(e, o.id).total));
    assert.equal(row(e, o.id).payment_status, "paid");
    await assert.rejects(e.payments.requestRefund(customer, o.id, { reason: "again" }, ctx), { code: "REFUND_ALREADY_PENDING" });
    await e.payments.decideRefund(accountant, e.pay.db.refunds[0].id, { decision: "approve" }, ctx);
    assert.equal(row(e, o.id).payment_status, "refunded");
  });

  it("a cancelled COD order closes its cash payment", async () => {
    const e = setup();
    const o = await place(e);
    await e.orders.cancel(customer, o.id, {}, ctx);
    assert.equal(paymentsOf(e, o.id)[0].status, "cancelled");
    assert.equal(row(e, o.id).payment_status, "not_collected");
  });

  it("from 'packed' on the backend refuses with TOO_LATE_TO_CANCEL for everyone, and the DTO says so (so the UI hides the button)", async () => {
    const e = setup();
    const o = await place(e);
    assert.equal(o.actions.canCancel, true);
    await step(e, o.id, "confirmed"); await step(e, o.id, "preparing"); await step(e, o.id, "packed");
    const view = await e.orders.get(customer, o.id);
    assert.equal(view.actions.canCancel, false);
    await assert.rejects(e.orders.cancel(customer, o.id, {}, ctx), { code: "TOO_LATE_TO_CANCEL" });
    await assert.rejects(e.orders.cancel(staffOrders, o.id, {}, ctx), { code: "TOO_LATE_TO_CANCEL" });
    for (const status of ["assigned", "out_for_delivery"]) {
      row(e, o.id).status = status;
      await assert.rejects(e.orders.cancel(customer, o.id, {}, ctx), { code: "TOO_LATE_TO_CANCEL" }, status);
    }
    for (const status of ["delivered", "returned"]) {
      row(e, o.id).status = status;
      await assert.rejects(e.orders.cancel(customer, o.id, {}, ctx), { code: "ALREADY_FINAL" }, status);
    }
  });
  // Two simultaneous cancels are serialised by the order row lock (SELECT … FOR UPDATE), which these in-memory fakes
  // don't have — that guarantee is asserted against real Postgres in test/integration/orderFlow.test.js.
});

// ------------------------------------------------------------------------------------------ sellers & ownership
describe("seller access is scoped to their own shop's orders", () => {
  it("a shop owner lists and fulfils orders that contain ONLY their products; another shop gets 'not found'", async () => {
    const e = setup();
    const novaOrder = await place(e, { items: [{ productId: "soap", qty: 1 }] });
    const seen = await e.orders.list(sellerNova);
    assert.deepEqual(seen.map((o) => o.id), [novaOrder.id]);
    assert.equal(seen[0].sellerView.soleSeller, true);

    await assert.rejects(e.orders.get(sellerMedico, novaOrder.id), { code: "ORDER_NOT_FOUND" });
    assert.deepEqual(await e.orders.list(sellerMedico), []);
    for (const attempt of [() => step(e, novaOrder.id, "confirmed", sellerMedico), () => e.orders.cancel(sellerMedico, novaOrder.id, {}, ctx)]) {
      await assert.rejects(attempt(), { code: "ORDER_NOT_FOUND" });
    }
    assert.equal(row(e, novaOrder.id).status, "placed", "the other shop changed nothing");

    assert.equal((await step(e, novaOrder.id, "confirmed", sellerNova)).status, "confirmed");
    await step(e, novaOrder.id, "preparing", sellerNova);
    assert.equal((await step(e, novaOrder.id, "packed", sellerNova)).status, "packed");
    await assert.rejects(step(e, novaOrder.id, "assigned", sellerNova), { code: "USE_DELIVERY_FLOW" }, "a shop can't dispatch or deliver");
  });

  it("a shop owner can cancel their own order before packed, and is refused after", async () => {
    const e = setup();
    const o = await place(e, { items: [{ productId: "soap", qty: 1 }] });
    assert.equal((await e.orders.cancel(sellerNova, o.id, { reason: "out of stock" }, ctx)).status, "cancelled");
    const o2 = await place(e, { items: [{ productId: "soap", qty: 1 }] });
    await step(e, o2.id, "confirmed", sellerNova); await step(e, o2.id, "preparing", sellerNova); await step(e, o2.id, "packed", sellerNova);
    await assert.rejects(e.orders.cancel(sellerNova, o2.id, {}, ctx), { code: "TOO_LATE_TO_CANCEL" });
  });

  it("a shared basket is visible (own lines only) but its status is not a single shop's to change", async () => {
    const e = setup();
    const shared = await place(e, { items: [{ productId: "soap", qty: 1 }, { productId: "bandage", qty: 1 }] });
    const nova = (await e.orders.list(sellerNova))[0];
    assert.deepEqual(nova.items.map((i) => i.productId), ["soap"], "no other seller's lines leak");
    assert.equal(nova.sellerView.soleSeller, false);
    await assert.rejects(step(e, shared.id, "confirmed", sellerNova), { code: "ORDER_NOT_FOUND" });
    await assert.rejects(e.orders.cancel(sellerNova, shared.id, {}, ctx), { code: "ORDER_NOT_FOUND" });
    assert.equal((await step(e, shared.id, "confirmed", staffOrders)).status, "confirmed", "staff coordinate shared baskets");
  });

  it("a seller can't pack an unpaid prepaid order, and never sees the handover code", async () => {
    const e = setup();
    const o = await place(e, { items: [{ productId: "soap", qty: 1 }], paymentMethod: "card" });
    await step(e, o.id, "confirmed", sellerNova); await step(e, o.id, "preparing", sellerNova);
    await assert.rejects(step(e, o.id, "packed", sellerNova), { code: "PAYMENT_PENDING" });
    row(e, o.id).status = "out_for_delivery";
    assert.equal((await e.orders.get(sellerNova, o.id)).otp, undefined);
    assert.equal((await e.orders.list(sellerNova))[0].otp, undefined);
  });
});

describe("customer ownership and unauthorised changes", () => {
  it("a customer can't read, advance or cancel someone else's order, and can't drive fulfilment on their own", async () => {
    const e = setup();
    const o = await place(e);
    await assert.rejects(e.orders.get(otherCustomer, o.id), { code: "ORDER_NOT_FOUND" });
    assert.deepEqual(await e.orders.list(otherCustomer), []);
    await assert.rejects(step(e, o.id, "confirmed", customer), { status: 403 });
    await assert.rejects(step(e, o.id, "confirmed", otherCustomer), { status: 403 });
    await assert.rejects(e.orders.cancel(otherCustomer, o.id, {}, ctx), { status: 403 });
    await assert.rejects(e.payments.get(otherCustomer, o.id), { code: "ORDER_NOT_FOUND" });
    assert.equal(row(e, o.id).status, "placed");
  });

  it("invalid transitions are rejected by the service even from staff", async () => {
    const e = setup();
    const o = await place(e);
    await assert.rejects(step(e, o.id, "preparing"), { code: "INVALID_TRANSITION" });
    await assert.rejects(step(e, o.id, "packed"), { code: "INVALID_TRANSITION" });
    await step(e, o.id, "confirmed");
    await assert.rejects(step(e, o.id, "confirmed"), { code: "INVALID_TRANSITION" });
    const done = await place(e);
    for (const status of ["delivered", "cancelled", "returned"]) {
      row(e, done.id).status = status;
      await assert.rejects(step(e, done.id, "preparing"), { code: "INVALID_TRANSITION" }, status);
      await assert.rejects(step(e, done.id, "packed"), { code: "INVALID_TRANSITION" }, status);
    }
  });
});

describe("order DTO", () => {
  it("carries the consistent field set and exposes no provider internals or handover code", async () => {
    const e = setup();
    const o = await place(e, { paymentMethod: "card" });
    for (const k of ["orderId", "orderNumber", "status", "paymentMethod", "paymentStatus", "subtotal", "deliveryFee", "discount", "tax", "total", "customer", "store", "items", "delivery", "timestamps", "actions"]) {
      assert.ok(k in o, `missing ${k}`);
    }
    assert.equal(o.total, o.totals.total);
    assert.equal(o.timestamps.placedAt, o.placedAt);
    const json = JSON.stringify(o);
    for (const secret of ["otp_nonce", "provider_ref", "providerRef", "raw_payload", "instructions\":{\"method"]) assert.ok(!json.includes(secret), secret);
    assert.equal(o.otp, undefined);
  });
});
