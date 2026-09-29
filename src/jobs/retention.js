import { PURGE_BATCH, RETENTION_DAYS as D } from "../config/retention.js";

/** [label, table, WHERE clause using $1 = days]. Everything here is expired, used-up or superseded data. */
const RULES = [
  ["refresh_tokens", "refresh_tokens", "expires_at < now() - make_interval(days => $1)", D.refreshTokensAfterExpiry],
  ["password_resets", "password_resets", "expires_at < now() - make_interval(days => $1)", D.passwordResetsAfterExpiry],
  ["otp_challenges", "otp_challenges", "expires_at < now() - make_interval(days => $1)", D.otpChallengesAfterExpiry],
  ["notifications_read", "notifications", "read_at IS NOT NULL AND created_at < now() - make_interval(days => $1)", D.notificationsRead],
  ["notifications_any", "notifications", "created_at < now() - make_interval(days => $1)", D.notificationsAny],
  ["outbox_sent", "notification_outbox", "status = 'sent' AND created_at < now() - make_interval(days => $1)", D.outboxSent],
  ["outbox_dead", "notification_outbox", "status = 'dead' AND created_at < now() - make_interval(days => $1)", D.outboxDead],
];

/**
 * Daily housekeeping. Deletes in batches (so a big backlog never holds a long lock) and is idempotent — running it in
 * several processes at once is harmless. NOT touched: audit_logs (append-only), orders, payments, stock movements.
 */
export function createRetentionJob({ pool, logger }) {
  async function purge(table, where, days) {
    let total = 0;
    for (;;) {
      const { rowCount } = await pool.query(`DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${where} LIMIT ${PURGE_BATCH})`, [days]);
      total += rowCount;
      if (rowCount < PURGE_BATCH) return total;
    }
  }
  return {
    async run() {
      const result = {};
      for (const [label, table, where, days] of RULES) result[label] = await purge(table, where, days);
      // Safety net for the privacy promise "a delivery's location trail is deleted when the run ends": the delivery
      // service purges on completion/failure, this catches anything left by a crash between two statements.
      const { rowCount } = await pool.query(
        `DELETE FROM delivery_locations dl USING deliveries d WHERE d.id = dl.delivery_id AND d.status NOT IN ('assigned','accepted','picked_up')`);
      result.delivery_locations_orphaned = rowCount;
      logger.info("retention purge", result);
      return result;
    },
  };
}
