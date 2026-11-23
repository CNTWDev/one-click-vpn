import { createHash, randomUUID } from "node:crypto";
import { dbExec, dbQuery } from "./db";
import { wakeAgent } from "./agent-wake";
import { writeOperationalLog } from "./operational-logs";

/**
 * Baseline speed of a node's own connection (Agent 2.20+, agent.py run_speed_test): the Agent downloads from
 * and uploads to Cloudflare's speed test service for 8 s each. "before" and "after" come from the Agent on its
 * own the first time it tunes the node (BBR, buffers); "baseline" is asked for by the Controller ten minutes after
 * a node first shows up and then about weekly, staggered per node; "manual" is the Console button.
 *
 * Results are node attributes (Postgres, last 30 per node); a line also goes to the runtime log (Loki).
 */
export type SpeedTestKind = "before" | "after" | "baseline" | "manual";
export type SpeedTest = { id: string; kind: SpeedTestKind; downMbps: number | null; upMbps: number | null; latencyMs: number | null; congestion: string; error: string; createdAt: string };
type Pending = { id: string; kind: "baseline" | "manual"; status: "waiting" | "running"; requestedAt: number };

const MIN_AGENT = [2, 20, 0];
const WEEK = 7 * 24 * 3600_000;
const FIRST_DELAY = 10 * 60_000;
const RUN_TIMEOUT = 3 * 60_000;
const KEEP = 30;
/** A baseline that failed or never came back is tried again after this long. */
const RETRY = 6 * 3600_000;

type Memory = { pending: Map<string, Pending>; lastAt: Map<string, number>; firstSeen: Map<string, number>; lastTry: Map<string, number> };
const memory: Memory = (globalThis as { __speedTests?: Memory }).__speedTests ??= { pending: new Map(), lastAt: new Map(), firstSeen: new Map(), lastTry: new Map() };

export function agentSupportsSpeedTest(version: string | null | undefined): boolean {
  const parts = /(\d+)\.(\d+)\.(\d+)/.exec(version || "")?.slice(1).map(Number);
  if (!parts) return false;
  for (let index = 0; index < 3; index += 1) if (parts[index] !== MIN_AGENT[index]) return parts[index] > MIN_AGENT[index];
  return true;
}

/** Up to a day added to the week, the same for a node every time, so a fleet does not test all at once. */
export function weeklyOffset(nodeId: string): number {
  return createHash("sha256").update(nodeId).digest().readUInt32BE(0) % (24 * 3600_000);
}

function live(pending: Pending | undefined, now: number): Pending | undefined {
  if (pending && pending.status === "running" && now - pending.requestedAt > RUN_TIMEOUT) return undefined;
  return pending;
}

async function lastTestAt(nodeId: string): Promise<number> {
  const cached = memory.lastAt.get(nodeId);
  if (cached !== undefined) return cached;
  const [row] = await dbQuery<{ at: string | null }>("SELECT max(created_at) AS at FROM node_speed_tests WHERE node_id = $1 AND error = ''", [nodeId]);
  const at = row?.at ? Date.parse(row.at) : 0;
  memory.lastAt.set(nodeId, at);
  return at;
}

/** The Console button; a test already waiting or running is returned instead of starting another. */
export function requestSpeedTest(nodeId: string, now = Date.now()): Pending {
  const running = live(memory.pending.get(nodeId), now);
  if (running) return running;
  const pending: Pending = { id: randomUUID(), kind: "manual", status: "waiting", requestedAt: now };
  memory.pending.set(nodeId, pending);
  wakeAgent(nodeId);
  return pending;
}

export function currentSpeedTest(nodeId: string, now = Date.now()): Pending | undefined {
  return live(memory.pending.get(nodeId), now);
}

/** What the Agent receives with its task pull: a waiting request, or a baseline when one is due. */
export async function takeSpeedTestFor(nodeId: string, version: string | null | undefined, now = Date.now()) {
  if (!agentSupportsSpeedTest(version)) return undefined;
  let pending = live(memory.pending.get(nodeId), now);
  if (!pending) {
    if (!memory.firstSeen.has(nodeId)) memory.firstSeen.set(nodeId, now);
    const last = await lastTestAt(nodeId);
    const due = last ? now - last >= WEEK + weeklyOffset(nodeId) : now - memory.firstSeen.get(nodeId)! >= FIRST_DELAY;
    if (!due || now - (memory.lastTry.get(nodeId) ?? 0) < RETRY) return undefined;
    memory.lastTry.set(nodeId, now);
    pending = { id: randomUUID(), kind: "baseline", status: "waiting", requestedAt: now };
    memory.pending.set(nodeId, pending);
  }
  if (pending.status !== "waiting") return undefined;
  pending.status = "running";
  pending.requestedAt = now;
  return { id: pending.id, kind: pending.kind };
}

function mbps(value: unknown): number | null {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) && number >= 0 && number < 1_000_000 ? Math.round(number * 10) / 10 : null;
}

export async function recordSpeedTest(nodeId: string, body: Record<string, unknown>, now = Date.now()) {
  const kind = (["before", "after", "baseline", "manual"] as const).find((item) => item === body.kind);
  if (!kind) return false;
  const id = typeof body.id === "string" ? body.id.slice(0, 64) : "";
  const pending = memory.pending.get(nodeId);
  if (id && pending?.id === id) memory.pending.delete(nodeId);
  const error = typeof body.error === "string" ? body.error.slice(0, 300) : "";
  // A second request while one ran is not a result.
  if (error === "busy") return true;
  const result = { downMbps: mbps(body.downMbps), upMbps: mbps(body.upMbps), latencyMs: mbps(body.latencyMs),
    congestion: typeof body.congestion === "string" ? body.congestion.replace(/[^a-z0-9_-]/gi, "").slice(0, 32) : "" };
  await dbExec(`INSERT INTO node_speed_tests (id, node_id, kind, down_mbps, up_mbps, latency_ms, congestion, error)
    SELECT $1, $2, $3, $4, $5, $6, $7, $8 WHERE EXISTS (SELECT 1 FROM nodes WHERE id = $2)`,
  [randomUUID(), nodeId, kind, result.downMbps, result.upMbps, result.latencyMs, result.congestion, error]);
  await dbExec(`DELETE FROM node_speed_tests WHERE node_id = $1 AND id NOT IN
    (SELECT id FROM node_speed_tests WHERE node_id = $1 ORDER BY created_at DESC LIMIT ${KEEP})`, [nodeId]);
  if (!error) memory.lastAt.set(nodeId, now);
  void writeOperationalLog({ component: "agent", level: error ? "warning" : "info", nodeId, action: "node.speed_test", source: "system",
    message: error ? `Speed test (${kind}) failed: ${error}` : `Speed test (${kind}): down ${result.downMbps ?? "-"} Mbps, up ${result.upMbps ?? "-"} Mbps, ${result.latencyMs ?? "-"} ms, ${result.congestion || "unknown"}`,
    fields: { kind, ...result } });
  return true;
}

export async function listSpeedTests(nodeId: string, limit = 10): Promise<SpeedTest[]> {
  const rows = await dbQuery<{ id: string; kind: SpeedTestKind; down_mbps: number | null; up_mbps: number | null; latency_ms: number | null; congestion: string; error: string; created_at: string | Date }>(
    `SELECT id, kind, down_mbps, up_mbps, latency_ms, congestion, error, created_at FROM node_speed_tests WHERE node_id = $1 ORDER BY created_at DESC LIMIT $2`, [nodeId, limit]);
  return rows.map((row) => ({ id: row.id, kind: row.kind, downMbps: row.down_mbps, upMbps: row.up_mbps, latencyMs: row.latency_ms,
    congestion: row.congestion, error: row.error, createdAt: new Date(row.created_at).toISOString() }));
}
