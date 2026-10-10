/** Suppliers, purchase orders and POS sales. */
const SALE_SELECT = `SELECT s.*, b.name AS branch_name, u.full_name AS cashier_name
  FROM pos_sales s LEFT JOIN branches b ON b.id = s.branch_id LEFT JOIN users u ON u.id = s.cashier_id`;

export function createPurchasingRepository() {
  return {
    async listSuppliers(db) { return (await db.query("SELECT * FROM suppliers ORDER BY lower(name)")).rows; },
    async getSupplier(db, id) { return (await db.query("SELECT * FROM suppliers WHERE id = $1", [id])).rows[0] || null; },

    async listPurchaseOrders(db, { status } = {}) {
      return (await db.query(status ? "SELECT * FROM purchase_orders WHERE status = $1 ORDER BY created_at DESC" : "SELECT * FROM purchase_orders ORDER BY created_at DESC", status ? [status] : [])).rows;
    },
    async getPurchaseOrder(db, id, { forUpdate = false } = {}) {
      return (await db.query(`SELECT * FROM purchase_orders WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`, [id])).rows[0] || null;
    },
    async poLines(db, poId) { return (await db.query("SELECT * FROM purchase_order_lines WHERE po_id = $1", [poId])).rows; },
    async linesForPOs(db, ids) {
      if (!ids.length) return new Map();
      const { rows } = await db.query("SELECT * FROM purchase_order_lines WHERE po_id = ANY($1::uuid[])", [ids]);
      const m = new Map(); for (const r of rows) { if (!m.has(r.po_id)) m.set(r.po_id, []); m.get(r.po_id).push(r); }
      return m;
    },
    async deletePOLines(db, poId) { await db.query("DELETE FROM purchase_order_lines WHERE po_id = $1", [poId]); },
    async insertPurchaseOrder(db, po) {
      const { rows } = await db.query(
        "INSERT INTO purchase_orders (number, supplier_id, branch_id, invoice_number, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *",
        [po.number, po.supplierId, po.branchId, po.invoiceNumber ?? null, po.createdBy],
      );
      return rows[0];
    },
    async insertPOLine(db, poId, l) {
      await db.query("INSERT INTO purchase_order_lines (po_id, product_id, qty, purchase_price, batch_no, expiry_date) VALUES ($1,$2,$3,$4,$5,$6)",
        [poId, l.productId, l.qty, l.purchasePrice, l.batchNo, l.expiryDate]);
    },
    async markReceived(db, id) {
      const { rows } = await db.query("UPDATE purchase_orders SET status='received', received_at=now() WHERE id=$1 AND status='ordered' RETURNING *", [id]);
      return rows[0] || null;
    },
    async nextPONumber(db) {
      const { rows } = await db.query("SELECT count(*) + 1001 AS n FROM purchase_orders");
      return `PO-${rows[0].n}`;
    },

    /** Serialises concurrent requests carrying the SAME key (a double-click, a retry racing its original) until the first one commits. */
    async lockIdempotency(db, cashierId, key) {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`pos:${cashierId}:${key}`]);
    },
    async getBranch(db, id) {
      return (await db.query("SELECT id, name, is_active FROM branches WHERE id = $1", [id])).rows[0] || null;
    },
    async insertPosSale(db, s) {
      const { rows } = await db.query(
        `INSERT INTO pos_sales (number, branch_id, cashier_id, customer_name, payment_method, subtotal, discount, discount_type, discount_value, tax, total,
                                amount_received, change_due, idempotency_key, request_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [s.number, s.branchId, s.cashierId, s.customerName ?? null, s.paymentMethod, s.subtotal, s.discount, s.discountType ?? null, s.discountValue ?? null, s.tax, s.total,
          s.amountReceived, s.changeDue, s.idempotencyKey ?? null, s.requestHash ?? null],
      );
      return rows[0];
    },
    async insertPosSaleItem(db, saleId, it) {
      await db.query(
        `INSERT INTO pos_sale_items (sale_id, line_no, product_id, variant_id, name, unit_price, qty, line_total, discount, tax_percent, tax, batch_no)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [saleId, it.lineNo, it.productId, it.variantId ?? null, it.name, it.unitPrice, it.qty, it.lineTotal, it.discount, it.taxPercent, it.tax, it.batchNo ?? null],
      );
    },
    /**
     * Next sale number: one counter row per day, bumped inside the sale's own transaction — two tills can't be handed the same number and a
     * rolled-back sale never burns one. If a number somehow already exists (counter drift after a restore or a manual edit) it is skipped
     * rather than failing the sale at the till.
     */
    async nextSaleNumber(db) {
      for (let attempt = 0; attempt < 50; attempt++) {
        const { rows } = await db.query(
          `INSERT INTO pos_sale_counters (day, n) VALUES (current_date, 1)
           ON CONFLICT (day) DO UPDATE SET n = pos_sale_counters.n + 1
           RETURNING n, to_char(day, 'YYYYMMDD') AS d`,
        );
        const number = `POS-${rows[0].d}${String(rows[0].n).padStart(4, "0")}`;
        if (!(await db.query("SELECT 1 FROM pos_sales WHERE number = $1", [number])).rows.length) return number;
      }
      throw new Error("Could not allocate a sale number");
    },

    async getSale(db, { id, number, cashierId, key } = {}) {
      const where = []; const values = [];
      if (id) { values.push(id); where.push(`s.id = $${values.length}`); }
      if (number) { values.push(number); where.push(`s.number = $${values.length}`); }
      if (cashierId && key) { values.push(cashierId, key); where.push(`s.cashier_id = $${values.length - 1} AND s.idempotency_key = $${values.length}`); }
      if (!where.length) return null;
      const { rows } = await db.query(`${SALE_SELECT} WHERE ${where.join(" AND ")}`, values);
      return rows[0] || null;
    },
    async listSales(db, { cashierId, branchId, limit = 30 } = {}) {
      const where = []; const values = [];
      if (cashierId) { values.push(cashierId); where.push(`s.cashier_id = $${values.length}`); }
      if (branchId) { values.push(branchId); where.push(`s.branch_id = $${values.length}`); }
      values.push(limit);
      const { rows } = await db.query(`${SALE_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY s.created_at DESC LIMIT $${values.length}`, values);
      return rows;
    },
    async saleItems(db, saleId) {
      return (await db.query("SELECT * FROM pos_sale_items WHERE sale_id = $1 ORDER BY line_no, id", [saleId])).rows;
    },
  };
}
