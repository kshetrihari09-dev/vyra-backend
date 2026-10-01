import { Router } from "express";
import { authenticate, optionalAuthenticate, requireAnyPermission, requirePermission } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import * as v from "../validators/catalog.validators.js";

/**
 * Public reads (optionally authenticated so staff also see inactive products / batch costs);
 * writes need catalog:write. Mounted at /api, so paths below are /api/products, /api/categories, ...
 */
export function catalogRoutes({ container, controller }) {
  const r = Router();
  const authed = authenticate(container);
  const maybe = optionalAuthenticate(container);
  const write = requirePermission("catalog:write");
  // A seller (catalog:write_own) manages only their own listings — products.service enforces the scoping and
  // the pending_review gate; categories/brands stay staff-only (`write` above).
  const writeProduct = requireAnyPermission("catalog:write", "catalog:write_own");

  // categories
  r.get("/categories", maybe, validate({ query: v.includeInactiveQuery }), controller.listCategories);
  r.post("/categories", authed, write, validate({ body: v.categoryBody }), controller.createCategory);
  r.put("/categories/:id", authed, write, validate({ params: v.idParams, body: v.categoryBody }), controller.updateCategory);
  r.post("/categories/:id/toggle", authed, write, validate({ params: v.idParams }), controller.toggleCategory);

  // brands
  r.get("/brands", maybe, validate({ query: v.includeInactiveQuery }), controller.listBrands);
  r.post("/brands", authed, write, validate({ body: v.brandBody }), controller.createBrand);
  r.put("/brands/:id", authed, write, validate({ params: v.idParams, body: v.brandBody }), controller.updateBrand);

  // search (declared before /products/:id so "facets" is never read as an id)
  r.get("/search", maybe, validate({ query: v.listProductsQuery }), controller.listProducts);
  r.get("/search/suggest", validate({ query: v.suggestQuery }), controller.suggest);
  r.get("/search/lookup", maybe, validate({ query: v.lookupQuery }), controller.lookup);
  r.get("/products/facets", validate({ query: v.facetsQuery }), controller.facets);

  // Public photo files. Keys are random UUIDs and only keys present in product_images are served (prescription files never are).
  r.get("/product-images/:key", validate({ params: v.imageKeyParams }), controller.productImage);

  // products
  r.get("/products", maybe, validate({ query: v.listProductsQuery }), controller.listProducts);
  r.get("/products/:id", maybe, validate({ params: v.idParams }), controller.getProduct);
  r.post("/products", authed, writeProduct, validate({ body: v.createProductBody }), controller.createProduct);
  r.put("/products/:id", authed, writeProduct, validate({ params: v.idParams, body: v.updateProductBody }), controller.updateProduct);
  r.put("/products/:id/images", authed, writeProduct, validate({ params: v.idParams, body: v.setImagesBody }), controller.setProductImages);
  r.delete("/products/:id", authed, writeProduct, validate({ params: v.idParams }), controller.deleteProduct);
  return r;
}
