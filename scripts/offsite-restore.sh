#!/usr/bin/env sh
# Restores the control-plane database from an off-site backup, e.g. onto a new server after the old one was lost:
#   1. Install the new server as usual (scripts/one-click-deploy.sh), then add the same VEILBIRD_BACKUP_S3_*
#      settings to .env.
#   2. sudo ./scripts/offsite-restore.sh            (newest backup; --list shows all, or name one)
# It asks for the backup password when this server's key cannot open it: the VEILBIRD_BACKUP_PASSPHRASE, or else
# the VEILBIRD_MASTER_KEY, of the server that made the backup. Encrypted fields (node SSH logins, keys) need the
# old master key, so it offers to put that key into .env, then restores with scripts/restore-postgres.sh.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
. "$SCRIPT_DIR/common.sh"

cd "$APP_DIR"
umask 077

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script with sudo." >&2
  exit 1
fi
if ! offsite_configured; then
  echo "Set VEILBIRD_BACKUP_S3_ENDPOINT, _BUCKET, _ACCESS_KEY_ID and _SECRET_ACCESS_KEY in .env first." >&2
  exit 1
fi
if [ "${1:-}" = "--list" ]; then
  offsite_request list | offsite_node
  exit $?
fi

name=${1:-latest}
mkdir -p ./backups
fetch() { # part, output file
  offsite_request get ",\"name\":$(json_string "$name"),\"part\":\"$1\"" | offsite_node > "$2" 2> ./backups/.offsite-get.log
}

status=0
fetch dump ./backups/.offsite-restore.dump || status=$?
if [ "$status" -eq 3 ]; then
  echo "This server's key cannot open the backup."
  printf 'Backup password (VEILBIRD_BACKUP_PASSPHRASE or VEILBIRD_MASTER_KEY of the old server): '
  stty -echo 2>/dev/null || true
  read -r OFFSITE_PASSPHRASE
  stty echo 2>/dev/null || true
  echo
  export OFFSITE_PASSPHRASE
  status=0
  fetch dump ./backups/.offsite-restore.dump || status=$?
fi
if [ "$status" -ne 0 ]; then
  cat ./backups/.offsite-get.log >&2
  rm -f ./backups/.offsite-restore.dump ./backups/.offsite-get.log
  exit 1
fi
backup_name=$(awk '/^BACKUP / { print $2 }' ./backups/.offsite-get.log | tail -n 1)
grep '^BACKUP ' ./backups/.offsite-get.log | tail -n 1
base=./backups/offsite-${backup_name%.vbk}
mv ./backups/.offsite-restore.dump "$base.dump"
name=$backup_name
fetch env "$base.env"
rm -f ./backups/.offsite-get.log
chmod 600 "$base.dump" "$base.env"
echo "Downloaded $base.dump and the .env it was made with ($base.env)."

old_key=$(awk -F= '$1 == "VEILBIRD_MASTER_KEY" { sub(/^[^=]*=/, ""); print; exit }' "$base.env")
key_changed=no
if [ -n "$old_key" ] && [ "$old_key" != "$(env_value VEILBIRD_MASTER_KEY)" ]; then
  echo ""
  echo "The backup was made with a different VEILBIRD_MASTER_KEY. Without it, encrypted data in the database"
  echo "(node SSH logins, keys) cannot be read. Other settings from the old .env are in $base.env."
  printf 'Type KEY to use the old master key in .env (the current .env is backed up first), anything else to keep it: '
  read -r answer
  if [ "$answer" = "KEY" ]; then
    cp .env ".env.backup.$(date -u +%Y%m%dT%H%M%SZ)"
    awk -v key="$old_key" 'BEGIN { done = 0 } /^VEILBIRD_MASTER_KEY=/ { print "VEILBIRD_MASTER_KEY=" key; done = 1; next } { print } END { if (!done) print "VEILBIRD_MASTER_KEY=" key }' .env > .env.tmp
    chmod 600 .env.tmp
    mv .env.tmp .env
    key_changed=yes
    echo "VEILBIRD_MASTER_KEY updated in .env."
  fi
fi

./scripts/restore-postgres.sh "$base.dump"
if [ "$key_changed" = yes ]; then
  echo "Recreating the backend so it uses the restored master key..."
  compose up -d --no-deps --force-recreate veilbird
fi
echo "Off-site restore finished. Check the Console (nodes, users) before sending traffic to this server."
