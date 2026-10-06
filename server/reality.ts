import { randomBytes } from "node:crypto";
import { x25519 } from "@noble/curves/ed25519.js";
import { dbExec, dbQuery, withTransaction } from "./db";
import { encryptSecret } from "./crypto";
import { createHash, randomUUID } from "node:crypto";
import { readSecretMaterial, createSecretMaterial, findSecretMaterialByKind } from "./secret-materials";
import { hashToken } from "./crypto";

export type RealitySettings = { node_id: string; server_name: string; public_key: string; short_id: string; secret_id: string; previous_server_names?: string };
export async function realitySettings(nodeId: string) {
  return (await dbQuery<RealitySettings>("SELECT * FROM reality_settings WHERE node_id = $1", [nodeId]))[0];
}

export async function configureReality(nodeId: string, serverName: string, options: { onlyIfMissing?: boolean } = {}) {
  // A DNS name, not a URL or arbitrary dial address. The node independently validates the resolved destination.
  const name = serverName.trim().toLowerCase();
  if (name.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name)) throw new Error("REALITY 目标必须是有效的公网域名");
  await withTransaction(async (exec) => {
    await exec("SELECT pg_advisory_xact_lock(hashtext($1))", [`reality:${nodeId}`]);
    const existing = await realitySettings(nodeId);
    if (existing) {
      if (options.onlyIfMissing) return;
      if (existing.server_name === name) return;
      // Smooth switch: keys stay, the old names remain accepted, and existing profiles move to the
      // new name so subscribers pick it up on their next refresh without re-issuing anything.
      const previous = [existing.server_name, ...parsePreviousNames(existing.previous_server_names)].filter((item) => item !== name).slice(0, 3);
      const raw = await readSecretMaterial(existing.secret_id,nodeId);
      if (!raw) throw new Error("REALITY server secret unavailable");
      const value = JSON.stringify({ ...JSON.parse(raw), serverName: name, previousServerNames: previous });
      const encrypted = encryptSecret(value), timestamp = new Date().toISOString();
      await exec("UPDATE secret_materials SET ciphertext=$1,iv=$2,tag=$3,fingerprint=$4,updated_at=$5 WHERE id=$6", [encrypted.ciphertext,encrypted.iv,encrypted.tag,hashToken(value),timestamp,existing.secret_id]);
      await exec("UPDATE reality_settings SET server_name=$1,previous_server_names=$2 WHERE node_id=$3", [name,JSON.stringify(previous),nodeId]);
      await exec(`UPDATE connection_profiles SET protocol_payload_json=jsonb_set(protocol_payload_json::jsonb,'{serverName}',to_jsonb($1::text))::text,updated_at=$3
        WHERE node_id=$2 AND protocol='vless'`, [name,nodeId,timestamp]);
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

function parsePreviousNames(value: string | undefined): string[] {
  try { const names = JSON.parse(value || "[]"); return Array.isArray(names) ? names.filter((item): item is string => typeof item === "string") : []; }
  catch { return []; }
}

async function realityUserRows(nodeId: string) {
  return dbQuery<{ secret_id: string; email: string; fingerprint: string }>(`SELECT DISTINCT COALESCE(s.private_key_secret_id, k.id) AS secret_id, c.identity_key AS email, material.fingerprint FROM access_credentials c
    LEFT JOIN subscriptions s ON s.credential_id=c.id
    LEFT JOIN secret_materials k ON k.kind='vless_client:' || c.id AND k.owner_node_id IS NULL
    JOIN secret_materials material ON material.id=COALESCE(s.private_key_secret_id, k.id)
    JOIN users u ON u.id=c.user_id JOIN connection_profiles p ON p.credential_id=c.id
    WHERE p.node_id=$1 AND p.protocol='vless' AND p.status='active' AND p.expires_at>$2
    AND c.status='active' AND NOT c.user_disabled AND NOT c.admin_disabled AND c.deleted_at IS NULL
    AND (c.expires_at IS NULL OR c.expires_at>$2) AND u.status='active' AND NOT u.native_only ORDER BY c.identity_key`, [nodeId,new Date().toISOString()]);
}

async function decryptUsers(rows: Awaited<ReturnType<typeof realityUserRows>>) {
  return Promise.all(rows.map(async (row) => {
    const id = await readSecretMaterial(row.secret_id);
    if (!id) throw new Error("VLESS client secret unavailable");
    return { id, email: row.email };
  }));
}

/** Telemetry identities currently granted on a node (no secrets are decrypted). */
export async function realityUserIdentities(nodeId: string) { return new Set((await realityUserRows(nodeId)).map((row) => row.email)); }

export async function realityUsers(nodeId: string) { return decryptUsers(await realityUserRows(nodeId)); }

export async function realityClientSecretId(credentialId: string) {
  const row = (await dbQuery<{ private_key_secret_id: string }>(`SELECT private_key_secret_id FROM subscriptions WHERE credential_id=$1
    UNION ALL SELECT id FROM secret_materials WHERE kind='vless_client:' || $1 AND owner_node_id IS NULL LIMIT 1`, [credentialId]))[0];
  if (!row?.private_key_secret_id) throw new Error("VLESS client secret unavailable");
  return row.private_key_secret_id;
}

export async function realityUsersSecret(nodeId: string) {
  const rows = await realityUserRows(nodeId);
  const sourceFingerprint = hashToken(JSON.stringify(rows));
  const previous = await findSecretMaterialByKind("vless_users_bundle", nodeId);
  if (previous?.source_fingerprint === sourceFingerprint) {
    await cleanRealityBundles(nodeId, previous.id);
    return previous.id;
  }
  const value = JSON.stringify(await decryptUsers(rows));
  const material = previous?.fingerprint === hashToken(value) ? previous : await createSecretMaterial({ kind: "vless_users_bundle", ownerNodeId: nodeId, value });
  await dbExec("UPDATE secret_materials SET source_fingerprint=$1 WHERE id=$2", [sourceFingerprint, material.id]);
  await cleanRealityBundles(nodeId, material.id);
  return material.id;
}
async function cleanRealityBundles(nodeId: string, keepId: string) {
  // Runs on every heartbeat: an indexed existence probe first, the jsonb scans only when there is something to collect.
  const cutoff = new Date(Date.now()-86400000).toISOString();
  if (!(await dbQuery("SELECT 1 FROM secret_materials WHERE kind='vless_users_bundle' AND owner_node_id=$1 AND id<>$2 AND created_at<$3 LIMIT 1", [nodeId, keepId, cutoff])).length) return;
  // Keep queued and in-flight revisions readable; completed bundles have a one-day grace period.
  await dbExec(`DELETE FROM secret_materials s WHERE s.kind='vless_users_bundle' AND s.owner_node_id=$1
    AND s.id<>$2 AND s.created_at<$3
    AND NOT EXISTS (SELECT 1 FROM desired_configs d WHERE d.node_id=$1 AND d.payload_json::jsonb->>'usersSecretId'=s.id)
    AND NOT EXISTS (SELECT 1 FROM reconcile_tasks t WHERE t.node_id=$1
      AND (t.status IN ('pending','running') OR (t.status='failed' AND t.attempts<5))
      AND t.payload_json::jsonb->>'usersSecretId'=s.id)`, [nodeId, keepId, new Date(Date.now()-86400000).toISOString()]);
}
