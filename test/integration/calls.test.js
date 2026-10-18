import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { boot, loginAs, makeUser, skipReason, uniq } from "./helpers.js";

/**
 * Vyra Call against a real Postgres + the real Express app: authorisation, shop isolation, busy/duplicate handling, the
 * whole call state machine, signaling relay, call records, and the live SSE stream (LISTEN/NOTIFY). Audio itself is browser
 * WebRTC and is NOT covered here — see docs/VYRA_CALL.md for the real-device checklist.
 */
const uuid = () => crypto.randomUUID();
const OFFER = { type: "offer", sdp: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n" };
const ANSWER = { type: "answer", sdp: "v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\ns=-\r\n" };
const ICE = { candidate: "candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host", sdpMid: "0", sdpMLineIndex: 0 };

describe("Vyra Call (real Postgres)", { skip: skipReason }, () => {
  let ctx; let request; let pool;
  let cust; let cust2; let stranger; let ownerA; let ownerB; let shopA; let shopB; let tCust; let tCust2; let tStranger; let tA; let tB;
  const auth = (t) => ({ Authorization: `Bearer ${t}` });
  const api = {
    post: (path, t, body) => request.post(`/api${path}`).set(auth(t)).send(body ?? {}),
    get: (path, t) => request.get(`/api${path}`).set(auth(t)),
    put: (path, t, body) => request.put(`/api${path}`).set(auth(t)).send(body ?? {}),
  };
  const present = (t, accepting = true) => api.put("/shop/call-presence", t, { accepting });
  const start = (t, sellerId, clientCallId = uuid()) => api.post("/calls", t, { sellerId, clientCallId });
  /** Closes whatever is open so each test starts clean (the DB allows one open call per customer/shop). */
  const reset = async () => {
    await pool.query("UPDATE vyra_calls SET status='cancelled', ended_at=now(), ended_by='system', end_reason='test_reset' WHERE status IN ('ringing','connecting','active') AND seller_id = ANY($1)", [[shopA, shopB]]);
  };

  before(async () => {
    ctx = await boot({ CALLS_ENABLED: "true" });
    request = ctx.request; pool = ctx.container.pool;
    const tag = uniq();
    [cust, cust2, stranger] = await Promise.all([makeUser(ctx.container), makeUser(ctx.container), makeUser(ctx.container)]);
    [ownerA, ownerB] = await Promise.all([makeUser(ctx.container, { roles: ["customer", "seller"] }), makeUser(ctx.container, { roles: ["customer", "seller"] })]);
    shopA = `it-shop-a-${tag}`; shopB = `it-shop-b-${tag}`;
    await pool.query("INSERT INTO sellers (id, name, status, owner_user_id, is_demo) VALUES ($1,'Shop A','active',$2,true), ($3,'Shop B','active',$4,true)", [shopA, ownerA.id, shopB, ownerB.id]);
    [tCust, tCust2, tStranger, tA, tB] = (await Promise.all([cust, cust2, stranger, ownerA, ownerB].map((u) => loginAs(request, u)))).map((l) => l.token);
    assert.ok(tCust && tA && tB, "logins must work");
  });
  after(async () => {
    await pool.query("DELETE FROM sellers WHERE id = ANY($1)", [[shopA, shopB]]);
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [[cust.id, cust2.id, stranger.id, ownerA.id, ownerB.id]]);
    await ctx.container.services.callsRealtime.stop();
    await ctx.close();
  });

  describe("availability is real", () => {
    it("requires sign-in", async () => {
      assert.equal((await request.get(`/api/shops/${shopA}/call-status`)).status, 401);
      assert.equal((await request.post("/api/calls").send({ sellerId: shopA, clientCallId: uuid() })).status, 401);
    });
    it("is offline until the shop's console heartbeats, then online; paused is not callable", async () => {
      await pool.query("DELETE FROM shop_call_presence");
      let r = await api.get(`/shops/${shopA}/call-status`, tCust);
      assert.equal(r.body.data.state, "offline"); assert.equal(r.body.data.callable, false);
      assert.equal((await present(tA)).status, 200);
      r = await api.get(`/shops/${shopA}/call-status`, tCust);
      assert.equal(r.body.data.state, "online"); assert.equal(r.body.data.callable, true);
      await present(tA, false);
      assert.equal((await api.get(`/shops/${shopA}/call-status`, tCust)).body.data.state, "paused");
      await present(tA, true);
      // an expired heartbeat means offline by itself
      await pool.query("UPDATE shop_call_presence SET available_until = now() - interval '1 second' WHERE seller_id = $1", [shopA]);
      assert.equal((await api.get(`/shops/${shopA}/call-status`, tCust)).body.data.state, "offline");
      await present(tA);
    });
    it("unknown / unapproved shops are unavailable; a shop can't call itself", async () => {
      assert.equal((await api.get("/shops/does-not-exist/call-status", tCust)).body.data.state, "unavailable");
      assert.equal((await api.get(`/shops/${shopA}/call-status`, tA)).body.data.state, "own_shop");
      assert.equal((await start(tA, shopA)).status, 403);
    });
    it("only a shop owner can set presence or read shop history; no shop id is accepted", async () => {
      assert.equal((await present(tCust)).status, 403);
      assert.equal((await api.get("/shop/calls", tCust)).status, 403);
    });
  });

  describe("call lifecycle + records", () => {
    it("customer -> ring -> accept -> signaling -> connected -> hang up, and the record is stored", async () => {
      await reset(); await present(tA);
      const clientCallId = uuid();
      const s = await start(tCust, shopA, clientCallId);
      assert.equal(s.status, 201); const id = s.body.data.id;
      assert.equal(s.body.data.status, "ringing"); assert.equal(s.body.data.role, "customer"); assert.equal(s.body.data.peerName, "Shop A");
      // a retry/double-tap of the same request is the same call, not a second ring
      assert.equal((await start(tCust, shopA, clientCallId)).body.data.id, id);

      // the shop's stream snapshot shows an incoming call with the customer's display name only
      const incoming = await ctx.container.services.calls.snapshot({ id: ownerA.id }, 0);
      assert.equal(incoming.calls[0].id, id); assert.equal(incoming.calls[0].role, "shop");
      assert.match(incoming.calls[0].peerName, /^IT /);
      assert.equal(JSON.stringify(incoming).includes(cust.email), false, "no customer email in what the shop receives");

      // signals aren't allowed before the shop accepts
      assert.equal((await api.post(`/calls/${id}/signal`, tCust, { kind: "offer", payload: OFFER })).status, 409);

      assert.equal((await api.post(`/calls/${id}/accept`, tA)).body.data.status, "connecting");
      // only the customer offers, only the shop answers
      assert.equal((await api.post(`/calls/${id}/signal`, tA, { kind: "offer", payload: OFFER })).status, 403);
      assert.equal((await api.post(`/calls/${id}/signal`, tCust, { kind: "answer", payload: ANSWER })).status, 403);
      assert.equal((await api.post(`/calls/${id}/signal`, tCust, { kind: "offer", payload: ANSWER })).status, 400, "payload must match kind");
      assert.equal((await api.post(`/calls/${id}/signal`, tCust, { kind: "offer", payload: OFFER })).status, 201);
      assert.equal((await api.post(`/calls/${id}/signal`, tCust, { kind: "ice", payload: ICE })).status, 201);
      assert.equal((await api.post(`/calls/${id}/signal`, tA, { kind: "answer", payload: ANSWER })).status, 201);

      // each side receives ONLY what the other sent
      const toShop = await ctx.container.services.calls.snapshot({ id: ownerA.id }, 0);
      assert.deepEqual(toShop.signals.map((x) => x.kind), ["offer", "ice"]);
      const toCust = await ctx.container.services.calls.snapshot({ id: cust.id }, 0);
      assert.deepEqual(toCust.signals.map((x) => x.kind), ["answer"]);
      // …and resuming from the cursor returns nothing twice
      assert.equal((await ctx.container.services.calls.snapshot({ id: cust.id }, toCust.cursor)).signals.length, 0);

      assert.equal((await api.post(`/calls/${id}/connected`, tCust)).body.data.status, "active");
      await new Promise((r) => setTimeout(r, 1100));
      const ended = await api.post(`/calls/${id}/end`, tA, { reason: "hangup" });
      assert.equal(ended.body.data.status, "completed"); assert.equal(ended.body.data.endedBy, "shop");
      assert.ok(ended.body.data.durationSeconds >= 1);
      // ending again is harmless and stays completed
      assert.equal((await api.post(`/calls/${id}/end`, tCust)).body.data.status, "completed");

      const { rows } = await pool.query("SELECT * FROM vyra_calls WHERE id = $1", [id]);
      assert.equal(rows[0].customer_id, cust.id); assert.equal(rows[0].seller_id, shopA); assert.equal(rows[0].answered_by, ownerA.id);
      assert.ok(rows[0].created_at && rows[0].answered_at && rows[0].connected_at && rows[0].ended_at);
      assert.equal(Object.keys(rows[0]).some((k) => /audio|recording|phone|email/.test(k)), false);

      const hist = await api.get("/shop/calls", tA);
      assert.equal(hist.body.data.calls.some((c) => c.id === id && c.status === "completed"), true);
    });

    it("decline, cancel and ring timeout produce the right outcomes (and missed shows in history)", async () => {
      await reset(); await present(tA);
      let id = (await start(tCust, shopA)).body.data.id;
      assert.equal((await api.post(`/calls/${id}/decline`, tA)).body.data.status, "declined");

      id = (await start(tCust, shopA)).body.data.id;
      const cancelled = await api.post(`/calls/${id}/end`, tCust);
      assert.equal(cancelled.body.data.status, "cancelled"); assert.equal(cancelled.body.data.endedBy, "customer");
      assert.equal((await api.post(`/calls/${id}/accept`, tA)).status, 409, "can't answer a cancelled call");

      id = (await start(tCust, shopA)).body.data.id;
      await pool.query("UPDATE vyra_calls SET ring_expires_at = now() - interval '1 second' WHERE id = $1", [id]);
      const exp = await ctx.container.services.calls.expireStale();
      assert.ok(exp.closed >= 1);
      assert.equal((await api.get(`/calls/${id}`, tCust)).body.data.status, "missed");
      assert.equal((await api.post(`/calls/${id}/accept`, tA)).status, 409);
      const missed = await api.get("/shop/calls?missedOnly=true", tA);
      assert.equal(missed.body.data.calls.some((c) => c.id === id), true);
      assert.equal(missed.body.data.calls.every((c) => c.status === "missed"), true);
    });

    it("a ring that already ran out can't be answered, even before the job runs", async () => {
      await reset(); await present(tA);
      const id = (await start(tCust, shopA)).body.data.id;
      await pool.query("UPDATE vyra_calls SET ring_expires_at = now() - interval '1 second' WHERE id = $1", [id]);
      const r = await api.post(`/calls/${id}/accept`, tA);
      assert.equal(r.status, 409); assert.equal(r.body.code, "CALL_MISSED");
    });

    it("a side that vanishes mid-call ends the call; a never-connected one fails", async () => {
      await reset(); await present(tA);
      let id = (await start(tCust, shopA)).body.data.id;
      await api.post(`/calls/${id}/accept`, tA); await api.post(`/calls/${id}/connected`, tCust);
      await pool.query("UPDATE vyra_calls SET shop_seen_at = now() - interval '5 minutes' WHERE id = $1", [id]);
      await ctx.container.services.calls.expireStale();
      let row = (await api.get(`/calls/${id}`, tCust)).body.data;
      assert.equal(row.status, "completed"); assert.equal(row.endReason, "peer_lost"); assert.equal(row.endedBy, "system");

      id = (await start(tCust, shopA)).body.data.id;
      await api.post(`/calls/${id}/accept`, tA);
      await pool.query("UPDATE vyra_calls SET answered_at = now() - interval '5 minutes', shop_seen_at = now(), customer_seen_at = now() WHERE id = $1", [id]);
      await ctx.container.services.calls.expireStale();
      row = (await api.get(`/calls/${id}`, tCust)).body.data;
      assert.equal(row.status, "failed"); assert.equal(row.durationSeconds, null);
    });
  });

  describe("signaling speed", () => {
    it("handles a burst of ICE candidates in parallel — all stored, none lost, none refused", async () => {
      await reset(); await present(tA);
      const id = (await start(tCust, shopA)).body.data.id; await api.post(`/calls/${id}/accept`, tA);
      const t0 = Date.now();
      const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => api.post(`/calls/${id}/signal`, tCust, { kind: "ice", payload: { ...ICE, candidate: `candidate:${i} 1 udp 1 192.0.2.1 ${5000 + i} typ host` } })));
      assert.deepEqual([...new Set(rs.map((r) => r.status))], [201]);
      const got = await ctx.container.services.calls.snapshot({ id: ownerA.id }, 0);
      assert.equal(got.signals.filter((x) => x.kind === "ice").length, 40);
      assert.ok(Date.now() - t0 < 5000, `40 signals took ${Date.now() - t0} ms`);
      // once the call has ended, a late candidate is refused cleanly rather than stored
      await api.post(`/calls/${id}/end`, tA);
      assert.equal((await api.post(`/calls/${id}/signal`, tCust, { kind: "ice", payload: ICE })).status, 409);
    });
  });

  describe("busy, duplicates and races", () => {
    it("one open call per customer and per shop; a second customer hears 'busy'", async () => {
      await reset(); await present(tA); await present(tB);
      const first = await start(tCust, shopA); assert.equal(first.status, 201);
      const again = await start(tCust, shopB);
      assert.equal(again.status, 409); assert.equal(again.body.code, "ALREADY_IN_CALL");
      const busy = await start(tCust2, shopA);
      assert.equal(busy.status, 409); assert.equal(busy.body.code, "SHOP_BUSY");
      assert.equal((await api.get(`/shops/${shopA}/call-status`, tCust2)).body.data.state, "busy");
      // a different shop is still reachable
      assert.equal((await start(tCust2, shopB)).status, 201);
    });
    it("simultaneous calls to one shop: exactly one rings", async () => {
      await reset(); await present(tA);
      const rs = await Promise.all([start(tCust, shopA), start(tCust2, shopA)]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409]);
    });
    it("accept racing cancel resolves to exactly one outcome", async () => {
      await reset(); await present(tA);
      const id = (await start(tCust, shopA)).body.data.id;
      const [a, c] = await Promise.all([api.post(`/calls/${id}/accept`, tA), api.post(`/calls/${id}/end`, tCust)]);
      const final = (await api.get(`/calls/${id}`, tCust)).body.data.status;
      assert.ok(["cancelled", "connecting"].includes(final), `unexpected final status ${final}`);
      // Whoever lost the race is told so cleanly (409), never a 500; and the call has exactly one outcome.
      if (final === "cancelled") assert.ok([200, 409].includes(a.status));
      else assert.equal(c.status, 200); // accept won; the customer's end then cancels the connecting call
      assert.ok(a.status < 500 && c.status < 500);
    });
  });

  describe("authorization and shop isolation", () => {
    it("strangers and other shops can't see, answer, signal, end or ping a call (404, same as a missing call)", async () => {
      await reset(); await present(tA); await present(tB);
      const id = (await start(tCust, shopA)).body.data.id;
      for (const t of [tStranger, tB, tCust2]) {
        assert.equal((await api.get(`/calls/${id}`, t)).status, 404);
        assert.equal((await api.post(`/calls/${id}/end`, t)).status, 404);
        assert.equal((await api.post(`/calls/${id}/ping`, t)).status, 404);
        assert.equal((await api.post(`/calls/${id}/connected`, t)).status, 404);
      }
      assert.equal((await api.post(`/calls/${id}/accept`, tB)).status, 404, "another shop can't answer");
      assert.equal((await api.post(`/calls/${id}/decline`, tB)).status, 404);
      assert.equal((await api.post(`/calls/${id}/accept`, tStranger)).status, 403, "non-shop users are refused outright");
      assert.equal((await api.post(`/calls/${id}/accept`, tCust)).status, 403, "the customer can't answer their own call");
      await api.post(`/calls/${id}/accept`, tA);
      for (const t of [tStranger, tB]) assert.equal((await api.post(`/calls/${id}/signal`, t, { kind: "ice", payload: ICE })).status, 404);
      // and their streams never contain it
      for (const u of [stranger, ownerB, cust2]) assert.equal((await ctx.container.services.calls.snapshot({ id: u.id }, 0)).calls.some((c) => c.id === id), false);
    });
    it("a shop's history contains only its own calls", async () => {
      await reset(); await present(tA); await present(tB);
      const idB = (await start(tCust2, shopB)).body.data.id; await api.post(`/calls/${idB}/decline`, tB);
      const a = await api.get("/shop/calls?pageSize=100", tA);
      assert.equal(a.body.data.calls.some((c) => c.id === idB), false);
      const b = await api.get("/shop/calls?pageSize=100", tB);
      assert.equal(b.body.data.calls.some((c) => c.id === idB), true);
    });
    it("identity can't be spoofed through the request: extra fields are ignored, the role comes from the database", async () => {
      await reset(); await present(tA);
      const r = await api.post("/calls", tStranger, { sellerId: shopA, clientCallId: uuid(), customerId: cust.id, role: "shop" });
      assert.equal(r.status, 201);
      assert.equal(r.body.data.role, "customer");
      const { rows } = await pool.query("SELECT customer_id FROM vyra_calls WHERE id = $1", [r.body.data.id]);
      assert.equal(rows[0].customer_id, stranger.id);
    });
    it("rejects malformed bodies and oversized signaling", async () => {
      await reset(); await present(tA);
      assert.equal((await api.post("/calls", tCust, { sellerId: "A B", clientCallId: uuid() })).status, 400);
      assert.equal((await api.post("/calls", tCust, { sellerId: shopA, clientCallId: "nope" })).status, 400);
      const id = (await start(tCust, shopA)).body.data.id; await api.post(`/calls/${id}/accept`, tA);
      assert.equal((await api.post(`/calls/${id}/signal`, tCust, { kind: "offer", payload: { type: "offer", sdp: "x".repeat(30_000) } })).status, 400);
      assert.equal((await api.post(`/calls/${id}/signal`, tCust, { kind: "ice", payload: { ...ICE, extra: 1 } })).status, 400);
    });
  });

  describe("ICE servers", () => {
    it("hands out STUN and never exposes a TURN secret", async () => {
      const r = await api.get("/calls/ice", tCust);
      assert.equal(r.status, 200); assert.ok(r.body.data.iceServers.length >= 1);
      assert.equal((await request.get("/api/calls/ice")).status, 401);
      assert.equal(JSON.stringify(r.body).includes("secret"), false);
    });
  });

  describe("live stream (SSE over LISTEN/NOTIFY)", () => {
    it("pushes an incoming call to the shop's open stream, and the end of it to the customer's", async () => {
      await reset(); await present(tA);
      const server = await new Promise((res) => { const s = ctx.app.listen(0, () => res(s)); });
      const base = `http://127.0.0.1:${server.address().port}/api`;
      const events = [];
      const ac = new AbortController();
      const open = async (token, tag) => {
        const res = await fetch(`${base}/calls/stream`, { headers: { ...auth(token), Accept: "text/event-stream" }, signal: ac.signal });
        assert.equal(res.status, 200); assert.match(res.headers.get("content-type"), /text\/event-stream/);
        (async () => {
          const dec = new TextDecoder(); let buf = "";
          try { for await (const chunk of res.body) { buf += dec.decode(chunk, { stream: true }); let i; while ((i = buf.indexOf("\n\n")) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); const m = /event: (\w+)\ndata: (.*)/s.exec(block); if (m) events.push({ tag, event: m[1], data: JSON.parse(m[2]) }); } } } catch { /* aborted */ }
        })();
      };
      const waitFor = async (pred, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const hit = events.find(pred); if (hit) return hit; await new Promise((r) => setTimeout(r, 25)); } throw new Error(`timed out; saw ${JSON.stringify(events.map((e) => [e.tag, e.data.calls?.map((c) => c.status)]))}`); };
      try {
        await open(tA, "shop"); await open(tCust, "cust");
        await waitFor((e) => e.tag === "shop"); // initial snapshot
        const id = (await start(tCust, shopA)).body.data.id;
        const ring = await waitFor((e) => e.tag === "shop" && e.data.calls.some((c) => c.id === id && c.status === "ringing"));
        assert.equal(ring.data.calls.find((c) => c.id === id).role, "shop");
        await api.post(`/calls/${id}/accept`, tA);
        await waitFor((e) => e.tag === "cust" && e.data.calls.some((c) => c.id === id && c.status === "connecting"));
        await api.post(`/calls/${id}/signal`, tCust, { kind: "offer", payload: OFFER });
        const off = await waitFor((e) => e.tag === "shop" && e.data.signals.some((x) => x.kind === "offer"));
        assert.equal(off.data.signals.find((x) => x.kind === "offer").callId, id);
        await api.post(`/calls/${id}/end`, tA);
        await waitFor((e) => e.tag === "cust" && e.data.calls.some((c) => c.id === id && ["cancelled", "completed"].includes(c.status)));
        // a stranger's stream never carried any of it
      } finally { ac.abort(); await new Promise((r) => server.close(r)); }
    });
    it("refuses an unauthenticated stream with plain JSON", async () => {
      const r = await request.get("/api/calls/stream");
      assert.equal(r.status, 401); assert.match(r.headers["content-type"], /json/);
    });
  });
});

describe("shop presence is kept alive by the open stream (real Postgres)", { skip: skipReason }, () => {
  let ctx; let request; let pool; let owner; let cust; let tOwner; let tCust; let shop;
  before(async () => {
    ctx = await boot({ CALLS_ENABLED: "true" }); request = ctx.request; pool = ctx.container.pool;
    owner = await makeUser(ctx.container, { roles: ["customer", "seller"] }); cust = await makeUser(ctx.container);
    shop = `it-presence-${uniq()}`;
    await pool.query("INSERT INTO sellers (id, name, status, owner_user_id, is_demo) VALUES ($1,'Presence Shop','active',$2,true)", [shop, owner.id]);
    [tOwner, tCust] = (await Promise.all([owner, cust].map((u) => loginAs(request, u)))).map((l) => l.token);
  });
  after(async () => {
    await pool.query("DELETE FROM sellers WHERE id = $1", [shop]); await pool.query("DELETE FROM users WHERE id = ANY($1)", [[owner.id, cust.id]]);
    await ctx.container.services.callsRealtime.stop(); await ctx.close();
  });
  const status = async () => (await request.get(`/api/shops/${shop}/call-status`).set({ Authorization: `Bearer ${tCust}` })).body.data.state;
  const calls = () => ctx.container.services.calls;

  it("extends an existing heartbeat without a client timer, and keeps a paused shop paused", async () => {
    await request.put("/api/shop/call-presence").set({ Authorization: `Bearer ${tOwner}` }).send({ accepting: true });
    await pool.query("UPDATE shop_call_presence SET available_until = now() + interval '1 second' WHERE seller_id = $1", [shop]);
    assert.equal(await calls().touchPresence({ id: owner.id }), true);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await status(), "online", "the stream kept it online past the old expiry");
    await request.put("/api/shop/call-presence").set({ Authorization: `Bearer ${tOwner}` }).send({ accepting: false });
    await calls().touchPresence({ id: owner.id });
    assert.equal(await status(), "paused");
  });
  it("never creates presence for a shop that didn't announce itself, and ignores non-shop users", async () => {
    await request.delete("/api/shop/call-presence").set({ Authorization: `Bearer ${tOwner}` });
    assert.equal(await calls().touchPresence({ id: owner.id }), false);
    assert.equal(await status(), "offline");
    assert.equal(await calls().touchPresence({ id: cust.id }), false);
  });
  it("a heartbeat arriving after a 'go offline' brings the shop back (no stuck-offline ordering trap)", async () => {
    await request.delete("/api/shop/call-presence").set({ Authorization: `Bearer ${tOwner}` });
    await request.put("/api/shop/call-presence").set({ Authorization: `Bearer ${tOwner}` }).send({ accepting: true });
    assert.equal(await status(), "online");
  });
});
