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
image_tag=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    deploy) mode="deploy"; shift ;;
    logs) mode="logs"; shift ;;
    ps|status) mode="ps"; shift ;;
    --service) service=${2:-}; service_explicit="yes"; shift 2 ;;
    --no-cache) no_cache="yes"; shift ;;
    --tag) image_tag=${2:-}; shift 2 ;;
    -h|--help)
      echo "Usage: ./scripts/deploy.sh [deploy|logs|ps] [--service all|backend,portal,console,static] [--no-cache] [--tag <commit>]"
      echo "  --tag  run the registry images of an earlier commit (rollback); needs VEILBIRD_IMAGE_PREFIX in .env"
      exit 0
      ;;
    *)
      echo "Usage: ./scripts/deploy.sh [deploy|logs|ps] [--service all|backend,portal,console,static] [--no-cache] [--tag <commit>]" >&2
      exit 2
      ;;
  esac
done

usage_services="all, or a comma list of: backend, portal, console, static"
if [ "$mode" = "deploy" ] && [ "$service_explicit" = "no" ] && [ -t 0 ] && [ -t 1 ]; then
  echo ""
  echo "TrackNothing deployment wizard"
  echo "Choose what you want to update:"
  echo "  1) all       Backend + Portal + Console + static site (recommended for releases)"
  echo "  2) backend   Controller/API only"
  echo "  3) portal    Portal only"
  echo "  4) console   Console only"
  printf "Select [1]: "
  read -r choice
  case "${choice:-1}" in
    1) service="all" ;;
    2) service="veilbird" ;;
    3) service="portal-web" ;;
    4) service="admin-web" ;;
    *) echo "Invalid selection: $choice" >&2; exit 2 ;;
  esac
fi

# --service takes "all" or a comma-separated list; it becomes the space-separated list of Compose services.
targets=""
for name in $(printf '%s' "$service" | tr ',' ' '); do
  normalized=$(normalize_service "$name")
  case "$normalized" in
    all) targets="$ALL_SERVICES" ;;
    ""|agent) echo "Unknown service: $name. Use $usage_services." >&2; exit 2 ;;
    *) case " $targets " in *" $normalized "*) ;; *) targets="$targets $normalized" ;; esac ;;
  esac
done
targets=$(echo $targets)
[ -n "$targets" ] || { echo "No service selected. Use $usage_services." >&2; exit 2; }
includes() { case " $targets " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

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

acquire_deploy_lock
"$SCRIPT_DIR/ensure-postgres-env.sh"
"$SCRIPT_DIR/ensure-service-origins.sh"
"$SCRIPT_DIR/check-env.sh"

export VEILBIRD_BUILD_REV=$(git rev-parse --short HEAD)
# Images: pulled from the registry CI pushes to (.github/workflows/server-images.yml) when VEILBIRD_IMAGE_PREFIX
# is set in .env, tagged with the commit; built here otherwise, or when the registry does not have this commit
# yet (CI still running) or cannot be reached.
image_prefix=$(env_value VEILBIRD_IMAGE_PREFIX)
if [ -n "$image_tag" ] && [ -z "$image_prefix" ]; then
  echo "Error: --tag needs VEILBIRD_IMAGE_PREFIX in .env (see README: server images)." >&2
  exit 2
fi
if [ -n "$image_prefix" ] && [ "$no_cache" = "no" ]; then
  export VEILBIRD_IMAGE_TAG=${image_tag:-$(git rev-parse --short=12 HEAD)}
  [ -z "$image_tag" ] || VEILBIRD_BUILD_REV=$(printf '%.7s' "$image_tag")
else
  export VEILBIRD_IMAGE_TAG=local
fi
# A changed Loki config is a bind mount Compose cannot see; its checksum makes "up -d loki" recreate it.
export VEILBIRD_LOKI_CONFIG_SHA=$(cksum < deploy/loki/loki.yml | cut -d ' ' -f 1)
echo "Deploying build $VEILBIRD_BUILD_REV: $targets"

echo "Starting PostgreSQL and waiting for it to become healthy..."
compose up -d db

wait_for_healthy() {
  service_name=$1
  container_id=$(compose ps -q "$service_name")
  if [ -z "$container_id" ]; then
    echo "$service_name container was not created." >&2
    compose ps --all >&2
    compose logs --tail=120 "$service_name" >&2 || true
    return 1
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
    return 1
  fi
}

wait_for_healthy db || exit 1
echo "PostgreSQL is healthy."

# Operational logs used to sit in a bundled MinIO; Loki now keeps them on its own volume (under /loki/fs,
# so the old MinIO-era index is never read). Stop the old containers; their data volume is left in place.
old_log_store=$(docker ps -aq --filter "label=com.docker.compose.project.working_dir=$APP_DIR" --filter "label=com.docker.compose.service=minio"
  docker ps -aq --filter "label=com.docker.compose.project.working_dir=$APP_DIR" --filter "label=com.docker.compose.service=minio-init")
if [ -n "$old_log_store" ]; then
  minio_volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' $old_log_store | grep . | head -n 1 || true)
  docker stop $old_log_store >/dev/null || true
  docker container rm $old_log_store >/dev/null || true
  echo "Operational logs now use Loki's own storage; runtime logs start fresh from this deploy."
  [ -z "$minio_volume" ] || echo "The old log volume is no longer used. To free its space: docker volume rm $minio_volume"
fi
compose up -d loki

if ! includes veilbird; then
  # A frontend needs a running Controller but must not touch it: "compose up veilbird" would recreate it
  # (its image tag and build revision change with every commit) and upgrade it without a backup.
  backend_id=$(compose ps -q veilbird 2>/dev/null || true)
  if [ -z "$backend_id" ]; then
    echo "The backend is not deployed yet. Deploy it first: sudo ./one-click-update.sh --only backend" >&2
    exit 1
  fi
  [ "$(docker inspect --format '{{.State.Running}}' "$backend_id" 2>/dev/null)" = "true" ] || compose start veilbird
  wait_for_healthy veilbird || exit 1
fi

# The image each target runs now is tagged ":previous", so a release that fails its health check goes back
# to it (and the Docker cleanup, which removes only untagged images, keeps it).
prefix_name=${image_prefix:-tracknothing}
rollback_ready=""
for target in $targets; do
  current=$(compose ps -q "$target" 2>/dev/null || true)
  [ -n "$current" ] || continue
  image_id=$(docker inspect --format '{{.Image}}' "$current" 2>/dev/null || true)
  [ -n "$image_id" ] || continue
  if docker tag "$image_id" "$prefix_name-$target:previous" 2>/dev/null; then
    rollback_ready="$rollback_ready $target"
    if [ "$target" = "veilbird" ]; then
      previous_rev=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$current" 2>/dev/null | sed -n 's/^VEILBIRD_BUILD_REV=//p' | head -n 1)
    fi
  fi
done

build_targets="$targets"
up_targets="$targets"

pulled="no"
if [ "$VEILBIRD_IMAGE_TAG" != "local" ]; then
  echo "Pulling images $image_prefix-*:$VEILBIRD_IMAGE_TAG"
  if compose pull --quiet $build_targets; then
    pulled="yes"
  elif [ -n "$image_tag" ]; then
    echo "Error: the registry has no images tagged $image_tag." >&2
    exit 1
  else
    echo "The registry has no images for this commit yet (or cannot be reached); building here instead."
  fi
fi
if [ "$pulled" = "no" ]; then
  export VEILBIRD_IMAGE_TAG=local
  echo "Building: $build_targets"
  if [ "$no_cache" = "yes" ]; then
    compose build --no-cache $build_targets
  else
    compose build $build_targets
  fi
fi

echo "Starting: $up_targets"
# --remove-orphans also retires the pre-rename "northstar" container that held port 3000.
# --no-deps: only the selected modules are recreated; the others keep running untouched.
compose up -d --force-recreate --remove-orphans --no-deps $up_targets

unhealthy=""
for target in $targets; do
  wait_for_healthy "$target" || unhealthy="$unhealthy $target"
done

if [ -n "$unhealthy" ]; then
  echo "" >&2
  echo "The new version did not become healthy:$unhealthy" >&2
  rollback_targets=""
  for target in $targets; do
    case " $rollback_ready " in *" $target "*) rollback_targets="$rollback_targets $target" ;; esac
  done
  if [ -z "$rollback_targets" ]; then
    echo "There is no previous version to go back to (first deployment of these modules)." >&2
    exit 1
  fi
  echo "Going back to the previous version of:$rollback_targets" >&2
  # Every module of this release goes back together, so the frontends and the backend still match.
  VEILBIRD_IMAGE_TAG=previous VEILBIRD_BUILD_REV=${previous_rev:-$VEILBIRD_BUILD_REV} \
    compose up -d --force-recreate --no-deps $rollback_targets
  rolled_back="yes"
  for target in $rollback_targets; do wait_for_healthy "$target" || rolled_back="no"; done
  if [ "$rolled_back" = "yes" ]; then
    echo "Rolled back: the previous version is running again." >&2
  else
    echo "The previous version did not come back healthy either. Check: ./scripts/deploy.sh logs" >&2
  fi
  if includes veilbird; then
    echo "Database changes made by the new version, if any, stay applied. If the previous version misbehaves," >&2
    echo "restore the backup taken just before this update (./backups, ./scripts/restore-postgres.sh)." >&2
  fi
  exit 1
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
  check_frontend_map() {
    service_name=$1
    port=$2
    map_type=$(curl --fail --silent --show-error --max-time 10 -o /dev/null -w '%{content_type}' "http://127.0.0.1:$port/world-map.webp") || {
      echo "Error: $service_name map asset is unavailable. Rebuild and redeploy this frontend." >&2
      exit 1
    }
    case "$map_type" in
      image/webp*) ;;
      *) echo "Error: $service_name map returned $map_type instead of image/webp. Deployment verification failed." >&2; exit 1 ;;
    esac
  }
  if includes veilbird; then check_endpoint veilbird 3000 /api/health; fi
  if includes portal-web; then
    check_frontend_map portal-web 3100
    check_endpoint portal-web 3100 /health
    check_endpoint portal-web 3100 /api/health
  fi
  if includes admin-web; then
    check_frontend_map admin-web 3200
    check_endpoint admin-web 3200 /health
    check_endpoint admin-web 3200 /api/health
  fi
fi

# Runtime logs are optional for recovery, so a log store problem is a warning, not a failed deploy.
loki_ready=""
loki_crashed=""
check_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
check_deadline=$(( $(date +%s) + 60 ))
while :; do
  elapsed=$(( 60 - (check_deadline - $(date +%s)) ))
  if [ -t 1 ]; then
    printf '\rChecking the log service (Loki)... %ss / 60s ' "$elapsed"
  elif [ -z "${check_announced:-}" ]; then
    echo "Checking the log service (Loki), up to 60 seconds..."
    check_announced="yes"
  fi
  if compose exec -T veilbird node -e "fetch('http://loki:3100/ready',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" </dev/null >/dev/null 2>&1; then
    loki_ready="yes"
    break
  fi
  # A startup error will not fix itself by waiting: report it right away.
  if compose logs --no-color --since "$check_started" loki 2>/dev/null | grep -q "error running loki"; then
    loki_crashed="yes"
    break
  fi
  [ "$(date +%s)" -lt "$check_deadline" ] || break
  sleep 1
done
if [ -t 1 ]; then echo ""; fi
if [ -n "$loki_ready" ]; then
  echo "Log service (Loki) is ready."
else
  echo "Warning: the log service (Loki) is not ready; Console Runtime logs stay empty until it is." >&2
  compose ps --all loki >&2 || true
  echo "Recent Loki output:" >&2
  if [ -n "$loki_crashed" ]; then
    compose logs --no-color --since "$check_started" loki 2>/dev/null | grep "error running loki" | tail -n 1 >&2 || true
  else
    compose logs --no-color --tail=40 loki >&2 || true
  fi
fi

# Host Nginx 429s floods for this deployment's hostnames before they reach the containers.
sh "$SCRIPT_DIR/setup-nginx-limits.sh" || echo "Warning: Nginx request limits were not updated; deployment is unaffected." >&2

# Cleanup runs only after a healthy deploy, so a failed one still has its previous images.
sh "$SCRIPT_DIR/prune-docker.sh" || echo "Warning: Docker cleanup failed; deployment is unaffected." >&2

# What each module runs now; one-click-update.sh compares it with new commits to pick what to update.
mkdir -p "$APP_DIR/.deployed"
deployed_commit=$(git rev-parse HEAD)
[ -z "$image_tag" ] || deployed_commit=$(git rev-parse --verify --quiet "$image_tag^{commit}" || echo "$image_tag")
for target in $targets; do echo "$deployed_commit" > "$APP_DIR/.deployed/$target"; done

compose ps
echo "TrackNothing deployment is healthy: $targets"
echo "Controller: http://127.0.0.1:3000"
echo "Portal: http://127.0.0.1:3100"
echo "Console: http://127.0.0.1:3200"
echo "Static target: http://127.0.0.1:3300 (public HTTPS requires one-time setup)"
echo "Logs: ./scripts/deploy.sh logs"
