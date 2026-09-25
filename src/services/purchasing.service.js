import { toPODto, toPosSaleDto, toSupplierDto } from "../models/inventory.model.js";
import { badRequest, conflict, notFound } from "../utils/errors.js";
import { round2 } from "../utils/text.js";

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

    /** A POS sale is complete the instant it's rung up — no reservation, stock leaves immediately. */
    async posSale(actor, body, ctx) {
      return withTx(async (db) => {
        const lines = [];
        const pendingMovements = [];
        for (const item of body.items) {
          const product = await products.getById(db, item.productId);
          if (!product) throw badRequest("PRODUCT_NOT_FOUND", `Unknown product "${item.productId}"`);
          let variant = null;
          if (item.variantId) {
            variant = (await products.listVariants(db, item.productId)).find((v) => v.id === item.variantId);
            if (!variant) throw badRequest("PRODUCT_NOT_FOUND", "Unknown variant");
          }
          const row = await inventory.lockRow(db, { branchId: body.branch, productId: item.productId, variantId: item.variantId ?? null });
          const available = row.on_hand - row.reserved;
          if (available < item.qty) throw conflict("INSUFFICIENT_STOCK", `Only ${available} of ${product.name} left at this store.`);
          await inventory.deduct(db, row.id, item.qty);
          await inventory.consumeFefo(db, { branchId: body.branch, productId: item.productId, qty: item.qty });
          const unitPrice = Number(variant ? (variant.sale_price ?? variant.price) : (product.sale_price ?? product.price));
          const lineTotal = round2(unitPrice * item.qty);
          lines.push({ productId: item.productId, variantId: item.variantId ?? null, name: variant ? `${product.name} — ${variant.label}` : product.name, unitPrice, qty: item.qty, lineTotal, taxPercent: Number(product.tax_percent), batchNo: item.batch ?? null });
          pendingMovements.push({ branchId: body.branch, productId: item.productId, variantId: item.variantId ?? null, delta: -item.qty, prevQty: row.on_hand, newQty: row.on_hand - item.qty, batchNo: item.batch ?? null });
        }
        const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
        const tax = round2(lines.reduce((s, l) => s + l.lineTotal * (l.taxPercent / 100), 0));
        const total = round2(subtotal + tax);
        const number = await purchasing.nextSaleNumber(db);
        const sale = await purchasing.insertPosSale(db, { number, branchId: body.branch, cashierId: actor.id, customerName: body.customerName, paymentMethod: body.paymentMethod, subtotal, tax, total });
        for (const l of lines) await purchasing.insertPosSaleItem(db, sale.id, l);
        for (const m of pendingMovements) await inventory.recordMovement(db, { ...m, reason: `POS sale · ${number}`, refType: "pos_sale", refId: sale.id, actorId: actor.id });
        await audit.log({ actor, action: "pos_sale.completed", entityType: "pos_sale", entityId: sale.id, newValue: { number, total, items: lines.length } }, ctx, db);
        return toPosSaleDto(sale, lines.map((l) => ({ product_id: l.productId, variant_id: l.variantId, name: l.name, unit_price: l.unitPrice, qty: l.qty, batch_no: l.batchNo })));
      });
    },
  };
}
