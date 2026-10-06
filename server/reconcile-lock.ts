import { Pool } from "pg";
import { getDb } from "./db";

let pool: Pool | undefined;
const queues = new Map<string, Promise<unknown>>();
export class ReconcileLockBusyError extends Error {}
export function isReconcileLockBusy(error: unknown): boolean {
  return error instanceof ReconcileLockBusyError;
}
/** Serialize read/build/write of desired state, including concurrent subscription provisioning and revocation. */
export async function withReconcileLock<T>(nodeId: string, protocol: string, work: () => Promise<T>): Promise<T> {
  const key = `reconcile:${nodeId}:${protocol}`;
  const previous = queues.get(key) || Promise.resolve();
  const pending = previous.catch(() => undefined).then(() => lockAndRun(key, work));
  queues.set(key, pending);
  try { return await pending; }
  finally { if (queues.get(key) === pending) queues.delete(key); }
}
async function lockAndRun<T>(key: string, work: () => Promise<T>): Promise<T> {
  if (!pool) {
    getDb();
    pool = new Pool({ connectionString: process.env.VEILBIRD_DATABASE_URL, max: Number(process.env.VEILBIRD_LOCK_POOL_MAX || 10), connectionTimeoutMillis: 30000, idleTimeoutMillis: 10000 });
    pool.on("error", () => console.error("Reconcile lock connection failed"));
  }
  const client = await pool.connect().catch(() => { throw new ReconcileLockBusyError("Reconcile lock pool is busy or unavailable; retry on next heartbeat"); });
  let held = false;
  try {
    await client.query("SET lock_timeout='30s'");
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
    held = true;
  } catch (error) {
    client.release(true);
    throw new ReconcileLockBusyError(`Reconcile lock unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  let discard = false;
  try { return await work(); } finally {
    try { if (held) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]); }
    catch { discard = true; }
    finally { client.release(discard); }
  }
}
