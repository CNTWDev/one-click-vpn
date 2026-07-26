import { timingSafeEqual } from "node:crypto";
import { findNode, updateNode } from "./db";
import { hashToken } from "./crypto";
import { updateNodeControlMetadata } from "./control-db";

function metricNumber(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : 0;
}

function normalizeMetrics(input: unknown): string | null {
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
    },
  });
}

function tokenMatches(provided: string, expectedHash: string | null): boolean {
  if (!expectedHash) return false;
  const actual = Buffer.from(hashToken(provided), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function authenticateAgent(nodeId: string, token: string) {
  const node = await findNode(nodeId);
  if (!node || !tokenMatches(token, node.agent_token_hash)) return null;
  return node;
}

export async function recordAgentHeartbeat(input: {
  nodeId: string;
  version?: string;
  hostname?: string;
  publicEndpoint?: string;
  serverPublicKey?: string;
  capabilities?: Record<string, unknown>;
  metrics?: unknown;
}): Promise<void> {
  const normalizedMetrics = input.metrics === undefined ? undefined : normalizeMetrics(input.metrics);
  await updateNode(input.nodeId, {
    status: "online",
    last_seen: "now",
    last_heartbeat_at: new Date().toISOString(),
    latency: "connected",
    version: input.version || "unknown",
    ...(normalizedMetrics ? { metrics_json: normalizedMetrics } : {}),
  });
  await updateNodeControlMetadata(input.nodeId, {
    publicEndpoint: input.publicEndpoint,
    ...(input.serverPublicKey ? { serverPublicKey: input.serverPublicKey } : {}),
    capabilities: {
      hostname: input.hostname || "",
      ...(input.capabilities || {}),
    },
  });
}
