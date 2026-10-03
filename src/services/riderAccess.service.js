import { REASON, dispatchError, evaluateRider, evaluateRiderRow, selfError } from "../domain/riderEligibility.js";
import { forbidden, notFound } from "../utils/errors.js";

/**
 * Rider authorisation — the single entry point. Everything that needs "is this person (or this rider) allowed to do
 * rider work right now?" calls one of these, so the rule lives in domain/riderEligibility.js and nowhere else:
 *
 *   requireSelf(db, actor)          a rider acting on their own behalf (every /rider/* call, claim, accept, pickup, …)
 *   requireAssignable(db, riderId)  a dispatcher handing work to a rider (assign / reassign)
 *   verdictFor(riderRow)            the same verdict without throwing (dispatcher list, stranded-delivery recovery)
 *
 * Both throwing variants re-read the database; they never trust `actor.roles` / `actor.permissions` (those came from the
 * start of the request). Pass `lock: true` to take the rider row lock (FOR UPDATE) in the same read — callers that do must
 * already hold the ORDER lock, because the global lock order is user → order → rider → delivery.
 */
export function createRiderAccess({ repos }) {
  const { delivery: repo, users } = repos;

  return {
    async requireSelf(db, actor, { lock = false } = {}) {
      if (!actor?.id) throw forbidden("RIDER_NOT_AUTHORIZED", "Rider is no longer authorized.");
      const row = await repo.getRiderByUser(db, actor.id, { forUpdate: lock });
      if (row) {
        // Defence in depth: the profile must belong to exactly the user making the request.
        const verdict = row.user_id !== actor.id ? { ok: false, reason: REASON.PROFILE_MISMATCH } : evaluateRiderRow(row);
        if (!verdict.ok) throw selfError(verdict.reason);
        return row;
      }
      // No profile: say "not set up" only to someone who WOULD be a rider (active, role, permission); anyone else is simply not authorised.
      const access = await users.getAccess(db, actor.id);
      const user = access && { id: access.id, status: access.status, roles: access.roles, permissions: access.permissions };
      const verdict = evaluateRider({ user, rider: null });
      throw selfError(verdict.reason);
    },

    async requireAssignable(db, riderId, { lock = false } = {}) {
      const row = await repo.getRider(db, riderId, { forUpdate: lock });
      if (!row) throw notFound("RIDER_NOT_FOUND", "Rider not found");
      const verdict = evaluateRiderRow(row);
      if (!verdict.ok) throw dispatchError(verdict.reason);
      return row;
    },

    verdictFor: (riderRow) => evaluateRiderRow(riderRow),
  };
}
