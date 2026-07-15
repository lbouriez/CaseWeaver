-- Safe immutable-version metadata for audited configuration inspection.  The
-- generated values avoid selecting settings or secret-reference identifiers for
-- the administrative read surface.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE administration_configuration_versions
  ADD COLUMN canonical_settings_sha256 text
    GENERATED ALWAYS AS (
      encode(digest(settings::text, 'sha256'), 'hex')
    ) STORED,
  ADD COLUMN secret_reference_count integer
    GENERATED ALWAYS AS (jsonb_array_length(secret_references)) STORED,
  ADD CONSTRAINT administration_configuration_versions_settings_sha256_check
    CHECK (canonical_settings_sha256 ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT administration_configuration_versions_secret_reference_count_check
    CHECK (secret_reference_count >= 0 AND secret_reference_count <= 100);

CREATE INDEX administration_configuration_versions_history_idx
  ON administration_configuration_versions (workspace_id, configuration_id, version DESC, id DESC);
