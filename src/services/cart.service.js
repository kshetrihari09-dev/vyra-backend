/** Stateless cart pricing/validation preview — the cart's line selection (which products, which qty) still lives
    in the browser; this is what makes the numbers and stock checks authoritative before checkout. */
import { outOfRangeMessage } from "../domain/deliveryPricing.js";

export function createCartService({ pool, repos, pricing }) {
  return {
    async price({ items, couponCode, deliveryOptionId, branch, addressId }, actor) {
      const branchId = branch ?? (await repos.products.branchIds(pool))[0];
      const manage = !!actor?.permissions?.includes("catalog:write");
      const { lines, issues } = await pricing.priceLines(pool, items, { branchId, manage, lock: false });
      // The address is only honoured if it is the signed-in caller's own (an anonymous cart simply has no distance yet).
      const address = addressId && actor?.id ? await repos.addresses.get(pool, actor.id, addressId) : null;
      const branchRow = await repos.catalog.getBranch(pool, branchId);
      const totals = await pricing.computeTotals(pool, lines, { couponCode, deliveryOptionId, userId: actor?.id ?? null, isFirstOrder: false, branch: branchRow, destination: address });
      // Out of range is blocking, like out-of-stock: the checkout button stays off and the message says why.
      if (!totals.delivery.deliverable) issues.push({ type: "out_of_range", message: outOfRangeMessage(totals.delivery, branchRow?.name) });
      return { lines, issues, totals, branchId };
    },
  };
}
