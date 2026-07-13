CREATE TABLE attachment_blobs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  storage_key text,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  detected_mime_type text NOT NULL CHECK (length(detected_mime_type) > 0),
  retention_state text NOT NULL DEFAULT 'active' CHECK (
    retention_state IN ('active', 'claimed', 'deleted')
  ),
  retention_claim_id text,
  retention_claimed_at timestamptz,
  retention_claim_expires_at timestamptz,
  retention_deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  CHECK (
    (retention_state = 'active'
      AND retention_claim_id IS NULL
      AND retention_claimed_at IS NULL
      AND retention_claim_expires_at IS NULL
      AND retention_deleted_at IS NULL
      AND storage_key IS NOT NULL)
    OR
    (retention_state = 'claimed'
      AND retention_claim_id IS NOT NULL
      AND retention_claimed_at IS NOT NULL
      AND retention_claim_expires_at IS NOT NULL
      AND retention_deleted_at IS NULL
      AND storage_key IS NOT NULL)
    OR
    (retention_state = 'deleted'
      AND retention_claim_id IS NULL
      AND retention_claimed_at IS NULL
      AND retention_claim_expires_at IS NULL
      AND retention_deleted_at IS NOT NULL
      AND storage_key IS NULL)
  )
);

ALTER TABLE attachments
  ADD COLUMN blob_id text,
  ADD COLUMN byte_length bigint,
  ADD COLUMN declared_mime_type text,
  ADD COLUMN detected_mime_type text,
  ADD COLUMN sanitized_filename text,
  ADD COLUMN retention_expires_at timestamptz,
  ADD COLUMN retention_state text NOT NULL DEFAULT 'active',
  ADD COLUMN retention_claim_id text,
  ADD COLUMN retention_claimed_at timestamptz,
  ADD COLUMN retention_claim_expires_at timestamptz,
  ADD COLUMN retention_deleted_at timestamptz,
  ADD CONSTRAINT attachments_blob_fk
    FOREIGN KEY (workspace_id, blob_id)
    REFERENCES attachment_blobs(workspace_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT attachments_blob_unique
    UNIQUE (workspace_id, blob_id),
  ADD CONSTRAINT attachments_retention_state_check CHECK (
    (retention_state = 'active'
      AND retention_claim_id IS NULL
      AND retention_claimed_at IS NULL
      AND retention_claim_expires_at IS NULL
      AND retention_deleted_at IS NULL)
    OR
    (retention_state = 'claimed'
      AND retention_claim_id IS NOT NULL
      AND retention_claimed_at IS NOT NULL
      AND retention_claim_expires_at IS NOT NULL
      AND retention_deleted_at IS NULL)
    OR
    (retention_state = 'deleted'
      AND retention_claim_id IS NULL
      AND retention_claimed_at IS NULL
      AND retention_claim_expires_at IS NULL
      AND retention_deleted_at IS NOT NULL)
  );
CREATE INDEX attachments_retention_claim_idx
  ON attachments (retention_state, retention_expires_at)
  WHERE retention_state = 'active' AND retention_expires_at IS NOT NULL;

CREATE TABLE attachment_derivatives (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  identity_key text NOT NULL CHECK (identity_key ~ '^[a-f0-9]{64}$'),
  access_policy_hash text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  processor text NOT NULL,
  processor_version text NOT NULL,
  security_policy_version text NOT NULL,
  normalization_version text NOT NULL,
  vision_prompt_version text,
  vision_binding_version_id text,
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  claim_id text,
  claim_expires_at timestamptz,
  claim_attempts integer NOT NULL DEFAULT 0 CHECK (claim_attempts > 0),
  output_storage_key text,
  output_mime_type text,
  ai_operation_id text,
  failure_code text,
  failure_retryable boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  failed_at timestamptz,
  retention_expires_at timestamptz,
  retention_state text NOT NULL DEFAULT 'active' CHECK (
    retention_state IN ('active', 'claimed', 'deleted')
  ),
  retention_claim_id text,
  retention_claimed_at timestamptz,
  retention_claim_expires_at timestamptz,
  retention_deleted_at timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, identity_key),
  CHECK (
    (vision_prompt_version IS NULL AND vision_binding_version_id IS NULL)
    OR
    (vision_prompt_version IS NOT NULL AND vision_binding_version_id IS NOT NULL)
  ),
  CHECK (
    (status = 'pending'
      AND claim_id IS NOT NULL
      AND claim_expires_at IS NOT NULL
      AND output_storage_key IS NULL
      AND output_mime_type IS NULL
      AND completed_at IS NULL
      AND failed_at IS NULL)
    OR
    (status = 'completed'
      AND claim_id IS NULL
      AND claim_expires_at IS NULL
      AND completed_at IS NOT NULL
      AND (
        retention_state = 'deleted'
        OR (
          output_storage_key IS NOT NULL
          AND output_mime_type = 'text/plain'
        )
      ))
    OR
    (status = 'failed'
      AND claim_id IS NULL
      AND claim_expires_at IS NULL
      AND failure_code IS NOT NULL
      AND failure_retryable IS NOT NULL
      AND failed_at IS NOT NULL)
  ),
  CHECK (
    (retention_state = 'active'
      AND retention_claim_id IS NULL
      AND retention_claimed_at IS NULL
      AND retention_claim_expires_at IS NULL
      AND retention_deleted_at IS NULL)
    OR
    (retention_state = 'claimed'
      AND retention_claim_id IS NOT NULL
      AND retention_claimed_at IS NOT NULL
      AND retention_claim_expires_at IS NOT NULL
      AND retention_deleted_at IS NULL)
    OR
    (retention_state = 'deleted'
      AND retention_claim_id IS NULL
      AND retention_claimed_at IS NULL
      AND retention_claim_expires_at IS NULL
      AND retention_deleted_at IS NOT NULL
      AND output_storage_key IS NULL)
  )
);
CREATE INDEX attachment_derivatives_claim_expiry_idx
  ON attachment_derivatives (status, claim_expires_at)
  WHERE status = 'pending';
CREATE INDEX attachment_derivatives_retention_claim_idx
  ON attachment_derivatives (retention_state, retention_expires_at)
  WHERE retention_state = 'active' AND retention_expires_at IS NOT NULL;

CREATE TABLE attachment_derivative_sources (
  workspace_id text NOT NULL,
  attachment_derivative_id text NOT NULL,
  attachment_id text NOT NULL,
  source_job_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (
    workspace_id,
    attachment_derivative_id,
    attachment_id,
    source_job_id
  ),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, attachment_derivative_id)
    REFERENCES attachment_derivatives(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, attachment_id)
    REFERENCES attachments(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE attachment_derivative_failures (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  attachment_derivative_id text NOT NULL,
  claim_id text NOT NULL,
  code text NOT NULL,
  retryable boolean NOT NULL,
  failed_at timestamptz NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, attachment_derivative_id, claim_id),
  FOREIGN KEY (workspace_id, attachment_derivative_id)
    REFERENCES attachment_derivatives(workspace_id, id) ON DELETE RESTRICT
);
