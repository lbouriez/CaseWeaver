#!/bin/sh
set -eu

# Production passes named values as Docker secret files. The disposable local Compose
# stack deliberately uses its internal direct DATABASE_URL. Nothing below prints a URL,
# secret name, value, or environment dump.
load_secret_file() {
  secret_name="$1"
  required="$2"
  file_variable="${secret_name}_FILE"
  eval "secret_file=\${$file_variable:-}"
  eval "direct_value=\${$secret_name:-}"

  if [ -n "$secret_file" ]; then
    if [ ! -r "$secret_file" ]; then
      echo "A required bootstrap secret is unreadable." >&2
      exit 1
    fi
    secret_value="$(cat "$secret_file")"
    if [ "$required" = "required" ] && [ -z "$secret_value" ]; then
      echo "A required bootstrap secret is empty." >&2
      exit 1
    fi
    export "$secret_name=$secret_value"
    unset "$file_variable"
    unset secret_value
    return
  fi

  if [ "$required" = "required" ] && [ -z "$direct_value" ]; then
    echo "A required bootstrap secret is missing." >&2
    exit 1
  fi
  if [ "${NODE_ENV:-development}" = "production" ] && [ -n "$direct_value" ]; then
    echo "Production bootstrap secrets must be supplied from files." >&2
    exit 1
  fi
}

load_application_secret_directory() {
  secret_directory="${CASEWEAVER_APPLICATION_SECRETS_DIRECTORY:-}"
  if [ -z "$secret_directory" ]; then
    return
  fi
  if [ ! -d "$secret_directory" ]; then
    echo "The application secret directory is unavailable." >&2
    exit 1
  fi
  for secret_file in "$secret_directory"/*; do
    [ -f "$secret_file" ] || continue
    secret_name="${secret_file##*/}"
    case "$secret_name" in
      [A-Za-z_][A-Za-z0-9_]* ) ;;
      *)
        echo "The application secret directory contains an invalid entry." >&2
        exit 1
        ;;
    esac
    secret_value="$(cat "$secret_file")"
    [ -n "$secret_value" ] || continue
    export "$secret_name=$secret_value"
    unset secret_value
  done
  unset CASEWEAVER_APPLICATION_SECRETS_DIRECTORY
}

load_secret_file DATABASE_URL required
load_secret_file OIDC_CLIENT_SECRET optional
load_secret_file OIDC_EPHEMERAL_ENCRYPTION_KEY optional
load_secret_file ADMIN_LOGIN optional
load_secret_file ADMIN_PASSWORD optional
load_secret_file OBJECT_STORAGE_KEY_DERIVATION_SECRET optional
load_secret_file OBJECT_STORAGE_S3_ACCESS_KEY_ID optional
load_secret_file OBJECT_STORAGE_S3_SECRET_ACCESS_KEY optional
load_application_secret_directory

exec "$@"
