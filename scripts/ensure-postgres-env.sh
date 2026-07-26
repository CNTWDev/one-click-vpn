#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

if [ ! -f "$APP_DIR/.env" ]; then
  echo "Missing $APP_DIR/.env" >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate the PostgreSQL password." >&2
  exit 1
fi

database_password=$(awk -F= '$1 == "NORTHSTAR_DB_PASSWORD" { sub(/^[^=]*=/, ""); print; exit }' "$APP_DIR/.env")
case "$database_password" in
  ""|replace-with-*)
    database_password=$(openssl rand -hex 24)
    env_tmp=$(mktemp "$APP_DIR/.env.tmp.XXXXXX")
    awk -v value="$database_password" '
      BEGIN { found = 0 }
      /^NORTHSTAR_DATABASE_PATH=/ { next }
      /^NORTHSTAR_DB_PASSWORD=/ { print "NORTHSTAR_DB_PASSWORD=" value; found = 1; next }
      { print }
      END { if (!found) print "NORTHSTAR_DB_PASSWORD=" value }
    ' "$APP_DIR/.env" > "$env_tmp"
    chmod 600 "$env_tmp"
    mv "$env_tmp" "$APP_DIR/.env"
    echo "PostgreSQL password added to $APP_DIR/.env"
    ;;
esac
