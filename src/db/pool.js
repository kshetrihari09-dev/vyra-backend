import pg from "pg";

export function createPool(config, logger) {
  const pool = new pg.Pool({
    connectionString: config.db.url,
    max: config.db.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: config.db.ssl ? { rejectUnauthorized: config.db.sslRejectUnauthorized } : undefined,
  });
  // An idle client erroring (e.g. DB restart) must not crash the process.
  pool.on("error", (err) => logger?.error("pg pool error", { error: err.message }));
  return pool;
}

/**
 * Runs `fn(client)` inside BEGIN/COMMIT and rolls back on any throw.
 * Every stock, order, payment, refund and payout operation in later phases goes through this.
 */
export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}
