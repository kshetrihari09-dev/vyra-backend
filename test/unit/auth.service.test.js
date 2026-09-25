import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { createAuthService } from "../../src/services/auth.service.js";
import { createFakeRepos, fakeAudit, fakeClock, fakeHasher, fakeNotifier, fakeTokens, testConfig } from "../helpers/fakes.js";

const ctx = { ip: "203.0.113.5", userAgent: "test", requestId: "req-1" };
const signup = { name: "Sabina Karki", mobile: "9812345678", email: "Sabina@Example.com", password: "Passw0rdOK" };

function setup(envExtra) {
  const clock = fakeClock();
  const { db, repos } = createFakeRepos(clock);
  const notifier = fakeNotifier();
  const audit = fakeAudit();
  const config = testConfig(envExtra);
  const service = createAuthService({
    config, pool: {}, withTx: (fn) => fn({}), repos, hasher: fakeHasher(), tokens: fakeTokens(), notifier, audit, clock,
  });
  return { clock, db, repos, notifier, audit, service, config };
}

async function register(env, body = signup) {
  const { challengeId } = await env.service.registerStart(body, ctx);
  return env.service.registerVerify({ challengeId, code: "1234" }, ctx);
}

describe("registration (mobile OTP)", () => {
  let env;
  beforeEach(() => { env = setup(); });

  it("creates nothing until the code is verified", async () => {
    await env.service.registerStart(signup, ctx);
    assert.equal(env.db.users.length, 0);
    assert.equal(env.notifier.sent.length, 1);
    assert.equal(env.notifier.sent[0].to, "9812345678");
  });

  it("creates user, customer profile and 'customer' role on a correct code, and signs in", async () => {
    const res = await register(env);
    assert.equal(env.db.users.length, 1);
    assert.equal(env.db.customers.length, 1);
    assert.deepEqual(res.user.roles, ["customer"]);
    assert.equal(res.user.email, "sabina@example.com"); // lower-cased
    assert.equal(res.user.phoneVerified, true);
    assert.ok(res.accessToken && res.refreshToken);
    assert.equal(res.user.isStaff, false);
  });

  it("never stores the plaintext password or OTP", async () => {
    await register(env);
    const blob = JSON.stringify(env.db);
    assert.ok(!blob.includes("Passw0rdOK"));
    assert.ok(!/"code"/.test(blob));
  });

  it("rejects a wrong code, counts the attempt, and locks the challenge after 5 misses", async () => {
    const { challengeId } = await env.service.registerStart(signup, ctx);
    for (let i = 0; i < 5; i++) await assert.rejects(env.service.registerVerify({ challengeId, code: "0000" }, ctx), { code: "INVALID_CODE" });
    await assert.rejects(env.service.registerVerify({ challengeId, code: "1234" }, ctx), { code: "TOO_MANY_ATTEMPTS" });
    assert.equal(env.db.users.length, 0);
  });

  it("rejects an expired code", async () => {
    const { challengeId } = await env.service.registerStart(signup, ctx);
    env.clock.advance(6 * 60_000);
    await assert.rejects(env.service.registerVerify({ challengeId, code: "1234" }, ctx), { code: "CODE_EXPIRED" });
  });

  it("a code cannot be used twice", async () => {
    const { challengeId } = await env.service.registerStart(signup, ctx);
    await env.service.registerVerify({ challengeId, code: "1234" }, ctx);
    await assert.rejects(env.service.registerVerify({ challengeId, code: "1234" }, ctx), { code: "INVALID_CODE" });
  });

  it("rejects an already-registered mobile or email", async () => {
    await register(env);
    await assert.rejects(env.service.registerStart({ ...signup, email: "other@example.com" }, ctx), { code: "MOBILE_TAKEN" });
    await assert.rejects(env.service.registerStart({ ...signup, mobile: "9800000000" }, ctx), { code: "EMAIL_TAKEN" });
  });

  it("limits how many codes one mobile can request per hour", async () => {
    for (let i = 0; i < 5; i++) await env.service.registerStart(signup, ctx);
    await assert.rejects(env.service.registerStart(signup, ctx), { code: "OTP_RATE_LIMITED" });
  });
});

describe("login", () => {
  let env;
  beforeEach(async () => { env = setup(); await register(env); });

  it("signs in by email or by mobile", async () => {
    assert.ok((await env.service.login({ identifier: "sabina@example.com", password: "Passw0rdOK" }, ctx)).accessToken);
    assert.ok((await env.service.login({ identifier: "9812345678", password: "Passw0rdOK" }, ctx)).accessToken);
  });

  it("gives the same error for unknown user and wrong password", async () => {
    const a = await env.service.login({ identifier: "nobody@example.com", password: "x" }, ctx).catch((e) => e);
    const b = await env.service.login({ identifier: "sabina@example.com", password: "wrong" }, ctx).catch((e) => e);
    assert.equal(a.code, "INVALID_CREDENTIALS");
    assert.equal(b.code, "INVALID_CREDENTIALS");
    assert.equal(a.message, b.message);
  });

  it("locks the account after repeated failures, even for the right password, then unlocks with time", async () => {
    for (let i = 0; i < 5; i++) await assert.rejects(env.service.login({ identifier: "sabina@example.com", password: "bad" }, ctx), { code: "INVALID_CREDENTIALS" });
    await assert.rejects(env.service.login({ identifier: "sabina@example.com", password: "Passw0rdOK" }, ctx), { code: "ACCOUNT_LOCKED" });
    assert.ok(env.audit.entries.some((e) => e.action === "auth.account_locked"));
    env.clock.advance(16 * 60_000);
    assert.ok((await env.service.login({ identifier: "sabina@example.com", password: "Passw0rdOK" }, ctx)).accessToken);
  });

  it("refuses suspended accounts only after the password is proven", async () => {
    env.db.users[0].status = "suspended";
    await assert.rejects(env.service.login({ identifier: "sabina@example.com", password: "Passw0rdOK" }, ctx), { code: "ACCOUNT_INACTIVE" });
    await assert.rejects(env.service.login({ identifier: "sabina@example.com", password: "nope" }, ctx), { code: "INVALID_CREDENTIALS" });
  });
});

describe("refresh tokens", () => {
  let env, session;
  beforeEach(async () => { env = setup(); session = await register(env); });

  it("rotates: the new token works, the old one is revoked", async () => {
    const next = await env.service.refresh(session.refreshToken, ctx);
    assert.notEqual(next.refreshToken, session.refreshToken);
    assert.equal(next.user.email, "sabina@example.com");
    env.clock.advance(60_000); // outside the concurrent-tab grace window
    await assert.rejects(env.service.refresh(session.refreshToken, ctx), { code: "INVALID_REFRESH_TOKEN" });
  });

  it("replaying a rotated token later revokes the whole family (theft response)", async () => {
    const next = await env.service.refresh(session.refreshToken, ctx);
    env.clock.advance(60_000);
    await assert.rejects(env.service.refresh(session.refreshToken, ctx), { code: "INVALID_REFRESH_TOKEN" });
    await assert.rejects(env.service.refresh(next.refreshToken, ctx), { code: "INVALID_REFRESH_TOKEN" }); // the thief's AND the victim's newest token are dead
  });

  it("a near-simultaneous second refresh (two tabs) is told to retry and does NOT revoke the family", async () => {
    const next = await env.service.refresh(session.refreshToken, ctx);
    await assert.rejects(env.service.refresh(session.refreshToken, ctx), { code: "REFRESH_TOKEN_ROTATED" });
    assert.ok((await env.service.refresh(next.refreshToken, ctx)).accessToken);
  });

  it("expired and unknown tokens are rejected", async () => {
    await assert.rejects(env.service.refresh("not-a-token", ctx), { code: "INVALID_REFRESH_TOKEN" });
    await assert.rejects(env.service.refresh(undefined, ctx), { code: "NO_REFRESH_TOKEN" });
    env.clock.advance(31 * 24 * 3600_000);
    await assert.rejects(env.service.refresh(session.refreshToken, ctx), { code: "INVALID_REFRESH_TOKEN" });
  });

  it("suspending the user kills their refresh tokens", async () => {
    env.db.users[0].status = "suspended";
    await assert.rejects(env.service.refresh(session.refreshToken, ctx), { code: "INVALID_REFRESH_TOKEN" });
  });

  it("logout revokes the session and is idempotent", async () => {
    await env.service.logout(session.refreshToken);
    await env.service.logout(session.refreshToken);
    await env.service.logout(undefined);
    await assert.rejects(env.service.refresh(session.refreshToken, ctx), { code: "INVALID_REFRESH_TOKEN" });
  });
});

describe("password reset & change", () => {
  let env;
  beforeEach(async () => { env = setup(); await register(env); });

  const tokenFromEmail = () => env.notifier.sent.at(-1).text.match(/token=([\w-]+)/)[1];

  it("forgot-password responds identically for unknown accounts and sends nothing", async () => {
    await env.service.forgotPassword({ identifier: "ghost@example.com" }, ctx);
    assert.equal(env.notifier.sent.filter((m) => m.channel === "email").length, 0);
  });

  it("emails a single-use link; resetting changes the password and signs out every session", async () => {
    const session = await env.service.login({ identifier: "sabina@example.com", password: "Passw0rdOK" }, ctx);
    await env.service.forgotPassword({ identifier: "sabina@example.com" }, ctx);
    const token = tokenFromEmail();
    await env.service.resetPassword({ token, password: "BrandNew123" }, ctx);

    await assert.rejects(env.service.login({ identifier: "sabina@example.com", password: "Passw0rdOK" }, ctx), { code: "INVALID_CREDENTIALS" });
    assert.ok((await env.service.login({ identifier: "sabina@example.com", password: "BrandNew123" }, ctx)).accessToken);
    await assert.rejects(env.service.refresh(session.refreshToken, ctx), { code: "INVALID_REFRESH_TOKEN" });
    await assert.rejects(env.service.resetPassword({ token, password: "AnotherOne1" }, ctx), { code: "INVALID_RESET_TOKEN" }); // single use
    assert.ok(env.audit.entries.some((e) => e.action === "auth.password_reset"));
  });

  it("reset links expire", async () => {
    await env.service.forgotPassword({ identifier: "sabina@example.com" }, ctx);
    const token = tokenFromEmail();
    env.clock.advance(31 * 60_000);
    await assert.rejects(env.service.resetPassword({ token, password: "BrandNew123" }, ctx), { code: "INVALID_RESET_TOKEN" });
  });

  it("change-password needs the current password and signs out other devices", async () => {
    const other = await env.service.login({ identifier: "sabina@example.com", password: "Passw0rdOK" }, ctx);
    const uid = env.db.users[0].id;
    await assert.rejects(env.service.changePassword(uid, { currentPassword: "wrong", newPassword: "BrandNew123" }, ctx), { code: "INVALID_CURRENT_PASSWORD" });
    const fresh = await env.service.changePassword(uid, { currentPassword: "Passw0rdOK", newPassword: "BrandNew123" }, ctx);
    assert.ok(fresh.refreshToken);
    await assert.rejects(env.service.refresh(other.refreshToken, ctx), { code: "INVALID_REFRESH_TOKEN" });
    assert.ok((await env.service.refresh(fresh.refreshToken, ctx)).accessToken);
  });
});
