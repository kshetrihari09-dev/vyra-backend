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

export const PAYMENT_METHOD_IDS = ["card", "upi", "netbanking", "cod"];
