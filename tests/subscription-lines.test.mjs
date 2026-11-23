import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import test from "node:test";
import pg from "pg";
import { hashPassword } from "../server/password.ts";

// Same database switch as the native admission test: a throwaway Postgres the test may write to.
const database = process.env.VEILBIRD_NATIVE_TEST_DATABASE_URL;
const parseConfig = (text) => Object.fromEntries(text.trim().split("\n").map((line) => [line.slice(0, line.indexOf(":")), JSON.parse(line.slice(line.indexOf(":") + 1))]));

test("subscriptions: Hysteria2 + REALITY + XHTTP per node once the node loaded them, traffic counted", { skip: !database, timeout: 90000 }, async () => {
  const env = { ...process.env, VEILBIRD_DATABASE_URL: database, VEILBIRD_NATIVE_ACCESS_ENABLED: "1", VEILBIRD_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"), VEILBIRD_PUBLIC_ORIGIN: "https://portal.example.com" };
  execFileSync(process.execPath, ["scripts/migrate.mjs"], { env, stdio: "pipe" });
  const pool = new pg.Pool({ connectionString: database });
  const stamp = new Date().toISOString(), user = `sub_${Date.now()}`, node = `${user}_node`, password = "test-password-123", agentToken = randomBytes(24).toString("hex");
  const connectivity = { protocols: { vless: { runtimeActive: true, listening: true }, stealth: { runtimeActive: true, listening: true } } };
  await pool.query("INSERT INTO users(id,email,display_name,password_hash,status,role,native_only,access_ok,created_at,updated_at) VALUES($1,$2,'Sub test',$3,'active','user',FALSE,TRUE,$4,$4)", [user, `${user}@example.com`, hashPassword(password), stamp]);
  await pool.query(`INSERT INTO nodes(id,name,place,ip,ssh_user,credential_type,credential_ciphertext,credential_iv,credential_tag,status,last_heartbeat_at,server_public_key,agent_capabilities_json,agent_token_hash,created_at,updated_at)
    VALUES($1,'Tokyo','Test','192.0.2.7','root','password','','','','online',$2,$3,$4,$5,$2,$2)`, [node, stamp, randomBytes(32).toString("base64"), JSON.stringify({ connectivity }), createHash("sha256").update(agentToken).digest("hex")]);
  await pool.query("INSERT INTO vpn_services(node_id,protocol,transport,listen_port,subnet,status,created_at,updated_at) VALUES($1,'vless','tcp',443,'','healthy',$2,$2),($1,'stealth','udp',8443,'','healthy',$2,$2)", [node, stamp]);
  await pool.query("INSERT INTO node_protocols(node_id,protocol,updated_at) VALUES($1,'vless',$2),($1,'stealth',$2)", [node, stamp]);
  await pool.query("INSERT INTO secret_materials(id,kind,owner_node_id,ciphertext,iv,tag,fingerprint,created_at,updated_at) VALUES($1,'reality_server',$2,'x','x','x','x',$3,$3)", [`${node}_reality`, node, stamp]);
  await pool.query("INSERT INTO reality_settings(node_id,server_name,public_key,short_id,secret_id) VALUES($1,'www.example.com','AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA','0123456789abcdef',$2)", [node, `${node}_reality`]);
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", "3381", "-H", "127.0.0.1"], { env, stdio: "ignore" });
  const base = "http://127.0.0.1:3381";
  const fetchSubscription = (token, userAgent) => fetch(`${base}/api/subscription?token=${token}`, { headers: { "User-Agent": userAgent } });
  const applyAll = async () => {
    for (const row of (await pool.query("SELECT protocol,revision FROM desired_configs WHERE node_id=$1", [node])).rows) {
      await pool.query(`INSERT INTO observed_configs(node_id,protocol,applied_revision,observed_hash,status,updated_at) VALUES($1,$2,$3,'test','applied',$4)
        ON CONFLICT (node_id,protocol) DO UPDATE SET applied_revision=EXCLUDED.applied_revision,status='applied'`, [node, row.protocol, row.revision, new Date().toISOString()]);
    }
  };
  try {
    let ready = false; for (let i = 0; i < 100; i++) { if (await fetch(`${base}/api/v1/health`).then(() => true).catch(() => false)) { ready = true; break; } await new Promise((r) => setTimeout(r, 100)); } assert.ok(ready);
    const login = await (await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `${user}@example.com`, password }) })).json();
    const auth = { Authorization: `Bearer ${login.accessToken}`, "Content-Type": "application/json" };
    // First use makes the account's one subscription; it is VLESS.
    const created = await fetch(`${base}/api/v1/subscriptions`, { method: "POST", headers: auth, body: "{}" });
    assert.equal(created.status, 200);
    const { subscription } = await created.json();
    const token = subscription.token;
    const credentialId = (await pool.query("SELECT credential_id FROM subscriptions WHERE id=$1", [subscription.id])).rows[0].credential_id;
    assert.equal((await pool.query("SELECT protocol FROM access_credentials WHERE id=$1", [credentialId])).rows[0].protocol, "vless");
    // Creating it rebuilt both services of the node: VLESS and the stealth one that carries the same user.
    const desired = Object.fromEntries((await pool.query("SELECT protocol,revision,payload_json FROM desired_configs WHERE node_id=$1", [node])).rows.map((row) => [row.protocol, row]));
    assert.ok(desired.vless && desired.stealth, JSON.stringify(Object.keys(desired)));
    assert.equal((await fetchSubscription(token, "clash-verge/v2.2.3")).status, 503, "nothing applied on the node yet");

    // The node applied VLESS but not yet stealth: REALITY only, no line that the node would refuse.
    await pool.query(`INSERT INTO observed_configs(node_id,protocol,applied_revision,observed_hash,status,updated_at) VALUES($1,'vless',$2,'test','applied',$3)`, [node, desired.vless.revision, stamp]);
    let config = parseConfig(await (await fetchSubscription(token, "clash-verge/v2.2.3")).text());
    assert.deepEqual(config.proxies.map((p) => p.type), ["vless"]);
    assert.equal(config.proxies[0].name, "Tokyo");

    await applyAll();
    const response = await fetchSubscription(token, "clash-verge/v2.2.3");
    assert.equal(response.status, 200);
    config = parseConfig(await response.text());
    assert.deepEqual(config.proxies.map((p) => [p.name, p.type, p.port, p.network ?? null]), [
      ["Tokyo · 线路 1", "hysteria2", 8443, null], ["Tokyo · 线路 2", "vless", 443, "tcp"], ["Tokyo · 线路 3", "vless", 8443, "xhttp"]]);
    const [hy2, reality, xhttp] = config.proxies;
    assert.equal(hy2.password, reality.uuid); assert.equal(xhttp.uuid, reality.uuid);
    assert.match(hy2.fingerprint, /^[0-9a-f]{64}$/); assert.equal(hy2.obfs, "salamander");
    assert.equal(xhttp["reality-opts"]["public-key"], reality["reality-opts"]["public-key"]);
    const groups = Object.fromEntries(config["proxy-groups"].map((group) => [group.name, group]));
    assert.deepEqual(groups.TrackNothing.proxies, ["自动选择", "Tokyo"]);
    assert.deepEqual(groups.Tokyo.proxies, ["Tokyo · 线路 1", "Tokyo · 线路 2", "Tokyo · 线路 3"]);

    // Older mihomo cores without XHTTP, Hiddify, and share-link clients by their pin support.
    assert.deepEqual(parseConfig(await (await fetchSubscription(token, "mihomo/1.19.15")).text()).proxies.map((p) => p.network ?? p.type), ["hysteria2", "tcp"]);
    assert.deepEqual(parseConfig(await (await fetchSubscription(token, "HiddifyNext/2.5.7")).text()).proxies.map((p) => p.name), ["Tokyo"]);
    const links = async (userAgent) => Buffer.from(await (await fetchSubscription(token, userAgent)).text(), "base64").toString().trim().split("\n").map((link) => new URL(link));
    assert.deepEqual((await links("Shadowrocket/2070")).map((link) => [link.protocol, decodeURIComponent(link.hash.slice(1))]), [["vless:", "Tokyo"], ["vless:", "Tokyo · 备用 1"]]);
    assert.deepEqual((await links("v2rayNG/1.10.2")).map((link) => link.protocol), ["hysteria2:", "vless:", "vless:"]);

    // Stealth traffic reported under the subscription's identity comes off the account like REALITY traffic.
    const identity = (await pool.query("SELECT identity_key FROM access_credentials WHERE id=$1", [credentialId])).rows[0].identity_key;
    const beat = await fetch(`${base}/api/v1/agent/heartbeat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      nodeId: node, token: agentToken, capabilities: { connectivity }, usageSnapshots: [{ protocol: "stealth", identityKey: identity, rxBytes: 1000, txBytes: 5000, counterEpoch: "e1" }] }) });
    assert.equal(beat.status, 200, await beat.text());
    // This bare heartbeat advertises no protocols; put the node back as the real Agent would report it.
    await pool.query("UPDATE node_protocols SET status='enabled' WHERE node_id=$1", [node]);
    const daily = (await pool.query("SELECT credential_id,protocol,upload_bytes,download_bytes FROM traffic_daily WHERE user_id=$1", [user])).rows;
    assert.deepEqual(daily.map((row) => [row.credential_id, row.protocol, Number(row.upload_bytes), Number(row.download_bytes)]), [[credentialId, "stealth", 1000, 5000]]);

    // An old WireGuard subscription moves to VLESS under the same link (minute jobs, first run 15 s after start);
    // its WireGuard credential stays usable for 7 days.
    const wgCred = `cred_wg_${user}`, wgDevice = `dev_wg_${user}`, wgToken = randomBytes(32).toString("base64url");
    const old = new Date(Date.now() - 86400000).toISOString(), farFuture = new Date(Date.now() + 365 * 86400000).toISOString();
    await pool.query("INSERT INTO devices(id,user_id,display_name,platform,app_version,public_key,status,created_at,updated_at) VALUES($1,$2,'Old WG','web','credential-1.0.0',$3,'active',$4,$4)", [wgDevice, user, randomBytes(32).toString("base64"), old]);
    await pool.query("INSERT INTO access_credentials(id,user_id,device_id,display_name,protocol,identity_key,status,created_at,updated_at,expires_at) VALUES($1,$2,$3,'Old WG','wireguard',$4,'active',$5,$5,$6)", [wgCred, user, wgDevice, randomBytes(32).toString("base64"), old, farFuture]);
    await pool.query("INSERT INTO subscriptions(id,credential_id,token_hash,created_at,updated_at) VALUES($1,$2,$3,$4,$4)", [`sub_wg_${user}`, wgCred, createHash("sha256").update(wgToken).digest("hex"), old]);
    let upgraded;
    for (let i = 0; i < 60 && !upgraded; i++) {
      upgraded = (await pool.query("SELECT c.protocol,c.created_at FROM subscriptions s JOIN access_credentials c ON c.id=s.credential_id WHERE s.id=$1 AND c.protocol='vless'", [`sub_wg_${user}`])).rows[0];
      if (!upgraded) await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(upgraded, "WireGuard subscription upgraded");
    assert.ok(Date.parse(upgraded.created_at) < Date.parse(old), "new credential ranks before the old one for device limits");
    const wgLeft = (await pool.query("SELECT status,expires_at FROM access_credentials WHERE id=$1", [wgCred])).rows[0];
    assert.equal(wgLeft.status, "active");
    assert.ok(Math.abs(Date.parse(wgLeft.expires_at) - Date.now() - 7 * 86400000) < 120000, "WireGuard keeps 7 days");
    assert.equal((await fetchSubscription(wgToken, "clash-verge/v2.2.3")).status, 503, "node has not loaded the new credential yet");
    await applyAll();
    const wgConfig = parseConfig(await (await fetchSubscription(wgToken, "clash-verge/v2.2.3")).text());
    assert.deepEqual(wgConfig.proxies.map((p) => p.type), ["hysteria2", "vless", "vless"]);

    // Deleting the subscription takes it off the stealth service too.
    const before = (await pool.query("SELECT revision FROM desired_configs WHERE node_id=$1 AND protocol='stealth'", [node])).rows[0].revision;
    const removed = await fetch(`${base}/api/v1/subscriptions`, { method: "PATCH", headers: auth, body: JSON.stringify({ id: subscription.id, action: "delete" }) });
    assert.equal(removed.status, 200, await removed.text());
    assert.ok((await pool.query("SELECT revision FROM desired_configs WHERE node_id=$1 AND protocol='stealth'", [node])).rows[0].revision > before);
  } finally {
    server.kill();
    await pool.end();
  }
});
