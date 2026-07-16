-- PBI-013 canonical retention lifecycle
--
-- Object keys are meaningful only with the workspace and immutable backend
-- identity that created them.  Existing key-only records are deliberately not
-- backfilled: choosing the current deployment backend would be an unsafe
-- reinterpretation of historical data.  The worker exposes those records as
-- legacy work and fails closed before any storage I/O.

ALTER TABLE attachment_blobs
  ADD COLUMN storage_backend_id text,
  ADD COLUMN retention_expires_at timestamptz,
  ADD CONSTRAINT attachment_blobs_storage_backend_id_check
    CHECK (
      storage_backend_id IS NULL
      OR storage_backend_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
    );

ALTER TABLE attachment_derivatives
  ADD COLUMN output_storage_backend_id text,
  ADD CONSTRAINT attachment_derivatives_output_storage_backend_id_check
    CHECK (
      output_storage_backend_id IS NULL
      OR output_storage_backend_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
    );

ALTER TABLE retention_work_items
  ADD COLUMN storage_backend_id text,
  DROP CONSTRAINT retention_work_items_target_kind_check,
  ADD CONSTRAINT retention_work_items_target_kind_check
    CHECK (
      target_kind IN (
        'attachmentReference',
        'attachmentBlob',
        'attachmentDerivative'
      )
    ),
  ADD CONSTRAINT retention_work_items_storage_backend_id_check
    CHECK (
      storage_backend_id IS NULL
      OR storage_backend_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
    );

-- Existing rows may contain a key without a backend identifier.  They remain
-- immutable historical work; all newly inserted rows must carry a complete
-- identity when they carry an object reference.  Reference-only work never
-- points at object storage.
CREATE OR REPLACE FUNCTION retention_work_item_object_identity_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.target_kind = 'attachmentReference' THEN
    IF NEW.storage_key IS NOT NULL OR NEW.storage_backend_id IS NOT NULL THEN
      RAISE EXCEPTION 'Reference retention work cannot carry object storage identity';
    END IF;
  ELSIF (NEW.storage_key IS NULL) <> (NEW.storage_backend_id IS NULL) THEN
    RAISE EXCEPTION 'Retention object work requires both storage key and backend identity';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER retention_work_item_object_identity_guard_trigger
  BEFORE INSERT ON retention_work_items
  FOR EACH ROW EXECUTE FUNCTION retention_work_item_object_identity_guard();

CREATE INDEX attachment_blobs_retention_expiry_idx
  ON attachment_blobs (workspace_id, retention_state, retention_expires_at, id)
  WHERE retention_state = 'active' AND retention_expires_at IS NOT NULL;
