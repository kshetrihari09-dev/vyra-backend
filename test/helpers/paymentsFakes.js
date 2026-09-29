/** In-memory repos for payments/prescriptions service tests — real services, fake data layer. */
export function createFakePayments({ orders = [] } = {}) {
  const db = {
    orders,
    payments: [],
    refunds: [],
    webhookEvents: [],
    prescriptions: [],
    prescriptionItems: [], // { prescription_id, product_id }
    orderPrescriptions: [], // { order_id, prescription_id }
    seq: 0,
  };

  const payments = {
    async insert(_d, p) {
      const row = { id: `pay-${++db.seq}`, order_id: p.orderId, provider: p.provider, method: p.method, status: p.status ?? "pending", currency: p.currency ?? "npr", amount: p.amount, refunded_amount: 0, provider_ref: null, instructions: p.instructions ?? null, failure_reason: null, raw_payload: null, authorized_at: null, captured_at: null, failed_at: null, created_at: new Date() };
      db.payments.push(row);
      return row;
    },
    async getById(_d, id) { return db.payments.find((p) => p.id === id) ?? null; },
    async getByProviderRef(_d, provider, providerRef) { return db.payments.find((p) => p.provider === provider && p.provider_ref === providerRef) ?? null; },
    async getActiveForOrder(_d, orderId) { return db.payments.filter((p) => p.order_id === orderId && ["pending", "authorized", "captured", "partially_refunded"].includes(p.status)).sort((a, b) => b.created_at - a.created_at)[0] ?? null; },
    async listForOrder(_d, orderId) { return db.payments.filter((p) => p.order_id === orderId); },
    async update(_d, id, patch) {
      const row = db.payments.find((p) => p.id === id);
      if (patch.status !== undefined) row.status = patch.status;
      if (patch.providerRef !== undefined) row.provider_ref = patch.providerRef;
      if (patch.failureReason !== undefined) row.failure_reason = patch.failureReason;
      if (patch.rawPayload !== undefined) row.raw_payload = patch.rawPayload;
      if (patch.authorizedAt !== undefined) row.authorized_at = patch.authorizedAt;
      if (patch.capturedAt !== undefined) row.captured_at = patch.capturedAt;
      if (patch.failedAt !== undefined) row.failed_at = patch.failedAt;
      if (patch.refundedAmount !== undefined) row.refunded_amount = patch.refundedAmount;
      return row;
    },
    async insertWebhookEvent(_d, { provider, eventId, paymentId, payload }) {
      if (db.webhookEvents.some((e) => e.provider === provider && e.event_id === eventId)) return null;
      const row = { provider, event_id: eventId, payment_id: paymentId, payload };
      db.webhookEvents.push(row);
      return row;
    },
    async insertRefund(_d, r) {
      const row = { id: `ref-${++db.seq}`, payment_id: r.paymentId, order_id: r.orderId, amount: r.amount, reason: r.reason, status: "pending", provider_ref: null, requested_by: r.requestedBy, decided_by: null, decided_at: null, decision_note: null, created_at: new Date() };
      db.refunds.push(row);
      return row;
    },
    async getRefundById(_d, id) { return db.refunds.find((r) => r.id === id) ?? null; },
    async listRefunds(_d, { status, orderId } = {}) { return db.refunds.filter((r) => (!status || r.status === status) && (!orderId || r.order_id === orderId)); },
    async updateRefund(_d, id, patch) {
      const row = db.refunds.find((r) => r.id === id);
      Object.assign(row, {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.providerRef !== undefined ? { provider_ref: patch.providerRef } : {}),
        ...(patch.decidedBy !== undefined ? { decided_by: patch.decidedBy } : {}),
        ...(patch.decidedAt !== undefined ? { decided_at: patch.decidedAt } : {}),
        ...(patch.decisionNote !== undefined ? { decision_note: patch.decisionNote } : {}),
      });
      return row;
    },
  };

  const prescriptions = {
    async insert(_d, p) {
      const row = { id: `rx-${++db.seq}`, user_id: p.userId, status: "pending", file_key: p.fileKey, file_name: p.fileName, mime_type: p.mimeType, size_bytes: p.sizeBytes, notes: null, rejection_reason: null, pharmacist_id: null, reviewed_at: null, created_at: new Date() };
      db.prescriptions.push(row);
      return row;
    },
    async insertItems(_d, prescriptionId, productIds) { for (const productId of new Set(productIds)) db.prescriptionItems.push({ prescription_id: prescriptionId, product_id: productId }); },
    async items(_d, prescriptionId) { return db.prescriptionItems.filter((i) => i.prescription_id === prescriptionId).map((i) => i.product_id); },
    async itemsFor(_d, ids) { const m = new Map(); for (const id of ids) m.set(id, db.prescriptionItems.filter((i) => i.prescription_id === id).map((i) => i.product_id)); return m; },
    async getById(_d, id) { return db.prescriptions.find((r) => r.id === id) ?? null; },
    async listMine(_d, userId) { return db.prescriptions.filter((r) => r.user_id === userId); },
    async listAll(_d, { status } = {}) { return status ? db.prescriptions.filter((r) => r.status === status) : db.prescriptions; },
    async approvedCovering(_d, userId, productIds) {
      return db.prescriptions.filter((r) => r.user_id === userId && r.status === "approved" && db.prescriptionItems.some((i) => i.prescription_id === r.id && productIds.includes(i.product_id)));
    },
    async review(_d, id, { status, notes, rejectionReason, pharmacistId }) {
      const row = db.prescriptions.find((r) => r.id === id);
      Object.assign(row, { status, notes, rejection_reason: rejectionReason, pharmacist_id: pharmacistId, reviewed_at: new Date() });
      return row;
    },
    async linkToOrder(_d, orderId, prescriptionIds) { for (const id of new Set(prescriptionIds)) db.orderPrescriptions.push({ order_id: orderId, prescription_id: id }); },
    async forOrder(_d, orderId) { return db.orderPrescriptions.filter((l) => l.order_id === orderId).map((l) => db.prescriptions.find((r) => r.id === l.prescription_id)); },
  };

  const productsRepo = {
    async prescriptionRequiredIds() { return db._rxRequiredIds ?? []; },
  };

  const ordersRepo = {
    async getById(_d, id) { return db.orders.find((o) => o.id === id) ?? null; },
    async updateStatus(_d, id, status, patch = {}) {
      const row = db.orders.find((o) => o.id === id);
      if (patch.paymentStatus !== undefined) row.payment_status = patch.paymentStatus;
      row.status = status;
      return row;
    },
  };

  /** In-memory object store standing in for storage.service — same shape (putObject/getObject). */
  const storage = {
    files: new Map(),
    async putObject(key, buffer) { storage.files.set(key, buffer); },
    async getObject(key) { return storage.files.get(key); },
    async deleteObject(key) { storage.files.delete(key); },
  };

  return { db, repos: { payments, prescriptions, products: productsRepo, orders: ordersRepo }, storage };
}

export const rxCustomer = { id: "u-cust", name: "Cust", roles: ["customer"], permissions: [] };
export const otherCustomer = { id: "u-cust-2", name: "Other", roles: ["customer"], permissions: [] };
export const pharmacist = { id: "u-pharm", name: "Dr. Rao", roles: ["pharmacist"], permissions: ["prescriptions:read_all", "prescriptions:review"] };
export const accountant = { id: "u-acct", name: "Accountant", roles: ["accountant"], permissions: ["orders:refund", "payments:manage"] };
export const support = { id: "u-support", name: "Support", roles: ["support"], permissions: ["orders:read_all", "orders:refund"] };
