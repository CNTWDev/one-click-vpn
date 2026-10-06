import assert from "node:assert/strict";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import { createHash, X509Certificate } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";
import { x25519 } from "@noble/curves/ed25519.js";
import test, { after, before } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = 3187;
const base = `http://127.0.0.1:${port}`;
let server;
const databaseUrl = process.env.VEILBIRD_TEST_DATABASE_URL;
const integrationOptions = databaseUrl
  ? {}
  : { skip: "Set VEILBIRD_TEST_DATABASE_URL to a disposable PostgreSQL database to run integration tests." };
const execFileAsync = promisify(execFile);

// Admin pages live in one file per page; source assertions search all of them.
function adminPagesSource() {
  const directory = path.join(root, "admin-web/src/pages");
  return readdirSync(directory).filter((name) => name.endsWith(".tsx")).sort().map((name) => readFileSync(path.join(directory, name), "utf8")).join("\n");
}

test("VPN service lifecycle is represented in schema and Agent tasks", () => {
  const migration = readFileSync(path.join(root, "scripts/migrate.mjs"), "utf8");
  const agent = readFileSync(path.join(root, "agent/agent.py"), "utf8");
  const bootstrap = readFileSync(path.join(root, "server/bootstrap.ts"), "utf8");
  const openVpnPki = readFileSync(path.join(root, "server/openvpn-pki.ts"), "utf8");
  const traffic = readFileSync(path.join(root, "server/traffic.ts"), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS vpn_services/);
  assert.match(migration, /deployment_policy TEXT NOT NULL DEFAULT 'standard'/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS policy_rollouts/);
  assert.match(agent, /DisableWireGuard/);
  assert.match(agent, /DisableOpenVpn/);
  assert.match(agent, /RestartWireGuard/);
  assert.match(agent, /RestartOpenVpn/);
  assert.match(agent, /restart_and_verify\("northstar-openvpn"\)/);
  assert.match(agent, /add\[add\.index\("-C"\)\] = operation/);
  assert.doesNotMatch(agent, /add\[1\] = operation/);
  assert.match(agent, /\/etc\/wireguard\/northstar\.conf/);
  assert.match(agent, /agent 2\.10\.0/);
  assert.match(agent, /status-version 3/);
  assert.match(agent, /def openvpn_usage_snapshots/);
  assert.match(agent, /wireguard_usage_snapshots\(\) \+ openvpn_usage_snapshots\(\)/);
  assert.doesNotMatch(bootstrap, /CapabilityBoundingSet=CAP_NET_ADMIN/);
  assert.doesNotMatch(bootstrap, /AmbientCapabilities=CAP_NET_ADMIN/);
  assert.match(bootstrap, /ProtectSystem=strict/);
  assert.match(bootstrap, /ReadWritePaths=\/opt\/northstar-agent \/etc\/wireguard \/etc\/systemd\/system/);
  assert.match(openVpnPki, /safeCommonName\(`northstar-\$\{credentialId\}`\)/);
  assert.doesNotMatch(openVpnPki, /commonName: `northstar-device-\$\{deviceName\}`/);
  assert.match(readFileSync(path.join(root, "server/control-plane.ts"), "utf8"), /displayName: device\?\.display_name \|\| null/);
  assert.match(traffic, /snapshot\.protocol === "wireguard"/);
  assert.match(traffic, /certificate_issuances c/);
  assert.match(traffic, /export async function usageByCredentials/);
});

test("regional profiles provide protocol-appropriate multi-node behavior", async () => {
  const controlPlane = readFileSync(path.join(root, "server/control-plane.ts"), "utf8");
  const openVpnPki = readFileSync(path.join(root, "server/openvpn-pki.ts"), "utf8");
  const heartbeat = readFileSync(path.join(root, "app/api/v1/agent/heartbeat/route.ts"), "utf8");
  const portal = readFileSync(path.join(root, "portal-web/src/credential-dashboard.tsx"), "utf8");
  assert.match(controlPlane, /export async function issueRegionalConnectionProfiles/);
  assert.match(controlPlane, /input\.protocol === "wireguard"/);
  assert.match(controlPlane, /regionalEndpoints: regionalCandidates\.map/);
  assert.match(controlPlane, /reconcileAllOpenVpnNodes/);
  assert.match(openVpnPki, /remote-random/);
  assert.match(openVpnPki, /regionalEndpoints/);
  assert.match(openVpnPki, /endpoint\.transport === "tcp" \? "tcp-client" : "udp"/);
  assert.match(heartbeat, /activeSessionCount/);
  assert.match(portal, /saveFiles/);
  assert.match(readFileSync(path.join(root, "portal-web/src/files.ts"), "utf8"), /createZipBlob/);
  const { createZipBlob } = await import("../portal-web/src/zip.ts");
  const archive = new Uint8Array(await createZipBlob([
    { name: "SG-node-1.conf", text: "[Interface]\nPrivateKey = one\n" },
    { name: "SG-node-2.conf", text: "[Interface]\nPrivateKey = two\n" },
  ]).arrayBuffer());
  assert.deepEqual([...archive.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  assert.match(new TextDecoder().decode(archive), /SG-node-1\.conf/);
  assert.match(new TextDecoder().decode(archive), /SG-node-2\.conf/);
});

test("SSH access supports parsed private keys and a shared privilege boundary", async () => {
  const migration = readFileSync(path.join(root, "scripts/migrate.mjs"), "utf8");
  const bootstrap = readFileSync(path.join(root, "server/bootstrap.ts"), "utf8");
  const admin = adminPagesSource();
  assert.match(migration, /ssh_privilege_mode TEXT NOT NULL DEFAULT 'auto'/);
  assert.match(bootstrap, /executeRemoteCommand/);
  assert.doesNotMatch(bootstrap, /privateKey: secret/);
  assert.match(admin, /测试 SSH 连接/);
  assert.match(admin, /选择 \.pem \/ \.key 文件/);
  const [{ default: ssh2 }, remoteSsh] = await Promise.all([import("ssh2"), import("../server/remote-ssh.ts")]);
  const privateKey = ssh2.utils.generateKeyPairSync("ed25519").private;
  const normalized = remoteSsh.validateSshCredential("private_key", privateKey);
  const parsed = ssh2.utils.parseKey(normalized);
  assert.equal(parsed.isPrivateKey(), true);
  const publicKey = `${parsed.type} ${parsed.getPublicSSH().toString("base64")}`;
  assert.throws(() => remoteSsh.validateSshCredential("private_key", publicKey), /private key is required/i);
  assert.equal(remoteSsh.privilegeMode(undefined, "root"), "root");
  assert.equal(remoteSsh.privilegeMode(undefined, "ubuntu"), "sudo");
});

test("node onboarding discovers persistent identity and preserves canonical SSH fingerprints", async () => {
  const migration = readFileSync(path.join(root, "scripts/migrate.mjs"), "utf8");
  const bootstrap = readFileSync(path.join(root, "server/bootstrap.ts"), "utf8");
  const createRoute = readFileSync(path.join(root, "app/api/nodes/route.ts"), "utf8");
  const admin = adminPagesSource();
  const fingerprint = await import("../server/ssh-fingerprint.js");
  const key = Buffer.from("case-sensitive-host-key");
  const expected = createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
  assert.equal(fingerprint.fingerprintForms(key).standard, expected);
  assert.equal(fingerprint.normalizeFingerprint("SHA256:AbCDef012+/="), "AbCDef012+/");
  assert.equal(fingerprint.fingerprintsEqual("SHA256:AbCDef", "SHA256:aBcDef"), false);
  assert.match(migration, /node_identity TEXT/);
  assert.match(migration, /nodes_node_identity_unique_idx/);
  assert.match(createRoute, /discoverRemoteNode/);
  assert.ok(createRoute.indexOf("await discoverRemoteNode") < createRoute.indexOf("await insertNode"));
  assert.match(bootstrap, /bindNodeIdentity/);
  assert.match(readFileSync(path.join(root, "server/remote-ssh.ts"), "utf8"), /\/var\/lib\/northstar\/node-id/);
  assert.match(admin, /无需手工生成或填写指纹/);
  assert.doesNotMatch(admin, /SSH 主机指纹（生产环境必填）/);
});

test("administrator account access exposes certificates, traffic attribution, and revocation controls", () => {
  const traffic = readFileSync(path.join(root, "server/traffic.ts"), "utf8");
  const usersRoute = readFileSync(path.join(root, "app/api/v1/admin/users/route.ts"), "utf8");
  const credentialsRoute = readFileSync(path.join(root, "app/api/v1/admin/users/[id]/credentials/route.ts"), "utf8");
  const statusRoute = readFileSync(path.join(root, "app/api/v1/admin/users/[id]/status/route.ts"), "utf8");
  const admin = adminPagesSource();
  assert.match(traffic, /export async function adminUserAccessSummaries/);
  assert.match(traffic, /export async function adminUserAccessOverview/);
  assert.match(traffic, /certificate_pem/);
  assert.match(traffic, /certificate-validity-window/);
  assert.match(traffic, /profile-validity-window/);
  assert.match(usersRoute, /accessSummary/);
  assert.match(credentialsRoute, /revoke-credential/);
  assert.match(credentialsRoute, /revoke-all-credentials/);
  assert.match(statusRoute, /revokeApiSessionsForUser/);
  assert.match(statusRoute, /deleteSessionsForUser/);
  assert.match(statusRoute, /reconcileUserAccess/);
  assert.match(admin, /OpenVPN 公开证书/);
  assert.match(admin, /撤销全部凭据/);
  assert.match(admin, /凭据窗口流量/);
});

test("user access is credential-first and shared OpenVPN sessions remain separately metered", () => {
  const migration = readFileSync(path.join(root, "scripts/migrate.mjs"), "utf8");
  const credentialRoute = readFileSync(path.join(root, "app/api/v1/credentials/route.ts"), "utf8");
  const portal = readFileSync(path.join(root, "portal-web/src/credential-dashboard.tsx"), "utf8");
  const agent = readFileSync(path.join(root, "agent/agent.py"), "utf8");
  const traffic = readFileSync(path.join(root, "server/traffic.ts"), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS access_credentials/);
  assert.match(migration, /session_key TEXT NOT NULL DEFAULT ''/);
  assert.match(credentialRoute, /createAccessCredential/);
  assert.match(portal, /我的连接/);
  assert.match(portal, /window\.setInterval/);
  assert.match(agent, /"duplicate-cn"/);
  assert.match(agent, /"sessionKey": session_key/);
  assert.match(traffic, /export async function credentialAccessOverview/);
  assert.match(traffic, /last_traffic_at/);
  assert.match(traffic, /telemetry-delayed/);
});

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {
      // Next is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Next production server did not start in time");
}

before(async () => {
  if (!databaseUrl) {
    return;
  }
  const testEnv = {
    ...process.env,
    NODE_ENV: "production",
    VEILBIRD_DATABASE_URL: databaseUrl,
    VEILBIRD_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    VEILBIRD_ADMIN_EMAIL: "owner@example.com",
    VEILBIRD_ADMIN_PASSWORD: "test-password-123",
    VEILBIRD_PUBLIC_ORIGIN: base,
  };
  // Exercise upgrades from the legacy country-code uniqueness constraint.
  const legacyPool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await legacyPool.query(`CREATE TABLE IF NOT EXISTS regions (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, country TEXT NOT NULL, code TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (name, country), UNIQUE (code)
    )`);
  } finally { await legacyPool.end(); }
  await execFileAsync(process.execPath, [path.join(root, "scripts/migrate.mjs")], { cwd: root, env: testEnv });
  await execFileAsync(process.execPath, [path.join(root, "scripts/migrate.mjs")], { cwd: root, env: testEnv });
  server = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env: testEnv,
    stdio: "ignore",
  });
  await waitForServer();
});

after(async () => {
  server?.kill("SIGTERM");
});

async function userIdFor(email, adminToken) {
  const response = await fetch(`${base}/api/v1/admin/users`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(response.status, 200);
  const user = (await response.json()).users.find((item) => item.email === email);
  assert.ok(user, `registered user ${email} not found`);
  return user.id;
}

test("Agent operations expose release, recover expired tasks and preserve live tasks", integrationOptions, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const nodeId = `ops_${Date.now()}`;
  const json = { "Content-Type": "application/json" };
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ email: "owner@example.com", password: "test-password-123" }) });
  assert.equal(login.status, 200);
  const headers = { ...json, Cookie: login.headers.get("set-cookie").split(";")[0] };
  try {
    assert.equal((await fetch(`${base}/api/nodes/agent-release`)).status, 401);
    const release = await fetch(`${base}/api/nodes/agent-release`, { headers });
    assert.equal(release.status, 200);
    assert.equal((await release.json()).version, "agent 2.10.0");
    const timestamp = new Date().toISOString();
    await pool.query(`INSERT INTO nodes (id,name,place,ip,ssh_user,credential_type,credential_ciphertext,credential_iv,credential_tag,created_at,updated_at)
      VALUES ($1,'Operations','Test','127.0.0.9','root','password','','','',$2,$2)`, [nodeId,timestamp]);
    await pool.query(`INSERT INTO node_actions (id,node_id,action,status,created_at) VALUES ($1,$2,'bootstrap','running',$3)`, [`${nodeId}_expired`,nodeId,new Date(Date.now()-61*60_000).toISOString()]);
    const detail = await fetch(`${base}/api/nodes/${nodeId}`, { headers });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).actions[0].status, "failed");
    await pool.query(`INSERT INTO node_actions (id,node_id,action,status,created_at,lease_updated_at) VALUES ($1,$2,'upgrade-agent','running',$3,$4)`, [`${nodeId}_live`,nodeId,new Date(Date.now()-120*60_000).toISOString(),timestamp]);
    await execFileAsync(process.execPath, [path.join(root, "scripts/migrate.mjs")], { cwd: root, env: { ...process.env, VEILBIRD_DATABASE_URL: databaseUrl } });
    const upgrade = await fetch(`${base}/api/nodes/${nodeId}/actions`, { method: "POST", headers, body: JSON.stringify({ action: "upgrade-agent" }) });
    assert.equal(upgrade.status, 409);
    const batch = await fetch(`${base}/api/nodes/batch-actions`, { method: "POST", headers, body: JSON.stringify({ action: "upgrade-agent", nodeIds: [nodeId,"missing-ops-node",nodeId] }) });
    assert.equal(batch.status, 200);
    const result = await batch.json();
    assert.equal(result.queued, 0);
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].status, "busy");
    assert.equal(result.results[1].status, "failed");
    assert.equal((await pool.query("SELECT status FROM node_actions WHERE id=$1", [`${nodeId}_live`])).rows[0].status, "running");
  } finally {
    await pool.query("DELETE FROM nodes WHERE id=$1", [nodeId]);
    await pool.end();
  }
});

test("registration does not reveal whether an email is already registered", integrationOptions, async () => {
  const json = { "Content-Type": "application/json" };
  const register = (email) => fetch(`${base}/api/v1/auth/register`, { method: "POST", headers: json, body: JSON.stringify({ email, password: "test-password-123", displayName: "Probe" }) });
  const fresh = await register(`probe-${Date.now()}@example.com`);
  const existing = await register("owner@example.com");
  assert.equal(fresh.status, 202);
  assert.equal(existing.status, 202);
  const freshBody = await fresh.json();
  const existingBody = await existing.json();
  assert.deepEqual(Object.keys(freshBody).sort(), Object.keys(existingBody).sort());
  assert.equal(freshBody.user, undefined);
});

test("health endpoint is public", integrationOptions, async () => {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json().then((body) => body.status), "ok");
});

test("node API requires an authenticated session", integrationOptions, async () => {
  const response = await fetch(`${base}/api/nodes`);
  assert.equal(response.status, 401);
});

test("regions allow multiple US locations and report duplicate names clearly", integrationOptions, async () => {
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", password: "test-password-123" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const call = (url, method, body) => fetch(`${base}${url}`, {
    method, headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ohio = { name: "Ohio", country: "United States", code: "US" };
  const first = await call("/api/regions", "POST", ohio);
  assert.equal(first.status, 201);
  const { region } = await first.json();
  const second = await call("/api/regions", "POST", { ...ohio, name: "Oregon" });
  assert.equal(second.status, 201);
  const other = (await second.json()).region;
  assert.equal((await call(`/api/regions/${other.id}`, "PATCH", { ...ohio, name: "Virginia" })).status, 200);
  const duplicate = await call("/api/regions", "POST", { ...ohio, id: "another-ohio" });
  assert.equal(duplicate.status, 409);
  assert.doesNotMatch(await duplicate.text(), /regions_.*_key|duplicate key/);
  assert.equal((await call(`/api/regions/${other.id}`, "PATCH", ohio)).status, 409);
  for (const id of [region.id, other.id]) assert.equal((await call(`/api/regions/${id}`, "DELETE")).status, 200);
});

test("owner can sign in and read an empty fleet", integrationOptions, async () => {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", password: "test-password-123" }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);

  const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.email, "owner@example.com");

  const nodes = await fetch(`${base}/api/nodes`, { headers: { Cookie: cookie } });
  assert.equal(nodes.status, 200);
  assert.deepEqual((await nodes.json()).nodes, []);
});

test("portal sessions cannot be replayed against administrator routes", integrationOptions, async () => {
  const json = { "Content-Type": "application/json" };
  const ownerLogin = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ email: "owner@example.com", password: "test-password-123" }) });
  const adminToken = (await ownerLogin.json()).accessToken;
  const email = `portal-${Date.now()}@example.com`;
  const registration = await fetch(`${base}/api/v1/auth/register`, { method: "POST", headers: json, body: JSON.stringify({ email, password: "test-password-123", displayName: "Portal user" }) });
  assert.equal(registration.status, 202);
  const userId = await userIdFor(email, adminToken);
  const approved = await fetch(`${base}/api/v1/admin/users/${userId}/status`, { method: "POST", headers: { ...json, Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ status: "active" }) });
  assert.equal(approved.status, 200);
  const portalLogin = await fetch(`${base}/api/v1/auth/web-login`, { method: "POST", headers: json, body: JSON.stringify({ email, password: "test-password-123" }) });
  assert.equal(portalLogin.status, 200);
  const portalSession = portalLogin.headers.get("set-cookie")?.split(";", 1)[0].split("=")[1];
  assert.ok(portalSession);
  const portalMe = await fetch(`${base}/api/v1/auth/me`, { headers: { Cookie: `veilbird_portal_session=${portalSession}` } });
  assert.equal(portalMe.status, 200);
  const replayed = await fetch(`${base}/api/nodes`, { headers: { Cookie: `veilbird_session=${portalSession}` } });
  assert.equal(replayed.status, 401);
});

test("agent heartbeats attribute traffic deltas to the owning credential", integrationOptions, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const json = { "Content-Type": "application/json" };
  const login = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ email: "owner@example.com", password: "test-password-123" }) });
  const token = (await login.json()).accessToken;
  const identityKey = Buffer.from(x25519.getPublicKey(x25519.utils.randomSecretKey())).toString("base64");
  const created = await fetch(`${base}/api/v1/credentials`, { method: "POST", headers: { ...json, Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "Metered", protocol: "wireguard", publicKey: identityKey }) });
  assert.equal(created.status, 201);
  const credentialId = (await created.json()).credential.id;
  const duplicate = await fetch(`${base}/api/v1/credentials`, { method: "POST", headers: { ...json, Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "Copy", protocol: "wireguard", publicKey: identityKey }) });
  assert.equal(duplicate.status, 409);
  const nodeId = `node_traffic_${Date.now()}`;
  const agentToken = `agent-${Date.now()}`;
  const timestamp = new Date().toISOString();
  try {
    await pool.query(`INSERT INTO nodes (id,name,place,ip,ssh_user,credential_type,credential_ciphertext,credential_iv,credential_tag,created_at,updated_at,agent_token_hash)
      VALUES ($1,'Traffic','Test','127.0.0.2','root','password','','','',$2,$2,$3)`, [nodeId, timestamp, createHash("sha256").update(agentToken).digest("hex")]);
    const beat = (rxBytes, txBytes) => fetch(`${base}/api/v1/agent/heartbeat`, { method: "POST", headers: json, body: JSON.stringify({
      nodeId, token: agentToken, version: "agent test",
      usageSnapshots: [
        { protocol: "wireguard", identityKey, rxBytes, txBytes, lastHandshakeAt: new Date().toISOString(), counterEpoch: "boot-1" },
        { protocol: "wireguard", identityKey: "unknown-peer", rxBytes: 5, txBytes: 5, counterEpoch: "boot-1" },
      ],
    }) });
    assert.equal((await beat(100, 1000)).status, 200);
    assert.equal((await beat(250, 1600)).status, 200);
    const daily = (await pool.query("SELECT upload_bytes::text, download_bytes::text FROM traffic_daily WHERE credential_id = $1 AND node_id = $2", [credentialId, nodeId])).rows;
    assert.deepEqual(daily, [{ upload_bytes: "250", download_bytes: "1600" }]);
    const counters = (await pool.query("SELECT identity_key, credential_id FROM traffic_counters WHERE node_id = $1 ORDER BY identity_key", [nodeId])).rows;
    assert.equal(counters.length, 2);
    assert.equal(counters.find((row) => row.identity_key === identityKey).credential_id, credentialId);
    const seen = (await pool.query("SELECT last_seen_at FROM access_credentials WHERE id = $1", [credentialId])).rows[0];
    assert.ok(seen.last_seen_at);
  } finally {
    await pool.query("DELETE FROM traffic_daily WHERE node_id = $1", [nodeId]);
    await pool.query("DELETE FROM nodes WHERE id = $1", [nodeId]);
    // Later tests count the owner's credentials, so leave none behind.
    const deviceId = (await pool.query("DELETE FROM access_credentials WHERE id = $1 RETURNING device_id", [credentialId])).rows[0]?.device_id;
    if (deviceId) await pool.query("DELETE FROM devices WHERE id = $1", [deviceId]);
    await pool.end();
  }
});

test("v1 bearer session can manage a device", integrationOptions, async () => {
  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", password: "test-password-123" }),
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  assert.ok(session.accessToken);
  assert.ok(session.refreshToken);

  const device = await fetch(`${base}/api/v1/devices`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.accessToken}`,
    },
    body: JSON.stringify({
      displayName: "Test Mac",
      platform: "macos",
      appVersion: "0.1.0",
      publicKey: "test-public-key",
    }),
  });
  assert.equal(device.status, 201);
  const deviceBody = await device.json();
  assert.equal(deviceBody.device.platform, "macos");

  const devices = await fetch(`${base}/api/v1/devices`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  assert.equal(devices.status, 200);
  assert.equal((await devices.json()).devices.length, 1);

  const credential = await fetch(`${base}/api/v1/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
    body: JSON.stringify({ name: "Shared WireGuard", protocol: "wireguard", publicKey: Buffer.alloc(32, 3).toString("base64") }),
  });
  assert.equal(credential.status, 201);
  const credentialBody = await credential.json();
  assert.equal(credentialBody.credential.name, "Shared WireGuard");
  const credentialId = credentialBody.credential.id;

  const credentials = await fetch(`${base}/api/v1/credentials`, { headers: { Authorization: `Bearer ${session.accessToken}` } });
  assert.equal(credentials.status, 200);
  assert.equal((await credentials.json()).credentials.some((item) => item.id === credentialId), true);

  const renamed = await fetch(`${base}/api/v1/credentials/${credentialId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
    body: JSON.stringify({ name: "Renamed Credential" }),
  });
  assert.equal(renamed.status, 200);

  const revoked = await fetch(`${base}/api/v1/credentials/${credentialId}/revoke`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  assert.equal(revoked.status, 200);

  const me = await fetch(`${base}/api/v1/auth/me`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.email, "owner@example.com");

  const refresh = await fetch(`${base}/api/v1/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  });
  assert.equal(refresh.status, 200);
  assert.ok((await refresh.json()).accessToken);
});

test("subscriptions provision stable multi-node WG/VLESS profiles and enforce access", integrationOptions, async () => {
  const parseConfig = (text) => Object.fromEntries(text.trim().split("\n").map((line) => [line.slice(0,line.indexOf(":")),JSON.parse(line.slice(line.indexOf(":")+1))]));
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const json = { "Content-Type": "application/json" };
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ email: "owner@example.com", password: "test-password-123" }) });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const userId = `sub-user-${Date.now()}`, email = `${userId}@example.com`, timestamp = new Date().toISOString();
  await pool.query(`INSERT INTO users (id,email,display_name,password_hash,role,status,created_at,updated_at)
    SELECT $1,$2,'Subscription user',password_hash,'member','active',$3,$3 FROM users WHERE email='owner@example.com'`, [userId,email,timestamp]);
  const userLogin = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ email, password: "test-password-123" }) });
  const token = (await userLogin.json()).accessToken;
  assert.ok(token);
  const call = (path, body, admin = false) => fetch(`${base}${path}`, { method: body ? "POST" : "GET", headers: { ...json, ...(admin ? { Cookie: cookie } : { Authorization: `Bearer ${token}` }) }, body: body ? JSON.stringify(body) : undefined });
  const patch = (id, action, admin = false, password = "test-password-123") => fetch(`${base}/api/v1/${admin ? "admin/" : ""}subscriptions`, { method: "PATCH", headers: { ...json, ...(admin ? { Cookie: cookie } : { Authorization: `Bearer ${token}` }) }, body: JSON.stringify({ id, action, password }) });
  const nodes = [`sub-node-a-${Date.now()}`, `sub-node-b-${Date.now()}`];
  const addNode = async (id) => {
    await pool.query(`INSERT INTO nodes (id,name,place,ip,ssh_user,credential_type,credential_ciphertext,credential_iv,credential_tag,created_at,updated_at,server_public_key,status,last_heartbeat_at,agent_capabilities_json)
      VALUES ($1,$1,'Test','192.0.2.10','root','password','','','',$2,$2,$3,'online',$2,$4)`, [id,timestamp,Buffer.alloc(32,9).toString("base64"),JSON.stringify({ connectivity: { protocols: { wireguard: { runtimeActive: true, listening: true }, vless: { runtimeActive: true, listening: true } } } })]);
    await pool.query(`INSERT INTO vpn_services (node_id,protocol,enabled,transport,listen_port,subnet,dns_json,status,created_at,updated_at)
      VALUES ($1,'wireguard',1,'udp',51820,'10.70.0.0/24','["1.1.1.1"]','healthy',$2,$2)`, [id,timestamp]);
    await pool.query(`INSERT INTO node_protocols (node_id,protocol,status,updated_at) VALUES ($1,'wireguard','enabled',$2),($1,'vless','enabled',$2)`, [id,timestamp]);
    await pool.query("UPDATE nodes SET region_id=(SELECT id FROM regions ORDER BY id LIMIT 1) WHERE id=$1",[id]);
  };
  const ack = async () => {
    await pool.query(`INSERT INTO observed_configs (node_id,protocol,applied_revision,observed_hash,status,last_error,updated_at)
      SELECT node_id,protocol,revision,'python-json-hash','applied','',$1 FROM desired_configs WHERE node_id=ANY($2::text[])
      ON CONFLICT(node_id,protocol) DO UPDATE SET applied_revision=excluded.applied_revision,status='applied'`, [timestamp,nodes]);
    await pool.query("UPDATE vpn_services SET status='healthy' WHERE node_id=ANY($1::text[])", [nodes]);
  };
  try {
    await addNode(nodes[0]);
    const availability = await (await call("/api/v1/availability")).json();
    assert.ok(availability.nodes.some((n) => n.id===nodes[0] && n.protocols.includes("wireguard")));
    assert.doesNotMatch(JSON.stringify(availability),/credential_ciphertext|agent_token_hash/);
    const created = await call("/api/v1/subscriptions", { name: "All nodes", protocol: "wireguard" });
    assert.equal(created.status,201);
    const sub = await created.json();
    assert.equal((await patch(sub.id,"reveal-link",false,"wrong-password")).status,403);
    const revealed = await patch(sub.id,"reveal-link");
    assert.equal(revealed.status,200);
    assert.equal((await revealed.json()).token,sub.token,"retrieving a link must not rotate it");
    assert.equal((await patch(sub.id,"reveal-link",true)).status,400,"admins cannot retrieve private links");
    const otherUserReveal = await fetch(`${base}/api/v1/subscriptions`,{method:"PATCH",headers:{...json,Cookie:cookie},body:JSON.stringify({id:sub.id,action:"reveal-link",password:"test-password-123"})});
    assert.equal(otherUserReveal.status,409,"an authenticated different owner cannot retrieve the link");
    const encryptedLink = (await pool.query("SELECT k.ciphertext FROM subscriptions s JOIN secret_materials k ON k.id=s.token_secret_id WHERE s.id=$1",[sub.id])).rows[0];
    assert.ok(encryptedLink.ciphertext);
    assert.notEqual(encryptedLink.ciphertext,sub.token);
    let url = `${base}/api/subscription?token=${sub.token}`;
    assert.equal((await fetch(url)).status,503, "never publish unacknowledged peers");
    await ack();
    let response = await fetch(url);
    assert.equal(response.status,200);
    assert.match(response.headers.get("cache-control"),/no-store/);
    let config = parseConfig(await response.text());
    assert.equal(config.proxies.length,1);
    assert.equal(config.proxies[0].type,"wireguard");
    const originalKey = config.proxies[0]["private-key"];
    const count = async () => Number((await pool.query("SELECT COUNT(*) FROM connection_profiles WHERE credential_id=$1", [sub.credentialId])).rows[0].count);
    assert.equal(await count(),1);
    await fetch(url); assert.equal(await count(),1, "refresh must not rotate identity or append duplicate profiles");
    await addNode(nodes[1]);
    assert.equal((await fetch(url)).status,200, "retain ready node while new node synchronizes");
    await ack();
    config = parseConfig(await (await fetch(url)).text());
    assert.equal(config.proxies.length,2);
    assert.ok(config.proxies.every((p) => p["private-key"] === originalKey));
    const reset = await patch(sub.id,"reset-link");
    assert.equal(reset.status,200);
    assert.equal((await fetch(url)).status,503);
    url = `${base}/api/subscription?token=${(await reset.json()).token}`;
    assert.equal((await fetch(url)).status,200);
    assert.equal((await call("/api/v1/admin/subscriptions")).status,403);
    assert.equal((await patch(sub.id,"disable",true)).status,200);
    assert.equal((await fetch(url)).status,503);
    assert.equal((await patch(sub.id,"enable")).status,409);
    assert.equal((await patch(sub.id,"enable",true)).status,200);
    await ack();
    const fixedKey = x25519.utils.randomSecretKey();
    const fixed = await call("/api/v1/credentials",{name:"Fixed node",protocol:"wireguard",publicKey:Buffer.from(x25519.getPublicKey(fixedKey)).toString("base64")});
    const fixedCredential = (await fixed.json()).credential;
    const single = await call("/api/v1/profiles",{credentialId:fixedCredential.id,nodeId:nodes[1],protocol:"wireguard",clientPrivateKey:Buffer.from(fixedKey).toString("base64")});
    assert.equal(single.status,201, single.status === 201 ? "" : await single.text());
    const fixedProfiles = (await single.json()).profiles;
    assert.equal(fixedProfiles.length,1);
    assert.equal(fixedProfiles[0].nodeId,nodes[1]);
    assert.equal((await call("/api/v1/profiles",{credentialId:fixedCredential.id,nodeId:"missing-node",protocol:"wireguard"})).status,409);
    const service = await call(`/api/nodes/${nodes[0]}/services`, { protocol: "vless", action: "enable", serverName: "www.example.com" },true);
    assert.equal(service.status,200,await service.text());
    assert.equal((await call(`/api/nodes/${nodes[0]}/services`, { protocol: "vless", action: "redeploy", serverName: "www.cloudflare.com" },true)).status,200,"initial target can be corrected before issuing profiles");
    assert.equal((await call(`/api/nodes/${nodes[0]}/services`, { protocol: "vless", action: "redeploy", serverName: "www.example.com" },true)).status,200);
    await ack();
    const vless = await call("/api/v1/subscriptions", { name: "TCP connection", protocol: "vless" });
    assert.equal(vless.status,201);
    const vsub = await vless.json();
    await ack();
    response = await fetch(`${base}/api/subscription?token=${vsub.token}`);
    assert.equal(response.status,200);
    config = parseConfig(await response.text());
    assert.equal(config.proxies[0].type,"vless");
    assert.match(config.proxies[0].uuid,/^[a-f0-9-]{36}$/);
    assert.equal(config.proxies[0].servername,"www.example.com");
    assert.ok(config.proxies[0]["reality-opts"]["public-key"]);
    // Changing the target is a smooth switch: keys stay, the old SNI stays accepted, issued profiles move to the new SNI.
    assert.equal((await call(`/api/nodes/${nodes[0]}/services`, { protocol: "vless", action: "redeploy", serverName: "www.cloudflare.com" },true)).status,200);
    let switched = (await pool.query("SELECT server_name,previous_server_names FROM reality_settings WHERE node_id=$1",[nodes[0]])).rows[0];
    assert.equal(switched.server_name,"www.cloudflare.com");
    assert.deepEqual(JSON.parse(switched.previous_server_names),["www.example.com"]);
    assert.equal((await pool.query("SELECT protocol_payload_json FROM connection_profiles WHERE credential_id=$1 AND node_id=$2",[vsub.credentialId,nodes[0]])).rows.map((row) => JSON.parse(row.protocol_payload_json).serverName).join(),"www.cloudflare.com");
    assert.equal((await call(`/api/nodes/${nodes[0]}/services`, { protocol: "vless", action: "redeploy", serverName: "www.example.com" },true)).status,200);
    switched = (await pool.query("SELECT server_name,previous_server_names FROM reality_settings WHERE node_id=$1",[nodes[0]])).rows[0];
    assert.deepEqual([switched.server_name,JSON.parse(switched.previous_server_names)],["www.example.com",["www.cloudflare.com"]]);
    await ack();
    assert.doesNotMatch(JSON.stringify(config),/serverBundleSecretId|privateKey|secret_/);
    const agentToken = "subscription-test-agent";
    const telemetryId = (await pool.query("SELECT identity_key FROM access_credentials WHERE id=$1", [vsub.credentialId])).rows[0].identity_key;
    assert.notEqual(telemetryId,config.proxies[0].uuid,"telemetry must not reveal the VLESS authorization secret");
    await pool.query("UPDATE nodes SET agent_token_hash=$1 WHERE id=$2", [createHash("sha256").update(agentToken).digest("hex"),nodes[0]]);
    const beat = await fetch(`${base}/api/v1/agent/heartbeat`, { method: "POST", headers: json, body: JSON.stringify({
      nodeId: nodes[0], token: agentToken, version: "agent 2.8.0",
      capabilities: { protocols: ["wireguard", "vless"], connectivity: { protocols: { wireguard: { runtimeActive: true, listening: true }, vless: { runtimeActive: true, listening: true } } } },
      usageSnapshots: [{ protocol: "vless", identityKey: telemetryId, rxBytes: 123, txBytes: 456, counterEpoch: "process-1" }],
    }) });
    assert.equal(beat.status,200);
    const heartbeatAgain = () => fetch(`${base}/api/v1/agent/heartbeat`, { method: "POST", headers: json, body: JSON.stringify({
      nodeId: nodes[0], token: agentToken, version: "agent 2.8.0",
      capabilities: { protocols: ["wireguard", "vless"], connectivity: { protocols: { wireguard: { runtimeActive: true, listening: true }, vless: { runtimeActive: true, listening: true } } } },
    }) });
    const originalSecret = (await pool.query("SELECT ciphertext,id FROM secret_materials WHERE id=(SELECT private_key_secret_id FROM subscriptions WHERE id=$1)", [vsub.id])).rows[0];
    const bundleCount = async () => Number((await pool.query("SELECT COUNT(*) FROM secret_materials WHERE kind='vless_users_bundle' AND owner_node_id=$1", [nodes[0]])).rows[0].count);
    const initialBundleCount = await bundleCount();
    // Unchanged fingerprints avoid decrypting every client UUID on every heartbeat.
    await pool.query("UPDATE secret_materials SET ciphertext='invalid' WHERE id=$1", [originalSecret.id]);
    try {
      await pool.query("UPDATE vpn_services SET status='attention' WHERE node_id=$1 AND protocol='vless'", [nodes[0]]);
      assert.equal((await heartbeatAgain()).status,200);
      const state = (await pool.query("SELECT status FROM vpn_services WHERE node_id=$1 AND protocol='vless'", [nodes[0]])).rows[0];
      assert.equal(state.status,"healthy", "acknowledged runtime recovers after controller-side contention");
      assert.equal(await bundleCount(),initialBundleCount);
    } finally { await pool.query("UPDATE secret_materials SET ciphertext=$1 WHERE id=$2", [originalSecret.ciphertext,originalSecret.id]); }
    const oldBundleId = `secret_old_${nodes[0]}`;
    await pool.query(`INSERT INTO secret_materials (id,kind,owner_node_id,ciphertext,iv,tag,fingerprint,created_at,updated_at)
      SELECT $1,kind,owner_node_id,ciphertext,iv,tag,fingerprint,'2000-01-01T00:00:00.000Z',updated_at
      FROM secret_materials WHERE owner_node_id=$2 AND kind='vless_users_bundle' LIMIT 1`, [oldBundleId,nodes[0]]);
    const protectedTask = `task_bundle_${nodes[0]}`;
    await pool.query(`INSERT INTO reconcile_tasks (id,node_id,protocol,task_type,desired_revision,payload_json,status,created_at)
      VALUES ($1,$2,'vless','ApplyVlessServer',1,$3,'pending',$4)`, [protectedTask,nodes[0],JSON.stringify({usersSecretId:oldBundleId}),timestamp]);
    await heartbeatAgain();
    assert.equal((await pool.query("SELECT id FROM secret_materials WHERE id=$1", [oldBundleId])).rowCount,1,"queued tasks keep their bundles");
    await pool.query("UPDATE reconcile_tasks SET status='succeeded' WHERE id=$1", [protectedTask]);
    await heartbeatAgain();
    assert.equal((await pool.query("SELECT id FROM secret_materials WHERE id=$1", [oldBundleId])).rowCount,0,"unreferenced old bundles are collected");
    const overview = await (await call("/api/v1/credentials")).json();
    const usage = overview.credentials.find((c) => c.id === vsub.credentialId);
    assert.equal(usage.totalBytes,579);
    assert.equal(usage.subscriptionId,vsub.id);
    assert.equal(usage.online,true);
    await pool.query("UPDATE users SET status='suspended' WHERE id=$1", [userId]);
    assert.equal((await fetch(`${base}/api/subscription?token=${vsub.token}`)).status,503);
    await pool.query("UPDATE users SET status='active' WHERE id=$1", [userId]);
    const desiredUsers = async () => {
      const payload = JSON.parse((await pool.query("SELECT payload_json FROM desired_configs WHERE node_id=$1 AND protocol='vless'", [nodes[0]])).rows[0].payload_json);
      assert.equal(payload.users,undefined,"task payload must not store plaintext authorization UUIDs");
      const response = await fetch(`${base}/api/v1/agent/secrets/pull`, { method: "POST", headers: json, body: JSON.stringify({ nodeId: nodes[0], token: agentToken, secretId: payload.usersSecretId }) });
      assert.equal(response.status,200);
      return JSON.parse((await response.json()).value);
    };
    assert.equal((await desiredUsers()).length,1);
    assert.equal((await patch(vsub.id,"revoke",true)).status,200);
    assert.equal((await desiredUsers()).length,0, "revocation removes server authorization");
    assert.equal((await fetch(`${base}/api/subscription?token=${vsub.token}`)).status,503);
    const list = await (await call("/api/v1/subscriptions")).json();
    assert.equal(list.subscriptions.length,2);
    assert.doesNotMatch(JSON.stringify(list),/token_hash|private_key_secret_id|token_secret_id/);
    await ack();
    const standalone = await call("/api/v1/credentials",{name:"Fixed REALITY",protocol:"vless"});
    assert.equal(standalone.status,201);
    const vc = (await standalone.json()).credential;
    const vpResponse = await call("/api/v1/profiles",{credentialId:vc.id,nodeId:nodes[0],protocol:"vless"});
    assert.equal(vpResponse.status,201);
    const vp = (await vpResponse.json()).profile;
    assert.equal((await call(`/api/v1/profiles/${vp.id}/activate`,{})).status,200);
    const exported = await call(`/api/v1/profiles/${vp.id}/download?format=mihomo`);
    assert.equal(exported.status,200);
    const singleConfig = parseConfig(await exported.text());
    assert.equal(singleConfig.proxies.length,1);
    assert.equal(singleConfig.proxies[0].type,"vless");
    assert.equal((await desiredUsers()).length,1,"standalone VLESS authorizes on the selected node");
    assert.equal((await call(`/api/v1/profiles/${vp.id}/download?format=mihomo`,undefined,true)).status,404);
    assert.equal((await call(`/api/v1/credentials/${vc.id}/revoke`,{})).status,200);
    assert.equal((await desiredUsers()).length,0);
    assert.equal((await call(`/api/v1/profiles/${vp.id}/download?format=mihomo`)).status,409);
    // Exhaust the legacy /24, then verify the Agent version gate and expanded allocator.
    await pool.query("UPDATE vpn_services SET subnet='10.70.0.0/20' WHERE node_id=$1 AND protocol='wireguard'", [nodes[0]]);
    await pool.query(`INSERT INTO devices (id,user_id,display_name,platform,app_version,public_key,created_at,updated_at)
      SELECT $1 || '-pool-' || i,$2,'Pool test','web','1.0','unused',$3,$3 FROM generate_series(2,254) i
      WHERE NOT EXISTS (SELECT 1 FROM ip_leases WHERE node_id=$1 AND protocol='wireguard' AND address='10.70.0.' || i || '/32')`, [nodes[0],userId,timestamp]);
    await pool.query(`INSERT INTO ip_leases (id,node_id,protocol,device_id,address,status,created_at)
      SELECT id,$1,'wireguard',id,'10.70.0.' || split_part(id,'-pool-',2) || '/32','active',$2
      FROM devices WHERE id LIKE $1 || '-pool-%'`, [nodes[0],timestamp]);
    const expandedKey = Buffer.from(x25519.utils.randomSecretKey());
    const expandedCredentialResponse = await call("/api/v1/credentials", {name:"Expanded pool",protocol:"wireguard",publicKey:Buffer.from(x25519.getPublicKey(expandedKey)).toString("base64")});
    assert.equal(expandedCredentialResponse.status,201);
    const expandedCredential = (await expandedCredentialResponse.json()).credential;
    const expandedRequest = {credentialId:expandedCredential.id,nodeId:nodes[0],protocol:"wireguard",clientPrivateKey:expandedKey.toString("base64")};
    await pool.query("UPDATE nodes SET version='agent 2.7.0' WHERE id=$1", [nodes[0]]);
    assert.equal((await call("/api/v1/profiles",expandedRequest)).status,409,"old Agent cannot allocate outside its /24");
    await pool.query("UPDATE nodes SET version='agent 2.8.0' WHERE id=$1", [nodes[0]]);
    const expandedProfile = await call("/api/v1/profiles",expandedRequest);
    assert.equal(expandedProfile.status,201);
    assert.equal((await expandedProfile.json()).profile.clientAddress,"10.70.0.255/32");
    await pool.query("DELETE FROM devices WHERE id LIKE $1 || '-pool-%'", [nodes[0]]);
    await pool.query("UPDATE subscriptions SET token_secret_id=NULL WHERE id=$1",[sub.id]);
    const legacyReveal = await patch(sub.id,"reveal-link");
    assert.equal(legacyReveal.status,409);
    assert.match((await legacyReveal.json()).error,/旧订阅/);
    await pool.query("UPDATE access_credentials SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=$1", [sub.credentialId]);
    assert.equal((await fetch(url)).status,503,"expired subscriptions cannot download cached keys");
    assert.equal((await patch(sub.id,"delete")).status,200);
    assert.equal((await fetch(url)).status,503);
  } finally {
    await pool.query("DELETE FROM nodes WHERE id=ANY($1::text[])", [nodes]);
    await pool.query("DELETE FROM users WHERE id=$1", [userId]);
    await pool.end();
  }
});

test("v1 agent tasks reject invalid credentials", integrationOptions, async () => {
  const response = await fetch(`${base}/api/v1/agent/tasks/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodeId: "missing", token: "invalid" }),
  });
  assert.equal(response.status, 401);
});

test("credential controls preserve independent user/admin locks and recoverable account suspension", integrationOptions, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const login = async (email) => {
    const response = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "test-password-123" }) });
    assert.equal(response.status, 200);
    return (await response.json()).accessToken;
  };
  const adminToken = await login("owner@example.com");
  const call = async (path, token, body, method = "POST") => fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const email = `controls-${Date.now()}@example.com`;
  const registration = await call("/api/v1/auth/register", adminToken, { email, password: "test-password-123", displayName: "Access test" });
  assert.equal(registration.status, 202);
  const userId = await userIdFor(email, adminToken);
  const statusPath = `/api/v1/admin/users/${userId}/status`;
  assert.equal((await call(statusPath, adminToken, { status: "active" })).status, 200);
  let token = await login(email);
  const clientPrivateKey = Buffer.from(x25519.utils.randomSecretKey());
  const created = await call("/api/v1/credentials", token, { name: "Reusable", protocol: "wireguard", publicKey: Buffer.from(x25519.getPublicKey(clientPrivateKey)).toString("base64") });
  assert.equal(created.status, 201);
  const id = (await created.json()).credential.id;
  const path = `/api/v1/credentials/${id}`;
  const adminPath = `/api/v1/admin/users/${userId}/credentials`;
  const state = async () => (await (await call("/api/v1/credentials", token, undefined, "GET")).json()).credentials.find((item) => item.id === id);
  const nodeId = `node_controls_${Date.now()}`;
  const timestamp = new Date().toISOString();
  try {
    const deviceId = (await pool.query("SELECT device_id FROM access_credentials WHERE id=$1", [id])).rows[0].device_id;
    await pool.query(`INSERT INTO nodes (id,name,place,ip,ssh_user,credential_type,credential_ciphertext,credential_iv,credential_tag,created_at,updated_at,server_public_key)
      VALUES ($1,'Controls','Test','127.0.0.1','root','password','','','',$2,$2,'server-key')`, [nodeId, timestamp]);
    await pool.query(`INSERT INTO vpn_services (node_id,protocol,enabled,transport,listen_port,subnet,dns_json,status,created_at,updated_at)
      VALUES ($1,'wireguard',1,'udp',51820,'10.70.0.0/24','[]','healthy',$2,$2)`, [nodeId, timestamp]);
    await pool.query(`INSERT INTO ip_leases (id,node_id,protocol,device_id,address,status,created_at)
      VALUES ($1,$2,'wireguard',$3,'10.70.0.2/32','active',$4)`, [`lease_${nodeId}`, nodeId, deviceId, timestamp]);
    await pool.query(`INSERT INTO connection_profiles (id,device_id,credential_id,node_id,protocol,transport,revision,status,endpoint_json,issued_at,expires_at,updated_at)
      VALUES ($1,$2,$3,$4,'wireguard','udp',1,'active','{}',$5,'2099-01-01T00:00:00.000Z',$5)`, [`profile_${nodeId}`, deviceId, id, nodeId, timestamp]);
    await pool.query(`UPDATE nodes SET status='online', last_heartbeat_at=$2, agent_capabilities_json=$3 WHERE id=$1`, [nodeId, timestamp, JSON.stringify({ connectivity: { protocols: { wireguard: { runtimeActive: true, listening: true }, openvpn: { runtimeActive: true, listening: true } } } })]);
    await pool.query(`INSERT INTO node_protocols (node_id,protocol,updated_at) VALUES ($1,'wireguard',$2),($1,'openvpn',$2)`, [nodeId, timestamp]);
    const wgIssued = await call("/api/v1/profiles", token, { credentialId: id, protocol: "wireguard", clientPrivateKey: clientPrivateKey.toString("base64") });
    assert.equal(wgIssued.status, 201);
    const wgProfile = (await wgIssued.json()).profile;
    const exportPath = `/api/v1/profiles/${wgProfile.id}/download?format=mihomo`;
    assert.equal((await call(exportPath, adminToken, undefined, "GET")).status, 404);
    assert.equal((await call(exportPath, token, undefined, "GET")).status, 409);
    await pool.query("UPDATE connection_profiles SET status='active', protocol_payload_json=$2 WHERE id=$1", [wgProfile.id, JSON.stringify({
      ...JSON.parse((await pool.query("SELECT protocol_payload_json FROM connection_profiles WHERE id=$1", [wgProfile.id])).rows[0].protocol_payload_json),
      serverPublicKey: Buffer.alloc(32, 9).toString("base64"),
    })]);
    const exported = await call(exportPath, token, undefined, "GET");
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-type"), /application\/yaml/);
    assert.match(exported.headers.get("cache-control"), /no-store/);
    assert.match(exported.headers.get("content-disposition"), /\.yaml/);
    assert.match(await exported.text(), /"type":"wireguard"/);
    assert.equal((await call(`/api/v1/profiles/${wgProfile.id}/download`, token, undefined, "GET")).status, 200);
    await pool.query("UPDATE connection_profiles SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=$1", [wgProfile.id]);
    assert.equal((await call(exportPath, token, undefined, "GET")).status, 409);
    await pool.query("UPDATE connection_profiles SET status='active', expires_at=$2 WHERE id=$1", [wgProfile.id, wgProfile.expiresAt]);
    assert.equal((await call(`/api/v1/profiles/${wgProfile.id}/download?format=invalid`, token, undefined, "GET")).status, 400);
    const wgCredential = (await pool.query("SELECT * FROM access_credentials WHERE id=$1", [id])).rows[0];
    assert.equal(wgProfile.expiresAt, wgCredential.expires_at);
    assert.equal(new Date(wgCredential.expires_at) - new Date(wgCredential.created_at), 365 * 86_400_000);
    const migrate = () => execFileAsync(process.execPath, [fileURLToPath(new URL("../scripts/migrate.mjs", import.meta.url))], { cwd: root, env: { ...process.env, VEILBIRD_DATABASE_URL: databaseUrl } });
    await pool.query("UPDATE connection_profiles SET expires_at=$2 WHERE id=$1", [wgProfile.id, new Date(new Date(wgProfile.issuedAt).getTime() + 86_400_000).toISOString()]);
    await migrate();
    await migrate();
    assert.equal((await pool.query("SELECT expires_at FROM connection_profiles WHERE id=$1", [wgProfile.id])).rows[0].expires_at, wgCredential.expires_at);
    await pool.query("UPDATE connection_profiles SET status='expired' WHERE id=$1", [wgProfile.id]);
    await migrate();
    assert.equal((await pool.query("SELECT status FROM connection_profiles WHERE id=$1", [wgProfile.id])).rows[0].status, "expired");
    assert.equal((await call(exportPath, token, undefined, "GET")).status, 409);
    await pool.query("UPDATE connection_profiles SET status='active' WHERE id=$1", [wgProfile.id]);
    await pool.query("UPDATE access_credentials SET expires_at=$2 WHERE id=$1", [id, new Date(Date.now() + 20 * 86_400_000).toISOString()]);
    assert.equal((await state()).expiringSoon, true);
    assert.equal((await state()).daysRemaining, 20);
    await pool.query("UPDATE access_credentials SET expires_at=$2 WHERE id=$1", [id, wgCredential.expires_at]);
    const peers = async () => JSON.parse((await pool.query("SELECT payload_json FROM desired_configs WHERE node_id=$1 AND protocol='wireguard'", [nodeId])).rows[0].payload_json).peers;
    assert.equal((await call(path, token, { action: "disable" }, "PATCH")).status, 200);
    assert.equal((await state()).state, "disabled");
    assert.equal((await call(exportPath, token, undefined, "GET")).status, 409);
    assert.equal((await peers()).length, 0);
    assert.equal((await state()).syncStatus, "pending");
    await pool.query("UPDATE reconcile_tasks SET status='succeeded' WHERE node_id=$1", [nodeId]);
    assert.equal((await state()).syncStatus, "applied");
    await pool.query("UPDATE reconcile_tasks SET status='failed' WHERE node_id=$1", [nodeId]);
    assert.equal((await state()).syncStatus, "failed");
    assert.equal((await call(path, adminToken, { action: "enable" }, "PATCH")).status, 404);
    assert.equal((await call(adminPath, adminToken, { action: "disable-credential", credentialId: id })).status, 200);
    assert.equal((await call(path, token, { action: "enable" }, "PATCH")).status, 409);
    assert.equal((await call(adminPath, adminToken, { action: "enable-credential", credentialId: id })).status, 200);
    assert.equal((await state()).state, "disabled");
    assert.equal((await call(path, token, { action: "enable" }, "PATCH")).status, 200);
    assert.equal((await peers()).length, 1);
    assert.equal((await call(statusPath, adminToken, { status: "suspended" })).status, 200);
    assert.equal((await peers()).length, 0);
    assert.equal((await call("/api/v1/credentials", token, undefined, "GET")).status, 401);
    assert.equal((await call(statusPath, adminToken, { status: "active" })).status, 200);
    token = await login(email);
    assert.equal((await peers()).length, 1);
    assert.equal((await state()).status, "active");
    // Exercise OpenVPN's reversible serial deny list through the same real API/service path.
    const ovCreated = await call("/api/v1/credentials", token, { name: "OpenVPN shared", protocol: "openvpn" });
    assert.equal(ovCreated.status, 201);
    const ovId = (await ovCreated.json()).credential.id;
    await pool.query(`INSERT INTO vpn_services (node_id,protocol,enabled,transport,listen_port,subnet,dns_json,status,created_at,updated_at)
      VALUES ($1,'openvpn',1,'udp',1194,'10.71.0.0/24','[]','healthy',$2,$2)
      ON CONFLICT (node_id,protocol) DO UPDATE SET status='healthy'`, [nodeId, timestamp]);
    const ovIssued = await call("/api/v1/profiles", token, { credentialId: ovId, protocol: "openvpn" });
    assert.equal(ovIssued.status, 201);
    const ovProfile = (await ovIssued.json()).profile;
    const cert = (await pool.query("SELECT * FROM certificate_issuances WHERE credential_id=$1 AND purpose='client'", [ovId])).rows[0];
    const parsedCert = new X509Certificate(cert.certificate_pem);
    assert.equal(new Date(parsedCert.validTo) - new Date(parsedCert.validFrom), 365 * 86_400_000);
    assert.equal(ovProfile.expiresAt, new Date(parsedCert.validTo).toISOString());
    assert.equal(ovProfile.expiresAt, (await pool.query("SELECT expires_at FROM access_credentials WHERE id=$1", [ovId])).rows[0].expires_at);
    const ovAction = async (action) => {
      const response = await call(adminPath, adminToken, { action: `${action}-credential`, credentialId: ovId });
      assert.equal(response.status, 200);
      return response.json();
    };
    await ovAction("disable");
    const deniedSerials = async () => JSON.parse((await pool.query("SELECT payload_json FROM desired_configs WHERE node_id=$1 AND protocol='openvpn'", [nodeId])).rows[0].payload_json).revokedSerials;
    await ovAction("disable");
    assert.ok((await deniedSerials()).includes(cert.serial));
    await ovAction("enable");
    assert.ok(!(await deniedSerials()).includes(cert.serial));
    assert.equal((await pool.query("SELECT status FROM certificate_issuances WHERE id=$1", [cert.id])).rows[0].status, "active");
    await ovAction("revoke");
    assert.ok((await deniedSerials()).includes(cert.serial));
    assert.equal((await call(adminPath, adminToken, { action: "revoke-credential", credentialId: id })).status, 200);
    assert.equal((await peers()).length, 0);
    assert.equal((await call(adminPath, adminToken, { action: "enable-credential", credentialId: id })).status, 400);
    assert.equal((await call(path, token, { action: "delete" }, "PATCH")).status, 200);
    assert.equal(await state(), undefined);
    assert.ok((await pool.query("SELECT deleted_at FROM access_credentials WHERE id=$1", [id])).rows[0].deleted_at);
    assert.ok((await pool.query("SELECT id FROM audit_logs WHERE target_id=$1", [id])).rowCount > 0);
  } finally {
    await pool.query("DELETE FROM nodes WHERE id=$1", [nodeId]);
    await pool.end();
  }
});
