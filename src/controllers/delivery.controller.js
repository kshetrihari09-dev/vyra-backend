import { clientContext, ok } from "../utils/http.js";

export function createDeliveryController({ services }) {
  const { delivery } = services;
  const actor = (req) => req.auth.user;
  return {
    // rider
    async me(req, res) { ok(res, { rider: await delivery.me(actor(req)) }); },
    async setAvailability(req, res) { ok(res, { rider: await delivery.setAvailability(actor(req), req.valid.body.available) }); },
    async listMine(req, res) { ok(res, { deliveries: await delivery.listMine(actor(req), req.valid.query) }); },
    async listClaimable(req, res) { ok(res, { orders: await delivery.listClaimable(actor(req)) }); },
    async claim(req, res) { ok(res, { delivery: await delivery.claim(actor(req), req.valid.params.orderId, clientContext(req)) }, 201); },
    async accept(req, res) { ok(res, { delivery: await delivery.accept(actor(req), req.valid.params.id, clientContext(req)) }); },
    async decline(req, res) { ok(res, { delivery: await delivery.decline(actor(req), req.valid.params.id, req.valid.body, clientContext(req)) }); },
    async pickup(req, res) { ok(res, { delivery: await delivery.pickup(actor(req), req.valid.params.id, clientContext(req)) }); },
    async location(req, res) { ok(res, await delivery.updateLocation(actor(req), req.valid.params.id, req.valid.body)); },
    async deliver(req, res) { ok(res, { delivery: await delivery.deliver(actor(req), req.valid.params.id, req.valid.body, clientContext(req)) }); },
    async fail(req, res) { ok(res, { delivery: await delivery.fail(actor(req), req.valid.params.id, req.valid.body, clientContext(req)) }); },

    // dispatch
    async listRiders(req, res) { ok(res, { riders: await delivery.listRiders(actor(req)) }); },
    async createRider(req, res) { ok(res, { rider: await delivery.createRider(actor(req), req.valid.body, clientContext(req)) }, 201); },
    async updateRider(req, res) { ok(res, { rider: await delivery.updateRider(actor(req), req.valid.params.id, req.valid.body, clientContext(req)) }); },
    async listActive(req, res) { ok(res, { deliveries: await delivery.listActive(actor(req)) }); },
    async assign(req, res) { ok(res, { delivery: await delivery.assign(actor(req), req.valid.params.orderId, req.valid.body, clientContext(req)) }, 201); },
    async reassign(req, res) { ok(res, { delivery: await delivery.reassign(actor(req), req.valid.params.id, req.valid.body, clientContext(req)) }); },
    async unassign(req, res) { ok(res, { delivery: await delivery.unassign(actor(req), req.valid.params.id, req.valid.body, clientContext(req)) }); },
    async resetOtp(req, res) { ok(res, await delivery.resetOtp(actor(req), req.valid.params.orderId, clientContext(req))); },

    // tracking (owner or staff)
    async tracking(req, res) { ok(res, { tracking: await delivery.tracking(actor(req), req.valid.params.id) }); },
  };
}
