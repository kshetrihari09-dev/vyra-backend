import { createHash } from "node:crypto";
import { toPODto, toPosSaleDto, toSupplierDto } from "../models/inventory.model.js";
import { badRequest, conflict, forbidden, notFound } from "../utils/errors.js";
import { MAX_CASHIER_DISCOUNT_PERCENT, POS_PAYMENT_METHODS } from "../config/pos.js";
import { priceSale, settle, toCents } from "../domain/posTotals.js";

const can = (actor, perm) => !!actor?.permissions?.includes(perm);

/** The same product twice in one request is one line (summed), and lines are ordered by (product, variant) — see the lock-order note in posSale. */
function mergeItems(items) {
  const map = new Map();
  for (const it of items) {
    const k = `${it.productId}\u0000${it.variantId ?? ""}`;
    const cur = map.get(k);
    if (cur) cur.qty += it.qty; else map.set(k, { productId: it.productId, variantId: it.variantId ?? null, qty: it.qty, batch: it.batch ?? null });
  }
  return [...map.values()].sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : (a.variantId ?? "") < (b.variantId ?? "") ? -1 : (a.variantId ?? "") > (b.variantId ?? "") ? 1 : 0));
}

/** What the sale IS (not how it was typed): same content → same hash, so an honest retry matches and a different sale under a reused key is caught. */
function hashRequest(b) {
  const canon = { branch: b.branch, items: b.items.map((i) => [i.productId, i.variantId ?? null, i.qty]), method: b.paymentMethod, discount: b.discount ? [b.discount.type, Number(b.discount.value)] : null, received: b.amountReceived ?? null, customer: b.customerName ?? null };
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

/** Suppliers, purchase orders (create → receive), and POS sales. All need inventory:adjust (PO/POS are how stock enters or leaves outside the order flow). */
export function createPurchasingService({ pool, withTx, repos, audit }) {
  const { purchasing, products, inventory } = repos;

  return {
    async listSuppliers() { return (await purchasing.listSuppliers(pool)).map(toSupplierDto); },

    async listPurchaseOrders({ status } = {}) {
      const rows = await purchasing.listPurchaseOrders(pool, { status });
      const lines = await purchasing.linesForPOs(pool, rows.map((r) => r.id));
      return rows.map((r) => toPODto(r, lines.get(r.id) ?? []));
    },

    async createPurchaseOrder(actor, body, ctx) {
      return withTx(async (db) => {
        if (!(await purchasing.getSupplier(db, body.supplierId))) throw badRequest("SUPPLIER_NOT_FOUND", "Supplier not found");
        for (const l of body.lines) if (!(await products.getById(db, l.productId))) throw badRequest("PRODUCT_NOT_FOUND", `Unknown product "${l.productId}"`);
        const number = await purchasing.nextPONumber(db);
        const po = await purchasing.insertPurchaseOrder(db, { number, supplierId: body.supplierId, branchId: body.branch, invoiceNumber: body.invoiceNumber, createdBy: actor.id });
        for (const l of body.lines) await purchasing.insertPOLine(db, po.id, { productId: l.productId, qty: l.qty, purchasePrice: l.purchasePrice, batchNo: null, expiryDate: null });
        await audit.log({ actor, action: "purchase_order.created", entityType: "purchase_order", entityId: po.id, newValue: { number, supplierId: body.supplierId, lines: body.lines.length } }, ctx, db);
        return toPODto(po, await purchasing.poLines(db, po.id));
      });
    },

    /** Receiving increases real stock: new (or topped-up) batches, on_hand up, a movement recorded per line. */
    async receivePurchaseOrder(actor, id, body, ctx) {
      return withTx(async (db) => {
        const po = await purchasing.getPurchaseOrder(db, id, { forUpdate: true });
        if (!po) throw notFound("PO_NOT_FOUND", "Purchase order not found");
        if (po.status !== "ordered") throw conflict("ALREADY_RECEIVED", `This purchase order is already "${po.status}".`);

        for (const line of body.lines) {
          const row = await inventory.lockRow(db, { branchId: po.branch_id, productId: line.productId, variantId: null });
          await inventory.increase(db, row.id, line.qty);
          await inventory.receiveBatch(db, { branchId: po.branch_id, productId: line.productId, batchNo: line.batch, expiryDate: line.expiry, purchaseCost: line.purchasePrice, qty: line.qty });
          await inventory.recordMovement(db, { branchId: po.branch_id, productId: line.productId, variantId: null, delta: line.qty, prevQty: row.on_hand, newQty: row.on_hand + line.qty, reason: `Goods received · ${po.number}`, batchNo: line.batch, refType: "receiving", refId: po.id, actorId: actor.id });
        }
        // The received lines are the record of truth (they carry the actual batch/expiry); replace the ordered lines with them.
        await purchasing.deletePOLines(db, id);
        for (const l of body.lines) await purchasing.insertPOLine(db, id, { productId: l.productId, qty: l.qty, purchasePrice: l.purchasePrice, batchNo: l.batch, expiryDate: l.expiry });
        const updated = await purchasing.markReceived(db, id);
        await audit.log({ actor, action: "purchase_order.received", entityType: "purchase_order", entityId: id, newValue: { lines: body.lines.length } }, ctx, db);
        return toPODto(updated, await purchasing.poLines(db, id));
      });
    },

    /**
     * A POS sale is complete the instant it's rung up — no reservation, stock leaves immediately.
     *
     * The whole thing is ONE transaction: stock deduction, batches, sale, items, movements and the audit entry all commit together or not at all.
     * The browser only says WHAT is sold (product, variant, qty), the discount it wants, and how it was paid; every price, tax, total and the
     * change due is computed here. Safe to send twice: the same `idempotencyKey` always yields the same single sale (see below).
     */
    async posSale(actor, body, ctx) {
      if (!POS_PAYMENT_METHODS.includes(body.paymentMethod)) throw badRequest("INVALID_PAYMENT_METHOD", "That payment method isn't available at the till.");
      const key = body.idempotencyKey || null;
      const merged = mergeItems(body.items);
      const requestHash = hashRequest({ ...body, items: merged });

      const replay = async (db, prior) => {
        // Same key, different sale → a client bug (or an attack on someone else's key space): refuse rather than hand back the wrong sale.
        if (prior.request_hash && prior.request_hash !== requestHash) throw conflict("IDEMPOTENCY_KEY_REUSED", "This request id was already used for a different sale.");
        return { ...toPosSaleDto(prior, await purchasing.saleItems(db, prior.id)), replayed: true };
      };

      const attempt = () => withTx(async (db) => {
        if (key) {
          // Two requests with the same key queue here; the second wakes up AFTER the first committed, finds its sale and returns it.
          await purchasing.lockIdempotency(db, actor.id, key);
          const prior = await purchasing.getSale(db, { cashierId: actor.id, key });
          if (prior) return replay(db, prior);
        }

        const branch = await purchasing.getBranch(db, body.branch);
        if (!branch || branch.is_active === false) throw badRequest("BRANCH_NOT_FOUND", "That store isn't available.");

        // PHASE 1 — read and price. No stock locks yet, so a bad discount, a stale price or short cash is refused before anything is touched.
        const lines = [];
        for (const item of merged) {
          const product = await products.getById(db, item.productId);
          if (!product || product.deleted_at) throw badRequest("PRODUCT_NOT_FOUND", `Unknown product "${item.productId}"`);
          if (product.status && product.status !== "active") throw conflict("PRODUCT_UNAVAILABLE", `${product.name} isn't available for sale.`);
          // A product with variants keeps its stock (and price) on the VARIANT rows — selling "the product" without saying which one is meaningless.
          const variants = await products.listVariants(db, item.productId);
          let variant = null;
          if (item.variantId) {
            variant = variants.find((v) => v.id === item.variantId);
            if (!variant) throw badRequest("PRODUCT_NOT_FOUND", "Unknown variant");
          } else if (variants.length) {
            throw badRequest("VARIANT_REQUIRED", `Choose a size/variant of ${product.name}.`);
          }
          const unitPrice = Number(variant ? (variant.sale_price ?? variant.price) : (product.sale_price ?? product.price));
          lines.push({ productId: item.productId, variantId: item.variantId ?? null, name: variant ? `${product.name} — ${variant.label}` : product.name, unitPrice, qty: item.qty, taxPercent: Number(product.tax_percent), batchNo: item.batch ?? null });
        }

        const priced = priceSale(lines, body.discount);
        if (priced.discount > 0 && priced.subtotal > 0 && (toCents(priced.discount) / toCents(priced.subtotal)) * 100 > MAX_CASHIER_DISCOUNT_PERCENT + 1e-9 && !can(actor, "catalog:price")) {
          throw forbidden("DISCOUNT_NOT_ALLOWED", `Discounts above ${MAX_CASHIER_DISCOUNT_PERCENT}% need a manager.`);
        }
        // The cashier's screen showed a total; if the server's differs (a price changed meanwhile) say so instead of charging something unseen.
        if (body.expectedTotal != null && toCents(body.expectedTotal) !== toCents(priced.total)) {
          throw conflict("PRICE_CHANGED", "Prices changed since this cart was built. Review the updated total.", { subtotal: priced.subtotal, discount: priced.discount, tax: priced.tax, total: priced.total });
        }
        const { received, change } = settle({ method: body.paymentMethod, total: priced.total, amountReceived: body.amountReceived });

        // PHASE 2 — stock. `merged` is sorted by (product, variant), so every concurrent sale takes its row locks in the same order: two tills
        // ringing up the same products in opposite order can never deadlock. Availability is re-checked UNDER the lock, so two sales racing for
        // the last units can't both win — the second sees what the first left and is refused.
        const pendingMovements = [];
        for (const [i, item] of merged.entries()) {
          const row = await inventory.lockRow(db, { branchId: body.branch, productId: item.productId, variantId: item.variantId ?? null });
          const available = Math.max(row.on_hand - row.reserved, 0);
          if (available < item.qty) {
            throw conflict("INSUFFICIENT_STOCK", `Only ${available} ${available === 1 ? "unit" : "units"} of ${lines[i].name} available.`, { productId: item.productId, variantId: item.variantId ?? null, available });
          }
          await inventory.deduct(db, row.id, item.qty);
          await inventory.consumeFefo(db, { branchId: body.branch, productId: item.productId, qty: item.qty });
          pendingMovements.push({ branchId: body.branch, productId: item.productId, variantId: item.variantId ?? null, delta: -item.qty, prevQty: row.on_hand, newQty: row.on_hand - item.qty, batchNo: item.batch ?? null });
        }

        const number = await purchasing.nextSaleNumber(db);
        const sale = await purchasing.insertPosSale(db, {
          number, branchId: body.branch, cashierId: actor.id, customerName: body.customerName, paymentMethod: body.paymentMethod,
          subtotal: priced.subtotal, discount: priced.discount, discountType: body.discount?.type ?? null, discountValue: body.discount ? Number(body.discount.value) : null,
          tax: priced.tax, total: priced.total, amountReceived: received, changeDue: change, idempotencyKey: key, requestHash,
        });
        let lineNo = 0;
        for (const [i, l] of lines.entries()) {
          await purchasing.insertPosSaleItem(db, sale.id, { ...l, lineNo: lineNo++, lineTotal: priced.lines[i].gross, discount: priced.lines[i].discount, tax: priced.lines[i].tax });
        }
        for (const m of pendingMovements) await inventory.recordMovement(db, { ...m, reason: `POS sale · ${number}`, refType: "pos_sale", refId: sale.id, actorId: actor.id });
        await audit.log({ actor, action: "pos_sale.completed", entityType: "pos_sale", entityId: sale.id, newValue: { number, total: priced.total, discount: priced.discount, items: lines.length, method: body.paymentMethod } }, ctx, db);

        const stored = await purchasing.getSale(db, { id: sale.id });
        return { ...toPosSaleDto(stored, await purchasing.saleItems(db, sale.id)), replayed: false };
      });

      try {
        return await attempt();
      } catch (err) {
        // Backstop: even if two identical requests somehow raced past the advisory lock, the unique index let exactly one commit.
        // The loser's whole transaction (stock included) was rolled back; hand it the winner's sale.
        if (key && err?.code === "23505" && err?.constraint === "pos_sales_idem_idx") {
          const prior = await purchasing.getSale(pool, { cashierId: actor.id, key });
          if (prior) return replay(pool, prior);
        }
        throw err;
      }
    },

    /** A cashier sees their own sales; anyone with reports:read (admin) sees all. */
    async getPosSale(actor, id) {
      const row = await purchasing.getSale(pool, { id });
      if (!row || (row.cashier_id !== actor.id && !can(actor, "reports:read"))) throw notFound("SALE_NOT_FOUND", "Sale not found");
      return toPosSaleDto(row, await purchasing.saleItems(pool, row.id));
    },
    /** Did a request with this key already produce a sale? Lets a till whose connection dropped find out safely instead of guessing. */
    async getPosSaleByKey(actor, key) {
      const row = await purchasing.getSale(pool, { cashierId: actor.id, key });
      if (!row) throw notFound("SALE_NOT_FOUND", "No sale was recorded for that request");
      return toPosSaleDto(row, await purchasing.saleItems(pool, row.id));
    },
    async listPosSales(actor, { branch, limit } = {}) {
      const rows = await purchasing.listSales(pool, { cashierId: can(actor, "reports:read") ? undefined : actor.id, branchId: branch, limit: limit ?? 30 });
      return rows.map((r) => toPosSaleDto(r, []));
    },
  };
}
