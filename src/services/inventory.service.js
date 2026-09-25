import { toMovementDto } from "../models/inventory.model.js";
import { badRequest, conflict, notFound } from "../utils/errors.js";

/** Manual stock changes: adjustments, branch-to-branch transfers, the movements ledger, and the low-stock report.
    Everything here needs inventory:adjust except the read-only reports. */
export function createInventoryService({ pool, withTx, repos, audit }) {
  const { inventory, products } = repos;

  return {
    async adjust(actor, body, ctx) {
      return withTx(async (db) => {
        const product = await products.getById(db, body.productId);
        if (!product) throw badRequest("PRODUCT_NOT_FOUND", "Product not found");
        const row = await inventory.lockRow(db, { branchId: body.branch, productId: body.productId, variantId: body.variantId ?? null });
        const newQty = Math.max(row.on_hand + body.delta, 0);
        const applied = newQty - row.on_hand;
        if (applied > 0) await inventory.increase(db, row.id, applied);
        else if (applied < 0) await inventory.deduct(db, row.id, -applied);
        const movement = await inventory.recordMovement(db, {
          branchId: body.branch, productId: body.productId, variantId: body.variantId ?? null, delta: applied, prevQty: row.on_hand, newQty,
          reason: body.reason, refType: "adjustment", actorId: actor.id,
        });
        await audit.log({ actor, action: "inventory.adjusted", entityType: "product", entityId: body.productId, newValue: { branch: body.branch, delta: applied, reason: body.reason, newQty } }, ctx, db);
        return toMovementDto(movement);
      });
    },

    async transfer(actor, body, ctx) {
      return withTx(async (db) => {
        const product = await products.getById(db, body.productId);
        if (!product) throw badRequest("PRODUCT_NOT_FOUND", "Product not found");
        // Lock both rows in a fixed order (lexical by branch id) regardless of transfer direction, so two
        // simultaneous transfers between the same two branches can never deadlock each other.
        const [firstBranch, secondBranch] = [body.fromBranch, body.toBranch].sort();
        const firstRow = await inventory.lockRow(db, { branchId: firstBranch, productId: body.productId, variantId: body.variantId ?? null });
        const secondRow = await inventory.lockRow(db, { branchId: secondBranch, productId: body.productId, variantId: body.variantId ?? null });
        const fromRow = body.fromBranch === firstBranch ? firstRow : secondRow;
        const toRow = body.fromBranch === firstBranch ? secondRow : firstRow;

        if (fromRow.on_hand - fromRow.reserved < body.qty) throw conflict("INSUFFICIENT_STOCK", `Only ${fromRow.on_hand - fromRow.reserved} available at ${body.fromBranch} to transfer.`);
        await inventory.deduct(db, fromRow.id, body.qty);
        await inventory.increase(db, toRow.id, body.qty);
        await inventory.consumeFefo(db, { branchId: body.fromBranch, productId: body.productId, qty: body.qty });

        const out = await inventory.recordMovement(db, { branchId: body.fromBranch, productId: body.productId, variantId: body.variantId ?? null, delta: -body.qty, prevQty: fromRow.on_hand, newQty: fromRow.on_hand - body.qty, reason: `Transfer to ${body.toBranch}`, refType: "transfer", actorId: actor.id });
        await inventory.recordMovement(db, { branchId: body.toBranch, productId: body.productId, variantId: body.variantId ?? null, delta: body.qty, prevQty: toRow.on_hand, newQty: toRow.on_hand + body.qty, reason: `Transfer from ${body.fromBranch}`, refType: "transfer", actorId: actor.id, refId: out.id });
        await audit.log({ actor, action: "inventory.transferred", entityType: "product", entityId: body.productId, newValue: { from: body.fromBranch, to: body.toBranch, qty: body.qty } }, ctx, db);
        return { ok: true };
      });
    },

    async movements(query) { return (await inventory.listMovements(pool, { productId: query.productId, branchId: query.branch, limit: query.limit })).map(toMovementDto); },

    /** on_hand at/below its reorder level, per branch+variant — the admin low-stock report. */
    async lowStock(query) {
      const rows = await inventory.lowStock(pool, { branchId: query.branch });
      return rows.map((r) => ({ branchId: r.branch_id, productId: r.product_id, variantId: r.variant_id, onHand: r.on_hand, reserved: r.reserved, reorderLevel: r.reorder_level }));
    },
  };
}
