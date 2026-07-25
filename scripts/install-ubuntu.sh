#!/usr/bin/env sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script as root on a new Ubuntu/Debian cloud VM." >&2
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl git openssl docker.io
if ! docker compose version >/dev/null 2>&1; then
  if ! apt-get install -y docker-compose-plugin; then
    echo "Docker Compose v2 plugin is unavailable from the configured apt repositories." >&2
    echo "Configure Docker's official apt repository, then install docker-compose-plugin." >&2
    echo "The legacy docker-compose v1 package is not supported." >&2
    exit 1
  fi
fi
systemctl enable --now docker
echo "Docker host prerequisites are ready."
echo "Run scripts/one-click-deploy.sh as root for first deployment, or add your deploy user to the docker group and run it again after re-login."
