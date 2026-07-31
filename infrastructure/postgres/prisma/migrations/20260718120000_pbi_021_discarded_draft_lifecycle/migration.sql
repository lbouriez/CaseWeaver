-- Preserve immutable configuration history while allowing an inert draft to be
-- terminally removed from authoring/read-model selection.

ALTER TABLE administration_configurations
  DROP CONSTRAINT administration_configurations_lifecycle_check;

ALTER TABLE administration_configurations
  ADD CONSTRAINT administration_configurations_lifecycle_check
  CHECK (lifecycle IN ('draft', 'active', 'disabled', 'discarded', 'superseded'));
