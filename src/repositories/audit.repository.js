export function createAuditRepository() {
  return {
    async insert(db, e) {
      await db.query(
        `INSERT INTO audit_logs (actor_user_id, actor_label, action, entity_type, entity_id, old_value, new_value, ip, user_agent, request_id)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`,
        [e.actorUserId ?? null, e.actorLabel ?? null, e.action, e.entityType, e.entityId == null ? null : String(e.entityId),
         e.oldValue == null ? null : JSON.stringify(e.oldValue), e.newValue == null ? null : JSON.stringify(e.newValue),
         e.ip ?? null, e.userAgent ?? null, e.requestId ?? null],
      );
    },

    async list(db, { entityType, entityId, action, actorUserId, limit, offset }) {
      const params = [];
      const where = [];
      if (entityType) { params.push(entityType); where.push(`entity_type = $${params.length}`); }
      if (entityId) { params.push(entityId); where.push(`entity_id = $${params.length}`); }
      if (action) { params.push(action); where.push(`action = $${params.length}`); }
      if (actorUserId) { params.push(actorUserId); where.push(`actor_user_id = $${params.length}`); }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const total = Number((await db.query(`SELECT count(*) AS n FROM audit_logs ${whereSql}`, params)).rows[0].n);
      params.push(limit, offset);
      const { rows } = await db.query(
        `SELECT id, at, actor_user_id, actor_label, action, entity_type, entity_id, old_value, new_value, ip, request_id
           FROM audit_logs ${whereSql} ORDER BY at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { rows, total };
    },
  };
}
