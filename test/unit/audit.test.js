import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAuditService, redact, toAuditDto } from "../../src/services/audit.service.js";

const row = (o = {}) => ({ id: 7, at: new Date("2026-09-28T10:00:00Z"), actor_user_id: "u1", actor_label: "Admin (admin)", action: "user.roles_changed", entity_type: "user", entity_id: "u2", old_value: null, new_value: null, ip: "203.0.113.5", request_id: "r1", ...o });

describe("audit log viewer", () => {
  it("redacts sensitive keys at any depth, leaves the rest alone", () => {
    const out = redact({ status: "ok", password: "hunter2", nested: { refreshToken: "abc", accountNumber: "0011", list: [{ otp: "1234", name: "x" }] }, amount: 5 });
    assert.deepEqual(out, { status: "ok", password: "[redacted]", nested: { refreshToken: "[redacted]", accountNumber: "[redacted]", list: [{ otp: "[redacted]", name: "x" }] }, amount: 5 });
    assert.equal(redact(null), null);
    assert.equal(redact("str"), "str");
  });
  it("the DTO redacts on the way out even if something sensitive was logged by mistake", () => {
    const dto = toAuditDto(row({ new_value: { note: "fine", apiSecret: "s3", delivery_otp: "4821" } }));
    assert.deepEqual(dto.newValue, { note: "fine", apiSecret: "[redacted]", delivery_otp: "[redacted]" });
    assert.equal(dto.id, "7");
  });
  it("requires audit:read and passes filters + paging to the repository", async () => {
    let seen;
    const svc = createAuditService({ pool: {}, repo: { list: async (_p, q) => { seen = q; return { rows: [row()], total: 51 }; } } });
    await assert.rejects(svc.query({ id: "u", permissions: ["orders:read_all"] }, {}), { status: 403 });
    const r = await svc.query({ id: "a", permissions: ["audit:read"] }, { page: 3, pageSize: 10, actionPrefix: "seller_", entityType: "user" });
    assert.deepEqual([seen.limit, seen.offset, seen.actionPrefix, seen.entityType], [10, 20, "seller_", "user"]);
    assert.deepEqual([r.total, r.page, r.pageSize, r.entries.length], [51, 3, 10, 1]);
  });
});
