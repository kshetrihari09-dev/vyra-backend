/**
 * Delivery options, mirrored from the frontend's data/stores.js DELIVERY_OPTIONS (kept in sync deliberately —
 * this is the server's source of truth for fee calculation; the frontend copy is display-only labels/slots).
 */
export const DELIVERY_OPTIONS = {
  express: { id: "express", label: "Express", fee: 2.99 },
  standard: { id: "standard", label: "Standard", fee: 0, freeAbove: 25 },
  slot: { id: "slot", label: "Scheduled Slot", fee: 1.49, slots: ["Today 6–8 PM", "Tomorrow 8–10 AM", "Tomorrow 12–2 PM", "Tomorrow 6–8 PM"] },
};
export const DELIVERY_OPTION_IDS = Object.keys(DELIVERY_OPTIONS);

export function deliveryFeeFor(optionId, taxableAmount) {
  const opt = DELIVERY_OPTIONS[optionId] ?? DELIVERY_OPTIONS.standard;
  if (opt.freeAbove && taxableAmount >= opt.freeAbove) return 0;
  return opt.fee;
}

/**
 * Distance-based delivery charge. The fee for an order is:   option base fee (above)  +  distance charge (below).
 *
 *   distance  = straight line between the branch and the customer's saved map pin × roadFactor, rounded UP to 0.1 km.
 *               (Deterministic and free — no routing API — so a cart quote and the order it becomes can never disagree.)
 *   tiers     = ascending; the first tier whose `upToKm` covers the distance sets the charge. The last tier must equal maxKm.
 *   maxKm     = farther than this is not deliverable: the cart shows why and the order is refused.
 *   unknownDistanceFee = charged when the distance can't be known (no pin on the address / no location on the branch), so
 *               leaving the pin off can't be used to dodge the distance charge.
 *
 * The free-delivery threshold on an option (freeAbove) waives only that option's BASE fee, never the distance charge.
 * These are business rules, kept here like the delivery options. The numbers are PLACEHOLDERS in the same scale as the
 * option fees above — set them to your real prices.
 */
export const DELIVERY_DISTANCE = Object.freeze({
  roadFactor: 1.3,
  tiers: Object.freeze([
    Object.freeze({ upToKm: 2, fee: 0 }),
    Object.freeze({ upToKm: 5, fee: 1 }),
    Object.freeze({ upToKm: 8, fee: 2 }),
    Object.freeze({ upToKm: 12, fee: 3.5 }),
    Object.freeze({ upToKm: 15, fee: 5 }),
  ]),
  maxKm: 15,
  unknownDistanceFee: 2,
});

export const PAYMENT_METHOD_IDS = ["card", "upi", "netbanking", "cod"];

/** Operational limits for the delivery module. Kept here (not in env) — they are business rules, not deployment settings. */
export const DELIVERY_RULES = {
  maxAttemptsPerOrder: 2,      // failed runs before an order is closed as "returned" instead of being re-dispatched
  maxActivePerRider: 5,        // simultaneous assigned/accepted/picked-up deliveries per rider
  otpMaxAttempts: 5,           // wrong handover codes per order before it locks (a dispatcher must reset it)
  locationMinIntervalMs: 5000, // faster location pings than this are dropped, not stored
  etaRefreshMs: 30_000,        // how often a live ping may trigger an ETA recalculation (it can call a routing API)
  requestCooldownMs: 120_000,  // a shop may re-send "request delivery" for the same order at most this often
};

export const FAILURE_REASONS = {
  customer_unreachable: "Customer unreachable",
  wrong_address: "Wrong or unfindable address",
  customer_refused: "Customer refused the order",
  unsafe_location: "Unsafe location",
  other: "Other",
};
export const FAILURE_REASON_IDS = Object.keys(FAILURE_REASONS);
