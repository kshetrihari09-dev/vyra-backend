import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { minOrderIssues, normalizeSettings, paymentRejection, settingsView, wantsNotification } from "../../src/domain/sellerSettings.js";
import { shopSettingsBody } from "../../src/validators/sellers.validators.js";

const full = () => ({
  name: "Fresh Grocers", description: "Local produce", logo: null, banner: null, phone: "9812345678", email: "shop@example.com",
  address: "Main St", city: "Butwal", landmark: "",
  hours: Object.fromEntries(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => [d, { open: "09:00", close: "18:00", closed: d === "Sun" }])),
  delivery: { available: true, pickup: true, radiusKm: 5, fee: 50, freeAbove: 1000, minOrder: 300, prepMinutes: 30 },
  payments: { cod: true, card: false, upi: true, netbanking: false },
  tax: { registration: "PAN123", inclusive: true, defaultRate: 13 },
  notifications: { newOrder: true, lowStock: true, payout: true, reviews: false, email: true, sms: false },
});

describe("normalizeSettings", () => {
  it("fills every missing key with the defaults (a shop that never saved anything is fully usable)", () => {
    const n = normalizeSettings({});
    assert.equal(n.payments.cod, true); assert.equal(n.payments.netbanking, false); assert.equal(n.delivery.minOrder, 0);
    assert.equal(n.hours.Sun.closed, true); assert.equal(n.notifications.newOrder, true);
    assert.deepEqual(normalizeSettings(null), n);
  });
  it("keeps what was saved and fills only the gaps", () => {
    const n = normalizeSettings({ delivery: { minOrder: 500 }, hours: { Mon: { open: "10:00", close: "20:00", closed: false } } });
    assert.equal(n.delivery.minOrder, 500); assert.equal(n.delivery.radiusKm, 5);
    assert.equal(n.hours.Mon.open, "10:00"); assert.equal(n.hours.Tue.open, "09:00");
  });
  it("settingsView puts the shop's own name/description columns first", () => {
    const v = settingsView({ name: "A", description: null, settings: { city: "X" } });
    assert.equal(v.name, "A"); assert.equal(v.description, ""); assert.equal(v.city, "X"); assert.equal(v.saved, true);
    assert.equal(settingsView({ name: "B", settings: {} }).saved, false, "a shop that never saved keeps its application prefill");
  });
});

describe("minimum order (per shop)", () => {
  const rows = [{ id: "a", name: "Shop A", settings: { delivery: { minOrder: 300 } } }, { id: "b", name: "Shop B", settings: {} }];
  const line = (sellerId, lineTotal) => ({ sellerId, lineTotal });
  it("flags a shop whose own items are under its minimum, with the amount still needed", () => {
    const [issue] = minOrderIssues([line("a", 120), line("b", 5000)], rows);
    assert.equal(issue.type, "seller_min_order"); assert.equal(issue.sellerId, "a");
    assert.match(issue.message, /Shop A has a minimum order of 300\. Add 180 more/);
  });
  it("counts only that shop's items — other shops' items don't help", () => {
    assert.equal(minOrderIssues([line("a", 299.99), line("b", 9999)], rows).length, 1);
    assert.equal(minOrderIssues([line("a", 150), line("a", 150)], rows).length, 0);
  });
  it("ignores shops with no minimum, products with no shop, and shops not in the cart", () => {
    assert.equal(minOrderIssues([line("b", 1), line(null, 1)], rows).length, 0);
    assert.equal(minOrderIssues([line("b", 1)], rows).length, 0);
  });
});

describe("accepted payment methods", () => {
  const rows = [{ id: "a", name: "Shop A", settings: { payments: { cod: false } } }, { id: "b", name: "Shop B", settings: {} }];
  it("refuses a method a shop in the cart has turned off, naming the shop", () => {
    const r = paymentRejection(rows, "cod");
    assert.equal(r.sellerId, "a"); assert.match(r.message, /Shop A doesn't accept cash on delivery/);
  });
  it("allows methods every shop accepts; defaults apply to shops with no saved settings", () => {
    assert.equal(paymentRejection(rows, "card"), null); assert.equal(paymentRejection([rows[1]], "cod"), null);
    assert.equal(paymentRejection([rows[1]], "netbanking")?.sellerId, "b", "net banking is off by default");
  });
});

describe("notification preferences", () => {
  it("default on; explicit off is honoured", () => {
    assert.equal(wantsNotification({}, "newOrder"), true);
    assert.equal(wantsNotification({ notifications: { newOrder: false } }, "newOrder"), false);
    assert.equal(wantsNotification({ notifications: { payout: false } }, "newOrder"), true);
  });
});

describe("shopSettingsBody validation", () => {
  it("accepts a complete, valid payload", () => assert.equal(shopSettingsBody.safeParse(full()).success, true));
  const bad = (mutate, re) => { const v = full(); mutate(v); const r = shopSettingsBody.safeParse(v); assert.equal(r.success, false); if (re) assert.match(JSON.stringify(r.error.issues), re); };
  it("rejects bad hours, no payment method, out-of-range tax, bad contact and unknown fields", () => {
    bad((v) => { v.hours.Mon = { open: "18:00", close: "09:00", closed: false }; }, /Closing time/);
    bad((v) => { v.payments = { cod: false, card: false, upi: false, netbanking: false }; }, /at least one payment/i);
    bad((v) => { v.tax.defaultRate = 140; });
    bad((v) => { v.email = "nope"; }, /valid email/);
    bad((v) => { v.phone = "12"; }, /valid phone/);
    bad((v) => { v.delivery.minOrder = -1; });
    bad((v) => { v.name = "  "; });
    bad((v) => { v.commissionRate = 0; });
    bad((v) => { v.hours.Mon.extra = 1; });
  });
  it("a closed day needs no valid times; images must be small data-URL pictures", () => {
    const v = full(); v.hours.Mon = { open: "18:00", close: "09:00", closed: true }; assert.equal(shopSettingsBody.safeParse(v).success, true);
    bad((x) => { x.logo = "https://evil.example/x.png"; }, /PNG, JPG or WebP/);
    bad((x) => { x.logo = "data:text/html;base64,PHNjcmlwdD4="; });
    bad((x) => { x.banner = "data:image/png;base64," + "A".repeat(950_000); }, /too large/);
    const ok = full(); ok.logo = "data:image/png;base64,iVBORw0KGgo="; assert.equal(shopSettingsBody.safeParse(ok).success, true);
  });
});
