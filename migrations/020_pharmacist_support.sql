-- Pharmacist support: live chat + "email a pharmacist" messages share ONE conversation per customer per department,
-- and pharmacists get a shared inbox. Availability is real: a pharmacist is "online" only while a heartbeat from their
-- console keeps `available_until` in the future, so closing the tab / losing connectivity takes them offline by itself.

-- ---------------------------------------------------------------- permission
-- seed:reference also grants this (src/config/permissions.js is the source of truth); doing it here as well means a deploy
-- that only runs `npm run migrate` still gives pharmacists their inbox. Guarded on the role existing so a fresh database
-- (migrations run BEFORE the reference seed) doesn't fail the foreign key.
INSERT INTO permissions (key, description)
VALUES ('support:pharmacist', 'Answer customers in the pharmacist inbox and set pharmacist availability')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_key, permission_key)
SELECT r.key, 'support:pharmacist' FROM roles r WHERE r.key IN ('pharmacist', 'admin')
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------------ presence
CREATE TABLE pharmacist_presence (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  available_until timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------- conversations
-- One thread per (customer, department). 'pharmacy' is what the pharmacist inbox shows; 'general' holds the
-- order/payment/delivery/return messages sent from the help page (email-delivered, no inbox UI).
CREATE TABLE support_conversations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department             text NOT NULL CHECK (department IN ('pharmacy', 'general')),
  status                 text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  assigned_to            uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Read cursors (support_messages.seq). Unread = messages from the OTHER side with a higher seq.
  customer_last_read_seq bigint NOT NULL DEFAULT 0,
  staff_last_read_seq    bigint NOT NULL DEFAULT 0,
  last_message_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at            timestamptz,
  resolved_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, department)
);
CREATE INDEX support_conversations_inbox_idx ON support_conversations (department, status, last_message_at DESC);

-- ------------------------------------------------------------------ messages
CREATE TABLE support_messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq               bigint GENERATED ALWAYS AS IDENTITY UNIQUE,      -- total order + read/stream cursor
  conversation_id   uuid NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  sender_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  sender_role       text NOT NULL CHECK (sender_role IN ('customer', 'staff')),
  via               text NOT NULL CHECK (via IN ('chat', 'form')),
  topic             text,                                            -- help-page topic for 'general' messages
  body              text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  -- Client-generated id: a retry or double-tap of the same message returns the original instead of duplicating it.
  client_message_id uuid,
  order_id          uuid REFERENCES orders(id) ON DELETE SET NULL,
  product_id        text REFERENCES products(id) ON DELETE SET NULL,
  prescription_id   uuid REFERENCES prescriptions(id) ON DELETE SET NULL,
  -- Email leg of a 'form' message. 'accepted' = the configured gateway answered 2xx; it is the only state shown as success.
  email_status      text CHECK (email_status IN ('pending', 'sending', 'accepted', 'failed')),
  email_attempts    integer NOT NULL DEFAULT 0,
  email_attempt_at  timestamptz,
  email_accepted_at timestamptz,
  email_error       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((via = 'form') = (email_status IS NOT NULL))
);
CREATE UNIQUE INDEX support_messages_client_key ON support_messages (conversation_id, sender_id, client_message_id) WHERE client_message_id IS NOT NULL;
CREATE INDEX support_messages_conversation_seq_idx ON support_messages (conversation_id, seq DESC);
