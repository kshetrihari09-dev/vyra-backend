import { ROLES } from "../../src/config/permissions.js";
import { loadConfig } from "../../src/config/env.js";

export const testEnv = (extra = {}) => ({
  NODE_ENV: "test",
  DATABASE_URL: "postgres://unused/unused",
  JWT_SECRET: "a".repeat(40),
  JWT_REFRESH_SECRET: "b".repeat(40),
  CORS_ORIGIN: "http://localhost:5173",
  OTP_DEV_CODE: "1234",
  ...extra,
});
export const testConfig = (extra) => loadConfig(testEnv(extra));

/** Controllable clock. */
export function fakeClock(start = "2026-09-20T10:00:00Z") {
  let t = new Date(start).getTime();
  const clock = () => new Date(t);
  clock.advance = (ms) => { t += ms; };
  return clock;
}

/** In-memory implementations of the repository interfaces used by the services. */
export function createFakeRepos(clock) {
  const now = () => clock();
  let seq = 0;
  const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

  const db = { users: [], userRoles: [], customers: [], refresh: [], resets: [], otps: [], audit: [] };

  const rolePerms = (roleKey) => ROLES[roleKey]?.permissions ?? [];
  const accessRow = (u) => {
    const roles = db.userRoles.filter((r) => r.userId === u.id).map((r) => r.role).sort();
    const permissions = [...new Set(roles.flatMap(rolePerms))].sort();
    return { id: u.id, full_name: u.fullName, email: u.email, mobile: u.mobile, status: u.status, legacy_id: u.legacyId, is_demo: false,
      email_verified_at: u.emailVerifiedAt, mobile_verified_at: u.mobileVerifiedAt, last_login_at: u.lastLoginAt, created_at: u.createdAt, roles, permissions };
  };

  const users = {
    async getAccess(_d, uid) { const u = db.users.find((x) => x.id === uid); return u ? accessRow(u) : null; },
    async findForLogin(_d, ident) {
      const u = db.users.find((x) => (ident.includes("@") ? x.email === ident.toLowerCase() : x.mobile === ident));
      return u ? { id: u.id, password_hash: u.passwordHash, status: u.status, failed_login_count: u.failed, locked_until: u.lockedUntil } : null;
    },
    async findByEmailOrMobile(_d, { email, mobile }) {
      return db.users.filter((u) => (email && u.email === email.toLowerCase()) || (mobile && u.mobile === mobile)).map((u) => ({ id: u.id, email: u.email, mobile: u.mobile }));
    },
    async findActiveByIdentifier(_d, ident) {
      const u = db.users.find((x) => x.status === "active" && (ident.includes("@") ? x.email === ident.toLowerCase() : x.mobile === ident));
      return u ? { id: u.id, full_name: u.fullName, email: u.email, mobile: u.mobile } : null;
    },
    async create(_d, { fullName, email, mobile, passwordHash, mobileVerified }) {
      const u = { id: id(), fullName, email: email?.toLowerCase() ?? null, mobile: mobile ?? null, passwordHash, status: "active", failed: 0, lockedUntil: null,
        mobileVerifiedAt: mobileVerified ? now() : null, emailVerifiedAt: null, lastLoginAt: null, createdAt: now(), legacyId: null };
      db.users.push(u); return u.id;
    },
    async createCustomerProfile(_d, uid) { db.customers.push(uid); },
    async recordLoginSuccess(_d, uid) { const u = db.users.find((x) => x.id === uid); u.failed = 0; u.lockedUntil = null; u.lastLoginAt = now(); },
    async recordLoginFailure(_d, uid, { max, lockMinutes }) {
      const u = db.users.find((x) => x.id === uid); u.failed += 1;
      if (u.failed >= max) u.lockedUntil = new Date(now().getTime() + lockMinutes * 60_000);
      return { failed_login_count: u.failed, locked_until: u.lockedUntil };
    },
    async updatePassword(_d, uid, hash) { const u = db.users.find((x) => x.id === uid); u.passwordHash = hash; u.failed = 0; u.lockedUntil = null; },
    async getPasswordHash(_d, uid) { return db.users.find((x) => x.id === uid)?.passwordHash ?? null; },
    async setStatus(_d, uid, status) { db.users.find((x) => x.id === uid).status = status; },
    async lockById(_d, uid) { const u = db.users.find((x) => x.id === uid); return u ? { id: u.id, status: u.status } : null; },
    async countActiveWithRole(_d, role, except) {
      return db.userRoles.filter((r) => r.role === role && r.userId !== except && db.users.find((u) => u.id === r.userId).status === "active").length;
    },
    async list(_d, { q, status, role, limit, offset }) {
      let rows = db.users.map(accessRow);
      if (q) rows = rows.filter((r) => `${r.full_name} ${r.email} ${r.mobile}`.toLowerCase().includes(q.toLowerCase()));
      if (status) rows = rows.filter((r) => r.status === status);
      if (role) rows = rows.filter((r) => r.roles.includes(role));
      return { rows: rows.slice(offset, offset + limit), total: rows.length };
    },
  };

  const roles = {
    async addUserRole(_d, userId, role) { if (!db.userRoles.some((r) => r.userId === userId && r.role === role)) db.userRoles.push({ userId, role }); },
    async existingKeys(_d, keys) { return keys.filter((k) => ROLES[k]); },
    async replaceUserRoles(_d, userId, keys) { db.userRoles = db.userRoles.filter((r) => r.userId !== userId); keys.forEach((k) => db.userRoles.push({ userId, role: k })); },
    async listRoles() { return Object.entries(ROLES).map(([key, r]) => ({ key, label: r.label, description: r.description, is_system: true, permissions: r.permissions })); },
  };

  const sessions = {
    async insertRefreshToken(_d, t) { const row = { id: id(), userId: t.userId, familyId: t.familyId, hash: t.tokenHash, expiresAt: t.expiresAt, revokedAt: null, replacedBy: null }; db.refresh.push(row); return row.id; },
    async findRefreshTokenForUpdate(_d, hash) {
      const r = db.refresh.find((x) => x.hash === hash);
      return r ? { id: r.id, user_id: r.userId, family_id: r.familyId, expires_at: r.expiresAt, revoked_at: r.revokedAt, replaced_by: r.replacedBy } : null;
    },
    async rotateRefreshToken(_d, oldId, newId) { const r = db.refresh.find((x) => x.id === oldId); r.revokedAt = now(); r.replacedBy = newId; },
    async revokeFamily(_d, fam) { db.refresh.filter((x) => x.familyId === fam).forEach((x) => { x.revokedAt ??= now(); }); },
    async revokeAllForUser(_d, uid) { db.refresh.filter((x) => x.userId === uid).forEach((x) => { x.revokedAt ??= now(); }); },
    async findFamilyByHash(_d, hash) { return db.refresh.find((x) => x.hash === hash)?.familyId ?? null; },
    async insertPasswordReset(_d, r) { db.resets.push({ id: id(), ...r, usedAt: null, createdAt: now() }); },
    async countRecentPasswordResets(_d, uid, sinceIso) { return db.resets.filter((r) => r.userId === uid && r.createdAt > new Date(sinceIso)).length; },
    async findUsablePasswordResetForUpdate(_d, hash) {
      const r = db.resets.find((x) => x.tokenHash === hash && !x.usedAt && x.expiresAt > now());
      return r ? { id: r.id, user_id: r.userId } : null;
    },
    async markPasswordResetUsed(_d, rid) { db.resets.find((x) => x.id === rid).usedAt = now(); },
    async insertOtpChallenge(_d, c) { db.otps.push({ ...c, attempts: 0, consumedAt: null, createdAt: now() }); },
    async countRecentOtpChallenges(_d, mobile, sinceIso) { return db.otps.filter((c) => c.mobile === mobile && c.createdAt > new Date(sinceIso)).length; },
    async findOtpChallengeForUpdate(_d, cid) {
      const c = db.otps.find((x) => x.id === cid);
      return c ? { id: c.id, purpose: c.purpose, mobile: c.mobile, code_hash: c.codeHash, payload: c.payload, attempts: c.attempts, expires_at: c.expiresAt, consumed_at: c.consumedAt } : null;
    },
    async bumpOtpAttempts(_d, cid) { db.otps.find((x) => x.id === cid).attempts += 1; },
    async consumeOtpChallenge(_d, cid) { db.otps.find((x) => x.id === cid).consumedAt = now(); },
  };

  return { db, repos: { users, roles, sessions } };
}

/** Deterministic stand-ins for the slow / external collaborators. */
export const fakeHasher = () => ({
  hash: async (pw) => `h:${Buffer.from(pw).toString("hex")}`, // opaque, like a real hash (never contains the plaintext)
  verify: async (pw, stored) => stored === `h:${Buffer.from(pw).toString("hex")}`,
  needsRehash: () => false,
  dummyHash: async () => "h:dummy",
});
export const fakeTokens = () => ({
  signAccessToken: (uid) => `access.${uid}`,
  verifyAccessToken: (t) => (t.startsWith("access.") ? { userId: t.slice(7) } : null),
});
export function fakeNotifier() {
  const sent = [];
  return { sent, sendSms: async (m) => sent.push({ channel: "sms", ...m }), sendEmail: async (m) => sent.push({ channel: "email", ...m }) };
}
export function fakeAudit() {
  const entries = [];
  return { entries, log: async (e) => { entries.push(e); } };
}
