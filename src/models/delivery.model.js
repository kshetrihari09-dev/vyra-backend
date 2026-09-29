import { toNumber } from "../utils/text.js";

export const toRiderDto = (r) => ({
  id: r.id, userId: r.user_id, name: r.full_name ?? null, phone: r.phone, vehicle: r.vehicle,
  status: r.status, isAvailable: r.is_available,
  ...(r.active_count !== undefined ? { activeCount: Number(r.active_count) } : {}),
});

/** What a rider needs to do the job: full address and contact once a delivery is theirs. The handover code is NEVER here. */
export function toDeliveryDto(r, { events } = {}) {
  const addr = r.order_address ?? {};
  return {
    id: r.id, orderId: r.order_id, status: r.status, riderId: r.rider_id, riderName: r.rider_name ?? undefined,
    selfClaimed: r.self_claimed, assignedAt: r.created_at, acceptedAt: r.accepted_at, pickedUpAt: r.picked_up_at,
    deliveredAt: r.delivered_at, failureReason: r.failure_reason ?? null, failureNote: r.failure_note ?? null,
    cashCollected: r.cash_collected == null ? null : toNumber(r.cash_collected),
    order: {
      number: r.order_number, status: r.order_status, storeId: r.branch_id, total: toNumber(r.order_total),
      paymentMethod: r.payment_method, collectCash: r.payment_method === "cod" && r.payment_status !== "paid",
      itemCount: r.item_count == null ? undefined : Number(r.item_count), otpRequired: r.otp_required, eta: r.eta,
      shipTo: { name: addr.name, phone: addr.phone, line1: addr.line1, line2: addr.line2, city: addr.city, zip: addr.zip, ward: addr.ward, instructions: addr.instructions },
    },
    ...(events ? { events } : {}),
  };
}

/** A packed, unassigned order as offered to riders BEFORE they claim it: area only — no street, name or phone. */
export const toClaimableDto = (r) => ({
  orderId: r.id, number: r.number, storeId: r.branch_id, total: toNumber(r.total), collectCash: r.payment_method === "cod",
  itemCount: Number(r.item_count), eta: r.eta,
  area: [r.address?.ward && `Ward ${r.address.ward}`, r.address?.city].filter(Boolean).join(", ") || "—",
});

export const toEventDto = (e, { staff = false } = {}) => ({
  type: e.type, at: e.at, ...(staff ? { note: e.note ?? undefined, actorId: e.actor_id ?? undefined } : {}),
});
