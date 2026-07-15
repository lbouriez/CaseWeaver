-- OIDC callbacks must supply the original PKCE verifier and nonce. They are therefore
-- retained only as short-lived authenticated ciphertext; state remains hash-only.
ALTER TABLE administration_login_transactions
  ADD COLUMN nonce_ciphertext text,
  ADD COLUMN verifier_ciphertext text,
  ADD COLUMN encryption_key_id text;

ALTER TABLE administration_login_transactions
  ADD CONSTRAINT administration_login_transactions_ciphertext_pair_check
  CHECK (
    (nonce_ciphertext IS NULL AND verifier_ciphertext IS NULL AND encryption_key_id IS NULL)
    OR (
      nonce_ciphertext IS NOT NULL
      AND verifier_ciphertext IS NOT NULL
      AND encryption_key_id IS NOT NULL
    )
  );
