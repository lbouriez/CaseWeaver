-- Immutable collection execution records keep durable source work pinned to its
-- vector space, limits, and hard-budget policy. Existing collections remain
-- readable; only a source runtime record that explicitly references one is
-- executable by the new resolver.
CREATE TABLE knowledge_collection_runtime_versions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  knowledge_collection_id text NOT NULL,
  embedding_binding_version_id text NOT NULL,
  embedding_profile_version text NOT NULL CHECK (length(embedding_profile_version) > 0),
  dimensions integer NOT NULL CHECK (dimensions > 0),
  maximum_input_tokens integer NOT NULL CHECK (maximum_input_tokens > 0),
  budget_currency char(3) NOT NULL CHECK (budget_currency ~ '^[A-Z]{3}$'),
  budget_hard boolean NOT NULL,
  budget_policy_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, knowledge_collection_id)
    REFERENCES knowledge_collections(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, embedding_binding_version_id)
    REFERENCES ai_model_binding_versions(workspace_id, id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION knowledge_collection_runtime_version_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Knowledge collection runtime versions are immutable.';
END; $$;
CREATE TRIGGER knowledge_collection_runtime_version_immutable_trigger
  BEFORE UPDATE OR DELETE ON knowledge_collection_runtime_versions
  FOR EACH ROW EXECUTE FUNCTION knowledge_collection_runtime_version_immutable();

ALTER TABLE knowledge_source_runtime_versions
  ADD COLUMN knowledge_collection_id text,
  ADD COLUMN collection_runtime_version_id text,
  ADD COLUMN normalization_profile_id text,
  ADD COLUMN normalization_profile_version text,
  ADD COLUMN chunking_profile_id text,
  ADD COLUMN chunking_profile_version text,
  ADD COLUMN synchronization_policy jsonb,
  ADD COLUMN embedding_batch_size integer,
  ADD CONSTRAINT knowledge_source_runtime_versions_collection_runtime_fk
    FOREIGN KEY (workspace_id, collection_runtime_version_id)
    REFERENCES knowledge_collection_runtime_versions(workspace_id, id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT knowledge_source_runtime_versions_execution_shape_check
    CHECK (
      (
        knowledge_collection_id IS NULL
        AND collection_runtime_version_id IS NULL
        AND normalization_profile_id IS NULL
        AND normalization_profile_version IS NULL
        AND chunking_profile_id IS NULL
        AND chunking_profile_version IS NULL
        AND synchronization_policy IS NULL
        AND embedding_batch_size IS NULL
      )
      OR
      (
        knowledge_collection_id IS NOT NULL
        AND collection_runtime_version_id IS NOT NULL
        AND normalization_profile_id IS NOT NULL
        AND normalization_profile_version IS NOT NULL
        AND chunking_profile_id IS NOT NULL
        AND chunking_profile_version IS NOT NULL
        AND synchronization_policy IS NOT NULL
        AND embedding_batch_size > 0
      )
    ) NOT VALID;

-- This guard permits legacy all-null rows, but rejects partial pins for every
-- new write. Runtime resolution still rejects all-null legacy records.
CREATE OR REPLACE FUNCTION knowledge_source_runtime_execution_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.collection_runtime_version_id IS NOT NULL THEN
    PERFORM 1
      FROM knowledge_collection_runtime_versions AS runtime
      JOIN knowledge_sources AS source
        ON source.workspace_id = NEW.workspace_id
       AND source.id = NEW.knowledge_source_id
     WHERE runtime.workspace_id = NEW.workspace_id
       AND runtime.id = NEW.collection_runtime_version_id
       AND runtime.knowledge_collection_id = NEW.knowledge_collection_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Knowledge source collection runtime pin is invalid.';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER knowledge_source_runtime_execution_guard_trigger
  BEFORE INSERT ON knowledge_source_runtime_versions
  FOR EACH ROW EXECUTE FUNCTION knowledge_source_runtime_execution_guard();

ALTER TABLE knowledge_source_states
  ADD COLUMN execution_fence bigint NOT NULL DEFAULT 0 CHECK (execution_fence >= 0),
  ADD COLUMN execution_lease_expires_at timestamptz,
  ADD COLUMN last_execution_mode text
    CHECK (last_execution_mode IS NULL OR last_execution_mode IN ('incremental', 'fullRescan'));

CREATE INDEX knowledge_source_states_execution_lease_idx
  ON knowledge_source_states (workspace_id, knowledge_source_id, execution_lease_expires_at);
