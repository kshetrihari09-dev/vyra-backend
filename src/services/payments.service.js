import { toPaymentDto, toRefundDto } from "../models/payments.model.js";
import { badRequest, conflict, forbidden, notFound } from "../utils/errors.js";

const can = (actor, perm) => !!actor?.permissions?.includes(perm);

/** provider name for a given order payment method — every non-cash method goes through "manual" until a
    real gateway (eSewa/Khalti/card) is wired in (decision D10). */
const providerFor = (paymentMethod) => (paymentMethod === "cod" ? "cod" : "manual");

export function createPaymentsService({ pool, withTx, repos, providers, audit, notifications = { emit: async () => null } }) {
  const repo = repos.payments;

  function provider(name) {
    const p = providers[name];
    if (!p) throw badRequest("UNKNOWN_PROVIDER", `No payment provider registered for "${name}"`);
    return p;
  }

  async function assertOrderReadable(order, actor) {
    if (!order) throw notFound("ORDER_NOT_FOUND", "Order not found");
    if (order.user_id !== actor?.id && !can(actor, "orders:read_all") && !can(actor, "payments:manage")) throw notFound("ORDER_NOT_FOUND", "Order not found");
  }

  async function notifyRefund(db, refund, type, extra) {
    const order = await repos.orders.getById(db, refund.order_id);
    if (order) await notifications.emit(db, { userId: order.user_id, type, data: { orderId: order.id, number: order.number, amount: refund.amount, ...extra } });
  }

  return {
    /**
     * Runs INSIDE the caller's order-creation transaction (`db` is that transaction's client) so the payment
     * row commits or rolls back atomically with the order it belongs to. Called once, right after the order
     * insert, by orders.service#create.
     */
    async createForOrder(db, order) {
      const name = providerFor(order.payment_method);
      const { status, providerRef, instructions } = await provider(name).initiate({ order });
      const row = await repo.insert(db, { orderId: order.id, provider: name, method: order.payment_method, status, amount: order.total, instructions });
      if (providerRef) await repo.update(db, row.id, { providerRef });
      return toPaymentDto(await repo.getById(db, row.id));
    },

    /** Called by orders.service when a COD order reaches "delivered" — the moment cash actually changes hands. */
    async markCodCollected(db, orderId) {
      const payment = await repo.getActiveForOrder(db, orderId, { forUpdate: true });
      if (!payment || payment.provider !== "cod") return null;
      return repo.update(db, payment.id, { status: "captured", capturedAt: new Date() });
    },

    /** Called when a COD order's final delivery attempt fails: no cash ever changed hands, so the pending payment is closed out. */
    async markCodNotCollected(db, orderId) {
      const payment = await repo.getActiveForOrder(db, orderId, { forUpdate: true });
      if (!payment || payment.provider !== "cod") return null;
      return repo.update(db, payment.id, { status: "cancelled" });
    },

    /**
     * Runs inside orders.service#cancel's transaction, AFTER the order row is locked (lock order is always order → payment).
     *  • nothing collected yet (pending / authorized — prepaid not yet paid, or COD): the payment is closed ("cancelled") so a
     *    late payment can't be applied to a dead order, and the order's payment_status becomes "not_collected";
     *  • already captured: one refund for the remaining balance is queued for finance to approve through the normal refund
     *    flow (the order stays "paid" until that refund completes). Never queued twice.
     * Returns the order columns to patch.
     */
    async settleOnCancel(db, order, actor, ctx) {
      const payment = await repo.getActiveForOrder(db, order.id, { forUpdate: true });
      if (!payment) return {};
      if (["captured", "partially_refunded"].includes(payment.status)) {
        const remaining = Number(payment.amount) - Number(payment.refunded_amount);
        const alreadyQueued = (await repo.listRefunds(db, { orderId: order.id, status: "pending" })).length > 0;
        if (remaining > 0.005 && !alreadyQueued) {
          const refund = await repo.insertRefund(db, { paymentId: payment.id, orderId: order.id, amount: Number(remaining.toFixed(2)), reason: "Order cancelled before fulfilment", requestedBy: actor.id });
          await audit.log({ actor, action: "refund.requested", entityType: "refund", entityId: refund.id, newValue: { orderId: order.id, amount: remaining, reason: "order cancelled" } }, ctx, db);
        }
        return {};
      }
      await repo.update(db, payment.id, { status: "cancelled" });
      return { paymentStatus: "not_collected" };
    },

    /**
     * "Pay again" for an order whose payment hasn't succeeded. It never creates a second order and never a second live
     * payment: if a pending payment already exists it is returned as-is (idempotent — a double-click or a retry storm gets the
     * same reference); only when the previous attempt failed (or was closed) is a fresh payment started for the SAME order.
     */
    async retry(actor, orderId, ctx) {
      return withTx(async (db) => {
        const order = await repos.orders.getById(db, orderId, { forUpdate: true });
        if (!order || order.user_id !== actor.id) throw notFound("ORDER_NOT_FOUND", "Order not found");
        if (order.payment_method === "cod") throw conflict("NOT_PREPAID", "Cash-on-delivery orders are paid to the rider — there's nothing to retry.");
        if (["cancelled", "returned", "delivered"].includes(order.status)) throw conflict("ORDER_CLOSED", "This order is closed, so it can't be paid.");
        if (order.payment_status === "paid") throw conflict("ALREADY_PAID", "This order is already paid.");
        if (order.payment_status !== "pending") throw conflict("NOT_PAYABLE", `This order's payment is "${order.payment_status}".`);

        const active = await repo.getActiveForOrder(db, orderId, { forUpdate: true });
        if (active?.status === "captured" || active?.status === "partially_refunded") throw conflict("ALREADY_PAID", "This order is already paid.");
        if (active) return { payment: toPaymentDto(active), created: false }; // still pending/authorized — reuse it

        const name = providerFor(order.payment_method);
        const { status, providerRef, instructions } = await provider(name).initiate({ order });
        const row = await repo.insert(db, { orderId, provider: name, method: order.payment_method, status, amount: order.total, instructions });
        if (providerRef) await repo.update(db, row.id, { providerRef });
        await audit.log({ actor, action: "payment.retried", entityType: "payment", entityId: row.id, newValue: { orderId } }, ctx, db);
        return { payment: toPaymentDto(await repo.getById(db, row.id)), created: true };
      });
    },

    async get(actor, orderId) {
      const order = await repos.orders.getById(pool, orderId);
      await assertOrderReadable(order, actor);
      const payments = await repo.listForOrder(pool, orderId);
      return payments.map(toPaymentDto);
    },

    /** Dev/demo substitute for a real gateway calling our webhook: staff confirm a manual payment by hand. */
    async confirmManual(actor, paymentId, ctx) {
      if (!can(actor, "payments:manage")) throw forbidden();
      return withTx(async (db) => {
        const peek = await repo.getById(db, paymentId);
        if (!peek) throw notFound("PAYMENT_NOT_FOUND", "Payment not found");
        const order = await repos.orders.getById(db, peek.order_id, { forUpdate: true }); // order first, then payment — same order as cancel
        const payment = await repo.getById(db, paymentId, { forUpdate: true });
        if (payment.provider !== "manual") throw badRequest("NOT_MANUAL", "Only manual payments can be confirmed this way");
        if (payment.status !== "pending") throw conflict("NOT_PENDING", `Payment is already "${payment.status}"`); // a second confirm is a no-op error, not a second capture
        if (["cancelled", "returned"].includes(order.status)) throw conflict("ORDER_CLOSED", `Order is "${order.status}" — its payment can't be confirmed.`);
        const updated = await repo.update(db, payment.id, { status: "captured", capturedAt: new Date() });
        const updatedOrder = await repos.orders.updateStatus(db, payment.order_id, order.status, { paymentStatus: "paid" });
        await audit.log({ actor, action: "payment.confirmed", entityType: "payment", entityId: payment.id, oldValue: { status: "pending" }, newValue: { status: "captured" } }, ctx, db);
        return { payment: toPaymentDto(updated), order: updatedOrder };
      });
    },

    /** Verified inbound webhook from a payment provider. Idempotent: the same event id is only ever applied once. */
    async handleWebhook(providerName, rawBody, headers, ctx) {
      const p = provider(providerName);
      if (!p.verifyWebhookSignature(rawBody, headers)) throw badRequest("INVALID_SIGNATURE", "Webhook signature could not be verified");
      let payload;
      try { payload = JSON.parse(rawBody.toString("utf8")); } catch { throw badRequest("INVALID_PAYLOAD", "Webhook body is not valid JSON"); }
      const event = p.parseWebhookEvent(payload);
      if (!event) throw badRequest("INVALID_PAYLOAD", "Webhook payload is missing required fields");

      return withTx(async (db) => {
        // Lock order → payment (same order as cancel) so a capture and a cancel can't deadlock or interleave.
        const peek = await repo.getByProviderRef(db, providerName, event.providerRef);
        const order = peek ? await repos.orders.getById(db, peek.order_id, { forUpdate: true }) : null;
        const payment = peek ? await repo.getById(db, peek.id, { forUpdate: true }) : null;
        const recorded = await repo.insertWebhookEvent(db, { provider: providerName, eventId: event.eventId, paymentId: payment?.id, payload });
        if (!recorded) return { duplicate: true }; // already processed this exact event — no-op
        if (!payment) return { unmatched: true }; // recorded for audit trail even if we can't find the payment it refers to

        // Only a payment that is still waiting can change state. A repeat "captured" under a NEW event id, a "failed" that
        // arrives after the money was captured, or anything for a payment that was already closed must not rewrite history
        // or create a second capture: the event is kept in the ledger and answered 200, the payment is left as it is.
        const open = ["pending", "authorized"].includes(payment.status);
        if (!open) {
          const lateCapture = event.status === "captured" && ["failed", "cancelled"].includes(payment.status);
          await audit.log({ actorLabel: `webhook:${providerName}`, action: lateCapture ? "payment.late_capture" : "payment.webhook_ignored", entityType: "payment", entityId: payment.id, newValue: { event: event.status, current: payment.status } }, ctx, db);
          return { payment: toPaymentDto(payment), ignored: true };
        }

        const patch = { rawPayload: payload };
        if (event.status === "captured") { patch.status = "captured"; patch.capturedAt = new Date(); }
        else if (event.status === "failed") { patch.status = "failed"; patch.failedAt = new Date(); patch.failureReason = event.failureReason; }
        const updated = await repo.update(db, payment.id, patch);
        if (event.status === "captured") await repos.orders.updateStatus(db, payment.order_id, order.status, { paymentStatus: "paid" });
        await audit.log({ actorLabel: `webhook:${providerName}`, action: "payment.webhook", entityType: "payment", entityId: payment.id, newValue: { status: event.status } }, ctx, db);
        return { payment: toPaymentDto(updated) };
      });
    },

    /** Order owner, or support/accountant staff on the customer's behalf. Staff decide the outcome separately. */
    async requestRefund(actor, orderId, body, ctx) {
      return withTx(async (db) => {
        const order = await repos.orders.getById(db, orderId);
        if (!order) throw notFound("ORDER_NOT_FOUND", "Order not found");
        const owner = order.user_id === actor.id;
        if (!owner && !can(actor, "orders:refund")) throw forbidden();

        const payment = await repo.getActiveForOrder(db, orderId, { forUpdate: true });
        if (!payment || !["captured", "partially_refunded"].includes(payment.status)) throw conflict("NOT_REFUNDABLE", "This order has no captured payment to refund");
        const already = Number(payment.refunded_amount);
        const cap = Number(payment.amount) - already;
        const amount = body.amount != null ? Number(body.amount) : cap;
        if (amount <= 0 || amount > cap) throw badRequest("INVALID_AMOUNT", `Amount must be between Rs. 0 and Rs. ${cap.toFixed(2)}`);

        if ((await repo.listRefunds(db, { orderId, status: "pending" })).length) throw conflict("REFUND_ALREADY_PENDING", "A refund for this order is already waiting for a decision.");
        const refund = await repo.insertRefund(db, { paymentId: payment.id, orderId, amount, reason: body.reason, requestedBy: actor.id });
        await audit.log({ actor, action: "refund.requested", entityType: "refund", entityId: refund.id, newValue: { orderId, amount, reason: body.reason } }, ctx, db);
        return toRefundDto(refund);
      });
    },

    async listRefunds(actor, { status } = {}) {
      if (!can(actor, "payments:manage") && !can(actor, "orders:refund")) throw forbidden();
      return (await repo.listRefunds(pool, { status })).map(toRefundDto);
    },

    /** payments:manage decides every refund — approving calls the provider (immediate for cod/manual); rejecting just records why. */
    async decideRefund(actor, refundId, body, ctx) {
      if (!can(actor, "payments:manage")) throw forbidden();
      return withTx(async (db) => {
        const refund = await repo.getRefundById(db, refundId, { forUpdate: true });
        if (!refund) throw notFound("REFUND_NOT_FOUND", "Refund not found");
        if (refund.status !== "pending") throw conflict("ALREADY_DECIDED", `This refund was already "${refund.status}"`);

        if (body.decision === "reject") {
          const updated = await repo.updateRefund(db, refundId, { status: "rejected", decidedBy: actor.id, decidedAt: new Date(), decisionNote: body.note ?? null });
          await audit.log({ actor, action: "refund.rejected", entityType: "refund", entityId: refundId, newValue: { note: body.note } }, ctx, db);
          await notifyRefund(db, refund, "refund.rejected", { note: body.note });
          return toRefundDto(updated);
        }

        await repos.orders.getById(db, refund.order_id, { forUpdate: true }); // order first, then payment (see settleOnCancel)
        const payment = await repo.getById(db, refund.payment_id, { forUpdate: true });
        const newRefundedTotal = Number(payment.refunded_amount) + Number(refund.amount);
        if (newRefundedTotal > Number(payment.amount) + 0.005) throw conflict("REFUND_EXCEEDS_PAYMENT", "Approving this would refund more than was paid.");
        const result = await provider(payment.provider).refund({ payment, amount: Number(refund.amount) });
        const fullyRefunded = newRefundedTotal >= Number(payment.amount) - 0.005;
        await repo.update(db, payment.id, { refundedAmount: newRefundedTotal, status: fullyRefunded ? "refunded" : "partially_refunded" });
        if (fullyRefunded) {
          const order = await repos.orders.getById(db, refund.order_id);
          await repos.orders.updateStatus(db, refund.order_id, order.status, { paymentStatus: "refunded" });
        }
        const updated = await repo.updateRefund(db, refundId, { status: "completed", providerRef: result.providerRef, decidedBy: actor.id, decidedAt: new Date(), decisionNote: body.note ?? null });
        await audit.log({ actor, action: "refund.completed", entityType: "refund", entityId: refundId, newValue: { amount: refund.amount, providerRef: result.providerRef } }, ctx, db);
        await notifyRefund(db, refund, "refund.completed", {});
        return toRefundDto(updated);
      });
    },
  };
}
