-- POS hardening: discounts, cash tendered/change, an idempotency key (a repeated request can never create a second sale),
-- race-free sale numbers, and enough per-line detail to reprint a receipt exactly as it was rung up.

ALTER TABLE pos_sales
  ADD COLUMN discount        numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  ADD COLUMN discount_type   text CHECK (discount_type IN ('percent', 'fixed')),
  ADD COLUMN discount_value  numeric(12,2),
  ADD COLUMN amount_received numeric(12,2),
  ADD COLUMN change_due      numeric(12,2) NOT NULL DEFAULT 0 CHECK (change_due >= 0),
  ADD COLUMN idempotency_key text,
  ADD COLUMN request_hash    text;

-- Sales rung up before this migration were paid in full by definition.
UPDATE pos_sales SET amount_received = total WHERE amount_received IS NULL;

-- The books must always add up. NOT VALID: enforced for every new/updated row without re-scanning (or failing on) history.
ALTER TABLE pos_sales ADD CONSTRAINT pos_sales_total_chk CHECK (total >= 0 AND total = subtotal - discount + tax) NOT VALID;
ALTER TABLE pos_sales ADD CONSTRAINT pos_sales_method_chk CHECK (payment_method IN ('cash', 'card', 'upi', 'cod', 'netbanking')) NOT VALID;

-- One request key per cashier → one sale. This is the database-level backstop behind the service's own check.
CREATE UNIQUE INDEX pos_sales_idem_idx ON pos_sales (cashier_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX pos_sales_cashier_idx ON pos_sales (cashier_id, created_at DESC);

ALTER TABLE pos_sale_items
  ADD COLUMN line_no     integer NOT NULL DEFAULT 0,
  ADD COLUMN tax_percent numeric(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN discount    numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  ADD COLUMN tax         numeric(12,2) NOT NULL DEFAULT 0 CHECK (tax >= 0);

-- Sale numbers: one counter row per day, bumped inside the sale's own transaction (so a rolled-back sale never burns a number, and two
-- tills can't be handed the same one — the old count(*)+1 could, and lpad() would have truncated at 10,000 sales a day).
CREATE TABLE pos_sale_counters (
  day date PRIMARY KEY,
  n   integer NOT NULL CHECK (n >= 0)
);
-- Seed each day's counter from the HIGHEST number already issued that day (not count(*): if a sale was ever deleted, count < max and the next
-- number would collide). Numbers look like POS-YYYYMMDDNNNN; anything not in that shape is ignored.
INSERT INTO pos_sale_counters (day, n)
SELECT to_date(substr(number, 5, 8), 'YYYYMMDD'), max(substr(number, 13)::integer)
  FROM pos_sales WHERE number ~ '^POS-[0-9]{8}[0-9]+$'
 GROUP BY 1;
