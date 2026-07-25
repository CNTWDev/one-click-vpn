#!/bin/sh
set -eu

# Docker supplies HOSTNAME as the container id by default. Next standalone
# uses HOSTNAME as its bind address, so set it before any Node process starts.
HOSTNAME=0.0.0.0
PORT=3000
export HOSTNAME PORT

if ! test -w "$(dirname "${NORTHSTAR_DATABASE_PATH:-/app/data/northstar.sqlite}")"; then
  echo "Northstar data directory is not writable by the runtime user." >&2
  echo "Run scripts/repair-data-volume.sh from the controller host." >&2
  exit 1
fi

node /app/scripts/migrate.mjs
exec node /app/server.js
