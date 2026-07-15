-- PBI-016 capability-test identity integrity. A confirmation/claim/result may
-- never combine a provider instance, provider version, and binding version
-- that are individually valid but do not belong to one another.

ALTER TABLE ai_provider_instance_versions
  ADD CONSTRAINT ai_provider_instance_versions_workspace_version_provider_unique
  UNIQUE (workspace_id, id, provider_instance_id);

ALTER TABLE ai_model_binding_versions
  ADD CONSTRAINT ai_model_binding_versions_workspace_binding_provider_version_unique
  UNIQUE (workspace_id, id, provider_instance_version_id);

ALTER TABLE administration_provider_capability_test_confirmations
  ADD CONSTRAINT administration_provider_test_confirmation_provider_identity_fk
    FOREIGN KEY (workspace_id, provider_instance_version_id, provider_instance_id)
    REFERENCES ai_provider_instance_versions(workspace_id, id, provider_instance_id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT administration_provider_test_confirmation_binding_provider_fk
    FOREIGN KEY (workspace_id, binding_version_id, provider_instance_version_id)
    REFERENCES ai_model_binding_versions(workspace_id, id, provider_instance_version_id)
    ON DELETE RESTRICT NOT VALID;

ALTER TABLE administration_provider_capability_test_claims
  ADD CONSTRAINT administration_provider_test_claim_provider_identity_fk
    FOREIGN KEY (workspace_id, provider_instance_version_id, provider_instance_id)
    REFERENCES ai_provider_instance_versions(workspace_id, id, provider_instance_id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT administration_provider_test_claim_binding_provider_fk
    FOREIGN KEY (workspace_id, binding_version_id, provider_instance_version_id)
    REFERENCES ai_model_binding_versions(workspace_id, id, provider_instance_version_id)
    ON DELETE RESTRICT NOT VALID;

ALTER TABLE administration_provider_capability_test_results
  ADD CONSTRAINT administration_provider_test_result_provider_identity_fk
    FOREIGN KEY (workspace_id, provider_instance_version_id, provider_instance_id)
    REFERENCES ai_provider_instance_versions(workspace_id, id, provider_instance_id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT administration_provider_test_result_binding_provider_fk
    FOREIGN KEY (workspace_id, binding_version_id, provider_instance_version_id)
    REFERENCES ai_model_binding_versions(workspace_id, id, provider_instance_version_id)
    ON DELETE RESTRICT NOT VALID;
