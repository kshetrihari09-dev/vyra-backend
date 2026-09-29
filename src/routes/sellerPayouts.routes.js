import { Router } from "express";
import { authenticate, requirePermission } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import * as v from "../validators/sellerPayouts.validators.js";

export function sellerPayoutsRoutes({ container, controller }) {
  const r = Router();
  const authed = authenticate(container);

  r.post("/sellers/:sellerId/payouts", authed, validate({ params: v.sellerIdParams, body: v.requestBody }), controller.request);
  r.get("/sellers/:sellerId/payouts", authed, validate({ params: v.sellerIdParams }), controller.listForSeller);
  r.get("/payouts", authed, requirePermission("payouts:read_all"), validate({ query: v.listQuery }), controller.listAll);
  r.post("/payouts/:id/decide", authed, requirePermission("payouts:approve"), validate({ params: v.payoutIdParams, body: v.decisionBody }), controller.decide);
  return r;
}
