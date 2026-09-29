/**
 * `npm run preflight` — run before (and after) every deploy. Exits non-zero if anything is FAIL.
 * Checks the things that have bitten real launches: a config that only "works" because a dev default is still active,
 * a database that isn't migrated, no admin account, and messaging that can't actually send.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
const FAIL = "FAIL"; const WARN = "WARN"; const OK = "ok";

export async function runPreflight({ config, pool, migrationsDir = MIGRATIONS_DIR }) {
  const checks = [];
  const add = (level, name, message) => checks.push({ level, name, message });

  // ---- configuration (loadConfig already refused to boot on hard errors; these are judgement calls)
  add(config.isProd ? OK : WARN, "NODE_ENV", config.isProd ? "production" : `NODE_ENV=${config.nodeEnv} — set NODE_ENV=production on the server`);
  add(config.cookie.secure ? OK : (config.isProd ? FAIL : WARN), "cookies", config.cookie.secure ? "refresh cookie is Secure" : "COOKIE_SECURE is off — the refresh cookie would travel over plain HTTP");
  add(config.trustProxy >= 1 ? OK : WARN, "TRUST_PROXY", config.trustProxy >= 1 ? `${config.trustProxy} proxy hop(s)` : "TRUST_PROXY=0: behind Nginx every request looks like it comes from 127.0.0.1, so rate limits and audit IPs are useless");
  add(config.rateLimit.enabled ? OK : (config.isProd ? FAIL : WARN), "rate limiting", config.rateLimit.enabled ? "enabled" : "disabled");
  add(config.otp.devCode ? (config.isProd ? FAIL : WARN) : OK, "OTP_DEV_CODE", config.otp.devCode ? "a fixed OTP is configured — anyone can register/verify" : "not set");
  add(config.cors.origins.length ? OK : WARN, "CORS", config.cors.origins.length ? config.cors.origins.join(", ") : "no allowed origins — browsers on another origin will be blocked");
  if (config.notify.driver === "console") add(config.isProd ? FAIL : WARN, "messaging", "NOTIFY_DRIVER=console logs OTPs and reset links");
  else if (config.notify.driver === "disabled") add(WARN, "messaging", "NOTIFY_DRIVER=disabled: registration OTPs and password resets cannot be delivered — nobody new can sign up");
  else add(OK, "messaging", `webhook → ${new URL(config.notify.webhookUrl).host}`);
  add(config.jobs.enabled ? OK : WARN, "background jobs", config.jobs.enabled ? "enabled (outbox worker + retention)" : "JOBS_ENABLED is off: no email/SMS will be sent and old data won't be purged");
  add(config.payments.manualWebhookSecret ? OK : WARN, "payment webhook secret", config.payments.manualWebhookSecret ? "set" : "not set");
  const storageOk = config.storage.bucket && config.storage.accessKey && config.storage.secretKey;
  add(storageOk ? OK : WARN, "file storage", storageOk ? `bucket ${config.storage.bucket}` : "no bucket configured — prescription and shop-document uploads use the fallback store, which is not for production");

  // ---- database
  try {
    await pool.query("SELECT 1");
    add(OK, "database", "reachable");
  } catch (err) {
    add(FAIL, "database", `cannot connect: ${err.message}`);
    return finish(checks);
  }
  try {
    const files = (await readdir(migrationsDir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    const applied = new Set((await pool.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const pending = files.filter((f) => !applied.has(f));
    add(pending.length ? FAIL : OK, "migrations", pending.length ? `pending: ${pending.join(", ")} — run npm run migrate` : `${files.length} applied`);
  } catch (err) {
    add(FAIL, "migrations", `cannot read schema_migrations (${err.message}) — run npm run migrate`);
    return finish(checks);
  }
  const one = async (sql) => Number((await pool.query(sql)).rows[0].n);
  const roles = await one("SELECT count(*) AS n FROM roles");
  add(roles >= 6 ? OK : FAIL, "reference data", roles >= 6 ? `${roles} roles` : "roles missing — run npm run seed:reference");
  const admins = await one("SELECT count(*) AS n FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE ur.role_key = 'admin' AND u.status = 'active'");
  add(admins >= 1 ? OK : FAIL, "admin account", admins >= 1 ? `${admins} active admin(s)` : "no active admin — nobody can manage the system");
  const demo = await one("SELECT (SELECT count(*) FROM users WHERE email LIKE '%@vyra.example') AS n");
  add(demo && config.isProd ? FAIL : OK, "demo accounts", demo ? `${demo} @vyra.example demo account(s) exist (known passwords)${config.isProd ? " — delete them" : ""}` : "none");
  const dead = await one("SELECT count(*) AS n FROM notification_outbox WHERE status = 'dead'");
  add(dead ? WARN : OK, "undeliverable messages", dead ? `${dead} message(s) failed permanently — check the gateway` : "none");
  const stuck = await one("SELECT count(*) AS n FROM notification_outbox WHERE status = 'pending' AND created_at < now() - interval '15 minutes'");
  add(stuck ? WARN : OK, "outbox backlog", stuck ? `${stuck} message(s) waiting more than 15 minutes` : "clear");
  return finish(checks);
}

function finish(checks) {
  return { checks, failed: checks.filter((c) => c.level === FAIL).length, warned: checks.filter((c) => c.level === WARN).length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { loadConfig } = await import("../config/env.js");
  const { createPool } = await import("../db/pool.js");
  let config;
  try { config = loadConfig(); } catch (err) { console.error(err.message); process.exit(1); }
  const pool = createPool(config);
  const { checks, failed, warned } = await runPreflight({ config, pool });
  for (const c of checks) console.log(`${c.level.padEnd(4)}  ${c.name.padEnd(22)} ${c.message}`);
  console.log(`\n${failed} failed, ${warned} warning(s)`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}
