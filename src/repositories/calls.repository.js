/** SQL for Vyra Call. Every method takes `db` (pool or transaction client), like the other repositories. */
const OPEN = "('ringing','connecting','active')";

export function createCallsRepository() {
  return {
    // ---------------------------------------------------------------- shop lookup
    /** The shop plus its login. A shop with no owner account can never answer, so it is never callable. */
    async shop(db, sellerId) {
      const { rows } = await db.query(
        `SELECT s.id, s.name, s.status, s.owner_user_id, s.first_party FROM sellers s WHERE s.id = $1`, [sellerId]);
      return rows[0] || null;
    },
    async shopByOwner(db, userId) {
      const { rows } = await db.query(`SELECT s.id, s.name, s.status, s.owner_user_id FROM sellers s WHERE s.owner_user_id = $1`, [userId]);
      return rows[0] || null;
    },

    // ---------------------------------------------------------------- presence
    async setPresence(db, { sellerId, userId, accepting, ttlSeconds }) {
      const { rows } = await db.query(
        `INSERT INTO shop_call_presence (seller_id, user_id, accepting, available_until)
         VALUES ($1, $2, $3, now() + make_interval(secs => $4))
         ON CONFLICT (seller_id) DO UPDATE SET user_id = EXCLUDED.user_id, accepting = EXCLUDED.accepting,
           available_until = EXCLUDED.available_until, updated_at = now()
         RETURNING available_until`, [sellerId, userId, accepting, ttlSeconds]);
      return rows[0].available_until;
    },
    async clearPresence(db, sellerId) { await db.query(`DELETE FROM shop_call_presence WHERE seller_id = $1`, [sellerId]); },
    async getPresence(db, sellerId) {
      const { rows } = await db.query(
        `SELECT accepting, available_until, available_until > now() AS online FROM shop_call_presence WHERE seller_id = $1`, [sellerId]);
      return rows[0] || null;
    },

    // ---------------------------------------------------------------- calls
    async insert(db, c) {
      const { rows } = await db.query(
        `INSERT INTO vyra_calls (customer_id, seller_id, client_call_id, ring_expires_at)
         VALUES ($1, $2, $3, now() + make_interval(secs => $4)) RETURNING *`,
        [c.customerId, c.sellerId, c.clientCallId, c.ringSeconds]);
      return rows[0];
    },
    async byClientId(db, customerId, clientCallId) {
      const { rows } = await db.query(`SELECT * FROM vyra_calls WHERE customer_id = $1 AND client_call_id = $2`, [customerId, clientCallId]);
      return rows[0] || null;
    },
    async getById(db, id, { forUpdate = false } = {}) {
      const { rows } = await db.query(`SELECT * FROM vyra_calls WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`, [id]);
      return rows[0] || null;
    },
    async openForCustomer(db, customerId) {
      const { rows } = await db.query(`SELECT * FROM vyra_calls WHERE customer_id = $1 AND status IN ${OPEN}`, [customerId]);
      return rows[0] || null;
    },
    async openForShop(db, sellerId) {
      const { rows } = await db.query(`SELECT * FROM vyra_calls WHERE seller_id = $1 AND status IN ${OPEN}`, [sellerId]);
      return rows[0] || null;
    },
    /** Calls a user is part of that are open, or ended in the last `recentSeconds` (so a stream that reconnects still learns how it ended). */
    async visibleToUser(db, { userId, sellerId, recentSeconds }) {
      const { rows } = await db.query(
        `SELECT c.*, u.full_name AS customer_name, s.name AS shop_name
           FROM vyra_calls c
           JOIN users u ON u.id = c.customer_id
           JOIN sellers s ON s.id = c.seller_id
          WHERE (c.customer_id = $1 OR c.seller_id = $2)
            AND (c.status IN ${OPEN} OR c.ended_at > now() - make_interval(secs => $3))
          ORDER BY c.created_at DESC LIMIT 5`, [userId, sellerId ?? "", recentSeconds]);
      return rows;
    },
    async withNames(db, id) {
      const { rows } = await db.query(
        `SELECT c.*, u.full_name AS customer_name, s.name AS shop_name
           FROM vyra_calls c JOIN users u ON u.id = c.customer_id JOIN sellers s ON s.id = c.seller_id WHERE c.id = $1`, [id]);
      return rows[0] || null;
    },
    async markAccepted(db, id, userId) {
      const { rows } = await db.query(
        `UPDATE vyra_calls SET status = 'connecting', answered_by = $2, answered_at = now(), shop_seen_at = now()
          WHERE id = $1 AND status = 'ringing' RETURNING *`, [id, userId]);
      return rows[0] || null;
    },
    async markConnected(db, id) {
      const { rows } = await db.query(
        `UPDATE vyra_calls SET status = 'active', connected_at = COALESCE(connected_at, now())
          WHERE id = $1 AND status IN ('connecting','active') RETURNING *`, [id]);
      return rows[0] || null;
    },
    /** Moves an OPEN call to a final status exactly once; duration is connected_at -> now (null if audio never connected). */
    async finish(db, id, { status, reason, by }) {
      const { rows } = await db.query(
        `UPDATE vyra_calls SET status = $2, end_reason = $3, ended_by = $4, ended_at = now(),
                duration_seconds = CASE WHEN connected_at IS NULL THEN NULL ELSE GREATEST(0, floor(extract(epoch FROM (now() - connected_at)))::int) END
          WHERE id = $1 AND status IN ${OPEN} RETURNING *`, [id, status, reason, by]);
      return rows[0] || null;
    },
    async touch(db, id, role) {
      const col = role === "customer" ? "customer_seen_at" : "shop_seen_at";
      await db.query(`UPDATE vyra_calls SET ${col} = now() WHERE id = $1 AND status IN ${OPEN}`, [id]);
    },
    /** Open calls that have outlived their ring, connect window, liveness window or hard cap — the expiry job closes them. */
    async stale(db, { connectSeconds, peerTimeoutSeconds, maxMinutes }) {
      const { rows } = await db.query(
        `SELECT c.id, c.customer_id, c.seller_id, c.status,
           CASE
             WHEN c.status = 'ringing' AND c.ring_expires_at <= now() THEN 'ring_timeout'
             WHEN c.status = 'connecting' AND c.answered_at <= now() - make_interval(secs => $1) THEN 'connect_timeout'
             WHEN c.status IN ('connecting','active') AND (c.customer_seen_at <= now() - make_interval(secs => $2)
                                                        OR COALESCE(c.shop_seen_at, c.answered_at) <= now() - make_interval(secs => $2)) THEN 'peer_lost'
             WHEN c.status = 'active' AND c.connected_at <= now() - make_interval(mins => $3) THEN 'max_duration'
             WHEN c.status = 'ringing' AND c.customer_seen_at <= now() - make_interval(secs => $2) THEN 'peer_lost'
           END AS reason
          FROM vyra_calls c WHERE c.status IN ${OPEN}`, [connectSeconds, peerTimeoutSeconds, maxMinutes]);
      return rows.filter((r) => r.reason);
    },

    // ---------------------------------------------------------------- signals
    async addSignal(db, { callId, fromRole, kind, payload }) {
      const { rows } = await db.query(
        `INSERT INTO vyra_call_signals (call_id, from_role, kind, payload) VALUES ($1,$2,$3,$4::jsonb) RETURNING id`,
        [callId, fromRole, kind, JSON.stringify(payload)]);
      return rows[0].id;
    },
    /** Signals addressed TO `toRole` (i.e. sent by the other side) after the cursor, for the given calls. */
    async signalsFor(db, { callIds, toRole, after }) {
      if (!callIds.length) return [];
      const from = toRole === "customer" ? "shop" : "customer";
      const { rows } = await db.query(
        `SELECT id, call_id, kind, payload FROM vyra_call_signals
          WHERE call_id = ANY($1::uuid[]) AND from_role = $2 AND id > $3 ORDER BY id ASC LIMIT 200`, [callIds, from, after]);
      return rows;
    },
    async countSignals(db, callId, fromRole) {
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM vyra_call_signals WHERE call_id = $1 AND from_role = $2`, [callId, fromRole]);
      return rows[0].n;
    },
    async purgeSignals(db, { olderThanMinutes }) {
      const { rowCount } = await db.query(
        `DELETE FROM vyra_call_signals s USING vyra_calls c
          WHERE c.id = s.call_id AND c.ended_at IS NOT NULL AND c.ended_at < now() - make_interval(mins => $1)`, [olderThanMinutes]);
      return rowCount;
    },

    // ---------------------------------------------------------------- history (shop-scoped by construction: seller_id is a required filter)
    async shopHistory(db, { sellerId, limit, offset, missedOnly }) {
      const where = ["c.seller_id = $1", "c.status NOT IN ('ringing','connecting','active')"];
      if (missedOnly) where.push("c.status = 'missed'");
      const total = Number((await db.query(`SELECT count(*) AS n FROM vyra_calls c WHERE ${where.join(" AND ")}`, [sellerId])).rows[0].n);
      const { rows } = await db.query(
        `SELECT c.id, c.status, c.end_reason, c.created_at, c.answered_at, c.connected_at, c.ended_at, c.duration_seconds, u.full_name AS customer_name
           FROM vyra_calls c JOIN users u ON u.id = c.customer_id
          WHERE ${where.join(" AND ")} ORDER BY c.created_at DESC LIMIT $2 OFFSET $3`, [sellerId, limit, offset]);
      return { rows, total };
    },
    async missedSince(db, { sellerId, since }) {
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM vyra_calls WHERE seller_id = $1 AND status = 'missed' AND created_at > $2`, [sellerId, since]);
      return rows[0].n;
    },
  };
}
