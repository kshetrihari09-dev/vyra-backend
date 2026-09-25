import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toErrorResponse } from "../../src/middleware/errorHandler.js";
import { AppError, conflict, forbidden } from "../../src/utils/errors.js";

describe("error → response mapping", () => {
  it("AppError keeps status, code and message in the documented envelope", () => {
    const r = toErrorResponse(conflict("INSUFFICIENT_STOCK", "Insufficient stock"), "req-1");
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { success: false, message: "Insufficient stock", code: "INSUFFICIENT_STOCK" });
    assert.equal(toErrorResponse(forbidden(), "r").status, 403);
  });

  it("validation details pass through", () => {
    const r = toErrorResponse(new AppError(400, "VALIDATION_ERROR", "bad", [{ path: "body.mobile", message: "x" }]), "r");
    assert.deepEqual(r.body.details, [{ path: "body.mobile", message: "x" }]);
  });

  it("database errors are translated without leaking constraint names or SQL", () => {
    const unique = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), { code: "23505", detail: "Key (email)=(a@b.c) already exists." });
    const r = toErrorResponse(unique, "r");
    assert.equal(r.status, 409);
    assert.ok(!JSON.stringify(r.body).includes("users_email_key"));
    assert.ok(!JSON.stringify(r.body).includes("a@b.c"));
    assert.equal(toErrorResponse(Object.assign(new Error("x"), { code: "22P02" }), "r").status, 400);
    assert.equal(toErrorResponse(Object.assign(new Error("x"), { code: "40001" }), "r").body.code, "TRANSACTION_CONFLICT");
  });

  it("body-parser errors are client errors", () => {
    assert.equal(toErrorResponse(Object.assign(new Error("x"), { type: "entity.parse.failed" }), "r").status, 400);
    assert.equal(toErrorResponse(Object.assign(new Error("x"), { type: "entity.too.large" }), "r").status, 413);
  });

  it("unexpected errors become a generic 500 with only a request id — no message, stack or credentials", () => {
    const r = toErrorResponse(new Error("connect ECONNREFUSED postgres://vyra:hunter2@db:5432/vyra"), "req-9");
    assert.equal(r.status, 500);
    assert.equal(r.body.code, "INTERNAL_ERROR");
    assert.equal(r.body.requestId, "req-9");
    assert.ok(!JSON.stringify(r.body).includes("hunter2"));
  });
});
