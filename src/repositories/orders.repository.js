/** Orders, order items and status history. */
export const formatOrderNumber = (day, seq) => `PN-${day}-${String(seq).padStart(6, "0")}`;

export function createOrdersRepository() {
  return {
    /**
     * `PN-YYYYMMDD-NNNNNN`, e.g. PN-20261001-000001. The counter is a Postgres SEQUENCE: nextval() is atomic across
     * concurrent transactions, so two orders can never be handed the same value (no random suffix, no read-then-write
     * race). Gaps are possible — a rolled-back checkout burns its number — and are harmless; uniqueness is what matters,
     * and orders.number is UNIQUE as the final backstop. The date part is the UTC day the number was issued.
     */
    async nextNumber(db) {
      const { rows } = await db.query("SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDD') AS day, nextval('order_number_seq') AS seq");
      return formatOrderNumber(rows[0].day, rows[0].seq);
    },

    async insert(db, o) {
      const { rows } = await db.query(
        `INSERT INTO orders (number, user_id, branch_id, status, payment_method, address_id, address, delivery_option_id, delivery_fee, slot,
                             subtotal, discount, tax, total, coupon_code, notes, instructions, otp_nonce, otp_required, eta, is_demo)
         VALUES ($1,$2,$3,'placed',$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
        [o.number, o.userId, o.branchId, o.paymentMethod, o.addressId ?? null, JSON.stringify(o.address), o.deliveryOptionId, o.deliveryFee, o.slot ?? null,
         o.subtotal, o.discount, o.tax, o.total, o.couponCode ?? null, o.notes ?? null, o.instructions ?? null, o.otpNonce ?? null, o.otpRequired, o.eta ?? null, o.isDemo ?? false],
      );
      return rows[0];
    },

    async insertItems(db, orderId, items) {
      for (const it of items) {
        await db.query(
          `INSERT INTO order_items (order_id, product_id, variant_id, seller_id, name, unit_price, tax_percent, qty, line_total, prescription_required)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [orderId, it.productId, it.variantId ?? null, it.sellerId ?? null, it.name, it.unitPrice, it.taxPercent ?? 0, it.qty, it.lineTotal, !!it.prescriptionRequired],
        );
      }
    },

    async addHistory(db, orderId, status, note = null) {
      await db.query("INSERT INTO order_status_history (order_id, status, note) VALUES ($1,$2,$3)", [orderId, status, note]);
    },

    async getById(db, id, { forUpdate = false } = {}) {
      const { rows } = await db.query(`SELECT * FROM orders WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`, [id]);
      return rows[0] || null;
    },

    async items(db, orderId) {
      return (await db.query("SELECT * FROM order_items WHERE order_id = $1 ORDER BY id", [orderId])).rows;
    },

    /** The active delivery (if any) of each order, for the progress summary on order lists. Read-only. */
    async activeDeliveries(db, orderIds) {
      const out = new Map();
      if (!orderIds.length) return out;
      const { rows } = await db.query(
        "SELECT order_id, status, arrived_pickup_at, started_at, eta_source FROM deliveries WHERE order_id = ANY($1) AND status IN ('assigned','accepted','picked_up')", [orderIds]);
      for (const r of rows) out.set(r.order_id, r);
      return out;
    },
    async itemsForOrders(db, orderIds) {
      if (!orderIds.length) return new Map();
      const { rows } = await db.query("SELECT * FROM order_items WHERE order_id = ANY($1::uuid[]) ORDER BY order_id, id", [orderIds]);
      const out = new Map();
      for (const r of rows) { if (!out.has(r.order_id)) out.set(r.order_id, []); out.get(r.order_id).push(r); }
      return out;
    },

    async history(db, orderId) {
      return (await db.query("SELECT status, note, at FROM order_status_history WHERE order_id = $1 ORDER BY at", [orderId])).rows;
    },

    async listMine(db, userId, { limit = 100 } = {}) {
      return (await db.query("SELECT * FROM orders WHERE user_id = $1 ORDER BY placed_at DESC LIMIT $2", [userId, limit])).rows;
    },

    /** Used for "first order" coupon eligibility — counts every order the user has ever placed, cancelled included. */
    async countForUser(db, userId) {
      return Number((await db.query("SELECT count(*) AS n FROM orders WHERE user_id = $1", [userId])).rows[0].n);
    },

    /** Orders that contain at least one line sold by this seller (a basket can span several shops). */
    async listForSeller(db, sellerId, { limit = 200 } = {}) {
      const { rows } = await db.query(
        "SELECT o.* FROM orders o WHERE EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.seller_id = $1) ORDER BY o.placed_at DESC LIMIT $2",
        [sellerId, limit],
      );
      return rows;
    },

    async listAll(db, { status = null, limit = 200 } = {}) {
      const { rows } = await db.query(
        status ? "SELECT * FROM orders WHERE status = $1 ORDER BY placed_at DESC LIMIT $2" : "SELECT * FROM orders ORDER BY placed_at DESC LIMIT $1",
        status ? [status, limit] : [limit],
      );
      return rows;
    },

    async updateStatus(db, id, status, patch = {}) {
      const sets = ["status = $2"];
      const values = [id, status];
      const map = { deliveredAt: "delivered_at", cancelledAt: "cancelled_at", returnedAt: "returned_at", cancelReason: "cancel_reason",
        paymentStatus: "payment_status", partner: "partner", eta: "eta", otpNonce: "otp_nonce", otpAttempts: "otp_attempts" };
      for (const [k, col] of Object.entries(map)) {
        if (patch[k] !== undefined) { values.push(col === "partner" && patch[k] !== null ? JSON.stringify(patch[k]) : patch[k]); sets.push(`${col} = $${values.length}${col === "partner" ? "::jsonb" : ""}`); }
      }
      const { rows } = await db.query(`UPDATE orders SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, values);
      return rows[0] || null;
    },
  };
}
