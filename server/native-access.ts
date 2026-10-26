import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { addAudit, dbExec, dbQuery, findUserByEmail, getDb, listRegions } from "./db";
import { verifyPassword } from "./password";
import { allowLoginAttempt, recordAuthFailure } from "./rate-limit";
import { canonical, digest, identity, NativeError, verifyNativeProof } from "./native-proof";
import { rebuildDesiredState, selectVpnServices } from "./control-plane";
import { ipv4Address, ipv4Pool } from "./ipv4-pool";
import { ensureNativeSecret, nativeProxies } from "./stealth";
import { accessSql, accountAccess, assertDeviceSlot, DeviceLimitError, deviceSlots, withinDeviceLimitSql } from "./entitlements";
import { writeOperationalLog } from "./operational-logs";
import { apiOrigins } from "./api-origins";

export type Session = { id: string; user_id: string; identity_jwk: string; identity_thumbprint: string; device_name: string; platform: string };
type Entitlement = { status: string; native_only: boolean; allowed: boolean; exhausted: boolean; access_until: Date | null };
/** The account row as connect needs it: the one access rule, and whether a used-up quota is why it fails. */
const entitlementSql = (lock = "") => `SELECT status,native_only,${accessSql("users")} AS allowed,access_until,
  EXISTS (SELECT 1 FROM access_grants g WHERE g.user_id=users.id AND g.status='active' AND g.quota_bytes IS NOT NULL AND g.used_bytes>=g.quota_bytes AND g.starts_at<=now() AND (g.ends_at IS NULL OR g.ends_at>now())) AS exhausted
  FROM users WHERE id=$1${lock}`;
const ttl = 300;
// Sliding: every signed connect/renewal extends it, so active devices never re-enter passwords.
export const sessionDays = () => { const n = Number(process.env.VEILBIRD_NATIVE_SESSION_DAYS || 30); return Number.isInteger(n) && n >= 1 && n <= 90 ? n : 30; };
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
  if (!user || !valid) { recordAuthFailure(request, "wrong-password"); throw new NativeError("INVALID_CREDENTIALS", 401); }
  if (user.status !== "active") throw new NativeError("ACCOUNT_UNAVAILABLE", 403);
  const key = identity(body.identityKey);
  if (!["android", "ios", "macos", "windows"].includes(String(body.platform))) throw new NativeError("INVALID_PLATFORM");
  const token = randomBytes(32).toString("base64url"), id = randomUUID();
  // A stolen token alone cannot connect: every connect/renewal also needs the device key's signature.
  await dbExec("DELETE FROM native_sessions WHERE expires_at < now()");
  await dbExec("DELETE FROM native_challenges WHERE expires_at < now()");
  await dbExec(`INSERT INTO native_sessions (id,token_hash,user_id,identity_jwk,identity_thumbprint,device_name,platform,expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,now()+make_interval(days=>$8))`,
  [id,digest(token),user.id,JSON.stringify(key.jwk),key.thumbprint,String(body.deviceName || body.platform).slice(0,80),body.platform,sessionDays()]);
  // Signing in again with the password re-admits a device that was signed out earlier; it counts against the limit on connect.
  await dbExec("DELETE FROM native_enrollments WHERE user_id=$1 AND identity_thumbprint=$2 AND (status='revoked' OR (status='revoking' AND release_after<=now()))",[user.id,key.thumbprint]);
  await addAudit({ actorUserId: user.id, action: "native.login", targetType: "native_session", targetId: id });
  // Every entry the apps may try when their own domain is blocked (api-origins.ts); also sent with the node list.
  return { accessToken: token, expiresAt: new Date(Date.now()+sessionDays()*86400000).toISOString(), apiOrigins: await apiOrigins() };
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
  const user = (await dbQuery<{email:string;display_name:string;native_only:boolean}>("SELECT email,display_name,native_only FROM users WHERE id=$1",[session.user_id]))[0];
  const slots = await deviceSlots(session.user_id);
  const access = await accountAccess(session.user_id);
  const devices = await dbQuery(`SELECT id,device_name AS name,platform,status,created_at AS "createdAt",last_seen_at AS "lastSeenAt",release_after AS "releaseAfter",
    identity_thumbprint=$2 AS "isCurrent" FROM native_enrollments WHERE user_id=$1 ORDER BY created_at`,[session.user_id,session.identity_thumbprint]);
  const since=new Date(Date.now()-29*86400000).toISOString().slice(0,10);
  const traffic=(await dbQuery<Record<string,unknown>>("SELECT COALESCE(SUM(upload_bytes),0)::text AS \"uploadBytes\",COALESCE(SUM(download_bytes),0)::text AS \"downloadBytes\" FROM traffic_daily WHERE user_id=$1 AND day >= $2",[session.user_id,since]))[0];
  // Per-day totals for the small usage chart in the apps; days without traffic are absent.
  traffic.days=await dbQuery("SELECT day::text AS day,(SUM(upload_bytes)+SUM(download_bytes))::text AS bytes FROM traffic_daily WHERE user_id=$1 AND day >= $2 GROUP BY day ORDER BY day",[session.user_id,since]);
  // expiresAt stays for apps that predate `access`: the end of the current period, null when it has none.
  return { name:user.display_name,email:user.email,managed:user.native_only,// limit null = unlimited; used counts subscriptions and node configs too, configs is how many of them.
    limit:slots.limit,used:slots.used,configs:slots.used-devices.filter(d=>d.status!=="revoked").length,
    expiresAt:access.state==="active"?access.until:access.endedAt,access,devices,traffic };
}
async function candidates(includePaused=false) {
  return (await selectVpnServices({protocol:"wireguard",includePaused})).filter(({node})=>node.capabilities.nativeLeaseEnforcement === 1);
}
/** Node CPU percent from a heartbeat under 3 minutes old; clients use it to steer away from busy nodes. */
function nodeLoad(metrics: string | null | undefined): number | null {
  try {
    const value=JSON.parse(metrics||"null") as {collectedAt?:string;cpuPercent?:number}|null;
    if(!value || typeof value.cpuPercent!=="number" || !Number.isFinite(value.cpuPercent)) return null;
    if(!value.collectedAt || Date.now()-new Date(value.collectedAt).getTime()>180_000) return null;
    return Math.max(0,Math.min(100,Math.round(value.cpuPercent)));
  } catch { return null; }
}
export async function nativeNodes() {
  // WireGuard ignores unknown peers, so clients time a TCP connect to the same host's REALITY port instead.
  // Nodes without one have no probe and keep the server's least-loaded order behind measured nodes.
  const tcp=new Map((await selectVpnServices({protocol:"vless"})).map(({node,service})=>[node.id,service.listen_port]));
  // The country code labels each location in the apps (a two-letter badge).
  const regions=new Map((await listRegions()).map((region)=>[region.id,region]));
  return {apiOrigins:await apiOrigins(),nodes:(await candidates()).map(({node})=>{
    const port=tcp.get(node.id);
    const countryCode=node.region_id?regions.get(node.region_id)?.code?.toUpperCase()||null:null;
    // load (CPU %) and users (online now) let the apps prefer a quieter node when latencies are close.
    return {id:node.id,name:node.name,region:node.region,countryCode,protocol:"wireguard",probe:port?{host:node.public_endpoint||node.ip,port}:null,load:nodeLoad(node.metrics_json),users:Math.max(0,Number(node.users)||0)};
  })};
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
  if(!user.allowed) throw new NativeError(user.exhausted?"QUOTA_EXHAUSTED":"MEMBERSHIP_EXPIRED",403);
}
export async function nativeConnect(session:Session,body:Record<string,unknown>) {
  const input=await consume(session,"connect",body);
  if(typeof input.publicKey!=="string" || !/^[A-Za-z0-9+/]{43}=$/.test(input.publicKey) || Buffer.from(input.publicKey,"base64").length!==32) throw new NativeError("INVALID_KEY");
  const available=await candidates(true);
  let chosen=input.nodeId?available.find(({node})=>node.id===input.nodeId):available.find(({node})=>!node.paused_at);
  // A paused node takes no new connections; a device already connected there keeps renewing until it disconnects.
  if(chosen?.node.paused_at && !(await dbQuery(`SELECT 1 FROM native_leases l JOIN native_enrollments e ON e.id=l.enrollment_id
    WHERE l.node_id=$1 AND e.user_id=$2 AND e.identity_thumbprint=$3 AND l.expires_at>now()`,[chosen.node.id,session.user_id,session.identity_thumbprint])).length) chosen=undefined;
  if(!chosen || !chosen.node.server_public_key) throw new NativeError("NODE_UNAVAILABLE",409);
  const {node,service}=chosen;
  const result=await transaction(async client=>{
    const user=(await client.query<Entitlement>(entitlementSql(" FOR UPDATE"),[session.user_id])).rows[0];
    checkEntitlement(user);
    // Only a valid device proof and entitlement may extend a login session.
    // Passive account polling cannot keep a stolen bearer token alive forever.
    if (!(await client.query("UPDATE native_sessions SET expires_at=now()+make_interval(days=>$2) WHERE id=$1 AND expires_at>now() RETURNING id",[session.id,sessionDays()])).rowCount) throw new NativeError("AUTH_REQUIRED",401);
    await client.query("UPDATE native_enrollments SET status='revoked' WHERE user_id=$1 AND status='revoking' AND release_after<=now()",[session.user_id]);
    let enrollment=(await client.query("SELECT id,status FROM native_enrollments WHERE user_id=$1 AND identity_thumbprint=$2",[session.user_id,session.identity_thumbprint])).rows[0];
    if(enrollment && enrollment.status!=="active") throw new NativeError("DEVICE_REVOKED",403);
    if(!enrollment) {
      await assertDeviceSlot(session.user_id,client).catch(error=>{throw error instanceof DeviceLimitError?new NativeError("DEVICE_LIMIT_REACHED",409,{limit:error.limit,used:error.used}):error;});
      enrollment={id:`enr_${randomUUID()}`,status:"active"};
      await client.query("INSERT INTO native_enrollments (id,user_id,identity_thumbprint,device_name,platform) VALUES ($1,$2,$3,$4,$5)",[enrollment.id,session.user_id,session.identity_thumbprint,session.device_name,session.platform]);
    }
    // Past a lowered limit only the devices added first keep connecting.
    if(!(await client.query(`SELECT ${withinDeviceLimitSql("u","e.created_at","e.id")} AS ok FROM native_enrollments e JOIN users u ON u.id=e.user_id WHERE e.id=$1`,[enrollment.id])).rows[0]?.ok) throw new NativeError("DEVICE_LIMIT_REACHED",409);
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
    const expiry=Math.min(Date.now()+ttl*1000,user.access_until?user.access_until.getTime():Infinity);
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
  const ready=!!applied && applied.applied_revision>=desired.revision;
  const fallback=await fallbackProxies(node,result.enrollmentId);
  // One line per connect, under the request id the app sends for the whole attempt (Console → 运行日志).
  void writeOperationalLog({component:"api",nodeId:node.id,actor:{id:session.user_id},action:"native.connect",level:fallback.reason?"warning":"info",
    message:`App ${session.platform} connect: node ${node.name}, WireGuard ${ready?"ready":`pending (revision ${desired.revision})`}, transports ${["wireguard",...fallback.proxies.map(p=>String(p.name))].join(" > ")}${fallback.reason?`; ${fallback.reason}`:""}`,
    fields:{leaseId:result.id,revision:desired.revision}});
  return {leaseId:result.id,enrollmentId:result.enrollmentId,expiresAt:result.expiresAt,nodeId:node.id,nodeName:node.name,revision:desired.revision,ready,
    wireguard:{address:result.address,serverPublicKey:node.server_public_key,endpoint:`${node.public_endpoint||node.ip}:${service.listen_port}`,dns:service.dns,allowedIps:["0.0.0.0/0","::/0"],mtu:1280},
    // Fallback transports for networks that block WireGuard, as mihomo proxies (Android 1.1+ races them).
    proxies:fallback.proxies};
}
/** The other transports, and why some are missing (logged, never sent to the app). */
async function fallbackProxies(node:{id:string;ip:string;public_endpoint:string|null},enrollmentId:string):Promise<{proxies:Array<Record<string,unknown>>;reason:string}> {
  const pick=async(protocol:"vless"|"stealth")=>(await selectVpnServices({protocol,includePaused:true})).find((item)=>item.node.id===node.id)?.service;
  try {
    await ensureNativeSecret(enrollmentId);
    const services={vless:await pick("vless"),stealth:await pick("stealth")};
    const proxies=await nativeProxies(node,enrollmentId,services);
    const missing=[!services.vless&&"no healthy VLESS REALITY service",!services.stealth&&"no healthy stealth service (Agent 2.12+, standard policy, UDP+TCP 8443)",
      (services.vless||services.stealth)&&!proxies.length&&"REALITY keys missing"].filter(Boolean);
    return {proxies,reason:missing.length?`fallback limited: ${missing.join(", ")}`:""};
  }
  // WireGuard alone still connects; a missing fallback must never fail the connection.
  catch(error) { return {proxies:[],reason:`fallback failed: ${error instanceof Error?error.message:String(error)}`}; }
}
export async function nativeStatus(session:Session,leaseId:string) {
  const row=(await dbQuery(`SELECT l.node_id,l.expires_at,l.required_revision,e.status,${accessSql()} AND ${withinDeviceLimitSql("u","e.created_at","e.id")} AS allowed FROM native_leases l JOIN native_enrollments e ON e.id=l.enrollment_id JOIN users u ON u.id=e.user_id WHERE l.id=$1 AND e.user_id=$2 AND e.identity_thumbprint=$3`,[leaseId,session.user_id,session.identity_thumbprint]))[0];
  if(!row || row.status!=="active" || !row.allowed || new Date(row.expires_at).getTime()<=Date.now()) throw new NativeError("ACCESS_EXPIRED",403);
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
