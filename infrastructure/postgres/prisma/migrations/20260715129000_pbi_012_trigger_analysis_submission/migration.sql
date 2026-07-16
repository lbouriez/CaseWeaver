-- PBI-012: a captured immutable trigger request may create exactly one PBI-011
-- analysis job. Historical requests remain readable; a missing actor cannot be
-- promoted into new execution work.
ALTER TABLE analysis_trigger_requests
  ADD COLUMN actor_principal_id TEXT;

ALTER TABLE analysis_trigger_requests
  ADD CONSTRAINT analysis_trigger_requests_actor_principal_fk
  FOREIGN KEY (workspace_id, actor_principal_id)
  REFERENCES principals (workspace_id, id)
  ON DELETE RESTRICT;

CREATE INDEX analysis_trigger_requests_actor_principal_index
  ON analysis_trigger_requests (workspace_id, actor_principal_id)
  WHERE actor_principal_id IS NOT NULL;

CREATE TABLE analysis_trigger_request_analyses (
  workspace_id TEXT NOT NULL,
  analysis_trigger_request_id TEXT NOT NULL,
  analysis_job_id TEXT NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, analysis_trigger_request_id),
  UNIQUE (workspace_id, analysis_job_id),
  CONSTRAINT analysis_trigger_request_analyses_request_fk
    FOREIGN KEY (workspace_id, analysis_trigger_request_id)
    REFERENCES analysis_trigger_requests (workspace_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT analysis_trigger_request_analyses_job_fk
    FOREIGN KEY (workspace_id, analysis_job_id)
    REFERENCES analysis_jobs (workspace_id, id)
    ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION assert_analysis_trigger_request_analysis_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  request_snapshot_id TEXT;
  request_profile_version_id TEXT;
  request_state TEXT;
  request_actor_principal_id TEXT;
  job_snapshot_id TEXT;
  job_profile_version_id TEXT;
BEGIN
  SELECT
    request.case_snapshot_id,
    request.analysis_profile_version_id,
    request.state,
    request.actor_principal_id
  INTO
    request_snapshot_id,
    request_profile_version_id,
    request_state,
    request_actor_principal_id
  FROM analysis_trigger_requests AS request
  WHERE request.workspace_id = NEW.workspace_id
    AND request.id = NEW.analysis_trigger_request_id
  FOR KEY SHARE;

  SELECT identity.case_snapshot_id, identity.analysis_profile_version_id
  INTO job_snapshot_id, job_profile_version_id
  FROM analysis_jobs AS job
  JOIN analysis_identities AS identity
    ON identity.workspace_id = job.workspace_id
   AND identity.id = job.analysis_identity_id
  WHERE job.workspace_id = NEW.workspace_id
    AND job.id = NEW.analysis_job_id
  FOR KEY SHARE OF job, identity;

  IF request_state IS DISTINCT FROM 'captured'
    OR request_snapshot_id IS NULL
    OR request_actor_principal_id IS NULL
    OR request_snapshot_id IS DISTINCT FROM job_snapshot_id
    OR request_profile_version_id IS DISTINCT FROM job_profile_version_id THEN
    RAISE EXCEPTION
      'analysis trigger request to analysis job link is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER analysis_trigger_request_analyses_validate_insert
  BEFORE INSERT ON analysis_trigger_request_analyses
  FOR EACH ROW
  EXECUTE FUNCTION assert_analysis_trigger_request_analysis_insert();

CREATE OR REPLACE FUNCTION reject_analysis_trigger_request_analysis_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'analysis trigger request analysis links are append-only';
END;
$$;

CREATE TRIGGER analysis_trigger_request_analyses_append_only
  BEFORE UPDATE OR DELETE ON analysis_trigger_request_analyses
  FOR EACH ROW
  EXECUTE FUNCTION reject_analysis_trigger_request_analysis_mutation();
