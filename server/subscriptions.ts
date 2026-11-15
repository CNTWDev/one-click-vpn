import { randomBytes, randomUUID } from "node:crypto";
import { addAudit, dbExec, dbQuery } from "./db";
import { withKeyedLock } from "./reconcile-lock";
import { hashToken } from "./crypto";
import { createAccessCredential, findAccessCredential, findDesiredConfig, listConnectionProfiles } from "./control-db";
import { activateProfile, issueConnectionProfile, rebuildDesiredState, selectVpnServices } from "./control-plane";
import { assertCredentialUsable, manageCredentialAccess } from "./credential-access";
import { createSecretMaterial, readSecretMaterial } from "./secret-materials";
import { lineNames, proxyName, renderSubscription, renderV2raySubscription, subscriptionClient, type RoutingMode, type SubscriptionClient, type SubscriptionFormat, type SubscriptionNode, type SubscriptionProxy } from "./subscription-format";
import { realitySettings, realityUserIdentities } from "./reality";
import { ensureStealthServer, STEALTH_SNI, stealthAccessApplied } from "./stealth";
import { accountAccess } from "./entitlements";

type Subscription = { id: string; credential_id: string; token_hash: string; token_secret_id: string | null; private_key_secret_id: string | null; created_at: string; updated_at: string; last_fetched_at: string | null };
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

/** Concurrent refreshes of one link wait for each other instead of provisioning twice. */
function locked<T>(key: string, work: () => Promise<T>): Promise<T> {
  return withKeyedLock(key, work);
}

/** A subscription is VLESS: REALITY plus the stealth lines (Hysteria2, XHTTP) on every ready node. */
export async function createSubscription(userId: string, name: string) {
  return locked(`subscription-create:${userId}`, async () => {
    if ((await listSubscriptions(userId)).filter((s) => s.status === "active").length >= 20) throw new Error("最多创建 20 份有效订阅");
    const credential = await createAccessCredential({ userId, displayName: name, protocol: "vless", identityKey: randomUUID() });
    // VLESS authorization UUID is distinct from its public telemetry identity and encrypted at rest.
    const secret = await createSecretMaterial({ kind: `subscription_key:${credential.id}`, value: randomUUID() });
    const token = randomBytes(32).toString("base64url"), id = `sub_${randomUUID()}`, timestamp = new Date().toISOString();
    const linkSecret = await createSecretMaterial({ kind: `subscription_link:${id}`, value: token });
    await dbExec(`INSERT INTO subscriptions (id,credential_id,token_hash,private_key_secret_id,created_at,updated_at,token_secret_id)
      VALUES ($1,$2,$3,$4,$5,$5,$6)`, [id,credential.id,hashToken(token),secret.id,timestamp,linkSecret.id]);
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

/** Has the Agent applied a VLESS revision that contains this credential? Later unrelated revisions don't matter. */
async function accessApplied(profileId: string, nodeId: string, identityKey: string) {
  const desired = await findDesiredConfig(nodeId, "vless");
  const applied = (await dbQuery<{ applied_revision: number; status: string }>(
    "SELECT applied_revision,status FROM observed_configs WHERE node_id=$1 AND protocol='vless'", [nodeId]))[0];
  if (!desired || !applied || !["applied", "succeeded"].includes(applied.status)) return false;
  if (!(await realityUserIdentities(nodeId)).has(identityKey)) {
    await dbExec("UPDATE connection_profiles SET included_revision=NULL WHERE id=$1", [profileId]);
    return false;
  }
  // Legacy agents hash sorted Python JSON, whereas the controller hashes JS JSON; revisions are the shared contract.
  const row = (await dbQuery<{ included_revision: number | null }>(
    "UPDATE connection_profiles SET included_revision=COALESCE(included_revision,$2) WHERE id=$1 RETURNING included_revision", [profileId,desired.revision]))[0];
  return applied.applied_revision >= Number(row?.included_revision ?? desired.revision);
}

/**
 * The node's stealth lines for a VLESS subscription, in the apps' order: Hysteria2 before REALITY, XHTTP after.
 * Same UUID as the REALITY line. Only once the node has loaded the subscription (stealthAccessApplied).
 */
async function stealthLines(node: { id: string }, host: string, port: number, uuid: string, identityKey: string, client: SubscriptionClient) {
  if (!client.hysteria2 && !client.xhttp) return { before: [], after: [] };
  if (!(await stealthAccessApplied(node.id, identityKey, () => rebuildDesiredState(node.id, "stealth")))) return { before: [], after: [] };
  const reality = await realitySettings(node.id);
  if (!reality) return { before: [], after: [] };
  const { server } = await ensureStealthServer(node.id);
  const before: SubscriptionProxy[] = client.hysteria2 ? [{ name: "", type: "hysteria2", server: host, port, password: uuid, obfs: "salamander",
    "obfs-password": server.obfsPassword, sni: STEALTH_SNI, "skip-cert-verify": true, fingerprint: server.fingerprint, alpn: ["h3"], udp: true }] : [];
  const after: SubscriptionProxy[] = client.xhttp ? [{ name: "", type: "vless", server: host, port, uuid, network: "xhttp", tls: true, udp: true,
    servername: reality.server_name, "client-fingerprint": "chrome", "reality-opts": { "public-key": reality.public_key, "short-id": reality.short_id },
    "xhttp-opts": { path: server.xhttpPath } }] : [];
  return { before, after };
}

const WIREGUARD_GRACE_MS = 7 * 86400_000;

/**
 * Subscriptions used to be WireGuard or VLESS; now they are all VLESS. An old WireGuard subscription moves
 * to a new VLESS credential under the same link, so its next refresh brings the new lines. The new credential
 * takes over the old one's device (no free slot needed, ranked just before it, so a device limit drops the
 * WireGuard one first). The WireGuard credential keeps working for 7 days for devices that have not refreshed.
 * Runs from the minute jobs; once no WireGuard subscription is left it is one empty query.
 * TODO(2026-12): remove together with the last WireGuard subscription credentials.
 */
export async function upgradeWireGuardSubscriptions(): Promise<number> {
  const rows = await dbQuery<{ id: string }>(`SELECT s.id FROM subscriptions s JOIN access_credentials c ON c.id=s.credential_id
    WHERE c.protocol='wireguard' AND c.status='active' AND c.deleted_at IS NULL`);
  for (const { id } of rows) {
    await locked(`subscription:${id}`, async () => {
      const sub = (await dbQuery<Subscription>("SELECT * FROM subscriptions WHERE id=$1", [id]))[0];
      const old = sub && await findAccessCredential(sub.credential_id);
      if (!old || old.protocol !== "wireguard") return;
      const credential = await createAccessCredential({ userId: old.user_id, displayName: old.display_name, protocol: "vless", identityKey: randomUUID(), replacesCredential: true });
      const grace = new Date(Date.now() + WIREGUARD_GRACE_MS).toISOString();
      await dbExec("UPDATE access_credentials SET created_at=$1,expires_at=$2,user_disabled=$3,admin_disabled=$4 WHERE id=$5",
        [new Date(Date.parse(old.created_at) - 1).toISOString(), old.expires_at, old.user_disabled, old.admin_disabled, credential.id]);
      const secret = await createSecretMaterial({ kind: `subscription_key:${credential.id}`, value: randomUUID() });
      await dbExec("UPDATE subscriptions SET credential_id=$1,private_key_secret_id=$2,updated_at=$3 WHERE id=$4", [credential.id, secret.id, new Date().toISOString(), id]);
      await dbExec("UPDATE access_credentials SET expires_at=$1,updated_at=$2 WHERE id=$3 AND (expires_at IS NULL OR expires_at>$1)", [grace, new Date().toISOString(), old.id]);
      await addAudit({ actorUserId: old.user_id, action: "subscription.upgraded", targetType: "subscription", targetId: id, metadata: { from: old.id, to: credential.id } });
    }).catch((error) => console.error("Subscription upgrade failed", id, error));
  }
  return rows.length;
}

export async function downloadSubscription(token: string, options: { format?: SubscriptionFormat; mode?: RoutingMode; group?: string; userAgent?: string | null } = {}) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("订阅不可用");
  const initial = (await dbQuery<Subscription>("SELECT * FROM subscriptions WHERE token_hash=$1", [hashToken(token)]))[0];
  if (!initial) throw new Error("订阅不可用");
  return locked(`subscription:${initial.id}`, async () => {
    const sub = (await dbQuery<Subscription>("SELECT * FROM subscriptions WHERE id=$1 AND token_hash=$2", [initial.id,hashToken(token)]))[0];
    if (!sub) throw new Error("订阅不可用");
    const credential = await assertCredentialUsable(sub.credential_id);
    // A WireGuard subscription not upgraded yet answers 503, so the client keeps its working config.
    if (credential.protocol !== "vless") throw new Error("订阅正在升级");
    const key = sub.private_key_secret_id ? await readSecretMaterial(sub.private_key_secret_id) : undefined;
    if (!key) throw new Error("订阅不可用");
    const format = options.format || "clash";
    const client = subscriptionClient(format, options.userAgent ?? null);
    const candidates = await selectVpnServices({ protocol: "vless" });
    const stealthServices = new Map((client.hysteria2 || client.xhttp ? await selectVpnServices({ protocol: "stealth" }) : []).map((item) => [item.node.id, item.service]));
    const profiles = await listConnectionProfiles({ credentialId: credential.id });
    const regions = new Map((await dbQuery<{ id: string; name: string; code: string }>("SELECT id,name,code FROM regions")).map((row) => [row.id, row]));
    const proxies: SubscriptionProxy[] = [], nodes: SubscriptionNode[] = [], usedNames = new Set<string>();
    for (const { node, service } of candidates) {
      try {
        let profile = profiles.find((p) => p.node_id === node.id && ["issued", "active"].includes(p.status)
          && new Date(p.expires_at).getTime() > Date.now() && p.endpoint.host === (node.public_endpoint || node.ip) && p.endpoint.port === service.listen_port);
        if (!profile) profile = await issueConnectionProfile({ credentialId: credential.id, nodeId: node.id, protocol: "vless" });
        if (profile.status === "issued") profile = await activateProfile(profile.id, credential.user_id);
        // A healthy process alone doesn't prove that THIS user's access has reached the node.
        if (!(await accessApplied(profile.id, node.id, credential.identity_key))) continue;
        const region = node.region_id ? regions.get(node.region_id) : undefined;
        const name = proxyName({ countryCode: region?.code, region: region?.name, nodeName: node.name, nodeId: node.id }, usedNames);
        const payload = profile.protocol_payload;
        const reality: SubscriptionProxy = { name, type: "vless", server: profile.endpoint.host, port: profile.endpoint.port,
          uuid: key, network: "tcp", tls: true, udp: true, flow: "xtls-rprx-vision", servername: payload.serverName,
          "client-fingerprint": "chrome", "reality-opts": { "public-key": payload.publicKey, "short-id": payload.shortId } };
        const stealth = stealthServices.get(node.id);
        // A stealth problem on one node never costs the subscription its REALITY line there.
        const extra = stealth ? await stealthLines(node, profile.endpoint.host, stealth.listen_port, key, credential.identity_key, client).catch(() => ({ before: [], after: [] }))
          : { before: [], after: [] };
        const lines = [...extra.before, reality, ...extra.after];
        const names = lineNames(name, lines.length, format);
        lines.forEach((line, index) => { line.name = names[index]; });
        proxies.push(...lines);
        nodes.push({ name, proxies: lines });
      } catch {
        // A full address pool or failed node must not invalidate the other ready nodes.
        await addAudit({ actorUserId: credential.user_id, action: "subscription.node-pending", targetType: "node", targetId: node.id,
          metadata: { subscriptionId: sub.id, protocol: "vless" } });
      }
    }
    // Re-check revocations that may have arrived through the legacy credential/account management endpoints.
    await assertCredentialUsable(credential.id);
    const content = format === "v2ray" ? renderV2raySubscription(proxies)
      : renderSubscription(proxies, { mode: options.mode, group: options.group, nodes: nodes.map((node) => ({ name: node.name, proxies: node.proxies.map((line) => line.name) })) });
    await dbExec("UPDATE subscriptions SET last_fetched_at=$1 WHERE id=$2", [new Date().toISOString(),sub.id]);
    // Clients such as Clash show this as the plan's usage and end date.
    const access = await accountAccess(credential.user_id);
    const ends = [access.until, credential.expires_at].filter((value): value is string => Boolean(value)).map((value) => Date.parse(value));
    return { content, format, count: proxies.length, expiresAt: ends.length ? new Date(Math.min(...ends)).toISOString() : null, usedBytes: access.usedBytes, quotaBytes: access.quotaBytes };
  });
}
