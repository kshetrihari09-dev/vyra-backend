-- Vyra Call: real-time voice calls between a customer and ONE Vyra Shop (a `sellers` row).
-- Audio itself is peer-to-peer WebRTC and is never recorded or stored; this schema holds only call metadata and the
-- short-lived signaling messages (SDP / ICE) the two browsers exchange to set that connection up.

-- ------------------------------------------------------------------ presence
-- A shop can take calls only while its dashboard keeps `available_until` in the future (heartbeat, same idea as
-- pharmacist_presence). Closing the tab or losing connectivity takes the shop offline by itself — availability is never faked.
CREATE TABLE shop_call_presence (
  seller_id       text PRIMARY KEY REFERENCES sellers(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- the signed-in owner whose console is open
  accepting       boolean NOT NULL DEFAULT true,                         -- the owner can pause calls without closing the dashboard
  available_until timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------- calls
CREATE TABLE vyra_calls (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_id         text NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  answered_by       uuid REFERENCES users(id) ON DELETE SET NULL,        -- the shop account that accepted
  -- ringing: waiting for the shop · connecting: accepted, WebRTC negotiating · active: audio flowing · the rest are final.
  status            text NOT NULL DEFAULT 'ringing'
                    CHECK (status IN ('ringing', 'connecting', 'active', 'completed', 'declined', 'missed', 'cancelled', 'failed')),
  end_reason        text,                                                -- short machine code, e.g. 'hangup', 'ring_timeout', 'ice_failed', 'peer_lost'
  ended_by          text CHECK (ended_by IN ('customer', 'shop', 'system')),
  client_call_id    uuid NOT NULL,                                       -- a retry / double-tap of "Call" returns the original call
  created_at        timestamptz NOT NULL DEFAULT now(),
  ring_expires_at   timestamptz NOT NULL,
  answered_at       timestamptz,
  connected_at      timestamptz,                                         -- first moment audio was actually connected
  ended_at          timestamptz,
  duration_seconds  integer CHECK (duration_seconds IS NULL OR duration_seconds >= 0),  -- connected_at -> ended_at; null if never connected
  customer_seen_at  timestamptz NOT NULL DEFAULT now(),                  -- liveness pings, so a closed tab can't hold a call open
  shop_seen_at      timestamptz,
  CHECK ((status IN ('ringing', 'connecting', 'active')) = (ended_at IS NULL))
);

-- The database itself enforces "no duplicate calls" and "busy": at most one open call per customer and one per shop.
CREATE UNIQUE INDEX vyra_calls_one_open_per_customer ON vyra_calls (customer_id) WHERE status IN ('ringing', 'connecting', 'active');
CREATE UNIQUE INDEX vyra_calls_one_open_per_shop     ON vyra_calls (seller_id)   WHERE status IN ('ringing', 'connecting', 'active');
CREATE UNIQUE INDEX vyra_calls_client_key            ON vyra_calls (customer_id, client_call_id);
CREATE INDEX vyra_calls_shop_history_idx ON vyra_calls (seller_id, created_at DESC);
CREATE INDEX vyra_calls_open_idx ON vyra_calls (status) WHERE status IN ('ringing', 'connecting', 'active');

-- ------------------------------------------------------------------ signaling
-- SDP offers/answers and ICE candidates. Kept in the database (not process memory) so signaling works across several API
-- instances and a briefly dropped stream can resume from its cursor. Purged shortly after the call ends (see jobs/calls.js).
CREATE TABLE vyra_call_signals (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,           -- total order + stream cursor
  call_id     uuid NOT NULL REFERENCES vyra_calls(id) ON DELETE CASCADE,
  from_role   text NOT NULL CHECK (from_role IN ('customer', 'shop')),   -- derived by the server from who the caller is, never client-supplied
  kind        text NOT NULL CHECK (kind IN ('offer', 'answer', 'ice')),
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vyra_call_signals_call_idx ON vyra_call_signals (call_id, id);
