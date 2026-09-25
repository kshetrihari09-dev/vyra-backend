import { Router } from "express";
import { authenticate, requirePermission } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import * as v from "../validators/auth.validators.js";

/** /api/admin/* — every route needs a specific permission; a customer token gets 403 on all of them. */
export function adminRoutes({ container, usersController }) {
  const r = Router();
  r.use(authenticate(container));

  r.get("/users", requirePermission("users:read"), validate({ query: v.listUsersQuery }), usersController.list);
  r.get("/users/:id", requirePermission("users:read"), validate({ params: v.userIdParams }), usersController.get);
  r.get("/roles", requirePermission("users:read"), usersController.listRoles);
  r.patch("/users/:id/status", requirePermission("users:manage"), validate({ params: v.userIdParams, body: v.setStatusBody }), usersController.setStatus);
  r.put("/users/:id/roles", requirePermission("roles:assign"), validate({ params: v.userIdParams, body: v.setRolesBody }), usersController.setRoles);
  return r;
}
