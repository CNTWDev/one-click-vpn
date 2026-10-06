import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import test from "node:test";

test("REALITY defaults migration/API: admin-only, invalid changes preserve state, deployment inherits without migrating old nodes", { skip: !process.env.VEILBIRD_TEST_REALITY_DATABASE_URL }, async () => {
  const databaseUrl = process.env.VEILBIRD_TEST_REALITY_DATABASE_URL;
  const base = "http://127.0.0.1:3198";
  const env = { ...process.env, NODE_ENV: "production", VEILBIRD_DATABASE_URL: databaseUrl, VEILBIRD_MASTER_KEY: Buffer.alloc(32,7).toString("base64"), VEILBIRD_ADMIN_EMAIL: "owner@example.com", VEILBIRD_ADMIN_PASSWORD: "test-password-123", VEILBIRD_PUBLIC_ORIGIN: base, VEILBIRD_PORTAL_DOMAIN: "app.example.com", VEILBIRD_REALITY_TARGET: "environment.example.com" };
  const exec = promisify(execFile);
  await exec(process.execPath, ["scripts/migrate.mjs"], { env });
  await exec(process.execPath, ["scripts/migrate.mjs"], { env });
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3198"], { env, stdio: "ignore" });
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const nodes = [`reality_default_${Date.now()}`, `reality_existing_${Date.now()}`];
  try {
    let ready = false;
    for (let attempt=0; attempt<100; attempt++) {
      if (await fetch(base+"/api/health").then((r)=>r.ok).catch(()=>false)) { ready=true; break; }
      await new Promise((resolve)=>setTimeout(resolve,100));
    }
    assert.equal(ready,true);
    assert.equal((await fetch(base+"/api/reality-defaults")).status,401);
    const json = { "Content-Type":"application/json" };
    assert.equal((await fetch(base+"/api/reality-defaults",{method:"PUT",headers:json,body:JSON.stringify({serverName:"www.example.com"})})).status,401);
    const login = await fetch(base+"/api/auth/login", { method:"POST",headers:json,body:JSON.stringify({email:"owner@example.com",password:"test-password-123"}) });
    assert.equal(login.status,200);
    const headers = { ...json,Cookie:login.headers.get("set-cookie").split(";")[0] };
    assert.equal((await (await fetch(base+"/api/reality-defaults",{headers})).json()).serverName,"environment.example.com");
    const timestamp = new Date().toISOString();
    await pool.query("INSERT INTO reality_defaults VALUES ('primary','default.example.com',$1,$1) ON CONFLICT (id) DO UPDATE SET server_name=EXCLUDED.server_name",[timestamp]);
    assert.equal((await (await fetch(base+"/api/reality-defaults",{headers})).json()).serverName,"default.example.com");
    for (const serverName of ["http://bad.example.com", "127.0.0.1", "app.example.com"]) {
      const response = await fetch(base+"/api/reality-defaults",{method:"PUT",headers,body:JSON.stringify({serverName})});
      assert.equal(response.status,400,await response.text());
    }
    assert.equal((await pool.query("SELECT server_name FROM reality_defaults")).rows[0].server_name,"default.example.com");
    for (const id of nodes) await pool.query(`INSERT INTO nodes (id,name,place,ip,ssh_user,credential_type,credential_ciphertext,credential_iv,credential_tag,created_at,updated_at)
      VALUES ($1,$1,'Test','192.0.2.8','root','password','','','',$2,$2)`,[id,timestamp]);
    const deploy = (id, serverName) => fetch(base+`/api/nodes/${id}/services`,{method:"POST",headers,body:JSON.stringify({protocol:"vless",action:"enable",listenPort:8443,...(serverName ? {serverName} : {})})});
    let response = await deploy(nodes[0]);
    assert.equal(response.status,200,await response.text());
    response = await deploy(nodes[1],"old.example.com");
    assert.equal(response.status,200,await response.text());
    await pool.query("UPDATE reality_defaults SET server_name='new.example.com'");
    response = await deploy(nodes[1]);
    assert.equal(response.status,200,await response.text());
    assert.deepEqual((await pool.query("SELECT server_name FROM reality_settings WHERE node_id=ANY($1) ORDER BY node_id",[nodes])).rows.map((r)=>r.server_name),["default.example.com","old.example.com"]);
    assert.equal((await pool.query("SELECT COUNT(*) FROM desired_configs WHERE node_id=ANY($1) AND protocol='vless'",[nodes])).rows[0].count,"2");
  } finally {
    server.kill("SIGTERM");
    await pool.query("DELETE FROM nodes WHERE id=ANY($1)",[nodes]);
    await pool.query("DELETE FROM reality_defaults");
    await pool.end();
  }
});
