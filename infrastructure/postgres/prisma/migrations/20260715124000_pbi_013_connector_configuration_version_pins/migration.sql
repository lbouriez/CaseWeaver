-- PBI-013: durable work must retain the immutable connector configuration that
-- created it. Never infer a legacy record's connector version from a mutable
-- current aggregate: legacy records remain readable and fail closed at runtime.

ALTER TABLE knowledge_sources
  ADD COLUMN connector_configuration_version_id text,
  ADD CONSTRAINT knowledge_sources_connector_configuration_version_fk
    FOREIGN KEY (workspace_id, connector_configuration_version_id)
    REFERENCES administration_configuration_versions(workspace_id, id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT knowledge_sources_enabled_connector_configuration_version_check
    CHECK (lifecycle = 'disabled' OR connector_configuration_version_id IS NOT NULL)
    NOT VALID;
CREATE INDEX knowledge_sources_connector_configuration_version_idx
  ON knowledge_sources(workspace_id, connector_configuration_version_id)
  WHERE connector_configuration_version_id IS NOT NULL;

CREATE TABLE knowledge_source_runtime_versions (
  workspace_id text NOT NULL,
  knowledge_source_id text NOT NULL,
  source_configuration_version_id text NOT NULL,
  connector_registration_id text NOT NULL,
  connector_configuration_version_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, knowledge_source_id, source_configuration_version_id),
  UNIQUE (workspace_id, knowledge_source_id, source_configuration_version_id,
          connector_configuration_version_id),
  FOREIGN KEY (workspace_id, knowledge_source_id)
    REFERENCES knowledge_sources(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, connector_registration_id)
    REFERENCES connector_registrations(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, source_configuration_version_id)
    REFERENCES administration_configuration_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, connector_configuration_version_id)
    REFERENCES administration_configuration_versions(workspace_id, id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION knowledge_source_runtime_version_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM administration_configuration_versions AS source_version
  JOIN administration_configurations AS source_configuration
    ON source_configuration.workspace_id = source_version.workspace_id
   AND source_configuration.id = source_version.configuration_id
  WHERE source_version.workspace_id = NEW.workspace_id
    AND source_version.id = NEW.source_configuration_version_id
    AND source_configuration.id = NEW.knowledge_source_id
    AND source_configuration.resource_type = 'knowledge-sources';
  IF NOT FOUND THEN RAISE EXCEPTION 'Knowledge source runtime version is invalid.'; END IF;
  PERFORM 1 FROM administration_configuration_versions AS connector_version
  JOIN administration_configurations AS connector_configuration
    ON connector_configuration.workspace_id = connector_version.workspace_id
   AND connector_configuration.id = connector_version.configuration_id
  WHERE connector_version.workspace_id = NEW.workspace_id
    AND connector_version.id = NEW.connector_configuration_version_id
    AND connector_configuration.id = NEW.connector_registration_id
    AND connector_configuration.resource_type = 'connector-instances'
    AND connector_version.descriptor_kind = 'connector';
  IF NOT FOUND THEN RAISE EXCEPTION 'Knowledge source runtime version is invalid.'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER knowledge_source_runtime_version_guard_trigger
  BEFORE INSERT ON knowledge_source_runtime_versions
  FOR EACH ROW EXECUTE FUNCTION knowledge_source_runtime_version_guard();
CREATE OR REPLACE FUNCTION knowledge_source_runtime_version_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Knowledge source runtime versions are immutable.';
END; $$;
CREATE TRIGGER knowledge_source_runtime_version_immutable_trigger
  BEFORE UPDATE OR DELETE ON knowledge_source_runtime_versions
  FOR EACH ROW EXECUTE FUNCTION knowledge_source_runtime_version_immutable();

-- A source is executable only when its own active configuration and the
-- separately pinned connector configuration were validated together. The
-- connector row lock serializes activation against connector disablement.
CREATE OR REPLACE FUNCTION knowledge_source_runtime_configuration_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lifecycle = 'enabled' THEN
    PERFORM 1
    FROM connector_registrations AS connector_lock
    WHERE connector_lock.workspace_id = NEW.workspace_id
      AND connector_lock.id = NEW.connector_registration_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Enabled knowledge sources require an existing connector.';
    END IF;
    PERFORM 1
    FROM administration_configurations AS source_configuration
    JOIN administration_configurations AS connector_configuration
      ON connector_configuration.workspace_id = NEW.workspace_id
     AND connector_configuration.id = NEW.connector_registration_id
     AND connector_configuration.resource_type = 'connector-instances'
     AND connector_configuration.lifecycle = 'active'
    JOIN administration_configuration_versions AS connector_version
      ON connector_version.workspace_id = NEW.workspace_id
     AND connector_version.id = NEW.connector_configuration_version_id
     AND connector_version.configuration_id = connector_configuration.id
     AND connector_version.descriptor_kind = 'connector'
    JOIN connector_registrations AS connector
      ON connector.workspace_id = NEW.workspace_id
     AND connector.id = NEW.connector_registration_id
     AND connector.lifecycle = 'active'
    JOIN connector_capabilities AS capability
      ON capability.workspace_id = connector.workspace_id
     AND capability.connector_registration_id = connector.id
     AND capability.capability = 'knowledgeSource'
    WHERE source_configuration.workspace_id = NEW.workspace_id
      AND source_configuration.id = NEW.id
      AND source_configuration.resource_type = 'knowledge-sources'
      AND source_configuration.lifecycle = 'active'
      AND source_configuration.current_version_id = NEW.configuration_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Enabled knowledge sources require an active pinned connector configuration.';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER knowledge_source_runtime_configuration_guard_trigger
  BEFORE INSERT OR UPDATE ON knowledge_sources
  FOR EACH ROW EXECUTE FUNCTION knowledge_source_runtime_configuration_guard();

ALTER TABLE knowledge_sources
  ADD CONSTRAINT knowledge_sources_runtime_version_mapping_fk
  FOREIGN KEY (workspace_id, id, configuration_version, connector_configuration_version_id)
  REFERENCES knowledge_source_runtime_versions (
    workspace_id, knowledge_source_id, source_configuration_version_id,
    connector_configuration_version_id
  ) DEFERRABLE INITIALLY DEFERRED NOT VALID;

ALTER TABLE knowledge_schedules
  ADD COLUMN connector_configuration_version_id text,
  ADD CONSTRAINT knowledge_schedules_connector_configuration_version_fk
    FOREIGN KEY (workspace_id, connector_configuration_version_id)
    REFERENCES administration_configuration_versions(workspace_id, id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT knowledge_schedules_enabled_connector_configuration_version_check
    CHECK (NOT enabled OR connector_configuration_version_id IS NOT NULL)
    NOT VALID,
  ADD CONSTRAINT knowledge_schedules_runtime_version_mapping_fk
    FOREIGN KEY (workspace_id, knowledge_source_id, configuration_version,
                connector_configuration_version_id)
    REFERENCES knowledge_source_runtime_versions (
      workspace_id, knowledge_source_id, source_configuration_version_id,
      connector_configuration_version_id
    ) NOT VALID,
  ADD CONSTRAINT knowledge_schedules_runtime_version_identity_unique
    UNIQUE (workspace_id, id, configuration_version,
            connector_configuration_version_id);

ALTER TABLE knowledge_schedule_occurrences
  ADD COLUMN source_configuration_version_id text,
  ADD COLUMN connector_configuration_version_id text,
  ADD CONSTRAINT knowledge_schedule_occurrences_runtime_pin_shape_check
    CHECK (source_configuration_version_id IS NOT NULL
       AND connector_configuration_version_id IS NOT NULL) NOT VALID,
  ADD CONSTRAINT knowledge_schedule_occurrences_connector_configuration_version_fk
    FOREIGN KEY (workspace_id, connector_configuration_version_id)
    REFERENCES administration_configuration_versions(workspace_id, id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT knowledge_schedule_occurrences_runtime_version_schedule_fk
    FOREIGN KEY (workspace_id, knowledge_schedule_id,
                source_configuration_version_id, connector_configuration_version_id)
    REFERENCES knowledge_schedules (
      workspace_id, id, configuration_version, connector_configuration_version_id
    ) NOT VALID;

DROP TRIGGER webhook_endpoint_configuration_guard_trigger ON webhook_endpoints;
DROP FUNCTION webhook_endpoint_configuration_guard();
DROP TRIGGER webhook_inbox_configuration_version_immutable_trigger ON webhook_inbox;
DROP FUNCTION webhook_inbox_configuration_version_immutable();

ALTER TABLE webhook_endpoints
  RENAME COLUMN configuration_version_id TO endpoint_configuration_version_id;
ALTER TABLE webhook_inbox
  RENAME COLUMN configuration_version_id TO endpoint_configuration_version_id;
ALTER TABLE webhook_inbox
  RENAME CONSTRAINT webhook_inbox_configuration_version_fk
  TO webhook_inbox_endpoint_configuration_version_fk;
ALTER TABLE webhook_endpoints
  ADD COLUMN connector_configuration_version_id text,
  ADD CONSTRAINT webhook_endpoints_connector_configuration_version_fk
    FOREIGN KEY (workspace_id, connector_configuration_version_id)
    REFERENCES administration_configuration_versions(workspace_id, id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT webhook_endpoints_active_connector_configuration_version_check
    CHECK (lifecycle = 'disabled' OR connector_configuration_version_id IS NOT NULL)
    NOT VALID;
ALTER TABLE webhook_inbox
  ADD COLUMN connector_configuration_version_id text,
  ADD CONSTRAINT webhook_inbox_connector_configuration_version_fk
    FOREIGN KEY (workspace_id, connector_configuration_version_id)
    REFERENCES administration_configuration_versions(workspace_id, id)
    ON DELETE RESTRICT NOT VALID;

-- The endpoint's own immutable configuration selects the public route.  The
-- separate connector pin selects the private verifier. Neither may be
-- inferred from a mutable current connector configuration at request time.
CREATE OR REPLACE FUNCTION webhook_endpoint_configuration_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lifecycle = 'active' THEN
    PERFORM 1
    FROM connector_registrations AS connector_lock
    WHERE connector_lock.workspace_id = NEW.workspace_id
      AND connector_lock.id = NEW.connector_instance_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Active webhook endpoints require an existing connector.';
    END IF;
    PERFORM 1
    FROM administration_configurations AS endpoint_configuration
    JOIN administration_configurations AS connector_configuration
      ON connector_configuration.workspace_id = NEW.workspace_id
     AND connector_configuration.id = NEW.connector_instance_id
     AND connector_configuration.resource_type = 'connector-instances'
     AND connector_configuration.lifecycle = 'active'
    JOIN administration_configuration_versions AS connector_version
      ON connector_version.workspace_id = NEW.workspace_id
     AND connector_version.id = NEW.connector_configuration_version_id
     AND connector_version.configuration_id = connector_configuration.id
     AND connector_version.descriptor_kind = 'connector'
    JOIN connector_registrations AS connector
      ON connector.workspace_id = NEW.workspace_id
     AND connector.id = NEW.connector_instance_id
     AND connector.lifecycle = 'active'
    JOIN connector_capabilities AS capability
      ON capability.workspace_id = connector.workspace_id
     AND capability.connector_registration_id = connector.id
     AND capability.capability = 'webhookAdapter'
    WHERE endpoint_configuration.workspace_id = NEW.workspace_id
      AND endpoint_configuration.id = NEW.id
      AND endpoint_configuration.resource_type = 'webhook-endpoints'
      AND endpoint_configuration.lifecycle = 'active'
      AND endpoint_configuration.current_version_id = NEW.endpoint_configuration_version_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Active webhook endpoints require their current configuration and an active pinned webhook adapter.';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER webhook_endpoint_configuration_guard_trigger
  BEFORE INSERT OR UPDATE ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION webhook_endpoint_configuration_guard();

CREATE OR REPLACE FUNCTION webhook_inbox_configuration_versions_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.endpoint_configuration_version_id IS DISTINCT FROM NEW.endpoint_configuration_version_id
     OR OLD.connector_configuration_version_id IS DISTINCT FROM NEW.connector_configuration_version_id THEN
    RAISE EXCEPTION 'Webhook inbox configuration versions are immutable.';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER webhook_inbox_configuration_versions_immutable_trigger
  BEFORE UPDATE ON webhook_inbox
  FOR EACH ROW EXECUTE FUNCTION webhook_inbox_configuration_versions_immutable();

-- Extend the existing inverse lifecycle guard so no active source or public
-- webhook endpoint can be left pointing at a disabled connector. The matching
-- activation triggers lock this row first, preventing READ COMMITTED races.
CREATE OR REPLACE FUNCTION webhook_endpoint_connector_lifecycle_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.lifecycle <> 'disabled' AND NEW.lifecycle = 'disabled' THEN
    PERFORM 1 FROM webhook_endpoints
    WHERE workspace_id = NEW.workspace_id
      AND connector_instance_id = NEW.id
      AND lifecycle = 'active'
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'A connector with active webhook endpoints cannot be disabled.';
    END IF;
    PERFORM 1 FROM knowledge_sources
    WHERE workspace_id = NEW.workspace_id
      AND connector_registration_id = NEW.id
      AND lifecycle = 'enabled'
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'A connector with enabled knowledge sources cannot be disabled.';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

ALTER TABLE outbox_envelopes
  DROP CONSTRAINT outbox_envelopes_type_check,
  DROP CONSTRAINT outbox_envelopes_kind_type_check,
  ADD CONSTRAINT outbox_envelopes_type_check CHECK (type IN (
    'analysis.execute.v1','analysis.trigger.v1','publication.execute.v1',
    'publication.reconcile.v1','analysis.completed.v1','knowledge.synchronize.v1',
    'knowledge.full-rescan.v1','knowledge.synchronize.v2','knowledge.full-rescan.v2',
    'retention.reap.v1','retention.purge.v1','diagnostics.export.generate.v1'
  )),
  ADD CONSTRAINT outbox_envelopes_kind_type_check CHECK (
    (type = 'analysis.completed.v1' AND kind = 'domainEvent') OR
    (type <> 'analysis.completed.v1' AND kind = 'command')
  ),
  ADD CONSTRAINT outbox_envelopes_knowledge_v2_payload_shape_check CHECK (
    type NOT IN ('knowledge.synchronize.v2','knowledge.full-rescan.v2') OR
    (jsonb_typeof(payload) = 'object' AND jsonb_typeof(payload->'sourceId') = 'string'
      AND jsonb_typeof(payload->'sourceConfigurationVersionId') = 'string'
      AND jsonb_typeof(payload->'connectorConfigurationVersionId') = 'string'
      AND payload->>'trigger' IN ('manual','schedule'))
  );

CREATE OR REPLACE FUNCTION outbox_knowledge_v2_runtime_pin_guard()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.type IN ('knowledge.synchronize.v2','knowledge.full-rescan.v2') THEN
    PERFORM 1 FROM knowledge_source_runtime_versions
    WHERE workspace_id = NEW.workspace_id
      AND knowledge_source_id = NEW.payload->>'sourceId'
      AND source_configuration_version_id = NEW.payload->>'sourceConfigurationVersionId'
      AND connector_configuration_version_id = NEW.payload->>'connectorConfigurationVersionId';
    IF NOT FOUND THEN RAISE EXCEPTION 'Knowledge runtime configuration is unavailable.'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER outbox_knowledge_v2_runtime_pin_guard_trigger
  BEFORE INSERT OR UPDATE OF type, payload, workspace_id ON outbox_envelopes
  FOR EACH ROW EXECUTE FUNCTION outbox_knowledge_v2_runtime_pin_guard();
