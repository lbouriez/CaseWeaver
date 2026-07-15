CREATE TABLE administration_diagnostic_export_artifacts (
  workspace_id text NOT NULL,
  export_id text NOT NULL,
  content bytea NOT NULL,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 0 AND 1048576),
  content_type text NOT NULL CHECK (content_type = 'application/json'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, export_id),
  FOREIGN KEY (workspace_id, export_id)
    REFERENCES administration_diagnostic_exports(workspace_id, id) ON DELETE RESTRICT,
  CHECK (octet_length(content) = byte_length)
);
