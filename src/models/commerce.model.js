import { toNumber } from "../utils/text.js";

export const toAddressDto = (r) => ({
  id: r.id, label: r.label, name: r.name, phone: r.phone, line1: r.line1, line2: r.line2 ?? "", city: r.city ?? "", zip: r.zip ?? "",
  provinceId: r.province_id ?? null, districtId: r.district_id ?? null, municipalityId: r.municipality_id ?? null, ward: r.ward ?? "",
  instructions: r.instructions ?? "", isDefault: r.is_default,
});

/** `snapshot` is the address object stored on the order (already the same shape as toAddressDto's output, minus id). */
export function toOrderDto(r, { items = [], history = [], includeOtp = false } = {}) {
  const dto = {
    id: r.id, number: r.number, placedAt: r.placed_at, storeId: r.branch_id, status: r.status,
    items: items.map((it) => ({ productId: it.product_id, variantId: it.variant_id, sellerId: it.seller_id, name: it.name, qty: it.qty, unitPrice: toNumber(it.unit_price), lineTotal: toNumber(it.line_total) })),
    // Proxy from the delivery snapshot — good enough for display (seller/admin tables show a name + phone).
    // A first-class customer profile (id/email) can be added once those screens need more than that.
    customer: { name: r.address?.name, phone: r.address?.phone },
    shipTo: r.address, addressId: r.address_id, paymentMethod: r.payment_method, paymentStatus: r.payment_status,
    deliveryOption: r.delivery_option_id, slot: r.slot,
    totals: { subtotal: toNumber(r.subtotal), discount: toNumber(r.discount), deliveryFee: toNumber(r.delivery_fee), tax: toNumber(r.tax), total: toNumber(r.total) },
    couponCode: r.coupon_code, notes: r.notes, instructions: r.instructions,
    otpRequired: r.otp_required, otp: includeOtp ? r.otp : undefined,
    partner: r.partner ?? null, eta: r.eta, deliveredAt: r.delivered_at, cancelledAt: r.cancelled_at, cancelReason: r.cancel_reason, returnedAt: r.returned_at,
    history: history.map((h) => ({ status: h.status, at: h.at, note: h.note ?? undefined })),
  };
  return dto;
}
