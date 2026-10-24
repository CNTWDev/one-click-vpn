#!/usr/bin/env sh
# Frees disk left behind by rebuilds: every deploy builds new images, which leaves the previous
# ones untagged ("<none>") and grows the build cache. Running containers are never touched.
# Set VEILBIRD_DOCKER_PRUNE=no in .env to skip.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
. "$SCRIPT_DIR/common.sh"

setting=${VEILBIRD_DOCKER_PRUNE:-$(env_value VEILBIRD_DOCKER_PRUNE 2>/dev/null || true)}
case "${setting:-yes}" in
  no|false|0|off) echo "Docker cleanup skipped (VEILBIRD_DOCKER_PRUNE=$setting)."; exit 0 ;;
esac

echo "Cleaning up old Docker images and build cache..."
# Dangling images only: untagged leftovers that no container (running or stopped) uses.
docker image prune -f >/dev/null 2>&1 || echo "Warning: could not prune old images." >&2
# Keep a week of build cache so the next update still builds quickly.
docker builder prune -f --filter until=168h >/dev/null 2>&1 || echo "Warning: could not prune build cache." >&2
docker system df 2>/dev/null || true
