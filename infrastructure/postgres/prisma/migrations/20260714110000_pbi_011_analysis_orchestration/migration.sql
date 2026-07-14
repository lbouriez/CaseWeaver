ALTER TABLE case_snapshots
  ADD COLUMN snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT case_snapshots_snapshot_object_check
    CHECK (jsonb_typeof(snapshot) = 'object');

ALTER TABLE analysis_profile_versions
  ADD COLUMN definition jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT analysis_profile_versions_definition_object_check
    CHECK (jsonb_typeof(definition) = 'object');

ALTER TABLE analysis_attempts
  ADD COLUMN error_retryable boolean,
  ADD COLUMN stages jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT analysis_attempts_stages_array_check
    CHECK (jsonb_typeof(stages) = 'array');

ALTER TABLE analysis_results
  ADD COLUMN record jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT analysis_results_record_object_check
    CHECK (jsonb_typeof(record) = 'object');

ALTER TABLE evidence
  ADD COLUMN record jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT evidence_record_object_check
    CHECK (jsonb_typeof(record) = 'object');

CREATE FUNCTION prevent_analysis_profile_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.analysis_profile_id IS DISTINCT FROM NEW.analysis_profile_id
     OR OLD.version IS DISTINCT FROM NEW.version
     OR OLD.definition_hash IS DISTINCT FROM NEW.definition_hash
     OR OLD.definition IS DISTINCT FROM NEW.definition THEN
    RAISE EXCEPTION 'Analysis profile versions are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER analysis_profile_versions_immutable
  BEFORE UPDATE ON analysis_profile_versions
  FOR EACH ROW
  EXECUTE FUNCTION prevent_analysis_profile_version_mutation();

CREATE FUNCTION prevent_case_snapshot_payload_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.external_reference_id IS DISTINCT FROM NEW.external_reference_id
     OR OLD.snapshot_hash IS DISTINCT FROM NEW.snapshot_hash
     OR OLD.snapshot IS DISTINCT FROM NEW.snapshot
     OR OLD.observed_at IS DISTINCT FROM NEW.observed_at THEN
    RAISE EXCEPTION 'Case snapshot payloads are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER case_snapshots_payload_immutable
  BEFORE UPDATE ON case_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION prevent_case_snapshot_payload_mutation();
