import { forbidden } from "../utils/errors.js";

const NEPAL_MOBILE = /^9[678]\d{8}$/;

/** "+977 98-1234 5678", "9779812345678", "9812345678" → "9812345678". Anything else comes back as plain digits. */
export function normalizePhone(raw) {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 13 && d.startsWith("977")) d = d.slice(3);
  return d;
}
export const isNepalMobile = (p) => NEPAL_MOBILE.test(normalizePhone(p));
/** "9812345678" → "98****5678" (for audit rows and security texts — never the full number). */
export function maskPhone(p) {
  const d = normalizePhone(p);
  return d.length >= 6 ? `${d.slice(0, 2)}****${d.slice(-4)}` : "****";
}

/**
 * Which phone numbers may a customer put on a delivery address? Their own login number, or one they have confirmed with
 * a code sent to that number. Used when an address is saved AND again when an order is placed, so an old or tampered
 * address row can't smuggle in an unconfirmed number.
 */
export function createPhoneTrust({ repos }) {
  async function accountMobile(db, userId) {
    const row = await repos.users.getAccess(db, userId);
    return row?.mobile ? normalizePhone(row.mobile) : null;
  }
  async function isTrusted(db, userId, phone) {
    const p = normalizePhone(phone);
    if (!isNepalMobile(p)) return false;
    if (p === (await accountMobile(db, userId))) return true;
    return repos.addresses.isPhoneVerified(db, userId, p);
  }
  async function assertTrusted(db, userId, phone) {
    if (!(await isTrusted(db, userId, phone))) throw forbidden("PHONE_NOT_VERIFIED", "Confirm this phone number with a code before using it for delivery.");
  }
  return { accountMobile, isTrusted, assertTrusted };
}
