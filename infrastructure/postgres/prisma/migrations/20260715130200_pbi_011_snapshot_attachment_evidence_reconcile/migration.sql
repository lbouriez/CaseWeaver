-- The disposable development database recorded an early draft of 15130000
-- before its attachment-evidence DDL was complete. Keep migration history
-- append-only: this idempotent reconciliation makes both that database and a
-- clean installation converge on the same immutable evidence schema.
ALTER TABLE attachment_derivatives
  ADD COLUMN IF NOT EXISTS output_content_hash TEXT;

ALTER TABLE attachment_derivatives
  ADD COLUMN IF NOT EXISTS output_byte_length BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'attachment_derivatives_output_content_hash_format'
  ) THEN
    ALTER TABLE attachment_derivatives
      ADD CONSTRAINT attachment_derivatives_output_content_hash_format
      CHECK (
        output_content_hash IS NULL
        OR output_content_hash ~ '^[0-9a-fA-F]{64}$'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'attachment_derivatives_output_integrity_pair'
  ) THEN
    ALTER TABLE attachment_derivatives
      ADD CONSTRAINT attachment_derivatives_output_integrity_pair
      CHECK (
        (output_content_hash IS NULL AND output_byte_length IS NULL)
        OR (
          output_content_hash IS NOT NULL
          AND output_byte_length IS NOT NULL
          AND output_byte_length >= 0
        )
      );
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS case_snapshot_attachment_references (
  workspace_id TEXT NOT NULL,
  case_snapshot_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  attachment_id TEXT NOT NULL,
  attachment_derivative_id TEXT NOT NULL,
  processor_version TEXT NOT NULL,
  output_content_hash TEXT NOT NULL
    CHECK (output_content_hash ~ '^[0-9a-fA-F]{64}$'),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, case_snapshot_id, ordinal),
  UNIQUE (workspace_id, case_snapshot_id, attachment_derivative_id),
  CONSTRAINT case_snapshot_attachment_references_workspace_fk
    FOREIGN KEY (workspace_id)
    REFERENCES workspaces (id)
    ON DELETE RESTRICT,
  CONSTRAINT case_snapshot_attachment_references_snapshot_fk
    FOREIGN KEY (workspace_id, case_snapshot_id)
    REFERENCES case_snapshots (workspace_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT case_snapshot_attachment_references_attachment_fk
    FOREIGN KEY (workspace_id, attachment_id)
    REFERENCES attachments (workspace_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT case_snapshot_attachment_references_derivative_fk
    FOREIGN KEY (workspace_id, attachment_derivative_id)
    REFERENCES attachment_derivatives (workspace_id, id)
    ON DELETE RESTRICT
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'case_snapshot_attachment_references_workspace_fk'
  ) THEN
    ALTER TABLE case_snapshot_attachment_references
      ADD CONSTRAINT case_snapshot_attachment_references_workspace_fk
      FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'case_snapshot_attachment_references_snapshot_fk'
  ) THEN
    ALTER TABLE case_snapshot_attachment_references
      ADD CONSTRAINT case_snapshot_attachment_references_snapshot_fk
      FOREIGN KEY (workspace_id, case_snapshot_id)
      REFERENCES case_snapshots (workspace_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'case_snapshot_attachment_references_attachment_fk'
  ) THEN
    ALTER TABLE case_snapshot_attachment_references
      ADD CONSTRAINT case_snapshot_attachment_references_attachment_fk
      FOREIGN KEY (workspace_id, attachment_id)
      REFERENCES attachments (workspace_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'case_snapshot_attachment_references_derivative_fk'
  ) THEN
    ALTER TABLE case_snapshot_attachment_references
      ADD CONSTRAINT case_snapshot_attachment_references_derivative_fk
      FOREIGN KEY (workspace_id, attachment_derivative_id)
      REFERENCES attachment_derivatives (workspace_id, id) ON DELETE RESTRICT;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION reject_case_snapshot_attachment_reference_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'case snapshot attachment references are append-only';
END;
$$;

DROP TRIGGER IF EXISTS case_snapshot_attachment_references_append_only
  ON case_snapshot_attachment_references;

CREATE TRIGGER case_snapshot_attachment_references_append_only
  BEFORE UPDATE OR DELETE ON case_snapshot_attachment_references
  FOR EACH ROW
  EXECUTE FUNCTION reject_case_snapshot_attachment_reference_mutation();
