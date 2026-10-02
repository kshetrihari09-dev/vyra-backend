import { clientContext, ok } from "../utils/http.js";

export function createPaymentsController({ services }) {
  const { payments } = services;
  return {
    async getForOrder(req, res) { ok(res, { payments: await payments.get(req.auth.user, req.valid.params.id) }); },
    /** Customer pays again for an existing, still-unpaid order — never creates a second order. */
    async retry(req, res) { ok(res, await payments.retry(req.auth.user, req.valid.params.id, clientContext(req))); },
    async confirmManual(req, res) { ok(res, await payments.confirmManual(req.auth.user, req.valid.params.id, clientContext(req))); },

    /** Public: no session, verified purely by the provider's signature. Always 200s a well-formed, verified
        request — including "duplicate"/"unmatched" outcomes — so a retried delivery doesn't look like a failure
        to the provider and trigger backoff/alerting on their side. */
    async webhook(req, res) {
      const result = await payments.handleWebhook(req.valid.params.provider, req.rawBody, req.headers, clientContext(req));
      ok(res, result);
    },

    async requestRefund(req, res) { ok(res, { refund: await payments.requestRefund(req.auth.user, req.valid.params.id, req.valid.body, clientContext(req)) }, 201); },
    async listRefunds(req, res) { ok(res, { refunds: await payments.listRefunds(req.auth.user, req.valid.query) }); },
    async decideRefund(req, res) { ok(res, { refund: await payments.decideRefund(req.auth.user, req.valid.params.id, req.valid.body, clientContext(req)) }); },
  };
}
