/** Demo coupons, matching the prototype's data/promotions.js COUPONS so the codes shoppers know still work. */
const COUPONS = [
  { code: "NOVA10", label: "10% off orders over $20", type: "percent", value: 10, maxDiscount: 15, minOrder: 20, scopeType: "all" },
  { code: "FRESH25", label: "25% off Grocery", type: "percent", value: 25, maxDiscount: 20, minOrder: 30, scopeType: "category", scopeId: "grocery" },
  { code: "FLAT5", label: "$5 off orders over $25", type: "fixed", value: 5, minOrder: 25, scopeType: "all" },
  { code: "FIRST15", label: "15% off your first order", type: "percent", value: 15, maxDiscount: 25, minOrder: 0, firstOrderOnly: true, scopeType: "all" },
  { code: "NOVATECH", label: "12% off NovaTech", type: "percent", value: 12, maxDiscount: 40, minOrder: 50, scopeType: "brand", scopeId: "novatech" },
];

export async function seedDemoCommerce(db, { log = console.log } = {}) {
  for (const c of COUPONS) {
    await db.query(
      `INSERT INTO coupons (code, label, type, value, max_discount, min_order, scope_type, scope_id, first_order_only, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true) ON CONFLICT (code) DO NOTHING`,
      [c.code, c.label, c.type, c.value, c.maxDiscount ?? null, c.minOrder ?? 0, c.scopeType, c.scopeId ?? null, !!c.firstOrderOnly],
    );
  }
  log(`demo coupons: ${COUPONS.length}`);
  return { coupons: COUPONS.length };
}
