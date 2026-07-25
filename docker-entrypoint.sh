#!/bin/sh
set -eu

# Docker supplies HOSTNAME as the container id by default. Next standalone
# uses HOSTNAME as its bind address, so set it before any Node process starts.
HOSTNAME=0.0.0.0
PORT=3000
export HOSTNAME PORT

node /app/scripts/migrate.mjs
exec node /app/server.js
