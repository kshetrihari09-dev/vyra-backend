import { clientContext, ok } from "../utils/http.js";

export function createCatalogController({ services }) {
  const { catalog, products, search } = services;
  const includeInactive = (req) => !!req.valid?.query?.includeInactive && !!req.auth?.user?.permissions.includes("catalog:write");
  return {
    // categories & brands
    async listCategories(req, res) { ok(res, { categories: await catalog.listCategories({ includeInactive: includeInactive(req) }) }); },
    async createCategory(req, res) { ok(res, { category: await catalog.createCategory(req.auth.user, req.valid.body, clientContext(req)) }, 201); },
    async updateCategory(req, res) { ok(res, { category: await catalog.updateCategory(req.auth.user, req.valid.params.id, req.valid.body, clientContext(req)) }); },
    async toggleCategory(req, res) { ok(res, { category: await catalog.toggleCategory(req.auth.user, req.valid.params.id, clientContext(req)) }); },
    async listBrands(req, res) { ok(res, { brands: await catalog.listBrands({ includeInactive: includeInactive(req) }) }); },
    async createBrand(req, res) { ok(res, { brand: await catalog.createBrand(req.auth.user, req.valid.body, clientContext(req)) }, 201); },
    async updateBrand(req, res) { ok(res, { brand: await catalog.updateBrand(req.auth.user, req.valid.params.id, req.valid.body, clientContext(req)) }); },

    // products
    async listProducts(req, res) { ok(res, await products.list({ ...req.valid.query }, req.auth?.user)); },
    async getProduct(req, res) { ok(res, { product: await products.get(req.valid.params.id, req.auth?.user) }); },
    async createProduct(req, res) { ok(res, { product: await products.create(req.auth.user, req.valid.body, clientContext(req)) }, 201); },
    async updateProduct(req, res) { ok(res, { product: await products.update(req.auth.user, req.valid.params.id, req.valid.body, clientContext(req)) }); },
    async deleteProduct(req, res) { ok(res, await products.remove(req.auth.user, req.valid.params.id, clientContext(req))); },

    // search
    async suggest(req, res) { ok(res, { suggestions: await search.suggest(req.valid.query) }); },
    async lookup(req, res) { ok(res, { product: await search.lookup(req.valid.query, req.auth?.user) }); },
    async facets(req, res) { ok(res, await search.facets(req.valid.query)); },
  };
}
