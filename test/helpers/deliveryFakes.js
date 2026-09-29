import { createFakeCommerce } from "./commerceFakes.js";

/** Commerce fakes + an in-memory delivery repository that enforces the same rules the SQL does (one active delivery per order). */
export function createFakeDelivery() {
  const base = createFakeCommerce();
  const { db } = base;
  Object.assign(db, { riders: [], deliveries: [], locations: [], events: [], users: new Map(), userRoles: [], payments: [] });
  const ACTIVE = ["assigned", "accepted", "picked_up"];

  const view = (d) => {
    const o = db.orders.find((x) => x.id === d.order_id);
    const r = db.riders.find((x) => x.id === d.rider_id);
    return { ...d, order_number: o.number, order_status: o.status, branch_id: o.branch_id, order_total: o.total, payment_method: o.payment_method,
      payment_status: o.payment_status, otp_required: o.otp_required, eta: o.eta, order_address: o.address, rider_name: r.full_name,
      item_count: (db.orderItems.get(o.id) ?? []).length };
  };
  const withName = (r) => r && { ...r, full_name: db.users.get(r.user_id)?.name ?? "Rider" };

  const delivery = {
    async getRider(_d, id) { return withName(db.riders.find((r) => r.id === id)) ?? null; },
    async getRiderByUser(_d, userId) { return withName(db.riders.find((r) => r.user_id === userId)) ?? null; },
    async insertRider(_d, { userId, phone, vehicle }) {
      const row = { id: `rider-${++db.seq}`, user_id: userId, phone, vehicle, status: "active", is_available: false };
      db.riders.push(row); return withName(row);
    },
    async updateRider(_d, id, patch) {
      const r = db.riders.find((x) => x.id === id);
      for (const [k, col] of Object.entries({ phone: "phone", vehicle: "vehicle", status: "status", isAvailable: "is_available" })) if (patch[k] !== undefined) r[col] = patch[k];
      return withName(r);
    },
    async listRiders() { return db.riders.map((r) => ({ ...withName(r), active_count: db.deliveries.filter((d) => d.rider_id === r.id && ACTIVE.includes(d.status)).length })); },
    async countActiveForRider(_d, riderId) { return db.deliveries.filter((d) => d.rider_id === riderId && ACTIVE.includes(d.status)).length; },

    async insertDelivery(_d, { orderId, riderId, status, assignedBy = null, selfClaimed = false, acceptedAt = null }) {
      if (db.deliveries.some((d) => d.order_id === orderId && ACTIVE.includes(d.status))) throw Object.assign(new Error("duplicate key"), { code: "23505" });
      const row = { id: `del-${++db.seq}`, order_id: orderId, rider_id: riderId, status, assigned_by: assignedBy, self_claimed: selfClaimed, created_at: new Date(),
        accepted_at: acceptedAt, picked_up_at: null, delivered_at: null, closed_at: null, failure_reason: null, failure_note: null, cancel_reason: null, cash_collected: null,
        last_lat: null, last_lng: null, last_accuracy: null, last_located_at: null };
      db.deliveries.push(row); return view(row);
    },
    async getDelivery(_d, id) { const d = db.deliveries.find((x) => x.id === id); return d ? view(d) : null; },
    async activeForOrder(_d, orderId) { const d = db.deliveries.find((x) => x.order_id === orderId && ACTIVE.includes(x.status)); return d ? view(d) : null; },
    async updateDelivery(_d, id, patch) {
      const d = db.deliveries.find((x) => x.id === id);
      const map = { status: "status", acceptedAt: "accepted_at", pickedUpAt: "picked_up_at", deliveredAt: "delivered_at", closedAt: "closed_at", failureReason: "failure_reason", failureNote: "failure_note",
        cancelReason: "cancel_reason", cashCollected: "cash_collected", lastLat: "last_lat", lastLng: "last_lng", lastAccuracy: "last_accuracy", lastLocatedAt: "last_located_at" };
      for (const [k, col] of Object.entries(map)) if (patch[k] !== undefined) d[col] = patch[k];
      return view(d);
    },
    async countFailedForOrder(_d, orderId) { return db.deliveries.filter((d) => d.order_id === orderId && d.status === "failed").length; },
    async listForRider(_d, riderId, { active }) { return db.deliveries.filter((d) => d.rider_id === riderId && ACTIVE.includes(d.status) === active).map(view); },
    async listActive() { return db.deliveries.filter((d) => ACTIVE.includes(d.status)).map(view); },
    async listClaimable() {
      return db.orders.filter((o) => o.status === "packed" && !db.deliveries.some((d) => d.order_id === o.id && ACTIVE.includes(d.status)))
        .map((o) => ({ ...o, item_count: (db.orderItems.get(o.id) ?? []).length }));
    },
    async addLocation(_d, deliveryId, p) { db.locations.push({ delivery_id: deliveryId, ...p }); },
    async purgeLocations(_d, deliveryId) {
      db.locations = db.locations.filter((l) => l.delivery_id !== deliveryId);
      Object.assign(db.deliveries.find((d) => d.id === deliveryId), { last_lat: null, last_lng: null, last_accuracy: null, last_located_at: null });
    },
    async addEvent(_d, e) { db.events.push({ delivery_id: e.deliveryId ?? null, order_id: e.orderId, type: e.type, actor_id: e.actorId ?? null, note: e.note ?? null, at: new Date() }); },
    async eventsForOrder(_d, orderId) { return db.events.filter((e) => e.order_id === orderId); },
  };

  const users = { async lockById(_d, id) { const u = db.users.get(id); return u ? { id, status: u.status } : null; } };
  const roles = { async addUserRole(_d, userId, role) { db.userRoles.push({ userId, role }); } };
  // Payments are their own service (payments.test.js); here we only need to observe what delivery asks of it.
  const payments = {
    async createForOrder() {},
    async markCodCollected(_d, orderId) { db.payments.push({ orderId, action: "cod_collected" }); },
    async markCodNotCollected(_d, orderId) { db.payments.push({ orderId, action: "cod_not_collected" }); },
  };
  return { ...base, payments, repos: { ...base.repos, delivery, users, roles } };
}

/** Actors */
export const dispatcher = { id: "u-dispatch", name: "Dispatch", roles: ["warehouse"], permissions: ["delivery:manage", "orders:read_all", "orders:update_status", "roles:assign"] };
export const dispatcherNoRoles = { id: "u-dispatch2", name: "Dispatch (no roles:assign)", roles: ["warehouse"], permissions: ["delivery:manage", "orders:read_all"] };
export const riderActor = (id) => ({ id, name: `Rider ${id}`, roles: ["delivery"], permissions: ["delivery:rider"] });
