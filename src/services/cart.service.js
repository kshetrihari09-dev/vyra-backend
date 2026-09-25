/** Stateless cart pricing/validation preview — the cart's line selection (which products, which qty) still lives
    in the browser; this is what makes the numbers and stock checks authoritative before checkout. */
export function createCartService({ pool, repos, pricing }) {
  return {
    async price({ items, couponCode, deliveryOptionId, branch }, actor) {
      const branchId = branch ?? (await repos.products.branchIds(pool))[0];
      const manage = !!actor?.permissions?.includes("catalog:write");
      const { lines, issues } = await pricing.priceLines(pool, items, { branchId, manage, lock: false });
      const totals = await pricing.computeTotals(pool, lines, { couponCode, deliveryOptionId, userId: actor?.id ?? null, isFirstOrder: false });
      return { lines, issues, totals, branchId };
    },
  };
}
