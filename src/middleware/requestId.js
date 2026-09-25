import { randomUUID } from "node:crypto";

/** Attaches req.id (honouring a well-formed X-Request-Id from the proxy) and echoes it back for support/debugging. */
export function requestId(req, res, next) {
  const incoming = req.get("x-request-id");
  req.id = incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
}

export const httpLogger = (logger) => (req, res, next) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    // Path only (no query string, no bodies) so tokens and personal data never reach the logs.
    logger.info("request", { id: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms), userId: req.auth?.user?.id });
  });
  next();
};
