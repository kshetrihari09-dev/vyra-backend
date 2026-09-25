-- Phase 2 (read model): stores, branches and the stock the catalogue displays.
-- Only what the storefront needs to SHOW availability lives here. Everything that CHANGES stock (adjustments,
-- transfers, receiving, reservations, movements, FEFO allocation) is Phase 4 and extends these tables.

-- A store is a business that sells (Vyra itself, and later each approved seller); a branch is a physical
-- fulfilment location. The prototype's "store-01 / store-02" are branches of the Vyra store.
CREATE TABLE stores (
  id         text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name       text NOT NULL,
  kind       text NOT NULL DEFAULT 'own' CHECK (kind IN ('own', 'seller')),
  seller_id  text,
  is_demo    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id                 text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  store_id           text NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  name               text NOT NULL,
  code               text NOT NULL UNIQUE,
  address            text,
  city               text,
  distance_km        numeric(6,2),
  eta_minutes        integer,
  is_open            boolean NOT NULL DEFAULT true,
  hours              text,
  phone              text,
  pharmacist_on_duty boolean NOT NULL DEFAULT false,
  otp_required       boolean NOT NULL DEFAULT true,
  is_active          boolean NOT NULL DEFAULT true,
  sort_order         integer NOT NULL DEFAULT 0,
  is_demo            boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX branches_store_idx ON branches (store_id);

-- One row per (branch, product) — or per (branch, product, variant) for products that have variants.
CREATE TABLE inventory (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id     text NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  product_id    text NOT NULL,
  variant_id    text,
  on_hand       integer NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved      integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  reorder_level integer NOT NULL DEFAULT 10 CHECK (reorder_level >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id, variant_id) REFERENCES product_variants(product_id, id) ON DELETE RESTRICT,
  CHECK (reserved <= on_hand)
);
CREATE UNIQUE INDEX inventory_key ON inventory (branch_id, product_id, COALESCE(variant_id, ''));
CREATE INDEX inventory_product_idx ON inventory (product_id);
CREATE TRIGGER inventory_set_updated_at BEFORE UPDATE ON inventory FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Batch / expiry sub-ledger for medicines. `is_legacy_opening` marks quantity imported from the prototype that
-- had no batch or expiry: it counts towards on-hand but is NEVER sold by FEFO until a pharmacist assigns a real batch.
CREATE TABLE inventory_batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id         text NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  product_id        text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id        text,
  batch_no          text NOT NULL,
  expiry_date       date,
  purchase_cost     numeric(12,4) CHECK (purchase_cost IS NULL OR purchase_cost >= 0),
  selling_price     numeric(12,2) CHECK (selling_price IS NULL OR selling_price >= 0),
  qty               integer NOT NULL CHECK (qty >= 0),
  supplier_id       text,
  is_legacy_opening boolean NOT NULL DEFAULT false,
  received_at       timestamptz NOT NULL DEFAULT now(),
  is_demo           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (is_legacy_opening OR expiry_date IS NOT NULL)
);
CREATE UNIQUE INDEX inventory_batches_key ON inventory_batches (branch_id, product_id, COALESCE(variant_id, ''), batch_no);
CREATE INDEX inventory_batches_fefo_idx ON inventory_batches (product_id, branch_id, expiry_date) WHERE NOT is_legacy_opening AND qty > 0;
