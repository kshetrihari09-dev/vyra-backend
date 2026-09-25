import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { boot, loginAs, makeUser, skipReason, uniq } from "./helpers.js";

describe("auth API (real Postgres)", { skip: skipReason }, () => {
  let ctx;
  before(async () => { ctx = await boot(); });
  after(async () => { await ctx?.close(); });

  const mobile = () => `98${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

  it("registration: start → verify creates a customer, sets an httpOnly refresh cookie, returns an access token", async () => {
    const m = mobile();
    const start = await ctx.request.post("/api/auth/register/start").send({ name: "Test Person", mobile: m, email: `r-${uniq()}@test.example`, password: "Passw0rd1" });
    assert.equal(start.status, 202);
    const verify = await ctx.request.post("/api/auth/register/verify").send({ challengeId: start.body.data.challengeId, code: "1234" });
    assert.equal(verify.status, 201);
    assert.deepEqual(verify.body.data.user.roles, ["customer"]);
    const cookie = verify.headers["set-cookie"].join(";");
    assert.match(cookie, /vyra_rt=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
  });

  it("validation errors use the standard envelope", async () => {
    const res = await ctx.request.post("/api/auth/register/start").send({ name: "", mobile: "123", password: "short" });
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.code, "VALIDATION_ERROR");
    assert.ok(Array.isArray(res.body.details));
  });

  it("login → /me → refresh → logout", async () => {
    const u = await makeUser(ctx.container);
    const { token, cookies } = await loginAs(ctx.request, u);
    assert.ok(token);
    const me = await ctx.request.get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    assert.equal(me.status, 200);
    assert.equal(me.body.data.user.email, u.email);

    const noHeader = await ctx.request.post("/api/auth/refresh").set("Cookie", cookies);
    assert.equal(noHeader.status, 403); // CSRF guard: custom header required
    const refreshed = await ctx.request.post("/api/auth/refresh").set("Cookie", cookies).set("X-Vyra-Client", "web");
    assert.equal(refreshed.status, 200);
    assert.ok(refreshed.body.data.accessToken);

    const out = await ctx.request.post("/api/auth/logout").set("Cookie", refreshed.headers["set-cookie"]).set("X-Vyra-Client", "web");
    assert.equal(out.status, 200);
    const again = await ctx.request.post("/api/auth/refresh").set("Cookie", refreshed.headers["set-cookie"]).set("X-Vyra-Client", "web");
    assert.equal(again.status, 401);
  });

  it("wrong password → 401 INVALID_CREDENTIALS; requests without a token → 401", async () => {
    const u = await makeUser(ctx.container);
    const bad = await ctx.request.post("/api/auth/login").send({ identifier: u.email, password: "nope" });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.code, "INVALID_CREDENTIALS");
    assert.equal((await ctx.request.get("/api/auth/me")).status, 401);
    assert.equal((await ctx.request.get("/api/auth/me").set("Authorization", "Bearer garbage")).status, 401);
  });

  it("a suspended user's still-valid access token stops working immediately", async () => {
    const admin = await makeUser(ctx.container, { roles: ["admin"] });
    const victim = await makeUser(ctx.container);
    const v = await loginAs(ctx.request, victim);
    const a = await loginAs(ctx.request, admin);
    const res = await ctx.request.patch(`/api/admin/users/${victim.id}/status`).set("Authorization", `Bearer ${a.token}`).send({ status: "suspended", reason: "test" });
    assert.equal(res.status, 200);
    assert.equal((await ctx.request.get("/api/auth/me").set("Authorization", `Bearer ${v.token}`)).status, 401);
  });
});

describe("authorization (real Postgres)", { skip: skipReason }, () => {
  let ctx;
  before(async () => { ctx = await boot(); });
  after(async () => { await ctx?.close(); });

  it("a normal customer cannot reach any admin API (403), and anonymous gets 401", async () => {
    const customer = await makeUser(ctx.container);
    const { token } = await loginAs(ctx.request, customer);
    const h = { Authorization: `Bearer ${token}` };
    assert.equal((await ctx.request.get("/api/admin/users").set(h)).status, 403);
    assert.equal((await ctx.request.get("/api/admin/roles").set(h)).status, 403);
    assert.equal((await ctx.request.patch(`/api/admin/users/${customer.id}/status`).set(h).send({ status: "suspended" })).status, 403);
    assert.equal((await ctx.request.put(`/api/admin/users/${customer.id}/roles`).set(h).send({ roles: ["admin"] })).status, 403);
    assert.equal((await ctx.request.get("/api/admin/users")).status, 401);
  });

  it("a pharmacist cannot manage users or assign roles; an admin can", async () => {
    const pharmacist = await makeUser(ctx.container, { roles: ["pharmacist"] });
    const admin = await makeUser(ctx.container, { roles: ["admin"] });
    const target = await makeUser(ctx.container);
    const p = await loginAs(ctx.request, pharmacist);
    const a = await loginAs(ctx.request, admin);
    assert.equal((await ctx.request.put(`/api/admin/users/${target.id}/roles`).set("Authorization", `Bearer ${p.token}`).send({ roles: ["admin"] })).status, 403);
    const ok = await ctx.request.put(`/api/admin/users/${target.id}/roles`).set("Authorization", `Bearer ${a.token}`).send({ roles: ["customer", "pharmacist"] });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.data.user.roles, ["customer", "pharmacist"]);
  });

  it("role changes are written to the audit log with old and new values", async () => {
    const admin = await makeUser(ctx.container, { roles: ["admin"] });
    const target = await makeUser(ctx.container);
    const a = await loginAs(ctx.request, admin);
    await ctx.request.put(`/api/admin/users/${target.id}/roles`).set("Authorization", `Bearer ${a.token}`).send({ roles: ["customer", "warehouse"] });
    const { rows } = await ctx.container.pool.query("SELECT old_value, new_value, actor_user_id FROM audit_logs WHERE action = 'user.roles_changed' AND entity_id = $1", [target.id]);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].old_value.roles, ["customer"]);
    assert.deepEqual(rows[0].new_value.roles, ["customer", "warehouse"]);
    assert.equal(rows[0].actor_user_id, admin.id);
  });

  it("audit_logs is append-only at the database level", async () => {
    await assert.rejects(ctx.container.pool.query("UPDATE audit_logs SET action = 'tampered'"), /append-only/);
    await assert.rejects(ctx.container.pool.query("DELETE FROM audit_logs"), /append-only/);
  });

  it("errors never leak internals", async () => {
    const res = await ctx.request.get("/api/admin/users/not-a-uuid").set("Authorization", "Bearer x");
    assert.ok([400, 401].includes(res.status));
    assert.ok(!JSON.stringify(res.body).match(/stack|postgres|SELECT/i));
    assert.equal((await ctx.request.get("/api/nope")).body.code, "ROUTE_NOT_FOUND");
  });
});
