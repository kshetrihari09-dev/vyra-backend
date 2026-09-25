import pg from "pg";
import supertest from "supertest";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/env.js";
import { createContainer } from "../../src/container.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedReference } from "../../seeds/reference/roles_permissions.js";
import { hashPassword } from "../../src/utils/password.js";
import { seedDemoCatalog } from "../../seeds/demo/catalog.js";
import { seedDemoCommerce } from "../../seeds/demo/commerce.js";
import { seedDemoPurchasing } from "../../seeds/demo/purchasing.js";

export const TEST_DB = process.env.TEST_DATABASE_URL;
export const skipReason = TEST_DB ? false : "TEST_DATABASE_URL not set (point it at a throwaway Postgres database)";

/** Boots the real app against a real Postgres. Migrations + reference seed are idempotent, so tests can share one database. */
export async function boot() {
  const config = loadConfig({
    NODE_ENV: "test", DATABASE_URL: TEST_DB, DISABLE_RATE_LIMIT: "true",
    JWT_SECRET: "t".repeat(40), JWT_REFRESH_SECRET: "u".repeat(40),
    CORS_ORIGIN: "http://localhost:5173", OTP_DEV_CODE: "1234", NOTIFY_DRIVER: "console", LOG_LEVEL: "silent",
  });
  const container = createContainer(config);
  await runMigrations(container.pool, { log: () => {} });
  await seedReference(container.pool);
  await seedDemoCatalog(container.pool, { log: () => {} });
  await seedDemoCommerce(container.pool, { log: () => {} });
  await seedDemoPurchasing(container.pool, { log: () => {} });
  const app = createApp(container);
  return { app, request: supertest(app), container, close: () => container.pool.end() };
}

let n = 0;
export const uniq = () => `${Date.now().toString(36)}${(n++).toString(36)}`;

/** Inserts a user directly (bypassing the public API) with the given roles. */
export async function makeUser(container, { roles = ["customer"], password = "Passw0rd1", status = "active" } = {}) {
  const tag = uniq();
  const email = `it-${tag}@test.example`;
  const { rows } = await container.pool.query(
    "INSERT INTO users (full_name, email, password_hash, status, is_demo) VALUES ($1, $2, $3, $4, true) RETURNING id",
    [`IT ${tag}`, email, await hashPassword(password), status],
  );
  for (const r of roles) await container.pool.query("INSERT INTO user_roles (user_id, role_key) VALUES ($1, $2)", [rows[0].id, r]);
  return { id: rows[0].id, email, password };
}

export async function loginAs(request, user) {
  const res = await request.post("/api/auth/login").send({ identifier: user.email, password: user.password });
  return { token: res.body.data?.accessToken, cookies: res.headers["set-cookie"], res };
}
