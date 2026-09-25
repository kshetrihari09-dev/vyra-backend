/**
 * Every function takes the executor `db` first — either the pool or a transaction client — so a service can
 * compose several repository calls into one transaction. All SQL is parameterised.
 */
const ACCESS_SELECT = `
  SELECT u.id, u.full_name, u.email, u.mobile, u.status, u.legacy_id, u.is_demo,
         u.email_verified_at, u.mobile_verified_at, u.last_login_at, u.created_at,
         COALESCE(array_agg(DISTINCT ur.role_key) FILTER (WHERE ur.role_key IS NOT NULL), '{}') AS roles,
         COALESCE(array_agg(DISTINCT rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS permissions
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    LEFT JOIN role_permissions rp ON rp.role_key = ur.role_key`;

export function createUsersRepository() {
  return {
    /** User + role keys + expanded permission keys, or null. */
    async getAccess(db, id) {
      const { rows } = await db.query(`${ACCESS_SELECT} WHERE u.id = $1 GROUP BY u.id`, [id]);
      return rows[0] || null;
    },

    /** Login lookup: an identifier containing '@' is an email, anything else a mobile number. Returns the auth row (with hash). */
    async findForLogin(db, identifier) {
      const isEmail = identifier.includes("@");
      const { rows } = await db.query(
        `SELECT id, password_hash, status, failed_login_count, locked_until
           FROM users WHERE ${isEmail ? "email = lower($1)" : "mobile = $1"}`,
        [identifier],
      );
      return rows[0] || null;
    },

    async findByEmailOrMobile(db, { email, mobile }) {
      const { rows } = await db.query(
        `SELECT id, email, mobile FROM users WHERE ($1::text IS NOT NULL AND email = lower($1)) OR ($2::text IS NOT NULL AND mobile = $2)`,
        [email ?? null, mobile ?? null],
      );
      return rows;
    },

    /** Row needed to send a reset message: any of email / mobile matching, active accounts only. */
    async findActiveByIdentifier(db, identifier) {
      const isEmail = identifier.includes("@");
      const { rows } = await db.query(
        `SELECT id, full_name, email, mobile FROM users WHERE status = 'active' AND ${isEmail ? "email = lower($1)" : "mobile = $1"}`,
        [identifier],
      );
      return rows[0] || null;
    },

    async create(db, { fullName, email, mobile, passwordHash, mobileVerified = false, emailVerified = false, legacyId = null, isDemo = false }) {
      const { rows } = await db.query(
        `INSERT INTO users (full_name, email, mobile, password_hash, mobile_verified_at, email_verified_at, legacy_id, is_demo)
         VALUES ($1, lower($2), $3, $4, CASE WHEN $5 THEN now() END, CASE WHEN $6 THEN now() END, $7, $8)
         RETURNING id`,
        [fullName, email ?? null, mobile ?? null, passwordHash, mobileVerified, emailVerified, legacyId, isDemo],
      );
      return rows[0].id;
    },

    async createCustomerProfile(db, userId) {
      await db.query("INSERT INTO customers (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING", [userId]);
    },

    async recordLoginSuccess(db, id) {
      await db.query("UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1", [id]);
    },

    /** Atomic increment; locks the account once `max` failures accumulate. Returns the new counters. */
    async recordLoginFailure(db, id, { max, lockMinutes }) {
      const { rows } = await db.query(
        `UPDATE users
            SET failed_login_count = failed_login_count + 1,
                locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
          WHERE id = $1
        RETURNING failed_login_count, locked_until`,
        [id, max, lockMinutes],
      );
      return rows[0];
    },

    async updatePassword(db, id, passwordHash) {
      await db.query("UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL WHERE id = $1", [id, passwordHash]);
    },

    async getPasswordHash(db, id) {
      const { rows } = await db.query("SELECT password_hash FROM users WHERE id = $1", [id]);
      return rows[0]?.password_hash ?? null;
    },

    async setStatus(db, id, status) {
      await db.query("UPDATE users SET status = $2 WHERE id = $1", [id, status]);
    },

    /** Paginated list for the admin console. */
    async list(db, { q, status, role, limit, offset }) {
      const params = [];
      const where = [];
      if (q) { params.push(`%${q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`); where.push(`(lower(u.full_name) LIKE $${params.length} OR u.email LIKE $${params.length} OR u.mobile LIKE $${params.length})`); }
      if (status) { params.push(status); where.push(`u.status = $${params.length}`); }
      if (role) { params.push(role); where.push(`EXISTS (SELECT 1 FROM user_roles x WHERE x.user_id = u.id AND x.role_key = $${params.length})`); }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const total = Number((await db.query(`SELECT count(*) AS n FROM users u ${whereSql}`, params)).rows[0].n);
      params.push(limit, offset);
      const { rows } = await db.query(
        `SELECT u.id, u.full_name, u.email, u.mobile, u.status, u.is_demo, u.last_login_at, u.created_at,
                COALESCE(array_agg(ur.role_key ORDER BY ur.role_key) FILTER (WHERE ur.role_key IS NOT NULL), '{}') AS roles
           FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id
           ${whereSql}
          GROUP BY u.id ORDER BY u.created_at DESC, u.id
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { rows, total };
    },

    /** Row-locks the user so concurrent role/status edits serialise. */
    async lockById(db, id) {
      const { rows } = await db.query("SELECT id, status FROM users WHERE id = $1 FOR UPDATE", [id]);
      return rows[0] || null;
    },

    /** Active users holding `role`, excluding `exceptUserId`. Used to keep at least one admin. */
    async countActiveWithRole(db, role, exceptUserId) {
      const { rows } = await db.query(
        `SELECT count(*) AS n FROM users u JOIN user_roles ur ON ur.user_id = u.id
          WHERE ur.role_key = $1 AND u.status = 'active' AND u.id <> $2`,
        [role, exceptUserId],
      );
      return Number(rows[0].n);
    },
  };
}
