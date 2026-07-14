ALTER TABLE analysis_attempts
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN recovery_fencing_token bigint NOT NULL DEFAULT 0
    CHECK (recovery_fencing_token >= 0);

UPDATE analysis_attempts
SET lease_expires_at = COALESCE(finished_at, started_at) + INTERVAL '15 minutes'
WHERE lease_expires_at IS NULL;

ALTER TABLE analysis_attempts
  ALTER COLUMN lease_expires_at SET NOT NULL;

CREATE INDEX analysis_attempts_recovery_idx
  ON analysis_attempts (workspace_id, state, lease_expires_at)
  WHERE state = 'running';

CREATE OR REPLACE FUNCTION prevent_case_snapshot_payload_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.external_reference_id IS DISTINCT FROM NEW.external_reference_id
     OR OLD.snapshot_hash IS DISTINCT FROM NEW.snapshot_hash
     OR OLD.observed_at IS DISTINCT FROM NEW.observed_at THEN
    RAISE EXCEPTION 'Case snapshot payloads are immutable';
  END IF;

  IF OLD.snapshot IS DISTINCT FROM NEW.snapshot
     AND NOT (
       OLD.lifecycle = 'active'
       AND NEW.lifecycle = 'tombstoned'
       AND NEW.snapshot ->> 'contentHash' = OLD.snapshot_hash
       AND NEW.snapshot ->> 'title' = '[Purged for privacy]'
       AND NEW.snapshot ->> 'summary' = '[Purged for privacy]'
       AND NEW.snapshot -> 'messages' = '[]'::jsonb
     ) THEN
    RAISE EXCEPTION 'Case snapshot payloads are immutable';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE ai_operations
  ADD COLUMN analysis_job_id text,
  ADD COLUMN connector_instance_id text,
  ADD COLUMN source_id text,
  ADD CONSTRAINT ai_operations_analysis_job_fk
    FOREIGN KEY (workspace_id, analysis_job_id)
    REFERENCES analysis_jobs(workspace_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT ai_operations_connector_fk
    FOREIGN KEY (workspace_id, connector_instance_id)
    REFERENCES connector_registrations(workspace_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT ai_operations_source_fk
    FOREIGN KEY (workspace_id, source_id)
    REFERENCES knowledge_sources(workspace_id, id) ON DELETE RESTRICT;

CREATE INDEX ai_operations_cost_attribution_idx
  ON ai_operations (
    workspace_id,
    analysis_job_id,
    connector_instance_id,
    role,
    started_at,
    id
  );

CREATE TABLE privacy_tombstones (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  case_snapshot_id text NOT NULL,
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  actor_principal_id text NOT NULL,
  reason text NOT NULL,
  purged_at timestamptz NOT NULL,
  UNIQUE (workspace_id, case_snapshot_id),
  FOREIGN KEY (workspace_id, case_snapshot_id)
    REFERENCES case_snapshots(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, actor_principal_id)
    REFERENCES principals(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE retention_work_items (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  target_kind text NOT NULL CHECK (
    target_kind IN ('attachmentBlob', 'attachmentDerivative')
  ),
  target_id text NOT NULL,
  storage_key text,
  reason text NOT NULL CHECK (reason IN ('privacy', 'retention')),
  state text NOT NULL CHECK (state IN ('queued', 'running', 'completed')),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  claimed_until timestamptz,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, target_kind, target_id),
  CHECK (
    (state = 'completed' AND completed_at IS NOT NULL AND claimed_until IS NULL)
    OR (state = 'running' AND claimed_until IS NOT NULL AND completed_at IS NULL)
    OR (state = 'queued' AND claimed_until IS NULL AND completed_at IS NULL)
  )
);

CREATE INDEX retention_work_items_claim_idx
  ON retention_work_items (workspace_id, state, claimed_until, created_at);

ALTER TABLE outbox_envelopes
  ADD COLUMN trace_context jsonb,
  DROP CONSTRAINT outbox_envelopes_type_check,
  DROP CONSTRAINT outbox_envelopes_kind_type_check,
  ADD CONSTRAINT outbox_envelopes_type_check
    CHECK (
      type IN (
        'analysis.execute.v1',
        'analysis.trigger.v1',
        'publication.execute.v1',
        'publication.reconcile.v1',
        'analysis.completed.v1',
        'knowledge.synchronize.v1',
        'knowledge.full-rescan.v1',
        'retention.reap.v1',
        'retention.purge.v1'
      )
    ),
  ADD CONSTRAINT outbox_envelopes_kind_type_check
    CHECK (
      (type = 'analysis.completed.v1' AND kind = 'domainEvent')
      OR (
        type IN (
          'analysis.execute.v1',
          'analysis.trigger.v1',
          'publication.execute.v1',
          'publication.reconcile.v1',
          'knowledge.synchronize.v1',
          'knowledge.full-rescan.v1',
          'retention.reap.v1',
          'retention.purge.v1'
        )
        AND kind = 'command'
      )
    );

ALTER TABLE outbox_envelopes
  ADD CONSTRAINT outbox_envelopes_trace_context_check
    CHECK (trace_context IS NULL OR jsonb_typeof(trace_context) = 'object');
