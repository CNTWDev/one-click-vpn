#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    legacy_version=$(docker-compose version --short 2>/dev/null || true)
    case "$legacy_version" in
      1.*)
        echo "Docker Compose v1 ($legacy_version) is not supported. Install the Docker Compose v2 plugin and use: docker compose" >&2
        return 1
        ;;
      *)
        docker-compose "$@"
        ;;
    esac
  else
    echo "Docker Compose is required (docker compose or docker-compose)." >&2
    return 1
  fi
}

env_value() {
  key=$1
  awk -F= -v wanted="$key" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' "$APP_DIR/.env"
}
