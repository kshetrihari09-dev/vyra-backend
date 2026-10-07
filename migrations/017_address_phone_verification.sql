-- Delivery-phone protection: the account's own (login) mobile is trusted as-is; any OTHER number used on a delivery
-- address must first be confirmed with a one-time code sent to that number. Confirmed numbers are remembered per user.

ALTER TABLE otp_challenges DROP CONSTRAINT IF EXISTS otp_challenges_purpose_check;
ALTER TABLE otp_challenges ADD CONSTRAINT otp_challenges_purpose_check CHECK (purpose IN ('register', 'address_phone'));

CREATE TABLE verified_phones (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mobile      text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, mobile)
);
