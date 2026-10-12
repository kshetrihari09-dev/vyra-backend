import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { boot, loginAs, makeUser, skipReason, uniq } from "./helpers.js";

const SECRET = "g".repeat(40);
const auth = (t) => ({ Authorization: `Bearer ${t}` });

/** A real HTTP gateway: records every signed POST the webhook notifier makes and answers with a controllable status. */
function startGateway() {
  const state = { status: 200, delayMs: 0, calls: [] };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const ts = req.headers["x-vyra-timestamp"];
      const expected = `sha256=${createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex")}`;
      state.calls.push({ body: JSON.parse(raw), signatureOk: req.headers["x-vyra-signature"] === expected });
      setTimeout(() => { res.statusCode = state.status; res.end("{}"); }, state.delayMs);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ state, url: `http://127.0.0.1:${server.address().port}/send`, close: () => new Promise((r) => server.close(r)) })));
}

/** Minimal SSE client over real HTTP (supertest can't hold a stream open). */
function openSse(base, path, token) {
  const events = []; const waiters = [];
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" } }, (res) => {
      if (!(res.headers["content-type"] || "").includes("text/event-stream")) {
        let body = ""; res.on("data", (c) => { body += c; }); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body || "{}"), close() {} }));
        return;
      }
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1]; const data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev && data) { events.push({ event: ev, data: JSON.parse(data) }); waiters.splice(0).forEach((w) => w()); }
        }
      });
      resolve({
        status: 200, events, close: () => req.destroy(),
        async waitFor(pred, ms = 4000) {
          const end = Date.now() + ms;
          for (;;) {
            const hit = events.find(pred);
            if (hit) return hit;
            if (Date.now() > end) throw new Error(`timed out waiting for SSE event; saw ${JSON.stringify(events.map((e) => e.event))}`);
            await new Promise((r) => { waiters.push(r); setTimeout(r, 200); });
          }
        },
      });
    });
    req.on("error", (e) => { if (e.code !== "ECONNRESET") reject(e); });
    req.end();
  });
}

describe("pharmacist support (real Postgres + real webhook gateway)", { skip: skipReason }, () => {
  let ctx, gw, server, base;
  let cust, other, pharm, nonStaff, custH, otherH, pharmH, supportH;
  let orderId, otherOrderId, rxId;
  const q = (sql, p) => ctx.container.pool.query(sql, p).then((r) => r.rows);
  const send = (h, body = "Can I take ibuprofen with my blood pressure tablet?", extra = {}) =>
    ctx.request.post("/api/support/chat/messages").set(h).send({ body, clientMessageId: randomUUID(), ...extra });

  before(async () => {
    gw = await startGateway();
    ctx = await boot({
      PHARMACY_PHONE: "+977 9812-345678", PHARMACY_SUPPORT_EMAIL: "pharmacy@vyra.example", GENERAL_SUPPORT_EMAIL: "help@vyra.example",
      NOTIFY_DRIVER: "webhook", NOTIFY_WEBHOOK_URL: gw.url, NOTIFY_WEBHOOK_SECRET: SECRET, NOTIFY_TIMEOUT_MS: "1500",
    });
    server = ctx.app.listen(0); base = `http://127.0.0.1:${server.address().port}`;
    const mk = async (roles) => { const u = await makeUser(ctx.container, { roles }); return { u, h: auth((await loginAs(ctx.request, u)).token) }; };
    ({ u: cust, h: custH } = await mk(["customer"]));
    ({ u: other, h: otherH } = await mk(["customer"]));
    ({ u: pharm, h: pharmH } = await mk(["pharmacist"]));
    ({ u: nonStaff, h: supportH } = await mk(["support"]));
    // Real rows owned by each customer (creating orders through the API is gated by address phone verification, not what's under test).
    const mkOrder = async (uid) => (await q(
      `INSERT INTO orders (number, user_id, branch_id, payment_method, address, delivery_option_id, subtotal, total, is_demo)
       VALUES ($1,$2,'store-01','cod','{}'::jsonb,'standard',10,10,true) RETURNING id`, [`SUP-${uniq()}`, uid]))[0].id;
    orderId = await mkOrder(cust.id); otherOrderId = await mkOrder(other.id);
    rxId = (await q(`INSERT INTO prescriptions (user_id, file_key, file_name, mime_type, size_bytes, is_demo) VALUES ($1,'k','rx.pdf','application/pdf',10,true) RETURNING id`, [cust.id]))[0].id;
  });
  after(async () => {
    server?.close();
    await ctx?.container.services.supportRealtime.stop();
    await ctx?.container.services.realtime.stop();
    await ctx?.close(); await gw?.close();
  });

  describe("contact card", () => {
    it("returns the CONFIGURED phone as a tel-ready number, and no pharmacist is online by default", async () => {
      const res = await ctx.request.get("/api/support/contact").query({ branchId: "store-01" });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data.phone, { display: "+977 9812-345678", tel: "+9779812345678", label: "Pharmacy line", source: "pharmacy" });
      assert.equal(res.body.data.chat.available, false);
      assert.equal(res.body.data.email.pharmacy.canSend, true);
    });
    it("availability is real: heartbeat makes a pharmacist online (name shown to signed-in users only), stopping/expiry takes them offline", async () => {
      assert.equal((await ctx.request.put("/api/support/availability").set(custH).send({ available: true })).status, 403, "a customer can't set availability");
      assert.equal((await ctx.request.put("/api/support/availability").set(supportH).send({ available: true })).status, 403, "other staff roles can't either");
      const on = await ctx.request.put("/api/support/availability").set(pharmH).send({ available: true });
      assert.equal(on.status, 200); assert.equal(on.body.data.available, true);

      const anon = (await ctx.request.get("/api/support/contact")).body.data.chat;
      assert.equal(anon.available, true); assert.deepEqual(anon.pharmacists, [], "anonymous callers learn availability, not staff names");
      const signed = (await ctx.request.get("/api/support/contact").set(custH)).body.data.chat;
      assert.equal(signed.pharmacists[0].name, `IT ${pharm.email.split("@")[0].slice(3)}`);

      await q("UPDATE pharmacist_presence SET available_until = now() - interval '1 second' WHERE user_id = $1", [pharm.id]);
      assert.equal((await ctx.request.get("/api/support/contact")).body.data.chat.available, false, "an expired heartbeat means offline");

      await ctx.request.put("/api/support/availability").set(pharmH).send({ available: true });
      await q("DELETE FROM user_roles WHERE user_id = $1 AND role_key = 'pharmacist'", [pharm.id]);
      assert.equal((await ctx.request.get("/api/support/contact")).body.data.chat.available, false, "losing the role takes them offline immediately");
      await q("INSERT INTO user_roles (user_id, role_key) VALUES ($1, 'pharmacist')", [pharm.id]);
      await ctx.request.put("/api/support/availability").set(pharmH).send({ available: false });
    });
  });

  describe("live chat", () => {
    it("customer sends, it is persisted with a timestamp, and survives a 'refresh' (history)", async () => {
      const sent = await send(custH, "Can I take ibuprofen with my blood pressure tablet?", { orderId, prescriptionId: rxId });
      assert.equal(sent.status, 201);
      assert.equal(sent.body.data.message.sender, "customer");
      assert.ok(Date.parse(sent.body.data.message.createdAt));
      const again = await ctx.request.get("/api/support/chat").set(custH);
      assert.equal(again.body.data.messages.length, 1);
      assert.equal(again.body.data.messages[0].refs.order.id, orderId);
      assert.equal(again.body.data.messages[0].refs.prescription.id, rxId);
    });
    it("the same clientMessageId is idempotent (double tap / retry never duplicates)", async () => {
      const id = randomUUID();
      const a = await ctx.request.post("/api/support/chat/messages").set(custH).send({ body: "dup test", clientMessageId: id });
      const b = await ctx.request.post("/api/support/chat/messages").set(custH).send({ body: "dup test", clientMessageId: id });
      assert.equal(a.status, 201); assert.equal(b.status, 200);
      assert.equal(a.body.data.message.id, b.body.data.message.id);
      assert.equal((await q("SELECT count(*)::int n FROM support_messages WHERE client_message_id = $1", [id]))[0].n, 1);
    });
    it("validates input server-side", async () => {
      const bad = (body) => ctx.request.post("/api/support/chat/messages").set(custH).send(body);
      assert.equal((await bad({ body: "   ", clientMessageId: randomUUID() })).status, 400);
      assert.equal((await bad({ body: "x".repeat(2001), clientMessageId: randomUUID() })).status, 400);
      assert.equal((await bad({ body: "hi", clientMessageId: "nope" })).status, 400);
      assert.equal((await bad({ body: "hi", clientMessageId: randomUUID(), orderId: "not-a-uuid" })).status, 400);
      assert.equal((await bad({ body: "hi", clientMessageId: randomUUID(), productId: "No Such!" })).status, 400);
      assert.equal((await bad({ body: "hi", clientMessageId: randomUUID(), productId: "does-not-exist" })).status, 404);
    });
    it("a customer can't attach someone else's order (answers exactly like a missing one)", async () => {
      const res = await send(custH, "hello", { orderId: otherOrderId });
      assert.equal(res.status, 404); assert.equal(res.body.code, "ORDER_NOT_FOUND");
    });
    it("pharmacist sees it unread, replies, and the customer sees the reply with the pharmacist's name + unread count; read clears it", async () => {
      const inbox = await ctx.request.get("/api/support/inbox").set(pharmH);
      const row = inbox.body.data.conversations.find((c) => c.customerName === `IT ${cust.email.split("@")[0].slice(3)}`);
      assert.ok(row, JSON.stringify(inbox.body)); assert.ok(row.unread >= 1); assert.equal(row.status, "open");
      assert.ok(inbox.body.data.unreadConversations >= 1);

      const detail = await ctx.request.get(`/api/support/inbox/${row.id}/messages`).set(pharmH);
      const first = detail.body.data.messages.find((m) => m.refs.order);
      assert.ok(first.refs.order.number.startsWith("SUP-"), "pharmacist (orders:read_all) sees the linked order");
      assert.ok(first.refs.prescription, "and the linked prescription reference");

      const reply = await ctx.request.post(`/api/support/inbox/${row.id}/messages`).set(pharmH).send({ body: "Please avoid it; paracetamol is safer. I'd check with your doctor too.", clientMessageId: randomUUID() });
      assert.equal(reply.status, 201);

      const mine = await ctx.request.get("/api/support/chat").set(custH);
      assert.equal(mine.body.data.conversation.unread, 1);
      assert.equal(mine.body.data.conversation.assignedPharmacist, `IT ${pharm.email.split("@")[0].slice(3)}`);
      const staffMsg = mine.body.data.messages.find((m) => m.sender === "staff");
      assert.ok(staffMsg.senderName);
      assert.equal((await ctx.request.post("/api/support/chat/read").set(custH)).body.data.unread, 0);
      assert.equal((await ctx.request.get("/api/support/chat").set(custH)).body.data.conversation.unread, 0);

      // pharmacist side: replying marked everything before it as read
      const after = await ctx.request.get("/api/support/inbox").set(pharmH);
      assert.equal(after.body.data.conversations.find((c) => c.id === row.id).unread, 0);
    });
    it("raises in-app notifications without message text (new question → pharmacists, reply → customer)", async () => {
      const toPharm = (await ctx.request.get("/api/notifications").set(pharmH)).body.data.notifications.find((n) => n.type === "support.new_message");
      assert.ok(toPharm); assert.ok(toPharm.data.conversationId); assert.ok(!/ibuprofen/i.test(JSON.stringify(toPharm)));
      const toCust = (await ctx.request.get("/api/notifications").set(custH)).body.data.notifications.find((n) => n.type === "support.reply");
      assert.ok(toCust); assert.ok(!/paracetamol/i.test(JSON.stringify(toCust)), "no health details in notifications");
    });
    it("history is paginated", async () => {
      const u = await makeUser(ctx.container); const h = auth((await loginAs(ctx.request, u)).token);
      for (let i = 0; i < 55; i++) await send(h, `msg ${i}`);
      const page1 = (await ctx.request.get("/api/support/chat").set(h)).body.data;
      assert.equal(page1.messages.length, 50); assert.equal(page1.hasMore, true);
      assert.equal(page1.messages.at(-1).body, "msg 54", "newest last");
      const page2 = (await ctx.request.get("/api/support/chat/messages").set(h).query({ before: page1.messages[0].seq })).body.data;
      assert.equal(page2.messages.length, 5); assert.equal(page2.hasMore, false);
      assert.equal((await ctx.request.get("/api/support/chat/messages").set(h).query({ limit: 101 })).status, 400);
    });
  });

  describe("authorization & isolation", () => {
    it("another customer sees none of it; customer routes take no id so there is nothing to tamper with", async () => {
      const res = await ctx.request.get("/api/support/chat").set(otherH);
      assert.equal(res.body.data.conversation, null); assert.deepEqual(res.body.data.messages, []);
    });
    it("customers and non-pharmacist staff are refused the inbox, every inbox route", async () => {
      const convId = (await q("SELECT id FROM support_conversations WHERE customer_id = $1 AND department = 'pharmacy'", [cust.id]))[0].id;
      for (const h of [custH, supportH]) {
        assert.equal((await ctx.request.get("/api/support/inbox").set(h)).status, 403);
        assert.equal((await ctx.request.get(`/api/support/inbox/${convId}`).set(h)).status, 403);
        assert.equal((await ctx.request.get(`/api/support/inbox/${convId}/messages`).set(h)).status, 403);
        assert.equal((await ctx.request.post(`/api/support/inbox/${convId}/messages`).set(h).send({ body: "hi", clientMessageId: randomUUID() })).status, 403);
        assert.equal((await ctx.request.post(`/api/support/inbox/${convId}/resolve`).set(h)).status, 403);
        assert.equal((await ctx.request.get(`/api/support/inbox/${convId}/stream`).set(h)).status, 403);
      }
      assert.equal((await ctx.request.get("/api/support/inbox/not-a-uuid").set(pharmH)).status, 400);
      assert.equal((await ctx.request.get(`/api/support/inbox/${randomUUID()}`).set(pharmH)).status, 404);
    });
    it("unauthenticated or expired/garbage tokens are rejected (401), not served", async () => {
      assert.equal((await ctx.request.get("/api/support/chat")).status, 401);
      const bad = await ctx.request.get("/api/support/chat").set({ Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.bad" });
      assert.equal(bad.status, 401); assert.equal(bad.body.code, "INVALID_TOKEN");
      assert.equal((await ctx.request.post("/api/support/messages").send({})).status, 401);
    });
    it("suspending a pharmacist ends their access at once", async () => {
      const p2 = await makeUser(ctx.container, { roles: ["pharmacist"] });
      const h = auth((await loginAs(ctx.request, p2)).token);
      assert.equal((await ctx.request.get("/api/support/inbox").set(h)).status, 200);
      await q("UPDATE users SET status = 'suspended' WHERE id = $1", [p2.id]);
      assert.equal((await ctx.request.get("/api/support/inbox").set(h)).status, 401);
    });
  });

  describe("email / message form", () => {
    const form = (h, extra = {}) => ctx.request.post("/api/support/messages").set(h).send({
      topic: "pharmacist", body: "Is amoxicillin safe with my other medicine?", clientRequestId: randomUUID(), orderId, prescriptionId: rxId, ...extra });
    const reset = () => { gw.state.status = 200; gw.state.delayMs = 0; gw.state.calls.length = 0; };

    it("success is returned only after the gateway accepted a correctly signed email addressed to the CONFIGURED pharmacy", async () => {
      reset();
      const res = await form(custH);
      assert.equal(res.status, 201); assert.equal(res.body.data.status, "accepted");
      assert.equal(gw.state.calls.length, 1);
      const call = gw.state.calls[0];
      assert.equal(call.signatureOk, true);
      assert.equal(call.body.channel, "email"); assert.equal(call.body.to, "pharmacy@vyra.example");
      assert.equal(call.body.replyTo, cust.email);
      assert.match(call.body.text, /amoxicillin/); assert.match(call.body.text, /Order: SUP-/); assert.match(call.body.text, /Prescription ref:/);
      const [row] = await q("SELECT email_status, email_accepted_at FROM support_messages WHERE id = $1", [res.body.data.message.id]);
      assert.equal(row.email_status, "accepted"); assert.ok(row.email_accepted_at);
    });
    it("a gateway error is reported as a failure (never as success), the message is kept, and a retry with the same id sends once and doesn't duplicate", async () => {
      reset(); gw.state.status = 500;
      const id = randomUUID();
      const fail = await form(custH, { clientRequestId: id });
      assert.equal(fail.status, 502); assert.equal(fail.body.code, "EMAIL_DELIVERY_FAILED");
      assert.equal((await q("SELECT email_status FROM support_messages WHERE client_message_id = $1", [id]))[0].email_status, "failed");

      gw.state.status = 200;
      const retry = await form(custH, { clientRequestId: id });
      assert.equal(retry.status, 201); assert.equal(retry.body.data.status, "accepted");
      assert.equal((await q("SELECT count(*)::int n FROM support_messages WHERE client_message_id = $1", [id]))[0].n, 1);

      const calls = gw.state.calls.length;
      const again = await form(custH, { clientRequestId: id });
      assert.equal(again.status, 201); assert.equal(gw.state.calls.length, calls, "an already-accepted message is never emailed twice");
    });
    it("an unreachable gateway fails cleanly", async () => {
      const dead = await boot({ PHARMACY_SUPPORT_EMAIL: "pharmacy@vyra.example", NOTIFY_DRIVER: "webhook", NOTIFY_WEBHOOK_URL: "http://127.0.0.1:1/send", NOTIFY_WEBHOOK_SECRET: SECRET, NOTIFY_TIMEOUT_MS: "1500" });
      try {
        const u = await makeUser(dead.container); const h = auth((await loginAs(dead.request, u)).token);
        const res = await dead.request.post("/api/support/messages").set(h).send({ topic: "pharmacist", body: "hello", clientRequestId: randomUUID() });
        assert.equal(res.status, 502); assert.equal(res.body.code, "EMAIL_DELIVERY_FAILED");
        assert.ok(!JSON.stringify(res.body).includes("127.0.0.1"), "internal URLs never leak to the client");
      } finally { await dead.container.services.supportRealtime.stop(); await dead.container.services.realtime.stop(); await dead.close(); }
    });
    it("two simultaneous submissions of the same request send exactly one email", async () => {
      reset(); gw.state.delayMs = 400;
      const id = randomUUID();
      const [a, b] = await Promise.all([form(custH, { clientRequestId: id }), form(custH, { clientRequestId: id })]);
      const statuses = [a.status, b.status].sort();
      assert.ok(statuses[0] === 201 && (statuses[1] === 201 || statuses[1] === 409), `got ${statuses}`);
      assert.equal(gw.state.calls.length, 1, "only one email left the building");
      if (statuses[1] === 409) assert.equal([a, b].find((r) => r.status === 409).body.code, "SUBMISSION_IN_PROGRESS");
    });
    it("general topics go to the general support address and never to the pharmacist inbox", async () => {
      reset();
      const res = await form(custH, { topic: "delivery", body: "My rider hasn't arrived", prescriptionId: undefined });
      assert.equal(res.status, 201);
      assert.equal(gw.state.calls[0].body.to, "help@vyra.example");
      const inbox = (await ctx.request.get("/api/support/inbox").set(pharmH).query({ status: "all", pageSize: 50 })).body.data.conversations;
      assert.ok(!JSON.stringify(inbox).includes("rider hasn't arrived"));
    });
    it("validates: empty / over-long / unknown topic / missing request id / someone else's order", async () => {
      assert.equal((await form(custH, { body: "  " })).status, 400);
      assert.equal((await form(custH, { body: "x".repeat(2001) })).status, 400);
      assert.equal((await form(custH, { topic: "weather" })).status, 400);
      assert.equal((await form(custH, { clientRequestId: undefined })).status, 400);
      assert.equal((await form(custH, { orderId: otherOrderId })).status, 404);
    });
    it("form messages show up in the same thread, with their email status", async () => {
      const msgs = (await ctx.request.get("/api/support/chat").set(custH)).body.data.messages;
      assert.ok(msgs.some((m) => m.via === "form" && m.email?.status === "accepted"));
    });
  });

  describe("unconfigured environments are honest", () => {
    it("console/disabled notifier → the form refuses with EMAIL_NOT_CONFIGURED and stores nothing; call/chat contact still resolve", async () => {
      const bare = await boot({ PHARMACY_SUPPORT_EMAIL: "pharmacy@vyra.example" }); // NOTIFY_DRIVER=console: logging is not delivery
      try {
        const u = await makeUser(bare.container); const h = auth((await loginAs(bare.request, u)).token);
        const res = await bare.request.post("/api/support/messages").set(h).send({ topic: "pharmacist", body: "hello", clientRequestId: randomUUID() });
        assert.equal(res.status, 503); assert.equal(res.body.code, "EMAIL_NOT_CONFIGURED");
        assert.equal((await bare.container.pool.query("SELECT count(*)::int n FROM support_messages m JOIN support_conversations c ON c.id = m.conversation_id WHERE c.customer_id = $1", [u.id])).rows[0].n, 0);
        const contact = (await bare.request.get("/api/support/contact").set(h)).body.data;
        assert.equal(contact.email.pharmacy.canSend, false);
        assert.equal(contact.phone, null, "no PHARMACY_PHONE and no branch asked for → no number, never a made-up one");
      } finally { await bare.container.services.supportRealtime.stop(); await bare.container.services.realtime.stop(); await bare.close(); }
    });
    it("a real gateway but no recipient address configured is also refused", async () => {
      const noTo = await boot({ NOTIFY_DRIVER: "webhook", NOTIFY_WEBHOOK_URL: gw.url, NOTIFY_WEBHOOK_SECRET: SECRET });
      try {
        const u = await makeUser(noTo.container); const h = auth((await loginAs(noTo.request, u)).token);
        const res = await noTo.request.post("/api/support/messages").set(h).send({ topic: "pharmacist", body: "hello", clientRequestId: randomUUID() });
        assert.equal(res.status, 503); assert.equal(res.body.code, "EMAIL_NOT_CONFIGURED");
      } finally { await noTo.container.services.supportRealtime.stop(); await noTo.container.services.realtime.stop(); await noTo.close(); }
    });
  });

  describe("reaching a human while everyone is offline", () => {
    it("a new customer question queues a content-free alert to the pharmacy mailbox", async () => {
      const u = await makeUser(ctx.container); const h = auth((await loginAs(ctx.request, u)).token);
      await send(h, "SECRET-SYMPTOM-TEXT please help");
      const alerts = await q("SELECT to_address, subject, body FROM notification_outbox WHERE type = 'support.pharmacy_alert' ORDER BY id DESC LIMIT 1");
      assert.equal(alerts[0].to_address, "pharmacy@vyra.example");
      assert.ok(!/SECRET-SYMPTOM/.test(alerts[0].body + alerts[0].subject), "message text never goes in the alert");
    });
    it("no alert email while a pharmacist is online (they get it in the console)", async () => {
      await ctx.request.put("/api/support/availability").set(pharmH).send({ available: true });
      const before = (await q("SELECT count(*)::int n FROM notification_outbox WHERE type = 'support.pharmacy_alert'"))[0].n;
      const u = await makeUser(ctx.container); const h = auth((await loginAs(ctx.request, u)).token);
      await send(h, "online case");
      assert.equal((await q("SELECT count(*)::int n FROM notification_outbox WHERE type = 'support.pharmacy_alert'"))[0].n, before);
      await ctx.request.put("/api/support/availability").set(pharmH).send({ available: false });
    });
  });

  describe("resolve / reopen", () => {
    it("pharmacist resolves (audited); the customer's next message reopens it", async () => {
      const u = await makeUser(ctx.container); const h = auth((await loginAs(ctx.request, u)).token);
      await send(h, "question");
      const convId = (await q("SELECT id FROM support_conversations WHERE customer_id = $1 AND department = 'pharmacy'", [u.id]))[0].id;
      const res = await ctx.request.post(`/api/support/inbox/${convId}/resolve`).set(pharmH);
      assert.equal(res.body.data.conversation.status, "resolved");
      assert.equal((await ctx.request.get("/api/support/inbox").set(pharmH).query({ status: "resolved", pageSize: 50 })).body.data.conversations.some((c) => c.id === convId), true);
      assert.equal((await q("SELECT count(*)::int n FROM audit_logs WHERE action = 'support.conversation.resolved' AND entity_id = $1", [convId]))[0].n, 1);
      await send(h, "one more thing");
      assert.equal((await ctx.request.get(`/api/support/inbox/${convId}`).set(pharmH)).body.data.conversation.status, "open");
    });
  });

  describe("live updates (SSE)", () => {
    it("customer and pharmacist streams receive each other's messages in real time; no stream without a thread; no cross-access", async () => {
      const u = await makeUser(ctx.container); const h = auth((await loginAs(ctx.request, u)).token);
      const tok = (hh) => hh.Authorization.slice(7);
      const none = await openSse(base, "/api/support/chat/stream", tok(h));
      assert.equal(none.status, 404); assert.equal(none.body.code, "CHAT_NOT_STARTED");

      await send(h, "hello pharmacist");
      const convId = (await q("SELECT id FROM support_conversations WHERE customer_id = $1 AND department = 'pharmacy'", [u.id]))[0].id;
      const cs = await openSse(base, "/api/support/chat/stream", tok(h));
      const ps = await openSse(base, `/api/support/inbox/${convId}/stream`, tok(pharmH));
      assert.equal(cs.status, 200); assert.equal(ps.status, 200);
      try {
        await cs.waitFor((e) => e.event === "support");
        await ps.waitFor((e) => e.event === "support");

        await ctx.request.post(`/api/support/inbox/${convId}/messages`).set(pharmH).send({ body: "live reply", clientMessageId: randomUUID() });
        const got = await cs.waitFor((e) => e.event === "support" && e.data.messages.some((m) => m.body === "live reply"));
        assert.equal(got.data.messages.find((m) => m.body === "live reply").sender, "staff");

        await send(h, "live question");
        await ps.waitFor((e) => e.event === "support" && e.data.messages.some((m) => m.body === "live question"));
      } finally { cs.close(); ps.close(); }

      const foreign = await openSse(base, `/api/support/inbox/${convId}/stream`, tok(h));
      assert.equal(foreign.status, 403, "a customer can't open the staff stream for even their own thread");
    });
  });

  describe("abuse protection", () => {
    it("rate limits chat messages per user (429 with a stable code)", async () => {
      const limited = await boot({ DISABLE_RATE_LIMIT: "false" });
      try {
        const u = await makeUser(limited.container); const h = auth((await loginAs(limited.request, u)).token);
        let last;
        for (let i = 0; i < 32; i++) last = await limited.request.post("/api/support/chat/messages").set(h).send({ body: `m${i}`, clientMessageId: randomUUID() });
        assert.equal(last.status, 429); assert.equal(last.body.code, "RATE_LIMITED");
        const other2 = await makeUser(limited.container); const h2 = auth((await loginAs(limited.request, other2)).token);
        assert.equal((await limited.request.post("/api/support/chat/messages").set(h2).send({ body: "fine", clientMessageId: randomUUID() })).status, 201, "limits are per user, not shared");
      } finally { await limited.container.services.supportRealtime.stop(); await limited.container.services.realtime.stop(); await limited.close(); }
    });
  });
});
