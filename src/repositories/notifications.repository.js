/** In-app inbox, the email/SMS outbox, and the per-user opt-outs. */
export function createNotificationsRepository() {
  return {
    // ------------------------------------------------------------------ inbox
    async insert(db, { userId, type, kind, title, message, data }) {
      const { rows } = await db.query(
        `INSERT INTO notifications (user_id, type, kind, title, message, data) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
        [userId, type, kind, title, message, JSON.stringify(data ?? {})]);
      return rows[0];
    },
    async list(db, userId, { unreadOnly, limit, before }) {
      const params = [userId]; const where = ["user_id = $1"];
      if (unreadOnly) where.push("read_at IS NULL");
      if (before) { params.push(before); where.push(`created_at < $${params.length}`); }
      params.push(limit);
      const { rows } = await db.query(`SELECT * FROM notifications WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
      return rows;
    },
    async unreadCount(db, userId) {
      return Number((await db.query("SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL", [userId])).rows[0].n);
    },
    /** Scoped by user_id in SQL: someone else's id simply matches nothing (→ 404 in the service), never leaks existence. */
    async markRead(db, userId, id) {
      const { rows } = await db.query("UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING id", [id, userId]);
      return rows.length > 0;
    },
    async markAllRead(db, userId) {
      return (await db.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL", [userId])).rowCount;
    },

    // ------------------------------------------------------------ preferences
    async getContact(db, userId) {
      const { rows } = await db.query("SELECT id, email, mobile, notify_email, notify_sms FROM users WHERE id = $1", [userId]);
      return rows[0] || null;
    },
    async setPreferences(db, userId, { email, sms }) {
      const sets = []; const values = [userId];
      if (email !== undefined) { values.push(email); sets.push(`notify_email = $${values.length}`); }
      if (sms !== undefined) { values.push(sms); sets.push(`notify_sms = $${values.length}`); }
      if (sets.length) await db.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $1`, values);
      return this.getContact(db, userId);
    },

    // ----------------------------------------------------------------- outbox
    async enqueue(db, { userId, channel, to, subject = null, body, type }) {
      await db.query("INSERT INTO notification_outbox (user_id, channel, to_address, subject, body, type) VALUES ($1,$2,$3,$4,$5,$6)", [userId, channel, to, subject, body, type]);
    },
    /**
     * Takes a batch for THIS worker. SKIP LOCKED lets several processes run without ever sharing a row; `locked_until`
     * makes a row whose worker died mid-send eligible again after the lease expires.
     */
    async claimDue(db, { limit, leaseSeconds }) {
      const { rows } = await db.query(
        `UPDATE notification_outbox o
            SET status = 'sending', attempts = o.attempts + 1, locked_until = now() + make_interval(secs => $2)
          WHERE o.id IN (
            SELECT id FROM notification_outbox
             WHERE (status = 'pending' AND next_attempt_at <= now()) OR (status = 'sending' AND locked_until < now())
             ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING o.*`, [limit, leaseSeconds]);
      return rows;
    },
    async markSent(db, id) {
      await db.query("UPDATE notification_outbox SET status = 'sent', sent_at = now(), locked_until = NULL, last_error = NULL WHERE id = $1", [id]);
    },
    async markRetry(db, id, { delaySeconds, error }) {
      await db.query("UPDATE notification_outbox SET status = 'pending', next_attempt_at = now() + make_interval(secs => $2), locked_until = NULL, last_error = $3 WHERE id = $1", [id, delaySeconds, error]);
    },
    async markDead(db, id, { error }) {
      await db.query("UPDATE notification_outbox SET status = 'dead', locked_until = NULL, last_error = $2 WHERE id = $1", [id, error]);
    },
    async outboxStats(db) {
      const { rows } = await db.query("SELECT status, count(*) AS n FROM notification_outbox GROUP BY status");
      return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
    },
  };
}
