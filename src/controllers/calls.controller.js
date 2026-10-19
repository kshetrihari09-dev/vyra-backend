import { ok } from "../utils/http.js";

/**
 * Vaspoor Call HTTP + live stream. Like the order-tracking and support streams: any authorisation failure is an ordinary JSON error
 * BEFORE the stream opens, a heartbeat keeps proxies from closing it, and it ends at the access token's lifetime so a revoked
 * or expired session can't keep listening (the client reconnects with a fresh token and resumes from its cursor).
 */
export function createCallsController({ services, config }) {
  const { calls, callsRealtime } = services;
  const me = (req) => req.auth.user;

  function openStream(req, res, user, first, snapshot, onTick) {
    res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders?.();
    const write = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    write("calls", first);

    let unsubscribe = null; let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat); clearTimeout(lifetime);
      unsubscribe?.();
      if (!res.writableEnded) res.end();
    };
    const heartbeat = setInterval(() => { if (!res.writableEnded) { res.write(": ping\n\n"); onTick?.(); } }, 15_000);
    const lifetime = setTimeout(() => { write("expired", {}); close(); }, config.auth.accessTtlSeconds * 1000);
    heartbeat.unref?.(); lifetime.unref?.();
    req.on("close", close);

    return callsRealtime.subscribe({ orderId: `u:${user.id}`, userId: user.id, initial: false, snapshot, send: write, end: close })
      .then((off) => { unsubscribe = off; if (closed) off(); })
      .catch((err) => {
        if (err?.code === "TOO_MANY_STREAMS") { write("error", { code: "TOO_MANY_STREAMS", message: "Vaspoor Call is open in too many tabs. Close one and try again." }); close(); return; }
        close();
        throw err;
      });
  }

  return {
    async ice(req, res) { ok(res, calls.iceServers(me(req))); },
    async shopStatus(req, res) { ok(res, await calls.shopStatus(me(req), req.valid.params.sellerId)); },

    async start(req, res) { ok(res, await calls.start(me(req), req.valid.body), 201); },
    async accept(req, res) { ok(res, await calls.accept(me(req), req.valid.params.id)); },
    async decline(req, res) { ok(res, await calls.decline(me(req), req.valid.params.id)); },
    async end(req, res) { ok(res, await calls.end(me(req), req.valid.params.id, req.valid.body)); },
    async connected(req, res) { ok(res, await calls.connected(me(req), req.valid.params.id)); },
    async ping(req, res) { ok(res, await calls.ping(me(req), req.valid.params.id)); },
    async get(req, res) { ok(res, await calls.get(me(req), req.valid.params.id)); },
    async signal(req, res) { ok(res, await calls.signal(me(req), req.valid.params.id, req.valid.body), 201); },

    async stream(req, res) {
      const user = me(req);
      let cursor = req.valid.query.after;
      const first = await calls.snapshot(user, cursor);
      cursor = first.cursor;
      await openStream(req, res, user, first, async () => { const snap = await calls.snapshot(user, cursor); cursor = snap.cursor; return snap; },
        () => { if (first.isShop) calls.touchPresence(user).catch(() => {}); }); // keep a shop's availability alive from the open connection
    },

    // shop console
    async presenceSet(req, res) { ok(res, await calls.setPresence(me(req), req.valid.body)); },
    async presenceClear(req, res) { ok(res, await calls.clearPresence(me(req))); },
    async shopHistory(req, res) { ok(res, await calls.shopHistory(me(req), req.valid.query)); },
  };
}
