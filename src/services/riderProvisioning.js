import { conflict, notFound } from "../utils/errors.js";

/**
 * The one way a user becomes a rider: used by an admin adding a rider directly AND by approving a rider application,
 * so both end in exactly the same state (delivery role + riders profile) and the same checks.
 * Lock order: user (first) → rider (the insert). Callers that also lock something else take it per the order in delivery.service.js.
 */
export function createRiderProvisioning({ repos, audit }) {
  return async function provisionRider(db, { actor, userId, phone, vehicle, via = "admin" }, ctx) {
    const user = await repos.users.lockById(db, userId);
    if (!user) throw notFound("USER_NOT_FOUND", "User not found");
    if (user.status !== "active") throw conflict("USER_INACTIVE", "That account is not active");
    if (await repos.delivery.getRiderByUser(db, user.id)) throw conflict("RIDER_EXISTS", "That user is already a rider");
    await repos.roles.addUserRole(db, user.id, "delivery", actor.id);
    const rider = await repos.delivery.insertRider(db, { userId: user.id, phone, vehicle });
    await audit.log({ actor, action: "rider.created", entityType: "rider", entityId: rider.id, newValue: { userId: user.id, vehicle, via } }, ctx, db);
    return rider;
  };
}
