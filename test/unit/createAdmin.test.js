import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAdmin } from "../../src/scripts/create-admin.js";

// Minimal fake pool: records queries so we can assert on behaviour without a database.
function fakePool({ existing = null } = {}) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql: sql.trim().split(/\s+/).slice(0, 3).join(" "), params });
      if (/^SELECT id, is_demo/i.test(sql.trim())) return { rows: existing ? [existing] : [] };
      if (/^INSERT INTO users/i.test(sql.trim())) return { rows: [{ id: "new-id" }] };
      if (/^INSERT INTO user_roles/i.test(sql.trim())) return { rowCount: 1 };
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client }, calls };
}

describe("create-admin", () => {
  it("creates a new admin with a hashed password and grants the admin role", async () => {
    const { pool, calls } = fakePool();
    const r = await createAdmin(pool, { email: "Dev@Example.com", name: "Dev", password: "a-long-passphrase-42" });
    assert.deepEqual([r.created, r.roleGranted], [true, true]);
    const insert = calls.find((c) => c.sql.startsWith("INSERT INTO users"));
    assert.equal(insert.params[1], "dev@example.com");
    assert.match(insert.params[3], /^scrypt\$/); // never stored in plain text
    assert.ok(calls.some((c) => c.sql === "COMMIT"));
  });
  it("rejects weak / short passwords and demo accounts, rolling back", async () => {
    await assert.rejects(() => createAdmin(fakePool().pool, { email: "a@b.co", name: "A", password: "short1" }), /at least/);
    await assert.rejects(() => createAdmin(fakePool().pool, { email: "a@b.co", name: "A", password: "onlyletterspasswordx" }), /number/);
    await assert.rejects(() => createAdmin(fakePool({ existing: { id: "x", is_demo: true, status: "active" } }).pool, { email: "a@b.co" }), /demo/);
  });
  it("promotes an existing account without needing or changing a password", async () => {
    const { pool, calls } = fakePool({ existing: { id: "u1", is_demo: false, status: "active" } });
    const r = await createAdmin(pool, { email: "a@b.co" });
    assert.deepEqual([r.created, r.roleGranted], [false, true]);
    assert.ok(!calls.some((c) => c.sql.startsWith("INSERT INTO users")));
  });
});
