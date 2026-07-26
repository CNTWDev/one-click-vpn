import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { Pool } from "pg";

const connectionString = process.env.NORTHSTAR_DATABASE_URL;
if (!connectionString) throw new Error("NORTHSTAR_DATABASE_URL is required");

const pool = new Pool({ connectionString });

function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'owner', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, place TEXT NOT NULL, region_id TEXT,
  ip TEXT NOT NULL, ssh_user TEXT NOT NULL, ssh_port INTEGER NOT NULL DEFAULT 22,
  status TEXT NOT NULL DEFAULT 'provisioning', latency TEXT NOT NULL DEFAULT 'checking',
  users INTEGER NOT NULL DEFAULT 0, traffic TEXT NOT NULL DEFAULT '—',
  version TEXT NOT NULL DEFAULT 'bootstrap pending', last_seen TEXT NOT NULL DEFAULT 'never',
  last_heartbeat_at TEXT, credential_type TEXT NOT NULL, credential_ciphertext TEXT NOT NULL,
  credential_iv TEXT NOT NULL, credential_tag TEXT NOT NULL, host_fingerprint TEXT,
  agent_token_hash TEXT, provider TEXT NOT NULL DEFAULT 'unknown', region TEXT NOT NULL DEFAULT '',
  public_endpoint TEXT, server_public_key TEXT, agent_capabilities_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS nodes_region_idx ON nodes(region_id);
CREATE TABLE IF NOT EXISTS regions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, country TEXT NOT NULL, code TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (name, country), UNIQUE (code)
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY, actor_user_id TEXT, action TEXT NOT NULL, target_type TEXT,
  target_id TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_logs(created_at);
CREATE TABLE IF NOT EXISTS node_actions (
  id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  action TEXT NOT NULL, status TEXT NOT NULL, output TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL, platform TEXT NOT NULL, app_version TEXT NOT NULL,
  public_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
  last_seen_at TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS devices_user_idx ON devices(user_id, created_at);
CREATE INDEX IF NOT EXISTS devices_public_key_idx ON devices(public_key);
CREATE TABLE IF NOT EXISTS node_protocols (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, protocol TEXT NOT NULL,
  transports_json TEXT NOT NULL DEFAULT '[]', platforms_json TEXT NOT NULL DEFAULT '[]',
  routing_json TEXT NOT NULL DEFAULT '[]', ipv6 INTEGER NOT NULL DEFAULT 0,
  min_client_version TEXT, config_schema_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'enabled', updated_at TEXT NOT NULL,
  PRIMARY KEY (node_id, protocol)
);
CREATE TABLE IF NOT EXISTS protocol_credentials (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL, public_key TEXT, certificate_serial TEXT,
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, expires_at TEXT,
  revoked_at TEXT, metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS protocol_credentials_device_idx ON protocol_credentials(device_id, protocol);
CREATE TABLE IF NOT EXISTS ip_leases (
  id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  address TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
  released_at TEXT, UNIQUE (node_id, protocol, address), UNIQUE (node_id, protocol, device_id)
);
CREATE TABLE IF NOT EXISTS connection_profiles (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, protocol TEXT NOT NULL,
  transport TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'issued',
  endpoint_json TEXT NOT NULL, client_address TEXT, dns_json TEXT NOT NULL DEFAULT '[]',
  allowed_ips_json TEXT NOT NULL DEFAULT '[]', protocol_payload_json TEXT NOT NULL DEFAULT '{}',
  issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS profiles_device_idx ON connection_profiles(device_id, updated_at);
CREATE INDEX IF NOT EXISTS profiles_node_idx ON connection_profiles(node_id, protocol, revision);
CREATE TABLE IF NOT EXISTS desired_configs (
  id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL, revision INTEGER NOT NULL, config_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, UNIQUE (node_id, protocol)
);
CREATE TABLE IF NOT EXISTS observed_configs (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, protocol TEXT NOT NULL,
  applied_revision INTEGER NOT NULL DEFAULT 0, observed_hash TEXT, status TEXT NOT NULL DEFAULT 'unknown',
  last_handshake_at TEXT, last_error TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
  PRIMARY KEY (node_id, protocol)
);
CREATE TABLE IF NOT EXISTS reconcile_tasks (
  id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL, task_type TEXT NOT NULL, desired_revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS reconcile_tasks_node_idx ON reconcile_tasks(node_id, status, created_at);
CREATE TABLE IF NOT EXISTS agent_certificates (
  id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  serial TEXT NOT NULL, fingerprint TEXT, status TEXT NOT NULL DEFAULT 'active',
  not_before TEXT NOT NULL, not_after TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS device_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token_hash TEXT NOT NULL UNIQUE, refresh_token_hash TEXT NOT NULL UNIQUE,
  access_expires_at TEXT NOT NULL, refresh_expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS device_sessions_access_idx ON device_sessions(access_token_hash, revoked_at);
CREATE INDEX IF NOT EXISTS device_sessions_refresh_idx ON device_sessions(refresh_token_hash, revoked_at);
`;

try {
  await pool.query("SELECT 1");
  await pool.query(schema);
  const timestamp = new Date().toISOString();
  const regions = [
    ["tokyo-jp", "Tokyo", "Japan", "JP"],
    ["singapore-sg", "Singapore", "Singapore", "SG"],
    ["frankfurt-de", "Frankfurt", "Germany", "DE"],
    ["los-angeles-us", "Los Angeles", "USA", "US"],
  ];
  for (const [id, name, country, code] of regions) {
    await pool.query(
      "INSERT INTO regions (id, name, country, code, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT (id) DO NOTHING",
      [id, name, country, code, timestamp],
    );
  }
  await pool.query(`UPDATE nodes SET region_id = regions.id
    FROM regions WHERE nodes.region_id IS NULL AND nodes.place = regions.name || ' · ' || regions.country`);
  const email = process.env.NORTHSTAR_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.NORTHSTAR_ADMIN_PASSWORD;
  if (email && password) {
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role, created_at)
       VALUES ($1, $2, $3, $4, 'owner', $5) ON CONFLICT (email) DO NOTHING`,
      [randomUUID(), email, process.env.NORTHSTAR_ADMIN_NAME?.trim() || "Owner", hashPassword(password), timestamp],
    );
  }
  console.log("Northstar PostgreSQL database ready");
} finally {
  await pool.end();
}
