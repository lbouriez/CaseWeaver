-- Existing deployments can contain object keys created before a backend
-- identity existed.  Preserve those items as readable historical work so the
-- application can reject them with its stable fail-closed outcome.  New
-- attachment persistence always writes both fields; this compatibility branch
-- never supplies a backend or permits storage I/O from a key alone.

CREATE OR REPLACE FUNCTION retention_work_item_object_identity_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.target_kind = 'attachmentReference' THEN
    IF NEW.storage_key IS NOT NULL OR NEW.storage_backend_id IS NOT NULL THEN
      RAISE EXCEPTION 'Reference retention work cannot carry object storage identity';
    END IF;
  ELSIF NEW.storage_backend_id IS NOT NULL AND NEW.storage_key IS NULL THEN
    RAISE EXCEPTION 'Retention backend identity requires an object key';
  END IF;
  RETURN NEW;
END;
$$;
