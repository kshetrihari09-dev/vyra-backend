import pg from "pg";

/**
 * Realtime tracking hub (Server-Sent Events over Postgres LISTEN/NOTIFY).
 *
 *   mutation transaction ──pg_notify('vyra_tracking', {orderId})──▶ every API instance's LISTEN connection
 *        └─ delivered only on COMMIT, so a rolled-back change never reaches a screen
 *   hub ──▶ for each stream watching that order: re-run the viewer's own snapshot ──▶ SSE `tracking` event
 *
 * Why this shape:
 *   • No new dependency or message broker — `pg` is already here — and it works with several API instances behind a balancer.
 *   • The NOTIFY carries only an order id. Each viewer's snapshot is rebuilt through the SAME authorisation path as the plain
 *     GET /orders/:id/tracking, so a push can never leak more than a poll would (customer vs. dispatcher vs. seller views differ).
 *   • Bursts coalesce: while a snapshot is being built, further notifications just mark the stream dirty → one more rebuild.
 *   • A slow safety refresh (REFRESH_MS) means a missed NOTIFY (listener reconnecting) heals itself without the client doing anything.
 *   • Streams end themselves when the order reaches a final state, and the controller caps their lifetime at the access-token TTL.
 */
const CHANNEL = "vyra_tracking";
const REFRESH_MS = 30_000;

export function createRealtime({ config, logger, channel = CHANNEL, maxPerUser = 6, refreshMs = REFRESH_MS, ClientImpl = pg.Client }) {
  const subs = new Map();      // orderId -> Set<sub>
  const perUser = new Map();   // userId -> open stream count
  let listener = null;
  let starting = null;
  let stopped = false;
  let backoff = 1000;

  function dispatch(orderId) {
    for (const sub of subs.get(orderId) ?? []) schedule(sub);
  }

  async function schedule(sub) {
    if (!sub.open) return;
    if (sub.busy) { sub.dirty = true; return; }
    sub.busy = true;
    try {
      do {
        sub.dirty = false;
        const payload = await sub.snapshot();
        if (!sub.open) break;
        sub.send("tracking", payload);
        if (payload?.final) { sub.end(); break; }
      } while (sub.dirty && sub.open);
    } catch (err) {
      // "Not found" means access was lost or the order vanished: tell the client and close. Anything else is transient.
      if (err?.status === 404 || err?.code === "ORDER_NOT_FOUND") { sub.send("gone", {}); sub.end(); }
      else logger?.warn?.("tracking snapshot failed", { orderId: sub.orderId, error: err?.message });
    } finally {
      sub.busy = false;
    }
  }

  async function connect() {
    if (stopped) return;
    const client = new ClientImpl({
      connectionString: config.db.url,
      ssl: config.db.ssl ? { rejectUnauthorized: config.db.sslRejectUnauthorized } : undefined,
    });
    client.on("notification", (msg) => {
      if (msg.channel !== channel) return;
      try { const { orderId } = JSON.parse(msg.payload); if (orderId) dispatch(orderId); } catch { /* malformed — ignore */ }
    });
    const lost = (err) => {
      if (listener !== client) return;
      listener = null;
      logger?.warn?.("tracking listener lost", { error: err?.message });
      client.removeAllListeners();
      client.end().catch(() => {});
      if (!stopped) setTimeout(() => ensureStarted().catch(() => {}), (backoff = Math.min(backoff * 2, 30_000))).unref?.();
    };
    client.on("error", lost);
    client.on("end", () => lost(new Error("connection ended")));
    await client.connect();
    await client.query(`LISTEN ${channel}`);
    listener = client;
    backoff = 1000;
    // Anything that changed while we were disconnected is picked up by refreshing every open stream once.
    for (const orderId of subs.keys()) dispatch(orderId);
  }

  async function ensureStarted() {
    if (listener || stopped) return;
    starting ??= connect().finally(() => { starting = null; });
    await starting;
  }

  return {
    /** Call INSIDE the mutating transaction: delivered on COMMIT, discarded on ROLLBACK. */
    async publish(db, orderId) {
      await db.query("SELECT pg_notify($1, $2)", [channel, JSON.stringify({ orderId })]);
    },

    /**
     * @param {{orderId:string,userId:string,snapshot:()=>Promise<object>,send:(event:string,data:object)=>void,end:()=>void}} s
     * @returns {Promise<() => void>} unsubscribe
     */
    async subscribe(s) {
      const count = perUser.get(s.userId) ?? 0;
      if (count >= maxPerUser) { const e = new Error("Too many open tracking streams"); e.code = "TOO_MANY_STREAMS"; throw e; }
      await ensureStarted().catch((err) => logger?.warn?.("tracking listener unavailable; relying on periodic refresh", { error: err?.message }));
      const sub = { ...s, open: true, busy: false, dirty: false };
      if (!subs.has(s.orderId)) subs.set(s.orderId, new Set());
      subs.get(s.orderId).add(sub);
      perUser.set(s.userId, count + 1);
      sub.timer = setInterval(() => schedule(sub), refreshMs);
      sub.timer.unref?.();
      if (s.initial !== false) schedule(sub); // initial snapshot (a caller that already sent one passes initial:false)
      return () => {
        if (!sub.open) return;
        sub.open = false;
        clearInterval(sub.timer);
        const set = subs.get(s.orderId);
        set?.delete(sub);
        if (set && set.size === 0) subs.delete(s.orderId);
        const left = (perUser.get(s.userId) ?? 1) - 1;
        if (left <= 0) perUser.delete(s.userId); else perUser.set(s.userId, left);
      };
    },

    stats: () => ({ orders: subs.size, streams: [...subs.values()].reduce((n, set) => n + set.size, 0), listening: !!listener }),

    async stop() {
      stopped = true;
      for (const set of subs.values()) for (const sub of set) { sub.open = false; clearInterval(sub.timer); try { sub.end(); } catch { /* already closed */ } }
      subs.clear(); perUser.clear();
      const l = listener; listener = null;
      if (l) { l.removeAllListeners(); await l.end().catch(() => {}); }
    },
  };
}

/** Used where realtime is optional (unit tests build services without a database). */
export const noRealtime = { publish: async () => {}, subscribe: async () => () => {}, stop: async () => {} };
