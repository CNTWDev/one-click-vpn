#!/bin/sh
set -eu

# Docker supplies HOSTNAME as the container id by default. Next standalone
# uses HOSTNAME as its bind address, so set it before any Node process starts.
HOSTNAME=0.0.0.0
PORT=3000
export HOSTNAME PORT

# Deployments created before the Veilbird rename may still pass NORTHSTAR_* settings.
# Accept them under the new names unless the VEILBIRD_* value is already set.
eval "$(env | sed -n 's/^NORTHSTAR_\([A-Z0-9_]*\)=.*/\1/p' | while read -r name; do
  printf '[ -n "${VEILBIRD_%s+x}" ] || export VEILBIRD_%s="$NORTHSTAR_%s"\n' "$name" "$name" "$name"
done)"

node /app/scripts/migrate.mjs
exec node /app/server.js
