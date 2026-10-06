/**
 * Customer-facing delivery progress, DERIVED from state that already exists (orders.status + the active delivery row).
 * Nothing here is stored, so it can never disagree with the order — the order id stays the single source of truth.
 *
 *   Confirmed → Preparing → Delivery partner assigned → Picked up → On the way → Delivered
 */
export const TRACKING_STEPS = Object.freeze([
  { id: "confirmed", label: "Confirmed" },
  { id: "preparing", label: "Preparing" },
  { id: "partner_assigned", label: "Delivery partner assigned" },
  { id: "picked_up", label: "Picked up" },
  { id: "on_the_way", label: "On the way" },
  { id: "delivered", label: "Delivered" },
]);

/** Delivery statuses during which the rider is on the job and may share their position. */
export const SHARING_STATUSES = Object.freeze(["accepted", "picked_up"]);
export const canShareLocation = (deliveryStatus) => SHARING_STATUSES.includes(deliveryStatus);

const FINAL_ORDER = ["delivered", "cancelled", "returned"];
export const isFinalOrder = (orderStatus) => FINAL_ORDER.includes(orderStatus);

/**
 * @param {string} orderStatus  orders.status
 * @param {object|null} d       the ACTIVE delivery row (status, arrived_pickup_at, started_at) — null when nobody has the order
 * @returns {{ id: string, index: number, label: string, detail: string, terminal: boolean }}
 */
export function stageOf(orderStatus, d = null) {
  const at = (id, label, detail, terminal = false) => ({ id, index: TRACKING_STEPS.findIndex((s) => s.id === id), label, detail, terminal });
  switch (orderStatus) {
    case "placed": return at("confirmed", "Order placed", "Waiting for the store to confirm");
    case "confirmed": return at("confirmed", "Confirmed", "The store has accepted your order");
    case "preparing": return at("preparing", "Preparing", "Your order is being prepared");
    case "packed": return at("preparing", "Packed", "Packed — finding a delivery partner");
    case "assigned":
      if (d?.status === "assigned") return at("partner_assigned", "Delivery partner assigned", "Waiting for the partner to accept");
      if (d?.arrived_pickup_at) return at("partner_assigned", "Delivery partner assigned", "Your partner has arrived at the store");
      return at("partner_assigned", "Delivery partner assigned", "Your partner is heading to the store");
    case "out_for_delivery":
      return d?.started_at ? at("on_the_way", "On the way", "Your order is on its way to you")
        : at("picked_up", "Picked up", "Your partner has your order");
    case "delivered": return at("delivered", "Delivered", "Your order has been delivered", true);
    case "cancelled": return { id: "cancelled", index: -1, label: "Cancelled", detail: "This order was cancelled", terminal: true };
    case "returned": return { id: "returned", index: -1, label: "Returned", detail: "This order could not be delivered and was returned to the store", terminal: true };
    default: return at("confirmed", "Order placed", "");
  }
}

/** The six steps with done / current / upcoming state for a stage — the same list every client renders. */
export function stepsFor(stage) {
  return TRACKING_STEPS.map((s, i) => ({
    ...s,
    state: stage.index < 0 ? "upcoming" : i < stage.index ? "done" : i === stage.index ? (stage.id === "delivered" ? "done" : "current") : "upcoming",
  }));
}
