-- Durable, redacted repository draft-test protocol. Private candidate settings
-- remain in immutable administration configuration versions; these tables retain
-- only bounded confirmation/claim/result metadata.
CREATE TABLE administration_repository_draft_test_confirmations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  principal_id text NOT NULL,
  session_id text NOT NULL,
  repository_id text NOT NULL,
  candidate_version_id text NOT NULL,
  candidate_digest char(64) NOT NULL CHECK (candidate_digest ~ '^[a-f0-9]{64}$'),
  confirmation text NOT NULL,
  impact text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, principal_id) REFERENCES principals(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, repository_id) REFERENCES administration_configurations(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, candidate_version_id) REFERENCES administration_configuration_versions(workspace_id, id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);
CREATE INDEX administration_repository_draft_test_confirmation_lookup_idx
  ON administration_repository_draft_test_confirmations (workspace_id, principal_id, session_id, expires_at);

CREATE TABLE administration_repository_draft_test_claims (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  principal_id text NOT NULL,
  session_id text NOT NULL,
  repository_id text NOT NULL,
  candidate_version_id text NOT NULL,
  candidate_digest char(64) NOT NULL CHECK (candidate_digest ~ '^[a-f0-9]{64}$'),
  key_digest char(64) NOT NULL CHECK (key_digest ~ '^[a-f0-9]{64}$'),
  attempt_ordinal integer NOT NULL CHECK (attempt_ordinal > 0),
  accepted_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  lease_expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  reclaimed_from_claim_id text,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, key_digest, attempt_ordinal),
  FOREIGN KEY (workspace_id, principal_id) REFERENCES principals(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, repository_id) REFERENCES administration_configurations(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, candidate_version_id) REFERENCES administration_configuration_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, reclaimed_from_claim_id)
    REFERENCES administration_repository_draft_test_claims(workspace_id, id) ON DELETE RESTRICT,
  CHECK (lease_expires_at > accepted_at),
  CHECK (completed_at IS NULL OR completed_at >= accepted_at)
);
CREATE INDEX administration_repository_draft_test_claim_lookup_idx
  ON administration_repository_draft_test_claims (workspace_id, key_digest, attempt_ordinal DESC);

CREATE TABLE administration_repository_draft_test_results (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  claim_id text NOT NULL UNIQUE,
  outcome text NOT NULL CHECK (outcome IN ('completed', 'failed', 'outcome_unknown')),
  completed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, claim_id)
    REFERENCES administration_repository_draft_test_claims(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX administration_repository_draft_test_success_idx
  ON administration_repository_draft_test_results (workspace_id, outcome, completed_at DESC)
  WHERE outcome = 'completed';

CREATE OR REPLACE FUNCTION repository_draft_test_immutable_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'administration_repository_draft_test_confirmations' THEN
    IF OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
       AND NEW.id = OLD.id AND NEW.workspace_id = OLD.workspace_id
       AND NEW.principal_id = OLD.principal_id AND NEW.session_id = OLD.session_id
       AND NEW.repository_id = OLD.repository_id AND NEW.candidate_version_id = OLD.candidate_version_id
       AND NEW.candidate_digest = OLD.candidate_digest AND NEW.confirmation = OLD.confirmation
       AND NEW.impact = OLD.impact AND NEW.expires_at = OLD.expires_at AND NEW.created_at = OLD.created_at THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'administration_repository_draft_test_claims' THEN
    IF OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL
       AND NEW.id = OLD.id AND NEW.workspace_id = OLD.workspace_id
       AND NEW.principal_id = OLD.principal_id AND NEW.session_id = OLD.session_id
       AND NEW.repository_id = OLD.repository_id AND NEW.candidate_version_id = OLD.candidate_version_id
       AND NEW.candidate_digest = OLD.candidate_digest AND NEW.key_digest = OLD.key_digest
       AND NEW.attempt_ordinal = OLD.attempt_ordinal AND NEW.accepted_at = OLD.accepted_at
       AND NEW.lease_expires_at = OLD.lease_expires_at AND NEW.reclaimed_from_claim_id IS NOT DISTINCT FROM OLD.reclaimed_from_claim_id THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'repository draft-test history is append-only';
END $$;
CREATE TRIGGER administration_repository_draft_test_confirmation_immutable
  BEFORE UPDATE OR DELETE ON administration_repository_draft_test_confirmations
  FOR EACH ROW EXECUTE FUNCTION repository_draft_test_immutable_transition();
CREATE TRIGGER administration_repository_draft_test_claim_immutable
  BEFORE UPDATE OR DELETE ON administration_repository_draft_test_claims
  FOR EACH ROW EXECUTE FUNCTION repository_draft_test_immutable_transition();
CREATE TRIGGER administration_repository_draft_test_result_immutable
  BEFORE UPDATE OR DELETE ON administration_repository_draft_test_results
  FOR EACH ROW EXECUTE FUNCTION pbi_020_reject_immutable_mutation();
