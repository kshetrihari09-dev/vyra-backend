-- Shop settings that used to live only in the browser. `settings` holds the validated preferences (contact, hours, delivery,
-- payments, tax, notifications, logo/banner); description is its own column so it can be shown/searched later.
ALTER TABLE sellers
  ADD COLUMN description text CHECK (description IS NULL OR length(description) <= 1000),
  ADD COLUMN settings jsonb NOT NULL DEFAULT '{}'::jsonb;
