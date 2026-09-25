import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { requireClientHeader } from "../middleware/security.js";
import { validate } from "../middleware/validate.js";
import * as v from "../validators/auth.validators.js";

export function authRoutes({ container, controller, limiters }) {
  const r = Router();
  const authed = authenticate(container);

  r.post("/register/start", limiters.otpStart, validate({ body: v.registerStart }), controller.registerStart);
  r.post("/register/verify", limiters.otpVerify, validate({ body: v.registerVerify }), controller.registerVerify);
  r.post("/login", limiters.login, validate({ body: v.login }), controller.login);
  // Cookie-authenticated: guarded against CSRF by the custom header + SameSite=Strict.
  r.post("/refresh", limiters.refresh, requireClientHeader, controller.refresh);
  r.post("/logout", requireClientHeader, controller.logout);
  r.post("/logout-all", authed, controller.logoutAll);
  r.get("/me", authed, controller.me);
  r.post("/password/forgot", limiters.passwordReset, validate({ body: v.forgotPassword }), controller.forgotPassword);
  r.post("/password/reset", limiters.passwordReset, validate({ body: v.resetPassword }), controller.resetPassword);
  r.post("/password/change", authed, validate({ body: v.changePassword }), controller.changePassword);
  return r;
}
