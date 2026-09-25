/** In-memory repos for pricing/coupons/orders/addresses service tests — real services, fake data layer. */
export function createFakeCommerce() {
  const db = {
    branches: { "store-01": { id: "store-01", otp_required: true }, "store-02": { id: "store-02", otp_required: false } },
    branchOrder: ["store-01", "store-02"],
    products: [
      { id: "soap", name: "Soap", category_id: "grocery", brand_id: "b1", price: 5, sale_price: null, tax_percent: 5, moq: 1, max_qty: 10, status: "active", prescription_required: false, seller_id: "novatech" },
      { id: "cough-syrup", name: "Cough Syrup", category_id: "health", brand_id: "b1", price: 8, sale_price: null, tax_percent: 0, moq: 1, max_qty: 5, status: "active", prescription_required: true, seller_id: "novatech" },
    ],
    variants: {},
    inventory: new Map(), // key `${branch}|${product}|${variant||''}` -> { id, on_hand, reserved }
    batches: { "cough-syrup": { "store-01": [{ id: "b-old", qty: 3, expiry_date: "2026-10-01", is_legacy_opening: false }, { id: "b-new", qty: 10, expiry_date: "2026-12-01", is_legacy_opening: false }] } },
    coupons: {
      NOVA10: { code: "NOVA10", label: "10% off", type: "percent", value: 10, max_discount: 15, min_order: 20, scope_type: "all", status: "active", starts_at: null, ends_at: null, first_order_only: false, usage_limit: null, per_customer_limit: 1, times_used: 0 },
      FIRST15: { code: "FIRST15", label: "First order", type: "percent", value: 15, max_discount: 25, min_order: 0, scope_type: "all", status: "active", starts_at: null, ends_at: null, first_order_only: true, usage_limit: null, per_customer_limit: 1, times_used: 0 },
      GONE: { code: "GONE", label: "Used up", type: "fixed", value: 5, min_order: 0, scope_type: "all", status: "active", starts_at: null, ends_at: null, first_order_only: false, usage_limit: 1, per_customer_limit: 5, times_used: 1 },
    },
    redemptions: [],
    addresses: [],
    orders: [], orderItems: new Map(), orderHistory: new Map(),
    suppliers: [{ id: "sup-1", name: "MedSource", contact: "Anita", phone: "+1 555 0410", email: "a@x.com", terms: "Net 30" }],
    purchaseOrders: [], poLines: new Map(),
    posSales: [], posSaleItems: new Map(),
    seq: 0,
  };
  const key = (b, p, v) => `${b}|${p}|${v || ""}`;
  const rowFor = (b, p, v) => db.inventory.get(key(b, p, v));

  const products = {
    async getById(_d, id) { return db.products.find((p) => p.id === id) ?? null; },
    async listVariants(_d, id) { return db.variants[id] ?? []; },
    async branchIds() { return db.branchOrder; },
  };
  const catalog = {
    async categoryTreeIds(_d, id) { return [id]; },
    async getBranch(_d, id) { return db.branches[id] ?? null; },
  };
  const inventory = {
    async lockRow(_d, { branchId, productId, variantId = null }) {
      const k = key(branchId, productId, variantId);
      if (!db.inventory.has(k)) db.inventory.set(k, { id: k, branch_id: branchId, product_id: productId, variant_id: variantId, on_hand: 0, reserved: 0, reorder_level: 10 });
      return db.inventory.get(k);
    },
    async availableQty(_d, { branchId, productId, variantId = null }) {
      const r = rowFor(branchId, productId, variantId);
      return r ? r.on_hand - r.reserved : 0;
    },
    async reserve(_d, rowId, qty) { db.inventory.get(rowId).reserved += qty; },
    async release(_d, rowId, qty) { const r = db.inventory.get(rowId); r.reserved = Math.max(r.reserved - qty, 0); },
    async deduct(_d, rowId, qty) { const r = db.inventory.get(rowId); r.on_hand = Math.max(r.on_hand - qty, 0); r.reserved = Math.max(r.reserved - qty, 0); },
    async isBatchTracked(_d, productId) { return !!db.batches[productId]; },
    async consumeFefo(_d, { branchId, productId, qty }) {
      if (!db.batches[productId]) return;
      let remaining = qty;
      for (const b of (db.batches[productId][branchId] ?? []).filter((x) => x.qty > 0).sort((a, z) => (a.is_legacy_opening ? 1 : 0) - (z.is_legacy_opening ? 1 : 0) || new Date(a.expiry_date ?? "9999") - new Date(z.expiry_date ?? "9999"))) {
        if (remaining <= 0) break;
        const take = Math.min(b.qty, remaining);
        if (take > 0) { b.qty -= take; remaining -= take; }
      }
    },
    async increase(_d, rowId, qty) { db.inventory.get(rowId).on_hand += qty; },
    async receiveBatch(_d, { branchId, productId, batchNo, expiryDate, purchaseCost, qty }) {
      const list = (db.batches[productId] ??= {})[branchId] ??= [];
      const existing = list.find((b) => b.batch_no === batchNo);
      if (existing) existing.qty += qty; else list.push({ id: `batch-${++db.seq}`, batch_no: batchNo, expiry_date: expiryDate, qty, purchase_cost: purchaseCost, is_legacy_opening: false });
    },
    async recordMovement(_d, m) {
      const row = { id: `mv-${++db.seq}`, branch_id: m.branchId, product_id: m.productId, variant_id: m.variantId ?? null, delta: m.delta, prev_qty: m.prevQty, new_qty: m.newQty, reason: m.reason, batch_no: m.batchNo ?? null, ref_type: m.refType, ref_id: m.refId ?? null, at: new Date() };
      (db.movements ??= []).push(row);
      return row;
    },
    async listMovements(_d, { productId, branchId } = {}) { return (db.movements ?? []).filter((m) => (!productId || m.product_id === productId) && (!branchId || m.branch_id === branchId)); },
    async lowStock(_d, { branchId } = {}) {
      return [...db.inventory.values()].filter((r) => r.on_hand <= (r.reorder_level ?? 10) && (!branchId || r.branch_id === branchId));
    },
    async lockBatchesFefo(_d, { branchId, productId }) {
      return (db.batches[productId]?.[branchId] ?? []).filter((b) => b.qty > 0).sort((a, b) => (a.is_legacy_opening ? 1 : 0) - (b.is_legacy_opening ? 1 : 0) || new Date(a.expiry_date ?? "9999") - new Date(b.expiry_date ?? "9999"));
    },
    async deductBatch(_d, id, qty) {
      for (const branch of Object.values(db.batches)) for (const list of Object.values(branch)) { const b = list.find((x) => x.id === id); if (b) b.qty -= qty; }
    },
  };
  const coupons = {
    async getActive(_d, code) { const c = db.coupons[code.toUpperCase()]; return c && c.status === "active" ? c : null; },
    async lockByCode(_d, code) { return db.coupons[code.toUpperCase()] ?? null; },
    async redemptionCount(_d, code, userId) { return db.redemptions.filter((r) => r.code === code.toUpperCase() && r.userId === userId).length; },
    async recordRedemption(_d, code, userId, orderId) { db.redemptions.push({ code: code.toUpperCase(), userId, orderId }); db.coupons[code.toUpperCase()].times_used++; },
  };
  const addresses = {
    async get(_d, userId, id) { return db.addresses.find((a) => a.id === id && a.user_id === userId) ?? null; },
    async list(_d, userId) { return db.addresses.filter((a) => a.user_id === userId); },
    async clearDefault(_d, userId) { db.addresses.forEach((a) => { if (a.user_id === userId) a.is_default = false; }); },
    async insert(_d, userId, a) { const row = { id: `addr-${++db.seq}`, user_id: userId, label: a.label, name: a.name, phone: a.phone, line1: a.line1, line2: a.line2, city: a.city, zip: a.zip, province_id: a.provinceId, district_id: a.districtId, municipality_id: a.municipalityId, ward: a.ward, instructions: a.instructions, is_default: !!a.isDefault }; db.addresses.push(row); return row; },
    async update(_d, userId, id, a) { const row = db.addresses.find((x) => x.id === id && x.user_id === userId); if (!row) return null; Object.assign(row, { label: a.label, name: a.name, phone: a.phone, line1: a.line1, is_default: !!a.isDefault }); return row; },
    async setDefault(_d, userId, id) { const row = db.addresses.find((x) => x.id === id && x.user_id === userId); row.is_default = true; return row; },
    async remove(_d, userId, id) { const i = db.addresses.findIndex((x) => x.id === id && x.user_id === userId); if (i < 0) return false; db.addresses.splice(i, 1); return true; },
  };
  const orders = {
    async nextNumber() { return `PN-${1000 + ++db.seq}`; },
    async countForUser(_d, userId) { return db.orders.filter((o) => o.user_id === userId).length; },
    async insert(_d, o) {
      const row = { id: `ord-${++db.seq}`, number: o.number, user_id: o.userId, branch_id: o.branchId, status: "placed", payment_method: o.paymentMethod,
        payment_status: "pending", address_id: o.addressId, address: o.address, delivery_option_id: o.deliveryOptionId, delivery_fee: o.deliveryFee, slot: o.slot,
        subtotal: o.subtotal, discount: o.discount, tax: o.tax, total: o.total, coupon_code: o.couponCode, notes: o.notes, instructions: o.instructions,
        otp: o.otp, otp_required: o.otpRequired, partner: null, eta: o.eta, delivered_at: null, cancelled_at: null, cancel_reason: null };
      db.orders.push(row); db.orderItems.set(row.id, []); db.orderHistory.set(row.id, []);
      return row;
    },
    async insertItems(_d, orderId, items) { db.orderItems.set(orderId, items.map((l) => ({ order_id: orderId, product_id: l.productId, variant_id: l.variantId, seller_id: l.sellerId, name: l.name, unit_price: l.unitPrice, qty: l.qty, line_total: l.lineTotal }))); },
    async addHistory(_d, orderId, status, note = null) { db.orderHistory.get(orderId).push({ status, note, at: new Date() }); },
    async getById(_d, id) { return db.orders.find((o) => o.id === id) ?? null; },
    async items(_d, orderId) { return db.orderItems.get(orderId) ?? []; },
    async itemsForOrders(_d, ids) { const m = new Map(); for (const id of ids) m.set(id, db.orderItems.get(id) ?? []); return m; },
    async history(_d, orderId) { return db.orderHistory.get(orderId) ?? []; },
    async listMine(_d, userId) { return db.orders.filter((o) => o.user_id === userId); },
    async listAll(_d, { status } = {}) { return status ? db.orders.filter((o) => o.status === status) : db.orders; },
    async updateStatus(_d, id, status, patch = {}) {
      const row = db.orders.find((o) => o.id === id);
      Object.assign(row, { status, ...(patch.deliveredAt !== undefined ? { delivered_at: patch.deliveredAt } : {}), ...(patch.cancelledAt !== undefined ? { cancelled_at: patch.cancelledAt } : {}), ...(patch.cancelReason !== undefined ? { cancel_reason: patch.cancelReason } : {}), ...(patch.partner !== undefined ? { partner: patch.partner } : {}), ...(patch.otp !== undefined ? { otp: patch.otp } : {}), ...(patch.paymentStatus !== undefined ? { payment_status: patch.paymentStatus } : {}) });
      return row;
    },
  };
  const wishlist = {
    async has(_d, userId, productId) { return db._wish?.some((w) => w.userId === userId && w.productId === productId) ?? false; },
    async add(_d, userId, productId) { (db._wish ??= []).push({ userId, productId }); },
    async remove(_d, userId, productId) { db._wish = (db._wish ?? []).filter((w) => !(w.userId === userId && w.productId === productId)); },
    async list(_d, userId) { return (db._wish ?? []).filter((w) => w.userId === userId).map((w) => w.productId); },
  };

  const purchasing = {
    async listSuppliers() { return db.suppliers; },
    async getSupplier(_d, id) { return db.suppliers.find((s) => s.id === id) ?? null; },
    async listPurchaseOrders(_d, { status } = {}) { return status ? db.purchaseOrders.filter((p) => p.status === status) : db.purchaseOrders; },
    async getPurchaseOrder(_d, id) { return db.purchaseOrders.find((p) => p.id === id) ?? null; },
    async poLines(_d, poId) { return db.poLines.get(poId) ?? []; },
    async linesForPOs(_d, ids) { const m = new Map(); for (const id of ids) m.set(id, db.poLines.get(id) ?? []); return m; },
    async nextPONumber() { return `PO-${1000 + ++db.seq}`; },
    async insertPurchaseOrder(_d, po) {
      const row = { id: `po-${++db.seq}`, number: po.number, supplier_id: po.supplierId, branch_id: po.branchId, status: "ordered", invoice_number: po.invoiceNumber, created_at: new Date(), received_at: null };
      db.purchaseOrders.push(row); db.poLines.set(row.id, []); return row;
    },
    async insertPOLine(_d, poId, l) { db.poLines.get(poId).push({ product_id: l.productId, qty: l.qty, purchase_price: l.purchasePrice, batch_no: l.batchNo, expiry_date: l.expiryDate }); },
    async deletePOLines(_d, poId) { db.poLines.set(poId, []); },
    async markReceived(_d, id) { const po = db.purchaseOrders.find((p) => p.id === id); if (po.status !== "ordered") return null; po.status = "received"; po.received_at = new Date(); return po; },
    async nextSaleNumber() { return `POS-${1000 + ++db.seq}`; },
    async insertPosSale(_d, s) { const row = { id: `sale-${++db.seq}`, ...s, created_at: new Date() }; db.posSales.push(row); db.posSaleItems.set(row.id, []); return row; },
    async insertPosSaleItem(_d, saleId, it) { db.posSaleItems.get(saleId).push(it); },
  };
  return { db, key, repos: { products, catalog, inventory, coupons, addresses, orders, wishlist, purchasing } };
}

export const customer = { id: "u-cust", name: "Cust", roles: ["customer"], permissions: [] };
export const staffOrders = { id: "u-staff", name: "Staff", roles: ["warehouse"], permissions: ["orders:update_status", "orders:read_all", "orders:cancel"] };
