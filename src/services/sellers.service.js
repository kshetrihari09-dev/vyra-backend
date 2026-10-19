import { toSellerDto } from "../models/sellers.model.js";
import { badRequest, conflict, forbidden, notFound } from "../utils/errors.js";
import { settingsView } from "../domain/sellerSettings.js";

const can = (actor, perm) => !!actor?.permissions?.includes(perm);

export function createSellersService({ pool, withTx, repos, encryption, audit }) {
  const repo = repos.sellers;

  async function requireOwnOrStaff(actor, sellerId) {
    if (can(actor, "sellers:read_all") || can(actor, "payouts:read_all")) return;
    if (actor.sellerId === sellerId) return;
    throw notFound("SELLER_NOT_FOUND", "Seller not found");
  }

  return {
    async list(actor, { status, q, page = 1, pageSize = 20 } = {}) {
      if (!can(actor, "sellers:read_all")) throw forbidden();
      const { rows, total } = await repo.list(pool, { status, q, limit: pageSize, offset: (page - 1) * pageSize });
      return { sellers: rows.map(toSellerDto), total, page, pageSize };
    },

    async get(actor, id) {
      await requireOwnOrStaff(actor, id);
      const row = await repo.getById(pool, id);
      if (!row) throw notFound("SELLER_NOT_FOUND", "Seller not found");
      return toSellerDto(row);
    },

    /** For the "shop I own" case — used right after login/onboarding to hydrate the seller dashboard. */
    async getMine(actor) {
      if (!actor.sellerId) return null;
      const row = await repo.getById(pool, actor.sellerId);
      if (!row) return null;
      return { ...toSellerDto(row), settings: settingsView(row) }; // the owner's own endpoint, so their saved settings come with it
    },

    async getSettings(actor, id) {
      if (actor.sellerId !== id && !can(actor, "sellers:read_all")) throw notFound("SELLER_NOT_FOUND", "Seller not found");
      const row = await repo.getById(pool, id);
      if (!row) throw notFound("SELLER_NOT_FOUND", "Seller not found");
      return settingsView(row);
    },

    /** Only the shop's own owner can change its settings (staff use the status / approval flows instead). */
    async updateSettings(actor, id, body, ctx) {
      if (actor.sellerId !== id || !can(actor, "seller:manage_own")) throw notFound("SELLER_NOT_FOUND", "Seller not found");
      return withTx(async (db) => {
        const row = await repo.getById(db, id, { forUpdate: true });
        if (!row) throw notFound("SELLER_NOT_FOUND", "Seller not found");
        if (row.status !== "active") throw conflict("SELLER_NOT_ACTIVE", "Your shop must be active to change its settings");
        const { name, description, email, ...rest } = body;
        const updated = await repo.updateSettings(db, id, { name, description, contactEmail: email, settings: { ...rest, email } });
        if (updated.owner_user_id) await repo.setOwnerNotifyPrefs(db, updated.owner_user_id, { email: body.notifications.email, sms: body.notifications.sms });
        await audit.log({ actor, action: "seller.settings_updated", entityType: "seller", entityId: id, newValue: { name, sections: Object.keys(rest) } }, ctx, db);
        return settingsView(updated);
      });
    },

    /** Direct status changes outside the application flow — e.g. suspending/reinstating an already-approved
        shop, or the simple "pending" seed sellers with no application behind them at all. */
    async setStatus(actor, id, status, ctx) {
      if (!can(actor, "sellers:approve")) throw forbidden();
      return withTx(async (db) => {
        const before = await repo.getById(db, id, { forUpdate: true });
        if (!before) throw notFound("SELLER_NOT_FOUND", "Seller not found");
        if (before.first_party) throw badRequest("FIRST_PARTY_LOCKED", "The first-party (Vaspoor Center) seller can't be suspended");
        const updated = await repo.updateStatus(db, id, status);
        await audit.log({ actor, action: "seller.status_changed", entityType: "seller", entityId: id, oldValue: { status: before.status }, newValue: { status } }, ctx, db);
        return toSellerDto(updated);
      });
    },

    async setPayoutMethodLabel(actor, id, label, ctx) {
      if (actor.sellerId !== id && !can(actor, "sellers:read_all")) throw forbidden();
      await repo.updatePayoutMethodLabel(pool, id, label);
      await audit.log({ actor, action: "seller.payout_method_updated", entityType: "seller", entityId: id, newValue: { label } }, ctx, null);
    },

    /** Decision D3: delivered orders' net-of-commission total, minus anything already requested/paid. */
    async availableBalance(actor, id) {
      await requireOwnOrStaff(actor, id);
      return repo.availableBalance(pool, id);
    },

    /**
     * The one place a seller's real bank/wallet number is ever decrypted for a *seller* record (as opposed to
     * a still-pending application — see sellerApplications.service#getSettlement). Ops needs this to actually
     * wire a payout; nowhere else calls it.
     */
    async getSettlement(actor, id) {
      if (!can(actor, "payouts:approve") && !can(actor, "sellers:approve")) throw forbidden();
      const row = await repo.getById(pool, id);
      if (!row) throw notFound("SELLER_NOT_FOUND", "Seller not found");
      // Settlement details live on the approved application, not the seller row itself.
      const apps = await repos.sellerApplications.listMine(pool, row.owner_user_id);
      const approved = apps.find((a) => a.seller_id === id && a.status === "approved");
      if (!approved) return { accountNumber: null, walletNumber: null };
      return {
        accountNumber: encryption.decrypt(approved.settlement_account_number_enc),
        walletNumber: encryption.decrypt(approved.settlement_wallet_number_enc),
      };
    },
  };
}
