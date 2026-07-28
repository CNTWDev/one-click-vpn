import { readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { agentOrigin, allowTofuHostKeys } from "./config";
import { decryptSecret, hashToken } from "./crypto";
import { addAudit, addNodeAction, appendNodeActionEvent, countRunningNodeActions, findNode, finishNodeAction, startNodeAction, updateNode, updateNodeActionProgress } from "./db";
import { ensureDefaultNodeProtocols } from "./control-plane";
import { reconcileEnabledVpnServices } from "./vpn-services";
import { writeOperationalLog } from "./operational-logs";
import { executeRemoteCommand } from "./remote-ssh";

const maximumConcurrentRemoteActions = 3;
const remoteActionQueue: Array<() => Promise<void>> = [];
let activeRemoteActions = 0;

function processRemoteActionQueue(): void {
  while (activeRemoteActions < maximumConcurrentRemoteActions && remoteActionQueue.length) {
    const action = remoteActionQueue.shift()!;
    activeRemoteActions += 1;
    void action().catch((error) => {
      console.error("Northstar queued node action failed", error);
    }).finally(() => {
      activeRemoteActions -= 1;
      processRemoteActionQueue();
    });
  }
}

function enqueueRemoteAction(action: () => Promise<void>): void {
  remoteActionQueue.push(action);
  processRemoteActionQueue();
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hasFreshAgentHeartbeat(node: Awaited<ReturnType<typeof findNode>>, maximumAgeMilliseconds = 90_000): boolean {
  if (!node?.last_heartbeat_at) return false;
  const heartbeatAt = new Date(node.last_heartbeat_at).getTime();
  return Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt <= maximumAgeMilliseconds;
}

async function waitForAgentHeartbeat(nodeId: string, notBefore: number, timeoutMilliseconds: number = 25_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const node = await findNode(nodeId);
    const heartbeatAt = node?.last_heartbeat_at ? new Date(node.last_heartbeat_at).getTime() : 0;
    if (heartbeatAt >= notBefore) return true;
    await pause(1_000);
  }
  return false;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function agentSource(): string {
  return readFileSync(path.join(process.cwd(), "agent", "agent.py"), "utf8");
}

class ActionOutputRecorder {
  private remainder = "";
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly actionId: string, private readonly nodeId: string) {}

  write(chunk: string): void {
    const lines = (this.remainder + chunk).replaceAll("\r", "").split("\n");
    this.remainder = lines.pop() || "";
    for (const line of lines) this.record(line);
  }

  private record(line: string): void {
    const message = line.trim();
    if (!message) return;
    const marker = message.match(/^NORTHSTAR_PROGRESS\|([^|]+)\|([^|]+)\|(.*)$/);
    this.writes = this.writes.then(async () => {
      if (marker) {
        await updateNodeActionProgress(this.actionId, { phase: marker[1], progress: Number(marker[2]) || 0, message: marker[3] });
      } else {
        void writeOperationalLog({ nodeId: this.nodeId, actionId: this.actionId, component: "bootstrap", level: /error|failed|unable|denied/i.test(message) ? "warning" : "info", message });
        if (/error|failed|unable|denied/i.test(message)) await appendNodeActionEvent(this.actionId, { phase: "output", message, level: "warning" });
      }
    }).catch(() => undefined);
  }

  async flush(): Promise<void> {
    if (this.remainder.trim()) this.record(this.remainder);
    await this.writes;
  }
}

export async function queueNodeBootstrap(nodeId: string, actorUserId?: string): Promise<string> {
  const actionId = await addNodeAction(nodeId, "bootstrap");
  enqueueRemoteAction(() => bootstrapNode(nodeId, actorUserId, actionId));
  return actionId;
}

export async function queueNodeAction(nodeId: string, action: "restart-agent" | "status-agent", actorUserId?: string): Promise<string> {
  const actionId = await addNodeAction(nodeId, action);
  enqueueRemoteAction(async () => {
    try {
      await runNodeAction(nodeId, action, actorUserId, actionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendNodeActionEvent(actionId, { level: "error", phase: "failed", message: message.slice(-4000) });
      await finishNodeAction(actionId, "failed", "", message.slice(-4000));
    }
  });
  return actionId;
}

export async function bootstrapNode(nodeId: string, actorUserId?: string, queuedActionId?: string): Promise<void> {
  const node = await findNode(nodeId);
  if (!node) return;
  const actionId = queuedActionId || await addNodeAction(nodeId, "bootstrap", "running");
  await startNodeAction(actionId);
  await updateNode(nodeId, { status: "provisioning", version: "bootstrap running", last_seen: "connecting" });
  let recorder: ActionOutputRecorder | undefined;

  try {
    if (!node.host_fingerprint && !allowTofuHostKeys()) {
      throw new Error("Host fingerprint is required. Set it before bootstrapping a production node.");
    }
    const secret = decryptSecret({
      ciphertext: node.credential_ciphertext,
      iv: node.credential_iv,
      tag: node.credential_tag,
    });
    const agentToken = randomBytes(32).toString("base64url");
    const source = Buffer.from(agentSource(), "utf8").toString("base64");
    const controllerOrigin = shellQuote(agentOrigin());
    const command = `set -eu
progress() { printf 'NORTHSTAR_PROGRESS|%s|%s|%s\\n' "$1" "$2" "$3"; }
progress connection 15 'SSH session established; checking node prerequisites'
install_wireguard_tools() {
  if command -v wg >/dev/null 2>&1 && command -v wg-quick >/dev/null 2>&1; then
    return 0
  fi

  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y
    DEBIAN_FRONTEND=noninteractive apt-get install -y wireguard-tools
  elif command -v dnf >/dev/null 2>&1; then
    if ! dnf install -y wireguard-tools; then
      echo "wireguard-tools is not in the currently enabled DNF repositories; trying compatible repositories" >&2

      . /etc/os-release 2>/dev/null || true
      dnf install -y dnf-plugins-core >/dev/null 2>&1 || true
      dnf config-manager --set-enabled crb >/dev/null 2>&1 || true
      dnf config-manager --set-enabled powertools >/dev/null 2>&1 || true
      dnf install -y wireguard-tools && return 0

      # RHEL/CentOS 7/8 commonly obtain WireGuard from EPEL + ELRepo.
      case "\${ID:-}:\${ID_LIKE:-}" in
        *rhel*|*centos*|*rocky*|*almalinux*|*oracle*|*ol*|*anolis*)
          dnf install -y epel-release >/dev/null 2>&1 || true
          dnf install -y wireguard-tools && return 0
          dnf install -y elrepo-release >/dev/null 2>&1 || true
          dnf install -y kmod-wireguard wireguard-tools && return 0
          ;;
      esac
    fi
  elif command -v yum >/dev/null 2>&1; then
    yum install -y wireguard-tools
  elif command -v apk >/dev/null 2>&1; then
    apk add wireguard-tools
  else
    echo "wireguard-tools is not installed and no supported package manager was found" >&2
    return 1
  fi

  if ! command -v wg >/dev/null 2>&1 || ! command -v wg-quick >/dev/null 2>&1; then
    echo "Unable to install wireguard-tools and wg-quick" >&2
    echo "Operating system:" >&2
    cat /etc/os-release >&2 2>/dev/null || true
    if command -v dnf >/dev/null 2>&1; then
      echo "Enabled DNF repositories:" >&2
      dnf repolist >&2 || true
    fi
    echo "Enable the repository that provides wireguard-tools, or use a distribution with native WireGuard packages." >&2
    return 1
  fi
}
progress packages 30 'Installing supported VPN runtime packages'
if ! install_wireguard_tools; then
  echo "WireGuard is unavailable on this host; continuing with OpenVPN support only" >&2
fi
install_openvpn() {
  if command -v openvpn >/dev/null 2>&1; then
    return 0
  fi
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y
    DEBIAN_FRONTEND=noninteractive apt-get install -y openvpn
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y openvpn
  elif command -v yum >/dev/null 2>&1; then
    yum install -y openvpn
  elif command -v apk >/dev/null 2>&1; then
    apk add openvpn
  else
    echo "openvpn is not installed and no supported package manager was found" >&2
    exit 1
  fi
  command -v openvpn >/dev/null 2>&1 || { echo "Unable to install openvpn" >&2; exit 1; }
}
install_openvpn
progress networking 50 'Configuring packet forwarding and firewall prerequisites'
if ! command -v iptables >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y iptables
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y iptables
  elif command -v yum >/dev/null 2>&1; then
    yum install -y iptables
  elif command -v apk >/dev/null 2>&1; then
    apk add iptables
  else
    echo "iptables is not installed and no supported package manager was found" >&2
    exit 1
  fi
fi
if command -v sysctl >/dev/null 2>&1; then
  cat > /etc/sysctl.d/99-northstar-wireguard.conf <<'NORTHSTAR_SYSCTL'
net.ipv4.ip_forward=1
NORTHSTAR_SYSCTL
  sysctl --system >/dev/null
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required by the Northstar Agent; installing it" >&2
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y
    DEBIAN_FRONTEND=noninteractive apt-get install -y python3-minimal
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y python3
  elif command -v yum >/dev/null 2>&1; then
    yum install -y python3
  elif command -v apk >/dev/null 2>&1; then
    apk add python3
  else
    echo "python3 is not installed and no supported package manager was found" >&2
    exit 1
  fi
fi
progress controller-check 65 'Verifying outbound access to the Controller'
python_path=$(command -v python3 || true)
if [ -z "$python_path" ] || [ ! -x "$python_path" ]; then
  echo "Unable to locate an executable python3 after installation" >&2
  exit 1
fi
NORTHSTAR_PREFLIGHT_ORIGIN=${controllerOrigin} "$python_path" - <<'NORTHSTAR_PREFLIGHT'
import os
import urllib.request

origin = os.environ["NORTHSTAR_PREFLIGHT_ORIGIN"].rstrip("/")
try:
    with urllib.request.urlopen(origin + "/api/v1/health", timeout=15) as response:
        if response.status != 200:
            raise RuntimeError(f"unexpected HTTP status {response.status}")
except Exception as error:
    raise SystemExit(f"Controller health preflight failed for {origin}: {error}")
NORTHSTAR_PREFLIGHT
progress agent-files 78 'Writing the managed Agent and service definition'
systemctl stop northstar-agent >/dev/null 2>&1 || true
install -d -m 700 /opt/northstar-agent
echo ${shellQuote(source)} | base64 -d > /opt/northstar-agent/agent.py
if command -v wg >/dev/null 2>&1; then
  install -d -m 700 /opt/northstar-agent/state/wireguard
  install -d -m 700 /etc/wireguard
  if [ ! -s /opt/northstar-agent/state/wireguard/server.key ]; then
    (umask 077; wg genkey > /opt/northstar-agent/state/wireguard/server.key)
  fi
  chmod 600 /opt/northstar-agent/state/wireguard/server.key
fi
cat > /opt/northstar-agent/config.env <<'NORTHSTAR_CONFIG'
NORTHSTAR_CONTROLLER_URL=${agentOrigin()}
NORTHSTAR_NODE_ID=${node.id}
NORTHSTAR_AGENT_TOKEN=${agentToken}
NORTHSTAR_AGENT_STATE_DIR=/opt/northstar-agent/state
NORTHSTAR_CONFIG
chmod 600 /opt/northstar-agent/config.env
cat > /etc/systemd/system/northstar-agent.service <<NORTHSTAR_SERVICE
[Unit]
Description=Northstar outbound node agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/opt/northstar-agent/config.env
ExecStart=$python_path /opt/northstar-agent/agent.py
Restart=always
RestartSec=5
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/northstar-agent /etc/wireguard /etc/systemd/system

[Install]
WantedBy=multi-user.target
NORTHSTAR_SERVICE
progress agent-staged 88 'Agent files are staged; registering its new identity with the Controller'
`;
    const outputRecorder = new ActionOutputRecorder(actionId, nodeId);
    recorder = outputRecorder;
    const result = await executeRemoteCommand(node, secret, command, (chunk) => outputRecorder.write(chunk));
    await outputRecorder.flush();
    await updateNodeActionProgress(actionId, { phase: "registration", progress: 90, message: "Controller registered the new Agent token; starting the service" });
    await updateNode(nodeId, {
      status: "provisioning",
      version: "agent installed",
      last_seen: "awaiting heartbeat",
      latency: "connected",
      host_fingerprint: node.host_fingerprint || result.fingerprint,
      agent_token_hash: hashToken(agentToken),
    });
    const heartbeatNotBefore = Date.now();
    const startCommand = `set -eu
printf 'NORTHSTAR_PROGRESS|agent-start|93|Starting the registered Agent service\\n'
systemctl daemon-reload
systemctl enable --now northstar-agent
sleep 2
if ! systemctl is-active --quiet northstar-agent; then
  systemctl --no-pager --full status northstar-agent || true
  journalctl -u northstar-agent -n 100 --no-pager || true
  exit 1
fi
systemctl --no-pager --full status northstar-agent
printf 'NORTHSTAR_PROGRESS|heartbeat|96|Agent is active; waiting for its first Controller heartbeat\\n'
`;
    const startResult = await executeRemoteCommand(node, secret, startCommand, (chunk) => outputRecorder.write(chunk));
    await outputRecorder.flush();
    const combinedOutput = `${result.output}\n${startResult.output}`;
    if (!(await waitForAgentHeartbeat(nodeId, heartbeatNotBefore))) {
      let runtimeDiagnostics = "";
      try {
        await updateNodeActionProgress(actionId, { phase: "heartbeat", progress: 96, message: "Heartbeat did not arrive; collecting remote service diagnostics", level: "warning" });
        const diagnostics = await executeRemoteCommand(node, secret, "printf 'NORTHSTAR_PROGRESS|diagnostics|97|Collecting systemd status and recent Agent journal\\n'; systemctl --no-pager --full status northstar-agent || true; journalctl -u northstar-agent -n 100 --no-pager || true", (chunk) => outputRecorder.write(chunk));
        runtimeDiagnostics = diagnostics.output.slice(-12_000);
      } catch (diagnosticError) {
        runtimeDiagnostics = `Unable to collect Agent diagnostics: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`;
      }
      const message = "Agent service installed but the Controller did not receive a heartbeat within 25 seconds. Verify DNS, TLS, firewall access, and the controller public origin.";
      await updateNode(nodeId, { status: "attention", version: "agent heartbeat failed", last_seen: "heartbeat not received", latency: "error" });
      await outputRecorder.flush();
      await finishNodeAction(actionId, "failed", `${combinedOutput.slice(-6000)}\n\n${message}\n\n${runtimeDiagnostics}`.slice(-12_000), message);
      await addAudit({ actorUserId, action: "node.bootstrap.heartbeat_failed", targetType: "node", targetId: nodeId });
      return;
    }
    await ensureDefaultNodeProtocols(nodeId);
    await reconcileEnabledVpnServices(nodeId);
    await finishNodeAction(actionId, "succeeded", combinedOutput.slice(-12000));
    await addAudit({ actorUserId, action: "node.bootstrap.succeeded", targetType: "node", targetId: nodeId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recorder?.flush();
    await updateNode(nodeId, { status: "attention", version: "bootstrap failed", last_seen: "failed" });
    await appendNodeActionEvent(actionId, { level: "error", phase: "failed", message: message.slice(-4000) });
    await finishNodeAction(actionId, "failed", "", message.slice(-4000));
    await addAudit({ actorUserId, action: "node.bootstrap.failed", targetType: "node", targetId: nodeId, metadata: { error: message } });
  }
}

export async function runNodeAction(nodeId: string, action: "restart-agent" | "status-agent", actorUserId?: string, queuedActionId?: string): Promise<string> {
  const node = await findNode(nodeId);
  if (!node) throw new Error("Node not found");
  const actionId = queuedActionId || await addNodeAction(nodeId, action, "running");
  if (await countRunningNodeActions(nodeId, actionId) > 0) throw new Error("This node already has a queued or running action. Wait for it to finish.");
  await startNodeAction(actionId);
  let recorder: ActionOutputRecorder | undefined;
  try {
    const secret = decryptSecret({ ciphertext: node.credential_ciphertext, iv: node.credential_iv, tag: node.credential_tag });
    const command = action === "restart-agent"
      ? "printf 'NORTHSTAR_PROGRESS|restart|30|Requesting a managed Agent restart\\n'; systemctl restart northstar-agent; printf 'NORTHSTAR_PROGRESS|verify|75|Checking service status after restart\\n'; systemctl --no-pager --full status northstar-agent; printf 'NORTHSTAR_PROGRESS|complete|100|Agent restart completed\\n'"
      : "printf 'NORTHSTAR_PROGRESS|check|25|Reading Agent service state\\n'; systemctl is-active --quiet northstar-agent; service_status=$?; systemctl --no-pager --full status northstar-agent || true; printf 'NORTHSTAR_PROGRESS|journal|60|Collecting the latest Agent journal entries\\n'; journalctl -u northstar-agent -n 80 --no-pager || true; if [ $service_status -ne 0 ]; then printf 'NORTHSTAR_PROGRESS|failed|100|Agent service is not active\\n'; exit $service_status; fi; printf 'NORTHSTAR_PROGRESS|complete|100|Agent check completed\\n'";
    const outputRecorder = new ActionOutputRecorder(actionId, nodeId);
    recorder = outputRecorder;
    const actionStartedAt = Date.now();
    const result = await executeRemoteCommand(node, secret, command, (chunk) => outputRecorder.write(chunk));
    await outputRecorder.flush();
    const output = result.output.slice(-12000);
    if (action === "restart-agent") {
      if (!(await waitForAgentHeartbeat(nodeId, actionStartedAt, 35_000))) {
        throw new Error("Agent service restarted, but no authenticated heartbeat reached the Controller. Use Reinstall / repair agent if the node journal reports HTTP 401 Unauthorized.");
      }
    } else {
      const inspectedNode = await findNode(nodeId);
      if (!hasFreshAgentHeartbeat(inspectedNode)) {
        const authenticationRejected = /HTTP (?:Error )?401|Unauthorized|Invalid agent credentials/i.test(output);
        throw new Error(authenticationRejected
          ? "Agent service is running, but the Controller rejected its identity with HTTP 401. Use Reinstall / repair agent to synchronize its credential."
          : "Agent service is running, but the Controller has not received an authenticated heartbeat within 90 seconds.");
      }
    }
    await finishNodeAction(actionId, "succeeded", output);
    await addAudit({ actorUserId, action: `node.${action}.succeeded`, targetType: "node", targetId: nodeId });
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recorder?.flush();
    await appendNodeActionEvent(actionId, { level: "error", phase: "failed", message: message.slice(-4000) });
    await finishNodeAction(actionId, "failed", "", message.slice(-4000));
    await addAudit({ actorUserId, action: `node.${action}.failed`, targetType: "node", targetId: nodeId, metadata: { error: message } });
    await updateNode(nodeId, { status: "attention", last_seen: "failed", latency: "error" });
    return "";
  }
}
