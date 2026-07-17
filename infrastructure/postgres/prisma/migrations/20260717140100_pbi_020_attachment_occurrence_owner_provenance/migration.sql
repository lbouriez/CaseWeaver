-- A preparation-local ordinal prevents collisions across a case description
-- and its comments. Retain the connector-normalized owner hash and original
-- per-owner ordinal as immutable safe provenance, without persisting a
-- connector locator, external URL, path, source text, or credential.
ALTER TABLE attachment_preparation_attempt_occurrences
  ADD COLUMN IF NOT EXISTS owner_identity text,
  ADD COLUMN IF NOT EXISTS source_ordinal integer;

ALTER TABLE attachment_preparation_attempt_occurrences
  ADD CONSTRAINT attachment_preparation_attempt_occurrences_source_ordinal_check
  CHECK (source_ordinal IS NULL OR source_ordinal >= 0) NOT VALID;

ALTER TABLE attachment_preparation_attempt_occurrences
  VALIDATE CONSTRAINT attachment_preparation_attempt_occurrences_source_ordinal_check;
