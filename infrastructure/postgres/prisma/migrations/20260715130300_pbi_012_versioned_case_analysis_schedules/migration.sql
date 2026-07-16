-- A scheduled case analysis has to retain the same immutable trigger revision
-- and opaque target as webhook/manual v2 ingress.  The predecessor schedule
-- table had neither, so old rows deliberately remain readable but cannot be
-- executed by a v2 producer.

ALTER TABLE case_analysis_schedules
  ADD COLUMN analysis_trigger_version_id text,
  ADD COLUMN target_connector_instance_id text,
  ADD COLUMN target_resource_type text,
  ADD COLUMN target_external_id text,
  ADD CONSTRAINT case_analysis_schedules_trigger_version_fk
    FOREIGN KEY (workspace_id, analysis_trigger_version_id)
    REFERENCES analysis_trigger_versions(workspace_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT case_analysis_schedules_target_connector_fk
    FOREIGN KEY (workspace_id, target_connector_instance_id)
    REFERENCES connector_registrations(workspace_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT case_analysis_schedules_v2_fields_complete_check
    CHECK (
      (analysis_trigger_version_id IS NULL
       AND target_connector_instance_id IS NULL
       AND target_resource_type IS NULL
       AND target_external_id IS NULL)
      OR
      (analysis_trigger_version_id IS NOT NULL
       AND target_connector_instance_id IS NOT NULL
       AND target_resource_type IS NOT NULL
       AND target_external_id IS NOT NULL
       AND length(target_resource_type) BETWEEN 1 AND 200
       AND length(target_external_id) BETWEEN 1 AND 512)
    );

CREATE OR REPLACE FUNCTION case_analysis_schedule_v2_pin_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Legacy schedules have no target/version proof.  They may be retained for
  -- audit but are rejected by the scheduler rather than rebound to current
  -- configuration.
  IF NEW.analysis_trigger_version_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM analysis_triggers AS trigger
  JOIN analysis_trigger_versions AS version
    ON version.workspace_id = trigger.workspace_id
   AND version.id = NEW.analysis_trigger_version_id
   AND version.analysis_trigger_id = NEW.trigger_id
  WHERE trigger.workspace_id = NEW.workspace_id
    AND trigger.id = NEW.trigger_id
    AND trigger.lifecycle = 'active'
    AND trigger.current_version_id = NEW.analysis_trigger_version_id
    AND version.connector_registration_id = NEW.target_connector_instance_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Case-analysis schedule requires an active exact trigger version and target connector';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER case_analysis_schedules_v2_pin_guard_trigger
  BEFORE INSERT OR UPDATE OF trigger_id, analysis_trigger_version_id,
    target_connector_instance_id, target_resource_type, target_external_id
  ON case_analysis_schedules
  FOR EACH ROW
  EXECUTE FUNCTION case_analysis_schedule_v2_pin_guard();

CREATE INDEX case_analysis_schedules_v2_due_idx
  ON case_analysis_schedules (enabled, next_run_at)
  WHERE analysis_trigger_version_id IS NOT NULL;
