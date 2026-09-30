/**
 * `npm run create-admin -- --email you@example.com --name "Your Name" [--mobile 98XXXXXXXX]`
 *
 * Creates (or promotes) a real administrator directly in the database — the ONLY supported way to get an
 * admin in production. No demo data is involved, and the password never appears on the command line:
 * supply it via the ADMIN_PASSWORD env var or type it at the hidden prompt.
 *
 *   • new email      → creates the account (password required) and grants the `admin` role
 *   • existing email → grants `admin` to that account; its password is left untouched
 * Demo accounts (is_demo) are refused. Safe to re-run.
 */
import readline from "node:readline";
import { parseArgs } from "node:util";
import { loadConfig } from "../config/env.js";
import { createPool } from "../db/pool.js";
import { hashPassword } from "../utils/password.js";
import { password as passwordRule, mobile as mobileRule } from "../validators/common.js";

const MIN_ADMIN_PASSWORD = 12;

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); }; // don't echo keystrokes
    rl.question(question, (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer); });
  });
}

export async function createAdmin(pool, { email, name, mobile, password }) {
  email = String(email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Provide a valid --email.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = (await client.query("SELECT id, is_demo, status FROM users WHERE email = $1 FOR UPDATE", [email])).rows[0];
    let userId; let created = false;
    if (found) {
      if (found.is_demo) throw new Error("That account is a demo/seed account; refusing to promote it.");
      if (found.status !== "active") throw new Error(`That account is ${found.status}; reactivate it first.`);
      userId = found.id;
    } else {
      if (!name?.trim()) throw new Error("Provide --name for a new account.");
      const problems = passwordRule.safeParse(password);
      if (!problems.success) throw new Error(problems.error.issues.map((i) => i.message).join("; "));
      if (password.length < MIN_ADMIN_PASSWORD) throw new Error(`Admin passwords need at least ${MIN_ADMIN_PASSWORD} characters.`);
      if (mobile) { const m = mobileRule.safeParse(mobile); if (!m.success) throw new Error(m.error.issues[0].message); }
      const hash = await hashPassword(password);
      userId = (await client.query(
        `INSERT INTO users (full_name, email, mobile, password_hash, email_verified_at)
         VALUES ($1, $2, $3, $4, now()) RETURNING id`, [name.trim(), email, mobile || null, hash])).rows[0].id;
      created = true;
    }
    const granted = await client.query(
      "INSERT INTO user_roles (user_id, role_key) VALUES ($1, 'admin') ON CONFLICT DO NOTHING", [userId]);
    await client.query("COMMIT");
    return { userId, created, roleGranted: granted.rowCount === 1 };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---- CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { email: { type: "string" }, name: { type: "string" }, mobile: { type: "string" } } });
  const config = loadConfig();
  const pool = createPool(config);
  try {
    const email = String(values.email || "").trim().toLowerCase();
    const exists = email && (await pool.query("SELECT 1 FROM users WHERE email = $1", [email])).rowCount > 0;
    let password = process.env.ADMIN_PASSWORD;
    if (!exists && !password) {
      if (!process.stdin.isTTY) throw new Error("No terminal for the password prompt — set ADMIN_PASSWORD for this one command.");
      password = await promptHidden("Admin password (min 12 chars, hidden): ");
      if (password !== await promptHidden("Repeat password: ")) throw new Error("Passwords didn't match.");
    }
    const r = await createAdmin(pool, { ...values, password });
    console.log(r.created ? `✔ Created admin ${email}` : `✔ Existing account ${email}`, r.roleGranted ? "— admin role granted." : "— already an admin, nothing to change.");
  } catch (err) {
    console.error("✖", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
