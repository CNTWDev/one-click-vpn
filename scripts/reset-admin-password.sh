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

echo "Resetting the password through the Controller database driver..."
updated=$(printf '%s' "$password" | compose exec -T \
  -e "NORTHSTAR_RESET_EMAIL=$email" northstar node -e '
const { randomBytes, scryptSync } = require("node:crypto");
const { Client } = require("pg");

let password = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { password += chunk; });
process.stdin.on("end", async () => {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  const passwordHash = `scrypt:${salt.toString("base64url")}:${derived.toString("base64url")}`;
  const client = new Client({ connectionString: process.env.NORTHSTAR_DATABASE_URL });
  try {
    await client.connect();
    const result = await client.query(
      `UPDATE users
       SET password_hash = $1, status = $2,
           approved_at = COALESCE(approved_at, NOW()), updated_at = NOW()
       WHERE lower(email) = lower($3) AND role IN ($4, $5)
       RETURNING email`,
      [passwordHash, "active", process.env.NORTHSTAR_RESET_EMAIL, "owner", "admin"],
    );
    if (result.rows[0]?.email) process.stdout.write(result.rows[0].email);
  } finally {
    await client.end();
  }
});
' | tr -d '\r\n')

if [ -z "$updated" ]; then
  echo "No owner/admin account matched: $email" >&2
  exit 1
fi

echo "Admin password reset for $updated"
echo "The database was updated; existing users, nodes, VPN services, and traffic data were not changed."
