import { productAuditView, toProductDto } from "../models/catalog.model.js";
import { badRequest, conflict, forbidden, notFound } from "../utils/errors.js";
import { normTerm, slugify } from "../utils/text.js";
import { randomUUID } from "node:crypto";

const MANAGE = "catalog:write";
const PUBLIC_STATUSES = ["active"];
const ALL_STATUSES = ["active", "inactive", "pending_review", "rejected", "draft"];
const SELLER_TOGGLABLE_STATUSES = ["active", "inactive"]; // a seller may flip between these on their own listing; only staff can move it out of pending_review/rejected

const can = (actor, perm) => !!actor?.permissions?.includes(perm);
/** A seller managing only their own catalogue — `catalog:write` (staff) always takes precedence. */
const isSellerOnly = (actor) => !can(actor, MANAGE) && can(actor, "catalog:write_own");

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

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MIME_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const EXT_MIME = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

export function createProductsService({ pool, withTx, repos, audit, storage }) {
  const { products, catalog, inventory } = repos;

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
    // Staff need inventory:adjust. A shop owner may also set the opening stock of the new listing they are creating:
    // this runs on create only (create() has already pinned sellerId to their shop and forced pending_review), and
    // every later stock change still goes through the inventory API and its permissions.
    if (!can(actor, "inventory:adjust") && !isSellerOnly(actor)) throw forbidden("FORBIDDEN", "You cannot set opening stock");
    const branches = new Set(await products.branchIds(db));
    for (const m of maps) for (const b of Object.keys(m)) if (!branches.has(b)) throw badRequest("BRANCH_NOT_FOUND", `Unknown branch "${b}"`);
  }

  /** Sets each branch's starting on-hand ONCE (create only; edit never calls this) and logs it in the movements ledger like any
   *  other stock change, so history and on-hand agree. A brand-new product has no stock yet, hence prev_qty 0. Zero/empty adds nothing. */
  async function writeOpeningStock(db, actor, productId, body) {
    const put = async (branchId, qty, variantId = null) => {
      if (!(qty > 0)) return;
      await products.setOpeningStock(db, { branchId, productId, variantId, qty });
      await inventory.recordMovement(db, { branchId, productId, variantId, delta: qty, prevQty: 0, newQty: qty, reason: "Opening stock", refType: "adjustment", actorId: actor?.id ?? null });
    };
    for (const [branchId, qty] of Object.entries(body.openingStock || {})) await put(branchId, qty);
    for (const v of body.variants || []) for (const [branchId, qty] of Object.entries(v.openingStock || {})) await put(branchId, qty, v.id);
  }

  async function load(db, row, actor) {
    const hydrated = await products.hydrate(db, [row], { includeBatchCost: can(actor, "inventory:read") });
    return toProductDto(row, hydrated);
  }

  return {
    /** Paginated, filtered, ranked listing. Anonymous/customers only ever see active products. */
    async list(query, actor) {
      const manage = can(actor, MANAGE);
      // A shop owner may widen the status filter for their OWN listings only (pending_review, inactive, rejected…) —
      // asking for any other shop's non-active products just gets the public view, exactly like a customer.
      const ownScope = !!actor?.sellerId && query.sellerId === actor.sellerId && can(actor, "catalog:write_own");
      let statuses = PUBLIC_STATUSES;
      if ((manage || ownScope) && query.status) statuses = query.status === "any" ? ALL_STATUSES : query.status.split(",").filter((s) => ALL_STATUSES.includes(s));
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
      const ownedByActor = row && actor?.sellerId && row.seller_id === actor.sellerId;
      if (!row || (row.status !== "active" && !can(actor, MANAGE) && !ownedByActor)) throw notFound("PRODUCT_NOT_FOUND", "Product not found");
      return load(pool, row, actor);
    },

    async create(actor, body, ctx) {
      try {
        return await withTx(async (db) => {
          if (isSellerOnly(actor)) {
            if (!actor.sellerId) throw forbidden("NO_SHOP", "You need an active shop before you can list products");
            body = { ...body, sellerId: actor.sellerId, status: "pending_review" }; // a seller can never self-approve a new listing
          }
          else if (body.sellerId) {
            // Staff creating a listing on a shop's behalf: the shop must exist. (Previously sellerId was silently dropped
            // here, so the product was saved with no owner and never appeared in any seller's console.)
            if (repos.sellers && !(await repos.sellers.getById(db, body.sellerId))) throw badRequest("SELLER_NOT_FOUND", "That shop doesn't exist");
          } else body = { ...body, sellerId: null };
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
          await writeOpeningStock(db, actor, id, body);
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
          if (isSellerOnly(actor)) {
            if (before.seller_id !== actor.sellerId) throw notFound("PRODUCT_NOT_FOUND", "Product not found"); // not theirs — 404, not 403, so a seller can't probe other shops' catalogue
            // A seller may flip an already-approved listing between active/inactive themselves, but can never
            // move it out of pending_review/rejected, or into either of those — that's staff-only moderation.
            const requestedStatus = body.status;
            const selfServeToggle = SELLER_TOGGLABLE_STATUSES.includes(before.status) && SELLER_TOGGLABLE_STATUSES.includes(requestedStatus);
            body = { ...body, status: selfServeToggle ? requestedStatus : before.status };
          }
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
          if (body.minStock != null) await products.syncReorderLevel(db, id, row.min_stock);
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
    /** Replaces the product's photo list. Entries are existing storage keys (kept) or new data URLs (stored). */
    async setImages(actor, id, images, ctx) {
      let removed = [];
      try {
        const dto = await withTx(async (db) => {
          const row = await products.getById(db, id, { forUpdate: true });
          if (!row) throw notFound("PRODUCT_NOT_FOUND", "Product not found");
          if (!can(actor, MANAGE)) {
            if (!can(actor, "catalog:write_own") || !actor.sellerId || row.seller_id !== actor.sellerId) throw notFound("PRODUCT_NOT_FOUND", "Product not found");
          }
          const current = (await products.listImages(db, id)).map((r) => r.storage_key);
          const rows = [];
          for (const entry of images) {
            if (current.includes(entry)) { rows.push({ key: entry, alt: row.name }); continue; }
            const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(entry);
            if (!m) throw badRequest("INVALID_IMAGE", "That image isn't one of this product's photos");
            const buffer = Buffer.from(m[2], "base64");
            if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw badRequest("INVALID_IMAGE", "Each image must be under 2 MB");
            const key = `${randomUUID()}.${MIME_EXT[m[1]]}`;
            await products.putImageBlob(db, key, m[1], buffer); // inside the transaction: a rollback leaves nothing behind
            rows.push({ key, alt: row.name });
          }
          await products.replaceImages(db, id, rows);
          removed = current.filter((k) => !rows.some((r) => r.key === k));
          await products.deleteImageBlobs(db, removed);
          await audit.log({ actor, action: "product.images_updated", entityType: "product", entityId: id, newValue: { count: rows.length } }, ctx, db);
          return load(db, row, actor);
        });
        for (const k of removed) await storage.deleteObject(k).catch(() => {}); // legacy disk copies, best effort
        return dto;
      } catch (err) {
        throw err;
      }
    },

    /** Bytes of one public product photo; 404 unless the key belongs to a product. */
    async imageFile(key) {
      if (!(await products.imageExists(pool, key))) throw notFound("IMAGE_NOT_FOUND", "Image not found");
      const blob = await products.getImageBlob(pool, key);
      if (blob) return blob;
      let buffer; // photos saved before the database store existed
      try { buffer = await storage.getObject(key); } catch { throw notFound("IMAGE_NOT_FOUND", "Image not found"); }
      return { buffer, mime: EXT_MIME[key.split(".").pop()] || "application/octet-stream" };
    },

    async remove(actor, id, ctx) {
      return withTx(async (db) => {
        const before = await products.getById(db, id, { forUpdate: true });
        if (!before) throw notFound("PRODUCT_NOT_FOUND", "Product not found");
        if (isSellerOnly(actor) && before.seller_id !== actor.sellerId) throw notFound("PRODUCT_NOT_FOUND", "Product not found");
        const dto = await load(db, before, actor);
        await products.softDelete(db, id);
        await audit.log({ actor, action: "product.deleted", entityType: "product", entityId: id, oldValue: productAuditView(dto) }, ctx, db);
        return { id };
      });
    },
  };
}
