ALTER TABLE case_snapshots
  ADD COLUMN tombstoned_by_principal_id text,
  ADD COLUMN tombstoned_at timestamptz,
  ADD COLUMN tombstone_reason text,
  ADD CONSTRAINT case_snapshots_tombstoned_by_principal_fk
    FOREIGN KEY (workspace_id, tombstoned_by_principal_id)
    REFERENCES principals(workspace_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT case_snapshots_tombstone_audit_check
    CHECK (
      (
        lifecycle = 'tombstoned'
        AND tombstoned_by_principal_id IS NOT NULL
        AND tombstoned_at IS NOT NULL
        AND tombstone_reason IS NOT NULL
        AND length(tombstone_reason) BETWEEN 1 AND 4000
      )
      OR (
        lifecycle <> 'tombstoned'
        AND tombstoned_by_principal_id IS NULL
        AND tombstoned_at IS NULL
        AND tombstone_reason IS NULL
      )
    );

CREATE FUNCTION prevent_case_snapshot_tombstone_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.lifecycle = 'tombstoned' AND (
    NEW.lifecycle IS DISTINCT FROM OLD.lifecycle
    OR NEW.tombstoned_by_principal_id IS DISTINCT FROM OLD.tombstoned_by_principal_id
    OR NEW.tombstoned_at IS DISTINCT FROM OLD.tombstoned_at
    OR NEW.tombstone_reason IS DISTINCT FROM OLD.tombstone_reason
  ) THEN
    RAISE EXCEPTION 'Case snapshot tombstones are immutable';
  END IF;

  IF OLD.lifecycle = 'active' AND (
    NEW.lifecycle = 'tombstoned'
    AND NEW.tombstoned_by_principal_id IS NOT NULL
    AND NEW.tombstoned_at IS NOT NULL
    AND NEW.tombstone_reason IS NOT NULL
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.lifecycle IS DISTINCT FROM OLD.lifecycle
    OR NEW.tombstoned_by_principal_id IS DISTINCT FROM OLD.tombstoned_by_principal_id
    OR NEW.tombstoned_at IS DISTINCT FROM OLD.tombstoned_at
    OR NEW.tombstone_reason IS DISTINCT FROM OLD.tombstone_reason THEN
    RAISE EXCEPTION 'Case snapshot lifecycle changes require an immutable tombstone';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER case_snapshots_tombstone_immutable
  BEFORE UPDATE ON case_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION prevent_case_snapshot_tombstone_mutation();
