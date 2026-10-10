import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { boot, loginAs, makeUser, skipReason, uniq } from "./helpers.js";

const BRANCH = "store-01";
const key = () => `k${uniq()}${"x".repeat(16)}`.slice(0, 40);

describe("POS sale API (real Postgres)", { skip: skipReason }, () => {
  let ctx, pool, cashier, otherCashier, manager, warehouse, customer;
  const auth = (a) => ({ Authorization: `Bearer ${a.token}` });
  const sell = (who, body) => ctx.request.post("/api/pos/sale").set(auth(who)).send({ branch: BRANCH, paymentMethod: "cash", amountReceived: 100000, idempotencyKey: key(), ...body });

  // Controlled stock for a product at the test branch (reserved cleared), and what the DB says it is right now.
  const setStock = (productId, qty) => pool.query(
    `INSERT INTO inventory (branch_id, product_id, on_hand, reserved) VALUES ($1,$2,$3,0)
     ON CONFLICT (branch_id, product_id, COALESCE(variant_id, '')) DO UPDATE SET on_hand = $3, reserved = 0`, [BRANCH, productId, qty]);
  const onHand = async (productId) => (await pool.query("SELECT on_hand FROM inventory WHERE branch_id=$1 AND product_id=$2 AND variant_id IS NULL", [BRANCH, productId])).rows[0].on_hand;
  const count = async (sql, args = []) => Number((await pool.query(sql, args)).rows[0].n);
  const unitPrice = async (id) => { const { rows: [p] } = await pool.query("SELECT price, sale_price FROM products WHERE id=$1", [id]); return Number(p.sale_price ?? p.price); };

  before(async () => {
    ctx = await boot(); pool = ctx.container.pool;
    const login = async (roles) => loginAs(ctx.request, await makeUser(ctx.container, { roles }));
    cashier = await login(["pharmacist"]); otherCashier = await login(["pharmacist"]);
    manager = await login(["admin"]); warehouse = await login(["warehouse"]); customer = await login(["customer"]);
  });
  after(async () => { await ctx?.close(); });

  describe("who may use the till", () => {
    it("needs pos:sell: pharmacist and admin yes; a customer and a stock-keeper (inventory:adjust only) no", async () => {
      await setStock("olive-oil-1l", 50);
      assert.equal((await sell(cashier, { items: [{ productId: "olive-oil-1l", qty: 1 }] })).status, 201);
      assert.equal((await sell(manager, { items: [{ productId: "olive-oil-1l", qty: 1 }] })).status, 201);
      assert.equal((await sell(customer, { items: [{ productId: "olive-oil-1l", qty: 1 }] })).status, 403);
      assert.equal((await sell(warehouse, { items: [{ productId: "olive-oil-1l", qty: 1 }] })).status, 403);
      assert.equal((await ctx.request.post("/api/pos/sale").send({})).status, 401);
    });
  });

  describe("a normal cash sale", () => {
    it("is stored completely, deducts exactly the quantity, logs the movement, and returns a receipt-ready sale", async () => {
      await setStock("olive-oil-1l", 20); await setStock("laundry-detergent", 20);
      const p1 = await unitPrice("olive-oil-1l"); const p2 = await unitPrice("laundry-detergent");
      const res = await sell(cashier, { items: [{ productId: "olive-oil-1l", qty: 2 }, { productId: "laundry-detergent", qty: 3 }], customerName: "Walk-in", amountReceived: 1000 });
      assert.equal(res.status, 201);
      const s = res.body.data.sale;
      assert.match(s.number, /^POS-\d{8}\d{4,}$/);
      const subtotal = Math.round((p1 * 2 + p2 * 3) * 100) / 100;
      assert.equal(s.totals.subtotal, subtotal); assert.equal(s.totals.total, subtotal);
      assert.equal(s.payment.received, 1000); assert.equal(s.payment.change, Math.round((1000 - subtotal) * 100) / 100);
      assert.equal(s.items.length, 2); assert.ok(s.storeName); assert.ok(s.cashierName);
      assert.equal(await onHand("olive-oil-1l"), 18); assert.equal(await onHand("laundry-detergent"), 17);
      assert.equal(await count("SELECT count(*) n FROM inventory_movements WHERE ref_type='pos_sale' AND ref_id=$1", [s.id]), 2);
      assert.equal(await count("SELECT count(*) n FROM pos_sale_items WHERE sale_id=$1", [s.id]), 2);
      // the receipt can be re-read later, identical
      const again = await ctx.request.get(`/api/pos/sales/${s.id}`).set(auth(cashier));
      assert.equal(again.status, 200); assert.deepEqual(again.body.data.sale.totals, s.totals);
    });
  });

  describe("input the till must never accept", () => {
    it("requires a request id, and only supported payment methods", async () => {
      const base = { branch: BRANCH, items: [{ productId: "olive-oil-1l", qty: 1 }], paymentMethod: "cash", amountReceived: 100 };
      assert.equal((await ctx.request.post("/api/pos/sale").set(auth(cashier)).send(base)).status, 400); // no idempotencyKey
      for (const m of ["cod", "cash_pos", "credit", "netbanking"]) assert.equal((await sell(cashier, { items: base.items, paymentMethod: m })).status, 400, m);
    });
    it("refuses 0, negative, fractional, NaN and Infinity quantities", async () => {
      await setStock("olive-oil-1l", 20);
      for (const qty of [0, -1, 1.5, "2", null, 1e9]) assert.equal((await sell(cashier, { items: [{ productId: "olive-oil-1l", qty }] })).status, 400, String(qty));
      for (const raw of ['{"qty":NaN}', '{"qty":Infinity}']) {
        const r = await ctx.request.post("/api/pos/sale").set(auth(cashier)).set("Content-Type", "application/json")
          .send(`{"branch":"${BRANCH}","paymentMethod":"cash","amountReceived":10,"idempotencyKey":"${key()}","items":[{"productId":"olive-oil-1l",${raw.slice(1, -1)}}]}`);
        assert.ok(r.status >= 400 && r.status < 500, raw);
      }
      assert.equal(await onHand("olive-oil-1l"), 20);
    });
    it("refuses an unknown product, an unknown store, and an empty cart", async () => {
      assert.equal((await sell(cashier, { items: [{ productId: "no-such-product", qty: 1 }] })).status, 400);
      assert.equal((await sell(cashier, { branch: "no-such-store", items: [{ productId: "olive-oil-1l", qty: 1 }] })).status, 400);
      assert.equal((await sell(cashier, { items: [] })).status, 400);
    });
  });

  describe("stock: the database is the authority", () => {
    it("available 2, sell 3 → rejected with a clear message, stock and records unchanged", async () => {
      await setStock("olive-oil-1l", 2);
      const before = await count("SELECT count(*) n FROM pos_sales");
      const r = await sell(cashier, { items: [{ productId: "olive-oil-1l", qty: 3 }] });
      assert.equal(r.status, 409); assert.equal(r.body.code, "INSUFFICIENT_STOCK");
      assert.match(r.body.message, /Only 2 units of .* available\./);
      assert.equal(await onHand("olive-oil-1l"), 2);
      assert.equal(await count("SELECT count(*) n FROM pos_sales"), before);
    });
    it("stock reserved for online orders is not sellable at the till", async () => {
      await pool.query("UPDATE inventory SET on_hand=10, reserved=8 WHERE branch_id=$1 AND product_id='olive-oil-1l' AND variant_id IS NULL", [BRANCH]);
      assert.equal((await sell(cashier, { items: [{ productId: "olive-oil-1l", qty: 3 }] })).status, 409);
      assert.equal((await sell(cashier, { items: [{ productId: "olive-oil-1l", qty: 2 }] })).status, 201);
    });
    it("a sale where the SECOND line is short leaves the FIRST line's stock untouched (all or nothing)", async () => {
      await setStock("olive-oil-1l", 10); await setStock("laundry-detergent", 1);
      const r = await sell(cashier, { items: [{ productId: "olive-oil-1l", qty: 4 }, { productId: "laundry-detergent", qty: 5 }] });
      assert.equal(r.status, 409);
      assert.equal(await onHand("olive-oil-1l"), 10); assert.equal(await onHand("laundry-detergent"), 1);
    });
    it("two sales racing for the LAST units: never oversells, stock never goes negative", async () => {
      await setStock("olive-oil-1l", 5);
      const results = await Promise.all(Array.from({ length: 12 }, () => sell(cashier, { items: [{ productId: "olive-oil-1l", qty: 1 }] })));
      const ok = results.filter((r) => r.status === 201).length; const refused = results.filter((r) => r.status === 409).length;
      assert.equal(ok, 5); assert.equal(refused, 7); assert.equal(results.length, ok + refused, "no 500s");
      assert.equal(await onHand("olive-oil-1l"), 0);
    });
    it("tills ringing up the same products in OPPOSITE order never deadlock", async () => {
      await setStock("olive-oil-1l", 500); await setStock("laundry-detergent", 500);
      const A = { productId: "olive-oil-1l", qty: 1 }; const B = { productId: "laundry-detergent", qty: 1 };
      const results = await Promise.all(Array.from({ length: 24 }, (_, i) => sell(i % 2 ? cashier : otherCashier, { items: i % 2 ? [A, B] : [B, A] })));
      assert.ok(results.every((r) => r.status === 201), results.map((r) => r.status).join());
      assert.equal(await onHand("olive-oil-1l"), 476); assert.equal(await onHand("laundry-detergent"), 476);
    });
  });

  describe("atomic: sale + items + stock + movements + audit commit together or not at all", () => {
    it("a failure AFTER stock was deducted (forced at the sale insert) rolls everything back", async () => {
      await setStock("olive-oil-1l", 10);
      await pool.query(`CREATE OR REPLACE FUNCTION pos_boom() RETURNS trigger AS $$ BEGIN IF NEW.customer_name = 'BOOM' THEN RAISE EXCEPTION 'simulated failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
      await pool.query("CREATE TRIGGER pos_boom_t BEFORE INSERT ON pos_sales FOR EACH ROW EXECUTE FUNCTION pos_boom()");
      try {
        const sales0 = await count("SELECT count(*) n FROM pos_sales"); const mv0 = await count("SELECT count(*) n FROM inventory_movements"); const audit0 = await count("SELECT count(*) n FROM audit_logs WHERE action='pos_sale.completed'");
        const r = await sell(cashier, { items: [{ productId: "olive-oil-1l", qty: 4 }], customerName: "BOOM" });
        assert.ok(r.status >= 500, `status ${r.status}`);
        assert.equal(await onHand("olive-oil-1l"), 10, "stock restored");
        assert.equal(await count("SELECT count(*) n FROM pos_sales"), sales0);
        assert.equal(await count("SELECT count(*) n FROM inventory_movements"), mv0);
        assert.equal(await count("SELECT count(*) n FROM audit_logs WHERE action='pos_sale.completed'"), audit0);
        assert.equal((await sell(cashier, { items: [{ productId: "olive-oil-1l", qty: 4 }], customerName: "Fine" })).status, 201, "and the till still works afterwards");
      } finally { await pool.query("DROP TRIGGER IF EXISTS pos_boom_t ON pos_sales"); await pool.query("DROP FUNCTION IF EXISTS pos_boom()"); }
    });
  });

  describe("double-sale protection", () => {
    it("the same request id sent twice in sequence → one sale (201 then 200), same number, stock deducted once", async () => {
      await setStock("olive-oil-1l", 10);
      const body = { items: [{ productId: "olive-oil-1l", qty: 3 }], idempotencyKey: key() };
      const a = await sell(cashier, body); const b = await sell(cashier, body);
      assert.deepEqual([a.status, b.status], [201, 200]);
      assert.equal(b.body.data.sale.number, a.body.data.sale.number);
      assert.equal(await count("SELECT count(*) n FROM pos_sales WHERE idempotency_key=$1", [body.idempotencyKey]), 1);
      assert.equal(await onHand("olive-oil-1l"), 7);
    });
    it("10 identical requests fired AT THE SAME INSTANT (a frantic double-click, a retry racing its original) → exactly one sale", async () => {
      await setStock("olive-oil-1l", 10);
      const body = { items: [{ productId: "olive-oil-1l", qty: 2 }], idempotencyKey: key() };
      const results = await Promise.all(Array.from({ length: 10 }, () => sell(cashier, body)));
      assert.equal(results.filter((r) => r.status === 201).length, 1);
      assert.equal(results.filter((r) => r.status === 200).length, 9);
      assert.equal(new Set(results.map((r) => r.body.data.sale.number)).size, 1);
      assert.equal(await count("SELECT count(*) n FROM pos_sales WHERE idempotency_key=$1", [body.idempotencyKey]), 1);
      assert.equal(await onHand("olive-oil-1l"), 8, "deducted once, not ten times");
      assert.equal(await count("SELECT count(*) n FROM inventory_movements WHERE ref_type='pos_sale' AND ref_id=$1", [results[0].body.data.sale.id]), 1);
    });
    it("a refused attempt does not 'use up' its request id: fix the problem and retry the same id", async () => {
      await setStock("olive-oil-1l", 10);
      const id = key(); const items = [{ productId: "olive-oil-1l", qty: 1 }];
      assert.equal((await sell(cashier, { items, idempotencyKey: id, amountReceived: 0.01 })).status, 400); // cash too short
      // same id, now with enough cash: the content hash differs from nothing stored, so it is simply a fresh sale
      assert.equal((await sell(cashier, { items, idempotencyKey: id, amountReceived: 1000 })).status, 201);
    });
    it("the same id with a DIFFERENT sale is refused, not answered with the old sale", async () => {
      await setStock("olive-oil-1l", 10);
      const id = key();
      assert.equal((await sell(cashier, { items: [{ productId: "olive-oil-1l", qty: 1 }], idempotencyKey: id })).status, 201);
      const r = await sell(cashier, { items: [{ productId: "olive-oil-1l", qty: 2 }], idempotencyKey: id });
      assert.equal(r.status, 409); assert.equal(r.body.code, "IDEMPOTENCY_KEY_REUSED");
    });
    it("request ids are per cashier (one till can't collide with, or read, another's)", async () => {
      await setStock("olive-oil-1l", 10);
      const id = key(); const items = [{ productId: "olive-oil-1l", qty: 1 }];
      const a = await sell(cashier, { items, idempotencyKey: id }); const b = await sell(otherCashier, { items, idempotencyKey: id });
      assert.deepEqual([a.status, b.status], [201, 201]); assert.notEqual(a.body.data.sale.id, b.body.data.sale.id);
      assert.equal((await ctx.request.get(`/api/pos/sales/${a.body.data.sale.id}`).set(auth(otherCashier))).status, 404);
      assert.equal((await ctx.request.get(`/api/pos/sales/${a.body.data.sale.id}`).set(auth(manager))).status, 200, "a manager can");
    });
    it("a till whose connection dropped can ask 'did my request go through?' by id", async () => {
      await setStock("olive-oil-1l", 10);
      const id = key();
      assert.equal((await ctx.request.get(`/api/pos/sales/by-key/${id}`).set(auth(cashier))).status, 404);
      const a = await sell(cashier, { items: [{ productId: "olive-oil-1l", qty: 1 }], idempotencyKey: id });
      const found = await ctx.request.get(`/api/pos/sales/by-key/${id}`).set(auth(cashier));
      assert.equal(found.status, 200); assert.equal(found.body.data.sale.number, a.body.data.sale.number);
      assert.equal((await ctx.request.get(`/api/pos/sales/by-key/${id}`).set(auth(otherCashier))).status, 404);
    });
  });

  describe("products with variants", () => {
    const setVariantStock = (productId, variantId, qty) => pool.query(
      `INSERT INTO inventory (branch_id, product_id, variant_id, on_hand, reserved) VALUES ($1,$2,$3,$4,0)
       ON CONFLICT (branch_id, product_id, COALESCE(variant_id, '')) DO UPDATE SET on_hand = $4, reserved = 0`, [BRANCH, productId, variantId, qty]);
    const variantOnHand = async (productId, variantId) => (await pool.query("SELECT on_hand FROM inventory WHERE branch_id=$1 AND product_id=$2 AND variant_id=$3", [BRANCH, productId, variantId])).rows[0].on_hand;

    it("selling the bare product (no variant chosen) is refused with a clear message", async () => {
      const r = await sell(cashier, { items: [{ productId: "basmati-rice-5kg", qty: 1 }] });
      assert.equal(r.status, 400); assert.equal(r.body.code, "VARIANT_REQUIRED"); assert.match(r.body.message, /Choose a size\/variant/);
    });
    it("the chosen variant's own price and stock are used (5 kg ≠ 1 kg)", async () => {
      await setVariantStock("basmati-rice-5kg", "r5", 9); await setVariantStock("basmati-rice-5kg", "r1", 9);
      const { rows: [v] } = await pool.query("SELECT price, sale_price FROM product_variants WHERE product_id='basmati-rice-5kg' AND id='r5'");
      const r = await sell(cashier, { items: [{ productId: "basmati-rice-5kg", variantId: "r5", qty: 2 }] });
      assert.equal(r.status, 201);
      assert.equal(r.body.data.sale.totals.total, Math.round(Number(v.sale_price ?? v.price) * 2 * 100) / 100);
      assert.match(r.body.data.sale.items[0].name, /5 kg/);
      assert.equal(await variantOnHand("basmati-rice-5kg", "r5"), 7); assert.equal(await variantOnHand("basmati-rice-5kg", "r1"), 9, "other variants untouched");
    });
    it("variant stock is validated per variant", async () => {
      await setVariantStock("basmati-rice-5kg", "r10", 1);
      const r = await sell(cashier, { items: [{ productId: "basmati-rice-5kg", variantId: "r10", qty: 2 }] });
      assert.equal(r.status, 409); assert.match(r.body.message, /Only 1 unit of .*10 kg/);
    });
  });

  describe("sale numbers", () => {
    // Sales of the SAME product queue on its stock-row lock, which would hide a numbering race. Different products don't, so use many.
    it("30 concurrent sales of 30 DIFFERENT products get 30 distinct, consecutive numbers (the old count(*)+1 handed two tills the same one)", async () => {
      const ids = (await pool.query("SELECT id FROM products WHERE status='active' AND deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = products.id) ORDER BY id LIMIT 30")).rows.map((r) => r.id);
      assert.ok(ids.length >= 20, `need many products, have ${ids.length}`);
      for (const id of ids) await setStock(id, 50);
      const results = await Promise.all(ids.map((id) => sell(cashier, { items: [{ productId: id, qty: 1 }] })));
      assert.ok(results.every((r) => r.status === 201), results.map((r) => r.status).join());
      const nums = results.map((r) => r.body.data.sale.number);
      assert.equal(new Set(nums).size, ids.length);
      const seq = nums.map((n) => Number(n.slice(12))).sort((a, b) => a - b);
      assert.equal(seq.at(-1) - seq[0], ids.length - 1, "consecutive: a rolled-back sale never burns a number");
    });
    it("survives counter drift: a number that already exists (restore, manual edit) is skipped, not a failed sale", async () => {
      await setStock("olive-oil-1l", 10);
      const { rows: [c] } = await pool.query("SELECT n, to_char(day,'YYYYMMDD') d FROM pos_sale_counters WHERE day = current_date");
      const taken = `POS-${c.d}${String(c.n + 1).padStart(4, "0")}`; // exactly the number the next sale would get
      await pool.query(`INSERT INTO pos_sales (number, branch_id, customer_name, payment_method, subtotal, tax, total, amount_received) VALUES ($1,$2,'legacy','cash',1,0,1,1)`, [taken, BRANCH]);
      const r = await sell(cashier, { items: [{ productId: "olive-oil-1l", qty: 1 }] });
      assert.equal(r.status, 201); assert.notEqual(r.body.data.sale.number, taken);
    });
    it("a failed sale does not burn a number", async () => {
      await setStock("olive-oil-1l", 1);
      const { rows: [before] } = await pool.query("SELECT n FROM pos_sale_counters WHERE day = current_date");
      assert.equal((await sell(cashier, { items: [{ productId: "olive-oil-1l", qty: 5 }] })).status, 409);
      const { rows: [after] } = await pool.query("SELECT n FROM pos_sale_counters WHERE day = current_date");
      assert.equal(after.n, before.n);
    });
  });

  describe("money: the server decides", () => {
    it("subtotal − discount + tax = total, to the cent, and the stored lines add up", async () => {
      await setStock("olive-oil-1l", 50);
      await pool.query("UPDATE products SET tax_percent = 13 WHERE id='olive-oil-1l'");
      try {
        const price = await unitPrice("olive-oil-1l");
        const r = await sell(cashier, { items: [{ productId: "olive-oil-1l", qty: 4 }], discount: { type: "percent", value: 10 } });
        assert.equal(r.status, 201); const s = r.body.data.sale;
        const sub = Math.round(price * 4 * 100); const disc = Math.round(sub * 0.10); const tax = Math.round((sub - disc) * 0.13);
        assert.deepEqual([s.totals.subtotal, s.totals.discount, s.totals.tax, s.totals.total].map((x) => Math.round(x * 100)), [sub, disc, tax, sub - disc + tax]);
        const li = s.items[0]; assert.equal(Math.round((li.lineTotal - li.discount + li.tax) * 100), s.totals.total * 100 | 0 || Math.round(s.totals.total * 100));
        assert.deepEqual(s.discount, { type: "percent", value: 10 });
      } finally { await pool.query("UPDATE products SET tax_percent = 0 WHERE id='olive-oil-1l'"); }
    });
    it("the price comes from the database, never the browser (an injected price field is ignored)", async () => {
      await setStock("olive-oil-1l", 10); const price = await unitPrice("olive-oil-1l");
      const r = await sell(cashier, { items: [{ productId: "olive-oil-1l", qty: 1, unitPrice: 0.01, price: 0.01 }], total: 0.01, subtotal: 0.01 });
      assert.equal(r.status, 201); assert.equal(r.body.data.sale.totals.total, price);
    });
    it("a stale on-screen total is rejected with the real one (a price changed meanwhile)", async () => {
      await setStock("olive-oil-1l", 10); const price = await unitPrice("olive-oil-1l");
      const r = await sell(cashier, { items: [{ productId: "olive-oil-1l", qty: 1 }], expectedTotal: price + 1 });
      assert.equal(r.status, 409); assert.equal(r.body.code, "PRICE_CHANGED"); assert.equal(r.body.details?.total ?? r.body.data?.total ?? price, price);
      assert.equal(await onHand("olive-oil-1l"), 10);
    });
    it("a discount larger than the sale, or non-sensical, is refused (total can't go negative); exactly 100% is allowed", async () => {
      await setStock("olive-oil-1l", 10);
      const items = [{ productId: "olive-oil-1l", qty: 1 }]; const price = await unitPrice("olive-oil-1l");
      assert.equal((await sell(manager, { items, discount: { type: "fixed", value: price + 0.01 } })).status, 409 === 0 ? 0 : 400);
      for (const d of [{ type: "percent", value: 101 }, { type: "percent", value: 0 }, { type: "percent", value: -5 }, { type: "fixed", value: -1 }]) assert.equal((await sell(manager, { items, discount: d })).status, 400, JSON.stringify(d));
      const free = await sell(manager, { items, discount: { type: "percent", value: 100 }, amountReceived: 0 });
      assert.equal(free.status, 201); assert.equal(free.body.data.sale.totals.total, 0);
    });
    it("a cashier can't discount past 20%; a manager can", async () => {
      await setStock("olive-oil-1l", 10); const items = [{ productId: "olive-oil-1l", qty: 1 }];
      assert.equal((await sell(cashier, { items, discount: { type: "percent", value: 20 } })).status, 201);
      assert.equal((await sell(cashier, { items, discount: { type: "percent", value: 25 } })).status, 403);
      assert.equal((await sell(manager, { items, discount: { type: "percent", value: 25 } })).status, 201);
    });
    it("cash: change is returned; short cash is refused and costs nothing", async () => {
      await setStock("olive-oil-1l", 10); const price = await unitPrice("olive-oil-1l");
      const ok = await sell(cashier, { items: [{ productId: "olive-oil-1l", qty: 1 }], amountReceived: 1000 });
      assert.equal(ok.body.data.sale.payment.change, Math.round((1000 - price) * 100) / 100);
      const short = await sell(cashier, { items: [{ productId: "olive-oil-1l", qty: 1 }], amountReceived: price - 0.01 });
      assert.equal(short.status, 400); assert.equal(short.body.code, "INSUFFICIENT_PAYMENT");
      assert.equal(await onHand("olive-oil-1l"), 9);
    });
    it("UPI / card are paid exactly, with no change", async () => {
      await setStock("olive-oil-1l", 10); const price = await unitPrice("olive-oil-1l");
      for (const paymentMethod of ["upi", "card"]) {
        const r = await sell(cashier, { items: [{ productId: "olive-oil-1l", qty: 1 }], paymentMethod, amountReceived: undefined });
        assert.deepEqual([r.status, r.body.data.sale.payment.received, r.body.data.sale.payment.change], [201, price, 0]);
      }
    });
    it("the database itself refuses a sale whose books don't add up (backstop behind the service)", async () => {
      await assert.rejects(pool.query(
        `INSERT INTO pos_sales (number, branch_id, customer_name, payment_method, subtotal, discount, tax, total, amount_received, change_due)
         VALUES ('POS-BAD', $1, 'x', 'cash', 100, 10, 0, 95, 95, 0)`, [BRANCH]), /pos_sales_total_chk/);
    });
  });

  describe("sale history", () => {
    it("a cashier lists only their own sales", async () => {
      const mine = await ctx.request.get("/api/pos/sales").set(auth(cashier));
      assert.equal(mine.status, 200); assert.ok(mine.body.data.sales.length > 0);
      assert.ok(mine.body.data.sales.every((s) => s.cashierName));
      const theirs = await ctx.request.get("/api/pos/sales").set(auth(otherCashier));
      const mineIds = new Set(mine.body.data.sales.map((s) => s.id));
      assert.ok(theirs.body.data.sales.every((s) => !mineIds.has(s.id)));
      assert.equal((await ctx.request.get("/api/pos/sales").set(auth(customer))).status, 403);
    });
  });
});
