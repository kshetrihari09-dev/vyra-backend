export function createCouponsRepository() {
  return {
    async getActive(db, code) {
      const { rows } = await db.query(
        `SELECT * FROM coupons WHERE code = $1 AND status = 'active'
           AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at >= now())`,
        [code.toUpperCase()],
      );
      return rows[0] || null;
    },
    /** Locks the coupon row so two simultaneous orders can't both slip past a usage_limit. */
    async lockByCode(db, code) {
      return (await db.query("SELECT * FROM coupons WHERE code = $1 FOR UPDATE", [code.toUpperCase()])).rows[0] || null;
    },
    async redemptionCount(db, code, userId) {
      return Number((await db.query("SELECT count(*) AS n FROM coupon_redemptions WHERE coupon_code = $1 AND user_id = $2", [code.toUpperCase(), userId])).rows[0].n);
    },
    async recordRedemption(db, code, userId, orderId) {
      await db.query("INSERT INTO coupon_redemptions (coupon_code, user_id, order_id) VALUES ($1,$2,$3)", [code.toUpperCase(), userId, orderId]);
      await db.query("UPDATE coupons SET times_used = times_used + 1 WHERE code = $1", [code.toUpperCase()]);
    },
  };
}
