import { AppError } from "../utils/errors.js";

/**
 * Maps any thrown value to { status, body }. Only AppErrors and a few well-understood driver/parser errors expose
 * their message; everything else becomes a generic 500. Stack traces and SQL text never leave the server.
 */
export function toErrorResponse(err, requestId) {
  if (err instanceof AppError) {
    const body = { success: false, message: err.message, code: err.code };
    if (err.details !== undefined) body.details = err.details;
    return { status: err.status, body };
  }
  // Body parser (express.json)
  if (err?.type === "entity.parse.failed") return { status: 400, body: { success: false, message: "Request body is not valid JSON", code: "INVALID_JSON" } };
  if (err?.type === "entity.too.large") return { status: 413, body: { success: false, message: "Request body is too large", code: "PAYLOAD_TOO_LARGE" } };
  // PostgreSQL (SQLSTATE)
  switch (err?.code) {
    case "23505": return { status: 409, body: { success: false, message: "That already exists", code: "CONFLICT" } };
    case "23503": return { status: 409, body: { success: false, message: "This change conflicts with related data", code: "CONFLICT" } };
    case "23514": case "22P02": case "22003": case "22001":
      return { status: 400, body: { success: false, message: "Invalid input", code: "INVALID_INPUT" } };
    case "40001": case "40P01":
      return { status: 409, body: { success: false, message: "The system was busy; please try again", code: "TRANSACTION_CONFLICT" } };
    default:
  }
  return { status: 500, body: { success: false, message: "Something went wrong on our side", code: "INTERNAL_ERROR", requestId } };
}

export const notFoundHandler = (_req, res) =>
  res.status(404).json({ success: false, message: "Route not found", code: "ROUTE_NOT_FOUND" });

export const errorHandler = (logger) => (err, req, res, _next) => {
  const { status, body } = toErrorResponse(err, req.id);
  if (status >= 500) logger.error("unhandled error", { id: req.id, method: req.method, path: req.path, error: err?.message, stack: err?.stack });
  if (res.headersSent) return;
  res.status(status).json(body);
};
