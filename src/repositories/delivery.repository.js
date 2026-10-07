const ACTIVE = "('assigned','accepted','picked_up')";

/** Riders, deliveries (one active per order — enforced by a partial unique index), location points and run events. */
export function createDeliveryRepository() {
  const RIDER_SELECT = `
    SELECT r.*, u.full_name, u.status AS user_status,
           COALESCE((SELECT array_agg(ur.role_key) FROM user_roles ur WHERE ur.user_id = u.id), '{}') AS roles,
           COALESCE((SELECT array_agg(DISTINCT rp.permission_key) FROM user_roles ur JOIN role_permissions rp ON rp.role_key = ur.role_key WHERE ur.user_id = u.id), '{}') AS permissions,
           (SELECT count(*) FROM deliveries d WHERE d.rider_id = r.id AND d.status IN ${ACTIVE}) AS active_count
      FROM riders r JOIN users u ON u.id = r.user_id`;
  const DELIVERY_VIEW = `
    SELECT d.*, o.number AS order_number, o.status AS order_status, o.branch_id, o.total AS order_total, o.payment_method,
           o.payment_status, o.otp_required, o.eta, o.address AS order_address, b.lat AS branch_lat, b.lng AS branch_lng, u.full_name AS rider_name, r.phone AS rider_phone, r.vehicle AS rider_vehicle, r.photo_url AS rider_photo,
           (SELECT count(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
      FROM deliveries d
      JOIN orders o ON o.id = d.order_id
      LEFT JOIN branches b ON b.id = o.branch_id
      JOIN riders r ON r.id = d.rider_id
      JOIN users u ON u.id = r.user_id`;

  return {
    // ---------------------------------------------------------------- riders
    /**
     * A rider row plus everything the eligibility check needs about the OWNING USER — status, roles, expanded permissions —
     * and the live delivery count, all in ONE statement. One read means the verdict is consistent with itself, and with
     * `forUpdate` it is consistent with the row lock too. `FOR UPDATE OF r` locks only the riders row (never users).
     */
    async getRider(db, id, { forUpdate = false } = {}) {
      const { rows } = await db.query(`${RIDER_SELECT} WHERE r.id = $1${forUpdate ? " FOR UPDATE OF r" : ""}`, [id]);
      return rows[0] || null;
    },
    async getRiderByUser(db, userId, { forUpdate = false } = {}) {
      const { rows } = await db.query(`${RIDER_SELECT} WHERE r.user_id = $1${forUpdate ? " FOR UPDATE OF r" : ""}`, [userId]);
      return rows[0] || null;
    },
    async insertRider(db, { userId, phone, vehicle, isDemo = false }) {
      const { rows } = await db.query("INSERT INTO riders (user_id, phone, vehicle, is_demo) VALUES ($1,$2,$3,$4) RETURNING id", [userId, phone, vehicle, isDemo]);
      return this.getRider(db, rows[0].id);
    },
    async updateRider(db, id, patch) {
      const map = { phone: "phone", vehicle: "vehicle", status: "status", isAvailable: "is_available", photoUrl: "photo_url" };
      const sets = []; const values = [id];
      for (const [k, col] of Object.entries(map)) if (patch[k] !== undefined) { values.push(patch[k]); sets.push(`${col} = $${values.length}`); }
      if (sets.length) await db.query(`UPDATE riders SET ${sets.join(", ")} WHERE id = $1`, values);
      return this.getRider(db, id);
    },
    async listRiders(db) {
      const { rows } = await db.query(`${RIDER_SELECT} ORDER BY u.full_name, r.id`);
      return rows;
    },
    async countActiveForRider(db, riderId) {
      return Number((await db.query(`SELECT count(*) AS n FROM deliveries WHERE rider_id = $1 AND status IN ${ACTIVE}`, [riderId])).rows[0].n);
    },
    /**
     * Called (inside the admin's transaction) when a user is suspended / deactivated or loses the delivery role: the rider
     * is taken off duty so they stop appearing as someone who can take work. Access itself is already gone — it is decided
     * from the user's role/permissions/status on every request — this just keeps the profile honest.
     */
    async setUnavailableForUser(db, userId) {
      const { rowCount } = await db.query("UPDATE riders SET is_available = false WHERE user_id = $1 AND is_available", [userId]);
      return rowCount;
    },

    // ------------------------------------------------------------ deliveries
    async insertDelivery(db, { orderId, riderId, status, assignedBy = null, selfClaimed = false, acceptedAt = null, pickup = null, customer = null, estimatedArrival = null, etaSource = null }) {
      const { rows } = await db.query(
        `INSERT INTO deliveries (order_id, rider_id, status, assigned_by, self_claimed, accepted_at, pickup_lat, pickup_lng, customer_lat, customer_lng, estimated_arrival, eta_updated_at, eta_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $11::timestamptz IS NULL THEN NULL ELSE now() END, $12) RETURNING id`,
        [orderId, riderId, status, assignedBy, selfClaimed, acceptedAt, pickup?.lat ?? null, pickup?.lng ?? null, customer?.lat ?? null, customer?.lng ?? null, estimatedArrival, etaSource]);
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
    /** Unlocked, minimal read used ONLY to learn which order a delivery belongs to, so the ORDER can be locked first. */
    async getDeliveryRef(db, id) {
      const { rows } = await db.query("SELECT id, order_id, rider_id FROM deliveries WHERE id = $1", [id]);
      return rows[0] || null;
    },
    async activeForOrder(db, orderId) {
      const { rows } = await db.query(`${DELIVERY_VIEW} WHERE d.order_id = $1 AND d.status IN ${ACTIVE}`, [orderId]);
      return rows[0] || null;
    },
    async updateDelivery(db, id, patch) {
      const map = { status: "status", acceptedAt: "accepted_at", pickedUpAt: "picked_up_at", deliveredAt: "delivered_at", closedAt: "closed_at",
        failureReason: "failure_reason", failureNote: "failure_note", cancelReason: "cancel_reason", cashCollected: "cash_collected",
        lastLat: "last_lat", lastLng: "last_lng", lastAccuracy: "last_accuracy", lastLocatedAt: "last_located_at",
        arrivedPickupAt: "arrived_pickup_at", startedAt: "started_at", estimatedArrival: "estimated_arrival", etaUpdatedAt: "eta_updated_at", etaSource: "eta_source" };
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
          WHERE o.status = 'packed' AND (o.payment_method = 'cod' OR o.payment_status = 'paid') AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.order_id = o.id AND d.status IN ${ACTIVE})
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
      await db.query("UPDATE deliveries SET last_lat = NULL, last_lng = NULL, last_accuracy = NULL, last_located_at = NULL, customer_lat = NULL, customer_lng = NULL WHERE id = $1", [deliveryId]);
    },

    // ------------------------------------------------------------ dispatch helpers
    /** Riders who are on duty and could take work — the people a shop's "request delivery" nudges. */
    async availableRiderUserIds(db) {
      const { rows } = await db.query(`${RIDER_SELECT} WHERE r.is_available AND r.status = 'active' AND u.status = 'active'`);
      return rows.filter((r) => Number(r.active_count) < 5).map((r) => r.user_id);
    },
    async lastEventAt(db, orderId, type) {
      return (await db.query("SELECT max(at) AS at FROM delivery_events WHERE order_id = $1 AND type = $2", [orderId, type])).rows[0]?.at ?? null;
    },
    async setBranchLocation(db, branchId, { lat, lng }) {
      const { rows } = await db.query("UPDATE branches SET lat = $2, lng = $3 WHERE id = $1 RETURNING id, name, lat, lng", [branchId, lat, lng]);
      return rows[0] || null;
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
