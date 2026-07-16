#!/bin/sh
set -eu

api_base_url="${CASEWEAVER_ADMIN_API_BASE_URL:-}"
ui_title="${CASEWEAVER_ADMIN_UI_TITLE:-CaseWeaver Control Room}"

if [ -z "$api_base_url" ]; then
  echo "CASEWEAVER_ADMIN_API_BASE_URL is required." >&2
  exit 1
fi

case "$api_base_url" in
  / | https://* | http://localhost[:/]* | http://127.0.0.1[:/]* | http://\[::1\][:/]*) ;;
  *)
    echo "CASEWEAVER_ADMIN_API_BASE_URL must be an HTTPS URL (HTTP is localhost-only)." >&2
    exit 1
    ;;
esac

# Both values are public configuration, but reject JSON metacharacters instead of
# interpolating arbitrary environment data into a response served to browsers.
case "$api_base_url" in
  *[!A-Za-z0-9:/?\&=._~#%+@,-]*)
    echo "CASEWEAVER_ADMIN_API_BASE_URL contains unsupported characters." >&2
    exit 1
    ;;
esac

case "$ui_title" in
  "" | *[!A-Za-z0-9\ .,:\(\)/_-]*)
    echo "CASEWEAVER_ADMIN_UI_TITLE contains unsupported characters." >&2
    exit 1
    ;;
esac

umask 077
printf '{\n  "apiBaseUrl": "%s",\n  "uiTitle": "%s"\n}\n' "$api_base_url" "$ui_title" \
  > /tmp/caseweaver-runtime-config.json

exec "$@"
