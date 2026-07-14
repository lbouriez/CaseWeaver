CREATE TABLE publication_profiles (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  lifecycle text NOT NULL CHECK (lifecycle IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE publication_profile_versions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  publication_profile_id text NOT NULL,
  version text NOT NULL,
  definition_hash text NOT NULL CHECK (definition_hash ~ '^[a-f0-9]{64}$'),
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, publication_profile_id, version),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, publication_profile_id)
    REFERENCES publication_profiles(workspace_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(definition) = 'object')
);

CREATE FUNCTION prevent_publication_profile_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.publication_profile_id IS DISTINCT FROM NEW.publication_profile_id
     OR OLD.version IS DISTINCT FROM NEW.version
     OR OLD.definition_hash IS DISTINCT FROM NEW.definition_hash
     OR OLD.definition IS DISTINCT FROM NEW.definition THEN
    RAISE EXCEPTION 'Publication profile versions are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER publication_profile_versions_immutable
  BEFORE UPDATE ON publication_profile_versions
  FOR EACH ROW
  EXECUTE FUNCTION prevent_publication_profile_version_mutation();

CREATE FUNCTION validate_publication_profile_destination()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  destination_id text;
BEGIN
  destination_id := NEW.definition #>> '{destination,connectorInstanceId}';
  IF destination_id IS NULL OR destination_id = '' THEN
    RAISE EXCEPTION 'Publication profile must declare a destination connector';
  END IF;

  PERFORM 1
  FROM connector_registrations AS destination
  JOIN connector_capabilities AS capability
    ON capability.workspace_id = destination.workspace_id
    AND capability.connector_registration_id = destination.id
    AND capability.capability = 'analysisDestination'
  WHERE destination.workspace_id = NEW.workspace_id
    AND destination.id = destination_id
    AND destination.lifecycle = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Publication profile destination must be an active analysis destination';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER publication_profile_versions_destination_valid
  BEFORE INSERT ON publication_profile_versions
  FOR EACH ROW
  EXECUTE FUNCTION validate_publication_profile_destination();

ALTER TABLE publication_intents
  ADD COLUMN publication_profile_version_id text,
  ADD COLUMN target_connector_instance_id text,
  ADD COLUMN target_resource_type text,
  ADD COLUMN target_external_id text,
  ADD COLUMN destination_connector_instance_id text,
  ADD COLUMN publication_marker text,
  ADD COLUMN identity_hash text,
  ADD COLUMN analysis_result_id text,
  ADD COLUMN approved_by_principal_id text,
  ADD COLUMN approved_at timestamptz,
  ADD CONSTRAINT publication_intents_profile_version_fk
    FOREIGN KEY (workspace_id, publication_profile_version_id)
    REFERENCES publication_profile_versions(workspace_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT publication_intents_result_fk
    FOREIGN KEY (workspace_id, analysis_result_id)
    REFERENCES analysis_results(workspace_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT publication_intents_approval_actor_fk
    FOREIGN KEY (workspace_id, approved_by_principal_id)
    REFERENCES principals(workspace_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT publication_intents_configured_shape_check
    CHECK (
      (
        publication_profile_version_id IS NULL
        AND target_connector_instance_id IS NULL
        AND target_resource_type IS NULL
        AND target_external_id IS NULL
        AND destination_connector_instance_id IS NULL
      )
      OR (
        publication_profile_version_id IS NOT NULL
        AND target_connector_instance_id IS NOT NULL
        AND target_resource_type IS NOT NULL
        AND target_external_id IS NOT NULL
        AND destination_connector_instance_id IS NOT NULL
      )
    ),
  ADD CONSTRAINT publication_intents_marker_shape_check
    CHECK (
      (publication_marker IS NULL AND identity_hash IS NULL AND analysis_result_id IS NULL)
      OR (
        publication_marker IS NOT NULL
        AND identity_hash IS NOT NULL
        AND analysis_result_id IS NOT NULL
      )
    ),
  ADD CONSTRAINT publication_intents_identity_hash_format_check
    CHECK (identity_hash IS NULL OR identity_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT publication_intents_marker_format_check
    CHECK (
      publication_marker IS NULL
      OR publication_marker ~ '^caseweaver\.publication\.v1\.[a-f0-9]{64}$'
    );

CREATE UNIQUE INDEX publication_intents_request_identity_unique
  ON publication_intents (
    workspace_id,
    analysis_job_id,
    publication_profile_version_id,
    target_connector_instance_id,
    target_resource_type,
    target_external_id
  )
  WHERE publication_profile_version_id IS NOT NULL;

CREATE UNIQUE INDEX publication_intents_destination_marker_unique
  ON publication_intents (
    workspace_id,
    destination_connector_instance_id,
    publication_marker
  )
  WHERE publication_marker IS NOT NULL;

CREATE UNIQUE INDEX publication_intents_identity_unique
  ON publication_intents (workspace_id, identity_hash)
  WHERE identity_hash IS NOT NULL;

CREATE FUNCTION prevent_publication_intent_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.publication_profile_version_id IS DISTINCT FROM NEW.publication_profile_version_id
     OR OLD.target_connector_instance_id IS DISTINCT FROM NEW.target_connector_instance_id
     OR OLD.target_resource_type IS DISTINCT FROM NEW.target_resource_type
     OR OLD.target_external_id IS DISTINCT FROM NEW.target_external_id
     OR OLD.destination_connector_instance_id IS DISTINCT FROM NEW.destination_connector_instance_id THEN
    RAISE EXCEPTION 'Publication intent delivery inputs are immutable';
  END IF;

  IF OLD.analysis_result_id IS NOT NULL
     AND (
       OLD.analysis_result_id IS DISTINCT FROM NEW.analysis_result_id
       OR OLD.identity_hash IS DISTINCT FROM NEW.identity_hash
       OR OLD.publication_marker IS DISTINCT FROM NEW.publication_marker
     ) THEN
    RAISE EXCEPTION 'Publication intent identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER publication_intents_identity_immutable
  BEFORE UPDATE ON publication_intents
  FOR EACH ROW
  EXECUTE FUNCTION prevent_publication_intent_identity_mutation();

ALTER TABLE publication_attempts
  ADD COLUMN identity_hash text,
  ADD COLUMN publication_marker text,
  ADD COLUMN receipt jsonb,
  ADD COLUMN error_code text,
  ADD COLUMN error_retryable boolean,
  ADD CONSTRAINT publication_attempts_terminal_shape_check
    CHECK (
      state NOT IN ('published', 'outcomeUnknown', 'failed', 'publishing')
      OR (state = 'published' AND finished_at IS NOT NULL AND receipt IS NOT NULL)
      OR (state = 'outcomeUnknown' AND finished_at IS NOT NULL)
      OR (state = 'failed' AND finished_at IS NOT NULL AND error_code IS NOT NULL AND error_retryable IS NOT NULL)
      OR (state = 'publishing' AND finished_at IS NULL)
    );

CREATE TABLE webhook_inbox (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  endpoint_id text NOT NULL,
  connector_instance_id text NOT NULL,
  analysis_trigger_id text,
  delivery_key text NOT NULL,
  raw_body_digest text NOT NULL CHECK (raw_body_digest ~ '^[a-f0-9]{64}$'),
  verification jsonb NOT NULL,
  signals jsonb NOT NULL,
  received_at timestamptz NOT NULL,
  UNIQUE (endpoint_id, delivery_key),
  CHECK (jsonb_typeof(verification) = 'object'),
  CHECK (jsonb_typeof(signals) = 'array')
);

CREATE TABLE case_analysis_schedules (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  trigger_id text NOT NULL,
  configuration_version text NOT NULL,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('cron', 'interval')),
  cron_expression text,
  timezone text,
  interval_ms bigint,
  jitter_ms bigint,
  enabled boolean NOT NULL DEFAULT true,
  next_run_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  CHECK (
    (
      trigger_kind = 'cron'
      AND cron_expression IS NOT NULL
      AND timezone IS NOT NULL
      AND interval_ms IS NULL
    )
    OR (
      trigger_kind = 'interval'
      AND interval_ms IS NOT NULL
      AND interval_ms > 0
      AND cron_expression IS NULL
      AND timezone IS NULL
    )
  ),
  CHECK (jitter_ms IS NULL OR jitter_ms >= 0)
);
CREATE INDEX case_analysis_schedules_due_idx
  ON case_analysis_schedules (enabled, next_run_at);

CREATE TABLE case_analysis_schedule_leases (
  workspace_id text NOT NULL,
  case_analysis_schedule_id text NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, case_analysis_schedule_id),
  FOREIGN KEY (workspace_id, case_analysis_schedule_id)
    REFERENCES case_analysis_schedules(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE case_analysis_schedule_occurrences (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  case_analysis_schedule_id text NOT NULL,
  occurrence_key text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, case_analysis_schedule_id, occurrence_key),
  FOREIGN KEY (workspace_id, case_analysis_schedule_id)
    REFERENCES case_analysis_schedules(workspace_id, id) ON DELETE RESTRICT
);

ALTER TABLE outbox_envelopes
  DROP CONSTRAINT outbox_envelopes_type_check,
  DROP CONSTRAINT outbox_envelopes_check,
  ADD CONSTRAINT outbox_envelopes_type_check
    CHECK (
      type IN (
        'analysis.execute.v1',
        'analysis.trigger.v1',
        'publication.execute.v1',
        'publication.reconcile.v1',
        'analysis.completed.v1'
      )
    ),
  ADD CONSTRAINT outbox_envelopes_kind_type_check
    CHECK (
      (type = 'analysis.completed.v1' AND kind = 'domainEvent')
      OR (
        type IN (
          'analysis.execute.v1',
          'analysis.trigger.v1',
          'publication.execute.v1',
          'publication.reconcile.v1'
        )
        AND kind = 'command'
      )
    );
