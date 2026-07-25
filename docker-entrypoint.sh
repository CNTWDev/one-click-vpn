#!/bin/sh
set -eu
node /app/scripts/migrate.mjs
HOSTNAME=0.0.0.0
export HOSTNAME
exec node /app/server.js
