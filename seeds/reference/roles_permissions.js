import { PERMISSIONS, ROLES } from "../../src/config/permissions.js";

/**
 * REFERENCE DATA — required in every environment, production included.
 * Idempotent and additive: it inserts/updates roles, permissions and grants from src/config/permissions.js and
 * never removes a grant an administrator added at runtime.
 */
export async function seedReference(db) {
  for (const [key, description] of Object.entries(PERMISSIONS)) {
    await db.query(
      "INSERT INTO permissions (key, description) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description",
      [key, description],
    );
  }
  for (const [key, role] of Object.entries(ROLES)) {
    await db.query(
      `INSERT INTO roles (key, label, description, is_system) VALUES ($1, $2, $3, true)
       ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description, is_system = true`,
      [key, role.label, role.description],
    );
    for (const permission of role.permissions) {
      await db.query("INSERT INTO role_permissions (role_key, permission_key) VALUES ($1, $2) ON CONFLICT DO NOTHING", [key, permission]);
    }
  }
  return { roles: Object.keys(ROLES).length, permissions: Object.keys(PERMISSIONS).length };
}
