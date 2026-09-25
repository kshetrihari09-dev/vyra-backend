import { randomBytes } from "node:crypto";
import { hashPassword } from "../../src/utils/password.js";

/**
 * DEMO DATA — never part of a production deploy. Every row is flagged users.is_demo = true so it can be found
 * and deleted. Passwords are never hard-coded: set DEMO_SEED_PASSWORD, or a random one is generated and printed.
 *
 * Customer identity mirrors the prototype's seed customer (legacy_id 'cus-1001') so the migrated demo orders
 * in later phases attach to the same person.
 */
const DEMO_USERS = [
  { name: "Alex Morgan", email: "alex.morgan@example.com", mobile: "+1 555 0190", legacyId: "cus-1001", roles: ["customer"], customer: true },
  { name: "Vyra Admin", email: "admin@vyra.example", roles: ["admin"] },
  { name: "Dr. N. Rao", email: "pharmacist@vyra.example", roles: ["pharmacist"] },
  { name: "Daniel R.", email: "rider@vyra.example", roles: ["delivery"] },
  { name: "Warehouse Lead", email: "warehouse@vyra.example", roles: ["warehouse"] },
  { name: "Accounts", email: "accountant@vyra.example", roles: ["accountant"] },
  { name: "Support Agent", email: "support@vyra.example", roles: ["support"] },
  { name: "NovaTech Owner", email: "novatech@vyra.example", roles: ["customer", "seller"], customer: true },
];

export async function seedDemoUsers(db, { password, log = console.log } = {}) {
  const generated = !password;
  const pw = password || randomBytes(9).toString("base64url");
  const passwordHash = await hashPassword(pw);

  for (const u of DEMO_USERS) {
    const { rows } = await db.query(
      `INSERT INTO users (full_name, email, mobile, password_hash, mobile_verified_at, email_verified_at, legacy_id, is_demo)
       VALUES ($1, $2, $3, $4, CASE WHEN $3::text IS NOT NULL THEN now() END, now(), $5, true)
       ON CONFLICT (email) DO NOTHING RETURNING id`,
      [u.name, u.email, u.mobile ?? null, passwordHash, u.legacyId ?? null],
    );
    if (!rows[0]) { log(`skip ${u.email} (already exists)`); continue; }
    const id = rows[0].id;
    if (u.customer) await db.query("INSERT INTO customers (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
    for (const role of u.roles) await db.query("INSERT INTO user_roles (user_id, role_key) VALUES ($1, $2) ON CONFLICT DO NOTHING", [id, role]);
    log(`created ${u.email} [${u.roles.join(", ")}]`);
  }
  if (generated) log(`\nGenerated demo password (shown once): ${pw}`);
  return { count: DEMO_USERS.length, generatedPassword: generated ? pw : null };
}
