#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
. "$SCRIPT_DIR/common.sh"

cd "$APP_DIR"
case "${1:-deploy}" in
  logs)
    compose logs -f
    exit 0
    ;;
  ps|status)
    compose ps
    exit 0
    ;;
  deploy)
    ;;
  *)
    echo "Usage: ./scripts/deploy.sh [deploy|logs|ps]" >&2
    exit 2
    ;;
esac

"$SCRIPT_DIR/check-env.sh"

echo "Building and starting Northstar..."
compose up -d --build --remove-orphans

container_id=$(compose ps -q northstar)
if [ -z "$container_id" ]; then
  echo "Northstar container was not created." >&2
  compose ps
  exit 1
fi

healthy=""
i=0
while [ "$i" -lt 60 ]; do
  status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)
  if [ "$status" = "healthy" ]; then
    healthy="yes"
    break
  fi
  if [ "$status" = "unhealthy" ] || [ "$status" = "exited" ]; then
    break
  fi
  i=$((i + 1))
  sleep 2
done

if [ -z "$healthy" ]; then
  echo "Northstar did not become healthy." >&2
  compose ps
  compose logs --tail=120 northstar >&2 || true
  exit 1
fi

origin=$(env_value NORTHSTAR_PUBLIC_ORIGIN)
if command -v curl >/dev/null 2>&1; then
  public_ok=""
  i=0
  while [ "$i" -lt 10 ]; do
    if curl --fail --silent --show-error --max-time 10 "$origin/api/health" >/dev/null 2>&1; then
      public_ok="yes"
      break
    fi
    i=$((i + 1))
    sleep 2
  done
  if [ -z "$public_ok" ]; then
    echo "Warning: internal health is ready, but $origin/api/health is not reachable yet." >&2
    echo "Check DNS, cloud firewall ports 80/443, and Caddy logs with: ./scripts/deploy.sh logs" >&2
  fi
fi

compose ps
echo "Northstar deployment is healthy."
echo "Logs: ./scripts/deploy.sh logs"
