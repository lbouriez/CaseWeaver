CREATE TABLE ai_catalog_snapshots (
  id text PRIMARY KEY,
  upstream_url text NOT NULL,
  upstream_commit_sha text NOT NULL,
  fetched_at timestamptz NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  raw_entries jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (upstream_url, upstream_commit_sha, sha256)
);

CREATE TABLE ai_catalog_models (
  id text PRIMARY KEY,
  catalog_snapshot_id text NOT NULL REFERENCES ai_catalog_snapshots(id) ON DELETE RESTRICT,
  canonical_model text NOT NULL,
  provider text NOT NULL,
  supported_roles jsonb NOT NULL,
  capabilities jsonb NOT NULL,
  maximum_input_tokens integer CHECK (maximum_input_tokens > 0),
  maximum_output_tokens integer CHECK (maximum_output_tokens > 0),
  raw_entry jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (catalog_snapshot_id, canonical_model)
);

CREATE TABLE ai_catalog_price_components (
  id text PRIMARY KEY,
  catalog_model_id text NOT NULL REFERENCES ai_catalog_models(id) ON DELETE RESTRICT,
  component_kind text NOT NULL,
  billing_unit text NOT NULL,
  amount numeric(38,18) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  conditions jsonb NOT NULL,
  source_revision text NOT NULL,
  raw_entry jsonb NOT NULL,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX ai_catalog_price_components_lookup_idx
  ON ai_catalog_price_components (catalog_model_id, component_kind, effective_from DESC);

CREATE TABLE ai_provider_instances (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  provider_type text NOT NULL,
  lifecycle text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE ai_provider_instance_versions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  provider_instance_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  endpoint text NOT NULL,
  wire_api text NOT NULL,
  parameters jsonb NOT NULL,
  secret_reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, provider_instance_id, version),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, provider_instance_id)
    REFERENCES ai_provider_instances(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE ai_model_bindings (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  role text NOT NULL,
  lifecycle text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE ai_model_binding_versions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  model_binding_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  provider_instance_version_id text NOT NULL,
  catalog_snapshot_id text NOT NULL REFERENCES ai_catalog_snapshots(id) ON DELETE RESTRICT,
  catalog_model_id text NOT NULL REFERENCES ai_catalog_models(id) ON DELETE RESTRICT,
  canonical_model text NOT NULL,
  wire_api text NOT NULL,
  parameters jsonb NOT NULL,
  capabilities jsonb NOT NULL,
  maximum_input_tokens integer CHECK (maximum_input_tokens > 0),
  maximum_output_tokens integer CHECK (maximum_output_tokens > 0),
  secret_reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, model_binding_id, version),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, model_binding_id)
    REFERENCES ai_model_bindings(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, provider_instance_version_id)
    REFERENCES ai_provider_instance_versions(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE ai_workspace_binding_defaults (
  workspace_id text NOT NULL,
  role text NOT NULL,
  model_binding_version_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, role),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, model_binding_version_id)
    REFERENCES ai_model_binding_versions(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE ai_installation_price_overrides (
  id text PRIMARY KEY,
  provider text NOT NULL,
  canonical_model text NOT NULL,
  source text NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE TABLE ai_workspace_price_overrides (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  canonical_model text NOT NULL,
  source text NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE TABLE ai_binding_price_overrides (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  model_binding_version_id text NOT NULL,
  source text NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, model_binding_version_id)
    REFERENCES ai_model_binding_versions(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE ai_price_override_components (
  id text PRIMARY KEY,
  installation_price_override_id text REFERENCES ai_installation_price_overrides(id) ON DELETE RESTRICT,
  workspace_id text,
  workspace_price_override_id text,
  binding_price_override_id text,
  component_kind text NOT NULL,
  billing_unit text NOT NULL,
  amount numeric(38,18) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  conditions jsonb NOT NULL,
  raw_entry jsonb NOT NULL,
  CHECK (
    ((installation_price_override_id IS NOT NULL)::integer +
     (workspace_price_override_id IS NOT NULL)::integer +
     (binding_price_override_id IS NOT NULL)::integer) = 1
  ),
  FOREIGN KEY (workspace_id, workspace_price_override_id)
    REFERENCES ai_workspace_price_overrides(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, binding_price_override_id)
    REFERENCES ai_binding_price_overrides(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE ai_budget_policies (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  scope text NOT NULL CHECK (scope IN ('operation', 'analysis', 'day', 'workspace')),
  scope_key text NOT NULL,
  limit_amount numeric(38,18) NOT NULL CHECK (limit_amount >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  hard boolean NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE ai_budget_balances (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  budget_policy_id text NOT NULL,
  scope_key text NOT NULL,
  reserved_amount numeric(38,18) NOT NULL DEFAULT 0 CHECK (reserved_amount >= 0),
  spent_amount numeric(38,18) NOT NULL DEFAULT 0 CHECK (spent_amount >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, budget_policy_id, scope_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, budget_policy_id)
    REFERENCES ai_budget_policies(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE ai_operations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  role text NOT NULL,
  operation_kind text NOT NULL,
  model_binding_version_id text NOT NULL,
  provider_instance_version_id text NOT NULL,
  catalog_snapshot_id text NOT NULL REFERENCES ai_catalog_snapshots(id) ON DELETE RESTRICT,
  configured_model text NOT NULL,
  effective_model text,
  provider_request_id text,
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  latency_ms integer CHECK (latency_ms >= 0),
  raw_redacted jsonb,
  status text NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'timedOut', 'cancelled', 'succeededUsageUnknown')),
  error_code text,
  error_retryable boolean,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, model_binding_version_id)
    REFERENCES ai_model_binding_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, provider_instance_version_id)
    REFERENCES ai_provider_instance_versions(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX ai_operations_workspace_started_idx
  ON ai_operations (workspace_id, started_at DESC);

CREATE TABLE ai_operation_usage (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  operation_id text NOT NULL,
  input_tokens integer CHECK (input_tokens >= 0),
  output_tokens integer CHECK (output_tokens >= 0),
  cache_read_input_tokens integer CHECK (cache_read_input_tokens >= 0),
  cache_creation_input_tokens integer CHECK (cache_creation_input_tokens >= 0),
  reasoning_tokens integer CHECK (reasoning_tokens >= 0),
  image_units integer CHECK (image_units >= 0),
  audio_units integer CHECK (audio_units >= 0),
  raw_usage jsonb,
  UNIQUE (workspace_id, operation_id),
  FOREIGN KEY (workspace_id, operation_id)
    REFERENCES ai_operations(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE ai_operation_costs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  operation_id text NOT NULL,
  estimated_amount numeric(38,18),
  calculated_amount numeric(38,18),
  currency char(3),
  provider_reported_amount numeric(38,18),
  provider_currency char(3),
  provider_currency_status text NOT NULL DEFAULT 'notReported'
    CHECK (provider_currency_status IN ('notReported', 'matched', 'foreign')),
  calculation_status text NOT NULL CHECK (calculation_status IN ('known', 'unknown', 'incomplete')),
  price_inputs jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, operation_id),
  FOREIGN KEY (workspace_id, operation_id)
    REFERENCES ai_operations(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE ai_budget_reservations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  operation_id text NOT NULL,
  budget_balance_id text NOT NULL,
  amount numeric(38,18),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK (status IN ('reserved', 'reconciled', 'released', 'retainedUncertain', 'providerOverage')),
  over_reservation_amount numeric(38,18) CHECK (over_reservation_amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  reconciled_at timestamptz,
  FOREIGN KEY (workspace_id, operation_id)
    REFERENCES ai_operations(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, budget_balance_id)
    REFERENCES ai_budget_balances(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX ai_budget_reservations_operation_idx
  ON ai_budget_reservations (workspace_id, operation_id, status);
