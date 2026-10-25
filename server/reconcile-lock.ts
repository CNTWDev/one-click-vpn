/**
 * Per-key serialization inside the controller process: desired-state builds per node and protocol,
 * subscription provisioning per link. The controller runs as one process (docker-compose `veilbird`),
 * so an in-memory queue is enough; it holds no database connection while waiting.
 */
const queues = new Map<string, Promise<unknown>>();

export async function withKeyedLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) || Promise.resolve();
  const pending = previous.catch(() => undefined).then(work);
  queues.set(key, pending);
  try { return await pending; }
  finally { if (queues.get(key) === pending) queues.delete(key); }
}

/** Serialize read/build/write of desired state, including concurrent subscription provisioning and revocation. */
export function withReconcileLock<T>(nodeId: string, protocol: string, work: () => Promise<T>): Promise<T> {
  return withKeyedLock(`reconcile:${nodeId}:${protocol}`, work);
}
