-- PBI-016 opaque webhook endpoint administration. Endpoint configuration is a
-- server-owned projection of immutable administration configuration versions;
-- delivery history remains separate and never stores raw headers or bodies.

ALTER TABLE webhook_inbox
  ADD COLUMN configuration_version_id text,
  ADD CONSTRAINT webhook_inbox_workspace_id_unique UNIQUE (workspace_id, id),
  ADD CONSTRAINT webhook_inbox_configuration_version_fk
    FOREIGN KEY (workspace_id, configuration_version_id)
    REFERENCES administration_configuration_versions(workspace_id, id)
    ON DELETE RESTRICT NOT VALID;

CREATE TABLE webhook_endpoints (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{1,200}$'),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  lifecycle text NOT NULL CHECK (lifecycle IN ('active', 'disabled')),
  connector_instance_id text NOT NULL,
  configuration_version_id text NOT NULL,
  verified_event_types jsonb NOT NULL,
  maximum_body_bytes integer NOT NULL CHECK (
    maximum_body_bytes BETWEEN 1 AND 10485760
  ),
  maximum_requests_per_minute integer NOT NULL CHECK (
    maximum_requests_per_minute BETWEEN 1 AND 10000
  ),
  analysis_trigger_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, id),
  FOREIGN KEY (workspace_id, connector_instance_id)
    REFERENCES connector_registrations(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, configuration_version_id)
    REFERENCES administration_configuration_versions(workspace_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(verified_event_types) = 'array')
);
CREATE INDEX webhook_endpoints_workspace_lifecycle_idx
  ON webhook_endpoints(workspace_id, lifecycle, updated_at DESC, id DESC);

CREATE TABLE webhook_endpoint_rate_windows (
  workspace_id text NOT NULL,
  endpoint_id text NOT NULL,
  window_started_at timestamptz NOT NULL,
  acquired_count integer NOT NULL CHECK (acquired_count >= 1),
  PRIMARY KEY (workspace_id, endpoint_id, window_started_at),
  FOREIGN KEY (workspace_id, endpoint_id)
    REFERENCES webhook_endpoints(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE webhook_replay_requests (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  endpoint_id text NOT NULL,
  webhook_inbox_id text NOT NULL,
  idempotency_key_digest char(64) NOT NULL
    CHECK (idempotency_key_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('requested', 'queued', 'completed', 'failed')),
  outbox_envelope_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(workspace_id, endpoint_id, webhook_inbox_id),
  UNIQUE(workspace_id, idempotency_key_digest),
  FOREIGN KEY (workspace_id, endpoint_id)
    REFERENCES webhook_endpoints(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, webhook_inbox_id)
    REFERENCES webhook_inbox(workspace_id, id) ON DELETE RESTRICT,
  CHECK (
    (state IN ('requested', 'queued') AND completed_at IS NULL)
    OR (state IN ('completed', 'failed') AND completed_at IS NOT NULL)
  )
);
CREATE INDEX webhook_replay_requests_queue_idx
  ON webhook_replay_requests(workspace_id, state, created_at);

-- An active public endpoint must be tied to the current immutable
-- configuration version and to an active connector explicitly declaring the
-- webhook-adapter capability. The trigger intentionally never examines a
-- request header/body or a secret locator.
CREATE OR REPLACE FUNCTION webhook_endpoint_configuration_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lifecycle = 'active' THEN
    PERFORM 1
    FROM administration_configurations AS configuration
    JOIN administration_configuration_versions AS version
      ON version.workspace_id = configuration.workspace_id
     AND version.id = configuration.current_version_id
    JOIN connector_registrations AS connector
      ON connector.workspace_id = NEW.workspace_id
     AND connector.id = NEW.connector_instance_id
    JOIN connector_capabilities AS capability
      ON capability.workspace_id = connector.workspace_id
     AND capability.connector_registration_id = connector.id
     AND capability.capability = 'webhookAdapter'
    WHERE configuration.workspace_id = NEW.workspace_id
      AND configuration.id = NEW.id
      AND configuration.resource_type = 'webhook-endpoints'
      AND configuration.lifecycle = 'active'
      AND version.id = NEW.configuration_version_id
      AND connector.lifecycle = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Active webhook endpoints require their current configuration and an active webhook adapter.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER webhook_endpoint_configuration_guard_trigger
  BEFORE INSERT OR UPDATE ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION webhook_endpoint_configuration_guard();

-- A delivery is forever tied to the immutable configuration that accepted it.
CREATE OR REPLACE FUNCTION webhook_inbox_configuration_version_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.configuration_version_id IS DISTINCT FROM NEW.configuration_version_id THEN
    RAISE EXCEPTION 'Webhook inbox configuration version is immutable.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER webhook_inbox_configuration_version_immutable_trigger
  BEFORE UPDATE ON webhook_inbox
  FOR EACH ROW EXECUTE FUNCTION webhook_inbox_configuration_version_immutable();
