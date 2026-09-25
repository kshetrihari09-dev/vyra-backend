import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { createInventoryService } from "../../src/services/inventory.service.js";
import { createPurchasingService } from "../../src/services/purchasing.service.js";
import { createFakeCommerce, staffOrders } from "../helpers/commerceFakes.js";
import { fakeAudit } from "../helpers/fakes.js";

const ctx = { ip: "203.0.113.5", requestId: "r" };
const warehouseActor = { id: "u-wh", name: "Warehouse", roles: ["warehouse"], permissions: ["inventory:adjust", "catalog:write"] };

function setup() {
  const fake = createFakeCommerce();
  fake.db.inventory.set(fake.key("store-01", "soap", ""), { id: fake.key("store-01", "soap", ""), branch_id: "store-01", product_id: "soap", variant_id: null, on_hand: 10, reserved: 2, reorder_level: 12 });
  fake.db.inventory.set(fake.key("store-01", "cough-syrup", ""), { id: fake.key("store-01", "cough-syrup", ""), branch_id: "store-01", product_id: "cough-syrup", variant_id: null, on_hand: 13, reserved: 0, reorder_level: 5 });

  const audit = fakeAudit();
  const withTx = (fn) => fn({});
  const inventory = createInventoryService({ pool: {}, withTx, repos: fake.repos, audit });
  const purchasing = createPurchasingService({ pool: {}, withTx, repos: fake.repos, audit });
  return { ...fake, audit, inventory, purchasing };
}

describe("stock adjustment", () => {
  it("a positive delta increases on_hand and records a movement", async () => {
    const e = setup();
    const m = await e.inventory.adjust(warehouseActor, { productId: "soap", variantId: null, branch: "store-01", delta: 5, reason: "Recount" }, ctx);
    assert.equal(m.delta, 5);
    assert.equal(m.newQty, 15);
    assert.equal(e.db.inventory.get(e.key("store-01", "soap", "")).on_hand, 15);
    assert.ok(e.audit.entries.some((a) => a.action === "inventory.adjusted"));
  });

  it("a negative delta clamps at zero and the recorded delta reflects what actually applied", async () => {
    const e = setup();
    const m = await e.inventory.adjust(warehouseActor, { productId: "soap", variantId: null, branch: "store-01", delta: -50, reason: "Damaged stock" }, ctx);
    assert.equal(m.newQty, 0);
    assert.equal(m.delta, -10); // only 10 was there to remove, even though -50 was requested
  });

  it("an unknown product is rejected", async () => {
    const e = setup();
    await assert.rejects(e.inventory.adjust(warehouseActor, { productId: "ghost", branch: "store-01", delta: 1, reason: "x" }, ctx), { code: "PRODUCT_NOT_FOUND" });
  });
});

describe("stock transfer", () => {
  it("moves stock between branches and records a movement on each side", async () => {
    const e = setup();
    await e.inventory.transfer(warehouseActor, { productId: "soap", variantId: null, fromBranch: "store-01", toBranch: "store-02", qty: 4 }, ctx);
    assert.equal(e.db.inventory.get(e.key("store-01", "soap", "")).on_hand, 6);
    assert.equal(e.db.inventory.get(e.key("store-02", "soap", "")).on_hand, 4);
    assert.equal(e.db.movements.filter((m) => m.reason?.includes("Transfer")).length, 2);
  });

  it("refuses to transfer more than is available (reserved stock isn't transferable)", async () => {
    const e = setup(); // soap: on_hand 10, reserved 2 → 8 available
    await assert.rejects(e.inventory.transfer(warehouseActor, { productId: "soap", fromBranch: "store-01", toBranch: "store-02", qty: 9 }, ctx), { code: "INSUFFICIENT_STOCK" });
  });

  it("consumes batches FEFO on the sending branch when the product is batch-tracked", async () => {
    const e = setup();
    await e.inventory.transfer(warehouseActor, { productId: "cough-syrup", fromBranch: "store-01", toBranch: "store-02", qty: 5 }, ctx);
    const batches = e.db.batches["cough-syrup"]["store-01"];
    assert.equal(batches.find((b) => b.id === "b-old").qty, 0);
    assert.equal(batches.find((b) => b.id === "b-new").qty, 8);
  });
});

describe("low-stock report", () => {
  it("lists rows at or below their reorder level", async () => {
    const e = setup();
    const rows = await e.inventory.lowStock({ branch: undefined });
    assert.ok(rows.some((r) => r.productId === "soap"));
    await e.inventory.adjust(warehouseActor, { productId: "soap", branch: "store-01", delta: 20, reason: "Restock" }, ctx);
    const after = await e.inventory.lowStock({});
    assert.ok(!after.some((r) => r.productId === "soap"));
  });
});

describe("purchase orders", () => {
  it("creating a PO records ordered lines without touching stock", async () => {
    const e = setup();
    const po = await e.purchasing.createPurchaseOrder(warehouseActor, { supplierId: "sup-1", branch: "store-01", lines: [{ productId: "soap", qty: 50, purchasePrice: 1.2 }] }, ctx);
    assert.equal(po.status, "ordered");
    assert.equal(e.db.inventory.get(e.key("store-01", "soap", "")).on_hand, 10, "stock unaffected until received");
  });

  it("receiving adds real stock, creates a batch, and can't be done twice", async () => {
    const e = setup();
    const po = await e.purchasing.createPurchaseOrder(warehouseActor, { supplierId: "sup-1", branch: "store-01", lines: [{ productId: "soap", qty: 50, purchasePrice: 1.2 }] }, ctx);
    const received = await e.purchasing.receivePurchaseOrder(warehouseActor, po.id, { lines: [{ productId: "soap", qty: 50, purchasePrice: 1.2, batch: "B-501", expiry: "2027-01-01" }] }, ctx);
    assert.equal(received.status, "received");
    assert.equal(e.db.inventory.get(e.key("store-01", "soap", "")).on_hand, 60);
    assert.equal(e.db.batches.soap["store-01"][0].batch_no, "B-501");
    await assert.rejects(e.purchasing.receivePurchaseOrder(warehouseActor, po.id, { lines: [{ productId: "soap", qty: 1, purchasePrice: 1, batch: "X", expiry: "2027-01-01" }] }, ctx), { code: "ALREADY_RECEIVED" });
  });

  it("receiving a batch that already exists tops up its quantity instead of duplicating it", async () => {
    const e = setup();
    e.db.batches.soap = { "store-01": [{ id: "b-soap-1", batch_no: "B-501", expiry_date: "2027-01-01", qty: 20, is_legacy_opening: false }] };
    const po = await e.purchasing.createPurchaseOrder(warehouseActor, { supplierId: "sup-1", branch: "store-01", lines: [{ productId: "soap", qty: 10, purchasePrice: 1.2 }] }, ctx);
    await e.purchasing.receivePurchaseOrder(warehouseActor, po.id, { lines: [{ productId: "soap", qty: 10, purchasePrice: 1.2, batch: "B-501", expiry: "2027-01-01" }] }, ctx);
    assert.equal(e.db.batches.soap["store-01"].length, 1);
    assert.equal(e.db.batches.soap["store-01"][0].qty, 30);
  });
});

describe("POS sale", () => {
  it("deducts stock immediately (no reservation step) and totals the sale with tax", async () => {
    const e = setup();
    const sale = await e.purchasing.posSale(warehouseActor, { branch: "store-01", items: [{ productId: "soap", qty: 3 }], paymentMethod: "cod" }, ctx);
    assert.equal(sale.items[0].qty, 3);
    assert.equal(e.db.inventory.get(e.key("store-01", "soap", "")).on_hand, 7);
    assert.equal(sale.totals.tax, Math.round(15 * 0.05 * 100) / 100); // soap: price 5, tax 5%
  });

  it("refuses a sale beyond what's actually available (accounting for online reservations)", async () => {
    const e = setup(); // soap: 10 on hand, 2 reserved → 8 sellable
    await assert.rejects(e.purchasing.posSale(warehouseActor, { branch: "store-01", items: [{ productId: "soap", qty: 9 }], paymentMethod: "cod" }, ctx), { code: "INSUFFICIENT_STOCK" });
  });

  it("consumes batches FEFO for a batch-tracked product", async () => {
    const e = setup();
    await e.purchasing.posSale(warehouseActor, { branch: "store-01", items: [{ productId: "cough-syrup", qty: 4 }], paymentMethod: "cod" }, ctx);
    const batches = e.db.batches["cough-syrup"]["store-01"];
    assert.equal(batches.find((b) => b.id === "b-old").qty, 0);
    assert.equal(batches.find((b) => b.id === "b-new").qty, 9);
  });
});
