#!/usr/bin/env sh
# Host Nginx request limits for this deployment's hostnames only (Portal, Console, API, Agent).
# Floods are answered with 429 by Nginx before they reach the containers. Other sites on the same
# Nginx (BaoTa panels often host several) are untouched: their requests get an empty limit key.
# Safe to re-run; deploy.sh runs it after every healthy deploy. VEILBIRD_NGINX_LIMITS=no skips it.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

config_dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --nginx-config-dir) config_dir=${2:-}; shift 2 ;;
    -h|--help) echo "Usage: sudo sh scripts/setup-nginx-limits.sh [--nginx-config-dir DIR]"; exit 0 ;;
    *) echo "Usage: sudo sh scripts/setup-nginx-limits.sh [--nginx-config-dir DIR]" >&2; exit 2 ;;
  esac
done

if [ "${VEILBIRD_NGINX_LIMITS:-}" = "no" ] || { [ -f "$APP_DIR/.env" ] && [ "$(env_value VEILBIRD_NGINX_LIMITS)" = "no" ]; }; then
  echo "Nginx request limits: skipped (VEILBIRD_NGINX_LIMITS=no)."; exit 0
fi
if [ "$(id -u)" -ne 0 ]; then echo "Nginx request limits: skipped (run as root to manage Nginx)."; exit 0; fi
nginx_bin=$(command -v nginx 2>/dev/null || true)
[ -n "$nginx_bin" ] || [ ! -x /www/server/nginx/sbin/nginx ] || nginx_bin=/www/server/nginx/sbin/nginx
if [ -z "$nginx_bin" ]; then echo "Nginx request limits: skipped (nginx not found)."; exit 0; fi

active=$(mktemp)
trap 'rm -f "$active"' EXIT
if ! "$nginx_bin" -T >"$active" 2>/dev/null; then
  echo "Nginx request limits: skipped (current Nginx configuration does not pass nginx -t)." >&2; exit 0
fi
included() { awk -v wanted="$1/*.conf;" '$1=="include" && $2==wanted {found=1} END {exit !found}' "$active"; }
if [ -z "$config_dir" ]; then
  # BaoTa's vhost directory and the stock conf.d are both included inside the http block.
  for candidate in /www/server/panel/vhost/nginx /etc/nginx/conf.d; do
    if [ -d "$candidate" ] && included "$candidate"; then config_dir=$candidate; break; fi
  done
fi
if [ -z "$config_dir" ] || ! included "$config_dir"; then
  echo "Nginx request limits: skipped (no included http config directory found; pass --nginx-config-dir)." >&2; exit 0
fi

# Hostnames: .env, then every site and the Agent domain from the database (sites added in Console).
hosts=$(mktemp)
trap 'rm -f "$active" "$hosts"' EXIT
for key in VEILBIRD_PORTAL_DOMAIN VEILBIRD_ADMIN_DOMAIN VEILBIRD_API_DOMAIN; do
  [ ! -f "$APP_DIR/.env" ] || env_value "$key" >>"$hosts"
done
compose exec -T db psql -U northstar -d northstar -Atc \
  "SELECT portal_domain FROM sites UNION SELECT console_domain FROM sites UNION SELECT api_domain FROM sites UNION SELECT agent_domain FROM controller_settings" \
  >>"$hosts" 2>/dev/null || echo "Nginx request limits: database not reachable; using .env hostnames only." >&2
host_lines=$(tr 'A-Z' 'a-z' <"$hosts" | tr -d '\r' | sed 's#^https\?://##; s#[/:].*$##' | grep -E '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' | grep -v 'example\.com$' | sort -u || true)
if [ -z "$host_lines" ]; then echo "Nginx request limits: skipped (no hostnames configured yet)."; exit 0; fi

target="$config_dir/veilbird-limits.conf"
backup=""
if [ -f "$target" ]; then backup=$(mktemp); cp "$target" "$backup"; fi
{
  echo "# Managed by TrackNothing scripts/setup-nginx-limits.sh (rewritten on every deploy; edit the script, not this file)."
  echo "map \$host \$veilbird_site {"
  echo "    hostnames;"
  echo "    default 0;"
  printf '%s\n' "$host_lines" | sed 's/^/    /; s/$/ 1;/'
  echo "}"
  cat <<'EOF'
map $uri $veilbird_auth_path {
    default 0;
    ~^/api/(auth/login|v1/auth/(login|web-login|register|password-reset(/confirm)?)|v2/native/login)$ 1;
}
map $veilbird_site $veilbird_limit_ip { default ""; 1 $binary_remote_addr; }
map "$veilbird_site$veilbird_auth_path" $veilbird_limit_auth { default ""; 11 $binary_remote_addr; }
limit_req_zone $veilbird_limit_ip zone=veilbird_ip:10m rate=20r/s;
limit_req_zone $veilbird_limit_auth zone=veilbird_auth:10m rate=10r/m;
limit_conn_zone $veilbird_limit_ip zone=veilbird_conn:10m;
# An empty key is never limited, so these only apply to the hostnames above.
limit_req zone=veilbird_ip burst=40 nodelay;
limit_req zone=veilbird_auth burst=5 nodelay;
limit_conn veilbird_conn 30;
limit_req_status 429;
limit_conn_status 429;
EOF
} >"$target"

if check=$("$nginx_bin" -t 2>&1) && "$nginx_bin" -s reload; then
  rm -f "$backup"
  echo "Nginx request limits active for: $(printf '%s' "$host_lines" | tr '\n' ' ') ($target)"
else
  # Leave Nginx exactly as it was: a limits file must never take the websites down.
  if [ -n "$backup" ]; then mv "$backup" "$target"; else rm -f "$target"; fi
  echo "Warning: Nginx rejected the request limits; previous configuration restored:" >&2
  printf '%s\n' "$check" | grep -E 'emerg|error' >&2 || true
fi
