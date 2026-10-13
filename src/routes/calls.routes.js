import { Router } from "express";
import { authenticate, requirePermission } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import * as v from "../validators/calls.validators.js";

/**
 * Vyra Call. Every route needs a signed-in user; WHICH side of a call they are is decided in the service from the database
 * (call.customer_id / the shop they own), never from anything in the request. Shop-only routes also require the existing
 * `seller:manage_own` permission, and the shop is always the caller's own (no shop id is accepted).
 * Rate limiters sit AFTER authenticate so they key on the user, not the IP.
 */
export function callsRoutes({ container, controller, limiters }) {
  const r = Router();
  const authed = authenticate(container);
  const shopOnly = [authed, requirePermission("seller:manage_own")];

  r.get("/calls/ice", authed, limiters.callRead, controller.ice);
  r.get("/calls/stream", authed, validate({ query: v.streamQuery }), controller.stream);
  r.get("/shops/:sellerId/call-status", authed, limiters.callRead, validate({ params: v.sellerParams }), controller.shopStatus);

  r.post("/calls", authed, limiters.callStart, validate({ body: v.startBody }), controller.start);
  r.get("/calls/:id", authed, limiters.callRead, validate({ params: v.idParams }), controller.get);
  r.post("/calls/:id/accept", ...shopOnly, limiters.callControl, validate({ params: v.idParams }), controller.accept);
  r.post("/calls/:id/decline", ...shopOnly, limiters.callControl, validate({ params: v.idParams }), controller.decline);
  r.post("/calls/:id/end", authed, limiters.callControl, validate({ params: v.idParams, body: v.endBody }), controller.end);
  r.post("/calls/:id/connected", authed, limiters.callControl, validate({ params: v.idParams }), controller.connected);
  r.post("/calls/:id/ping", authed, limiters.callPing, validate({ params: v.idParams }), controller.ping);
  r.post("/calls/:id/signal", authed, limiters.callSignal, validate({ params: v.idParams, body: v.signalBody }), controller.signal);

  r.put("/shop/call-presence", ...shopOnly, limiters.callControl, validate({ body: v.presenceBody }), controller.presenceSet);
  r.delete("/shop/call-presence", ...shopOnly, limiters.callControl, controller.presenceClear);
  r.get("/shop/calls", ...shopOnly, limiters.callRead, validate({ query: v.historyQuery }), controller.shopHistory);
  return r;
}
