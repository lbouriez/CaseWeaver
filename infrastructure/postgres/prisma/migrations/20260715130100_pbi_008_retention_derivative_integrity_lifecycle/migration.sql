-- PBI-008/PBI-013: completed derivative evidence is required only when a
-- derivative first becomes retained completed content.  Retention cleanup
-- deliberately keeps the completed lifecycle marker while clearing its
-- server-private object handle, so it must not be rejected by the evidence
-- integrity guard after the row has moved to deleted retention state.
CREATE OR REPLACE FUNCTION enforce_attachment_derivative_output_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'completed'
    AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'completed')
    AND NEW.retention_state <> 'deleted'
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
