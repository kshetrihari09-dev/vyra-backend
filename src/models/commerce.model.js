import { actionsFor } from "../domain/orderRules.js";
import { stageOf } from "../domain/tracking.js";
import { toNumber } from "../utils/text.js";

export const toAddressDto = (r) => ({
  id: r.id, label: r.label, name: r.name, phone: r.phone, line1: r.line1, line2: r.line2 ?? "", city: r.city ?? "", zip: r.zip ?? "",
  provinceId: r.province_id ?? null, districtId: r.district_id ?? null, municipalityId: r.municipality_id ?? null, ward: r.ward ?? "",
  instructions: r.instructions ?? "", isDefault: r.is_default,
  lat: r.lat ?? null, lng: r.lng ?? null,
});

/** `otp` is the derived hand-off code (utils/deliveryCode.js) and is passed in ONLY for the order's owner, and only while
 *  the order is in the delivery phase (domain/orderRules.js) — the rider must never receive it (they get it from the
 *  customer), and it is never stored. `sellerView` is set only when a shop owner (not the buyer) is looking at the order:
 *  `items` has already been cut down to their own lines and `soleSeller` says whether that is the whole basket. */
export function toOrderDto(r, { items = [], history = [], otp = undefined, sellerView = undefined, active = null } = {}) {
  const totals = { subtotal: toNumber(r.subtotal), discount: toNumber(r.discount), deliveryFee: toNumber(r.delivery_fee), tax: toNumber(r.tax), total: toNumber(r.total) };
  const dto = {
    id: r.id, number: r.number, placedAt: r.placed_at, storeId: r.branch_id, status: r.status,
    items: items.map((it) => ({ productId: it.product_id, variantId: it.variant_id, sellerId: it.seller_id, name: it.name, qty: it.qty, unitPrice: toNumber(it.unit_price), lineTotal: toNumber(it.line_total) })),
    // Proxy from the delivery snapshot — good enough for display (seller/admin tables show a name + phone).
    // A first-class customer profile (id/email) can be added once those screens need more than that.
    customer: { name: r.address?.name, phone: r.address?.phone },
    shipTo: r.address, addressId: r.address_id, paymentMethod: r.payment_method,
    // Order-level mirror of the payment row: "pending" | "paid" (= payments.status "captured") | "refunded" | "not_collected".
    // The UI must show "Paid" only for "paid" — never because a prepaid method was chosen.
    paymentStatus: r.payment_status,
    deliveryOption: r.delivery_option_id, slot: r.slot,
    totals,
    couponCode: r.coupon_code, notes: r.notes, instructions: r.instructions,
    otpRequired: r.otp_required, otp,
    partner: r.partner ?? null, eta: r.eta, deliveredAt: r.delivered_at, cancelledAt: r.cancelled_at, cancelReason: r.cancel_reason, returnedAt: r.returned_at,
    history: history.map((h) => ({ status: h.status, at: h.at, note: h.note ?? undefined })),

    // ---- additive, consistent aliases (the original field names above are unchanged so nothing existing breaks) ----
    orderId: r.id, orderNumber: r.number,
    ...totals,                                   // subtotal, discount, deliveryFee, tax, total
    store: { id: r.branch_id },
    // `stage` is the customer-facing progress (domain/tracking.js) derived from the order + its active delivery — never stored.
    delivery: { status: r.status, partner: r.partner ?? null, eta: r.eta, deliveredAt: r.delivered_at, otpRequired: r.otp_required, stage: stageOf(r.status, active), etaSource: active?.eta_source ?? null },
    timestamps: { placedAt: r.placed_at, updatedAt: r.updated_at ?? null, deliveredAt: r.delivered_at, cancelledAt: r.cancelled_at, returnedAt: r.returned_at },
    // What may happen next, decided by the backend rules (domain/orderRules.js): the next fulfilment step, whether the
    // payment gate currently blocks it, and whether cancelling is still possible.
    actions: actionsFor(r),
  };
  if (sellerView) dto.sellerView = sellerView;
  return dto;
}
