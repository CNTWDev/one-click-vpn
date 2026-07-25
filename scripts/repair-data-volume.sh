#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
. "$SCRIPT_DIR/common.sh"

cd "$APP_DIR"

echo "Stopping Northstar before repairing the database volume..."
compose stop northstar >/dev/null 2>&1 || true

echo "Repairing ownership and write permissions for /app/data..."
compose run --rm --no-deps --user root --entrypoint /bin/sh northstar -c '
set -eu
data_dir=/app/data
mkdir -p "$data_dir"
owner="$(id -u node):$(id -g node)"
chown -R "$owner" "$data_dir"
find "$data_dir" -type d -exec chmod u+rwx {} +
find "$data_dir" -type f -exec chmod u+rw {} +
'
compose run --rm --no-deps --user node --entrypoint /bin/sh northstar -c '
set -eu
probe=/app/data/.northstar-write-test
touch "$probe"
rm -f "$probe"
echo "Northstar data volume is writable by the node user."
'
