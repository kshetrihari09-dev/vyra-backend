import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../../src/config/env.js";
import { createNotifier } from "../../src/services/notifier.js";
import { createSupportService } from "../../src/services/support.service.js";
import { cleanText, formBody, sendBody } from "../../src/validators/support.validators.js";

const base = { NODE_ENV: "test", DATABASE_URL: "postgres://x", JWT_SECRET: "a".repeat(40), JWT_REFRESH_SECRET: "b".repeat(40), DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") };
const uuid = "123e4567-e89b-42d3-a456-426614174000";

describe("notifier says whether it really delivers", () => {
  const logger = { info() {} };
  it("console and disabled are NOT delivery; webhook is", () => {
    assert.equal(createNotifier({ driver: "console", logger }).deliversExternally, false);
    assert.equal(createNotifier({ driver: "disabled", logger }).deliversExternally, false);
    assert.equal(createNotifier({ driver: "webhook", logger, webhookUrl: "https://g.example/x", webhookSecret: "s".repeat(32) }).deliversExternally, true);
  });
  it("webhook passes replyTo only when given", async () => {
    const bodies = [];
    const n = createNotifier({ driver: "webhook", logger, webhookUrl: "https://g.example/x", webhookSecret: "s".repeat(32), fetchImpl: async (_u, o) => { bodies.push(JSON.parse(o.body)); return { ok: true }; } });
    await n.sendEmail({ to: "a@b.co", subject: "s", text: "t" });
    await n.sendEmail({ to: "a@b.co", subject: "s", text: "t", replyTo: "c@d.co" });
    assert.equal("replyTo" in bodies[0], false); assert.equal(bodies[1].replyTo, "c@d.co");
  });
});

describe("support config", () => {
  it("is empty (features disabled) when nothing is configured — no demo fallbacks", () => {
    const c = loadConfig(base).support;
    assert.equal(c.pharmacyPhone, null); assert.equal(c.pharmacyEmail, null); assert.equal(c.generalEmail, null);
  });
  it("normalises the phone for tel: and rejects junk", () => {
    assert.deepEqual(loadConfig({ ...base, PHARMACY_PHONE: "+977 (981) 234-5678" }).support.pharmacyPhone, { display: "+977 (981) 234-5678", tel: "+9779812345678" });
    assert.throws(() => loadConfig({ ...base, PHARMACY_PHONE: "call me" }), /PHARMACY_PHONE/);
    assert.throws(() => loadConfig({ ...base, PHARMACY_SUPPORT_EMAIL: "nope" }), /PHARMACY_SUPPORT_EMAIL/);
  });
});

describe("support validators", () => {
  it("cleanText strips control/zero-width chars and normalises newlines", () => {
    assert.equal(cleanText("  a\u0000b\u200Bc\r\n\r\n\r\n\r\nd  "), "abc\n\nd");
  });
  it("rejects blank and over-long text, and bad ids", () => {
    assert.equal(sendBody.safeParse({ body: " \n ", clientMessageId: uuid }).success, false);
    assert.equal(sendBody.safeParse({ body: "x".repeat(2001), clientMessageId: uuid }).success, false);
    assert.equal(sendBody.safeParse({ body: "ok", clientMessageId: "x" }).success, false);
    assert.equal(formBody.safeParse({ topic: "pharmacist", body: "ok", clientRequestId: uuid }).success, true);
    assert.equal(formBody.safeParse({ topic: "nope", body: "ok", clientRequestId: uuid }).success, false);
  });
});

describe("support service: contact resolution and masking", () => {
  const make = ({ config, branch, rows = [] }) => createSupportService({
    pool: {}, withTx: async () => {}, notifications: {}, realtime: {}, audit: {}, logger: {},
    notifier: { deliversExternally: true },
    repos: { support: {
      onlinePharmacists: async () => [], findByCustomer: async () => null,
      branchContact: async () => branch, getById: async () => ({ department: "pharmacy", customer_name: "C" }),
      listMessages: async () => ({ rows, hasMore: false }), unread: async () => 0,
    } },
    config: { notify: { driver: "webhook" }, support: { pharmacyPhone: null, pharmacyEmail: "p@x.co", generalEmail: null, presenceTtlSeconds: 180 }, isProd: false, appUrl: "", ...config },
  });
  const branch = { id: "store-01", name: "Central", phone: "+1 555 0142", is_demo: true };

  it("falls back to the store line outside production", async () => {
    const c = await make({ branch }).contact(null, { branchId: "store-01" });
    assert.equal(c.phone.source, "branch"); assert.equal(c.phone.tel, "+15550142");
  });
  it("in production a demo store's number is NEVER offered; a real one is", async () => {
    const prod = { isProd: true };
    assert.equal((await make({ config: prod, branch }).contact(null, { branchId: "store-01" })).phone, null);
    assert.equal((await make({ config: prod, branch: { ...branch, is_demo: false } }).contact(null, { branchId: "store-01" })).phone.tel, "+15550142");
  });
  it("a malformed branch phone is ignored rather than put in a tel: link", async () => {
    assert.equal((await make({ branch: { ...branch, phone: "ext 12" } }).contact(null, { branchId: "store-01" })).phone, null);
  });
  it("email is only 'sendable' with a real channel AND a recipient", async () => {
    const svc = make({ branch: null });
    assert.equal(svc.emailCapability("pharmacy").configured, true);
    assert.equal(svc.emailCapability("general").configured, false);
  });
  it("order/prescription details are hidden from staff who lack the permission for them", async () => {
    const row = { id: "m1", seq: "1", sender_role: "customer", sender_name: "C", via: "chat", body: "hi", created_at: new Date(), order_id: "o1", order_number: "VY-1", product_id: null, prescription_id: "r1", prescription_status: "pending" };
    const svc = make({ branch: null, rows: [row] });
    const none = await svc.inboxMessages({ id: "p", permissions: ["support:pharmacist"] }, uuid, {});
    assert.equal(none.messages[0].refs.order, null); assert.equal(none.messages[0].refs.prescription, null);
    const full = await svc.inboxMessages({ id: "p", permissions: ["support:pharmacist", "orders:read_all", "prescriptions:read_all"] }, uuid, {});
    assert.equal(full.messages[0].refs.order.number, "VY-1"); assert.equal(full.messages[0].refs.prescription.status, "pending");
  });
  it("staff methods refuse callers without support:pharmacist even if a route forgot to", async () => {
    await assert.rejects(() => make({ branch: null }).inbox({ id: "x", permissions: [] }, { status: "open", page: 1, pageSize: 10 }), { status: 403 });
  });
});
