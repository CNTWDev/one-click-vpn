#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR="$SCRIPT_DIR"
no_cache="no"
service="all"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-cache) no_cache="yes"; shift ;;
    --service) service=${2:-}; shift 2 ;;
    -h|--help)
      echo "Usage: sudo ./one-click-update.sh [--service all|northstar|portal-web|admin-web] [--no-cache]"
      exit 0
      ;;
    *)
      echo "Usage: sudo ./one-click-update.sh [--service all|northstar|portal-web|admin-web] [--no-cache]" >&2
      exit 2
      ;;
  esac
done

cd "$APP_DIR"

./scripts/ensure-postgres-env.sh

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script with sudo so backup and Docker commands use production permissions." >&2
  exit 1
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Tracked working tree changes detected. Commit or stash them before automatic update:" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

case "$service" in
  all|northstar|controller)
    echo "Creating a database backup before pulling new code..."
    ./scripts/backup.sh ./backups
    ;;
  portal|portal-web|admin|admin-web)
    echo "Frontend-only update selected; skipping database backup."
    ;;
  *)
    echo "Unknown service: $service. Use all, northstar, portal-web, or admin-web." >&2
    exit 2
    ;;
esac

before=$(git rev-parse HEAD)
echo "Fetching latest code..."
git fetch origin
git pull --ff-only
after=$(git rev-parse HEAD)
short_before=$(printf '%s' "$before" | cut -c1-12)
short_after=$(printf '%s' "$after" | cut -c1-12)

if [ "$before" = "$after" ]; then
  echo "Already up to date at $short_after."
else
  echo "Updated from $short_before to $short_after."
fi

if [ "$no_cache" = "yes" ]; then
  sh ./scripts/deploy.sh --service "$service" --no-cache
else
  sh ./scripts/deploy.sh --service "$service"
fi
