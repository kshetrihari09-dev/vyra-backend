import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { createProductsService } from "../../src/services/products.service.js";
import { adminActor, createFakeCatalog, otherSellerActor, sellerActor, staffNoStock } from "../helpers/catalogFakes.js";
import { fakeAudit } from "../helpers/fakes.js";

const ctx = { ip: "203.0.113.5", requestId: "r" };
const base = { name: "Paracetamol 500mg", categoryId: "health-medicines", brandId: "cipla", price: 10, salePrice: 8, sku: "MED-PCM-500", attributes: { genericName: "Paracetamol", dosageForm: "Tablet" }, unit: "strip", moq: 1, maxQty: 10, status: "active", tags: [], description: "", tax: 0, deliveryAvailable: true };

function setup() {
  const fake = createFakeCatalog();
  const audit = fakeAudit();
  const service = createProductsService({ pool: {}, withTx: (fn) => fn({}), repos: fake.repos, audit });
  return { ...fake, audit, service };
}

describe("product creation", () => {
  let e;
  beforeEach(() => { e = setup(); });

  it("generates a unique id and slug from the name, and audits the creation", async () => {
    const a = await e.service.create(adminActor, base, ctx);
    assert.equal(a.id, "paracetamol-500mg");
    assert.equal(a.slug, "paracetamol-500mg");
    const b = await e.service.create(adminActor, { ...base, sku: "MED-PCM-501" }, ctx);
    assert.equal(b.id, "paracetamol-500mg-2");
    assert.equal(b.slug, "paracetamol-500mg-2");
    assert.equal(e.audit.entries.filter((x) => x.action === "product.created").length, 2);
  });

  it("validates attributes against the category's schema, including inherited schemas and select options", async () => {
    await assert.rejects(e.service.create(adminActor, { ...base, attributes: { colour: "red" } }, ctx), { code: "INVALID_ATTRIBUTES" });
    await assert.rejects(e.service.create(adminActor, { ...base, attributes: { dosageForm: "Injection" } }, ctx), (err) => err.code === "INVALID_ATTRIBUTES" && /Tablet, Syrup/.test(err.message));
    // "health-medicines" declares no attributes of its own — it inherits "health"'s
    assert.ok(await e.service.create(adminActor, { ...base, attributes: { dosageForm: "Syrup" } }, ctx));
  });

  it("rejects an unknown category or brand, and requires a brand", async () => {
    await assert.rejects(e.service.create(adminActor, { ...base, categoryId: "nope" }, ctx), { code: "CATEGORY_NOT_FOUND" });
    await assert.rejects(e.service.create(adminActor, { ...base, brandId: "ghost" }, ctx), { code: "BRAND_NOT_FOUND" });
    await assert.rejects(e.service.create(adminActor, { ...base, brandId: undefined }, ctx), { code: "BRAND_REQUIRED" });
  });

  it("brandName reuses an existing brand or registers a new one (case-insensitive)", async () => {
    const reused = await e.service.create(adminActor, { ...base, brandId: undefined, brandName: "  CIPLA " }, ctx);
    assert.equal(reused.brandId, "cipla");
    const created = await e.service.create(adminActor, { ...base, sku: "X-2", brandId: undefined, brandName: "Zenith Labs" }, ctx);
    assert.equal(created.brandId, "zenith-labs");
    assert.ok(e.db.brands.some((b) => b.id === "zenith-labs"));
  });

  it("a duplicate SKU becomes a field-level 409, not a raw database error", async () => {
    await e.service.create(adminActor, base, ctx);
    const err = await e.service.create(adminActor, { ...base, name: "Other" }, ctx).catch((x) => x);
    assert.equal(err.status, 409);
    assert.equal(err.code, "SKU_TAKEN");
    assert.deepEqual(err.details, [{ path: "body.sku", message: "Another product already uses this SKU" }]);
  });

  it("rejects duplicate variant ids", async () => {
    const v = { id: "a", label: "A", price: 1, sku: "V-1", options: {} };
    await assert.rejects(e.service.create(adminActor, { ...base, variants: [v, { ...v, sku: "V-2" }] }, ctx), { code: "DUPLICATE_VARIANT" });
  });

  it("opening stock needs inventory:adjust and known branches; it is recorded and audited", async () => {
    await assert.rejects(e.service.create(staffNoStock, { ...base, openingStock: { "store-01": 5 } }, ctx), { status: 403 });
    await assert.rejects(e.service.create(adminActor, { ...base, openingStock: { "store-99": 5 } }, ctx), { code: "BRANCH_NOT_FOUND" });
    const p = await e.service.create(adminActor, { ...base, openingStock: { "store-01": 12, "store-02": 0 } }, ctx);
    assert.deepEqual(p.stock, { "store-01": 12 });
    assert.ok(e.audit.entries.some((x) => x.action === "inventory.opening_stock"));
  });

  it("opening stock is applied exactly once and logged in the movements ledger; zero/empty adds nothing", async () => {
    const p = await e.service.create(adminActor, { ...base, openingStock: { "store-01": 20 } }, ctx);
    assert.deepEqual(p.stock, { "store-01": 20 });
    assert.equal(e.db.inventory.filter((r) => r.product_id === p.id).length, 1, "one inventory row, not two");
    assert.deepEqual(e.db.movements.map((m) => [m.productId, m.branchId, m.delta, m.prevQty, m.newQty, m.reason, m.refType]), [[p.id, "store-01", 20, 0, 20, "Opening stock", "adjustment"]]);

    const zero = await e.service.create(adminActor, { ...base, name: "Zero", sku: "Z-0", openingStock: { "store-01": 0 } }, ctx);
    const none = await e.service.create(adminActor, { ...base, name: "None", sku: "N-0" }, ctx);
    assert.deepEqual([zero.stock, none.stock], [{}, {}]);
    assert.equal(e.db.inventory.length, 1);
    assert.equal(e.db.movements.length, 1, "no ledger noise for 0 / empty");
  });

  it("editing a product never re-applies or changes its opening stock", async () => {
    const p = await e.service.create(adminActor, { ...base, openingStock: { "store-01": 20 } }, ctx);
    const after = await e.service.update(adminActor, p.id, { ...base, id: p.id, version: p.version, openingStock: { "store-01": 99 }, name: "Renamed" }, ctx);
    assert.deepEqual(after.stock, { "store-01": 20 });
    assert.equal(e.db.movements.length, 1);
  });

  it("the client can't smuggle server-owned fields (rating, sold, stock, batches) through create", async () => {
    // The validator strips them; the service never reads them either.
    const p = await e.service.create(adminActor, { ...base, rating: 5, sold: 9999, stock: { "store-01": 500 }, batches: [{ batch: "X" }] }, ctx);
    assert.equal(p.rating, 0);
    assert.equal(p.sold, 0);
    assert.deepEqual(p.stock, {});
    assert.equal(p.batches, undefined);
  });
});

describe("seller sees their own non-public listings", () => {
  it("list({ sellerId: own, status: any }) asks the repository for every status, scoped to that shop", async () => {
    const e = setup();
    await e.service.create(sellerActor, { ...base, sku: "SEL-LIST" }, ctx);
    await e.service.list({ page: 1, pageSize: 100, sort: "relevance", sellerId: "acme", status: "any" }, sellerActor);
    const f = e.db.products.lastSearch ?? e.repos?.products?.lastSearch;
    assert.ok(f.statuses.includes("pending_review") && f.statuses.includes("rejected") && f.statuses.includes("inactive"));
    assert.equal(f.sellerId, "acme");
  });
  it("another shop asking for acme's non-active products only gets the public view", async () => {
    const e = setup();
    await e.service.list({ page: 1, pageSize: 100, sort: "relevance", sellerId: "acme", status: "any" }, otherSellerActor);
    const f = e.db.products.lastSearch ?? e.repos?.products?.lastSearch;
    assert.deepEqual(f.statuses, ["active"]);
  });
});

describe("staff creating on behalf of a shop", () => {
  it("keeps the chosen sellerId so the product appears in that shop's console (it used to be dropped)", async () => {
    const e = setup();
    const p = await e.service.create(adminActor, { ...base, sku: "ADM-1", sellerId: "acme" }, ctx);
    assert.equal(p.sellerId, "acme");
  });
  it("leaves it unowned (Vyra's own catalogue) when no shop is given", async () => {
    const e = setup();
    const p = await e.service.create(adminActor, { ...base, sku: "ADM-2" }, ctx);
    assert.equal(p.sellerId, undefined);
  });
});

describe("minimum stock level", () => {
  it("is stored on create, returned on the DTO, kept when an edit omits it, and changed when an edit sends it", async () => {
    const e = setup();
    const a = await e.service.create(adminActor, { ...base, minStock: 25 }, ctx);
    assert.equal(a.minStock, 25);
    const kept = await e.service.update(adminActor, a.id, { ...base, version: a.version }, ctx);
    assert.equal(kept.minStock, 25);
    const changed = await e.service.update(adminActor, a.id, { ...base, minStock: 3, version: kept.version }, ctx);
    assert.equal(changed.minStock, 3);
  });
  it("defaults to 10 when never set", async () => {
    const e = setup();
    assert.equal((await e.service.create(adminActor, base, ctx)).minStock, 10);
  });
});

describe("product update / delete", () => {
  let e, p;
  beforeEach(async () => { e = setup(); p = await e.service.create(adminActor, base, ctx); e.audit.entries.length = 0; });

  it("bumps the version and audits a price change separately from a generic update", async () => {
    const out = await e.service.update(adminActor, p.id, { ...base, price: 12, salePrice: 9 }, ctx);
    assert.equal(out.version, 2);
    const actions = e.audit.entries.map((x) => x.action);
    assert.deepEqual(actions, ["product.updated", "product.price_changed"]);
    const change = e.audit.entries.find((x) => x.action === "product.price_changed");
    assert.equal(change.oldValue.price, 10);
    assert.equal(change.newValue.price, 12);
  });

  it("a non-price edit does not write a price_changed entry", async () => {
    await e.service.update(adminActor, p.id, { ...base, description: "new copy" }, ctx);
    assert.deepEqual(e.audit.entries.map((x) => x.action), ["product.updated"]);
  });

  it("stale version → 409", async () => {
    await e.service.update(adminActor, p.id, { ...base, price: 11 }, ctx);
    await assert.rejects(e.service.update(adminActor, p.id, { ...base, price: 13, version: 1 }, ctx), { code: "STALE_PRODUCT" });
  });

  it("cannot remove a variant that still holds stock, or add variants over unvarianted stock", async () => {
    const withVariants = await e.service.create(adminActor, { ...base, name: "Vit C", sku: "VC", variants: [{ id: "s", label: "30", price: 5, sku: "VC-30", options: {}, openingStock: { "store-01": 4 } }] }, ctx);
    await assert.rejects(e.service.update(adminActor, withVariants.id, { ...base, name: "Vit C", sku: "VC", variants: [] }, ctx), { code: "STOCK_STRUCTURE" });
    e.db.inventory.push({ product_id: p.id, variant_id: null, branch_id: "store-01", on_hand: 3 });
    await assert.rejects(e.service.update(adminActor, p.id, { ...base, variants: [{ id: "a", label: "A", price: 1, sku: "V-A", options: {} }] }, ctx), { code: "STOCK_STRUCTURE" });
  });

  it("delete is soft, audited, and hides the product", async () => {
    await e.service.remove(adminActor, p.id, ctx);
    assert.ok(e.db.products.find((x) => x.id === p.id).deleted_at);
    assert.equal(e.audit.entries.at(-1).action, "product.deleted");
    await assert.rejects(e.service.get(p.id, adminActor), { code: "PRODUCT_NOT_FOUND" });
    await assert.rejects(e.service.remove(adminActor, p.id, ctx), { code: "PRODUCT_NOT_FOUND" });
  });
});

describe("visibility", () => {
  it("customers and anonymous callers only ever see active products; managers can widen the status filter", async () => {
    const e = setup();
    const p = await e.service.create(adminActor, { ...base, status: "inactive" }, ctx);
    await assert.rejects(e.service.get(p.id, undefined), { code: "PRODUCT_NOT_FOUND" });
    await assert.rejects(e.service.get(p.id, { permissions: [] }), { code: "PRODUCT_NOT_FOUND" });
    assert.equal((await e.service.get(p.id, adminActor)).status, "inactive");

    const q = { page: 1, pageSize: 25, sort: "relevance", status: "any" };
    await e.service.list(q, undefined);
    assert.deepEqual(e.repos.products.lastSearch.statuses, ["active"], "?status=any is ignored for non-managers");
    await e.service.list(q, adminActor);
    assert.ok(e.repos.products.lastSearch.statuses.includes("inactive"));
  });

  it("sellerId filtering is not available to anonymous callers", async () => {
    const e = setup();
    await assert.rejects(e.service.list({ page: 1, pageSize: 25, sort: "relevance", sellerId: "novatech" }, undefined), { status: 403 });
  });

  it("attribute filters come only from well-formed attr.<key> query keys; the search term is normalised", async () => {
    const e = setup();
    await e.service.list({ page: 1, pageSize: 25, sort: "relevance", q: "  ParaCET ", "attr.origin": "India", "attr.bad key": "x", "attr.": "y", notattr: "z" }, undefined);
    assert.deepEqual(e.repos.products.lastSearch.attrs, { origin: "India" });
    assert.equal(e.repos.products.lastSearch.q, "paracet");
  });
});

// Phase 6: a seller (catalog:write_own) manages only their own catalogue, and a new listing always starts
// out unapproved — this is what makes the marketplace's product moderation actually mean something.
describe("seller-scoped catalogue (decision: sellers can't self-approve)", () => {
  it("a seller can set the opening stock of the NEW listing they create (recorded once, in the ledger); nobody else without inventory:adjust can", async () => {
    const e = setup();
    const p = await e.service.create(sellerActor, { ...base, sku: "SEL-OPEN", openingStock: { "store-01": 10 } }, ctx);
    assert.equal(p.status, "pending_review");
    assert.deepEqual(p.stock, { "store-01": 10 });
    assert.equal(e.db.movements.length, 1);
    assert.equal(e.db.movements[0].actorId, sellerActor.id);
    await assert.rejects(e.service.create(sellerActor, { ...base, sku: "SEL-BAD", openingStock: { "store-99": 1 } }, ctx), { code: "BRANCH_NOT_FOUND" });
    await assert.rejects(e.service.create({ id: "u", permissions: [] }, { ...base, sku: "X-1", openingStock: { "store-01": 5 } }, ctx), { status: 403 });
  });

  it("forces a new listing's sellerId to the caller's own shop, and its status to pending_review regardless of what's submitted", async () => {
    const e = setup();
    const p = await e.service.create(sellerActor, { ...base, sku: "SEL-1", sellerId: "someone-else", status: "active" }, ctx);
    assert.equal(p.sellerId, "acme");
    assert.equal(p.status, "pending_review");
  });

  it("a seller with no shop yet cannot list anything", async () => {
    const e = setup();
    await assert.rejects(e.service.create({ ...sellerActor, sellerId: null }, { ...base, sku: "SEL-2" }, ctx), (err) => err.status === 403);
  });

  it("the owner can see their own pending listing; a different seller gets 404, not 403", async () => {
    const e = setup();
    const p = await e.service.create(sellerActor, { ...base, sku: "SEL-3" }, ctx);
    assert.equal((await e.service.get(p.id, sellerActor)).status, "pending_review");
    await assert.rejects(e.service.get(p.id, otherSellerActor), { code: "PRODUCT_NOT_FOUND" });
  });

  it("a seller can't edit or delete another seller's product (404, not 403 — no existence leak)", async () => {
    const e = setup();
    const p = await e.service.create(sellerActor, { ...base, sku: "SEL-4" }, ctx);
    await assert.rejects(e.service.update(otherSellerActor, p.id, { ...base, sku: "SEL-4", status: "active" }, ctx), { code: "PRODUCT_NOT_FOUND" });
    await assert.rejects(e.service.remove(otherSellerActor, p.id, ctx), { code: "PRODUCT_NOT_FOUND" });
  });

  it("a seller cannot self-approve a pending listing by PUTting status: active", async () => {
    const e = setup();
    const p = await e.service.create(sellerActor, { ...base, sku: "SEL-5" }, ctx);
    const updated = await e.service.update(sellerActor, p.id, { ...base, sku: "SEL-5", status: "active" }, ctx);
    assert.equal(updated.status, "pending_review");
  });

  it("once staff approve it, the owning seller can toggle active/inactive themselves", async () => {
    const e = setup();
    const p = await e.service.create(sellerActor, { ...base, sku: "SEL-6" }, ctx);
    await e.service.update(adminActor, p.id, { ...base, sku: "SEL-6", status: "active" }, ctx); // staff approval
    const deactivated = await e.service.update(sellerActor, p.id, { ...base, sku: "SEL-6", status: "inactive" }, ctx);
    assert.equal(deactivated.status, "inactive");
    const reactivated = await e.service.update(sellerActor, p.id, { ...base, sku: "SEL-6", status: "active" }, ctx);
    assert.equal(reactivated.status, "active");
  });

  it("a seller can delete their own product regardless of its status", async () => {
    const e = setup();
    const p = await e.service.create(sellerActor, { ...base, sku: "SEL-7" }, ctx);
    await e.service.remove(sellerActor, p.id, ctx);
    await assert.rejects(e.service.get(p.id, sellerActor), { code: "PRODUCT_NOT_FOUND" });
  });

  it("an owner can widen the status filter for their own shop's listings, but never for another shop's", async () => {
    const e = setup();
    await e.service.create(sellerActor, { ...base, sku: "SEL-9" }, ctx); // pending_review
    const q = { page: 1, pageSize: 25, sort: "relevance", status: "any" };
    await e.service.list({ ...q, sellerId: "acme" }, sellerActor);
    assert.ok(e.repos.products.lastSearch.statuses.includes("pending_review"), "own shop: widened");
    await e.service.list({ ...q, sellerId: "zenith" }, sellerActor);
    assert.deepEqual(e.repos.products.lastSearch.statuses, ["active"], "someone else's shop: public view only");
    await e.service.list({ ...q, sellerId: "acme" }, otherSellerActor);
    assert.deepEqual(e.repos.products.lastSearch.statuses, ["active"]);
  });

  it("catalog:write staff are unaffected by any of this — they can set status directly and touch any shop's listing", async () => {
    const e = setup();
    const p = await e.service.create(adminActor, { ...base, sku: "SEL-8", sellerId: "acme" }, ctx);
    assert.equal(p.status, "active");
    const updated = await e.service.update(adminActor, p.id, { ...base, sku: "SEL-8", status: "rejected" }, ctx);
    assert.equal(updated.status, "rejected");
  });
});
