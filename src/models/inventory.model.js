import { toNumber } from "../utils/text.js";

export const toMovementDto = (r) => ({
  id: r.id, branchId: r.branch_id, productId: r.product_id, variantId: r.variant_id, delta: r.delta, prevQty: r.prev_qty, newQty: r.new_qty,
  reason: r.reason, batch: r.batch_no, refType: r.ref_type, refId: r.ref_id, at: r.at,
});

export const toSupplierDto = (r) => ({ id: r.id, name: r.name, contact: r.contact, phone: r.phone, email: r.email, terms: r.terms });

export const toPODto = (r, lines = []) => ({
  id: r.id, number: r.number, supplierId: r.supplier_id, storeId: r.branch_id, status: r.status, invoiceNumber: r.invoice_number,
  createdAt: r.created_at, receivedAt: r.received_at,
  lines: lines.map((l) => ({ productId: l.product_id, qty: l.qty, purchasePrice: toNumber(l.purchase_price), batch: l.batch_no, expiry: l.expiry_date })),
});

export const toPosSaleDto = (r, items = []) => ({
  id: r.id, number: r.number, storeId: r.branch_id, customerName: r.customer_name, paymentMethod: r.payment_method,
  totals: { subtotal: toNumber(r.subtotal), tax: toNumber(r.tax), total: toNumber(r.total) }, placedAt: r.created_at,
  items: items.map((it) => ({ productId: it.product_id, variantId: it.variant_id, name: it.name, unitPrice: toNumber(it.unit_price), qty: it.qty, batch: it.batch_no })),
});
