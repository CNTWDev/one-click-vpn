import { randomBytes, randomUUID } from "node:crypto";
import { x25519 } from "@noble/curves/ed25519.js";
import { Pool } from "pg";
import { addAudit, dbExec, dbQuery, getDb } from "./db";
import { hashToken } from "./crypto";
import { createAccessCredential, findDesiredConfig, listConnectionProfiles } from "./control-db";
import { activateProfile, issueConnectionProfile, selectVpnServices } from "./control-plane";
import { assertCredentialUsable, manageCredentialAccess } from "./credential-access";
import { createSecretMaterial, readSecretMaterial } from "./secret-materials";
import { proxyName, renderSubscription, renderV2raySubscription, type RoutingMode, type SubscriptionFormat, type SubscriptionProxy } from "./subscription-format";
import { realityUserIdentities } from "./reality";

type Subscription = { id: string; credential_id: string; token_hash: string; token_secret_id: string | null; private_key_secret_id: string | null; created_at: string; updated_at: string; last_fetched_at: string | null };
let lockPool: Pool | undefined;
export async function listSubscriptions(userId?: string) {
  return dbQuery<Subscription & { user_id: string; display_name: string; protocol: string; status: string; user_disabled: boolean; admin_disabled: boolean; expires_at: string; email: string }>(
    `SELECT s.id,s.credential_id,s.created_at,s.updated_at,s.last_fetched_at,c.user_id,c.display_name,c.protocol,c.status,
      c.user_disabled,c.admin_disabled,c.expires_at,u.email,u.status AS account_status,
      COALESCE((SELECT SUM(t.upload_bytes+t.download_bytes) FROM traffic_daily t WHERE t.credential_id=c.id AND t.day BETWEEN to_char((now() AT TIME ZONE 'UTC') - interval '29 days','YYYY-MM-DD') AND to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD')),0)::text AS total_bytes,
      (SELECT COUNT(DISTINCT p.node_id) FROM connection_profiles p JOIN vpn_services v ON v.node_id=p.node_id AND v.protocol=p.protocol
        JOIN desired_configs d ON d.node_id=p.node_id AND d.protocol=p.protocol
        JOIN observed_configs o ON o.node_id=p.node_id AND o.protocol=p.protocol AND o.applied_revision=d.revision
        WHERE p.credential_id=c.id AND p.status='active' AND p.expires_at>$${userId ? 2 : 1} AND v.enabled=1
        AND o.status IN ('applied','succeeded'))::int AS synced_nodes
      FROM subscriptions s JOIN access_credentials c ON c.id=s.credential_id
      JOIN users u ON u.id=c.user_id WHERE c.deleted_at IS NULL ${userId ? "AND c.user_id=$1" : ""} ORDER BY s.created_at DESC`, userId ? [userId,new Date().toISOString()] : [new Date().toISOString()]);
}

// A session advisory lock serializes provisioning across controller workers without nesting existing DB transactions.
// Same-process callers queue in memory first, so two devices refreshing one subscription wait instead of failing.
const lockQueues = new Map<string, Promise<unknown>>();
async function locked<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = lockQueues.get(key) || Promise.resolve();
  const pending = previous.catch(() => undefined).then(() => lockAndRun(key, work));
  lockQueues.set(key, pending);
  try { return await pending; }
  finally { if (lockQueues.get(key) === pending) lockQueues.delete(key); }
}
async function lockAndRun<T>(key: string, work: () => Promise<T>): Promise<T> {
  // Dedicated bounded pool, separate from the reconcile lock pool that work() itself may need.
  if (!lockPool) {
    getDb(); // Validate the configured database before creating another pool.
    lockPool = new Pool({ connectionString: process.env.NORTHSTAR_DATABASE_URL, max: Number(process.env.NORTHSTAR_SUBSCRIPTION_LOCK_POOL_MAX || 10), connectionTimeoutMillis: 15000, idleTimeoutMillis: 10000 });
    lockPool.on("error", () => console.error("Subscription lock connection failed"));
  }
  const client = await lockPool.connect().catch(() => { throw new Error("订阅服务繁忙，请稍后重试"); });
  let held = false;
  try {
    try {
      await client.query("SET lock_timeout='15s'");
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
      held = true;
    } catch { throw new Error("订阅正在更新，请稍后重试"); }
    return await work();
  } finally {
    let discard = false;
    try { if (held) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]); }
    catch { discard = true; }
    finally { client.release(discard || !held); }
  }
}

export async function createSubscription(userId: string, name: string, protocol: "wireguard" | "vless") {
  return locked(`subscription-create:${userId}`, async () => {
    if ((await listSubscriptions(userId)).filter((s) => s.status === "active").length >= 20) throw new Error("最多创建 20 份有效订阅");
    const key = protocol === "wireguard" ? randomBytes(32) : null;
    const identityKey = key ? Buffer.from(x25519.getPublicKey(key)).toString("base64") : randomUUID();
    const credential = await createAccessCredential({ userId, displayName: name, protocol, identityKey });
    // VLESS authorization UUID is distinct from its public telemetry identity and encrypted at rest.
    const secret = await createSecretMaterial({ kind: `subscription_key:${credential.id}`, value: key ? key.toString("base64") : randomUUID() });
    const token = randomBytes(32).toString("base64url"), id = `sub_${randomUUID()}`, timestamp = new Date().toISOString();
    const linkSecret = await createSecretMaterial({ kind: `subscription_link:${id}`, value: token });
    await dbExec(`INSERT INTO subscriptions (id,credential_id,token_hash,private_key_secret_id,created_at,updated_at,token_secret_id)
      VALUES ($1,$2,$3,$4,$5,$5,$6)`, [id,credential.id,hashToken(token),secret?.id || null,timestamp,linkSecret.id]);
    await addAudit({ actorUserId: userId, action: "subscription.created", targetType: "subscription", targetId: id });
    return { id, credentialId: credential.id, token };
  });
}

export async function manageSubscription(id: string, action: string, actor: { id: string; admin: boolean }) {
  return locked(`subscription:${id}`, async () => {
    const sub = (await listSubscriptions(actor.admin ? undefined : actor.id)).find((s) => s.id === id);
    if (!sub) throw new Error("订阅不存在");
    if (["reveal-link", "reset-link"].includes(action) && actor.admin) throw new Error("订阅链接仅本人可获取");
    if (action === "reveal-link") {
      await assertCredentialUsable(sub.credential_id);
      const stored = (await dbQuery<Subscription>("SELECT * FROM subscriptions WHERE id=$1", [id]))[0];
      const token = stored?.token_secret_id ? await readSecretMaterial(stored.token_secret_id) : undefined;
      if (!token) throw new Error("旧订阅未保存可恢复的链接，请在更多操作中重置一次；已有配置不会因此撤销。");
      await addAudit({ actorUserId: actor.id, action: "subscription.link-revealed", targetType: "subscription", targetId: id });
      return { token };
    }
    if (action === "reset-link") {
      await assertCredentialUsable(sub.credential_id);
      const token = randomBytes(32).toString("base64url");
      const linkSecret = await createSecretMaterial({ kind: `subscription_link:${id}`, value: token });
      await dbExec("UPDATE subscriptions SET token_hash=$1,updated_at=$2,token_secret_id=$4 WHERE id=$3", [hashToken(token),new Date().toISOString(),id,linkSecret.id]);
      await addAudit({ actorUserId: actor.id, action: "subscription.link-reset", targetType: "subscription", targetId: id });
      return { token };
    }
    if (!["enable", "disable", "revoke", "delete"].includes(action)) throw new Error("不支持的订阅操作");
    return manageCredentialAccess(sub.credential_id, action as "enable" | "disable" | "revoke" | "delete", actor);
  });
}

/** Has the Agent applied a revision that contains this credential? Later unrelated revisions don't matter. */
async function accessApplied(profileId: string, nodeId: string, protocol: "wireguard" | "vless", identityKey: string) {
  const desired = await findDesiredConfig(nodeId, protocol);
  const applied = (await dbQuery<{ applied_revision: number; status: string }>(
    "SELECT applied_revision,status FROM observed_configs WHERE node_id=$1 AND protocol=$2", [nodeId,protocol]))[0];
  if (!desired || !applied || !["applied", "succeeded"].includes(applied.status)) return false;
  const member = protocol === "wireguard"
    ? ((desired.payload.peers || []) as Array<{ publicKey?: string }>).some((peer) => peer.publicKey === identityKey)
    : (await realityUserIdentities(nodeId)).has(identityKey);
  if (!member) {
    await dbExec("UPDATE connection_profiles SET included_revision=NULL WHERE id=$1", [profileId]);
    return false;
  }
  // Legacy agents hash sorted Python JSON, whereas the controller hashes JS JSON; revisions are the shared contract.
  const row = (await dbQuery<{ included_revision: number | null }>(
    "UPDATE connection_profiles SET included_revision=COALESCE(included_revision,$2) WHERE id=$1 RETURNING included_revision", [profileId,desired.revision]))[0];
  return applied.applied_revision >= Number(row?.included_revision ?? desired.revision);
}

export async function downloadSubscription(token: string, options: { format?: SubscriptionFormat; mode?: RoutingMode } = {}) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("订阅不可用");
  const initial = (await dbQuery<Subscription>("SELECT * FROM subscriptions WHERE token_hash=$1", [hashToken(token)]))[0];
  if (!initial) throw new Error("订阅不可用");
  return locked(`subscription:${initial.id}`, async () => {
    const sub = (await dbQuery<Subscription>("SELECT * FROM subscriptions WHERE id=$1 AND token_hash=$2", [initial.id,hashToken(token)]))[0];
    if (!sub) throw new Error("订阅不可用");
    const credential = await assertCredentialUsable(sub.credential_id);
    if (credential.protocol !== "wireguard" && credential.protocol !== "vless") throw new Error("订阅协议不受支持");
    const key = sub.private_key_secret_id ? await readSecretMaterial(sub.private_key_secret_id) : undefined;
    const candidates = await selectVpnServices({ protocol: credential.protocol });
    const profiles = await listConnectionProfiles({ credentialId: credential.id });
    const proxies: SubscriptionProxy[] = [];
    const regions = new Map((await dbQuery<{ id: string; name: string; code: string }>("SELECT id,name,code FROM regions")).map((row) => [row.id, row]));
    const usedNames = new Set<string>();
    for (const { node, service } of candidates) {
      try {
      let profile = profiles.find((p) => p.node_id === node.id && ["issued", "active"].includes(p.status)
        && new Date(p.expires_at).getTime() > Date.now() && p.endpoint.host === (node.public_endpoint || node.ip) && p.endpoint.port === service.listen_port);
      if (!profile) profile = await issueConnectionProfile({ credentialId: credential.id, nodeId: node.id, protocol: credential.protocol, clientPrivateKey: key });
      if (profile.status === "issued") profile = await activateProfile(profile.id, credential.user_id);
      // A healthy process alone doesn't prove that THIS user's access has reached the node.
      if (!(await accessApplied(profile.id, node.id, credential.protocol, credential.identity_key))) continue;
      const region = node.region_id ? regions.get(node.region_id) : undefined;
      const name = proxyName({ countryCode: region?.code, region: region?.name, nodeName: node.name, nodeId: node.id }, usedNames);
      const payload = profile.protocol_payload;
      if (credential.protocol === "wireguard") {
        if (!key || !profile.client_address || !node.server_public_key) continue;
        proxies.push({ name, type: "wireguard", server: profile.endpoint.host, port: profile.endpoint.port,
          ip: profile.client_address.split("/")[0], "private-key": key, "public-key": node.server_public_key,
          "allowed-ips": ["0.0.0.0/0"], "persistent-keepalive": 25, udp: true, "remote-dns-resolve": true, dns: profile.dns, mtu: 1280 });
      } else {
        if (!key) continue;
        proxies.push({ name, type: "vless", server: profile.endpoint.host, port: profile.endpoint.port,
          uuid: key, network: "tcp", tls: true, udp: true, flow: "xtls-rprx-vision", servername: payload.serverName,
          "client-fingerprint": "chrome", "reality-opts": { "public-key": payload.publicKey, "short-id": payload.shortId } });
      }
      } catch {
        // A full address pool or failed node must not invalidate the other ready nodes.
        await addAudit({ actorUserId: credential.user_id, action: "subscription.node-pending", targetType: "node", targetId: node.id,
          metadata: { subscriptionId: sub.id, protocol: credential.protocol } });
      }
    }
    // Re-check revocations that may have arrived through the legacy credential/account management endpoints.
    await assertCredentialUsable(credential.id);
    const format = options.format || "clash";
    const content = format === "v2ray" ? renderV2raySubscription(proxies) : renderSubscription(proxies, { mode: options.mode });
    await dbExec("UPDATE subscriptions SET last_fetched_at=$1 WHERE id=$2", [new Date().toISOString(),sub.id]);
    return { content, format, count: proxies.length, expiresAt: credential.expires_at };
  });
}
