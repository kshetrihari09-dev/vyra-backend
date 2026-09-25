/**
 * Application errors. Anything thrown as an AppError is safe to show to the
 * client (status + code + message). Everything else is treated as an
 * unexpected failure and reported as a generic 500 by the error handler.
 */
export class AppError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code   stable machine-readable code (frontend switches on this)
   * @param {string} message human-readable, safe to display
   * @param {unknown} [details] extra safe-to-expose data (e.g. field errors)
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code, message, details) => new AppError(400, code, message, details);
export const unauthorized = (code = "UNAUTHENTICATED", message = "Authentication required") => new AppError(401, code, message);
export const forbidden = (code = "FORBIDDEN", message = "You do not have permission to do that") => new AppError(403, code, message);
export const notFound = (code = "NOT_FOUND", message = "Resource not found") => new AppError(404, code, message);
export const conflict = (code, message, details) => new AppError(409, code, message, details);
export const tooManyRequests = (code = "RATE_LIMITED", message = "Too many requests. Please try again later.") => new AppError(429, code, message);
export const unavailable = (code, message) => new AppError(503, code, message);
