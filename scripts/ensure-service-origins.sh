#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
. "$SCRIPT_DIR/common.sh"

portal_arg=""
admin_arg=""
api_arg=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --portal-domain) portal_arg=${2:-}; shift 2 ;;
    --admin-domain) admin_arg=${2:-}; shift 2 ;;
    --api-domain) api_arg=${2:-}; shift 2 ;;
    -h|--help)
      echo "Usage: ./scripts/ensure-service-origins.sh [--portal-domain HOST --admin-domain HOST --api-domain HOST]"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ ! -f "$APP_DIR/.env" ]; then
  echo "Missing $APP_DIR/.env" >&2
  exit 1
fi

current_app=$(env_value APP_DOMAIN)
current_public=$(env_value NORTHSTAR_PUBLIC_ORIGIN)
current_api_origin=$(env_value NORTHSTAR_API_ORIGIN)
current_agent_origin=$(env_value NORTHSTAR_AGENT_ORIGIN)
portal_domain=${portal_arg:-$(env_value NORTHSTAR_PORTAL_DOMAIN)}
admin_domain=${admin_arg:-$(env_value NORTHSTAR_ADMIN_DOMAIN)}
api_domain=${api_arg:-$(env_value NORTHSTAR_API_DOMAIN)}

if [ -n "$portal_domain" ] && [ -n "$admin_domain" ] && [ -n "$api_domain" ] &&
   [ "$current_app" = "$portal_domain" ] &&
   [ "$current_public" = "https://$portal_domain" ] &&
   [ "$current_api_origin" = "https://$api_domain" ] &&
   [ "$current_agent_origin" = "https://$api_domain" ]; then
  exit 0
fi

if [ -z "$portal_domain" ] || [ -z "$admin_domain" ] || [ -z "$api_domain" ]; then
  if [ ! -t 0 ] || [ ! -t 1 ]; then
    echo "Legacy single-domain configuration detected in .env." >&2
    echo "Run ./scripts/ensure-service-origins.sh interactively, or pass --portal-domain, --admin-domain, and --api-domain." >&2
    exit 1
  fi

  base_domain=$current_app
  case "$base_domain" in
    vpn.*|app.*|console.*|api.*) base_domain=${base_domain#*.} ;;
  esac
  default_portal="app.$base_domain"
  default_admin="console.$base_domain"
  default_api="api.$base_domain"

  echo ""
  echo "Northstar service-domain migration"
  echo "The current .env still uses the legacy single-domain layout: ${current_app:-unset}"
  printf "Portal domain [%s]: " "$default_portal"
  read -r portal_domain
  portal_domain=${portal_domain:-$default_portal}
  printf "Admin domain [%s]: " "$default_admin"
  read -r admin_domain
  admin_domain=${admin_domain:-$default_admin}
  printf "API / Agent domain [%s]: " "$default_api"
  read -r api_domain
  api_domain=${api_domain:-$default_api}
fi

for named_domain in "$portal_domain" "$admin_domain" "$api_domain"; do
  if ! printf '%s' "$named_domain" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$'; then
    echo "Invalid service hostname: $named_domain" >&2
    exit 1
  fi
done

backup="$APP_DIR/.env.backup.origins.$(date -u +%Y%m%dT%H%M%SZ)"
cp "$APP_DIR/.env" "$backup"
chmod 600 "$backup"

env_tmp=$(mktemp "$APP_DIR/.env.tmp.XXXXXX")
awk \
  -v app="$portal_domain" \
  -v portal="$portal_domain" \
  -v admin="$admin_domain" \
  -v api="$api_domain" '
  function replacement(key) {
    if (key == "APP_DOMAIN") return app
    if (key == "NORTHSTAR_PORTAL_DOMAIN") return portal
    if (key == "NORTHSTAR_ADMIN_DOMAIN") return admin
    if (key == "NORTHSTAR_API_DOMAIN") return api
    if (key == "NORTHSTAR_PUBLIC_ORIGIN") return "https://" portal
    if (key == "NORTHSTAR_API_ORIGIN") return "https://" api
    if (key == "NORTHSTAR_AGENT_ORIGIN") return "https://" api
    return ""
  }
  BEGIN {
    managed["APP_DOMAIN"] = 1
    managed["NORTHSTAR_PORTAL_DOMAIN"] = 1
    managed["NORTHSTAR_ADMIN_DOMAIN"] = 1
    managed["NORTHSTAR_API_DOMAIN"] = 1
    managed["NORTHSTAR_PUBLIC_ORIGIN"] = 1
    managed["NORTHSTAR_API_ORIGIN"] = 1
    managed["NORTHSTAR_AGENT_ORIGIN"] = 1
  }
  {
    separator = index($0, "=")
    key = separator ? substr($0, 1, separator - 1) : ""
    if (key in managed) {
      if (!(key in seen)) print key "=" replacement(key)
      seen[key] = 1
      next
    }
    print
  }
  END {
    if (!("APP_DOMAIN" in seen)) print "APP_DOMAIN=" app
    if (!("NORTHSTAR_PORTAL_DOMAIN" in seen)) print "NORTHSTAR_PORTAL_DOMAIN=" portal
    if (!("NORTHSTAR_ADMIN_DOMAIN" in seen)) print "NORTHSTAR_ADMIN_DOMAIN=" admin
    if (!("NORTHSTAR_API_DOMAIN" in seen)) print "NORTHSTAR_API_DOMAIN=" api
    if (!("NORTHSTAR_PUBLIC_ORIGIN" in seen)) print "NORTHSTAR_PUBLIC_ORIGIN=https://" portal
    if (!("NORTHSTAR_API_ORIGIN" in seen)) print "NORTHSTAR_API_ORIGIN=https://" api
    if (!("NORTHSTAR_AGENT_ORIGIN" in seen)) print "NORTHSTAR_AGENT_ORIGIN=https://" api
  }
' "$APP_DIR/.env" > "$env_tmp"
chmod 600 "$env_tmp"
mv "$env_tmp" "$APP_DIR/.env"

echo "Service origins migrated:"
echo "  Portal: https://$portal_domain"
echo "  Admin:  https://$admin_domain"
echo "  API:    https://$api_domain"
echo "Previous .env: $backup"
