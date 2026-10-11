-- Prescription-required medicines sold at the till.
-- The storefront refuses them without an approved prescription (decision D5); the POS skipped the check and kept no record. From now on
-- a till sale containing one carries a prescription record — written in the SAME transaction as the sale, so a sale can't exist without it.

ALTER TABLE pos_sale_items ADD COLUMN prescription_required boolean NOT NULL DEFAULT false;

CREATE TABLE pos_sale_prescriptions (
  sale_id          uuid PRIMARY KEY REFERENCES pos_sales(id) ON DELETE CASCADE,   -- one prescription record per sale
  source           text NOT NULL CHECK (source IN ('in_store', 'online')),
  -- online: the customer's approved prescription from the app (its own file/review live in `prescriptions`)
  prescription_id  uuid REFERENCES prescriptions(id) ON DELETE RESTRICT,
  -- in_store: what the pharmacist read off the paper prescription
  patient_name     text,
  prescriber_name  text,
  prescriber_reg_no text,
  issued_on        date,
  notes            text,
  verified_by      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,        -- the pharmacist who checked it and dispensed
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (source = 'online'   AND prescription_id IS NOT NULL) OR
    (source = 'in_store' AND patient_name IS NOT NULL AND prescriber_name IS NOT NULL AND issued_on IS NOT NULL)
  )
);
CREATE INDEX pos_sale_prescriptions_rx_idx ON pos_sale_prescriptions (prescription_id) WHERE prescription_id IS NOT NULL;
CREATE INDEX pos_sale_prescriptions_verified_idx ON pos_sale_prescriptions (verified_by, created_at DESC);
