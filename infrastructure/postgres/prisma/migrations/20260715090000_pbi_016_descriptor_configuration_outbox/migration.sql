-- Safe descriptor snapshots are globally registered by trusted backend composition.
-- Configuration versions retain their descriptor identity and emit a durable
-- cache-invalidation signal in the same transaction as the new immutable version.

CREATE TABLE administration_descriptor_revisions (
  kind text NOT NULL CHECK (kind IN ('connector', 'aiProvider')),
  type text NOT NULL,
  version text NOT NULL,
  descriptor jsonb NOT NULL,
  descriptor_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, type, version),
  CHECK (jsonb_typeof(descriptor) = 'object')
);

ALTER TABLE administration_configuration_versions
  ADD COLUMN display_name text,
  ADD COLUMN descriptor_kind text,
  ADD COLUMN descriptor_type text,
  ADD COLUMN descriptor_version text,
  ADD CONSTRAINT administration_configuration_versions_descriptor_triplet_check
    CHECK (
      (descriptor_kind IS NULL AND descriptor_type IS NULL AND descriptor_version IS NULL)
      OR (descriptor_kind IS NOT NULL AND descriptor_type IS NOT NULL AND descriptor_version IS NOT NULL)
    ),
  ADD CONSTRAINT administration_configuration_versions_descriptor_kind_check
    CHECK (descriptor_kind IS NULL OR descriptor_kind IN ('connector', 'aiProvider')),
  ADD CONSTRAINT administration_configuration_versions_descriptor_fk
    FOREIGN KEY (descriptor_kind, descriptor_type, descriptor_version)
    REFERENCES administration_descriptor_revisions(kind, type, version)
    ON DELETE RESTRICT;
CREATE INDEX administration_configuration_versions_descriptor_idx
  ON administration_configuration_versions (descriptor_kind, descriptor_type, descriptor_version);

CREATE TABLE administration_configuration_change_outbox (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  resource_type text NOT NULL,
  configuration_id text NOT NULL,
  previous_version_id text,
  current_version_id text NOT NULL,
  cache_scopes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (workspace_id, configuration_id, current_version_id),
  FOREIGN KEY (workspace_id, configuration_id)
    REFERENCES administration_configurations(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, current_version_id)
    REFERENCES administration_configuration_versions(workspace_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(cache_scopes) = 'array')
);
CREATE INDEX administration_configuration_change_outbox_pending_idx
  ON administration_configuration_change_outbox (published_at, created_at);

CREATE OR REPLACE FUNCTION administration_descriptor_revisions_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Administration descriptor revisions are immutable';
END;
$$;
CREATE TRIGGER administration_descriptor_revisions_immutable_trigger
  BEFORE UPDATE OR DELETE ON administration_descriptor_revisions
  FOR EACH ROW EXECUTE FUNCTION administration_descriptor_revisions_immutable();
