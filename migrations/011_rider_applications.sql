-- Rider applications: a signed-in user asks to become a delivery rider; a reviewer (delivery:manage + roles:assign)
-- approves, which creates the rider profile and grants the `delivery` role through the SAME code path as an admin
-- adding a rider directly. Mirrors seller applications (007): private document storage, applicant-or-reviewer access.

CREATE TABLE rider_applications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, -- always the signed-in account, never a submitted id
  status             text NOT NULL DEFAULT 'under_review' CHECK (status IN ('under_review', 'approved', 'rejected')),
  needs_correction   boolean NOT NULL DEFAULT false, -- a "rejected" that invites resubmission rather than a final no
  phone              text NOT NULL,
  vehicle_type       text NOT NULL,
  vehicle_number     text,
  license_number_enc bytea,         -- driving licence number, encrypted at rest (utils/encryption.js); NULL for a bicycle
  rejection_reason   text,
  rider_id           uuid REFERENCES riders(id) ON DELETE SET NULL, -- set on approval
  decided_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rider_applications_user_idx ON rider_applications (user_id, created_at DESC);
CREATE INDEX rider_applications_status_idx ON rider_applications (status);
-- Database backstop: at most one open (in review or approved) application per user, even under a double-submit race.
CREATE UNIQUE INDEX rider_applications_one_open_per_user ON rider_applications (user_id) WHERE status IN ('under_review', 'approved');
CREATE TRIGGER rider_applications_set_updated_at BEFORE UPDATE ON rider_applications FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE rider_application_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES rider_applications(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('driving_license', 'vehicle_registration', 'citizen_id', 'insurance', 'other')),
  file_key        text NOT NULL, -- private storage (services/storage.service.js); never returned by the API
  file_name       text NOT NULL,
  mime_type       text NOT NULL,
  size_bytes      integer NOT NULL CHECK (size_bytes > 0),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rider_application_documents_app_idx ON rider_application_documents (application_id);
