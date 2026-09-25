export function createRolesRepository() {
  return {
    async listRoles(db) {
      const { rows } = await db.query(
        `SELECT r.key, r.label, r.description, r.is_system,
                COALESCE(array_agg(rp.permission_key ORDER BY rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS permissions
           FROM roles r LEFT JOIN role_permissions rp ON rp.role_key = r.key
          GROUP BY r.key ORDER BY r.key`,
      );
      return rows;
    },

    async existingKeys(db, keys) {
      if (!keys.length) return [];
      const { rows } = await db.query("SELECT key FROM roles WHERE key = ANY($1::text[])", [keys]);
      return rows.map((r) => r.key);
    },

    async getUserRoles(db, userId) {
      const { rows } = await db.query("SELECT role_key FROM user_roles WHERE user_id = $1 ORDER BY role_key", [userId]);
      return rows.map((r) => r.role_key);
    },

    async addUserRole(db, userId, roleKey, grantedBy = null) {
      await db.query("INSERT INTO user_roles (user_id, role_key, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [userId, roleKey, grantedBy]);
    },

    /** Makes the user's role set exactly `roleKeys`. */
    async replaceUserRoles(db, userId, roleKeys, grantedBy) {
      await db.query("DELETE FROM user_roles WHERE user_id = $1 AND NOT (role_key = ANY($2::text[]))", [userId, roleKeys]);
      await db.query(
        `INSERT INTO user_roles (user_id, role_key, granted_by)
         SELECT $1, k, $3 FROM unnest($2::text[]) AS k ON CONFLICT DO NOTHING`,
        [userId, roleKeys, grantedBy],
      );
    },
  };
}
