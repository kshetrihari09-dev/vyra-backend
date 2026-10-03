import { Router } from "express";
import { authenticate, requirePermission } from "../middleware/authenticate.js";
import { requireRiderAccess } from "../middleware/riderAccess.js";
import { validate } from "../middleware/validate.js";
import * as v from "../validators/delivery.validators.js";

/**
 * /rider/*    — the rider app. `requireRiderAccess` runs the central rider check (active user + `delivery` role + `delivery:rider`
 *               permission + an active profile that belongs to this user); a rider only ever touches their own deliveries)
 * /delivery/* — dispatch (delivery:manage)
 * /orders/:id/tracking — the order's owner, or staff (checked in the service)
 */
export function deliveryRoutes({ container, controller }) {
  const r = Router();
  const authed = authenticate(container);
  const rider = requireRiderAccess(container);
  const dispatch = requirePermission("delivery:manage");

  r.get("/rider/me", authed, rider, controller.me);
  r.put("/rider/me/availability", authed, rider, validate({ body: v.availabilityBody }), controller.setAvailability);
  r.get("/rider/deliveries", authed, rider, validate({ query: v.listMineQuery }), controller.listMine);
  r.get("/rider/available-orders", authed, rider, controller.listClaimable);
  r.post("/rider/orders/:orderId/claim", authed, rider, validate({ params: v.orderIdParams }), controller.claim);
  r.post("/rider/deliveries/:id/accept", authed, rider, validate({ params: v.idParams }), controller.accept);
  r.post("/rider/deliveries/:id/decline", authed, rider, validate({ params: v.idParams, body: v.declineBody }), controller.decline);
  r.post("/rider/deliveries/:id/pickup", authed, rider, validate({ params: v.idParams }), controller.pickup);
  r.post("/rider/deliveries/:id/location", authed, rider, validate({ params: v.idParams, body: v.locationBody }), controller.location);
  r.post("/rider/deliveries/:id/deliver", authed, rider, validate({ params: v.idParams, body: v.deliverBody }), controller.deliver);
  r.post("/rider/deliveries/:id/fail", authed, rider, validate({ params: v.idParams, body: v.failBody }), controller.fail);

  r.get("/delivery/riders", authed, dispatch, controller.listRiders);
  r.post("/delivery/riders", authed, dispatch, validate({ body: v.createRiderBody }), controller.createRider);
  r.put("/delivery/riders/:id", authed, dispatch, validate({ params: v.idParams, body: v.updateRiderBody }), controller.updateRider);
  r.get("/delivery/active", authed, dispatch, controller.listActive);
  r.post("/delivery/orders/:orderId/assign", authed, dispatch, validate({ params: v.orderIdParams, body: v.assignBody }), controller.assign);
  r.post("/delivery/orders/:orderId/reset-otp", authed, dispatch, validate({ params: v.orderIdParams }), controller.resetOtp);
  r.post("/delivery/deliveries/:id/reassign", authed, dispatch, validate({ params: v.idParams, body: v.assignBody }), controller.reassign);
  r.post("/delivery/deliveries/:id/unassign", authed, dispatch, validate({ params: v.idParams, body: v.unassignBody }), controller.unassign);

  r.get("/orders/:id/tracking", authed, validate({ params: v.idParams }), controller.tracking);
  return r;
}
