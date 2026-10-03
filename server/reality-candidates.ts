import { createHash } from "node:crypto";

/** Default REALITY targets. Keep in sync with REALITY_CANDIDATES in agent/agent.py (a test enforces it). */
export const REALITY_CANDIDATES = [
  "www.microsoft.com", "www.apple.com", "www.amazon.com", "www.tesla.com", "www.nvidia.com",
  "www.amd.com", "www.samsung.com", "www.lovelive-anime.jp", "www.cisco.com", "www.mozilla.org",
] as const;

export type RealityProbe = { checkedAt?: string | null; results?: Array<{ serverName?: unknown; ok?: unknown; latencyMs?: unknown }> };

/**
 * Pick a target the node itself verified (public DNS, TLS 1.3, HTTP/2). Among the fast ones the
 * node id decides, so a fleet spreads over several targets instead of sharing one fingerprint.
 */
export function pickRealityCandidate(nodeId: string, probe: RealityProbe | undefined): string | undefined {
  const usable = (probe?.results || [])
    .filter((row) => row.ok === true && typeof row.latencyMs === "number" && REALITY_CANDIDATES.includes(row.serverName as typeof REALITY_CANDIDATES[number]))
    .map((row) => ({ name: row.serverName as string, latency: row.latencyMs as number }))
    .sort((a, b) => a.latency - b.latency || a.name.localeCompare(b.name));
  if (!usable.length) return undefined;
  const fast = usable.filter((row) => row.latency <= usable[0].latency + 40).slice(0, 4);
  const index = createHash("sha256").update(nodeId).digest().readUInt32BE(0) % fast.length;
  return fast[index].name;
}
