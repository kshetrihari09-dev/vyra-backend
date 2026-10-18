import { buildIceServers } from "./calls.ice.js";
import { AppError, conflict, forbidden, notFound, unavailable } from "../utils/errors.js";

/**
 * Vyra Call — authorisation, state machine and signaling for customer <-> Vyra Shop voice calls.
 *
 * Who is who is NEVER taken from the request: a caller is the call's "customer" iff call.customer_id is their user id, and its
 * "shop" iff they are the owner account of call.seller_id (the existing shop ownership model: sellers.owner_user_id). A user
 * who is neither gets the same 404 as a call that doesn't exist, so call ids can't be probed.
 *
 *   ringing ──accept──▶ connecting ──audio connected──▶ active ──▶ completed
 *      │  └──decline──▶ declined          │                  └──▶ failed
 *      ├────cancel───▶ cancelled          └──▶ cancelled / failed
 *      └────timeout──▶ missed
 *
 * Every transition happens inside a transaction that locks the call row and ends with pg_notify (via realtime.publish), so a
 * rolled-back change never reaches a screen and two racing taps (accept vs. cancel) resolve to exactly one winner.
 */
const key = (userId) => `u:${userId}`; // realtime topic: one per user; every stream snapshot is rebuilt through the user's own authorisation path
const OPEN = new Set(["ringing", "connecting", "active"]);
const MAX_SIGNALS_PER_ROLE = 400; // an ICE restart or two is a few dozen; this only stops a runaway client
const RECENT_END_SECONDS = 120;

export function createCallsService({ pool, withTx, repos, realtime, config, logger }) {
  const repo = repos.calls;
  const cfg = config.calls;

  const iso = (d) => (d ? new Date(d).toISOString() : null);

  const dto = (c, role) => ({
    id: c.id,
    role,
    status: c.status,
    endReason: c.end_reason ?? null,
    endedBy: c.ended_by ?? null,
    shop: { id: c.seller_id, name: c.shop_name ?? null },
    // The shop sees the customer's display name only — no phone, email, address or order data.
    peerName: role === "shop" ? (c.customer_name ?? "Customer") : (c.shop_name ?? "Shop"),
    createdAt: iso(c.created_at), ringExpiresAt: iso(c.ring_expires_at), answeredAt: iso(c.answered_at),
    connectedAt: iso(c.connected_at), endedAt: iso(c.ended_at), durationSeconds: c.duration_seconds ?? null,
  });

  /** Resolves the caller's role on this call from the database. Returns null for a stranger. */
  async function roleOn(db, call, user) {
    if (call.customer_id === user.id) return "customer";
    const shop = await repo.shopByOwner(db, user.id);
    if (shop && shop.id === call.seller_id) return "shop";
    return null;
  }

  async function loadFor(db, id, user, { forUpdate = false } = {}) {
    const call = await repo.getById(db, id, { forUpdate });
    const role = call ? await roleOn(db, call, user) : null;
    if (!call || !role) throw notFound("CALL_NOT_FOUND", "Call not found");
    return { call, role };
  }

  async function notifyBoth(db, call) {
    const shop = await repo.shop(db, call.seller_id);
    await realtime.publish(db, key(call.customer_id));
    if (shop?.owner_user_id) await realtime.publish(db, key(shop.owner_user_id));
  }
  async function notifyPeer(db, call, fromRole) {
    if (fromRole === "customer") {
      const shop = await repo.shop(db, call.seller_id);
      if (shop?.owner_user_id) await realtime.publish(db, key(shop.owner_user_id));
    } else await realtime.publish(db, key(call.customer_id));
  }

  /** Ends an OPEN call (already locked by the caller) and tells both sides. Returns the updated row, or the row unchanged if it had already ended. */
  async function finishLocked(db, call, { status, reason, by }) {
    if (!OPEN.has(call.status)) return call;
    const done = await repo.finish(db, call.id, { status, reason, by });
    if (done) await notifyBoth(db, done);
    return done ?? call;
  }

  /** A ring that ran out (or any other stale state) is closed on demand, so a stale row can never block a new call. */
  async function expireIfStale(db, call) {
    const stale = (await repo.stale(db, { connectSeconds: cfg.connectSeconds, peerTimeoutSeconds: cfg.peerTimeoutSeconds, maxMinutes: cfg.maxMinutes })).find((s) => s.id === call.id);
    return stale ? closeStale(db, call, stale.reason) : call;
  }

  const STALE_OUTCOME = {
    ring_timeout: () => ({ status: "missed" }),
    connect_timeout: () => ({ status: "failed" }),
    max_duration: () => ({ status: "completed" }),
    peer_lost: (call) => ({ status: call.status === "active" ? "completed" : call.status === "ringing" ? "cancelled" : "failed" }),
  };
  async function closeStale(db, call, reason) {
    const locked = await repo.getById(db, call.id, { forUpdate: true });
    if (!locked || !OPEN.has(locked.status)) return locked ?? call;
    return finishLocked(db, locked, { ...STALE_OUTCOME[reason](locked), reason, by: "system" });
  }

  const unavailableReasons = {
    disabled_by_config: "Vyra Call is switched off right now.",
    turn_not_configured: "Vyra Call isn't available yet on this server.",
  };

  /** Shared by the customer's "Call shop" button and start(): the shop's REAL availability, from its heartbeat and open calls. */
  async function availability(db, sellerId, userId) {
    if (!cfg.enabled) return { state: "unavailable", callable: false, reason: cfg.disabledReason, message: unavailableReasons[cfg.disabledReason] };
    const shop = await repo.shop(db, sellerId);
    if (!shop || shop.status !== "active" || !shop.owner_user_id) return { state: "unavailable", callable: false, shop: null, message: "This shop can't take calls." };
    const base = { shop: { id: shop.id, name: shop.name } };
    if (userId && shop.owner_user_id === userId) return { ...base, state: "own_shop", callable: false, message: "You can't call your own shop." };
    const presence = await repo.getPresence(db, sellerId);
    if (!presence || !presence.online) return { ...base, state: "offline", callable: false, message: "The shop isn't online to take calls right now." };
    if (!presence.accepting) return { ...base, state: "paused", callable: false, message: "The shop has paused calls for now." };
    const open = await repo.openForShop(db, sellerId);
    // A call that has quietly died (app killed, ring ran out) is closed here, so it can't make the shop look busy forever.
    if (open && OPEN.has((await expireIfStale(db, open)).status)) return { ...base, state: "busy", callable: false, message: "The shop is on another call. Please try again in a few minutes." };
    return { ...base, state: "online", callable: true };
  }

  const isUniqueViolation = (err, constraint) => err?.code === "23505" && String(err.constraint || "").includes(constraint);

  return {
    iceServers: (user) => {
      if (!cfg.enabled) throw unavailable("CALLS_DISABLED", unavailableReasons[cfg.disabledReason] ?? "Vyra Call is unavailable.");
      return buildIceServers({ calls: cfg }, user.id);
    },

    async shopStatus(user, sellerId) {
      return { ...(await availability(pool, sellerId, user.id)), callsEnabled: cfg.enabled };
    },

    // ================================================================= customer
    async start(user, { sellerId, clientCallId }) {
      if (!cfg.enabled) throw unavailable("CALLS_DISABLED", unavailableReasons[cfg.disabledReason] ?? "Vyra Call is unavailable.");
      const run = () => withTx(async (db) => {
        const again = await repo.byClientId(db, user.id, clientCallId);
        if (again) return dto(await repo.withNames(db, again.id), "customer"); // a retry/double-tap: same call, no second ring

        // Clear out my own and the shop's dead calls first, so a call whose app was killed can't block either side.
        const mine = await repo.openForCustomer(db, user.id);
        if (mine) { const after = await expireIfStale(db, mine); if (OPEN.has(after.status)) throw conflict("ALREADY_IN_CALL", "You already have a call in progress."); }

        const a = await availability(db, sellerId, user.id);
        if (a.state === "own_shop") throw forbidden("CANNOT_CALL_OWN_SHOP", a.message);
        if (!a.callable) throw conflict(a.state === "busy" ? "SHOP_BUSY" : a.state === "unavailable" ? "SHOP_UNAVAILABLE" : "SHOP_OFFLINE", a.message, { state: a.state });

        const row = await repo.insert(db, { customerId: user.id, sellerId, clientCallId, ringSeconds: cfg.ringSeconds });
        await notifyBoth(db, row);
        return dto(await repo.withNames(db, row.id), "customer");
      });
      try {
        return await run();
      } catch (err) {
        // Two simultaneous requests can both pass the checks above; the partial unique indexes decide, here is the friendly answer.
        if (isUniqueViolation(err, "one_open_per_shop")) throw conflict("SHOP_BUSY", "The shop is on another call. Please try again in a few minutes.", { state: "busy" });
        if (isUniqueViolation(err, "one_open_per_customer")) throw conflict("ALREADY_IN_CALL", "You already have a call in progress.");
        if (isUniqueViolation(err, "client_key")) { const c = await repo.byClientId(pool, user.id, clientCallId); if (c) return dto(await repo.withNames(pool, c.id), "customer"); }
        throw err;
      }
    },

    // ================================================================= shop
    async accept(user, id) {
      return withTx(async (db) => {
        const { call, role } = await loadFor(db, id, user, { forUpdate: true });
        if (role !== "shop") throw forbidden("NOT_THE_SHOP", "Only the shop can answer this call.");
        const fresh = await expireIfStale(db, call);
        if (fresh.status !== "ringing") throw conflict(fresh.status === "missed" ? "CALL_MISSED" : "CALL_NOT_RINGING", fresh.status === "missed" ? "This call was missed." : "This call is no longer ringing.", { status: fresh.status });
        const done = await repo.markAccepted(db, id, user.id);
        await notifyBoth(db, done);
        return dto(await repo.withNames(db, id), "shop");
      });
    },

    async decline(user, id) {
      return withTx(async (db) => {
        const { call, role } = await loadFor(db, id, user, { forUpdate: true });
        if (role !== "shop") throw forbidden("NOT_THE_SHOP", "Only the shop can decline this call.");
        if (call.status !== "ringing") throw conflict("CALL_NOT_RINGING", "This call is no longer ringing.", { status: call.status });
        await finishLocked(db, call, { status: "declined", reason: "declined", by: "shop" });
        return dto(await repo.withNames(db, id), "shop");
      });
    },

    // ================================================================= both sides
    /** Hang up / cancel. Idempotent: ending an already-ended call just returns it. */
    async end(user, id, { reason = "hangup" } = {}) {
      return withTx(async (db) => {
        const { call, role } = await loadFor(db, id, user, { forUpdate: true });
        if (OPEN.has(call.status)) {
          let outcome;
          if (call.status === "ringing") outcome = role === "customer" ? { status: "cancelled", reason: "cancelled" } : { status: "declined", reason: "declined" };
          else if (reason === "failed") outcome = { status: "failed", reason: "client_failed" };
          else outcome = call.status === "active" ? { status: "completed", reason: "hangup" } : { status: "cancelled", reason: "hangup" };
          await finishLocked(db, call, { ...outcome, by: role });
        }
        return dto(await repo.withNames(db, id), role);
      });
    },

    /** Audio is flowing (reported by either browser from RTCPeerConnection.connectionState === "connected"). */
    async connected(user, id) {
      return withTx(async (db) => {
        const { call, role } = await loadFor(db, id, user, { forUpdate: true });
        if (call.status === "connecting") { const done = await repo.markConnected(db, id); if (done) await notifyBoth(db, done); }
        else if (call.status !== "active") throw conflict("CALL_NOT_CONNECTING", "This call isn't being connected.", { status: call.status });
        await repo.touch(db, id, role);
        return dto(await repo.withNames(db, id), role);
      });
    },

    /** Liveness ping (~every 15 s while a side has the call open) — a closed tab or dead network is noticed by the expiry job. */
    async ping(user, id) {
      const { call, role } = await loadFor(pool, id, user);
      if (OPEN.has(call.status)) await repo.touch(pool, id, role);
      return dto(await repo.withNames(pool, id), role);
    },

    async get(user, id) {
      const { call, role } = await loadFor(pool, id, user);
      return dto(await repo.withNames(pool, call.id), role);
    },

    /**
     * Relay one SDP/ICE message to the OTHER participant of this call — and to nobody else. This is the hottest path (dozens of
     * ICE candidates per call), so it is three cheap queries with no transaction and no row lock: who-is-who from one join, one
     * atomic insert that re-checks the call is still open, and one NOTIFY. Liveness comes from the separate ping.
     */
    async signal(user, id, { kind, payload }) {
      const call = await repo.getForSignal(pool, id);
      const role = !call ? null : call.customer_id === user.id ? "customer" : call.shop_owner_id === user.id ? "shop" : null;
      if (!role) throw notFound("CALL_NOT_FOUND", "Call not found");
      if (call.status !== "connecting" && call.status !== "active") throw conflict("CALL_NOT_CONNECTING", "This call isn't being connected.", { status: call.status });
      // The customer makes the offer, the shop answers — a participant can't impersonate the other side's part.
      if (kind === "offer" && role !== "customer") throw forbidden("SIGNAL_NOT_ALLOWED", "Only the caller sends the offer.");
      if (kind === "answer" && role !== "shop") throw forbidden("SIGNAL_NOT_ALLOWED", "Only the shop sends the answer.");
      const signalId = await repo.insertSignalIfOpen(pool, { callId: id, fromRole: role, kind, payload, max: MAX_SIGNALS_PER_ROLE });
      if (signalId == null) { // either it just ended, or this side hit its cap
        const now = await repo.getById(pool, id);
        if (!now || !OPEN.has(now.status) || now.status === "ringing") throw conflict("CALL_NOT_CONNECTING", "This call isn't being connected.", { status: now?.status });
        throw new AppError(429, "RATE_LIMITED", "Too many signaling messages for this call.");
      }
      await realtime.publish(pool, key(role === "customer" ? call.shop_owner_id : call.customer_id));
      return { id: Number(signalId) };
    },

    // ================================================================= live stream
    /**
     * Everything the signed-in user's open stream needs: their open (or just-ended) calls with their own view of each, plus the
     * signals the other side has sent since `after`. Built through the same role check as every other call, so a push can never
     * show more than a poll would.
     */
    async snapshot(user, after = 0) {
      const shop = await repo.shopByOwner(pool, user.id);
      const rows = await repo.visibleToUser(pool, { userId: user.id, sellerId: shop?.id ?? null, recentSeconds: RECENT_END_SECONDS });
      const calls = []; const byRole = { customer: [], shop: [] };
      for (const c of rows) {
        const role = c.customer_id === user.id ? "customer" : "shop"; // a row is visible only through one of those two conditions
        calls.push(dto(c, role));
        if (OPEN.has(c.status)) byRole[role].push(c.id);
      }
      const [toCustomer, toShop] = await Promise.all([
        repo.signalsFor(pool, { callIds: byRole.customer, toRole: "customer", after }),
        repo.signalsFor(pool, { callIds: byRole.shop, toRole: "shop", after }),
      ]);
      const signals = [...toCustomer, ...toShop].sort((a, b) => Number(a.id) - Number(b.id))
        .map((s) => ({ id: Number(s.id), callId: s.call_id, kind: s.kind, payload: s.payload }));
      return { calls, signals, cursor: signals.reduce((n, s) => Math.max(n, s.id), after), isShop: !!shop };
    },

    // ================================================================= shop console
    async setPresence(user, { accepting }) {
      if (!cfg.enabled) throw unavailable("CALLS_DISABLED", unavailableReasons[cfg.disabledReason] ?? "Vyra Call is unavailable.");
      const shop = await repo.shopByOwner(pool, user.id);
      if (!shop || shop.status !== "active") throw forbidden("NOT_A_SHOP", "Only an active Vyra Shop can take calls.");
      const until = await repo.setPresence(pool, { sellerId: shop.id, userId: user.id, accepting, ttlSeconds: cfg.shopPresenceTtlSeconds });
      return { online: true, accepting, until: iso(until), shop: { id: shop.id, name: shop.name } };
    },
    /**
     * Called every ~15 s while the shop owner's live stream is open. The open connection IS the proof the dashboard is there, so
     * availability no longer depends on browser timers (which background tabs throttle). Only refreshes a row the dashboard
     * already created, so a paused shop stays paused and a shop that never went online stays offline.
     */
    async touchPresence(user) {
      if (!cfg.enabled) return false;
      const shop = await repo.shopByOwner(pool, user.id);
      if (!shop || shop.status !== "active") return false;
      return repo.touchPresence(pool, { sellerId: shop.id, userId: user.id, ttlSeconds: cfg.shopPresenceTtlSeconds });
    },
    async clearPresence(user) {
      const shop = await repo.shopByOwner(pool, user.id);
      if (shop) await repo.clearPresence(pool, shop.id);
      return { online: false };
    },

    /** The shop's OWN history. There is no shop id in the request: the shop is whichever one the caller owns. */
    async shopHistory(user, { page, pageSize, missedOnly }) {
      const shop = await repo.shopByOwner(pool, user.id);
      if (!shop) throw forbidden("NOT_A_SHOP", "Only a Vyra Shop can see call history.");
      const { rows, total } = await repo.shopHistory(pool, { sellerId: shop.id, limit: pageSize, offset: (page - 1) * pageSize, missedOnly });
      return {
        total, page, pageSize,
        calls: rows.map((r) => ({
          id: r.id, status: r.status, endReason: r.end_reason, customerName: r.customer_name ?? "Customer",
          createdAt: iso(r.created_at), answeredAt: iso(r.answered_at), endedAt: iso(r.ended_at), durationSeconds: r.duration_seconds ?? null,
        })),
      };
    },

    // ================================================================= background expiry
    /** Closes calls that rang out, never connected, lost a side, or hit the cap; and drops signaling rows of long-finished calls. */
    async expireStale() {
      const stale = await repo.stale(pool, { connectSeconds: cfg.connectSeconds, peerTimeoutSeconds: cfg.peerTimeoutSeconds, maxMinutes: cfg.maxMinutes });
      let closed = 0;
      for (const s of stale) {
        try { await withTx(async (db) => { await closeStale(db, { id: s.id }, s.reason); }); closed += 1; }
        catch (err) { logger?.warn?.("vyra call expiry failed", { callId: s.id, error: err?.message }); }
      }
      const purged = await repo.purgeSignals(pool, { olderThanMinutes: 10 });
      return { closed, purged };
    },
  };
}
