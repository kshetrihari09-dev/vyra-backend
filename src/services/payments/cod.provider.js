/**
 * Cash on delivery: no gateway, no webhook. The payment stays "pending" until the rider marks the order
 * delivered (orders.service calls markCodCollected at that point), at which point it becomes "captured".
 * A COD "refund" is always cash handed back in person — recorded here so accounting has one ledger for
 * every payment method, but there's nothing to call out to.
 */
export function createCodProvider() {
  return {
    name: "cod",
    async initiate() {
      return { status: "pending", providerRef: null, instructions: { method: "cod", note: "Pay the rider on delivery." } };
    },
    verifyWebhookSignature() { return false; }, // COD never receives webhooks
    parseWebhookEvent() { return null; },
    async refund({ amount }) {
      return { providerRef: null, status: "completed", note: `Cash refund of ${amount} to be handed back by staff.` };
    },
  };
}
