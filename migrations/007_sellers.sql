-- Phase 6: the marketplace side — shop applications (with document review), the sellers they mint, a
-- commission-aware earnings view, and payouts. Closes the FK migration 002 deferred ("Plain text until the
-- sellers table exists in Phase 6, which adds the FK").

CREATE TABLE sellers (
  id               text PRIMARY KEY CHECK (id = lower(id)), -- slug, matches products.seller_id and the existing demo seller ids
  name             text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 150),
  first_party      boolean NOT NULL DEFAULT false, -- Vyra Retail: 0% commission, always active, never suspended
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended', 'rejected')),
  commission_rate  numeric(5,2) NOT NULL DEFAULT 12 CHECK (commission_rate >= 0 AND commission_rate <= 100),
  owner_user_id    uuid REFERENCES users(id) ON DELETE SET NULL, -- the account with the `seller` role for this shop; null for a seed seller with no login yet
  contact_email    text,
  contact_mobile   text,
  rating           numeric(2,1),
  reviews_count    integer NOT NULL DEFAULT 0,
  payout_method_label text, -- display only, e.g. "Global IME Bank •••• 9012" — never the real account number (see settlement below)
  is_demo          boolean NOT NULL DEFAULT false,
  joined_at        timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sellers_owner_idx ON sellers (owner_user_id) WHERE owner_user_id IS NOT NULL; -- one shop per account
CREATE TRIGGER sellers_set_updated_at BEFORE UPDATE ON sellers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Finding #9 / decision D8: bank/wallet numbers are the one genuinely sensitive field a shop application
-- carries. Encrypted at rest (AES-256-GCM, DATA_ENCRYPTION_KEY — see utils/encryption.js); every other
-- settlement field is plain because it's already effectively public (a bank name, an account holder's own
-- name) or is itself just a masked label.
CREATE TABLE seller_applications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, -- the applicant's account — never trust a submitted owner/email instead
  status              text NOT NULL DEFAULT 'under_review' CHECK (status IN ('under_review', 'approved', 'rejected', 'suspended')),
  needs_correction    boolean NOT NULL DEFAULT false, -- a "reject" that invites resubmission rather than a final no

  shop_name           text NOT NULL CHECK (length(btrim(shop_name)) BETWEEN 1 AND 150),
  shop_type           text NOT NULL,
  shop_contact        text NOT NULL,
  shop_email          text,
  shop_description    text,
  address_line        text NOT NULL,
  province_id         text NOT NULL,
  district_id         text NOT NULL,
  municipality_id     text NOT NULL,
  ward                text NOT NULL,
  landmark            text,
  lat                 double precision,
  lng                 double precision,

  -- Only meaningful when shop_type = 'pharmacy' — enforced in the service layer, not a CHECK, so a non-pharmacy
  -- application can simply leave every one of these null.
  pharmacy_license_number   text,
  pharmacy_license_issued   date,
  pharmacy_license_expires  date,
  pharmacist_name           text,
  pharmacist_reg_number     text,

  operations          jsonb NOT NULL, -- hours + delivery/pickup/radius/fee/min-order/prep-time — admin-defined shape, no reason to force columns

  settlement_account_holder   text NOT NULL,
  settlement_bank_name        text,
  settlement_branch           text,
  settlement_wallet_provider  text,
  settlement_account_number_enc  bytea, -- ciphertext (IV || tag || data) — see utils/encryption.js
  settlement_wallet_number_enc   bytea,

  seller_id           text REFERENCES sellers(id) ON DELETE SET NULL, -- set once approved
  rejection_reason    text,
  submitted_at        timestamptz NOT NULL DEFAULT now(),
  decided_at          timestamptz,
  decided_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  is_demo             boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX seller_applications_user_idx ON seller_applications (user_id, created_at DESC);
CREATE INDEX seller_applications_status_idx ON seller_applications (status);
CREATE TRIGGER seller_applications_set_updated_at BEFORE UPDATE ON seller_applications FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE seller_application_documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id        uuid NOT NULL REFERENCES seller_applications(id) ON DELETE CASCADE,
  type                  text NOT NULL, -- business_reg | pan_vat | shop_license | owner_id | pharmacy_license | pharmacist_certificate | other
  file_key              text NOT NULL, -- private storage — see services/storage.service.js, same as prescriptions
  file_name             text NOT NULL,
  mime_type             text NOT NULL,
  size_bytes            integer NOT NULL CHECK (size_bytes > 0),
  verification_status   text NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'rejected')),
  rejection_reason      text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX seller_application_documents_app_idx ON seller_application_documents (application_id);

CREATE TABLE seller_payouts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id      text NOT NULL REFERENCES sellers(id) ON DELETE RESTRICT,
  amount         numeric(12,2) NOT NULL CHECK (amount > 0),
  status         text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'paid')),
  method_label   text, -- snapshot of sellers.payout_method_label at request time
  note           text,
  requested_by   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decided_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at     timestamptz,
  paid_at        timestamptz,
  is_demo        boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX seller_payouts_seller_idx ON seller_payouts (seller_id, created_at DESC);
CREATE INDEX seller_payouts_status_idx ON seller_payouts (status);
CREATE TRIGGER seller_payouts_set_updated_at BEFORE UPDATE ON seller_payouts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The FK migration 002 deferred: now that sellers exists, a product can only ever point at a real seller.
ALTER TABLE products ADD CONSTRAINT products_seller_id_fkey FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE RESTRICT;
