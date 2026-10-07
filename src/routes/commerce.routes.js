import { Router } from "express";
import { authenticate, optionalAuthenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import * as v from "../validators/commerce.validators.js";

/** Everything here is a signed-in customer acting on their own data, except cart pricing (works for guests too). */
export function commerceRoutes({ container, controller, limiters = {} }) {
  const pass = (_req, _res, next) => next();
  const write = limiters.addressWrite ?? pass, otpStart = limiters.otpStart ?? pass, otpVerify = limiters.otpVerify ?? pass;
  const r = Router();
  const authed = authenticate(container);
  const maybe = optionalAuthenticate(container);

  r.get("/addresses", authed, controller.listAddresses);
  r.post("/addresses", authed, write, validate({ body: v.addressBody }), controller.createAddress);
  r.put("/addresses/:id", authed, write, validate({ params: v.addressIdParams, body: v.addressBody }), controller.updateAddress);
  // Confirm a delivery phone that is not the login number (code is texted to THAT number).
  r.post("/addresses/phone/start", authed, otpStart, validate({ body: v.addressPhoneStart }), controller.startAddressPhone);
  r.post("/addresses/phone/verify", authed, otpVerify, validate({ body: v.addressPhoneVerify }), controller.verifyAddressPhone);
  r.post("/addresses/:id/default", authed, validate({ params: v.addressIdParams }), controller.setDefaultAddress);
  r.delete("/addresses/:id", authed, validate({ params: v.addressIdParams }), controller.removeAddress);

  r.post("/cart/price", maybe, validate({ body: v.cartPriceBody }), controller.priceCart);

  r.get("/orders", authed, validate({ query: v.orderListQuery }), controller.listOrders);
  r.get("/orders/:id", authed, validate({ params: v.orderIdParams }), controller.getOrder);
  r.post("/orders", authed, validate({ body: v.createOrderBody }), controller.createOrder);
  r.post("/orders/:id/status", authed, validate({ params: v.orderIdParams, body: v.orderStatusBody }), controller.advanceOrder);
  r.post("/orders/:id/cancel", authed, validate({ params: v.orderIdParams, body: v.orderCancelBody }), controller.cancelOrder);

  r.get("/wishlist", authed, controller.listWishlist);
  r.post("/wishlist/:productId/toggle", authed, validate({ params: v.wishlistParams }), controller.toggleWishlist);
  return r;
}
