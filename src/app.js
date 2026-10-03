import cookieParser from "cookie-parser";
import express from "express";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { httpLogger, requestId } from "./middleware/requestId.js";
import { corsPolicy, createLimiters, securityHeaders } from "./middleware/security.js";
import { createRoutes } from "./routes/index.js";

export function createApp(container) {
  const { config, logger } = container;
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy); // number of Nginx hops; required for correct req.ip and rate limiting

  const limiters = createLimiters(config);
  app.use(requestId);
  if (!config.isTest) app.use(httpLogger(logger));
  app.use(securityHeaders());
  app.use(corsPolicy(config));
  // `verify` stashes the exact bytes received so payment webhooks can check a signature over the raw body —
  // re-serializing the parsed JSON would not reliably reproduce what the provider actually signed.
  const rawBodyCapture = { verify: (req, _res, buf) => { req.rawBody = buf; } };
  // Prescription uploads carry a base64-encoded file (~13.3 MB for a 10 MB original) — too big for the 100kb
  // default below, so that one path gets its own parser with a bigger cap, mounted first (body-parser skips
  // a body that's already been parsed, so the global 100kb parser after it is a no-op for this path).
  app.use("/api/prescriptions", express.json({ limit: "14mb", ...rawBodyCapture }));
  // A shop application can carry up to 6 documents at 5 MB each (~40 MB once base64-encoded).
  app.use("/api/seller-applications", express.json({ limit: "45mb", ...rawBodyCapture }));
  // A rider application carries up to 4 documents at 5 MB each (~28 MB once base64-encoded).
  app.use("/api/rider-applications", express.json({ limit: "30mb", ...rawBodyCapture }));
  // Product photos: up to 5 browser-downscaled JPEGs as data URLs — bigger than the 100kb default, so this one path gets 8mb.
  app.use(/^\/api\/products\/[^/]+\/images$/, express.json({ limit: "8mb", ...rawBodyCapture }));
  app.use(express.json({ limit: "100kb", ...rawBodyCapture }));
  app.use(cookieParser());
  app.use("/api", limiters.global);
  app.use("/api", createRoutes(container, limiters));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
