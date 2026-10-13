import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { loadConfig } from "../../src/config/env.js";
import { buildIceServers } from "../../src/services/calls.ice.js";
import { endBody, signalBody, startBody } from "../../src/validators/calls.validators.js";

const base = { NODE_ENV: "test", DATABASE_URL: "postgres://x", JWT_SECRET: "a".repeat(40), JWT_REFRESH_SECRET: "b".repeat(40), DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") };
const prod = { ...base, NODE_ENV: "production", CORS_ORIGIN: "https://shop.example", PAYMENTS_MANUAL_WEBHOOK_SECRET: "x", NOTIFY_DRIVER: "disabled" };
const uuid = "123e4567-e89b-42d3-a456-426614174000";

describe("Vyra Call config", () => {
  it("defaults to enabled with a public STUN outside production", () => {
    const c = loadConfig(base).calls;
    assert.equal(c.enabled, true); assert.deepEqual(c.stunUrls, ["stun:stun.l.google.com:19302"]); assert.deepEqual(c.turnUrls, []);
  });
  it("stays OFF in production until TURN is configured (or STUN-only is explicitly accepted) — and says why", () => {
    assert.deepEqual([loadConfig(prod).calls.enabled, loadConfig(prod).calls.disabledReason], [false, "turn_not_configured"]);
    const secret = "s".repeat(40);
    assert.equal(loadConfig({ ...prod, CALLS_TURN_URLS: "turns:turn.example:443?transport=tcp", CALLS_TURN_SECRET: secret }).calls.enabled, true);
    assert.equal(loadConfig({ ...prod, CALLS_ALLOW_STUN_ONLY: "true", CALLS_STUN_URLS: "stun:stun.example:3478" }).calls.enabled, true);
    assert.equal(loadConfig({ ...base, CALLS_ENABLED: "false" }).calls.disabledReason, "disabled_by_config");
  });
  it("rejects malformed URLs and weak or orphaned TURN secrets", () => {
    assert.throws(() => loadConfig({ ...base, CALLS_STUN_URLS: "https://x" }), /CALLS_STUN_URLS/);
    assert.throws(() => loadConfig({ ...base, CALLS_TURN_URLS: "stun:x" }), /CALLS_TURN_URLS/);
    assert.throws(() => loadConfig({ ...base, CALLS_TURN_URLS: "turn:x:3478", CALLS_TURN_SECRET: "short" }), /CALLS_TURN_SECRET/);
    assert.throws(() => loadConfig({ ...base, CALLS_TURN_SECRET: "s".repeat(40) }), /CALLS_TURN_URLS/);
  });
});

describe("TURN credentials", () => {
  const calls = { stunUrls: ["stun:s:3478"], turnUrls: ["turn:t:3478"], turnSecret: "z".repeat(40), turnTtlSeconds: 600 };
  it("follow coturn's time-limited REST scheme and never include the shared secret", () => {
    const now = 1_700_000_000_000;
    const out = buildIceServers({ calls }, "user-1", now);
    const turn = out.iceServers.find((s) => s.credential);
    assert.equal(turn.username, `${1_700_000_600}:user-1`);
    assert.equal(turn.credential, createHmac("sha1", calls.turnSecret).update(turn.username).digest("base64"));
    assert.equal(JSON.stringify(out).includes(calls.turnSecret), false);
    assert.equal(out.relay, true);
  });
  it("different users and different times get different credentials", () => {
    const a = buildIceServers({ calls }, "u1", 1e12).iceServers[1]; const b = buildIceServers({ calls }, "u2", 1e12).iceServers[1];
    assert.notEqual(a.credential, b.credential);
  });
  it("STUN-only reports relay:false and no credentials", () => {
    const out = buildIceServers({ calls: { ...calls, turnUrls: [], turnSecret: "" } }, "u");
    assert.equal(out.relay, false); assert.equal(out.iceServers.some((s) => s.credential), false);
  });
});

describe("Vyra Call validators", () => {
  it("startBody needs a shop slug and a client uuid, and drops unknown fields", () => {
    assert.equal(startBody.safeParse({ sellerId: "fresh-grocers", clientCallId: uuid }).success, true);
    assert.equal(startBody.safeParse({ sellerId: "Bad Id", clientCallId: uuid }).success, false);
    assert.equal(startBody.safeParse({ sellerId: "x", clientCallId: "nope" }).success, false);
    assert.deepEqual(Object.keys(startBody.parse({ sellerId: "x", clientCallId: uuid, customerId: "evil" })).sort(), ["clientCallId", "sellerId"]);
  });
  it("signal payload must match its kind and carry nothing extra", () => {
    const sdp = (type) => ({ type, sdp: "v=0\r\n" });
    assert.equal(signalBody.safeParse({ kind: "offer", payload: sdp("offer") }).success, true);
    assert.equal(signalBody.safeParse({ kind: "offer", payload: sdp("answer") }).success, false);
    assert.equal(signalBody.safeParse({ kind: "answer", payload: sdp("answer") }).success, true);
    assert.equal(signalBody.safeParse({ kind: "ice", payload: { candidate: "", sdpMid: null, sdpMLineIndex: null } }).success, true, "end-of-candidates");
    assert.equal(signalBody.safeParse({ kind: "ice", payload: { candidate: "c", evil: 1 } }).success, false);
    assert.equal(signalBody.safeParse({ kind: "bye", payload: {} }).success, false);
    assert.equal(signalBody.safeParse({ kind: "offer", payload: { type: "offer", sdp: "x".repeat(20_001) } }).success, false);
  });
  it("end reason is limited to hangup|failed", () => {
    assert.equal(endBody.parse({}).reason, "hangup");
    assert.equal(endBody.safeParse({ reason: "completed" }).success, false);
  });
});
