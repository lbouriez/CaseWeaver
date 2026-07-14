#!/bin/sh
set -eu

if [ -z "${DATABASE_URL_FILE:-}" ] || [ ! -r "$DATABASE_URL_FILE" ]; then
  echo "DATABASE_URL_FILE must reference a readable Docker secret." >&2
  exit 1
fi

DATABASE_URL="$(cat "$DATABASE_URL_FILE")"
export DATABASE_URL
unset DATABASE_URL_FILE

exec "$@"
