/** A customer's saved-for-later product ids. */
export function createWishlistService({ pool, repos }) {
  const { wishlist: repo } = repos;
  return {
    async list(userId) { return repo.list(pool, userId); },
    async toggle(userId, productId) {
      if (await repo.has(pool, userId, productId)) { await repo.remove(pool, userId, productId); return { productId, saved: false }; }
      await repo.add(pool, userId, productId);
      return { productId, saved: true };
    },
  };
}
