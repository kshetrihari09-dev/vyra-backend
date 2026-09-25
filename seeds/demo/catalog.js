import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * DEMO DATA — the prototype's catalogue (brands, categories, 39 products, 2 branches, stock and medicine batches).
 * Every row is flagged is_demo = true. Idempotent: re-running never overwrites live stock or edited products.
 *
 * The snapshot in ./data/catalog.json is owned by the backend (it was exported once from the prototype's local data
 * files, which are being retired). Batch expiries are stored as "days from today" and resolved when the seed runs,
 * so a freshly seeded demo never shows already-expired stock.
 */
const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "catalog.json");
export const LEGACY_BATCH = "LEGACY-OPENING";

/**
 * Batch → branch assignment (decision D4 in MIGRATION_PLAN.md). In the prototype batches had no branch and their
 * totals did not always match branch stock. Rule: hand batches out in FEFO order to the first branch until its
 * stock is covered, then the next (a batch may split); stock no batch explains becomes a quarantined
 * LEGACY-OPENING batch (no expiry) that FEFO never sells until a pharmacist assigns a real batch and expiry.
 */
export function planBatchAllocation({ batches, branchOrder, stockByBranch }) {
  const remaining = Object.fromEntries(branchOrder.map((b) => [b, stockByBranch[b] ?? 0]));
  const placements = [];
  let surplus = 0;
  for (const b of [...batches].sort((a, z) => a.expiryInDays - z.expiryInDays)) {
    let left = b.qty;
    for (const branchId of branchOrder) {
      if (left <= 0) break;
      const take = Math.min(left, remaining[branchId]);
      if (take > 0) { placements.push({ branchId, batch: b.batch, expiryInDays: b.expiryInDays, qty: take, cost: b.cost }); remaining[branchId] -= take; left -= take; }
    }
    surplus += left; // batch quantity that no branch stock accounts for — reported, never invented
  }
  const legacy = branchOrder.map((branchId) => ({ branchId, qty: remaining[branchId] })).filter((l) => l.qty > 0);
  return { placements, legacy, surplus };
}

export async function seedDemoCatalog(db, { log = console.log } = {}) {
  const snap = JSON.parse(await readFile(DATA, "utf8"));

  for (const b of snap.brands) {
    await db.query("INSERT INTO brands (id, name, tint, fg, is_demo) VALUES ($1,$2,$3,$4,true) ON CONFLICT DO NOTHING", [b.id, b.name, b.tint, b.fg]);
  }

  // Parents before children so the self-referencing FK is satisfied.
  const depth = (c) => (c.parent ? 1 + depth(snap.categories.find((x) => x.id === c.parent)) : 0);
  for (const c of [...snap.categories].sort((a, b) => depth(a) - depth(b))) {
    await db.query(
      `INSERT INTO categories (id, name, slug, parent_id, description, icon, image_shape, tint, fg, sort_order, status, unit_label, attributes, modules, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,true) ON CONFLICT DO NOTHING`,
      [c.id, c.name, c.slug, c.parent ?? null, c.description ?? null, c.icon ?? null, c.image ?? null, c.tint ?? null, c.fg ?? null,
       c.order ?? 0, c.status ?? "active", c.unitLabel ?? null, c.attributes ? JSON.stringify(c.attributes) : null, c.modules ?? null],
    );
  }

  await db.query("INSERT INTO stores (id, name, kind, is_demo) VALUES ($1,$2,'own',true) ON CONFLICT DO NOTHING", [snap.company.id, snap.company.name]);
  const branchOrder = snap.branches.map((b) => b.id);
  for (const [i, b] of snap.branches.entries()) {
    await db.query(
      `INSERT INTO branches (id, store_id, name, code, address, city, distance_km, eta_minutes, is_open, hours, phone, pharmacist_on_duty, otp_required, sort_order, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true) ON CONFLICT DO NOTHING`,
      [b.id, snap.company.id, b.name, b.code, b.address, b.city, b.distanceKm, b.etaMinutes, b.open, b.hours, b.phone, !!b.pharmacistOnDuty, b.otpRequired !== false, i],
    );
  }

  const report = [];
  for (const p of snap.products) {
    const ins = await db.query(
      `INSERT INTO products (id, name, slug, category_id, brand_id, seller_id, description, price, sale_price, tax_percent, sku, barcode, unit, moq, max_qty,
                             rating, review_count, sold_count, status, delivery_available, prescription_required, tags, art, attributes,
                             composition, usage_instructions, side_effects, created_at, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24::jsonb,$25,$26,$27,$28::date,true)
       ON CONFLICT DO NOTHING RETURNING id`,
      [p.id, p.name, p.slug, p.categoryId, p.brandId, p.sellerId ?? null, p.description ?? "", p.price, p.salePrice ?? null, p.tax ?? 0, p.sku, p.barcode || null,
       p.unit ?? "piece", p.moq ?? 1, p.maxQty ?? 10, p.rating ?? 0, p.reviews ?? 0, p.sold ?? 0, p.status ?? "active", p.deliveryAvailable !== false,
       !!p.flags?.prescriptionRequired, p.tags ?? [], p.art ? JSON.stringify(p.art) : null, JSON.stringify(p.attributes ?? {}),
       p.composition ?? null, p.usage ?? null, p.sideEffects ?? null, p.createdAt],
    );
    if (!ins.rows.length) continue; // already seeded (or the id was taken): leave live data alone

    const stockRows = [];
    for (const [i, v] of (p.variants || []).entries()) {
      await db.query(
        `INSERT INTO product_variants (product_id, id, label, options, price, sale_price, sku, sort_order) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)`,
        [p.id, v.id, v.label, JSON.stringify(v.options ?? {}), v.price, v.salePrice ?? null, v.sku, i],
      );
      for (const [branchId, qty] of Object.entries(v.stock || {})) stockRows.push({ branchId, variantId: v.id, qty });
    }
    if (!p.variants?.length) for (const [branchId, qty] of Object.entries(p.stock || {})) stockRows.push({ branchId, variantId: null, qty });
    for (const s of stockRows) {
      await db.query("INSERT INTO inventory (branch_id, product_id, variant_id, on_hand) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [s.branchId, p.id, s.variantId, s.qty]);
    }

    if (p.batches?.length) {
      const stockByBranch = {};
      for (const s of stockRows) stockByBranch[s.branchId] = (stockByBranch[s.branchId] ?? 0) + s.qty;
      const plan = planBatchAllocation({ batches: p.batches, branchOrder, stockByBranch });
      for (const x of plan.placements) {
        await db.query(
          `INSERT INTO inventory_batches (branch_id, product_id, batch_no, expiry_date, purchase_cost, qty, is_demo)
           VALUES ($1,$2,$3, current_date + $4::int, $5, $6, true) ON CONFLICT DO NOTHING`,
          [x.branchId, p.id, x.batch, x.expiryInDays, x.cost, x.qty],
        );
      }
      for (const l of plan.legacy) {
        await db.query(
          `INSERT INTO inventory_batches (branch_id, product_id, batch_no, expiry_date, qty, is_legacy_opening, is_demo)
           VALUES ($1,$2,$3,NULL,$4,true,true) ON CONFLICT DO NOTHING`,
          [l.branchId, p.id, LEGACY_BATCH, l.qty],
        );
      }
      report.push({ id: p.id, legacy: plan.legacy.reduce((s, l) => s + l.qty, 0), surplus: plan.surplus });
    }
  }

  const quarantined = report.filter((r) => r.legacy > 0);
  if (quarantined.length) log(`batch reconciliation: ${quarantined.length} medicine(s) have stock with no batch/expiry, held in ${LEGACY_BATCH} (not sellable via FEFO): ${quarantined.map((r) => `${r.id}=${r.legacy}`).join(", ")}`);
  const surplus = report.filter((r) => r.surplus > 0);
  if (surplus.length) log(`WARNING: batch quantity exceeds branch stock for ${surplus.map((r) => `${r.id}=${r.surplus}`).join(", ")} (surplus not imported)`);
  return { brands: snap.brands.length, categories: snap.categories.length, products: snap.products.length };
}
