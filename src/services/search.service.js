import { toProductDto } from "../models/catalog.model.js";
import { notFound } from "../utils/errors.js";
import { normTerm } from "../utils/text.js";

/**
 * Storefront/POS search: ranked autocomplete, exact barcode/SKU lookup, and category facets.
 * Matching is PREFIX-based (never "contains"), so typing "l" does not surface "Paracetamol".
 */
export function createSearchService({ pool, repos }) {
  const { products, catalog } = repos;
  const PUBLIC = ["active"];
  const canCost = (actor) => !!actor?.permissions?.includes("inventory:read");

  return {
    /** Products first (best tier first), then categories and brands whose name starts with the term. Max `limit` rows. */
    async suggest({ q, limit }) {
      const term = normTerm(q);
      if (!term) return [];
      const out = (await products.suggestProducts(pool, { q: term, statuses: PUBLIC, limit }))
        .map((r) => ({ type: "product", id: r.id, label: r.name, sub: r.brand_name, tier: r.tier }));
      if (out.length < limit) {
        for (const c of await catalog.listCategories(pool)) {
          if (out.length >= limit) break;
          if (normTerm(c.name).startsWith(term)) out.push({ type: "category", id: c.id, label: c.name, sub: c.parent_id ? "Subcategory" : "Category" });
        }
      }
      if (out.length < limit) {
        for (const b of await catalog.listBrands(pool)) {
          if (out.length >= limit) break;
          if (normTerm(b.name).startsWith(term)) out.push({ type: "brand", id: b.id, label: b.name, sub: "Brand" });
        }
      }
      return out.slice(0, limit);
    },

    /** Exact barcode or SKU (product or variant) -> the one product, for scanners and the POS search box. */
    async lookup({ code }, actor) {
      const c = code.trim();
      const { rows } = await products.search(pool, { barcode: c, statuses: PUBLIC, sort: "relevance", page: 1, pageSize: 1 })
        .then((r) => (r.rows.length ? r : products.search(pool, { sku: c, statuses: PUBLIC, sort: "relevance", page: 1, pageSize: 1 })));
      if (!rows.length) throw notFound("PRODUCT_NOT_FOUND", "No product matches that code");
      const hydrated = await products.hydrate(pool, rows, { includeBatchCost: canCost(actor) });
      return toProductDto(rows[0], hydrated);
    },

    /** Filter options for a category page: its declared filterable attributes (with the values that actually exist), brands present, price ceiling. */
    async facets({ category, q }) {
      const term = normTerm(q) || null;
      const base = { statuses: PUBLIC, q: term, categoryIds: category ? await catalog.categoryTreeIds(pool, category) : null };
      let attributes = [];
      if (category) {
        const chain = await catalog.categoryAncestry(pool, category);
        const schema = chain.find((c) => c.attributes != null)?.attributes ?? [];
        for (const a of schema.filter((x) => x.filterable)) {
          const values = await products.attributeValues(pool, { ...base, key: a.key });
          if (values.length > 1) attributes.push({ key: a.key, label: a.label, type: a.type, options: a.options ?? null, filterable: true, highlight: !!a.highlight, values });
        }
      }
      const [brands, top] = await Promise.all([products.brandFacets(pool, base), products.priceCeiling(pool, base)]);
      return { attributes, brands, priceCeiling: Math.ceil(Math.max(10, top)) };
    },
  };
}
