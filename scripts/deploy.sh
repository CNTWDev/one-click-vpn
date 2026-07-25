#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
. "$SCRIPT_DIR/common.sh"

cd "$APP_DIR"
mode="deploy"
no_cache="no"
while [ "$#" -gt 0 ]; do
  case "$1" in
    deploy) mode="deploy"; shift ;;
    logs) mode="logs"; shift ;;
    ps|status) mode="ps"; shift ;;
    --no-cache) no_cache="yes"; shift ;;
    -h|--help)
      echo "Usage: ./scripts/deploy.sh [deploy|logs|ps] [--no-cache]"
      exit 0
      ;;
    *)
      echo "Usage: ./scripts/deploy.sh [deploy|logs|ps] [--no-cache]" >&2
      exit 2
      ;;
  esac
done

case "$mode" in
  logs)
    compose logs -f
    exit 0
    ;;
  ps)
    compose ps
    exit 0
    ;;
esac

"$SCRIPT_DIR/check-env.sh"

echo "Building and starting Northstar..."
if [ "$no_cache" = "yes" ]; then
  echo "Docker build cache disabled."
  compose build --no-cache northstar
else
  compose build northstar
fi
compose up -d --force-recreate --remove-orphans

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
  echo "Runtime binding environment:" >&2
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" 2>/dev/null | awk '/^(HOSTNAME|PORT)=/' >&2 || true
  echo "Health-check output:" >&2
  docker inspect --format '{{range .State.Health.Log}}{{println .ExitCode .Output}}{{end}}' "$container_id" >&2 || true
  compose logs --tail=120 northstar >&2 || true
  exit 1
fi

if command -v curl >/dev/null 2>&1; then
  local_ok=""
  if curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    local_ok="yes"
  fi
  if [ -z "$local_ok" ]; then
    echo "Warning: the container health check passed, but the host-local controller check failed." >&2
    echo "Check the Northstar logs with: ./scripts/deploy.sh logs" >&2
  fi
fi

compose ps
echo "Northstar deployment is healthy."
echo "Controller: http://127.0.0.1:3000"
echo "Configure host Nginx to proxy your HTTPS domain to 127.0.0.1:3000."
echo "Logs: ./scripts/deploy.sh logs"
