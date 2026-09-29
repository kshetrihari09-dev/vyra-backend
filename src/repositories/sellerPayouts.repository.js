export function createSellerPayoutsRepository() {
  return {
    async insert(db, p) {
      const { rows } = await db.query(
        `INSERT INTO seller_payouts (seller_id, amount, method_label, note, requested_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [p.sellerId, p.amount, p.methodLabel ?? null, p.note ?? null, p.requestedBy],
      );
      return rows[0];
    },

    async getById(db, id, { forUpdate = false } = {}) {
      const { rows } = await db.query(`SELECT * FROM seller_payouts WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`, [id]);
      return rows[0] || null;
    },

    async listForSeller(db, sellerId) {
      return (await db.query("SELECT * FROM seller_payouts WHERE seller_id = $1 ORDER BY created_at DESC", [sellerId])).rows;
    },

    async listAll(db, { status } = {}) {
      return (await db.query(status ? "SELECT * FROM seller_payouts WHERE status = $1 ORDER BY created_at DESC" : "SELECT * FROM seller_payouts ORDER BY created_at DESC", status ? [status] : [])).rows;
    },

    async decide(db, id, patch) {
      const sets = [];
      const values = [id];
      const map = { status: "status", decidedBy: "decided_by", decidedAt: "decided_at", paidAt: "paid_at" };
      for (const [k, col] of Object.entries(map)) {
        if (patch[k] !== undefined) { values.push(patch[k]); sets.push(`${col} = $${values.length}`); }
      }
      const { rows } = await db.query(`UPDATE seller_payouts SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, values);
      return rows[0] || null;
    },
  };
}
