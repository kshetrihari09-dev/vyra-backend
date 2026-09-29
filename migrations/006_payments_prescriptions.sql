-- Phase 5: payments (provider abstraction, verified webhooks, refunds) and prescriptions
-- (private uploads + pharmacist review), and the link that closes Phase 3's known gap:
-- an order can no longer be placed for a prescription-required item without an approved
-- prescription that already covers it (decision D5).

CREATE TABLE payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  provider       text NOT NULL CHECK (provider IN ('cod', 'manual')), -- eSewa/Khalti/card providers plug in later behind the same interface (D10)
  method         text NOT NULL, -- mirrors orders.payment_method at the time the payment was created
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'authorized', 'captured', 'failed', 'refunded', 'partially_refunded', 'cancelled')),
  currency       text NOT NULL DEFAULT 'npr', -- money is currency-agnostic in storage; see finding #12 (currency should become a setting)
  amount         numeric(12,2) NOT NULL CHECK (amount >= 0),
  refunded_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  provider_ref   text, -- external transaction/reference id once the provider assigns one
  idempotency_key text, -- set on provider-initiated intents so a retried initiate() can't create a second payment
  instructions   jsonb, -- what the customer is shown for provider='manual' (e.g. bank details + reference to quote)
  failure_reason text,
  raw_payload    jsonb, -- last webhook payload received for this payment, for support/debugging
  authorized_at  timestamptz,
  captured_at    timestamptz,
  failed_at      timestamptz,
  is_demo        boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_order_idx ON payments (order_id);
CREATE UNIQUE INDEX payments_idempotency_key_idx ON payments (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TRIGGER payments_set_updated_at BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One order can only ever have one *active* (non-cancelled/failed) payment; a retried initiate() should
-- reuse it rather than pile up duplicate pending rows for the same order.
CREATE UNIQUE INDEX payments_one_active_per_order ON payments (order_id) WHERE status IN ('pending', 'authorized', 'captured', 'partially_refunded');

CREATE TABLE refunds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id     uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  order_id       uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  amount         numeric(12,2) NOT NULL CHECK (amount > 0),
  reason         text NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'completed')),
  provider_ref   text,
  requested_by   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decided_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at     timestamptz,
  decision_note  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refunds_payment_idx ON refunds (payment_id);
CREATE INDEX refunds_order_idx ON refunds (order_id);
CREATE INDEX refunds_status_idx ON refunds (status);
CREATE TRIGGER refunds_set_updated_at BEFORE UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Idempotency ledger for inbound webhooks: (provider, event_id) is unique so a provider's at-least-once
-- delivery can never apply the same event twice, regardless of what the payment row already shows.
CREATE TABLE payment_webhook_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     text NOT NULL,
  event_id     text NOT NULL,
  payment_id   uuid REFERENCES payments(id) ON DELETE SET NULL,
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payment_webhook_events_unique_idx ON payment_webhook_events (provider, event_id);

CREATE TABLE prescriptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  -- The file itself lives in private object storage (local disk in dev, S3-compatible in production — see
  -- src/services/storage.service.js); only its key is stored here. Never a public URL.
  file_key         text NOT NULL,
  file_name        text NOT NULL,
  mime_type        text NOT NULL,
  size_bytes       integer NOT NULL CHECK (size_bytes > 0),
  notes            text, -- pharmacist's note, shown to the customer alongside the decision
  rejection_reason text,
  pharmacist_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at      timestamptz,
  is_demo          boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prescriptions_user_idx ON prescriptions (user_id, created_at DESC);
CREATE INDEX prescriptions_status_idx ON prescriptions (status);
CREATE TRIGGER prescriptions_set_updated_at BEFORE UPDATE ON prescriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Which medicines a prescription is claimed to cover (matches the prototype's rx.items: product ids).
CREATE TABLE prescription_items (
  prescription_id  uuid NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  product_id       text NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  PRIMARY KEY (prescription_id, product_id)
);

-- Which approved prescription(s) satisfied the requirement for a given order — written once, at order
-- creation, so the decision an order was placed under is preserved even if the prescription is reused later.
CREATE TABLE order_prescriptions (
  order_id         uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  prescription_id  uuid NOT NULL REFERENCES prescriptions(id) ON DELETE RESTRICT,
  PRIMARY KEY (order_id, prescription_id)
);
