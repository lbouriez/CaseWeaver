-- A session response returns the current CSRF synchronizer token. Retain it only as
-- short-lived authenticated ciphertext; the existing digest remains comparison-only.
ALTER TABLE administration_sessions
  ADD COLUMN csrf_ciphertext text,
  ADD COLUMN csrf_encryption_key_id text;

ALTER TABLE administration_sessions
  ADD CONSTRAINT administration_sessions_csrf_ciphertext_pair_check
  CHECK (
    (csrf_ciphertext IS NULL AND csrf_encryption_key_id IS NULL)
    OR (csrf_ciphertext IS NOT NULL AND csrf_encryption_key_id IS NOT NULL)
  );
