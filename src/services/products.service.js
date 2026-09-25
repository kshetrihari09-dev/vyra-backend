import { productAuditView, toProductDto } from "../models/catalog.model.js";
import { badRequest, conflict, forbidden, notFound } from "../utils/errors.js";
import { normTerm, slugify } from "../utils/text.js";

const MANAGE = "catalog:write";
const PUBLIC_STATUSES = ["active"];
const ALL_STATUSES = ["active", "inactive", "pending_review", "rejected", "draft"];

const can = (actor, perm) => !!actor?.permissions?.includes(perm);

/** Postgres unique-violation -> a specific 409 the form can show against the right field. */
function mapUniqueViolation(err) {
  if (err?.code !== "23505") return err;
  const byConstraint = {
    products_sku_key: ["SKU_TAKEN", "sku", "Another product already uses this SKU"],
    product_variants_sku_key: ["SKU_TAKEN", "sku", "Another variant already uses this SKU"],
    products_barcode_key: ["BARCODE_TAKEN", "barcode", "Another product already uses this barcode"],
    product_variants_barcode_key: ["BARCODE_TAKEN", "barcode", "Another variant already uses this barcode"],
    products_slug_key: ["SLUG_TAKEN", "slug", "Another product already uses this slug"],
    products_pkey: ["PRODUCT_EXISTS", "id", "A product with this id already exists"],
  };
  const hit = byConstraint[err.constraint];
  return hit ? conflict(hit[0], hit[2], [{ path: `body.${hit[1]}`, message: hit[2] }]) : err;
}

export function createProductsService({ pool, withTx, repos, audit }) {
  const { products, catalog } = repos;

  /** Resolves the attribute schema a category declares (inherited from ancestors when the child has none). */
  async function schemaFor(db, categoryId) {
    const chain = await catalog.categoryAncestry(db, categoryId);
    if (!chain.length) return null;
    const self = chain[0];
    const attributes = chain.find((c) => c.attributes != null)?.attributes ?? [];
    const modules = chain.find((c) => c.modules != null)?.modules ?? [];
    return { category: self, attributes, modules };
  }

  /** Attribute values must use keys the category declares and, for selects, one of its options. */
  function validateAttributes(schema, attributes) {
    const declared = new Map(schema.attributes.map((a) => [a.key, a]));
    const issues = [];
    for (const [key, value] of Object.entries(attributes || {})) {
      const def = declared.get(key);
      if (!def) issues.push({ path: `body.attributes.${key}`, message: `"${key}" is not an attribute of this category` });
      else if (def.type === "select" && value !== "" && !(def.options || []).includes(value)) issues.push({ path: `body.attributes.${key}`, message: `${def.label} must be one of: ${def.options.join(", ")}` });
    }
    if (issues.length) throw badRequest("INVALID_ATTRIBUTES", issues[0].message, issues);
  }

  async function resolveBrand(db, body) {
    if (body.brandId) {
      if (!(await catalog.getBrand(db, body.brandId))) throw badRequest("BRAND_NOT_FOUND", "Brand does not exist", [{ path: "body.brandId", message: "Brand does not exist" }]);
      return body.brandId;
    }
    if (body.brandName) {
      // Sellers/admins may type a brand that isn't registered yet: reuse an existing one by name or register it.
      const existing = await catalog.findBrandByName(db, body.brandName);
      if (existing) return existing.id;
      let id = slugify(body.brandName, 60) || "brand";
      for (let n = 2; await catalog.getBrand(db, id); n++) id = `${slugify(body.brandName, 55)}-${n}`;
      await catalog.insertBrand(db, { id, name: body.brandName.trim() });
      return id;
    }
    throw badRequest("BRAND_REQUIRED", "Choose a brand", [{ path: "body.brandId", message: "Choose a brand" }]);
  }

  async function checkCommon(db, body) {
    const schema = await schemaFor(db, body.categoryId);
    if (!schema) throw badRequest("CATEGORY_NOT_FOUND", "Category does not exist", [{ path: "body.categoryId", message: "Category does not exist" }]);
    validateAttributes(schema, body.attributes);
    const seen = new Set();
    for (const v of body.variants || []) {
      if (seen.has(v.id)) throw badRequest("DUPLICATE_VARIANT", `Variant id "${v.id}" is used twice`);
      seen.add(v.id);
    }
    return schema;
  }

  async function checkOpeningStock(db, actor, body) {
    const maps = [body.openingStock, ...(body.variants || []).map((v) => v.openingStock)].filter(Boolean);
    if (!maps.length) return;
    if (!can(actor, "inventory:adjust")) throw forbidden("FORBIDDEN", "You cannot set opening stock");
    const branches = new Set(await products.branchIds(db));
    for (const m of maps) for (const b of Object.keys(m)) if (!branches.has(b)) throw badRequest("BRANCH_NOT_FOUND", `Unknown branch "${b}"`);
  }

  async function writeOpeningStock(db, productId, body) {
    for (const [branchId, qty] of Object.entries(body.openingStock || {})) if (qty > 0) await products.setOpeningStock(db, { branchId, productId, qty });
    for (const v of body.variants || []) for (const [branchId, qty] of Object.entries(v.openingStock || {})) if (qty > 0) await products.setOpeningStock(db, { branchId, productId, variantId: v.id, qty });
  }

  async function load(db, row, actor) {
    const hydrated = await products.hydrate(db, [row], { includeBatchCost: can(actor, "inventory:read") });
    return toProductDto(row, hydrated);
  }

  return {
    /** Paginated, filtered, ranked listing. Anonymous/customers only ever see active products. */
    async list(query, actor) {
      const manage = can(actor, MANAGE);
      let statuses = PUBLIC_STATUSES;
      if (manage && query.status) statuses = query.status === "any" ? ALL_STATUSES : query.status.split(",").filter((s) => ALL_STATUSES.includes(s));
      if (query.sellerId && !manage && !can(actor, "seller:manage_own")) throw forbidden();

      const attrs = {};
      for (const [k, v] of Object.entries(query)) {
        if (k.startsWith("attr.") && /^attr\.[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k) && typeof v === "string" && v) attrs[k.slice(5)] = v;
      }
      const q = normTerm(query.q);
      const { rows, total } = await products.search(pool, {
        q: q || null, statuses,
        categoryIds: query.category ? await catalog.categoryTreeIds(pool, query.category) : null,
        brandIds: query.brand, tag: query.tag, onSale: query.onSale, inStock: query.inStock, branchId: query.branch,
        minPrice: query.minPrice, maxPrice: query.maxPrice, minRating: query.minRating, minDiscount: query.minDiscount,
        sku: query.sku, barcode: query.barcode, sellerId: query.sellerId, ids: query.ids, attrs,
        sort: query.sort, page: query.page, pageSize: query.pageSize,
      });
      const hydrated = await products.hydrate(pool, rows, { includeBatchCost: can(actor, "inventory:read") });
      return { items: rows.map((r) => toProductDto(r, hydrated)), page: query.page, pageSize: query.pageSize, total };
    },

    async get(id, actor) {
      const row = await products.getById(pool, id);
      if (!row || (row.status !== "active" && !can(actor, MANAGE))) throw notFound("PRODUCT_NOT_FOUND", "Product not found");
      return load(pool, row, actor);
    },

    async create(actor, body, ctx) {
      try {
        return await withTx(async (db) => {
          await checkCommon(db, body);
          await checkOpeningStock(db, actor, body);
          const brandId = await resolveBrand(db, body);

          let id = body.id ?? slugify(body.name, 70);
          if (!id) throw badRequest("INVALID_NAME", "Enter a product name");
          if (body.id) { if (await products.idExists(db, id)) throw conflict("PRODUCT_EXISTS", "A product with this id already exists"); }
          else for (let n = 2; await products.idExists(db, id); n++) id = `${slugify(body.name, 70)}-${n}`;

          let slug = body.slug ?? slugify(body.name);
          for (let n = 2; await products.slugExists(db, slug); n++) slug = `${slugify(body.name, 70)}-${n}`;

          const row = await products.insert(db, { ...body, id, slug, brandId });
          for (const [i, v] of (body.variants || []).entries()) await products.upsertVariant(db, id, v, i);
          await writeOpeningStock(db, id, body);
          const dto = await load(db, row, actor);
          await audit.log({ actor, action: "product.created", entityType: "product", entityId: id, newValue: productAuditView(dto) }, ctx, db);
          if (body.openingStock || (body.variants || []).some((v) => v.openingStock)) {
            await audit.log({ actor, action: "inventory.opening_stock", entityType: "product", entityId: id, newValue: { branches: body.openingStock ?? null, variants: (body.variants || []).filter((v) => v.openingStock).map((v) => ({ id: v.id, ...v.openingStock })) } }, ctx, db);
          }
          return dto;
        });
      } catch (err) {
        throw mapUniqueViolation(err);
      }
    },

    async update(actor, id, body, ctx) {
      try {
        return await withTx(async (db) => {
          const before = await products.getById(db, id, { forUpdate: true });
          if (!before) throw notFound("PRODUCT_NOT_FOUND", "Product not found");
          if (body.version != null && body.version !== before.version) throw conflict("STALE_PRODUCT", "This product was changed by someone else. Reload and try again.");
          await checkCommon(db, body);
          const brandId = await resolveBrand(db, { ...body, brandId: body.brandId ?? (body.brandName ? undefined : before.brand_id) });
          const beforeDto = await load(db, before, actor);

          let slug = body.slug ?? before.slug;
          if (await products.slugExists(db, slug, id)) slug = `${slugify(body.name, 70)}-${id}`.slice(0, 81);

          // Variants: sync to the submitted list. Refuse changes that would orphan stock.
          if (body.variants) {
            const existing = await products.listVariants(db, id);
            const keep = new Set(body.variants.map((v) => v.id));
            const shape = await products.stockShape(db, id);
            if (body.variants.length && !existing.length && shape.simple > 0) throw conflict("STOCK_STRUCTURE", "This product has stock without variants. Move or adjust that stock before adding variants.");
            if (!body.variants.length && existing.length && shape.variant > 0) throw conflict("STOCK_STRUCTURE", "Variants still hold stock. Adjust it to zero before removing them.");
            for (const v of existing) {
              if (!keep.has(v.id)) {
                if ((await products.variantStock(db, id, v.id)) > 0) throw conflict("VARIANT_HAS_STOCK", `Variant "${v.label}" still has stock`);
                await products.deleteVariant(db, id, v.id);
              }
            }
            for (const [i, v] of body.variants.entries()) await products.upsertVariant(db, id, v, i);
          }

          const row = await products.update(db, id, { ...body, brandId, slug, sellerId: before.seller_id });
          const afterDto = await load(db, row, actor);

          await audit.log({ actor, action: "product.updated", entityType: "product", entityId: id, oldValue: productAuditView(beforeDto), newValue: productAuditView(afterDto) }, ctx, db);
          const priceChanged = beforeDto.price !== afterDto.price || beforeDto.salePrice !== afterDto.salePrice || beforeDto.tax !== afterDto.tax
            || JSON.stringify(beforeDto.variants?.map((v) => [v.id, v.price, v.salePrice])) !== JSON.stringify(afterDto.variants?.map((v) => [v.id, v.price, v.salePrice]));
          if (priceChanged) {
            await audit.log({ actor, action: "product.price_changed", entityType: "product", entityId: id,
              oldValue: { price: beforeDto.price, salePrice: beforeDto.salePrice, tax: beforeDto.tax, variants: beforeDto.variants?.map((v) => ({ id: v.id, price: v.price, salePrice: v.salePrice })) },
              newValue: { price: afterDto.price, salePrice: afterDto.salePrice, tax: afterDto.tax, variants: afterDto.variants?.map((v) => ({ id: v.id, price: v.price, salePrice: v.salePrice })) } }, ctx, db);
          }
          return afterDto;
        });
      } catch (err) {
        throw mapUniqueViolation(err);
      }
    },

    /** Soft delete: the row stays so orders, stock history and audit entries keep resolving. */
    async remove(actor, id, ctx) {
      return withTx(async (db) => {
        const before = await products.getById(db, id, { forUpdate: true });
        if (!before) throw notFound("PRODUCT_NOT_FOUND", "Product not found");
        const dto = await load(db, before, actor);
        await products.softDelete(db, id);
        await audit.log({ actor, action: "product.deleted", entityType: "product", entityId: id, oldValue: productAuditView(dto) }, ctx, db);
        return { id };
      });
    },
  };
}
