import { unauthorized } from "../utils/errors.js";

/**
 * Gate for every /rider/* route. Must run after `authenticate` (which already rejects unknown / suspended users and loads
 * roles + permissions from the database). It then runs the SAME central check the services use — active user, `delivery`
 * role, `delivery:rider` permission, an active rider profile that belongs to this user — so a rider whose role, permission
 * or account was just revoked gets a 403 before any handler runs.
 *
 * It is a fast, early refusal, not the only line of defence: each service method re-validates inside its own transaction.
 */
export const requireRiderAccess = ({ pool, services }) => async (req, _res, next) => {
  try {
    if (!req.auth?.user) throw unauthorized();
    await services.riderAccess.requireSelf(pool, req.auth.user);
    next();
  } catch (err) {
    next(err);
  }
};
