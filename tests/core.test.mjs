import assert from "node:assert/strict";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createHash, X509Certificate } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";
import test, { after, before } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = 3187;
const base = `http://127.0.0.1:${port}`;
let server;
const databaseUrl = process.env.NORTHSTAR_TEST_DATABASE_URL;
const integrationOptions = databaseUrl
  ? {}
  : { skip: "Set NORTHSTAR_TEST_DATABASE_URL to a disposable PostgreSQL database to run integration tests." };
const execFileAsync = promisify(execFile);

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
  assert.match(agent, /\["systemctl", "restart", "northstar-openvpn"\]/);
  assert.match(agent, /add\[add\.index\("-C"\)\] = operation/);
  assert.doesNotMatch(agent, /add\[1\] = operation/);
  assert.match(agent, /\/etc\/wireguard\/northstar\.conf/);
  assert.match(agent, /agent 2\.6\.0/);
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
  assert.match(portal, /createZipBlob/);
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
  const admin = readFileSync(path.join(root, "admin-web/src/pages.tsx"), "utf8");
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
  const admin = readFileSync(path.join(root, "admin-web/src/pages.tsx"), "utf8");
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
  const admin = readFileSync(path.join(root, "admin-web/src/pages.tsx"), "utf8");
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
    NORTHSTAR_DATABASE_URL: databaseUrl,
    NORTHSTAR_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    NORTHSTAR_ADMIN_EMAIL: "owner@example.com",
    NORTHSTAR_ADMIN_PASSWORD: "test-password-123",
    NORTHSTAR_PUBLIC_ORIGIN: base,
  };
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

test("health endpoint is public", integrationOptions, async () => {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json().then((body) => body.status), "ok");
});

test("node API requires an authenticated session", integrationOptions, async () => {
  const response = await fetch(`${base}/api/nodes`);
  assert.equal(response.status, 401);
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
  assert.equal(registration.status, 201);
  const userId = (await registration.json()).user.id;
  const statusPath = `/api/v1/admin/users/${userId}/status`;
  assert.equal((await call(statusPath, adminToken, { status: "active" })).status, 200);
  let token = await login(email);
  const created = await call("/api/v1/credentials", token, { name: "Reusable", protocol: "wireguard", publicKey: Buffer.alloc(32, 5).toString("base64") });
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
    const wgIssued = await call("/api/v1/profiles", token, { credentialId: id, protocol: "wireguard", clientPrivateKey: Buffer.alloc(32, 5).toString("base64") });
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
    const migrate = () => execFileAsync(process.execPath, [fileURLToPath(new URL("../scripts/migrate.mjs", import.meta.url))], { cwd: root, env: { ...process.env, NORTHSTAR_DATABASE_URL: databaseUrl } });
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
