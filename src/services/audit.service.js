import { forbidden } from "../utils/errors.js";

const SENSITIVE = /pass(word)?|token|secret|otp|nonce|account(_?number)?|iban|card|cvv|pin\b|authorization|hash/i;
/** Recursively masks values under sensitive-looking keys. Exported for tests. */
export function redact(value, depth = 0) {
  if (value == null || depth > 6) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SENSITIVE.test(k) ? "[redacted]" : redact(v, depth + 1)]));
  return value;
}
export const toAuditDto = (r) => ({
  id: String(r.id), at: r.at, actorUserId: r.actor_user_id, actor: r.actor_label, action: r.action,
  entityType: r.entity_type, entityId: r.entity_id, oldValue: redact(r.old_value), newValue: redact(r.new_value), ip: r.ip, requestId: r.request_id,
});

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
    /**
     * Reading the log needs `audit:read`. Values are redacted on the way OUT as well as being kept clean on the way in:
     * if a future caller ever logs something sensitive by mistake, the viewer still won't show it.
     */
    async query(actor, { page = 1, pageSize = 25, ...filters }) {
      if (!actor?.permissions?.includes("audit:read")) throw forbidden();
      const { rows, total } = await repo.list(pool, { ...filters, limit: pageSize, offset: (page - 1) * pageSize });
      return { entries: rows.map(toAuditDto), total, page, pageSize };
    },
  };
}
