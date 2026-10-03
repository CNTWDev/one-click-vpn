import { dbQuery, withTransaction } from "./db";
import { randomUUID } from "node:crypto";
import { assertIndependentTarget, checkTarget, targetHostname } from "./reality-target-check.mjs";

export async function realityDefaults() {
  const row = (await dbQuery<{ server_name: string; checked_at: string; updated_at: string }>("SELECT server_name, checked_at, updated_at FROM reality_defaults WHERE id='primary'"))[0];
  return { serverName: row?.server_name || process.env.NORTHSTAR_REALITY_TARGET?.trim() || "", checkedAt: row?.checked_at || null, updatedAt: row?.updated_at || null };
}

export async function saveRealityDefaults(value: string, actorUserId: string) {
  const name = targetHostname(value);
  assertIndependentTarget(name);
  const result = await checkTarget(name);
  await withTransaction(async (exec) => {
    await exec(`INSERT INTO reality_defaults (id,server_name,checked_at,updated_at) VALUES ('primary',$1,$2,$2)
      ON CONFLICT (id) DO UPDATE SET server_name=EXCLUDED.server_name,checked_at=EXCLUDED.checked_at,updated_at=EXCLUDED.updated_at`, [name,result.checkedAt]);
    await exec(`INSERT INTO audit_logs (id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
      VALUES ($1,$2,'reality.default.update','settings','primary',$3,$4)`, [randomUUID(),actorUserId,JSON.stringify({ serverName: name }),result.checkedAt]);
  });
  return realityDefaults();
}
