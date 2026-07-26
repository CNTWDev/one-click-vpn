
export type OperationalLogInput = {
  nodeId?: string | null;
  actionId?: string | null;
  component: "controller" | "bootstrap" | "agent" | "reconcile";
  level?: "info" | "warning" | "error";
  message: string;
  fields?: Record<string, unknown>;
  timestamp?: string;
};

function lokiUrl(): string | null {
  const value = process.env.NORTHSTAR_LOKI_URL?.trim();
  return value ? value.replace(/\/$/, "") : null;
}

function labels(input: OperationalLogInput): Record<string, string> {
  return {
    service: "northstar",
    component: input.component,
    level: input.level || "info",
    node: input.nodeId || "controller",
  };
}

/** Best-effort by design: an unavailable log store must never block node recovery. */
export async function writeOperationalLog(input: OperationalLogInput): Promise<void> {
  const url = lokiUrl();
  if (!url || !input.message.trim()) return;
  const timestamp = new Date(input.timestamp || Date.now()).getTime() * 1_000_000;
  const line = JSON.stringify({
    time: new Date(input.timestamp || Date.now()).toISOString(), actionId: input.actionId || undefined,
    message: input.message.slice(0, 16_000), ...(input.fields || {}),
  });
  try {
    await fetch(`${url}/loki/api/v1/push`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ streams: [{ stream: labels(input), values: [[String(timestamp), line]] }] }),
      signal: AbortSignal.timeout(1_500),
    });
  } catch {
    // Operational telemetry is intentionally lossy when the separate log store is unavailable.
  }
}

export type OperationalLogLine = { timestamp: string; labels: Record<string, string>; message: string; actionId?: string };
export type OperationalLogQuery = { logs: OperationalLogLine[]; available: boolean };

export async function queryOperationalLogs(input: { nodeId?: string; level?: string; hours?: number; limit?: number }): Promise<OperationalLogQuery> {
  const url = lokiUrl();
  if (!url) return { logs: [], available: false };
  const selector = [`service="northstar"`];
  if (input.nodeId) selector.push(`node="${input.nodeId.replaceAll('"', "")}"`);
  if (input.level && ["info", "warning", "error"].includes(input.level)) selector.push(`level="${input.level}"`);
  const end = Date.now() * 1_000_000;
  const start = end - Math.min(Math.max(input.hours || 24, 1), 24 * 31) * 60 * 60 * 1_000_000_000;
  const params = new URLSearchParams({ query: `{${selector.join(",")}}`, start: String(start), end: String(end), limit: String(Math.min(Math.max(input.limit || 200, 1), 500)), direction: "BACKWARD" });
  try {
    const response = await fetch(`${url}/loki/api/v1/query_range?${params}`, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { logs: [], available: false };
    const payload = await response.json() as { data?: { result?: Array<{ stream: Record<string, string>; values: Array<[string, string]> }> } };
    const logs = (payload.data?.result || []).flatMap((stream) => stream.values.map(([nanoseconds, raw]) => {
      let parsed: { message?: string; actionId?: string } = {};
      try { parsed = JSON.parse(raw) as { message?: string; actionId?: string }; } catch { parsed = { message: raw }; }
      return { timestamp: new Date(Number(nanoseconds) / 1_000_000).toISOString(), labels: stream.stream, message: parsed.message || raw, actionId: parsed.actionId };
    }));
    return { logs, available: true };
  } catch {
    return { logs: [], available: false };
  }
}

export async function requestOperationalLogPurge(nodeId?: string): Promise<void> {
  const url = lokiUrl();
  const selector = nodeId ? `{service="northstar",node="${nodeId.replaceAll('"', "")}"}` : `{service="northstar"}`;
  if (url) {
    const params = new URLSearchParams({ query: selector, start: "0", end: String(Date.now() * 1_000_000) });
    const response = await fetch(`${url}/loki/api/v1/delete?${params}`, { method: "POST", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error("The log service did not accept the deletion request");
  }
}
