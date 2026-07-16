#!/bin/sh
set -eu

# Production passes DATABASE_URL_FILE as a Docker secret. The disposable local
# Compose stack deliberately uses an internal direct DATABASE_URL instead. Neither
# branch prints the URL or any other environment value.
if [ -n "${DATABASE_URL_FILE:-}" ]; then
  if [ ! -r "$DATABASE_URL_FILE" ]; then
    echo "DATABASE_URL_FILE must reference a readable Docker secret." >&2
    exit 1
  fi
  DATABASE_URL="$(cat "$DATABASE_URL_FILE")"
  export DATABASE_URL
  unset DATABASE_URL_FILE
elif [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL or DATABASE_URL_FILE must be configured." >&2
  exit 1
fi

exec "$@"
