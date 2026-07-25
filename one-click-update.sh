#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR="$SCRIPT_DIR"
no_cache="no"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-cache) no_cache="yes"; shift ;;
    -h|--help)
      echo "Usage: sudo ./one-click-update.sh [--no-cache]"
      exit 0
      ;;
    *)
      echo "Usage: sudo ./one-click-update.sh [--no-cache]" >&2
      exit 2
      ;;
  esac
done

cd "$APP_DIR"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script with sudo so backup and Docker commands use production permissions." >&2
  exit 1
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Tracked working tree changes detected. Commit or stash them before automatic update:" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

echo "Creating a database backup before pulling new code..."
./scripts/backup.sh ./backups

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
  ./scripts/deploy.sh --no-cache
else
  ./scripts/deploy.sh
fi
