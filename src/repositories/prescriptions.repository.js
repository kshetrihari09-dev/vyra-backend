/** Prescriptions, their covered-product list, and the link recorded at order creation. */
export function createPrescriptionsRepository() {
  return {
    async insert(db, p) {
      const { rows } = await db.query(
        `INSERT INTO prescriptions (user_id, file_key, file_name, mime_type, size_bytes) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [p.userId, p.fileKey, p.fileName, p.mimeType, p.sizeBytes],
      );
      return rows[0];
    },

    async insertItems(db, prescriptionId, productIds) {
      for (const productId of new Set(productIds)) {
        await db.query(`INSERT INTO prescription_items (prescription_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [prescriptionId, productId]);
      }
    },

    async items(db, prescriptionId) {
      return (await db.query("SELECT product_id FROM prescription_items WHERE prescription_id = $1", [prescriptionId])).rows.map((r) => r.product_id);
    },

    async itemsFor(db, prescriptionIds) {
      if (!prescriptionIds.length) return new Map();
      const { rows } = await db.query("SELECT prescription_id, product_id FROM prescription_items WHERE prescription_id = ANY($1::uuid[])", [prescriptionIds]);
      const out = new Map();
      for (const r of rows) { if (!out.has(r.prescription_id)) out.set(r.prescription_id, []); out.get(r.prescription_id).push(r.product_id); }
      return out;
    },

    async getById(db, id) {
      const { rows } = await db.query("SELECT * FROM prescriptions WHERE id = $1", [id]);
      return rows[0] || null;
    },

    async listMine(db, userId) {
      return (await db.query("SELECT * FROM prescriptions WHERE user_id = $1 ORDER BY created_at DESC", [userId])).rows;
    },

    /** The pharmacist console needs to know *whose* prescription it's reviewing — a plain customer's own
        listMine() doesn't, so only this query joins users. */
    async listAll(db, { status } = {}) {
      const where = status ? "WHERE p.status = $1" : "";
      return (await db.query(
        `SELECT p.*, u.name AS customer_name FROM prescriptions p JOIN users u ON u.id = p.user_id ${where} ORDER BY p.created_at DESC`,
        status ? [status] : [],
      )).rows;
    },

    /** Approved prescriptions this user owns that cover ALL of the given product ids, in one query. */
    async approvedCovering(db, userId, productIds) {
      if (!productIds.length) return [];
      const { rows } = await db.query(
        `SELECT p.* FROM prescriptions p
         WHERE p.user_id = $1 AND p.status = 'approved'
           AND EXISTS (SELECT 1 FROM prescription_items pi WHERE pi.prescription_id = p.id AND pi.product_id = ANY($2::text[]))
         ORDER BY p.reviewed_at DESC`,
        [userId, productIds],
      );
      return rows;
    },

    async review(db, id, { status, notes, rejectionReason, pharmacistId }) {
      const { rows } = await db.query(
        `UPDATE prescriptions SET status = $2, notes = $3, rejection_reason = $4, pharmacist_id = $5, reviewed_at = now() WHERE id = $1 RETURNING *`,
        [id, status, notes ?? null, rejectionReason ?? null, pharmacistId],
      );
      return rows[0] || null;
    },

    async linkToOrder(db, orderId, prescriptionIds) {
      for (const id of new Set(prescriptionIds)) {
        await db.query(`INSERT INTO order_prescriptions (order_id, prescription_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [orderId, id]);
      }
    },

    async forOrder(db, orderId) {
      return (await db.query(
        `SELECT p.* FROM order_prescriptions op JOIN prescriptions p ON p.id = op.prescription_id WHERE op.order_id = $1`, [orderId],
      )).rows;
    },
  };
}
