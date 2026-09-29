import { Router } from "express";
import { authenticate, requirePermission } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import * as v from "../validators/prescriptions.validators.js";

/** Customers manage their own; a pharmacist (prescriptions:review) sees and decides every one. Ownership is
    checked inside the service, never trusted from the client — see prescriptions.service#get/getFile. */
export function prescriptionsRoutes({ container, controller }) {
  const r = Router();
  const authed = authenticate(container);

  r.post("/prescriptions", authed, validate({ body: v.uploadBody }), controller.upload);
  r.get("/prescriptions", authed, validate({ query: v.listQuery }), (req, res, next) =>
    (req.auth.user.permissions.includes("prescriptions:read_all") ? controller.listAll : controller.listMine)(req, res, next));
  r.get("/prescriptions/:id", authed, validate({ params: v.idParams }), controller.get);
  r.get("/prescriptions/:id/file", authed, validate({ params: v.idParams }), controller.file);
  r.post("/prescriptions/:id/review", authed, requirePermission("prescriptions:review"), validate({ params: v.idParams, body: v.reviewBody }), controller.review);
  return r;
}
