/** Payments, refunds and the webhook-idempotency ledger. */
export function createPaymentsRepository() {
  return {
    async insert(db, p) {
      const { rows } = await db.query(
        `INSERT INTO payments (order_id, provider, method, status, currency, amount, instructions, idempotency_key, is_demo)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *`,
        [p.orderId, p.provider, p.method, p.status ?? "pending", p.currency ?? "npr", p.amount, JSON.stringify(p.instructions ?? null), p.idempotencyKey ?? null, p.isDemo ?? false],
      );
      return rows[0];
    },

    async getById(db, id, { forUpdate = false } = {}) {
      const { rows } = await db.query(`SELECT * FROM payments WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`, [id]);
      return rows[0] || null;
    },

    async getByProviderRef(db, provider, providerRef, { forUpdate = false } = {}) {
      const { rows } = await db.query(`SELECT * FROM payments WHERE provider = $1 AND provider_ref = $2${forUpdate ? " FOR UPDATE" : ""}`, [provider, providerRef]);
      return rows[0] || null;
    },

    async getActiveForOrder(db, orderId, { forUpdate = false } = {}) {
      const { rows } = await db.query(
        `SELECT * FROM payments WHERE order_id = $1 AND status IN ('pending','authorized','captured','partially_refunded')
         ORDER BY created_at DESC LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
        [orderId],
      );
      return rows[0] || null;
    },

    async listForOrder(db, orderId) {
      return (await db.query("SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC", [orderId])).rows;
    },

    async update(db, id, patch) {
      const sets = [];
      const values = [id];
      const map = {
        status: "status", providerRef: "provider_ref", failureReason: "failure_reason", rawPayload: "raw_payload",
        authorizedAt: "authorized_at", capturedAt: "captured_at", failedAt: "failed_at", refundedAmount: "refunded_amount",
      };
      for (const [k, col] of Object.entries(map)) {
        if (patch[k] !== undefined) { values.push(col === "raw_payload" ? JSON.stringify(patch[k]) : patch[k]); sets.push(`${col} = $${values.length}${col === "raw_payload" ? "::jsonb" : ""}`); }
      }
      if (!sets.length) return this.getById(db, id);
      const { rows } = await db.query(`UPDATE payments SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, values);
      return rows[0] || null;
    },

    async insertWebhookEvent(db, { provider, eventId, paymentId, payload }) {
      const { rows } = await db.query(
        `INSERT INTO payment_webhook_events (provider, event_id, payment_id, payload) VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT (provider, event_id) DO NOTHING RETURNING *`,
        [provider, eventId, paymentId ?? null, JSON.stringify(payload)],
      );
      return rows[0] || null; // null means this event was already processed (idempotent no-op)
    },

    // --- refunds ---
    async insertRefund(db, r) {
      const { rows } = await db.query(
        `INSERT INTO refunds (payment_id, order_id, amount, reason, requested_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [r.paymentId, r.orderId, r.amount, r.reason, r.requestedBy],
      );
      return rows[0];
    },

    async getRefundById(db, id, { forUpdate = false } = {}) {
      const { rows } = await db.query(`SELECT * FROM refunds WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`, [id]);
      return rows[0] || null;
    },

    async listRefunds(db, { status, orderId } = {}) {
      const clauses = [];
      const values = [];
      if (status) { values.push(status); clauses.push(`status = $${values.length}`); }
      if (orderId) { values.push(orderId); clauses.push(`order_id = $${values.length}`); }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      return (await db.query(`SELECT * FROM refunds ${where} ORDER BY created_at DESC`, values)).rows;
    },

    async updateRefund(db, id, patch) {
      const sets = [];
      const values = [id];
      const map = { status: "status", providerRef: "provider_ref", decidedBy: "decided_by", decidedAt: "decided_at", decisionNote: "decision_note" };
      for (const [k, col] of Object.entries(map)) {
        if (patch[k] !== undefined) { values.push(patch[k]); sets.push(`${col} = $${values.length}`); }
      }
      const { rows } = await db.query(`UPDATE refunds SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, values);
      return rows[0] || null;
    },
  };
}
