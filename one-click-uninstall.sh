#!/usr/bin/env sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$PROJECT_DIR/scripts/common.sh"
# common.sh is normally sourced by files inside scripts/ and therefore derives
# its APP_DIR one level up. This entrypoint lives at the repository root, so
# restore the resolved project path after loading the shared Compose helper.
SCRIPT_DIR="$PROJECT_DIR"
APP_DIR="$PROJECT_DIR"

assume_yes="no"
create_backup="yes"
check_only="no"

usage() {
  cat <<'USAGE'
Usage: sudo ./one-click-uninstall.sh [--check] [--yes] [--no-backup]

Permanently removes this Northstar installation's containers, local images,
PostgreSQL/MinIO/Loki volumes, .env, environment backups, and local DB backups.

The source tree, host Nginx configuration, TLS certificates, and DNS are kept.
By default a recovery package is written beside the project directory first.

Options:
  --check      Validate the resolved project and Compose config; remove nothing
  --yes        Skip the typed confirmation (backup is still created by default)
  --no-backup  Do not create a recovery package; deleted data cannot be restored
  -h, --help   Show this help
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) check_only="yes"; shift ;;
    --yes) assume_yes="yes"; shift ;;
    --no-backup) create_backup="no"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script with sudo." >&2
  exit 1
fi

if [ ! -f "$APP_DIR/.env" ]; then
  echo "Missing $APP_DIR/.env; Docker Compose cannot safely resolve this installation." >&2
  echo "If the file was moved, restore it before running the uninstall script." >&2
  exit 1
fi

cd "$APP_DIR"

if [ "$check_only" = "yes" ]; then
  compose config --quiet
  echo "Northstar uninstall preflight passed."
  echo "Project: $APP_DIR"
  echo "Environment: $APP_DIR/.env"
  echo "No data was removed."
  exit 0
fi

portal_domain=$(env_value NORTHSTAR_PORTAL_DOMAIN)
admin_domain=$(env_value NORTHSTAR_ADMIN_DOMAIN)
api_domain=$(env_value NORTHSTAR_API_DOMAIN)
admin_email=$(env_value NORTHSTAR_ADMIN_EMAIL)
app_domain=$(env_value APP_DOMAIN)
[ -n "$portal_domain" ] || portal_domain=$app_domain
default_base_domain=$app_domain
case "$default_base_domain" in
  vpn.*|app.*|console.*|api.*) default_base_domain=${default_base_domain#*.} ;;
esac
[ -n "$admin_domain" ] || admin_domain="console.$default_base_domain"
[ -n "$api_domain" ] || api_domain="api.$default_base_domain"

echo ""
echo "Northstar destructive uninstall"
echo "Project: $APP_DIR"
echo ""
echo "This will permanently remove:"
echo "  - Northstar Controller, Portal, Admin, PostgreSQL, MinIO, and Loki containers"
echo "  - this Compose project's PostgreSQL, MinIO, and Loki volumes"
echo "  - locally built Northstar images"
echo "  - $APP_DIR/.env and .env.backup*"
echo "  - $APP_DIR/backups"
echo ""
echo "This will keep:"
echo "  - project source code"
echo "  - host Nginx configuration and TLS certificates"
echo "  - DNS records"
echo "  - Agent files on remote Edge Nodes"

if [ "$assume_yes" = "no" ]; then
  printf "Create a recovery package outside the project first? [Y/n]: "
  read -r backup_choice
  case "$backup_choice" in
    n|N|no|NO) create_backup="no" ;;
    *) create_backup="yes" ;;
  esac
  echo ""
  echo "Type DELETE NORTHSTAR to confirm permanent removal."
  printf "> "
  read -r confirmation
  if [ "$confirmation" != "DELETE NORTHSTAR" ]; then
    echo "Confirmation did not match; nothing was removed."
    exit 1
  fi
fi

recovery_dir=""
if [ "$create_backup" = "yes" ]; then
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  recovery_dir="$(dirname "$APP_DIR")/northstar-uninstall-backup-$timestamp"
  mkdir -m 700 "$recovery_dir"
  cp -p "$APP_DIR/.env" "$recovery_dir/.env"
  find "$APP_DIR" -maxdepth 1 -type f -name '.env.backup*' -exec cp -p {} "$recovery_dir/" \;
  if [ -d "$APP_DIR/backups" ]; then
    cp -Rp "$APP_DIR/backups" "$recovery_dir/previous-database-backups"
  fi

  echo "Creating a final PostgreSQL backup..."
  compose up -d db
  backup_ready="no"
  attempts=0
  while [ "$attempts" -lt 30 ]; do
    if compose exec -T db pg_isready -U northstar -d northstar >/dev/null 2>&1; then
      backup_ready="yes"
      break
    fi
    attempts=$((attempts + 1))
    sleep 2
  done
  if [ "$backup_ready" = "yes" ] && "$APP_DIR/scripts/backup.sh" "$recovery_dir"; then
    echo "Recovery package created at $recovery_dir"
  else
    echo "The final PostgreSQL backup failed." >&2
    if [ "$assume_yes" = "yes" ]; then
      echo "Uninstall aborted; no runtime data was removed." >&2
      exit 1
    fi
    printf "Continue uninstall using only the copied environment/older backups? [y/N]: "
    read -r continue_choice
    case "$continue_choice" in
      y|Y|yes|YES) : ;;
      *) echo "Uninstall aborted; no runtime data was removed."; exit 1 ;;
    esac
  fi
elif [ "$assume_yes" = "no" ]; then
  echo "No recovery package will be created."
fi

echo "Stopping Northstar and deleting project volumes..."
compose down --volumes --remove-orphans --rmi local

rm -f -- "$APP_DIR/.env"
find "$APP_DIR" -maxdepth 1 -type f -name '.env.backup*' -exec rm -f -- {} \;
if [ -d "$APP_DIR/backups" ]; then
  rm -rf -- "$APP_DIR/backups"
fi

base_domain=$portal_domain
case "$base_domain" in
  app.*) base_domain=${base_domain#*.} ;;
esac

echo ""
echo "Northstar runtime data and .env were removed successfully."
[ -n "$recovery_dir" ] && echo "Recovery package: $recovery_dir"
echo ""
echo "Reinstall with:"
echo "  cd $APP_DIR"
printf '  sudo ./scripts/one-click-deploy.sh \\\n'
printf '    --domain %s \\\n' "$base_domain"
printf '    --portal-domain %s \\\n' "$portal_domain"
printf '    --admin-domain %s \\\n' "$admin_domain"
printf '    --api-domain %s \\\n' "$api_domain"
printf '    --admin-email %s\n' "${admin_email:-owner@example.com}"
echo ""
echo "Remote Edge Agents are not removed. Re-add each node in Console and run Reinstall / repair."
