-- PBI-016 race-safe inverse lifecycle protection for active webhook endpoints.
-- Kept forward-only because the endpoint schema migration may already exist in
-- a development or operator database.

CREATE OR REPLACE FUNCTION webhook_endpoint_configuration_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lifecycle = 'active' THEN
    -- Serialize endpoint activation with inverse connector disablement. A
    -- non-key lifecycle update otherwise does not conflict with a weak shared
    -- row lock under READ COMMITTED.
    PERFORM 1
    FROM connector_registrations AS connector_lock
    WHERE connector_lock.workspace_id = NEW.workspace_id
      AND connector_lock.id = NEW.connector_instance_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Active webhook endpoints require an existing connector.';
    END IF;
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

-- A connector cannot be disabled after it becomes the active verifier for an
-- endpoint. The activation trigger locks this source row first, serializing
-- inverse transitions so they cannot commit an invalid active pair.
CREATE OR REPLACE FUNCTION webhook_endpoint_connector_lifecycle_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.lifecycle <> 'disabled' AND NEW.lifecycle = 'disabled' THEN
    PERFORM 1
    FROM webhook_endpoints
    WHERE workspace_id = NEW.workspace_id
      AND connector_instance_id = NEW.id
      AND lifecycle = 'active'
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'A connector with active webhook endpoints cannot be disabled.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER webhook_endpoint_connector_lifecycle_guard_trigger
  BEFORE UPDATE OF lifecycle ON connector_registrations
  FOR EACH ROW EXECUTE FUNCTION webhook_endpoint_connector_lifecycle_guard();
