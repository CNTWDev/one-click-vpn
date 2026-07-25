import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { adminSeed, databasePath } from "./config";
import { hashPassword } from "./password";

export type DbUser = {
  id: string;
  email: string;
  display_name: string;
  role: string;
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
  credential_type: string;
  credential_ciphertext: string;
  credential_iv: string;
  credential_tag: string;
  host_fingerprint: string | null;
  agent_token_hash: string | null;
  created_at: string;
  updated_at: string;
};

export type DbRegion = {
  id: string;
  name: string;
  country: string;
  code: string;
  created_at: string;
  updated_at: string;
};

let instance: DatabaseSync | null = null;

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  place TEXT NOT NULL,
  region_id TEXT,
  ip TEXT NOT NULL,
  ssh_user TEXT NOT NULL,
  ssh_port INTEGER NOT NULL DEFAULT 22,
  status TEXT NOT NULL DEFAULT 'provisioning',
  latency TEXT NOT NULL DEFAULT 'checking',
  users INTEGER NOT NULL DEFAULT 0,
  traffic TEXT NOT NULL DEFAULT '—',
  version TEXT NOT NULL DEFAULT 'bootstrap pending',
  last_seen TEXT NOT NULL DEFAULT 'never',
  credential_type TEXT NOT NULL,
  credential_ciphertext TEXT NOT NULL,
  credential_iv TEXT NOT NULL,
  credential_tag TEXT NOT NULL,
  host_fingerprint TEXT,
  agent_token_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS regions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (name, country),
  UNIQUE (code)
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_logs(created_at);
CREATE TABLE IF NOT EXISTS node_actions (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  output TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  finished_at TEXT
);
`;

function now(): string {
  return new Date().toISOString();
}

export function getDb(): DatabaseSync {
  if (instance) return instance;
  const file = databasePath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  instance = new DatabaseSync(file);
  instance.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  instance.exec(schema);
  for (const statement of [
    "ALTER TABLE nodes ADD COLUMN agent_token_hash TEXT",
    "ALTER TABLE nodes ADD COLUMN region_id TEXT",
  ]) {
    try { instance.exec(statement); } catch { /* column already exists */ }
  }
  instance.exec("CREATE INDEX IF NOT EXISTS nodes_region_idx ON nodes(region_id)");
  seedRegions(instance);
  seedAdmin(instance);
  return instance;
}

function seedRegions(db: DatabaseSync): void {
  const timestamp = now();
  const defaults = [
    ["tokyo-jp", "Tokyo", "Japan", "JP"],
    ["singapore-sg", "Singapore", "Singapore", "SG"],
    ["frankfurt-de", "Frankfurt", "Germany", "DE"],
    ["los-angeles-us", "Los Angeles", "USA", "US"],
  ];
  const statement = db.prepare(`INSERT OR IGNORE INTO regions
    (id, name, country, code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const [id, name, country, code] of defaults) {
    statement.run(id, name, country, code, timestamp, timestamp);
  }
  db.exec(`UPDATE nodes SET region_id = (
    SELECT regions.id FROM regions
    WHERE nodes.place = regions.name || ' · ' || regions.country
  ) WHERE region_id IS NULL`);
}

function seedAdmin(db: DatabaseSync): void {
  const seed = adminSeed();
  if (!seed) return;
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(seed.email) as { id: string } | undefined;
  if (existing) return;
  db.prepare(
    "INSERT INTO users (id, email, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'owner', ?)",
  ).run(randomUUID(), seed.email, seed.displayName, hashPassword(seed.password), now());
}

export function findUserByEmail(email: string): (DbUser & { password_hash: string }) | undefined {
  return getDb().prepare("SELECT id, email, display_name, role, password_hash FROM users WHERE email = ?").get(email.toLowerCase()) as (DbUser & { password_hash: string }) | undefined;
}

export function findUserById(id: string): DbUser | undefined {
  return getDb().prepare("SELECT id, email, display_name, role FROM users WHERE id = ?").get(id) as DbUser | undefined;
}

export function createSession(userId: string, expiresAt: string, id: string = randomUUID()): string {
  getDb().prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(id, userId, expiresAt, now());
  return id;
}

export function findSession(id: string): { user_id: string; expires_at: string } | undefined {
  return getDb().prepare("SELECT user_id, expires_at FROM sessions WHERE id = ?").get(id) as { user_id: string; expires_at: string } | undefined;
}

export function deleteSession(id: string): void {
  getDb().prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

export function cleanupSessions(): void {
  getDb().prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now());
}

export function listNodes(): DbNode[] {
  return getDb().prepare("SELECT * FROM nodes ORDER BY created_at DESC").all() as unknown as DbNode[];
}

export function listRegions(): DbRegion[] {
  return getDb().prepare("SELECT * FROM regions ORDER BY name, country").all() as unknown as DbRegion[];
}

export function findRegion(id: string): DbRegion | undefined {
  return getDb().prepare("SELECT * FROM regions WHERE id = ?").get(id) as DbRegion | undefined;
}

export function findRegionByLabel(label: string): DbRegion | undefined {
  return getDb().prepare("SELECT * FROM regions WHERE name || ' · ' || country = ?").get(label) as DbRegion | undefined;
}

export function insertRegion(input: Pick<DbRegion, "id" | "name" | "country" | "code">): DbRegion {
  const timestamp = now();
  getDb().prepare(`INSERT INTO regions (id, name, country, code, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(input.id, input.name, input.country, input.code, timestamp, timestamp);
  return findRegion(input.id)!;
}

export function updateRegion(id: string, values: Pick<DbRegion, "name" | "country" | "code">): DbRegion | undefined {
  const timestamp = now();
  const database = getDb();
  database.prepare("UPDATE regions SET name = ?, country = ?, code = ?, updated_at = ? WHERE id = ?")
    .run(values.name, values.country, values.code, timestamp, id);
  database.prepare("UPDATE nodes SET place = ?, updated_at = ? WHERE region_id = ?")
    .run(`${values.name} · ${values.country}`, timestamp, id);
  return findRegion(id);
}

export function deleteRegion(id: string): boolean {
  const database = getDb();
  const usage = database.prepare("SELECT COUNT(*) AS count FROM nodes WHERE region_id = ?").get(id) as { count: number };
  if (Number(usage.count) > 0) return false;
  return Number(database.prepare("DELETE FROM regions WHERE id = ?").run(id).changes || 0) === 1;
}

export function findNode(id: string): DbNode | undefined {
  return getDb().prepare("SELECT * FROM nodes WHERE id = ?").get(id) as DbNode | undefined;
}

export function insertNode(input: Omit<DbNode, "id" | "created_at" | "updated_at">): DbNode {
  const id = randomUUID();
  const timestamp = now();
  getDb().prepare(`INSERT INTO nodes
    (id, name, place, region_id, ip, ssh_user, ssh_port, status, latency, users, traffic, version, last_seen,
     credential_type, credential_ciphertext, credential_iv, credential_tag, host_fingerprint, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, input.name, input.place, input.region_id, input.ip, input.ssh_user, input.ssh_port, input.status, input.latency,
    input.users, input.traffic, input.version, input.last_seen, input.credential_type,
    input.credential_ciphertext, input.credential_iv, input.credential_tag, input.host_fingerprint,
    timestamp, timestamp,
  );
  return findNode(id)!;
}

export function updateNode(id: string, values: Record<string, string | number | null>): DbNode | undefined {
  const allowed = new Set(["status", "latency", "users", "traffic", "version", "last_seen", "host_fingerprint", "agent_token_hash"]);
  const entries = Object.entries(values).filter(([key]) => allowed.has(key));
  if (entries.length) {
    const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
    getDb().prepare(`UPDATE nodes SET ${assignments}, updated_at = ? WHERE id = ?`).run(
      ...entries.map(([, value]) => value), now(), id,
    );
  }
  return findNode(id);
}

export function addAudit(input: {
  actorUserId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}): void {
  getDb().prepare(`INSERT INTO audit_logs
    (id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    randomUUID(), input.actorUserId || null, input.action, input.targetType || null,
    input.targetId || null, JSON.stringify(input.metadata || {}), now(),
  );
}

export function addNodeAction(nodeId: string, action: string): string {
  const id = randomUUID();
  getDb().prepare(`INSERT INTO node_actions (id, node_id, action, status, created_at)
    VALUES (?, ?, ?, 'running', ?)`).run(id, nodeId, action, now());
  return id;
}

export function finishNodeAction(id: string, status: string, output = "", error = ""): void {
  getDb().prepare("UPDATE node_actions SET status = ?, output = ?, error = ?, finished_at = ? WHERE id = ?").run(status, output, error, now(), id);
}
