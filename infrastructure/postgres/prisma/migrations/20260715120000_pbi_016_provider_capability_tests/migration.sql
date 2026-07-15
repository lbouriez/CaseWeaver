-- PBI-016 durable, provider-neutral capability-test confirmation, replay,
-- outcome, and database-time rate-limit state. These tables deliberately
-- retain only immutable identities and safe cost/outcome metadata.

CREATE TABLE administration_provider_capability_test_confirmations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  principal_id text NOT NULL,
  session_id text NOT NULL,
  provider_instance_id text NOT NULL,
  provider_instance_version_id text NOT NULL,
  binding_version_id text NOT NULL,
  test_operation text NOT NULL,
  template_digest char(64) NOT NULL CHECK (template_digest ~ '^[a-f0-9]{64}$'),
  estimated_amount numeric(38,18) NOT NULL CHECK (estimated_amount >= 0),
  estimated_currency char(3) NOT NULL CHECK (estimated_currency ~ '^[A-Z]{3}$'),
  confirmation text NOT NULL CHECK (
    char_length(confirmation) BETWEEN 1 AND 2000
    AND confirmation !~ E'[\\r\\n]'
  ),
  impact text NOT NULL CHECK (
    char_length(impact) BETWEEN 1 AND 2000
    AND impact !~ E'[\\r\\n]'
  ),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  FOREIGN KEY (workspace_id, provider_instance_id)
    REFERENCES ai_provider_instances(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, provider_instance_version_id)
    REFERENCES ai_provider_instance_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, binding_version_id)
    REFERENCES ai_model_binding_versions(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX administration_provider_capability_test_confirmations_lookup_idx
  ON administration_provider_capability_test_confirmations
  (workspace_id, principal_id, session_id, expires_at, consumed_at);

CREATE TABLE administration_provider_capability_test_claims (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  principal_id text NOT NULL,
  provider_instance_id text NOT NULL,
  provider_instance_version_id text NOT NULL,
  binding_version_id text NOT NULL,
  test_operation text NOT NULL,
  key_digest char(64) NOT NULL CHECK (key_digest ~ '^[a-f0-9]{64}$'),
  request_fingerprint char(64) NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (workspace_id, key_digest),
  FOREIGN KEY (workspace_id, provider_instance_id)
    REFERENCES ai_provider_instances(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, provider_instance_version_id)
    REFERENCES ai_provider_instance_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, binding_version_id)
    REFERENCES ai_model_binding_versions(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE administration_provider_capability_test_results (
  id text PRIMARY KEY,
  claim_id text NOT NULL UNIQUE
    REFERENCES administration_provider_capability_test_claims(id) ON DELETE RESTRICT,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  provider_instance_id text NOT NULL,
  provider_instance_version_id text NOT NULL,
  binding_version_id text NOT NULL,
  test_operation text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'denied')),
  operation_id text,
  estimated_amount numeric(38,18),
  estimated_currency char(3),
  actual_amount numeric(38,18),
  actual_currency char(3),
  reason_code text,
  completed_at timestamptz NOT NULL,
  CHECK (
    (estimated_amount IS NULL) = (estimated_currency IS NULL)
    AND (actual_amount IS NULL) = (actual_currency IS NULL)
    AND (estimated_amount IS NULL OR estimated_amount >= 0)
    AND (actual_amount IS NULL OR actual_amount >= 0)
    AND (estimated_currency IS NULL OR estimated_currency ~ '^[A-Z]{3}$')
    AND (actual_currency IS NULL OR actual_currency ~ '^[A-Z]{3}$')
  ),
  FOREIGN KEY (workspace_id, provider_instance_id)
    REFERENCES ai_provider_instances(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, provider_instance_version_id)
    REFERENCES ai_provider_instance_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, binding_version_id)
    REFERENCES ai_model_binding_versions(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE administration_provider_capability_test_rate_windows (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  principal_id text NOT NULL,
  provider_instance_id text NOT NULL,
  provider_instance_version_id text NOT NULL,
  window_started_at timestamptz NOT NULL,
  acquired_count integer NOT NULL CHECK (acquired_count BETWEEN 1 AND 5),
  PRIMARY KEY (
    workspace_id, principal_id, provider_instance_id,
    provider_instance_version_id, window_started_at
  ),
  FOREIGN KEY (workspace_id, provider_instance_id)
    REFERENCES ai_provider_instances(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, provider_instance_version_id)
    REFERENCES ai_provider_instance_versions(workspace_id, id) ON DELETE RESTRICT
);

-- Confirmation identity is append-only. The sole permissible change consumes
-- an otherwise matching record exactly once.
CREATE OR REPLACE FUNCTION administration_provider_test_confirmation_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Provider capability-test confirmations are append-only.';
  END IF;
  IF OLD.consumed_at IS NOT NULL
     OR NEW.consumed_at IS NULL
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.provider_instance_id IS DISTINCT FROM OLD.provider_instance_id
     OR NEW.provider_instance_version_id IS DISTINCT FROM OLD.provider_instance_version_id
     OR NEW.binding_version_id IS DISTINCT FROM OLD.binding_version_id
     OR NEW.test_operation IS DISTINCT FROM OLD.test_operation
     OR NEW.template_digest IS DISTINCT FROM OLD.template_digest
     OR NEW.estimated_amount IS DISTINCT FROM OLD.estimated_amount
     OR NEW.estimated_currency IS DISTINCT FROM OLD.estimated_currency
     OR NEW.confirmation IS DISTINCT FROM OLD.confirmation
     OR NEW.impact IS DISTINCT FROM OLD.impact
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Provider capability-test confirmations are immutable once issued.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER administration_provider_test_confirmation_guard_trigger
  BEFORE UPDATE OR DELETE ON administration_provider_capability_test_confirmations
  FOR EACH ROW EXECUTE FUNCTION administration_provider_test_confirmation_guard();

CREATE OR REPLACE FUNCTION administration_provider_test_claim_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Provider capability-test claims are append-only.';
  END IF;
  IF OLD.completed_at IS NOT NULL
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.provider_instance_id IS DISTINCT FROM OLD.provider_instance_id
     OR NEW.provider_instance_version_id IS DISTINCT FROM OLD.provider_instance_version_id
     OR NEW.binding_version_id IS DISTINCT FROM OLD.binding_version_id
     OR NEW.test_operation IS DISTINCT FROM OLD.test_operation
     OR NEW.key_digest IS DISTINCT FROM OLD.key_digest
     OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Provider capability-test claims are immutable.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER administration_provider_test_claim_guard_trigger
  BEFORE UPDATE OR DELETE ON administration_provider_capability_test_claims
  FOR EACH ROW EXECUTE FUNCTION administration_provider_test_claim_guard();

CREATE OR REPLACE FUNCTION administration_provider_test_result_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Provider capability-test results are immutable.';
END;
$$;
CREATE TRIGGER administration_provider_test_result_immutable_trigger
  BEFORE UPDATE OR DELETE ON administration_provider_capability_test_results
  FOR EACH ROW EXECUTE FUNCTION administration_provider_test_result_immutable();
