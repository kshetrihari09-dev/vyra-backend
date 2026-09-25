import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { createUsersService } from "../../src/services/users.service.js";
import { createFakeRepos, fakeAudit, fakeClock } from "../helpers/fakes.js";

const ctx = { ip: "203.0.113.5", requestId: "r" };

function setup() {
  const { db, repos } = createFakeRepos(fakeClock());
  const audit = fakeAudit();
  const service = createUsersService({ pool: {}, withTx: (fn) => fn({}), repos, audit });
  const add = async (name, roles, status = "active") => {
    const id = await repos.users.create({}, { fullName: name, email: `${name.toLowerCase()}@x.example`, passwordHash: "h" });
    db.users.find((u) => u.id === id).status = status;
    for (const r of roles) await repos.roles.addUserRole({}, id, r);
    return id;
  };
  const actor = async (id) => { const row = await repos.users.getAccess({}, id); return { id, name: row.full_name, roles: row.roles }; };
  return { db, repos, audit, service, add, actor };
}

describe("admin user management", () => {
  let e, admin1, admin2, customer, rider;
  beforeEach(async () => {
    e = setup();
    admin1 = await e.add("Ada", ["admin"]);
    admin2 = await e.add("Bo", ["admin"]);
    customer = await e.add("Cy", ["customer"]);
    rider = await e.add("Dee", ["delivery"]);
  });

  it("changes roles, revokes sessions and audits old + new values", async () => {
    await e.repos.sessions.insertRefreshToken({}, { userId: customer, familyId: "f", tokenHash: "t", expiresAt: new Date("2030-01-01") });
    const out = await e.service.setRoles(await e.actor(admin1), customer, ["customer", "pharmacist"], ctx);
    assert.deepEqual(out.roles, ["customer", "pharmacist"]);
    assert.ok(e.db.refresh.every((r) => r.revokedAt), "existing sessions are revoked so new permissions apply at next sign-in");
    const entry = e.audit.entries.at(-1);
    assert.equal(entry.action, "user.roles_changed");
    assert.deepEqual(entry.oldValue.roles, ["customer"]);
    assert.deepEqual(entry.newValue.roles, ["customer", "pharmacist"]);
  });

  it("rejects unknown roles", async () => {
    await assert.rejects(e.service.setRoles(await e.actor(admin1), customer, ["superuser"], ctx), { code: "UNKNOWN_ROLE" });
  });

  it("nobody can change their own roles or status", async () => {
    await assert.rejects(e.service.setRoles(await e.actor(admin1), admin1, ["customer"], ctx), { code: "CANNOT_MODIFY_SELF" });
    await assert.rejects(e.service.setStatus(await e.actor(admin1), admin1, { status: "suspended" }, ctx), { code: "CANNOT_MODIFY_SELF" });
  });

  it("suspending revokes sessions and is audited with the reason", async () => {
    await e.repos.sessions.insertRefreshToken({}, { userId: rider, familyId: "f", tokenHash: "t2", expiresAt: new Date("2030-01-01") });
    const out = await e.service.setStatus(await e.actor(admin1), rider, { status: "suspended", reason: "fraud review" }, ctx);
    assert.equal(out.status, "suspended");
    assert.ok(e.db.refresh.every((r) => r.revokedAt));
    assert.equal(e.audit.entries.at(-1).newValue.reason, "fraud review");
  });

  it("refuses to remove the last active administrator (by role change or suspension)", async () => {
    await e.service.setStatus(await e.actor(admin1), admin2, { status: "suspended" }, ctx); // admin1 remains
    await assert.rejects(e.service.setRoles(await e.actor(customer), admin1, ["customer"], ctx), { code: "LAST_ADMIN" });
    await assert.rejects(e.service.setStatus(await e.actor(customer), admin1, { status: "suspended" }, ctx), { code: "LAST_ADMIN" });
  });

  it("404s for unknown users", async () => {
    await assert.rejects(e.service.setStatus(await e.actor(admin1), "00000000-0000-4000-8000-999999999999", { status: "suspended" }, ctx), { code: "USER_NOT_FOUND" });
  });

  it("lists with filters and pagination metadata", async () => {
    const page = await e.service.list({ role: "admin", page: 1, pageSize: 1 });
    assert.equal(page.total, 2);
    assert.equal(page.items.length, 1);
    assert.ok(!("passwordHash" in page.items[0]));
  });
});
