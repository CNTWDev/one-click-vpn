const directory = "/opt/northstar-agent";
const lock = `exec 9>${directory}/upgrade.lock\nflock -x 9\n`;
/** Run on the node even if SSH or the Controller disappears during verification. */
export function agentRollbackCommand(): string {
  return `set -eu\n${lock}if test -f ${directory}/upgrade.pending; then
  cp -p ${directory}/agent.py.rollback ${directory}/agent.py
  rm -f ${directory}/upgrade.pending
  systemctl restart northstar-agent
  echo 'Unverified Agent upgrade rolled back'
fi\n`;
}
export function agentUpgradeFinalizeCommand(): string {
  return `set -eu\n${lock}test -f ${directory}/upgrade.pending || { echo 'Agent upgrade already rolled back'; exit 1; }
systemctl is-active --quiet northstar-agent
cp -p ${directory}/agent.py.rollback ${directory}/agent.py.previous
rm -f ${directory}/upgrade.pending
systemctl stop northstar-agent-upgrade-rollback.timer || true\n`;
}
/** Stage a source-only upgrade, confirmed only after an authenticated target-version heartbeat. */
export function agentUpgradeCommand(source: string): string {
  const rollback = Buffer.from(agentRollbackCommand()).toString("base64");
  return `set -eu
${lock}test -s ${directory}/config.env || { echo 'Agent is not installed; use reinstall / repair'; exit 1; }
test -s ${directory}/agent.py
if test -f ${directory}/upgrade.pending; then
  cp -p ${directory}/agent.py.rollback ${directory}/agent.py
  rm -f ${directory}/upgrade.pending
  systemctl restart northstar-agent
fi
# Never overwrite the last confirmed backup with a source that cannot run.
if ! systemctl is-active --quiet northstar-agent; then
  test -s ${directory}/agent.py.previous || { echo 'No healthy Agent backup available'; exit 1; }
  cp -p ${directory}/agent.py.previous ${directory}/agent.py
  systemctl restart northstar-agent
  systemctl is-active --quiet northstar-agent
fi
printf 'NORTHSTAR_PROGRESS|upgrade|30|Uploading Controller Agent release\\n'
python_path=$(command -v python3)
printf '%s' '${Buffer.from(source).toString("base64")}' | base64 -d > ${directory}/agent.py.next
"$python_path" -c "import ast; ast.parse(open('${directory}/agent.py.next').read())"
chmod 700 ${directory}/agent.py.next
cp -p ${directory}/agent.py ${directory}/agent.py.rollback
printf '%s' '${rollback}' | base64 -d > ${directory}/upgrade-rollback.sh
chmod 700 ${directory}/upgrade-rollback.sh
touch ${directory}/upgrade.pending
systemctl stop northstar-agent-upgrade-rollback.timer northstar-agent-upgrade-rollback.service || true
systemctl reset-failed northstar-agent-upgrade-rollback.service || true
if ! systemd-run --unit=northstar-agent-upgrade-rollback --on-active=90s --timer-property=AccuracySec=1s /bin/sh ${directory}/upgrade-rollback.sh; then
  rm -f ${directory}/upgrade.pending
  echo 'Could not arm Agent rollback watchdog'; exit 1
fi
mv ${directory}/agent.py.next ${directory}/agent.py
if ! systemctl restart northstar-agent || ! systemctl is-active --quiet northstar-agent; then
  cp -p ${directory}/agent.py.rollback ${directory}/agent.py
  rm -f ${directory}/upgrade.pending
  systemctl restart northstar-agent || true
  echo 'Agent restart failed; previous source restored'; exit 1
fi
printf 'NORTHSTAR_PROGRESS|verify|85|Waiting for authenticated version heartbeat\\n'
`;
}
