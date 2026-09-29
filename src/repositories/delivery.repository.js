const ACTIVE = "('assigned','accepted','picked_up')";

/** Riders, deliveries (one active per order — enforced by a partial unique index), location points and run events. */
export function createDeliveryRepository() {
  const lock = (forUpdate) => (forUpdate ? " FOR UPDATE" : "");
  const DELIVERY_VIEW = `
    SELECT d.*, o.number AS order_number, o.status AS order_status, o.branch_id, o.total AS order_total, o.payment_method,
           o.payment_status, o.otp_required, o.eta, o.address AS order_address, u.full_name AS rider_name,
           (SELECT count(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
      FROM deliveries d
      JOIN orders o ON o.id = d.order_id
      JOIN riders r ON r.id = d.rider_id
      JOIN users u ON u.id = r.user_id`;

  return {
    // ---------------------------------------------------------------- riders
    async getRider(db, id, { forUpdate = false } = {}) {
      const { rows } = await db.query(`SELECT r.*, u.full_name FROM riders r JOIN users u ON u.id = r.user_id WHERE r.id = $1${forUpdate ? " FOR UPDATE OF r" : ""}`, [id]);
      return rows[0] || null;
    },
    async getRiderByUser(db, userId, { forUpdate = false } = {}) {
      const { rows } = await db.query(`SELECT r.*, u.full_name FROM riders r JOIN users u ON u.id = r.user_id WHERE r.user_id = $1${forUpdate ? " FOR UPDATE OF r" : ""}`, [userId]);
      return rows[0] || null;
    },
    async insertRider(db, { userId, phone, vehicle, isDemo = false }) {
      const { rows } = await db.query("INSERT INTO riders (user_id, phone, vehicle, is_demo) VALUES ($1,$2,$3,$4) RETURNING id", [userId, phone, vehicle, isDemo]);
      return this.getRider(db, rows[0].id);
    },
    async updateRider(db, id, patch) {
      const map = { phone: "phone", vehicle: "vehicle", status: "status", isAvailable: "is_available" };
      const sets = []; const values = [id];
      for (const [k, col] of Object.entries(map)) if (patch[k] !== undefined) { values.push(patch[k]); sets.push(`${col} = $${values.length}`); }
      if (sets.length) await db.query(`UPDATE riders SET ${sets.join(", ")} WHERE id = $1`, values);
      return this.getRider(db, id);
    },
    async listRiders(db) {
      const { rows } = await db.query(
        `SELECT r.*, u.full_name,
                (SELECT count(*) FROM deliveries d WHERE d.rider_id = r.id AND d.status IN ${ACTIVE}) AS active_count
           FROM riders r JOIN users u ON u.id = r.user_id ORDER BY u.full_name`);
      return rows;
    },
    async countActiveForRider(db, riderId) {
      return Number((await db.query(`SELECT count(*) AS n FROM deliveries WHERE rider_id = $1 AND status IN ${ACTIVE}`, [riderId])).rows[0].n);
    },

    // ------------------------------------------------------------ deliveries
    async insertDelivery(db, { orderId, riderId, status, assignedBy = null, selfClaimed = false, acceptedAt = null }) {
      const { rows } = await db.query(
        "INSERT INTO deliveries (order_id, rider_id, status, assigned_by, self_claimed, accepted_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [orderId, riderId, status, assignedBy, selfClaimed, acceptedAt]);
      return this.getDelivery(db, rows[0].id);
    },
    async getDelivery(db, id, { forUpdate = false } = {}) {
      if (forUpdate) {
        // FOR UPDATE can't be applied through the joins in the view, so lock the bare row first, then read the view.
        await db.query("SELECT id FROM deliveries WHERE id = $1 FOR UPDATE", [id]);
      }
      const { rows } = await db.query(`${DELIVERY_VIEW} WHERE d.id = $1`, [id]);
      return rows[0] || null;
    },
    async activeForOrder(db, orderId) {
      const { rows } = await db.query(`${DELIVERY_VIEW} WHERE d.order_id = $1 AND d.status IN ${ACTIVE}`, [orderId]);
      return rows[0] || null;
    },
    async updateDelivery(db, id, patch) {
      const map = { status: "status", acceptedAt: "accepted_at", pickedUpAt: "picked_up_at", deliveredAt: "delivered_at", closedAt: "closed_at",
        failureReason: "failure_reason", failureNote: "failure_note", cancelReason: "cancel_reason", cashCollected: "cash_collected",
        lastLat: "last_lat", lastLng: "last_lng", lastAccuracy: "last_accuracy", lastLocatedAt: "last_located_at" };
      const sets = []; const values = [id];
      for (const [k, col] of Object.entries(map)) if (patch[k] !== undefined) { values.push(patch[k]); sets.push(`${col} = $${values.length}`); }
      if (sets.length) await db.query(`UPDATE deliveries SET ${sets.join(", ")} WHERE id = $1`, values);
      return this.getDelivery(db, id);
    },
    async countFailedForOrder(db, orderId) {
      return Number((await db.query("SELECT count(*) AS n FROM deliveries WHERE order_id = $1 AND status = 'failed'", [orderId])).rows[0].n);
    },
    async listForRider(db, riderId, { active }) {
      const { rows } = await db.query(
        active ? `${DELIVERY_VIEW} WHERE d.rider_id = $1 AND d.status IN ${ACTIVE} ORDER BY d.created_at`
               : `${DELIVERY_VIEW} WHERE d.rider_id = $1 AND d.status NOT IN ${ACTIVE} ORDER BY d.updated_at DESC LIMIT 50`, [riderId]);
      return rows;
    },
    async listActive(db) {
      return (await db.query(`${DELIVERY_VIEW} WHERE d.status IN ${ACTIVE} ORDER BY d.created_at`)).rows;
    },
    /** Packed orders nobody has picked up yet. */
    async listClaimable(db) {
      const { rows } = await db.query(
        `SELECT o.id, o.number, o.branch_id, o.total, o.payment_method, o.eta, o.address,
                (SELECT count(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
           FROM orders o
          WHERE o.status = 'packed' AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.order_id = o.id AND d.status IN ${ACTIVE})
          ORDER BY o.placed_at`);
      return rows;
    },

    // ---------------------------------------------------------------- location
    async addLocation(db, deliveryId, { lat, lng, accuracy = null }) {
      await db.query("INSERT INTO delivery_locations (delivery_id, lat, lng, accuracy) VALUES ($1,$2,$3,$4)", [deliveryId, lat, lng, accuracy]);
    },
    /** Called when a run ends: the trail and the "last seen" position are deleted, not archived. */
    async purgeLocations(db, deliveryId) {
      await db.query("DELETE FROM delivery_locations WHERE delivery_id = $1", [deliveryId]);
      await db.query("UPDATE deliveries SET last_lat = NULL, last_lng = NULL, last_accuracy = NULL, last_located_at = NULL WHERE id = $1", [deliveryId]);
    },

    // ------------------------------------------------------------------ events
    async addEvent(db, { deliveryId = null, orderId, type, actorId = null, note = null }) {
      await db.query("INSERT INTO delivery_events (delivery_id, order_id, type, actor_id, note) VALUES ($1,$2,$3,$4,$5)", [deliveryId, orderId, type, actorId, note]);
    },
    async eventsForOrder(db, orderId) {
      return (await db.query("SELECT type, note, actor_id, at FROM delivery_events WHERE order_id = $1 ORDER BY at", [orderId])).rows;
    },
  };
}
