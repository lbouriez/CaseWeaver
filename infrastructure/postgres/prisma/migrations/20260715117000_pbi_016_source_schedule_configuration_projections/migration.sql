-- Source and schedule read models now retain immutable administration-version
-- references. Constraints are NOT VALID so existing pre-administration source
-- records remain readable during an incremental upgrade; all new projections are
-- validated by PostgreSQL at write time.

ALTER TABLE knowledge_sources
  ADD CONSTRAINT knowledge_sources_administration_configuration_version_fk
  FOREIGN KEY (workspace_id, configuration_version)
  REFERENCES administration_configuration_versions(workspace_id, id)
  ON DELETE RESTRICT
  NOT VALID;

ALTER TABLE knowledge_schedules
  ADD COLUMN administration_configuration_version_id text;

ALTER TABLE knowledge_schedules
  ADD CONSTRAINT knowledge_schedules_source_configuration_version_fk
  FOREIGN KEY (workspace_id, configuration_version)
  REFERENCES administration_configuration_versions(workspace_id, id)
  ON DELETE RESTRICT
  NOT VALID,
  ADD CONSTRAINT knowledge_schedules_administration_configuration_version_fk
  FOREIGN KEY (workspace_id, administration_configuration_version_id)
  REFERENCES administration_configuration_versions(workspace_id, id)
  ON DELETE RESTRICT
  NOT VALID;

CREATE INDEX knowledge_schedules_administration_configuration_version_idx
  ON knowledge_schedules (
    workspace_id,
    administration_configuration_version_id
  )
  WHERE administration_configuration_version_id IS NOT NULL;
