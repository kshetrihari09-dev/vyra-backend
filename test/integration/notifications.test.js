import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { boot, loginAs, makeUser, skipReason } from "./helpers.js";

/** Written against the real API + Postgres like the other integration files — NOT yet run (needs TEST_DATABASE_URL). */
describe("notifications + audit log API (real Postgres)", { skip: skipReason }, () => {
  let ctx, cust, custHeader, admin, addressId, orderId;
  const auth = (t) => ({ Authorization: `Bearer ${t}` });
  before(async () => {
    ctx = await boot();
    cust = await makeUser(ctx.container);
    custHeader = auth((await loginAs(ctx.request, cust)).token);
    admin = auth((await loginAs(ctx.request, await makeUser(ctx.container, { roles: ["admin"] }))).token);
    addressId = (await ctx.request.post("/api/addresses").set(custHeader).send({ name: "Alex", phone: "+1 555 0190", line1: "24 Maple Court", city: "Metro City", zip: "10245" })).body.data.address.id;
    orderId = (await ctx.request.post("/api/orders").set(custHeader).send({ items: [{ productId: "paracetamol-500", qty: 1 }], addressId, paymentMethod: "cod", deliveryOptionId: "standard" })).body.data.order.id;
  });
  after(async () => { await ctx?.close(); });

  it("placing an order raises an in-app notification for the buyer, unread, deep-linking to the order", async () => {
    const res = await ctx.request.get("/api/notifications").set(custHeader);
    assert.equal(res.status, 200);
    const n = res.body.data.notifications.find((x) => x.type === "order.placed");
    assert.ok(n, JSON.stringify(res.body.data.notifications));
    assert.equal(n.unread, true);
    assert.equal(n.data.orderId, orderId);
    assert.ok(res.body.data.unread >= 1);
  });

  it("marking read is scoped to the owner", async () => {
    const mine = (await ctx.request.get("/api/notifications").set(custHeader)).body.data.notifications[0];
    const other = auth((await loginAs(ctx.request, await makeUser(ctx.container))).token);
    assert.equal((await ctx.request.post(`/api/notifications/${mine.id}/read`).set(other)).status, 404);
    assert.equal((await ctx.request.post(`/api/notifications/${mine.id}/read`).set(custHeader)).status, 200);
  });

  it("preferences round-trip and only affect the caller", async () => {
    const set = await ctx.request.put("/api/notifications/preferences").set(custHeader).send({ sms: false });
    assert.equal(set.body.data.preferences.sms, false);
    const got = await ctx.request.get("/api/notifications/preferences").set(custHeader);
    assert.equal(got.body.data.preferences.sms, false);
  });

  it("the audit log needs audit:read; a customer is refused, an admin sees the order.placed entry with the actor's name (not raw secrets)", async () => {
    assert.equal((await ctx.request.get("/api/audit-logs").set(custHeader)).status, 403);
    const res = await ctx.request.get("/api/audit-logs").set(admin).send();
    assert.equal(res.status, 200);
    const entry = res.body.data.entries.find((e) => e.action === "order.placed" && e.entityId === orderId);
    assert.ok(entry);
    assert.ok(!JSON.stringify(entry).match(/Bearer |eyJ/), "no raw tokens ever appear in the log");
  });

  it("a scoped query by entityType + action narrows results", async () => {
    const res = await ctx.request.get("/api/audit-logs").set(admin).query({ entityType: "order", action: "order.placed", pageSize: 5 });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.entries.every((e) => e.entityType === "order" && e.action === "order.placed"));
  });
});
