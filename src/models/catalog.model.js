import { toNumber } from "../utils/text.js";

const isoDate = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);

/** Same shape the storefront's local registry used ({ parent, order, image, unitLabel, ... }) so components need no change. */
export function toCategoryDto(r) {
  const dto = {
    id: r.id, name: r.name, slug: r.slug, parent: r.parent_id ?? null, order: r.sort_order, status: r.status,
    icon: r.icon, image: r.image_shape, tint: r.tint, fg: r.fg, description: r.description ?? undefined,
  };
  if (r.unit_label != null) dto.unitLabel = r.unit_label;
  if (r.attributes != null) dto.attributes = r.attributes;
  if (r.modules != null) dto.modules = r.modules;
  if (r.product_count !== undefined) dto.productCount = Number(r.product_count);
  return dto;
}

export const toBrandDto = (r) => ({ id: r.id, name: r.name, tint: r.tint, fg: r.fg, status: r.status });

/**
 * `hydrated` = { variants: Map<productId, row[]>, stock: Map<productId, {variantId|'' -> {branchId -> qty}}>, batches: Map<productId, {batch, expiry, qty, cost}[]> }
 * Produces the storefront's product shape: `stock` on the product for simple products, `stock` per variant for
 * products with variants, `batches` for batch-tracked medicines.
 */
export function toProductDto(r, hydrated = {}) {
  const variantRows = hydrated.variants?.get(r.id) ?? [];
  const stockMap = hydrated.stock?.get(r.id) ?? {};
  const dto = {
    id: r.id, name: r.name, slug: r.slug, categoryId: r.category_id, brandId: r.brand_id,
    description: r.description, price: toNumber(r.price), salePrice: toNumber(r.sale_price), tax: toNumber(r.tax_percent),
    sku: r.sku, barcode: r.barcode ?? "", unit: r.unit, moq: r.moq, maxQty: r.max_qty,
    rating: toNumber(r.rating), reviews: r.review_count, sold: r.sold_count,
    createdAt: isoDate(r.created_at), status: r.status, deliveryAvailable: r.delivery_available,
    tags: r.tags ?? [], art: r.art ?? null, attributes: r.attributes ?? {},
    version: r.version,
  };
  if (r.seller_id) dto.sellerId = r.seller_id;
  if (r.composition) dto.composition = r.composition;
  if (r.usage_instructions) dto.usage = r.usage_instructions;
  if (r.side_effects) dto.sideEffects = r.side_effects;
  if (r.prescription_required) dto.flags = { prescriptionRequired: true };
  if (variantRows.length) {
    dto.variants = variantRows.map((v) => ({
      id: v.id, label: v.label, options: v.options, price: toNumber(v.price), salePrice: toNumber(v.sale_price), sku: v.sku,
      ...(v.barcode ? { barcode: v.barcode } : {}), stock: stockMap[v.id] ?? {},
    }));
  } else {
    dto.stock = stockMap[""] ?? {};
  }
  const batches = hydrated.batches?.get(r.id);
  if (batches?.length) dto.batches = batches;
  if (hydrated.images?.get(r.id)?.length) dto.images = hydrated.images.get(r.id);
  return dto;
}

/** Snapshot of the fields worth recording in an audit entry (no descriptions, no art). */
export const productAuditView = (dto) => ({
  name: dto.name, categoryId: dto.categoryId, brandId: dto.brandId, price: dto.price, salePrice: dto.salePrice, tax: dto.tax,
  sku: dto.sku, barcode: dto.barcode, status: dto.status, unit: dto.unit, variants: (dto.variants || []).map((v) => ({ id: v.id, price: v.price, salePrice: v.salePrice, sku: v.sku })),
});
