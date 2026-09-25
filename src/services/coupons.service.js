import { round2 } from "../utils/text.js";

/** Server-side reimplementation of the prototype's coupon rules (utils/pricing.js evaluateCoupon), now with real expiry, usage-limit and per-customer-limit enforcement (finding 5 in MIGRATION_PLAN.md). */
export function createCouponsService({ repos }) {
  const { coupons: repo, catalog } = repos;

  async function inScope(db, coupon, line) {
    if (coupon.scope_type === "all") return true;
    if (coupon.scope_type === "brand") return line.brandId === coupon.scope_id;
    if (coupon.scope_type === "category") return (await catalog.categoryTreeIds(db, coupon.scope_id)).includes(line.categoryId);
    return false;
  }

  return {
    /** `lines` = [{ categoryId, brandId, lineTotal }]. Pass `lock: true` only when actually placing an order. */
    async evaluate(db, code, lines, { userId = null, isFirstOrder = false, lock = false } = {}) {
      if (!code) return null;
      const coupon = lock ? await repo.lockByCode(db, code) : await repo.getActive(db, code);
      const fail = (reason) => ({ ok: false, discount: 0, reason, code: code.toUpperCase() });
      if (!coupon) return fail("This code isn't valid.");
      if (coupon.status !== "active") return fail("This code isn't active.");
      const now = new Date();
      if (coupon.starts_at && new Date(coupon.starts_at) > now) return fail("This code isn't active yet.");
      if (coupon.ends_at && new Date(coupon.ends_at) < now) return fail("This code has expired.");
      if (coupon.first_order_only && !isFirstOrder) return fail("This code is for first orders only.");
      if (coupon.usage_limit != null && coupon.times_used >= coupon.usage_limit) return fail("This code has been fully redeemed.");
      if (userId && (await repo.redemptionCount(db, code, userId)) >= coupon.per_customer_limit) return fail("You've already used this code.");

      const eligible = [];
      for (const l of lines) if (await inScope(db, coupon, l)) eligible.push(l);
      const eligibleTotal = eligible.reduce((s, l) => s + l.lineTotal, 0);
      const cartTotal = lines.reduce((s, l) => s + l.lineTotal, 0);
      if (cartTotal < Number(coupon.min_order)) return fail(`Spend ${round2(Number(coupon.min_order) - cartTotal)} more to use this code.`);
      if (eligibleTotal <= 0) return fail("No items in your cart match this offer.");

      let discount = coupon.type === "percent" ? (eligibleTotal * Number(coupon.value)) / 100 : Math.min(Number(coupon.value), eligibleTotal);
      if (coupon.max_discount) discount = Math.min(discount, Number(coupon.max_discount));
      return { ok: true, discount: round2(discount), code: coupon.code, label: coupon.label };
    },
  };
}
