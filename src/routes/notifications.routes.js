import { Router } from "express";
import { authenticate, requirePermission } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import * as v from "../validators/notifications.validators.js";

/** /notifications/* is the caller's own inbox (scoped by user id in SQL); /audit-logs needs audit:read. */
export function notificationsRoutes({ container, controller }) {
  const r = Router();
  const authed = authenticate(container);
  r.get("/notifications", authed, validate({ query: v.listQuery }), controller.list);
  r.post("/notifications/read-all", authed, controller.readAll);
  r.get("/notifications/preferences", authed, controller.getPrefs);
  r.put("/notifications/preferences", authed, validate({ body: v.prefsBody }), controller.setPrefs);
  r.post("/notifications/:id/read", authed, validate({ params: v.idParams }), controller.read);
  r.get("/audit-logs", authed, requirePermission("audit:read"), validate({ query: v.auditQuery }), controller.auditLog);
  return r;
}
