import { createHash } from "node:crypto";

/** What the apps report about a connection session and a crash, read for the staged-rollout health check (rollout-health.ts). */
const sessionOutcomes = ["ok", "failed", "cancelled", "lost"] as const;
export type SessionSummary = { outcome: typeof sessionOutcomes[number]; ms: number | null; line: string | null; fallbacks: number; drops: number; seconds: number; net: string };

/**
 * A CONNECT_SESSION detail ("outcome=ok ms=1400 line=hysteria2 fallbacks=0 drops=1 seconds=3600 net=wifi"), checked
 * field by field; anything else is dropped. Counts are capped so one odd client cannot skew a build's figures.
 */
export function parseSession(detail: string | null): SessionSummary | null {
  if (!detail) return null;
  const fields = new Map(detail.split(/\s+/).map((pair) => pair.split("=", 2) as [string, string]).filter((pair) => pair.length === 2));
  const outcome = fields.get("outcome") as SessionSummary["outcome"];
  if (!sessionOutcomes.includes(outcome)) return null;
  const count = (key: string, max: number) => { const value = Number(fields.get(key)); return Number.isInteger(value) && value >= 0 ? Math.min(value, max) : 0; };
  const ms = Number(fields.get("ms"));
  const line = fields.get("line") || "";
  const net = fields.get("net") || "";
  return { outcome, ms: outcome === "ok" && Number.isInteger(ms) && ms >= 0 ? Math.min(ms, 600_000) : null,
    line: /^[a-z0-9][a-z0-9-]{0,23}$/.test(line) ? line : null, fallbacks: count("fallbacks", 20), drops: count("drops", 1000),
    seconds: count("seconds", 7 * 86400), net: ["wifi", "cell", "lan"].includes(net) ? net : "unknown" };
}

/**
 * Groups the same crash across installs and builds: the report without its version numbers and durations
 * (Android/Windows "1.0.22 Type: message at A/b < C/d", Apple's MetricKit summary), cut to the start that names it.
 */
export function crashSignature(detail: string | null): string {
  const text = (detail || "").split(/\s+/).filter((word) => !/^[\d.+()]+$/.test(word)).join(" ").slice(0, 160);
  return createHash("sha256").update(text || "unknown").digest("hex").slice(0, 12);
}
