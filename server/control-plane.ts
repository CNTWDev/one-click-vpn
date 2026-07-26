import { addAudit } from "./db";
import {
  activateConnectionProfile,
  allocateIpLease,
  createConnectionProfile,
  enqueueReconcileTask,
  findConnectionProfile,
  findDesiredConfig,
  findDevice,
  listActivePeers,
  listConnectionProfiles,
  listControlNodes,
  listNodeProtocols,
  revokeCertificateIssuancesForDevice,
  revokeDevice,
  upsertDesiredConfig,
  upsertNodeProtocol,
  type ConnectionProfile,
  type Platform,
  type Protocol,
} from "./control-db";
import { getProtocolAdapter } from "./protocols/registry";
import { ensureOpenVpnClientCredential, ensureOpenVpnServerBundle, openVpnRevokedSerials } from "./openvpn-pki";

export function publicDevice(device: Awaited<ReturnType<typeof findDevice>>) {
  if (!device) return null;
  return {
    id: device.id,
    displayName: device.display_name,
    platform: device.platform,
    appVersion: device.app_version,
    publicKey: device.public_key,
    status: device.status,
    createdAt: device.created_at,
    lastSeenAt: device.last_seen_at,
  };
}

export function publicProfile(profile: ConnectionProfile) {
  const protocolPayload = { ...profile.protocol_payload };
  if (profile.protocol === "openvpn") {
    delete protocolPayload.clientKeySecretId;
    delete protocolPayload.tlsCryptSecretId;
  }
  return {
    id: profile.id,
    deviceId: profile.device_id,
    nodeId: profile.node_id,
    revision: profile.revision,
    status: profile.status,
    protocol: profile.protocol,
    transport: profile.transport,
    endpoint: profile.endpoint,
    clientAddress: profile.client_address,
    dns: profile.dns,
    allowedIps: profile.allowed_ips,
    protocolPayload,
    issuedAt: profile.issued_at,
    expiresAt: profile.expires_at,
    updatedAt: profile.updated_at,
  };
}

async function findNode(nodeId: string) {
  return (await listControlNodes()).find((node) => node.id === nodeId);
}

export async function ensureDefaultNodeProtocols(nodeId: string): Promise<void> {
  if ((await listNodeProtocols(nodeId)).length) return;
  for (const protocol of ["wireguard", "openvpn"] as const) {
    const adapter = getProtocolAdapter(protocol);
    await upsertNodeProtocol({
      nodeId, protocol, transports: adapter.capability.transports, platforms: [...adapter.capability.platforms],
      routing: adapter.capability.routing, ipv6: adapter.capability.ipv6,
      minClientVersion: adapter.capability.minClientVersion, configSchemaVersion: adapter.capability.configSchemaVersion,
      status: adapter.capability.status,
    });
  }
}

export async function rebuildDesiredState(nodeId: string, protocol: Protocol) {
  const node = await findNode(nodeId);
  if (!node) throw new Error("Node not found");
  const adapter = getProtocolAdapter(protocol);
  if (adapter.capability.status !== "enabled") throw new Error(`${protocol} adapter is not enabled`);
  const openvpn = protocol === "openvpn" ? await (async () => {
    const bundle = await ensureOpenVpnServerBundle(nodeId, node.name);
    return {
      serverBundleSecretId: bundle.bundleSecretId,
      revokedSerials: await openVpnRevokedSerials(),
      transport: "udp", subnet: "10.71.0.0/24", listenPort: 1194, dns: ["1.1.1.1"],
    };
  })() : undefined;
  const desiredPayload = adapter.buildDesiredState({
    nodeId,
    serverPublicKey: node.server_public_key,
    listenPort: protocol === "wireguard" ? 51820 : undefined,
    peers: await listActivePeers(nodeId, protocol),
    openvpn,
  });
  const previous = await findDesiredConfig(nodeId, protocol);
  const desired = await upsertDesiredConfig({ nodeId, protocol, payload: desiredPayload });
  if (!previous || previous.config_hash !== desired.config_hash) {
    await enqueueReconcileTask({
      nodeId,
      protocol,
      taskType: protocol === "wireguard" ? "ApplyWireGuardPeers" : "ApplyOpenVpnServer",
      desiredRevision: desired.revision,
      payload: desiredPayload,
    });
  }
  return desired;
}

export async function issueConnectionProfile(input: {
  actorUserId?: string;
  deviceId: string;
  nodeId: string;
  protocol: Protocol;
  transport?: string;
  expiresInSeconds?: number;
  rotateCredential?: boolean;
}): Promise<ConnectionProfile> {
  const device = await findDevice(input.deviceId);
  if (!device || device.status !== "active") throw new Error("Device is not active");
  const node = await findNode(input.nodeId);
  if (!node) throw new Error("Node not found");
  const adapter = getProtocolAdapter(input.protocol);
  if (adapter.capability.status !== "enabled") throw new Error(`${input.protocol} adapter is not enabled`);
  const capability = (await listNodeProtocols(input.nodeId)).find((item) => item.protocol === input.protocol);
  if (!capability || capability.status !== "enabled") throw new Error("Node does not advertise this protocol");
  if (input.protocol === "wireguard" && !node.server_public_key) {
    throw new Error("This node is online but has not reported its WireGuard server key. Reinstall or restart the Agent, then wait for a heartbeat.");
  }
  const transport = input.transport || adapter.capability.transports[0];
  if (!adapter.capability.transports.includes(transport)) throw new Error("Unsupported protocol transport");
  const clientAddress = await allocateIpLease(input.nodeId, input.protocol, input.deviceId);
  const openvpnCredential = input.protocol === "openvpn"
    ? await ensureOpenVpnClientCredential(device.id, device.display_name, input.rotateCredential)
    : undefined;
  const profile = adapter.buildProfile({
    deviceId: device.id,
    devicePublicKey: device.public_key,
    nodeId: node.id,
    endpoint: { host: node.public_endpoint || node.ip, port: input.protocol === "wireguard" ? 51820 : 1194 },
    serverPublicKey: node.server_public_key,
    clientAddress,
    transport,
    dns: ["1.1.1.1"],
    allowedIps: adapter.capability.ipv6 ? ["0.0.0.0/0", "::/0"] : ["0.0.0.0/0"],
    openvpn: openvpnCredential ? {
      clientCertificate: openvpnCredential.issuance.certificate_pem,
      clientKeySecretId: openvpnCredential.issuance.private_key_secret_id || "",
      caCertificate: openvpnCredential.authority.certificate_pem,
      tlsCryptSecretId: openvpnCredential.authority.tls_crypt_secret_id || "",
    } : undefined,
  });
  const saved = await createConnectionProfile({
    deviceId: input.deviceId,
    nodeId: input.nodeId,
    protocol: input.protocol,
    transport: profile.transport,
    endpoint: { host: node.public_endpoint || node.ip, port: input.protocol === "wireguard" ? 51820 : 1194 },
    clientAddress,
    dns: profile.dns,
    allowedIps: profile.allowedIps,
    protocolPayload: profile.protocolPayload,
    expiresAt: new Date(Date.now() + (input.expiresInSeconds || 24 * 60 * 60) * 1000).toISOString(),
  });
  await addAudit({ actorUserId: input.actorUserId, action: "profile.issued", targetType: "profile", targetId: saved.id, metadata: { deviceId: input.deviceId, nodeId: input.nodeId, protocol: input.protocol } });
  return saved;
}

export async function activateProfile(profileId: string, actorUserId?: string): Promise<ConnectionProfile> {
  const profile = await findConnectionProfile(profileId);
  if (!profile) throw new Error("Profile not found");
  const activated = await activateConnectionProfile(profileId);
  if (!activated) throw new Error("Profile could not be activated");
  await rebuildDesiredState(activated.node_id, activated.protocol);
  await addAudit({ actorUserId, action: "profile.activated", targetType: "profile", targetId: profileId });
  return activated;
}

export async function revokeDeviceAndReconcile(deviceId: string, actorUserId?: string): Promise<void> {
  const profiles = await listConnectionProfiles({ deviceId });
  await revokeCertificateIssuancesForDevice(deviceId);
  await revokeDevice(deviceId);
  const affected = new Set(profiles.map((profile) => `${profile.node_id}:${profile.protocol}`));
  for (const key of affected) {
    const [nodeId, protocol] = key.split(":") as [string, Protocol];
    try { await rebuildDesiredState(nodeId, protocol); } catch { /* a disabled adapter needs no reconcile */ }
  }
  await addAudit({ actorUserId, action: "device.revoked", targetType: "device", targetId: deviceId });
}

export function protocolForPlatform(platform: Platform, protocol: Protocol): boolean {
  const adapter = getProtocolAdapter(protocol);
  return adapter.capability.platforms.includes(platform);
}
