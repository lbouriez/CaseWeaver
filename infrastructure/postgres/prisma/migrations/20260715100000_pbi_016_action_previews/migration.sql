-- Server-owned, one-use action confirmations. Commands are bounded safe metadata;
-- they must never contain resolved secret values or raw external payloads.
CREATE TABLE administration_action_previews (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  principal_id text NOT NULL,
  session_id text NOT NULL,
  action text NOT NULL,
  command jsonb NOT NULL,
  parameter_digest text NOT NULL,
  permission text NOT NULL,
  confirmation text NOT NULL,
  impact text NOT NULL,
  can_confirm boolean NOT NULL,
  estimated_cost jsonb,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(command) = 'object'),
  CHECK (estimated_cost IS NULL OR jsonb_typeof(estimated_cost) = 'object')
);
CREATE INDEX administration_action_previews_active_idx
  ON administration_action_previews (workspace_id, principal_id, session_id, expires_at)
  WHERE consumed_at IS NULL;
