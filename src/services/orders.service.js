import { toOrderDto } from "../models/commerce.model.js";
import { noRealtime } from "./realtime.service.js";
import { badRequest, conflict, forbidden, notFound } from "../utils/errors.js";

import { FINAL, OTP_VISIBLE_STATUSES, STAFF_STAGES, assertPaymentCleared, assertTransition, canCancelFrom } from "../domain/orderRules.js";

const can = (actor, perm) => !!actor?.permissions?.includes(perm);

export function createOrdersService({ pool, withTx, repos, pricing, audit, prescriptions, payments, codes, notifications = { emit: async () => null }, realtime = noRealtime }) {
  const { orders: repo, addresses, catalog } = repos;

  /** The handover code is shown to the order's owner only — not to riders, dispatch, sellers or other staff — and only
   *  while the order is in the delivery phase (assigned / out for delivery). It is recomputed here on every read;
   *  nothing is stored (see utils/deliveryCode.js). */
  const otpFor = (row, actor) => (row.user_id === actor?.id && row.otp_required && row.otp_nonce && OTP_VISIBLE_STATUSES.includes(row.status)
    ? codes.codeFor(row.id, row.otp_nonce) : undefined);

  /** The caller's shop, if they are an ACTIVE shop owner. Which shop is decided by the database, never by the client. */
  async function shopOf(db, actor) {
    if (!can(actor, "seller:manage_own")) return null;
    const seller = await repos.sellers.getByOwner(db, actor.id);
    return seller && seller.status === "active" ? seller : null;
  }

  /** Staff (orders:read_all) and the buyer see the whole order. A shop owner who isn't the buyer sees only their own
   *  lines, plus whether that is the whole basket (a shared basket's status is coordinated by Vyra, not by one shop). */
  function viewFor(row, items, actor, shop) {
    if (row.user_id === actor?.id || can(actor, "orders:read_all") || !shop) return { items };
    const own = items.filter((i) => i.seller_id === shop.id);
    return { items: own, sellerView: { soleSeller: own.length > 0 && own.length === items.length } };
  }

  async function hydrate(db, row, actor, shop) {
    const [items, history] = await Promise.all([repo.items(db, row.id), repo.history(db, row.id)]);
    // Sequential on purpose: `db` may be a single transaction client, and pg warns (soon errors) when more than two queries queue on it.
    const active = await repo.activeDeliveries(db, [row.id]);
    return toOrderDto(row, { ...viewFor(row, items, actor, shop), history, otp: otpFor(row, actor), active: active.get(row.id) ?? null });
  }

  /** Throws "not found" (never "forbidden" — no existence leak) unless the caller is the buyer, staff, or a shop with a line in it. */
  async function assertReadable(db, row, actor, shop) {
    if (!row) throw notFound("ORDER_NOT_FOUND", "Order not found");
    if (row.user_id === actor?.id || can(actor, "orders:read_all")) return;
    if (shop && (await repo.items(db, row.id)).some((i) => i.seller_id === shop.id)) return;
    throw notFound("ORDER_NOT_FOUND", "Order not found");
  }

  /** May this caller drive fulfilment (confirm / prepare / pack / cancel) on this order? Staff with the permission, or the
   *  shop that is the order's ONLY seller. Anyone else just gets "not found". */
  async function assertCanFulfil(db, row, actor, staffPerm) {
    if (can(actor, staffPerm)) return;
    const shop = await shopOf(db, actor);
    const items = shop ? await repo.items(db, row.id) : [];
    if (shop && items.length > 0 && items.every((i) => i.seller_id === shop.id)) return;
    if (!shop && !can(actor, "seller:manage_own")) throw forbidden();
    throw notFound("ORDER_NOT_FOUND", "Order not found");
  }

  return {
    async list(actor, { status } = {}) {
      const shop = await shopOf(pool, actor);
      let rows;
      if (can(actor, "orders:read_all")) rows = await repo.listAll(pool, { status });
      else {
        // Own purchases, plus (for a shop owner) every order that contains one of their products.
        const mine = await repo.listMine(pool, actor.id);
        const theirs = shop ? await repo.listForSeller(pool, shop.id) : [];
        const seen = new Set();
        rows = [...mine, ...theirs].filter((r) => (seen.has(r.id) ? false : seen.add(r.id)) && (!status || r.status === status))
          .sort((a, b) => new Date(b.placed_at) - new Date(a.placed_at));
      }
      const ids = rows.map((r) => r.id);
      const [itemsByOrder, activeByOrder] = await Promise.all([repo.itemsForOrders(pool, ids), repo.activeDeliveries(pool, ids)]);
      return Promise.all(rows.map(async (r) => toOrderDto(r, {
        ...viewFor(r, itemsByOrder.get(r.id) ?? [], actor, shop), history: await repo.history(pool, r.id), otp: otpFor(r, actor), active: activeByOrder.get(r.id) ?? null,
      })));
    },

    async get(actor, id) {
      const row = await repo.getById(pool, id);
      const shop = await shopOf(pool, actor);
      await assertReadable(pool, row, actor, shop);
      return hydrate(pool, row, actor, shop);
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
        const addressSnapshot = { label: address.label, name: address.name, phone: address.phone, line1: address.line1, line2: address.line2, city: address.city, zip: address.zip, provinceId: address.province_id, districtId: address.district_id, municipalityId: address.municipality_id, ward: address.ward, instructions: address.instructions, lat: address.lat ?? null, lng: address.lng ?? null };
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
        // The order stays "placed" until the shop confirms it (POST /orders/:id/status {status:"confirmed"}); the customer
        // sees it straight away. Payment is a separate axis: a prepaid order starts "pending" and is only "paid" once the
        // provider confirms — placing it never marks it paid.
        if (totals.couponResult?.ok) await repos.coupons.recordRedemption(db, totals.couponResult.code, actor.id, order.id);

        await audit.log({ actor, action: "order.placed", entityType: "order", entityId: order.id, newValue: { number, total: totals.total, items: lines.length } }, ctx, db);
        await notifications.emit(db, { userId: actor.id, type: "order.placed", data: { orderId: order.id, number, total: totals.total } });
        return hydrate(db, order, actor);
      });
    },

    /** Staff — or the shop that is the order's only seller — move an order forward one stage at a time up to "packed"
     *  (where reserved stock actually leaves — FEFO for batch-tracked items). Assigned / out-for-delivery / delivered
     *  belong to the delivery module. Every rule here is enforced server-side; the UI only mirrors it. */
    async advance(actor, id, body, ctx) {
      if (!can(actor, "orders:update_status") && !can(actor, "seller:manage_own")) throw forbidden();
      if (!STAFF_STAGES.includes(body.status)) {
        throw conflict("USE_DELIVERY_FLOW", "From here an order moves through delivery: assign a rider, then the rider picks it up and completes it with the customer's code.");
      }
      return withTx(async (db) => {
        const row = await repo.getById(db, id, { forUpdate: true });
        if (!row) throw notFound("ORDER_NOT_FOUND", "Order not found");
        await assertCanFulfil(db, row, actor, "orders:update_status");
        assertTransition(row.status, body.status);
        // Payment gate: a prepaid order can be confirmed and prepared while payment is pending, but it can't be packed
        // (and therefore can't be dispatched) until the payment is confirmed. COD is never gated.
        if (body.status === "packed") assertPaymentCleared(row);
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
        await realtime.publish(db, id);
        if (body.status === "confirmed") await notifications.emit(db, { userId: row.user_id, type: "order.confirmed", data: { orderId: id, number: row.number } });
        if (body.status === "packed") await notifications.emit(db, { userId: row.user_id, type: "order.packed", data: { orderId: id, number: row.number } });
        return hydrate(db, updated, actor, await shopOf(db, actor));
      });
    },

    /** Only before "packed" — after that, stock has already left and a cancellation needs the return flow instead.
     *  The buyer, staff with orders:cancel, or the shop that is the order's only seller may cancel. Releasing the stock
     *  reservation and settling the payment happen in the same transaction as the status change, and the row lock makes a
     *  second (concurrent) cancel fail on the status check — so stock is never released twice. */
    async cancel(actor, id, body, ctx) {
      return withTx(async (db) => {
        const row = await repo.getById(db, id, { forUpdate: true });
        if (!row) throw notFound("ORDER_NOT_FOUND", "Order not found");
        const owner = row.user_id === actor.id;
        if (!owner) await assertCanFulfil(db, row, actor, "orders:cancel");
        if (["cancelled", "returned", "delivered"].includes(row.status)) throw conflict("ALREADY_FINAL", "This order can no longer be cancelled.");
        if (!canCancelFrom(row.status)) throw conflict("TOO_LATE_TO_CANCEL", "This order is already being fulfilled and can no longer be cancelled.");
        assertTransition(row.status, "cancelled");

        for (const it of await repo.items(db, id)) {
          const invRow = await repos.inventory.lockRow(db, { branchId: row.branch_id, productId: it.product_id, variantId: it.variant_id });
          await repos.inventory.release(db, invRow.id, it.qty);
          await repos.inventory.recordMovement(db, { branchId: row.branch_id, productId: it.product_id, variantId: it.variant_id, delta: 0,
            prevQty: invRow.on_hand, newQty: invRow.on_hand, reason: `Order ${row.number} cancelled — reservation released`, refType: "order_cancelled", refId: row.id, actorId: actor.id });
        }
        // Money: an unpaid payment is closed so it can never be paid for a dead order; a captured one queues a refund.
        const settled = await payments.settleOnCancel(db, row, actor, ctx);
        const updated = await repo.updateStatus(db, id, "cancelled", { cancelledAt: new Date(), cancelReason: body?.reason ?? null, ...settled });
        await repo.addHistory(db, id, "cancelled", body?.reason ?? null);
        await audit.log({ actor, action: "order.cancelled", entityType: "order", entityId: id, oldValue: { status: row.status }, newValue: { status: "cancelled", reason: body?.reason ?? null } }, ctx, db);
        await realtime.publish(db, id);
        await notifications.emit(db, { userId: row.user_id, type: "order.cancelled", data: { orderId: id, number: row.number, reason: owner ? null : body?.reason ?? null } });
        return hydrate(db, updated, actor, await shopOf(db, actor));
      });
    },
  };
}
