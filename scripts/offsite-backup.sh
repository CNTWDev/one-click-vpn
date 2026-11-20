#!/usr/bin/env sh
# Daily off-site backup: dumps PostgreSQL (kept in ./backups like any backup.sh dump), encrypts it together
# with .env and uploads it to the S3-compatible bucket set in .env (Aliyun OSS, Cloudflare R2, AWS S3...).
# Runs every night from the veilbird-backup.timer that one-click-update.sh installs; run it by hand any time:
#   sudo ./scripts/offsite-backup.sh          back up now
#   sudo ./scripts/offsite-backup.sh --list   show the backups in the bucket
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
. "$SCRIPT_DIR/common.sh"

cd "$APP_DIR"
umask 077

if ! offsite_configured; then
  echo "Off-site backup is not configured: set VEILBIRD_BACKUP_S3_* in .env (see README, Off-site backups)."
  exit 0
fi

if [ "${1:-}" = "--list" ]; then
  offsite_request list | offsite_node
  exit $?
fi

# An update recreates the Controller this script runs in: wait for a running one to finish (at most 1 hour).
if [ -z "${VEILBIRD_DEPLOY_LOCK_HELD:-}" ]; then
  waited=0
  while [ -d "$APP_DIR/.deploy.lock" ] && kill -0 "$(cat "$APP_DIR/.deploy.lock/pid" 2>/dev/null || echo 0)" 2>/dev/null; do
    [ "$waited" -lt 3600 ] || { echo "An update has been running for an hour; backing up anyway." >&2; break; }
    [ "$waited" -gt 0 ] || echo "Waiting for the running update to finish..."
    sleep 30
    waited=$((waited + 30))
  done
fi

output=$(mktemp)
trap 'rm -f "$output"' EXIT
if ! ./scripts/backup.sh ./backups > "$output" 2>&1; then
  cat "$output" >&2
  offsite_log error backup.offsite_failed "Off-site backup failed: the PostgreSQL dump did not complete."
  exit 1
fi
dump=$(sed -n 's/^PostgreSQL backup written to //p' "$output" | tail -n 1)
grep -v '^PostgreSQL backup written to ' "$output" | grep -v '^Reminder: encrypted fields' || true
[ -n "$dump" ] && [ -s "$dump" ] || { echo "backup.sh did not report a dump file." >&2; exit 1; }
echo "Database dump: $dump"

keep=$(backup_setting VEILBIRD_BACKUP_S3_KEEP)
case "$keep" in ''|*[!0-9]*) keep=30 ;; esac
created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
extra=",\"envBytes\":$(wc -c < .env | tr -d ' '),\"createdAt\":\"$created\",\"keep\":$keep,\"source\":$(json_string "$(hostname 2>/dev/null || echo server)"),\"dumpName\":$(json_string "$(basename "$dump")")"
{ offsite_request upload "$extra"; cat .env; cat "$dump"; } | offsite_node
