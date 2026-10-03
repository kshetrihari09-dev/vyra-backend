import { DELIVERY_RULES, FAILURE_REASONS } from "../config/delivery.js";
import { toClaimableDto, toDeliveryDto, toEventDto, toRiderDto } from "../models/delivery.model.js";
import { assertPaymentCleared, assertTransition } from "../domain/orderRules.js";
import { AppError, badRequest, conflict, forbidden, notFound } from "../utils/errors.js";
import { createRiderAccess } from "./riderAccess.service.js";

const can = (actor, perm) => !!actor?.permissions?.includes(perm);
const cents = (n) => Math.round(Number(n) * 100);
const partnerOf = (rider) => ({ name: rider.full_name, phone: rider.phone, vehicle: rider.vehicle });
/** Event types a customer may see on their own order's timeline (never notes, never OTP/staff housekeeping). */
const CUSTOMER_EVENTS = ["assigned", "claimed", "picked_up", "delivered", "failed"];
const BEFORE_PICKUP = ["assigned", "accepted"];

/**
 * PostgreSQL concurrency errors, translated. Raw driver errors never reach the client (the global handler would turn an
 * unknown one into a generic 500); these are expected under load and have a clear, actionable meaning.
 *   40P01 deadlock_detected · 40001 serialization_failure · 55P03 lock_not_available → "try again"
 *   23505 unique_violation → the one-active-delivery-per-order index (or a double-created rider profile)
 */
function friendlyDbError(err) {
  if (err instanceof AppError) return err;
  if (["40P01", "40001", "55P03"].includes(err?.code)) return conflict("DELIVERY_BUSY", "That delivery is being updated by someone else. Please try again.");
  if (err?.code === "23505") {
    if (err.constraint === "riders_user_id_key") return conflict("RIDER_EXISTS", "That user is already a rider");
    return conflict("ALREADY_ASSIGNED", "Order is already assigned to another rider.");
  }
  return err;
}

/**
 * Delivery module. Owns everything from "packed" onwards:
 *   packed ──assign/claim──▶ assigned ──pickup──▶ out_for_delivery ──deliver(code)──▶ delivered
 *                              ▲   │decline/unassign        │fail
 *                              └───┴──── back to packed ◀───┘ (until maxAttemptsPerOrder, then → returned)
 *
 * LOCK ORDER — every transaction that touches more than one of these takes them in THIS order, and only the ones it needs:
 *
 *      user  →  order  →  rider  →  delivery  →  (payment)
 *
 *   claim ............ order → rider → delivery(new)      assign / reassign ... order → rider(new) → delivery
 *   unassign ......... order → delivery                   decline/pickup/deliver/fail ... order → delivery
 *   accept / location  delivery only                      setAvailability / updateRider .. rider only
 *   createRider ...... user → rider(new)                  resetOtp ........... order only
 *
 * Because every path is a subsequence of that one order, no two transactions can each hold something the other wants:
 * deadlock is impossible by construction rather than merely unlikely. Operations that are handed only a delivery id first
 * read its order id WITHOUT a lock (`getDeliveryRef`), lock the order, and only then lock the delivery row and re-check.
 * The partial unique index `deliveries_one_active_per_order` stays as the database-level backstop.
 *
 * Rider authorisation is NOT decided here: it is `riderAccess` (domain/riderEligibility.js), called on every path.
 */
export function createDeliveryService({ pool, withTx, repos, audit, payments, codes, notifications = { emit: async () => null }, clock = () => new Date(), riderAccess = createRiderAccess({ repos }) }) {
  const { delivery: repo, orders, roles, users } = repos;

  /** `withTx` with PostgreSQL concurrency errors mapped to safe, specific conflicts. */
  const tx = async (fn) => {
    try { return await withTx(fn); } catch (err) { throw friendlyDbError(err); }
  };

  async function lockOrder(db, orderId) {
    const order = await orders.getById(db, orderId, { forUpdate: true });
    if (!order) throw notFound("ORDER_NOT_FOUND", "Order not found");
    return order;
  }

  /**
   * A rider's access to ONE of their deliveries. The rider is validated first (central check, read-only: acting on an
   * existing delivery makes no capacity decision, so the rider row is not locked), then locks are taken in global order:
   * the order (only when the operation changes it) and the delivery. A delivery that isn't theirs is simply "not found".
   */
  async function lockOwnDelivery(db, actor, id, { withOrder = false } = {}) {
    const rider = await riderAccess.requireSelf(db, actor);
    const ref = await repo.getDeliveryRef(db, id);
    if (!ref || ref.rider_id !== rider.id) throw notFound("DELIVERY_NOT_FOUND", "Delivery not found");
    const order = withOrder ? await lockOrder(db, ref.order_id) : null;      // 1. order
    const d = await repo.getDelivery(db, id, { forUpdate: true });            // 3. delivery
    if (!d || d.rider_id !== rider.id) throw notFound("DELIVERY_NOT_FOUND", "Delivery not found");
    return { rider, order, d };
  }

  /** Every status change from "packed" on goes through here, and through the one transition table (domain/orderRules.js):
   *  `order` is the row the caller just locked, so the move is checked against its real current status. */
  const moveOrder = async (db, order, status, { note = null, patch } = {}) => {
    assertTransition(order.status, status);
    const updated = await orders.updateStatus(db, order.id, status, patch);
    await orders.addHistory(db, order.id, status, note);
    return updated;
  };

  /** Why an order can't be taken right now, in words a rider or dispatcher can act on. The order row is locked by the caller. */
  async function whyNotDispatchable(db, order, riderId = null) {
    if (["assigned", "out_for_delivery"].includes(order.status)) {
      const active = await repo.activeForOrder(db, order.id);
      if (active && riderId && active.rider_id === riderId) return "You already have this delivery.";
      return "Order is already assigned to another rider.";
    }
    return "Delivery is no longer available.";
  }

  /** Shared by assign / claim / reassign: capacity check (the rider row is already locked and validated), then the one-active-per-order insert. */
  async function openAssignment(db, { actor, order, rider, selfClaimed = false }) {
    if (await repo.countActiveForRider(db, rider.id) >= DELIVERY_RULES.maxActivePerRider) {
      throw conflict("RIDER_BUSY", `${selfClaimed ? "You have" : "Rider has"} reached the delivery limit (${DELIVERY_RULES.maxActivePerRider} active deliveries).`);
    }
    try {
      return await repo.insertDelivery(db, {
        orderId: order.id, riderId: rider.id, status: selfClaimed ? "accepted" : "assigned",
        assignedBy: selfClaimed ? null : actor.id, selfClaimed, acceptedAt: selfClaimed ? clock() : null,
      });
    } catch (err) {
      if (err.code === "23505") throw conflict("ALREADY_ASSIGNED", "Order is already assigned to another rider."); // the partial unique index is the backstop
      throw err;
    }
  }

  /** Tell the customer (and, for dispatch assignments, the rider) — inside the same transaction as the change. */
  const tell = (db, order, type, data = {}) => notifications.emit(db, { userId: order.user_id, type, data: { orderId: order.id, number: order.number, ...data } });

  const dto = async (db, id, opts) => toDeliveryDto(await repo.getDelivery(db, id), opts);

  return {
    // =============================================================== rider: profile & queue
    async me(actor) {
      return toRiderDto(await riderAccess.requireSelf(pool, actor));
    },

    async setAvailability(actor, isAvailable) {
      return tx(async (db) => {
        const rider = await riderAccess.requireSelf(db, actor, { lock: true }); // rider only
        return toRiderDto(await repo.updateRider(db, rider.id, { isAvailable }));
      });
    },

    async listMine(actor, { scope = "active" } = {}) {
      const rider = await riderAccess.requireSelf(pool, actor);
      const rows = await repo.listForRider(pool, rider.id, { active: scope !== "history" });
      return rows.map((r) => toDeliveryDto(r));
    },

    /** Packed, unassigned orders a rider could take — area only, no street/name/phone until it's theirs. */
    async listClaimable(actor) {
      const rider = await riderAccess.requireSelf(pool, actor);
      if (!rider.is_available) return [];
      return (await repo.listClaimable(pool)).map(toClaimableDto);
    },

    // =============================================================== rider: taking & doing a delivery
    async claim(actor, orderId, ctx) {
      return tx(async (db) => {
        await riderAccess.requireSelf(db, actor);                                     // refuse an invalid rider BEFORE any lock or lookup (no order-id probing)
        const order = await lockOrder(db, orderId);                                   // 1. order
        const rider = await riderAccess.requireSelf(db, actor, { lock: true });       // 2. rider (re-validated under its lock: authoritative)
        if (!rider.is_available) throw conflict("RIDER_UNAVAILABLE", "Switch to available to take deliveries");
        // Two riders racing for one order are serialised by the order lock above: the loser wakes up here, sees the winner's
        // committed state, and gets a clear conflict. The partial unique index is the second line of defence.
        if (order.status !== "packed") throw conflict("NOT_DISPATCHABLE", await whyNotDispatchable(db, order, rider.id));
        assertPaymentCleared(order);
        if (await repo.activeForOrder(db, orderId)) throw conflict("ALREADY_ASSIGNED", "Order is already assigned to another rider.");
        const d = await openAssignment(db, { actor, order, rider, selfClaimed: true }); // 3. delivery (new row)
        await moveOrder(db, order, "assigned", { patch: { partner: partnerOf(rider) } });
        await repo.addEvent(db, { deliveryId: d.id, orderId, type: "claimed", actorId: actor.id });
        await tell(db, order, "delivery.assigned", { riderName: rider.full_name });
        await audit.log({ actor, action: "delivery.claimed", entityType: "delivery", entityId: d.id, newValue: { orderId, riderId: rider.id } }, ctx, db);
        return dto(db, d.id);
      });
    },

    async accept(actor, id, ctx) {
      return tx(async (db) => {
        const { d } = await lockOwnDelivery(db, actor, id);                           // delivery only
        if (d.status !== "assigned") throw conflict("NOT_OFFERED", `This delivery is "${d.status}" — there's nothing to accept.`);
        await repo.updateDelivery(db, d.id, { status: "accepted", acceptedAt: clock() });
        await repo.addEvent(db, { deliveryId: d.id, orderId: d.order_id, type: "accepted", actorId: actor.id });
        return dto(db, d.id);
      });
    },

    /** Give the order back before picking it up. It returns to "packed" for someone else. */
    async decline(actor, id, body, ctx) {
      return tx(async (db) => {
        const { d, order } = await lockOwnDelivery(db, actor, id, { withOrder: true }); // order → delivery
        if (!BEFORE_PICKUP.includes(d.status)) throw conflict("CANNOT_DECLINE", "Once the order is picked up, use \"couldn't deliver\" instead.");
        await repo.updateDelivery(db, d.id, { status: "cancelled", cancelReason: `declined${body?.reason ? `: ${body.reason}` : ""}`, closedAt: clock() });
        await moveOrder(db, order, "packed", { note: "Rider declined — back to dispatch", patch: { partner: null } });
        await repo.addEvent(db, { deliveryId: d.id, orderId: order.id, type: "declined", actorId: actor.id, note: body?.reason ?? null });
        await audit.log({ actor, action: "delivery.declined", entityType: "delivery", entityId: d.id, newValue: { orderId: order.id, reason: body?.reason ?? null } }, ctx, db);
        return dto(db, d.id);
      });
    },

    async pickup(actor, id, ctx) {
      return tx(async (db) => {
        const { d, order } = await lockOwnDelivery(db, actor, id, { withOrder: true }); // order → delivery
        if (d.status !== "accepted") throw conflict("NOT_ACCEPTED", d.status === "assigned" ? "Accept the delivery before picking it up." : `This delivery is "${d.status}".`);
        if (order.status !== "assigned") throw conflict("ORDER_STATE", `Order is "${order.status}", not ready for pickup.`);
        assertPaymentCleared(order);
        await repo.updateDelivery(db, d.id, { status: "picked_up", pickedUpAt: clock() });
        await moveOrder(db, order, "out_for_delivery");
        await repo.addEvent(db, { deliveryId: d.id, orderId: order.id, type: "picked_up", actorId: actor.id });
        await tell(db, order, "delivery.out_for_delivery"); // never carries the handover code — see notifications/templates.js
        await audit.log({ actor, action: "delivery.picked_up", entityType: "delivery", entityId: d.id, newValue: { orderId: order.id } }, ctx, db);
        return dto(db, d.id);
      });
    },

    /** Only while out for delivery, and pings faster than the interval are dropped rather than stored. */
    async updateLocation(actor, id, point) {
      return tx(async (db) => {
        // Delivery lock only: it serialises with deliver/fail (which hold order → delivery) so a late ping can't outlive the purge.
        const { d } = await lockOwnDelivery(db, actor, id);
        if (d.status !== "picked_up") throw conflict("NOT_TRACKING", "Location is only shared while you're out for delivery.");
        const now = clock();
        if (d.last_located_at && now - new Date(d.last_located_at) < DELIVERY_RULES.locationMinIntervalMs) return { accepted: false };
        await repo.addLocation(db, d.id, point);
        await repo.updateDelivery(db, d.id, { lastLat: point.lat, lastLng: point.lng, lastAccuracy: point.accuracy ?? null, lastLocatedAt: now });
        return { accepted: true };
      });
    },

    /**
     * Completes the run. The customer's code is checked here, on the server; the rider never receives it. A wrong
     * code must be COUNTED even though the request fails, so the transaction commits the counter and hands the
     * error back to be thrown afterwards (throwing inside would roll the counter back — an unlimited-guess bug).
     */
    async deliver(actor, id, body, ctx) {
      const outcome = await tx(async (db) => {
        const { d, order } = await lockOwnDelivery(db, actor, id, { withOrder: true }); // order → delivery
        if (d.status !== "picked_up") throw conflict("NOT_OUT_FOR_DELIVERY", d.status === "delivered" ? "This delivery is already complete." : "Pick the order up before completing it.");
        if (order.status !== "out_for_delivery") throw conflict("ORDER_STATE", `Order is "${order.status}".`);
        assertPaymentCleared(order); // defence in depth: a prepaid order that somehow lost its "paid" state can't be handed over

        if (order.otp_required) {
          const max = DELIVERY_RULES.otpMaxAttempts;
          if (order.otp_attempts >= max) throw conflict("OTP_LOCKED", "Too many wrong codes. Ask dispatch to reset this order's code.");
          if (!body.otp) throw badRequest("OTP_REQUIRED", "Ask the customer for their 4-digit code.", [{ path: "body.otp", message: "Enter the customer's 4-digit code" }]);
          if (!codes.matches(order.id, order.otp_nonce, body.otp)) {
            const attempts = order.otp_attempts + 1;
            await orders.updateStatus(db, order.id, order.status, { otpAttempts: attempts });
            await repo.addEvent(db, { deliveryId: d.id, orderId: order.id, type: "otp_failed", actorId: actor.id, note: `attempt ${attempts}/${max}` });
            if (attempts >= max) {
              await repo.addEvent(db, { deliveryId: d.id, orderId: order.id, type: "otp_locked", actorId: actor.id });
              await audit.log({ actor, action: "delivery.otp_locked", entityType: "order", entityId: order.id, newValue: { attempts } }, ctx, db);
            }
            const message = attempts >= max ? "Too many wrong codes — this delivery is locked. Contact dispatch." : `That code doesn't match. ${max - attempts} attempt${max - attempts === 1 ? "" : "s"} left.`;
            return { error: badRequest("OTP_MISMATCH", message, [{ path: "body.otp", message }]) };
          }
        }

        const cod = order.payment_method === "cod" && order.payment_status !== "paid";
        if (cod && (body.cashCollected == null || cents(body.cashCollected) !== cents(order.total))) {
          throw badRequest("CASH_MISMATCH", `Collect exactly Rs. ${Number(order.total).toFixed(2)} in cash before completing.`, [{ path: "body.cashCollected", message: "Cash collected must equal the order total" }]);
        }

        const now = clock();
        await repo.updateDelivery(db, d.id, { status: "delivered", deliveredAt: now, closedAt: now, ...(cod ? { cashCollected: order.total } : {}) });
        await repo.purgeLocations(db, d.id);
        await moveOrder(db, order, "delivered", { patch: { deliveredAt: now, paymentStatus: cod ? "paid" : order.payment_status } });
        if (cod) await payments.markCodCollected(db, order.id);
        await repo.addEvent(db, { deliveryId: d.id, orderId: order.id, type: "delivered", actorId: actor.id });
        await tell(db, order, "delivery.delivered");
        await audit.log({ actor, action: "delivery.completed", entityType: "delivery", entityId: d.id, newValue: { orderId: order.id, cash: cod ? Number(order.total) : 0 } }, ctx, db);
        return { value: await dto(db, d.id) };
      });
      if (outcome.error) throw outcome.error;
      return outcome.value;
    },

    /**
     * "Couldn't deliver". Under the attempt limit the order goes back to "packed" for re-dispatch; at the limit it is
     * closed as "returned". Stock is NOT put back automatically (a pharmacist should inspect returned medicine —
     * use an inventory adjustment), and a prepaid order needs its refund requested through the payments flow.
     */
    async fail(actor, id, body, ctx) {
      return tx(async (db) => {
        const { d, order } = await lockOwnDelivery(db, actor, id, { withOrder: true }); // order → delivery
        if (d.status !== "picked_up") throw conflict("NOT_OUT_FOR_DELIVERY", "Only an order that's out for delivery can be reported as undeliverable.");
        const now = clock();
        await repo.updateDelivery(db, d.id, { status: "failed", failureReason: body.reason, failureNote: body.note ?? null, closedAt: now });
        await repo.purgeLocations(db, d.id);
        const attempts = await repo.countFailedForOrder(db, order.id);
        const label = FAILURE_REASONS[body.reason];
        let orderOutcome;
        if (attempts < DELIVERY_RULES.maxAttemptsPerOrder) {
          orderOutcome = "redispatch";
          await moveOrder(db, order, "packed", { note: `Delivery attempt ${attempts} failed: ${label}`, patch: { partner: null } });
        } else {
          orderOutcome = "returned";
          const cod = order.payment_method === "cod";
          await moveOrder(db, order, "returned", { note: `Delivery failed ${attempts} times (${label}) — returned to store`, patch: { returnedAt: now, ...(cod ? { paymentStatus: "not_collected" } : {}) } });
          if (cod) await payments.markCodNotCollected(db, order.id);
        }
        await repo.addEvent(db, { deliveryId: d.id, orderId: order.id, type: "failed", actorId: actor.id, note: [label, body.note].filter(Boolean).join(" — ") });
        await tell(db, order, orderOutcome === "returned" ? "delivery.returned" : "delivery.retry", { reason: label.toLowerCase() });
        await audit.log({ actor, action: "delivery.failed", entityType: "delivery", entityId: d.id, newValue: { orderId: order.id, reason: body.reason, attempts, orderOutcome } }, ctx, db);
        return { ...(await dto(db, d.id)), orderOutcome };
      });
    },

    // =============================================================== dispatch (delivery:manage)
    async assign(actor, orderId, body, ctx) {
      if (!can(actor, "delivery:manage")) throw forbidden();
      return tx(async (db) => {
        const order = await lockOrder(db, orderId);                                   // 1. order
        if (order.status !== "packed") throw conflict("NOT_DISPATCHABLE", `Order is "${order.status}" — only packed orders can be assigned.`);
        assertPaymentCleared(order);
        if (await repo.activeForOrder(db, orderId)) throw conflict("ALREADY_ASSIGNED", "This order already has a rider.");
        const rider = await riderAccess.requireAssignable(db, body.riderId, { lock: true }); // 2. rider: active user + role + permission + active profile
        const d = await openAssignment(db, { actor, order, rider });                  // 3. delivery (new row)
        await moveOrder(db, order, "assigned", { patch: { partner: partnerOf(rider) } });
        await repo.addEvent(db, { deliveryId: d.id, orderId, type: "assigned", actorId: actor.id, note: rider.full_name });
        await tell(db, order, "delivery.assigned", { riderName: rider.full_name });
        await notifications.emit(db, { userId: rider.user_id, type: "rider.assigned", data: { orderId, number: order.number } });
        await audit.log({ actor, action: "delivery.assigned", entityType: "delivery", entityId: d.id, newValue: { orderId, riderId: rider.id } }, ctx, db);
        return dto(db, d.id);
      });
    },

    /**
     * Take the order off its rider and put it back in the packed queue. Normally only before pickup. The one exception:
     * if the rider can no longer operate (account suspended, role or permission removed, profile deactivated) the parcel
     * would otherwise be stranded — nobody could complete or fail it — so dispatch may recover it even after pickup.
     */
    async unassign(actor, deliveryId, body, ctx) {
      if (!can(actor, "delivery:manage")) throw forbidden();
      return tx(async (db) => {
        const ref = await repo.getDeliveryRef(db, deliveryId);
        if (!ref) throw notFound("DELIVERY_NOT_FOUND", "Delivery not found");
        const order = await lockOrder(db, ref.order_id);                              // 1. order
        const d = await repo.getDelivery(db, deliveryId, { forUpdate: true });        // 3. delivery
        if (!d) throw notFound("DELIVERY_NOT_FOUND", "Delivery not found");
        let recovering = false;
        if (d.status === "picked_up") {
          const riderRow = await repo.getRider(db, d.rider_id);
          if (riderRow && riderAccess.verdictFor(riderRow).ok) throw conflict("CANNOT_UNASSIGN", "The rider already has the order — they must complete it or report it undeliverable.");
          recovering = true;
        } else if (!BEFORE_PICKUP.includes(d.status)) {
          throw conflict("CANNOT_UNASSIGN", `This delivery is "${d.status}".`);
        }
        const why = body?.reason ? `: ${body.reason}` : "";
        await repo.updateDelivery(db, d.id, { status: "cancelled", cancelReason: recovering ? `unassigned (rider no longer authorized)${why}` : `unassigned${why}`, closedAt: clock() });
        if (recovering) await repo.purgeLocations(db, d.id);
        await moveOrder(db, order, "packed", { note: recovering ? "Rider no longer authorized — recovered by dispatch" : "Rider unassigned", patch: { partner: null } });
        await repo.addEvent(db, { deliveryId: d.id, orderId: order.id, type: "unassigned", actorId: actor.id, note: body?.reason ?? null });
        await audit.log({ actor, action: "delivery.unassigned", entityType: "delivery", entityId: d.id, newValue: { orderId: order.id, reason: body?.reason ?? null, recovered: recovering } }, ctx, db);
        return dto(db, d.id);
      });
    },

    async reassign(actor, deliveryId, body, ctx) {
      if (!can(actor, "delivery:manage")) throw forbidden();
      return tx(async (db) => {
        const ref = await repo.getDeliveryRef(db, deliveryId);
        if (!ref) throw notFound("DELIVERY_NOT_FOUND", "Delivery not found");
        const order = await lockOrder(db, ref.order_id);                              // 1. order
        const rider = await riderAccess.requireAssignable(db, body.riderId, { lock: true }); // 2. the NEW rider (the old one is only read)
        const old = await repo.getDelivery(db, deliveryId, { forUpdate: true });      // 3. delivery
        if (!old) throw notFound("DELIVERY_NOT_FOUND", "Delivery not found");
        if (!BEFORE_PICKUP.includes(old.status)) throw conflict("CANNOT_REASSIGN", old.status === "picked_up" ? "The rider already has the order." : `This delivery is "${old.status}".`);
        if (old.rider_id === body.riderId) throw badRequest("SAME_RIDER", "That rider already has this delivery.");
        await repo.updateDelivery(db, old.id, { status: "cancelled", cancelReason: "reassigned", closedAt: clock() });
        const d = await openAssignment(db, { actor, order, rider });
        await orders.updateStatus(db, order.id, order.status, { partner: partnerOf(rider) });
        await orders.addHistory(db, order.id, "assigned", `Reassigned to ${rider.full_name}`);
        await repo.addEvent(db, { deliveryId: d.id, orderId: order.id, type: "assigned", actorId: actor.id, note: `reassigned from ${old.rider_name} to ${rider.full_name}` });
        await tell(db, order, "delivery.assigned", { riderName: rider.full_name });
        await notifications.emit(db, { userId: rider.user_id, type: "rider.assigned", data: { orderId: order.id, number: order.number } });
        await audit.log({ actor, action: "delivery.reassigned", entityType: "delivery", entityId: d.id, oldValue: { riderId: old.rider_id }, newValue: { riderId: rider.id, orderId: order.id } }, ctx, db);
        return dto(db, d.id);
      });
    },

    /** Unlocks the handover after too many wrong codes: fresh nonce (so a NEW code) and a zeroed counter. */
    async resetOtp(actor, orderId, ctx) {
      if (!can(actor, "delivery:manage")) throw forbidden();
      return tx(async (db) => {
        const order = await lockOrder(db, orderId);                                   // order only
        if (!order.otp_required) throw conflict("NO_OTP", "This order doesn't use a handover code.");
        if (["delivered", "cancelled", "returned"].includes(order.status)) throw conflict("ALREADY_FINAL", "This order is already closed.");
        await orders.updateStatus(db, order.id, order.status, { otpNonce: codes.newNonce(), otpAttempts: 0 });
        const active = await repo.activeForOrder(db, order.id);
        await repo.addEvent(db, { deliveryId: active?.id ?? null, orderId, type: "otp_reset", actorId: actor.id });
        await audit.log({ actor, action: "delivery.otp_reset", entityType: "order", entityId: orderId }, ctx, db);
        return { ok: true };
      });
    },

    async listRiders(actor) {
      if (!can(actor, "delivery:manage")) throw forbidden();
      return (await repo.listRiders(pool)).map(toRiderDto);
    },

    async listActive(actor) {
      if (!can(actor, "delivery:manage")) throw forbidden();
      return (await repo.listActive(pool)).map((r) => toDeliveryDto(r));
    },

    /** Riders are ordinary user accounts + the `delivery` role + a profile row. Needs BOTH delivery:manage and roles:assign. */
    async createRider(actor, body, ctx) {
      if (!can(actor, "delivery:manage") || !can(actor, "roles:assign")) throw forbidden();
      return tx(async (db) => {
        const user = await users.lockById(db, body.userId);                           // user (first in the global order)
        if (!user) throw notFound("USER_NOT_FOUND", "User not found");
        if (user.status !== "active") throw conflict("USER_INACTIVE", "That account is not active");
        if (await repo.getRiderByUser(db, user.id)) throw conflict("RIDER_EXISTS", "That user is already a rider");
        await roles.addUserRole(db, user.id, "delivery", actor.id);
        const rider = await repo.insertRider(db, { userId: user.id, phone: body.phone, vehicle: body.vehicle });
        await audit.log({ actor, action: "rider.created", entityType: "rider", entityId: rider.id, newValue: { userId: user.id, vehicle: body.vehicle } }, ctx, db);
        return toRiderDto(rider);
      });
    },

    async updateRider(actor, id, body, ctx) {
      if (!can(actor, "delivery:manage")) throw forbidden();
      return tx(async (db) => {
        const rider = await repo.getRider(db, id, { forUpdate: true });               // rider only
        if (!rider) throw notFound("RIDER_NOT_FOUND", "Rider not found");
        const patch = { ...body };
        if (body.status === "suspended") {
          if (await repo.countActiveForRider(db, id) > 0) throw conflict("RIDER_HAS_ACTIVE", "Reassign or unassign this rider's deliveries before suspending them.");
          patch.isAvailable = false;
        }
        const updated = await repo.updateRider(db, id, patch);
        await audit.log({ actor, action: "rider.updated", entityType: "rider", entityId: id, oldValue: { status: rider.status, vehicle: rider.vehicle }, newValue: body }, ctx, db);
        return toRiderDto(updated);
      });
    },

    // =============================================================== customer / staff: tracking
    /**
     * Owner, or staff who can see every order / manage dispatch. The rider's PRECISE position goes only to the owner and
     * to dispatch (delivery:manage) — other order-readers (support, accounts) see status and history but never coordinates —
     * and only while the run is live (picked up).
     */
    async tracking(actor, orderId) {
      const order = await orders.getById(pool, orderId);
      const owner = !!order && order.user_id === actor?.id;
      const dispatcher = can(actor, "delivery:manage");
      if (!order || (!owner && !dispatcher && !can(actor, "orders:read_all"))) throw notFound("ORDER_NOT_FOUND", "Order not found");
      const [active, events, failed] = await Promise.all([repo.activeForOrder(pool, orderId), repo.eventsForOrder(pool, orderId), repo.countFailedForOrder(pool, orderId)]);
      const live = (owner || dispatcher) && active?.status === "picked_up" && active.last_lat != null;
      return {
        orderId, orderStatus: order.status, failedAttempts: failed,
        delivery: active ? {
          status: active.status, rider: order.partner ?? null,
          location: live ? { lat: active.last_lat, lng: active.last_lng, accuracy: active.last_accuracy ?? null, updatedAt: active.last_located_at } : null,
        } : null,
        events: events.filter((e) => dispatcher || CUSTOMER_EVENTS.includes(e.type)).map((e) => toEventDto(e, { staff: dispatcher })),
      };
    },
  };
}
