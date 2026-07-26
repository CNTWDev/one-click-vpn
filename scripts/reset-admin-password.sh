#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
. "$SCRIPT_DIR/common.sh"

cd "$APP_DIR"
if [ ! -f .env ]; then
  echo "Missing $APP_DIR/.env. Run this on the deployed Controller host." >&2
  exit 1
fi

default_email=$(env_value NORTHSTAR_ADMIN_EMAIL)
printf "Admin email [%s]: " "$default_email"
read -r email
email=${email:-$default_email}
if [ -z "$email" ]; then
  echo "An admin email is required." >&2
  exit 1
fi

printf "New password (min 16 characters): "
old_stty=$(stty -g 2>/dev/null || true)
stty -echo 2>/dev/null || true
read -r password
[ -n "$old_stty" ] && stty "$old_stty" 2>/dev/null || true
printf '\n'

printf "Repeat new password: "
old_stty=$(stty -g 2>/dev/null || true)
stty -echo 2>/dev/null || true
read -r password_again
[ -n "$old_stty" ] && stty "$old_stty" 2>/dev/null || true
printf '\n'

if [ "${#password}" -lt 16 ]; then
  echo "Password must be at least 16 characters." >&2
  exit 1
fi
if [ "$password" != "$password_again" ]; then
  echo "Passwords do not match." >&2
  exit 1
fi

echo "Generating password hash inside the Controller image..."
password_hash=$(printf '%s' "$password" | compose run --rm --no-deps -T --entrypoint node northstar -e '
const { randomBytes, scryptSync } = require("node:crypto");
let password = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { password += chunk; });
process.stdin.on("end", () => {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  process.stdout.write(`scrypt:${salt.toString("base64url")}:${derived.toString("base64url")}`);
});
' | tr -d '\r\n')

updated=$(compose exec -T db psql -v ON_ERROR_STOP=1 -U northstar -d northstar \
  -v admin_email="$email" -v password_hash="$password_hash" -tA \
  -c "UPDATE users SET password_hash = :'password_hash', status = 'active', approved_at = COALESCE(approved_at, NOW()), updated_at = NOW() WHERE lower(email) = lower(:'admin_email') AND role IN ('owner', 'admin') RETURNING email;")

if [ -z "$updated" ]; then
  echo "No owner/admin account matched: $email" >&2
  exit 1
fi

echo "Admin password reset for $updated"
echo "The database was updated; existing users, nodes, VPN services, and traffic data were not changed."
