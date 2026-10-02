import { randomBytes, randomUUID } from "node:crypto";
import { x25519 } from "@noble/curves/ed25519.js";
import { Pool } from "pg";
import { addAudit, dbExec, dbQuery, getDb } from "./db";
import { hashToken } from "./crypto";
import { createAccessCredential, findDesiredConfig, listConnectionProfiles } from "./control-db";
import { activateProfile, issueConnectionProfile, rebuildDesiredState, selectVpnServices } from "./control-plane";
import { assertCredentialUsable, manageCredentialAccess } from "./credential-access";
import { createSecretMaterial, readSecretMaterial } from "./secret-materials";
import { renderSubscription, type SubscriptionProxy } from "./subscription-format";

type Subscription = { id: string; credential_id: string; token_hash: string; private_key_secret_id: string | null; created_at: string; updated_at: string; last_fetched_at: string | null };
let lockPool: Pool | undefined;
export async function listSubscriptions(userId?: string) {
  return dbQuery<Subscription & { user_id: string; display_name: string; protocol: string; status: string; user_disabled: boolean; admin_disabled: boolean; expires_at: string; email: string }>(
    `SELECT s.id,s.credential_id,s.created_at,s.updated_at,s.last_fetched_at,c.user_id,c.display_name,c.protocol,c.status,
      c.user_disabled,c.admin_disabled,c.expires_at,u.email,u.status AS account_status,
      COALESCE((SELECT SUM(t.upload_bytes+t.download_bytes) FROM traffic_daily t WHERE t.credential_id=c.id),0)::text AS total_bytes,
      (SELECT COUNT(DISTINCT p.node_id) FROM connection_profiles p JOIN vpn_services v ON v.node_id=p.node_id AND v.protocol=p.protocol
        JOIN desired_configs d ON d.node_id=p.node_id AND d.protocol=p.protocol
        JOIN observed_configs o ON o.node_id=p.node_id AND o.protocol=p.protocol AND o.applied_revision=d.revision
        WHERE p.credential_id=c.id AND p.status='active' AND p.expires_at>$${userId ? 2 : 1} AND v.enabled=1
        AND o.status IN ('applied','succeeded'))::int AS synced_nodes
      FROM subscriptions s JOIN access_credentials c ON c.id=s.credential_id
      JOIN users u ON u.id=c.user_id WHERE c.deleted_at IS NULL ${userId ? "AND c.user_id=$1" : ""} ORDER BY s.created_at DESC`, userId ? [userId,new Date().toISOString()] : [new Date().toISOString()]);
}

// A session advisory lock serializes provisioning across controller workers without nesting existing DB transactions.
async function locked<T>(key: string, work: () => Promise<T>): Promise<T> {
  // Dedicated bounded pool: holding locks must never exhaust the query pool needed by work().
  if (!lockPool) {
    getDb(); // Validate the configured database before creating another pool.
    lockPool = new Pool({ connectionString: process.env.NORTHSTAR_DATABASE_URL, max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
    lockPool.on("error", () => console.error("Subscription lock connection failed"));
  }
  const client = await lockPool.connect();
  let held = false;
  try {
    held = (await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS held", [key])).rows[0].held;
    if (!held) throw new Error("订阅正在更新，请稍后重试");
    return await work();
  } finally {
    try { if (held) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]); }
    finally { client.release(); }
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
    await dbExec(`INSERT INTO subscriptions (id,credential_id,token_hash,private_key_secret_id,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$5)`, [id,credential.id,hashToken(token),secret?.id || null,timestamp]);
    await addAudit({ actorUserId: userId, action: "subscription.created", targetType: "subscription", targetId: id });
    return { id, credentialId: credential.id, token };
  });
}

export async function manageSubscription(id: string, action: string, actor: { id: string; admin: boolean }) {
  return locked(`subscription:${id}`, async () => {
    const sub = (await listSubscriptions(actor.admin ? undefined : actor.id)).find((s) => s.id === id);
    if (!sub) throw new Error("订阅不存在");
    if (action === "reset-link") {
      await assertCredentialUsable(sub.credential_id);
      const token = randomBytes(32).toString("base64url");
      await dbExec("UPDATE subscriptions SET token_hash=$1,updated_at=$2 WHERE id=$3", [hashToken(token),new Date().toISOString(),id]);
      await addAudit({ actorUserId: actor.id, action: "subscription.link-reset", targetType: "subscription", targetId: id });
      return { token };
    }
    if (!["enable", "disable", "revoke", "delete"].includes(action)) throw new Error("不支持的订阅操作");
    return manageCredentialAccess(sub.credential_id, action as "enable" | "disable" | "revoke" | "delete", actor);
  });
}

export async function downloadSubscription(token: string) {
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
    for (const { node, service } of candidates) {
      try {
      let profile = profiles.find((p) => p.node_id === node.id && ["issued", "active"].includes(p.status)
        && p.endpoint.host === (node.public_endpoint || node.ip) && p.endpoint.port === service.listen_port);
      if (!profile) profile = await issueConnectionProfile({ credentialId: credential.id, nodeId: node.id, protocol: credential.protocol, clientPrivateKey: key });
      if (profile.status === "issued") profile = await activateProfile(profile.id, credential.user_id);
      else await rebuildDesiredState(node.id, credential.protocol);
      const desired = await findDesiredConfig(node.id, credential.protocol);
      const applied = (await dbQuery<{ applied_revision: number; observed_hash: string; status: string }>(
        "SELECT applied_revision,observed_hash,status FROM observed_configs WHERE node_id=$1 AND protocol=$2", [node.id,credential.protocol]))[0];
      // A healthy process alone doesn't prove that THIS user's access has reached the node.
      // Legacy agents hash sorted Python JSON, whereas the controller hashes JS JSON; revisions are the shared contract.
      if (!desired || !applied || applied.applied_revision !== desired.revision || !["applied", "succeeded"].includes(applied.status)) continue;
      const name = `${node.region || node.name} · ${node.name} · ${node.id.slice(-8)} · ${credential.protocol === "vless" ? "VL" : "WG"}`;
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
    const content = renderSubscription(proxies);
    await dbExec("UPDATE subscriptions SET last_fetched_at=$1 WHERE id=$2", [new Date().toISOString(),sub.id]);
    return { content, count: proxies.length, expiresAt: credential.expires_at };
  });
}
