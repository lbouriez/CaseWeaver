ALTER TABLE ai_operations
  ADD COLUMN parent_operation_id text;

ALTER TABLE ai_operations
  ADD CONSTRAINT ai_operations_parent_operation_check
    CHECK (parent_operation_id IS NULL OR parent_operation_id <> id),
  ADD CONSTRAINT ai_operations_parent_operation_fk
    FOREIGN KEY (workspace_id, parent_operation_id)
    REFERENCES ai_operations(workspace_id, id) ON DELETE RESTRICT;

CREATE INDEX ai_operations_workspace_parent_started_idx
  ON ai_operations (workspace_id, parent_operation_id, started_at);
