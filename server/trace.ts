import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/**
 * Correlation context carried by every operational log line. One trace starts per HTTP request
 * (proxy.ts assigns X-Request-Id) and is carried into queued background work, so a single search
 * finds the user, the request, the node action and the Agent's follow-up.
 */
export type TraceContext = {
  traceId: string;
  ip?: string;
  userAgent?: string;
  method?: string;
  path?: string;
  /** Set for queued work that outlives its request: such lines are "system", not user actions. */
  background?: boolean;
};

export const REQUEST_ID_HEADER = "x-request-id";
const storage = new AsyncLocalStorage<TraceContext>();

export function newTraceId(): string {
  return randomBytes(8).toString("hex");
}

/** Accepts an upstream id (Nginx $request_id, a client) only when it is short and printable. */
export function validTraceId(value: string | null | undefined): string | null {
  return value && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null;
}

export function runWithTrace<T>(context: TraceContext, task: () => T): T {
  return storage.run(context, task);
}

/** The active trace: background work first, then the current Next.js request; null outside both. */
export async function currentTrace(): Promise<TraceContext | null> {
  const stored = storage.getStore();
  if (stored) return stored;
  try {
    const { headers } = await import("next/headers");
    const list = await headers();
    const traceId = validTraceId(list.get(REQUEST_ID_HEADER));
    if (!traceId) return null;
    const forwarded = list.get("x-forwarded-for")?.split(",")[0]?.trim();
    return {
      traceId,
      ip: list.get("x-real-ip") || forwarded || undefined,
      userAgent: list.get("user-agent")?.slice(0, 200) || undefined,
      method: list.get("x-veilbird-method") || undefined,
      path: list.get("x-veilbird-path") || undefined,
    };
  } catch {
    // Called outside a request scope (timers, startup): there is no trace to report.
    return null;
  }
}

/** Captures the caller's trace so queued work keeps it after the request has returned. */
export async function captureTrace(): Promise<TraceContext> {
  return { ...((await currentTrace()) || { traceId: newTraceId() }), background: true };
}
