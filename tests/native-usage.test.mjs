import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";
import test from "node:test";
import { hashPassword } from "../server/password.ts";

// The apps' usage page: traffic_daily summed per day, per signed-in app (all its per-node device rows) and per location.
test("Native usage: per day, per device and per location from traffic_daily", { skip: !process.env.VEILBIRD_TEST_DATABASE_URL, timeout: 90000 }, async () => {
  const databaseUrl = process.env.VEILBIRD_TEST_DATABASE_URL;
  const base = "http://127.0.0.1:3199/api/v2/native/";
  const env = { ...process.env, VEILBIRD_DATABASE_URL: databaseUrl, VEILBIRD_NATIVE_ACCESS_ENABLED: "1", VEILBIRD_MASTER_KEY: Buffer.alloc(32, 9).toString("base64") };
  await promisify(execFile)(process.execPath, ["scripts/migrate.mjs"], { env });
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3199"], { env, stdio: "ignore" });
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const stamp = new Date().toISOString(), user = `usage_${Date.now()}`, password = "test-password-123";
  const day = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);
  try {
    for (let attempt = 0; attempt < 100 && !await fetch(base + "account").then(() => true).catch(() => false); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
    await pool.query("INSERT INTO users(id,email,display_name,password_hash,status,role,native_only,created_at,updated_at) VALUES($1,$2,'Usage',$3,'active','user',TRUE,$4,$4)", [user, `${user}@example.com`, hashPassword(password), stamp]);
    const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const login = await fetch(base + "login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `${user}@example.com`, password, identityKey: keys.publicKey.export({ format: "jwk" }), platform: "android", deviceName: "Pixel" }) });
    assert.equal(login.status, 200);
    const token = (await login.json()).accessToken;
    const { identity_thumbprint: thumbprint } = (await pool.query("SELECT identity_thumbprint FROM native_sessions WHERE user_id=$1", [user])).rows[0];
    await pool.query("INSERT INTO regions(id,name,country,code,created_at,updated_at) VALUES($1,$1,'Japan','jp',$2,$2) ON CONFLICT DO NOTHING", [`${user}_tokyo`, stamp]);
    for (const [node, region] of [[`${user}_a`, `${user}_tokyo`], [`${user}_b`, null]]) {
      await pool.query(`INSERT INTO nodes(id,name,place,ip,ssh_user,credential_type,credential_ciphertext,credential_iv,credential_tag,status,region_id,created_at,updated_at)
        VALUES($1,$1,'Test','192.0.2.1','root','password','','','','online',$2,$3,$3)`, [node, region, stamp]);
    }
    // This app (one device row per node it used), another app, and a subscription device.
    await pool.query("INSERT INTO native_enrollments(id,user_id,identity_thumbprint,device_name,platform) VALUES($1,$2,$3,'Pixel','android'),($4,$2,'other','MacBook','macos')", [`${user}_me`, user, thumbprint, `${user}_mac`]);
    for (const device of ["me_a", "me_b", "mac_a", "cfg"]) {
      await pool.query("INSERT INTO devices(id,user_id,display_name,platform,app_version,public_key,status,created_at,updated_at) VALUES($1,$2,$3,'web','native-1',$4,'active',$5,$5)", [`${user}_${device}`, user, device === "cfg" ? "Clash" : "native", randomBytes(32).toString("base64"), stamp]);
    }
    for (const [device, enrollment, node] of [["me_a", "me", "a"], ["me_b", "me", "b"], ["mac_a", "mac", "a"]]) {
      await pool.query("INSERT INTO native_leases(id,enrollment_id,node_id,device_id,public_key,address,expires_at) VALUES($1,$2,$3,$4,$5,'10.0.0.2/32',now())", [`${user}_${device}_lease`, `${user}_${enrollment}`, `${user}_${node}`, `${user}_${device}`, randomBytes(32).toString("base64")]);
    }
    const rows = [[0, "me_a", "a", 100, 900], [0, "me_b", "b", 50, 450], [1, "mac_a", "a", 10, 290], [2, "cfg", "b", 0, 200], [40, "me_a", "a", 5000, 5000]];
    for (const [ago, device, node, up, down] of rows) {
      await pool.query(`INSERT INTO traffic_daily(day,user_id,device_id,node_id,protocol,upload_bytes,download_bytes,first_seen_at,last_seen_at) VALUES($1,$2,$3,$4,'vless',$5,$6,$7,$7)`,
        [day(ago), user, `${user}_${device}`, `${user}_${node}`, up, down, stamp]);
    }
    const usage = async (query = "") => { const response = await fetch(base + "usage" + query, { headers: { Authorization: `Bearer ${token}` } }); assert.equal(response.status, 200); return response.json(); };
    const month = await usage();
    assert.equal(month.days, 30);
    assert.deepEqual(month.daily, [{ day: day(2), upload: "0", download: "200" }, { day: day(1), upload: "10", download: "290" }, { day: day(0), upload: "150", download: "1350" }]);
    assert.deepEqual(month.devices.map((d) => [d.name, d.bytes, d.isCurrent]), [["Pixel", "1500", true], ["MacBook", "300", false], ["Clash", "200", false]]);
    assert.deepEqual(month.nodes.map((n) => [n.id, n.bytes, n.countryCode]), [[`${user}_a`, "1300", "JP"], [`${user}_b`, "700", null]]);
    assert.equal((await usage("?days=90")).devices[0].bytes, "11500", "older traffic inside a longer range");
    assert.deepEqual((await usage("?days=1")).daily.map((d) => d.day), [day(0)]);
    assert.equal((await usage("?days=5000")).days, 90);
    assert.equal((await fetch(base + "usage")).status, 401);
  } finally {
    // Other suites share the database and expect an empty fleet: leave nothing behind.
    await pool.query("DELETE FROM nodes WHERE id LIKE $1", [`${user}_%`]).catch(() => undefined);
    await pool.query("DELETE FROM regions WHERE id=$1", [`${user}_tokyo`]).catch(() => undefined);
    await pool.query("DELETE FROM users WHERE id=$1", [user]).catch(() => undefined);
    server.kill("SIGTERM"); await pool.end();
  }
});
