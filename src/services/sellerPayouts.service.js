import { toPayoutDto } from "../models/sellerPayouts.model.js";
import { badRequest, conflict, forbidden, notFound } from "../utils/errors.js";

const can = (actor, perm) => !!actor?.permissions?.includes(perm);

export function createSellerPayoutsService({ pool, withTx, repos, audit, notifications = { emit: async () => null } }) {
  const repo = repos.sellerPayouts;

  async function notifyPayoutOwner(db, payout, type, extra) {
    const seller = await repos.sellers.getById(db, payout.seller_id);
    if (seller?.owner_user_id) await notifications.emit(db, { userId: seller.owner_user_id, type, data: { amount: payout.amount, ...extra } });
  }

  return {
    /** The seller requests up to their available (delivered, net-of-commission, not-yet-requested) balance. */
    async request(actor, sellerId, body, ctx) {
      if (actor.sellerId !== sellerId) throw forbidden();
      return withTx(async (db) => {
        const seller = await repos.sellers.getById(db, sellerId, { forUpdate: true });
        if (!seller) throw notFound("SELLER_NOT_FOUND", "Seller not found");
        if (seller.status !== "active") throw conflict("SELLER_NOT_ACTIVE", "Your shop must be active to request a payout");
        const available = await repos.sellers.availableBalance(db, sellerId);
        const amount = body.amount != null ? Number(body.amount) : available;
        if (amount <= 0) throw badRequest("NOTHING_AVAILABLE", "There's no available balance to pay out");
        if (amount > available) throw badRequest("EXCEEDS_AVAILABLE", `Amount must be between Rs. 0 and Rs. ${available.toFixed(2)}`);
        const row = await repo.insert(db, { sellerId, amount, methodLabel: seller.payout_method_label, note: body.note, requestedBy: actor.id });
        await audit.log({ actor, action: "seller_payout.requested", entityType: "seller_payout", entityId: row.id, newValue: { sellerId, amount } }, ctx, db);
        return toPayoutDto(row);
      });
    },

    async listForSeller(actor, sellerId) {
      if (actor.sellerId !== sellerId && !can(actor, "payouts:read_all")) throw forbidden();
      return (await repo.listForSeller(pool, sellerId)).map(toPayoutDto);
    },

    async listAll(actor, { status } = {}) {
      if (!can(actor, "payouts:read_all")) throw forbidden();
      return (await repo.listAll(pool, { status })).map(toPayoutDto);
    },

    /** approve marks it paid immediately — there's no external disbursement step modeled here yet (no
        payment-provider payout API is wired up); ops still does the actual transfer by hand using the
        decrypted settlement details from sellers.service#getSettlement. reject just records why. */
    async decide(actor, id, body, ctx) {
      if (!can(actor, "payouts:approve")) throw forbidden();
      return withTx(async (db) => {
        const payout = await repo.getById(db, id, { forUpdate: true });
        if (!payout) throw notFound("PAYOUT_NOT_FOUND", "Payout not found");
        if (payout.status !== "requested") throw conflict("ALREADY_DECIDED", `This payout was already "${payout.status}"`);
        if (body.decision === "reject") {
          const updated = await repo.decide(db, id, { status: "rejected", decidedBy: actor.id, decidedAt: new Date() });
          await audit.log({ actor, action: "seller_payout.rejected", entityType: "seller_payout", entityId: id, newValue: { note: body.note } }, ctx, db);
          await notifyPayoutOwner(db, payout, "seller_payout.rejected", { note: body.note });
          return toPayoutDto(updated);
        }
        const updated = await repo.decide(db, id, { status: "paid", decidedBy: actor.id, decidedAt: new Date(), paidAt: new Date() });
        await audit.log({ actor, action: "seller_payout.paid", entityType: "seller_payout", entityId: id, newValue: { amount: payout.amount } }, ctx, db);
        await notifyPayoutOwner(db, payout, "seller_payout.paid", {});
        return toPayoutDto(updated);
      });
    },
  };
}
