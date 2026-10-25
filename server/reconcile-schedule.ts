/**
 * When a heartbeat should rebuild a node's healthy services. Rebuilding reads every user with access to
 * the node, so it runs only after something that can change access happened (an account ran out of time
 * or traffic, a credential or profile reached its end), once after the controller starts, and otherwise
 * every few minutes as a safety net. Changes made in Console or Portal rebuild the affected nodes directly.
 *
 * The state is in memory: the controller is a single process, and a restart rebuilds every node once.
 */
const SAFETY_INTERVAL_MS = 10 * 60_000;

let epoch = 1;
const reconciled = new Map<string, { epoch: number; at: number }>();

/** Something that can change who may connect happened; every node rebuilds on its next heartbeat. */
export function markAccessChanged(): void {
  epoch += 1;
}

/** Returns the epoch to pass to {@link markNodeReconciled}, or null when the node is up to date. */
export function nodeReconcileDue(nodeId: string, now = Date.now()): number | null {
  const last = reconciled.get(nodeId);
  return !last || last.epoch !== epoch || now - last.at >= SAFETY_INTERVAL_MS ? epoch : null;
}

/** A change that arrives while the node rebuilds keeps it due, because the epoch moved on. */
export function markNodeReconciled(nodeId: string, startedEpoch: number, now = Date.now()): void {
  reconciled.set(nodeId, { epoch: startedEpoch, at: now });
}
