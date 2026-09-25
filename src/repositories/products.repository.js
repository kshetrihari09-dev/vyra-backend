import { escapeLike } from "../utils/text.js";

/**
 * Products: paginated/filtered/ranked listing, hydration (variants, stock, batches, images), writes.
 * The listing is built dynamically but ONLY from whitelisted fragments; every user-supplied value is a bound parameter.
 */

const EFFECTIVE_PRICE = "COALESCE(p.sale_price, p.price)";
const DISCOUNT_PCT = `(CASE WHEN p.price > ${EFFECTIVE_PRICE} THEN round((p.price - ${EFFECTIVE_PRICE}) / p.price * 100) ELSE 0 END)`;

const SORTS = {
  price_asc: `${EFFECTIVE_PRICE} ASC, p.id`,
  price_desc: `${EFFECTIVE_PRICE} DESC, p.id`,
  rating: "p.rating DESC, p.review_count DESC, p.id",
  newest: "p.created_at DESC, p.id",
  bestselling: "p.sold_count DESC, p.id",
  discount: `${DISCOUNT_PCT} DESC, p.id`,
};

/**
 * Prefix-ranked match tier — the same ladder the storefront used, plus generic name and category (requested for
 * pharmacy look-ups). Lower tier ranks first; NULL = no match.
 *   0 exact barcode · 1 exact SKU (product or variant) · 2 barcode prefix · 3 SKU prefix · 4 name prefix
 *   5 a word in the name starts with it · 6 generic name · 7 brand name · 8 category name
 */
function tierSql(T, L) {
  return `(CASE
    WHEN lower(p.barcode) = ${T} OR EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.barcode = ${T}) THEN 0
    WHEN lower(p.sku) = ${T} OR EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND lower(v.sku) = ${T}) THEN 1
    WHEN lower(p.barcode) LIKE ${L} || '%' THEN 2
    WHEN lower(p.sku) LIKE ${L} || '%' OR EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND lower(v.sku) LIKE ${L} || '%') THEN 3
    WHEN lower(p.name) LIKE ${L} || '%' THEN 4
    WHEN lower(p.name) LIKE '% ' || ${L} || '%' THEN 5
    WHEN lower(p.attributes->>'genericName') LIKE ${L} || '%' OR lower(p.attributes->>'genericName') LIKE '% ' || ${L} || '%' THEN 6
    WHEN lower(b.name) LIKE ${L} || '%' THEN 7
    WHEN lower(c.name) LIKE ${L} || '%' THEN 8
  END)`;
}

/** Parameter collector: push(value) returns its "$n" placeholder. */
function params() {
  const values = [];
  return { values, push: (v) => { values.push(v); return `$${values.length}`; } };
}

/** Builds { where, values, tier } for a listing. `f` has already been validated by the service/validators. */
function buildFilters(f) {
  const { values, push } = params();
  const where = ["p.deleted_at IS NULL"];
  let tier = null;

  if (f.statuses?.length) where.push(`p.status = ANY(${push(f.statuses)}::text[])`);
  if (f.ids?.length) where.push(`p.id = ANY(${push(f.ids)}::text[])`);
  if (f.categoryIds?.length) where.push(`p.category_id = ANY(${push(f.categoryIds)}::text[])`);
  if (f.brandIds?.length) where.push(`p.brand_id = ANY(${push(f.brandIds)}::text[])`);
  if (f.sellerId) where.push(`p.seller_id = ${push(f.sellerId)}`);
  if (f.tag) where.push(`${push(f.tag)}::text = ANY(p.tags)`);
  if (f.sku) where.push(`(lower(p.sku) = ${push(f.sku.toLowerCase())} OR EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND lower(v.sku) = ${push(f.sku.toLowerCase())}))`);
  if (f.barcode) where.push(`(p.barcode = ${push(f.barcode)} OR EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.barcode = ${push(f.barcode)}))`);
  if (f.minPrice != null) where.push(`${EFFECTIVE_PRICE} >= ${push(f.minPrice)}`);
  if (f.maxPrice != null) where.push(`${EFFECTIVE_PRICE} <= ${push(f.maxPrice)}`);
  if (f.minRating) where.push(`p.rating >= ${push(f.minRating)}`);
  if (f.minDiscount) where.push(`${DISCOUNT_PCT} >= ${push(f.minDiscount)}`);
  if (f.onSale) where.push(`${DISCOUNT_PCT} > 0`);
  if (f.inStock) {
    where.push(`EXISTS (SELECT 1 FROM inventory i WHERE i.product_id = p.id AND (i.on_hand - i.reserved) > 0${f.branchId ? ` AND i.branch_id = ${push(f.branchId)}` : ""})`);
  }
  for (const [key, value] of Object.entries(f.attrs || {})) {
    const k = `${push(key)}::text`; // explicit cast: without it Postgres cannot choose between the ->> (text) and ->> (int) operators
    const v = `${push(String(value))}::text`;
    where.push(`(p.attributes ->> ${k} = ${v} OR EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id AND pv.options ->> ${k} = ${v}))`);
  }
  if (f.q) {
    const T = push(f.q);
    const L = push(escapeLike(f.q));
    tier = tierSql(T, L);
    where.push(`${tier} IS NOT NULL`);
  }
  return { where: where.join(" AND "), values, push, tier };
}

const FROM = "FROM products p JOIN brands b ON b.id = p.brand_id JOIN categories c ON c.id = p.category_id";

export function createProductsRepository() {
  return {
    /** @returns {{ rows: object[], total: number }} */
    async search(db, f) {
      const { where, values, push, tier } = buildFilters(f);
      const total = Number((await db.query(`SELECT count(*) AS n ${FROM} WHERE ${where}`, values)).rows[0].n);

      let order;
      if ((f.sort === "relevance" || !f.sort) && tier) order = `${tier}, p.sold_count DESC, p.rating DESC, p.id`;
      else order = SORTS[f.sort] ?? "p.sold_count DESC, p.id";

      const limit = push(f.pageSize);
      const offset = push((f.page - 1) * f.pageSize);
      const { rows } = await db.query(`SELECT p.* ${FROM} WHERE ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, values);
      return { rows, total };
    },

    /** Ranked autocomplete (products only; categories/brands are matched in the service). */
    async suggestProducts(db, { q, statuses, limit }) {
      const { where, values, push, tier } = buildFilters({ q, statuses });
      const lim = push(limit);
      const { rows } = await db.query(
        `SELECT p.id, p.name, b.name AS brand_name, ${tier} AS tier ${FROM} WHERE ${where}
          ORDER BY ${tier}, p.sold_count DESC, p.id LIMIT ${lim}`,
        values,
      );
      return rows;
    },

    async getById(db, id, { forUpdate = false } = {}) {
      const { rows } = await db.query(`SELECT * FROM products WHERE id = $1 AND deleted_at IS NULL${forUpdate ? " FOR UPDATE" : ""}`, [id]);
      return rows[0] || null;
    },

    async idExists(db, id) {
      return (await db.query("SELECT 1 FROM products WHERE id = $1", [id])).rows.length > 0;
    },

    async slugExists(db, slug, exceptId = null) {
      return (await db.query("SELECT 1 FROM products WHERE slug = $1 AND deleted_at IS NULL AND id <> COALESCE($2, '')", [slug, exceptId])).rows.length > 0;
    },

    /** Loads variants, stock, batches and images for a page of product rows in four queries (no N+1). */
    async hydrate(db, productRows, { includeBatchCost = false } = {}) {
      const ids = productRows.map((r) => r.id);
      const out = { variants: new Map(), stock: new Map(), batches: new Map(), images: new Map() };
      if (!ids.length) return out;

      for (const v of (await db.query("SELECT * FROM product_variants WHERE product_id = ANY($1::text[]) ORDER BY product_id, sort_order, id", [ids])).rows) {
        if (!out.variants.has(v.product_id)) out.variants.set(v.product_id, []);
        out.variants.get(v.product_id).push(v);
      }
      for (const s of (await db.query(
        "SELECT product_id, COALESCE(variant_id, '') AS variant_id, branch_id, (on_hand - reserved) AS qty FROM inventory WHERE product_id = ANY($1::text[])", [ids])).rows) {
        const byVariant = out.stock.get(s.product_id) ?? {};
        (byVariant[s.variant_id] ??= {})[s.branch_id] = Number(s.qty);
        out.stock.set(s.product_id, byVariant);
      }
      for (const b of (await db.query(
        `SELECT product_id, batch_no, to_char(min(expiry_date), 'YYYY-MM-DD') AS expiry, sum(qty)::int AS qty, max(purchase_cost) AS cost
           FROM inventory_batches
          WHERE product_id = ANY($1::text[]) AND NOT is_legacy_opening AND qty > 0
          GROUP BY product_id, batch_no ORDER BY min(expiry_date), batch_no`, [ids])).rows) {
        if (!out.batches.has(b.product_id)) out.batches.set(b.product_id, []);
        out.batches.get(b.product_id).push({ batch: b.batch_no, expiry: b.expiry, qty: b.qty, ...(includeBatchCost && b.cost != null ? { cost: Number(b.cost) } : {}) });
      }
      for (const i of (await db.query("SELECT product_id, storage_key, alt_text, is_primary FROM product_images WHERE product_id = ANY($1::text[]) ORDER BY product_id, sort_order", [ids])).rows) {
        if (!out.images.has(i.product_id)) out.images.set(i.product_id, []);
        out.images.get(i.product_id).push({ key: i.storage_key, alt: i.alt_text, primary: i.is_primary });
      }
      return out;
    },

    // ------------------------------------------------------------------ facets
    /** Distinct values of one attribute across a category's products (base attribute + variant options). */
    async attributeValues(db, { key, categoryIds, statuses, q }) {
      const { where, values, push } = buildFilters({ categoryIds, statuses, q });
      const k = `${push(key)}::text`;
      const { rows } = await db.query(
        `SELECT DISTINCT val FROM (
           SELECT p.attributes ->> ${k} AS val ${FROM} WHERE ${where}
           UNION
           SELECT pv.options ->> ${k} FROM product_variants pv JOIN products p ON p.id = pv.product_id
             JOIN brands b ON b.id = p.brand_id JOIN categories c ON c.id = p.category_id WHERE ${where}
         ) t WHERE val IS NOT NULL AND val <> '' AND val <> '—' ORDER BY val`,
        values,
      );
      return rows.map((r) => r.val);
    },

    async brandFacets(db, { categoryIds, statuses, q }) {
      const { where, values } = buildFilters({ categoryIds, statuses, q });
      const { rows } = await db.query(`SELECT b.id, b.name, count(*)::int AS count ${FROM} WHERE ${where} GROUP BY b.id, b.name ORDER BY lower(b.name)`, values);
      return rows;
    },

    async priceCeiling(db, { categoryIds, statuses, q }) {
      const { where, values } = buildFilters({ categoryIds, statuses, q });
      const { rows } = await db.query(`SELECT COALESCE(max(${EFFECTIVE_PRICE}), 0) AS top ${FROM} WHERE ${where}`, values);
      return Number(rows[0].top);
    },

    // ------------------------------------------------------------------ writes
    async insert(db, p) {
      const { rows } = await db.query(
        `INSERT INTO products (id, name, slug, category_id, brand_id, seller_id, description, price, sale_price, tax_percent, sku, barcode, unit, moq, max_qty,
                               status, delivery_available, prescription_required, tags, art, attributes, composition, usage_instructions, side_effects)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21::jsonb,$22,$23,$24) RETURNING *`,
        [p.id, p.name, p.slug, p.categoryId, p.brandId, p.sellerId ?? null, p.description ?? "", p.price, p.salePrice ?? null, p.tax ?? 0, p.sku, p.barcode || null,
         p.unit ?? "piece", p.moq ?? 1, p.maxQty ?? 10, p.status ?? "active", p.deliveryAvailable ?? true, !!p.flags?.prescriptionRequired, p.tags ?? [],
         p.art == null ? null : JSON.stringify(p.art), JSON.stringify(p.attributes ?? {}), p.composition ?? null, p.usage ?? null, p.sideEffects ?? null],
      );
      return rows[0];
    },

    /** Full replace of the editable columns; bumps `version`. */
    async update(db, id, p) {
      const { rows } = await db.query(
        `UPDATE products SET name=$2, slug=$3, category_id=$4, brand_id=$5, seller_id=$6, description=$7, price=$8, sale_price=$9, tax_percent=$10, sku=$11,
                barcode=$12, unit=$13, moq=$14, max_qty=$15, status=$16, delivery_available=$17, prescription_required=$18, tags=$19, art=$20::jsonb,
                attributes=$21::jsonb, composition=$22, usage_instructions=$23, side_effects=$24, version = version + 1
          WHERE id=$1 AND deleted_at IS NULL RETURNING *`,
        [id, p.name, p.slug, p.categoryId, p.brandId, p.sellerId ?? null, p.description ?? "", p.price, p.salePrice ?? null, p.tax ?? 0, p.sku, p.barcode || null,
         p.unit ?? "piece", p.moq ?? 1, p.maxQty ?? 10, p.status, p.deliveryAvailable ?? true, !!p.flags?.prescriptionRequired, p.tags ?? [],
         p.art == null ? null : JSON.stringify(p.art), JSON.stringify(p.attributes ?? {}), p.composition ?? null, p.usage ?? null, p.sideEffects ?? null],
      );
      return rows[0] || null;
    },

    async softDelete(db, id) {
      const { rowCount } = await db.query("UPDATE products SET deleted_at = now(), status = 'inactive' WHERE id = $1 AND deleted_at IS NULL", [id]);
      return rowCount > 0;
    },

    async setStatus(db, id, status) {
      const { rows } = await db.query("UPDATE products SET status = $2, version = version + 1 WHERE id = $1 AND deleted_at IS NULL RETURNING *", [id, status]);
      return rows[0] || null;
    },

    // ------------------------------------------------------------------ variants
    async listVariants(db, productId) {
      return (await db.query("SELECT * FROM product_variants WHERE product_id = $1 ORDER BY sort_order, id", [productId])).rows;
    },

    async upsertVariant(db, productId, v, sortOrder) {
      await db.query(
        `INSERT INTO product_variants (product_id, id, label, options, price, sale_price, sku, barcode, sort_order)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)
         ON CONFLICT (product_id, id) DO UPDATE SET label=EXCLUDED.label, options=EXCLUDED.options, price=EXCLUDED.price,
           sale_price=EXCLUDED.sale_price, sku=EXCLUDED.sku, barcode=EXCLUDED.barcode, sort_order=EXCLUDED.sort_order`,
        [productId, v.id, v.label, JSON.stringify(v.options ?? {}), v.price, v.salePrice ?? null, v.sku, v.barcode || null, sortOrder],
      );
    },

    async deleteVariant(db, productId, variantId) {
      await db.query("DELETE FROM product_variants WHERE product_id = $1 AND id = $2", [productId, variantId]);
    },

    async variantStock(db, productId, variantId) {
      const { rows } = await db.query("SELECT COALESCE(sum(on_hand), 0)::int AS n FROM inventory WHERE product_id = $1 AND variant_id = $2", [productId, variantId]);
      return rows[0].n;
    },

    /** Opening stock recorded at product creation (later stock changes go through the Phase 4 inventory API). */
    async setOpeningStock(db, { branchId, productId, variantId = null, qty }) {
      await db.query(
        `INSERT INTO inventory (branch_id, product_id, variant_id, on_hand) VALUES ($1,$2,$3,$4)
         ON CONFLICT (branch_id, product_id, COALESCE(variant_id, '')) DO UPDATE SET on_hand = EXCLUDED.on_hand`,
        [branchId, productId, variantId, qty],
      );
    },

    /** How the product's current stock is keyed: rows without a variant vs rows with one (used to block structural changes that would orphan stock). */
    async stockShape(db, productId) {
      const { rows } = await db.query(
        `SELECT COALESCE(sum(on_hand) FILTER (WHERE variant_id IS NULL), 0)::int AS simple,
                COALESCE(sum(on_hand) FILTER (WHERE variant_id IS NOT NULL), 0)::int AS variant
           FROM inventory WHERE product_id = $1`, [productId]);
      return rows[0];
    },

    async branchIds(db) {
      return (await db.query("SELECT id FROM branches WHERE is_active ORDER BY sort_order, id")).rows.map((r) => r.id);
    },
  };
}
