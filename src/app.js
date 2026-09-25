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
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());
  app.use("/api", limiters.global);
  app.use("/api", createRoutes(container, limiters));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
