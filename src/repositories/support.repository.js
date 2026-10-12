/**
 * Pharmacist support: conversations, messages, read cursors and pharmacist presence. SQL only — authorisation lives in
 * the service. Customer-facing reads are ALWAYS keyed by customer_id in the WHERE clause, so a customer can never be
 * handed another customer's thread even if a caller passes the wrong id.
 */
const PERMISSION = "support:pharmacist";

// A message plus everything a screen shows next to it. Order/prescription details are masked in the service by who is asking.
const MESSAGE_SELECT = `
  SELECT m.*, su.full_name AS sender_name,
         o.number AS order_number, o.status AS order_status,
         p.name AS product_name,
         rx.status AS prescription_status
    FROM support_messages m
    LEFT JOIN users su ON su.id = m.sender_id
    LEFT JOIN orders o ON o.id = m.order_id
    LEFT JOIN products p ON p.id = m.product_id
    LEFT JOIN prescriptions rx ON rx.id = m.prescription_id`;

const HAS_PERMISSION = `EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_key = ur.role_key
                                  WHERE ur.user_id = u.id AND rp.permission_key = '${PERMISSION}')`;

export function createSupportRepository() {
  return {
    // ------------------------------------------------------------ conversations
    async findByCustomer(db, customerId, department, { lock = false } = {}) {
      const { rows } = await db.query(
        `SELECT * FROM support_conversations WHERE customer_id = $1 AND department = $2 ${lock ? "FOR UPDATE" : ""}`, [customerId, department]);
      return rows[0] || null;
    },
    /** Finds or creates the (customer, department) thread, row-locked for the rest of the transaction. */
    async lockOrCreate(db, customerId, department) {
      await db.query(
        "INSERT INTO support_conversations (customer_id, department) VALUES ($1, $2) ON CONFLICT (customer_id, department) DO NOTHING", [customerId, department]);
      return this.findByCustomer(db, customerId, department, { lock: true });
    },
    async getById(db, id, { lock = false } = {}) {
      const { rows } = await db.query(
        `SELECT c.*, u.full_name AS customer_name, a.full_name AS assigned_name
           FROM support_conversations c
           JOIN users u ON u.id = c.customer_id
           LEFT JOIN users a ON a.id = c.assigned_to
          WHERE c.id = $1 ${lock ? "FOR UPDATE OF c" : ""}`, [id]);
      return rows[0] || null;
    },
    async getByCustomerWithNames(db, customerId, department) {
      const { rows } = await db.query(
        `SELECT c.*, u.full_name AS customer_name, a.full_name AS assigned_name
           FROM support_conversations c
           JOIN users u ON u.id = c.customer_id
           LEFT JOIN users a ON a.id = c.assigned_to
          WHERE c.customer_id = $1 AND c.department = $2`, [customerId, department]);
      return rows[0] || null;
    },
    async touch(db, id, { reopen = false } = {}) {
      await db.query(
        `UPDATE support_conversations
            SET last_message_at = now(),
                status = CASE WHEN $2 THEN 'open' ELSE status END,
                resolved_at = CASE WHEN $2 THEN NULL ELSE resolved_at END,
                resolved_by = CASE WHEN $2 THEN NULL ELSE resolved_by END
          WHERE id = $1`, [id, reopen]);
    },
    async assignIfUnassigned(db, id, userId) {
      await db.query("UPDATE support_conversations SET assigned_to = $2 WHERE id = $1 AND assigned_to IS NULL", [id, userId]);
    },
    async setStatus(db, id, status, userId) {
      const { rows } = await db.query(
        `UPDATE support_conversations
            SET status = $2, resolved_at = CASE WHEN $2 = 'resolved' THEN now() END, resolved_by = CASE WHEN $2 = 'resolved' THEN $3::uuid END
          WHERE id = $1 RETURNING *`, [id, status, userId]);
      return rows[0] || null;
    },
    /** Moves a read cursor forward only (GREATEST), never back. side: 'customer' | 'staff'. */
    async markRead(db, id, side, seq) {
      const col = side === "customer" ? "customer_last_read_seq" : "staff_last_read_seq";
      await db.query(`UPDATE support_conversations SET ${col} = GREATEST(${col}, $2) WHERE id = $1`, [id, seq]);
    },

    // ----------------------------------------------------------------- messages
    /** Inserts a message; returns { row, duplicate }. A repeated (conversation, sender, clientMessageId) returns the original. */
    async insertMessage(db, m) {
      const { rows } = await db.query(
        `INSERT INTO support_messages (conversation_id, sender_id, sender_role, via, topic, body, client_message_id, order_id, product_id, prescription_id, email_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (conversation_id, sender_id, client_message_id) WHERE client_message_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [m.conversationId, m.senderId, m.senderRole, m.via, m.topic ?? null, m.body, m.clientMessageId ?? null, m.orderId ?? null, m.productId ?? null, m.prescriptionId ?? null, m.via === "form" ? "pending" : null]);
      if (rows[0]) return { row: await this.getMessage(db, rows[0].id), duplicate: false };
      const existing = await db.query(`${MESSAGE_SELECT} WHERE m.conversation_id = $1 AND m.sender_id = $2 AND m.client_message_id = $3`, [m.conversationId, m.senderId, m.clientMessageId]);
      return { row: existing.rows[0], duplicate: true };
    },
    async getMessage(db, id) {
      return (await db.query(`${MESSAGE_SELECT} WHERE m.id = $1`, [id])).rows[0] || null;
    },
    /** Oldest-first page. `beforeSeq` pages back through history; `afterSeq` is the live cursor. */
    async listMessages(db, conversationId, { beforeSeq, afterSeq, limit }) {
      const params = [conversationId]; const where = ["m.conversation_id = $1"];
      if (beforeSeq) { params.push(beforeSeq); where.push(`m.seq < $${params.length}`); }
      if (afterSeq) { params.push(afterSeq); where.push(`m.seq > $${params.length}`); }
      params.push(limit + 1);
      // Newest-first with LIMIT so "the last N" is cheap, then flipped to chronological. Fetching limit+1 tells us whether there is more.
      const order = afterSeq && !beforeSeq ? "ASC" : "DESC";
      const { rows } = await db.query(`${MESSAGE_SELECT} WHERE ${where.join(" AND ")} ORDER BY m.seq ${order} LIMIT $${params.length}`, params);
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return { rows: order === "DESC" ? page.reverse() : page, hasMore };
    },
    async maxSeq(db, conversationId) {
      return Number((await db.query("SELECT COALESCE(MAX(seq), 0) AS n FROM support_messages WHERE conversation_id = $1", [conversationId])).rows[0].n);
    },
    /** Messages from the OTHER side that this side hasn't read. */
    async unread(db, conversationId, side) {
      const { rows } = await db.query(
        side === "customer"
          ? `SELECT count(*) AS n FROM support_messages m JOIN support_conversations c ON c.id = m.conversation_id
              WHERE m.conversation_id = $1 AND m.sender_role = 'staff' AND m.seq > c.customer_last_read_seq`
          : `SELECT count(*) AS n FROM support_messages m JOIN support_conversations c ON c.id = m.conversation_id
              WHERE m.conversation_id = $1 AND m.sender_role = 'customer' AND m.seq > c.staff_last_read_seq`, [conversationId]);
      return Number(rows[0].n);
    },

    // ------------------------------------------------------- email leg (form)
    /**
     * Atomically takes the right to send the email for ONE message. Returns the row if this caller should send, null if
     * it was already accepted or another request is sending it right now (a 'sending' claim older than staleSeconds is
     * treated as a crashed attempt and can be taken over).
     */
    async claimEmailAttempt(db, messageId, { staleSeconds }) {
      const { rows } = await db.query(
        `UPDATE support_messages
            SET email_status = 'sending', email_attempts = email_attempts + 1, email_attempt_at = now()
          WHERE id = $1 AND via = 'form'
            AND (email_status IN ('pending', 'failed')
                 OR (email_status = 'sending' AND email_attempt_at < now() - make_interval(secs => $2)))
        RETURNING id`, [messageId, staleSeconds]);
      return rows.length > 0;
    },
    async markEmailAccepted(db, messageId) {
      await db.query("UPDATE support_messages SET email_status = 'accepted', email_accepted_at = now(), email_error = NULL WHERE id = $1", [messageId]);
    },
    async markEmailFailed(db, messageId, error) {
      await db.query("UPDATE support_messages SET email_status = 'failed', email_error = $2 WHERE id = $1", [messageId, String(error).slice(0, 300)]);
    },

    // -------------------------------------------------------------------- inbox
    async inbox(db, { status, limit, offset }) {
      const params = []; const where = ["c.department = 'pharmacy'"];
      if (status !== "all") { params.push(status); where.push(`c.status = $${params.length}`); }
      const filter = where.join(" AND ");
      const total = Number((await db.query(`SELECT count(*) AS n FROM support_conversations c WHERE ${filter}`, params)).rows[0].n);
      params.push(limit, offset);
      const { rows } = await db.query(
        `SELECT c.*, u.full_name AS customer_name, a.full_name AS assigned_name,
                (SELECT count(*) FROM support_messages m WHERE m.conversation_id = c.id AND m.sender_role = 'customer' AND m.seq > c.staff_last_read_seq) AS unread,
                (SELECT m.body FROM support_messages m WHERE m.conversation_id = c.id ORDER BY m.seq DESC LIMIT 1) AS last_body,
                (SELECT m.sender_role FROM support_messages m WHERE m.conversation_id = c.id ORDER BY m.seq DESC LIMIT 1) AS last_sender
           FROM support_conversations c
           JOIN users u ON u.id = c.customer_id
           LEFT JOIN users a ON a.id = c.assigned_to
          WHERE ${filter}
          ORDER BY c.last_message_at DESC, c.id
          LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
      return { rows, total };
    },
    /** Open conversations with something the pharmacists haven't read — for the tab badge. */
    async unreadConversations(db) {
      const { rows } = await db.query(
        `SELECT count(*) AS n FROM support_conversations c
          WHERE c.department = 'pharmacy' AND c.status = 'open'
            AND EXISTS (SELECT 1 FROM support_messages m WHERE m.conversation_id = c.id AND m.sender_role = 'customer' AND m.seq > c.staff_last_read_seq)`);
      return Number(rows[0].n);
    },

    // ----------------------------------------------------------------- presence
    async setPresence(db, userId, ttlSeconds) {
      const { rows } = await db.query(
        `INSERT INTO pharmacist_presence (user_id, available_until) VALUES ($1, now() + make_interval(secs => $2))
         ON CONFLICT (user_id) DO UPDATE SET available_until = EXCLUDED.available_until, updated_at = now()
         RETURNING available_until`, [userId, ttlSeconds]);
      return rows[0].available_until;
    },
    async clearPresence(db, userId) {
      await db.query("DELETE FROM pharmacist_presence WHERE user_id = $1", [userId]);
    },
    async getPresence(db, userId) {
      const { rows } = await db.query("SELECT available_until, available_until > now() AS online FROM pharmacist_presence WHERE user_id = $1", [userId]);
      return rows[0] || null;
    },
    /** Pharmacists whose heartbeat is current, still active, and STILL holding the permission (revoking the role takes them offline at once). */
    async onlinePharmacists(db) {
      const { rows } = await db.query(
        `SELECT u.id, u.full_name FROM pharmacist_presence p JOIN users u ON u.id = p.user_id
          WHERE p.available_until > now() AND u.status = 'active' AND ${HAS_PERMISSION}
          ORDER BY u.full_name`);
      return rows;
    },
    async pharmacistIds(db) {
      const { rows } = await db.query(`SELECT u.id FROM users u WHERE u.status = 'active' AND ${HAS_PERMISSION}`);
      return rows.map((r) => r.id);
    },

    // --------------------------------------------------------------- references
    async orderOf(db, id) { return (await db.query("SELECT id, user_id, number FROM orders WHERE id = $1", [id])).rows[0] || null; },
    async prescriptionOf(db, id) { return (await db.query("SELECT id, user_id FROM prescriptions WHERE id = $1", [id])).rows[0] || null; },
    async productOf(db, id) { return (await db.query("SELECT id, name FROM products WHERE id = $1", [id])).rows[0] || null; },
    async branchContact(db, id) {
      return (await db.query("SELECT id, name, phone, is_demo FROM branches WHERE id = $1 AND is_active", [id])).rows[0] || null;
    },
  };
}
