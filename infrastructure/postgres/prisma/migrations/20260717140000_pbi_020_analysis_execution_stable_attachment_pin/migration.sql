-- PBI-020 originally retained a reference to the superseded mutable
-- attachment-preparation run ledger. New executions pin the terminal stable
-- attempt selected before a snapshot exists. Keep the legacy column for
-- historical records; no row is rewritten or rebound.

ALTER TABLE analysis_execution_inputs
  ADD COLUMN IF NOT EXISTS attachment_preparation_attempt_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'analysis_execution_inputs_stable_attempt_fk'
  ) THEN
    ALTER TABLE analysis_execution_inputs
      ADD CONSTRAINT analysis_execution_inputs_stable_attempt_fk
      FOREIGN KEY (workspace_id, attachment_preparation_attempt_id)
      REFERENCES attachment_preparation_attempts(workspace_id, id)
      ON DELETE RESTRICT;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS analysis_execution_inputs_stable_attempt_idx
  ON analysis_execution_inputs (workspace_id, attachment_preparation_attempt_id)
  WHERE attachment_preparation_attempt_id IS NOT NULL;
