-- Phase 7: delivery. Rider accounts, assignments (one active per order), an append-only event trail,
-- short-lived location points, and the delivery-OTP hardening flagged since Phase 3 (finding #7).

-- ---------------------------------------------------------------------------------------------------
-- Delivery OTP: stop storing the code. The code is now DERIVED on demand from (server key, order id,
-- per-order nonce) — see utils/deliveryCode.js — so a database dump alone does not reveal it, yet the
-- customer can still re-open the order and see it. Attempts are counted per order and lock at 5.
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN otp_nonce text;
ALTER TABLE orders ADD COLUMN otp_attempts integer NOT NULL DEFAULT 0 CHECK (otp_attempts >= 0);
-- Orders that already carry a plaintext code get a nonce; their code simply changes (it is derived on
-- read, so the customer sees the new one). Nothing is lost: the old value was only ever a hand-off secret.
UPDATE orders SET otp_nonce = replace(gen_random_uuid()::text, '-', '') WHERE otp_required AND otp_nonce IS NULL;
ALTER TABLE orders DROP COLUMN otp;

-- ---------------------------------------------------------------------------------------------------
-- Riders: a rider is a user holding the `delivery` role PLUS a row here (phone, vehicle, availability).
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE riders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  phone         text NOT NULL,
  vehicle       text NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  is_available  boolean NOT NULL DEFAULT false,
  is_demo       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER riders_set_updated_at BEFORE UPDATE ON riders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------------
-- Deliveries: one row per assignment attempt. An order can have several over its life (a declined
-- offer, a reassignment, a failed attempt) but only ONE can be active at a time — enforced by the DB.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  rider_id        uuid NOT NULL REFERENCES riders(id) ON DELETE RESTRICT,
  status          text NOT NULL CHECK (status IN ('assigned', 'accepted', 'picked_up', 'delivered', 'failed', 'cancelled')),
  assigned_by     uuid REFERENCES users(id) ON DELETE SET NULL, -- NULL when the rider claimed it themselves
  self_claimed    boolean NOT NULL DEFAULT false,
  accepted_at     timestamptz,
  picked_up_at    timestamptz,
  delivered_at    timestamptz,
  closed_at       timestamptz,
  failure_reason  text CHECK (failure_reason IS NULL OR failure_reason IN ('customer_unreachable', 'wrong_address', 'customer_refused', 'unsafe_location', 'other')),
  failure_note    text,
  cancel_reason   text,
  cash_collected  numeric(12,2) CHECK (cash_collected IS NULL OR cash_collected >= 0),
  -- Latest known position only while the run is live; cleared (with the trail) once it ends.
  last_lat        double precision CHECK (last_lat IS NULL OR last_lat BETWEEN -90 AND 90),
  last_lng        double precision CHECK (last_lng IS NULL OR last_lng BETWEEN -180 AND 180),
  last_accuracy   real,
  last_located_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX deliveries_one_active_per_order ON deliveries (order_id) WHERE status IN ('assigned', 'accepted', 'picked_up');
CREATE INDEX deliveries_rider_status_idx ON deliveries (rider_id, status);
CREATE INDEX deliveries_order_idx ON deliveries (order_id);
CREATE TRIGGER deliveries_set_updated_at BEFORE UPDATE ON deliveries FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Location trail: purged when the delivery ends (privacy — we don't keep a rider's or a customer's movements).
CREATE TABLE delivery_locations (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_id  uuid NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  lat          double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng          double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  accuracy     real,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_locations_delivery_idx ON delivery_locations (delivery_id, recorded_at DESC);

-- Append-only run history (who did what, when). Notes here are staff-only; customers only see the event types.
CREATE TABLE delivery_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id  uuid REFERENCES deliveries(id) ON DELETE SET NULL,
  order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type         text NOT NULL,
  actor_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  note         text,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_events_order_idx ON delivery_events (order_id, at);
