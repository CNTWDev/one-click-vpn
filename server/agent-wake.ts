// Agents long-poll their task queue (app/api/v1/agent/tasks/pull): a pull with nothing to do waits here
// until work for that node appears, so a new task reaches the node at once instead of on its next poll.
// The Controller is one process, so an in-memory list of waiting pulls is enough.
const waiting = new Map<string, Set<() => void>>();

/** Wakes the pulls of nodeId that are waiting for work. */
export function wakeAgent(nodeId: string): void {
  const listeners = waiting.get(nodeId);
  if (!listeners) return;
  waiting.delete(nodeId);
  for (const listener of listeners) listener();
}

/** Resolves when wakeAgent(nodeId) is called, after milliseconds, or when signal aborts. */
export function waitForAgentWork(nodeId: string, milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      const listeners = waiting.get(nodeId);
      listeners?.delete(finish);
      if (listeners && !listeners.size) waiting.delete(nodeId);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    if (signal?.aborted) return finish();
    signal?.addEventListener("abort", finish);
    const listeners = waiting.get(nodeId) ?? new Set<() => void>();
    listeners.add(finish);
    waiting.set(nodeId, listeners);
  });
}
