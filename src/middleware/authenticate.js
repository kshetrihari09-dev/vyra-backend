import { forbidden, unauthorized } from "../utils/errors.js";

/**
 * Verifies the bearer token, then loads the user, roles and permissions FROM THE DATABASE on every request.
 * Nothing about identity or privilege is taken from the token body or from anything the client sends.
 * Sets req.auth = { user: { id, name, roles, permissions, ... } }.
 */
export const authenticate = ({ tokens, repos, pool }) => async (req, _res, next) => {
  try {
    const header = req.get("authorization") || "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) throw unauthorized();
    const claims = tokens.verifyAccessToken(token);
    if (!claims) throw unauthorized("INVALID_TOKEN", "Session expired");

    const row = await repos.users.getAccess(pool, claims.userId);
    if (!row || row.status !== "active") throw unauthorized("INVALID_TOKEN", "Session expired");
    req.auth = { user: { id: row.id, name: row.full_name, email: row.email, roles: row.roles, permissions: row.permissions } };
    next();
  } catch (err) {
    next(err);
  }
};

/** Requires ALL listed permissions. Must run after authenticate. */
export const requirePermission = (...needed) => (req, _res, next) => {
  const have = req.auth?.user?.permissions;
  if (!have) return next(unauthorized());
  if (!needed.every((p) => have.includes(p))) return next(forbidden());
  next();
};

/** Requires AT LEAST ONE of the listed permissions. */
export const requireAnyPermission = (...options) => (req, _res, next) => {
  const have = req.auth?.user?.permissions;
  if (!have) return next(unauthorized());
  if (!options.some((p) => have.includes(p))) return next(forbidden());
  next();
};

/** Requires one of the listed roles (use for endpoints that belong to a role rather than a capability, e.g. the rider API). */
export const requireRole = (...roles) => (req, _res, next) => {
  const have = req.auth?.user?.roles;
  if (!have) return next(unauthorized());
  if (!roles.some((r) => have.includes(r))) return next(forbidden());
  next();
};

/**
 * Like authenticate, but anonymous requests are fine: with a valid bearer token req.auth is populated (so a
 * staff member browsing the catalogue sees inactive products and batch costs); with none, req.auth stays undefined.
 * A present-but-invalid token is treated as anonymous rather than an error, so an expired session never blocks browsing.
 */
export const optionalAuthenticate = ({ tokens, repos, pool }) => async (req, _res, next) => {
  try {
    const [scheme, token] = (req.get("authorization") || "").split(" ");
    if (scheme === "Bearer" && token) {
      const claims = tokens.verifyAccessToken(token);
      const row = claims ? await repos.users.getAccess(pool, claims.userId) : null;
      if (row && row.status === "active") req.auth = { user: { id: row.id, name: row.full_name, email: row.email, roles: row.roles, permissions: row.permissions } };
    }
    next();
  } catch (err) {
    next(err);
  }
};
