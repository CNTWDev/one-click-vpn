#!/usr/bin/env sh
# Restore drill: proves the newest off-site backup can really be restored, without touching production.
# Downloads and decrypts it, restores it into a throwaway PostgreSQL container (no network, removed afterwards)
# and compares it with the live database. Runs weekly from veilbird-backup-drill.timer; by hand:
#   sudo ./scripts/backup-drill.sh [veilbird-YYYYmmddTHHMMSSZ.vbk]
# Fails when the backup cannot be decrypted or restored, has no users, or is older than 36 hours.
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

name=${1:-latest}
# Beside the other dumps, not in /tmp (often a small tmpfs).
mkdir -p ./backups
work=$(mktemp -d ./backups/.drill.XXXXXX)
container="veilbird-restore-drill-$$"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "Restore drill FAILED: $1" >&2
  offsite_log error backup.drill_failed "Restore drill failed: $1"
  exit 1
}

started=$(date +%s)
echo "Downloading and decrypting the off-site backup ($name)..."
if ! offsite_request get ",\"name\":$(json_string "$name"),\"part\":\"dump\"" | offsite_node > "$work/backup.dump" 2> "$work/get.log"; then
  cat "$work/get.log" >&2
  fail "$(tail -n 1 "$work/get.log")"
fi
info=$(grep '^BACKUP ' "$work/get.log" | tail -n 1)
backup_name=$(printf '%s' "$info" | awk '{print $2}')
age=$(printf '%s' "$info" | sed -n 's/.*age_hours=\([0-9.]*\).*/\1/p')
echo "Backup: $backup_name, $age hours old, $(wc -c < "$work/backup.dump" | tr -d ' ') bytes"

# The .env inside the backup must carry the master key that encrypted fields in the dump need.
offsite_request get ",\"name\":$(json_string "$backup_name"),\"part\":\"env\"" | offsite_node > "$work/backup.env" 2>/dev/null ||
  fail "could not read the .env stored in $backup_name"
backup_key=$(awk -F= '$1 == "VEILBIRD_MASTER_KEY" { sub(/^[^=]*=/, ""); print; exit }' "$work/backup.env")
key_note="same master key as this server"
if [ -z "$backup_key" ]; then
  fail "$backup_name has no VEILBIRD_MASTER_KEY in its .env copy"
elif [ "$backup_key" != "$(env_value VEILBIRD_MASTER_KEY)" ]; then
  key_note="WARNING: master key differs from this server's .env"
fi

image=$(docker inspect -f '{{.Config.Image}}' "$(compose ps -q db)" 2>/dev/null || true)
[ -n "$image" ] || image=postgres:17-alpine
echo "Restoring into a throwaway $image container..."
docker run -d --name "$container" --network none \
  -e POSTGRES_USER=northstar -e POSTGRES_DB=northstar -e POSTGRES_PASSWORD=drill "$image" >/dev/null ||
  fail "could not start a temporary PostgreSQL container"
# During first start PostgreSQL initialises on a socket only, then restarts listening on TCP: wait for that.
ready=no
for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U northstar -d northstar >/dev/null 2>&1; then ready=yes; break; fi
  sleep 1
done
[ "$ready" = yes ] || fail "the temporary PostgreSQL did not start"
if ! docker exec -i "$container" pg_restore --no-owner --no-privileges --exit-on-error \
  -U northstar -d northstar < "$work/backup.dump" 2> "$work/restore.log"; then
  cat "$work/restore.log" >&2
  fail "pg_restore of $backup_name failed: $(tail -n 1 "$work/restore.log")"
fi

# Row counts of every table, as "table count" lines.
count_sql="SELECT table_name, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1"
docker exec "$container" psql -U northstar -d northstar -AtF ' ' -c "$count_sql" > "$work/restored.txt" ||
  fail "could not read the restored tables"
compose exec -T db psql -U northstar -d northstar -AtF ' ' -c "$count_sql" > "$work/live.txt" 2>/dev/null || : > "$work/live.txt"

count() { awk -v t="$2" '$1 == t { print $2; found = 1 } END { if (!found) print "-" }' "$1"; }
printf '%-22s %10s %10s\n' table backup live
for table in users nodes devices access_grants native_sessions protocol_credentials; do
  printf '%-22s %10s %10s\n' "$table" "$(count "$work/restored.txt" "$table")" "$(count "$work/live.txt" "$table")"
done
tables=$(wc -l < "$work/restored.txt" | tr -d ' ')
missing=""
if [ -s "$work/live.txt" ]; then
  missing=$(awk 'NR == FNR { have[$1] = 1; next } !($1 in have) { printf "%s ", $1 }' "$work/restored.txt" "$work/live.txt")
fi
[ -z "$missing" ] || echo "Tables added since this backup (created again by migrations on restore): $missing"

users=$(count "$work/restored.txt" users)
case "$users" in ''|-|0) fail "$backup_name restored, but it has no users" ;; esac
max_age=${VEILBIRD_BACKUP_MAX_AGE_HOURS:-36}
if [ "$name" = latest ] && awk -v a="$age" -v m="$max_age" 'BEGIN { exit !(a > m) }'; then
  fail "the newest off-site backup $backup_name is $age hours old (more than $max_age): daily backups are not arriving"
fi

seconds=$(( $(date +%s) - started ))
message="Restore drill passed: $backup_name ($age h old) restored into a throwaway database in ${seconds} s, $tables tables, $users users; $key_note."
echo "$message"
if [ "$key_note" = "same master key as this server" ]; then
  offsite_log info backup.drill_passed "$message"
else
  offsite_log warning backup.drill_passed "$message"
fi
