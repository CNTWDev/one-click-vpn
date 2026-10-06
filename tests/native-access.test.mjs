import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import test from "node:test";
import pg from "pg";
import { hashPassword } from "../server/password.ts";

const database=process.env.NORTHSTAR_NATIVE_TEST_DATABASE_URL;
test("native admission: signed proof, concurrency quota, revoke grace, ownership and expiry",{skip:!database,timeout:90000},async()=>{
  const env={...process.env,NORTHSTAR_DATABASE_URL:database,NORTHSTAR_NATIVE_ACCESS_ENABLED:"1",NORTHSTAR_MASTER_KEY:Buffer.alloc(32,9).toString("base64")};
  execFileSync(process.execPath,["scripts/migrate.mjs"],{env,stdio:"pipe"});
  const pool=new pg.Pool({connectionString:database});
  const stamp=new Date().toISOString(),user=`native_${Date.now()}`,node=`${user}_node`,password="test-password-123";
  await pool.query("INSERT INTO users(id,email,display_name,password_hash,status,role,native_only,native_device_limit,created_at,updated_at) VALUES($1,$2,'Native test',$3,'active','user',TRUE,1,$4,$4)",[user,`${user}@example.com`,hashPassword(password),stamp]);
  await pool.query(`INSERT INTO nodes(id,name,place,ip,ssh_user,credential_type,credential_ciphertext,credential_iv,credential_tag,status,last_heartbeat_at,server_public_key,agent_capabilities_json,created_at,updated_at)
    VALUES($1,'Test node','Test','192.0.2.1','root','password','','','','online',$2,$3,$4,$2,$2)`,[node,stamp,randomBytes(32).toString("base64"),JSON.stringify({nativeLeaseEnforcement:1,connectivity:{protocols:{wireguard:{runtimeActive:true,listening:true}}}})]);
  await pool.query("INSERT INTO vpn_services(node_id,protocol,listen_port,subnet,status,created_at,updated_at) VALUES($1,'wireguard',51820,'10.70.0.0/24','healthy',$2,$2)",[node,stamp]);
  await pool.query("INSERT INTO node_protocols(node_id,protocol,updated_at) VALUES($1,'wireguard',$2)",[node,stamp]);
  const server=spawn(process.execPath,["node_modules/next/dist/bin/next","start","-p","3397","-H","127.0.0.1"],{env,stdio:"ignore"});
  const base="http://127.0.0.1:3397/api/v2/native/";
  const call=async(path,body,token)=>{const response=await fetch(base+path,{method:body?"POST":"GET",headers:{"Content-Type":"application/json",...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};};
  try {
    let ready=false;for(let i=0;i<100;i++){if(await fetch(base+"account").then(()=>true).catch(()=>false)){ready=true;break;}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
    const login=async()=>{const keys=generateKeyPairSync("ec",{namedCurve:"P-256"});const r=await call("login",{email:`${user}@example.com`,password,identityKey:keys.publicKey.export({format:"jwk"}),platform:"android",deviceName:"Phone"});assert.equal(r.status,200,JSON.stringify(r.data));return {keys,token:r.data.accessToken};};
    const a=await login(),b=await login();
    const proof=async(client,action,request)=>{const c=await call("challenge",{action,request},client.token);assert.equal(c.status,200);return {challengeId:c.data.id,request,signature:sign("sha256",Buffer.from(c.data.payload,"base64url"),{key:client.keys.privateKey,dsaEncoding:"ieee-p1363"}).toString("base64url")};};
    const input={nodeId:node,publicKey:randomBytes(32).toString("base64")};
    const payload=await proof(a,"connect",input);
    assert.equal((await call("connect",{...payload,request:{...input,nodeId:"tampered"}},a.token)).status,403);
    const results=await Promise.all([call("connect",payload,a.token),proof(b,"connect",{...input,publicKey:randomBytes(32).toString("base64")}).then(p=>call("connect",p,b.token))]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409],JSON.stringify(results));
    const winner=results[0].status===200?a:b,loser=winner===a?b:a,result=results.find(r=>r.status===200).data;
    assert.ok(result.wireguard.address);assert.equal(result.ready,false);assert.ok(result.wireguard.dns.length);
    const internalDevice=(await pool.query("SELECT device_id FROM native_leases WHERE id=$1",[result.leaseId])).rows[0].device_id;
    await assert.rejects(pool.query(`INSERT INTO connection_profiles(id,device_id,node_id,protocol,transport,revision,endpoint_json,issued_at,expires_at,updated_at)
      VALUES($1,$2,$3,'wireguard','udp',1,'{}',$4,$4,$4)`,[`${user}_bypass`,internalDevice,node,stamp]),/NORTHSTAR/);
    assert.equal(Number((await pool.query("SELECT COUNT(*) FROM native_enrollments WHERE user_id=$1",[user])).rows[0].count),1);
    assert.equal((await call("connect",payload,a.token)).status,403,"proof cannot replay");
    assert.equal((await call(`status/${result.leaseId}`,undefined,loser.token)).status,403);
    const desired=(await pool.query("SELECT payload_json FROM desired_configs WHERE node_id=$1",[node])).rows[0];
    assert.match(desired.payload_json,/expiresAt/);
    await pool.query("INSERT INTO observed_configs(node_id,protocol,applied_revision,observed_hash,status,updated_at) VALUES($1,'wireguard',$2,'test','applied',$3)",[node,result.revision,stamp]);
    await pool.query("UPDATE desired_configs SET revision=revision+1 WHERE node_id=$1",[node]);
    assert.equal((await call(`status/${result.leaseId}`,undefined,winner.token)).data.ready,true,"another client's pending revision must not block an applied lease");
    const revoke=await proof(winner,"revoke",{enrollmentId:result.enrollmentId});assert.equal((await call("revoke",revoke,winner.token)).status,200);
    assert.equal((await call("account",undefined,winner.token)).data.used,1,"slot retained until lease deadline");
    assert.equal((await call(`status/${result.leaseId}`,undefined,winner.token)).status,403);
    const next=await proof(loser,"connect",{...input,publicKey:randomBytes(32).toString("base64")});assert.equal((await call("connect",next,loser.token)).data.code,"DEVICE_LIMIT_REACHED");
    await pool.query("UPDATE native_enrollments SET release_after=now()-interval '1 second' WHERE id=$1",[result.enrollmentId]);
    assert.equal((await call("account",undefined,winner.token)).data.used,0);
    const enrolled=await call("connect",await proof(loser,"connect",{...input,publicKey:randomBytes(32).toString("base64")}),loser.token);assert.equal(enrolled.status,200,JSON.stringify(enrolled));
    await pool.query("UPDATE users SET membership_expires_at=$2 WHERE id=$1",[user,new Date(Date.now()-1000).toISOString()]);
    assert.equal((await call("connect",await proof(loser,"connect",input),loser.token)).data.code,"MEMBERSHIP_EXPIRED");
    // Migration must not turn native internal devices into exportable credentials.
    execFileSync(process.execPath,["scripts/migrate.mjs"],{env,stdio:"pipe"});
    assert.equal(Number((await pool.query("SELECT COUNT(*) FROM access_credentials WHERE user_id=$1",[user])).rows[0].count),0);
  } finally {server.kill("SIGTERM");await pool.end();}
});
