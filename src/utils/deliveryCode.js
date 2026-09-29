import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The delivery hand-off code (finding #7). It is never stored. It is derived from
 *   HMAC-SHA256(subkey, orderId ":" nonce)  →  first 32 bits  →  mod 10 000  →  4 digits
 * where `subkey` is HKDF-derived from DATA_ENCRYPTION_KEY (so no new secret to manage) and `nonce` is a random
 * per-order value stored on the order. Consequences:
 *   • a database dump alone does not reveal any code (a plain hash of a 4-digit code would be trivially reversible);
 *   • the customer can re-open the order and see the same code, because the server recomputes it;
 *   • resetting the nonce (dispatcher action) changes the code.
 * With only 10 000 possibilities the real protection against guessing is the attempt limit enforced by the
 * delivery service (5 wrong tries per order, then locked).
 */
export function createDeliveryCodes(keyBase64) {
  const master = Buffer.from(keyBase64 ?? "", "base64");
  if (master.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must decode (base64) to exactly 32 bytes");
  const key = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "vyra/delivery-otp/v1", 32));

  const codeFor = (orderId, nonce) => {
    const mac = createHmac("sha256", key).update(`${orderId}:${nonce}`).digest();
    return String(mac.readUInt32BE(0) % 10_000).padStart(4, "0");
  };

  return {
    newNonce: () => randomBytes(12).toString("hex"),
    codeFor,
    /** Constant-time comparison; anything that isn't exactly four digits never matches. */
    matches(orderId, nonce, entered) {
      if (!nonce || typeof entered !== "string" || !/^\d{4}$/.test(entered)) return false;
      const a = Buffer.from(codeFor(orderId, nonce));
      const b = Buffer.from(entered);
      return a.length === b.length && timingSafeEqual(a, b);
    },
  };
}
