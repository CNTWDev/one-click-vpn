/** One transport's result in an app's probe summary: "hysteria2=ok,reality=fail"; newer apps add the delay, "reality=ok:182". */
export type ProbeResult = { transport: string; ok: boolean; delayMs: number | null };

/** `known` is the set of transport names to keep (appTransports in app-transports.ts). */
export function parseProbeDetail(detail: string | null | undefined, known: Record<string, unknown>): ProbeResult[] {
  const results = new Map<string, ProbeResult>();
  for (const part of (detail || "").split(",")) {
    const match = /^\s*([a-z0-9-]{2,16})=(ok|fail)(?::(\d{1,5}))?\s*$/.exec(part);
    if (!match || !Object.hasOwn(known, match[1])) continue;
    const delay = match[2] === "ok" && match[3] !== undefined ? Number(match[3]) : null;
    results.set(match[1], { transport: match[1], ok: match[2] === "ok", delayMs: delay !== null && delay > 0 && delay < 30_000 ? delay : null });
  }
  return [...results.values()];
}
