#!/bin/sh
set -eu

# Runs after Prisma and pg-boss migrations with the DDL-owning migration role.
# The role name is public configuration, but restrict it before it reaches SQL
# identifier substitution. Passwords and URLs remain in the inherited process only.
runtime_role="${CASEWEAVER_RUNTIME_DATABASE_ROLE:-caseweaver_runtime}"
case "$runtime_role" in
  [a-z][a-z0-9_]* ) ;;
  *)
    echo "CASEWEAVER_RUNTIME_DATABASE_ROLE is invalid." >&2
    exit 1
    ;;
esac

psql --set=ON_ERROR_STOP=1 \
  --set=runtime_role="$runtime_role" \
  --dbname="$DATABASE_URL" <<'SQL'
GRANT USAGE ON SCHEMA public TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"runtime_role";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO :"runtime_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"runtime_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"runtime_role";

GRANT USAGE ON SCHEMA caseweaver_queue TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA caseweaver_queue TO :"runtime_role";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA caseweaver_queue TO :"runtime_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA caseweaver_queue
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"runtime_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA caseweaver_queue
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"runtime_role";
SQL
