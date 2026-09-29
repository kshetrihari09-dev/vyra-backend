import { Router } from "express";
import { authenticate, requireAnyPermission, requirePermission } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import * as v from "../validators/sellers.validators.js";

export function sellersRoutes({ container, controller }) {
  const r = Router();
  const authed = authenticate(container);

  r.get("/sellers", authed, requirePermission("sellers:read_all"), validate({ query: v.listQuery }), controller.list);
  r.get("/sellers/mine", authed, controller.getMine); // null if the caller doesn't own a shop
  r.get("/sellers/:id", authed, validate({ params: v.idParams }), controller.get); // owner or sellers:read_all — service enforces
  r.post("/sellers/:id/status", authed, requirePermission("sellers:approve"), validate({ params: v.idParams, body: v.statusBody }), controller.setStatus);
  r.post("/sellers/:id/payout-method", authed, validate({ params: v.idParams, body: v.payoutMethodLabelBody }), controller.setPayoutMethodLabel);
  r.get("/sellers/:id/balance", authed, validate({ params: v.idParams }), controller.getBalance);
  r.get("/sellers/:id/settlement", authed, requireAnyPermission("payouts:approve", "sellers:approve"), validate({ params: v.idParams }), controller.getSettlement);
  return r;
}
