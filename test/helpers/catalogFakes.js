/** In-memory catalogue repositories (DB-shaped rows) for service-level tests. */
export function createFakeCatalog() {
  const db = {
    categories: [
      { id: "health", name: "Medicines & Healthcare", slug: "health", parent_id: null, status: "active", sort_order: 1, unit_label: "pack", modules: ["prescription", "batch"],
        attributes: [{ key: "genericName", label: "Generic name", type: "text" }, { key: "dosageForm", label: "Form", type: "select", options: ["Tablet", "Syrup"], filterable: true }] },
      { id: "health-medicines", name: "Medicines", slug: "medicines", parent_id: "health", status: "active", sort_order: 1, attributes: null, modules: null },
      { id: "grocery", name: "Grocery", slug: "grocery", parent_id: null, status: "active", sort_order: 2, modules: null,
        attributes: [{ key: "weight", label: "Weight", type: "text" }] },
    ],
    brands: [{ id: "cipla", name: "Cipla", status: "active" }],
    products: [], variants: [], inventory: [], branches: ["store-01", "store-02"],
  };
  let version = 0;

  const catalog = {
    async categoryAncestry(_d, id) {
      const out = []; let cur = db.categories.find((c) => c.id === id);
      while (cur) { out.push(cur); cur = db.categories.find((c) => c.id === cur.parent_id); }
      return out;
    },
    async categoryTreeIds(_d, id) { return [id, ...db.categories.filter((c) => c.parent_id === id).map((c) => c.id)]; },
    async getBrand(_d, id) { return db.brands.find((b) => b.id === id) ?? null; },
    async findBrandByName(_d, name) { return db.brands.find((b) => b.name.toLowerCase() === name.trim().toLowerCase()) ?? null; },
    async insertBrand(_d, b) { db.brands.push({ status: "active", ...b }); return b; },
    async listCategories() { return db.categories; },
    async listBrands() { return db.brands; },
  };

  const products = {
    async getById(_d, id) { return db.products.find((p) => p.id === id && !p.deleted_at) ?? null; },
    async idExists(_d, id) { return db.products.some((p) => p.id === id); },
    async slugExists(_d, slug, except) { return db.products.some((p) => p.slug === slug && !p.deleted_at && p.id !== except); },
    async insert(_d, p) {
      if (db.products.some((x) => !x.deleted_at && x.sku.toLowerCase() === p.sku.toLowerCase())) throw Object.assign(new Error("dup"), { code: "23505", constraint: "products_sku_key" });
      const row = { id: p.id, name: p.name, slug: p.slug, category_id: p.categoryId, brand_id: p.brandId, seller_id: p.sellerId ?? null, description: p.description ?? "", price: p.price, sale_price: p.salePrice ?? null,
        tax_percent: p.tax ?? 0, sku: p.sku, barcode: p.barcode ?? null, unit: p.unit, moq: p.moq, max_qty: p.maxQty, rating: 0, review_count: 0, sold_count: 0, status: p.status, delivery_available: true,
        prescription_required: !!p.flags?.prescriptionRequired, tags: p.tags ?? [], art: p.art ?? null, attributes: p.attributes ?? {}, version: ++version && 1, created_at: new Date("2026-09-20"), deleted_at: null };
      db.products.push(row); return row;
    },
    async update(_d, id, p) {
      const row = db.products.find((x) => x.id === id);
      Object.assign(row, { name: p.name, slug: p.slug, category_id: p.categoryId, brand_id: p.brandId, price: p.price, sale_price: p.salePrice ?? null, tax_percent: p.tax ?? 0, sku: p.sku,
        status: p.status, attributes: p.attributes ?? {}, version: row.version + 1 });
      return row;
    },
    async softDelete(_d, id) { const r = db.products.find((x) => x.id === id); r.deleted_at = new Date(); return true; },
    async hydrate(_d, rows) {
      const variants = new Map(); const stock = new Map();
      for (const r of rows) {
        const vs = db.variants.filter((v) => v.product_id === r.id); if (vs.length) variants.set(r.id, vs);
        const s = {}; for (const i of db.inventory.filter((x) => x.product_id === r.id)) (s[i.variant_id ?? ""] ??= {})[i.branch_id] = i.on_hand; stock.set(r.id, s);
      }
      return { variants, stock, batches: new Map(), images: new Map() };
    },
    async listVariants(_d, pid) { return db.variants.filter((v) => v.product_id === pid); },
    async upsertVariant(_d, pid, v, sort) {
      const i = db.variants.findIndex((x) => x.product_id === pid && x.id === v.id);
      const row = { product_id: pid, id: v.id, label: v.label, options: v.options ?? {}, price: v.price, sale_price: v.salePrice ?? null, sku: v.sku, barcode: v.barcode ?? null, sort_order: sort };
      if (i >= 0) db.variants[i] = row; else db.variants.push(row);
    },
    async deleteVariant(_d, pid, vid) { db.variants = db.variants.filter((v) => !(v.product_id === pid && v.id === vid)); },
    async variantStock(_d, pid, vid) { return db.inventory.filter((i) => i.product_id === pid && i.variant_id === vid).reduce((s, i) => s + i.on_hand, 0); },
    async stockShape(_d, pid) {
      const rows = db.inventory.filter((i) => i.product_id === pid);
      return { simple: rows.filter((i) => i.variant_id == null).reduce((s, i) => s + i.on_hand, 0), variant: rows.filter((i) => i.variant_id != null).reduce((s, i) => s + i.on_hand, 0) };
    },
    async setOpeningStock(_d, { branchId, productId, variantId = null, qty }) { db.inventory.push({ branch_id: branchId, product_id: productId, variant_id: variantId, on_hand: qty }); },
    async branchIds() { return db.branches; },
    /** Records how search() was called; returns the rows the test preloaded. */
    async search(_d, f) { products.lastSearch = f; return { rows: db.products.filter((p) => !p.deleted_at && f.statuses.includes(p.status)), total: db.products.length }; },
  };
  return { db, repos: { catalog, products } };
}

export const adminActor = { id: "u-admin", name: "Admin", roles: ["admin"], permissions: ["catalog:write", "catalog:price", "inventory:adjust", "inventory:read"] };
export const staffNoStock = { id: "u-cat", name: "Catalog", roles: ["x"], permissions: ["catalog:write"] };
