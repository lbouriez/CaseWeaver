-- PBI-016 administration configuration/history and server-side identity session foundation.
-- Version rows and audit records are append-only; no secret value columns are present.

ALTER TABLE audit_events
  ADD COLUMN origin text,
  ADD COLUMN target_type text,
  ADD COLUMN outcome text,
  ADD COLUMN permission text,
  ADD COLUMN reason_code text,
  ADD COLUMN ui_action_id text,
  ADD COLUMN request_id text,
  ADD COLUMN correlation_id text,
  ADD COLUMN trace_id text,
  ADD COLUMN idempotency_key_digest text,
  ADD COLUMN client_address text,
  ADD COLUMN user_agent text;

CREATE INDEX audit_events_workspace_occurred_idx
  ON audit_events (workspace_id, occurred_at DESC, id DESC);

CREATE TABLE administration_configurations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  resource_type text NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('draft', 'active', 'disabled', 'superseded')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  current_version_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);
CREATE INDEX administration_configurations_list_idx
  ON administration_configurations (workspace_id, resource_type, updated_at DESC, id DESC);

CREATE TABLE administration_configuration_versions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  configuration_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  settings jsonb NOT NULL,
  secret_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, configuration_id, version),
  FOREIGN KEY (workspace_id, configuration_id)
    REFERENCES administration_configurations(workspace_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(settings) = 'object'),
  CHECK (jsonb_typeof(secret_references) = 'array')
);
ALTER TABLE administration_configurations
  ADD CONSTRAINT administration_configurations_current_version_fk
  FOREIGN KEY (workspace_id, current_version_id)
  REFERENCES administration_configuration_versions(workspace_id, id) ON DELETE RESTRICT;

CREATE TABLE oidc_identity_mappings (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  principal_id text NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, issuer, subject),
  UNIQUE (workspace_id, principal_id),
  FOREIGN KEY (workspace_id, principal_id)
    REFERENCES principals(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE administration_sessions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  principal_id text NOT NULL,
  session_digest text NOT NULL UNIQUE,
  csrf_digest text NOT NULL,
  issued_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (workspace_id, principal_id)
    REFERENCES principals(workspace_id, id) ON DELETE RESTRICT,
  CHECK (idle_expires_at <= absolute_expires_at)
);
CREATE INDEX administration_sessions_active_idx
  ON administration_sessions (session_digest, revoked_at, idle_expires_at);

CREATE TABLE administration_login_transactions (
  id text PRIMARY KEY,
  workspace_id text REFERENCES workspaces(id) ON DELETE RESTRICT,
  state_digest text NOT NULL UNIQUE,
  nonce_digest text NOT NULL,
  verifier_digest text NOT NULL,
  return_path text NOT NULL CHECK (return_path ~ '^/[^/].*$' OR return_path = '/'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX administration_login_transactions_active_idx
  ON administration_login_transactions (state_digest, expires_at, consumed_at);

CREATE OR REPLACE FUNCTION administration_configuration_versions_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Administration configuration versions are immutable';
END;
$$;
CREATE TRIGGER administration_configuration_versions_immutable_trigger
  BEFORE UPDATE OR DELETE ON administration_configuration_versions
  FOR EACH ROW EXECUTE FUNCTION administration_configuration_versions_immutable();

CREATE OR REPLACE FUNCTION audit_events_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Audit events are append-only';
END;
$$;
CREATE TRIGGER audit_events_append_only_trigger
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
