import { randomUUID } from "node:crypto";
import ssh2, { type ConnectConfig } from "ssh2";
import type { DbNode } from "./db";
import { fingerprintForms, fingerprintsEqual, normalizeFingerprint } from "./ssh-fingerprint.js";

const { Client, utils } = ssh2;

export type SshCredentialType = "password" | "private_key";
export type SshPrivilegeMode = "root" | "sudo";

type RemoteNodeAccess = Pick<DbNode, "ip" | "ssh_port" | "ssh_user" | "credential_type" | "host_fingerprint" | "ssh_privilege_mode">;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export { normalizeFingerprint } from "./ssh-fingerprint.js";

export function credentialType(value: unknown, secret = ""): SshCredentialType {
  if (value === "private_key") return "private_key";
  if (value === "password") return "password";
  return /-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/.test(secret) ? "private_key" : "password";
}

export function privilegeMode(value: unknown, sshUser: string): SshPrivilegeMode {
  if (value === "sudo") return "sudo";
  if (value === "root") return "root";
  return sshUser === "root" ? "root" : "sudo";
}

export function validateSshCredential(type: SshCredentialType, rawSecret: string): string {
  if (!rawSecret || rawSecret.includes("\0")) throw new Error("SSH credential is required");
  if (Buffer.byteLength(rawSecret, "utf8") > 60 * 1024) throw new Error("SSH credential is too large");
  if (type === "password") return rawSecret;
  const secret = `${rawSecret.replaceAll("\r\n", "\n").trim()}\n`;
  const parsed = utils.parseKey(secret);
  if (parsed instanceof Error) {
    if (/encrypted|passphrase/i.test(parsed.message)) throw new Error("Encrypted SSH private keys are not supported yet. Use a dedicated unencrypted deployment key.");
    throw new Error("SSH private key could not be parsed. Use an OpenSSH, RSA, EC, or PKCS#8 private key.");
  }
  if (!parsed.isPrivateKey()) throw new Error("The supplied SSH key is public. A private key is required.");
  return secret;
}

function privilegedCommand(command: string, mode: SshPrivilegeMode): string {
  if (mode === "sudo") {
    return `command -v sudo >/dev/null 2>&1 || { echo 'Northstar requires sudo for this SSH user.' >&2; exit 126; }
sudo -n true >/dev/null 2>&1 || { echo 'Northstar requires passwordless sudo for this SSH user.' >&2; exit 126; }
sudo -n sh -c ${shellQuote(command)}`;
  }
  return `[ "$(id -u)" -eq 0 ] || { echo 'Northstar root mode requires an SSH user with uid 0.' >&2; exit 126; }
${command}`;
}

function connectConfig(node: RemoteNodeAccess, secret: string): ConnectConfig {
  const type = credentialType(node.credential_type, secret);
  return {
    host: node.ip,
    port: node.ssh_port,
    username: node.ssh_user,
    readyTimeout: 15_000,
    ...(type === "private_key" ? { privateKey: secret } : { password: secret }),
  };
}

export function executeRemoteCommand(
  node: RemoteNodeAccess,
  secret: string,
  command: string,
  onOutput?: (chunk: string) => void,
  timeoutMilliseconds = 20 * 60_000,
): Promise<{ output: string; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let output = "";
    let fingerprint = "";
    let settled = false;
    const finish = (error?: Error, result?: { output: string; fingerprint: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.end();
      if (error) reject(error);
      else resolve(result!);
    };
    const timeout = setTimeout(() => finish(new Error(`SSH remote command timed out after ${Math.round(timeoutMilliseconds / 1000)} seconds`)), timeoutMilliseconds);
    const expectedFingerprint = node.host_fingerprint;
    const expected = expectedFingerprint ? normalizeFingerprint(expectedFingerprint) : "";
    client.on("ready", () => {
      client.exec(privilegedCommand(command, privilegeMode(node.ssh_privilege_mode, node.ssh_user)), (error, stream) => {
        if (error) {
          finish(error);
          return;
        }
        stream.on("data", (chunk: Buffer) => { const text = chunk.toString(); output += text; onOutput?.(text); });
        stream.stderr.on("data", (chunk: Buffer) => { const text = chunk.toString(); output += text; onOutput?.(text); });
        stream.on("close", (code: number | null) => {
          if (code === 0) finish(undefined, { output, fingerprint });
          else finish(new Error(`Remote command exited with code ${code ?? "unknown"}: ${output.slice(-4000)}`));
        });
      });
    });
    client.on("error", (error) => {
      if (expected && fingerprint && !fingerprintsEqual(expectedFingerprint!, fingerprint)) {
        finish(new Error(`SSH host fingerprint mismatch. Expected ${expectedFingerprint}; received ${fingerprint}. Verify the node fingerprint from a trusted console.`));
        return;
      }
      finish(error);
    });
    const verifier = ((key: Buffer) => {
      const forms = fingerprintForms(key);
      fingerprint = `SHA256:${forms.standard}`;
      return !expected || fingerprintsEqual(expectedFingerprint!, forms.standard) || fingerprintsEqual(expectedFingerprint!, forms.hex);
    }) as NonNullable<ConnectConfig["hostVerifier"]>;
    client.connect({ ...connectConfig(node, secret), hostVerifier: verifier });
  });
}

export async function testRemoteAccess(node: RemoteNodeAccess, secret: string): Promise<{ fingerprint: string; privilegeMode: SshPrivilegeMode; output: string }> {
  const result = await executeRemoteCommand(node, secret, "printf 'NORTHSTAR_SSH_TEST_OK\\n'; id -un; uname -srm", undefined, 30_000);
  if (!result.output.includes("NORTHSTAR_SSH_TEST_OK")) throw new Error("SSH connection completed without the expected verification response");
  return { fingerprint: result.fingerprint, privilegeMode: privilegeMode(node.ssh_privilege_mode, node.ssh_user), output: result.output };
}

const nodeIdentityPattern = /^nsn_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function discoverRemoteNode(
  node: RemoteNodeAccess,
  secret: string,
): Promise<{ fingerprint: string; nodeIdentity: string; privilegeMode: SshPrivilegeMode }> {
  const candidate = `nsn_${randomUUID()}`;
  const command = `set -eu
identity_dir=/var/lib/northstar
identity_file="$identity_dir/node-id"
install -d -m 0700 "$identity_dir"
if [ ! -s "$identity_file" ]; then
  (set -C; umask 077; printf '%s\\n' ${shellQuote(candidate)} > "$identity_file") 2>/dev/null || true
fi
chown root:root "$identity_file"
chmod 0600 "$identity_file"
identity="$(head -n 1 "$identity_file")"
printf 'NORTHSTAR_NODE_ID=%s\\n' "$identity"`;
  const result = await executeRemoteCommand(node, secret, command, undefined, 30_000);
  const match = result.output.match(/(?:^|\n)NORTHSTAR_NODE_ID=(nsn_[0-9a-f-]+)(?:\n|$)/i);
  const nodeIdentity = match?.[1]?.toLowerCase() || "";
  if (!nodeIdentityPattern.test(nodeIdentity)) {
    throw new Error("The remote Northstar node identity is missing or invalid. Inspect /var/lib/northstar/node-id before retrying.");
  }
  return {
    fingerprint: result.fingerprint,
    nodeIdentity,
    privilegeMode: privilegeMode(node.ssh_privilege_mode, node.ssh_user),
  };
}
