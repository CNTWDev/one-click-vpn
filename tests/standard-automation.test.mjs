import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, symlink, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "rolldown";
import pg from "pg";
import test from "node:test";

test("standard automation registers VLESS and runs during node bootstrap, not every heartbeat", async () => {
  const adapter = await readFile("server/protocols/vless.ts", "utf8");
  const bootstrap = await readFile("server/bootstrap.ts", "utf8");
  const heartbeat = await readFile("app/api/v1/agent/heartbeat/route.ts", "utf8");
  assert.match(adapter, /standard: true/);
  assert.match(bootstrap, /await ensureStandardVpnServices\(nodeId\);\s+await reconcileEnabledVpnServices\(nodeId\)/);
  assert.doesNotMatch(heartbeat, /ensureStandardVpnServices/);
});

test("automatic deployment is idempotent, preserves custom templates and keys, recovers after target setup, and supports old-node rollout", { skip: !process.env.VEILBIRD_TEST_AUTOMATION_DATABASE_URL }, async () => {
  const databaseUrl = process.env.VEILBIRD_TEST_AUTOMATION_DATABASE_URL;
  process.env.VEILBIRD_DATABASE_URL = databaseUrl;
  process.env.VEILBIRD_MASTER_KEY = Buffer.alloc(32,7).toString("base64");
  process.env.VEILBIRD_ADMIN_EMAIL = "automation@example.com";
  process.env.VEILBIRD_ADMIN_PASSWORD = "automation-test-password";
  delete process.env.VEILBIRD_REALITY_TARGET;
  const root = process.cwd();
  const directory = await mkdtemp(path.join(tmpdir(),"northstar-automation-"));
  const pool = new pg.Pool({ connectionString: databaseUrl });
  let api;
  const nodeIds = ["new-standard","old-standard","custom","agent-only","rollout-old","auto-probe"].map((name) => `${name}-${Date.now()}`);
  try {
    await promisify(execFile)(process.execPath,["scripts/migrate.mjs"]);
    await symlink(path.join(root,"node_modules"),path.join(directory,"node_modules"),"dir");
    const entry = "virtual:automation-test";
    const output = path.join(directory,"automation.mjs");
    await build({ input: entry, platform:"node", external:["pg"], output:{file:output,format:"esm"}, plugins:[{
      name:"automation-test-entry",resolveId(id){ if(id===entry)return id; },
      load(id){ if(id===entry)return ["vpn-services","db","control-plane","deployment-policy","control-db"].map((name)=>`export * from ${JSON.stringify(path.join(root,"server",name+".ts"))};`).join("\n"); },
    }] });
    api = await import(pathToFileURL(output).href);
    assert.deepEqual(api.protocolsForTemplate("standard").sort(),["openvpn","vless","wireguard"]);
    assert.deepEqual(api.protocolsForTemplate("agent-only"),[]);
    const timestamp = new Date().toISOString();
    for (const id of nodeIds) {
      await pool.query(`INSERT INTO nodes (id,name,place,ip,ssh_user,credential_type,credential_ciphertext,credential_iv,credential_tag,created_at,updated_at,status,last_heartbeat_at,server_public_key)
        VALUES ($1,$1,'Test','192.0.2.90','root','password','','','',$2,$2,'online',$2,$3)`,[id,timestamp,Buffer.alloc(32,9).toString("base64")]);
      await api.ensureDefaultNodeProtocols(id);
    }
    const [fresh,old,custom,agentOnly,rollout,probed] = nodeIds;
    await api.initializeVpnServices(fresh);
    assert.equal((await api.listVpnServices(fresh)).length,3);
    await api.reconcileEnabledVpnServices(fresh);
    assert.equal((await api.findVpnService(fresh,"vless")).status,"attention");
    // Auto target mode waits for the node's own probe; nothing to configure by hand.
    assert.match((await api.findVpnService(fresh,"vless")).last_error,/REALITY 目标探测/);
    assert.ok(await api.findDesiredConfig(fresh,"wireguard"));
    assert.ok(await api.findDesiredConfig(fresh,"openvpn"));
    assert.equal(await api.findDesiredConfig(fresh,"vless"),undefined);
    assert.match((await api.deploymentPolicyOverview()).driftedNodes.find((node)=>node.id===fresh).reason,/VLESS：/);

    await pool.query("INSERT INTO reality_defaults VALUES ('primary','auto.example.com',$1,$1)",[timestamp]);
    // Avoid public DNS in this isolated test. Port 443 and target safety are separately tested.
    await pool.query("UPDATE vpn_services SET listen_port=8443 WHERE node_id=$1 AND protocol='vless'",[fresh]);
    await api.reconcileEnabledVpnServices(fresh);
    const keys = (await pool.query("SELECT * FROM reality_settings WHERE node_id=$1",[fresh])).rows[0];
    assert.equal(keys.server_name,"auto.example.com");
    assert.ok((await api.findDesiredConfig(fresh,"vless")).payload.serverBundleSecretId);
    await pool.query("UPDATE reality_defaults SET server_name='changed.example.com'");
    await api.initializeVpnServices(fresh);
    await api.rebuildDesiredState(fresh,"vless",{force:true});
    assert.deepEqual((await pool.query("SELECT * FROM reality_settings WHERE node_id=$1",[fresh])).rows[0],keys);
    assert.equal((await api.findVpnService(fresh,"vless")).listen_port,8443);

    await api.initializeVpnServices(old,"wireguard");
    await api.setNodeDeploymentPolicy(old,"standard",1);
    await api.upsertVpnService({nodeId:old,protocol:"wireguard",enabled:true,listenPort:51821,status:"healthy"});
    await api.ensureStandardVpnServices(old);
    assert.equal((await api.listVpnServices(old)).length,3);
    assert.equal((await api.findVpnService(old,"wireguard")).listen_port,51821);
    await api.initializeVpnServices(custom,"wireguard");
    await api.ensureStandardVpnServices(custom);
    assert.deepEqual((await api.listVpnServices(custom)).map((service)=>service.protocol),["wireguard"]);
    await api.initializeVpnServices(agentOnly,"agent-only");
    await api.ensureStandardVpnServices(agentOnly);
    assert.equal((await api.listVpnServices(agentOnly)).length,0);
    await api.configureVpnService({nodeId:fresh,protocol:"vless",action:"disable"});
    await api.ensureStandardVpnServices(fresh);
    assert.equal((await api.findVpnService(fresh,"vless")).enabled,false);

    await api.initializeVpnServices(rollout,"wireguard");
    await api.setNodeDeploymentPolicy(rollout,"standard",1);
    await api.upsertVpnService({nodeId:rollout,protocol:"wireguard",enabled:true,status:"healthy"});
    await api.upsertVpnService({nodeId:rollout,protocol:"vless",enabled:true,listenPort:8443,status:"pending"});
    const actor = (await pool.query("SELECT id FROM users WHERE email='automation@example.com'")).rows[0].id;
    const result = await api.rolloutStandardPolicy({actorUserId:actor,mode:"batch",nodeIds:[rollout]});
    assert.equal(result.queuedTargets,1);
    assert.equal(result.failedTargets,0);
    assert.equal((await api.listVpnServices(rollout)).length,3);
    assert.ok(await api.findDesiredConfig(rollout,"vless"));
    assert.equal((await pool.query("SELECT server_name FROM reality_settings WHERE node_id=$1",[rollout])).rows[0].server_name,"changed.example.com");

    // Auto mode: the node's probe picks one of the built-in large sites.
    await pool.query("UPDATE reality_defaults SET mode='auto',server_name=''");
    await pool.query("UPDATE nodes SET agent_capabilities_json=$1 WHERE id=$2",[JSON.stringify({ realityProbe: { checkedAt: timestamp, results: [
      { serverName: "www.apple.com", ok: true, latencyMs: 31 }, { serverName: "www.microsoft.com", ok: false, latencyMs: null } ] } }),probed]);
    await api.initializeVpnServices(probed);
    await pool.query("UPDATE vpn_services SET listen_port=8443 WHERE node_id=$1 AND protocol='vless'",[probed]);
    await api.reconcileEnabledVpnServices(probed);
    assert.equal((await pool.query("SELECT server_name FROM reality_settings WHERE node_id=$1",[probed])).rows[0].server_name,"www.apple.com");
    assert.equal((await api.findDesiredConfig(probed,"vless")).payload.serverName,"www.apple.com");
  } finally {
    await api?.closeDb();
    await pool.query("DELETE FROM nodes WHERE id=ANY($1)",[nodeIds]);
    await pool.query("DELETE FROM reality_defaults");
    await pool.end();
    await rm(directory,{recursive:true,force:true});
  }
});
