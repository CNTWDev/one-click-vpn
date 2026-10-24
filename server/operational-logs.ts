import { currentTrace } from "./trace";

/**
 * Operational logs live only in the bundled single-node Loki (MinIO-backed, 14-day retention in
 * deploy/loki/loki.yml), never in Postgres, so they cannot grow the control-plane database.
 */
export type OperationalLogInput = {
  nodeId?: string | null;
  actionId?: string | null;
  component: "controller" | "bootstrap" | "agent" | "reconcile" | "audit" | "api";
  level?: "info" | "warning" | "error";
  message: string;
  /** Who did it. Present only for actions a signed-in person started. */
  actor?: { id: string; email?: string; role?: string } | null;
  /** Look the actor up from the request's session cookie (for lines written without one, e.g. API errors). */
  actorFromRequest?: boolean;
  /** The key action name, e.g. "node.deleted"; set for audit events. */
  action?: string;
  target?: { type?: string; id?: string } | null;
  /** Defaults to "user" for a signed-in actor inside a request, else "system" (incl. queued work). */
  source?: "user" | "system";
  fields?: Record<string, unknown>;
  timestamp?: string;
};

function lokiUrl(): string | null {
  const value = process.env.VEILBIRD_LOKI_URL?.trim();
  return value ? value.replace(/\/$/, "") : null;
}

function labels(input: OperationalLogInput, source: "user" | "system"): Record<string, string> {
  return {
    service: "northstar",
    component: input.component,
    level: input.level || "info",
    node: input.nodeId || "controller",
    // Low-cardinality split used by the Console "user / system" filter.
    source,
  };
}

/** Best-effort by design: an unavailable log store must never block node recovery. */
export async function writeOperationalLog(input: OperationalLogInput): Promise<void> {
  const url = lokiUrl();
  if (!url || !input.message.trim()) return;
  const trace = await currentTrace();
  if (!input.actor && input.actorFromRequest && trace && !trace.background) {
    // Imported lazily: auth -> db -> operational-logs would otherwise be a cycle.
    input = { ...input, actor: await import("./auth").then((auth) => auth.requestActor()).catch(() => null) };
  }
  const source = input.source || (input.actor && trace && !trace.background ? "user" : "system");
  const at = new Date(input.timestamp || Date.now());
  const line = JSON.stringify({
    ...(input.fields || {}),
    time: at.toISOString(),
    message: input.message.slice(0, 16_000),
    traceId: trace?.traceId,
    actionId: input.actionId || undefined,
    action: input.action,
    actor: input.actor || undefined,
    target: input.target?.type || input.target?.id ? input.target : undefined,
    ip: trace?.ip,
    userAgent: trace?.userAgent,
    request: trace?.method ? `${trace.method} ${trace.path || ""}`.trim() : undefined,
  });
  try {
    await fetch(`${url}/loki/api/v1/push`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ streams: [{ stream: labels(input, source), values: [[String(at.getTime() * 1_000_000), line]] }] }),
      signal: AbortSignal.timeout(1_500),
    });
  } catch {
    // Operational telemetry is intentionally lossy when the separate log store is unavailable.
  }
}

export type OperationalLogLine = {
  timestamp: string;
  labels: Record<string, string>;
  message: string;
  traceId?: string;
  actionId?: string;
  action?: string;
  actor?: { id: string; email?: string; role?: string };
  target?: { type?: string; id?: string };
  ip?: string;
  request?: string;
  details?: Record<string, unknown>;
};
export type OperationalLogQuery = {
  logs: OperationalLogLine[];
  available: boolean;
  /** Pass back as `before` to get the next (older) page; absent on the last page. */
  nextCursor?: string;
  /** Matching lines per level in the whole time window (first page only; ignores the level filter). */
  counts?: Record<string, number>;
};

type LogFilter = { nodeId?: string; level?: string; source?: string; search?: string; hours?: number };

function logSelector(input: LogFilter, withLevel: boolean): string {
  const selector = [`service="northstar"`];
  if (input.nodeId) selector.push(`node="${labelValue(input.nodeId)}"`);
  if (withLevel && input.level && ["info", "warning", "error"].includes(input.level)) selector.push(`level="${input.level}"`);
  if (input.source === "user") selector.push(`source="user"`);
  if (input.source === "system") selector.push(`source!="user"`);
  return `{${selector.join(",")}}${input.search ? ` ${lineFilter(input.search)}` : ""}`;
}

function windowHours(input: LogFilter): number {
  return Math.min(Math.max(Math.trunc(input.hours || 24), 1), 24 * 31);
}

const KNOWN_KEYS = new Set(["time", "message", "traceId", "actionId", "action", "actor", "target", "ip", "userAgent", "request"]);

function labelValue(value: string): string {
  return value.replaceAll("\\", "").replaceAll('"', "");
}

/** Case-insensitive substring filter, escaped for both RE2 and the LogQL string literal. */
export function lineFilter(text: string): string {
  // Lines are stored as JSON, so a quote in the text appears as \" in the stored line.
  const regex = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll('"', '\\\\?"');
  return `|~ "(?i)${regex.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export async function queryOperationalLogs(input: LogFilter & { limit?: number; before?: string }): Promise<OperationalLogQuery> {
  const url = lokiUrl();
  if (!url) return { logs: [], available: false };
  const query = logSelector(input, true);
  const limit = Math.min(Math.max(input.limit || 200, 1), 500);
  const now = Date.now() * 1_000_000;
  const start = now - windowHours(input) * 60 * 60 * 1_000_000_000;
  // Cursor paging: each page ends just before the oldest line of the previous one (Loki's end is exclusive).
  const end = input.before && /^\d{1,20}$/.test(input.before) ? input.before : String(now);
  // One extra line tells whether the page boundary splits lines that share a timestamp.
  const params = new URLSearchParams({ query, start: String(start), end, limit: String(limit + 1), direction: "BACKWARD" });
  const counts = input.before ? undefined : countOperationalLogs(url, input);
  try {
    const response = await fetch(`${url}/loki/api/v1/query_range?${params}`, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { logs: [], available: false };
    const payload = await response.json() as { data?: { result?: Array<{ stream: Record<string, string>; values: Array<[string, string]> }> } };
    const logs = (payload.data?.result || []).flatMap((stream) => stream.values.map(([nanoseconds, raw]): { ns: string; line: OperationalLogLine } => {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { parsed = { message: raw }; }
      const details = Object.fromEntries(Object.entries(parsed).filter(([key, value]) => !KNOWN_KEYS.has(key) && value !== undefined && value !== null && value !== ""));
      const text = (key: string) => typeof parsed[key] === "string" ? parsed[key] as string : undefined;
      return { ns: nanoseconds, line: {
        timestamp: new Date(Number(nanoseconds.slice(0, -6)) || 0).toISOString(),
        labels: Object.fromEntries(Object.entries(stream.stream).filter(([key]) => ["component", "level", "node", "source"].includes(key))),
        message: text("message") || raw,
        traceId: text("traceId"), actionId: text("actionId"), action: text("action"),
        actor: parsed.actor && typeof parsed.actor === "object" ? parsed.actor as OperationalLogLine["actor"] : undefined,
        target: parsed.target && typeof parsed.target === "object" ? parsed.target as OperationalLogLine["target"] : undefined,
        ip: text("ip"), request: text("request"),
        details: Object.keys(details).length ? details : undefined,
      } };
    }));
    // Loki returns one block per stream; interleave them newest first.
    // Nanosecond strings exceed Number precision; equal-length digit strings compare correctly as text.
    logs.sort((a, b) => b.ns.length - a.ns.length || (a.ns === b.ns ? 0 : a.ns < b.ns ? 1 : -1));
    let page = logs.slice(0, limit);
    let nextCursor: string | undefined;
    if (logs.length > limit) {
      const last = page[page.length - 1].ns;
      nextCursor = last;
      if (logs[limit].ns === last && page[0].ns !== last) {
        // The boundary falls inside a group of same-nanosecond lines: move the whole group to the next page.
        page = page.filter((entry) => entry.ns !== last);
        nextCursor = incrementDigits(last);
      }
    }
    return { logs: page.map((entry) => entry.line), available: true, nextCursor, counts: await counts };
  } catch {
    return { logs: [], available: false };
  }
}

/** n + 1 for a decimal string too large for Number (nanosecond timestamps). */
function incrementDigits(value: string): string {
  const digits = value.split("");
  for (let i = digits.length - 1; i >= 0; i--) {
    if (digits[i] !== "9") { digits[i] = String(Number(digits[i]) + 1); return digits.join(""); }
    digits[i] = "0";
  }
  return `1${digits.join("")}`;
}

/** One metric query instead of reading every line: how many lines match, per level, in the window. */
async function countOperationalLogs(url: string, input: LogFilter): Promise<Record<string, number> | undefined> {
  const params = new URLSearchParams({ query: `sum by (level) (count_over_time(${logSelector(input, false)} [${windowHours(input)}h]))`, time: String(Date.now() * 1_000_000) });
  try {
    const response = await fetch(`${url}/loki/api/v1/query?${params}`, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return undefined;
    const payload = await response.json() as { data?: { result?: Array<{ metric: Record<string, string>; value: [number, string] }> } };
    const counts: Record<string, number> = { info: 0, warning: 0, error: 0 };
    for (const row of payload.data?.result || []) counts[row.metric.level || "info"] = (counts[row.metric.level || "info"] || 0) + (Number(row.value[1]) || 0);
    return counts;
  } catch {
    // Totals are a convenience; the page still works without them.
    return undefined;
  }
}

export async function requestOperationalLogPurge(nodeId?: string): Promise<void> {
  const url = lokiUrl();
  const selector = nodeId ? `{service="northstar",node="${labelValue(nodeId)}"}` : `{service="northstar"}`;
  if (url) {
    // The delete API takes Unix seconds (nanoseconds are rejected) and refuses start=0; anything
    // older than the retention window is already gone, so 400 days back covers every stored line.
    const end = Math.floor(Date.now() / 1000);
    const params = new URLSearchParams({ query: selector, start: String(end - 400 * 24 * 60 * 60), end: String(end) });
    const response = await fetch(`${url}/loki/api/v1/delete?${params}`, { method: "POST", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error("The log service did not accept the deletion request");
  }
}
