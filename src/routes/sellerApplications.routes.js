import { Router } from "express";
import { authenticate, requireAnyPermission, requirePermission } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import * as v from "../validators/sellerApplications.validators.js";

export function sellerApplicationsRoutes({ container, controller }) {
  const r = Router();
  const authed = authenticate(container);

  r.post("/seller-applications", authed, validate({ body: v.submitBody }), controller.submit);
  r.get("/seller-applications", authed, validate({ query: v.listQuery }), (req, res, next) =>
    (req.auth.user.permissions.includes("sellers:read_all") ? controller.listAll : controller.listMine)(req, res, next));
  r.get("/seller-applications/:id", authed, validate({ params: v.idParams }), controller.get);
  r.get("/seller-applications/:id/settlement", authed, requireAnyPermission("sellers:approve", "payouts:approve"), validate({ params: v.idParams }), controller.getSettlement);
  r.post("/seller-applications/:id/decide", authed, requirePermission("sellers:approve"), validate({ params: v.idParams, body: v.decisionBody }), controller.decide);
  r.post("/seller-applications/:id/resubmit", authed, validate({ params: v.idParams, body: v.resubmitBody }), controller.resubmit);
  r.post("/seller-applications/:id/documents/:documentId/verify", authed, requirePermission("sellers:approve"), validate({ params: v.documentParams, body: v.documentVerifyBody }), controller.verifyDocument);
  r.get("/seller-applications/:id/documents/:documentId/file", authed, validate({ params: v.documentParams }), controller.documentFile);
  return r;
}
