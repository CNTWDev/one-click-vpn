import { addAudit } from "./db";
import {
  activateConnectionProfile,
  allocateIpLease,
  createConnectionProfile,
  enqueueReconcileTask,
  findConnectionProfile,
  findDesiredConfig,
  findDevice,
  findVpnService,
  listActivePeers,
  listConnectionProfiles,
  listControlNodes,
  listNodeProtocols,
  listVpnServices,
  revokeCertificateIssuancesForDevice,
  revokeDevice,
  upsertDesiredConfig,
  upsertNodeProtocol,
  type ConnectionProfile,
  type Platform,
  type Protocol,
} from "./control-db";
import { getProtocolAdapter, listProtocolAdapters } from "./protocols/registry";
import { ensureOpenVpnClientCredential, ensureOpenVpnServerBundle, openVpnRevokedSerials } from "./openvpn-pki";
import { createSecretMaterial, deleteSecretMaterialsByKind, readSecretMaterial } from "./secret-materials";

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

export function publicProfile(profile: ConnectionProfile, region?: { code: string; name: string }, device?: { display_name: string }) {
  const protocolPayload = { ...profile.protocol_payload };
  if (profile.protocol === "openvpn") {
    delete protocolPayload.clientKeySecretId;
    delete protocolPayload.tlsCryptSecretId;
  }
  if (profile.protocol === "wireguard") delete protocolPayload.clientPrivateKeySecretId;
  return {
    id: profile.id,
    deviceId: profile.device_id,
    displayName: device?.display_name || null,
    nodeId: profile.node_id,
    regionCode: region?.code || null,
    regionName: region?.name || null,
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
  for (const adapter of listProtocolAdapters()) {
    const protocol = adapter.id;
    await upsertNodeProtocol({
      nodeId, protocol, transports: adapter.capability.transports, platforms: [...adapter.capability.platforms],
      routing: adapter.capability.routing, ipv6: adapter.capability.ipv6,
      minClientVersion: adapter.capability.minClientVersion, configSchemaVersion: adapter.capability.configSchemaVersion,
      status: adapter.capability.status,
    });
  }
}

export async function rebuildDesiredState(nodeId: string, protocol: Protocol, options: { force?: boolean } = {}) {
  const node = await findNode(nodeId);
  if (!node) throw new Error("Node not found");
  const adapter = getProtocolAdapter(protocol);
  if (adapter.capability.status !== "enabled") throw new Error(`${protocol} adapter is not enabled`);
  const service = await findVpnService(nodeId, protocol);
  if (!service?.enabled) throw new Error(`${protocol} service is not enabled on this node`);
  const openvpn = protocol === "openvpn" ? await (async () => {
    const bundle = await ensureOpenVpnServerBundle(nodeId, node.name);
    return {
      serverBundleSecretId: bundle.bundleSecretId,
      revokedSerials: await openVpnRevokedSerials(),
      transport: service.transport, subnet: service.subnet, listenPort: service.listen_port, dns: service.dns,
    };
  })() : undefined;
  const desiredPayload = adapter.buildDesiredState({
    nodeId,
    serverPublicKey: node.server_public_key,
    listenPort: protocol === "wireguard" ? service.listen_port : undefined,
    peers: await listActivePeers(nodeId, protocol),
    openvpn,
  });
  const previous = await findDesiredConfig(nodeId, protocol);
  const desired = await upsertDesiredConfig({ nodeId, protocol, payload: desiredPayload });
  if (options.force || !previous || previous.config_hash !== desired.config_hash) {
    await enqueueReconcileTask({
      nodeId,
      protocol,
      taskType: adapter.service.applyTask,
      desiredRevision: desired.revision,
      payload: desiredPayload,
    });
  }
  return desired;
}

export async function selectVpnService(input: { protocol: Protocol; regionId?: string }) {
  const candidates = await selectVpnServices(input);
  const selected = candidates[0];
  if (!selected) throw new Error(input.regionId ? "No healthy VPN service is available in this region" : "No healthy VPN service is available");
  return selected;
}

export async function selectVpnServices(input: { protocol: Protocol; regionId?: string }) {
  const services = (await listVpnServices()).filter((service) => service.protocol === input.protocol && service.enabled && service.status === "healthy");
  const nodes = await listControlNodes();
  const activeProfiles = await listConnectionProfiles({ status: "active" });
  const profileCounts = new Map<string, number>();
  for (const profile of activeProfiles) profileCounts.set(profile.node_id, (profileCounts.get(profile.node_id) || 0) + 1);
  const advertised = new Map<string, boolean>();
  await Promise.all(nodes.map(async (node) => {
    const capability = (await listNodeProtocols(node.id)).find((item) => item.protocol === input.protocol);
    advertised.set(node.id, capability?.status === "enabled");
  }));
  return nodes.filter((node) => {
    if (!services.some((service) => service.node_id === node.id)) return false;
    if (!advertised.get(node.id)) return false;
    if (input.regionId && node.region_id !== input.regionId) return false;
    if (node.status !== "online" || !node.last_heartbeat_at) return false;
    if (Date.now() - new Date(node.last_heartbeat_at).getTime() >= 90_000) return false;
    const connectivity = node.capabilities.connectivity as { protocols?: Record<string, { runtimeActive?: boolean; interfaceActive?: boolean; serviceActive?: boolean; listening?: boolean }> } | undefined;
    const observed = connectivity?.protocols?.[input.protocol];
    const active = observed?.runtimeActive ?? observed?.interfaceActive ?? observed?.serviceActive;
    return active === true && observed?.listening === true;
  }).sort((left, right) => left.users - right.users || (profileCounts.get(left.id) || 0) - (profileCounts.get(right.id) || 0) || left.name.localeCompare(right.name))
    .map((node) => ({ node, service: services.find((item) => item.node_id === node.id)! }));
}

export async function issueScheduledConnectionProfile(input: Omit<Parameters<typeof issueConnectionProfile>[0], "nodeId"> & { regionId?: string }): Promise<ConnectionProfile> {
  const selected = await selectVpnService({ protocol: input.protocol, regionId: input.regionId });
  return issueConnectionProfile({ ...input, nodeId: selected.node.id });
}

export async function issueRegionalConnectionProfiles(input: Omit<Parameters<typeof issueConnectionProfile>[0], "nodeId" | "regionalEndpoints"> & { regionId?: string }): Promise<ConnectionProfile[]> {
  const candidates = await selectVpnServices({ protocol: input.protocol, regionId: input.regionId });
  if (!candidates.length) throw new Error(input.regionId ? "No healthy VPN service is available in this region" : "No healthy VPN service is available");
  const regionalCandidates = input.regionId ? candidates : candidates.slice(0, 1);
  if (input.protocol === "wireguard") {
    const profiles: ConnectionProfile[] = [];
    let firstError: unknown;
    for (const candidate of regionalCandidates) {
      try {
        profiles.push(await issueConnectionProfile({ ...input, nodeId: candidate.node.id }));
      } catch (error) {
        firstError ??= error;
        await addAudit({
          actorUserId: input.actorUserId,
          action: "profile.issue.skipped",
          targetType: "node",
          targetId: candidate.node.id,
          metadata: { protocol: input.protocol, reason: error instanceof Error ? error.message : "Unknown profile issuance error" },
        });
      }
    }
    if (!profiles.length) throw firstError instanceof Error ? firstError : new Error("No WireGuard profile could be issued in this region");
    return profiles;
  }
  if (input.protocol === "openvpn") {
    const primary = regionalCandidates[0];
    return [await issueConnectionProfile({
      ...input,
      nodeId: primary.node.id,
      regionalEndpoints: regionalCandidates.map((candidate) => ({
        nodeId: candidate.node.id,
        host: candidate.node.public_endpoint || candidate.node.ip,
        port: candidate.service.listen_port,
        transport: candidate.service.transport,
      })),
    })];
  }
  return [await issueConnectionProfile({ ...input, nodeId: regionalCandidates[0].node.id })];
}

export async function issueConnectionProfile(input: {
  actorUserId?: string;
  deviceId: string;
  nodeId: string;
  protocol: Protocol;
  transport?: string;
  expiresInSeconds?: number;
  rotateCredential?: boolean;
  clientPrivateKey?: string;
  regionalEndpoints?: Array<{ nodeId: string; host: string; port: number; transport: string }>;
}): Promise<ConnectionProfile> {
  const device = await findDevice(input.deviceId);
  if (!device || device.status !== "active") throw new Error("Device is not active");
  const node = await findNode(input.nodeId);
  if (!node) throw new Error("Node not found");
  const adapter = getProtocolAdapter(input.protocol);
  if (adapter.capability.status !== "enabled") throw new Error(`${input.protocol} adapter is not enabled`);
  const capability = (await listNodeProtocols(input.nodeId)).find((item) => item.protocol === input.protocol);
  if (!capability || capability.status !== "enabled") throw new Error("Node does not advertise this protocol");
  const service = await findVpnService(input.nodeId, input.protocol);
  if (!service?.enabled || service.status !== "healthy") throw new Error("VPN service is not ready on this node");
  if (input.protocol === "wireguard" && !node.server_public_key) {
    throw new Error("This node is online but has not reported its WireGuard server key. Reinstall or restart the Agent, then wait for a heartbeat.");
  }
  const transport = input.transport || adapter.capability.transports[0];
  if (!adapter.capability.transports.includes(transport)) throw new Error("Unsupported protocol transport");
  const clientAddress = await allocateIpLease(input.nodeId, input.protocol, input.deviceId);
  const openvpnCredential = input.protocol === "openvpn"
    ? await ensureOpenVpnClientCredential(device.id, input.rotateCredential)
    : undefined;
  const profile = adapter.buildProfile({
    deviceId: device.id,
    devicePublicKey: device.public_key,
    nodeId: node.id,
    endpoint: { host: node.public_endpoint || node.ip, port: service.listen_port },
    serverPublicKey: node.server_public_key,
    clientAddress,
    transport: service.transport || transport,
    dns: service.dns,
    allowedIps: adapter.capability.ipv6 ? ["0.0.0.0/0", "::/0"] : ["0.0.0.0/0"],
    openvpn: openvpnCredential ? {
      clientCertificate: openvpnCredential.issuance.certificate_pem,
      clientKeySecretId: openvpnCredential.issuance.private_key_secret_id || "",
      caCertificate: openvpnCredential.authority.certificate_pem,
      tlsCryptSecretId: openvpnCredential.authority.tls_crypt_secret_id || "",
    } : undefined,
  });
  if (input.regionalEndpoints?.length) profile.protocolPayload.regionalEndpoints = input.regionalEndpoints;
  if (input.protocol === "wireguard") {
    if (!isWireGuardPrivateKey(input.clientPrivateKey)) throw new Error("A valid WireGuard private key is required to create an exportable profile");
    const privateKey = await createSecretMaterial({ kind: `wireguard_client_private_key:${device.id}`, value: input.clientPrivateKey });
    profile.protocolPayload.clientPrivateKeySecretId = privateKey.id;
  }
  const saved = await createConnectionProfile({
    deviceId: input.deviceId,
    nodeId: input.nodeId,
    protocol: input.protocol,
    transport: profile.transport,
    endpoint: { host: node.public_endpoint || node.ip, port: service.listen_port },
    clientAddress,
    dns: profile.dns,
    allowedIps: profile.allowedIps,
    protocolPayload: profile.protocolPayload,
    expiresAt: new Date(Date.now() + (input.expiresInSeconds || 24 * 60 * 60) * 1000).toISOString(),
  });
  if (input.protocol === "openvpn" && input.rotateCredential) await reconcileAllOpenVpnNodes();
  await addAudit({ actorUserId: input.actorUserId, action: "profile.issued", targetType: "profile", targetId: saved.id, metadata: { deviceId: input.deviceId, nodeId: input.nodeId, protocol: input.protocol } });
  return saved;
}

async function reconcileAllOpenVpnNodes(): Promise<void> {
  const services = (await listVpnServices()).filter((service) => service.protocol === "openvpn" && service.enabled);
  for (const service of services) {
    try { await rebuildDesiredState(service.node_id, "openvpn", { force: true }); } catch { /* offline nodes reconcile after their next heartbeat */ }
  }
}

function isWireGuardPrivateKey(value: string | undefined): value is string {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  return Buffer.from(value, "base64").length === 32;
}

export async function renderWireGuardProfile(profile: ConnectionProfile): Promise<string> {
  const serverPublicKey = typeof profile.protocol_payload.serverPublicKey === "string" ? profile.protocol_payload.serverPublicKey : "";
  const privateKeySecretId = typeof profile.protocol_payload.clientPrivateKeySecretId === "string" ? profile.protocol_payload.clientPrivateKeySecretId : "";
  const privateKey = privateKeySecretId ? await readSecretMaterial(privateKeySecretId) : undefined;
  if (!serverPublicKey || !privateKey || !profile.client_address) {
    throw new Error("WireGuard client key material is unavailable. Create a new profile for this device.");
  }
  return [
    "[Interface]", `PrivateKey = ${privateKey}`, `Address = ${profile.client_address}`, `DNS = ${profile.dns.join(", ")}`,
    "", "[Peer]", `PublicKey = ${serverPublicKey}`, `Endpoint = ${profile.endpoint.host}:${profile.endpoint.port}`,
    `AllowedIPs = ${profile.allowed_ips.join(", ")}`, "PersistentKeepalive = 25", "",
  ].join("\n");
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
  const hasOpenVpnProfile = profiles.some((profile) => profile.protocol === "openvpn");
  await revokeCertificateIssuancesForDevice(deviceId);
  await deleteSecretMaterialsByKind(`wireguard_client_private_key:${deviceId}`);
  await revokeDevice(deviceId);
  const affected = new Set(profiles.map((profile) => `${profile.node_id}:${profile.protocol}`));
  for (const key of affected) {
    const [nodeId, protocol] = key.split(":") as [string, Protocol];
    if (protocol === "openvpn") continue;
    try { await rebuildDesiredState(nodeId, protocol); } catch { /* a disabled adapter needs no reconcile */ }
  }
  if (hasOpenVpnProfile) await reconcileAllOpenVpnNodes();
  await addAudit({ actorUserId, action: "device.revoked", targetType: "device", targetId: deviceId });
}

export function protocolForPlatform(platform: Platform, protocol: Protocol): boolean {
  const adapter = getProtocolAdapter(protocol);
  return adapter.capability.platforms.includes(platform);
}
