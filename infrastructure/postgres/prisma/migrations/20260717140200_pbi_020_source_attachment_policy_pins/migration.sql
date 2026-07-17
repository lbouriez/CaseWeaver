-- Source-owned attachment stage pins. Existing source runtime versions stay
-- executable with their legacy no-attachment behavior; no mutable policy is
-- invented for them.
ALTER TABLE knowledge_source_runtime_versions
  ADD COLUMN attachment_stage_mode text,
  ADD COLUMN attachment_policy_configuration_version_id text,
  ADD COLUMN attachment_access_policy_hash char(64);

ALTER TABLE knowledge_source_runtime_versions
  ADD CONSTRAINT knowledge_source_runtime_versions_attachment_stage_check
  CHECK (
    (attachment_stage_mode IS NULL
      AND attachment_policy_configuration_version_id IS NULL
      AND attachment_access_policy_hash IS NULL)
    OR
    (attachment_stage_mode = 'disabled'
      AND attachment_policy_configuration_version_id IS NULL
      AND attachment_access_policy_hash IS NULL)
    OR
    (attachment_stage_mode IN ('optional', 'required')
      AND attachment_policy_configuration_version_id IS NOT NULL
      AND attachment_access_policy_hash ~ '^[a-f0-9]{64}$')
  ) NOT VALID;

ALTER TABLE knowledge_source_runtime_versions
  VALIDATE CONSTRAINT knowledge_source_runtime_versions_attachment_stage_check;

ALTER TABLE knowledge_source_runtime_versions
  ADD CONSTRAINT knowledge_source_runtime_versions_attachment_policy_fk
  FOREIGN KEY (workspace_id, attachment_policy_configuration_version_id)
  REFERENCES attachment_policy_versions(workspace_id, configuration_version_id)
  ON DELETE RESTRICT;

CREATE INDEX knowledge_source_runtime_versions_attachment_policy_idx
  ON knowledge_source_runtime_versions (
    workspace_id,
    attachment_policy_configuration_version_id
  )
  WHERE attachment_policy_configuration_version_id IS NOT NULL;
