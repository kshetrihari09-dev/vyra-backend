import { toBrandDto, toCategoryDto } from "../models/catalog.model.js";
import { badRequest, conflict, notFound } from "../utils/errors.js";
import { slugify } from "../utils/text.js";

/** Categories and brands (the catalogue's configuration). Reads are public; every write is audited. */
export function createCatalogService({ pool, withTx, repos, audit }) {
  const { catalog } = repos;
  const catView = (r) => ({ name: r.name, parent: r.parent_id, status: r.status, order: r.sort_order, modules: r.modules, attributes: (r.attributes || []).map((a) => a.key) });

  async function uniqueId(db, base, exists) {
    let id = base || "item";
    for (let n = 2; await exists(db, id); n++) id = `${base}-${n}`.slice(0, 63);
    return id;
  }

  return {
    async listCategories({ includeInactive = false } = {}) {
      return (await catalog.listCategories(pool, { includeInactive })).map(toCategoryDto);
    },

    async createCategory(actor, body, ctx) {
      return withTx(async (db) => {
        if (body.id && (await catalog.getCategory(db, body.id))) throw conflict("CATEGORY_EXISTS", "A category with this id already exists");
        if (body.parent && !(await catalog.getCategory(db, body.parent))) throw badRequest("PARENT_NOT_FOUND", "Parent category does not exist");
        const id = body.id ?? (await uniqueId(db, slugify(body.name, 60), async (d, i) => !!(await catalog.getCategory(d, i))));
        const row = await catalog.insertCategory(db, { ...body, id, slug: body.slug ?? id });
        await audit.log({ actor, action: "category.created", entityType: "category", entityId: id, newValue: catView(row) }, ctx, db);
        return toCategoryDto(row);
      });
    },

    async updateCategory(actor, id, body, ctx) {
      return withTx(async (db) => {
        const before = await catalog.getCategory(db, id);
        if (!before) throw notFound("CATEGORY_NOT_FOUND", "Category not found");
        if (body.parent) {
          if (!(await catalog.getCategory(db, body.parent))) throw badRequest("PARENT_NOT_FOUND", "Parent category does not exist");
          if ((await catalog.categoryTreeIds(db, id)).includes(body.parent)) throw badRequest("CATEGORY_CYCLE", "A category cannot be moved under itself");
        }
        const row = await catalog.updateCategory(db, id, { ...body, slug: body.slug ?? before.slug, order: body.order ?? before.sort_order });
        await audit.log({ actor, action: "category.updated", entityType: "category", entityId: id, oldValue: catView(before), newValue: catView(row) }, ctx, db);
        return toCategoryDto(row);
      });
    },

    /** Flips active/inactive (the admin "Disable / Enable" button). */
    async toggleCategory(actor, id, ctx) {
      return withTx(async (db) => {
        const before = await catalog.getCategory(db, id);
        if (!before) throw notFound("CATEGORY_NOT_FOUND", "Category not found");
        const next = before.status === "active" ? "inactive" : "active";
        const row = await catalog.setCategoryStatus(db, id, next);
        await audit.log({ actor, action: "category.status_changed", entityType: "category", entityId: id, oldValue: { status: before.status }, newValue: { status: next } }, ctx, db);
        return toCategoryDto(row);
      });
    },

    async listBrands({ includeInactive = false } = {}) {
      return (await catalog.listBrands(pool, { includeInactive })).map(toBrandDto);
    },

    async createBrand(actor, body, ctx) {
      return withTx(async (db) => {
        if (await catalog.findBrandByName(db, body.name)) throw conflict("BRAND_EXISTS", "A brand with this name already exists", [{ path: "body.name", message: "A brand with this name already exists" }]);
        if (body.id && (await catalog.getBrand(db, body.id))) throw conflict("BRAND_EXISTS", "A brand with this id already exists");
        const id = body.id ?? (await uniqueId(db, slugify(body.name, 60), async (d, i) => !!(await catalog.getBrand(d, i))));
        const row = await catalog.insertBrand(db, { ...body, id });
        await audit.log({ actor, action: "brand.created", entityType: "brand", entityId: id, newValue: { name: row.name } }, ctx, db);
        return toBrandDto(row);
      });
    },

    async updateBrand(actor, id, body, ctx) {
      return withTx(async (db) => {
        const before = await catalog.getBrand(db, id);
        if (!before) throw notFound("BRAND_NOT_FOUND", "Brand not found");
        const clash = await catalog.findBrandByName(db, body.name);
        if (clash && clash.id !== id) throw conflict("BRAND_EXISTS", "A brand with this name already exists", [{ path: "body.name", message: "A brand with this name already exists" }]);
        const row = await catalog.updateBrand(db, id, body);
        await audit.log({ actor, action: "brand.updated", entityType: "brand", entityId: id, oldValue: { name: before.name, status: before.status }, newValue: { name: row.name, status: row.status } }, ctx, db);
        return toBrandDto(row);
      });
    },
  };
}
