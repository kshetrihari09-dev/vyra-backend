/**
 * `node --env-file=.env src/scripts/reset-admin-password.js --email you@example.com`
 *
 * Sets a new password for an EXISTING administrator (refuses anyone without the admin role), clears any login
 * lockout, and revokes their refresh tokens. The password is typed at a hidden prompt (or read from
 * ADMIN_PASSWORD) — never put it on the command line. Needs only DATABASE_URL (+ DB_SSL=true for managed Postgres).
 */
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { hashPassword } from "../utils/password.js";

const MIN = 12;

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer); });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { email: { type: "string" } }, allowPositionals: true });
  const email = String(values.email || "").trim().toLowerCase();
  console.log(`Resetting admin password for ${email || "(no --email given)"} …`);
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false" } : undefined,
  });
  try {
    if (!email) throw new Error("Provide --email.");
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (check backend/.env).");
    const user = (await pool.query(
      `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.role_key = 'admin'
        WHERE u.email = $1 AND u.status = 'active' AND NOT u.is_demo`, [email])).rows[0];
    if (!user) throw new Error("No active admin account with that email.");
    let password = process.env.ADMIN_PASSWORD;
    if (!password) {
      if (!process.stdin.isTTY) throw new Error("No terminal for the password prompt — set ADMIN_PASSWORD for this one command.");
      password = await promptHidden(`New password (min ${MIN} chars, hidden): `);
      if (password !== await promptHidden("Repeat password: ")) throw new Error("Passwords didn't match.");
    }
    if (password.length < MIN) throw new Error(`Admin passwords need at least ${MIN} characters.`);
    const hash = await hashPassword(password);
    await pool.query("UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL WHERE id = $1", [user.id, hash]);
    await pool.query("DELETE FROM refresh_tokens WHERE user_id = $1", [user.id]).catch(() => {}); // best effort: revoke old sessions
    console.log(`✔ Password updated for ${email}. You can sign in now.`);
  } catch (err) {
    console.error("✖", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
