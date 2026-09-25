/** Refresh tokens, password-reset tokens and OTP challenges — everything short-lived that proves "who is this". */
export function createSessionsRepository() {
  return {
    // ------------------------------------------------------------ refresh tokens
    async insertRefreshToken(db, { userId, familyId, tokenHash, expiresAt, ip, userAgent }) {
      const { rows } = await db.query(
        `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [userId, familyId, tokenHash, expiresAt, ip ?? null, userAgent ?? null],
      );
      return rows[0].id;
    },

    async findRefreshTokenForUpdate(db, tokenHash) {
      const { rows } = await db.query(
        `SELECT id, user_id, family_id, expires_at, revoked_at, replaced_by FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
        [tokenHash],
      );
      return rows[0] || null;
    },

    async rotateRefreshToken(db, oldId, newId) {
      await db.query("UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1", [oldId, newId]);
    },

    async revokeFamily(db, familyId) {
      await db.query("UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE family_id = $1", [familyId]);
    },

    async revokeAllForUser(db, userId) {
      await db.query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
    },

    async findFamilyByHash(db, tokenHash) {
      const { rows } = await db.query("SELECT family_id FROM refresh_tokens WHERE token_hash = $1", [tokenHash]);
      return rows[0]?.family_id ?? null;
    },

    // ------------------------------------------------------------ password reset
    async insertPasswordReset(db, { userId, tokenHash, expiresAt }) {
      await db.query("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)", [userId, tokenHash, expiresAt]);
    },

    async countRecentPasswordResets(db, userId, sinceIso) {
      const { rows } = await db.query("SELECT count(*) AS n FROM password_resets WHERE user_id = $1 AND created_at > $2", [userId, sinceIso]);
      return Number(rows[0].n);
    },

    async findUsablePasswordResetForUpdate(db, tokenHash) {
      const { rows } = await db.query(
        `SELECT id, user_id FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
        [tokenHash],
      );
      return rows[0] || null;
    },

    async markPasswordResetUsed(db, id) {
      await db.query("UPDATE password_resets SET used_at = now() WHERE id = $1", [id]);
    },

    // ------------------------------------------------------------ OTP challenges
    async insertOtpChallenge(db, { id, purpose, mobile, codeHash, payload, expiresAt }) {
      await db.query(
        `INSERT INTO otp_challenges (id, purpose, mobile, code_hash, payload, expires_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [id, purpose, mobile, codeHash, JSON.stringify(payload), expiresAt],
      );
    },

    async countRecentOtpChallenges(db, mobile, sinceIso) {
      const { rows } = await db.query("SELECT count(*) AS n FROM otp_challenges WHERE mobile = $1 AND created_at > $2", [mobile, sinceIso]);
      return Number(rows[0].n);
    },

    async findOtpChallengeForUpdate(db, id) {
      const { rows } = await db.query(
        `SELECT id, purpose, mobile, code_hash, payload, attempts, expires_at, consumed_at FROM otp_challenges WHERE id = $1 FOR UPDATE`,
        [id],
      );
      return rows[0] || null;
    },

    async bumpOtpAttempts(db, id) {
      await db.query("UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1", [id]);
    },

    async consumeOtpChallenge(db, id) {
      await db.query("UPDATE otp_challenges SET consumed_at = now() WHERE id = $1", [id]);
    },
  };
}
