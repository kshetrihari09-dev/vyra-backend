import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DELIVERY_DISTANCE, DELIVERY_OPTIONS } from "../../src/config/delivery.js";
import { assertDistanceConfig, outOfRangeMessage, quoteDelivery, tierTable } from "../../src/domain/deliveryPricing.js";
import { createCartService } from "../../src/services/cart.service.js";
import { createCouponsService } from "../../src/services/coupons.service.js";
import { createOrdersService } from "../../src/services/orders.service.js";
import { createPricingService } from "../../src/services/pricing.service.js";
import { createDeliveryCodes } from "../../src/utils/deliveryCode.js";
import { createFakeCommerce, customer } from "../helpers/commerceFakes.js";
import { fakeAudit } from "../helpers/fakes.js";

const STORE = { lat: 27.7172, lng: 85.324 };   // the seeded Vyra Central
const ctx = { ip: "203.0.113.5", requestId: "r" };
const codes = createDeliveryCodes(Buffer.alloc(32, 7).toString("base64"));
const km = (dLat) => ({ lat: STORE.lat + dLat, lng: STORE.lng });   // 1° of latitude ≈ 111.19 km straight, × 1.3 road factor

// ------------------------------------------------------------------------------------------------ the pure rules
describe("distance-based delivery charge (pure rules)", () => {
  const q = (destination, extra = {}) => quoteDelivery({ optionId: "standard", taxable: 100, branch: STORE, destination, ...extra });

  it("the shipped tier table is valid and reads as bands", () => {
    assert.doesNotThrow(() => assertDistanceConfig());
    assert.deepEqual(tierTable()[0], { fromKm: 0, toKm: 2, fee: 0 });
    assert.equal(tierTable().at(-1).toKm, DELIVERY_DISTANCE.maxKm);
  });

  it("a malformed tier table is refused at startup instead of mispricing orders", () => {
    const ok = { roadFactor: 1.3, maxKm: 10, unknownDistanceFee: 1 };
    assert.throws(() => assertDistanceConfig({ ...ok, tiers: [] }), /empty/);
    assert.throws(() => assertDistanceConfig({ ...ok, tiers: [{ upToKm: 5, fee: 1 }, { upToKm: 3, fee: 2 }], maxKm: 3 }), /ascending/);
    assert.throws(() => assertDistanceConfig({ ...ok, tiers: [{ upToKm: 5, fee: 1 }, { upToKm: 10, fee: -1 }] }), />= 0/);
    assert.throws(() => assertDistanceConfig({ ...ok, tiers: [{ upToKm: 5, fee: 1 }], maxKm: 10 }), /maxKm/);
    assert.throws(() => assertDistanceConfig({ ...ok, roadFactor: 0.5, tiers: [{ upToKm: 10, fee: 1 }] }), /roadFactor/);
  });

  it("farther is never cheaper, and every distance lands in the band that contains it", () => {
    let last = -1;
    for (let d = 0; d <= 0.13; d += 0.0025) {
      const r = q(km(d));
      if (!r.deliverable) { assert.ok(r.distanceKm > DELIVERY_DISTANCE.maxKm); continue; }
      assert.ok(r.distanceFee >= last, `fee fell at ${r.distanceKm} km`); last = r.distanceFee;
      assert.ok(r.distanceKm > r.tier.fromKm || r.tier.fromKm === 0);
      assert.ok(r.distanceKm <= r.tier.toKm);
      assert.equal(r.fee, r.base + r.distanceFee);
    }
  });

  it("distance is the straight line × the road factor, rounded UP to 0.1 km", () => {
    const r = q(km(0.01));                                        // ≈ 1.11 km straight → ×1.3 = 1.445 → 1.5
    assert.equal(r.distanceKm, 1.5);
    assert.equal(Math.round(r.distanceKm * 10), r.distanceKm * 10);
  });

  it("an exact band edge belongs to the cheaper band (no float-noise upgrade)", () => {
    const cfg = { roadFactor: 1, maxKm: 4, unknownDistanceFee: 9, tiers: [{ upToKm: 2, fee: 1 }, { upToKm: 4, fee: 3 }] };
    const dLat = (2 * 180) / (Math.PI * 6371); // exactly 2 km along a meridian on the sphere the code uses (R = 6371 km)
    const r = quoteDelivery({ optionId: "standard", taxable: 0, branch: STORE, destination: km(dLat) }, cfg);
    assert.equal(r.distanceKm, 2);
    assert.equal(r.distanceFee, 1);
  });

  it("the option's base fee and the distance charge add up, for every option", () => {
    for (const id of Object.keys(DELIVERY_OPTIONS)) {
      const r = quoteDelivery({ optionId: id, taxable: 10, branch: STORE, destination: km(0.03) });
      assert.equal(r.fee, Math.round((r.base + r.distanceFee) * 100) / 100, id);
    }
    assert.ok(quoteDelivery({ optionId: "express", taxable: 10, branch: STORE, destination: km(0.03) }).fee > q(km(0.03)).fee);
  });

  it("beyond the maximum radius is not deliverable, and says how far it was", () => {
    const r = q(km(0.2));
    assert.equal(r.deliverable, false); assert.equal(r.distanceFee, null);
    assert.match(outOfRangeMessage(r, "Vyra Central"), new RegExp(`${r.distanceKm} km from Vyra Central.*within ${DELIVERY_DISTANCE.maxKm} km`));
  });

  it("without a pin (or without a branch location) the fallback fee applies, so leaving the pin off is no loophole", () => {
    const noPin = q(null);
    assert.deepEqual([noPin.basis, noPin.distanceKm, noPin.distanceFee, noPin.deliverable], ["no_pin", null, DELIVERY_DISTANCE.unknownDistanceFee, true]);
    const noBranch = quoteDelivery({ optionId: "standard", taxable: 10, branch: null, destination: km(0.01) });
    assert.equal(noBranch.basis, "branch_unlocated"); assert.equal(noBranch.distanceFee, DELIVERY_DISTANCE.unknownDistanceFee);
    // NULL is what the database returns for an address without a pin — it must NEVER be read as (0, 0).
    for (const bad of [{ lat: null, lng: null }, { lat: null, lng: 85.3 }, { lat: 27.7, lng: null }, { lat: "", lng: "" }, { lat: "x", lng: 1 }, { lat: NaN, lng: 1 },
      { lat: 95, lng: 0 }, { lat: 0, lng: 200 }, {}, undefined, null]) assert.equal(q(bad).basis, "no_pin", JSON.stringify(bad));
    assert.equal(quoteDelivery({ optionId: "standard", taxable: 1, branch: { lat: null, lng: null }, destination: km(0.01) }).basis, "branch_unlocated");
  });

  it("is deterministic: the same inputs always give the same quote", () => {
    assert.deepEqual(q(km(0.04)), q(km(0.04)));
  });
});

// ------------------------------------------------------------------------------------------------ in the cart and the order
function setup() {
  const fake = createFakeCommerce();
  const soap = fake.key("store-01", "soap", "");
  fake.db.inventory.set(soap, { id: soap, on_hand: 50, reserved: 0 });
  const addr = (id, extra = {}) => fake.db.addresses.push({ id, user_id: customer.id, label: id, name: "Alex", phone: "+1 555 0190", line1: "1 Test Rd", line2: null, city: "Metro", zip: "1", is_default: false, ...extra });
  addr("near", { lat: STORE.lat + 0.005, lng: STORE.lng });                  // ≈ 0.7 km
  addr("mid", { lat: 27.7, lng: 85.3333 });                                  // ≈ 2.8 km
  addr("far", { lat: 27.75, lng: 85.4 });                                    // ≈ 10.9 km
  addr("away", { lat: 27.9, lng: 85.5 });                                    // ≈ 35 km — out of range
  addr("nopin", { lat: null, lng: null });                                // like Postgres: NULL, not a missing key
  fake.db.addresses.push({ id: "theirs", user_id: "someone-else", line1: "x", lat: STORE.lat + 0.005, lng: STORE.lng });
  const withTx = (fn) => fn({});
  const pricing = createPricingService({ repos: fake.repos, coupons: createCouponsService({ repos: fake.repos }) });
  const cart = createCartService({ pool: {}, repos: fake.repos, pricing });
  const prescriptions = { assertCoverage: async () => [], linkToOrder: async () => {} };
  const payments = { createForOrder: async () => {}, markCodCollected: async () => {}, settleOnCancel: async () => ({}) };
  const orders = createOrdersService({ pool: {}, withTx, repos: fake.repos, pricing, audit: fakeAudit(), prescriptions, payments, codes });
  return { ...fake, cart, orders, soap };
}
const quote = (e, addressId, over = {}, actor = customer) =>
  e.cart.price({ items: [{ productId: "soap", qty: 2 }], deliveryOptionId: "standard", branch: "store-01", addressId, ...over }, actor);
const place = (e, addressId, over = {}) => e.orders.create(customer, { items: [{ productId: "soap", qty: 2 }], addressId, paymentMethod: "cod", deliveryOptionId: "standard", ...over }, ctx);

describe("delivery charge in the cart preview", () => {
  it("charges by the band the address falls into, and the total adds up", async () => {
    const e = setup();
    const near = await quote(e, "near"); const mid = await quote(e, "mid"); const far = await quote(e, "far");
    assert.deepEqual([near.totals.delivery.distanceFee, mid.totals.delivery.distanceFee, far.totals.delivery.distanceFee], [0, 1, 3.5]);
    assert.ok(near.totals.delivery.distanceKm < mid.totals.delivery.distanceKm && mid.totals.delivery.distanceKm < far.totals.delivery.distanceKm);
    for (const r of [near, mid, far]) {
      assert.equal(r.totals.deliveryFee, r.totals.delivery.fee);
      assert.equal(r.totals.total, Math.round((r.totals.subtotal - r.totals.discount + r.totals.tax + r.totals.deliveryFee) * 100) / 100);
    }
  });

  it("an out-of-range address is a blocking issue with a reason (so checkout can't proceed)", async () => {
    const r = await quote(await setup(), "away");
    const issue = r.issues.find((i) => i.type === "out_of_range");
    assert.ok(issue); assert.match(issue.message, /within 15 km/);
    assert.equal(r.totals.delivery.deliverable, false);
  });

  it("an address with no pin gets the fallback fee and says why", async () => {
    const r = await quote(setup(), "nopin");
    assert.equal(r.totals.delivery.basis, "no_pin"); assert.equal(r.totals.delivery.distanceFee, DELIVERY_DISTANCE.unknownDistanceFee);
  });

  it("someone else's address id — or no signed-in user — is ignored, never used to probe an address", async () => {
    const e = setup();
    assert.equal((await quote(e, "theirs")).totals.delivery.basis, "no_pin");
    assert.equal((await quote(e, "near", {}, null)).totals.delivery.basis, "no_pin");
    assert.equal((await quote(e, undefined)).totals.delivery.basis, "no_pin");
  });
});

describe("delivery charge on the placed order", () => {
  it("the order is charged exactly what the preview quoted — and keeps the distance it was based on", async () => {
    const e = setup();
    for (const id of ["near", "mid", "far"]) {
      const quoted = await quote(e, id);
      const order = await place(e, id);
      assert.equal(order.deliveryFee, quoted.totals.deliveryFee, id);
      assert.equal(order.total, quoted.totals.total, id);
      assert.equal(order.delivery.distanceKm, quoted.totals.delivery.distanceKm, id);
    }
  });

  it("an out-of-range order is refused outright and reserves no stock", async () => {
    const e = setup();
    await assert.rejects(place(e, "away"), { code: "OUT_OF_DELIVERY_RANGE" });
    assert.equal(e.db.inventory.get(e.soap).reserved, 0);
    assert.equal(e.db.orders.length, 0);
  });

  it("an order to an address without a pin pays the fallback fee and records no distance", async () => {
    const e = setup();
    const order = await place(e, "nopin");
    assert.equal(order.deliveryFee, DELIVERY_DISTANCE.unknownDistanceFee);
    assert.equal(order.delivery.distanceKm, null);
  });

  it("the fee is a snapshot: re-reading the order later returns the same fee and distance", async () => {
    const e = setup();
    const order = await place(e, "mid");
    const again = await e.orders.get(customer, order.id);
    assert.deepEqual([again.deliveryFee, again.delivery.distanceKm, again.total], [order.deliveryFee, order.delivery.distanceKm, order.total]);
  });
});
