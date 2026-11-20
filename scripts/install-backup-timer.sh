#!/usr/bin/env sh
# Installs the systemd timers for off-site backups once VEILBIRD_BACKUP_S3_BUCKET is set in .env:
#   veilbird-backup.timer        every night 03:30 (server time): scripts/offsite-backup.sh
#   veilbird-backup-drill.timer  Sundays 05:00: scripts/backup-drill.sh (restore drill)
# one-click-update.sh runs this on every update; it changes nothing when the timers are already current.
# The first time, it also makes a backup and runs the drill right away so a wrong setting shows at once.
# --remove takes the timers out again.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
. "$SCRIPT_DIR/common.sh"

cd "$APP_DIR"
UNIT_DIR=${VEILBIRD_SYSTEMD_DIR:-/etc/systemd/system}
UNITS="veilbird-backup.service veilbird-backup.timer veilbird-backup-drill.service veilbird-backup-drill.timer"

if [ "${1:-}" = "--remove" ]; then
  systemctl disable --now veilbird-backup.timer veilbird-backup-drill.timer >/dev/null 2>&1 || true
  for unit in $UNITS; do rm -f "$UNIT_DIR/$unit"; done
  systemctl daemon-reload 2>/dev/null || true
  echo "Off-site backup timers removed."
  exit 0
fi

if ! offsite_configured; then
  echo "Off-site backup: not configured (VEILBIRD_BACKUP_S3_* in .env, see README). Only local dumps are kept."
  exit 0
fi
if [ ! -d /run/systemd/system ] || ! command -v systemctl >/dev/null 2>&1; then
  echo "Off-site backup: systemd is not available. Schedule it with cron instead, e.g.:" >&2
  echo "  30 3 * * * $APP_DIR/scripts/offsite-backup.sh   and   0 5 * * 0 $APP_DIR/scripts/backup-drill.sh" >&2
  exit 0
fi

new=$(mktemp -d)
trap 'rm -rf "$new"' EXIT
cat > "$new/veilbird-backup.service" <<UNIT
[Unit]
Description=TrackNothing off-site database backup
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=$APP_DIR
ExecStart=/bin/sh $APP_DIR/scripts/offsite-backup.sh
Nice=10
UNIT
cat > "$new/veilbird-backup.timer" <<UNIT
[Unit]
Description=Nightly TrackNothing off-site database backup

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=20min
Persistent=true

[Install]
WantedBy=timers.target
UNIT
cat > "$new/veilbird-backup-drill.service" <<UNIT
[Unit]
Description=TrackNothing off-site backup restore drill
After=docker.service veilbird-backup.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=$APP_DIR
ExecStart=/bin/sh $APP_DIR/scripts/backup-drill.sh
Nice=10
UNIT
cat > "$new/veilbird-backup-drill.timer" <<UNIT
[Unit]
Description=Weekly TrackNothing restore drill

[Timer]
OnCalendar=Sun *-*-* 05:00:00
RandomizedDelaySec=20min
Persistent=true

[Install]
WantedBy=timers.target
UNIT

first_install=no
[ -f "$UNIT_DIR/veilbird-backup.timer" ] || first_install=yes
changed=no
for unit in $UNITS; do
  if ! cmp -s "$new/$unit" "$UNIT_DIR/$unit"; then
    install -m 644 "$new/$unit" "$UNIT_DIR/$unit"
    changed=yes
  fi
done
if [ "$changed" = yes ]; then
  systemctl daemon-reload
fi
systemctl enable --now veilbird-backup.timer veilbird-backup-drill.timer >/dev/null 2>&1 ||
  { echo "Off-site backup: could not enable the timers (systemctl enable veilbird-backup.timer)." >&2; exit 1; }
next=$(systemctl show veilbird-backup.timer -p NextElapseUSecRealtime --value 2>/dev/null || true)
echo "Off-site backup: nightly to bucket $(backup_setting VEILBIRD_BACKUP_S3_BUCKET)${next:+, next run $next}; restore drill on Sundays."

if [ "$first_install" = yes ]; then
  echo "First off-site backup and restore drill, to check the settings..."
  if sh ./scripts/offsite-backup.sh && sh ./scripts/backup-drill.sh; then
    echo "Off-site backup is working."
  else
    echo "Off-site backup is NOT working yet: fix the VEILBIRD_BACKUP_S3_* settings in .env, then run" >&2
    echo "  sudo ./scripts/offsite-backup.sh && sudo ./scripts/backup-drill.sh" >&2
    exit 1
  fi
fi
