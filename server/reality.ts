import { randomBytes } from "node:crypto";
import { x25519 } from "@noble/curves/ed25519.js";
import { dbQuery, withTransaction } from "./db";
import { encryptSecret } from "./crypto";
import { createHash, randomUUID } from "node:crypto";
import { readSecretMaterial, createSecretMaterial, findSecretMaterialByKind } from "./secret-materials";
import { hashToken } from "./crypto";

export type RealitySettings = { node_id: string; server_name: string; public_key: string; short_id: string; secret_id: string };
export async function realitySettings(nodeId: string) {
  return (await dbQuery<RealitySettings>("SELECT * FROM reality_settings WHERE node_id = $1", [nodeId]))[0];
}

export async function configureReality(nodeId: string, serverName: string) {
  // A DNS name, not a URL or arbitrary dial address. The node independently validates the resolved destination.
  const name = serverName.trim().toLowerCase();
  if (name.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name)) throw new Error("REALITY 目标必须是有效的公网域名");
  await withTransaction(async (exec) => {
    await exec("SELECT pg_advisory_xact_lock(hashtext($1))", [`reality:${nodeId}`]);
    const existing = await realitySettings(nodeId);
    if (existing) {
      if (existing.server_name === name) return;
      const inUse = await exec("SELECT id FROM connection_profiles WHERE node_id=$1 AND protocol='vless' AND status IN ('issued','active') AND expires_at>$2", [nodeId,new Date().toISOString()]);
      if (inUse) throw new Error("节点已有有效 VLESS 配置，不能直接更换目标域名。请先撤销相关连接或使用新节点。");
      const raw = await readSecretMaterial(existing.secret_id,nodeId);
      if (!raw) throw new Error("REALITY server secret unavailable");
      const value = JSON.stringify({ ...JSON.parse(raw), serverName: name });
      const encrypted = encryptSecret(value);
      await exec("UPDATE secret_materials SET ciphertext=$1,iv=$2,tag=$3,fingerprint=$4,updated_at=$5 WHERE id=$6", [encrypted.ciphertext,encrypted.iv,encrypted.tag,hashToken(value),new Date().toISOString(),existing.secret_id]);
      await exec("UPDATE reality_settings SET server_name=$1 WHERE node_id=$2", [name,nodeId]);
      return;
    }
    const key = randomBytes(32);
    const publicKey = Buffer.from(x25519.getPublicKey(key)).toString("base64url");
    const shortId = randomBytes(8).toString("hex");
    const value = JSON.stringify({ privateKey: key.toString("base64url"), serverName: name, shortId });
    const encrypted = encryptSecret(value), id = `secret_${randomUUID()}`, timestamp = new Date().toISOString();
    await exec(`INSERT INTO secret_materials (id,kind,owner_node_id,ciphertext,iv,tag,fingerprint,created_at,updated_at)
      VALUES ($1,'reality_server',$2,$3,$4,$5,$6,$7,$7)`, [id,nodeId,encrypted.ciphertext,encrypted.iv,encrypted.tag,createHash("sha256").update(value).digest("hex"),timestamp]);
    await exec("INSERT INTO reality_settings (node_id,server_name,public_key,short_id,secret_id) VALUES ($1,$2,$3,$4,$5)", [nodeId,name,publicKey,shortId,id]);
  });
}

export async function realityUsers(nodeId: string) {
  const rows = await dbQuery<{ secret_id: string; email: string }>(`SELECT DISTINCT s.private_key_secret_id AS secret_id, c.identity_key AS email FROM access_credentials c
    JOIN subscriptions s ON s.credential_id=c.id
    JOIN users u ON u.id=c.user_id JOIN connection_profiles p ON p.credential_id=c.id
    WHERE p.node_id=$1 AND p.protocol='vless' AND p.status='active' AND p.expires_at>$2
    AND c.status='active' AND NOT c.user_disabled AND NOT c.admin_disabled AND c.deleted_at IS NULL
    AND (c.expires_at IS NULL OR c.expires_at>$2) AND u.status='active' ORDER BY c.identity_key`, [nodeId,new Date().toISOString()]);
  return Promise.all(rows.map(async (row) => {
    const id = await readSecretMaterial(row.secret_id);
    if (!id) throw new Error("VLESS client secret unavailable");
    return { id, email: row.email };
  }));
}

export async function realityClientSecretId(credentialId: string) {
  const row = (await dbQuery<{ private_key_secret_id: string }>("SELECT private_key_secret_id FROM subscriptions WHERE credential_id=$1", [credentialId]))[0];
  if (!row?.private_key_secret_id) throw new Error("VLESS subscription secret unavailable");
  return row.private_key_secret_id;
}

export async function realityUsersSecret(nodeId: string) {
  const value = JSON.stringify(await realityUsers(nodeId));
  const previous = await findSecretMaterialByKind("vless_users_bundle", nodeId);
  if (previous?.fingerprint === hashToken(value)) return previous.id;
  return (await createSecretMaterial({ kind: "vless_users_bundle", ownerNodeId: nodeId, value })).id;
}
