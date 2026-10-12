import { Router } from "express";
import { authenticate, optionalAuthenticate, requirePermission } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import * as v from "../validators/support.validators.js";

/**
 * Customer routes (/support/chat*, /support/messages) never take a conversation id: the thread is always looked up by the
 * signed-in caller, so there is nothing to tamper with. Pharmacist routes (/support/inbox*, /support/availability) need
 * `support:pharmacist`. /support/contact is public (phone and availability are not secrets) but names pharmacists only to signed-in users.
 * Rate limiters sit AFTER authenticate so they key on the user, not the IP.
 */
export function supportRoutes({ container, controller, limiters }) {
  const r = Router();
  const authed = authenticate(container);
  const staff = [authed, requirePermission("support:pharmacist")];

  r.get("/support/contact", optionalAuthenticate(container), validate({ query: v.contactQuery }), controller.contact);

  r.get("/support/chat", authed, controller.chatGet);
  r.get("/support/chat/messages", authed, validate({ query: v.historyQuery }), controller.chatHistory);
  r.get("/support/chat/stream", authed, validate({ query: v.streamQuery }), controller.chatStream);
  r.post("/support/chat/messages", authed, limiters.supportSend, validate({ body: v.sendBody }), controller.chatSend);
  r.post("/support/chat/read", authed, limiters.supportRead, controller.chatRead);
  r.post("/support/messages", authed, limiters.supportForm, validate({ body: v.formBody }), controller.form);

  r.get("/support/availability", ...staff, controller.availabilityGet);
  r.put("/support/availability", ...staff, limiters.supportStaff, validate({ body: v.availabilityBody }), controller.availabilitySet);
  r.get("/support/inbox", ...staff, validate({ query: v.inboxQuery }), controller.inboxList);
  r.get("/support/inbox/:id", ...staff, validate({ params: v.idParams }), controller.inboxGet);
  r.get("/support/inbox/:id/messages", ...staff, validate({ params: v.idParams, query: v.historyQuery }), controller.inboxMessages);
  r.get("/support/inbox/:id/stream", ...staff, validate({ params: v.idParams, query: v.streamQuery }), controller.inboxStream);
  r.post("/support/inbox/:id/messages", ...staff, limiters.supportStaff, validate({ params: v.idParams, body: v.replyBody }), controller.inboxReply);
  r.post("/support/inbox/:id/read", ...staff, limiters.supportRead, validate({ params: v.idParams }), controller.inboxRead);
  r.post("/support/inbox/:id/resolve", ...staff, limiters.supportStaff, validate({ params: v.idParams }), controller.inboxResolve);
  r.post("/support/inbox/:id/reopen", ...staff, limiters.supportStaff, validate({ params: v.idParams }), controller.inboxReopen);
  return r;
}
