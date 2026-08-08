CREATE TABLE "repository_change_requests" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "analysis_result_id" TEXT NOT NULL,
    "runtime_version_id" TEXT NOT NULL,
    "repository_id" TEXT NOT NULL,
    "analyzed_commit" TEXT NOT NULL,
    "target_branch" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "lease_token" TEXT,
    "lease_expires_at" TIMESTAMPTZ(6),
    "architect_summary" TEXT,
    "documentation_impact" TEXT,
    "target_commit" TEXT,
    "pull_request_url" TEXT,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "repository_change_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "repository_change_requests_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "repository_change_requests_workspace_id_analysis_result_id_fkey" FOREIGN KEY ("workspace_id", "analysis_result_id") REFERENCES "analysis_results"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

ALTER TABLE "code_repository_versions"
  ADD COLUMN "automatic_draft_pull_request" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "repository_change_requests_workspace_id_analysis_result_id_key" ON "repository_change_requests"("workspace_id", "analysis_result_id");
CREATE UNIQUE INDEX "repository_change_requests_workspace_id_id_key" ON "repository_change_requests"("workspace_id", "id");
CREATE INDEX "repository_change_requests_workspace_id_state_lease_expires_at_created_at_idx" ON "repository_change_requests"("workspace_id", "state", "lease_expires_at", "created_at");
