-- LiteLLM canonical model names commonly contain `/`. They are display and
-- provider values, not safe control-plane resource IDs. Convert the internal
-- catalog-model primary keys to the stable SHA-256 form emitted by
-- @caseweaver/ai-config while retaining canonical_model unchanged.
--
-- This is a one-time identity repair for immutable catalog rows. Historical
-- binding versions retain the identical catalog snapshot/model semantics; only
-- their internal foreign-key value changes. No configuration settings, secret
-- references, prices, usage, or audit data is read or rewritten.

-- The original PBI-003 constraints deliberately restrict mutable catalog
-- records. This reviewed forward migration temporarily removes the affected
-- FK and append-only guards, rewrites only the durable identity columns, then
-- restores the same restrictions before commit.
ALTER TABLE ai_catalog_price_components
  DROP CONSTRAINT ai_catalog_price_components_catalog_model_id_fkey;
ALTER TABLE ai_model_binding_versions
  DROP CONSTRAINT ai_model_binding_versions_catalog_model_id_fkey;

ALTER TABLE ai_catalog_models DISABLE TRIGGER USER;
ALTER TABLE ai_catalog_price_components DISABLE TRIGGER USER;
ALTER TABLE ai_model_binding_versions DISABLE TRIGGER USER;

UPDATE ai_catalog_price_components AS component
SET catalog_model_id =
  'catalog-model-' || encode(digest(model.catalog_snapshot_id || ':' || model.canonical_model, 'sha256'), 'hex')
FROM ai_catalog_models AS model
WHERE component.catalog_model_id = model.id;

UPDATE ai_model_binding_versions AS binding
SET catalog_model_id =
  'catalog-model-' || encode(digest(model.catalog_snapshot_id || ':' || model.canonical_model, 'sha256'), 'hex')
FROM ai_catalog_models AS model
WHERE binding.catalog_model_id = model.id;

UPDATE ai_catalog_models AS model
SET id =
  'catalog-model-' || encode(digest(model.catalog_snapshot_id || ':' || model.canonical_model, 'sha256'), 'hex');

ALTER TABLE ai_catalog_models ENABLE TRIGGER USER;
ALTER TABLE ai_catalog_price_components ENABLE TRIGGER USER;
ALTER TABLE ai_model_binding_versions ENABLE TRIGGER USER;

ALTER TABLE ai_catalog_price_components
  ADD CONSTRAINT ai_catalog_price_components_catalog_model_id_fkey
  FOREIGN KEY (catalog_model_id)
  REFERENCES ai_catalog_models(id)
  ON DELETE RESTRICT;
ALTER TABLE ai_model_binding_versions
  ADD CONSTRAINT ai_model_binding_versions_catalog_model_id_fkey
  FOREIGN KEY (catalog_model_id)
  REFERENCES ai_catalog_models(id)
  ON DELETE RESTRICT;
