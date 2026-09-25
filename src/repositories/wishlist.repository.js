export function createWishlistRepository() {
  return {
    async list(db, userId) {
      return (await db.query("SELECT product_id FROM wishlist_items WHERE user_id = $1 ORDER BY created_at DESC", [userId])).rows.map((r) => r.product_id);
    },
    async add(db, userId, productId) {
      await db.query("INSERT INTO wishlist_items (user_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [userId, productId]);
    },
    async remove(db, userId, productId) {
      await db.query("DELETE FROM wishlist_items WHERE user_id = $1 AND product_id = $2", [userId, productId]);
    },
    async has(db, userId, productId) {
      return (await db.query("SELECT 1 FROM wishlist_items WHERE user_id = $1 AND product_id = $2", [userId, productId])).rows.length > 0;
    },
  };
}
