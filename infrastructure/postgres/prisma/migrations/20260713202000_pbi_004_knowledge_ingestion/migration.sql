CREATE TABLE knowledge_collections (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  embedding_binding_version_id text NOT NULL,
  embedding_profile_version text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, embedding_binding_version_id)
    REFERENCES ai_model_binding_versions(workspace_id, id) ON DELETE RESTRICT
);

CREATE FUNCTION prevent_knowledge_collection_embedding_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.embedding_binding_version_id IS DISTINCT FROM NEW.embedding_binding_version_id
     OR OLD.embedding_profile_version IS DISTINCT FROM NEW.embedding_profile_version
     OR OLD.dimensions IS DISTINCT FROM NEW.dimensions THEN
    RAISE EXCEPTION 'Knowledge collection embedding space is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER knowledge_collections_embedding_immutable
  BEFORE UPDATE ON knowledge_collections
  FOR EACH ROW
  EXECUTE FUNCTION prevent_knowledge_collection_embedding_mutation();

CREATE TABLE knowledge_sources (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  connector_registration_id text NOT NULL,
  knowledge_collection_id text NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('enabled', 'disabled')),
  configuration_version text NOT NULL,
  normalization_profile_version text NOT NULL,
  chunking_profile_version text NOT NULL,
  synchronization_policy jsonb NOT NULL,
  deletion_behavior text NOT NULL CHECK (deletion_behavior IN ('tombstone', 'retain')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, connector_registration_id)
    REFERENCES connector_registrations(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, knowledge_collection_id)
    REFERENCES knowledge_collections(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE knowledge_source_states (
  workspace_id text NOT NULL,
  knowledge_source_id text NOT NULL,
  cursor_version text,
  cursor_value text,
  last_completed_at timestamptz,
  last_scan_epoch_version text,
  last_scan_epoch_value text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, knowledge_source_id),
  CHECK (
    (cursor_version IS NULL AND cursor_value IS NULL)
    OR (cursor_version IS NOT NULL AND cursor_value IS NOT NULL)
  ),
  CHECK (
    (last_scan_epoch_version IS NULL AND last_scan_epoch_value IS NULL)
    OR (last_scan_epoch_version IS NOT NULL AND last_scan_epoch_value IS NOT NULL)
  ),
  FOREIGN KEY (workspace_id, knowledge_source_id)
    REFERENCES knowledge_sources(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE knowledge_documents (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  knowledge_source_id text NOT NULL,
  external_reference_id text NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('active', 'tombstoned')),
  active_revision_id text,
  last_fingerprint_version text,
  last_fingerprint_value text,
  last_seen_epoch_version text,
  last_seen_epoch_value text,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, knowledge_source_id, external_reference_id),
  CHECK (
    (last_fingerprint_version IS NULL AND last_fingerprint_value IS NULL)
    OR (last_fingerprint_version IS NOT NULL AND last_fingerprint_value IS NOT NULL)
  ),
  CHECK (
    (last_seen_epoch_version IS NULL AND last_seen_epoch_value IS NULL)
    OR (last_seen_epoch_version IS NOT NULL AND last_seen_epoch_value IS NOT NULL)
  ),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, knowledge_source_id)
    REFERENCES knowledge_sources(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, external_reference_id)
    REFERENCES external_references(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE knowledge_revisions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  knowledge_document_id text NOT NULL,
  revision_ordinal integer NOT NULL CHECK (revision_ordinal > 0),
  state text NOT NULL CHECK (state IN ('active', 'failed')),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  normalization_profile_version text NOT NULL,
  chunking_profile_version text NOT NULL,
  embedding_binding_version_id text NOT NULL,
  embedding_profile_version text NOT NULL,
  embedding_dimensions integer NOT NULL CHECK (embedding_dimensions > 0),
  normalized_content text,
  title text,
  source_url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  diagnostic jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, knowledge_document_id, revision_ordinal),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, knowledge_document_id)
    REFERENCES knowledge_documents(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, embedding_binding_version_id)
    REFERENCES ai_model_binding_versions(workspace_id, id) ON DELETE RESTRICT,
  CHECK (
    (state = 'active' AND activated_at IS NOT NULL AND diagnostic IS NULL)
    OR (state = 'failed' AND activated_at IS NULL AND diagnostic IS NOT NULL)
  )
);

ALTER TABLE knowledge_documents
  ADD CONSTRAINT knowledge_documents_active_revision_fk
  FOREIGN KEY (workspace_id, active_revision_id)
  REFERENCES knowledge_revisions(workspace_id, id) ON DELETE RESTRICT;

CREATE TABLE knowledge_embedding_cache_entries (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  chunk_hash text NOT NULL CHECK (chunk_hash ~ '^[a-f0-9]{64}$'),
  embedding_binding_version_id text NOT NULL,
  embedding_profile_version text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions > 0),
  normalization_profile_version text NOT NULL,
  embedding vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (
    workspace_id,
    chunk_hash,
    embedding_binding_version_id,
    embedding_profile_version,
    dimensions,
    normalization_profile_version
  ),
  CHECK (vector_dims(embedding) = dimensions),
  FOREIGN KEY (workspace_id, embedding_binding_version_id)
    REFERENCES ai_model_binding_versions(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE knowledge_chunks (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  knowledge_revision_id text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  content text NOT NULL CHECK (length(content) > 0),
  source_anchor text,
  embedding_cache_entry_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, knowledge_revision_id, position),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, knowledge_revision_id)
    REFERENCES knowledge_revisions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, embedding_cache_entry_id)
    REFERENCES knowledge_embedding_cache_entries(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE knowledge_embedding_allocations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  embedding_cache_entry_id text NOT NULL,
  ai_operation_id text NOT NULL,
  allocated_input_tokens integer CHECK (allocated_input_tokens >= 0),
  calculated_cost_amount numeric(38,18),
  calculated_cost_currency char(3),
  calculation_status text NOT NULL CHECK (calculation_status IN ('known', 'unknown', 'incomplete')),
  weight_numerator integer NOT NULL CHECK (weight_numerator >= 0),
  weight_denominator integer NOT NULL CHECK (weight_denominator > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, embedding_cache_entry_id, ai_operation_id),
  CHECK (
    (calculated_cost_amount IS NULL AND calculated_cost_currency IS NULL)
    OR (
      calculated_cost_amount IS NOT NULL
      AND calculated_cost_currency IS NOT NULL
      AND calculated_cost_currency ~ '^[A-Z]{3}$'
    )
  ),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, embedding_cache_entry_id)
    REFERENCES knowledge_embedding_cache_entries(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, ai_operation_id)
    REFERENCES ai_operations(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE knowledge_schedules (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  knowledge_source_id text NOT NULL,
  schedule_kind text NOT NULL CHECK (schedule_kind IN ('synchronize', 'fullRescan')),
  configuration_version text NOT NULL,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('cron', 'interval')),
  cron_expression text,
  timezone text,
  interval_ms bigint,
  jitter_ms bigint,
  overlap_policy text NOT NULL CHECK (overlap_policy IN ('skip', 'queue')),
  enabled boolean NOT NULL DEFAULT true,
  next_run_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  CHECK (
    (
      trigger_kind = 'cron'
      AND cron_expression IS NOT NULL
      AND timezone IS NOT NULL
      AND interval_ms IS NULL
    )
    OR (
      trigger_kind = 'interval'
      AND interval_ms IS NOT NULL
      AND interval_ms > 0
      AND cron_expression IS NULL
      AND timezone IS NULL
    )
  ),
  CHECK (jitter_ms IS NULL OR jitter_ms >= 0),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, knowledge_source_id)
    REFERENCES knowledge_sources(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX knowledge_schedules_due_idx
  ON knowledge_schedules (enabled, next_run_at);

CREATE TABLE knowledge_schedule_leases (
  workspace_id text NOT NULL,
  knowledge_schedule_id text NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, knowledge_schedule_id),
  FOREIGN KEY (workspace_id, knowledge_schedule_id)
    REFERENCES knowledge_schedules(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE knowledge_schedule_occurrences (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  knowledge_schedule_id text NOT NULL,
  occurrence_key text NOT NULL CHECK (occurrence_key ~ '^[a-f0-9]{64}$'),
  scheduled_for timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, knowledge_schedule_id, occurrence_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, knowledge_schedule_id)
    REFERENCES knowledge_schedules(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE knowledge_schedule_commands (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  knowledge_schedule_occurrence_id text NOT NULL,
  command_type text NOT NULL CHECK (
    command_type IN ('knowledge.synchronize.v1', 'knowledge.full-rescan.v1')
  ),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (workspace_id, knowledge_schedule_occurrence_id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, knowledge_schedule_occurrence_id)
    REFERENCES knowledge_schedule_occurrences(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX knowledge_schedule_commands_delivery_idx
  ON knowledge_schedule_commands (delivered_at, created_at);

ALTER TABLE outbox_envelopes
  DROP CONSTRAINT outbox_envelopes_type_check,
  ADD CONSTRAINT outbox_envelopes_type_check CHECK (
    type IN (
      'analysis.execute.v1',
      'publication.execute.v1',
      'analysis.completed.v1',
      'knowledge.synchronize.v1',
      'knowledge.full-rescan.v1'
    )
  ),
  DROP CONSTRAINT outbox_envelopes_check,
  ADD CONSTRAINT outbox_envelopes_check CHECK (
    (type = 'analysis.completed.v1' AND kind = 'domainEvent')
    OR (
      type IN (
        'analysis.execute.v1',
        'publication.execute.v1',
        'knowledge.synchronize.v1',
        'knowledge.full-rescan.v1'
      )
      AND kind = 'command'
    )
  );
