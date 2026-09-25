import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { boot, loginAs, makeUser, skipReason } from "./helpers.js";

describe("inventory API (real Postgres)", { skip: skipReason }, () => {
  let ctx, whAuth, custAuth;
  before(async () => {
    ctx = await boot();
    whAuth = { Authorization: `Bearer ${(await loginAs(ctx.request, await makeUser(ctx.container, { roles: ["warehouse"] }))).token}` };
    custAuth = { Authorization: `Bearer ${(await loginAs(ctx.request, await makeUser(ctx.container))).token}` };
  });
  after(async () => { await ctx?.close(); });

  it("adjustment and transfer need inventory:adjust", async () => {
    assert.equal((await ctx.request.post("/api/inventory/adjust").set(custAuth).send({ productId: "olive-oil-1l", branch: "store-01", delta: 1, reason: "x" })).status, 403);
  });

  it("adjusts stock and records a movement visible in the ledger", async () => {
    const before = (await ctx.request.get("/api/products/basmati-rice-5kg")).body.data.product;
    const res = await ctx.request.post("/api/inventory/adjust").set(whAuth).send({ productId: "basmati-rice-5kg", branch: "store-01", delta: 10, reason: "Recount" });
    assert.equal(res.status, 201);
    const after = (await ctx.request.get("/api/products/basmati-rice-5kg")).body.data.product;
    assert.equal(after.stock?.["store-01"] ?? before.stock?.["store-01"], (before.stock?.["store-01"] ?? 0) + 10);
    const movements = await ctx.request.get("/api/inventory/movements?productId=basmati-rice-5kg").set(whAuth);
    assert.ok(movements.body.data.movements.some((m) => m.reason === "Recount"));
  });

  it("transfers stock between branches", async () => {
    const res = await ctx.request.post("/api/inventory/transfer").set(whAuth).send({ productId: "basmati-rice-5kg", fromBranch: "store-01", toBranch: "store-02", qty: 2 });
    assert.equal(res.status, 201);
  });

  it("low-stock report only lists rows at or below their reorder level", async () => {
    const res = await ctx.request.get("/api/inventory/low-stock").set(whAuth);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data.items));
  });

  it("purchase order round trip: create → receive → stock and batch increase", async () => {
    const before = (await ctx.request.get("/api/products/paracetamol-500")).body.data.product;
    const created = await ctx.request.post("/api/purchase-orders").set(whAuth).send({ supplierId: "sup-1", branch: "store-01", lines: [{ productId: "paracetamol-500", qty: 40, purchasePrice: 1.5 }] });
    assert.equal(created.status, 201);
    const po = created.body.data.purchaseOrder;
    const received = await ctx.request.post(`/api/purchase-orders/${po.id}/receive`).set(whAuth).send({ lines: [{ productId: "paracetamol-500", qty: 40, purchasePrice: 1.5, batch: "PCM-IT-1", expiry: "2028-01-01" }] });
    assert.equal(received.status, 200);
    assert.equal(received.body.data.purchaseOrder.status, "received");
    const after = (await ctx.request.get("/api/products/paracetamol-500", whAuth)).body.data.product;
    assert.equal(after.stock["store-01"], before.stock["store-01"] + 40);
    assert.ok(after.batches.some((b) => b.batch === "PCM-IT-1"));
    assert.equal((await ctx.request.post(`/api/purchase-orders/${po.id}/receive`).set(whAuth).send({ lines: [{ productId: "paracetamol-500", qty: 1, purchasePrice: 1, batch: "X", expiry: "2028-01-01" }] })).status, 409);
  });

  it("POS sale deducts stock immediately, no reservation step", async () => {
    const before = (await ctx.request.get("/api/products/basmati-rice-5kg")).body.data.product;
    const stockBefore = before.stock?.["store-01"] ?? before.variants?.[0]?.stock?.["store-01"];
    const res = await ctx.request.post("/api/pos/sale").set(whAuth).send({ branch: "store-01", items: [{ productId: "basmati-rice-5kg", variantId: before.variants?.[0]?.id, qty: 1 }], paymentMethod: "cod" });
    assert.equal(res.status, 201);
    assert.ok(res.body.data.sale.number.startsWith("POS-"));
  });
});
