#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$SCRIPT_DIR/docker-compose.yml" ] && [ -d "$SCRIPT_DIR/scripts" ]; then
  APP_DIR="$SCRIPT_DIR"
elif [ -f "$(pwd)/docker-compose.yml" ] && [ -d "$(pwd)/scripts" ]; then
  APP_DIR=$(pwd)
else
  echo "Cannot locate the one-click-vpn project directory." >&2
  echo "Run this script from the repository root or place it in the repository root." >&2
  exit 1
fi
. "$APP_DIR/scripts/common.sh"

backup="yes"
assume_yes="no"

usage() {
  cat <<'USAGE'
Usage: sudo ./one-click-rebuild.sh [--yes] [--skip-backup]

Stop and remove the Northstar Compose containers and service image, then
rebuild the service from scratch and run the health check.

Options:
  --yes            Skip the confirmation prompt.
  --skip-backup   Do not create a database backup first (use only if the
                  current container cannot be started).
  -h, --help      Show this help.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes) assume_yes="yes"; shift ;;
    --skip-backup) backup="no"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script with sudo." >&2
  exit 1
fi

cd "$APP_DIR"

if [ ! -f .env ]; then
  echo "Missing $APP_DIR/.env; refusing to rebuild without production configuration." >&2
  exit 1
fi

"$APP_DIR/scripts/check-env.sh"

if [ "$assume_yes" != "yes" ]; then
  echo "This will remove the Northstar Compose containers and service image."
  echo "It will NOT remove .env or the northstar-data volume."
  printf 'Type REBUILD to continue: '
  read -r confirmation
  if [ "$confirmation" != "REBUILD" ]; then
    echo "Cancelled."
    exit 1
  fi
fi

if [ "$backup" = "yes" ]; then
  echo "Creating a database backup before cleanup..."
  "$APP_DIR/scripts/backup.sh" "$APP_DIR/backups"
else
  echo "WARNING: database backup skipped by request." >&2
fi

old_images=$(compose images -q northstar 2>/dev/null | sort -u || true)
echo "Stopping Northstar containers..."
compose down --remove-orphans

if [ -n "$old_images" ]; then
  echo "Removing old Northstar service image(s)..."
  for image in $old_images; do
    docker image rm -f "$image" >/dev/null 2>&1 || echo "Could not remove image $image; continuing." >&2
  done
fi

echo "Building a fresh image and starting Northstar..."
"$APP_DIR/scripts/deploy.sh" --no-cache
