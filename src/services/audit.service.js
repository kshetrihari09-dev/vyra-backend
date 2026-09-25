/**
 * Append-only audit trail. Pass the transaction client as `db` so the audit row commits or rolls back with the
 * change it describes. Never put secrets (password hashes, tokens) in old/new values.
 */
export function createAuditService({ repo, pool }) {
  return {
    async log(entry, ctx = {}, db = pool) {
      await repo.insert(db, {
        actorUserId: entry.actor?.id ?? null,
        actorLabel: entry.actor ? `${entry.actor.name} (${(entry.actor.roles || []).join(",") || "no role"})` : entry.actorLabel ?? "system",
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        oldValue: entry.oldValue,
        newValue: entry.newValue,
        ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId,
      });
    },
    async list(query) {
      return repo.list(pool, query);
    },
  };
}
