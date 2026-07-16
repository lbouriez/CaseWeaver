-- PBI-011/PBI-008: normalized attachment output is immutable evidence only when
-- its exact SHA-256 is retained. Legacy derivative rows remain readable but
-- cannot become analysis evidence until a successor is processed with a hash.
ALTER TABLE attachment_derivatives
  ADD COLUMN output_content_hash TEXT;

ALTER TABLE attachment_derivatives
  ADD COLUMN output_byte_length BIGINT;

ALTER TABLE attachment_derivatives
  ADD CONSTRAINT attachment_derivatives_output_content_hash_format
  CHECK (
    output_content_hash IS NULL
    OR output_content_hash ~ '^[0-9a-fA-F]{64}$'
  );

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

CREATE OR REPLACE FUNCTION enforce_attachment_derivative_output_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'completed'
    AND (
      NEW.output_storage_key IS NULL
      OR NEW.output_storage_backend_id IS NULL
      OR NEW.output_mime_type IS DISTINCT FROM 'text/plain'
      OR NEW.output_content_hash IS NULL
      OR NEW.output_byte_length IS NULL
    ) THEN
    RAISE EXCEPTION 'completed attachment derivative requires verified output integrity';
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD.status = 'completed'
    AND NEW.status = 'completed'
    AND (
      NEW.output_content_hash IS DISTINCT FROM OLD.output_content_hash
      OR NEW.output_byte_length IS DISTINCT FROM OLD.output_byte_length
    ) THEN
    RAISE EXCEPTION 'completed attachment derivative output integrity is immutable';
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD.status = 'completed'
    AND NEW.status <> 'completed'
    AND (NEW.output_content_hash IS NOT NULL OR NEW.output_byte_length IS NOT NULL) THEN
    RAISE EXCEPTION 'reclaimed attachment derivative must clear output integrity';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER attachment_derivatives_output_integrity
  BEFORE INSERT OR UPDATE ON attachment_derivatives
  FOR EACH ROW
  EXECUTE FUNCTION enforce_attachment_derivative_output_integrity();

CREATE TABLE case_snapshot_attachment_references (
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

CREATE OR REPLACE FUNCTION reject_case_snapshot_attachment_reference_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'case snapshot attachment references are append-only';
END;
$$;

CREATE TRIGGER case_snapshot_attachment_references_append_only
  BEFORE UPDATE OR DELETE ON case_snapshot_attachment_references
  FOR EACH ROW
  EXECUTE FUNCTION reject_case_snapshot_attachment_reference_mutation();
