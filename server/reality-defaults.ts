import { dbQuery, withTransaction } from "./db";
import { randomUUID } from "node:crypto";
import { assertIndependentTarget, checkTarget, targetHostname } from "./reality-target-check.mjs";
import { REALITY_CANDIDATES } from "./reality-candidates";

export type RealityTargetMode = "auto" | "custom";

/** "auto" (default): each node gets a verified large public site; "custom": one operator-run static site. */
export async function realityDefaults() {
  const row = (await dbQuery<{ mode: string | null; server_name: string; checked_at: string; updated_at: string }>("SELECT mode, server_name, checked_at, updated_at FROM reality_defaults WHERE id='primary'"))[0];
  const environment = process.env.VEILBIRD_REALITY_TARGET?.trim() || "";
  const mode: RealityTargetMode = row ? (row.mode === "auto" ? "auto" : "custom") : environment ? "custom" : "auto";
  const serverName = mode === "custom" ? row?.server_name || environment : "";
  return { mode, serverName, candidates: [...REALITY_CANDIDATES], checkedAt: row?.checked_at || null, updatedAt: row?.updated_at || null };
}

export async function saveRealityDefaults(input: { mode?: unknown; serverName?: unknown }, actorUserId: string) {
  const mode: RealityTargetMode = input.mode === "auto" ? "auto" : "custom";
  let name = "", checkedAt = new Date().toISOString();
  if (mode === "custom") {
    name = targetHostname(input.serverName);
    assertIndependentTarget(name);
    checkedAt = (await checkTarget(name)).checkedAt;
  }
  await withTransaction(async (exec) => {
    await exec(`INSERT INTO reality_defaults (id,mode,server_name,checked_at,updated_at) VALUES ('primary',$1,$2,$3,$3)
      ON CONFLICT (id) DO UPDATE SET mode=EXCLUDED.mode,server_name=EXCLUDED.server_name,checked_at=EXCLUDED.checked_at,updated_at=EXCLUDED.updated_at`, [mode,name,checkedAt]);
    await exec(`INSERT INTO audit_logs (id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
      VALUES ($1,$2,'reality.default.update','settings','primary',$3,$4)`, [randomUUID(),actorUserId,JSON.stringify({ mode, serverName: name }),checkedAt]);
  });
  return realityDefaults();
}
