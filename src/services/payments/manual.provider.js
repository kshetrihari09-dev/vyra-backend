import { randomToken, safeEqualHex } from "../../utils/crypto.js";
import { createHmac } from "node:crypto";

/**
 * Stand-in for a real gateway (card / eSewa / Khalti — decision D10). "Initiate" hands the customer a
 * reference to pay against outside the app; a real integration replaces initiate()'s body with a redirect
 * URL/checkout session and parseWebhookEvent()'s shape with that provider's payload, without touching
 * anything that calls this interface.
 *
 * In dev/demo, with no gateway to call us back, a staff member with `payments:manage` can confirm the
 * payment directly (POST /payments/:id/confirm-manual) — that path calls the exact same service function
 * a verified webhook would.
 */
export function createManualProvider({ webhookSecret }) {
  const secret = webhookSecret || "dev-only-manual-webhook-secret-not-for-production";

  return {
    name: "manual",
    async initiate({ order }) {
      const providerRef = `MANUAL-${randomToken(6)}`;
      return {
        status: "pending",
        providerRef,
        instructions: {
          method: "manual",
          reference: providerRef,
          note: `Transfer the order total and quote reference ${providerRef} (order ${order.number}). Your order ships once payment is confirmed.`,
        },
      };
    },

    /** HMAC-SHA256 over the raw body, hex, in an `x-vyra-signature` header — swap for the real provider's scheme later. */
    verifyWebhookSignature(rawBody, headers) {
      const given = headers["x-vyra-signature"];
      if (!given) return false;
      const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
      return safeEqualHex(expected, given);
    },

    parseWebhookEvent(payload) {
      if (!payload?.eventId || !payload?.providerRef || !payload?.status) return null;
      return { eventId: payload.eventId, providerRef: payload.providerRef, status: payload.status, failureReason: payload.reason ?? null };
    },

    async refund({ amount }) {
      // No gateway to call — a manual refund is completed the moment staff approve it.
      return { providerRef: `REFUND-${randomToken(6)}`, status: "completed", note: `Manual refund of ${amount} recorded.` };
    },
  };
}
