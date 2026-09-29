-- Phase 8: persisted notifications (in-app inbox) + an outbox for email/SMS, plus per-user opt-outs.

-- In-app inbox. `data` carries ids for deep links only (orderId, prescriptionId…) — never addresses, codes or amounts owed.
CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        text NOT NULL,               -- e.g. order.placed, delivery.out_for_delivery
  kind        text NOT NULL,               -- UI grouping/icon: order | delivery | payment | prescription | seller
  title       text NOT NULL,
  message     text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_created_idx ON notifications (user_id, created_at DESC, id DESC);
CREATE INDEX notifications_user_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- Outbox: rows are written in the SAME transaction as the business change (so a rolled-back order never sends
-- anything) and delivered afterwards by the worker. At-least-once: a crash between "sent" and the status update
-- can repeat a message, never lose one. Recipient address is copied here on purpose (the user may change it later,
-- and the message must go where it was addressed); rows are purged after a retention period (jobs/retention.js).
CREATE TABLE notification_outbox (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  channel         text NOT NULL CHECK (channel IN ('sms', 'email')),
  to_address      text NOT NULL,
  subject         text,
  body            text NOT NULL,
  type            text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'dead')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until    timestamptz,             -- a worker that dies mid-send leaves this in the past → the row is reclaimed
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX notification_outbox_due_idx ON notification_outbox (next_attempt_at) WHERE status IN ('pending', 'sending');
CREATE INDEX notification_outbox_status_idx ON notification_outbox (status, created_at);

-- Opt-outs for the *external* channels. In-app notifications and security messages (OTP, password reset) are unaffected.
ALTER TABLE users ADD COLUMN notify_email boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN notify_sms   boolean NOT NULL DEFAULT true;
