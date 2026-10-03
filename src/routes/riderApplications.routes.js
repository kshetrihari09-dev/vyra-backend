import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import * as v from "../validators/riderApplications.validators.js";

/** Any signed-in user may apply and see their own; reviewing and reading others' is decided in the service (delivery:manage + roles:assign). */
export function riderApplicationsRoutes({ container, controller }) {
  const r = Router();
  const authed = authenticate(container);
  r.post("/rider-applications", authed, validate({ body: v.submitBody }), controller.submit);
  r.get("/rider-applications", authed, validate({ query: v.listQuery }), (req, res, next) =>
    (req.valid.query.scope === "all" ? controller.listAll : controller.listMine)(req, res, next));
  r.get("/rider-applications/:id", authed, validate({ params: v.idParams }), controller.get);
  r.post("/rider-applications/:id/decide", authed, validate({ params: v.idParams, body: v.decisionBody }), controller.decide);
  r.post("/rider-applications/:id/resubmit", authed, validate({ params: v.idParams, body: v.resubmitBody }), controller.resubmit);
  r.get("/rider-applications/:id/documents/:documentId/file", authed, validate({ params: v.documentParams }), controller.documentFile);
  return r;
}
