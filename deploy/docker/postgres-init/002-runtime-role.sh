#!/bin/sh
set -eu

configure_runtime_role() {
  # The official PostgreSQL image invokes init scripts only for a new data volume.
  # It sources non-executable .sh files, so this must return rather than exit: a
  # local no-secret opt-out must never terminate the image's parent entrypoint.
  # This script deliberately receives no connection URL and never emits a password.
  runtime_role="${CASEWEAVER_RUNTIME_DATABASE_ROLE:-caseweaver_runtime}"
  runtime_password_file="/run/secrets/runtime-database-password"

  case "$runtime_role" in
    [a-z][a-z0-9_]* ) ;;
    *)
      echo "CASEWEAVER_RUNTIME_DATABASE_ROLE is invalid." >&2
      return 1
      ;;
  esac

  if [ ! -r "$runtime_password_file" ]; then
    # The disposable local Compose topology uses the PostgreSQL owner directly
    # and deliberately has no separate runtime database credential. Production
    # always mounts this secret before PostgreSQL can initialize; treating its
    # absence here as a local-role opt-out keeps the shared extension directory
    # usable without weakening the production secret-file contract.
    return 0
  fi

  runtime_password="$(cat "$runtime_password_file")"
  if [ -z "$runtime_password" ]; then
    echo "The runtime database password secret is empty." >&2
    return 1
  fi

  psql --set=ON_ERROR_STOP=1 \
    --set=runtime_role="$runtime_role" \
    --set=runtime_password="$runtime_password" \
    --set=database_name="$POSTGRES_DB" \
    --username="$POSTGRES_USER" \
    --dbname="$POSTGRES_DB" <<'SQL'
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'runtime_role')
    THEN format('ALTER ROLE %I LOGIN PASSWORD %L', :'runtime_role', :'runtime_password')
  ELSE format('CREATE ROLE %I LOGIN PASSWORD %L', :'runtime_role', :'runtime_password')
END
\gexec

GRANT CONNECT ON DATABASE :"database_name" TO :"runtime_role";
GRANT USAGE ON SCHEMA public TO :"runtime_role";
SQL

  unset runtime_password
}

configure_runtime_role
