ALTER TABLE knowledge_collections
  ADD CONSTRAINT knowledge_collections_supported_dimensions
  CHECK (dimensions IN (3, 1536));

ALTER TABLE knowledge_revisions
  ADD CONSTRAINT knowledge_revisions_supported_embedding_dimensions
  CHECK (embedding_dimensions IN (3, 1536));

ALTER TABLE knowledge_embedding_cache_entries
  ADD CONSTRAINT knowledge_embedding_cache_entries_supported_dimensions
  CHECK (dimensions IN (3, 1536));

CREATE INDEX knowledge_chunks_content_fts_idx
  ON knowledge_chunks
  USING gin (to_tsvector('simple', content));

CREATE INDEX knowledge_embedding_cache_entries_vector_3_idx
  ON knowledge_embedding_cache_entries
  USING hnsw ((embedding::vector(3)) vector_cosine_ops)
  WHERE dimensions = 3;

CREATE INDEX knowledge_embedding_cache_entries_vector_1536_idx
  ON knowledge_embedding_cache_entries
  USING hnsw ((embedding::vector(1536)) vector_cosine_ops)
  WHERE dimensions = 1536;

CREATE TABLE retrieval_snapshots (
  id text NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  analysis_id text,
  captured_at timestamptz NOT NULL,
  query text NOT NULL CHECK (length(query) > 0),
  profile_id text NOT NULL CHECK (length(profile_id) > 0),
  profile_version text NOT NULL CHECK (length(profile_version) > 0),
  query_embedding_operation_ids jsonb NOT NULL,
  reranker_operation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE retrieval_snapshot_evidence (
  workspace_id text NOT NULL,
  retrieval_snapshot_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  collection_id text NOT NULL CHECK (length(collection_id) > 0),
  source_id text NOT NULL CHECK (length(source_id) > 0),
  source_revision_id text NOT NULL CHECK (length(source_revision_id) > 0),
  chunk_id text NOT NULL CHECK (length(chunk_id) > 0),
  location text NOT NULL CHECK (length(location) > 0),
  source_url text,
  content text NOT NULL CHECK (length(content) > 0),
  access_metadata jsonb NOT NULL,
  fused_rrf double precision NOT NULL,
  lexical_rrf double precision NOT NULL,
  vector_rrf double precision NOT NULL,
  reranker_score double precision,
  character_count integer NOT NULL CHECK (character_count >= 0),
  token_count integer NOT NULL CHECK (token_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, retrieval_snapshot_id, ordinal),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, retrieval_snapshot_id)
    REFERENCES retrieval_snapshots(workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX retrieval_snapshot_evidence_source_idx
  ON retrieval_snapshot_evidence (
    workspace_id, source_id, source_revision_id, chunk_id
  );

CREATE FUNCTION prevent_retrieval_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Retrieval snapshots are immutable';
  RETURN OLD;
END;
$$;

CREATE TRIGGER retrieval_snapshots_immutable
  BEFORE UPDATE OR DELETE ON retrieval_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION prevent_retrieval_snapshot_mutation();

CREATE TRIGGER retrieval_snapshot_evidence_immutable
  BEFORE UPDATE OR DELETE ON retrieval_snapshot_evidence
  FOR EACH ROW
  EXECUTE FUNCTION prevent_retrieval_snapshot_mutation();
