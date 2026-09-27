/**
 * One-off: create (or promote) an admin account.
 *
 * Usage:
 *   ADMIN_NAME="Hari Khatri Kshetri" ADMIN_EMAIL="khatrihari9999@gmail.com" \
 *   ADMIN_PASSWORD="@#passhari123" node --env-file-if-exists=.env scripts/create-admin.js
 *
 * Safe to re-run: if the email already exists, it just resets the password and
 * makes sure the 'admin' role is attached — it won't create a duplicate user.
 */
import pg from "pg";
import { hashPassword } from "../src/utils/password.js";

const name = process.env.ADMIN_NAME;
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;

if (!name || !email || !password) {
  console.error("usage: ADMIN_NAME=... ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/create-admin.js");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false" } : undefined,
});

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const passwordHash = await hashPassword(password);

  const { rows } = await client.query(
    `INSERT INTO users (full_name, email, password_hash, email_verified_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, full_name = EXCLUDED.full_name
     RETURNING id`,
    [name, email, passwordHash],
  );
  const userId = rows[0].id;

  await client.query(
    "INSERT INTO user_roles (user_id, role_key) VALUES ($1, 'admin') ON CONFLICT DO NOTHING",
    [userId],
  );

  await client.query("COMMIT");
  console.log(`admin ready: ${email} (user id ${userId})`);
} catch (err) {
  await client.query("ROLLBACK");
  console.error("failed:", err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
