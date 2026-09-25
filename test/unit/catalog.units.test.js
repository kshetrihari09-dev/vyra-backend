import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toCategoryDto, toProductDto } from "../../src/models/catalog.model.js";
import { createProductsRepository } from "../../src/repositories/products.repository.js";
import { createSearchService } from "../../src/services/search.service.js";
import { escapeLike, normTerm, slugify, toNumber } from "../../src/utils/text.js";
import { planBatchAllocation } from "../../seeds/demo/catalog.js";

describe("text helpers", () => {
  it("slugify", () => {
    assert.equal(slugify("Extra Virgin Olive Oil (1L)"), "extra-virgin-olive-oil-1l");
    assert.equal(slugify("  Café Crème!! "), "cafe-creme");
    assert.equal(slugify("---"), "");
    assert.equal(slugify("a".repeat(200)).length, 80);
  });
  it("escapeLike neutralises wildcards so input is matched literally", () => {
    assert.equal(escapeLike("100%_off\\"), "100\\%\\_off\\\\");
  });
  it("normTerm / toNumber", () => {
    assert.equal(normTerm("  PaRa "), "para");
    assert.equal(toNumber("14.50"), 14.5);
    assert.equal(toNumber(null), null);
  });
});

describe("batch → branch allocation (decision D4)", () => {
  const branchOrder = ["store-01", "store-02"];
  it("fills the first branch in FEFO order, splitting a batch across branches when needed", () => {
    const r = planBatchAllocation({
      batches: [{ batch: "B", expiryInDays: 400, qty: 40, cost: 1 }, { batch: "A", expiryInDays: 100, qty: 30, cost: 1 }],
      branchOrder, stockByBranch: { "store-01": 40, "store-02": 30 },
    });
    assert.deepEqual(r.placements.map((p) => [p.branchId, p.batch, p.qty]), [["store-01", "A", 30], ["store-01", "B", 10], ["store-02", "B", 30]]);
    assert.deepEqual(r.legacy, []);
    assert.equal(r.surplus, 0);
  });
  it("stock that no batch explains is quarantined per branch, never given an invented expiry", () => {
    const r = planBatchAllocation({ batches: [{ batch: "A", expiryInDays: 10, qty: 58, cost: 1 }], branchOrder, stockByBranch: { "store-01": 58, "store-02": 40 } });
    assert.deepEqual(r.legacy, [{ branchId: "store-02", qty: 40 }]);
  });
  it("batch quantity beyond total stock is reported as surplus, not imported", () => {
    const r = planBatchAllocation({ batches: [{ batch: "A", expiryInDays: 10, qty: 50, cost: 1 }], branchOrder, stockByBranch: { "store-01": 20, "store-02": 10 } });
    assert.equal(r.surplus, 20);
    assert.equal(r.placements.reduce((s, p) => s + p.qty, 0), 30);
  });
  it("placed + legacy always equals branch stock", () => {
    const stock = { "store-01": 25, "store-02": 11 };
    const r = planBatchAllocation({ batches: [{ batch: "X", expiryInDays: 5, qty: 12, cost: 1 }, { batch: "Y", expiryInDays: 50, qty: 8, cost: 1 }], branchOrder, stockByBranch: stock });
    const total = r.placements.reduce((s, p) => s + p.qty, 0) + r.legacy.reduce((s, l) => s + l.qty, 0);
    assert.equal(total, 36);
  });
});

describe("DTO mappers keep the storefront's existing shapes", () => {
  const row = {
    id: "olive-oil-1l", name: "EVOO", slug: "evoo", category_id: "grocery", brand_id: "freshfields", seller_id: "vyra-retail", description: "d", price: "12.90", sale_price: "10.30", tax_percent: "0.00",
    sku: "S", barcode: null, unit: "bottle", moq: 1, max_qty: 8, rating: "4.6", review_count: 742, sold_count: 1980, status: "active", delivery_available: true,
    prescription_required: false, tags: ["popular"], art: { shape: "bottle" }, attributes: { weight: "1 L" }, version: 3, created_at: new Date("2026-04-02T10:00:00Z"),
  };
  it("simple product: numbers not strings, stock map on the product", () => {
    const dto = toProductDto(row, { stock: new Map([["olive-oil-1l", { "": { "store-01": 31 } }]]) });
    assert.equal(dto.price, 12.9);
    assert.equal(dto.salePrice, 10.3);
    assert.equal(dto.rating, 4.6);
    assert.equal(dto.createdAt, "2026-04-02");
    assert.deepEqual(dto.stock, { "store-01": 31 });
    assert.equal(dto.variants, undefined);
    assert.equal(dto.barcode, "");
    assert.equal(dto.flags, undefined);
  });
  it("variant product: stock lives on each variant; prescription flag and batches appear when present", () => {
    const dto = toProductDto({ ...row, prescription_required: true }, {
      variants: new Map([["olive-oil-1l", [{ id: "r1", label: "1 kg", options: { weight: "1 kg" }, price: "3.60", sale_price: null, sku: "V1" }]]]),
      stock: new Map([["olive-oil-1l", { r1: { "store-01": 40 } }]]),
      batches: new Map([["olive-oil-1l", [{ batch: "B1", expiry: "2027-01-01", qty: 5 }]]]),
    });
    assert.equal(dto.stock, undefined);
    assert.deepEqual(dto.variants[0].stock, { "store-01": 40 });
    assert.equal(dto.variants[0].salePrice, null);
    assert.deepEqual(dto.flags, { prescriptionRequired: true });
    assert.equal(dto.batches[0].batch, "B1");
  });
  it("category: uses parent/order/image keys and omits inherited fields", () => {
    const dto = toCategoryDto({ id: "grocery-snacks", name: "Snacks", slug: "snacks", parent_id: "grocery", sort_order: 2, status: "active", icon: "Cookie", image_shape: "bag", tint: "#FCF3E3", fg: "#C98A2E", attributes: null, modules: null, unit_label: null, product_count: "4" });
    assert.equal(dto.parent, "grocery");
    assert.equal(dto.order, 2);
    assert.equal(dto.image, "bag");
    assert.equal(dto.productCount, 4);
    assert.ok(!("attributes" in dto) && !("modules" in dto) && !("unitLabel" in dto));
  });
});

/** Captures every SQL statement + bound values so we can assert on how queries are built. */
function recorder() {
  const calls = [];
  return { calls, query: async (sql, values) => { calls.push({ sql, values }); return { rows: [{ n: "0" }], rowCount: 0 }; } };
}
const filters = (over = {}) => ({ statuses: ["active"], sort: "relevance", page: 1, pageSize: 25, ...over });

describe("product search SQL", () => {
  const repo = createProductsRepository();

  it("user input is only ever a bound parameter, never part of the SQL text", async () => {
    const evil = "'; DROP TABLE products; --";
    const db = recorder();
    await repo.search(db, filters({ q: evil.toLowerCase(), tag: "x'--", sku: evil, barcode: evil, attrs: { "origin": evil }, brandIds: [evil], categoryIds: [evil], sellerId: evil, ids: [evil] }));
    for (const { sql, values } of db.calls) {
      assert.ok(!/drop table/i.test(sql), "payload leaked into SQL text");
      assert.ok(!sql.includes("x'--"));
      assert.ok(values.some((v) => (Array.isArray(v) ? v.includes(evil) : String(v).includes("drop table") || String(v).includes("DROP TABLE"))), "payload should travel as a parameter");
    }
  });

  it("LIKE wildcards in the search term are escaped", async () => {
    const db = recorder();
    await repo.search(db, filters({ q: "50%_off" }));
    const values = db.calls[0].values;
    assert.ok(values.includes("50%_off"), "exact-match parameter is the raw term");
    assert.ok(values.includes("50\\%\\_off"), "prefix parameter is escaped");
  });

  it("with a term, relevance orders by match tier first; without one it falls back to best-selling", async () => {
    const withQ = recorder(); await repo.search(withQ, filters({ q: "para" }));
    assert.match(withQ.calls[1].sql, /ORDER BY \(CASE[\s\S]+\), p\.sold_count DESC, p\.rating DESC, p\.id/);
    const noQ = recorder(); await repo.search(noQ, filters());
    assert.match(noQ.calls[1].sql, /ORDER BY p\.sold_count DESC, p\.id/);
    assert.ok(!/CASE\s+WHEN lower\(p\.barcode\)/.test(noQ.calls[1].sql));
  });

  it("ranks exact barcode, then SKU, then prefixes, then generic name/brand/category (tier ladder)", async () => {
    const db = recorder(); await repo.search(db, filters({ q: "x" }));
    const sql = db.calls[1].sql;
    const order = ["= $", "lower(p.sku) = ", "lower(p.barcode) LIKE", "lower(p.sku) LIKE", "lower(p.name) LIKE $", "LIKE '% '", "genericName", "lower(b.name)", "lower(c.name)"];
    let at = 0;
    for (const marker of order) { const i = sql.indexOf(marker, at); assert.ok(i >= at, `tier marker missing or out of order: ${marker}`); at = i; }
  });

  it("no prefix search uses a leading wildcard on indexed columns (index-friendly), except the word-start rule", async () => {
    const db = recorder(); await repo.search(db, filters({ q: "para" }));
    const sql = db.calls[1].sql;
    assert.ok(!/LIKE '%' \|\|/.test(sql), "no bare leading % pattern");
  });

  it("pagination is bounded parameters (LIMIT/OFFSET), sort ids map to a fixed whitelist", async () => {
    const db = recorder(); await repo.search(db, filters({ sort: "price_asc", page: 3, pageSize: 10 }));
    const { sql, values } = db.calls[1];
    assert.match(sql, /ORDER BY COALESCE\(p\.sale_price, p\.price\) ASC, p\.id LIMIT \$\d+ OFFSET \$\d+/);
    assert.deepEqual(values.slice(-2), [10, 20]);
    const bogus = recorder(); await repo.search(bogus, filters({ sort: "price; DROP" }));
    assert.ok(!/DROP/.test(bogus.calls[1].sql));
  });

  it("attribute filters cast the key parameter (jsonb ->> operator ambiguity) and also match variant options", async () => {
    const db = recorder(); await repo.search(db, filters({ attrs: { dietary: "Veg" } }));
    assert.match(db.calls[0].sql, /->> \$\d+::text = \$\d+::text OR EXISTS/);
  });

  it("stock filters use on-hand minus reserved, optionally per branch", async () => {
    const db = recorder(); await repo.search(db, filters({ inStock: true, branchId: "store-01" }));
    assert.match(db.calls[0].sql, /\(i\.on_hand - i\.reserved\) > 0 AND i\.branch_id = \$\d+/);
  });

  it("soft-deleted products are always excluded", async () => {
    const db = recorder(); await repo.search(db, filters());
    for (const c of db.calls) assert.match(c.sql, /p\.deleted_at IS NULL/);
  });
});

describe("search service", () => {
  it("suggest: products first, then categories and brands by prefix, capped at the limit", async () => {
    const repos = {
      products: { suggestProducts: async () => [{ id: "p1", name: "Paracetamol", brand_name: "GSK", tier: 4 }] },
      catalog: {
        listCategories: async () => [{ id: "c1", name: "Pain relief", parent_id: null }, { id: "c2", name: "Paediatric", parent_id: "c1" }],
        listBrands: async () => [{ id: "b1", name: "Panadol Co" }, { id: "b2", name: "Zed" }],
      },
    };
    const s = createSearchService({ pool: {}, repos });
    const out = await s.suggest({ q: "pa", limit: 20 });
    assert.deepEqual(out.map((x) => [x.type, x.id]), [["product", "p1"], ["category", "c1"], ["category", "c2"], ["brand", "b1"]]);
    assert.equal((await s.suggest({ q: "pa", limit: 2 })).length, 2);
    assert.deepEqual(await s.suggest({ q: "   ", limit: 5 }), []);
  });
});
