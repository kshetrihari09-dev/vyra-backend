import { DELIVERY_RULES } from "../config/delivery.js";
import { conflict, forbidden } from "../utils/errors.js";

/**
 * The ONE definition of "a valid rider". Nothing else in the codebase decides this — the route middleware, every
 * rider-side service call, and every dispatcher assignment go through `evaluateRider` (via services/riderAccess.service.js).
 *
 * A rider is valid only if ALL of these hold:
 *   user exists  ·  user is active  ·  user has the `delivery` role  ·  user has the `delivery:rider` permission
 *   rider profile exists  ·  profile is active  ·  profile belongs to that exact user
 *
 * The `riders` table alone is NOT authority: an admin removing the role/permission or suspending the user must
 * revoke rider access immediately, even though the profile row is still there.
 */
export const RIDER_ROLE = "delivery";
export const RIDER_PERMISSION = "delivery:rider";

/** Why a rider is not valid. Order matters: the first failing check wins. */
export const REASON = Object.freeze({
  USER_MISSING: "user_missing",
  USER_SUSPENDED: "user_suspended",
  USER_DEACTIVATED: "user_deactivated",
  ROLE_MISSING: "role_missing",
  PERMISSION_MISSING: "permission_missing",
  PROFILE_MISSING: "profile_missing",
  PROFILE_MISMATCH: "profile_mismatch",
  PROFILE_INACTIVE: "profile_inactive",
});

/** What the dispatcher / admin UI shows for a rider. Derived on the server so the client never re-implements the rules. */
export const RIDER_STATE = Object.freeze({
  AVAILABLE: "available",
  AT_CAPACITY: "at_capacity",
  OFF_DUTY: "off_duty",
  INACTIVE: "inactive",
  SUSPENDED: "suspended",
  NOT_AUTHORIZED: "not_authorized",
});

/**
 * @param {{ user: {id, status, roles, permissions} | null, rider: {user_id, status} | null }} input
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function evaluateRider({ user, rider }) {
  if (!user) return { ok: false, reason: REASON.USER_MISSING };
  if (user.status === "suspended") return { ok: false, reason: REASON.USER_SUSPENDED };
  if (user.status !== "active") return { ok: false, reason: REASON.USER_DEACTIVATED };
  if (!user.roles?.includes(RIDER_ROLE)) return { ok: false, reason: REASON.ROLE_MISSING };
  if (!user.permissions?.includes(RIDER_PERMISSION)) return { ok: false, reason: REASON.PERMISSION_MISSING };
  if (!rider) return { ok: false, reason: REASON.PROFILE_MISSING };
  if (rider.user_id !== user.id) return { ok: false, reason: REASON.PROFILE_MISMATCH };
  if (rider.status !== "active") return { ok: false, reason: REASON.PROFILE_INACTIVE };
  return { ok: true };
}

/** A rider row as the repository returns it (profile + the owning user's status / roles / permissions in one read). */
export const userOfRiderRow = (row) => ({ id: row.user_id, status: row.user_status, roles: row.roles ?? [], permissions: row.permissions ?? [] });
export const evaluateRiderRow = (row) => evaluateRider({ user: userOfRiderRow(row), rider: row });

/** The display state. `canTakeDelivery` is only a hint for the UI — the backend re-validates every assignment. */
export function riderState(row, { capacity = DELIVERY_RULES.maxActivePerRider } = {}) {
  const verdict = evaluateRiderRow(row);
  if (!verdict.ok) {
    if (verdict.reason === REASON.USER_SUSPENDED) return RIDER_STATE.SUSPENDED;
    if (verdict.reason === REASON.USER_DEACTIVATED || verdict.reason === REASON.PROFILE_INACTIVE) return RIDER_STATE.INACTIVE;
    return RIDER_STATE.NOT_AUTHORIZED;
  }
  if (!row.is_available) return RIDER_STATE.OFF_DUTY;
  if (Number(row.active_count ?? 0) >= capacity) return RIDER_STATE.AT_CAPACITY;
  return RIDER_STATE.AVAILABLE;
}

const DISPATCH_MESSAGE = "Rider is inactive or no longer authorized for delivery.";

/**
 * The error a DISPATCHER gets when assigning to / reassigning to a rider who isn't valid (409: the request was fine,
 * the target isn't). Same message for every reason on purpose — dispatch doesn't need to know which check failed.
 */
export function dispatchError(reason) {
  const inactive = [REASON.USER_SUSPENDED, REASON.USER_DEACTIVATED, REASON.PROFILE_INACTIVE].includes(reason);
  return conflict(inactive ? "RIDER_INACTIVE" : "RIDER_NOT_AUTHORIZED", DISPATCH_MESSAGE);
}

/**
 * The error a RIDER gets when they themselves are not valid (403). `NOT_A_RIDER` is the "authorised but no profile yet"
 * case — the app turns it into a setup message rather than a broken screen.
 */
export function selfError(reason) {
  switch (reason) {
    case REASON.PROFILE_MISSING: return forbidden("NOT_A_RIDER", "This account isn't set up as a delivery rider");
    case REASON.USER_SUSPENDED: case REASON.USER_DEACTIVATED: case REASON.PROFILE_INACTIVE:
      return forbidden("RIDER_SUSPENDED", "Rider is inactive.");
    default: return forbidden("RIDER_NOT_AUTHORIZED", "Rider is no longer authorized.");
  }
}
