import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Client, type ConnectConfig } from "ssh2";
import { allowTofuHostKeys, publicOrigin } from "./config";
import { decryptSecret, hashToken } from "./crypto";
import { addAudit, addNodeAction, countRunningNodeActions, findNode, finishNodeAction, updateNode } from "./db";
import { ensureDefaultNodeProtocols } from "./control-plane";

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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function fingerprintForms(key: Buffer): { standard: string; hex: string } {
  const digest = createHash("sha256").update(key).digest();
  return {
    standard: digest.toString("base64").replace(/=+$/, "").toLowerCase(),
    hex: digest.toString("hex").toLowerCase(),
  };
}

function normalizeFingerprint(value: string): string {
  const input = value.trim();
  const sha256 = input.match(/SHA256:([A-Za-z0-9+/]+={0,2})/i);
  if (sha256) return sha256[1].replace(/=+$/, "").toLowerCase();
  const hex = input.match(/(?:^|\s)([a-f0-9]{64})(?:\s|$)/i);
  if (hex) return hex[1].toLowerCase();
  return input.replace(/^sha256:/i, "").replace(/=+$/, "").toLowerCase();
}

function agentSource(): string {
  return readFileSync(path.join(process.cwd(), "agent", "agent.py"), "utf8");
}

function connectAndExec(config: ConnectConfig, command: string, expectedFingerprint: string | null): Promise<{ output: string; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let output = "";
    let fingerprint = "";
    const expected = expectedFingerprint ? normalizeFingerprint(expectedFingerprint) : "";
    client.on("ready", () => {
      client.exec(command, (error, stream) => {
        if (error) {
          client.end();
          reject(error);
          return;
        }
        stream.on("data", (chunk: Buffer) => { output += chunk.toString(); });
        stream.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
        stream.on("close", (code: number) => {
          client.end();
          if (code === 0) resolve({ output, fingerprint });
          else reject(new Error(`Remote bootstrap exited with code ${code}: ${output.slice(-4000)}`));
        });
      });
    });
    client.on("error", (error) => {
      if (expected && fingerprint) {
        const received = normalizeFingerprint(fingerprint);
        if (expected !== received) {
          reject(new Error(`SSH host fingerprint mismatch. Expected ${expectedFingerprint}; received ${fingerprint}. Verify the node fingerprint from a trusted console.`));
          return;
        }
      }
      reject(error);
    });
    const verifier = ((key: Buffer) => {
      const forms = fingerprintForms(key);
      fingerprint = `SHA256:${forms.standard}`;
      return !expected || expected === forms.standard || expected === forms.hex;
    }) as NonNullable<ConnectConfig["hostVerifier"]>;
    client.connect({
      ...config,
      hostVerifier: verifier,
    });
  });
}

export function queueNodeBootstrap(nodeId: string, actorUserId?: string): void {
  enqueueRemoteAction(() => bootstrapNode(nodeId, actorUserId));
}

export function queueNodeAction(nodeId: string, action: "restart-agent" | "status-agent", actorUserId?: string): void {
  enqueueRemoteAction(async () => {
    await runNodeAction(nodeId, action, actorUserId);
  });
}

export async function bootstrapNode(nodeId: string, actorUserId?: string): Promise<void> {
  const node = await findNode(nodeId);
  if (!node) return;
  const actionId = await addNodeAction(nodeId, "bootstrap");
  await updateNode(nodeId, { status: "provisioning", version: "bootstrap running", last_seen: "connecting" });

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
    const expectedFingerprint = node.host_fingerprint;
    const source = Buffer.from(agentSource(), "utf8").toString("base64");
    const command = `set -eu
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
    exit 1
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
    exit 1
  fi
}
install_wireguard_tools
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
python_path=$(command -v python3 || true)
if [ -z "$python_path" ] || [ ! -x "$python_path" ]; then
  echo "Unable to locate an executable python3 after installation" >&2
  exit 1
fi
install -d -m 700 /opt/northstar-agent
echo ${shellQuote(source)} | base64 -d > /opt/northstar-agent/agent.py
if command -v wg >/dev/null 2>&1; then
  install -d -m 700 /opt/northstar-agent/state/wireguard
  if [ ! -s /opt/northstar-agent/state/wireguard/server.key ]; then
    (umask 077; wg genkey > /opt/northstar-agent/state/wireguard/server.key)
  fi
  chmod 600 /opt/northstar-agent/state/wireguard/server.key
fi
cat > /opt/northstar-agent/config.env <<'NORTHSTAR_CONFIG'
NORTHSTAR_CONTROLLER_URL=${publicOrigin()}
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
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
CapabilityBoundingSet=CAP_NET_ADMIN
AmbientCapabilities=CAP_NET_ADMIN
ReadWritePaths=/opt/northstar-agent /etc/wireguard

[Install]
WantedBy=multi-user.target
NORTHSTAR_SERVICE
systemctl daemon-reload
systemctl enable --now northstar-agent
systemctl --no-pager --full status northstar-agent
`;
    const config: ConnectConfig = {
      host: node.ip,
      port: node.ssh_port,
      username: node.ssh_user,
      readyTimeout: 15_000,
      ...(node.credential_type === "private_key" ? { privateKey: secret } : { password: secret }),
    };
    const result = await connectAndExec(config, command, expectedFingerprint);
    await updateNode(nodeId, {
      status: "provisioning",
      version: "agent installed",
      last_seen: "awaiting heartbeat",
      latency: "connected",
      host_fingerprint: node.host_fingerprint || result.fingerprint,
      agent_token_hash: hashToken(agentToken),
    });
    await ensureDefaultNodeProtocols(nodeId);
    await finishNodeAction(actionId, "succeeded", result.output.slice(-12000));
    await addAudit({ actorUserId, action: "node.bootstrap.succeeded", targetType: "node", targetId: nodeId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateNode(nodeId, { status: "attention", version: "bootstrap failed", last_seen: "failed" });
    await finishNodeAction(actionId, "failed", "", message.slice(-4000));
    await addAudit({ actorUserId, action: "node.bootstrap.failed", targetType: "node", targetId: nodeId, metadata: { error: message } });
  }
}

export async function runNodeAction(nodeId: string, action: "restart-agent" | "status-agent", actorUserId?: string): Promise<string> {
  const node = await findNode(nodeId);
  if (!node) throw new Error("Node not found");
  if (await countRunningNodeActions(nodeId) > 0) throw new Error("This node already has a running action. Wait for it to finish.");
  const actionId = await addNodeAction(nodeId, action);
  try {
    const secret = decryptSecret({ ciphertext: node.credential_ciphertext, iv: node.credential_iv, tag: node.credential_tag });
    const command = action === "restart-agent"
      ? "systemctl restart northstar-agent && systemctl --no-pager --full status northstar-agent"
      : "systemctl --no-pager --full status northstar-agent";
    const config: ConnectConfig = {
      host: node.ip,
      port: node.ssh_port,
      username: node.ssh_user,
      readyTimeout: 15_000,
      ...(node.credential_type === "private_key" ? { privateKey: secret } : { password: secret }),
    };
    const result = await connectAndExec(config, command, node.host_fingerprint);
    const output = result.output.slice(-12000);
    await finishNodeAction(actionId, "succeeded", output);
    await addAudit({ actorUserId, action: `node.${action}.succeeded`, targetType: "node", targetId: nodeId });
    await updateNode(nodeId, { status: "online", last_seen: "now", latency: "connected" });
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishNodeAction(actionId, "failed", "", message.slice(-4000));
    await addAudit({ actorUserId, action: `node.${action}.failed`, targetType: "node", targetId: nodeId, metadata: { error: message } });
    await updateNode(nodeId, { status: "attention", last_seen: "failed", latency: "error" });
    throw error;
  }
}
