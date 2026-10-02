import { DELIVERY_RULES, FAILURE_REASONS } from "../config/delivery.js";
import { toClaimableDto, toDeliveryDto, toEventDto, toRiderDto } from "../models/delivery.model.js";
import { assertPaymentCleared, assertTransition } from "../domain/orderRules.js";
import { badRequest, conflict, forbidden, notFound } from "../utils/errors.js";

const can = (actor, perm) => !!actor?.permissions?.includes(perm);
const cents = (n) => Math.round(Number(n) * 100);
const partnerOf = (rider) => ({ name: rider.full_name, phone: rider.phone, vehicle: rider.vehicle });
/** Event types a customer may see on their own order's timeline (never notes, never OTP/staff housekeeping). */
const CUSTOMER_EVENTS = ["assigned", "claimed", "picked_up", "delivered", "failed"];

/**
 * Delivery module (Phase 7). Owns everything from "packed" onwards:
 *   packed ──assign/claim──▶ assigned ──pickup──▶ out_for_delivery ──deliver(code)──▶ delivered
 *                              ▲   │decline/unassign        │fail
 *                              └───┴──── back to packed ◀───┘ (until maxAttemptsPerOrder, then → returned)
 * Lock order is always: order row, then delivery row (rider actions lock the delivery first and the order second —
 * they can't collide with assign/claim because those only run when NO active delivery exists).
 */
export function createDeliveryService({ pool, withTx, repos, audit, payments, codes, notifications = { emit: async () => null }, clock = () => new Date() }) {
  const { delivery: repo, orders, roles, users } = repos;

  async function requireRider(db, actor, { forUpdate = false } = {}) {
    const rider = await repo.getRiderByUser(db, actor.id, { forUpdate });
    if (!rider) throw forbidden("NOT_A_RIDER", "This account isn't set up as a delivery rider");
    if (rider.status !== "active") throw forbidden("RIDER_SUSPENDED", "Your rider account is suspended");
    return rider;
  }

  /** A rider only ever sees or touches their own deliveries; anyone else's is simply "not found". */
  async function ownDelivery(db, actor, id, { forUpdate = false } = {}) {
    const rider = await requireRider(db, actor);
    const d = await repo.getDelivery(db, id, { forUpdate });
    if (!d || d.rider_id !== rider.id) throw notFound("DELIVERY_NOT_FOUND", "Delivery not found");
    return { rider, d };
  }

  async function lockOrder(db, orderId) {
    const order = await orders.getById(db, orderId, { forUpdate: true });
    if (!order) throw notFound("ORDER_NOT_FOUND", "Order not found");
    return order;
  }

  /** Every status change from "packed" on goes through here, and through the one transition table (domain/orderRules.js):
   *  `order` is the row the caller just locked, so the move is checked against its real current status. */
  const moveOrder = async (db, order, status, { note = null, patch } = {}) => {
    assertTransition(order.status, status);
    const updated = await orders.updateStatus(db, order.id, status, patch);
    await orders.addHistory(db, order.id, status, note);
    return updated;
  };

  /** Shared by assign / claim / reassign: capacity check, then the one-active-per-order insert. */
  async function openAssignment(db, { actor, order, rider, selfClaimed = false }) {
    if (rider.status !== "active") throw conflict("RIDER_INACTIVE", "That rider's account isn't active");
    if (await repo.countActiveForRider(db, rider.id) >= DELIVERY_RULES.maxActivePerRider) {
      throw conflict("RIDER_BUSY", `${selfClaimed ? "You already have" : "That rider already has"} ${DELIVERY_RULES.maxActivePerRider} deliveries in progress`);
    }
    try {
      return await repo.insertDelivery(db, {
        orderId: order.id, riderId: rider.id, status: selfClaimed ? "accepted" : "assigned",
        assignedBy: selfClaimed ? null : actor.id, selfClaimed, acceptedAt: selfClaimed ? clock() : null,
      });
    } catch (err) {
      if (err.code === "23505") throw conflict("ALREADY_ASSIGNED", "That order was just taken by someone else"); // the partial unique index is the backstop
      throw err;
    }
  }

  /** Tell the customer (and, for dispatch assignments, the rider) — inside the same transaction as the change. */
  const tell = (db, order, type, data = {}) => notifications.emit(db, { userId: order.user_id, type, data: { orderId: order.id, number: order.number, ...data } });

  const dto = async (db, id, opts) => toDeliveryDto(await repo.getDelivery(db, id), opts);

  return {
    // =============================================================== rider: profile & queue
    async me(actor) {
      return toRiderDto(await requireRider(pool, actor));
    },

    async setAvailability(actor, isAvailable) {
      const rider = await requireRider(pool, actor);
      return toRiderDto(await repo.updateRider(pool, rider.id, { isAvailable }));
    },

    async listMine(actor, { scope = "active" } = {}) {
      const rider = await requireRider(pool, actor);
      const rows = await repo.listForRider(pool, rider.id, { active: scope !== "history" });
      return rows.map((r) => toDeliveryDto(r));
    },

    /** Packed, unassigned orders a rider could take — area only, no street/name/phone until it's theirs. */
    async listClaimable(actor) {
      const rider = await requireRider(pool, actor);
      if (!rider.is_available) return [];
      return (await repo.listClaimable(pool)).map(toClaimableDto);
    },

    // =============================================================== rider: taking & doing a delivery
    async claim(actor, orderId, ctx) {
      return withTx(async (db) => {
        const rider = await requireRider(db, actor, { forUpdate: true });
        if (!rider.is_available) throw conflict("RIDER_UNAVAILABLE", "Switch to available to take deliveries");
        const order = await lockOrder(db, orderId);
        if (order.status !== "packed") throw conflict("NOT_DISPATCHABLE", `Order is "${order.status}" — only packed orders can be taken.`);
        assertPaymentCleared(order);
        if (await repo.activeForOrder(db, orderId)) throw conflict("ALREADY_ASSIGNED", "That order was just taken by someone else");
        const d = await openAssignment(db, { actor, order, rider, selfClaimed: true });
        await moveOrder(db, order, "assigned", { patch: { partner: partnerOf(rider) } });
        await repo.addEvent(db, { deliveryId: d.id, orderId, type: "claimed", actorId: actor.id });
        await tell(db, order, "delivery.assigned", { riderName: rider.full_name });
        await audit.log({ actor, action: "delivery.claimed", entityType: "delivery", entityId: d.id, newValue: { orderId, riderId: rider.id } }, ctx, db);
        return dto(db, d.id);
      });
    },

    async accept(actor, id, ctx) {
      return withTx(async (db) => {
        const { d } = await ownDelivery(db, actor, id, { forUpdate: true });
        if (d.status !== "assigned") throw conflict("NOT_OFFERED", `This delivery is "${d.status}" — there's nothing to accept.`);
        await repo.updateDelivery(db, d.id, { status: "accepted", acceptedAt: clock() });
        await repo.addEvent(db, { deliveryId: d.id, orderId: d.order_id, type: "accepted", actorId: actor.id });
        return dto(db, d.id);
      });
    },

    /** Give the order back before picking it up. It returns to "packed" for someone else. */
    async decline(actor, id, body, ctx) {
      return withTx(async (db) => {
        const { d } = await ownDelivery(db, actor, id, { forUpdate: true });
        if (!["assigned", "accepted"].includes(d.status)) throw conflict("CANNOT_DECLINE", "Once the order is picked up, use \"couldn't deliver\" instead.");
        const order = await lockOrder(db, d.order_id);
        await repo.updateDelivery(db, d.id, { status: "cancelled", cancelReason: `declined${body?.reason ? `: ${body.reason}` : ""}`, closedAt: clock() });
        await moveOrder(db, order, "packed", { note: "Rider declined — back to dispatch", patch: { partner: null } });
        await repo.addEvent(db, { deliveryId: d.id, orderId: order.id, type: "declined", actorId: actor.id, note: body?.reason ?? null });
        await audit.log({ actor, action: "delivery.declined", entityType: "delivery", entityId: d.id, newValue: { orderId: order.id, reason: body?.reason ?? null } }, ctx, db);
        return dto(db, d.id);
      });
    },

    async pickup(actor, id, ctx) {
      return withTx(async (db) => {
        const { d } = await ownDelivery(db, actor, id, { forUpdate: true });
        if (d.status !== "accepted") throw conflict("NOT_ACCEPTED", d.status === "assigned" ? "Accept the delivery before picking it up." : `This delivery is "${d.status}".`);
        const order = await lockOrder(db, d.order_id);
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
      return withTx(async (db) => {
        const { d } = await ownDelivery(db, actor, id, { forUpdate: true }); // serialises with deliver/fail so a late ping can't outlive the purge
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
      const outcome = await withTx(async (db) => {
        const { d } = await ownDelivery(db, actor, id, { forUpdate: true });
        if (d.status !== "picked_up") throw conflict("NOT_OUT_FOR_DELIVERY", d.status === "delivered" ? "This delivery is already complete." : "Pick the order up before completing it.");
        const order = await lockOrder(db, d.order_id);
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
      return withTx(async (db) => {
        const { d } = await ownDelivery(db, actor, id, { forUpdate: true });
        if (d.status !== "picked_up") throw conflict("NOT_OUT_FOR_DELIVERY", "Only an order that's out for delivery can be reported as undeliverable.");
        const order = await lockOrder(db, d.order_id);
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
      return withTx(async (db) => {
        const order = await lockOrder(db, orderId);
        if (order.status !== "packed") throw conflict("NOT_DISPATCHABLE", `Order is "${order.status}" — only packed orders can be assigned.`);
        assertPaymentCleared(order);
        if (await repo.activeForOrder(db, orderId)) throw conflict("ALREADY_ASSIGNED", "This order already has a rider.");
        const rider = await repo.getRider(db, body.riderId, { forUpdate: true });
        if (!rider) throw notFound("RIDER_NOT_FOUND", "Rider not found");
        const d = await openAssignment(db, { actor, order, rider });
        await moveOrder(db, order, "assigned", { patch: { partner: partnerOf(rider) } });
        await repo.addEvent(db, { deliveryId: d.id, orderId, type: "assigned", actorId: actor.id, note: rider.full_name });
        await tell(db, order, "delivery.assigned", { riderName: rider.full_name });
        await notifications.emit(db, { userId: rider.user_id, type: "rider.assigned", data: { orderId, number: order.number } });
        await audit.log({ actor, action: "delivery.assigned", entityType: "delivery", entityId: d.id, newValue: { orderId, riderId: rider.id } }, ctx, db);
        return dto(db, d.id);
      });
    },

    /** Take the order off its rider (before pickup) and put it back in the packed queue. */
    async unassign(actor, deliveryId, body, ctx) {
      if (!can(actor, "delivery:manage")) throw forbidden();
      return withTx(async (db) => {
        const d = await repo.getDelivery(db, deliveryId, { forUpdate: true });
        if (!d) throw notFound("DELIVERY_NOT_FOUND", "Delivery not found");
        if (!["assigned", "accepted"].includes(d.status)) throw conflict("CANNOT_UNASSIGN", d.status === "picked_up" ? "The rider already has the order — they must complete it or report it undeliverable." : `This delivery is "${d.status}".`);
        const order = await lockOrder(db, d.order_id);
        await repo.updateDelivery(db, d.id, { status: "cancelled", cancelReason: `unassigned${body?.reason ? `: ${body.reason}` : ""}`, closedAt: clock() });
        await moveOrder(db, order, "packed", { note: "Rider unassigned", patch: { partner: null } });
        await repo.addEvent(db, { deliveryId: d.id, orderId: order.id, type: "unassigned", actorId: actor.id, note: body?.reason ?? null });
        await audit.log({ actor, action: "delivery.unassigned", entityType: "delivery", entityId: d.id, newValue: { orderId: order.id, reason: body?.reason ?? null } }, ctx, db);
        return dto(db, d.id);
      });
    },

    async reassign(actor, deliveryId, body, ctx) {
      if (!can(actor, "delivery:manage")) throw forbidden();
      return withTx(async (db) => {
        const old = await repo.getDelivery(db, deliveryId, { forUpdate: true });
        if (!old) throw notFound("DELIVERY_NOT_FOUND", "Delivery not found");
        if (!["assigned", "accepted"].includes(old.status)) throw conflict("CANNOT_REASSIGN", old.status === "picked_up" ? "The rider already has the order." : `This delivery is "${old.status}".`);
        if (old.rider_id === body.riderId) throw badRequest("SAME_RIDER", "That rider already has this delivery.");
        const order = await lockOrder(db, old.order_id);
        const rider = await repo.getRider(db, body.riderId, { forUpdate: true });
        if (!rider) throw notFound("RIDER_NOT_FOUND", "Rider not found");
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
      return withTx(async (db) => {
        const order = await lockOrder(db, orderId);
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
      return withTx(async (db) => {
        const user = await users.lockById(db, body.userId);
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
      return withTx(async (db) => {
        const rider = await repo.getRider(db, id, { forUpdate: true });
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
    /** Owner, or staff who can see every order / manage dispatch. Location only while the run is live. */
    async tracking(actor, orderId) {
      const order = await orders.getById(pool, orderId);
      const staff = can(actor, "delivery:manage");
      if (!order || (order.user_id !== actor?.id && !staff && !can(actor, "orders:read_all"))) throw notFound("ORDER_NOT_FOUND", "Order not found");
      const [active, events, failed] = await Promise.all([repo.activeForOrder(pool, orderId), repo.eventsForOrder(pool, orderId), repo.countFailedForOrder(pool, orderId)]);
      const live = active?.status === "picked_up" && active.last_lat != null;
      return {
        orderId, orderStatus: order.status, failedAttempts: failed,
        delivery: active ? {
          status: active.status, rider: order.partner ?? null,
          location: live ? { lat: active.last_lat, lng: active.last_lng, accuracy: active.last_accuracy ?? null, updatedAt: active.last_located_at } : null,
        } : null,
        events: events.filter((e) => staff || CUSTOMER_EVENTS.includes(e.type)).map((e) => toEventDto(e, { staff })),
      };
    },
  };
}
