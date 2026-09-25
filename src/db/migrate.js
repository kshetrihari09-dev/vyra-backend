/**
 * Tiny forward-only migration runner.
 *   npm run migrate          apply pending migrations/*.sql in filename order
 *   npm run migrate:status   list applied / pending
 * Each file runs in its own transaction. Applied files are checksummed; editing one after it has
 * been applied is an error (write a new migration instead).
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
const LOCK_KEY = 727_001; // arbitrary constant for pg_advisory_lock so two deploys can't migrate at once

const sha = (text) => createHash("sha256").update(text).digest("hex");

export async function runMigrations(pool, { dir = MIGRATIONS_DIR, log = console.log, dryRun = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Map((await client.query("SELECT name, checksum FROM schema_migrations")).rows.map((r) => [r.name, r.checksum]));
    const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    const result = { applied: [], pending: [] };

    for (const file of files) {
      const sql = await readFile(path.join(dir, file), "utf8");
      const checksum = sha(sql);
      if (applied.has(file)) {
        if (applied.get(file) !== checksum) throw new Error(`Migration ${file} was modified after being applied. Add a new migration instead.`);
        continue;
      }
      if (dryRun) { result.pending.push(file); continue; }
      log(`applying ${file} ...`);
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
        await client.query("COMMIT");
        result.applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
    return { ...result, alreadyApplied: [...applied.keys()] };
  } finally {
    try { await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]); } catch { /* ignore */ }
    client.release();
  }
}

// CLI entry
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || "up";
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(1); }
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false" } : undefined,
  });
  try {
    const r = await runMigrations(pool, { dryRun: command === "status" });
    if (command === "status") console.log(`applied: ${r.alreadyApplied.length}\npending: ${r.pending.length ? r.pending.join(", ") : "none"}`);
    else console.log(r.applied.length ? `applied ${r.applied.length}: ${r.applied.join(", ")}` : "database is up to date");
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
