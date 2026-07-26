import { randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import { adminSeed } from "./config";
import { hashPassword } from "./password";
import { writeOperationalLog } from "./operational-logs";

export type DbUser = {
  id: string;
  email: string;
  display_name: string;
  role: string;
  status: "pending" | "active" | "rejected" | "suspended";
  approved_at: string | null;
  approved_by: string | null;
  rejection_reason: string | null;
  created_at?: string;
  updated_at?: string;
};

export type DbNode = {
  id: string;
  name: string;
  place: string;
  region_id: string | null;
  ip: string;
  ssh_user: string;
  ssh_port: number;
  status: string;
  latency: string;
  users: number;
  traffic: string;
  version: string;
  last_seen: string;
  last_heartbeat_at?: string | null;
  credential_type: string;
  credential_ciphertext: string;
  credential_iv: string;
  credential_tag: string;
  host_fingerprint: string | null;
  agent_token_hash: string | null;
  server_public_key?: string | null;
  created_at: string;
  updated_at: string;
  metrics_json?: string | null;
  deployment_policy?: "standard" | "custom" | "agent-only";
  policy_version?: number;
};

export type NodeMetrics = {
  collectedAt: string;
  cpuPercent: number;
  load1: number;
  memory: { usedBytes: number; totalBytes: number; percent: number };
  disk: { usedBytes: number; totalBytes: number; percent: number };
  network: { rxBytes: number; txBytes: number; rxBytesPerSecond: number; txBytesPerSecond: number };
};

export type DbRegion = {
  id: string;
  name: string;
  country: string;
  code: string;
  created_at: string;
  updated_at: string;
};

export type ControllerSettings = {
  id: string;
  display_name: string;
  location_label: string;
  latitude: number | null;
  longitude: number | null;
  location_source: "unset" | "environment" | "manual";
  created_at: string;
  updated_at: string;
};

let pool: Pool | null = null;
let readyPromise: Promise<void> | null = null;

function now(): string {
  return new Date().toISOString();
}

function parseMetrics(value: string | null | undefined): NodeMetrics | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as NodeMetrics;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getDb(): Pool {
  if (pool) return pool;
  const connectionString = process.env.NORTHSTAR_DATABASE_URL?.trim();
  if (!connectionString) throw new Error("NORTHSTAR_DATABASE_URL is required");
  pool = new Pool({ connectionString, max: Number(process.env.NORTHSTAR_DB_POOL_MAX || 10), idleTimeoutMillis: 30_000 });
  pool.on("error", (error) => console.error("Northstar PostgreSQL pool error", error));
  return pool;
}

async function ensureReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = (async () => {
      const database = getDb();
      const timestamp = now();
      const defaults = [
        ["tokyo-jp", "Tokyo", "Japan", "JP"],
        ["singapore-sg", "Singapore", "Singapore", "SG"],
        ["frankfurt-de", "Frankfurt", "Germany", "DE"],
        ["los-angeles-us", "Los Angeles", "USA", "US"],
      ];
      for (const [id, name, country, code] of defaults) {
        await database.query(
          "INSERT INTO regions (id, name, country, code, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT (id) DO NOTHING",
          [id, name, country, code, timestamp],
        );
      }
      await database.query(`UPDATE nodes SET region_id = regions.id
        FROM regions
        WHERE nodes.region_id IS NULL AND nodes.place = regions.name || ' · ' || regions.country`);
      const seed = adminSeed();
      if (seed) {
        await database.query(
          `INSERT INTO users (id, email, display_name, password_hash, role, status, approved_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'owner', 'active', $5, $5, $5) ON CONFLICT (email) DO NOTHING`,
          [randomUUID(), seed.email, seed.displayName, hashPassword(seed.password), timestamp],
        );
      }
    })().catch((error) => {
      readyPromise = null;
      throw error;
    });
  }
  await readyPromise;
}

export async function dbQuery<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  await ensureReady();
  return (await getDb().query<T>(text, values)).rows;
}

export async function dbExec(text: string, values: unknown[] = []): Promise<number> {
  await ensureReady();
  return (await getDb().query(text, values)).rowCount || 0;
}

export async function closeDb(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
  readyPromise = null;
}

export function publicNode(node: DbNode): Record<string, unknown> {
  const hidden = new Set(["credential_ciphertext", "credential_iv", "credential_tag", "agent_token_hash", "metrics_json"]);
  const heartbeatAt = node.last_heartbeat_at || (node.status === "online" ? node.updated_at : null);
  const stale = node.status === "online" && heartbeatAt && Date.now() - new Date(heartbeatAt).getTime() > 90_000;
  return {
    ...Object.fromEntries(Object.entries(node).filter(([key]) => !hidden.has(key))),
    metrics: parseMetrics(node.metrics_json),
    metricsCollectedAt: parseMetrics(node.metrics_json)?.collectedAt || null,
    ...(stale ? { status: "attention", latency: "no heartbeat", last_seen: "heartbeat expired" } : {}),
  };
}

export async function findUserByEmail(email: string): Promise<(DbUser & { password_hash: string }) | undefined> {
  const rows = await dbQuery<DbUser & { password_hash: string }>("SELECT id, email, display_name, role, status, approved_at, approved_by, rejection_reason, created_at, updated_at, password_hash FROM users WHERE email = $1", [email.toLowerCase()]);
  return rows[0];
}

export async function findUserById(id: string): Promise<DbUser | undefined> {
  const rows = await dbQuery<DbUser>("SELECT id, email, display_name, role, status, approved_at, approved_by, rejection_reason, created_at, updated_at FROM users WHERE id = $1", [id]);
  return rows[0];
}

export async function createPendingUser(input: { email: string; displayName: string; passwordHash: string }): Promise<DbUser> {
  const timestamp = now();
  const id = `usr_${randomUUID()}`;
  await dbExec(`INSERT INTO users
    (id, email, display_name, password_hash, role, status, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 'member', 'pending', $5, $5)`, [id, input.email.toLowerCase(), input.displayName, input.passwordHash, timestamp]);
  return (await findUserById(id))!;
}

export async function listUsers(status?: DbUser["status"]): Promise<DbUser[]> {
  const rows = status
    ? await dbQuery<DbUser>("SELECT id, email, display_name, role, status, approved_at, approved_by, rejection_reason, created_at, updated_at FROM users WHERE status = $1 ORDER BY created_at DESC", [status])
    : await dbQuery<DbUser>("SELECT id, email, display_name, role, status, approved_at, approved_by, rejection_reason, created_at, updated_at FROM users ORDER BY created_at DESC");
  return rows;
}

export async function updateUserStatus(id: string, status: DbUser["status"], actorUserId: string, rejectionReason?: string): Promise<DbUser | undefined> {
  const timestamp = now();
  await dbExec(`UPDATE users SET status = $1, approved_at = CASE WHEN $1 = 'active' THEN $2 ELSE approved_at END,
    approved_by = CASE WHEN $1 = 'active' THEN $3 ELSE approved_by END,
    rejection_reason = CASE WHEN $1 = 'rejected' THEN $4 ELSE NULL END,
    updated_at = $2 WHERE id = $5`, [status, timestamp, actorUserId, rejectionReason || null, id]);
  return findUserById(id);
}

export async function createSession(userId: string, expiresAt: string, id: string = randomUUID()): Promise<string> {
  await dbExec("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4)", [id, userId, expiresAt, now()]);
  return id;
}

export async function findSession(id: string): Promise<{ user_id: string; expires_at: string } | undefined> {
  const rows = await dbQuery<{ user_id: string; expires_at: string }>("SELECT user_id, expires_at FROM sessions WHERE id = $1", [id]);
  return rows[0];
}

export async function deleteSession(id: string): Promise<void> {
  await dbExec("DELETE FROM sessions WHERE id = $1", [id]);
}

export async function cleanupSessions(): Promise<void> {
  await dbExec("DELETE FROM sessions WHERE expires_at <= $1", [now()]);
}

export async function listNodes(): Promise<DbNode[]> {
  return dbQuery<DbNode>("SELECT * FROM nodes ORDER BY created_at DESC");
}

function configuredCoordinate(name: string, minimum: number, maximum: number): number | null {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : null;
}

export async function getControllerSettings(): Promise<ControllerSettings> {
  const latitude = configuredCoordinate("NORTHSTAR_CONTROLLER_LATITUDE", -90, 90);
  const longitude = configuredCoordinate("NORTHSTAR_CONTROLLER_LONGITUDE", -180, 180);
  const locationLabel = process.env.NORTHSTAR_CONTROLLER_LOCATION?.trim() || "";
  const source = latitude !== null && longitude !== null ? "environment" : "unset";
  const timestamp = now();
  await dbExec(`INSERT INTO controller_settings
    (id, display_name, location_label, latitude, longitude, location_source, created_at, updated_at)
    VALUES ('primary', 'Northstar Controller', $1, $2, $3, $4, $5, $5)
    ON CONFLICT (id) DO NOTHING`, [locationLabel, latitude, longitude, source, timestamp]);
  return (await dbQuery<ControllerSettings>("SELECT * FROM controller_settings WHERE id = 'primary'"))[0]!;
}

export async function updateControllerSettings(input: { displayName: string; locationLabel: string; latitude: number | null; longitude: number | null }): Promise<ControllerSettings> {
  await getControllerSettings();
  await dbExec(`UPDATE controller_settings SET display_name = $1, location_label = $2, latitude = $3,
    longitude = $4, location_source = 'manual', updated_at = $5 WHERE id = 'primary'`, [
    input.displayName, input.locationLabel, input.latitude, input.longitude, now(),
  ]);
  return getControllerSettings();
}

export async function listRegions(): Promise<DbRegion[]> {
  return dbQuery<DbRegion>("SELECT * FROM regions ORDER BY name, country");
}

export async function findRegion(id: string): Promise<DbRegion | undefined> {
  const rows = await dbQuery<DbRegion>("SELECT * FROM regions WHERE id = $1", [id]);
  return rows[0];
}

export async function findRegionByLabel(label: string): Promise<DbRegion | undefined> {
  const rows = await dbQuery<DbRegion>("SELECT * FROM regions WHERE name || ' · ' || country = $1", [label]);
  return rows[0];
}

export async function insertRegion(input: Pick<DbRegion, "id" | "name" | "country" | "code">): Promise<DbRegion> {
  const timestamp = now();
  await dbExec("INSERT INTO regions (id, name, country, code, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)", [input.id, input.name, input.country, input.code, timestamp]);
  return (await findRegion(input.id))!;
}

export async function updateRegion(id: string, values: Pick<DbRegion, "name" | "country" | "code">): Promise<DbRegion | undefined> {
  const timestamp = now();
  await dbExec("UPDATE regions SET name = $1, country = $2, code = $3, updated_at = $4 WHERE id = $5", [values.name, values.country, values.code, timestamp, id]);
  await dbExec("UPDATE nodes SET place = $1, updated_at = $2 WHERE region_id = $3", [`${values.name} · ${values.country}`, timestamp, id]);
  return findRegion(id);
}

export async function deleteRegion(id: string): Promise<boolean> {
  const rows = await dbQuery<{ count: string }>("SELECT COUNT(*)::text AS count FROM nodes WHERE region_id = $1", [id]);
  if (Number(rows[0]?.count || 0) > 0) return false;
  return (await dbExec("DELETE FROM regions WHERE id = $1", [id])) === 1;
}

export async function findNode(id: string): Promise<DbNode | undefined> {
  const rows = await dbQuery<DbNode>("SELECT * FROM nodes WHERE id = $1", [id]);
  return rows[0];
}

export async function insertNode(input: Omit<DbNode, "id" | "created_at" | "updated_at">): Promise<DbNode> {
  const id = randomUUID();
  const timestamp = now();
  await dbExec(`INSERT INTO nodes
    (id, name, place, region_id, ip, ssh_user, ssh_port, status, latency, users, traffic, version, last_seen,
     credential_type, credential_ciphertext, credential_iv, credential_tag, host_fingerprint, deployment_policy, policy_version, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`, [
    id, input.name, input.place, input.region_id, input.ip, input.ssh_user, input.ssh_port, input.status, input.latency,
    input.users, input.traffic, input.version, input.last_seen, input.credential_type,
    input.credential_ciphertext, input.credential_iv, input.credential_tag, input.host_fingerprint,
    input.deployment_policy || "standard", input.policy_version ?? 1, timestamp, timestamp,
  ]);
  return (await findNode(id))!;
}

export async function updateNode(id: string, values: Record<string, string | number | null>): Promise<DbNode | undefined> {
  const allowed = new Set(["status", "latency", "users", "traffic", "version", "last_seen", "last_heartbeat_at", "host_fingerprint", "agent_token_hash", "metrics_json"]);
  const entries = Object.entries(values).filter(([key]) => allowed.has(key));
  if (entries.length) {
    const assignments = entries.map(([key], index) => `${key} = $${index + 1}`).join(", ");
    const valuesWithTimestamp = entries.map(([, value]) => value);
    valuesWithTimestamp.push(now(), id);
    await dbExec(`UPDATE nodes SET ${assignments}, updated_at = $${entries.length + 1} WHERE id = $${entries.length + 2}`, valuesWithTimestamp);
  }
  return findNode(id);
}

export async function updateNodeConfig(id: string, values: {
  name: string;
  place: string;
  regionId: string;
  ip: string;
  sshUser: string;
  sshPort: number;
  hostFingerprint: string | null;
  credential?: { type: string; ciphertext: string; iv: string; tag: string };
}): Promise<DbNode | undefined> {
  if (values.credential) {
    await dbExec(`UPDATE nodes SET name = $1, place = $2, region_id = $3, ip = $4, ssh_user = $5, ssh_port = $6,
      host_fingerprint = $7, credential_type = $8, credential_ciphertext = $9, credential_iv = $10, credential_tag = $11, updated_at = $12 WHERE id = $13`, [
      values.name, values.place, values.regionId, values.ip, values.sshUser, values.sshPort, values.hostFingerprint,
      values.credential.type, values.credential.ciphertext, values.credential.iv, values.credential.tag, now(), id,
    ]);
  } else {
    await dbExec(`UPDATE nodes SET name = $1, place = $2, region_id = $3, ip = $4, ssh_user = $5, ssh_port = $6,
      host_fingerprint = $7, updated_at = $8 WHERE id = $9`, [values.name, values.place, values.regionId, values.ip, values.sshUser, values.sshPort, values.hostFingerprint, now(), id]);
  }
  return findNode(id);
}

export async function countRunningNodeActions(nodeId: string, excludeActionId?: string): Promise<number> {
  const rows = await dbQuery<{ count: string }>(`SELECT COUNT(*)::text AS count FROM node_actions
    WHERE node_id = $1 AND status IN ('queued', 'running')${excludeActionId ? " AND id <> $2" : ""}`, excludeActionId ? [nodeId, excludeActionId] : [nodeId]);
  return Number(rows[0]?.count || 0);
}

export async function deleteNode(id: string): Promise<boolean> {
  return (await dbExec("DELETE FROM nodes WHERE id = $1", [id])) === 1;
}

export async function addAudit(input: {
  actorUserId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await dbExec(`INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
    randomUUID(), input.actorUserId || null, input.action, input.targetType || null,
    input.targetId || null, JSON.stringify(input.metadata || {}), now(),
  ]);
}

export async function addNodeAction(nodeId: string, action: string, status: "queued" | "running" = "queued"): Promise<string> {
  const id = randomUUID();
  const timestamp = now();
  await dbExec(`INSERT INTO node_actions (id, node_id, action, status, created_at, started_at, current_phase, progress)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [id, nodeId, action, status, timestamp, status === "running" ? timestamp : null, status === "running" ? "connecting" : "queued", status === "running" ? 5 : 0]);
  await appendNodeActionEvent(id, { phase: status === "running" ? "connecting" : "queued", message: status === "running" ? "Controller started the remote operation" : "Operation queued by the Controller" });
  return id;
}

export async function startNodeAction(id: string): Promise<void> {
  const timestamp = now();
  await dbExec("UPDATE node_actions SET status = 'running', started_at = $1, current_phase = 'connecting', progress = 5 WHERE id = $2 AND status = 'queued'", [timestamp, id]);
  await appendNodeActionEvent(id, { phase: "connecting", message: "Worker accepted the operation and is connecting to the node" });
}

export async function updateNodeActionProgress(id: string, input: { phase: string; progress?: number; message?: string; level?: "info" | "warning" | "error" }): Promise<void> {
  const progress = Math.min(Math.max(Math.trunc(input.progress ?? 0), 0), 100);
  await dbExec("UPDATE node_actions SET current_phase = $1, progress = GREATEST(progress, $2) WHERE id = $3", [input.phase.slice(0, 64), progress, id]);
  if (input.message) await appendNodeActionEvent(id, { phase: input.phase, message: input.message, level: input.level });
}

export async function finishNodeAction(id: string, status: string, output = "", error = ""): Promise<void> {
  const succeeded = status === "succeeded";
  await dbExec("UPDATE node_actions SET status = $1, output = $2, error = $3, current_phase = $4, progress = $5, finished_at = $6 WHERE id = $7", [status, output ? "Full remote output is stored in operational logs." : "", error.slice(-4000), succeeded ? "complete" : "failed", 100, now(), id]);
  await appendNodeActionEvent(id, { level: succeeded ? "info" : "error", phase: succeeded ? "complete" : "failed", message: succeeded ? "Operation completed successfully" : (error || "Operation failed") });
}

export type DbNodeAction = {
  id: string;
  node_id: string;
  action: string;
  status: string;
  output: string;
  error: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  current_phase: string;
  progress: number;
};

export type DbNodeActionEvent = {
  id: string;
  action_id: string;
  sequence: number;
  level: "info" | "warning" | "error";
  phase: string;
  message: string;
  created_at: string;
};

export async function appendNodeActionEvent(actionId: string, input: { phase: string; message: string; level?: "info" | "warning" | "error" }): Promise<void> {
  if (input.phase === "output" && (input.level || "info") === "info") {
    void writeOperationalLog({ actionId, component: "controller", level: "info", message: input.message, fields: { phase: input.phase } });
    return;
  }
  const action = (await dbQuery<{ node_id: string; action: string }>("SELECT node_id, action FROM node_actions WHERE id = $1", [actionId]))[0];
  void writeOperationalLog({ nodeId: action?.node_id, actionId, component: "bootstrap", level: input.level || "info", message: input.message, fields: { phase: input.phase, action: action?.action } });
  const sequence = Number((await dbQuery<{ next: string }>("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM node_action_events WHERE action_id = $1", [actionId]))[0]?.next || 1);
  await dbExec(`INSERT INTO node_action_events (id, action_id, sequence, level, phase, message, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`, [randomUUID(), actionId, sequence, input.level || "info", input.phase.slice(0, 64), input.message.slice(0, 4000), now()]);
}

export async function purgeStoredOperationalLogs(nodeId?: string): Promise<void> {
  if (nodeId) {
    await dbExec("DELETE FROM node_action_events WHERE action_id IN (SELECT id FROM node_actions WHERE node_id = $1)", [nodeId]);
    await dbExec("UPDATE node_actions SET output = '', error = '' WHERE node_id = $1", [nodeId]);
    await dbExec("DELETE FROM reconcile_tasks WHERE node_id = $1 AND status IN ('succeeded', 'failed')", [nodeId]);
    return;
  }
  await dbExec("DELETE FROM node_action_events");
  await dbExec("UPDATE node_actions SET output = '', error = ''");
  await dbExec("DELETE FROM reconcile_tasks WHERE status IN ('succeeded', 'failed')");
}

export async function listNodeActionEvents(nodeId: string, limit = 250): Promise<DbNodeActionEvent[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
  return dbQuery<DbNodeActionEvent>(`SELECT e.* FROM node_action_events e
    INNER JOIN node_actions a ON a.id = e.action_id WHERE a.node_id = $1
    ORDER BY e.created_at DESC, e.sequence DESC LIMIT $2`, [nodeId, safeLimit]);
}

export async function listNodeActions(nodeId: string, limit = 20): Promise<DbNodeAction[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 50);
  return dbQuery<DbNodeAction>(`SELECT id, node_id, action, status, output, error, created_at, started_at, finished_at, current_phase, progress
    FROM node_actions WHERE node_id = $1 ORDER BY created_at DESC LIMIT $2`, [nodeId, safeLimit]);
}
