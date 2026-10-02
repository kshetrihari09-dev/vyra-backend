import { conflict } from "../utils/errors.js";

/**
 * The ONE place that knows how an order may move, who may see its handover code, and when money gates the flow.
 * orders.service (staff / seller steps, cancel) and delivery.service (assign → deliver) both go through here, and the
 * order DTO exposes the result (`actions`) so the UI reflects the backend instead of re-deriving the rules.
 *
 *   placed → confirmed → preparing → packed → assigned → out_for_delivery → delivered
 *
 * Side exits the delivery module already supports: a declined / unassigned / failed run puts the order back to
 * `packed`; a second failed attempt closes it as `returned`. Cancellation is only possible before `packed`
 * (once packed, stock has physically left — that needs the return flow, not a cancel).
 */
export const STAGES = ["placed", "confirmed", "preparing", "packed", "assigned", "out_for_delivery", "delivered"];
export const FINAL = ["delivered", "cancelled", "returned"];
/** The only stages the generic staff / seller endpoint may set; from "packed" on, the delivery module owns the order. */
export const STAFF_STAGES = ["confirmed", "preparing", "packed"];
/** The handover code is shown to the customer only once the order is actually in the delivery phase. */
export const OTP_VISIBLE_STATUSES = ["assigned", "out_for_delivery"];

export const TRANSITIONS = Object.freeze({
  placed: ["confirmed", "cancelled"],
  confirmed: ["preparing", "cancelled"],
  preparing: ["packed", "cancelled"],
  packed: ["assigned"],
  assigned: ["out_for_delivery", "packed"],          // packed ← rider declined / dispatcher unassigned
  out_for_delivery: ["delivered", "packed", "returned"], // packed ← failed attempt (re-dispatch); returned ← attempts exhausted
  delivered: [],
  cancelled: [],
  returned: [],
});

/** Statuses an order may only reach once a prepaid payment has been confirmed. Cash on delivery is never gated. */
export const PAYMENT_GATED_STATUSES = ["packed", "assigned", "out_for_delivery", "delivered"];

export const stageIndex = (status) => STAGES.indexOf(status);
export const isFinal = (status) => FINAL.includes(status);
export const canTransition = (from, to) => !!TRANSITIONS[from]?.includes(to);
export const canCancelFrom = (status) => stageIndex(status) >= 0 && stageIndex(status) < stageIndex("packed");

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    const next = TRANSITIONS[from];
    throw conflict("INVALID_TRANSITION", next?.length
      ? `Order is "${from}" — it can only move to ${next.map((s) => `"${s}"`).join(" or ")}.`
      : `Order is "${from}" — it can't be moved any further.`);
  }
}

/** Non-COD orders are prepaid. orders.payment_status === "paid" mirrors a payments row that reached "captured". */
export const isPrepaid = (order) => !!order.payment_method && order.payment_method !== "cod";
export const paymentCleared = (order) => !isPrepaid(order) || order.payment_status === "paid";

export function assertPaymentCleared(order) {
  if (!paymentCleared(order)) {
    throw conflict("PAYMENT_PENDING", "This prepaid order hasn't been paid yet — it can't be packed or dispatched until the payment is confirmed.");
  }
}

/** What the next staff/seller step is, and whether the payment gate blocks it. Derived — never stored. */
export function actionsFor(order) {
  const i = stageIndex(order.status);
  const next = i >= 0 && i < stageIndex("packed") ? STAGES[i + 1] : null;
  const blocked = next && PAYMENT_GATED_STATUSES.includes(next) && !paymentCleared(order) ? "PAYMENT_PENDING" : null;
  return { next, blocked, canCancel: canCancelFrom(order.status) };
}
