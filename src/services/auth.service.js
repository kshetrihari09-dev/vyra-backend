import { randomUUID } from "node:crypto";
import { toUserDto } from "../models/user.model.js";
import { badRequest, forbidden, tooManyRequests, unauthorized } from "../utils/errors.js";
import { hmacHex, randomDigits, randomToken, safeEqualHex } from "../utils/crypto.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Authentication use-cases. Depends only on injected collaborators (repositories, hasher, token signer,
 * notifier, audit) so the whole flow is unit-testable without a database or HTTP server.
 *
 * `withTx(fn)` must run fn(db) in a transaction (commit on return, rollback on throw).
 * Failure counters that must survive a rejected request (bad OTP, replayed refresh token) are written in a
 * transaction that COMMITS, and the error is thrown after it returns.
 */
export function createAuthService({ config, pool, withTx, repos, hasher, tokens, notifier, audit, clock = () => new Date() }) {
  const { users, roles, sessions } = repos;
  const cfg = config.auth;

  const hash = (kind, value) => hmacHex(cfg.refreshSecret, `${kind}:${value}`);
  const later = (ms) => new Date(clock().getTime() + ms);
  const agoIso = (ms) => new Date(clock().getTime() - ms).toISOString();

  async function loadUserDto(db, userId) {
    const row = await users.getAccess(db, userId);
    return row ? toUserDto(row) : null;
  }

  /** Creates a refresh token (new family unless one is supplied) and a matching access token. */
  async function issueSession(db, userId, ctx, familyId = randomUUID()) {
    const refreshToken = randomToken(48);
    const expiresAt = later(cfg.refreshTtlDays * 24 * HOUR);
    const id = await sessions.insertRefreshToken(db, {
      userId, familyId, tokenHash: hash("refresh", refreshToken), expiresAt, ip: ctx.ip, userAgent: ctx.userAgent,
    });
    return { accessToken: tokens.signAccessToken(userId), refreshToken, refreshExpiresAt: expiresAt, refreshTokenId: id, familyId };
  }

  return {
    // ------------------------------------------------------------------ registration (mobile OTP)
    /** Step 1: validate, park the sign-up in an OTP challenge, text the code. Nothing is created yet. */
    async registerStart({ name, mobile, email: rawEmail, password }, ctx) {
      const email = rawEmail ? rawEmail.trim().toLowerCase() : undefined; // service-level normalisation: never rely on the caller
      const existing = await users.findByEmailOrMobile(pool, { email, mobile });
      if (existing.some((u) => u.mobile === mobile)) throw badRequest("MOBILE_TAKEN", "This mobile number is already registered", [{ path: "body.mobile", message: "This mobile number is already registered" }]);
      if (email && existing.some((u) => u.email === email)) throw badRequest("EMAIL_TAKEN", "This email is already registered", [{ path: "body.email", message: "This email is already registered" }]);

      const recent = await sessions.countRecentOtpChallenges(pool, mobile, agoIso(HOUR));
      if (recent >= config.otp.maxStartsPerMobilePerHour) throw tooManyRequests("OTP_RATE_LIMITED", "Too many verification codes requested. Try again in an hour.");

      const challengeId = randomUUID();
      const code = config.otp.devCode ?? randomDigits(config.otp.length);
      await sessions.insertOtpChallenge(pool, {
        id: challengeId, purpose: "register", mobile,
        codeHash: hash("otp", `${challengeId}:${code}`),
        payload: { name, email: email ?? null, passwordHash: await hasher.hash(password) },
        expiresAt: later(config.otp.ttlSeconds * 1000),
      });
      await notifier.sendSms({ to: mobile, text: `Your Vyra verification code is ${code}. It expires in ${Math.round(config.otp.ttlSeconds / 60)} minutes.` });
      return { challengeId, expiresInSeconds: config.otp.ttlSeconds };
    },

    /** Step 2: check the code; on success create user + customer profile + 'customer' role and sign in. */
    async registerVerify({ challengeId, code }, ctx) {
      const outcome = await withTx(async (db) => {
        const ch = await sessions.findOtpChallengeForUpdate(db, challengeId);
        if (!ch || ch.consumed_at || ch.purpose !== "register") return { error: badRequest("INVALID_CODE", "That code isn't right") };
        if (new Date(ch.expires_at) <= clock()) return { error: badRequest("CODE_EXPIRED", "That code has expired. Request a new one.") };
        if (ch.attempts >= config.otp.maxAttempts) return { error: tooManyRequests("TOO_MANY_ATTEMPTS", "Too many wrong codes. Request a new one.") };

        if (!safeEqualHex(ch.code_hash, hash("otp", `${challengeId}:${code}`))) {
          await sessions.bumpOtpAttempts(db, challengeId); // committed even though we reject
          return { error: badRequest("INVALID_CODE", "That code isn't right") };
        }

        const { name, email, passwordHash } = ch.payload;
        const clash = await users.findByEmailOrMobile(db, { email, mobile: ch.mobile });
        if (clash.length) return { error: badRequest("ACCOUNT_EXISTS", "An account with these details already exists") };

        const userId = await users.create(db, { fullName: name, email, mobile: ch.mobile, passwordHash, mobileVerified: true });
        await users.createCustomerProfile(db, userId);
        await roles.addUserRole(db, userId, "customer", null);
        await sessions.consumeOtpChallenge(db, challengeId);
        const session = await issueSession(db, userId, ctx);
        return { userId, session, user: await loadUserDto(db, userId) };
      });
      if (outcome.error) throw outcome.error;
      return { user: outcome.user, accessToken: outcome.session.accessToken, refreshToken: outcome.session.refreshToken, refreshExpiresAt: outcome.session.refreshExpiresAt };
    },

    // ------------------------------------------------------------------ login / session
    async login({ identifier, password }, ctx) {
      const invalid = () => unauthorized("INVALID_CREDENTIALS", "Incorrect mobile/email or password");
      const row = await users.findForLogin(pool, identifier.trim());
      if (!row) {
        await hasher.verify(password, await hasher.dummyHash()); // equalise timing with the "wrong password" path
        throw invalid();
      }
      if (row.locked_until && new Date(row.locked_until) > clock()) {
        throw tooManyRequests("ACCOUNT_LOCKED", "Too many failed attempts. Try again in a few minutes or reset your password.");
      }

      const good = await hasher.verify(password, row.password_hash);
      if (!good) {
        const after = await users.recordLoginFailure(pool, row.id, { max: cfg.maxLoginFailures, lockMinutes: cfg.lockoutMinutes });
        if (after?.locked_until && after.failed_login_count === cfg.maxLoginFailures) {
          await audit.log({ actorLabel: "system", action: "auth.account_locked", entityType: "user", entityId: row.id, newValue: { failedLoginCount: after.failed_login_count } }, ctx);
        }
        throw invalid();
      }
      // Status is only revealed after the password is proven correct.
      if (row.status !== "active") throw forbidden("ACCOUNT_INACTIVE", "This account is not active. Contact support.");

      return withTx(async (db) => {
        await users.recordLoginSuccess(db, row.id);
        if (hasher.needsRehash(row.password_hash)) await users.updatePassword(db, row.id, await hasher.hash(password));
        const session = await issueSession(db, row.id, ctx);
        return { user: await loadUserDto(db, row.id), accessToken: session.accessToken, refreshToken: session.refreshToken, refreshExpiresAt: session.refreshExpiresAt };
      });
    },

    /** Rotates the refresh token. Replaying an already-rotated token revokes the whole family. */
    async refresh(rawToken, ctx) {
      if (!rawToken) throw unauthorized("NO_REFRESH_TOKEN", "Session expired");
      const outcome = await withTx(async (db) => {
        const row = await sessions.findRefreshTokenForUpdate(db, hash("refresh", rawToken));
        if (!row) return { error: unauthorized("INVALID_REFRESH_TOKEN", "Session expired") };

        if (row.revoked_at) {
          const sinceRevoked = clock().getTime() - new Date(row.revoked_at).getTime();
          // Two tabs refreshing at once: the loser presents a token the winner just rotated. The winner's new cookie is
          // already in the browser, so ask the client to retry instead of treating it as theft.
          if (row.replaced_by && sinceRevoked <= cfg.refreshRotationGraceSeconds * 1000) return { error: unauthorized("REFRESH_TOKEN_ROTATED", "Session was refreshed elsewhere; retry") };
          await sessions.revokeFamily(db, row.family_id); // committed: this is the theft response
          return { error: unauthorized("INVALID_REFRESH_TOKEN", "Session expired") };
        }
        if (new Date(row.expires_at) <= clock()) return { error: unauthorized("INVALID_REFRESH_TOKEN", "Session expired") };

        const access = await users.getAccess(db, row.user_id);
        if (!access || access.status !== "active") {
          await sessions.revokeFamily(db, row.family_id);
          return { error: unauthorized("INVALID_REFRESH_TOKEN", "Session expired") };
        }
        const session = await issueSession(db, row.user_id, ctx, row.family_id);
        await sessions.rotateRefreshToken(db, row.id, session.refreshTokenId);
        return { session, user: toUserDto(access) };
      });
      if (outcome.error) throw outcome.error;
      return { user: outcome.user, accessToken: outcome.session.accessToken, refreshToken: outcome.session.refreshToken, refreshExpiresAt: outcome.session.refreshExpiresAt };
    },

    /** Idempotent: unknown / already-revoked tokens are fine. */
    async logout(rawToken) {
      if (!rawToken) return;
      const familyId = await sessions.findFamilyByHash(pool, hash("refresh", rawToken));
      if (familyId) await sessions.revokeFamily(pool, familyId);
    },

    async logoutAll(userId) {
      await sessions.revokeAllForUser(pool, userId);
    },

    async me(userId) {
      return loadUserDto(pool, userId);
    },

    // ------------------------------------------------------------------ passwords
    /** Always resolves the same way whether or not the account exists (no account enumeration). */
    async forgotPassword({ identifier }, ctx) {
      const user = await users.findActiveByIdentifier(pool, identifier.trim());
      if (!user) return;
      const recent = await sessions.countRecentPasswordResets(pool, user.id, agoIso(HOUR));
      if (recent >= 5) return;

      const token = randomToken(32);
      await sessions.insertPasswordReset(pool, { userId: user.id, tokenHash: hash("reset", token), expiresAt: later(cfg.resetTtlMinutes * MINUTE) });
      const link = `${config.appUrl}/reset-password?token=${token}`;
      const text = `Reset your Vyra password: ${link} (valid for ${cfg.resetTtlMinutes} minutes). If you didn't ask for this, ignore this message.`;
      if (user.email) await notifier.sendEmail({ to: user.email, subject: "Reset your Vyra password", text });
      else await notifier.sendSms({ to: user.mobile, text });
    },

    async resetPassword({ token, password }, ctx) {
      const newHash = await hasher.hash(password);
      await withTx(async (db) => {
        const row = await sessions.findUsablePasswordResetForUpdate(db, hash("reset", token));
        if (!row) throw badRequest("INVALID_RESET_TOKEN", "This reset link is invalid or has expired");
        await users.updatePassword(db, row.user_id, newHash);
        await sessions.markPasswordResetUsed(db, row.id);
        await sessions.revokeAllForUser(db, row.user_id); // sign out everywhere
        await audit.log({ actorLabel: "user (password reset)", action: "auth.password_reset", entityType: "user", entityId: row.user_id }, ctx, db);
      });
    },

    /** Verifies the current password, sets the new one, signs out every other device and returns a fresh session for this one. */
    async changePassword(userId, { currentPassword, newPassword }, ctx) {
      const stored = await users.getPasswordHash(pool, userId);
      if (!stored || !(await hasher.verify(currentPassword, stored))) throw badRequest("INVALID_CURRENT_PASSWORD", "Your current password is incorrect");
      const newHash = await hasher.hash(newPassword);
      return withTx(async (db) => {
        await users.updatePassword(db, userId, newHash);
        await sessions.revokeAllForUser(db, userId);
        await audit.log({ actorLabel: "user (self)", action: "auth.password_changed", entityType: "user", entityId: userId }, ctx, db);
        const session = await issueSession(db, userId, ctx);
        return { accessToken: session.accessToken, refreshToken: session.refreshToken, refreshExpiresAt: session.refreshExpiresAt };
      });
    },
  };
}
