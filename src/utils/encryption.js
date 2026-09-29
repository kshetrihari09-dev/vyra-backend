import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Field-level encryption for the one genuinely sensitive thing a shop application carries: bank/wallet
 * account numbers (decision D8, finding #9). AES-256-GCM, a fresh random IV per value, stored as one blob
 * (IV || authTag || ciphertext) so there's nothing else to keep track of alongside it.
 */
export function createEncryption(keyBase64) {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must decode (base64) to exactly 32 bytes");

  return {
    /** string -> Buffer, or null in, null out (nothing to encrypt). */
    encrypt(plaintext) {
      if (plaintext == null || plaintext === "") return null;
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    /** Buffer -> string, or null in, null out. Throws if the blob was tampered with or the key is wrong. */
    decrypt(blob) {
      if (blob == null) return null;
      const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
      const iv = buf.subarray(0, 12);
      const authTag = buf.subarray(12, 28);
      const ciphertext = buf.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    },
  };
}

/** Last 4 characters only — the same masked shape the prototype already shows ("•••• 4410"). */
export function maskTail(value) {
  const s = String(value || "");
  return s.length > 4 ? `•••• ${s.slice(-4)}` : s ? `•••• ${s}` : null;
}
