-- Versioned trigger requests decouple safe producer ingress from server-private
-- case capture. New work keeps exact trigger/profile/connector configuration
-- pins; no settings, secret locators, request bodies, or source URLs are held.

CREATE TABLE analysis_triggers (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('active', 'disabled')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  current_version_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  CHECK (lifecycle = 'disabled' OR current_version_id IS NOT NULL),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT
);

CREATE TABLE analysis_trigger_versions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  analysis_trigger_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  analysis_profile_version_id text NOT NULL,
  connector_registration_id text NOT NULL,
  connector_configuration_version_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, analysis_trigger_id, id),
  UNIQUE (workspace_id, analysis_trigger_id, version),
  FOREIGN KEY (workspace_id, analysis_trigger_id)
    REFERENCES analysis_triggers(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, analysis_profile_version_id)
    REFERENCES analysis_profile_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, connector_registration_id)
    REFERENCES connector_registrations(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, connector_configuration_version_id)
    REFERENCES administration_configuration_versions(workspace_id, id) ON DELETE RESTRICT
);

ALTER TABLE analysis_triggers
  ADD CONSTRAINT analysis_trigger_current_version_fk
    FOREIGN KEY (workspace_id, id, current_version_id)
    REFERENCES analysis_trigger_versions(workspace_id, analysis_trigger_id, id)
    ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION analysis_trigger_version_configuration_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Locks serialize activation against connector/configuration disablement.
  PERFORM 1
  FROM connector_registrations
  WHERE workspace_id = NEW.workspace_id
    AND id = NEW.connector_registration_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Analysis trigger requires an existing case source connector';
  END IF;

  PERFORM 1
  FROM analysis_profile_versions AS profile
  JOIN connector_registrations AS connector
    ON connector.workspace_id = NEW.workspace_id
   AND connector.id = NEW.connector_registration_id
   AND connector.lifecycle = 'active'
  JOIN connector_capabilities AS capability
    ON capability.workspace_id = connector.workspace_id
   AND capability.connector_registration_id = connector.id
   AND capability.capability = 'caseSource'
  JOIN administration_configurations AS configuration
    ON configuration.workspace_id = connector.workspace_id
   AND configuration.id = connector.id
   AND configuration.resource_type = 'connector-instances'
   AND configuration.lifecycle = 'active'
   AND configuration.current_version_id = NEW.connector_configuration_version_id
  JOIN administration_configuration_versions AS connector_version
    ON connector_version.workspace_id = configuration.workspace_id
   AND connector_version.id = NEW.connector_configuration_version_id
   AND connector_version.configuration_id = configuration.id
   AND connector_version.descriptor_kind = 'connector'
  JOIN administration_descriptor_revisions AS descriptor
    ON descriptor.kind = connector_version.descriptor_kind
   AND descriptor.type = connector_version.descriptor_type
   AND descriptor.version = connector_version.descriptor_version
   AND descriptor.descriptor -> 'connectorCapabilities' ? 'caseSource'
  WHERE profile.workspace_id = NEW.workspace_id
    AND profile.id = NEW.analysis_profile_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Analysis trigger requires active pinned case source configuration';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER analysis_trigger_versions_configuration_guard_trigger
  BEFORE INSERT ON analysis_trigger_versions
  FOR EACH ROW
  EXECUTE FUNCTION analysis_trigger_version_configuration_guard();

CREATE OR REPLACE FUNCTION analysis_trigger_version_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Analysis trigger versions are immutable';
END;
$$;

CREATE TRIGGER analysis_trigger_versions_immutable_trigger
  BEFORE UPDATE OR DELETE ON analysis_trigger_versions
  FOR EACH ROW
  EXECUTE FUNCTION analysis_trigger_version_immutable();

CREATE TABLE analysis_trigger_requests (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  analysis_trigger_version_id text NOT NULL,
  analysis_profile_version_id text NOT NULL,
  connector_registration_id text NOT NULL,
  connector_configuration_version_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('manual', 'schedule', 'webhook')),
  occurrence_key text,
  target_connector_instance_id text NOT NULL,
  target_resource_type text NOT NULL,
  target_external_id text NOT NULL,
  idempotency_key_digest char(64) NOT NULL,
  request_digest char(64) NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'capturing', 'captured', 'failed')),
  capture_fencing_token bigint NOT NULL DEFAULT 0 CHECK (capture_fencing_token >= 0),
  capture_lease_expires_at timestamptz,
  case_snapshot_id text,
  error_code text,
  error_retryable boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  captured_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key_digest),
  FOREIGN KEY (workspace_id, analysis_trigger_version_id)
    REFERENCES analysis_trigger_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, analysis_profile_version_id)
    REFERENCES analysis_profile_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, connector_registration_id)
    REFERENCES connector_registrations(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, connector_configuration_version_id)
    REFERENCES administration_configuration_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, case_snapshot_id)
    REFERENCES case_snapshots(workspace_id, id) ON DELETE RESTRICT,
  CHECK (
    (state = 'pending'
      AND capture_lease_expires_at IS NULL
      AND case_snapshot_id IS NULL
      AND error_code IS NULL
      AND error_retryable IS NULL)
    OR
    (state = 'capturing'
      AND capture_lease_expires_at IS NOT NULL
      AND case_snapshot_id IS NULL
      AND error_code IS NULL
      AND error_retryable IS NULL)
    OR
    (state = 'captured'
      AND capture_lease_expires_at IS NULL
      AND case_snapshot_id IS NOT NULL
      AND error_code IS NULL
      AND error_retryable IS NULL)
    OR
    (state = 'failed'
      AND capture_lease_expires_at IS NULL
      AND case_snapshot_id IS NULL
      AND error_code IS NOT NULL
      AND error_retryable IS NOT NULL)
  )
);
CREATE INDEX analysis_trigger_requests_capture_claim_idx
  ON analysis_trigger_requests (workspace_id, state, capture_lease_expires_at, created_at);
CREATE INDEX analysis_trigger_requests_snapshot_idx
  ON analysis_trigger_requests (workspace_id, case_snapshot_id)
  WHERE case_snapshot_id IS NOT NULL;

CREATE OR REPLACE FUNCTION analysis_trigger_request_pin_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1
  FROM analysis_trigger_versions AS version
  WHERE version.workspace_id = NEW.workspace_id
    AND version.id = NEW.analysis_trigger_version_id
    AND version.analysis_profile_version_id = NEW.analysis_profile_version_id
    AND version.connector_registration_id = NEW.connector_registration_id
    AND version.connector_configuration_version_id = NEW.connector_configuration_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Analysis trigger request configuration pins are invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER analysis_trigger_requests_pin_guard_trigger
  BEFORE INSERT ON analysis_trigger_requests
  FOR EACH ROW
  EXECUTE FUNCTION analysis_trigger_request_pin_guard();

CREATE OR REPLACE FUNCTION analysis_trigger_request_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Analysis trigger requests are immutable';
  END IF;
  IF OLD.analysis_trigger_version_id IS DISTINCT FROM NEW.analysis_trigger_version_id
     OR OLD.analysis_profile_version_id IS DISTINCT FROM NEW.analysis_profile_version_id
     OR OLD.connector_registration_id IS DISTINCT FROM NEW.connector_registration_id
     OR OLD.connector_configuration_version_id IS DISTINCT FROM NEW.connector_configuration_version_id
     OR OLD.source IS DISTINCT FROM NEW.source
     OR OLD.occurrence_key IS DISTINCT FROM NEW.occurrence_key
     OR OLD.target_connector_instance_id IS DISTINCT FROM NEW.target_connector_instance_id
     OR OLD.target_resource_type IS DISTINCT FROM NEW.target_resource_type
     OR OLD.target_external_id IS DISTINCT FROM NEW.target_external_id
     OR OLD.idempotency_key_digest IS DISTINCT FROM NEW.idempotency_key_digest
     OR OLD.request_digest IS DISTINCT FROM NEW.request_digest THEN
    RAISE EXCEPTION 'Analysis trigger request inputs are immutable';
  END IF;
  IF OLD.capture_fencing_token > NEW.capture_fencing_token THEN
    RAISE EXCEPTION 'Analysis trigger capture fencing cannot decrease';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER analysis_trigger_requests_immutable_guard_trigger
  BEFORE UPDATE OR DELETE ON analysis_trigger_requests
  FOR EACH ROW
  EXECUTE FUNCTION analysis_trigger_request_immutable_guard();

CREATE OR REPLACE FUNCTION analysis_trigger_connector_lifecycle_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.lifecycle <> 'disabled' AND NEW.lifecycle = 'disabled' THEN
    PERFORM 1
    FROM analysis_triggers AS trigger
    JOIN analysis_trigger_versions AS version
      ON version.workspace_id = trigger.workspace_id
     AND version.id = trigger.current_version_id
    WHERE trigger.workspace_id = NEW.workspace_id
      AND trigger.lifecycle = 'active'
      AND version.connector_registration_id = NEW.id
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'A connector with active analysis triggers cannot be disabled';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER analysis_trigger_connector_lifecycle_guard_trigger
  BEFORE UPDATE OF lifecycle ON connector_registrations
  FOR EACH ROW
  EXECUTE FUNCTION analysis_trigger_connector_lifecycle_guard();

CREATE OR REPLACE FUNCTION analysis_trigger_configuration_lifecycle_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.resource_type = 'connector-instances'
     AND OLD.lifecycle = 'active'
     AND NEW.lifecycle <> 'active' THEN
    PERFORM 1
    FROM connector_registrations
    WHERE workspace_id = NEW.workspace_id AND id = NEW.id
    FOR UPDATE;
    PERFORM 1
    FROM analysis_triggers AS trigger
    JOIN analysis_trigger_versions AS version
      ON version.workspace_id = trigger.workspace_id
     AND version.id = trigger.current_version_id
    WHERE trigger.workspace_id = NEW.workspace_id
      AND trigger.lifecycle = 'active'
      AND version.connector_registration_id = NEW.id
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'A connector configuration with active analysis triggers cannot be disabled';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER analysis_trigger_configuration_lifecycle_guard_trigger
  BEFORE UPDATE OF lifecycle ON administration_configurations
  FOR EACH ROW
  EXECUTE FUNCTION analysis_trigger_configuration_lifecycle_guard();

ALTER TABLE outbox_envelopes
  DROP CONSTRAINT outbox_envelopes_type_check,
  DROP CONSTRAINT outbox_envelopes_kind_type_check,
  ADD CONSTRAINT outbox_envelopes_type_check CHECK (type IN (
    'analysis.execute.v1','analysis.trigger.v1','analysis.trigger.v2',
    'publication.execute.v1','publication.reconcile.v1','analysis.completed.v1',
    'knowledge.synchronize.v1','knowledge.full-rescan.v1',
    'knowledge.synchronize.v2','knowledge.full-rescan.v2',
    'retention.reap.v1','retention.purge.v1','diagnostics.export.generate.v1'
  )),
  ADD CONSTRAINT outbox_envelopes_kind_type_check CHECK (
    (type = 'analysis.completed.v1' AND kind = 'domainEvent') OR
    (type <> 'analysis.completed.v1' AND kind = 'command')
  ),
  ADD CONSTRAINT outbox_analysis_trigger_v2_payload_check CHECK (
    type <> 'analysis.trigger.v2' OR
    (
      jsonb_typeof(payload) = 'object'
      AND jsonb_typeof(payload->'triggerRequestId') = 'string'
      AND jsonb_typeof(payload->'triggerId') = 'string'
      AND jsonb_typeof(payload->'triggerVersionId') = 'string'
      AND jsonb_typeof(payload->'connectorRegistrationId') = 'string'
      AND jsonb_typeof(payload->'connectorConfigurationVersionId') = 'string'
      AND payload->>'source' IN ('manual','schedule','webhook')
      AND jsonb_typeof(payload->'target') = 'object'
      AND jsonb_typeof(payload->'target'->'connectorInstanceId') = 'string'
      AND jsonb_typeof(payload->'target'->'resourceType') = 'string'
      AND jsonb_typeof(payload->'target'->'externalId') = 'string'
    )
  );
