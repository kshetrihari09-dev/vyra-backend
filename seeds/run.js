/**
 *   npm run seed:reference   roles + permissions (safe everywhere, run on every deploy)
 *   npm run seed:demo        demo accounts (refuses in production unless ALLOW_DEMO_SEED=true)
 */
import pg from "pg";
import { seedReference } from "./reference/roles_permissions.js";
import { seedDemoUsers } from "./demo/users.js";
import { seedDemoCatalog } from "./demo/catalog.js";
import { seedDemoCommerce } from "./demo/commerce.js";
import { seedDemoPurchasing } from "./demo/purchasing.js";

const target = process.argv[2];
if (!["reference", "demo"].includes(target)) { console.error("usage: seeds/run.js <reference|demo>"); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(1); }
if (target === "demo" && process.env.NODE_ENV === "production" && process.env.ALLOW_DEMO_SEED !== "true") {
  console.error("Refusing to seed demo data in production (set ALLOW_DEMO_SEED=true if you really mean it).");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false" } : undefined,
});
const client = await pool.connect();
try {
  await client.query("BEGIN");
  if (target === "reference") console.log("reference data:", await seedReference(client));
  else {
    await seedReference(client); // demo users need the roles to exist
    await seedDemoUsers(client, { password: process.env.DEMO_SEED_PASSWORD || undefined });
    console.log("demo catalogue:", await seedDemoCatalog(client));
    console.log("demo commerce:", await seedDemoCommerce(client));
    console.log("demo purchasing:", await seedDemoPurchasing(client));
  }
  await client.query("COMMIT");
} catch (err) {
  await client.query("ROLLBACK");
  console.error("seed failed:", err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
