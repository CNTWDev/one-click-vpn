import { createHash, randomBytes, randomUUID } from "node:crypto";
import { findUserById, getDb, type DbNode, type DbUser } from "./db";
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

let schemaReady = false;

function now(): string {
  return new Date().toISOString();
}

function db() {
  const database = getDb();
  if (!schemaReady) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        platform TEXT NOT NULL,
        app_version TEXT NOT NULL,
        public_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS devices_user_idx ON devices(user_id, created_at);
      CREATE INDEX IF NOT EXISTS devices_public_key_idx ON devices(public_key);

      CREATE TABLE IF NOT EXISTS node_protocols (
        node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        protocol TEXT NOT NULL,
        transports_json TEXT NOT NULL DEFAULT '[]',
        platforms_json TEXT NOT NULL DEFAULT '[]',
        routing_json TEXT NOT NULL DEFAULT '[]',
        ipv6 INTEGER NOT NULL DEFAULT 0,
        min_client_version TEXT,
        config_schema_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'enabled',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (node_id, protocol)
      );

      CREATE TABLE IF NOT EXISTS protocol_credentials (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        protocol TEXT NOT NULL,
        public_key TEXT,
        certificate_serial TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS protocol_credentials_device_idx ON protocol_credentials(device_id, protocol);

      CREATE TABLE IF NOT EXISTS ip_leases (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        protocol TEXT NOT NULL,
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        address TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        released_at TEXT,
        UNIQUE (node_id, protocol, address),
        UNIQUE (node_id, protocol, device_id)
      );

      CREATE TABLE IF NOT EXISTS connection_profiles (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        protocol TEXT NOT NULL,
        transport TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'issued',
        endpoint_json TEXT NOT NULL,
        client_address TEXT,
        dns_json TEXT NOT NULL DEFAULT '[]',
        allowed_ips_json TEXT NOT NULL DEFAULT '[]',
        protocol_payload_json TEXT NOT NULL DEFAULT '{}',
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS profiles_device_idx ON connection_profiles(device_id, updated_at);
      CREATE INDEX IF NOT EXISTS profiles_node_idx ON connection_profiles(node_id, protocol, revision);

      CREATE TABLE IF NOT EXISTS desired_configs (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        protocol TEXT NOT NULL,
        revision INTEGER NOT NULL,
        config_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (node_id, protocol)
      );

      CREATE TABLE IF NOT EXISTS observed_configs (
        node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        protocol TEXT NOT NULL,
        applied_revision INTEGER NOT NULL DEFAULT 0,
        observed_hash TEXT,
        status TEXT NOT NULL DEFAULT 'unknown',
        last_handshake_at TEXT,
        last_error TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (node_id, protocol)
      );

      CREATE TABLE IF NOT EXISTS reconcile_tasks (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        protocol TEXT NOT NULL,
        task_type TEXT NOT NULL,
        desired_revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS reconcile_tasks_node_idx ON reconcile_tasks(node_id, status, created_at);

      CREATE TABLE IF NOT EXISTS agent_certificates (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        serial TEXT NOT NULL,
        fingerprint TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        not_before TEXT NOT NULL,
        not_after TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS device_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        access_token_hash TEXT NOT NULL UNIQUE,
        refresh_token_hash TEXT NOT NULL UNIQUE,
        access_expires_at TEXT NOT NULL,
        refresh_expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS device_sessions_access_idx ON device_sessions(access_token_hash, revoked_at);
      CREATE INDEX IF NOT EXISTS device_sessions_refresh_idx ON device_sessions(refresh_token_hash, revoked_at);
    `);

    for (const statement of [
      "ALTER TABLE nodes ADD COLUMN provider TEXT NOT NULL DEFAULT 'unknown'",
      "ALTER TABLE nodes ADD COLUMN region TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE nodes ADD COLUMN public_endpoint TEXT",
      "ALTER TABLE nodes ADD COLUMN server_public_key TEXT",
      "ALTER TABLE nodes ADD COLUMN agent_capabilities_json TEXT NOT NULL DEFAULT '{}'",
    ]) {
      try { database.exec(statement); } catch { /* column already exists */ }
    }
    schemaReady = true;
  }
  return database;
}

export function ensureControlPlaneSchema(): void {
  db();
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function createDevice(input: {
  userId: string;
  displayName: string;
  platform: Platform;
  appVersion: string;
  publicKey: string;
}): Device {
  const id = `dev_${randomUUID()}`;
  const timestamp = now();
  db().prepare(`INSERT INTO devices
    (id, user_id, display_name, platform, app_version, public_key, status, created_at, last_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
    .run(id, input.userId, input.displayName, input.platform, input.appVersion, input.publicKey, timestamp, timestamp, timestamp);
  return findDevice(id)!;
}

export function listDevices(userId?: string): Device[] {
  const rows = userId
    ? db().prepare("SELECT * FROM devices WHERE user_id = ? ORDER BY created_at DESC").all(userId)
    : db().prepare("SELECT * FROM devices ORDER BY created_at DESC").all();
  return rows as unknown as Device[];
}

export function findDevice(id: string): Device | undefined {
  return db().prepare("SELECT * FROM devices WHERE id = ?").get(id) as Device | undefined;
}

export function revokeDevice(id: string): Device | undefined {
  db().prepare("UPDATE devices SET status = 'revoked', updated_at = ? WHERE id = ?").run(now(), id);
  db().prepare("UPDATE protocol_credentials SET status = 'revoked', revoked_at = ? WHERE device_id = ? AND status = 'active'").run(now(), id);
  db().prepare("UPDATE ip_leases SET status = 'released', released_at = ? WHERE device_id = ? AND status = 'active'").run(now(), id);
  db().prepare("UPDATE connection_profiles SET status = 'revoked', updated_at = ? WHERE device_id = ? AND status IN ('issued', 'active')").run(now(), id);
  return findDevice(id);
}

export function touchDevice(id: string): void {
  db().prepare("UPDATE devices SET last_seen_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), id);
}

export function createApiSession(userId: string): ApiSession {
  const accessToken = randomBytes(32).toString("base64url");
  const refreshToken = randomBytes(48).toString("base64url");
  const accessExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db().prepare(`INSERT INTO device_sessions
    (id, user_id, access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(`session_${randomUUID()}`, userId, hashToken(accessToken), hashToken(refreshToken), accessExpiresAt, refreshExpiresAt, now());
  return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
}

export function findApiUserByAccessToken(token: string): DbUser | undefined {
  const row = db().prepare(`SELECT user_id, access_expires_at FROM device_sessions
    WHERE access_token_hash = ? AND revoked_at IS NULL`).get(hashToken(token)) as { user_id: string; access_expires_at: string } | undefined;
  if (!row || new Date(row.access_expires_at).getTime() <= Date.now()) return undefined;
  return findUserById(row.user_id);
}

export function rotateApiSession(refreshToken: string): { user: DbUser; session: ApiSession } | undefined {
  const row = db().prepare(`SELECT id, user_id, refresh_expires_at FROM device_sessions
    WHERE refresh_token_hash = ? AND revoked_at IS NULL`).get(hashToken(refreshToken)) as { id: string; user_id: string; refresh_expires_at: string } | undefined;
  if (!row || new Date(row.refresh_expires_at).getTime() <= Date.now()) return undefined;
  db().prepare("UPDATE device_sessions SET revoked_at = ? WHERE id = ?").run(now(), row.id);
  const user = findUserById(row.user_id);
  return user ? { user, session: createApiSession(user.id) } : undefined;
}

export function revokeApiSession(token: string): void {
  db().prepare("UPDATE device_sessions SET revoked_at = ? WHERE access_token_hash = ? AND revoked_at IS NULL").run(now(), hashToken(token));
}

export function listControlNodes(): Array<DbNode & {
  provider: string;
  region: string;
  public_endpoint: string | null;
  server_public_key: string | null;
  capabilities: Record<string, unknown>;
}> {
  const rows = db().prepare("SELECT * FROM nodes ORDER BY created_at DESC").all() as Array<DbNode & {
    provider: string;
    region: string;
    public_endpoint: string | null;
    server_public_key: string | null;
    agent_capabilities_json: string;
  }>;
  return rows.map((row) => ({
    ...row,
    capabilities: parseJson(row.agent_capabilities_json, {}),
  }));
}

export function updateNodeControlMetadata(nodeId: string, input: {
  provider?: string;
  region?: string;
  publicEndpoint?: string;
  serverPublicKey?: string;
  capabilities?: Record<string, unknown>;
}): void {
  const values: Array<[string, string]> = [];
  if (input.provider !== undefined) values.push(["provider", input.provider]);
  if (input.region !== undefined) values.push(["region", input.region]);
  if (input.publicEndpoint !== undefined) values.push(["public_endpoint", input.publicEndpoint]);
  if (input.serverPublicKey !== undefined) values.push(["server_public_key", input.serverPublicKey]);
  if (input.capabilities !== undefined) values.push(["agent_capabilities_json", JSON.stringify(input.capabilities)]);
  if (!values.length) return;
  const assignments = values.map(([key]) => `${key} = ?`).join(", ");
  db().prepare(`UPDATE nodes SET ${assignments}, updated_at = ? WHERE id = ?`).run(...values.map(([, value]) => value), now(), nodeId);
}

export function updateControlRegion(regionId: string, label: string): void {
  db().prepare("UPDATE nodes SET region = ?, updated_at = ? WHERE region_id = ?").run(label, now(), regionId);
}

export function upsertNodeProtocol(input: {
  nodeId: string;
  protocol: Protocol;
  transports: string[];
  platforms: Platform[];
  routing: string[];
  ipv6: boolean;
  minClientVersion?: string | null;
  configSchemaVersion?: number;
  status?: string;
}): NodeProtocol {
  const timestamp = now();
  db().prepare(`INSERT INTO node_protocols
    (node_id, protocol, transports_json, platforms_json, routing_json, ipv6, min_client_version, config_schema_version, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(node_id, protocol) DO UPDATE SET
      transports_json = excluded.transports_json,
      platforms_json = excluded.platforms_json,
      routing_json = excluded.routing_json,
      ipv6 = excluded.ipv6,
      min_client_version = excluded.min_client_version,
      config_schema_version = excluded.config_schema_version,
      status = excluded.status,
      updated_at = excluded.updated_at`)
    .run(input.nodeId, input.protocol, JSON.stringify(input.transports), JSON.stringify(input.platforms), JSON.stringify(input.routing), input.ipv6 ? 1 : 0, input.minClientVersion || null, input.configSchemaVersion || 1, input.status || "enabled", timestamp);
  return listNodeProtocols(input.nodeId).find((item) => item.protocol === input.protocol)!;
}

export function listNodeProtocols(nodeId?: string): NodeProtocol[] {
  const rows = nodeId
    ? db().prepare("SELECT * FROM node_protocols WHERE node_id = ? ORDER BY protocol").all(nodeId)
    : db().prepare("SELECT * FROM node_protocols ORDER BY node_id, protocol").all();
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    node_id: String(row.node_id),
    protocol: row.protocol as Protocol,
    transports: parseJson(String(row.transports_json), []),
    platforms: parseJson(String(row.platforms_json), []),
    routing: parseJson(String(row.routing_json), []),
    ipv6: Boolean(row.ipv6),
    min_client_version: row.min_client_version ? String(row.min_client_version) : null,
    config_schema_version: Number(row.config_schema_version || 1),
    status: String(row.status),
    updated_at: String(row.updated_at),
  }));
}

export function allocateIpLease(nodeId: string, protocol: Protocol, deviceId: string): string {
  const existing = db().prepare("SELECT address FROM ip_leases WHERE node_id = ? AND protocol = ? AND device_id = ? AND status = 'active'").get(nodeId, protocol, deviceId) as { address: string } | undefined;
  if (existing) return existing.address;
  const used = new Set((db().prepare("SELECT address FROM ip_leases WHERE node_id = ? AND protocol = ? AND status = 'active'").all(nodeId, protocol) as Array<{ address: string }>).map((row) => row.address));
  let address = "";
  for (let index = 2; index < 255; index += 1) {
    const candidate = `10.70.0.${index}/32`;
    if (!used.has(candidate)) { address = candidate; break; }
  }
  if (!address) throw new Error("No VPN addresses available for this node and protocol");
  db().prepare(`INSERT INTO ip_leases (id, node_id, protocol, device_id, address, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?)`)
    .run(`lease_${randomUUID()}`, nodeId, protocol, deviceId, address, now());
  return address;
}

function profileFromRow(row: Record<string, unknown>): ConnectionProfile {
  return {
    id: String(row.id),
    device_id: String(row.device_id),
    node_id: String(row.node_id),
    protocol: row.protocol as Protocol,
    transport: String(row.transport),
    revision: Number(row.revision),
    status: row.status as ProfileStatus,
    endpoint: parseJson(String(row.endpoint_json), { host: "", port: 0 }),
    client_address: row.client_address ? String(row.client_address) : null,
    dns: parseJson(String(row.dns_json), []),
    allowed_ips: parseJson(String(row.allowed_ips_json), []),
    protocol_payload: parseJson(String(row.protocol_payload_json), {}),
    issued_at: String(row.issued_at),
    expires_at: String(row.expires_at),
    updated_at: String(row.updated_at),
  };
}

export function createConnectionProfile(input: {
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
}): ConnectionProfile {
  const latest = db().prepare("SELECT MAX(revision) AS revision FROM connection_profiles WHERE device_id = ? AND node_id = ? AND protocol = ?").get(input.deviceId, input.nodeId, input.protocol) as { revision: number | null };
  const revision = Number(latest?.revision || 0) + 1;
  const timestamp = now();
  const id = `prof_${randomUUID()}`;
  db().prepare(`INSERT INTO connection_profiles
    (id, device_id, node_id, protocol, transport, revision, status, endpoint_json, client_address, dns_json, allowed_ips_json, protocol_payload_json, issued_at, expires_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.deviceId, input.nodeId, input.protocol, input.transport, revision, JSON.stringify(input.endpoint), input.clientAddress || null, JSON.stringify(input.dns), JSON.stringify(input.allowedIps), JSON.stringify(input.protocolPayload), timestamp, input.expiresAt, timestamp);
  return findConnectionProfile(id)!;
}

export function expireDueConnectionProfiles(): number {
  const result = db().prepare(`UPDATE connection_profiles
    SET status = 'expired', updated_at = ?
    WHERE status IN ('issued', 'active') AND expires_at <= ?`).run(now(), now());
  return Number(result.changes || 0);
}

export function listConnectionProfiles(filters: { deviceId?: string; status?: ProfileStatus } = {}): ConnectionProfile[] {
  expireDueConnectionProfiles();
  const clauses: string[] = [];
  const values: string[] = [];
  if (filters.deviceId) { clauses.push("device_id = ?"); values.push(filters.deviceId); }
  if (filters.status) { clauses.push("status = ?"); values.push(filters.status); }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  return (db().prepare(`SELECT * FROM connection_profiles${where} ORDER BY updated_at DESC`).all(...values) as Array<Record<string, unknown>>).map(profileFromRow);
}

export function findConnectionProfile(id: string): ConnectionProfile | undefined {
  expireDueConnectionProfiles();
  const row = db().prepare("SELECT * FROM connection_profiles WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? profileFromRow(row) : undefined;
}

export function activateConnectionProfile(id: string): ConnectionProfile | undefined {
  const timestamp = now();
  db().prepare("UPDATE connection_profiles SET status = 'active', updated_at = ? WHERE id = ? AND status = 'issued' AND expires_at > ?").run(timestamp, id, timestamp);
  return findConnectionProfile(id);
}

export function expireConnectionProfile(id: string): void {
  db().prepare("UPDATE connection_profiles SET status = 'expired', updated_at = ? WHERE id = ? AND status IN ('issued', 'active')").run(now(), id);
}

export function revokeConnectionProfilesForDevice(deviceId: string): void {
  db().prepare("UPDATE connection_profiles SET status = 'revoked', updated_at = ? WHERE device_id = ? AND status IN ('issued', 'active')").run(now(), deviceId);
}

export function upsertDesiredConfig(input: {
  nodeId: string;
  protocol: Protocol;
  payload: Record<string, unknown>;
}): DesiredConfig {
  const payloadJson = JSON.stringify(input.payload);
  const hash = createHash("sha256").update(payloadJson).digest("hex");
  const current = db().prepare("SELECT revision, id, config_hash FROM desired_configs WHERE node_id = ? AND protocol = ?").get(input.nodeId, input.protocol) as { revision: number; id: string; config_hash: string } | undefined;
  if (current?.config_hash === hash) {
    return findDesiredConfig(input.nodeId, input.protocol)!;
  }
  const revision = Number(current?.revision || 0) + 1;
  const timestamp = now();
  const id = current?.id || `desired_${randomUUID()}`;
  db().prepare(`INSERT INTO desired_configs (id, node_id, protocol, revision, config_hash, payload_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(node_id, protocol) DO UPDATE SET revision = excluded.revision, config_hash = excluded.config_hash, payload_json = excluded.payload_json, status = 'pending', updated_at = excluded.updated_at`)
    .run(id, input.nodeId, input.protocol, revision, hash, payloadJson, timestamp, timestamp);
  const row = db().prepare("SELECT * FROM desired_configs WHERE node_id = ? AND protocol = ?").get(input.nodeId, input.protocol) as Record<string, unknown>;
  return {
    id: String(row.id), node_id: String(row.node_id), protocol: row.protocol as Protocol,
    revision: Number(row.revision), config_hash: String(row.config_hash), payload: parseJson(String(row.payload_json), {}),
    status: String(row.status), updated_at: String(row.updated_at),
  };
}

export function findDesiredConfig(nodeId: string, protocol: Protocol): DesiredConfig | undefined {
  const row = db().prepare("SELECT * FROM desired_configs WHERE node_id = ? AND protocol = ?").get(nodeId, protocol) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: String(row.id), node_id: String(row.node_id), protocol: row.protocol as Protocol,
    revision: Number(row.revision), config_hash: String(row.config_hash), payload: parseJson(String(row.payload_json), {}),
    status: String(row.status), updated_at: String(row.updated_at),
  };
}

export function getNodeReconcileStatus(nodeId: string) {
  const desired = db().prepare("SELECT protocol, revision, config_hash, status, updated_at FROM desired_configs WHERE node_id = ? ORDER BY protocol").all(nodeId) as Array<Record<string, unknown>>;
  const observed = db().prepare("SELECT protocol, applied_revision, observed_hash, status, last_error, updated_at FROM observed_configs WHERE node_id = ? ORDER BY protocol").all(nodeId) as Array<Record<string, unknown>>;
  const tasks = db().prepare("SELECT id, protocol, task_type, desired_revision, status, attempts, last_error, created_at, started_at, finished_at FROM reconcile_tasks WHERE node_id = ? ORDER BY created_at DESC LIMIT 50").all(nodeId) as Array<Record<string, unknown>>;
  return {
    desired: desired.map((row) => ({ protocol: row.protocol, revision: Number(row.revision), configHash: row.config_hash, status: row.status, updatedAt: row.updated_at })),
    observed: observed.map((row) => ({ protocol: row.protocol, appliedRevision: Number(row.applied_revision), observedHash: row.observed_hash, status: row.status, lastError: row.last_error, updatedAt: row.updated_at })),
    tasks: tasks.map((row) => ({ id: row.id, protocol: row.protocol, taskType: row.task_type, desiredRevision: Number(row.desired_revision), status: row.status, attempts: Number(row.attempts), lastError: row.last_error, createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at })),
  };
}

export function enqueueReconcileTask(input: {
  nodeId: string;
  protocol: Protocol;
  taskType: string;
  desiredRevision: number;
  payload: Record<string, unknown>;
}): string {
  const id = `task_${randomUUID()}`;
  db().prepare(`INSERT INTO reconcile_tasks
    (id, node_id, protocol, task_type, desired_revision, payload_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .run(id, input.nodeId, input.protocol, input.taskType, input.desiredRevision, JSON.stringify(input.payload), now());
  return id;
}

export function pullReconcileTasks(nodeId: string, limit = 10): ReconcileTask[] {
  const stale = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  db().prepare("UPDATE reconcile_tasks SET status = 'pending', started_at = NULL WHERE node_id = ? AND status = 'running' AND started_at < ?").run(nodeId, stale);
  const retryAfter = new Date(Date.now() - 30 * 1000).toISOString();
  db().prepare("UPDATE reconcile_tasks SET status = 'pending', started_at = NULL WHERE node_id = ? AND status = 'failed' AND attempts < 5 AND finished_at < ?").run(nodeId, retryAfter);
  const rows = db().prepare("SELECT * FROM reconcile_tasks WHERE node_id = ? AND status = 'pending' ORDER BY created_at LIMIT ?").all(nodeId, limit) as Array<Record<string, unknown>>;
  const tasks: ReconcileTask[] = [];
  for (const row of rows) {
    const changed = db().prepare("UPDATE reconcile_tasks SET status = 'running', attempts = attempts + 1, started_at = ? WHERE id = ? AND status = 'pending'").run(now(), String(row.id));
    if (Number(changed.changes || 0) !== 1) continue;
    tasks.push({
      id: String(row.id), node_id: String(row.node_id), protocol: row.protocol as Protocol,
      task_type: String(row.task_type), desired_revision: Number(row.desired_revision),
      payload: parseJson(String(row.payload_json), {}), status: "running", attempts: Number(row.attempts || 0) + 1,
      last_error: String(row.last_error || ""), created_at: String(row.created_at), started_at: now(),
    });
  }
  return tasks;
}

export function finishReconcileTask(input: {
  taskId: string;
  nodeId: string;
  status: "succeeded" | "failed";
  error?: string;
  observedRevision?: number;
  observedHash?: string;
  observedStatus?: string;
}): void {
  const timestamp = now();
  db().prepare("UPDATE reconcile_tasks SET status = ?, last_error = ?, finished_at = ? WHERE id = ? AND node_id = ?")
    .run(input.status, input.error || "", timestamp, input.taskId, input.nodeId);
  if (input.observedRevision !== undefined && input.observedHash !== undefined) {
    db().prepare(`INSERT INTO observed_configs (node_id, protocol, applied_revision, observed_hash, status, last_error, updated_at)
      SELECT node_id, protocol, ?, ?, ?, ?, ? FROM reconcile_tasks WHERE id = ?
      ON CONFLICT(node_id, protocol) DO UPDATE SET applied_revision = excluded.applied_revision, observed_hash = excluded.observed_hash, status = excluded.status, last_error = excluded.last_error, updated_at = excluded.updated_at`)
      .run(input.observedRevision, input.observedHash, input.observedStatus || input.status, input.error || "", timestamp, input.taskId);
  }
}

export function listActivePeers(nodeId: string, protocol: Protocol): Array<{ publicKey: string; allowedIps: string[]; persistentKeepaliveSeconds: number }> {
  expireDueConnectionProfiles();
  const rows = db().prepare(`SELECT d.public_key, l.address
    FROM devices d JOIN ip_leases l ON l.device_id = d.id
    JOIN connection_profiles p ON p.device_id = d.id AND p.node_id = l.node_id AND p.protocol = l.protocol
    WHERE l.node_id = ? AND l.protocol = ? AND l.status = 'active' AND d.status = 'active' AND p.status = 'active'
    GROUP BY d.id, l.address, d.public_key`).all(nodeId, protocol) as Array<{ public_key: string; address: string }>;
  return rows.map((row) => ({ publicKey: row.public_key, allowedIps: [row.address], persistentKeepaliveSeconds: 25 }));
}
