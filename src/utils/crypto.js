import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** URL-safe random token (default 48 bytes = 384 bits). */
export const randomToken = (bytes = 48) => randomBytes(bytes).toString("base64url");

/** Numeric one-time code, uniformly random, left-padded ("0042"). */
export const randomDigits = (length = 4) => String(randomInt(0, 10 ** length)).padStart(length, "0");

/** Keyed hash for values we store but must never keep in clear (refresh tokens, reset tokens, OTPs). */
export const hmacHex = (secret, value) => createHmac("sha256", secret).update(String(value)).digest("hex");

export function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), "hex");
  const y = Buffer.from(String(b), "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
