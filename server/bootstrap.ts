import { readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Client, type ConnectConfig } from "ssh2";
import { allowTofuHostKeys, publicOrigin } from "./config";
import { decryptSecret, hashToken } from "./crypto";
import { addAudit, addNodeAction, findNode, finishNodeAction, updateNode } from "./db";
import { ensureDefaultNodeProtocols } from "./control-plane";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function agentSource(): string {
  return readFileSync(path.join(process.cwd(), "agent", "agent.py"), "utf8");
}

function connectAndExec(config: ConnectConfig, command: string, expectedFingerprint: string | null): Promise<{ output: string; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let output = "";
    let fingerprint = "";
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
    client.on("error", reject);
    const verifier = ((keyHash: string) => {
      fingerprint = keyHash;
      return !expectedFingerprint || keyHash === expectedFingerprint;
    }) as NonNullable<ConnectConfig["hostVerifier"]>;
    client.connect({
      ...config,
      hostHash: "sha256",
      hostVerifier: verifier,
    });
  });
}

export function queueNodeBootstrap(nodeId: string, actorUserId?: string): void {
  setImmediate(() => {
    void bootstrapNode(nodeId, actorUserId);
  });
}

export async function bootstrapNode(nodeId: string, actorUserId?: string): Promise<void> {
  const node = findNode(nodeId);
  if (!node) return;
  const actionId = addNodeAction(nodeId, "bootstrap");
  updateNode(nodeId, { status: "provisioning", version: "bootstrap running", last_seen: "connecting" });

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
if ! command -v wg >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y
    DEBIAN_FRONTEND=noninteractive apt-get install -y wireguard-tools
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y wireguard-tools
  elif command -v yum >/dev/null 2>&1; then
    yum install -y wireguard-tools
  elif command -v apk >/dev/null 2>&1; then
    apk add wireguard-tools
  else
    echo "wireguard-tools is not installed and no supported package manager was found" >&2
    exit 1
  fi
fi
install -d -m 700 /opt/northstar-agent
echo ${shellQuote(source)} | base64 -d > /opt/northstar-agent/agent.py
cat > /opt/northstar-agent/config.env <<'NORTHSTAR_CONFIG'
NORTHSTAR_CONTROLLER_URL=${publicOrigin()}
NORTHSTAR_NODE_ID=${node.id}
NORTHSTAR_AGENT_TOKEN=${agentToken}
NORTHSTAR_AGENT_STATE_DIR=/opt/northstar-agent/state
NORTHSTAR_CONFIG
chmod 600 /opt/northstar-agent/config.env
cat > /etc/systemd/system/northstar-agent.service <<'NORTHSTAR_SERVICE'
[Unit]
Description=Northstar outbound node agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/opt/northstar-agent/config.env
ExecStart=/usr/bin/python3 /opt/northstar-agent/agent.py
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
    updateNode(nodeId, {
      status: "online",
      version: "agent 1.0.0",
      last_seen: "now",
      latency: "connected",
      host_fingerprint: node.host_fingerprint || result.fingerprint,
      agent_token_hash: hashToken(agentToken),
    });
    ensureDefaultNodeProtocols(nodeId);
    finishNodeAction(actionId, "succeeded", result.output.slice(-12000));
    addAudit({ actorUserId, action: "node.bootstrap.succeeded", targetType: "node", targetId: nodeId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateNode(nodeId, { status: "attention", version: "bootstrap failed", last_seen: "failed" });
    finishNodeAction(actionId, "failed", "", message.slice(-4000));
    addAudit({ actorUserId, action: "node.bootstrap.failed", targetType: "node", targetId: nodeId, metadata: { error: message } });
  }
}

export async function runNodeAction(nodeId: string, action: "restart-agent" | "status-agent", actorUserId?: string): Promise<string> {
  const node = findNode(nodeId);
  if (!node) throw new Error("Node not found");
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
  addAudit({ actorUserId, action: `node.${action}.succeeded`, targetType: "node", targetId: nodeId });
  updateNode(nodeId, { status: "online", last_seen: "now", latency: "connected" });
  return result.output.slice(-12000);
}
