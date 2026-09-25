import { z } from "zod";
import { pagination } from "./common.js";

const idSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "Use lowercase letters, numbers and dashes");
const color = z.string().regex(/^#[0-9A-Fa-f]{3,8}$/, "Use a hex colour like #0FAF8F");
const text = (max) => z.string().trim().max(max);
const money = z.number({ invalid_type_error: "Enter a number" }).min(0).max(10_000_000).multipleOf(0.01, "Use at most 2 decimals");
const flag = z.preprocess((v) => (v === "true" || v === true ? true : v === "false" || v === false ? false : v), z.boolean());
const csv = (max) => z.string().transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)).pipe(z.array(z.string().max(80)).max(max));

/* ------------------------------------------------------------------ categories & brands */
const attributeDef = z.object({
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, "Attribute keys are letters, numbers and underscores"),
  label: text(80).min(1),
  type: z.enum(["text", "select"]).default("text"),
  options: z.array(text(80).min(1)).max(50).nullable().optional(),
  filterable: z.boolean().default(false),
  highlight: z.boolean().default(false),
}).refine((a) => a.type !== "select" || (a.options && a.options.length > 0), { message: "A select attribute needs at least one option", path: ["options"] });

export const categoryBody = z.object({
  id: idSlug.optional(),
  name: text(100).min(1, "Enter a category name"),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/).optional(),
  parent: idSlug.nullable().optional(),
  description: text(500).nullable().optional(),
  icon: text(40).nullable().optional(),
  image: text(30).nullable().optional(),
  tint: color.nullable().optional(),
  fg: color.nullable().optional(),
  order: z.number().int().min(0).max(10_000).optional(),
  status: z.enum(["active", "inactive"]).default("active"),
  unitLabel: text(30).nullable().optional(),
  attributes: z.array(attributeDef).max(30).nullable().optional(),
  modules: z.array(z.enum(["prescription", "batch"])).max(5).nullable().optional(),
});

export const brandBody = z.object({
  id: idSlug.optional(),
  name: text(100).min(1, "Enter a brand name"),
  tint: color.nullable().optional(),
  fg: color.nullable().optional(),
  status: z.enum(["active", "inactive"]).default("active"),
});

export const idParams = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/, "Invalid id") });
export const includeInactiveQuery = z.object({ includeInactive: flag.optional() });

/* ------------------------------------------------------------------ products */
export const SORT_IDS = ["relevance", "price_asc", "price_desc", "rating", "newest", "bestselling", "discount"];

/** Listing / search query. Attribute filters arrive as literal `attr.<key>=<value>` keys and are read from the passthrough. */
export const listProductsQuery = z.object({
  q: text(100).optional(),
  category: idSlug.optional(),
  brand: csv(20).optional(),
  tag: z.string().regex(/^[a-z0-9_-]{1,30}$/).optional(),
  onSale: flag.optional(),
  inStock: flag.optional(),
  branch: idSlug.optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  minDiscount: z.coerce.number().min(0).max(100).optional(),
  sku: text(64).optional(),
  barcode: text(64).optional(),
  sellerId: text(64).optional(),
  status: z.string().regex(/^(any|[a-z_]+(,[a-z_]+)*)$/).optional(),
  ids: csv(100).optional(),
  sort: z.enum(SORT_IDS).default("relevance"),
  ...pagination,
}).passthrough();

export const suggestQuery = z.object({ q: text(100).min(1), limit: z.coerce.number().int().min(1).max(20).default(20) });
export const lookupQuery = z.object({ code: text(64).min(1) });
export const facetsQuery = z.object({ category: idSlug.optional(), q: text(100).optional() });

const variantBody = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$/, "Variant ids are letters, numbers, dashes"),
  label: text(100).min(1),
  options: z.record(text(80)).default({}),
  price: money,
  salePrice: money.positive().nullable().optional(),
  sku: text(64).min(1),
  barcode: text(64).nullable().optional(),
  openingStock: z.record(z.number().int().min(0).max(1_000_000)).optional(),
}).refine((v) => v.salePrice == null || v.salePrice <= v.price, { message: "Sale price cannot exceed the regular price", path: ["salePrice"] });

const productShape = {
  id: idSlug.optional(),
  name: text(200).min(1, "Enter a product name"),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/).optional(),
  categoryId: idSlug,
  brandId: idSlug.optional(),
  brandName: text(100).min(1).optional(),
  description: text(5000).default(""),
  price: money,
  salePrice: money.positive().nullable().optional(),
  tax: z.number().min(0).max(100).default(0),
  sku: text(64).min(1, "Enter a SKU"),
  barcode: text(64).nullable().optional(),
  unit: text(30).min(1).default("piece"),
  moq: z.number().int().min(1).max(10_000).default(1),
  maxQty: z.number().int().min(1).max(10_000).default(10),
  status: z.enum(["active", "inactive", "pending_review", "rejected", "draft"]).default("active"),
  deliveryAvailable: z.boolean().default(true),
  tags: z.array(z.string().regex(/^[a-z0-9_-]{1,30}$/)).max(20).default([]),
  art: z.object({ shape: text(30).optional(), color: color.optional(), accent: color.optional() }).nullable().optional(),
  attributes: z.record(text(200)).default({}),
  variants: z.array(variantBody).max(100).optional(),
  composition: text(2000).nullable().optional(),
  usage: text(2000).nullable().optional(),
  sideEffects: text(2000).nullable().optional(),
  flags: z.object({ prescriptionRequired: z.boolean().optional() }).nullable().optional(),
  openingStock: z.record(z.number().int().min(0).max(1_000_000)).optional(),
  version: z.number().int().min(1).optional(),
};

const productRules = (p) => p.salePrice == null || p.salePrice <= p.price;
const ruleMsg = { message: "Sale price cannot exceed the regular price", path: ["salePrice"] };

/** Unknown keys (rating, sold, createdAt, stock, batches, ...) are stripped: those are server-owned. */
export const createProductBody = z.object(productShape).refine(productRules, ruleMsg);
export const updateProductBody = z.object(productShape).refine(productRules, ruleMsg);
