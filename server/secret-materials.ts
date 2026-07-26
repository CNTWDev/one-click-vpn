import { randomUUID } from "node:crypto";
import { decryptSecret, encryptSecret, hashToken } from "./crypto";
import { dbExec, dbQuery } from "./db";

export type SecretMaterial = {
  id: string;
  kind: string;
  owner_node_id: string | null;
  ciphertext: string;
  iv: string;
  tag: string;
  fingerprint: string;
  created_at: string;
  updated_at: string;
};

function now(): string {
  return new Date().toISOString();
}

export async function createSecretMaterial(input: { kind: string; value: string; ownerNodeId?: string | null }): Promise<SecretMaterial> {
  const id = `secret_${randomUUID()}`;
  const encrypted = encryptSecret(input.value);
  const timestamp = now();
  await dbExec(`INSERT INTO secret_materials
    (id, kind, owner_node_id, ciphertext, iv, tag, fingerprint, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`, [
    id, input.kind, input.ownerNodeId || null, encrypted.ciphertext, encrypted.iv, encrypted.tag,
    hashToken(input.value), timestamp,
  ]);
  return (await findSecretMaterial(id))!;
}

export async function findSecretMaterial(id: string): Promise<SecretMaterial | undefined> {
  return (await dbQuery<SecretMaterial>("SELECT * FROM secret_materials WHERE id = $1", [id]))[0];
}

export async function findSecretMaterialByKind(kind: string, ownerNodeId: string): Promise<SecretMaterial | undefined> {
  return (await dbQuery<SecretMaterial>(`SELECT * FROM secret_materials
    WHERE kind = $1 AND owner_node_id = $2 ORDER BY created_at DESC LIMIT 1`, [kind, ownerNodeId]))[0];
}

export async function readSecretMaterial(id: string, ownerNodeId?: string): Promise<string | undefined> {
  const secret = await findSecretMaterial(id);
  if (!secret || (ownerNodeId && secret.owner_node_id !== ownerNodeId)) return undefined;
  return decryptSecret(secret);
}

export async function deleteSecretMaterialsByKind(kind: string): Promise<void> {
  await dbExec("DELETE FROM secret_materials WHERE kind = $1", [kind]);
}
