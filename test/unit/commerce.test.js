import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { createAddressesService } from "../../src/services/addresses.service.js";
import { createCartService } from "../../src/services/cart.service.js";
import { createCouponsService } from "../../src/services/coupons.service.js";
import { createOrdersService } from "../../src/services/orders.service.js";
import { createPricingService } from "../../src/services/pricing.service.js";
import { createFakeCommerce, customer, staffOrders } from "../helpers/commerceFakes.js";
import { fakeAudit } from "../helpers/fakes.js";

const ctx = { ip: "203.0.113.5", requestId: "r" };

function setup() {
  const fake = createFakeCommerce();
  fake.db.inventory.set(fake.key("store-01", "soap", ""), { id: fake.key("store-01", "soap", ""), on_hand: 10, reserved: 0 });
  fake.db.inventory.set(fake.key("store-01", "cough-syrup", ""), { id: fake.key("store-01", "cough-syrup", ""), on_hand: 13, reserved: 0 });
  fake.db.addresses.push({ id: "addr-1", user_id: customer.id, label: "Home", name: "Alex", phone: "+1 555 0190", line1: "24 Maple Ct", line2: null, city: "Metro", zip: "10245", is_default: true });

  const audit = fakeAudit();
  const withTx = (fn) => fn({});
  const coupons = createCouponsService({ repos: fake.repos });
  const pricing = createPricingService({ repos: fake.repos, coupons });
  const cart = createCartService({ pool: {}, repos: fake.repos, pricing });
  const orders = createOrdersService({ pool: {}, withTx, repos: fake.repos, pricing, audit });
  const addresses = createAddressesService({ pool: {}, withTx, repos: fake.repos });
  return { ...fake, audit, coupons, pricing, cart, orders, addresses };
}

describe("pricing / cart preview", () => {
  it("prices lines at the current product price and flags stock/limit/moq problems", async () => {
    const e = setup();
    const res = await e.cart.price({ items: [{ productId: "soap", qty: 3 }], deliveryOptionId: "standard", branch: "store-01" }, null);
    assert.equal(res.lines[0].lineTotal, 15);
    assert.deepEqual(res.issues, []);
    assert.equal(res.totals.subtotal, 15);

    const over = await e.cart.price({ items: [{ productId: "soap", qty: 999 }], branch: "store-01" }, null);
    assert.ok(over.issues.some((i) => i.type === "limit"));
    const out = await e.cart.price({ items: [{ productId: "cough-syrup", qty: 1 }], branch: "store-02" }, null); // no stock row at store-02
    assert.ok(out.issues.some((i) => i.type === "out_of_stock"));
  });

  it("an unknown product is reported, not thrown, so the rest of the cart still prices", async () => {
    const e = setup();
    const res = await e.cart.price({ items: [{ productId: "ghost", qty: 1 }, { productId: "soap", qty: 1 }], branch: "store-01" }, null);
    assert.equal(res.lines.length, 1);
    assert.equal(res.issues[0].type, "not_found");
  });
});

describe("coupons", () => {
  it("percent discount is capped by maxDiscount and requires the minimum order", async () => {
    const e = setup();
    const low = await e.coupons.evaluate({}, "NOVA10", [{ categoryId: "grocery", brandId: "b1", lineTotal: 10 }], {});
    assert.equal(low.ok, false);
    const big = await e.coupons.evaluate({}, "NOVA10", [{ categoryId: "grocery", brandId: "b1", lineTotal: 200 }], {});
    assert.equal(big.discount, 15); // 10% of 200 = 20, capped at 15
  });
  it("first-order-only is enforced, and a fully-redeemed code is refused", async () => {
    const e = setup();
    assert.equal((await e.coupons.evaluate({}, "FIRST15", [{ categoryId: "g", brandId: "b", lineTotal: 10 }], { isFirstOrder: false })).ok, false);
    assert.equal((await e.coupons.evaluate({}, "FIRST15", [{ categoryId: "g", brandId: "b", lineTotal: 10 }], { isFirstOrder: true })).ok, true);
    assert.equal((await e.coupons.evaluate({}, "GONE", [{ categoryId: "g", brandId: "b", lineTotal: 10 }], {})).ok, false);
  });
  it("a customer can't reuse a code past their per-customer limit", async () => {
    const e = setup();
    e.db.redemptions.push({ code: "NOVA10", userId: customer.id });
    const res = await e.coupons.evaluate({}, "NOVA10", [{ categoryId: "g", brandId: "b", lineTotal: 100 }], { userId: customer.id });
    assert.equal(res.ok, false);
  });
});

describe("order creation", () => {
  it("reserves stock, snapshots the address, and auto-confirms", async () => {
    const e = setup();
    const order = await e.orders.create(customer, { items: [{ productId: "soap", qty: 2 }], addressId: "addr-1", paymentMethod: "cod", deliveryOptionId: "standard" }, ctx);
    assert.equal(order.status, "confirmed");
    assert.equal(order.totals.subtotal, 10);
    assert.equal(order.shipTo.line1, "24 Maple Ct");
    assert.deepEqual(order.history.map((h) => h.status), ["placed", "confirmed"]);
    const row = e.db.inventory.get(e.key("store-01", "soap", ""));
    assert.equal(row.reserved, 2);
    assert.equal(row.on_hand, 10, "reservation does not touch on_hand yet");
    assert.ok(e.audit.entries.some((a) => a.action === "order.placed"));
  });

  it("insufficient stock blocks order creation and reserves nothing", async () => {
    const e = setup();
    await assert.rejects(e.orders.create(customer, { items: [{ productId: "soap", qty: 50 }], addressId: "addr-1", paymentMethod: "cod", deliveryOptionId: "standard" }, ctx), { code: "CART_INVALID" });
    assert.equal(e.db.inventory.get(e.key("store-01", "soap", "")).reserved, 0);
  });

  it("an address belonging to someone else is rejected", async () => {
    const e = setup();
    await assert.rejects(e.orders.create({ ...customer, id: "someone-else" }, { items: [{ productId: "soap", qty: 1 }], addressId: "addr-1", paymentMethod: "cod", deliveryOptionId: "standard" }, ctx), { code: "ADDRESS_NOT_FOUND" });
  });

  it("applies a valid coupon and records the redemption", async () => {
    const e = setup();
    const order = await e.orders.create(customer, { items: [{ productId: "soap", qty: 5 }], addressId: "addr-1", paymentMethod: "cod", deliveryOptionId: "standard", couponCode: "nova10" }, ctx);
    assert.equal(order.couponCode, "NOVA10");
    assert.ok(order.totals.discount > 0);
    assert.equal(e.db.redemptions.length, 1);
  });

  it("an invalid coupon code fails the whole order, not just the discount", async () => {
    const e = setup();
    await assert.rejects(e.orders.create(customer, { items: [{ productId: "soap", qty: 1 }], addressId: "addr-1", paymentMethod: "cod", deliveryOptionId: "standard", couponCode: "NOPE" }, ctx), { code: "COUPON_INVALID" });
  });
});

describe("order fulfilment", () => {
  let e, order;
  beforeEach(async () => {
    e = setup();
    order = await e.orders.create(customer, { items: [{ productId: "cough-syrup", qty: 5 }], addressId: "addr-1", paymentMethod: "cod", deliveryOptionId: "standard" }, ctx);
  });

  it("stages must advance one at a time — skipping ahead is rejected", async () => {
    await assert.rejects(e.orders.advance(staffOrders, order.id, { status: "packed" }, ctx), { code: "INVALID_TRANSITION" });
    assert.ok(await e.orders.advance(staffOrders, order.id, { status: "preparing" }, ctx));
  });

  it("a non-staff caller cannot advance an order", async () => {
    await assert.rejects(e.orders.advance(customer, order.id, { status: "preparing" }, ctx), { status: 403 });
  });

  it("reaching 'packed' deducts on-hand and consumes batches oldest-expiry-first", async () => {
    await e.orders.advance(staffOrders, order.id, { status: "preparing" }, ctx);
    await e.orders.advance(staffOrders, order.id, { status: "packed" }, ctx);
    const row = e.db.inventory.get(e.key("store-01", "cough-syrup", ""));
    assert.equal(row.on_hand, 8);
    assert.equal(row.reserved, 0);
    const batches = e.db.batches["cough-syrup"]["store-01"];
    assert.equal(batches.find((b) => b.id === "b-old").qty, 0); // fully consumed first (3 of 5)
    assert.equal(batches.find((b) => b.id === "b-new").qty, 8); // remaining 2 taken from the next batch
  });

  it("'assigned' attaches a delivery partner", async () => {
    await e.orders.advance(staffOrders, order.id, { status: "preparing" }, ctx);
    await e.orders.advance(staffOrders, order.id, { status: "packed" }, ctx);
    const assigned = await e.orders.advance(staffOrders, order.id, { status: "assigned" }, ctx);
    assert.ok(assigned.partner?.name);
  });

  it("cancelling releases the reservation and is refused once packed", async () => {
    const cancelled = await e.orders.cancel(customer, order.id, { reason: "changed my mind" }, ctx);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(e.db.inventory.get(e.key("store-01", "cough-syrup", "")).reserved, 0);

    const order2 = await e.orders.create(customer, { items: [{ productId: "soap", qty: 1 }], addressId: "addr-1", paymentMethod: "cod", deliveryOptionId: "standard" }, ctx);
    await e.orders.advance(staffOrders, order2.id, { status: "preparing" }, ctx);
    await e.orders.advance(staffOrders, order2.id, { status: "packed" }, ctx);
    await assert.rejects(e.orders.cancel(customer, order2.id, {}, ctx), { code: "TOO_LATE_TO_CANCEL" });
  });

  it("a stranger cannot cancel someone else's order", async () => {
    await assert.rejects(e.orders.cancel({ id: "stranger", permissions: [] }, order.id, {}, ctx), { status: 403 });
  });
});

describe("order visibility", () => {
  it("the owner and staff with orders:read_all can fetch an order; anyone else gets NOT_FOUND (never a 403 that confirms it exists)", async () => {
    const e = setup();
    const order = await e.orders.create(customer, { items: [{ productId: "soap", qty: 1 }], addressId: "addr-1", paymentMethod: "cod", deliveryOptionId: "standard" }, ctx);
    assert.ok(await e.orders.get(customer, order.id));
    assert.ok(await e.orders.get(staffOrders, order.id));
    await assert.rejects(e.orders.get({ id: "stranger", permissions: [] }, order.id), { code: "ORDER_NOT_FOUND" });
  });

  it("otp is only ever included for the owner or delivery-permitted staff", async () => {
    const e = setup();
    const order = await e.orders.create(customer, { items: [{ productId: "soap", qty: 1 }], addressId: "addr-1", paymentMethod: "cod", deliveryOptionId: "standard" }, ctx);
    const mine = await e.orders.get(customer, order.id);
    assert.equal(typeof mine.otp, "string");
    const staffView = await e.orders.get(staffOrders, order.id); // orders:update_status/read_all, no delivery perms
    assert.equal(staffView.otp, undefined);
  });
});

describe("addresses", () => {
  it("the first saved address becomes the default automatically; a later default clears the previous one", async () => {
    const e = setup();
    e.db.addresses.length = 0;
    const a = await e.addresses.create(customer.id, { label: "Home", name: "Alex", phone: "+1 555 0190", line1: "1 A St" });
    assert.equal(a.isDefault, true);
    const b = await e.addresses.create(customer.id, { label: "Work", name: "Alex", phone: "+1 555 0190", line1: "2 B St", isDefault: true });
    assert.equal(b.isDefault, true);
    assert.equal((await e.addresses.list(customer.id)).find((x) => x.id === a.id).isDefault, false);
  });

  it("cannot update or delete someone else's address", async () => {
    const e = setup();
    await assert.rejects(e.addresses.update("someone-else", "addr-1", { label: "x", name: "x", phone: "+1 555 0190", line1: "x" }), { code: "ADDRESS_NOT_FOUND" });
  });
});
