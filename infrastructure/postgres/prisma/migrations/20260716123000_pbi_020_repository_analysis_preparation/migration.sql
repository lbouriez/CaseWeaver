-- PBI-020 repository-assisted analysis. New records are immutable, workspace-scoped,
-- and keep connector reopen data and analysis output outside generic read models.
-- Historical PBI-011/PBI-012 rows remain readable and are never rebound.

ALTER TABLE publication_attempts
  ADD CONSTRAINT publication_attempts_workspace_id_unique UNIQUE (workspace_id, id);

CREATE TABLE code_repository_versions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  configuration_version_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('remoteHttps', 'deploymentMounted')),
  allowed_ref_kinds jsonb NOT NULL DEFAULT '[]'::jsonb,
  checkout_credential_required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, configuration_version_id),
  FOREIGN KEY (workspace_id, configuration_version_id)
    REFERENCES administration_configuration_versions(workspace_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(allowed_ref_kinds) = 'array')
);

CREATE TABLE repository_execution_policy_versions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  configuration_version_id text NOT NULL,
  repository_agent_binding_version_id text NOT NULL,
  sandbox_policy_version_id text NOT NULL,
  read_only_tool_allowlist jsonb NOT NULL,
  network_disabled boolean NOT NULL CHECK (network_disabled),
  maximum_duration_milliseconds integer NOT NULL CHECK (maximum_duration_milliseconds BETWEEN 1 AND 3600000),
  maximum_turns integer NOT NULL CHECK (maximum_turns BETWEEN 1 AND 1000),
  maximum_tool_calls integer NOT NULL CHECK (maximum_tool_calls BETWEEN 1 AND 10000),
  maximum_output_tokens integer NOT NULL CHECK (maximum_output_tokens BETWEEN 1 AND 128000),
  maximum_cpu_milliseconds integer NOT NULL CHECK (maximum_cpu_milliseconds BETWEEN 1 AND 3600000),
  maximum_memory_bytes bigint NOT NULL CHECK (maximum_memory_bytes BETWEEN 1 AND 1099511627776),
  maximum_output_bytes bigint NOT NULL CHECK (maximum_output_bytes BETWEEN 1 AND 1073741824),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, configuration_version_id),
  FOREIGN KEY (workspace_id, configuration_version_id)
    REFERENCES administration_configuration_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, repository_agent_binding_version_id)
    REFERENCES ai_model_binding_versions(workspace_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(read_only_tool_allowlist) = 'array'),
  CHECK (jsonb_array_length(read_only_tool_allowlist) > 0)
);

CREATE TABLE attachment_policy_versions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  configuration_version_id text NOT NULL,
  processor_security_policy_version_id text NOT NULL,
  vision_binding_version_id text NOT NULL,
  maximum_attachment_count integer NOT NULL CHECK (maximum_attachment_count BETWEEN 1 AND 10000),
  maximum_attachment_bytes bigint NOT NULL CHECK (maximum_attachment_bytes BETWEEN 1 AND 2147483648),
  maximum_archive_entries integer NOT NULL CHECK (maximum_archive_entries BETWEEN 1 AND 100000),
  maximum_expanded_archive_bytes bigint NOT NULL CHECK (maximum_expanded_archive_bytes BETWEEN 1 AND 8589934592),
  maximum_archive_depth integer NOT NULL CHECK (maximum_archive_depth BETWEEN 0 AND 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, configuration_version_id),
  FOREIGN KEY (workspace_id, configuration_version_id)
    REFERENCES administration_configuration_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, vision_binding_version_id)
    REFERENCES ai_model_binding_versions(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE analysis_recipe_versions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  configuration_version_id text NOT NULL,
  analysis_profile_version_id text NOT NULL,
  analysis_binding_version_id text NOT NULL,
  retrieval_profile_version_id text,
  prompt_profile_version_id text,
  publication_profile_version_id text,
  attachment_policy_version_id text,
  attachment_stage_mode text NOT NULL CHECK (attachment_stage_mode IN ('disabled', 'optional', 'required')),
  code_repository_version_id text,
  repository_execution_policy_version_id text,
  repository_stage_mode text NOT NULL CHECK (repository_stage_mode IN ('disabled', 'optional', 'required')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, configuration_version_id),
  FOREIGN KEY (workspace_id, configuration_version_id)
    REFERENCES administration_configuration_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, analysis_binding_version_id)
    REFERENCES ai_model_binding_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, analysis_profile_version_id)
    REFERENCES analysis_profile_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, publication_profile_version_id)
    REFERENCES publication_profile_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, attachment_policy_version_id)
    REFERENCES attachment_policy_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, code_repository_version_id)
    REFERENCES code_repository_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, repository_execution_policy_version_id)
    REFERENCES repository_execution_policy_versions(workspace_id, id) ON DELETE RESTRICT,
  CHECK (
    (repository_stage_mode = 'disabled' AND code_repository_version_id IS NULL AND repository_execution_policy_version_id IS NULL)
    OR
    (repository_stage_mode IN ('optional', 'required') AND code_repository_version_id IS NOT NULL AND repository_execution_policy_version_id IS NOT NULL)
  ),
  CHECK (
    (attachment_stage_mode = 'disabled' AND attachment_policy_version_id IS NULL)
    OR
    (attachment_stage_mode IN ('optional', 'required') AND attachment_policy_version_id IS NOT NULL)
  )
);

CREATE TABLE case_analysis_trigger_recipe_versions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  analysis_trigger_version_id text NOT NULL,
  analysis_recipe_version_id text NOT NULL,
  automated_principal_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, analysis_trigger_version_id),
  FOREIGN KEY (workspace_id, analysis_trigger_version_id)
    REFERENCES analysis_trigger_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, analysis_recipe_version_id)
    REFERENCES analysis_recipe_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, automated_principal_id)
    REFERENCES principals(workspace_id, id) ON DELETE RESTRICT
);

-- A PBI-020 intake schedule polls a case source and maps every discovered case
-- through an immutable trigger/recipe. It is intentionally not the historical
-- PBI-012 target-specific case_analysis_schedules table.
CREATE TABLE case_analysis_intake_schedules (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  schedule_id text NOT NULL,
  configuration_version_id text NOT NULL,
  analysis_trigger_configuration_version_id text NOT NULL,
  automated_principal_id text,
  cadence jsonb NOT NULL,
  next_run_at timestamptz NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, configuration_version_id),
  UNIQUE (workspace_id, schedule_id, configuration_version_id),
  FOREIGN KEY (workspace_id, configuration_version_id)
    REFERENCES administration_configuration_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, analysis_trigger_configuration_version_id)
    REFERENCES administration_configuration_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, automated_principal_id)
    REFERENCES principals(workspace_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(cadence) = 'object'),
  CHECK (NOT enabled OR automated_principal_id IS NOT NULL)
);
CREATE INDEX case_analysis_intake_schedules_due_idx
  ON case_analysis_intake_schedules (enabled, next_run_at)
  WHERE enabled;

-- Safe occurrence metadata is immutable. The opaque reopen identity is held in the
-- separate encrypted/private table and is intentionally absent from every generic read.
CREATE TABLE attachment_occurrences (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  owner_kind text NOT NULL CHECK (owner_kind IN ('knowledgeRevision', 'caseSnapshot', 'caseMessage')),
  owner_id text NOT NULL,
  connector_registration_id text NOT NULL,
  connector_configuration_version_id text,
  relation text NOT NULL CHECK (relation IN ('declaredAttachment', 'inlineImage', 'inlineFile')),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  attachment_reference_id text NOT NULL,
  declared_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  identity_hash text NOT NULL CHECK (identity_hash ~ '^[a-f0-9]{64}$'),
  required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, owner_kind, owner_id, ordinal),
  FOREIGN KEY (workspace_id, connector_registration_id)
    REFERENCES connector_registrations(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, attachment_reference_id)
    REFERENCES external_references(workspace_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(declared_metadata) = 'object')
);

CREATE TABLE attachment_occurrence_private (
  workspace_id text NOT NULL,
  attachment_occurrence_id text NOT NULL,
  locator_ciphertext text NOT NULL,
  cipher_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, attachment_occurrence_id),
  FOREIGN KEY (workspace_id, attachment_occurrence_id)
    REFERENCES attachment_occurrences(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE attachment_preparation_runs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  owner_kind text NOT NULL CHECK (owner_kind IN ('knowledgeRevision', 'caseSnapshot', 'caseMessage')),
  owner_id text NOT NULL,
  attachment_policy_version_id text,
  policy_identity_hash text NOT NULL CHECK (policy_identity_hash ~ '^[a-f0-9]{64}$'),
  preparation_identity_hash text NOT NULL CHECK (preparation_identity_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('pending', 'claimed', 'completed', 'failed')),
  lease_token text,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0,
  retry_required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, owner_kind, owner_id, preparation_identity_hash),
  FOREIGN KEY (workspace_id, attachment_policy_version_id)
    REFERENCES attachment_policy_versions(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE attachment_preparation_evidence (
  workspace_id text NOT NULL,
  attachment_preparation_run_id text NOT NULL,
  attachment_occurrence_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('ready', 'skipped', 'failed')),
  required boolean NOT NULL,
  attachment_id text,
  attachment_derivative_id text,
  processor_version text,
  output_content_hash text,
  warning_code text,
  retryable boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, attachment_preparation_run_id, attachment_occurrence_id),
  FOREIGN KEY (workspace_id, attachment_preparation_run_id)
    REFERENCES attachment_preparation_runs(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, attachment_occurrence_id)
    REFERENCES attachment_occurrences(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, attachment_id)
    REFERENCES attachments(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, attachment_derivative_id)
    REFERENCES attachment_derivatives(workspace_id, id) ON DELETE RESTRICT,
  CHECK (
    (outcome = 'ready' AND attachment_id IS NOT NULL AND attachment_derivative_id IS NOT NULL
      AND processor_version IS NOT NULL AND output_content_hash ~ '^[a-f0-9]{64}$' AND warning_code IS NULL)
    OR
    (outcome IN ('skipped', 'failed') AND attachment_id IS NULL AND attachment_derivative_id IS NULL
      AND processor_version IS NULL AND output_content_hash IS NULL AND warning_code IS NOT NULL)
  )
);

CREATE TABLE analysis_execution_inputs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  analysis_trigger_request_id text NOT NULL,
  case_snapshot_id text NOT NULL,
  analysis_recipe_version_id text NOT NULL,
  attachment_preparation_run_id text,
  attachment_evidence_hash text NOT NULL CHECK (attachment_evidence_hash ~ '^[a-f0-9]{64}$'),
  code_repository_version_id text,
  repository_execution_policy_version_id text,
  repository_agent_binding_version_id text,
  resolved_commit_sha text,
  repository_resolved_at timestamptz,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('pending', 'claimed', 'finalized', 'failed')),
  lease_token text,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0,
  analysis_job_id text,
  error_code text,
  error_retryable boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, analysis_trigger_request_id),
  UNIQUE (workspace_id, analysis_job_id),
  FOREIGN KEY (workspace_id, analysis_trigger_request_id)
    REFERENCES analysis_trigger_requests(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, case_snapshot_id)
    REFERENCES case_snapshots(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, analysis_recipe_version_id)
    REFERENCES analysis_recipe_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, attachment_preparation_run_id)
    REFERENCES attachment_preparation_runs(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, code_repository_version_id)
    REFERENCES code_repository_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, repository_execution_policy_version_id)
    REFERENCES repository_execution_policy_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, repository_agent_binding_version_id)
    REFERENCES ai_model_binding_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, analysis_job_id)
    REFERENCES analysis_jobs(workspace_id, id) ON DELETE RESTRICT,
  CHECK (
    (code_repository_version_id IS NULL AND repository_execution_policy_version_id IS NULL
      AND repository_agent_binding_version_id IS NULL AND resolved_commit_sha IS NULL AND repository_resolved_at IS NULL)
    OR
    (code_repository_version_id IS NOT NULL AND repository_execution_policy_version_id IS NOT NULL
      AND repository_agent_binding_version_id IS NOT NULL AND resolved_commit_sha ~ '^[a-f0-9]{40,64}$'
      AND repository_resolved_at IS NOT NULL)
  )
);

CREATE TABLE analysis_result_protected_content (
  workspace_id text NOT NULL,
  analysis_result_id text NOT NULL,
  content_ciphertext text NOT NULL,
  cipher_version text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  retention_state text NOT NULL DEFAULT 'active' CHECK (retention_state IN ('active', 'tombstoned', 'deleted')),
  tombstoned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, analysis_result_id),
  FOREIGN KEY (workspace_id, analysis_result_id)
    REFERENCES analysis_results(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE publication_receipts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  publication_attempt_id text NOT NULL,
  destination_connector_instance_id text NOT NULL,
  target_resource_type text NOT NULL,
  target_external_id text NOT NULL,
  external_publication_id text NOT NULL,
  marker_digest text NOT NULL CHECK (marker_digest ~ '^[a-f0-9]{64}$'),
  published_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, publication_attempt_id),
  UNIQUE (workspace_id, destination_connector_instance_id, target_resource_type, target_external_id, external_publication_id),
  FOREIGN KEY (workspace_id, publication_attempt_id)
    REFERENCES publication_attempts(workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX attachment_preparation_runs_claim_idx
  ON attachment_preparation_runs (state, lease_expires_at, created_at)
  WHERE state IN ('pending', 'claimed');
CREATE INDEX analysis_execution_inputs_claim_idx
  ON analysis_execution_inputs (state, lease_expires_at, created_at)
  WHERE state IN ('pending', 'claimed');
CREATE INDEX attachment_occurrences_owner_idx
  ON attachment_occurrences (workspace_id, owner_kind, owner_id, ordinal);

CREATE OR REPLACE FUNCTION pbi_020_reject_immutable_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PBI-020 immutable record cannot be updated or deleted';
END;
$$;

CREATE TRIGGER code_repository_versions_immutable_trigger
  BEFORE UPDATE OR DELETE ON code_repository_versions
  FOR EACH ROW EXECUTE FUNCTION pbi_020_reject_immutable_mutation();
CREATE TRIGGER repository_execution_policy_versions_immutable_trigger
  BEFORE UPDATE OR DELETE ON repository_execution_policy_versions
  FOR EACH ROW EXECUTE FUNCTION pbi_020_reject_immutable_mutation();
CREATE TRIGGER attachment_policy_versions_immutable_trigger
  BEFORE UPDATE OR DELETE ON attachment_policy_versions
  FOR EACH ROW EXECUTE FUNCTION pbi_020_reject_immutable_mutation();
CREATE TRIGGER analysis_recipe_versions_immutable_trigger
  BEFORE UPDATE OR DELETE ON analysis_recipe_versions
  FOR EACH ROW EXECUTE FUNCTION pbi_020_reject_immutable_mutation();
CREATE TRIGGER attachment_occurrences_immutable_trigger
  BEFORE UPDATE OR DELETE ON attachment_occurrences
  FOR EACH ROW EXECUTE FUNCTION pbi_020_reject_immutable_mutation();
CREATE TRIGGER attachment_occurrence_private_immutable_trigger
  BEFORE UPDATE OR DELETE ON attachment_occurrence_private
  FOR EACH ROW EXECUTE FUNCTION pbi_020_reject_immutable_mutation();
CREATE TRIGGER attachment_preparation_evidence_immutable_trigger
  BEFORE UPDATE OR DELETE ON attachment_preparation_evidence
  FOR EACH ROW EXECUTE FUNCTION pbi_020_reject_immutable_mutation();
CREATE TRIGGER publication_receipts_immutable_trigger
  BEFORE UPDATE OR DELETE ON publication_receipts
  FOR EACH ROW EXECUTE FUNCTION pbi_020_reject_immutable_mutation();
