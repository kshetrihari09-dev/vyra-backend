import { clientContext, ok } from "../utils/http.js";
import { tooManyRequests } from "../utils/errors.js";
import { DELIVERY_DISTANCE, DELIVERY_OPTIONS } from "../config/delivery.js";
import { tierTable } from "../domain/deliveryPricing.js";

export function createDeliveryController({ services, config }) {
  const { delivery, realtime } = services;
  const actor = (req) => req.auth.user;
  return {
    /** The published fee schedule: option base fees + the distance tiers. Static and public (the checkout page shows it anyway). */
    async pricing(_req, res) {
      res.set("Cache-Control", "public, max-age=300");
      ok(res, {
        options: Object.values(DELIVERY_OPTIONS).map((o) => ({ id: o.id, label: o.label, fee: o.fee, freeAbove: o.freeAbove ?? null })),
        distance: { tiers: tierTable(), maxKm: DELIVERY_DISTANCE.maxKm, unknownDistanceFee: DELIVERY_DISTANCE.unknownDistanceFee },
      });
    },

    // rider
    async me(req, res) { ok(res, { rider: await delivery.me(actor(req)) }); },
    async setAvailability(req, res) { ok(res, { rider: await delivery.setAvailability(actor(req), req.valid.body.available) }); },
    async listMine(req, res) { ok(res, { deliveries: await delivery.listMine(actor(req), req.valid.query) }); },
    async listClaimable(req, res) { ok(res, { orders: await delivery.listClaimable(actor(req)) }); },
    async claim(req, res) { ok(res, { delivery: await delivery.claim(actor(req), req.valid.params.orderId, clientContext(req)) }, 201); },
    async accept(req, res) { ok(res, { delivery: await delivery.accept(actor(req), req.valid.params.id, clientContext(req)) }); },
    async decline(req, res) { ok(res, { delivery: await delivery.decline(actor(req), req.valid.params.id, req.valid.body, clientContext(req)) }); },
    async arrived(req, res) { ok(res, { delivery: await delivery.arrived(actor(req), req.valid.params.id) }); },
    async start(req, res) { ok(res, { delivery: await delivery.start(actor(req), req.valid.params.id) }); },
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
    async setBranchLocation(req, res) { ok(res, { branch: await delivery.setBranchLocation(actor(req), req.valid.params.branchId, req.valid.body, clientContext(req)) }); },
    async resetOtp(req, res) { ok(res, await delivery.resetOtp(actor(req), req.valid.params.orderId, clientContext(req))); },

    // a shop asks riders to collect a packed order
    async requestDelivery(req, res) { ok(res, await delivery.requestDelivery(actor(req), req.valid.params.orderId, clientContext(req))); },

    // tracking (owner, dispatch, the order's shop, or read-only staff)
    async tracking(req, res) { ok(res, { tracking: await delivery.tracking(actor(req), req.valid.params.id) }); },

    /**
     * Live tracking as Server-Sent Events. Authorised exactly like the plain GET (a caller who may not see the order gets an
     * ordinary JSON 404 BEFORE any stream opens). The stream ends when the order reaches a final state, or at the access-token's
     * lifetime — whichever is first — so a revoked or expired session can't keep listening; the client reconnects with a fresh token.
     */
    async trackingStream(req, res) {
      const user = actor(req);
      const orderId = req.valid.params.id;
      const first = await delivery.tracking(user, orderId);

      res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.flushHeaders?.();
      const write = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
      write("tracking", first);
      if (first.final) { res.end(); return; }

      let unsubscribe = null;
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat); clearTimeout(lifetime);
        unsubscribe?.();
        if (!res.writableEnded) res.end();
      };
      const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 20_000);
      const lifetime = setTimeout(() => { write("expired", {}); close(); }, config.auth.accessTtlSeconds * 1000);
      heartbeat.unref?.(); lifetime.unref?.();
      req.on("close", close);

      try {
        unsubscribe = await realtime.subscribe({
          orderId, userId: user.id, initial: false,
          snapshot: () => delivery.tracking(user, orderId),
          send: write, end: close,
        });
        if (closed) unsubscribe();
      } catch (err) {
        if (err?.code === "TOO_MANY_STREAMS") { write("error", { code: "TOO_MANY_STREAMS", message: "Too many open tracking screens. Close one and try again." }); close(); return; }
        close();
        throw err;
      }
    },
  };
}
