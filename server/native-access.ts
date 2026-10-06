import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { addAudit, dbExec, dbQuery, findUserByEmail, getDb } from "./db";
import { verifyPassword } from "./password";
import { allowLoginAttempt } from "./rate-limit";
import { canonical, digest, identity, NativeError, verifyNativeProof } from "./native-proof";
import { rebuildDesiredState, selectVpnServices } from "./control-plane";
import { ipv4Address, ipv4Pool } from "./ipv4-pool";

export type Session = { id: string; user_id: string; identity_jwk: string; identity_thumbprint: string; device_name: string; platform: string };
type Entitlement = { status: string; native_only: boolean; native_device_limit: number | null; membership_expires_at: string | null };
const ttl = 300;
export const defaultLimit = () => { const n = Number(process.env.NORTHSTAR_NATIVE_DEVICE_LIMIT || 3); return Number.isInteger(n) && n >= 1 && n <= 100 ? n : 3; };
export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getDb().connect();
  try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
  catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}
export async function nativeLogin(request: Request, body: Record<string, unknown>) {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!allowLoginAttempt(request, email)) throw new NativeError("RATE_LIMITED", 429);
  const user = await findUserByEmail(email);
  const valid=await verifyPassword(typeof body.password==="string"?body.password:"",user?.password_hash);
  if (!user || !valid) throw new NativeError("INVALID_CREDENTIALS", 401);
  if (user.status !== "active") throw new NativeError("ACCOUNT_UNAVAILABLE", 403);
  const key = identity(body.identityKey);
  if (!["android", "ios", "macos", "windows"].includes(String(body.platform))) throw new NativeError("INVALID_PLATFORM");
  const token = randomBytes(32).toString("base64url"), id = randomUUID();
  // Short enough to bound stolen login sessions; device proof is still required to connect.
  await dbExec("DELETE FROM native_sessions WHERE expires_at < now()");
  await dbExec("DELETE FROM native_challenges WHERE expires_at < now()");
  await dbExec(`INSERT INTO native_sessions (id,token_hash,user_id,identity_jwk,identity_thumbprint,device_name,platform,expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,now()+interval '12 hours')`,
  [id,digest(token),user.id,JSON.stringify(key.jwk),key.thumbprint,String(body.deviceName || body.platform).slice(0,80),body.platform]);
  await addAudit({ actorUserId: user.id, action: "native.login", targetType: "native_session", targetId: id });
  return { accessToken: token, expiresAt: new Date(Date.now()+12*3600000).toISOString() };
}
export async function nativeSession(request: Request): Promise<Session> {
  const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) throw new NativeError("AUTH_REQUIRED", 401);
  const session = (await dbQuery<Session>(`SELECT s.* FROM native_sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=$1 AND expires_at>now() AND u.status='active'`,[digest(token)]))[0];
  if (!session) throw new NativeError("AUTH_REQUIRED",401);
  return session;
}
export async function nativeAccount(session: Session) {
  await dbExec("UPDATE native_enrollments SET status='revoked' WHERE user_id=$1 AND status='revoking' AND release_after<=now()",[session.user_id]);
  const user = (await dbQuery<Entitlement & {email:string;display_name:string}>("SELECT email,display_name,status,native_only,native_device_limit,membership_expires_at FROM users WHERE id=$1",[session.user_id]))[0];
  const devices = await dbQuery(`SELECT id,device_name AS name,platform,status,created_at AS "createdAt",last_seen_at AS "lastSeenAt",release_after AS "releaseAfter",
    identity_thumbprint=$2 AS "isCurrent" FROM native_enrollments WHERE user_id=$1 ORDER BY created_at`,[session.user_id,session.identity_thumbprint]);
  const traffic=(await dbQuery("SELECT COALESCE(SUM(upload_bytes),0)::text AS \"uploadBytes\",COALESCE(SUM(download_bytes),0)::text AS \"downloadBytes\" FROM traffic_daily WHERE user_id=$1 AND day >= $2",[session.user_id,new Date(Date.now()-29*86400000).toISOString().slice(0,10)]))[0];
  return { name:user.display_name,email:user.email,managed:user.native_only,limit:user.native_device_limit??defaultLimit(),limitSource:user.native_device_limit===null?"default":"override",used:devices.filter(d=>d.status!=="revoked").length,expiresAt:user.membership_expires_at,devices,traffic };
}
async function candidates() {
  return (await selectVpnServices({protocol:"wireguard"})).filter(({node})=>node.capabilities.nativeLeaseEnforcement === 1);
}
export async function nativeNodes() {
  return {nodes:(await candidates()).map(({node})=>({id:node.id,name:node.name,region:node.region,protocol:"wireguard"}))};
}
export async function nativeChallenge(session: Session, body: Record<string,unknown>) {
  if (!["connect","disconnect","revoke"].includes(String(body.action)) || !body.request || typeof body.request!=="object" || Array.isArray(body.request)) throw new NativeError("INVALID_REQUEST");
  const pending=(await dbQuery<{count:number}>("SELECT COUNT(*)::int AS count FROM native_challenges WHERE session_id=$1 AND NOT consumed AND expires_at>now()",[session.id]))[0].count;
  if(pending>=10) throw new NativeError("RATE_LIMITED",429);
  const id=randomUUID(), expiresAt=new Date(Date.now()+60000).toISOString(), hash=digest(canonical(body.request));
  const payload=Buffer.from(JSON.stringify({id,sessionId:session.id,identity:session.identity_thumbprint,action:body.action,requestHash:hash,expiresAt,nonce:randomBytes(32).toString("base64url")})).toString("base64url");
  await dbExec("INSERT INTO native_challenges (id,session_id,action,request_hash,payload,expires_at) VALUES ($1,$2,$3,$4,$5,$6)",[id,session.id,body.action,hash,payload,expiresAt]);
  return {id,payload,expiresAt};
}
async function consume(session:Session,action:string,body:Record<string,unknown>) {
  const row=(await dbQuery<{payload:string}>(`UPDATE native_challenges SET consumed=TRUE WHERE id=$1 AND session_id=$2 AND action=$3 AND request_hash=$4 AND NOT consumed AND expires_at>now() RETURNING payload`,[body.challengeId,session.id,action,digest(canonical(body.request))]))[0];
  if(!row || !verifyNativeProof(session.identity_jwk,row.payload,body.signature)) throw new NativeError("PROOF_INVALID",403);
  if(!body.request || typeof body.request!=="object" || Array.isArray(body.request)) throw new NativeError("INVALID_REQUEST");
  return body.request as Record<string,unknown>;
}
function checkEntitlement(user:Entitlement) {
  if(user.status!=="active") throw new NativeError("ACCOUNT_UNAVAILABLE",403);
  if(!user.native_only) throw new NativeError("MANAGED_ACCESS_REQUIRED",403);
  if(user.membership_expires_at && Date.parse(user.membership_expires_at)<=Date.now()) throw new NativeError("MEMBERSHIP_EXPIRED",403);
}
export async function nativeConnect(session:Session,body:Record<string,unknown>) {
  const input=await consume(session,"connect",body);
  if(typeof input.publicKey!=="string" || !/^[A-Za-z0-9+/]{43}=$/.test(input.publicKey) || Buffer.from(input.publicKey,"base64").length!==32) throw new NativeError("INVALID_KEY");
  const available=await candidates(), chosen=input.nodeId?available.find(({node})=>node.id===input.nodeId):available[0];
  if(!chosen || !chosen.node.server_public_key) throw new NativeError("NODE_UNAVAILABLE",409);
  const {node,service}=chosen;
  const result=await transaction(async client=>{
    const user=(await client.query<Entitlement>("SELECT status,native_only,native_device_limit,membership_expires_at FROM users WHERE id=$1 FOR UPDATE",[session.user_id])).rows[0];
    checkEntitlement(user);
    // Only a valid device proof and entitlement may extend a login session.
    // Passive account polling cannot keep a stolen bearer token alive forever.
    if (!(await client.query("UPDATE native_sessions SET expires_at=now()+interval '12 hours' WHERE id=$1 AND expires_at>now() RETURNING id",[session.id])).rowCount) throw new NativeError("AUTH_REQUIRED",401);
    await client.query("UPDATE native_enrollments SET status='revoked' WHERE user_id=$1 AND status='revoking' AND release_after<=now()",[session.user_id]);
    let enrollment=(await client.query("SELECT id,status FROM native_enrollments WHERE user_id=$1 AND identity_thumbprint=$2",[session.user_id,session.identity_thumbprint])).rows[0];
    if(enrollment && enrollment.status!=="active") throw new NativeError("DEVICE_REVOKED",403);
    if(!enrollment) {
      const used=Number((await client.query("SELECT COUNT(*) AS count FROM native_enrollments WHERE user_id=$1 AND status<>'revoked'",[session.user_id])).rows[0].count),limit=user.native_device_limit??defaultLimit();
      if(used>=limit) throw new NativeError("DEVICE_LIMIT_REACHED",409,{limit,used});
      enrollment={id:`enr_${randomUUID()}`,status:"active"};
      await client.query("INSERT INTO native_enrollments (id,user_id,identity_thumbprint,device_name,platform) VALUES ($1,$2,$3,$4,$5)",[enrollment.id,session.user_id,session.identity_thumbprint,session.device_name,session.platform]);
    }
    await client.query("UPDATE native_enrollments SET last_seen_at=now() WHERE id=$1",[enrollment.id]);
    // Serializes native allocations per node; the existing allocator uses unique address conflicts to retry.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`native-pool:${node.id}`]);
    if ((await client.query("SELECT id FROM native_leases WHERE public_key=$1 AND enrollment_id<>$2 UNION ALL SELECT id FROM access_credentials WHERE identity_key=$1 LIMIT 1",[input.publicKey,enrollment.id])).rowCount) throw new NativeError("KEY_ALREADY_REGISTERED",409);
    let lease=(await client.query("SELECT * FROM native_leases WHERE enrollment_id=$1 AND node_id=$2",[enrollment.id,node.id])).rows[0];
    if(!lease) {
      const deviceId=`ndev_${randomUUID()}`,stamp=new Date().toISOString();
      await client.query("INSERT INTO devices (id,user_id,display_name,platform,app_version,public_key,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'native-1',$5,'active',$6,$6)",[deviceId,session.user_id,session.device_name,session.platform,input.publicKey,stamp]);
      const occupied=new Set((await client.query("SELECT address FROM ip_leases WHERE node_id=$1 AND protocol='wireguard'",[node.id])).rows.map(r=>r.address));
      const pool=ipv4Pool(service.subnet);
      let address="";
      for(let i=2;i<pool.size-1;i++) {
        const candidate=`${ipv4Address(pool.network+i)}/32`;
        if(occupied.has(candidate)) continue;
        const inserted=await client.query("INSERT INTO ip_leases (id,node_id,protocol,device_id,address,status,created_at) VALUES ($1,$2,'wireguard',$3,$4,'active',$5) ON CONFLICT DO NOTHING RETURNING address",[randomUUID(),node.id,deviceId,candidate,stamp]);
        if(inserted.rows.length) {address=candidate;break;}
      }
      if(!address) throw new NativeError("NODE_FULL",409);
      lease={id:randomUUID(),device_id:deviceId,address};
    }
    const expiry=Math.min(Date.now()+ttl*1000,user.membership_expires_at?Date.parse(user.membership_expires_at):Infinity);
    const expiresAt=new Date(expiry).toISOString();
    await client.query(`INSERT INTO native_leases (id,enrollment_id,node_id,device_id,public_key,address,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(enrollment_id,node_id) DO UPDATE SET public_key=excluded.public_key,expires_at=excluded.expires_at,required_revision=NULL`,[lease.id,enrollment.id,node.id,lease.device_id,input.publicKey,lease.address,expiresAt]);
    await client.query("UPDATE devices SET public_key=$2 WHERE id=$1",[lease.device_id,input.publicKey]);
    const old=(await client.query("UPDATE native_leases SET expires_at=now() WHERE enrollment_id=$1 AND node_id<>$2 AND expires_at>now() RETURNING node_id",[enrollment.id,node.id])).rows.map(r=>r.node_id as string);
    return {id:lease.id,enrollmentId:enrollment.id,address:lease.address,expiresAt,old};
  });
  const desired=await rebuildDesiredState(node.id,"wireguard");
  // Bind readiness to this lease, not the ever-moving latest node revision.
  // A concurrent renewal must not inherit acknowledgement of an older lease.
  const recorded=await dbExec("UPDATE native_leases SET required_revision=$2 WHERE id=$1 AND expires_at=$3 AND public_key=$4",[result.id,desired.revision,result.expiresAt,input.publicKey]);
  if(recorded!==1) throw new NativeError("CONNECTION_SUPERSEDED",409);
  for(const old of result.old) await rebuildDesiredState(old,"wireguard").catch(()=>undefined);
  const applied=(await dbQuery<{applied_revision:number}>("SELECT applied_revision FROM observed_configs WHERE node_id=$1 AND protocol='wireguard' AND status IN ('applied','succeeded')",[node.id]))[0];
  return {leaseId:result.id,enrollmentId:result.enrollmentId,expiresAt:result.expiresAt,nodeId:node.id,nodeName:node.name,revision:desired.revision,ready:!!applied && applied.applied_revision>=desired.revision,
    wireguard:{address:result.address,serverPublicKey:node.server_public_key,endpoint:`${node.public_endpoint||node.ip}:${service.listen_port}`,dns:service.dns,allowedIps:["0.0.0.0/0","::/0"],mtu:1280}};
}
export async function nativeStatus(session:Session,leaseId:string) {
  const row=(await dbQuery(`SELECT l.node_id,l.expires_at,l.required_revision,e.status,u.status AS account_status,u.native_only,u.membership_expires_at FROM native_leases l JOIN native_enrollments e ON e.id=l.enrollment_id JOIN users u ON u.id=e.user_id WHERE l.id=$1 AND e.user_id=$2 AND e.identity_thumbprint=$3`,[leaseId,session.user_id,session.identity_thumbprint]))[0];
  if(!row || row.status!=="active" || row.account_status!=="active" || !row.native_only || new Date(row.expires_at).getTime()<=Date.now() || (row.membership_expires_at&&Date.parse(row.membership_expires_at)<=Date.now())) throw new NativeError("ACCESS_EXPIRED",403);
  const observed=(await dbQuery(`SELECT d.revision,o.applied_revision,o.status FROM desired_configs d LEFT JOIN observed_configs o ON o.node_id=d.node_id AND o.protocol=d.protocol WHERE d.node_id=$1 AND d.protocol='wireguard'`,[row.node_id]))[0];
  return {ready:row.required_revision!=null && !!observed && observed.applied_revision>=row.required_revision && ["applied","succeeded"].includes(observed.status),expiresAt:row.expires_at};
}
export async function nativeEnd(session:Session,action:"disconnect"|"revoke",body:Record<string,unknown>) {
  const input=await consume(session,action,body);
  const affected=await transaction(async client=>{
    await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE",[session.user_id]);
    const enrollment=(await client.query(`SELECT id FROM native_enrollments WHERE user_id=$1 AND ${action==="revoke"?"id=$2":"identity_thumbprint=$2"}`,[session.user_id,action==="revoke"?input.enrollmentId:session.identity_thumbprint])).rows[0];
    if(!enrollment) throw new NativeError("DEVICE_NOT_FOUND",404);
    // Keep the slot through the maximum already-issued lease plus a watchdog allowance.
    if(action==="revoke") await client.query(`UPDATE native_enrollments SET status='revoking',release_after=GREATEST(now(),COALESCE((SELECT MAX(expires_at) FROM native_leases WHERE enrollment_id=$1),now()))+interval '20 seconds' WHERE id=$1 AND status='active'`,[enrollment.id]);
    return (await client.query("UPDATE native_leases SET expires_at=now() WHERE enrollment_id=$1 RETURNING node_id",[enrollment.id])).rows.map(r=>r.node_id as string);
  });
  for(const nodeId of affected) await rebuildDesiredState(nodeId,"wireguard").catch(()=>undefined);
  await addAudit({actorUserId:session.user_id,action:`native.${action}`,targetType:"native_enrollment",targetId:String(input.enrollmentId||session.identity_thumbprint)});
  return {ok:true};
}
export async function nativeLogout(session:Session) { await dbExec("DELETE FROM native_sessions WHERE id=$1",[session.id]);return {ok:true}; }
