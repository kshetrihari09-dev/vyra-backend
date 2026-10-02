import { Router } from "express";
import { authenticate, requireAnyPermission, requirePermission } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import * as v from "../validators/payments.validators.js";

/** Everything except the webhook is a signed-in call; the webhook is authenticated by its provider signature
    instead (see payments.service#handleWebhook), never by a bearer token — a real gateway has no session. */
export function paymentsRoutes({ container, controller }) {
  const r = Router();
  const authed = authenticate(container);

  r.get("/orders/:id/payment", authed, validate({ params: v.orderIdParams }), controller.getForOrder);
  r.post("/orders/:id/payment/retry", authed, validate({ params: v.orderIdParams }), controller.retry);
  r.post("/payments/:id/confirm-manual", authed, requirePermission("payments:manage"), validate({ params: v.paymentIdParams }), controller.confirmManual);

  r.post("/orders/:id/refund-request", authed, validate({ params: v.orderIdParams, body: v.refundRequestBody }), controller.requestRefund);
  r.get("/refunds", authed, requireAnyPermission("payments:manage", "orders:refund"), validate({ query: v.refundListQuery }), controller.listRefunds);
  r.post("/refunds/:id/decide", authed, requirePermission("payments:manage"), validate({ params: v.refundIdParams, body: v.refundDecisionBody }), controller.decideRefund);

  // Public — no `authed`. Body must stay untouched by the earlier json parser's re-serialization for the
  // signature check to work; app.js's `verify` hook stashes the exact bytes on req.rawBody for this.
  r.post("/webhooks/payments/:provider", validate({ params: v.webhookProviderParams }), controller.webhook);
  return r;
}
