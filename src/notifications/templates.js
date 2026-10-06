import { money } from "../utils/text.js";

/**
 * Every notification the system can raise, in one table. `email` / `sms` say which EXTERNAL channels a type may use
 * (the in-app inbox always gets a row). Templates receive only the small `data` object the service passed — keep
 * that to ids, order numbers and amounts: no addresses, no phone numbers, and NEVER the delivery handover code
 * (it would then sit in the outbox and in a provider's logs, defeating the point of deriving it on demand).
 */
export const TEMPLATES = {
  // ---- customer: orders
  "order.placed": {
    kind: "order", email: true,
    title: () => "Order placed",
    message: (d) => `Order ${d.number} has been placed — total ${money(d.total)}. The store will confirm it shortly.`,
  },
  "order.confirmed": {
    kind: "order",
    title: () => "Order confirmed",
    message: (d) => `The store has confirmed order ${d.number} and will start preparing it.`,
  },
  "order.packed": {
    kind: "order",
    title: () => "Packed and ready",
    message: (d) => `Order ${d.number} is packed and waiting for a rider.`,
  },
  "order.cancelled": {
    kind: "order", email: true,
    title: () => "Order cancelled",
    message: (d) => `Order ${d.number} was cancelled${d.reason ? `: ${d.reason}` : "."}`,
  },
  // ---- rider: a shop is asking for a pickup (ids + order number only — no address, no customer details)
  "rider.delivery_requested": {
    kind: "delivery",
    title: () => "Delivery requested",
    message: (d) => `A shop has order ${d.number} packed and ready. Open the Available tab to take it.`,
  },
  // ---- customer: delivery
  "delivery.assigned": {
    kind: "delivery",
    title: () => "Rider assigned",
    message: (d) => `${d.riderName || "A rider"} will deliver order ${d.number}.`,
  },
  "delivery.out_for_delivery": {
    kind: "delivery", sms: true,
    title: () => "Out for delivery",
    message: (d) => `Order ${d.number} is on its way. Open the app for your delivery code and read it to the rider only once you have your order.`,
  },
  "delivery.delivered": {
    kind: "delivery", email: true,
    title: () => "Delivered",
    message: (d) => `Order ${d.number} was delivered. Thank you for shopping with Vyra.`,
  },
  "delivery.retry": {
    kind: "delivery", sms: true,
    title: () => "We couldn't deliver",
    message: (d) => `We couldn't deliver order ${d.number} (${d.reason}). We'll try again — please keep your phone nearby.`,
  },
  "delivery.returned": {
    kind: "delivery", sms: true, email: true,
    title: () => "Order returned to store",
    message: (d) => `Order ${d.number} couldn't be delivered after repeated attempts and was returned to the store. Contact support about a refund or redelivery.`,
  },
  // ---- rider
  "rider.assigned": {
    kind: "delivery",
    title: () => "New delivery assigned",
    message: (d) => `Order ${d.number} was assigned to you. Open the Delivery App to accept it.`,
  },
  // ---- prescriptions
  "prescription.approved": {
    kind: "prescription", email: true,
    title: () => "Prescription verified",
    message: () => "Your prescription was approved by the pharmacist. You can now order the covered items.",
  },
  "prescription.rejected": {
    kind: "prescription", email: true,
    title: () => "Prescription not accepted",
    message: (d) => `Your prescription couldn't be accepted${d.reason ? `: ${d.reason}` : "."} You can upload a clearer copy.`,
  },
  // ---- payments
  "refund.completed": {
    kind: "payment", email: true,
    title: () => "Refund issued",
    message: (d) => `A refund of ${money(d.amount)} for order ${d.number} has been issued.`,
  },
  "refund.rejected": {
    kind: "payment", email: true,
    title: () => "Refund not approved",
    message: (d) => `Your refund request for order ${d.number} wasn't approved${d.note ? `: ${d.note}` : "."}`,
  },
  // ---- rider applications
  "rider_application.approved": {
    kind: "delivery", email: true,
    title: () => "You're approved as a delivery rider",
    message: () => "Sign in again, open the Delivery App from your profile, and switch to Available to start taking deliveries.",
  },
  "rider_application.rejected": {
    kind: "delivery", email: true,
    title: () => "Rider application not approved",
    message: (d) => `Your rider application wasn't approved: ${d.reason}`,
  },
  "rider_application.correction_requested": {
    kind: "delivery", email: true,
    title: () => "Changes needed on your rider application",
    message: (d) => `Please update your rider application: ${d.reason}`,
  },
  // ---- sellers
  "seller_application.approved": {
    kind: "seller", email: true,
    title: () => "Your shop is approved",
    message: (d) => `${d.shopName} is now live on Vyra. Open the seller dashboard to add products.`,
  },
  "seller_application.rejected": {
    kind: "seller", email: true,
    title: () => "Shop application not approved",
    message: (d) => `Your application for ${d.shopName} wasn't approved: ${d.reason}`,
  },
  "seller_application.correction_requested": {
    kind: "seller", email: true,
    title: () => "Changes needed on your application",
    message: (d) => `Please update your application for ${d.shopName}: ${d.reason}`,
  },
  "seller_application.suspended": {
    kind: "seller", email: true,
    title: () => "Your shop was suspended",
    message: (d) => `${d.shopName} has been suspended. Contact support for details.`,
  },
  "seller_payout.paid": {
    kind: "seller", email: true,
    title: () => "Payout sent",
    message: (d) => `Your payout of ${money(d.amount)} has been approved and sent.`,
  },
  "seller_payout.rejected": {
    kind: "seller", email: true,
    title: () => "Payout not approved",
    message: (d) => `Your payout request of ${money(d.amount)} wasn't approved${d.note ? `: ${d.note}` : "."}`,
  },
};

/** Types that carry a deep-link target the UI understands. */
export const LINK_KEYS = ["orderId", "prescriptionId", "applicationId"];
