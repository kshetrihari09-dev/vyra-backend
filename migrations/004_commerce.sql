-- Phase 3: addresses, coupons, orders, order items/history, wishlist.
-- Stock CHANGES here are limited to what order placement/fulfilment needs (reserve → allocate+deduct → release);
-- adjustments, transfers, receiving and purchase orders are still Phase 4.

CREATE TABLE addresses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label          text NOT NULL DEFAULT 'Address',
  name           text NOT NULL,
  phone          text NOT NULL,
  line1          text NOT NULL,
  line2          text,
  city           text,
  zip            text,
  province_id    text,
  district_id    text,
  municipality_id text,
  ward           text,
  instructions   text,
  is_default     boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX addresses_user_idx ON addresses (user_id);
-- Only one default address per user (partial unique index, since "default" is a per-user flag not a global one).
CREATE UNIQUE INDEX addresses_one_default ON addresses (user_id) WHERE is_default;
CREATE TRIGGER addresses_set_updated_at BEFORE UPDATE ON addresses FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE coupons (
  code              text PRIMARY KEY CHECK (code = upper(code)),
  label             text NOT NULL,
  type              text NOT NULL CHECK (type IN ('percent', 'fixed')),
  value             numeric(12,2) NOT NULL CHECK (value > 0),
  max_discount      numeric(12,2) CHECK (max_discount IS NULL OR max_discount > 0),
  min_order         numeric(12,2) NOT NULL DEFAULT 0 CHECK (min_order >= 0),
  scope_type        text NOT NULL DEFAULT 'all' CHECK (scope_type IN ('all', 'category', 'brand')),
  scope_id          text,
  first_order_only  boolean NOT NULL DEFAULT false,
  starts_at         timestamptz,
  ends_at           timestamptz,
  usage_limit       integer CHECK (usage_limit IS NULL OR usage_limit > 0),
  per_customer_limit integer NOT NULL DEFAULT 1 CHECK (per_customer_limit > 0),
  times_used        integer NOT NULL DEFAULT 0 CHECK (times_used >= 0),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  is_demo           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (scope_type = 'all' OR scope_id IS NOT NULL)
);

-- One order per order per coupon; drives the per-customer limit (count of this user's rows for the code).
CREATE TABLE coupon_redemptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_code text NOT NULL REFERENCES coupons(code) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id    uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (coupon_code, order_id)
);
CREATE INDEX coupon_redemptions_user_idx ON coupon_redemptions (coupon_code, user_id);

CREATE TABLE orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number           text NOT NULL UNIQUE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  branch_id        text NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  status           text NOT NULL DEFAULT 'placed'
                     CHECK (status IN ('placed', 'confirmed', 'preparing', 'packed', 'assigned', 'out_for_delivery', 'delivered', 'cancelled', 'returned')),
  payment_method   text NOT NULL,
  payment_status   text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'refunded', 'not_collected')),
  -- Snapshot: survives the customer later editing or deleting the address. address_id is kept only for reference.
  address_id       uuid REFERENCES addresses(id) ON DELETE SET NULL,
  address          jsonb NOT NULL,
  delivery_option_id text NOT NULL,
  delivery_fee     numeric(12,2) NOT NULL DEFAULT 0,
  slot             text,
  subtotal         numeric(12,2) NOT NULL,
  discount         numeric(12,2) NOT NULL DEFAULT 0,
  tax              numeric(12,2) NOT NULL DEFAULT 0,
  total            numeric(12,2) NOT NULL,
  coupon_code      text REFERENCES coupons(code),
  notes            text,
  instructions     text,
  -- Delivery hand-off code shown to the customer, who reads it to the rider. Kept in plain form (like the
  -- prototype) because it must be re-displayed throughout delivery; it is only ever returned to the order's
  -- owner or a rider with delivery:rider, never in staff listings. A hash-only + reveal-once design is a
  -- reasonable Phase 7 hardening if wanted.
  otp              text,
  otp_required     boolean NOT NULL DEFAULT true,
  partner          jsonb,
  eta              timestamptz,
  delivered_at     timestamptz,
  cancelled_at     timestamptz,
  cancel_reason    text,
  returned_at      timestamptz,
  is_demo          boolean NOT NULL DEFAULT false,
  placed_at        timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_user_idx ON orders (user_id, placed_at DESC);
CREATE INDEX orders_status_idx ON orders (status);
CREATE TRIGGER orders_set_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE order_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id            text NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  variant_id            text,
  seller_id             text,
  -- Snapshots at purchase time — the product may change name/price/tax later.
  name                  text NOT NULL,
  unit_price            numeric(12,2) NOT NULL,
  tax_percent           numeric(5,2) NOT NULL DEFAULT 0,
  qty                   integer NOT NULL CHECK (qty > 0),
  line_total            numeric(12,2) NOT NULL,
  prescription_required boolean NOT NULL DEFAULT false
);
CREATE INDEX order_items_order_idx ON order_items (order_id);
CREATE INDEX order_items_product_idx ON order_items (product_id);

CREATE TABLE order_status_history (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status     text NOT NULL,
  note       text,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_status_history_order_idx ON order_status_history (order_id, at);

CREATE TABLE wishlist_items (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);
