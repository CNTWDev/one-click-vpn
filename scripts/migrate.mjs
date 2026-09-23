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
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'owner',
  status TEXT NOT NULL DEFAULT 'active', approved_at TEXT, approved_by TEXT,
  rejection_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TEXT;
UPDATE users SET updated_at = COALESCE(updated_at, created_at);
UPDATE users SET status = 'active' WHERE role IN ('owner', 'admin') AND status = 'pending';
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, place TEXT NOT NULL, region_id TEXT,
  ip TEXT NOT NULL, ssh_user TEXT NOT NULL, ssh_port INTEGER NOT NULL DEFAULT 22,
  ssh_privilege_mode TEXT NOT NULL DEFAULT 'auto',
  status TEXT NOT NULL DEFAULT 'provisioning', latency TEXT NOT NULL DEFAULT 'checking',
  users INTEGER NOT NULL DEFAULT 0, traffic TEXT NOT NULL DEFAULT '—',
  version TEXT NOT NULL DEFAULT 'bootstrap pending', last_seen TEXT NOT NULL DEFAULT 'never',
  last_heartbeat_at TEXT, credential_type TEXT NOT NULL, credential_ciphertext TEXT NOT NULL,
  credential_iv TEXT NOT NULL, credential_tag TEXT NOT NULL, host_fingerprint TEXT,
  host_fingerprint_source TEXT NOT NULL DEFAULT 'legacy', node_identity TEXT, identity_verified_at TEXT,
  agent_token_hash TEXT, provider TEXT NOT NULL DEFAULT 'unknown', region TEXT NOT NULL DEFAULT '',
  public_endpoint TEXT, server_public_key TEXT, agent_capabilities_json TEXT NOT NULL DEFAULT '{}',
  metrics_json TEXT, deployment_policy TEXT NOT NULL DEFAULT 'standard', policy_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS metrics_json TEXT;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS ssh_privilege_mode TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS deployment_policy TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS policy_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS host_fingerprint_source TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS node_identity TEXT;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS identity_verified_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS nodes_node_identity_unique_idx ON nodes(node_identity) WHERE node_identity IS NOT NULL;
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
CREATE TABLE IF NOT EXISTS controller_settings (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL DEFAULT 'Northstar Controller',
  location_label TEXT NOT NULL DEFAULT '', latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
  location_source TEXT NOT NULL DEFAULT 'unset', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS node_actions (
  id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  action TEXT NOT NULL, status TEXT NOT NULL, output TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
  current_phase TEXT NOT NULL DEFAULT 'queued', progress INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE node_actions ADD COLUMN IF NOT EXISTS started_at TEXT;
ALTER TABLE node_actions ADD COLUMN IF NOT EXISTS current_phase TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE node_actions ADD COLUMN IF NOT EXISTS progress INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS node_action_events (
  id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES node_actions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL, level TEXT NOT NULL DEFAULT 'info', phase TEXT NOT NULL DEFAULT 'execution',
  message TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(action_id, sequence)
);
CREATE INDEX IF NOT EXISTS node_action_events_action_idx ON node_action_events(action_id, sequence);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL, platform TEXT NOT NULL, app_version TEXT NOT NULL,
  public_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
  last_seen_at TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS devices_user_idx ON devices(user_id, created_at);
CREATE INDEX IF NOT EXISTS devices_public_key_idx ON devices(public_key);
CREATE TABLE IF NOT EXISTS access_credentials (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL, protocol TEXT NOT NULL, identity_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', expires_at TEXT, revoked_at TEXT,
  last_seen_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (device_id, protocol)
);
CREATE INDEX IF NOT EXISTS access_credentials_user_idx ON access_credentials(user_id, created_at);
CREATE INDEX IF NOT EXISTS access_credentials_identity_idx ON access_credentials(protocol, identity_key, status);
CREATE TABLE IF NOT EXISTS node_protocols (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, protocol TEXT NOT NULL,
  transports_json TEXT NOT NULL DEFAULT '[]', platforms_json TEXT NOT NULL DEFAULT '[]',
  routing_json TEXT NOT NULL DEFAULT '[]', ipv6 INTEGER NOT NULL DEFAULT 0,
  min_client_version TEXT, config_schema_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'enabled', updated_at TEXT NOT NULL,
  PRIMARY KEY (node_id, protocol)
);
CREATE TABLE IF NOT EXISTS vpn_services (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  transport TEXT NOT NULL DEFAULT 'udp', listen_port INTEGER NOT NULL,
  subnet TEXT NOT NULL, dns_json TEXT NOT NULL DEFAULT '["1.1.1.1"]',
  status TEXT NOT NULL DEFAULT 'pending', last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (node_id, protocol)
);
CREATE INDEX IF NOT EXISTS vpn_services_status_idx ON vpn_services(enabled, status, protocol);
CREATE TABLE IF NOT EXISTS policy_rollouts (
  id TEXT PRIMARY KEY, from_version INTEGER NOT NULL, to_version INTEGER NOT NULL,
  mode TEXT NOT NULL, status TEXT NOT NULL, protocols_json TEXT NOT NULL DEFAULT '[]',
  total_targets INTEGER NOT NULL DEFAULT 0, queued_targets INTEGER NOT NULL DEFAULT 0,
  succeeded_targets INTEGER NOT NULL DEFAULT 0, blocked_targets INTEGER NOT NULL DEFAULT 0,
  failed_targets INTEGER NOT NULL DEFAULT 0, created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
);
ALTER TABLE policy_rollouts ADD COLUMN IF NOT EXISTS succeeded_targets INTEGER NOT NULL DEFAULT 0;
ALTER TABLE policy_rollouts ADD COLUMN IF NOT EXISTS blocked_targets INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS policy_rollout_targets (
  rollout_id TEXT NOT NULL REFERENCES policy_rollouts(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
  PRIMARY KEY (rollout_id, node_id)
);
CREATE TABLE IF NOT EXISTS protocol_credentials (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL, public_key TEXT, certificate_serial TEXT,
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, expires_at TEXT,
  revoked_at TEXT, metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS protocol_credentials_device_idx ON protocol_credentials(device_id, protocol);
CREATE TABLE IF NOT EXISTS secret_materials (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, owner_node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL,
  fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS secret_materials_node_idx ON secret_materials(owner_node_id, kind);
CREATE TABLE IF NOT EXISTS credential_authorities (
  id TEXT PRIMARY KEY, realm TEXT NOT NULL, protocol TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', certificate_pem TEXT NOT NULL,
  private_key_secret_id TEXT NOT NULL REFERENCES secret_materials(id),
  tls_crypt_secret_id TEXT REFERENCES secret_materials(id),
  not_before TEXT NOT NULL, not_after TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
ALTER TABLE credential_authorities DROP CONSTRAINT IF EXISTS credential_authorities_realm_protocol_status_key;
CREATE UNIQUE INDEX IF NOT EXISTS credential_authorities_one_active_idx
  ON credential_authorities(realm, protocol) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS certificate_issuances (
  id TEXT PRIMARY KEY, authority_id TEXT NOT NULL REFERENCES credential_authorities(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE, device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
  credential_id TEXT REFERENCES access_credentials(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL, serial TEXT NOT NULL, subject TEXT NOT NULL,
  certificate_pem TEXT NOT NULL, private_key_secret_id TEXT REFERENCES secret_materials(id),
  status TEXT NOT NULL DEFAULT 'active', not_before TEXT NOT NULL, not_after TEXT NOT NULL,
  revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (authority_id, serial)
);
CREATE INDEX IF NOT EXISTS certificate_issuances_node_idx ON certificate_issuances(node_id, purpose, status);
CREATE INDEX IF NOT EXISTS certificate_issuances_device_idx ON certificate_issuances(device_id, purpose, status);
ALTER TABLE certificate_issuances ADD COLUMN IF NOT EXISTS credential_id TEXT REFERENCES access_credentials(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS certificate_issuances_credential_idx ON certificate_issuances(credential_id, purpose, status);
CREATE TABLE IF NOT EXISTS ip_leases (
  id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  address TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
  released_at TEXT, UNIQUE (node_id, protocol, address), UNIQUE (node_id, protocol, device_id)
);
CREATE TABLE IF NOT EXISTS connection_profiles (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  credential_id TEXT REFERENCES access_credentials(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, protocol TEXT NOT NULL,
  transport TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'issued',
  endpoint_json TEXT NOT NULL, client_address TEXT, dns_json TEXT NOT NULL DEFAULT '[]',
  allowed_ips_json TEXT NOT NULL DEFAULT '[]', protocol_payload_json TEXT NOT NULL DEFAULT '{}',
  issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS profiles_device_idx ON connection_profiles(device_id, updated_at);
ALTER TABLE connection_profiles ADD COLUMN IF NOT EXISTS credential_id TEXT REFERENCES access_credentials(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS profiles_credential_idx ON connection_profiles(credential_id, updated_at);
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
CREATE TABLE IF NOT EXISTS traffic_counters (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  session_key TEXT NOT NULL DEFAULT '',
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  credential_id TEXT REFERENCES access_credentials(id) ON DELETE SET NULL,
  observed_rx_bytes BIGINT NOT NULL DEFAULT 0,
  observed_tx_bytes BIGINT NOT NULL DEFAULT 0,
  last_handshake_at TEXT,
  last_traffic_at TEXT,
  connected INTEGER NOT NULL DEFAULT 0,
  counter_epoch TEXT NOT NULL DEFAULT '',
  observed_at TEXT NOT NULL,
  PRIMARY KEY (node_id, protocol, identity_key, session_key)
);
ALTER TABLE traffic_counters ADD COLUMN IF NOT EXISTS session_key TEXT NOT NULL DEFAULT '';
ALTER TABLE traffic_counters ADD COLUMN IF NOT EXISTS credential_id TEXT REFERENCES access_credentials(id) ON DELETE SET NULL;
ALTER TABLE traffic_counters ADD COLUMN IF NOT EXISTS last_traffic_at TEXT;
ALTER TABLE traffic_counters ADD COLUMN IF NOT EXISTS connected INTEGER NOT NULL DEFAULT 0;
ALTER TABLE traffic_counters DROP CONSTRAINT IF EXISTS traffic_counters_pkey;
ALTER TABLE traffic_counters ADD PRIMARY KEY (node_id, protocol, identity_key, session_key);
CREATE INDEX IF NOT EXISTS traffic_counters_device_idx ON traffic_counters(device_id, observed_at);
CREATE INDEX IF NOT EXISTS traffic_counters_credential_idx ON traffic_counters(credential_id, observed_at);
CREATE TABLE IF NOT EXISTS traffic_daily (
  day TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  credential_id TEXT REFERENCES access_credentials(id) ON DELETE SET NULL,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL,
  upload_bytes BIGINT NOT NULL DEFAULT 0,
  download_bytes BIGINT NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (day, device_id, node_id, protocol)
);
ALTER TABLE traffic_daily ADD COLUMN IF NOT EXISTS credential_id TEXT REFERENCES access_credentials(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS traffic_daily_user_idx ON traffic_daily(user_id, day);
CREATE INDEX IF NOT EXISTS traffic_daily_credential_idx ON traffic_daily(credential_id, day);

ALTER TABLE access_credentials ADD COLUMN IF NOT EXISTS user_disabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE access_credentials ADD COLUMN IF NOT EXISTS admin_disabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE access_credentials ADD COLUMN IF NOT EXISTS deleted_at TEXT;
ALTER TABLE vpn_services ADD COLUMN IF NOT EXISTS access_sync_error TEXT NOT NULL DEFAULT '';

INSERT INTO access_credentials
  (id, user_id, device_id, display_name, protocol, identity_key, status, expires_at, revoked_at, last_seen_at, created_at, updated_at)
SELECT 'cred_' || md5(d.id || ':' || protocols.protocol), d.user_id, d.id, d.display_name, protocols.protocol,
  CASE WHEN protocols.protocol = 'openvpn' THEN COALESCE(REPLACE(cert.subject, 'CN=', ''), 'northstar-' || d.id) ELSE d.public_key END,
  CASE WHEN d.status = 'revoked' THEN 'revoked' ELSE 'active' END,
  cert.not_after, cert.revoked_at, d.last_seen_at, d.created_at, d.updated_at
FROM devices d
INNER JOIN (
  SELECT DISTINCT device_id, protocol FROM connection_profiles
  UNION
  SELECT id AS device_id, CASE WHEN public_key LIKE 'openvpn-managed%' THEN 'openvpn' ELSE 'wireguard' END AS protocol
  FROM devices WHERE NOT EXISTS (SELECT 1 FROM connection_profiles p WHERE p.device_id = devices.id)
) protocols ON protocols.device_id = d.id
LEFT JOIN LATERAL (
  SELECT subject, not_after, revoked_at FROM certificate_issuances c
  WHERE c.device_id = d.id AND c.purpose = 'client' ORDER BY c.created_at DESC LIMIT 1
) cert ON protocols.protocol = 'openvpn'
ON CONFLICT (device_id, protocol) DO NOTHING;

UPDATE connection_profiles p SET credential_id = c.id
FROM access_credentials c WHERE p.credential_id IS NULL AND c.device_id = p.device_id AND c.protocol = p.protocol;
UPDATE certificate_issuances cert SET credential_id = c.id
FROM access_credentials c WHERE cert.credential_id IS NULL AND cert.device_id = c.device_id AND c.protocol = 'openvpn' AND cert.purpose = 'client';
UPDATE traffic_counters t SET credential_id = c.id
FROM access_credentials c WHERE t.credential_id IS NULL AND t.device_id = c.device_id AND t.protocol = c.protocol;
UPDATE traffic_daily t SET credential_id = c.id
FROM access_credentials c WHERE t.credential_id IS NULL AND t.device_id = c.device_id AND t.protocol = c.protocol;

-- Existing signed certificates retain their original cryptographic expiry. Never rewrite PEM dates.
UPDATE access_credentials c SET expires_at = COALESCE(
  (SELECT ci.not_after FROM certificate_issuances ci WHERE ci.credential_id = c.id AND ci.purpose = 'client'
    AND ci.status = 'active' ORDER BY ci.created_at DESC LIMIT 1),
  to_char((c.created_at::timestamptz + interval '365 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
WHERE c.expires_at IS NULL;

-- Correct only still-valid legacy 24-hour profiles. Do not resurrect expired/revoked/disabled access.
UPDATE connection_profiles p SET expires_at = c.expires_at
FROM access_credentials c, users u, devices d
WHERE p.credential_id = c.id AND u.id = c.user_id AND d.id = c.device_id
  AND p.status IN ('issued', 'active') AND p.expires_at::timestamptz > CURRENT_TIMESTAMP
  AND c.status = 'active' AND u.status = 'active' AND d.status = 'active'
  AND NOT c.user_disabled AND NOT c.admin_disabled AND c.deleted_at IS NULL
  AND c.expires_at::timestamptz > p.expires_at::timestamptz
  AND EXTRACT(EPOCH FROM (p.expires_at::timestamptz - p.issued_at::timestamptz)) BETWEEN 86399 AND 86401;
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
  await pool.query(`INSERT INTO vpn_services
    (node_id, protocol, enabled, transport, listen_port, subnet, dns_json, status, created_at, updated_at)
    SELECT id, 'wireguard', 1, 'udp', 51820, '10.70.0.0/24', '["1.1.1.1"]', 'pending', $1, $1 FROM nodes
    ON CONFLICT (node_id, protocol) DO NOTHING`, [timestamp]);
  await pool.query(`INSERT INTO vpn_services
    (node_id, protocol, enabled, transport, listen_port, subnet, dns_json, status, created_at, updated_at)
    SELECT id, 'openvpn', 1, 'udp', 1194, '10.71.0.0/24', '["1.1.1.1"]', 'pending', $1, $1 FROM nodes
    ON CONFLICT (node_id, protocol) DO NOTHING`, [timestamp]);
  const email = process.env.NORTHSTAR_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.NORTHSTAR_ADMIN_PASSWORD;
  if (email && password) {
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role, status, approved_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'owner', 'active', $5, $5, $5) ON CONFLICT (email) DO NOTHING`,
      [randomUUID(), email, process.env.NORTHSTAR_ADMIN_NAME?.trim() || "Owner", hashPassword(password), timestamp],
    );
  }
  console.log("Northstar PostgreSQL database ready");
} finally {
  await pool.end();
}
