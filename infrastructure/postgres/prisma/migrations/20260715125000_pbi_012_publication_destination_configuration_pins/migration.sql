-- PBI-012: a publication destination is selected by an immutable connector
-- configuration version, never by the connector aggregate's mutable current
-- version. Existing profile, intent, and attempt history remains readable with
-- null pins and must fail closed in the application adapter.

ALTER TABLE publication_profile_versions
  ADD COLUMN destination_connector_configuration_version_id text,
  ADD CONSTRAINT publication_profile_destination_pin_fk
    FOREIGN KEY (workspace_id, destination_connector_configuration_version_id)
    REFERENCES administration_configuration_versions(workspace_id, id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT publication_profile_destination_pin_required
    CHECK (destination_connector_configuration_version_id IS NOT NULL)
    NOT VALID;
CREATE INDEX publication_profile_versions_destination_configuration_version_idx
  ON publication_profile_versions (
    workspace_id, destination_connector_configuration_version_id
  )
  WHERE destination_connector_configuration_version_id IS NOT NULL;

ALTER TABLE publication_intents
  ADD COLUMN destination_connector_configuration_version_id text,
  ADD CONSTRAINT publication_intent_destination_pin_fk
    FOREIGN KEY (workspace_id, destination_connector_configuration_version_id)
    REFERENCES administration_configuration_versions(workspace_id, id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT publication_intent_destination_pin_shape_check
    CHECK (
      (destination_connector_instance_id IS NULL
        AND destination_connector_configuration_version_id IS NULL)
      OR
      (destination_connector_instance_id IS NOT NULL
        AND destination_connector_configuration_version_id IS NOT NULL)
    ) NOT VALID;
CREATE INDEX publication_intents_destination_configuration_version_idx
  ON publication_intents (
    workspace_id, destination_connector_configuration_version_id
  )
  WHERE destination_connector_configuration_version_id IS NOT NULL;

ALTER TABLE publication_attempts
  ADD COLUMN destination_connector_configuration_version_id text,
  ADD CONSTRAINT publication_attempt_destination_pin_fk
    FOREIGN KEY (workspace_id, destination_connector_configuration_version_id)
    REFERENCES administration_configuration_versions(workspace_id, id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT publication_attempt_destination_pin_required
    CHECK (
      state <> 'publishing'
      OR destination_connector_configuration_version_id IS NOT NULL
    ) NOT VALID;
CREATE INDEX publication_attempts_destination_configuration_version_idx
  ON publication_attempts (
    workspace_id, destination_connector_configuration_version_id
  )
  WHERE destination_connector_configuration_version_id IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_publication_profile_destination_configuration()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  destination_id text;
BEGIN
  destination_id := NEW.definition #>> '{destination,connectorInstanceId}';
  IF destination_id IS NULL OR destination_id = ''
     OR NEW.destination_connector_configuration_version_id IS NULL THEN
    RAISE EXCEPTION 'Publication profile destination configuration is required';
  END IF;

  -- Serialize profile activation against destination connector disablement.
  PERFORM 1
  FROM connector_registrations AS destination_lock
  WHERE destination_lock.workspace_id = NEW.workspace_id
    AND destination_lock.id = destination_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Publication profile destination must be an active analysis destination';
  END IF;

  PERFORM 1
  FROM connector_registrations AS destination
  JOIN connector_capabilities AS capability
    ON capability.workspace_id = destination.workspace_id
    AND capability.connector_registration_id = destination.id
    AND capability.capability = 'analysisDestination'
  JOIN administration_configurations AS configuration
    ON configuration.workspace_id = destination.workspace_id
    AND configuration.id = destination.id
    AND configuration.resource_type = 'connector-instances'
    AND configuration.lifecycle = 'active'
    AND configuration.current_version_id = NEW.destination_connector_configuration_version_id
  JOIN administration_configuration_versions AS version
    ON version.workspace_id = configuration.workspace_id
    AND version.id = NEW.destination_connector_configuration_version_id
    AND version.configuration_id = configuration.id
    AND version.descriptor_kind = 'connector'
  JOIN administration_descriptor_revisions AS descriptor
    ON descriptor.kind = version.descriptor_kind
    AND descriptor.type = version.descriptor_type
    AND descriptor.version = version.descriptor_version
    AND descriptor.descriptor -> 'connectorCapabilities' ? 'analysisDestination'
  WHERE destination.workspace_id = NEW.workspace_id
    AND destination.id = destination_id
    AND destination.lifecycle = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Publication profile destination must be an active pinned analysis destination';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER publication_profile_versions_destination_configuration_valid
  BEFORE INSERT ON publication_profile_versions
  FOR EACH ROW
  EXECUTE FUNCTION validate_publication_profile_destination_configuration();

CREATE OR REPLACE FUNCTION prevent_publication_profile_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.publication_profile_id IS DISTINCT FROM NEW.publication_profile_id
     OR OLD.version IS DISTINCT FROM NEW.version
     OR OLD.definition_hash IS DISTINCT FROM NEW.definition_hash
     OR OLD.definition IS DISTINCT FROM NEW.definition
     OR OLD.destination_connector_configuration_version_id
        IS DISTINCT FROM NEW.destination_connector_configuration_version_id THEN
    RAISE EXCEPTION 'Publication profile versions are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION prevent_publication_intent_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.publication_profile_version_id IS DISTINCT FROM NEW.publication_profile_version_id
     OR OLD.target_connector_instance_id IS DISTINCT FROM NEW.target_connector_instance_id
     OR OLD.target_resource_type IS DISTINCT FROM NEW.target_resource_type
     OR OLD.target_external_id IS DISTINCT FROM NEW.target_external_id
     OR OLD.destination_connector_instance_id IS DISTINCT FROM NEW.destination_connector_instance_id
     OR OLD.destination_connector_configuration_version_id
        IS DISTINCT FROM NEW.destination_connector_configuration_version_id THEN
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

CREATE OR REPLACE FUNCTION publication_attempt_destination_configuration_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  intent_pin text;
BEGIN
  SELECT destination_connector_configuration_version_id
  INTO intent_pin
  FROM publication_intents
  WHERE workspace_id = NEW.workspace_id
    AND id = NEW.publication_intent_id;
  IF NOT FOUND
     OR intent_pin IS NULL
     OR NEW.destination_connector_configuration_version_id IS NULL
     OR NEW.destination_connector_configuration_version_id <> intent_pin THEN
    RAISE EXCEPTION 'Publication attempt destination configuration is invalid';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.destination_connector_configuration_version_id
       IS DISTINCT FROM NEW.destination_connector_configuration_version_id THEN
    RAISE EXCEPTION 'Publication attempt destination configuration is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER publication_attempts_destination_configuration_guard_trigger
  BEFORE INSERT OR UPDATE ON publication_attempts
  FOR EACH ROW
  EXECUTE FUNCTION publication_attempt_destination_configuration_guard();

-- Connector lifecycle mutations must not leave a routable profile pointing at
-- a disabled destination. Existing historical profile versions are retained.
CREATE OR REPLACE FUNCTION publication_destination_connector_lifecycle_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.lifecycle <> 'disabled' AND NEW.lifecycle = 'disabled' THEN
    PERFORM 1
    FROM publication_profiles AS profile
    JOIN publication_profile_versions AS version
      ON version.workspace_id = profile.workspace_id
      AND version.publication_profile_id = profile.id
    WHERE profile.workspace_id = NEW.workspace_id
      AND profile.lifecycle = 'active'
      AND version.definition #>> '{destination,connectorInstanceId}' = NEW.id
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'A connector with active publication profiles cannot be disabled';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER publication_destination_connector_lifecycle_guard_trigger
  BEFORE UPDATE OF lifecycle ON connector_registrations
  FOR EACH ROW
  EXECUTE FUNCTION publication_destination_connector_lifecycle_guard();

-- The connector registration and its descriptor-backed configuration aggregate
-- are a single routability boundary. Serializing on the registration closes
-- the activation/disable race while preserving immutable historical versions.
CREATE OR REPLACE FUNCTION publication_destination_configuration_lifecycle_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.resource_type = 'connector-instances'
     AND OLD.lifecycle = 'active'
     AND NEW.lifecycle <> 'active' THEN
    PERFORM 1
    FROM connector_registrations AS destination_lock
    WHERE destination_lock.workspace_id = NEW.workspace_id
      AND destination_lock.id = NEW.id
    FOR UPDATE;

    PERFORM 1
    FROM publication_profiles AS profile
    JOIN publication_profile_versions AS version
      ON version.workspace_id = profile.workspace_id
      AND version.publication_profile_id = profile.id
    JOIN administration_configuration_versions AS destination_version
      ON destination_version.workspace_id = version.workspace_id
      AND destination_version.id = version.destination_connector_configuration_version_id
    WHERE profile.workspace_id = NEW.workspace_id
      AND profile.lifecycle = 'active'
      AND destination_version.configuration_id = NEW.id
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'A connector configuration with active publication profiles cannot be disabled';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER publication_destination_configuration_lifecycle_guard_trigger
  BEFORE UPDATE OF lifecycle ON administration_configurations
  FOR EACH ROW
  EXECUTE FUNCTION publication_destination_configuration_lifecycle_guard();
