-- Phase 1: identity, roles/permissions, sessions, OTP, audit.
-- Requires PostgreSQL 13+ (gen_random_uuid() is built in). Forward-only: take a backup before migrating production.

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- roles & permissions
CREATE TABLE roles (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z][a-z_]{1,31}$'),
  label       text NOT NULL,
  description text,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z_]+:[a-z_]+$'),
  description text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
  role_key       text NOT NULL REFERENCES roles(key) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_key, permission_key)
);

-- ---------------------------------------------------------------- users
-- One account table for every kind of person. A shop owner is a customer account plus the 'seller' role;
-- there is never a second parallel user system.
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name          text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 100),
  email              text UNIQUE CHECK (email = lower(email) AND length(email) <= 254),
  mobile             text UNIQUE CHECK (length(mobile) BETWEEN 7 AND 20),
  password_hash      text NOT NULL,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deactivated')),
  email_verified_at  timestamptz,
  mobile_verified_at timestamptz,
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  last_login_at      timestamptz,
  -- Bridge to the ids the React prototype used (e.g. 'cus-1001'); only set for imported demo/legacy rows.
  legacy_id          text UNIQUE,
  -- Demo/seed rows are flagged so they can be found and purged; production data is never is_demo.
  is_demo            boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR mobile IS NOT NULL)
);
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX users_status_idx ON users (status);
CREATE INDEX users_created_idx ON users (created_at DESC);

CREATE TABLE user_roles (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_key   text NOT NULL REFERENCES roles(key) ON DELETE RESTRICT,
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_key)
);
CREATE INDEX user_roles_role_idx ON user_roles (role_key);

-- Shopper profile. Addresses, carts, wishlists, orders hang off this in later phases.
CREATE TABLE customers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  member_since date NOT NULL DEFAULT current_date,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- sessions
-- Refresh tokens are stored only as keyed hashes. Each login starts a "family"; every refresh rotates the token
-- within the family, and re-presenting an already-rotated token revokes the whole family (theft detection).
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  ip          text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_expiry_idx ON refresh_tokens (expires_at);

CREATE TABLE password_resets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id, created_at DESC);

-- Mobile verification for self-registration. The pending sign-up (name, email, password HASH) rides in payload
-- until the code is verified; only then is the user row created.
CREATE TABLE otp_challenges (
  id          uuid PRIMARY KEY,
  purpose     text NOT NULL CHECK (purpose IN ('register')),
  mobile      text NOT NULL,
  code_hash   text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_challenges_mobile_idx ON otp_challenges (mobile, created_at DESC);

-- ---------------------------------------------------------------- audit log (append-only)
CREATE TABLE audit_logs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES users(id),
  actor_label   text,
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text,
  old_value     jsonb,
  new_value     jsonb,
  ip            text,
  user_agent    text,
  request_id    text
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, at DESC);
CREATE INDEX audit_logs_at_idx ON audit_logs (at DESC);

CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_logs_no_change BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();
