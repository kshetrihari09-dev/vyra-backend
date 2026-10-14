import { clientContext, ok } from "../utils/http.js";

export function createSellersController({ services }) {
  const { sellers } = services;
  return {
    async list(req, res) { ok(res, await sellers.list(req.auth.user, req.valid.query)); },
    async get(req, res) { ok(res, { seller: await sellers.get(req.auth.user, req.valid.params.id) }); },
    async getMine(req, res) { ok(res, { seller: await sellers.getMine(req.auth.user) }); },
    async getSettings(req, res) { ok(res, { settings: await sellers.getSettings(req.auth.user, req.valid.params.id) }); },
    async updateSettings(req, res) { ok(res, { settings: await sellers.updateSettings(req.auth.user, req.valid.params.id, req.valid.body, clientContext(req)) }); },
    async setStatus(req, res) { ok(res, { seller: await sellers.setStatus(req.auth.user, req.valid.params.id, req.valid.body.status, clientContext(req)) }); },
    async setPayoutMethodLabel(req, res) {
      await sellers.setPayoutMethodLabel(req.auth.user, req.valid.params.id, req.valid.body.label, clientContext(req));
      ok(res, { ok: true });
    },
    async getBalance(req, res) { ok(res, { availableBalance: await sellers.availableBalance(req.auth.user, req.valid.params.id) }); },
    async getSettlement(req, res) { ok(res, await sellers.getSettlement(req.auth.user, req.valid.params.id)); },
  };
}
