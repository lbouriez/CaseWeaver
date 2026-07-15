-- PBI-016 durable AI control-plane aggregates. PBI-003 runtime records remain
-- valid immutable references; these additive fields make administrator authored
-- draft/active selection, optimistic concurrency, and cache invalidation explicit.

ALTER TABLE ai_model_bindings
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN active_version_id text,
  ADD COLUMN draft_version_id text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- Existing active aggregates predate explicit pointers. Backfill only when an
-- immutable version exists; the NOT VALID check still protects every new write
-- without rejecting an old, incomplete installation record.
UPDATE ai_model_bindings AS binding
SET active_version_id = (
  SELECT version.id
  FROM ai_model_binding_versions AS version
  WHERE version.workspace_id = binding.workspace_id
    AND version.model_binding_id = binding.id
  ORDER BY version.version DESC, version.id DESC
  LIMIT 1
)
WHERE binding.lifecycle = 'active'
  AND EXISTS (
    SELECT 1
    FROM ai_model_binding_versions AS version
    WHERE version.workspace_id = binding.workspace_id
      AND version.model_binding_id = binding.id
  );

ALTER TABLE ai_model_bindings
  ADD CONSTRAINT ai_model_bindings_active_version_fk
    FOREIGN KEY (workspace_id, active_version_id)
    REFERENCES ai_model_binding_versions(workspace_id, id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT ai_model_bindings_draft_version_fk
    FOREIGN KEY (workspace_id, draft_version_id)
    REFERENCES ai_model_binding_versions(workspace_id, id)
    ON DELETE RESTRICT NOT VALID;
CREATE INDEX ai_model_bindings_workspace_lifecycle_idx
  ON ai_model_bindings(workspace_id, lifecycle, updated_at DESC, id DESC);

ALTER TABLE ai_workspace_binding_defaults
  ADD COLUMN fallback_binding_version_id text,
  ADD COLUMN revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT ai_workspace_binding_defaults_fallback_fk
    FOREIGN KEY (workspace_id, fallback_binding_version_id)
    REFERENCES ai_model_binding_versions(workspace_id, id)
    ON DELETE RESTRICT NOT VALID;

ALTER TABLE ai_budget_policies
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN supersedes_policy_id text,
  ADD CONSTRAINT ai_budget_policies_supersedes_fk
    FOREIGN KEY (workspace_id, supersedes_policy_id)
    REFERENCES ai_budget_policies(workspace_id, id)
    ON DELETE RESTRICT NOT VALID;
CREATE UNIQUE INDEX ai_budget_policies_one_active_scope_idx
  ON ai_budget_policies(workspace_id, scope, scope_key)
  WHERE active;

-- AI aggregates are not generic administration configurations, so the existing
-- generic outbox foreign keys cannot represent them. This safe-ID-only relay is
-- inserted in the same transaction as the aggregate mutation and audit record.
CREATE TABLE administration_ai_configuration_change_outbox (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  resource_type text NOT NULL,
  aggregate_id text NOT NULL,
  previous_version_id text,
  current_version_id text NOT NULL,
  cache_scopes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  claim_token text,
  claimed_until timestamptz,
  claim_attempts integer NOT NULL DEFAULT 0 CHECK (claim_attempts >= 0),
  UNIQUE(workspace_id, aggregate_id, current_version_id),
  CHECK (jsonb_typeof(cache_scopes) = 'array')
);
CREATE INDEX administration_ai_configuration_change_outbox_claim_idx
  ON administration_ai_configuration_change_outbox
  (published_at, claimed_until, created_at);

CREATE OR REPLACE FUNCTION ai_model_binding_version_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AI model binding versions are append-only.';
END;
$$;
CREATE TRIGGER ai_model_binding_version_append_only_trigger
  BEFORE UPDATE OR DELETE ON ai_model_binding_versions
  FOR EACH ROW EXECUTE FUNCTION ai_model_binding_version_append_only();

CREATE OR REPLACE FUNCTION ai_provider_version_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AI provider versions are append-only.';
END;
$$;
CREATE TRIGGER ai_provider_version_append_only_trigger
  BEFORE UPDATE OR DELETE ON ai_provider_instance_versions
  FOR EACH ROW EXECUTE FUNCTION ai_provider_version_append_only();

CREATE OR REPLACE FUNCTION ai_catalog_rows_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AI catalog records are append-only.';
END;
$$;
CREATE TRIGGER ai_catalog_snapshot_append_only_trigger
  BEFORE UPDATE OR DELETE ON ai_catalog_snapshots
  FOR EACH ROW EXECUTE FUNCTION ai_catalog_rows_append_only();
CREATE TRIGGER ai_catalog_model_append_only_trigger
  BEFORE UPDATE OR DELETE ON ai_catalog_models
  FOR EACH ROW EXECUTE FUNCTION ai_catalog_rows_append_only();
CREATE TRIGGER ai_catalog_price_component_append_only_trigger
  BEFORE UPDATE OR DELETE ON ai_catalog_price_components
  FOR EACH ROW EXECUTE FUNCTION ai_catalog_rows_append_only();

CREATE OR REPLACE FUNCTION ai_price_override_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AI price overrides are append-only.';
END;
$$;
CREATE TRIGGER ai_workspace_price_override_append_only_trigger
  BEFORE UPDATE OR DELETE ON ai_workspace_price_overrides
  FOR EACH ROW EXECUTE FUNCTION ai_price_override_append_only();
CREATE TRIGGER ai_binding_price_override_append_only_trigger
  BEFORE UPDATE OR DELETE ON ai_binding_price_overrides
  FOR EACH ROW EXECUTE FUNCTION ai_price_override_append_only();
CREATE TRIGGER ai_price_override_component_append_only_trigger
  BEFORE UPDATE OR DELETE ON ai_price_override_components
  FOR EACH ROW EXECUTE FUNCTION ai_price_override_append_only();

-- A replacement policy may only deactivate the old immutable row. Every new
-- policy is inserted with a distinct ID and its predecessor identity.
CREATE OR REPLACE FUNCTION ai_budget_policy_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AI budget policies are append-only.';
  END IF;
  IF OLD.active IS NOT TRUE
     OR NEW.active IS DISTINCT FROM false
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.scope_key IS DISTINCT FROM OLD.scope_key
     OR NEW.limit_amount IS DISTINCT FROM OLD.limit_amount
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.hard IS DISTINCT FROM OLD.hard
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.supersedes_policy_id IS DISTINCT FROM OLD.supersedes_policy_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'AI budget policies are immutable except for replacement deactivation.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ai_budget_policy_immutable_guard_trigger
  BEFORE UPDATE OR DELETE ON ai_budget_policies
  FOR EACH ROW EXECUTE FUNCTION ai_budget_policy_immutable_guard();

-- New/changed defaults must resolve to the current active immutable version.
-- A null pointer is tolerated only for a legacy PBI-003 aggregate; the runtime
-- resolver fails closed for that shape until an operator activates a version.
CREATE OR REPLACE FUNCTION ai_workspace_default_active_version_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1
  FROM ai_model_binding_versions AS version
  JOIN ai_model_bindings AS binding
    ON binding.workspace_id = version.workspace_id
   AND binding.id = version.model_binding_id
  WHERE version.workspace_id = NEW.workspace_id
    AND version.id = NEW.model_binding_version_id
    AND binding.role = NEW.role
    AND binding.lifecycle = 'active'
    AND (
      binding.active_version_id = NEW.model_binding_version_id
      OR binding.active_version_id IS NULL
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI workspace defaults must target the current active binding version.';
  END IF;
  IF NEW.fallback_binding_version_id IS NOT NULL THEN
    PERFORM 1
    FROM ai_model_binding_versions AS version
    JOIN ai_model_bindings AS binding
      ON binding.workspace_id = version.workspace_id
     AND binding.id = version.model_binding_id
    WHERE version.workspace_id = NEW.workspace_id
      AND version.id = NEW.fallback_binding_version_id
      AND binding.role = NEW.role
      AND binding.lifecycle = 'active'
      AND (
        binding.active_version_id = NEW.fallback_binding_version_id
        OR binding.active_version_id IS NULL
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'AI workspace fallback defaults must target the current active binding version.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ai_workspace_default_active_version_guard_trigger
  BEFORE INSERT OR UPDATE ON ai_workspace_binding_defaults
  FOR EACH ROW EXECUTE FUNCTION ai_workspace_default_active_version_guard();
