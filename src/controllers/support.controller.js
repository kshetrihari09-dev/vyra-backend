import { ok, clientContext } from "../utils/http.js";

/**
 * Server-Sent Events for a support thread. Same contract as the order-tracking stream: any authorisation failure is an
 * ordinary JSON error BEFORE the stream opens; a heartbeat keeps proxies from closing it; it ends at the access token's
 * lifetime so a revoked or expired session can't keep listening (the client reconnects with a fresh token).
 */
function openStream({ req, res, config, realtime, first, conversationId, userId, snapshot }) {
  res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders?.();
  const write = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  write("support", first);

  let unsubscribe = null; let closed = false;
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

  return realtime.subscribe({ orderId: conversationId, userId, initial: false, snapshot, send: write, end: close })
    .then((off) => { unsubscribe = off; if (closed) off(); })
    .catch((err) => {
      if (err?.code === "TOO_MANY_STREAMS") { write("error", { code: "TOO_MANY_STREAMS", message: "Too many open chat windows. Close one and try again." }); close(); return; }
      close();
      throw err;
    });
}

export function createSupportController({ services, config }) {
  const { support, supportRealtime } = services;
  const me = (req) => req.auth.user;
  return {
    // ----------------------------------------------------------------- customer
    async contact(req, res) { ok(res, await support.contact(req.auth?.user ?? null, req.valid.query)); },
    async chatGet(req, res) { ok(res, await support.chat(me(req))); },
    async chatHistory(req, res) { ok(res, await support.chatHistory(me(req), req.valid.query)); },
    async chatSend(req, res) {
      const out = await support.sendChat(me(req), req.valid.body);
      ok(res, out, out.duplicate ? 200 : 201);
    },
    async chatRead(req, res) { ok(res, await support.markChatRead(me(req))); },
    async form(req, res) { ok(res, await support.submitForm(me(req), req.valid.body), 201); },
    async chatStream(req, res) {
      const user = me(req);
      let cursor = req.valid.query.after;
      const first = await support.chatSnapshot(user, cursor);
      if (!first.conversation) { res.status(404).json({ success: false, code: "CHAT_NOT_STARTED", message: "No conversation yet" }); return; }
      cursor = first.cursor;
      await openStream({
        req, res, config, realtime: supportRealtime, first, conversationId: first.conversation.id, userId: user.id,
        snapshot: async () => { const snap = await support.chatSnapshot(user, cursor); cursor = snap.cursor; return snap; },
      });
    },

    // ----------------------------------------------------------------- pharmacist
    async availabilityGet(req, res) { ok(res, await support.getAvailability(me(req))); },
    async availabilitySet(req, res) { ok(res, await support.setAvailability(me(req), req.valid.body.available)); },
    async inboxList(req, res) { ok(res, await support.inbox(me(req), req.valid.query)); },
    async inboxGet(req, res) { ok(res, await support.inboxConversation(me(req), req.valid.params.id)); },
    async inboxMessages(req, res) { ok(res, await support.inboxMessages(me(req), req.valid.params.id, req.valid.query)); },
    async inboxReply(req, res) {
      const out = await support.reply(me(req), req.valid.params.id, req.valid.body);
      ok(res, out, out.duplicate ? 200 : 201);
    },
    async inboxRead(req, res) { ok(res, await support.markInboxRead(me(req), req.valid.params.id)); },
    async inboxResolve(req, res) { ok(res, await support.setStatus(me(req), req.valid.params.id, "resolved", clientContext(req))); },
    async inboxReopen(req, res) { ok(res, await support.setStatus(me(req), req.valid.params.id, "open", clientContext(req))); },
    async inboxStream(req, res) {
      const user = me(req); const id = req.valid.params.id;
      let cursor = req.valid.query.after;
      const first = await support.staffSnapshot(user, id, cursor);
      cursor = first.cursor;
      await openStream({
        req, res, config, realtime: supportRealtime, first, conversationId: id, userId: user.id,
        snapshot: async () => { const snap = await support.staffSnapshot(user, id, cursor); cursor = snap.cursor; return snap; },
      });
    },
  };
}
