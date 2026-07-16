-- Automated ingress has no browser session at delivery time.  It therefore
-- retains the authorized principal chosen when the route/schedule was enabled;
-- producers never infer an actor from a current administrator or a request.

ALTER TABLE webhook_endpoints
  ADD COLUMN automated_principal_id text,
  ADD CONSTRAINT webhook_endpoints_automated_principal_fk
    FOREIGN KEY (workspace_id, automated_principal_id)
    REFERENCES principals(workspace_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT webhook_endpoints_trigger_actor_check
    CHECK (
      analysis_trigger_id IS NULL OR automated_principal_id IS NOT NULL
    );

ALTER TABLE webhook_inbox
  ADD COLUMN automated_principal_id text,
  ADD CONSTRAINT webhook_inbox_automated_principal_fk
    FOREIGN KEY (workspace_id, automated_principal_id)
    REFERENCES principals(workspace_id, id)
    ON DELETE RESTRICT;

ALTER TABLE case_analysis_schedules
  ADD COLUMN automated_principal_id text,
  ADD CONSTRAINT case_analysis_schedules_automated_principal_fk
    FOREIGN KEY (workspace_id, automated_principal_id)
    REFERENCES principals(workspace_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT case_analysis_schedules_v2_actor_check
    CHECK (
      analysis_trigger_version_id IS NULL OR automated_principal_id IS NOT NULL
    );

CREATE OR REPLACE FUNCTION case_analysis_schedule_v2_actor_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.analysis_trigger_version_id IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM 1
  FROM principals
  WHERE workspace_id = NEW.workspace_id
    AND id = NEW.automated_principal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Case-analysis schedule requires an authorized workspace principal';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER case_analysis_schedules_v2_actor_guard_trigger
  BEFORE INSERT OR UPDATE OF analysis_trigger_version_id, automated_principal_id
  ON case_analysis_schedules
  FOR EACH ROW
  EXECUTE FUNCTION case_analysis_schedule_v2_actor_guard();
