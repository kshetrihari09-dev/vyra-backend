import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { boot, loginAs, makeUser, skipReason, uniq } from "./helpers.js";

describe("catalogue API (real Postgres)", { skip: skipReason }, () => {
  let ctx, admin, adminAuth, customerAuth;
  before(async () => {
    ctx = await boot();
    admin = await makeUser(ctx.container, { roles: ["admin"] });
    adminAuth = { Authorization: `Bearer ${(await loginAs(ctx.request, admin)).token}` };
    customerAuth = { Authorization: `Bearer ${(await loginAs(ctx.request, await makeUser(ctx.container))).token}` };
  });
  after(async () => { await ctx?.close(); });

  const get = (path, headers = {}) => ctx.request.get(path).set(headers);
  const newProduct = (over = {}) => {
    const t = uniq();
    return { name: `IT Widget ${t}`, categoryId: "grocery-snacks", brandId: "freshfields", price: 10, salePrice: 8, sku: `IT-${t}`, attributes: { weight: "100 g" }, ...over };
  };

  describe("reads", () => {
    it("lists products without authentication, paginated", async () => {
      const res = await get("/api/products?pageSize=5&page=1");
      assert.equal(res.status, 200);
      assert.equal(res.body.data.items.length, 5);
      assert.ok(res.body.data.total >= 39);
      const p = res.body.data.items[0];
      assert.equal(typeof p.price, "number");
      assert.ok("stock" in p || "variants" in p);
    });

    it("pageSize is capped and bad input is a 400, not a 500", async () => {
      assert.equal((await get("/api/products?pageSize=1000")).status, 400);
      assert.equal((await get("/api/products?page=abc")).status, 400);
      assert.equal((await get("/api/products?sort=bogus")).status, 400);
    });

    it("prefix search: 'para' finds paracetamol; a bare 'l' does not match it by a letter in the middle", async () => {
      const para = await get("/api/products?q=para");
      assert.ok(para.body.data.items.some((p) => p.id === "paracetamol-500"));
      const l = await get("/api/products?q=l&pageSize=100");
      assert.ok(!l.body.data.items.some((p) => p.id === "paracetamol-500"));
    });

    it("an exact barcode ranks first, and /search/lookup resolves barcode or SKU", async () => {
      const bar = (await get("/api/products/paracetamol-500")).body.data.product.barcode;
      const res = await get(`/api/products?q=${bar}`);
      assert.equal(res.body.data.items[0].id, "paracetamol-500");
      const byCode = await get(`/api/search/lookup?code=${bar}`);
      assert.equal(byCode.body.data.product.id, "paracetamol-500");
      const sku = (await get("/api/products/paracetamol-500")).body.data.product.sku;
      assert.equal((await get(`/api/search/lookup?code=${sku}`)).body.data.product.id, "paracetamol-500");
      assert.equal((await get("/api/search/lookup?code=000000")).status, 404);
    });

    it("generic-name search finds medicines by their generic", async () => {
      const res = await get("/api/products?q=cetirizine");
      assert.ok(res.body.data.items.some((p) => p.id === "cetirizine-10"));
    });

    it("category filter includes subcategories; sort orders by effective price; onSale and attribute filters narrow", async () => {
      const g = await get("/api/products?category=grocery&pageSize=100");
      assert.ok(g.body.data.items.length > 3);
      assert.ok(g.body.data.items.every((p) => p.categoryId.startsWith("grocery")));
      const asc = (await get("/api/products?category=grocery&sort=price_asc&pageSize=100")).body.data.items.map((p) => p.salePrice ?? p.price);
      assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
      const sale = await get("/api/products?onSale=true&pageSize=100");
      assert.ok(sale.body.data.items.every((p) => p.salePrice != null && p.salePrice < p.price));
      const veg = await get("/api/products?category=grocery&attr.dietary=Veg&pageSize=100");
      assert.ok(veg.body.data.items.length > 0 && veg.body.data.items.every((p) => p.attributes.dietary === "Veg"));
    });

    it("stock filter respects the branch", async () => {
      const res = await get("/api/products?inStock=true&branch=store-02&pageSize=100");
      assert.ok(res.body.data.items.every((p) => (p.variants ? p.variants.some((v) => (v.stock["store-02"] ?? 0) > 0) : (p.stock["store-02"] ?? 0) > 0)));
    });

    it("SQL-injection payloads are inert", async () => {
      const res = await get(`/api/products?q=${encodeURIComponent("'; DROP TABLE products; --")}&tag=${encodeURIComponent("x' OR '1'='1")}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.total, 0);
      assert.equal((await get("/api/products?pageSize=1")).status, 200);
    });

    it("medicine detail exposes batches (no cost) to the public and with cost to staff who can see inventory", async () => {
      const anon = (await get("/api/products/paracetamol-500")).body.data.product;
      assert.ok(anon.batches.length >= 2);
      assert.ok(anon.batches.every((b) => !("cost" in b)));
      assert.ok(!anon.batches.some((b) => b.batch === "LEGACY-OPENING"), "quarantined stock is never shown as a batch");
      const staff = (await get("/api/products/paracetamol-500", adminAuth)).body.data.product;
      assert.ok(staff.batches.every((b) => typeof b.cost === "number"));
    });

    it("variant products carry per-variant stock", async () => {
      const p = (await get("/api/products/basmati-rice-5kg")).body.data.product;
      assert.equal(p.variants.length, 3);
      assert.equal(p.variants.find((v) => v.id === "r5").stock["store-01"], 22);
      assert.equal(p.stock, undefined);
    });

    it("facets for a category: filterable attributes with real values, brands present, price ceiling", async () => {
      const f = (await get("/api/products/facets?category=grocery")).body.data;
      assert.ok(f.attributes.some((a) => a.key === "dietary" && a.values.length > 1));
      assert.ok(f.brands.length > 0);
      assert.ok(f.priceCeiling >= 10);
    });

    it("suggest is prefix-based and capped at 20", async () => {
      const s = (await get("/api/search/suggest?q=pa")).body.data.suggestions;
      assert.ok(s.length > 0 && s.length <= 20);
      assert.ok(s.every((x) => ["product", "category", "brand"].includes(x.type)));
      assert.ok(s.filter((x) => x.type === "product").every((x) => x.tier !== null));
    });

    it("categories carry productCount for their whole subtree; brands list is public", async () => {
      const cats = (await get("/api/categories")).body.data.categories;
      const grocery = cats.find((c) => c.id === "grocery");
      assert.ok(grocery.productCount >= 1);
      assert.equal(grocery.parent, null);
      assert.ok(cats.find((c) => c.id === "grocery-snacks").parent === "grocery");
      assert.ok((await get("/api/brands")).body.data.brands.length >= 15);
    });
  });

  describe("writes", () => {
    it("anonymous → 401, customer → 403 on every catalogue write", async () => {
      const body = newProduct();
      assert.equal((await ctx.request.post("/api/products").send(body)).status, 401);
      assert.equal((await ctx.request.post("/api/products").set(customerAuth).send(body)).status, 403);
      assert.equal((await ctx.request.put("/api/products/paracetamol-500").set(customerAuth).send(body)).status, 403);
      assert.equal((await ctx.request.delete("/api/products/paracetamol-500").set(customerAuth)).status, 403);
      assert.equal((await ctx.request.post("/api/categories").set(customerAuth).send({ name: "x" })).status, 403);
      assert.equal((await ctx.request.post("/api/categories/grocery/toggle").set(customerAuth)).status, 403);
      assert.equal((await ctx.request.post("/api/brands").set(customerAuth).send({ name: "x" })).status, 403);
    });

    it("admin creates a product; stock and rating supplied by the client are ignored", async () => {
      const res = await ctx.request.post("/api/products").set(adminAuth).send({ ...newProduct(), rating: 5, sold: 999, stock: { "store-01": 500 } });
      assert.equal(res.status, 201);
      const p = res.body.data.product;
      assert.equal(p.rating, 0);
      assert.equal(p.sold, 0);
      assert.deepEqual(p.stock, {});
      assert.equal((await get(`/api/products/${p.id}`)).status, 200);
    });

    it("opening stock is recorded and shows up in the product's stock map", async () => {
      const res = await ctx.request.post("/api/products").set(adminAuth).send({ ...newProduct(), openingStock: { "store-01": 7 } });
      assert.equal(res.status, 201);
      assert.deepEqual(res.body.data.product.stock, { "store-01": 7 });
    });

    it("validation: bad money, sale above price, unknown attribute, bad select value", async () => {
      const post = (over) => ctx.request.post("/api/products").set(adminAuth).send(newProduct(over));
      assert.equal((await post({ price: -1 })).status, 400);
      assert.equal((await post({ price: 5, salePrice: 9 })).status, 400);
      assert.equal((await post({ price: 1.234 })).status, 400);
      assert.equal((await post({ attributes: { nonsense: "x" } })).body.code, "INVALID_ATTRIBUTES");
      assert.equal((await post({ categoryId: "grocery", attributes: { dietary: "Carnivore" } })).body.code, "INVALID_ATTRIBUTES");
      assert.equal((await post({ categoryId: "nope-nope" })).body.code, "CATEGORY_NOT_FOUND");
    });

    it("duplicate SKU → 409 SKU_TAKEN with a field error; a free-typed brand is registered", async () => {
      const a = newProduct();
      assert.equal((await ctx.request.post("/api/products").set(adminAuth).send(a)).status, 201);
      const dup = await ctx.request.post("/api/products").set(adminAuth).send({ ...newProduct(), sku: a.sku });
      assert.equal(dup.status, 409);
      assert.equal(dup.body.code, "SKU_TAKEN");
      assert.equal(dup.body.details[0].path, "body.sku");
      const brand = `IT Brand ${uniq()}`;
      const created = await ctx.request.post("/api/products").set(adminAuth).send({ ...newProduct(), brandId: undefined, brandName: brand });
      assert.equal(created.status, 201);
      assert.ok((await get("/api/brands")).body.data.brands.some((b) => b.name === brand));
    });

    it("update writes audit entries (price changes separately), bumps version, and rejects stale versions", async () => {
      const created = (await ctx.request.post("/api/products").set(adminAuth).send(newProduct())).body.data.product;
      const upd = await ctx.request.put(`/api/products/${created.id}`).set(adminAuth).send({ ...newProduct({ sku: created.sku, name: created.name }), price: 20, salePrice: 15 });
      assert.equal(upd.status, 200);
      assert.equal(upd.body.data.product.version, created.version + 1);
      const { rows } = await ctx.container.pool.query("SELECT action, old_value, new_value FROM audit_logs WHERE entity_type='product' AND entity_id=$1 ORDER BY id", [created.id]);
      assert.deepEqual(rows.map((r) => r.action), ["product.created", "product.updated", "product.price_changed"]);
      assert.equal(rows[2].old_value.price, 10);
      assert.equal(rows[2].new_value.price, 20);
      const stale = await ctx.request.put(`/api/products/${created.id}`).set(adminAuth).send({ ...newProduct({ sku: created.sku, name: created.name }), version: created.version });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.code, "STALE_PRODUCT");
    });

    it("inactive products are hidden from the public but visible to managers; delete is soft and frees the SKU", async () => {
      const p = newProduct({ status: "inactive" });
      const created = (await ctx.request.post("/api/products").set(adminAuth).send(p)).body.data.product;
      assert.equal((await get(`/api/products/${created.id}`)).status, 404);
      assert.equal((await get(`/api/products/${created.id}`, adminAuth)).status, 200);
      assert.ok(!(await get(`/api/products?q=${encodeURIComponent(p.name)}`)).body.data.items.some((x) => x.id === created.id));
      assert.ok((await get(`/api/products?q=${encodeURIComponent(p.name)}&status=any`, adminAuth)).body.data.items.some((x) => x.id === created.id));

      assert.equal((await ctx.request.delete(`/api/products/${created.id}`).set(adminAuth)).status, 200);
      assert.equal((await get(`/api/products/${created.id}`, adminAuth)).status, 404);
      const { rows } = await ctx.container.pool.query("SELECT deleted_at FROM products WHERE id = $1", [created.id]);
      assert.ok(rows[0].deleted_at, "row is kept for order/stock history");
      assert.equal((await ctx.request.post("/api/products").set(adminAuth).send({ ...newProduct(), sku: p.sku })).status, 201);
    });

    it("categories: admin can create, update and toggle; cycles are refused; changes are audited", async () => {
      const id = `it-cat-${uniq()}`;
      const made = await ctx.request.post("/api/categories").set(adminAuth).send({ id, name: `IT ${id}`, parent: "grocery", attributes: [{ key: "size", label: "Size", type: "text" }] });
      assert.equal(made.status, 201);
      const cyc = await ctx.request.put("/api/categories/grocery").set(adminAuth).send({ name: "Grocery", parent: id, status: "active" });
      assert.equal(cyc.status, 400);
      assert.equal(cyc.body.code, "CATEGORY_CYCLE");
      const t = await ctx.request.post(`/api/categories/${id}/toggle`).set(adminAuth);
      assert.equal(t.body.data.category.status, "inactive");
      assert.ok(!(await get("/api/categories")).body.data.categories.some((c) => c.id === id), "inactive categories are hidden from the storefront");
      assert.ok((await get("/api/categories?includeInactive=true", adminAuth)).body.data.categories.some((c) => c.id === id));
      const { rows } = await ctx.container.pool.query("SELECT action FROM audit_logs WHERE entity_type='category' AND entity_id=$1 ORDER BY id", [id]);
      assert.deepEqual(rows.map((r) => r.action), ["category.created", "category.status_changed"]);
    });

    it("brands: duplicate names are refused", async () => {
      const name = `IT Brand ${uniq()}`;
      assert.equal((await ctx.request.post("/api/brands").set(adminAuth).send({ name })).status, 201);
      assert.equal((await ctx.request.post("/api/brands").set(adminAuth).send({ name: name.toUpperCase() })).body.code, "BRAND_EXISTS");
    });
  });

  describe("demo seed integrity", () => {
    it("every batch-tracked medicine reconciles: batches (incl. quarantined legacy) equal on-hand per branch", async () => {
      const { rows } = await ctx.container.pool.query(`
        SELECT i.product_id, i.branch_id, i.on_hand, COALESCE(b.qty, 0) AS batch_qty
          FROM (SELECT product_id, branch_id, sum(on_hand) AS on_hand FROM inventory GROUP BY 1, 2) i
          JOIN (SELECT DISTINCT product_id FROM inventory_batches) bp ON bp.product_id = i.product_id
          LEFT JOIN (SELECT product_id, branch_id, sum(qty) AS qty FROM inventory_batches GROUP BY 1, 2) b ON b.product_id = i.product_id AND b.branch_id = i.branch_id`);
      assert.ok(rows.length > 0);
      for (const r of rows) assert.equal(Number(r.batch_qty), Number(r.on_hand), `${r.product_id}@${r.branch_id}`);
    });

    it("FEFO ordering data: real batches have an expiry, quarantined ones do not", async () => {
      const { rows } = await ctx.container.pool.query("SELECT is_legacy_opening, count(*) FILTER (WHERE expiry_date IS NULL) AS no_expiry, count(*) AS n FROM inventory_batches GROUP BY 1");
      for (const r of rows) assert.equal(Number(r.no_expiry), r.is_legacy_opening ? Number(r.n) : 0);
    });
  });
});
