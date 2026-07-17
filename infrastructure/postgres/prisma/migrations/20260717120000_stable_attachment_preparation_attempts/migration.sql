-- Stable attachment preparation is deliberately independent from a knowledge
-- revision or a final case snapshot. A source/case capture can therefore be
-- fenced and completed before either downstream immutable record exists.
--
-- The earlier PBI-020 preparation tables remain untouched for historical
-- compatibility. New composition uses the append-only attempt model below.

CREATE TABLE attachment_preparation_attempts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  subject_kind text NOT NULL CHECK (subject_kind IN ('sourceDocument', 'caseCapture')),
  subject_id text NOT NULL,
  plan_identity_hash text NOT NULL CHECK (plan_identity_hash ~ '^[a-f0-9]{64}$'),
  policy_mode text NOT NULL CHECK (policy_mode IN ('disabled', 'optional', 'required')),
  policy_version text NOT NULL,
  access_policy_hash text NOT NULL CHECK (access_policy_hash ~ '^[a-f0-9]{64}$'),
  attempt_sequence integer NOT NULL CHECK (attempt_sequence > 0),
  retry_of_attempt_id text,
  state text NOT NULL CHECK (state IN ('claimed', 'completed')),
  fence text,
  lease_expires_at timestamptz,
  result_identity_hash text CHECK (result_identity_hash IS NULL OR result_identity_hash ~ '^[a-f0-9]{64}$'),
  result jsonb,
  retry_required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, subject_kind, subject_id, plan_identity_hash, attempt_sequence),
  FOREIGN KEY (workspace_id, retry_of_attempt_id)
    REFERENCES attachment_preparation_attempts(workspace_id, id) ON DELETE RESTRICT,
  CHECK (
    (state = 'claimed' AND fence IS NOT NULL AND lease_expires_at IS NOT NULL
      AND result_identity_hash IS NULL AND result IS NULL AND completed_at IS NULL
      AND retry_required = false)
    OR
    (state = 'completed' AND fence IS NULL AND lease_expires_at IS NULL
      AND result_identity_hash IS NOT NULL AND result IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CHECK (result IS NULL OR jsonb_typeof(result) = 'object')
);

CREATE TABLE attachment_preparation_attempt_occurrences (
  workspace_id text NOT NULL,
  attempt_id text NOT NULL,
  occurrence_identity text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  attachment_id text NOT NULL,
  relation text NOT NULL,
  required boolean NOT NULL,
  PRIMARY KEY (workspace_id, attempt_id, occurrence_identity),
  UNIQUE (workspace_id, attempt_id, ordinal),
  FOREIGN KEY (workspace_id, attempt_id)
    REFERENCES attachment_preparation_attempts(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, attachment_id)
    REFERENCES attachments(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE attachment_preparation_attempt_evidence (
  workspace_id text NOT NULL,
  attempt_id text NOT NULL,
  occurrence_identity text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('ready', 'unavailable')),
  derivative_id text,
  derivative_identity text,
  derivative_content_hash text,
  warning_code text,
  warning_retryable boolean,
  PRIMARY KEY (workspace_id, attempt_id, occurrence_identity),
  FOREIGN KEY (workspace_id, attempt_id, occurrence_identity)
    REFERENCES attachment_preparation_attempt_occurrences(workspace_id, attempt_id, occurrence_identity)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, derivative_id)
    REFERENCES attachment_derivatives(workspace_id, id) ON DELETE RESTRICT,
  CHECK (
    (outcome = 'ready' AND derivative_id IS NOT NULL AND derivative_identity IS NOT NULL
      AND derivative_content_hash ~ '^[a-f0-9]{64}$' AND warning_code IS NULL
      AND warning_retryable IS NULL)
    OR
    (outcome = 'unavailable' AND derivative_id IS NULL AND derivative_identity IS NULL
      AND derivative_content_hash IS NULL AND warning_code IS NOT NULL
      AND warning_retryable IS NOT NULL)
  )
);

-- Downstream immutable records pin exactly the terminal attempt selected for
-- their capture/activation. A failed transaction may safely reuse an already
-- terminal attempt, but later records can never reinterpret it.
CREATE TABLE case_snapshot_attachment_preparation_attempts (
  workspace_id text NOT NULL,
  case_snapshot_id text NOT NULL,
  attachment_preparation_attempt_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, case_snapshot_id),
  UNIQUE (workspace_id, attachment_preparation_attempt_id),
  FOREIGN KEY (workspace_id, case_snapshot_id)
    REFERENCES case_snapshots(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, attachment_preparation_attempt_id)
    REFERENCES attachment_preparation_attempts(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE knowledge_revision_attachment_preparation_attempts (
  workspace_id text NOT NULL,
  knowledge_revision_id text NOT NULL,
  attachment_preparation_attempt_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, knowledge_revision_id),
  UNIQUE (workspace_id, attachment_preparation_attempt_id),
  FOREIGN KEY (workspace_id, knowledge_revision_id)
    REFERENCES knowledge_revisions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, attachment_preparation_attempt_id)
    REFERENCES attachment_preparation_attempts(workspace_id, id) ON DELETE RESTRICT
);

-- Existing PBI-011 records remain valid. New capture code supplies an
-- occurrence identity, allowing two case occurrences to share one derivative
-- without collapsing their immutable evidence records.
DO $$
DECLARE
  derivative_unique text;
BEGIN
  SELECT constraint_name
    INTO derivative_unique
  FROM information_schema.table_constraints
  WHERE table_schema = current_schema()
    AND table_name = 'case_snapshot_attachment_references'
    AND constraint_type = 'UNIQUE'
    AND constraint_name LIKE '%attachment_derivative_id%'
  LIMIT 1;

  IF derivative_unique IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE case_snapshot_attachment_references DROP CONSTRAINT %I',
      derivative_unique
    );
  END IF;
END;
$$;

ALTER TABLE case_snapshot_attachment_references
  ADD COLUMN occurrence_identity text;

CREATE UNIQUE INDEX case_snapshot_attachment_references_occurrence_identity_idx
  ON case_snapshot_attachment_references (workspace_id, case_snapshot_id, occurrence_identity)
  WHERE occurrence_identity IS NOT NULL;

CREATE INDEX attachment_preparation_attempt_claim_idx
  ON attachment_preparation_attempts (workspace_id, state, lease_expires_at, created_at)
  WHERE state = 'claimed';

-- A terminal attempt is meaningful only when the immutable occurrence ledger
-- is complete. These deferred checks defend the table boundary as well as the
-- adapter: direct SQL cannot manufacture incomplete or mis-linked evidence.
CREATE OR REPLACE FUNCTION validate_attachment_preparation_attempt_terminal_state()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  occurrence_count integer;
  evidence_count integer;
  invalid_ready_count integer;
  retry_valid boolean;
BEGIN
  IF NEW.retry_of_attempt_id IS NOT NULL THEN
    SELECT (
      prior.state = 'completed'
      AND prior.retry_required = true
      AND prior.workspace_id = NEW.workspace_id
      AND prior.subject_kind = NEW.subject_kind
      AND prior.subject_id = NEW.subject_id
      AND prior.plan_identity_hash = NEW.plan_identity_hash
      AND prior.policy_mode = NEW.policy_mode
      AND prior.policy_version = NEW.policy_version
      AND prior.access_policy_hash = NEW.access_policy_hash
      AND NEW.attempt_sequence = prior.attempt_sequence + 1
    ) INTO retry_valid
    FROM attachment_preparation_attempts AS prior
    WHERE prior.workspace_id = NEW.workspace_id
      AND prior.id = NEW.retry_of_attempt_id;
    IF retry_valid IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Attachment preparation retry must follow the matching retryable terminal attempt';
    END IF;
  ELSIF NEW.attempt_sequence <> 1 THEN
    RAISE EXCEPTION 'Attachment preparation initial attempt sequence must be one';
  END IF;

  IF NEW.state <> 'completed' THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO occurrence_count
  FROM attachment_preparation_attempt_occurrences
  WHERE workspace_id = NEW.workspace_id AND attempt_id = NEW.id;
  SELECT count(*) INTO evidence_count
  FROM attachment_preparation_attempt_evidence
  WHERE workspace_id = NEW.workspace_id AND attempt_id = NEW.id;

  IF NEW.policy_mode = 'disabled' THEN
    IF evidence_count <> 0 THEN
      RAISE EXCEPTION 'Disabled attachment preparation cannot retain evidence';
    END IF;
    RETURN NULL;
  END IF;

  IF evidence_count <> occurrence_count THEN
    RAISE EXCEPTION 'Completed attachment preparation must cover every occurrence exactly once';
  END IF;

  SELECT count(*) INTO invalid_ready_count
  FROM attachment_preparation_attempt_evidence AS evidence
  JOIN attachment_preparation_attempt_occurrences AS occurrence
    ON occurrence.workspace_id = evidence.workspace_id
   AND occurrence.attempt_id = evidence.attempt_id
   AND occurrence.occurrence_identity = evidence.occurrence_identity
  LEFT JOIN attachment_derivatives AS derivative
    ON derivative.workspace_id = evidence.workspace_id
   AND derivative.id = evidence.derivative_id
  LEFT JOIN attachment_derivative_sources AS source
    ON source.workspace_id = occurrence.workspace_id
   AND source.attachment_id = occurrence.attachment_id
   AND source.attachment_derivative_id = evidence.derivative_id
  WHERE evidence.workspace_id = NEW.workspace_id
    AND evidence.attempt_id = NEW.id
    AND evidence.outcome = 'ready'
    AND (
      derivative.id IS NULL
      OR derivative.status <> 'completed'
      OR derivative.identity_key <> evidence.derivative_identity
      OR derivative.output_content_hash <> evidence.derivative_content_hash
      OR source.attachment_derivative_id IS NULL
    );
  IF invalid_ready_count <> 0 THEN
    RAISE EXCEPTION 'Attachment preparation ready evidence must pin a completed derivative of its occurrence attachment';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER attachment_preparation_attempt_terminal_state
  AFTER INSERT OR UPDATE ON attachment_preparation_attempts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_attachment_preparation_attempt_terminal_state();

CREATE OR REPLACE FUNCTION reject_attachment_preparation_late_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt_state text;
BEGIN
  SELECT state INTO attempt_state
  FROM attachment_preparation_attempts
  WHERE workspace_id = NEW.workspace_id AND id = NEW.attempt_id;
  IF attempt_state IS DISTINCT FROM 'claimed' THEN
    RAISE EXCEPTION 'Attachment preparation evidence can only be recorded while its attempt is claimed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER attachment_preparation_attempt_evidence_claimed_only
  BEFORE INSERT ON attachment_preparation_attempt_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_attachment_preparation_late_evidence();

CREATE OR REPLACE FUNCTION reject_attachment_preparation_late_occurrence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt_state text;
BEGIN
  SELECT state INTO attempt_state
  FROM attachment_preparation_attempts
  WHERE workspace_id = NEW.workspace_id AND id = NEW.attempt_id;
  IF attempt_state IS DISTINCT FROM 'claimed' THEN
    RAISE EXCEPTION 'Attachment preparation occurrences can only be registered while its attempt is claimed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER attachment_preparation_attempt_occurrences_claimed_only
  BEFORE INSERT ON attachment_preparation_attempt_occurrences
  FOR EACH ROW EXECUTE FUNCTION reject_attachment_preparation_late_occurrence();

CREATE OR REPLACE FUNCTION reject_terminal_attachment_preparation_attempt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.state = 'completed' THEN
    RAISE EXCEPTION 'Terminal attachment preparation attempts are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER attachment_preparation_attempt_terminal_immutable
  BEFORE UPDATE OR DELETE ON attachment_preparation_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_terminal_attachment_preparation_attempt_mutation();

CREATE TRIGGER attachment_preparation_attempt_occurrences_immutable
  BEFORE UPDATE OR DELETE ON attachment_preparation_attempt_occurrences
  FOR EACH ROW EXECUTE FUNCTION pbi_020_reject_immutable_mutation();

CREATE TRIGGER attachment_preparation_attempt_evidence_immutable
  BEFORE UPDATE OR DELETE ON attachment_preparation_attempt_evidence
  FOR EACH ROW EXECUTE FUNCTION pbi_020_reject_immutable_mutation();

CREATE TRIGGER case_snapshot_attachment_preparation_attempts_immutable
  BEFORE UPDATE OR DELETE ON case_snapshot_attachment_preparation_attempts
  FOR EACH ROW EXECUTE FUNCTION pbi_020_reject_immutable_mutation();

CREATE TRIGGER knowledge_revision_attachment_preparation_attempts_immutable
  BEFORE UPDATE OR DELETE ON knowledge_revision_attachment_preparation_attempts
  FOR EACH ROW EXECUTE FUNCTION pbi_020_reject_immutable_mutation();
