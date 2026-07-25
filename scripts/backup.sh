#!/usr/bin/env sh
set -eu

backup_dir=${1:-./backups}
mkdir -p "$backup_dir"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
docker compose exec -T northstar node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync('/app/data/northstar.sqlite'); db.exec(\"VACUUM INTO '/app/data/backup-$timestamp.sqlite'\"); db.close()"
docker compose cp "northstar:/app/data/backup-$timestamp.sqlite" "$backup_dir/northstar-$timestamp.sqlite"
docker compose exec -T northstar rm -f "/app/data/backup-$timestamp.sqlite"
echo "Backup written to $backup_dir/northstar-$timestamp.sqlite"
