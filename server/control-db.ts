import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dbExec, dbQuery, findUserById, type DbNode, type DbUser } from "./db";
import { hashToken } from "./crypto";

export type Platform = "macos" | "ios" | "android";
export type Protocol = "wireguard" | "openvpn" | "ikev2";
export type DeviceStatus = "pending" | "active" | "revoked";
export type ProfileStatus = "issued" | "active" | "expired" | "revoked";

export type Device = {
  id: string;
  user_id: string;
  display_name: string;
  platform: Platform;
  app_version: string;
  public_key: string;
  status: DeviceStatus;
  created_at: string;
  last_seen_at: string | null;
  updated_at: string;
};

export type NodeProtocol = {
  node_id: string;
  protocol: Protocol;
  transports: string[];
  platforms: Platform[];
  routing: string[];
  ipv6: boolean;
  min_client_version: string | null;
  config_schema_version: number;
  status: string;
  updated_at: string;
};

export type VpnServiceStatus = "pending" | "deploying" | "healthy" | "attention" | "disabled" | "unsupported";

export type VpnService = {
  node_id: string;
  protocol: Protocol;
  enabled: boolean;
  transport: string;
  listen_port: number;
  subnet: string;
  dns: string[];
  status: VpnServiceStatus;
  last_error: string;
  created_at: string;
  updated_at: string;
};

export type ConnectionProfile = {
  id: string;
  device_id: string;
  node_id: string;
  protocol: Protocol;
  transport: string;
  revision: number;
  status: ProfileStatus;
  endpoint: { host: string; port: number };
  client_address: string | null;
  dns: string[];
  allowed_ips: string[];
  protocol_payload: Record<string, unknown>;
  issued_at: string;
  expires_at: string;
  updated_at: string;
};

export type DesiredConfig = {
  id: string;
  node_id: string;
  protocol: Protocol;
  revision: number;
  config_hash: string;
  payload: Record<string, unknown>;
  status: string;
  updated_at: string;
};

export type ReconcileTask = {
  id: string;
  node_id: string;
  protocol: Protocol;
  task_type: string;
  desired_revision: number;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  last_error: string;
  created_at: string;
  started_at: string | null;
};

export type ApiSession = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
};

export type CredentialAuthority = {
  id: string;
  realm: string;
  protocol: Protocol;
  status: "active" | "retired" | "revoked";
  certificate_pem: string;
  private_key_secret_id: string;
  tls_crypt_secret_id: string | null;
  not_before: string;
  not_after: string;
  created_at: string;
  updated_at: string;
};

export type CertificateIssuance = {
  id: string;
  authority_id: string;
  node_id: string | null;
  device_id: string | null;
  purpose: "server" | "client";
  serial: string;
  subject: string;
  certificate_pem: string;
  private_key_secret_id: string | null;
  status: "active" | "revoked" | "expired";
  not_before: string;
  not_after: string;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

function now(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export async function ensureControlPlaneSchema(): Promise<void> {
  await dbQuery("SELECT 1");
}

export async function findActiveCredentialAuthority(realm: string, protocol: Protocol): Promise<CredentialAuthority | undefined> {
  return (await dbQuery<CredentialAuthority>(`SELECT * FROM credential_authorities
    WHERE realm = $1 AND protocol = $2 AND status = 'active' ORDER BY created_at DESC LIMIT 1`, [realm, protocol]))[0];
}

export async function createCredentialAuthority(input: Omit<CredentialAuthority, "id" | "created_at" | "updated_at" | "status"> & { status?: CredentialAuthority["status"] }): Promise<CredentialAuthority> {
  const id = `authority_${randomUUID()}`;
  const timestamp = now();
  await dbExec(`INSERT INTO credential_authorities
    (id, realm, protocol, status, certificate_pem, private_key_secret_id, tls_crypt_secret_id, not_before, not_after, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`, [
    id, input.realm, input.protocol, input.status || "active", input.certificate_pem,
    input.private_key_secret_id, input.tls_crypt_secret_id, input.not_before, input.not_after, timestamp,
  ]);
  return (await dbQuery<CredentialAuthority>("SELECT * FROM credential_authorities WHERE id = $1", [id]))[0]!;
}

export async function findActiveCertificateIssuance(input: { authorityId: string; nodeId?: string; deviceId?: string; purpose: CertificateIssuance["purpose"] }): Promise<CertificateIssuance | undefined> {
  const field = input.nodeId ? "node_id" : "device_id";
  const owner = input.nodeId || input.deviceId;
  if (!owner) return undefined;
  return (await dbQuery<CertificateIssuance>(`SELECT * FROM certificate_issuances
    WHERE authority_id = $1 AND ${field} = $2 AND purpose = $3 AND status = 'active'
    ORDER BY created_at DESC LIMIT 1`, [input.authorityId, owner, input.purpose]))[0];
}

export async function createCertificateIssuance(input: Omit<CertificateIssuance, "id" | "created_at" | "updated_at" | "status" | "revoked_at"> & { status?: CertificateIssuance["status"] }): Promise<CertificateIssuance> {
  const id = `cert_${randomUUID()}`;
  const timestamp = now();
  await dbExec(`INSERT INTO certificate_issuances
    (id, authority_id, node_id, device_id, purpose, serial, subject, certificate_pem, private_key_secret_id, status, not_before, not_after, revoked_at, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL, $13, $13)`, [
    id, input.authority_id, input.node_id, input.device_id, input.purpose, input.serial, input.subject,
    input.certificate_pem, input.private_key_secret_id, input.status || "active", input.not_before, input.not_after, timestamp,
  ]);
  return (await dbQuery<CertificateIssuance>("SELECT * FROM certificate_issuances WHERE id = $1", [id]))[0]!;
}

export async function listRevokedCertificateSerials(authorityId: string): Promise<string[]> {
  const rows = await dbQuery<{ serial: string }>("SELECT serial FROM certificate_issuances WHERE authority_id = $1 AND status = 'revoked' ORDER BY revoked_at", [authorityId]);
  return rows.map((row) => row.serial);
}

export async function revokeCertificateIssuancesForDevice(deviceId: string): Promise<void> {
  await dbExec(`UPDATE certificate_issuances SET status = 'revoked', revoked_at = $1, updated_at = $1
    WHERE device_id = $2 AND status = 'active'`, [now(), deviceId]);
}

export async function revokeCertificateIssuance(id: string): Promise<void> {
  await dbExec(`UPDATE certificate_issuances SET status = 'revoked', revoked_at = $1, updated_at = $1
    WHERE id = $2 AND status = 'active'`, [now(), id]);
}

export async function createDevice(input: {
  userId: string;
  displayName: string;
  platform: Platform;
  appVersion: string;
  publicKey: string;
}): Promise<Device> {
  const id = `dev_${randomUUID()}`;
  const timestamp = now();
  await dbExec(`INSERT INTO devices
    (id, user_id, display_name, platform, app_version, public_key, status, created_at, last_seen_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $7, $7)`, [id, input.userId, input.displayName, input.platform, input.appVersion, input.publicKey, timestamp]);
  return (await findDevice(id))!;
}

export async function listDevices(userId?: string): Promise<Device[]> {
  return userId
    ? dbQuery<Device>("SELECT * FROM devices WHERE user_id = $1 ORDER BY created_at DESC", [userId])
    : dbQuery<Device>("SELECT * FROM devices ORDER BY created_at DESC");
}

export async function findDevice(id: string): Promise<Device | undefined> {
  const rows = await dbQuery<Device>("SELECT * FROM devices WHERE id = $1", [id]);
  return rows[0];
}

export async function revokeDevice(id: string): Promise<Device | undefined> {
  await dbExec("UPDATE devices SET status = 'revoked', updated_at = $1 WHERE id = $2", [now(), id]);
  await dbExec("UPDATE protocol_credentials SET status = 'revoked', revoked_at = $1 WHERE device_id = $2 AND status = 'active'", [now(), id]);
  await dbExec("UPDATE ip_leases SET status = 'released', released_at = $1 WHERE device_id = $2 AND status = 'active'", [now(), id]);
  await dbExec("UPDATE connection_profiles SET status = 'revoked', updated_at = $1 WHERE device_id = $2 AND status IN ('issued', 'active')", [now(), id]);
  return findDevice(id);
}

export async function touchDevice(id: string): Promise<void> {
  const timestamp = now();
  await dbExec("UPDATE devices SET last_seen_at = $1, updated_at = $2 WHERE id = $3", [timestamp, timestamp, id]);
}

export async function createApiSession(userId: string): Promise<ApiSession> {
  const accessToken = randomBytes(32).toString("base64url");
  const refreshToken = randomBytes(48).toString("base64url");
  const accessExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await dbExec(`INSERT INTO device_sessions
    (id, user_id, access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
    `session_${randomUUID()}`, userId, hashToken(accessToken), hashToken(refreshToken), accessExpiresAt, refreshExpiresAt, now(),
  ]);
  return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
}

export async function findApiUserByAccessToken(token: string): Promise<DbUser | undefined> {
  const rows = await dbQuery<{ user_id: string; access_expires_at: string }>(`SELECT user_id, access_expires_at FROM device_sessions
    WHERE access_token_hash = $1 AND revoked_at IS NULL`, [hashToken(token)]);
  const row = rows[0];
  if (!row || new Date(row.access_expires_at).getTime() <= Date.now()) return undefined;
  return findUserById(row.user_id);
}

export async function rotateApiSession(refreshToken: string): Promise<{ user: DbUser; session: ApiSession } | undefined> {
  const rows = await dbQuery<{ id: string; user_id: string; refresh_expires_at: string }>(`SELECT id, user_id, refresh_expires_at FROM device_sessions
    WHERE refresh_token_hash = $1 AND revoked_at IS NULL`, [hashToken(refreshToken)]);
  const row = rows[0];
  if (!row || new Date(row.refresh_expires_at).getTime() <= Date.now()) return undefined;
  await dbExec("UPDATE device_sessions SET revoked_at = $1 WHERE id = $2", [now(), row.id]);
  const user = await findUserById(row.user_id);
  return user ? { user, session: await createApiSession(user.id) } : undefined;
}

export async function revokeApiSession(token: string): Promise<void> {
  await dbExec("UPDATE device_sessions SET revoked_at = $1 WHERE access_token_hash = $2 AND revoked_at IS NULL", [now(), hashToken(token)]);
}

export async function listControlNodes(): Promise<Array<DbNode & {
  provider: string;
  region: string;
  public_endpoint: string | null;
  server_public_key: string | null;
  capabilities: Record<string, unknown>;
}>> {
  const rows = await dbQuery<DbNode & {
    provider: string;
    region: string;
    public_endpoint: string | null;
    server_public_key: string | null;
    agent_capabilities_json: string;
  }>("SELECT * FROM nodes ORDER BY created_at DESC");
  return rows.map((row) => ({ ...row, capabilities: parseJson(row.agent_capabilities_json, {}) }));
}

export async function updateNodeControlMetadata(nodeId: string, input: {
  provider?: string;
  region?: string;
  publicEndpoint?: string;
  serverPublicKey?: string;
  capabilities?: Record<string, unknown>;
}): Promise<void> {
  const values: Array<[string, string]> = [];
  if (input.provider !== undefined) values.push(["provider", input.provider]);
  if (input.region !== undefined) values.push(["region", input.region]);
  if (input.publicEndpoint !== undefined) values.push(["public_endpoint", input.publicEndpoint]);
  if (input.serverPublicKey !== undefined) values.push(["server_public_key", input.serverPublicKey]);
  if (input.capabilities !== undefined) values.push(["agent_capabilities_json", JSON.stringify(input.capabilities)]);
  if (!values.length) return;
  const assignments = values.map(([key], index) => `${key} = $${index + 1}`).join(", ");
  const params: unknown[] = values.map(([, value]) => value);
  params.push(now(), nodeId);
  await dbExec(`UPDATE nodes SET ${assignments}, updated_at = $${values.length + 1} WHERE id = $${values.length + 2}`, params);
}

export async function updateControlRegion(regionId: string, label: string): Promise<void> {
  await dbExec("UPDATE nodes SET region = $1, updated_at = $2 WHERE region_id = $3", [label, now(), regionId]);
}

export async function upsertNodeProtocol(input: {
  nodeId: string;
  protocol: Protocol;
  transports: string[];
  platforms: string[];
  routing: string[];
  ipv6: boolean;
  minClientVersion?: string | null;
  configSchemaVersion?: number;
  status?: string;
}): Promise<NodeProtocol> {
  const timestamp = now();
  await dbExec(`INSERT INTO node_protocols
    (node_id, protocol, transports_json, platforms_json, routing_json, ipv6, min_client_version, config_schema_version, status, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT(node_id, protocol) DO UPDATE SET
      transports_json = excluded.transports_json, platforms_json = excluded.platforms_json,
      routing_json = excluded.routing_json, ipv6 = excluded.ipv6, min_client_version = excluded.min_client_version,
      config_schema_version = excluded.config_schema_version, status = excluded.status, updated_at = excluded.updated_at`, [
    input.nodeId, input.protocol, JSON.stringify(input.transports), JSON.stringify(input.platforms), JSON.stringify(input.routing), input.ipv6 ? 1 : 0,
    input.minClientVersion || null, input.configSchemaVersion || 1, input.status || "enabled", timestamp,
  ]);
  return (await listNodeProtocols(input.nodeId)).find((item) => item.protocol === input.protocol)!;
}

export async function listNodeProtocols(nodeId?: string): Promise<NodeProtocol[]> {
  const rows = nodeId
    ? await dbQuery<Record<string, unknown>>("SELECT * FROM node_protocols WHERE node_id = $1 ORDER BY protocol", [nodeId])
    : await dbQuery<Record<string, unknown>>("SELECT * FROM node_protocols ORDER BY node_id, protocol");
  return rows.map((row) => ({
    node_id: String(row.node_id), protocol: row.protocol as Protocol,
    transports: parseJson(String(row.transports_json), []), platforms: parseJson(String(row.platforms_json), []),
    routing: parseJson(String(row.routing_json), []), ipv6: Boolean(row.ipv6),
    min_client_version: row.min_client_version ? String(row.min_client_version) : null,
    config_schema_version: Number(row.config_schema_version || 1), status: String(row.status), updated_at: String(row.updated_at),
  }));
}

function vpnServiceFromRow(row: Record<string, unknown>): VpnService {
  return {
    node_id: String(row.node_id), protocol: row.protocol as Protocol, enabled: Boolean(row.enabled),
    transport: String(row.transport), listen_port: Number(row.listen_port), subnet: String(row.subnet),
    dns: parseJson(String(row.dns_json), ["1.1.1.1"]), status: row.status as VpnServiceStatus,
    last_error: String(row.last_error || ""), created_at: String(row.created_at), updated_at: String(row.updated_at),
  };
}

export async function listVpnServices(nodeId?: string): Promise<VpnService[]> {
  const rows = nodeId
    ? await dbQuery<Record<string, unknown>>("SELECT * FROM vpn_services WHERE node_id = $1 ORDER BY protocol", [nodeId])
    : await dbQuery<Record<string, unknown>>("SELECT * FROM vpn_services ORDER BY node_id, protocol");
  return rows.map(vpnServiceFromRow);
}

export async function findVpnService(nodeId: string, protocol: Protocol): Promise<VpnService | undefined> {
  return (await listVpnServices(nodeId)).find((item) => item.protocol === protocol);
}

export async function upsertVpnService(input: {
  nodeId: string; protocol: Protocol; enabled: boolean; transport?: string; listenPort?: number;
  subnet?: string; dns?: string[]; status?: VpnServiceStatus; lastError?: string;
}): Promise<VpnService> {
  const timestamp = now();
  const defaults = input.protocol === "wireguard"
    ? { port: 51820, subnet: "10.70.0.0/24" }
    : { port: 1194, subnet: "10.71.0.0/24" };
  await dbExec(`INSERT INTO vpn_services
    (node_id, protocol, enabled, transport, listen_port, subnet, dns_json, status, last_error, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
    ON CONFLICT(node_id, protocol) DO UPDATE SET enabled = excluded.enabled, transport = excluded.transport,
      listen_port = excluded.listen_port, subnet = excluded.subnet, dns_json = excluded.dns_json,
      status = excluded.status, last_error = excluded.last_error, updated_at = excluded.updated_at`, [
    input.nodeId, input.protocol, input.enabled ? 1 : 0, input.transport || "udp", input.listenPort || defaults.port,
    input.subnet || defaults.subnet, JSON.stringify(input.dns || ["1.1.1.1"]),
    input.status || (input.enabled ? "pending" : "disabled"), input.lastError || "", timestamp,
  ]);
  return (await findVpnService(input.nodeId, input.protocol))!;
}

export async function updateVpnServiceState(nodeId: string, protocol: Protocol, input: { status: VpnServiceStatus; lastError?: string }): Promise<void> {
  await dbExec("UPDATE vpn_services SET status = $1, last_error = $2, updated_at = $3 WHERE node_id = $4 AND protocol = $5", [input.status, input.lastError || "", now(), nodeId, protocol]);
}

export async function allocateIpLease(nodeId: string, protocol: Protocol, deviceId: string): Promise<string> {
  // A released row remains in the table for auditability, so treating only
  // active rows as occupied would try to insert the same unique address again.
  const existing = (await dbQuery<{ id: string; address: string; status: string }>("SELECT id, address, status FROM ip_leases WHERE node_id = $1 AND protocol = $2 AND device_id = $3", [nodeId, protocol, deviceId]))[0];
  if (existing) {
    if (existing.status !== "active") await dbExec("UPDATE ip_leases SET status = 'active', released_at = NULL, created_at = $1 WHERE id = $2", [now(), existing.id]);
    return existing.address;
  }

  // Reassign one released address atomically before consuming a new address.
  const released = await dbQuery<{ address: string }>(`WITH reusable AS (
      SELECT id FROM ip_leases WHERE node_id = $1 AND protocol = $2 AND status = 'released'
      ORDER BY released_at NULLS FIRST, created_at LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE ip_leases SET device_id = $3, status = 'active', released_at = NULL, created_at = $4
      FROM reusable WHERE ip_leases.id = reusable.id RETURNING ip_leases.address`, [nodeId, protocol, deviceId, now()]);
  if (released[0]) return released[0].address;

  const occupied = new Set((await dbQuery<{ address: string }>("SELECT address FROM ip_leases WHERE node_id = $1 AND protocol = $2", [nodeId, protocol])).map((row) => row.address));
  const service = await findVpnService(nodeId, protocol);
  const subnetMatch = service?.subnet.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d+\/24$/);
  if (!subnetMatch) throw new Error("This protocol service requires a supported IPv4 /24 address pool");
  const network = subnetMatch[1];
  for (let index = 2; index < 255; index += 1) {
    const address = `${network}.${index}/32`;
    if (occupied.has(address)) continue;
    try {
      await dbExec(`INSERT INTO ip_leases (id, node_id, protocol, device_id, address, status, created_at)
        VALUES ($1, $2, $3, $4, $5, 'active', $6)`, [`lease_${randomUUID()}`, nodeId, protocol, deviceId, address, now()]);
      return address;
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
    }
  }
  throw new Error("No VPN addresses available for this node and protocol");
}

function profileFromRow(row: Record<string, unknown>): ConnectionProfile {
  return {
    id: String(row.id), device_id: String(row.device_id), node_id: String(row.node_id), protocol: row.protocol as Protocol,
    transport: String(row.transport), revision: Number(row.revision), status: row.status as ProfileStatus,
    endpoint: parseJson(String(row.endpoint_json), { host: "", port: 0 }), client_address: row.client_address ? String(row.client_address) : null,
    dns: parseJson(String(row.dns_json), []), allowed_ips: parseJson(String(row.allowed_ips_json), []),
    protocol_payload: parseJson(String(row.protocol_payload_json), {}), issued_at: String(row.issued_at),
    expires_at: String(row.expires_at), updated_at: String(row.updated_at),
  };
}

export async function createConnectionProfile(input: {
  deviceId: string;
  nodeId: string;
  protocol: Protocol;
  transport: string;
  endpoint: { host: string; port: number };
  clientAddress?: string | null;
  dns: string[];
  allowedIps: string[];
  protocolPayload: Record<string, unknown>;
  expiresAt: string;
}): Promise<ConnectionProfile> {
  const latest = (await dbQuery<{ revision: number | null }>("SELECT MAX(revision) AS revision FROM connection_profiles WHERE device_id = $1 AND node_id = $2 AND protocol = $3", [input.deviceId, input.nodeId, input.protocol]))[0];
  const revision = Number(latest?.revision || 0) + 1;
  const timestamp = now();
  const id = `prof_${randomUUID()}`;
  await dbExec(`INSERT INTO connection_profiles
    (id, device_id, node_id, protocol, transport, revision, status, endpoint_json, client_address, dns_json, allowed_ips_json, protocol_payload_json, issued_at, expires_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, 'issued', $7, $8, $9, $10, $11, $12, $13, $14)`, [
    id, input.deviceId, input.nodeId, input.protocol, input.transport, revision, JSON.stringify(input.endpoint), input.clientAddress || null,
    JSON.stringify(input.dns), JSON.stringify(input.allowedIps), JSON.stringify(input.protocolPayload), timestamp, input.expiresAt, timestamp,
  ]);
  return (await findConnectionProfile(id))!;
}

export async function expireDueConnectionProfiles(): Promise<number> {
  return dbExec(`UPDATE connection_profiles SET status = 'expired', updated_at = $1
    WHERE status IN ('issued', 'active') AND expires_at <= $2`, [now(), now()]);
}

export async function listConnectionProfiles(filters: { deviceId?: string; status?: ProfileStatus; userId?: string } = {}): Promise<ConnectionProfile[]> {
  await expireDueConnectionProfiles();
  const clauses: string[] = [];
  const values: string[] = [];
  if (filters.deviceId) { clauses.push(`connection_profiles.device_id = $${values.length + 1}`); values.push(filters.deviceId); }
  if (filters.status) { clauses.push(`connection_profiles.status = $${values.length + 1}`); values.push(filters.status); }
  if (filters.userId) { clauses.push(`devices.user_id = $${values.length + 1}`); values.push(filters.userId); }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  return (await dbQuery<Record<string, unknown>>(`SELECT connection_profiles.* FROM connection_profiles
    INNER JOIN devices ON devices.id = connection_profiles.device_id${where}
    ORDER BY connection_profiles.updated_at DESC`, values)).map(profileFromRow);
}

export async function findConnectionProfile(id: string): Promise<ConnectionProfile | undefined> {
  await expireDueConnectionProfiles();
  const rows = await dbQuery<Record<string, unknown>>("SELECT * FROM connection_profiles WHERE id = $1", [id]);
  return rows[0] ? profileFromRow(rows[0]) : undefined;
}

export async function activateConnectionProfile(id: string): Promise<ConnectionProfile | undefined> {
  const timestamp = now();
  await dbExec("UPDATE connection_profiles SET status = 'active', updated_at = $1 WHERE id = $2 AND status = 'issued' AND expires_at > $1", [timestamp, id]);
  return findConnectionProfile(id);
}

export async function expireConnectionProfile(id: string): Promise<void> {
  await dbExec("UPDATE connection_profiles SET status = 'expired', updated_at = $1 WHERE id = $2 AND status IN ('issued', 'active')", [now(), id]);
}

export async function revokeConnectionProfilesForDevice(deviceId: string): Promise<void> {
  await dbExec("UPDATE connection_profiles SET status = 'revoked', updated_at = $1 WHERE device_id = $2 AND status IN ('issued', 'active')", [now(), deviceId]);
}

export async function upsertDesiredConfig(input: { nodeId: string; protocol: Protocol; payload: Record<string, unknown> }): Promise<DesiredConfig> {
  const payloadJson = JSON.stringify(input.payload);
  const hash = createHash("sha256").update(payloadJson).digest("hex");
  const current = (await dbQuery<{ revision: number; id: string; config_hash: string }>("SELECT revision, id, config_hash FROM desired_configs WHERE node_id = $1 AND protocol = $2", [input.nodeId, input.protocol]))[0];
  if (current?.config_hash === hash) return (await findDesiredConfig(input.nodeId, input.protocol))!;
  const revision = Number(current?.revision || 0) + 1;
  const timestamp = now();
  const id = current?.id || `desired_${randomUUID()}`;
  await dbExec(`INSERT INTO desired_configs (id, node_id, protocol, revision, config_hash, payload_json, status, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
    ON CONFLICT(node_id, protocol) DO UPDATE SET revision = excluded.revision, config_hash = excluded.config_hash, payload_json = excluded.payload_json, status = 'pending', updated_at = excluded.updated_at`, [
    id, input.nodeId, input.protocol, revision, hash, payloadJson, timestamp, timestamp,
  ]);
  return (await findDesiredConfig(input.nodeId, input.protocol))!;
}

export async function findDesiredConfig(nodeId: string, protocol: Protocol): Promise<DesiredConfig | undefined> {
  const rows = await dbQuery<Record<string, unknown>>("SELECT * FROM desired_configs WHERE node_id = $1 AND protocol = $2", [nodeId, protocol]);
  const row = rows[0];
  if (!row) return undefined;
  return { id: String(row.id), node_id: String(row.node_id), protocol: row.protocol as Protocol, revision: Number(row.revision), config_hash: String(row.config_hash), payload: parseJson(String(row.payload_json), {}), status: String(row.status), updated_at: String(row.updated_at) };
}

export async function getNodeReconcileStatus(nodeId: string) {
  const desired = await dbQuery<Record<string, unknown>>("SELECT protocol, revision, config_hash, status, updated_at FROM desired_configs WHERE node_id = $1 ORDER BY protocol", [nodeId]);
  const observed = await dbQuery<Record<string, unknown>>("SELECT protocol, applied_revision, observed_hash, status, last_error, updated_at FROM observed_configs WHERE node_id = $1 ORDER BY protocol", [nodeId]);
  const tasks = await dbQuery<Record<string, unknown>>("SELECT id, protocol, task_type, desired_revision, status, attempts, last_error, created_at, started_at, finished_at FROM reconcile_tasks WHERE node_id = $1 ORDER BY created_at DESC LIMIT 50", [nodeId]);
  return {
    desired: desired.map((row) => ({ protocol: row.protocol, revision: Number(row.revision), configHash: row.config_hash, status: row.status, updatedAt: row.updated_at })),
    observed: observed.map((row) => ({ protocol: row.protocol, appliedRevision: Number(row.applied_revision), observedHash: row.observed_hash, status: row.status, lastError: row.last_error, updatedAt: row.updated_at })),
    tasks: tasks.map((row) => ({ id: row.id, protocol: row.protocol, taskType: row.task_type, desiredRevision: Number(row.desired_revision), status: row.status, attempts: Number(row.attempts), lastError: row.last_error, createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at })),
  };
}

export async function enqueueReconcileTask(input: { nodeId: string; protocol: Protocol; taskType: string; desiredRevision: number; payload: Record<string, unknown> }): Promise<string> {
  const id = `task_${randomUUID()}`;
  await dbExec(`INSERT INTO reconcile_tasks (id, node_id, protocol, task_type, desired_revision, payload_json, status, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`, [id, input.nodeId, input.protocol, input.taskType, input.desiredRevision, JSON.stringify(input.payload), now()]);
  return id;
}

export async function pullReconcileTasks(nodeId: string, limit = 10): Promise<ReconcileTask[]> {
  const stale = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  await dbExec("UPDATE reconcile_tasks SET status = 'pending', started_at = NULL WHERE node_id = $1 AND status = 'running' AND started_at < $2", [nodeId, stale]);
  const retryAfter = new Date(Date.now() - 30 * 1000).toISOString();
  await dbExec("UPDATE reconcile_tasks SET status = 'pending', started_at = NULL WHERE node_id = $1 AND status = 'failed' AND attempts < 5 AND finished_at < $2", [nodeId, retryAfter]);
  const rows = await dbQuery<Record<string, unknown>>("SELECT * FROM reconcile_tasks WHERE node_id = $1 AND status = 'pending' ORDER BY created_at LIMIT $2", [nodeId, Math.min(Math.max(limit, 1), 20)]);
  const tasks: ReconcileTask[] = [];
  for (const row of rows) {
    const startedAt = now();
    if ((await dbExec("UPDATE reconcile_tasks SET status = 'running', attempts = attempts + 1, started_at = $1 WHERE id = $2 AND status = 'pending'", [startedAt, String(row.id)])) !== 1) continue;
    tasks.push({ id: String(row.id), node_id: String(row.node_id), protocol: row.protocol as Protocol, task_type: String(row.task_type), desired_revision: Number(row.desired_revision), payload: parseJson(String(row.payload_json), {}), status: "running", attempts: Number(row.attempts || 0) + 1, last_error: String(row.last_error || ""), created_at: String(row.created_at), started_at: startedAt });
  }
  return tasks;
}

export async function finishReconcileTask(input: {
  taskId: string;
  nodeId: string;
  status: "succeeded" | "failed";
  error?: string;
  observedRevision?: number;
  observedHash?: string;
  observedStatus?: string;
}): Promise<void> {
  const timestamp = now();
  await dbExec("UPDATE reconcile_tasks SET status = $1, last_error = $2, finished_at = $3 WHERE id = $4 AND node_id = $5", [input.status, input.error || "", timestamp, input.taskId, input.nodeId]);
  const completedTask = (await dbQuery<{ protocol: Protocol; task_type: string }>("SELECT protocol, task_type FROM reconcile_tasks WHERE id = $1 AND node_id = $2", [input.taskId, input.nodeId]))[0];
  if (completedTask) {
    const currentService = await findVpnService(input.nodeId, completedTask.protocol);
    const disablesService = completedTask.task_type.startsWith("Disable");
    if (currentService && disablesService === !currentService.enabled) {
      const serviceStatus: VpnServiceStatus = input.status === "failed" ? "attention" : disablesService ? "disabled" : "healthy";
      await updateVpnServiceState(input.nodeId, completedTask.protocol, { status: serviceStatus, lastError: input.error });
    }
  }
  if (input.observedRevision !== undefined && input.observedHash !== undefined) {
    await dbExec(`INSERT INTO observed_configs (node_id, protocol, applied_revision, observed_hash, status, last_error, updated_at)
      SELECT node_id, protocol, $1, $2, $3, $4, $5 FROM reconcile_tasks WHERE id = $6
      ON CONFLICT(node_id, protocol) DO UPDATE SET applied_revision = excluded.applied_revision, observed_hash = excluded.observed_hash, status = excluded.status, last_error = excluded.last_error, updated_at = excluded.updated_at`, [
      input.observedRevision, input.observedHash, input.observedStatus || input.status, input.error || "", timestamp, input.taskId,
    ]);
  }
}

export async function listActivePeers(nodeId: string, protocol: Protocol): Promise<Array<{ publicKey: string; allowedIps: string[]; persistentKeepaliveSeconds: number }>> {
  await expireDueConnectionProfiles();
  const rows = await dbQuery<{ public_key: string; address: string }>(`SELECT d.public_key, l.address
    FROM devices d JOIN ip_leases l ON l.device_id = d.id
    JOIN connection_profiles p ON p.device_id = d.id AND p.node_id = l.node_id AND p.protocol = l.protocol
    WHERE l.node_id = $1 AND l.protocol = $2 AND l.status = 'active' AND d.status = 'active' AND p.status = 'active'
    GROUP BY d.id, l.address, d.public_key`, [nodeId, protocol]);
  return rows.map((row) => ({ publicKey: row.public_key, allowedIps: [row.address], persistentKeepaliveSeconds: 25 }));
}
