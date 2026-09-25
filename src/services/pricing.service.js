import { deliveryFeeFor } from "../config/delivery.js";
import { round2 } from "../utils/text.js";

/**
 * The one place cart totals get computed — used by both the cart preview (GET-like pricing, no side effects) and
 * order creation (same math, plus row locks so two simultaneous orders can't oversell the same stock).
 * Tax is computed on undiscounted line totals, matching the prototype (decision D6 — flagged, not silently changed).
 */
export function createPricingService({ repos, coupons }) {
  const { products } = repos;

  async function loadLine(db, item, { branchId, manage, lock }) {
    const product = lock ? await products.getById(db, item.productId, { forUpdate: true }) : await products.getById(db, item.productId);
    if (!product) return { issue: { productId: item.productId, variantId: item.variantId ?? null, type: "not_found", message: "This item is no longer available." } };
    if (product.status !== "active" && !manage) return { issue: { productId: item.productId, variantId: item.variantId ?? null, type: "unavailable", message: `${product.name} is no longer available.` } };

    let variant = null;
    if (item.variantId) {
      variant = (await products.listVariants(db, item.productId)).find((v) => v.id === item.variantId);
      if (!variant) return { issue: { productId: item.productId, variantId: item.variantId, type: "not_found", message: "This item is no longer available." } };
    }

    const unitPrice = Number(variant ? (variant.sale_price ?? variant.price) : (product.sale_price ?? product.price));
    const name = variant ? `${product.name} — ${variant.label}` : product.name;
    const line = {
      productId: product.id, variantId: item.variantId ?? null, categoryId: product.category_id, brandId: product.brand_id, sellerId: product.seller_id,
      name, unitPrice, taxPercent: Number(product.tax_percent), qty: item.qty, lineTotal: round2(unitPrice * item.qty),
      prescriptionRequired: product.prescription_required, moq: product.moq, maxQty: product.max_qty,
    };

    const issues = [];
    if (line.qty > line.maxQty) issues.push({ productId: line.productId, variantId: line.variantId, type: "limit", message: `Limit ${line.maxQty} per order for ${product.name}.`, max: line.maxQty });
    if (line.qty < line.moq) issues.push({ productId: line.productId, variantId: line.variantId, type: "moq", message: `Minimum ${line.moq} for ${product.name}.` });

    let rowId = null, available;
    if (lock) {
      const row = await repos.inventory.lockRow(db, { branchId, productId: product.id, variantId: item.variantId ?? null });
      rowId = row.id;
      available = row.on_hand - row.reserved;
    } else {
      available = await repos.inventory.availableQty(db, { branchId, productId: product.id, variantId: item.variantId ?? null });
    }
    if (available <= 0) issues.push({ productId: line.productId, variantId: line.variantId, type: "out_of_stock", message: `${product.name} is out of stock at this store.` });
    else if (line.qty > available) issues.push({ productId: line.productId, variantId: line.variantId, type: "insufficient_stock", message: `Only ${available} of ${product.name} left — reduce the quantity.`, max: available });

    return { line, issues, rowId };
  }

  return {
    /** @returns {{ lines, issues, rowIds }} — rowIds is only populated when lock is true (order creation). */
    async priceLines(db, items, { branchId, manage = false, lock = false }) {
      const lines = [], issues = [], rowIds = [];
      for (const item of items) {
        const r = await loadLine(db, item, { branchId, manage, lock });
        if (r.issue) { issues.push(r.issue); continue; }
        lines.push(r.line);
        issues.push(...r.issues);
        if (r.rowId) rowIds.push({ rowId: r.rowId, productId: r.line.productId, variantId: r.line.variantId, qty: r.line.qty });
      }
      return { lines, issues, rowIds };
    },

    async computeTotals(db, lines, { couponCode = null, deliveryOptionId = "standard", userId = null, isFirstOrder = false, lock = false } = {}) {
      const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
      const couponResult = couponCode ? await coupons.evaluate(db, couponCode, lines, { userId, isFirstOrder, lock }) : null;
      const discount = couponResult?.ok ? couponResult.discount : 0;
      const taxable = Math.max(subtotal - discount, 0);
      const tax = round2(lines.reduce((s, l) => s + l.lineTotal * (l.taxPercent / 100), 0));
      const deliveryFee = deliveryFeeFor(deliveryOptionId, taxable);
      const total = round2(Math.max(taxable + tax + deliveryFee, 0));
      return { subtotal, discount, tax, deliveryFee, total, couponResult };
    },
  };
}
