-- PBI-020 target-free intake scheduling. The scheduler owns only leased
-- occurrence/outbox publication; connector cursors are worker-private state.
CREATE TABLE case_analysis_intake_schedule_leases (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  case_analysis_intake_schedule_id text NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, case_analysis_intake_schedule_id),
  FOREIGN KEY (workspace_id, case_analysis_intake_schedule_id)
    REFERENCES case_analysis_intake_schedules(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE case_analysis_intake_schedule_occurrences (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  case_analysis_intake_schedule_id text NOT NULL,
  occurrence_key text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  configuration_version_id text NOT NULL,
  trigger_version_id text NOT NULL,
  connector_configuration_version_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, case_analysis_intake_schedule_id, occurrence_key),
  FOREIGN KEY (workspace_id, case_analysis_intake_schedule_id)
    REFERENCES case_analysis_intake_schedules(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, configuration_version_id)
    REFERENCES administration_configuration_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, trigger_version_id)
    REFERENCES analysis_trigger_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, connector_configuration_version_id)
    REFERENCES administration_configuration_versions(workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX case_analysis_intake_schedule_occurrences_created_idx
  ON case_analysis_intake_schedule_occurrences (workspace_id, created_at);

-- Opaque connector cursors are private worker state. They are never selected
-- by administration/API reads or carried in an outbox envelope.
CREATE TABLE case_analysis_intake_schedule_cursors (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  case_analysis_intake_schedule_id text NOT NULL,
  cursor_version text,
  cursor_value text,
  execution_fence bigint NOT NULL DEFAULT 0 CHECK (execution_fence >= 0),
  lease_expires_at timestamptz,
  state text NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'running', 'failed')),
  error_code text,
  error_retryable boolean,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, case_analysis_intake_schedule_id),
  FOREIGN KEY (workspace_id, case_analysis_intake_schedule_id)
    REFERENCES case_analysis_intake_schedules(workspace_id, id) ON DELETE RESTRICT,
  CHECK (
    (cursor_version IS NULL AND cursor_value IS NULL)
    OR (cursor_version IS NOT NULL AND cursor_value IS NOT NULL)
  ),
  CHECK (cursor_version IS NULL OR char_length(cursor_version) BETWEEN 1 AND 200),
  CHECK (cursor_value IS NULL OR char_length(cursor_value) BETWEEN 1 AND 16384),
  CHECK (
    (state = 'running' AND lease_expires_at IS NOT NULL)
    OR (state IN ('idle', 'failed') AND lease_expires_at IS NULL)
  )
);
