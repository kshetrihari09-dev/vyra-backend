import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../../src/config/env.js";
import { testEnv } from "../helpers/fakes.js";

const prod = (extra = {}) => testEnv({ NODE_ENV: "production", OTP_DEV_CODE: "", NOTIFY_DRIVER: "disabled", ...extra });

describe("environment validation", () => {
  it("accepts a complete development env", () => {
    const c = loadConfig(testEnv());
    assert.equal(c.port, 4000);
    assert.deepEqual(c.cors.origins, ["http://localhost:5173"]);
  });

  it("refuses to boot without secrets or a database", () => {
    assert.throws(() => loadConfig({ NODE_ENV: "development" }), /JWT_SECRET is required[\s\S]*JWT_REFRESH_SECRET is required[\s\S]*DATABASE_URL is required/);
  });

  it("rejects short, placeholder and identical secrets", () => {
    assert.throws(() => loadConfig(testEnv({ JWT_SECRET: "short" })), /at least 32/);
    assert.throws(() => loadConfig(testEnv({ JWT_SECRET: "change-me-".repeat(5) })), /placeholder/);
    assert.throws(() => loadConfig(testEnv({ JWT_REFRESH_SECRET: "a".repeat(40) })), /must be different/);
  });

  it("production: requires CORS origins, forbids '*', console notifier and the dev OTP", () => {
    assert.doesNotThrow(() => loadConfig(prod()));
    assert.throws(() => loadConfig(prod({ CORS_ORIGIN: "" })), /CORS_ORIGIN is required/);
    assert.throws(() => loadConfig(prod({ CORS_ORIGIN: "*" })), /must not be \*/);
    assert.throws(() => loadConfig(prod({ NOTIFY_DRIVER: "console" })), /not allowed in production/);
    assert.throws(() => loadConfig(prod({ OTP_DEV_CODE: "1234" })), /OTP_DEV_CODE must not be set/);
  });

  it("production defaults: secure cookies on, notifier disabled, rate limiting cannot be turned off", () => {
    const c = loadConfig(prod({ DISABLE_RATE_LIMIT: "true" }));
    assert.equal(c.cookie.secure, true);
    assert.equal(c.notify.driver, "disabled");
    assert.equal(c.rateLimit.enabled, true);
    assert.equal(loadConfig(testEnv({ DISABLE_RATE_LIMIT: "true" })).rateLimit.enabled, false);
  });
});
