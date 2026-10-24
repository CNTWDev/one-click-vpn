import { execFile } from "node:child_process";
import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { dbExec, dbQuery, withTransaction } from "./db";
import { hashToken } from "./crypto";
import { realitySettings } from "./reality";
import { createSecretMaterial, findSecretMaterialByKind, readSecretMaterial } from "./secret-materials";
import type { VpnService } from "./control-db";
import { nativeUserRows } from "./native-users";

/**
 * Censorship-resistant transports for the Veilbird apps ("stealth" service on a node):
 * Hysteria2 with Salamander obfuscation (UDP, no QUIC fingerprint) and VLESS REALITY over
 * XHTTP (TCP). Both run in one mihomo process managed by the Agent. Every enrolled app device
 * has one secret (a UUID) that is its VLESS id and its Hysteria2 password on every node.
 */

const execFileAsync = promisify(execFile);
// Never on the wire in clear: Salamander hides the QUIC handshake, the client pins the certificate.
export const STEALTH_SNI = "www.bing.com";

export type StealthServer = { obfsPassword: string; certificate: string; privateKey: string; fingerprint: string; xhttpPath: string };

/** Lowercase hex SHA-256 of the certificate, the format mihomo's `fingerprint` pin expects. */
export function certificateFingerprint(pem: string): string {
  return new X509Certificate(pem).fingerprint256.replaceAll(":", "").toLowerCase();
}

async function selfSignedCertificate(): Promise<{ certificate: string; privateKey: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "veilbird-stealth-"));
  try {
    await execFileAsync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", "key.pem", "-out", "cert.pem", "-days", "3650", "-subj", `/CN=${STEALTH_SNI}`, "-addext", `subjectAltName=DNS:${STEALTH_SNI}`], { cwd: directory });
    const [certificate, privateKey] = await Promise.all([readFile(path.join(directory, "cert.pem"), "utf8"), readFile(path.join(directory, "key.pem"), "utf8")]);
    return { certificate, privateKey };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Per-node keys, created once: Salamander password, TLS certificate and the XHTTP path. */
export async function ensureStealthServer(nodeId: string): Promise<{ secretId: string; server: StealthServer }> {
  const existing = await findSecretMaterialByKind("stealth_server", nodeId);
  if (existing) {
    const raw = await readSecretMaterial(existing.id, nodeId);
    if (raw) return { secretId: existing.id, server: JSON.parse(raw) as StealthServer };
  }
  const { certificate, privateKey } = await selfSignedCertificate();
  const server: StealthServer = {
    obfsPassword: randomBytes(24).toString("base64url"), certificate, privateKey,
    fingerprint: certificateFingerprint(certificate), xhttpPath: `/${randomBytes(9).toString("base64url")}`,
  };
  const material = await withTransaction(async (exec) => {
    await exec("SELECT pg_advisory_xact_lock(hashtext($1))", [`stealth:${nodeId}`]);
    // A concurrent builder may have won the lock first; keep its keys.
    const raced = await findSecretMaterialByKind("stealth_server", nodeId);
    return raced || createSecretMaterial({ kind: "stealth_server", ownerNodeId: nodeId, value: JSON.stringify(server) });
  });
  const raw = await readSecretMaterial(material.id, nodeId);
  return { secretId: material.id, server: raw ? JSON.parse(raw) as StealthServer : server };
}

/** The device's secret, created on its first connection. */
export async function ensureNativeSecret(enrollmentId: string): Promise<string> {
  const kind = `native_secret:${enrollmentId}`;
  const row = (await dbQuery<{ id: string }>("SELECT id FROM secret_materials WHERE kind=$1 AND owner_node_id IS NULL ORDER BY created_at LIMIT 1", [kind]))[0];
  if (row) {
    const value = await readSecretMaterial(row.id);
    if (value) return value;
  }
  const value = randomUUID();
  await createSecretMaterial({ kind, value });
  // Two first connections at once: everyone uses the oldest secret.
  const first = (await dbQuery<{ id: string }>("SELECT id FROM secret_materials WHERE kind=$1 AND owner_node_id IS NULL ORDER BY created_at LIMIT 1", [kind]))[0];
  return (await readSecretMaterial(first.id)) || value;
}

/** Encrypted user list for the node, reused while the source rows are unchanged. */
export async function stealthUsersSecret(nodeId: string) {
  const rows = await nativeUserRows();
  const sourceFingerprint = hashToken(JSON.stringify(rows));
  const previous = await findSecretMaterialByKind("stealth_users_bundle", nodeId);
  if (previous?.source_fingerprint === sourceFingerprint) return previous.id;
  const users = await Promise.all(rows.map(async (row) => {
    const id = await readSecretMaterial(row.secret_id);
    if (!id) throw new Error("App device secret unavailable");
    return { id, email: row.email };
  }));
  const value = JSON.stringify(users);
  const material = previous?.fingerprint === hashToken(value) ? previous : await createSecretMaterial({ kind: "stealth_users_bundle", ownerNodeId: nodeId, value });
  await dbExec("UPDATE secret_materials SET source_fingerprint=$1 WHERE id=$2", [sourceFingerprint, material.id]);
  // Bundles no desired state or pending task refers to any more are garbage after a day.
  await dbExec(`DELETE FROM secret_materials s WHERE s.kind='stealth_users_bundle' AND s.owner_node_id=$1 AND s.id<>$2 AND s.created_at<$3
    AND NOT EXISTS (SELECT 1 FROM desired_configs d WHERE d.node_id=$1 AND d.payload_json::jsonb->>'usersSecretId'=s.id)
    AND NOT EXISTS (SELECT 1 FROM reconcile_tasks t WHERE t.node_id=$1 AND t.status IN ('pending','running') AND t.payload_json::jsonb->>'usersSecretId'=s.id)`,
  [nodeId, material.id, new Date(Date.now() - 86400000).toISOString()]);
  return material.id;
}

/** Desired state for the Agent; REALITY keys and target are the node's VLESS ones. */
export async function stealthDesiredState(nodeId: string, listenPort: number) {
  const reality = await realitySettings(nodeId);
  if (!reality) throw new Error("请先启用 VLESS REALITY：抗封锁通道复用它的密钥和目标域名");
  const { secretId } = await ensureStealthServer(nodeId);
  return { serverSecretId: secretId, realitySecretId: reality.secret_id, usersSecretId: await stealthUsersSecret(nodeId), listenPort };
}

type NodeAddress = { id: string; ip: string; public_endpoint: string | null };

/**
 * mihomo proxies for an app device on one node, lightest first after WireGuard (which the app
 * builds itself because only the device knows its private key). Only healthy services are listed.
 */
export async function nativeProxies(node: NodeAddress, enrollmentId: string, services: { vless?: VpnService; stealth?: VpnService }) {
  if (!services.vless && !services.stealth) return [];
  const reality = await realitySettings(node.id);
  if (!reality) return [];
  const uuid = await ensureNativeSecret(enrollmentId);
  const host = node.public_endpoint || node.ip;
  const realityOpts = { "public-key": reality.public_key, "short-id": reality.short_id };
  const stealth = services.stealth && { port: services.stealth.listen_port, server: (await ensureStealthServer(node.id)).server };
  const proxies: Array<Record<string, unknown>> = [];
  if (stealth) proxies.push({ name: "hysteria2", type: "hysteria2", server: host, port: stealth.port, password: uuid,
    obfs: "salamander", "obfs-password": stealth.server.obfsPassword, sni: STEALTH_SNI, "skip-cert-verify": true, fingerprint: stealth.server.fingerprint, alpn: ["h3"] });
  if (services.vless) proxies.push({ name: "reality", type: "vless", server: host, port: services.vless.listen_port, uuid, network: "tcp", tls: true, udp: true,
    flow: "xtls-rprx-vision", servername: reality.server_name, "client-fingerprint": "chrome", "reality-opts": realityOpts });
  if (stealth) proxies.push({ name: "xhttp", type: "vless", server: host, port: stealth.port, uuid, network: "xhttp", tls: true, udp: true,
    servername: reality.server_name, "client-fingerprint": "chrome", "reality-opts": realityOpts, "xhttp-opts": { path: stealth.server.xhttpPath } });
  return proxies;
}
