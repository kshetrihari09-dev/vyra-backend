import { DELIVERY_RULES } from "../config/delivery.js";
import { evaluateRiderRow, riderState, RIDER_STATE } from "../domain/riderEligibility.js";
import { toNumber } from "../utils/text.js";

const pt = (lat, lng) => (lat == null || lng == null ? null : { lat: Number(lat), lng: Number(lng) });

/** `vehicle` is one text column, written as "Type · Plate" ("Bike · BA 12 PA 1234"). The UI wants the halves. */
export function splitVehicle(vehicle) {
  const [type, ...rest] = String(vehicle ?? "").split(" · ");
  return { vehicleType: type.trim() || null, vehicleNumber: rest.length ? rest.join(" · ").trim() || null : null };
}

/** Deliveries still in the rider's hands. Anything else is closed: the customer's contact details are no longer theirs to hold. */
const OPEN_DELIVERY = ["assigned", "accepted", "picked_up"];

/**
 * `state` / `canTakeDelivery` are computed here, from the same rules the backend enforces on assignment, so the UI shows
 * what the server will actually accept. They are display hints — assigning to a rider is always re-validated server-side.
 */
export function toRiderDto(r) {
  const capacity = DELIVERY_RULES.maxActivePerRider;
  const state = riderState(r, { capacity });
  return {
    id: r.id, userId: r.user_id, name: r.full_name ?? null, phone: r.phone, vehicle: r.vehicle, ...splitVehicle(r.vehicle),
    status: r.status, isAvailable: r.is_available, photoUrl: r.photo_url ?? null,
    activeCount: Number(r.active_count ?? 0), capacity,
    authorized: evaluateRiderRow(r).ok, state, canTakeDelivery: state === RIDER_STATE.AVAILABLE,
  };
}

/**
 * What a rider needs to do the job: full address and contact WHILE a delivery is theirs. The handover code is NEVER here.
 * Once the delivery is closed (delivered, failed, declined, unassigned, reassigned) the street, name and phone are dropped —
 * only the area stays — so a rider's history can't be used as a customer directory.
 */
export function toDeliveryDto(r, { events } = {}) {
  const addr = r.order_address ?? {};
  return {
    id: r.id, orderId: r.order_id, status: r.status, riderId: r.rider_id, riderName: r.rider_name ?? undefined,
    selfClaimed: r.self_claimed, assignedAt: r.created_at, acceptedAt: r.accepted_at, pickedUpAt: r.picked_up_at,
    deliveredAt: r.delivered_at, arrivedPickupAt: r.arrived_pickup_at ?? null, startedAt: r.started_at ?? null,
    estimatedArrival: r.estimated_arrival ?? null, etaSource: r.eta_source ?? null,
    /** Store location (not personal data). The customer's pin is handed over only while the run is open, like the street address. */
    pickup: pt(r.pickup_lat, r.pickup_lng),
    destination: OPEN_DELIVERY.includes(r.status) ? pt(r.customer_lat, r.customer_lng) : null,
    failureReason: r.failure_reason ?? null, failureNote: r.failure_note ?? null,
    cashCollected: r.cash_collected == null ? null : toNumber(r.cash_collected),
    order: {
      number: r.order_number, status: r.order_status, storeId: r.branch_id, total: toNumber(r.order_total),
      paymentMethod: r.payment_method, collectCash: r.payment_method === "cod" && r.payment_status !== "paid",
      itemCount: r.item_count == null ? undefined : Number(r.item_count), otpRequired: r.otp_required, eta: r.eta,
      shipTo: OPEN_DELIVERY.includes(r.status)
        ? { name: addr.name, phone: addr.phone, line1: addr.line1, line2: addr.line2, city: addr.city, zip: addr.zip, ward: addr.ward, instructions: addr.instructions }
        : { city: addr.city, ward: addr.ward },
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
