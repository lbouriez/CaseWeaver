-- Durable, redacted candidate connector-test state.  No settings, secret
-- registrations/locators, credentials, remote URLs, payloads, or exceptions
-- are retained in these tables.

CREATE TABLE administration_connector_draft_test_confirmations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  principal_id text NOT NULL,
  session_id text NOT NULL,
  descriptor_type text NOT NULL CHECK (descriptor_type ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  descriptor_version text NOT NULL CHECK (descriptor_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  test_operation text NOT NULL CHECK (test_operation ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  candidate_digest char(64) NOT NULL CHECK (candidate_digest ~ '^[a-f0-9]{64}$'),
  confirmation text NOT NULL CHECK (char_length(confirmation) BETWEEN 1 AND 500),
  impact text NOT NULL CHECK (char_length(impact) BETWEEN 1 AND 2000),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX administration_connector_draft_test_confirmation_lookup_idx
  ON administration_connector_draft_test_confirmations
  (workspace_id, principal_id, session_id, expires_at, consumed_at);

CREATE TABLE administration_connector_draft_test_claims (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  principal_id text NOT NULL,
  descriptor_type text NOT NULL CHECK (descriptor_type ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  descriptor_version text NOT NULL CHECK (descriptor_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  test_operation text NOT NULL CHECK (test_operation ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  candidate_digest char(64) NOT NULL CHECK (candidate_digest ~ '^[a-f0-9]{64}$'),
  key_digest char(64) NOT NULL CHECK (key_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (workspace_id, key_digest)
);

CREATE TABLE administration_connector_draft_test_results (
  id text PRIMARY KEY,
  claim_id text NOT NULL UNIQUE
    REFERENCES administration_connector_draft_test_claims(id) ON DELETE RESTRICT,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  completed_at timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION administration_connector_draft_test_confirmation_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.descriptor_type IS DISTINCT FROM OLD.descriptor_type
     OR NEW.descriptor_version IS DISTINCT FROM OLD.descriptor_version
     OR NEW.test_operation IS DISTINCT FROM OLD.test_operation
     OR NEW.candidate_digest IS DISTINCT FROM OLD.candidate_digest
     OR NEW.confirmation IS DISTINCT FROM OLD.confirmation
     OR NEW.impact IS DISTINCT FROM OLD.impact
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Connector draft-test confirmations are immutable once issued.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER administration_connector_draft_test_confirmation_guard_trigger
  BEFORE UPDATE OR DELETE ON administration_connector_draft_test_confirmations
  FOR EACH ROW EXECUTE FUNCTION administration_connector_draft_test_confirmation_guard();

CREATE OR REPLACE FUNCTION administration_connector_draft_test_claim_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.completed_at IS NOT NULL
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.descriptor_type IS DISTINCT FROM OLD.descriptor_type
     OR NEW.descriptor_version IS DISTINCT FROM OLD.descriptor_version
     OR NEW.test_operation IS DISTINCT FROM OLD.test_operation
     OR NEW.candidate_digest IS DISTINCT FROM OLD.candidate_digest
     OR NEW.key_digest IS DISTINCT FROM OLD.key_digest
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Connector draft-test claims are immutable.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER administration_connector_draft_test_claim_guard_trigger
  BEFORE UPDATE OR DELETE ON administration_connector_draft_test_claims
  FOR EACH ROW EXECUTE FUNCTION administration_connector_draft_test_claim_guard();

CREATE OR REPLACE FUNCTION administration_connector_draft_test_result_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Connector draft-test results are immutable.';
END;
$$;
CREATE TRIGGER administration_connector_draft_test_result_immutable_trigger
  BEFORE UPDATE OR DELETE ON administration_connector_draft_test_results
  FOR EACH ROW EXECUTE FUNCTION administration_connector_draft_test_result_immutable();
