/**
 * DEMO DATA — the prototype's marketplace sellers (frontend data/sellers.js), inserted before the catalogue
 * so products.seller_id (now FK'd to sellers — migration 007) has somewhere to point. Idempotent: ON CONFLICT
 * DO NOTHING, so re-running never overwrites a seller an admin has since edited.
 *
 * "novatech-official" is the one demo shop with a real login behind it — the "NovaTech Owner" account
 * (seeds/demo/users.js) already carries the `seller` role, so its owner_user_id is looked up by email and
 * linked here, exactly matching the account a demo session with that email would need to see the shop.
 * Every other seed seller has no owner account yet (nobody logs in as them), so owner_user_id stays null.
 */
const SELLERS = [
  { id: "vyra-retail", name: "Vyra Center", firstParty: true, status: "active", commissionRate: 0, rating: 4.8, reviews: 12400, joinedAt: "2024-01-01", payoutMethod: "N/A — first-party", contactEmail: "ops@vyra.com", ownerEmail: null },
  { id: "fresh-grocers", name: "Fresh Grocers Co.", status: "active", commissionRate: 8, rating: 4.6, reviews: 2140, joinedAt: "2025-09-12", payoutMethod: "Bank transfer •••• 4410", contactEmail: "partners@freshgrocers.example" },
  { id: "auralux-beauty", name: "AuraLux Beauty", status: "active", commissionRate: 15, rating: 4.7, reviews: 3810, joinedAt: "2025-11-03", payoutMethod: "Bank transfer •••• 2207", contactEmail: "hello@auralux.example" },
  { id: "novatech-official", name: "NovaTech Official Store", status: "active", commissionRate: 10, rating: 4.5, reviews: 5290, joinedAt: "2025-06-21", payoutMethod: "Bank transfer •••• 8834", contactEmail: "store@novatech.example", ownerEmail: "novatech@vyra.example" },
  { id: "homecraft-living", name: "HomeCraft Living", status: "active", commissionRate: 12, rating: 4.4, reviews: 980, joinedAt: "2026-02-14", payoutMethod: "Bank transfer •••• 1190", contactEmail: "sell@homecraft.example" },
  { id: "inkwell-stationery", name: "Inkwell Stationery", status: "active", commissionRate: 14, rating: 4.6, reviews: 640, joinedAt: "2026-04-30", payoutMethod: "Bank transfer •••• 5567", contactEmail: "orders@inkwell.example" },
  { id: "pawsome-pets", name: "Pawsome Pets", status: "active", commissionRate: 13, rating: 4.5, reviews: 1120, joinedAt: "2026-01-08", payoutMethod: "Bank transfer •••• 3321", contactEmail: "team@pawsome.example" },
  { id: "urbanthread-apparel", name: "UrbanThread Apparel", status: "active", commissionRate: 18, rating: 4.3, reviews: 2670, joinedAt: "2025-08-19", payoutMethod: "Bank transfer •••• 7742", contactEmail: "wholesale@urbanthread.example" },
  { id: "northwind-outdoors", name: "Northwind Outdoors", status: "pending", commissionRate: 15, rating: null, reviews: 0, joinedAt: "2026-09-10", payoutMethod: "Not yet set up", contactEmail: "apply@northwind.example" },
];

const PAYOUTS = [
  { sellerId: "novatech-official", amount: 612.4, at: "2026-08-15T10:00:00Z", method: "Bank transfer •••• 8834" },
  { sellerId: "auralux-beauty", amount: 284.1, at: "2026-08-01T10:00:00Z", method: "Bank transfer •••• 2207" },
  { sellerId: "urbanthread-apparel", amount: 190.6, at: "2026-07-20T10:00:00Z", method: "Bank transfer •••• 7742" },
];

export async function seedDemoSellers(db, { log = console.log } = {}) {
  let sellers = 0, payouts = 0;
  for (const s of SELLERS) {
    const ownerId = s.ownerEmail ? (await db.query("SELECT id FROM users WHERE email = $1", [s.ownerEmail])).rows[0]?.id ?? null : null;
    const ins = await db.query(
      `INSERT INTO sellers (id, name, first_party, status, commission_rate, owner_user_id, contact_email, payout_method_label, rating, reviews_count, joined_at, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [s.id, s.name, !!s.firstParty, s.status, s.commissionRate, ownerId, s.contactEmail, s.payoutMethod, s.rating, s.reviews, s.joinedAt],
    );
    if (ins.rows.length) sellers++;
  }
  for (const p of PAYOUTS) {
    const seller = (await db.query("SELECT owner_user_id FROM sellers WHERE id = $1", [p.sellerId])).rows[0];
    if (!seller) continue; // seller row wasn't (re-)created this run — nothing to attach the payout to
    // Historical/demo payouts predate this account-linking model for most shops, so there's no real
    // "who requested it" — any demo user satisfies the FK; the owner account is used where one exists.
    const exists = await db.query("SELECT 1 FROM seller_payouts WHERE seller_id = $1 AND amount = $2 AND created_at = $3::timestamptz", [p.sellerId, p.amount, p.at]);
    if (exists.rows.length) continue;
    const ins = await db.query(
      `INSERT INTO seller_payouts (seller_id, amount, status, method_label, requested_by, decided_at, paid_at, created_at, is_demo)
       VALUES ($1,$2,'paid',$3, COALESCE($4, (SELECT id FROM users WHERE is_demo LIMIT 1)), $5::timestamptz, $5::timestamptz, $5::timestamptz, true)
       RETURNING id`,
      [p.sellerId, p.amount, p.method, seller.owner_user_id, p.at],
    );
    if (ins.rows.length) payouts++;
  }
  log(`  sellers: ${sellers} seller(s), ${payouts} payout(s)`);
  return { sellers, payouts };
}
