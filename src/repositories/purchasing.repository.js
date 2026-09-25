/** Suppliers, purchase orders and POS sales. */
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

    async insertPosSale(db, s) {
      const { rows } = await db.query(
        "INSERT INTO pos_sales (number, branch_id, cashier_id, customer_name, payment_method, subtotal, tax, total) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
        [s.number, s.branchId, s.cashierId, s.customerName ?? null, s.paymentMethod, s.subtotal, s.tax, s.total],
      );
      return rows[0];
    },
    async insertPosSaleItem(db, saleId, it) {
      await db.query("INSERT INTO pos_sale_items (sale_id, product_id, variant_id, name, unit_price, qty, line_total, batch_no) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [saleId, it.productId, it.variantId ?? null, it.name, it.unitPrice, it.qty, it.lineTotal, it.batchNo ?? null]);
    },
    async nextSaleNumber(db) {
      const { rows } = await db.query("SELECT to_char(now(), 'FMYYYYMMDD') || lpad((count(*) + 1)::text, 4, '0') AS n FROM pos_sales WHERE created_at::date = current_date");
      return `POS-${rows[0].n}`;
    },
  };
}
