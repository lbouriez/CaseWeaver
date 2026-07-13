CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE installation_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  workspace_id text UNIQUE,
  principal_id text,
  initialized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE principals (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

ALTER TABLE installation_state
  ADD CONSTRAINT installation_state_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  ADD CONSTRAINT installation_state_principal_fk
    FOREIGN KEY (workspace_id, principal_id)
    REFERENCES principals(workspace_id, id) ON DELETE RESTRICT;

CREATE TABLE workspace_role_assignments (
  workspace_id text NOT NULL,
  principal_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('administrator', 'operator', 'analyst', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, principal_id, role),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, principal_id) REFERENCES principals(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE credential_registrations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  secret_reference text NOT NULL,
  lifecycle text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, secret_reference)
);

CREATE TABLE connector_registrations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  lifecycle text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE connector_capabilities (
  workspace_id text NOT NULL,
  connector_registration_id text NOT NULL,
  capability text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, connector_registration_id, capability),
  FOREIGN KEY (workspace_id, connector_registration_id)
    REFERENCES connector_registrations(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE external_references (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  connector_registration_id text NOT NULL,
  kind text NOT NULL,
  external_id text NOT NULL,
  observed_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, connector_registration_id, kind, external_id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, connector_registration_id)
    REFERENCES connector_registrations(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE case_snapshots (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  external_reference_id text NOT NULL,
  lifecycle text NOT NULL,
  snapshot_hash text NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, external_reference_id, snapshot_hash),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, external_reference_id)
    REFERENCES external_references(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE knowledge_items (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  external_reference_id text NOT NULL,
  lifecycle text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  content_hash text NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, external_reference_id, version),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, external_reference_id)
    REFERENCES external_references(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE attachments (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  external_reference_id text NOT NULL,
  lifecycle text NOT NULL,
  content_hash text,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, external_reference_id)
    REFERENCES external_references(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE analysis_profiles (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  lifecycle text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE analysis_profile_versions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  analysis_profile_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  definition_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, analysis_profile_id, version),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, analysis_profile_id)
    REFERENCES analysis_profiles(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE analysis_identities (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  identity_hash text NOT NULL,
  analysis_profile_version_id text NOT NULL,
  case_snapshot_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, identity_hash),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, analysis_profile_version_id)
    REFERENCES analysis_profile_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, case_snapshot_id)
    REFERENCES case_snapshots(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE analysis_jobs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  analysis_identity_id text NOT NULL,
  run_ordinal integer NOT NULL CHECK (run_ordinal >= 0),
  state text NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (analysis_identity_id, run_ordinal),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, analysis_identity_id)
    REFERENCES analysis_identities(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE analysis_attempts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  analysis_job_id text NOT NULL,
  attempt_ordinal integer NOT NULL CHECK (attempt_ordinal >= 0),
  state text NOT NULL CHECK (state IN ('running', 'succeeded', 'failed', 'cancelled', 'leaseExpired')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  error_code text,
  UNIQUE (analysis_job_id, attempt_ordinal),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, analysis_job_id)
    REFERENCES analysis_jobs(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE analysis_results (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  analysis_job_id text NOT NULL,
  result_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, analysis_job_id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, analysis_job_id)
    REFERENCES analysis_jobs(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE evidence (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  analysis_result_id text NOT NULL,
  evidence_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, analysis_result_id)
    REFERENCES analysis_results(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE publication_intents (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  analysis_job_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'awaitingApproval', 'publishing', 'published', 'outcomeUnknown', 'failed', 'skipped')),
  intent_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, analysis_job_id)
    REFERENCES analysis_jobs(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE publication_attempts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  publication_intent_id text NOT NULL,
  attempt_ordinal integer NOT NULL CHECK (attempt_ordinal >= 0),
  state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (publication_intent_id, attempt_ordinal),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, publication_intent_id)
    REFERENCES publication_intents(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE audit_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  actor_principal_id text,
  action text NOT NULL,
  target_id text,
  before_hash text,
  after_hash text,
  occurred_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, actor_principal_id)
    REFERENCES principals(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE idempotency_records (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  operation text NOT NULL,
  key_digest text NOT NULL,
  request_digest text NOT NULL,
  resource_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, operation, key_digest)
);

CREATE TABLE inbox_messages (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  message_hash text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, message_hash)
);

CREATE TABLE outbox_envelopes (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('command', 'domainEvent')),
  type text NOT NULL CHECK (type IN ('analysis.execute.v1', 'publication.execute.v1', 'analysis.completed.v1')),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  occurred_at timestamptz NOT NULL,
  correlation_id text NOT NULL,
  causation_id text NOT NULL,
  payload jsonb NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  claim_token text,
  claimed_until timestamptz,
  claim_attempts integer NOT NULL DEFAULT 0 CHECK (claim_attempts >= 0),
  delivered_at timestamptz,
  CHECK (
    (type = 'analysis.completed.v1' AND kind = 'domainEvent')
    OR (type IN ('analysis.execute.v1', 'publication.execute.v1') AND kind = 'command')
  )
);
CREATE INDEX outbox_envelopes_claim_idx
  ON outbox_envelopes (delivered_at, available_at, claimed_until);

CREATE TABLE resource_leases (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  resource_type text NOT NULL,
  resource_key text NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, resource_type, resource_key)
);
