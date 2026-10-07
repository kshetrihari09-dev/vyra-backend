import { randomUUID } from "node:crypto";
import { toAddressDto } from "../models/commerce.model.js";
import { badRequest, notFound, tooManyRequests } from "../utils/errors.js";
import { hmacHex, randomDigits, safeEqualHex } from "../utils/crypto.js";
import { isNepalMobile, maskPhone, normalizePhone } from "./phoneTrust.js";

const HOUR = 60 * 60_000;
export const MAX_ADDRESSES = 10;          // a customer rarely needs more; a cap stops address-spam and bulk-created junk rows
const MAX_PHONE_CODES_PER_HOUR = 5;       // per account, across all numbers: one account can't be used to text strangers

/**
 * A customer's own delivery addresses. Every operation is scoped to the caller — there is no "any user's address" lookup.
 *
 * Delivery phone rule: the account's login number is trusted; any other number must be confirmed with a code texted to
 * that number first (startPhoneVerification → verifyPhone). Saving an address with an unconfirmed number is refused with
 * PHONE_NOT_VERIFIED, so the rule holds no matter which client calls the API.
 */
export function createAddressesService({ pool, withTx, repos, config, notifier, audit, phoneTrust, clock = () => new Date() }) {
  const { addresses: repo, sessions } = repos;
  const agoIso = (ms) => new Date(clock().getTime() - ms).toISOString();
  const later = (ms) => new Date(clock().getTime() + ms);
  const hash = (challengeId, code) => hmacHex(config.auth.refreshSecret, `addrphone:${challengeId}:${code}`);
  const who = (userId) => ({ id: userId, name: "customer", roles: ["customer"] });

  return {
    async list(userId) { return (await repo.list(pool, userId)).map(toAddressDto); },

    async create(userId, body, ctx = {}) {
      return withTx(async (db) => {
        const phone = normalizePhone(body.phone);
        await phoneTrust.assertTrusted(db, userId, phone);
        const existing = await repo.list(db, userId);
        if (existing.length >= MAX_ADDRESSES) throw badRequest("ADDRESS_LIMIT", `You can save up to ${MAX_ADDRESSES} addresses. Remove one to add another.`);
        if (body.isDefault) await repo.clearDefault(db, userId);
        const row = await repo.insert(db, userId, { ...body, phone, isDefault: body.isDefault || existing.length === 0 });
        await audit.log({ actor: who(userId), action: "address.created", entityType: "address", entityId: row.id, newValue: { label: row.label, ward: row.ward, phone: maskPhone(phone), hasMapPoint: row.lat != null } }, ctx, db);
        return toAddressDto(row);
      });
    },

    async update(userId, id, body, ctx = {}) {
      return withTx(async (db) => {
        const current = await repo.get(db, userId, id);
        if (!current) throw notFound("ADDRESS_NOT_FOUND", "Address not found");
        const phone = normalizePhone(body.phone);
        await phoneTrust.assertTrusted(db, userId, phone); // also re-checks an old row whose number was never confirmed
        if (body.isDefault) await repo.clearDefault(db, userId);
        const row = await repo.update(db, userId, id, { ...body, phone });
        if (!row) throw notFound("ADDRESS_NOT_FOUND", "Address not found");
        const was = normalizePhone(current.phone);
        await audit.log({ actor: who(userId), action: "address.updated", entityType: "address", entityId: id,
          oldValue: { line1: current.line1, phone: maskPhone(was) }, newValue: { line1: row.line1, phone: maskPhone(phone), phoneChanged: was !== phone, hasMapPoint: row.lat != null } }, ctx, db);
        return toAddressDto(row);
      });
    },

    async setDefault(userId, id) {
      return withTx(async (db) => {
        if (!(await repo.get(db, userId, id))) throw notFound("ADDRESS_NOT_FOUND", "Address not found");
        await repo.clearDefault(db, userId);
        return toAddressDto(await repo.setDefault(db, userId, id));
      });
    },

    async remove(userId, id, ctx = {}) {
      if (!(await repo.remove(pool, userId, id))) throw notFound("ADDRESS_NOT_FOUND", "Address not found");
      await audit.log({ actor: who(userId), action: "address.removed", entityType: "address", entityId: id }, ctx);
      return { id };
    },

    // ------------------------------------------------------------------ delivery-phone confirmation
    /** Step 1. Already trusted (login number or confirmed before) → { verified: true }, no text. Otherwise text a code to THAT number. */
    async startPhoneVerification(userId, rawPhone, ctx = {}) {
      const phone = normalizePhone(rawPhone);
      if (!isNepalMobile(phone)) throw badRequest("PHONE_NOT_SUPPORTED", "Enter a valid mobile number (98XXXXXXXX) so we can text a code to it.", [{ path: "body.phone", message: "Enter a valid mobile number (98XXXXXXXX)" }]);
      if (await phoneTrust.isTrusted(pool, userId, phone)) return { verified: true, phone };

      const since = agoIso(HOUR);
      if ((await repo.countRecentPhoneChallenges(pool, userId, since)) >= MAX_PHONE_CODES_PER_HOUR) throw tooManyRequests("OTP_RATE_LIMITED", "Too many verification codes requested. Try again in an hour.");
      if ((await sessions.countRecentOtpChallenges(pool, phone, since)) >= config.otp.maxStartsPerMobilePerHour) throw tooManyRequests("OTP_RATE_LIMITED", "Too many codes were sent to this number. Try again in an hour.");

      const challengeId = randomUUID();
      const code = config.otp.devCode ?? randomDigits(config.otp.length);
      await sessions.insertOtpChallenge(pool, {
        id: challengeId, purpose: "address_phone", mobile: phone,
        codeHash: hash(challengeId, code), payload: { userId }, expiresAt: later(config.otp.ttlSeconds * 1000),
      });
      await notifier.sendSms({ to: phone, text: `Your Vyra code to confirm this delivery number is ${code}. Don't share it. It expires in ${Math.round(config.otp.ttlSeconds / 60)} minutes.` });
      return { verified: false, challengeId, expiresInSeconds: config.otp.ttlSeconds };
    },

    /** Step 2. A right code (for THIS user's challenge) remembers the number; a wrong one counts toward the attempt limit. */
    async verifyPhone(userId, { challengeId, code }, ctx = {}) {
      const outcome = await withTx(async (db) => {
        const ch = await sessions.findOtpChallengeForUpdate(db, challengeId);
        // Someone else's challenge looks exactly like a wrong one — no hint that it exists.
        if (!ch || ch.consumed_at || ch.purpose !== "address_phone" || ch.payload?.userId !== userId) return { error: badRequest("INVALID_CODE", "That code isn't right") };
        if (new Date(ch.expires_at) <= clock()) return { error: badRequest("CODE_EXPIRED", "That code has expired. Request a new one.") };
        if (ch.attempts >= config.otp.maxAttempts) return { error: tooManyRequests("TOO_MANY_ATTEMPTS", "Too many wrong codes. Request a new one.") };
        if (!safeEqualHex(ch.code_hash, hash(challengeId, code))) {
          await sessions.bumpOtpAttempts(db, challengeId); // committed even though we reject
          return { error: badRequest("INVALID_CODE", "That code isn't right") };
        }
        await repo.markPhoneVerified(db, userId, ch.mobile);
        await sessions.consumeOtpChallenge(db, challengeId);
        await audit.log({ actor: who(userId), action: "address.phone_verified", entityType: "user", entityId: userId, newValue: { phone: maskPhone(ch.mobile) } }, ctx, db);
        return { phone: ch.mobile };
      });
      if (outcome.error) throw outcome.error;

      // Heads-up on the LOGIN number: if someone else got into the account, the owner finds out. Never blocks the flow.
      try {
        const account = await phoneTrust.accountMobile(pool, userId);
        if (account && account !== outcome.phone) await notifier.sendSms({ to: account, text: `Vyra: the number ${maskPhone(outcome.phone)} was just confirmed for deliveries on your account. If this wasn't you, change your password.` });
      } catch { /* a failed notice must not undo a successful confirmation */ }
      return { verified: true, phone: outcome.phone };
    },
  };
}
