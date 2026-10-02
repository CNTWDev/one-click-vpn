/** Replace only the Agent source; never rotate identity or rewrite VPN state. */
export function agentUpgradeCommand(source: string): string {
  return `set -eu
test -s /opt/northstar-agent/config.env || { echo 'Agent is not installed; use reinstall / repair'; exit 1; }
test -s /opt/northstar-agent/agent.py
printf 'NORTHSTAR_PROGRESS|upgrade|30|Uploading Controller Agent release\\n'
python_path=$(command -v python3)
printf '%s' '${Buffer.from(source).toString("base64")}' | base64 -d > /opt/northstar-agent/agent.py.next
"$python_path" -c "import ast; ast.parse(open('/opt/northstar-agent/agent.py.next').read())"
chmod 700 /opt/northstar-agent/agent.py.next
cp -p /opt/northstar-agent/agent.py /opt/northstar-agent/agent.py.previous
mv /opt/northstar-agent/agent.py.next /opt/northstar-agent/agent.py
if ! systemctl restart northstar-agent || ! systemctl is-active --quiet northstar-agent; then
  cp -p /opt/northstar-agent/agent.py.previous /opt/northstar-agent/agent.py
  systemctl restart northstar-agent || true
  echo 'Agent restart failed; previous source restored'; exit 1
fi
printf 'NORTHSTAR_PROGRESS|verify|85|Waiting for authenticated version heartbeat\\n'
`;
}
