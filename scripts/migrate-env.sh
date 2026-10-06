#!/usr/bin/env sh
# Renames NORTHSTAR_* settings in .env to VEILBIRD_* (product rename). Idempotent; keeps a backup.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENV_FILE=${1:-"$SCRIPT_DIR/../.env"}

[ -f "$ENV_FILE" ] || exit 0
grep -q '^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}NORTHSTAR_' "$ENV_FILE" || exit 0

backup="$ENV_FILE.before-veilbird"
[ -e "$backup" ] || cp -p "$ENV_FILE" "$backup"
tmp="$ENV_FILE.tmp.$$"
# A VEILBIRD_ line that already exists wins; the old duplicate is dropped.
awk '
  { line = $0; key = line; sub(/^[ \t]*(export[ \t]+)?/, "", key); sub(/=.*/, "", key) }
  key ~ /^VEILBIRD_/ { seen[key] = 1 }
  { lines[NR] = line; keys[NR] = key }
  END {
    for (i = 1; i <= NR; i++) {
      if (keys[i] ~ /^NORTHSTAR_/) {
        renamed = keys[i]; sub(/^NORTHSTAR_/, "VEILBIRD_", renamed)
        if (renamed in seen) continue
        sub(/NORTHSTAR_/, "VEILBIRD_", lines[i])
      }
      print lines[i]
    }
  }' "$ENV_FILE" > "$tmp"
cat "$tmp" > "$ENV_FILE"
rm -f "$tmp"
echo "Renamed NORTHSTAR_* settings in $(basename "$ENV_FILE") to VEILBIRD_* (backup: $(basename "$backup"))."
