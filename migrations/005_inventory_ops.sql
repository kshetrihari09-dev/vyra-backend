-- Phase 4: everything that actually CHANGES stock outside an order (adjustments, transfers, receiving, POS
-- sales), plus a movements ledger recording every change from any source, including the order fulfilment paths
-- Phase 3 already built (packed/cancelled).

CREATE TABLE inventory_movements (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id  text NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  product_id text NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  variant_id text,
  delta      integer NOT NULL,
  prev_qty   integer NOT NULL,
  new_qty    integer NOT NULL,
  reason     text NOT NULL,
  batch_no   text,
  ref_type   text NOT NULL CHECK (ref_type IN ('adjustment', 'transfer', 'receiving', 'pos_sale', 'order_packed', 'order_cancelled')),
  ref_id     text,
  actor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_movements_product_idx ON inventory_movements (product_id, at DESC);
CREATE INDEX inventory_movements_branch_idx ON inventory_movements (branch_id, at DESC);

CREATE TABLE suppliers (
  id         text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name       text NOT NULL,
  contact    text,
  phone      text,
  email      text,
  terms      text,
  is_demo    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE purchase_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          text NOT NULL UNIQUE,
  supplier_id     text NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  branch_id       text NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  status          text NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered', 'received', 'cancelled')),
  invoice_number  text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  received_at     timestamptz
);

CREATE TABLE purchase_order_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id         uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id    text NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty           integer NOT NULL CHECK (qty > 0),
  purchase_price numeric(12,4) NOT NULL CHECK (purchase_price >= 0),
  batch_no      text,
  expiry_date   date
);
CREATE INDEX purchase_order_lines_po_idx ON purchase_order_lines (po_id);

-- A POS sale is already complete the moment it's rung up (no state machine, no reservation) — deliberately
-- separate from `orders`, which models a delivery/pickup lifecycle POS sales don't have.
CREATE TABLE pos_sales (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number         text NOT NULL UNIQUE,
  branch_id      text NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  cashier_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  customer_name  text,
  payment_method text NOT NULL,
  subtotal       numeric(12,2) NOT NULL,
  tax            numeric(12,2) NOT NULL DEFAULT 0,
  total          numeric(12,2) NOT NULL,
  is_demo        boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pos_sale_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id     uuid NOT NULL REFERENCES pos_sales(id) ON DELETE CASCADE,
  product_id  text NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  variant_id  text,
  name        text NOT NULL,
  unit_price  numeric(12,2) NOT NULL,
  qty         integer NOT NULL CHECK (qty > 0),
  line_total  numeric(12,2) NOT NULL,
  batch_no    text
);
CREATE INDEX pos_sale_items_sale_idx ON pos_sale_items (sale_id);
