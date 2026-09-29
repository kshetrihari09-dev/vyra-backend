import { toNumber } from "../utils/text.js";

export const toPaymentDto = (r) => ({
  id: r.id, orderId: r.order_id, provider: r.provider, method: r.method, status: r.status,
  currency: r.currency, amount: toNumber(r.amount), refundedAmount: toNumber(r.refunded_amount),
  providerRef: r.provider_ref, instructions: r.instructions ?? null, failureReason: r.failure_reason ?? null,
  authorizedAt: r.authorized_at, capturedAt: r.captured_at, failedAt: r.failed_at, createdAt: r.created_at,
});

export const toRefundDto = (r) => ({
  id: r.id, paymentId: r.payment_id, orderId: r.order_id, amount: toNumber(r.amount), reason: r.reason,
  status: r.status, providerRef: r.provider_ref, requestedBy: r.requested_by, decidedBy: r.decided_by,
  decidedAt: r.decided_at, decisionNote: r.decision_note, createdAt: r.created_at,
});
