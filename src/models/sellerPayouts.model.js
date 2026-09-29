import { toNumber } from "../utils/text.js";

export const toPayoutDto = (r) => ({
  id: r.id, sellerId: r.seller_id, amount: toNumber(r.amount), status: r.status,
  methodLabel: r.method_label ?? null, note: r.note ?? null, requestedBy: r.requested_by,
  decidedBy: r.decided_by ?? null, decidedAt: r.decided_at ?? null, paidAt: r.paid_at ?? null, createdAt: r.created_at,
});
