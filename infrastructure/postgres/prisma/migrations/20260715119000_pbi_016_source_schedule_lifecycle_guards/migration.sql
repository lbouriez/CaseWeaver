-- PBI-016 source/schedule lifecycle transitions must remain valid even when
-- two independently authenticated requests race. Application checks provide a
-- clear conflict response; these database guards are the final authority.

CREATE OR REPLACE FUNCTION caseweaver_prevent_disabling_source_with_enabled_schedules()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.lifecycle = 'disabled' AND EXISTS (
    SELECT 1
    FROM knowledge_schedules AS schedule
    WHERE schedule.workspace_id = NEW.workspace_id
      AND schedule.knowledge_source_id = NEW.id
      AND schedule.enabled = TRUE
  ) THEN
    RAISE EXCEPTION 'A knowledge source with enabled schedules cannot be disabled.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER knowledge_sources_prevent_disable_with_enabled_schedules
BEFORE UPDATE OF lifecycle ON knowledge_sources
FOR EACH ROW
WHEN (OLD.lifecycle IS DISTINCT FROM NEW.lifecycle)
EXECUTE FUNCTION caseweaver_prevent_disabling_source_with_enabled_schedules();

CREATE OR REPLACE FUNCTION caseweaver_prevent_enabling_schedule_for_disabled_source()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  source_lifecycle text;
BEGIN
  -- This row lock serializes the inverse source-disable transition. Without
  -- it, both transaction triggers can observe the old state and commit an
  -- invalid enabled-schedule/disabled-source pair.
  SELECT lifecycle
  INTO source_lifecycle
  FROM knowledge_sources AS source
  WHERE source.workspace_id = NEW.workspace_id
    AND source.id = NEW.knowledge_source_id
  FOR UPDATE;
  IF NEW.enabled = TRUE AND source_lifecycle IS DISTINCT FROM 'enabled' THEN
    RAISE EXCEPTION 'An enabled knowledge schedule requires an enabled source.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER knowledge_schedules_prevent_enable_for_disabled_source
BEFORE INSERT OR UPDATE OF enabled, knowledge_source_id, workspace_id ON knowledge_schedules
FOR EACH ROW
WHEN (NEW.enabled = TRUE)
EXECUTE FUNCTION caseweaver_prevent_enabling_schedule_for_disabled_source();
