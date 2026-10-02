import { Pool } from "pg";
import { getDb } from "./db";

let pool: Pool | undefined;
/** Serialize read/build/write of desired state, including concurrent subscription provisioning and revocation. */
export async function withReconcileLock<T>(nodeId: string, protocol: string, work: () => Promise<T>): Promise<T> {
  if (!pool) {
    getDb();
    pool = new Pool({ connectionString: process.env.NORTHSTAR_DATABASE_URL, max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
    pool.on("error", () => console.error("Reconcile lock connection failed"));
  }
  const client = await pool.connect();
  const key = `reconcile:${nodeId}:${protocol}`;
  let held = false;
  try {
    await client.query("SET lock_timeout='5s'");
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
    held = true;
    return await work();
  } finally {
    try { if (held) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]); }
    finally { client.release(); }
  }
}
