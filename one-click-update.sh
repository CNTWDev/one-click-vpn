#!/usr/bin/env sh
# Updates this server to the latest code. By default it works out what changed since each module was last
# deployed and updates only those modules: backend, portal, console (and the static REALITY site); after
# that it upgrades the node Agents that are behind, one node first. See README (upgrade section).
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR="$SCRIPT_DIR"
. "$APP_DIR/scripts/common.sh"
APP_DIR="$SCRIPT_DIR"

usage() {
  cat <<'USAGE'
Usage: sudo ./one-click-update.sh [--only <modules>] [--all] [--no-agent] [--no-cache]

  (no option)       Update only the modules whose code changed, then upgrade outdated node Agents.
  --only <modules>  Update just these, comma separated: backend, portal, console, agent, static.
                    Example: --only console   or   --only backend,console
  --all             Rebuild and restart every module, changed or not.
  --no-agent        Do not upgrade node Agents (do it later in Console or with --only agent).
  --no-cache        Build images without the Docker cache.
USAGE
}

original_args="$*"
only=""
force_all="no"
agent_step="auto"
no_cache="no"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --only|--service) only=${2:-}; [ -n "$only" ] || { usage >&2; exit 2; }; shift 2 ;;
    --all) force_all="yes"; shift ;;
    --no-agent) agent_step="no"; shift ;;
    --no-cache) no_cache="yes"; shift ;;
    --code-updated) code_updated="yes"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[ "$only" != "all" ] || { only=""; force_all="yes"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script with sudo so backup and Docker commands use production permissions." >&2
  exit 1
fi

cd "$APP_DIR"
acquire_deploy_lock

# Modules named with --only, as Compose services (the Agent is its own step).
selected=""
if [ -n "$only" ]; then
  agent_step="no"
  for name in $(printf '%s' "$only" | tr ',' ' '); do
    normalized=$(normalize_service "$name")
    case "$normalized" in
      "") echo "Unknown module: $name. Use backend, portal, console, agent or static." >&2; exit 2 ;;
      all) force_all="yes" ;;
      agent) agent_step="yes" ;;
      *) selected="$selected $normalized" ;;
    esac
  done
fi

./scripts/ensure-postgres-env.sh

# --only agent upgrades the nodes to the Agent the running backend carries: no new code is needed for that.
if [ "$agent_step" = "yes" ] && [ -z "$selected" ] && [ "$force_all" = "no" ]; then
  echo "Upgrading node Agents only (to the version the running backend carries)."
  compose exec -T veilbird node --input-type=module - < ./scripts/agent-rollout.mjs
  exit $?
fi

if [ "${code_updated:-}" != "yes" ]; then
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "Tracked working tree changes detected. Commit or stash them before automatic update:" >&2
    git status --short --untracked-files=no >&2
    exit 1
  fi
  before=$(git rev-parse HEAD)
  echo "Fetching latest code..."
  git pull --ff-only
  after=$(git rev-parse HEAD)
  if [ "$before" = "$after" ]; then
    echo "Code is up to date at $(printf '%.12s' "$after")."
  else
    echo "Updated code from $(printf '%.12s' "$before") to $(printf '%.12s' "$after")."
    # This script may itself have changed: run the new version for the rest of the update.
    if ! git diff --quiet "$before" "$after" -- one-click-update.sh scripts/common.sh; then
      echo "The update script changed; continuing with the new version."
      # shellcheck disable=SC2086 # the options never contain spaces
      exec sh ./one-click-update.sh $original_args --code-updated
    fi
  fi
fi

if [ "$force_all" = "yes" ]; then
  targets="$ALL_SERVICES"
elif [ -n "$selected" ]; then
  targets=$(echo $selected)
else
  targets=$(echo $(changed_services))
fi

skipped=""
for svc in $ALL_SERVICES; do
  case " $targets " in *" $svc "*) ;; *) skipped="$skipped, $(service_label "$svc")" ;; esac
done
if [ -n "$targets" ]; then
  planned=""
  for svc in $targets; do planned="$planned, $(service_label "$svc")"; done
  echo "Updating: ${planned#, }"
  [ -z "$skipped" ] || echo "Unchanged, left running: ${skipped#, }"
else
  echo "No module changed since it was last deployed; nothing to rebuild."
fi

# A frontend chosen by hand may need backend changes that are not deployed yet.
case " $targets " in
  *" veilbird "*) ;;
  *" portal-web "*|*" admin-web "*)
    if [ -n "$selected" ] && changed_services | grep -qx veilbird; then
      echo "Warning: the backend also has undeployed changes. If the page needs them, run: sudo ./one-click-update.sh --only backend" >&2
    fi
    ;;
esac

if [ -n "$targets" ]; then
  case " $targets " in
    *" veilbird "*)
      echo "Creating a database backup before updating the backend..."
      ./scripts/backup.sh ./backups
      ;;
  esac
  service_list=$(echo $targets | tr ' ' ',')
  if [ "$no_cache" = "yes" ]; then
    sh ./scripts/deploy.sh --service "$service_list" --no-cache
  else
    sh ./scripts/deploy.sh --service "$service_list"
  fi
fi

if [ "$agent_step" != "no" ]; then
  echo ""
  echo "Checking node Agents..."
  # A node that cannot upgrade now does not fail the server update; the message says what to do.
  compose exec -T veilbird node --input-type=module - < ./scripts/agent-rollout.mjs || true
else
  echo "Node Agents were not checked (--no-agent / --only). Later: sudo ./one-click-update.sh --only agent"
fi

# Nightly off-site backup and weekly restore drill (only once VEILBIRD_BACKUP_S3_* is set in .env).
echo ""
sh ./scripts/install-backup-timer.sh || echo "Warning: off-site backup needs attention (see above); the update itself succeeded." >&2
