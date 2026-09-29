import { toOrderDto } from "../models/commerce.model.js";
import { badRequest, conflict, forbidden, notFound } from "../utils/errors.js";

/** Order lifecycle — must match the frontend's services/orderStatus.js ORDER_STAGES exactly. */
const STAGES = ["placed", "confirmed", "preparing", "packed", "assigned", "out_for_delivery", "delivered"];
const stageIndex = (s) => STAGES.indexOf(s);
/** The only stages this generic staff endpoint may set. From "packed" on, an order moves through the delivery
 *  module (assign → accept → pick up → deliver-with-code), which is what makes the handover code meaningful:
 *  before Phase 7 anyone holding orders:update_status could mark an order delivered without it. */
const STAFF_STAGES = ["confirmed", "preparing", "packed"];
const FINAL = ["delivered", "cancelled", "returned"];

const can = (actor, perm) => !!actor?.permissions?.includes(perm);

export function createOrdersService({ pool, withTx, repos, pricing, audit, prescriptions, payments, codes, notifications = { emit: async () => null } }) {
  const { orders: repo, addresses, catalog } = repos;

  /** The handover code is shown to the order's owner only — not to riders, dispatch or other staff — and only while
   *  the order is still live. It is recomputed here on every read; nothing is stored (see utils/deliveryCode.js). */
  const otpFor = (row, actor) => (row.user_id === actor?.id && row.otp_required && row.otp_nonce && !FINAL.includes(row.status)
    ? codes.codeFor(row.id, row.otp_nonce) : undefined);

  async function hydrate(db, row, actor) {
    const [items, history] = await Promise.all([repo.items(db, row.id), repo.history(db, row.id)]);
    return toOrderDto(row, { items, history, otp: otpFor(row, actor) });
  }

  async function assertReadable(row, actor) {
    if (!row) throw notFound("ORDER_NOT_FOUND", "Order not found");
    if (row.user_id !== actor?.id && !can(actor, "orders:read_all")) throw notFound("ORDER_NOT_FOUND", "Order not found");
  }

  return {
    async list(actor, { status } = {}) {
      const rows = can(actor, "orders:read_all") ? await repo.listAll(pool, { status }) : await repo.listMine(pool, actor.id);
      const itemsByOrder = await repo.itemsForOrders(pool, rows.map((r) => r.id));
      return Promise.all(rows.map(async (r) => toOrderDto(r, {
        items: itemsByOrder.get(r.id) ?? [], history: await repo.history(pool, r.id), otp: otpFor(r, actor),
      })));
    },

    async get(actor, id) {
      const row = await repo.getById(pool, id);
      await assertReadable(row, actor);
      return hydrate(pool, row, actor);
    },

    /** Reserve stock → price the order → create it, all in one transaction so a failed price/stock check leaves nothing reserved. */
    async create(actor, body, ctx) {
      return withTx(async (db) => {
        const address = await addresses.get(db, actor.id, body.addressId);
        if (!address) throw badRequest("ADDRESS_NOT_FOUND", "Choose a delivery address", [{ path: "body.addressId", message: "Choose a delivery address" }]);

        const branchId = body.branch ?? (await repos.products.branchIds(db))[0];
        const branch = await catalog.getBranch(db, branchId);
        if (!branch) throw badRequest("BRANCH_NOT_FOUND", "That store isn't available");

        const { lines, issues, rowIds } = await pricing.priceLines(db, body.items, { branchId, manage: false, lock: true });
        const blocking = issues.filter((i) => ["not_found", "unavailable", "limit", "moq", "out_of_stock", "insufficient_stock"].includes(i.type));
        if (blocking.length) throw conflict("CART_INVALID", blocking[0].message, blocking);

        // Decision D5 (now enforced — closes the Phase 3 known gap): every prescription-required line must be
        // covered by one of the customer's own *approved* prescriptions, or the order is refused outright.
        const rxProductIds = lines.filter((l) => l.prescriptionRequired).map((l) => l.productId);
        const coveringPrescriptionIds = await prescriptions.assertCoverage(db, actor.id, rxProductIds);

        const isFirstOrder = (await repo.countForUser(db, actor.id)) === 0;
        const totals = await pricing.computeTotals(db, lines, { couponCode: body.couponCode, deliveryOptionId: body.deliveryOptionId, userId: actor.id, isFirstOrder, lock: true });
        if (body.couponCode && totals.couponResult && !totals.couponResult.ok) throw badRequest("COUPON_INVALID", totals.couponResult.reason, [{ path: "body.couponCode", message: totals.couponResult.reason }]);

        for (const r of rowIds) await repos.inventory.reserve(db, r.rowId, r.qty);

        const number = await repo.nextNumber(db);
        const otpRequired = branch.otp_required;
        const addressSnapshot = { label: address.label, name: address.name, phone: address.phone, line1: address.line1, line2: address.line2, city: address.city, zip: address.zip, provinceId: address.province_id, districtId: address.district_id, municipalityId: address.municipality_id, ward: address.ward, instructions: address.instructions };
        const order = await repo.insert(db, {
          number, userId: actor.id, branchId, paymentMethod: body.paymentMethod, addressId: address.id, address: addressSnapshot,
          deliveryOptionId: body.deliveryOptionId, deliveryFee: totals.deliveryFee, slot: body.slot ?? null,
          subtotal: totals.subtotal, discount: totals.discount, tax: totals.tax, total: totals.total,
          couponCode: totals.couponResult?.ok ? totals.couponResult.code : null, notes: body.notes ?? null, instructions: body.instructions ?? null,
          otpNonce: otpRequired ? codes.newNonce() : null, otpRequired, eta: new Date(Date.now() + 35 * 60_000),
        });
        await repo.insertItems(db, order.id, lines);
        await repo.addHistory(db, order.id, "placed");
        if (coveringPrescriptionIds.length) await prescriptions.linkToOrder(db, order.id, coveringPrescriptionIds);
        await payments.createForOrder(db, order);
        // The prototype auto-confirms an order the moment it's placed (no manual "accept" step yet).
        const confirmed = await repo.updateStatus(db, order.id, "confirmed");
        await repo.addHistory(db, order.id, "confirmed");
        if (totals.couponResult?.ok) await repos.coupons.recordRedemption(db, totals.couponResult.code, actor.id, order.id);

        await audit.log({ actor, action: "order.placed", entityType: "order", entityId: order.id, newValue: { number, total: totals.total, items: lines.length } }, ctx, db);
        await notifications.emit(db, { userId: actor.id, type: "order.placed", data: { orderId: order.id, number, total: totals.total } });
        return hydrate(db, confirmed, actor);
      });
    },

    /** Staff move an order forward one stage at a time up to "packed" (where reserved stock actually leaves — FEFO for
     *  batch-tracked items). Assigned / out-for-delivery / delivered belong to the delivery module. */
    async advance(actor, id, body, ctx) {
      if (!can(actor, "orders:update_status")) throw forbidden();
      if (!STAFF_STAGES.includes(body.status)) {
        throw conflict("USE_DELIVERY_FLOW", "From here an order moves through delivery: assign a rider, then the rider picks it up and completes it with the customer's code.");
      }
      return withTx(async (db) => {
        const row = await repo.getById(db, id, { forUpdate: true });
        if (!row) throw notFound("ORDER_NOT_FOUND", "Order not found");
        if (stageIndex(row.status) < 0 || stageIndex(body.status) !== stageIndex(row.status) + 1) {
          throw conflict("INVALID_TRANSITION", `Order is "${row.status}" — it can only move to the next stage.`);
        }
        const patch = {};
        if (body.status === "packed") {
          for (const it of await repo.items(db, id)) {
            const invRow = await repos.inventory.lockRow(db, { branchId: row.branch_id, productId: it.product_id, variantId: it.variant_id });
            await repos.inventory.deduct(db, invRow.id, it.qty);
            await repos.inventory.recordMovement(db, { branchId: row.branch_id, productId: it.product_id, variantId: it.variant_id, delta: -it.qty,
              prevQty: invRow.on_hand, newQty: Math.max(invRow.on_hand - it.qty, 0), reason: `Order ${row.number} packed`, refType: "order_packed", refId: row.id, actorId: actor.id });
            if (await repos.inventory.isBatchTracked(db, it.product_id)) {
              let remaining = it.qty;
              for (const b of await repos.inventory.lockBatchesFefo(db, { branchId: row.branch_id, productId: it.product_id })) {
                if (remaining <= 0) break;
                const take = Math.min(b.qty, remaining);
                if (take > 0) { await repos.inventory.deductBatch(db, b.id, take); remaining -= take; }
              }
              // remaining > 0 here means the batch ledger under-counts on-hand for this product/branch — a data
              // issue to investigate, not a reason to block the order (on_hand is the number actually sold from).
            }
          }
        }
        const updated = await repo.updateStatus(db, id, body.status, patch);
        await repo.addHistory(db, id, body.status);
        await audit.log({ actor, action: "order.status_changed", entityType: "order", entityId: id, oldValue: { status: row.status }, newValue: { status: body.status } }, ctx, db);
        if (body.status === "packed") await notifications.emit(db, { userId: row.user_id, type: "order.packed", data: { orderId: id, number: row.number } });
        return hydrate(db, updated, actor);
      });
    },

    /** Only before "packed" — after that, stock has already left and a cancellation needs the return flow instead. */
    async cancel(actor, id, body, ctx) {
      return withTx(async (db) => {
        const row = await repo.getById(db, id, { forUpdate: true });
        if (!row) throw notFound("ORDER_NOT_FOUND", "Order not found");
        const owner = row.user_id === actor.id;
        if (!owner && !can(actor, "orders:cancel")) throw forbidden();
        if (["cancelled", "returned", "delivered"].includes(row.status)) throw conflict("ALREADY_FINAL", "This order can no longer be cancelled.");
        if (stageIndex(row.status) >= stageIndex("packed")) throw conflict("TOO_LATE_TO_CANCEL", "This order is already being fulfilled and can no longer be cancelled.");

        for (const it of await repo.items(db, id)) {
          const invRow = await repos.inventory.lockRow(db, { branchId: row.branch_id, productId: it.product_id, variantId: it.variant_id });
          await repos.inventory.release(db, invRow.id, it.qty);
          await repos.inventory.recordMovement(db, { branchId: row.branch_id, productId: it.product_id, variantId: it.variant_id, delta: 0,
            prevQty: invRow.on_hand, newQty: invRow.on_hand, reason: `Order ${row.number} cancelled — reservation released`, refType: "order_cancelled", refId: row.id, actorId: actor.id });
        }
        const updated = await repo.updateStatus(db, id, "cancelled", { cancelledAt: new Date(), cancelReason: body?.reason ?? null });
        await repo.addHistory(db, id, "cancelled", body?.reason ?? null);
        await audit.log({ actor, action: "order.cancelled", entityType: "order", entityId: id, oldValue: { status: row.status }, newValue: { status: "cancelled", reason: body?.reason ?? null } }, ctx, db);
        await notifications.emit(db, { userId: row.user_id, type: "order.cancelled", data: { orderId: id, number: row.number, reason: owner ? null : body?.reason ?? null } });
        return hydrate(db, updated, actor);
      });
    },
  };
}
