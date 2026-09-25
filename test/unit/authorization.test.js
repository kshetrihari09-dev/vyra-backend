import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PERMISSIONS, ROLES, ROLE_KEYS, STAFF_ROLES, isStaffRole } from "../../src/config/permissions.js";
import { requireAnyPermission, requirePermission, requireRole } from "../../src/middleware/authenticate.js";
import { toUserDto } from "../../src/models/user.model.js";

const run = (mw, auth) => new Promise((resolve) => mw({ auth }, {}, (err) => resolve(err ?? null)));
const as = (roles, permissions) => ({ user: { id: "u", roles, permissions } });

describe("role / permission catalogue", () => {
  it("has the required roles", () => {
    for (const r of ["customer", "admin", "pharmacist", "seller", "delivery", "warehouse", "accountant"]) assert.ok(ROLE_KEYS.includes(r), r);
  });
  it("every granted permission exists", () => {
    for (const [role, def] of Object.entries(ROLES)) for (const p of def.permissions) assert.ok(PERMISSIONS[p], `${role} → ${p}`);
  });
  it("customers hold no back-office permission; admin holds them all", () => {
    assert.deepEqual(ROLES.customer.permissions, []);
    assert.equal(ROLES.admin.permissions.length, Object.keys(PERMISSIONS).length);
  });
  it("least privilege spot-checks", () => {
    assert.ok(!ROLES.pharmacist.permissions.includes("inventory:adjust"));
    assert.ok(!ROLES.warehouse.permissions.includes("payouts:approve"));
    assert.ok(!ROLES.accountant.permissions.includes("roles:assign"));
    assert.ok(!ROLES.seller.permissions.includes("sellers:approve"));
    assert.deepEqual(ROLES.delivery.permissions, ["delivery:rider"]);
  });
  it("seller and customer are not staff", () => {
    assert.ok(!isStaffRole(["customer", "seller"]));
    assert.ok(STAFF_ROLES.every((r) => isStaffRole([r])));
  });
});

describe("authorization middleware", () => {
  it("401 when unauthenticated, 403 when authenticated but lacking the permission", async () => {
    assert.equal((await run(requirePermission("users:read"), undefined)).status, 401);
    const err = await run(requirePermission("users:read"), as(["customer"], []));
    assert.equal(err.status, 403);
    assert.equal(err.code, "FORBIDDEN");
  });
  it("allows when every required permission is held", async () => {
    assert.equal(await run(requirePermission("users:read", "users:manage"), as(["admin"], ["users:read", "users:manage"])), null);
    assert.equal((await run(requirePermission("users:read", "users:manage"), as(["x"], ["users:read"]))).status, 403);
  });
  it("any-of and role guards", async () => {
    assert.equal(await run(requireAnyPermission("a:b", "c:d"), as([], ["c:d"])), null);
    assert.equal((await run(requireAnyPermission("a:b", "c:d"), as([], []))).status, 403);
    assert.equal(await run(requireRole("delivery"), as(["delivery"], [])), null);
    assert.equal((await run(requireRole("delivery"), as(["customer"], []))).status, 403);
  });
});

describe("user DTO", () => {
  it("exposes roles/permissions, a UI-only isStaff hint, and never the password hash", () => {
    const dto = toUserDto({ id: "1", full_name: "A", email: "a@x.y", mobile: "9812345678", status: "active", roles: ["pharmacist"], permissions: ["prescriptions:review"], password_hash: "SECRET", created_at: "2026-01-02T00:00:00Z" });
    assert.equal(dto.isStaff, true);
    assert.equal(dto.phone, "9812345678");
    assert.equal(dto.memberSince, "2026-01-02");
    assert.ok(!JSON.stringify(dto).includes("SECRET"));
  });
});
