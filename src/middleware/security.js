import cors from "cors";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { forbidden } from "../utils/errors.js";

export const securityHeaders = () => helmet();

/** Browser origins on the allow-list may call the API with cookies. Requests with no Origin header (curl, server-to-server) pass. */
export const corsPolicy = (config) => cors({
  origin(origin, cb) {
    if (!origin || config.cors.origins.includes(origin)) return cb(null, true);
    cb(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "X-Vyra-Client", "X-Request-Id"],
  exposedHeaders: ["X-Request-Id"],
  maxAge: 600,
});

/**
 * Endpoints authenticated only by the refresh cookie need a CSRF guard. SameSite=Strict already blocks cross-site
 * sends; this custom header (which a cross-origin form/img cannot set, and CORS will not allow from other origins)
 * is the second layer.
 */
export const requireClientHeader = (req, _res, next) => {
  if (req.get("x-vyra-client") !== "web") return next(forbidden("CSRF_CHECK_FAILED", "Missing client header"));
  next();
};

const limiter = (config, opts) => config.rateLimit.enabled
  ? rateLimit({
      standardHeaders: "draft-7", legacyHeaders: false,
      handler: (_req, res) => res.status(429).json({ success: false, message: "Too many requests. Please slow down and try again shortly.", code: "RATE_LIMITED" }),
      ...opts,
    })
  : (_req, _res, next) => next();

/** Limits are per client IP (needs TRUST_PROXY set correctly behind Nginx). In-memory: fine for one Node process. */
export const createLimiters = (config) => ({
  global: limiter(config, { windowMs: 60_000, limit: 300 }),
  login: limiter(config, { windowMs: 15 * 60_000, limit: 20 }),
  otpStart: limiter(config, { windowMs: 60 * 60_000, limit: 10 }),
  otpVerify: limiter(config, { windowMs: 15 * 60_000, limit: 20 }),
  passwordReset: limiter(config, { windowMs: 60 * 60_000, limit: 10 }),
  refresh: limiter(config, { windowMs: 60_000, limit: 60 }),
  addressWrite: limiter(config, { windowMs: 60 * 60_000, limit: 40 }),
  // Support limits are per signed-in user (they sit after `authenticate`), so one shared network can't lock out others.
  supportSend: limiter(config, { windowMs: 60_000, limit: 30, keyGenerator: (req) => `u:${req.auth?.user?.id ?? "anon"}` }),
  supportForm: limiter(config, { windowMs: 60 * 60_000, limit: 10, keyGenerator: (req) => `u:${req.auth?.user?.id ?? "anon"}` }),
  supportRead: limiter(config, { windowMs: 60_000, limit: 120, keyGenerator: (req) => `u:${req.auth?.user?.id ?? "anon"}` }),
  // Vyra Call limits are per signed-in user. callStart is the anti-harassment one: a customer can't ring shops in a loop.
  callStart: limiter(config, { windowMs: 10 * 60_000, limit: 8, keyGenerator: (req) => `u:${req.auth?.user?.id ?? "anon"}` }),
  callControl: limiter(config, { windowMs: 60_000, limit: 60, keyGenerator: (req) => `u:${req.auth?.user?.id ?? "anon"}` }),
  callSignal: limiter(config, { windowMs: 60_000, limit: 600, keyGenerator: (req) => `u:${req.auth?.user?.id ?? "anon"}` }),
  callPing: limiter(config, { windowMs: 60_000, limit: 20, keyGenerator: (req) => `u:${req.auth?.user?.id ?? "anon"}` }),
  callRead: limiter(config, { windowMs: 60_000, limit: 120, keyGenerator: (req) => `u:${req.auth?.user?.id ?? "anon"}` }),
  supportStaff: limiter(config, { windowMs: 60_000, limit: 120, keyGenerator: (req) => `u:${req.auth?.user?.id ?? "anon"}` }),
});
