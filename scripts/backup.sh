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

# Every update writes a dump, so keep only the newest ones. VEILBIRD_BACKUP_KEEP=0 keeps all.
keep=${VEILBIRD_BACKUP_KEEP:-$(env_value VEILBIRD_BACKUP_KEEP 2>/dev/null || true)}
keep=${keep:-10}
case "$keep" in
  ''|*[!0-9]*) echo "Ignoring invalid VEILBIRD_BACKUP_KEEP=$keep; keeping 10 backups." >&2; keep=10 ;;
esac
# Leftovers from a dump that was interrupted before the trap could run.
find "$backup_dir" -maxdepth 1 -type f -name 'northstar-*.dump.tmp' -mmin +60 -exec rm -f {} + 2>/dev/null || true
if [ "$keep" -gt 0 ]; then
  # Timestamped names sort chronologically, so the newest come first in reverse order.
  find "$backup_dir" -maxdepth 1 -type f -name 'northstar-*.dump' | sort -r | tail -n +"$((keep + 1))" |
    while IFS= read -r old; do
      rm -f "$old" && echo "Removed old backup $(basename "$old")"
    done
fi
echo "Reminder: encrypted fields need VEILBIRD_MASTER_KEY from .env, which is NOT in this dump. Back it up separately and securely." >&2
