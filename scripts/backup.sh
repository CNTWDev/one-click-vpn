#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
. "$SCRIPT_DIR/common.sh"

cd "$APP_DIR"
backup_dir=${1:-./backups}
mkdir -p "$backup_dir"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
compose exec -T db pg_dump -U northstar -d northstar -Fc > "$backup_dir/northstar-$timestamp.dump"
chmod 600 "$backup_dir/northstar-$timestamp.dump"
echo "PostgreSQL backup written to $backup_dir/northstar-$timestamp.dump"
