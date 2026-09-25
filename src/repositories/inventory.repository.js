/**
 * Stock-changing operations needed to place and fulfil an order (decision D2 in MIGRATION_PLAN.md):
 * reserve at placement → allocate + deduct (FEFO for batch-tracked products) when an order reaches "packed" →
 * release the reservation if it's cancelled first. Everything here runs inside the caller's transaction and
 * locks the row with FOR UPDATE, so concurrent orders can never oversell the same stock.
 *
 * Adjustments, transfers, receiving and purchase orders are still Phase 4 — this file only has what order
 * placement/fulfilment needs.
 */
export function createInventoryRepository() {
  return {
    /** Locks and returns the inventory row for (branch, product, variant), creating one with zero stock if none exists yet. */
    async lockRow(db, { branchId, productId, variantId = null }) {
      const existing = await db.query(
        "SELECT * FROM inventory WHERE branch_id = $1 AND product_id = $2 AND variant_id IS NOT DISTINCT FROM $3 FOR UPDATE",
        [branchId, productId, variantId],
      );
      if (existing.rows.length) return existing.rows[0];
      const { rows } = await db.query(
        "INSERT INTO inventory (branch_id, product_id, variant_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING *",
        [branchId, productId, variantId],
      );
      if (rows.length) return rows[0];
      // Someone else inserted it between our SELECT and INSERT — lock it now.
      return (await db.query(
        "SELECT * FROM inventory WHERE branch_id = $1 AND product_id = $2 AND variant_id IS NOT DISTINCT FROM $3 FOR UPDATE",
        [branchId, productId, variantId],
      )).rows[0];
    },

    /** Read-only availability check for pricing/preview (no lock — callers that will actually reserve use lockRow instead). */
    async availableQty(db, { branchId, productId, variantId = null }) {
      const { rows } = await db.query(
        "SELECT (on_hand - reserved) AS n FROM inventory WHERE branch_id = $1 AND product_id = $2 AND variant_id IS NOT DISTINCT FROM $3",
        [branchId, productId, variantId],
      );
      return rows.length ? Number(rows[0].n) : 0;
    },

    /** Increases `reserved` by qty. Caller has already locked the row and checked (on_hand - reserved) >= qty. */
    async reserve(db, rowId, qty) {
      await db.query("UPDATE inventory SET reserved = reserved + $2 WHERE id = $1", [rowId, qty]);
    },

    /** Releases a reservation without touching on_hand (order cancelled before stock was actually deducted). */
    async release(db, rowId, qty) {
      await db.query("UPDATE inventory SET reserved = GREATEST(reserved - $2, 0) WHERE id = $1", [rowId, qty]);
    },

    /** Deducts on_hand and clears the matching reservation — the order has reached "packed" and stock is really leaving. */
    async deduct(db, rowId, qty) {
      await db.query("UPDATE inventory SET on_hand = GREATEST(on_hand - $2, 0), reserved = GREATEST(reserved - $2, 0) WHERE id = $1", [rowId, qty]);
    },

    /** Batch-tracked products only: locks batches for (branch, product) oldest-expiry-first, real batches before the quarantined LEGACY-OPENING one. */
    async lockBatchesFefo(db, { branchId, productId }) {
      return (await db.query(
        `SELECT * FROM inventory_batches WHERE branch_id = $1 AND product_id = $2 AND qty > 0
          ORDER BY is_legacy_opening, expiry_date NULLS LAST FOR UPDATE`,
        [branchId, productId],
      )).rows;
    },

    async deductBatch(db, id, qty) {
      await db.query("UPDATE inventory_batches SET qty = qty - $2 WHERE id = $1", [id, qty]);
    },

    async isBatchTracked(db, productId) {
      return (await db.query("SELECT 1 FROM inventory_batches WHERE product_id = $1 LIMIT 1", [productId])).rows.length > 0;
    },

    /** Consumes `qty` from a batch-tracked product's batches, oldest-expiry-first (LEGACY-OPENING last). No-op for products with no batches. */
    async consumeFefo(db, { branchId, productId, qty }) {
      if (!(await this.isBatchTracked(db, productId))) return;
      let remaining = qty;
      for (const b of await this.lockBatchesFefo(db, { branchId, productId })) {
        if (remaining <= 0) break;
        const take = Math.min(b.qty, remaining);
        if (take > 0) { await this.deductBatch(db, b.id, take); remaining -= take; }
      }
    },

    /** Adds `qty` new units into a batch (creating it if new) — receiving a purchase order. */
    async receiveBatch(db, { branchId, productId, batchNo, expiryDate, purchaseCost, qty }) {
      await db.query(
        `INSERT INTO inventory_batches (branch_id, product_id, batch_no, expiry_date, purchase_cost, qty)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (branch_id, product_id, COALESCE(variant_id, ''), batch_no) DO UPDATE SET qty = inventory_batches.qty + EXCLUDED.qty`,
        [branchId, productId, batchNo, expiryDate, purchaseCost ?? null, qty],
      );
    },

    /** Increases on_hand directly (receiving; adjustments with a positive delta). Not an order-reservation path. */
    async increase(db, rowId, qty) {
      await db.query("UPDATE inventory SET on_hand = on_hand + $2 WHERE id = $1", [rowId, qty]);
    },

    /** Every stock-changing operation writes one of these — the ledger a low-stock report or an audit trail reads from. */
    async recordMovement(db, m) {
      const { rows } = await db.query(
        `INSERT INTO inventory_movements (branch_id, product_id, variant_id, delta, prev_qty, new_qty, reason, batch_no, ref_type, ref_id, actor_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [m.branchId, m.productId, m.variantId ?? null, m.delta, m.prevQty, m.newQty, m.reason, m.batchNo ?? null, m.refType, m.refId ?? null, m.actorId ?? null],
      );
      return rows[0];
    },

    async listMovements(db, { productId, branchId, limit = 100 } = {}) {
      const clauses = []; const values = [];
      if (productId) { values.push(productId); clauses.push(`product_id = $${values.length}`); }
      if (branchId) { values.push(branchId); clauses.push(`branch_id = $${values.length}`); }
      values.push(limit);
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      return (await db.query(`SELECT * FROM inventory_movements ${where} ORDER BY at DESC LIMIT $${values.length}`, values)).rows;
    },

    /** Every branch's stock for every product, for the low-stock report (on_hand at/below its reorder_level). */
    async lowStock(db, { branchId } = {}) {
      const { rows } = await db.query(
        `SELECT i.branch_id, i.product_id, i.variant_id, i.on_hand, i.reserved, i.reorder_level
           FROM inventory i
          WHERE i.on_hand <= i.reorder_level AND ($1::text IS NULL OR i.branch_id = $1)
          ORDER BY i.on_hand ASC`,
        [branchId ?? null],
      );
      return rows;
    },
  };
}
