-- Provider inventory is distinct from the deployment-owned LiteLLM pricing
-- catalog. This table securely associates a workspace/provider immutable
-- version with a synthetic, safe catalog projection used by existing binding
-- and cost machinery. It deliberately contains no endpoint, locator,
-- credential, raw provider response, or account metadata.
CREATE TABLE ai_provider_model_inventory_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider_instance_id TEXT NOT NULL,
  provider_instance_version_id TEXT NOT NULL,
  catalog_snapshot_id TEXT NOT NULL UNIQUE,
  content_sha256 CHAR(64) NOT NULL,
  discovered_at TIMESTAMPTZ(6) NOT NULL,
  model_count INTEGER NOT NULL,
  priced_model_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT ai_provider_model_inventory_snapshots_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  CONSTRAINT ai_provider_model_inventory_snapshots_provider_instance_fkey
    FOREIGN KEY (workspace_id, provider_instance_id)
    REFERENCES ai_provider_instances(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT ai_provider_model_inventory_snapshots_provider_version_fkey
    FOREIGN KEY (workspace_id, provider_instance_version_id)
    REFERENCES ai_provider_instance_versions(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT ai_provider_model_inventory_snapshots_catalog_snapshot_id_fkey
    FOREIGN KEY (catalog_snapshot_id)
    REFERENCES ai_catalog_snapshots(id) ON DELETE RESTRICT,
  CONSTRAINT ai_provider_model_inventory_snapshots_content_sha256_check
    CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT ai_provider_model_inventory_snapshots_model_count_check
    CHECK (model_count >= 0),
  CONSTRAINT ai_provider_model_inventory_snapshots_priced_model_count_check
    CHECK (priced_model_count >= 0 AND priced_model_count <= model_count),
  CONSTRAINT ai_provider_model_inventory_snapshots_identifier_check
    CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$')
);

CREATE UNIQUE INDEX ai_provider_model_inventory_snapshots_provider_version_digest_key
  ON ai_provider_model_inventory_snapshots (
    workspace_id, provider_instance_version_id, content_sha256
  );
CREATE INDEX ai_provider_model_inventory_snapshots_workspace_provider_discovered_idx
  ON ai_provider_model_inventory_snapshots (
    workspace_id, provider_instance_id, discovered_at DESC
  );
