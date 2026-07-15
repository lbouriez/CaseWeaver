CREATE TABLE administration_diagnostic_exports (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  requested_by_principal_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('requested', 'generating', 'ready', 'failed', 'expired', 'deleted')),
  event_cutoff_at timestamptz NOT NULL,
  maximum_events integer NOT NULL CHECK (maximum_events BETWEEN 1 AND 1000),
  expires_at timestamptz NOT NULL,
  artifact_storage_key text,
  content_sha256 text,
  byte_length integer,
  content_type text,
  event_count integer,
  generated_at timestamptz,
  failure_code text CHECK (failure_code IS NULL OR failure_code IN ('source.unavailable', 'content.tooLarge', 'storage.unavailable')),
  generation_claim_token text,
  generation_claimed_until timestamptz,
  generation_attempts integer NOT NULL DEFAULT 0 CHECK (generation_attempts >= 0),
  deletion_claim_token text,
  deletion_claimed_until timestamptz,
  deletion_attempts integer NOT NULL DEFAULT 0 CHECK (deletion_attempts >= 0),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, requested_by_principal_id)
    REFERENCES principals(workspace_id, id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK (
    (status = 'ready' AND artifact_storage_key IS NOT NULL AND content_sha256 ~ '^[a-f0-9]{64}$'
      AND byte_length BETWEEN 0 AND 1048576 AND content_type = 'application/json'
      AND event_count BETWEEN 0 AND 1000 AND generated_at IS NOT NULL AND failure_code IS NULL)
    OR (status <> 'ready')
  ),
  CHECK (
    (status = 'failed' AND failure_code IS NOT NULL)
    OR (status IN ('requested', 'generating', 'ready', 'deleted') AND failure_code IS NULL)
    OR status = 'expired'
  ),
  CHECK (
    (status IN ('requested', 'generating', 'ready', 'failed') AND deleted_at IS NULL)
    OR (status = 'deleted' AND deleted_at IS NOT NULL)
    OR status = 'expired'
  )
);

CREATE INDEX administration_diagnostic_exports_expiry_idx
  ON administration_diagnostic_exports (status, expires_at, created_at);
CREATE INDEX administration_diagnostic_exports_generation_claim_idx
  ON administration_diagnostic_exports (status, generation_claimed_until, created_at);
CREATE INDEX administration_diagnostic_exports_deletion_claim_idx
  ON administration_diagnostic_exports (status, deletion_claimed_until, expires_at);
