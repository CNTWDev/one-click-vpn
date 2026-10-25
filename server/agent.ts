import { timingSafeEqual } from "node:crypto";
import { dbExec, findNode } from "./db";
import { hashToken } from "./crypto";
import { recordAuthFailure } from "./rate-limit";
import { recordNodeNetworkCounters, type NodeNetworkRate } from "./node-traffic";

function metricNumber(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : 0;
}

function normalizeMetrics(input: unknown, wanRate: NodeNetworkRate | null): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const memory = value.memory && typeof value.memory === "object" ? value.memory as Record<string, unknown> : {};
  const disk = value.disk && typeof value.disk === "object" ? value.disk as Record<string, unknown> : {};
  const network = value.network && typeof value.network === "object" ? value.network as Record<string, unknown> : {};
  return JSON.stringify({
    collectedAt: typeof value.collectedAt === "string" ? value.collectedAt.slice(0, 64) : new Date().toISOString(),
    cpuPercent: metricNumber(value.cpuPercent, 100),
    load1: metricNumber(value.load1, 100000),
    memory: { usedBytes: metricNumber(memory.usedBytes), totalBytes: metricNumber(memory.totalBytes), percent: metricNumber(memory.percent, 100) },
    disk: { usedBytes: metricNumber(disk.usedBytes), totalBytes: metricNumber(disk.totalBytes), percent: metricNumber(disk.percent, 100) },
    network: {
      rxBytes: metricNumber(network.rxBytes), txBytes: metricNumber(network.txBytes),
      rxBytesPerSecond: metricNumber(network.rxBytesPerSecond), txBytesPerSecond: metricNumber(network.txBytesPerSecond),
      ...(wanRate ? { wanRxBytesPerSecond: wanRate.rxBytesPerSecond, wanTxBytesPerSecond: wanRate.txBytesPerSecond } : {}),
    },
  });
}

function tokenMatches(provided: string, expectedHash: string | null): boolean {
  if (!expectedHash) return false;
  const actual = Buffer.from(hashToken(provided), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Prefer the standard Authorization header; keep body-token fallback for older Agents. */
export function agentTokenFromRequest(request: Request, fallback = ""): string {
  const authorization = request.headers.get("authorization")?.trim() || "";
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, "").trim();
  return fallback;
}

export async function authenticateAgent(nodeId: string, token: string, request?: Request) {
  const node = await findNode(nodeId);
  // Only unknown node ids count towards a ban: a reinstalled node's old Agent keeps polling with a
  // stale token until it is replaced, and must not lock the node's address out for an hour.
  if (!node) {
    if (request) recordAuthFailure(request, "unknown-agent");
    return null;
  }
  if (!tokenMatches(token, node.agent_token_hash)) return null;
  return node;
}

/** One UPDATE per heartbeat: status, metrics, Agent metadata and the online-user count together. */
export async function recordAgentHeartbeat(input: {
  nodeId: string;
  version?: string;
  hostname?: string;
  publicEndpoint?: string;
  serverPublicKey?: string;
  capabilities?: Record<string, unknown>;
  metrics?: unknown;
  activeUsers?: number;
}): Promise<void> {
  // Rate comes from the stored public-interface sample, so it is overwritten each heartbeat and adds no rows.
  const wanRate = input.metrics === undefined ? null : await recordNodeNetworkCounters(input.nodeId, input.metrics);
  const normalizedMetrics = input.metrics === undefined ? null : normalizeMetrics(input.metrics, wanRate);
  const timestamp = new Date().toISOString();
  // VLESS users have no session list on the node; count the identities that moved traffic in the last 90 s.
  await dbExec(`UPDATE nodes n SET status = 'online', last_seen = 'now', last_heartbeat_at = $2,
      latency = 'connected', version = $3, metrics_json = COALESCE($4, n.metrics_json),
      public_endpoint = COALESCE($5, n.public_endpoint), server_public_key = COALESCE($6, n.server_public_key),
      agent_capabilities_json = $7, updated_at = $2,
      users = $8 + (SELECT COUNT(DISTINCT tc.identity_key) FROM traffic_counters tc
        JOIN access_credentials c ON c.id = tc.credential_id JOIN users u ON u.id = c.user_id
        WHERE tc.node_id = $1 AND tc.protocol = 'vless' AND tc.last_traffic_at > $9 AND c.status = 'active'
          AND NOT c.user_disabled AND NOT c.admin_disabled AND c.deleted_at IS NULL AND u.status = 'active')
    WHERE n.id = $1`, [
    input.nodeId, timestamp, input.version || "unknown", normalizedMetrics,
    input.publicEndpoint ?? null, input.serverPublicKey || null,
    JSON.stringify({ hostname: input.hostname || "", ...(input.capabilities || {}) }),
    Math.max(0, Math.floor(input.activeUsers || 0)), new Date(Date.now() - 90_000).toISOString(),
  ]);
}
