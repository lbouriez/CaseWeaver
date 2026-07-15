-- A browser starts OIDC at the API but may be hosted on a distinct trusted
-- origin. The API derives and persists only allow-listed absolute UI targets.
ALTER TABLE administration_login_transactions
  DROP CONSTRAINT administration_login_transactions_return_path_check,
  ADD CONSTRAINT administration_login_transactions_return_path_check
    CHECK (
      length(return_path) BETWEEN 1 AND 2000
      -- Relative records can exist only from an already-issued, short-lived
      -- pre-migration login transaction. New service writes are absolute and
      -- independently checked against ADMIN_ALLOWED_ORIGINS before persistence.
      AND (
        return_path ~ '^/(?!/)[^[:cntrl:]]*$'
        OR return_path ~ '^https?://[^/?#[:space:]]+(?:/|$)'
      )
    );
