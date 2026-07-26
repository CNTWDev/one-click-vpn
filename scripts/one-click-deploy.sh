#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

domain=""
portal_domain=""
admin_domain=""
api_domain=""
admin_email=""
admin_password=""
skip_docker_install="no"
force_env="no"

usage() {
  cat <<'USAGE'
Usage:
  sudo ./scripts/one-click-deploy.sh --domain example.com --admin-email owner@example.com

The admin password is requested interactively when --admin-password is omitted.
Existing .env is reused. Pass --yes to back it up and regenerate it from arguments.

Options:
  --domain HOST              Base DNS name; defaults to app./console./api.HOST
  --portal-domain HOST       Portal browser hostname (default: app.HOST)
  --admin-domain HOST        Admin browser hostname (default: console.HOST)
  --api-domain HOST          API and Agent hostname (default: api.HOST)
  --admin-email EMAIL        Initial owner email
  --admin-password PASSWORD  Initial owner password (prefer interactive prompt)
  --yes                      Back up and replace an existing .env
  --skip-docker-install      Do not install Docker when it is missing
  -h, --help                 Show this help
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --domain) domain=${2:-}; shift 2 ;;
    --portal-domain) portal_domain=${2:-}; shift 2 ;;
    --admin-domain) admin_domain=${2:-}; shift 2 ;;
    --api-domain) api_domain=${2:-}; shift 2 ;;
    --admin-email) admin_email=${2:-}; shift 2 ;;
    --admin-password) admin_password=${2:-}; shift 2 ;;
    --yes) force_env="yes"; shift ;;
    --skip-docker-install) skip_docker_install="yes"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

compose_available="no"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  compose_available="yes"
elif command -v docker-compose >/dev/null 2>&1; then
  legacy_version=$(docker-compose version --short 2>/dev/null || true)
  case "$legacy_version" in
    1.*) ;;
    *) compose_available="yes" ;;
  esac
fi

if [ "$(id -u)" -ne 0 ] && [ "$skip_docker_install" = "no" ] && [ "$compose_available" = "no" ]; then
  echo "Docker is missing. Run as root or install Docker first." >&2
  exit 1
fi

if [ "$compose_available" = "no" ] && [ "$skip_docker_install" = "no" ]; then
  "$SCRIPT_DIR/install-ubuntu.sh"
fi

if [ "$compose_available" = "no" ] && [ "$skip_docker_install" = "yes" ]; then
  echo "Docker Compose v2 is required. Install the docker-compose-plugin or omit --skip-docker-install." >&2
  exit 1
fi

if [ -f "$APP_DIR/.env" ] && [ "$force_env" != "yes" ]; then
  echo "Using existing $APP_DIR/.env"
  chmod 600 "$APP_DIR/.env" 2>/dev/null || true
else
  if [ -z "$domain" ]; then
    printf "Base domain (for example example.com): "
    read -r domain
  fi
  if [ -z "$portal_domain" ]; then portal_domain="app.$domain"; fi
  if [ -z "$admin_domain" ]; then admin_domain="console.$domain"; fi
  if [ -z "$api_domain" ]; then api_domain="api.$domain"; fi
  if [ -z "$admin_email" ]; then
    printf "Owner email: "
    read -r admin_email
  fi
  if [ -z "$admin_password" ]; then
    printf "Owner password (min 16 characters): "
    old_stty=$(stty -g 2>/dev/null || true)
    stty -echo 2>/dev/null || true
    read -r admin_password
    [ -n "$old_stty" ] && stty "$old_stty" 2>/dev/null || true
    printf '\n'
  fi
  if [ "$force_env" = "yes" ] && [ -f "$APP_DIR/.env" ]; then
    backup="$APP_DIR/.env.backup.$(date -u +%Y%m%dT%H%M%SZ)"
    cp "$APP_DIR/.env" "$backup"
    chmod 600 "$backup"
    echo "Existing .env backed up to $backup"
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    echo "openssl is required to generate the master key." >&2
    exit 1
  fi
  master_key=$(openssl rand -base64 32 | tr -d '\n')
  umask 077
  {
    echo "NODE_ENV=production"
    echo "APP_DOMAIN=$portal_domain"
    echo "NORTHSTAR_PORTAL_DOMAIN=$portal_domain"
    echo "NORTHSTAR_ADMIN_DOMAIN=$admin_domain"
    echo "NORTHSTAR_API_DOMAIN=$api_domain"
    echo "NORTHSTAR_ADMIN_EMAIL=$admin_email"
    echo "NORTHSTAR_ADMIN_PASSWORD=$admin_password"
    echo "NORTHSTAR_MASTER_KEY=$master_key"
    echo "NORTHSTAR_PUBLIC_ORIGIN=https://$portal_domain"
    echo "NORTHSTAR_API_ORIGIN=https://$api_domain"
    echo "NORTHSTAR_AGENT_ORIGIN=https://$api_domain"
    echo "NORTHSTAR_DB_PASSWORD=$(openssl rand -hex 24)"
    echo "NORTHSTAR_LOG_STORAGE_PASSWORD=$(openssl rand -hex 24)"
    echo "NORTHSTAR_ADMIN_NAME=Owner"
    echo "NORTHSTAR_SESSION_TTL_SECONDS=43200"
    echo "NORTHSTAR_ALLOW_TOFU_HOST_KEYS=false"
  } > "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "Created $APP_DIR/.env"
fi

"$SCRIPT_DIR/ensure-postgres-env.sh"

cd "$APP_DIR"
"$SCRIPT_DIR/deploy.sh"
