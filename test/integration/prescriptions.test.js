import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { boot, loginAs, makeUser, skipReason } from "./helpers.js";

/* The existing prescription system had only fake-backed unit tests, so its SQL never ran against a real schema. These do. */
describe("prescriptions API (real Postgres)", { skip: skipReason }, () => {
  let ctx, pool, pharmacist, owner, other;
  const auth = (a) => ({ Authorization: `Bearer ${a.token}` });
  const insertRx = async (userId, status = "pending") => {
    const { rows: [r] } = await pool.query(`INSERT INTO prescriptions (user_id, status, file_key, file_name, mime_type, size_bytes) VALUES ($1,$2,'k','rx.pdf','application/pdf',10) RETURNING id`, [userId, status]);
    await pool.query("INSERT INTO prescription_items (prescription_id, product_id) VALUES ($1,'amoxicillin-500')", [r.id]);
    return r.id;
  };

  before(async () => {
    ctx = await boot(); pool = ctx.container.pool;
    const ownerUser = await makeUser(ctx.container, { roles: ["customer"] }); const otherUser = await makeUser(ctx.container, { roles: ["customer"] });
    pharmacist = await loginAs(ctx.request, await makeUser(ctx.container, { roles: ["pharmacist"] }));
    owner = { ...(await loginAs(ctx.request, ownerUser)), id: ownerUser.user?.id ?? ownerUser.id };
    other = await loginAs(ctx.request, otherUser);
  });
  after(async () => { await ctx?.close(); });

  it("the pharmacist console lists everyone's prescriptions WITH the customer's name (this query used a column that does not exist)", async () => {
    const id = await insertRx(owner.id, "pending");
    const r = await ctx.request.get("/api/prescriptions").query({ status: "pending" }).set(auth(pharmacist));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const mine = r.body.data.prescriptions.find((p) => p.id === id);
    assert.ok(mine, "listed"); assert.ok(mine.customerName, "customer name joined"); assert.deepEqual(mine.items, ["amoxicillin-500"]);
  });
  it("a customer lists only their own", async () => {
    const id = await insertRx(owner.id);
    assert.ok((await ctx.request.get("/api/prescriptions").set(auth(owner))).body.data.prescriptions.some((p) => p.id === id));
    assert.ok(!(await ctx.request.get("/api/prescriptions").set(auth(other))).body.data.prescriptions.some((p) => p.id === id));
  });
});
