#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
. "$SCRIPT_DIR/common.sh"

cd "$APP_DIR"

if [ ! -f .env ]; then
  echo "Missing $APP_DIR/.env. Run scripts/one-click-deploy.sh or copy .env.example." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required." >&2
  exit 1
fi

compose version >/dev/null

required_value() {
  name=$1
  value=$(env_value "$name")
  if [ -z "$value" ] || printf '%s' "$value" | grep -Eq '^(replace-with|owner@example.com|vpn\.example\.com)'; then
    echo "$name is missing or still contains an example value in .env." >&2
    exit 1
  fi
}

required_value APP_DOMAIN
required_value NORTHSTAR_ADMIN_EMAIL
required_value NORTHSTAR_ADMIN_PASSWORD
required_value NORTHSTAR_MASTER_KEY
required_value NORTHSTAR_PUBLIC_ORIGIN
required_value NORTHSTAR_DB_PASSWORD

domain=$(env_value APP_DOMAIN)
origin=$(env_value NORTHSTAR_PUBLIC_ORIGIN)
email=$(env_value NORTHSTAR_ADMIN_EMAIL)
password=$(env_value NORTHSTAR_ADMIN_PASSWORD)
master_key=$(env_value NORTHSTAR_MASTER_KEY)
database_password=$(env_value NORTHSTAR_DB_PASSWORD)

if ! printf '%s' "$domain" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$'; then
  echo "APP_DOMAIN must be a DNS hostname without a scheme or path." >&2
  exit 1
fi

if [ "$origin" != "https://$domain" ]; then
  echo "NORTHSTAR_PUBLIC_ORIGIN must exactly be https://$domain in production." >&2
  exit 1
fi

if ! printf '%s' "$email" | grep -Eq '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'; then
  echo "NORTHSTAR_ADMIN_EMAIL is not a valid email address." >&2
  exit 1
fi

if [ "${#password}" -lt 16 ]; then
  echo "NORTHSTAR_ADMIN_PASSWORD must be at least 16 characters." >&2
  exit 1
fi

if [ "${#database_password}" -lt 24 ]; then
  echo "NORTHSTAR_DB_PASSWORD must be at least 24 characters." >&2
  exit 1
fi

key_length=0
if printf '%s' "$master_key" | grep -Eq '^[0-9a-fA-F]{64}$'; then
  key_length=32
elif command -v openssl >/dev/null 2>&1; then
  key_length=$(printf '%s' "$master_key" | openssl base64 -d -A 2>/dev/null | wc -c | tr -d ' ')
fi
if [ "$key_length" -ne 32 ]; then
  echo "NORTHSTAR_MASTER_KEY must be 32 bytes encoded as base64 or 64 hex characters." >&2
  exit 1
fi

if ! compose config --quiet >/dev/null 2>&1; then
  echo "docker compose configuration is invalid." >&2
  compose config >&2 || true
  exit 1
fi

case "$(uname -s)" in
  Linux)
    if command -v stat >/dev/null 2>&1 && stat -c '%a' .env >/dev/null 2>&1; then
      mode=$(stat -c '%a' .env)
    else
      mode=$(stat -f '%Lp' .env)
    fi
    case "$mode" in
      ???[0-9]|??[1-7][0-9]|?[1-7][0-9][0-9]|[1-7][0-9][0-9][0-9])
        echo "Warning: .env permissions are broader than 0600; run chmod 600 .env." >&2
        ;;
    esac
    ;;
esac

echo "Environment and Docker Compose configuration are valid."
