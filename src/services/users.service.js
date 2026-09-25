import { auditView, toUserDto, toUserSummaryDto } from "../models/user.model.js";
import { badRequest, conflict, forbidden, notFound } from "../utils/errors.js";

/**
 * Back-office account management: list users, suspend / reactivate, assign roles.
 * Every change is audited with before/after values in the same transaction.
 */
export function createUsersService({ pool, withTx, repos, audit }) {
  const { users, roles, sessions } = repos;

  return {
    async list({ q, status, role, page, pageSize }) {
      const { rows, total } = await users.list(pool, { q, status, role, limit: pageSize, offset: (page - 1) * pageSize });
      return { items: rows.map(toUserSummaryDto), page, pageSize, total };
    },

    async get(id) {
      const row = await users.getAccess(pool, id);
      if (!row) throw notFound("USER_NOT_FOUND", "User not found");
      return toUserDto(row);
    },

    async listRoles() {
      return (await roles.listRoles(pool)).map((r) => ({ key: r.key, label: r.label, description: r.description, isSystem: r.is_system, permissions: r.permissions }));
    },

    async setStatus(actor, id, { status, reason }, ctx) {
      if (actor.id === id) throw forbidden("CANNOT_MODIFY_SELF", "You cannot change your own account status");
      return withTx(async (db) => {
        const locked = await users.lockById(db, id);
        if (!locked) throw notFound("USER_NOT_FOUND", "User not found");
        const before = await users.getAccess(db, id);

        if (status !== "active" && before.roles.includes("admin") && (await users.countActiveWithRole(db, "admin", id)) === 0) {
          throw conflict("LAST_ADMIN", "This is the last active administrator");
        }
        await users.setStatus(db, id, status);
        if (status !== "active") await sessions.revokeAllForUser(db, id); // kick them out immediately
        const after = await users.getAccess(db, id);
        await audit.log({ actor, action: "user.status_changed", entityType: "user", entityId: id, oldValue: auditView(before), newValue: { ...auditView(after), reason: reason ?? null } }, ctx, db);
        return toUserDto(after);
      });
    },

    /** Replaces the user's roles with exactly `roleKeys`. */
    async setRoles(actor, id, roleKeys, ctx) {
      if (actor.id === id) throw forbidden("CANNOT_MODIFY_SELF", "You cannot change your own roles");
      const wanted = [...new Set(roleKeys)];
      return withTx(async (db) => {
        const locked = await users.lockById(db, id);
        if (!locked) throw notFound("USER_NOT_FOUND", "User not found");

        const known = await roles.existingKeys(db, wanted);
        const unknown = wanted.filter((k) => !known.includes(k));
        if (unknown.length) throw badRequest("UNKNOWN_ROLE", `Unknown role: ${unknown.join(", ")}`);

        const before = await users.getAccess(db, id);
        if (before.roles.includes("admin") && !wanted.includes("admin") && (await users.countActiveWithRole(db, "admin", id)) === 0) {
          throw conflict("LAST_ADMIN", "This is the last active administrator");
        }
        await roles.replaceUserRoles(db, id, wanted, actor.id);
        await sessions.revokeAllForUser(db, id); // permissions changed: force a fresh sign-in
        const after = await users.getAccess(db, id);
        await audit.log({ actor, action: "user.roles_changed", entityType: "user", entityId: id, oldValue: { roles: before.roles }, newValue: { roles: after.roles } }, ctx, db);
        return toUserDto(after);
      });
    },
  };
}
