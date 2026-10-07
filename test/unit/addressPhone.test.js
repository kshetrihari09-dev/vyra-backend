import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAddressesService } from "../../src/services/addresses.service.js";
import { createPhoneTrust } from "../../src/services/phoneTrust.js";

const db = { addresses: [], verified: new Set(), challenges: [], sms: [], audit: [], seq: 0 };
const users = { u1: { mobile: "9812345678" }, u2: { mobile: "9800000002" } };
const repos = {
  users: { getAccess: async (_d, id) => users[id] },
  addresses: {
    list: async (_d, uid) => db.addresses.filter((a) => a.user_id === uid),
    get: async (_d, uid, id) => db.addresses.find((a) => a.id === id && a.user_id === uid) || null,
    clearDefault: async () => {},
    insert: async (_d, uid, a) => { const r = { id: `a${++db.seq}`, user_id: uid, ...a, label: a.label, line1: a.line1, phone: a.phone, is_default: !!a.isDefault, lat: null }; db.addresses.push(r); return r; },
    update: async (_d, uid, id, a) => { const r = db.addresses.find((x) => x.id === id); Object.assign(r, { phone: a.phone, line1: a.line1 }); return r; },
    remove: async () => true, setDefault: async () => ({}),
    isPhoneVerified: async (_d, uid, m) => db.verified.has(`${uid}:${m}`),
    markPhoneVerified: async (_d, uid, m) => { db.verified.add(`${uid}:${m}`); },
    countRecentPhoneChallenges: async (_d, uid) => db.challenges.filter((c) => c.payload.userId === uid).length,
  },
  sessions: {
    countRecentOtpChallenges: async (_d, m) => db.challenges.filter((c) => c.mobile === m).length,
    insertOtpChallenge: async (_d, c) => { db.challenges.push({ ...c, attempts: 0, consumed_at: null, expires_at: c.expiresAt, code_hash: c.codeHash }); },
    findOtpChallengeForUpdate: async (_d, id) => db.challenges.find((c) => c.id === id) || null,
    bumpOtpAttempts: async (_d, id) => { db.challenges.find((c) => c.id === id).attempts++; },
    consumeOtpChallenge: async (_d, id) => { db.challenges.find((c) => c.id === id).consumed_at = new Date(); },
  },
};
const pool = {}; const withTx = (fn) => fn({});
const config = { auth: { refreshSecret: "s" }, otp: { length: 4, ttlSeconds: 300, maxAttempts: 5, maxStartsPerMobilePerHour: 5, devCode: "1234" } };
const notifier = { sendSms: async (m) => { db.sms.push(m); } };
const audit = { log: async (e) => { db.audit.push(e); } };
const phoneTrust = createPhoneTrust({ repos });
const svc = createAddressesService({ pool, withTx, repos, config, notifier, audit, phoneTrust });

describe("delivery phone confirmation (addresses service)", () => {
  it("login number is trusted; any other number needs a code sent to it; limits and audit hold", async () => {
  const base = { label: "Home", name: "A", line1: "1 Rd", isDefault: false };
  const code = (e) => e.code;

  // login number (any formatting) is trusted
  assert.ok((await svc.create("u1", { ...base, phone: "+977 98-1234 5678" })).id);
  assert.equal(db.addresses[0].phone, "9812345678");
  // another number is refused until confirmed
  await assert.rejects(svc.create("u1", { ...base, phone: "9811111111" }), (e) => code(e) === "PHONE_NOT_VERIFIED");
  // non-Nepal / landline can't even start
  await assert.rejects(svc.startPhoneVerification("u1", "+1 555 0190"), (e) => code(e) === "PHONE_NOT_SUPPORTED");
  // login number needs no text
  assert.deepEqual(await svc.startPhoneVerification("u1", "9812345678"), { verified: true, phone: "9812345678" });
  // start → code goes to the NEW number
  const st = await svc.startPhoneVerification("u1", "9811111111");
  assert.equal(st.verified, false); assert.equal(db.sms.at(-1).to, "9811111111");
  // someone else can't use this challenge; wrong code counts attempts
  await assert.rejects(svc.verifyPhone("u2", { challengeId: st.challengeId, code: "1234" }), (e) => code(e) === "INVALID_CODE");
  await assert.rejects(svc.verifyPhone("u1", { challengeId: st.challengeId, code: "0000" }), (e) => code(e) === "INVALID_CODE");
  assert.equal(db.challenges[0].attempts, 1);
  // right code → remembered, owner of the login number gets a heads-up, address saves
  assert.deepEqual(await svc.verifyPhone("u1", { challengeId: st.challengeId, code: "1234" }), { verified: true, phone: "9811111111" });
  assert.equal(db.sms.at(-1).to, "9812345678"); assert.match(db.sms.at(-1).text, /98\*\*\*\*1111/);
  assert.ok((await svc.create("u1", { ...base, phone: "9811111111" })).id);
  // replaying a used challenge fails; the confirmed number is per user
  await assert.rejects(svc.verifyPhone("u1", { challengeId: st.challengeId, code: "1234" }), (e) => code(e) === "INVALID_CODE");
  await assert.rejects(svc.create("u2", { ...base, phone: "9811111111" }), (e) => code(e) === "PHONE_NOT_VERIFIED");
  // editing an address to a new unconfirmed number is refused too
  await assert.rejects(svc.update("u1", "a1", { ...base, phone: "9822222222" }), (e) => code(e) === "PHONE_NOT_VERIFIED");
  // per-account cap on codes
  for (let i = 0; i < 4; i++) await svc.startPhoneVerification("u1", `98333333${30 + i}`);
  await assert.rejects(svc.startPhoneVerification("u1", "9844444444"), (e) => code(e) === "OTP_RATE_LIMITED");
  // address cap
  for (let i = db.addresses.filter((a) => a.user_id === "u1").length; i < 10; i++) await svc.create("u1", { ...base, phone: "9812345678" });
  await assert.rejects(svc.create("u1", { ...base, phone: "9812345678" }), (e) => code(e) === "ADDRESS_LIMIT");
  // audit never holds a full number
  assert.ok(db.audit.length > 3); assert.ok(!JSON.stringify(db.audit).includes("9811111111"));
  });
});
