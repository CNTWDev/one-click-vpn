#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
. "$SCRIPT_DIR/common.sh"

cd "$APP_DIR"
umask 077
backup_dir=${1:-./backups}
mkdir -p "$backup_dir"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$backup_dir/northstar-$timestamp.dump"
tmp="$target.tmp"
trap 'rm -f "$tmp"' EXIT
compose exec -T db pg_dump -U northstar -d northstar -Fc > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$target"
trap - EXIT
echo "PostgreSQL backup written to $target"
echo "Reminder: encrypted fields need VEILBIRD_MASTER_KEY from .env, which is NOT in this dump. Back it up separately and securely." >&2
