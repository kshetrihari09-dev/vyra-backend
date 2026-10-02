-- Order-flow consistency fixes.
--
-- 1. Collision-safe order numbers. The old generator was `PN-<MMDD><random 4 digits>`, so two orders placed on the
--    same day could draw the same suffix (the UNIQUE constraint on orders.number turned that into a failed checkout).
--    Numbers now come from a database sequence — nextval() is atomic across concurrent transactions and never hands the
--    same value out twice — formatted by the repository as `PN-YYYYMMDD-NNNNNN` (e.g. PN-20261001-000001).
--    Existing orders keep their old numbers; the two formats can never collide because the new one contains a dash.
--
--    orders.number has been `UNIQUE` since 004_commerce.sql (index `orders_number_key`); the DO block below only
--    re-asserts that, so a database that somehow lost it fails loudly here instead of silently allowing duplicates.
CREATE SEQUENCE IF NOT EXISTS order_number_seq AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (i.indkey)
     WHERE t.relname = 'orders' AND i.indisunique AND a.attname = 'number' AND i.indnatts = 1
  ) THEN
    CREATE UNIQUE INDEX orders_number_unique_idx ON orders (number);
  END IF;
END $$;

-- 2. Sellers now list / act on the orders that contain their products (a shop owner's orders were previously only ever
--    reachable through local React state). The lookup is "orders having a line for seller X".
CREATE INDEX IF NOT EXISTS order_items_seller_idx ON order_items (seller_id) WHERE seller_id IS NOT NULL;

-- 3. A cancelled order that had a captured payment queues one refund for the remainder. Guard against queueing two
--    pending refunds for the same payment through different routes (customer request + cancel-time refund).
--    NOTE: this only constrains rows that are *pending*; completed / rejected refunds are history and unrestricted.
CREATE UNIQUE INDEX IF NOT EXISTS refunds_one_pending_per_payment ON refunds (payment_id) WHERE status = 'pending';
