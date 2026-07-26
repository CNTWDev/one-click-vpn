#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
. "$SCRIPT_DIR/common.sh"

if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "Usage: ./scripts/restore-postgres.sh ./backups/northstar-YYYYmmddTHHMMSSZ.dump" >&2
  exit 2
fi

cd "$APP_DIR"
"$SCRIPT_DIR/check-env.sh"
echo "This will replace the current PostgreSQL schema and data with: $1"
printf 'Type RESTORE to continue: '
read -r confirmation
if [ "$confirmation" != "RESTORE" ]; then
  echo "Cancelled."
  exit 1
fi

compose exec -T db pg_restore \
  --clean --if-exists --no-owner --no-privileges \
  -U northstar -d northstar < "$1"
echo "PostgreSQL restore completed."
