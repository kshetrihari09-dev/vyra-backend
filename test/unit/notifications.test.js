import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import { TEMPLATES } from "../../src/notifications/templates.js";
import { createNotificationsService, NOTIFICATION_OUTBOX_RULES } from "../../src/services/notifications.service.js";
import { createNotifier } from "../../src/services/notifier.js";
import { createRetentionJob } from "../../src/jobs/retention.js";
import { createScheduler } from "../../src/jobs/scheduler.js";
import { loadConfig } from "../../src/config/env.js";
import { createFakeNotifications } from "../helpers/notificationFakes.js";

const silent = { info() {}, error() {}, warn() {} };
const alice = { id: "u-alice", name: "Alice", permissions: [] };
const bob = { id: "u-bob", name: "Bob", permissions: [] };
const contacts = () => ({
  "u-alice": { id: "u-alice", email: "alice@example.com", mobile: "9801234567", notify_email: true, notify_sms: true },
  "u-bob": { id: "u-bob", email: null, mobile: "9807654321", notify_email: true, notify_sms: false },
});
function setup({ notifier, externalEnabled = true } = {}) {
  const fake = createFakeNotifications({ users: contacts() });
  const sent = [];
  const n = notifier ?? { sendSms: async (m) => { sent.push({ channel: "sms", ...m }); }, sendEmail: async (m) => { sent.push({ channel: "email", ...m }); } };
  const svc = createNotificationsService({ pool: {}, repo: fake.repo, notifier: n, logger: silent, externalEnabled });
  return { ...fake, svc, sent };
}
const SAMPLE = { orderId: "o1", number: "PN-3081", total: 42.5, riderName: "Daniel R.", reason: "customer unreachable", note: "n", amount: 10, shopName: "Fresh", prescriptionId: "rx1", applicationId: "app1" };

describe("templates", () => {
  it("every template renders with sample data, has a kind, and never mentions a handover code value", () => {
    for (const [type, t] of Object.entries(TEMPLATES)) {
      assert.ok(t.kind, type);
      const text = `${t.title(SAMPLE)} ${t.message(SAMPLE)}`;
      assert.ok(text.length > 10, type);
      assert.ok(!/undefined|NaN|\[object/.test(text), `${type}: ${text}`);
      assert.ok(!/\b\d{4}\b/.test(text.replace(/PN-3081/, "")), `${type} must not contain a 4-digit code: ${text}`);
    }
  });
  it("the out-for-delivery message tells the customer to open the app, not the code", () => {
    assert.match(TEMPLATES["delivery.out_for_delivery"].message({ number: "PN-1" }), /Open the app/);
  });
});

describe("emit", () => {
  it("writes an inbox row and keeps only deep-link ids in data", async () => {
    const e = setup();
    const row = await e.svc.emit({}, { userId: "u-alice", type: "order.placed", data: { orderId: "o1", number: "PN-1", total: 5, secret: "x" } });
    assert.equal(row.title, "Order placed");
    assert.deepEqual(row.data, { orderId: "o1" });
    assert.match(row.message, /PN-1.*Rs\. 5\.00/);
  });
  it("queues email for email-enabled types only, respecting the user's opt-outs and missing addresses", async () => {
    const e = setup();
    await e.svc.emit({}, { userId: "u-alice", type: "order.placed", data: { number: "PN-1", total: 1 } });        // email: true
    await e.svc.emit({}, { userId: "u-alice", type: "order.packed", data: { number: "PN-1" } });                   // in-app only
    await e.svc.emit({}, { userId: "u-bob", type: "order.placed", data: { number: "PN-2", total: 1 } });           // bob has no email
    await e.svc.emit({}, { userId: "u-bob", type: "delivery.out_for_delivery", data: { number: "PN-2" } });        // sms, but bob opted out
    await e.svc.emit({}, { userId: "u-alice", type: "delivery.out_for_delivery", data: { number: "PN-1" } });      // sms ok
    assert.deepEqual(e.db.outbox.map((o) => [o.user_id, o.channel, o.to_address]), [["u-alice", "email", "alice@example.com"], ["u-alice", "sms", "9801234567"]]);
    assert.equal(e.db.inbox.length, 5, "in-app rows are unaffected by opt-outs");
  });
  it("does not queue external messages when the driver is disabled", async () => {
    const e = setup({ externalEnabled: false });
    await e.svc.emit({}, { userId: "u-alice", type: "order.placed", data: { number: "PN-1", total: 1 } });
    assert.equal(e.db.outbox.length, 0);
    assert.equal(e.db.inbox.length, 1);
  });
  it("an unknown type throws (typos fail loudly) and a missing user is a no-op", async () => {
    const e = setup();
    await assert.rejects(e.svc.emit({}, { userId: "u-alice", type: "order.plaecd" }), /Unknown notification type/);
    assert.equal(await e.svc.emit({}, { userId: null, type: "order.placed", data: {} }), null);
  });
});

describe("inbox API", () => {
  let e;
  beforeEach(async () => {
    e = setup();
    await e.svc.emit({}, { userId: "u-alice", type: "order.packed", data: { orderId: "o1", number: "PN-1" } });
    await e.svc.emit({}, { userId: "u-alice", type: "order.cancelled", data: { orderId: "o2", number: "PN-2" } });
    await e.svc.emit({}, { userId: "u-bob", type: "order.packed", data: { orderId: "o3", number: "PN-3" } });
  });
  it("lists only my notifications, newest first, with the unread count", async () => {
    const r = await e.svc.list(alice);
    assert.equal(r.notifications.length, 2);
    assert.equal(r.unread, 2);
    assert.equal(r.notifications[0].type, "order.cancelled");
    assert.ok(r.notifications.every((n) => n.unread === true && n.data.orderId));
  });
  it("marking read is scoped to the owner — someone else's id is 'not found'", async () => {
    const [first] = (await e.svc.list(alice)).notifications;
    const bobsId = (await e.svc.list(bob)).notifications[0].id;
    await assert.rejects(e.svc.markRead(alice, bobsId), { code: "NOTIFICATION_NOT_FOUND" });
    assert.equal((await e.svc.list(bob)).unread, 1, "bob's is untouched");
    assert.deepEqual(await e.svc.markRead(alice, first.id), { unread: 1 });
    assert.deepEqual(await e.svc.markRead(alice, first.id), { unread: 1 }, "idempotent");
    await assert.rejects(e.svc.markRead(alice, "nope"), { code: "NOTIFICATION_NOT_FOUND" });
  });
  it("read-all only touches the caller; unread filter works; preferences round-trip", async () => {
    await e.svc.markAllRead(alice);
    assert.equal((await e.svc.list(alice, { unread: true })).notifications.length, 0);
    assert.equal((await e.svc.list(bob)).unread, 1);
    assert.deepEqual(await e.svc.setPreferences(bob, { sms: true }), { email: true, sms: true });
    assert.deepEqual(await e.svc.getPreferences(alice), { email: true, sms: true });
  });
});

describe("outbox worker", () => {
  it("sends due messages once, over the right channel", async () => {
    const e = setup();
    await e.svc.emit({}, { userId: "u-alice", type: "order.placed", data: { number: "PN-1", total: 1 } });
    await e.svc.emit({}, { userId: "u-alice", type: "delivery.out_for_delivery", data: { number: "PN-1" } });
    assert.deepEqual(await e.svc.processOutbox(), { sent: 2, retried: 0, dead: 0 });
    assert.deepEqual(e.sent.map((m) => [m.channel, m.to]), [["email", "alice@example.com"], ["sms", "9801234567"]]);
    assert.deepEqual(await e.svc.processOutbox(), { sent: 0, retried: 0, dead: 0 }, "nothing is sent twice");
    assert.deepEqual(await e.svc.outboxStats(), { sent: 2 });
  });
  it("a failing provider is retried with growing delays, then marked dead — and never throws out", async () => {
    const notifier = { sendSms: async () => { throw new Error("gateway responded 503"); }, sendEmail: async () => {} };
    const e = setup({ notifier });
    await e.svc.emit({}, { userId: "u-alice", type: "delivery.out_for_delivery", data: { number: "PN-1" } });
    const row = e.db.outbox[0];
    const delays = [];
    for (let attempt = 1; attempt <= NOTIFICATION_OUTBOX_RULES.maxAttempts; attempt++) {
      row.next_attempt_at = new Date(0); // make it due
      const r = await e.svc.processOutbox();
      if (attempt < NOTIFICATION_OUTBOX_RULES.maxAttempts) { assert.equal(r.retried, 1); delays.push(Math.round((row.next_attempt_at - Date.now()) / 1000)); }
      else assert.equal(r.dead, 1);
    }
    assert.equal(row.status, "dead");
    assert.match(row.last_error, /503/);
    assert.ok(delays.every((d, i) => i === 0 || d > delays[i - 1] * 3), `exponential: ${delays}`);
    assert.deepEqual(await e.svc.processOutbox(), { sent: 0, retried: 0, dead: 0 });
  });
  it("a row whose worker died mid-send is reclaimed after its lease, and a live lease is respected", async () => {
    const e = setup();
    await e.svc.emit({}, { userId: "u-alice", type: "order.placed", data: { number: "PN-1", total: 1 } });
    const claimed = await e.repo.claimDue({}, { limit: 10, leaseSeconds: 120 });      // worker A takes it, then "crashes"
    assert.equal(claimed.length, 1);
    assert.equal((await e.repo.claimDue({}, { limit: 10, leaseSeconds: 120 })).length, 0, "lease still valid → worker B must not double-send");
    e.db.outbox[0].locked_until = new Date(Date.now() - 1000);
    assert.equal((await e.svc.processOutbox()).sent, 1);
  });
});

describe("webhook notifier", () => {
  const base = { driver: "webhook", logger: silent, webhookUrl: "https://gw.example.com/send", webhookSecret: "s".repeat(40), clock: () => 1_700_000_000_000 };
  it("POSTs signed JSON: signature = HMAC(secret, `${timestamp}.${body}`)", async () => {
    let call;
    const n = createNotifier({ ...base, fetchImpl: async (url, init) => { call = { url, init }; return { ok: true, status: 200 }; } });
    await n.sendSms({ to: "9801234567", text: "hi" });
    assert.equal(call.url, "https://gw.example.com/send");
    assert.deepEqual(JSON.parse(call.init.body), { channel: "sms", to: "9801234567", text: "hi" });
    const expected = createHmac("sha256", base.webhookSecret).update(`1700000000000.${call.init.body}`).digest("hex");
    assert.equal(call.init.headers["x-vyra-signature"], `sha256=${expected}`);
    assert.equal(call.init.headers["x-vyra-timestamp"], "1700000000000");
    assert.equal(call.init.redirect, "error");
    await n.sendEmail({ to: "a@b.c", subject: "S", text: "t" });
    assert.deepEqual(JSON.parse(call.init.body), { channel: "email", to: "a@b.c", subject: "S", text: "t" });
  });
  it("throws generic errors (no URL, no message text) on non-2xx, network failure and timeout", async () => {
    const mk = (fetchImpl) => createNotifier({ ...base, fetchImpl });
    await assert.rejects(mk(async () => ({ ok: false, status: 502 })).sendSms({ to: "1", text: "OTP 999" }), (e) => e.message === "notification gateway responded 502");
    await assert.rejects(mk(async () => { throw new Error("connect ECONNREFUSED gw.example.com"); }).sendSms({ to: "1", text: "x" }), (e) => e.message === "notification gateway unreachable");
    await assert.rejects(mk(async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }).sendSms({ to: "1", text: "x" }), /timed out/);
  });
  it("the disabled driver refuses; console just logs", async () => {
    await assert.rejects(createNotifier({ driver: "disabled", logger: silent }).sendSms({ to: "1", text: "x" }), { code: "NOTIFIER_UNAVAILABLE" });
    const logs = []; await createNotifier({ driver: "console", logger: { info: (...a) => logs.push(a) } }).sendSms({ to: "1", text: "x" });
    assert.equal(logs.length, 1);
  });
});

describe("scheduler", () => {
  it("never overlaps a job with itself, survives a failing job, and stop() waits", async () => {
    const errors = []; let running = 0; let maxRunning = 0; let calls = 0;
    const s = createScheduler({ logger: { info() {}, error: (...a) => errors.push(a) }, jobs: [
      { name: "slow", everyMs: 1e9, run: async () => { running++; maxRunning = Math.max(maxRunning, running); calls++; await new Promise((r) => setTimeout(r, 30)); running--; } },
      { name: "bad", everyMs: 1e9, run: async () => { throw new Error("boom"); } },
    ] });
    const [a, b] = await Promise.all([s.tick("slow"), s.tick("slow")]);
    assert.equal(maxRunning, 1);
    assert.equal(calls, 1);
    assert.ok(a.skipped || b.skipped);
    assert.deepEqual(await s.tick("bad"), { error: true });
    assert.equal(errors.length, 1);
    assert.deepEqual(await s.tick("slow"), { result: undefined }, "a finished job can run again");
    await s.stop();
  });
});

describe("retention", () => {
  it("purges the right tables in batches, never audit_logs, and reports counts", async () => {
    const queries = [];
    const pool = { query: async (sql) => { queries.push(sql); return { rowCount: 3 }; } };
    const out = await createRetentionJob({ pool, logger: silent }).run();
    const tables = queries.map((q) => /(?:DELETE FROM|FROM) (\w+)/.exec(q)?.[1]);
    for (const t of ["refresh_tokens", "password_resets", "otp_challenges", "notifications", "notification_outbox", "delivery_locations"]) assert.ok(tables.includes(t), t);
    assert.ok(!queries.some((q) => /audit_logs|orders |payments/.test(q)));
    assert.ok(queries.filter((q) => /^DELETE FROM \w+ WHERE ctid IN/.test(q)).every((q) => /LIMIT \d+/.test(q)), "batched");
    assert.equal(out.refresh_tokens, 3);
    assert.equal(out.delivery_locations_orphaned, 3);
  });
  it("keeps deleting while batches come back full", async () => {
    let n = 0;
    const pool = { query: async () => ({ rowCount: n++ < 2 ? 5000 : 10 }) };
    const out = await createRetentionJob({ pool, logger: silent }).run();
    assert.equal(out.refresh_tokens, 10_010);
  });
});

describe("config", () => {
  const base = { DATABASE_URL: "postgres://x", JWT_SECRET: "a".repeat(40), JWT_REFRESH_SECRET: "b".repeat(40), DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") };
  it("jobs default on outside tests and off in tests; webhook driver needs URL + 32-char secret", () => {
    assert.equal(loadConfig({ ...base, NODE_ENV: "development" }).jobs.enabled, true);
    assert.equal(loadConfig({ ...base, NODE_ENV: "test" }).jobs.enabled, false);
    assert.throws(() => loadConfig({ ...base, NOTIFY_DRIVER: "webhook" }), /NOTIFY_WEBHOOK_URL/);
    assert.equal(loadConfig({ ...base, NOTIFY_DRIVER: "webhook", NOTIFY_WEBHOOK_URL: "http://localhost:9000", NOTIFY_WEBHOOK_SECRET: "s".repeat(32) }).notify.driver, "webhook");
  });
});

describe("preflight", () => {
  const cfg = (o = {}) => ({ isProd: true, nodeEnv: "production", cookie: { secure: true }, trustProxy: 1, rateLimit: { enabled: true }, otp: { devCode: null },
    cors: { origins: ["https://shop.example.com"] }, notify: { driver: "webhook", webhookUrl: "https://gw.example.com/x" }, jobs: { enabled: true },
    payments: { manualWebhookSecret: "x" }, storage: { bucket: "b", accessKey: "k", secretKey: "s" }, ...o });
  const pool = (over = {}) => ({ query: async (sql) => {
    if (/SELECT 1$/.test(sql)) return { rows: [{}] };
    if (/schema_migrations/.test(sql)) return { rows: over.applied ?? ["001_auth_core.sql"].map((name) => ({ name })) };
    if (/FROM roles/.test(sql)) return { rows: [{ n: over.roles ?? 8 }] };
    if (/role_key = 'admin'/.test(sql)) return { rows: [{ n: over.admins ?? 1 }] };
    if (/vyra\.example/.test(sql)) return { rows: [{ n: over.demo ?? 0 }] };
    if (/status = 'dead'/.test(sql)) return { rows: [{ n: over.dead ?? 0 }] };
    return { rows: [{ n: over.stuck ?? 0 }] };
  } });
  const dir = new URL("../helpers/migrations-fixture/", import.meta.url);
  it("a healthy production setup passes with nothing failed", async () => {
    const { runPreflight } = await import("../../src/scripts/preflight.js");
    const r = await runPreflight({ config: cfg(), pool: pool({ applied: (await import("node:fs")).readdirSync(new URL("../../migrations/", import.meta.url)).map((name) => ({ name })) }) });
    assert.equal(r.failed, 0, JSON.stringify(r.checks.filter((c) => c.level !== "ok")));
  });
  it("fails on dev leftovers in production: console messaging, fixed OTP, demo accounts, no admin, pending migrations", async () => {
    const { runPreflight } = await import("../../src/scripts/preflight.js");
    const r = await runPreflight({ config: cfg({ notify: { driver: "console" }, otp: { devCode: "1234" }, cookie: { secure: false } }), pool: pool({ demo: 3, admins: 0 }) });
    const failed = r.checks.filter((c) => c.level === "FAIL").map((c) => c.name);
    for (const n of ["messaging", "OTP_DEV_CODE", "cookies", "demo accounts", "admin account", "migrations"]) assert.ok(failed.includes(n), `${n} in ${failed}`);
  });
  it("stops early and fails when the database is unreachable", async () => {
    const { runPreflight } = await import("../../src/scripts/preflight.js");
    const r = await runPreflight({ config: cfg(), pool: { query: async () => { throw new Error("ECONNREFUSED"); } } });
    assert.ok(r.checks.some((c) => c.name === "database" && c.level === "FAIL"));
    assert.ok(!r.checks.some((c) => c.name === "migrations"));
  });
});
