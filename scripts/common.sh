#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

compose() {
  # .env files written before the Veilbird rename still use NORTHSTAR_* keys.
  if [ -z "${VEILBIRD_ENV_MIGRATED:-}" ] && [ -f "$APP_DIR/scripts/migrate-env.sh" ]; then
    sh "$APP_DIR/scripts/migrate-env.sh" "$APP_DIR/.env"
    VEILBIRD_ENV_MIGRATED=1
  fi
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

# One update at a time: a second run waits for nothing and stops with a message. one-click-update.sh takes
# the lock and its child deploy.sh inherits it.
acquire_deploy_lock() {
  lock_dir="$APP_DIR/.deploy.lock"
  if [ -n "${VEILBIRD_DEPLOY_LOCK_HELD:-}" ]; then
    # Re-run by exec (one-click-update.sh after it updated itself): the same process keeps the lock.
    if [ "$(cat "$lock_dir/pid" 2>/dev/null || true)" = "$$" ]; then trap 'rm -rf "$lock_dir"' EXIT; fi
    return 0
  fi
  if ! mkdir "$lock_dir" 2>/dev/null; then
    other=$(cat "$lock_dir/pid" 2>/dev/null || true)
    if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then
      echo "Another update is already running (process $other). Wait for it to finish, then run this again." >&2
      exit 1
    fi
    # Left behind by a run that was killed.
    rm -rf "$lock_dir"
    mkdir "$lock_dir" || { echo "Cannot create $lock_dir." >&2; exit 1; }
  fi
  echo "$$" > "$lock_dir/pid"
  VEILBIRD_DEPLOY_LOCK_HELD=1
  export VEILBIRD_DEPLOY_LOCK_HELD
  trap 'rm -rf "$lock_dir"' EXIT
  trap 'exit 130' INT TERM
}

# Modules (Compose services): veilbird = backend/Controller, portal-web = Portal, admin-web = Console,
# reality-target = the static REALITY target site. The node Agent ships inside the backend image and is
# rolled out to nodes by scripts/agent-rollout.mjs.
ALL_SERVICES="veilbird portal-web admin-web reality-target"

# Accepts the names people type (backend, console, portal, ...) and prints the service, or nothing.
normalize_service() {
  case "$1" in
    backend|controller|api|veilbird|northstar) echo veilbird ;;
    portal|portal-web) echo portal-web ;;
    console|admin|admin-web) echo admin-web ;;
    static|reality-target) echo reality-target ;;
    agent) echo agent ;;
    all) echo all ;;
  esac
}

service_label() {
  case "$1" in
    veilbird) echo "backend" ;;
    portal-web) echo "portal" ;;
    admin-web) echo "console" ;;
    reality-target) echo "static site" ;;
    agent) echo "node Agent" ;;
    *) echo "$1" ;;
  esac
}

# Which images a changed file goes into. Files that no image contains (apps, docs, tests, host scripts)
# change nothing; anything not listed here rebuilds every module, to be safe.
services_for_path() {
  case "$1" in
    clients/*|docs/*|tests/*|.github/*|*.md|deploy/nginx/*|deploy/loki/*|eslint.config.mjs|.gitignore|.env.example) ;;
    one-click-*.sh) ;;
    scripts/migrate.mjs) echo veilbird ;;
    scripts/check-frontend-assets.mjs|scripts/compress-frontend-assets.mjs) echo portal-web; echo admin-web ;;
    scripts/*) ;;
    portal-web/*) echo portal-web ;;
    admin-web/*) echo admin-web ;;
    frontend-server.mjs|Dockerfile.frontend) echo portal-web; echo admin-web ;;
    deploy/reality-target/*) echo reality-target ;;
    app/*|server/*|db/*|agent/*|Dockerfile|docker-entrypoint.sh|instrumentation.ts|next.config.ts|proxy.ts) echo veilbird ;;
    # Console strings are read by the Console only; other shared code is used by several modules.
    shared/i18n-console.json) echo admin-web ;;
    shared/*|public/*|package.json|package-lock.json|tsconfig.json) echo veilbird; echo portal-web; echo admin-web ;;
    *) echo "$ALL_SERVICES" | tr ' ' '\n' ;;
  esac
}

# The commit each module last deployed successfully, written by deploy.sh.
deployed_rev() {
  cat "$APP_DIR/.deployed/$1" 2>/dev/null || true
}

# Prints the modules whose image changed between what is deployed and HEAD (one per line).
changed_services() {
  head_rev=${1:-HEAD}
  for svc in $ALL_SERVICES; do
    base=$(deployed_rev "$svc")
    if [ -z "$base" ] || ! git -C "$APP_DIR" cat-file -e "$base^{commit}" 2>/dev/null; then
      echo "$svc"
      continue
    fi
    git -C "$APP_DIR" diff --name-only "$base" "$head_rev" | while IFS= read -r file; do services_for_path "$file"; done | grep -qx "$svc" && echo "$svc"
  done
  return 0
}

# ---- Off-site backups (scripts/offsite-backup.sh, backup-drill.sh, offsite-restore.sh) ----
# A .env value without surrounding quotes; empty when unset.
backup_setting() {
  value=$(env_value "$1" 2>/dev/null || true)
  case "$value" in \"*\") value=${value#\"}; value=${value%\"} ;; \'*\') value=${value#\'}; value=${value%\'} ;; esac
  printf '%s' "$value"
}

offsite_configured() {
  [ -n "$(backup_setting VEILBIRD_BACKUP_S3_BUCKET)" ]
}

json_string() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

# The first stdin line scripts/offsite-backup.mjs reads: the command, the bucket settings and the backup
# password (VEILBIRD_BACKUP_PASSPHRASE, else VEILBIRD_MASTER_KEY; OFFSITE_PASSPHRASE overrides both), then
# extra JSON fields given as the second argument (",\"name\":\"...\"").
offsite_request() {
  passphrase=${OFFSITE_PASSPHRASE:-$(backup_setting VEILBIRD_BACKUP_PASSPHRASE)}
  [ -n "$passphrase" ] || passphrase=$(backup_setting VEILBIRD_MASTER_KEY)
  printf '{"command":%s,"endpoint":%s,"bucket":%s,"region":%s,"prefix":%s,"addressing":%s,"accessKeyId":%s,"secretAccessKey":%s,"passphrase":%s%s}\n' \
    "$(json_string "$1")" \
    "$(json_string "$(backup_setting VEILBIRD_BACKUP_S3_ENDPOINT)")" \
    "$(json_string "$(backup_setting VEILBIRD_BACKUP_S3_BUCKET)")" \
    "$(json_string "$(backup_setting VEILBIRD_BACKUP_S3_REGION)")" \
    "$(json_string "$(backup_setting VEILBIRD_BACKUP_S3_PREFIX)")" \
    "$(json_string "$(backup_setting VEILBIRD_BACKUP_S3_ADDRESSING)")" \
    "$(json_string "$(backup_setting VEILBIRD_BACKUP_S3_ACCESS_KEY_ID)")" \
    "$(json_string "$(backup_setting VEILBIRD_BACKUP_S3_SECRET_ACCESS_KEY)")" \
    "$(json_string "$passphrase")" \
    "${2:-}"
}

# Runs scripts/offsite-backup.mjs inside the Controller container (it has Node and reaches Loki); stdin is the
# request line plus any data. The bucket keys travel on stdin, never on a command line.
offsite_node() {
  compose exec -T veilbird node --input-type=module -e "$(cat "$APP_DIR/scripts/offsite-backup.mjs")"
}

# Writes one line to Console → 日志 (best effort).
offsite_log() {
  printf '{"command":"log","level":%s,"action":%s,"message":%s}\n' "$(json_string "$1")" "$(json_string "$2")" "$(json_string "$3")" |
    offsite_node >/dev/null 2>&1 || true
}
