import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../../src/config/env.js";
import { createNotifier } from "../../src/services/notifier.js";

const brevo = { apiKey: "xkeysib-" + "a".repeat(30), senderEmail: "no-reply@vyra.example", senderName: "Vyra", smsSender: "Vyra", countryCode: "977" };
const make = (reply = { ok: true, status: 201 }) => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); if (reply instanceof Error) throw reply; return reply; };
  return { calls, n: createNotifier({ driver: "brevo", logger: console, brevo, fetchImpl }) };
};
const base = { NODE_ENV: "test", DATABASE_URL: "postgres://x", JWT_SECRET: "a".repeat(40), JWT_REFRESH_SECRET: "b".repeat(40), DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") };

describe("Brevo notifier", () => {
  it("sends SMS via transactionalSMS/send with the api-key header and a country-coded recipient", async () => {
    const { calls, n } = make(); await n.sendSms({ to: "9812345678", text: "Your Vyra verification code is 123456." });
    assert.equal(calls[0].url, "https://api.brevo.com/v3/transactionalSMS/send");
    assert.equal(calls[0].init.headers["api-key"], brevo.apiKey);
    assert.deepEqual(calls[0].body, { sender: "Vyra", recipient: "9779812345678", content: "Your Vyra verification code is 123456.", type: "transactional" });
    assert.equal(n.deliversExternally, true);
  });
  it("leaves numbers that already carry a country code alone", async () => {
    const { calls, n } = make(); await n.sendSms({ to: "+977 981-234-5678", text: "x" }); await n.sendSms({ to: "919812345678", text: "x" });
    assert.deepEqual(calls.map((c) => c.body.recipient), ["9779812345678", "919812345678"]);
  });
  it("sends email via smtp/email with a verified sender and optional reply-to", async () => {
    const { calls, n } = make(); await n.sendEmail({ to: "a@b.com", subject: "Hi", text: "Body", replyTo: "c@d.com" });
    assert.equal(calls[0].url, "https://api.brevo.com/v3/smtp/email");
    assert.deepEqual(calls[0].body, { sender: { name: "Vyra", email: "no-reply@vyra.example" }, to: [{ email: "a@b.com" }], subject: "Hi", textContent: "Body", replyTo: { email: "c@d.com" } });
  });
  it("turns a Brevo failure into a clean 503 for the customer and logs Brevo's reason for the operator — never the key, number or message", async () => {
    const logs = [];
    const fetchImpl = async () => ({ ok: false, status: 402, json: async () => ({ code: "not_enough_credits", message: "Not enough credits" }) });
    const n = createNotifier({ driver: "brevo", logger: { error: (m, d) => logs.push([m, d]) }, brevo, fetchImpl });
    await assert.rejects(() => n.sendSms({ to: "9812345678", text: "secret-otp-999" }), (e) => {
      assert.equal(e.status, 503); assert.equal(e.code, "NOTIFIER_FAILED");
      assert.equal(/xkeysib|9812345678|secret-otp|Brevo/.test(e.message), false); return true;
    });
    assert.equal(logs[0][1].brevoCode, "not_enough_credits"); assert.equal(logs[0][1].status, 402);
    assert.equal(/xkeysib|9812345678|secret-otp/.test(JSON.stringify(logs)), false);
    const down = createNotifier({ driver: "brevo", logger: { error() {} }, brevo, fetchImpl: async () => { throw Object.assign(new Error("boom"), { name: "TimeoutError" }); } });
    await assert.rejects(() => down.sendEmail({ to: "a@b.com", subject: "s", text: "t" }), (e) => e.code === "NOTIFIER_FAILED");
  });
});

describe("NOTIFY_DRIVER=brevo config", () => {
  const ok = { ...base, NOTIFY_DRIVER: "brevo", BREVO_API_KEY: "xkeysib-" + "a".repeat(30), BREVO_SENDER_EMAIL: "no-reply@vyra.example" };
  it("accepts a complete configuration", () => { const c = loadConfig(ok).notify; assert.equal(c.driver, "brevo"); assert.equal(c.brevo.countryCode, "977"); assert.equal(c.brevo.smsSender, "Vyra"); });
  it("requires the key, a sender email and a valid SMS sender", () => {
    assert.throws(() => loadConfig({ ...ok, BREVO_API_KEY: "" }), /BREVO_API_KEY/);
    assert.throws(() => loadConfig({ ...ok, BREVO_SENDER_EMAIL: "nope" }), /BREVO_SENDER_EMAIL/);
    assert.throws(() => loadConfig({ ...ok, BREVO_SMS_SENDER: "Vyra Pharmacy Store" }), /BREVO_SMS_SENDER/);
  });
});
