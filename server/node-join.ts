import { randomBytes } from "node:crypto";
import { hashToken } from "./crypto";
import { addAudit, addNodeAction, appendNodeActionEvent, dbExec, dbQuery, finishNodeAction, startNodeAction, updateNode, updateNodeActionProgress } from "./db";
import { agentInstallScript, finishAgentInstall, waitForAgentHeartbeat } from "./bootstrap";
import { currentAgentOrigin } from "./agent-domain";
import { writeOperationalLog } from "./operational-logs";

// Adding a node without SSH: Console shows a one-line install command with a one-time token (1 hour). Run as
// root on the server, it downloads the install script from the Agent domain, which consumes the token and embeds
// a fresh Agent token. The Controller never sees or stores an SSH credential, and the node needs no inbound SSH.
const TOKEN_TTL_MS = 60 * 60_000;
const INSTALL_WAIT_MS = 20 * 60_000;

export async function createJoinCommand(nodeId: string): Promise<{ command: string; expiresAt: string }> {
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  // A new command replaces the previous unused one.
  await dbExec("DELETE FROM node_join_tokens WHERE node_id = $1 AND used_at IS NULL", [nodeId]);
  await dbExec("INSERT INTO node_join_tokens (token_hash, node_id, expires_at) VALUES ($1, $2, $3)", [hashToken(token), nodeId, expiresAt]);
  return { command: `curl -fsSL ${await currentAgentOrigin()}/api/v1/agent/join/${token} | sh`, expiresAt };
}

/** Marks the token used; null when it is unknown, used or expired. */
export async function consumeJoinToken(token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  const row = (await dbQuery<{ node_id: string }>(`UPDATE node_join_tokens SET used_at = now()
    WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING node_id`, [hashToken(token)]))[0];
  return row?.node_id ?? null;
}

/** Shell that prints a reason and fails, so `curl | sh` shows why instead of an HTTP status. */
export function refusalScript(message: string): string {
  return `#!/bin/sh\necho ${shellQuote(message)} >&2\nexit 1\n`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The install script for a consumed token. The whole script sits in one brace group, so a cut-off download runs nothing. */
export async function joinScript(nodeId: string): Promise<string> {
  const agentToken = randomBytes(32).toString("base64url");
  const agentOrigin = await currentAgentOrigin();
  const install = agentInstallScript({ nodeId, agentToken, agentOrigin, progress: "text", firstStep: "Checking node prerequisites" });
  await updateNode(nodeId, { status: "provisioning", version: "agent installing", last_seen: "install command running", agent_token_hash: hashToken(agentToken) });
  const actionId = await addNodeAction(nodeId, "join", "running").catch(() => "");
  if (actionId) {
    await startNodeAction(actionId);
    await updateNodeActionProgress(actionId, { phase: "install", progress: 20, message: "Install command is running on the node" });
    void awaitJoinedAgent(nodeId, actionId);
  }
  await addAudit({ action: "node.join.started", targetType: "node", targetId: nodeId });
  return `#!/bin/sh
{
set -eu
[ "$(id -u)" -eq 0 ] || { echo 'Run the install command as root (sudo -i, then paste it again).' >&2; exit 1; }
# The same persistent identity file the SSH install reads (server/remote-ssh.ts).
install -d -m 0700 /var/lib/northstar
if [ ! -s /var/lib/northstar/node-id ]; then
  (umask 077; printf 'nsn_%s\\n' "$(cat /proc/sys/kernel/random/uuid)" > /var/lib/northstar/node-id)
fi
${install}
progress agent-start 95 'Starting the Agent'
systemctl daemon-reload
systemctl enable --now northstar-agent
sleep 2
if ! systemctl is-active --quiet northstar-agent; then
  systemctl --no-pager --full status northstar-agent || true
  journalctl -u northstar-agent -n 60 --no-pager || true
  exit 1
fi
progress done 100 'Agent installed and running. The node appears online in Console within a few seconds.'
} </dev/null
`;
}

/** Waits for the first heartbeat of the joined Agent (installing packages can take minutes), then finishes the install. */
async function awaitJoinedAgent(nodeId: string, actionId: string): Promise<void> {
  const renew = setInterval(() => { void dbExec("UPDATE node_actions SET lease_updated_at = $2 WHERE id = $1", [actionId, new Date().toISOString()]).catch(() => undefined); }, 30_000);
  renew.unref();
  try {
    if (!(await waitForAgentHeartbeat(nodeId, Date.now(), INSTALL_WAIT_MS))) {
      const message = "安装命令已开始运行，但 20 分钟内没有收到 Agent 心跳。请查看命令输出；节点需要能访问 Agent 域名。";
      await updateNode(nodeId, { status: "attention", version: "agent heartbeat failed", last_seen: "heartbeat not received" });
      await appendNodeActionEvent(actionId, { level: "error", phase: "failed", message });
      await finishNodeAction(actionId, "failed", "", message);
      return;
    }
    await updateNodeActionProgress(actionId, { phase: "services", progress: 90, message: "Agent is online; setting up VPN services" });
    await finishAgentInstall(nodeId, actionId);
    await finishNodeAction(actionId, "succeeded", "Installed by install command; no SSH credential is stored.");
    await addAudit({ action: "node.join.succeeded", targetType: "node", targetId: nodeId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void writeOperationalLog({ nodeId, actionId, component: "bootstrap", level: "error", message: `Install command follow-up failed: ${message}` });
    await finishNodeAction(actionId, "failed", "", message.slice(-4000)).catch(() => undefined);
  } finally {
    clearInterval(renew);
  }
}
