export function createSellersRepository() {
  return {
    /** Only ever called at the moment a seller application is approved — the shop goes straight to
        "active", never "pending" (a "pending" seller with no application, like a demo seed, is a row
        written directly by the seed script). */
    async insert(db, s) {
      const { rows } = await db.query(
        `INSERT INTO sellers (id, name, status, commission_rate, owner_user_id, contact_email, contact_mobile)
         VALUES ($1,$2,'active',$3,$4,$5,$6) RETURNING *`,
        [s.id, s.name, s.commissionRate, s.ownerUserId ?? null, s.contactEmail ?? null, s.contactMobile ?? null],
      );
      return rows[0];
    },

    async getById(db, id, { forUpdate = false } = {}) {
      const { rows } = await db.query(`SELECT * FROM sellers WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`, [id]);
      return rows[0] || null;
    },

    async getByOwner(db, ownerUserId) {
      const { rows } = await db.query("SELECT * FROM sellers WHERE owner_user_id = $1", [ownerUserId]);
      return rows[0] || null;
    },

    async idExists(db, id) {
      return (await db.query("SELECT 1 FROM sellers WHERE id = $1", [id])).rows.length > 0;
    },

    async list(db, { status, q, limit, offset } = {}) {
      const params = [];
      const where = [];
      if (status) { params.push(status); where.push(`status = $${params.length}`); }
      if (q) { params.push(`%${q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`); where.push(`lower(name) LIKE $${params.length}`); }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const total = Number((await db.query(`SELECT count(*) AS n FROM sellers ${whereSql}`, params)).rows[0].n);
      const rows = limit != null
        ? (await db.query(`SELECT * FROM sellers ${whereSql} ORDER BY joined_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset ?? 0])).rows
        : (await db.query(`SELECT * FROM sellers ${whereSql} ORDER BY joined_at DESC`, params)).rows;
      return { rows, total };
    },

    async updateStatus(db, id, status) {
      const { rows } = await db.query("UPDATE sellers SET status = $2 WHERE id = $1 RETURNING *", [id, status]);
      return rows[0] || null;
    },

    async updatePayoutMethodLabel(db, id, label) {
      await db.query("UPDATE sellers SET payout_method_label = $2 WHERE id = $1", [id, label]);
    },

    /**
     * Decision D3: what a seller can be paid is delivered orders minus whatever's already been requested (any
     * status other than rejected — a paid payout is spent, and a pending one shouldn't be double-counted either).
     * Commission is deducted here so the number returned is always the seller's own net take.
     */
    async availableBalance(db, sellerId) {
      const { rows } = await db.query(
        `SELECT
           COALESCE((
             SELECT SUM(oi.line_total) * (1 - s.commission_rate / 100.0)
               FROM order_items oi JOIN orders o ON o.id = oi.order_id
              WHERE oi.seller_id = $1 AND o.status = 'delivered'
           ), 0) AS gross_net,
           COALESCE((
             SELECT SUM(amount) FROM seller_payouts WHERE seller_id = $1 AND status <> 'rejected'
           ), 0) AS already_requested,
           s.commission_rate
         FROM sellers s WHERE s.id = $1`,
        [sellerId],
      );
      const row = rows[0];
      if (!row) return 0;
      return Math.max(0, Number(row.gross_net) - Number(row.already_requested));
    },
  };
}
