import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allocate, priceSale, settle, toCents } from "../../src/domain/posTotals.js";

const L = (unitPrice, qty, taxPercent = 0) => ({ unitPrice, qty, taxPercent });

describe("priceSale", () => {
  it("the worked example: 280 − 20 + 0 = 260", () => {
    const r = priceSale([L(80, 2), L(40, 3)], { type: "fixed", value: 20 });
    assert.deepEqual([r.subtotal, r.discount, r.tax, r.total], [280, 20, 0, 260]);
  });
  it("percentage discount, then tax on the discounted amount", () => {
    const r = priceSale([L(100, 1, 13)], { type: "percent", value: 10 }); // 100 − 10 = 90; 13% of 90 = 11.70
    assert.deepEqual([r.subtotal, r.discount, r.tax, r.total], [100, 10, 11.7, 101.7]);
  });
  it("no discount: total = subtotal + tax", () => assert.equal(priceSale([L(5, 3, 5)]).total, 15.75));
  it("floating-point traps stay exact (0.1 + 0.2 style)", () => {
    const r = priceSale([L(0.1, 3), L(0.2, 3)]);
    assert.equal(r.subtotal, 0.9);
    assert.equal(priceSale([L(19.99, 3, 13)], { type: "percent", value: 15 }).total, 57.6); // checked by hand in cents: 5997 − 900 + 662 = 5759… see below
  });
  it("discount shares add up to the discount EXACTLY and every line's net is never negative", () => {
    const r = priceSale([L(3.33, 1), L(3.33, 1), L(3.34, 1)], { type: "fixed", value: 1 });
    assert.equal(r.lines.reduce((a, l) => toCents(l.discount) + a, 0), 100);
    for (const l of r.lines) assert.ok(l.gross - l.discount >= 0);
  });
  it("can't go negative: a discount above the subtotal is refused; exactly the subtotal gives 0", () => {
    assert.throws(() => priceSale([L(10, 1)], { type: "fixed", value: 10.01 }), { code: "DISCOUNT_TOO_LARGE" });
    assert.equal(priceSale([L(10, 1, 13)], { type: "fixed", value: 10 }).total, 0);
    assert.equal(priceSale([L(10, 1)], { type: "percent", value: 100 }).total, 0);
  });
  it("rejects nonsense discounts", () => {
    for (const d of [{ type: "percent", value: 0 }, { type: "percent", value: 100.01 }, { type: "percent", value: -1 }, { type: "fixed", value: 0 }, { type: "fixed", value: -3 }, { type: "fixed", value: Infinity }, { type: "fixed", value: NaN }, { type: "bogus", value: 1 }]) {
      assert.throws(() => priceSale([L(10, 1)], d), { code: "INVALID_DISCOUNT" }, JSON.stringify(d));
    }
  });
  it("sub-cent results round to whole cents per line", () => assert.equal(priceSale([L(0.99, 1, 13)]).tax, 0.13));
});

describe("allocate", () => {
  it("always sums to the total", () => {
    for (const [t, w] of [[100, [1, 1, 1]], [7, [1, 1]], [1, [5, 5, 5]], [0, [1, 2]], [99, [0, 0, 0]], [1000, [333, 333, 334]]]) {
      const a = allocate(t, w);
      assert.equal(a.reduce((x, y) => x + y, 0), w.every((x) => x === 0) ? 0 : t, JSON.stringify([t, w]));
      assert.ok(a.every((x) => x >= 0 && Number.isInteger(x)));
    }
  });
});

describe("settle", () => {
  it("cash: change is received − total (the Rs. 850 / 1000 / 150 example)", () => assert.deepEqual(settle({ method: "cash", total: 850, amountReceived: 1000 }), { received: 1000, change: 150 }));
  it("exact cash gives no change", () => assert.deepEqual(settle({ method: "cash", total: 850, amountReceived: 850 }), { received: 850, change: 0 }));
  it("insufficient or missing cash is refused", () => {
    assert.throws(() => settle({ method: "cash", total: 850, amountReceived: 849.99 }), { code: "INSUFFICIENT_PAYMENT" });
    assert.throws(() => settle({ method: "cash", total: 850 }), { code: "INSUFFICIENT_PAYMENT" });
  });
  it("a zero total needs no cash; card/upi are always exact", () => {
    assert.deepEqual(settle({ method: "cash", total: 0 }), { received: 0, change: 0 });
    assert.deepEqual(settle({ method: "upi", total: 12.5, amountReceived: 999 }), { received: 12.5, change: 0 });
  });
});
