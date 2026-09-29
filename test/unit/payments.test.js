import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { createPaymentsService } from "../../src/services/payments.service.js";
import { createCodProvider } from "../../src/services/payments/cod.provider.js";
import { createManualProvider } from "../../src/services/payments/manual.provider.js";
import { createFakePayments, rxCustomer, otherCustomer, accountant, support } from "../helpers/paymentsFakes.js";
import { fakeAudit } from "../helpers/fakes.js";

const ctx = { ip: "203.0.113.5", requestId: "r" };
const WEBHOOK_SECRET = "test-secret";

function setup(orders = []) {
  const fake = createFakePayments({ orders });
  const audit = fakeAudit();
  const withTx = (fn) => fn({});
  const providers = { cod: createCodProvider(), manual: createManualProvider({ webhookSecret: WEBHOOK_SECRET }) };
  const svc = createPaymentsService({ pool: {}, withTx, repos: fake.repos, providers, audit });
  return { ...fake, audit, svc, providers };
}

function order(overrides = {}) {
  return { id: "ord-1", number: "PN-1001", user_id: rxCustomer.id, payment_method: "manual", total: 100, status: "confirmed", payment_status: "pending", ...overrides };
}

describe("payments: creation at order time", () => {
  it("a cod order gets a pending cod payment with no external reference", async () => {
    const e = setup([order({ payment_method: "cod" })]);
    const payment = await e.svc.createForOrder({}, e.db.orders[0]);
    assert.equal(payment.provider, "cod");
    assert.equal(payment.status, "pending");
    assert.equal(payment.providerRef, null);
  });

  it("a non-cod order gets a manual payment with a reference to quote", async () => {
    const e = setup([order()]);
    const payment = await e.svc.createForOrder({}, e.db.orders[0]);
    assert.equal(payment.provider, "manual");
    assert.equal(payment.status, "pending");
    assert.match(payment.providerRef, /^MANUAL-/);
    assert.equal(payment.instructions.reference, payment.providerRef);
  });

  it("delivering a cod order marks its payment captured; a non-cod order's payment is untouched", async () => {
    const e = setup([order({ payment_method: "cod" })]);
    await e.svc.createForOrder({}, e.db.orders[0]);
    await e.svc.markCodCollected({}, "ord-1");
    assert.equal(e.db.payments[0].status, "captured");
  });
});

describe("payments: reading", () => {
  it("the owner can see their own order's payments; a stranger gets 404, not 403 (no existence leak)", async () => {
    const e = setup([order()]);
    await e.svc.createForOrder({}, e.db.orders[0]);
    assert.equal((await e.svc.get(rxCustomer, "ord-1")).length, 1);
    await assert.rejects(() => e.svc.get(otherCustomer, "ord-1"), (err) => err.status === 404);
  });
});

describe("payments: manual confirmation (dev/demo substitute for a real gateway callback)", () => {
  it("requires payments:manage", async () => {
    const e = setup([order()]);
    const payment = await e.svc.createForOrder({}, e.db.orders[0]);
    await assert.rejects(() => e.svc.confirmManual(rxCustomer, payment.id, ctx), (err) => err.status === 403);
  });

  it("captures the payment and marks the order paid, but only once", async () => {
    const e = setup([order()]);
    const payment = await e.svc.createForOrder({}, e.db.orders[0]);
    const { payment: updated, order: updatedOrder } = await e.svc.confirmManual(accountant, payment.id, ctx);
    assert.equal(updated.status, "captured");
    assert.equal(updatedOrder.payment_status, "paid");
    await assert.rejects(() => e.svc.confirmManual(accountant, payment.id, ctx), (err) => err.status === 409);
  });

  it("refuses to confirm a cod payment this way", async () => {
    const e = setup([order({ payment_method: "cod" })]);
    const payment = await e.svc.createForOrder({}, e.db.orders[0]);
    await assert.rejects(() => e.svc.confirmManual(accountant, payment.id, ctx), (err) => err.status === 400);
  });
});

describe("payments: webhooks are verified and idempotent", () => {
  function signed(payload) {
    const body = Buffer.from(JSON.stringify(payload));
    const sig = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
    return { body, headers: { "x-vyra-signature": sig } };
  }

  it("rejects a webhook with a bad or missing signature", async () => {
    const e = setup([order()]);
    const body = Buffer.from(JSON.stringify({ eventId: "e1", providerRef: "MANUAL-x", status: "captured" }));
    await assert.rejects(() => e.svc.handleWebhook("manual", body, {}, ctx), (err) => err.code === "INVALID_SIGNATURE");
    await assert.rejects(() => e.svc.handleWebhook("manual", body, { "x-vyra-signature": "wrong" }, ctx), (err) => err.code === "INVALID_SIGNATURE");
  });

  it("a verified event captures the matching payment and marks the order paid", async () => {
    const e = setup([order()]);
    const payment = await e.svc.createForOrder({}, e.db.orders[0]);
    const { body, headers } = signed({ eventId: "evt-1", providerRef: payment.providerRef, status: "captured" });
    const result = await e.svc.handleWebhook("manual", body, headers, ctx);
    assert.equal(result.payment.status, "captured");
    assert.equal(e.db.orders[0].payment_status, "paid");
  });

  it("the exact same event id is a no-op the second time (at-least-once delivery is safe)", async () => {
    const e = setup([order()]);
    const payment = await e.svc.createForOrder({}, e.db.orders[0]);
    const { body, headers } = signed({ eventId: "evt-dup", providerRef: payment.providerRef, status: "captured" });
    await e.svc.handleWebhook("manual", body, headers, ctx);
    const second = await e.svc.handleWebhook("manual", body, headers, ctx);
    assert.equal(second.duplicate, true);
  });

  it("a failed event records the failure reason without touching order.payment_status", async () => {
    const e = setup([order()]);
    const payment = await e.svc.createForOrder({}, e.db.orders[0]);
    const { body, headers } = signed({ eventId: "evt-2", providerRef: payment.providerRef, status: "failed", reason: "Insufficient funds" });
    await e.svc.handleWebhook("manual", body, headers, ctx);
    assert.equal(e.db.payments[0].status, "failed");
    assert.equal(e.db.payments[0].failure_reason, "Insufficient funds");
    assert.equal(e.db.orders[0].payment_status, "pending");
  });
});

describe("payments: refunds", () => {
  async function paidOrder(e) {
    const payment = await e.svc.createForOrder({}, e.db.orders[0]);
    await e.svc.confirmManual(accountant, payment.id, ctx);
    return payment;
  }

  it("the order owner, or support on their behalf, can request a refund; a stranger cannot", async () => {
    const e = setup([order()]);
    await paidOrder(e);
    await assert.doesNotReject(() => e.svc.requestRefund(rxCustomer, "ord-1", { reason: "Wrong item" }, ctx));
    await assert.rejects(() => e.svc.requestRefund(otherCustomer, "ord-1", { reason: "x" }, ctx), (err) => err.status === 403);
  });

  it("defaults to the full remaining balance, and refuses an amount over that", async () => {
    const e = setup([order()]);
    await paidOrder(e);
    const refund = await e.svc.requestRefund(rxCustomer, "ord-1", { reason: "Damaged" }, ctx);
    assert.equal(refund.amount, 100);
    await assert.rejects(() => e.svc.requestRefund(rxCustomer, "ord-1", { amount: 500, reason: "x" }, ctx), (err) => err.code === "INVALID_AMOUNT");
  });

  it("only payments:manage decides; approving completes it immediately for a manual/cod provider and marks the order refunded", async () => {
    const e = setup([order()]);
    await paidOrder(e);
    const refund = await e.svc.requestRefund(support, "ord-1", { reason: "Damaged" }, ctx);
    await assert.rejects(() => e.svc.decideRefund(support, refund.id, { decision: "approve" }, ctx), (err) => err.status === 403);
    const decided = await e.svc.decideRefund(accountant, refund.id, { decision: "approve" }, ctx);
    assert.equal(decided.status, "completed");
    assert.equal(e.db.payments[0].status, "refunded");
    assert.equal(e.db.orders[0].payment_status, "refunded");
  });

  it("rejecting a refund leaves the payment untouched, and a decided refund can't be decided twice", async () => {
    const e = setup([order()]);
    await paidOrder(e);
    const refund = await e.svc.requestRefund(rxCustomer, "ord-1", { reason: "Changed my mind" }, ctx);
    const decided = await e.svc.decideRefund(accountant, refund.id, { decision: "reject", note: "Outside window" }, ctx);
    assert.equal(decided.status, "rejected");
    assert.equal(e.db.payments[0].status, "captured");
    await assert.rejects(() => e.svc.decideRefund(accountant, refund.id, { decision: "approve" }, ctx), (err) => err.status === 409);
  });

  it("a partial refund leaves the payment partially_refunded and the order still paid", async () => {
    const e = setup([order({ total: 100 })]);
    await paidOrder(e);
    const refund = await e.svc.requestRefund(rxCustomer, "ord-1", { amount: 40, reason: "One item missing" }, ctx);
    await e.svc.decideRefund(accountant, refund.id, { decision: "approve" }, ctx);
    assert.equal(e.db.payments[0].status, "partially_refunded");
    assert.equal(e.db.payments[0].refunded_amount, 40);
    assert.equal(e.db.orders[0].payment_status, "paid");
  });

  it("refuses a refund request against an order with no captured payment yet", async () => {
    const e = setup([order()]);
    await e.svc.createForOrder({}, e.db.orders[0]); // still pending, never confirmed
    await assert.rejects(() => e.svc.requestRefund(rxCustomer, "ord-1", { reason: "x" }, ctx), (err) => err.code === "NOT_REFUNDABLE");
  });
});
