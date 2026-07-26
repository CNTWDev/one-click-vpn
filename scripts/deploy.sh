#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
. "$SCRIPT_DIR/common.sh"

cd "$APP_DIR"
mode="deploy"
service="all"
service_explicit="no"
no_cache="no"
while [ "$#" -gt 0 ]; do
  case "$1" in
    deploy) mode="deploy"; shift ;;
    logs) mode="logs"; shift ;;
    ps|status) mode="ps"; shift ;;
    --service) service=${2:-}; service_explicit="yes"; shift 2 ;;
    --no-cache) no_cache="yes"; shift ;;
    -h|--help)
      echo "Usage: ./scripts/deploy.sh [deploy|logs|ps] [--service all|northstar|portal-web|admin-web] [--no-cache]"
      exit 0
      ;;
    *)
      echo "Usage: ./scripts/deploy.sh [deploy|logs|ps] [--service all|northstar|portal-web|admin-web] [--no-cache]" >&2
      exit 2
      ;;
  esac
done

case "$service" in
  all) ;;
  controller|northstar) service="northstar" ;;
  portal) service="portal-web" ;;
  admin) service="admin-web" ;;
  portal-web|admin-web) ;;
  *) echo "Unknown service: $service. Use all, northstar, portal-web, or admin-web." >&2; exit 2 ;;
esac

if [ "$mode" = "deploy" ] && [ "$service_explicit" = "no" ] && [ -t 0 ] && [ -t 1 ]; then
  echo ""
  echo "Northstar deployment wizard"
  echo "Choose what you want to update:"
  echo "  1) all         Controller + Portal + Admin (recommended for releases)"
  echo "  2) northstar   Controller/API only"
  echo "  3) portal-web  Portal only"
  echo "  4) admin-web   Admin only"
  printf "Select [1]: "
  read -r choice
  case "${choice:-1}" in
    1) service="all" ;;
    2) service="northstar" ;;
    3) service="portal-web" ;;
    4) service="admin-web" ;;
    *) echo "Invalid selection: $choice" >&2; exit 2 ;;
  esac
  echo "Selected service: $service"
fi

case "$mode" in
  logs)
    compose logs -f
    exit 0
    ;;
  ps)
    compose ps --all
    exit 0
    ;;
esac

"$SCRIPT_DIR/ensure-postgres-env.sh"
"$SCRIPT_DIR/check-env.sh"

export NORTHSTAR_BUILD_REV=$(git rev-parse --short HEAD)
echo "Deploying build $NORTHSTAR_BUILD_REV (service: $service)"

echo "Starting PostgreSQL and waiting for it to become healthy..."
compose up -d db

wait_for_healthy() {
  service_name=$1
  container_id=$(compose ps -q "$service_name")
  if [ -z "$container_id" ]; then
    echo "$service_name container was not created." >&2
    compose ps --all >&2
    compose logs --tail=120 "$service_name" >&2 || true
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
    echo "$service_name did not become healthy." >&2
    compose ps --all >&2
    docker inspect --format '{{range .State.Health.Log}}{{println .ExitCode .Output}}{{end}}' "$container_id" >&2 || true
    compose logs --tail=120 "$service_name" >&2 || true
    exit 1
  fi
}

wait_for_healthy db
echo "PostgreSQL is healthy. Preparing internal operational-log storage..."
compose up -d minio minio-init

minio_init_id=$(compose ps --all --quiet minio-init)
if [ -z "$minio_init_id" ]; then
  echo "MinIO initialization container was not created." >&2
  compose ps --all >&2
  compose logs --tail=160 minio minio-init >&2 || true
  exit 1
fi

minio_initialized=""
i=0
while [ "$i" -lt 65 ]; do
  minio_init_status=$(docker inspect --format '{{.State.Status}}:{{.State.ExitCode}}' "$minio_init_id" 2>/dev/null || true)
  if [ "$minio_init_status" = "exited:0" ]; then
    minio_initialized="yes"
    break
  fi
  case "$minio_init_status" in
    exited:*|dead:*) break ;;
  esac
  i=$((i + 1))
  sleep 2
done

if [ -z "$minio_initialized" ]; then
  echo "MinIO bucket initialization did not complete successfully." >&2
  compose ps --all >&2
  compose logs --tail=160 minio minio-init >&2 || true
  exit 1
fi

compose up -d loki

if [ "$service" = "all" ]; then
  build_targets="northstar portal-web admin-web"
  up_targets="northstar portal-web admin-web"
else
  build_targets="$service"
  up_targets="$service"
  if [ "$service" != "northstar" ]; then
    # A frontend needs a healthy Controller, but does not recreate it.
    compose up -d northstar
    wait_for_healthy northstar
  fi
fi

echo "Building: $build_targets"
if [ "$no_cache" = "yes" ]; then
  compose build --no-cache $build_targets
else
  compose build $build_targets
fi

echo "Starting: $up_targets"
if [ "$service" = "all" ]; then
  compose up -d --force-recreate --remove-orphans --no-deps $up_targets
else
  compose up -d --force-recreate --no-deps $up_targets
fi

if [ "$service" = "all" ]; then
  wait_for_healthy northstar
  wait_for_healthy portal-web
  wait_for_healthy admin-web
else
  wait_for_healthy "$service"
fi

if command -v curl >/dev/null 2>&1; then
  check_endpoint() {
    service_name=$1
    port=$2
    path=$3
    if ! curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:$port$path" >/dev/null 2>&1; then
      echo "Warning: $service_name failed its local health check at 127.0.0.1:$port$path." >&2
    fi
  }
  case "$service" in
    all)
      check_endpoint northstar 3000 /api/health
      check_endpoint portal-web 3100 /health
      check_endpoint admin-web 3200 /health
      ;;
    northstar) check_endpoint northstar 3000 /api/health ;;
    portal-web) check_endpoint portal-web 3100 /health ;;
    admin-web) check_endpoint admin-web 3200 /health ;;
  esac
fi

compose ps
echo "Northstar deployment is healthy (service: $service)."
echo "Controller: http://127.0.0.1:3000"
echo "Portal: http://127.0.0.1:3100"
echo "Admin: http://127.0.0.1:3200"
echo "Logs: ./scripts/deploy.sh logs"
