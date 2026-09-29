import { clientContext, ok } from "../utils/http.js";

export function createSellerPayoutsController({ services }) {
  const { sellerPayouts } = services;
  return {
    async request(req, res) { ok(res, { payout: await sellerPayouts.request(req.auth.user, req.valid.params.sellerId, req.valid.body, clientContext(req)) }, 201); },
    async listForSeller(req, res) { ok(res, { payouts: await sellerPayouts.listForSeller(req.auth.user, req.valid.params.sellerId) }); },
    async listAll(req, res) { ok(res, { payouts: await sellerPayouts.listAll(req.auth.user, req.valid.query) }); },
    async decide(req, res) { ok(res, { payout: await sellerPayouts.decide(req.auth.user, req.valid.params.id, req.valid.body, clientContext(req)) }); },
  };
}
